import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { eq, and, desc } from 'drizzle-orm'
import crypto from 'crypto'
import { mkdir, readdir } from 'fs/promises'
import path from 'path'
import { db } from '../db/index.js'
import { projects } from '../db/schema/projects.js'
import { agentSessions } from '../db/schema/agent-sessions.js'
import { authMiddleware } from '../middleware/auth.js'
import { opencodeBridge } from '../bridges/index.js'

const createProjectSchema = z.object({
  name: z.string().min(2).max(128),
  description: z.string().max(1000).optional(),
  software: z.string().max(32).default('paper'),
  language: z.enum(['java', 'kotlin']).default('java'),
  javaVersion: z.string().max(8).default('21'),
  compiler: z.enum(['maven', 'gradle']).default('gradle'),
})

const updateProjectSchema = z.object({
  name: z.string().min(2).max(128).optional(),
  description: z.string().max(1000).nullable().optional(),
  status: z.enum(['active', 'archived']).optional(),
  software: z.string().max(32).optional(),
  language: z.enum(['java', 'kotlin']).optional(),
  javaVersion: z.string().max(8).optional(),
  compiler: z.enum(['maven', 'gradle']).optional(),
})

function generateLinkId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
  const hex = crypto.randomBytes(3).toString('hex')
  return `${slug}-${hex}`
}

interface FileTreeEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileTreeEntry[]
}

async function readFileTree(dirPath: string, relativeTo: string, maxDepth: number): Promise<FileTreeEntry[]> {
  if (maxDepth <= 0) return []

  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    const result: FileTreeEntry[] = []

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue

      const fullPath = path.join(dirPath, entry.name)
      const relPath = path.relative(relativeTo, fullPath)

      if (entry.isDirectory()) {
        const children = await readFileTree(fullPath, relativeTo, maxDepth - 1)
        result.push({ name: entry.name, path: relPath, type: 'directory', children })
      } else {
        result.push({ name: entry.name, path: relPath, type: 'file' })
      }
    }

    return result.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  } catch {
    return []
  }
}

export async function projectRoutes(app: FastifyInstance) {
  // List projects for current user
  app.get('/api/projects', { preHandler: [authMiddleware] }, async (request) => {
    const userProjects = await db
      .select()
      .from(projects)
      .where(eq(projects.userId, request.user!.id))
      .orderBy(desc(projects.updatedAt))

    return userProjects
  })

  // Get single project
  app.get('/api/projects/:id', { preHandler: [authMiddleware] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.userId, request.user!.id)))
      .limit(1)

    if (!project) {
      return reply.status(404).send({ message: 'Project not found', statusCode: 404 })
    }

    return project
  })

  // Create project
  app.post('/api/projects', { preHandler: [authMiddleware] }, async (request, reply) => {
    const parsed = createProjectSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({
        message: parsed.error.issues[0].message,
        statusCode: 400,
      })
    }

    const linkId = generateLinkId(parsed.data.name)
    const username = request.user!.username

    const [project] = await db
      .insert(projects)
      .values({
        userId: request.user!.id,
        linkId,
        ...parsed.data,
      })
      .returning()

    // Create project directory (non-blocking)
    const projectDir = `/home/auroracraft-${username}/${linkId}`
    mkdir(projectDir, { recursive: true }).catch((err) => {
      app.log.warn({ err, projectDir }, 'Failed to create project directory')
    })

    return reply.status(201).send(project)
  })

  // Update project
  app.patch('/api/projects/:id', { preHandler: [authMiddleware] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = updateProjectSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({
        message: parsed.error.issues[0].message,
        statusCode: 400,
      })
    }

    const [existing] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.userId, request.user!.id)))
      .limit(1)

    if (!existing) {
      return reply.status(404).send({ message: 'Project not found', statusCode: 404 })
    }

    const [updated] = await db
      .update(projects)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(projects.id, id))
      .returning()

    return updated
  })

  // Delete project
  app.delete('/api/projects/:id', { preHandler: [authMiddleware] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const [existing] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.userId, request.user!.id)))
      .limit(1)

    if (!existing) {
      return reply.status(404).send({ message: 'Project not found', statusCode: 404 })
    }

    // Clean up OpenCode sessions before deleting the project
    const sessions = await db
      .select({ opencodeSessionId: agentSessions.opencodeSessionId })
      .from(agentSessions)
      .where(eq(agentSessions.projectId, id))

    const ocSessionIds = sessions
      .map((s) => s.opencodeSessionId)
      .filter((ocId): ocId is string => !!ocId)

    if (ocSessionIds.length > 0) {
      await Promise.allSettled(
        ocSessionIds.map((ocId) => opencodeBridge.deleteSession(ocId)),
      )
    }

    await db.delete(projects).where(eq(projects.id, id))

    return reply.status(204).send()
  })

  // Get file tree for a project
  app.get('/api/projects/:id/files', { preHandler: [authMiddleware] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.userId, request.user!.id)))
      .limit(1)

    if (!project) {
      return reply.status(404).send({ message: 'Project not found', statusCode: 404 })
    }

    if (!project.linkId) {
      return { files: [] }
    }

    const username = request.user!.username
    const projectDir = `/home/auroracraft-${username}/${project.linkId}`
    const files = await readFileTree(projectDir, projectDir, 6)

    return { files }
  })
}
