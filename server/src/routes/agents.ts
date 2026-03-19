import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { eq, and, desc } from 'drizzle-orm'
import { db } from '../db/index.js'
import { projects } from '../db/schema/projects.js'
import { agentSessions } from '../db/schema/agent-sessions.js'
import { agentMessages } from '../db/schema/agent-messages.js'
import { agentLogs } from '../db/schema/agent-logs.js'
import { authMiddleware } from '../middleware/auth.js'
import { agentExecutor } from '../agents/executor.js'
import { opencodeBridge } from '../bridges/index.js'

const sendMessageSchema = z.object({
  content: z.string().min(1).max(10000),
  model: z.string().max(100).optional(),
})

const sessionModelTracker = new Map<string, string>()

async function verifyProjectOwnership(userId: string, projectId: string) {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1)
  return project
}

function getProjectDirectory(username: string, linkId: string | null): string {
  if (!linkId) return '.'
  return `/home/auroracraft-${username}/${linkId}`
}

export async function agentRoutes(app: FastifyInstance) {
  // List agent sessions for a project
  app.get('/api/projects/:projectId/agent/sessions', { preHandler: [authMiddleware] }, async (request, reply) => {
    const { projectId } = request.params as { projectId: string }

    const project = await verifyProjectOwnership(request.user!.id, projectId)
    if (!project) {
      return reply.status(404).send({ message: 'Project not found', statusCode: 404 })
    }

    const sessions = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.projectId, projectId))
      .orderBy(desc(agentSessions.createdAt))

    return sessions
  })

  // Create a new agent session
  app.post('/api/projects/:projectId/agent/sessions', { preHandler: [authMiddleware] }, async (request, reply) => {
    const { projectId } = request.params as { projectId: string }

    const project = await verifyProjectOwnership(request.user!.id, projectId)
    if (!project) {
      return reply.status(404).send({ message: 'Project not found', statusCode: 404 })
    }

    const [session] = await db
      .insert(agentSessions)
      .values({ projectId })
      .returning()

    return reply.status(201).send(session)
  })

  // Get a specific agent session with its messages
  app.get('/api/projects/:projectId/agent/sessions/:sessionId', { preHandler: [authMiddleware] }, async (request, reply) => {
    const { projectId, sessionId } = request.params as { projectId: string; sessionId: string }

    const project = await verifyProjectOwnership(request.user!.id, projectId)
    if (!project) {
      return reply.status(404).send({ message: 'Project not found', statusCode: 404 })
    }

    const [session] = await db
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.projectId, projectId)))
      .limit(1)

    if (!session) {
      return reply.status(404).send({ message: 'Session not found', statusCode: 404 })
    }

    const messages = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.sessionId, sessionId))
      .orderBy(agentMessages.createdAt)

    return { ...session, messages }
  })

  // SSE streaming endpoint for live updates
  app.get('/api/projects/:projectId/agent/sessions/:sessionId/stream', { preHandler: [authMiddleware] }, async (request, reply) => {
    const { projectId, sessionId } = request.params as { projectId: string; sessionId: string }

    const project = await verifyProjectOwnership(request.user!.id, projectId)
    if (!project) {
      return reply.status(404).send({ message: 'Project not found', statusCode: 404 })
    }

    const [session] = await db
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.projectId, projectId)))
      .limit(1)

    if (!session) {
      return reply.status(404).send({ message: 'Session not found', statusCode: 404 })
    }

    const username = request.user!.username
    const projectDir = getProjectDirectory(username, project.linkId)

    // Hijack the response for raw SSE streaming
    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    const sendSSE = (data: unknown) => {
      if (!raw.destroyed) {
        raw.write(`data: ${JSON.stringify(data)}\n\n`)
      }
    }

    // Heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
      if (!raw.destroyed) {
        raw.write(': heartbeat\n\n')
      }
    }, 15000)

    let unsubscribe: (() => void) | null = null
    let subscribed = false

    const trySubscribe = () => {
      if (subscribed) return

      // Find the opencodeSessionId (poll DB if needed)
      const doSubscribe = async () => {
        let opencodeId = session.opencodeSessionId

        // Poll for up to 30 seconds if no opencodeSessionId yet
        if (!opencodeId) {
          for (let i = 0; i < 60; i++) {
            if (raw.destroyed) return
            await new Promise((r) => setTimeout(r, 500))

            const [refreshed] = await db
              .select({ opencodeSessionId: agentSessions.opencodeSessionId })
              .from(agentSessions)
              .where(eq(agentSessions.id, sessionId))
              .limit(1)

            if (refreshed?.opencodeSessionId) {
              opencodeId = refreshed.opencodeSessionId
              break
            }
          }
        }

        if (!opencodeId || raw.destroyed) return

        subscribed = true

        // If the session is still active, send a synthetic running status BEFORE
        // subscribing (which replays buffered events). This ensures the client sets
        // activeStream=true before processing any replayed file-op events.
        // Guards against the buffer overflowing and losing the original status event.
        const [current] = await db
          .select({ status: agentSessions.status })
          .from(agentSessions)
          .where(eq(agentSessions.id, sessionId))
          .limit(1)

        if (current && (current.status === 'running' || current.status === 'idle')) {
          sendSSE({ type: 'status', status: 'running' })
        }

        unsubscribe = opencodeBridge.subscriptionManager.subscribe(
          projectDir,
          opencodeId,
          (event) => sendSSE(event),
        )
      }

      doSubscribe().catch(() => {})
    }

    // Start trying to subscribe
    trySubscribe()

    // Send initial connection event
    sendSSE({ type: 'status', status: 'connected' })

    // Clean up on disconnect
    request.raw.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe?.()
    })
  })

  // Send a message to an agent session
  app.post('/api/projects/:projectId/agent/sessions/:sessionId/messages', { preHandler: [authMiddleware] }, async (request, reply) => {
    const { projectId, sessionId } = request.params as { projectId: string; sessionId: string }
    const parsed = sendMessageSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({
        message: parsed.error.issues[0].message,
        statusCode: 400,
      })
    }

    const project = await verifyProjectOwnership(request.user!.id, projectId)
    if (!project) {
      return reply.status(404).send({ message: 'Project not found', statusCode: 404 })
    }

    const [session] = await db
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.projectId, projectId)))
      .limit(1)

    if (!session) {
      return reply.status(404).send({ message: 'Session not found', statusCode: 404 })
    }

    if (session.status === 'running') {
      return reply.status(409).send({ message: 'Agent is already processing', statusCode: 409 })
    }

    // Save the user message
    const [message] = await db
      .insert(agentMessages)
      .values({
        sessionId,
        role: 'user',
        content: parsed.data.content,
      })
      .returning()

    // Resolve project directory
    const username = request.user!.username
    const projectDir = getProjectDirectory(username, project.linkId)

    // Track model per session — force new OpenCode session when model changes
    const requestedModel = parsed.data.model ?? ''
    const lastModel = sessionModelTracker.get(sessionId)
    const modelChanged = !!(requestedModel && lastModel && requestedModel !== lastModel)
    if (requestedModel) sessionModelTracker.set(sessionId, requestedModel)

    if (modelChanged && session.opencodeSessionId) {
      app.log.info({ sessionId, from: lastModel, to: requestedModel }, 'Model changed — creating new OpenCode session')
      await db.update(agentSessions).set({ opencodeSessionId: null, updatedAt: new Date() }).where(eq(agentSessions.id, sessionId))
    }

    // Pre-create or resolve the OpenCode session so the SSE endpoint can subscribe immediately
    let opencodeSessionId = modelChanged ? undefined : (session.opencodeSessionId ?? undefined)
    try {
      opencodeSessionId = await opencodeBridge.createOrResolveSession(
        projectDir,
        project.linkId ?? project.name,
        opencodeSessionId,
      )

      // Save opencodeSessionId early so SSE endpoint can pick it up
      await db
        .update(agentSessions)
        .set({ opencodeSessionId, updatedAt: new Date() })
        .where(eq(agentSessions.id, sessionId))
    } catch (err) {
      app.log.warn({ err, sessionId }, 'Failed to pre-create OpenCode session')
    }

    // Clear stale buffered events from previous messages so SSE subscribers don't replay old 'complete' events
    if (opencodeSessionId) {
      opencodeBridge.subscriptionManager.clearBuffer(projectDir, opencodeSessionId)
    }

    // Fire-and-forget: launch the AI agent executor asynchronously
    agentExecutor.execute(
      {
        sessionId,
        projectId,
        prompt: parsed.data.content,
        bridgeName: 'opencode',
        model: parsed.data.model,
        opencodeSessionId,
        projectLinkId: project.linkId ?? undefined,
        projectName: project.name,
        software: project.software,
        language: project.language,
        compiler: project.compiler,
        javaVersion: project.javaVersion,
        projectDirectory: projectDir,
        userHomeDir: `/home/auroracraft-${username}`,
      },
      {
        onOutput: (content) => { app.log.debug({ sessionId }, `Agent output: ${content.substring(0, 100)}`) },
        onStatus: (status) => { app.log.info({ sessionId, status }, 'Agent status changed') },
        onLog: (logType, msg) => { app.log.debug({ sessionId, logType }, msg) },
        onComplete: () => { app.log.info({ sessionId }, 'Agent execution completed') },
        onError: (error) => { app.log.error({ sessionId, error }, 'Agent execution error') },
      },
    ).catch((err) => {
      app.log.error({ sessionId, err }, 'Unhandled agent execution error')
    })

    return reply.status(201).send(message)
  })

  // Cancel an agent session
  app.post('/api/projects/:projectId/agent/sessions/:sessionId/cancel', { preHandler: [authMiddleware] }, async (request, reply) => {
    const { projectId, sessionId } = request.params as { projectId: string; sessionId: string }

    const project = await verifyProjectOwnership(request.user!.id, projectId)
    if (!project) {
      return reply.status(404).send({ message: 'Project not found', statusCode: 404 })
    }

    const [session] = await db
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.projectId, projectId)))
      .limit(1)

    if (!session) {
      return reply.status(404).send({ message: 'Session not found', statusCode: 404 })
    }

    if (session.status !== 'running' && session.status !== 'idle') {
      return reply.status(400).send({ message: 'Session is not active', statusCode: 400 })
    }

    await agentExecutor.cancel(sessionId)

    const [updated] = await db
      .update(agentSessions)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(agentSessions.id, sessionId))
      .returning()

    await db.insert(agentLogs).values({
      sessionId,
      logType: 'status',
      message: 'Session cancelled by user',
    })

    return updated
  })

  // Get logs for a session
  app.get('/api/projects/:projectId/agent/sessions/:sessionId/logs', { preHandler: [authMiddleware] }, async (request, reply) => {
    const { projectId, sessionId } = request.params as { projectId: string; sessionId: string }

    const project = await verifyProjectOwnership(request.user!.id, projectId)
    if (!project) {
      return reply.status(404).send({ message: 'Project not found', statusCode: 404 })
    }

    const logs = await db
      .select()
      .from(agentLogs)
      .where(eq(agentLogs.sessionId, sessionId))
      .orderBy(agentLogs.createdAt)

    return logs
  })
}
