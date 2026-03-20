import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { eq, and, desc } from 'drizzle-orm'
import crypto from 'crypto'
import { mkdir, readdir, readFile, writeFile, rm, stat, rename as fsRename } from 'fs/promises'
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
      .select({ id: projects.id, linkId: projects.linkId })
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

    // Clean up project directory (non-blocking)
    if (existing.linkId) {
      const username = request.user!.username
      const projectDir = `/home/auroracraft-${username}/${existing.linkId}`
      rm(projectDir, { recursive: true, force: true }).catch((err) => {
        app.log.warn({ err, projectDir }, 'Failed to remove project directory')
      })
    }

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
    const files = await readFileTree(projectDir, projectDir, 10)

    return { files }
  })

  // Read file content
  app.get('/api/projects/:id/files/content', { preHandler: [authMiddleware] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { path: filePath } = request.query as { path?: string }

    if (!filePath) {
      return reply.status(400).send({ message: 'Missing path query parameter', statusCode: 400 })
    }

    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.userId, request.user!.id)))
      .limit(1)

    if (!project) {
      return reply.status(404).send({ message: 'Project not found', statusCode: 404 })
    }

    if (!project.linkId) {
      return reply.status(404).send({ message: 'Project directory not found', statusCode: 404 })
    }

    const username = request.user!.username
    const projectDir = `/home/auroracraft-${username}/${project.linkId}`
    const fullPath = path.resolve(projectDir, filePath)

    // Security: ensure the resolved path is within the project directory
    if (!fullPath.startsWith(projectDir + '/')) {
      return reply.status(403).send({ message: 'Access denied', statusCode: 403 })
    }

    try {
      const fileStat = await stat(fullPath)
      if (!fileStat.isFile()) {
        return reply.status(400).send({ message: 'Path is not a file', statusCode: 400 })
      }
      const content = await readFile(fullPath, 'utf-8')
      return { content, path: filePath }
    } catch {
      return reply.status(404).send({ message: 'File not found', statusCode: 404 })
    }
  })

  // Save/write file content
  app.put('/api/projects/:id/files/content', { preHandler: [authMiddleware] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = z.object({ path: z.string().min(1), content: z.string() }).safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ message: parsed.error.issues[0].message, statusCode: 400 })
    }

    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.userId, request.user!.id)))
      .limit(1)

    if (!project) {
      return reply.status(404).send({ message: 'Project not found', statusCode: 404 })
    }

    if (!project.linkId) {
      return reply.status(404).send({ message: 'Project directory not found', statusCode: 404 })
    }

    const username = request.user!.username
    const projectDir = `/home/auroracraft-${username}/${project.linkId}`
    const fullPath = path.resolve(projectDir, parsed.data.path)

    if (!fullPath.startsWith(projectDir + '/')) {
      return reply.status(403).send({ message: 'Access denied', statusCode: 403 })
    }

    try {
      await mkdir(path.dirname(fullPath), { recursive: true })
      await writeFile(fullPath, parsed.data.content, 'utf-8')
    } catch (err) {
      app.log.error({ err, path: parsed.data.path }, 'Failed to write file')
      return reply.status(500).send({ message: 'Failed to write file', statusCode: 500 })
    }

    return { success: true, path: parsed.data.path }
  })

  // Create file or folder
  app.post('/api/projects/:id/files/create', { preHandler: [authMiddleware] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = z.object({ path: z.string().min(1), type: z.enum(['file', 'directory']) }).safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ message: parsed.error.issues[0].message, statusCode: 400 })
    }

    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.userId, request.user!.id)))
      .limit(1)

    if (!project) {
      return reply.status(404).send({ message: 'Project not found', statusCode: 404 })
    }

    if (!project.linkId) {
      return reply.status(404).send({ message: 'Project directory not found', statusCode: 404 })
    }

    const username = request.user!.username
    const projectDir = `/home/auroracraft-${username}/${project.linkId}`
    const fullPath = path.resolve(projectDir, parsed.data.path)

    if (!fullPath.startsWith(projectDir + '/')) {
      return reply.status(403).send({ message: 'Access denied', statusCode: 403 })
    }

    try {
      await stat(fullPath)
      return reply.status(409).send({ message: `${parsed.data.type === 'directory' ? 'Folder' : 'File'} already exists at ${parsed.data.path}`, statusCode: 409 })
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }

    try {
      if (parsed.data.type === 'directory') {
        await mkdir(fullPath, { recursive: true })
      } else {
        await mkdir(path.dirname(fullPath), { recursive: true })
        await writeFile(fullPath, '', 'utf-8')
      }
    } catch (err) {
      app.log.error({ err, path: parsed.data.path }, 'Failed to create file/folder')
      return reply.status(500).send({ message: 'Failed to create file/folder', statusCode: 500 })
    }

    return reply.status(201).send({ success: true, path: parsed.data.path, type: parsed.data.type })
  })

  // Delete file or folder
  app.delete('/api/projects/:id/files/delete', { preHandler: [authMiddleware] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = z.object({ path: z.string().min(1) }).safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ message: parsed.error.issues[0].message, statusCode: 400 })
    }

    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.userId, request.user!.id)))
      .limit(1)

    if (!project) {
      return reply.status(404).send({ message: 'Project not found', statusCode: 404 })
    }

    if (!project.linkId) {
      return reply.status(404).send({ message: 'Project directory not found', statusCode: 404 })
    }

    const username = request.user!.username
    const projectDir = `/home/auroracraft-${username}/${project.linkId}`
    const fullPath = path.resolve(projectDir, parsed.data.path)

    if (!fullPath.startsWith(projectDir + '/') || fullPath === projectDir) {
      return reply.status(403).send({ message: 'Access denied', statusCode: 403 })
    }

    try {
      await rm(fullPath, { recursive: true, force: true })
    } catch (err) {
      app.log.error({ err, path: parsed.data.path }, 'Failed to delete file/folder')
      return reply.status(500).send({ message: 'Failed to delete file/folder', statusCode: 500 })
    }

    return reply.status(204).send()
  })

  // Rename file or folder
  app.post('/api/projects/:id/files/rename', { preHandler: [authMiddleware] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = z.object({ oldPath: z.string().min(1), newPath: z.string().min(1) }).safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ message: parsed.error.issues[0].message, statusCode: 400 })
    }

    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.userId, request.user!.id)))
      .limit(1)

    if (!project) {
      return reply.status(404).send({ message: 'Project not found', statusCode: 404 })
    }

    if (!project.linkId) {
      return reply.status(404).send({ message: 'Project directory not found', statusCode: 404 })
    }

    const username = request.user!.username
    const projectDir = `/home/auroracraft-${username}/${project.linkId}`
    const oldFullPath = path.resolve(projectDir, parsed.data.oldPath)
    const newFullPath = path.resolve(projectDir, parsed.data.newPath)

    if (!oldFullPath.startsWith(projectDir + '/') || !newFullPath.startsWith(projectDir + '/')) {
      return reply.status(403).send({ message: 'Access denied', statusCode: 403 })
    }

    try {
      await stat(newFullPath)
      return reply.status(409).send({ message: `A file or folder already exists at ${parsed.data.newPath}`, statusCode: 409 })
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }

    try {
      await mkdir(path.dirname(newFullPath), { recursive: true })
      await fsRename(oldFullPath, newFullPath)
    } catch (err) {
      app.log.error({ err, oldPath: parsed.data.oldPath, newPath: parsed.data.newPath }, 'Failed to rename file/folder')
      return reply.status(500).send({ message: 'Failed to rename file/folder', statusCode: 500 })
    }

    return { success: true, oldPath: parsed.data.oldPath, newPath: parsed.data.newPath }
  })
}
