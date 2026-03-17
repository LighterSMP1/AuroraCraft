import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { agentSessions } from '../db/schema/agent-sessions.js'
import { agentMessages } from '../db/schema/agent-messages.js'
import { agentLogs } from '../db/schema/agent-logs.js'
import { bridgeRegistry } from '../bridges/index.js'
import type { AgentExecutionContext, AgentStreamCallback, AgentExecutionResult } from './types.js'

export class AgentExecutor {
  private activeExecutions = new Map<string, boolean>()

  async execute(context: AgentExecutionContext, callbacks: AgentStreamCallback): Promise<AgentExecutionResult> {
    const bridge = bridgeRegistry.get(context.bridgeName) ?? bridgeRegistry.getDefault()
    if (!bridge) {
      const error = 'No AI bridge is configured'
      await this.failSession(context.sessionId, error)
      callbacks.onError(error)
      return { status: 'failed', output: '', error }
    }

    this.activeExecutions.set(context.sessionId, true)

    await db
      .update(agentSessions)
      .set({ status: 'running', updatedAt: new Date() })
      .where(eq(agentSessions.id, context.sessionId))

    callbacks.onStatus('running')
    await this.addLog(context.sessionId, 'status', 'Execution started')

    try {
      const result = await bridge.streamResponse(
        {
          sessionId: context.sessionId,
          projectId: context.projectId,
          prompt: context.prompt,
          context: {
            opencodeSessionId: context.opencodeSessionId,
            model: context.model,
            projectLinkId: context.projectLinkId,
            projectName: context.projectName,
            software: context.software,
            language: context.language,
            compiler: context.compiler,
            javaVersion: context.javaVersion,
            projectDirectory: context.projectDirectory,
          },
        },
        (event) => {
          if (!this.activeExecutions.get(context.sessionId)) return

          switch (event.type) {
            case 'output':
              callbacks.onOutput(event.content)
              break
            case 'error':
              callbacks.onError(event.content)
              break
            case 'status':
            case 'thinking':
            case 'file-op':
            case 'todo':
            case 'complete':
              callbacks.onLog(event.type, event.content)
              break
          }
        },
      )

      if (!this.activeExecutions.get(context.sessionId)) {
        return { status: 'cancelled', output: '' }
      }

      if (!result.success) {
        const error = result.error ?? 'Bridge execution failed'
        await this.failSession(context.sessionId, error)

        // Save agent message: include partial output if available (e.g. timeout with partial work)
        const partialOutput = result.output ? `${result.output}\n\n⚠️ ${error}` : `⚠️ ${error}`
        await db.insert(agentMessages).values({
          sessionId: context.sessionId,
          role: 'agent',
          content: partialOutput,
          metadata: result.metadata?.parts ? { parts: result.metadata.parts } : undefined,
        })

        callbacks.onError(error)
        this.activeExecutions.delete(context.sessionId)
        return { status: 'failed', output: '', error }
      }

      // Save the agent response with metadata
      await db.insert(agentMessages).values({
        sessionId: context.sessionId,
        role: 'agent',
        content: result.output,
        metadata: result.metadata?.parts ? { parts: result.metadata.parts } : undefined,
      })

      // Store the OpenCode session ID for future message reuse
      if (result.metadata?.opencodeSessionId) {
        await db
          .update(agentSessions)
          .set({
            status: 'completed',
            opencodeSessionId: result.metadata.opencodeSessionId,
            updatedAt: new Date(),
          })
          .where(eq(agentSessions.id, context.sessionId))
      } else {
        await db
          .update(agentSessions)
          .set({ status: 'completed', updatedAt: new Date() })
          .where(eq(agentSessions.id, context.sessionId))
      }

      await this.addLog(context.sessionId, 'status', 'Execution completed')

      const executionResult: AgentExecutionResult = {
        status: 'completed',
        output: result.output,
        metadata: result.metadata,
      }

      callbacks.onComplete(executionResult)
      this.activeExecutions.delete(context.sessionId)
      return executionResult
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error'
      await this.failSession(context.sessionId, errorMessage)

      // Save error as agent message
      await db.insert(agentMessages).values({
        sessionId: context.sessionId,
        role: 'agent',
        content: `⚠️ Error: ${errorMessage}`,
      }).catch(() => {})

      callbacks.onError(errorMessage)
      this.activeExecutions.delete(context.sessionId)
      return { status: 'failed', output: '', error: errorMessage }
    }
  }

  async cancel(sessionId: string): Promise<void> {
    this.activeExecutions.delete(sessionId)

    const bridges = bridgeRegistry.getAll()
    for (const bridge of bridges) {
      await bridge.cancelExecution(sessionId)
    }

    await db
      .update(agentSessions)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(agentSessions.id, sessionId))

    await this.addLog(sessionId, 'status', 'Execution cancelled')
  }

  isRunning(sessionId: string): boolean {
    return this.activeExecutions.get(sessionId) === true
  }

  private async failSession(sessionId: string, error: string): Promise<void> {
    await db
      .update(agentSessions)
      .set({ status: 'failed', updatedAt: new Date() })
      .where(eq(agentSessions.id, sessionId))

    await this.addLog(sessionId, 'error', error)
  }

  private async addLog(sessionId: string, logType: string, message: string): Promise<void> {
    await db.insert(agentLogs).values({ sessionId, logType, message })
  }
}

export const agentExecutor = new AgentExecutor()
