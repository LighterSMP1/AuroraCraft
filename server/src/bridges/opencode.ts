import type { BridgeInterface, BridgeTask, BridgeResult, BridgeStreamEvent, MessagePart, TodoItem, StreamEvent } from './types.js'
import { env } from '../env.js'

// ── OpenCode API response types ──────────────────────────────────────

interface OpenCodeSession {
  id: string
  projectID?: string
  directory?: string
  title?: string
}

interface OpenCodePart {
  id?: string
  sessionID?: string
  messageID?: string
  type?: string
  text?: string
  tool?: string
  callID?: string
  state?: {
    status?: string
    input?: Record<string, unknown>
    output?: string
    title?: string
    metadata?: Record<string, unknown>
    error?: string
    time?: { start?: number; end?: number }
  }
  time?: { start?: number; end?: number }
  [key: string]: unknown
}

interface OpenCodeEvent {
  type: string
  properties: Record<string, unknown>
}

interface OpenCodeMessage {
  info?: {
    role?: string
    sessionID?: string
    id?: string
    time?: { created?: number; completed?: number }
    [key: string]: unknown
  }
  parts?: OpenCodePart[]
  [key: string]: unknown
}

interface OpenCodeTodo {
  id?: string
  content?: string
  status?: string
  priority?: string
}

// ── File action mapping ──────────────────────────────────────────────

type FileAction = 'create' | 'update' | 'delete' | 'rename' | 'read'

const TOOL_TO_FILE_ACTION: Record<string, FileAction> = {
  write: 'create', file_write: 'create', create: 'create', create_file: 'create', createFile: 'create',
  edit: 'update', file_edit: 'update', str_replace: 'update', str_replace_editor: 'update',
  patch: 'update', apply_diff: 'update', file_patch: 'update',
  delete: 'delete', file_delete: 'delete', remove: 'delete', rm: 'delete',
  rename: 'rename', move: 'rename', mv: 'rename', file_rename: 'rename',
  read: 'read', file_read: 'read', cat: 'read', read_file: 'read', readFile: 'read',
}

function extractFilePath(input: Record<string, unknown>): string {
  return String(input.path ?? input.filePath ?? input.file_path ?? input.filename ?? input.file ?? input.target ?? input.source ?? '')
}

function extractNewPath(input: Record<string, unknown>): string {
  return String(input.new_path ?? input.newFilePath ?? input.destination ?? input.target ?? input.newPath ?? '')
}

// ── SSE Connection (one per project directory) ───────────────────────

class SSEConnection {
  private controller: AbortController | null = null
  private listeners = new Map<string, Set<(event: StreamEvent) => void>>()
  private partTypes = new Map<string, string>()
  private eventBuffer = new Map<string, StreamEvent[]>()
  private readonly MAX_BUFFER_SIZE = 500
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private baseUrl: string,
    private directory: string,
  ) {}

  private makeRelativePath(filePath: string): string {
    if (filePath.startsWith(this.directory + '/')) {
      return filePath.slice(this.directory.length + 1)
    }
    if (filePath.startsWith('/')) {
      const lastSlash = filePath.lastIndexOf('/')
      return lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath
    }
    return filePath
  }

  get listenerCount(): number {
    let count = 0
    for (const set of this.listeners.values()) count += set.size
    return count
  }

  addListener(sessionId: string, callback: (event: StreamEvent) => void) {
    let set = this.listeners.get(sessionId)
    if (!set) {
      set = new Set()
      this.listeners.set(sessionId, set)
    }
    set.add(callback)

    // Replay any buffered events that arrived before this listener subscribed
    const buffered = this.eventBuffer.get(sessionId)
    if (buffered && buffered.length > 0) {
      for (const event of buffered) {
        callback(event)
      }
    }
  }

  removeListener(sessionId: string, callback: (event: StreamEvent) => void) {
    const set = this.listeners.get(sessionId)
    if (set) {
      set.delete(callback)
      if (set.size === 0) {
        this.listeners.delete(sessionId)
        this.cancelIdleComplete(sessionId)
      }
    }
  }

  connect() {
    if (this.controller) return
    this.controller = new AbortController()
    this.consumeStream(this.controller.signal).catch(() => {})
  }

  disconnect() {
    this.controller?.abort()
    this.controller = null
    this.partTypes.clear()
    this.eventBuffer.clear()
    for (const timer of this.idleTimers.values()) clearTimeout(timer)
    this.idleTimers.clear()
  }

  private async consumeStream(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        const url = `${this.baseUrl}/event`
        console.log('[OpenCode] Connecting to SSE event stream:', url)
        const response = await fetch(url, {
          headers: { Accept: 'text/event-stream' },
          signal,
        })

        if (!response.ok || !response.body) {
          console.error('[OpenCode] SSE connection failed: status', response.status)
          await this.delay(2000, signal)
          continue
        }
        console.log('[OpenCode] SSE event stream connected')

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (!signal.aborted) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })

          let idx: number
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 2)

            let data = ''
            for (const line of block.split('\n')) {
              if (line.startsWith('data: ')) data += line.slice(6)
              else if (line.startsWith('data:')) data += line.slice(5)
            }

            if (data) {
              try {
                this.routeEvent(JSON.parse(data) as OpenCodeEvent)
              } catch { /* ignore parse errors */ }
            }
          }
        }
      } catch (err) {
        if (signal.aborted) return
        console.error('[OpenCode] SSE stream error, reconnecting in 2s:', err instanceof Error ? err.message : err)
      }

      console.log('[OpenCode] SSE stream disconnected, reconnecting in 2s...')
      await this.delay(2000, signal)
    }
  }

  private delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    })
  }

  private routeEvent(event: OpenCodeEvent) {
    // Auto-approve permission requests so tool calls (write, edit, etc.) aren't blocked
    if (event.type === 'permission.updated') {
      const props = event.properties as { id?: string; sessionID?: string }
      console.log('[OpenCode] Permission event:', event.type, 'id:', props.id, 'session:', props.sessionID)
      if (props.id && props.sessionID) {
        this.approvePermission(props.sessionID, props.id)
      }
    }

    const { sessionId, streamEvents } = this.transformEvent(event)
    if (streamEvents.length === 0) return

    for (const streamEvent of streamEvents) {
      if (sessionId) {
        // Buffer non-terminal events for late-joining listeners (e.g. SSE endpoint after page refresh)
        // 'complete' is a terminal signal that should only be dispatched live, never replayed
        if (streamEvent.type !== 'complete') {
          let buffer = this.eventBuffer.get(sessionId)
          if (!buffer) {
            buffer = []
            this.eventBuffer.set(sessionId, buffer)
          }
          buffer.push(streamEvent)
          if (buffer.length > this.MAX_BUFFER_SIZE) {
            buffer.splice(0, buffer.length - this.MAX_BUFFER_SIZE)
          }
        }

        // Dispatch to existing listeners
        const listeners = this.listeners.get(sessionId)
        if (listeners) {
          for (const cb of [...listeners]) cb(streamEvent)
        }
      } else {
        // Broadcast to all listeners in this directory
        for (const [, listeners] of this.listeners) {
          for (const cb of [...listeners]) cb(streamEvent)
        }
      }
    }
  }

  private transformEvent(event: OpenCodeEvent): { sessionId: string | null; streamEvents: StreamEvent[] } {
    const events: StreamEvent[] = []

    switch (event.type) {
      case 'message.part.delta': {
        const props = event.properties as { sessionID?: string; partID?: string; field?: string; delta?: string }
        if (!props.delta) return { sessionId: props.sessionID ?? null, streamEvents: [] }

        const partType = this.partTypes.get(props.partID ?? '')
        if (partType === 'text') {
          events.push({ type: 'text-delta', content: props.delta })
        } else if (partType === 'reasoning') {
          events.push({ type: 'thinking', id: props.partID ?? '', content: props.delta, done: false })
        }
        return { sessionId: props.sessionID ?? null, streamEvents: events }
      }

      case 'message.part.updated': {
        const props = event.properties as { part?: OpenCodePart }
        const part = props.part
        if (!part) return { sessionId: null, streamEvents: [] }

        const sessionId = part.sessionID ?? null

        if (part.id && part.type) {
          this.partTypes.set(part.id, part.type)
        }

        if (part.type === 'reasoning' && part.time?.end) {
          events.push({ type: 'thinking', id: part.id ?? '', content: '', done: true })
        } else if (part.type === 'tool') {
          const toolEvent = this.transformToolPart(part)
          if (toolEvent) events.push(toolEvent)
        }

        return { sessionId, streamEvents: events }
      }

      case 'session.status': {
        const props = event.properties as { sessionID?: string; status?: { type?: string } }
        const statusType = props.status?.type
        const sessionId = props.sessionID ?? null
        if (statusType === 'busy') {
          if (sessionId) this.cancelIdleComplete(sessionId)
          events.push({ type: 'status', status: 'running' })
        } else if (statusType === 'idle') {
          if (sessionId) this.scheduleIdleComplete(sessionId)
          events.push({ type: 'status', status: 'idle' })
        }
        return { sessionId, streamEvents: events }
      }

      case 'session.idle': {
        const props = event.properties as { sessionID?: string }
        const sessionId = props.sessionID ?? null
        if (sessionId) {
          this.scheduleIdleComplete(sessionId)
        }
        return { sessionId, streamEvents: [] }
      }

      case 'todo.updated': {
        const props = event.properties as { sessionID?: string; todos?: OpenCodeTodo[] }
        events.push({
          type: 'todo',
          items: (props.todos ?? []).map((t) => ({
            id: t.id ?? '',
            content: t.content ?? '',
            status: t.status ?? 'pending',
            priority: t.priority ?? 'medium',
          })),
        })
        return { sessionId: props.sessionID ?? null, streamEvents: events }
      }

      case 'session.diff': {
        const props = event.properties as {
          sessionID?: string
          diff?: Array<{ file?: string; status?: string; additions?: number; deletions?: number }>
        }
        // Emit file-change events (triggers file tree refresh) instead of file-op events
        // (which would create duplicate badges alongside the tool-call-based badges)
        for (const entry of props.diff ?? []) {
          if (!entry.file) continue
          events.push({
            type: 'file-change',
            file: this.makeRelativePath(entry.file),
          })
        }
        return { sessionId: props.sessionID ?? null, streamEvents: events }
      }

      case 'file.edited': {
        return { sessionId: null, streamEvents: [] }
      }

      case 'message.updated': {
        const props = event.properties as {
          info?: {
            sessionID?: string
            role?: string
            time?: { created?: number; completed?: number }
            error?: { name?: string; data?: { message?: string } }
          }
        }
        const sessionId = props.info?.sessionID ?? null
        if (props.info?.error) {
          events.push({ type: 'error', message: props.info.error.data?.message ?? 'Unknown error' })
        }
        return { sessionId, streamEvents: events }
      }

      case 'session.error': {
        const props = event.properties as { sessionID?: string; error?: string }
        events.push({ type: 'error', message: props.error ?? 'Session error' })
        return { sessionId: props.sessionID ?? null, streamEvents: events }
      }

      default:
        return { sessionId: null, streamEvents: [] }
    }
  }

  private approvePermission(sessionId: string, permissionId: string) {
    console.log('[OpenCode] Attempting to approve permission:', permissionId, 'for session:', sessionId)
    fetch(`${this.baseUrl}/session/${sessionId}/permissions/${permissionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: 'always' }),
      signal: AbortSignal.timeout(5000),
    }).catch((err) => {
      console.error('[OpenCode] Permission approval failed:', permissionId, err instanceof Error ? err.message : err)
    })
  }

  private scheduleIdleComplete(sessionId: string) {
    this.cancelIdleComplete(sessionId)
    console.log('[OpenCode] Scheduling idle complete for session:', sessionId, '(30s timer)')
    // Primary completion mechanism: schedule a debounced complete event.
    // If another step starts (session.status: busy), the timer is cancelled.
    // 30s is long enough to cover gaps between multi-step tool calls
    // (plugin creation can have long pauses between steps),
    // while still completing reasonably quickly after the task finishes.
    const timer = setTimeout(() => {
      this.idleTimers.delete(sessionId)
      console.log('[OpenCode] Idle timer fired for session:', sessionId, '— dispatching complete')
      this.dispatchToSession(sessionId, { type: 'complete' })
    }, 30_000)
    this.idleTimers.set(sessionId, timer)
  }

  private cancelIdleComplete(sessionId: string) {
    const timer = this.idleTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.idleTimers.delete(sessionId)
    }
  }

  clearBuffer(sessionId: string) {
    this.eventBuffer.delete(sessionId)
    this.cancelIdleComplete(sessionId)
  }

  dispatchComplete(sessionId: string) {
    this.cancelIdleComplete(sessionId)
    console.log('[OpenCode] Dispatching complete for session:', sessionId)
    this.dispatchToSession(sessionId, { type: 'complete' })
  }

  dispatchError(sessionId: string, message: string) {
    this.dispatchToSession(sessionId, { type: 'error', message })
  }

  private dispatchToSession(sessionId: string, event: StreamEvent) {
    // Buffer non-terminal events for late-joining listeners
    if (event.type !== 'complete') {
      let buffer = this.eventBuffer.get(sessionId)
      if (!buffer) {
        buffer = []
        this.eventBuffer.set(sessionId, buffer)
      }
      buffer.push(event)
      if (buffer.length > this.MAX_BUFFER_SIZE) {
        buffer.splice(0, buffer.length - this.MAX_BUFFER_SIZE)
      }
    }
    // Always dispatch to live listeners
    const listeners = this.listeners.get(sessionId)
    if (listeners) {
      for (const cb of [...listeners]) cb(event)
    }
  }

  private transformToolPart(part: OpenCodePart): StreamEvent | null {
    const toolName = (part.tool ?? '').toLowerCase()
    const action = TOOL_TO_FILE_ACTION[toolName]

    const state = part.state
    if (!state) return null

    let status: 'running' | 'completed' | 'error'
    if (state.status === 'completed') status = 'completed'
    else if (state.status === 'error') status = 'error'
    else status = 'running'

    if (!action) {
      const input = state.input ?? {}
      const label = String(input.path ?? input.pattern ?? input.command ?? toolName)
      return {
        type: 'file-op',
        id: part.callID ?? part.id ?? '',
        action: 'tool',
        path: label,
        status,
        tool: part.tool ?? toolName,
      }
    }

    const input = state.input ?? {}
    const rawPath = extractFilePath(input)
    if (!rawPath) return null

    const path = this.makeRelativePath(rawPath)
    const rawNewPath = action === 'rename' ? extractNewPath(input) : undefined

    return {
      type: 'file-op',
      id: part.callID ?? part.id ?? '',
      action,
      path,
      newPath: rawNewPath ? this.makeRelativePath(rawNewPath) : undefined,
      status,
      tool: toolName,
    }
  }
}

// ── Subscription Manager ─────────────────────────────────────────────

export class SubscriptionManager {
  private connections = new Map<string, SSEConnection>()
  private disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private baseUrl: string) {}

  subscribe(
    directory: string,
    opencodeSessionId: string,
    callback: (event: StreamEvent) => void,
  ): () => void {
    // Cancel any pending disconnect for this directory
    const pendingTimer = this.disconnectTimers.get(directory)
    if (pendingTimer) {
      clearTimeout(pendingTimer)
      this.disconnectTimers.delete(directory)
    }

    let conn = this.connections.get(directory)
    if (!conn) {
      conn = new SSEConnection(this.baseUrl, directory)
      this.connections.set(directory, conn)
      conn.connect()
    }

    conn.addListener(opencodeSessionId, callback)

    const connection = conn
    return () => {
      connection.removeListener(opencodeSessionId, callback)
      if (connection.listenerCount === 0) {
        // Grace period: keep connection + buffer alive for late-joining subscribers
        const timer = setTimeout(() => {
          this.disconnectTimers.delete(directory)
          if (connection.listenerCount === 0) {
            connection.disconnect()
            this.connections.delete(directory)
          }
        }, 30_000)
        this.disconnectTimers.set(directory, timer)
      }
    }
  }

  clearBuffer(directory: string, sessionId: string) {
    const conn = this.connections.get(directory)
    if (conn) conn.clearBuffer(sessionId)
  }

  dispatchComplete(directory: string, sessionId: string) {
    const conn = this.connections.get(directory)
    if (conn) conn.dispatchComplete(sessionId)
  }

  dispatchError(directory: string, sessionId: string, message: string) {
    const conn = this.connections.get(directory)
    if (conn) conn.dispatchError(sessionId, message)
  }
}

// ── OpenCode Bridge ──────────────────────────────────────────────────

export class OpenCodeBridge implements BridgeInterface {
  name = 'opencode'
  private baseUrl: string
  private activeSessions = new Map<string, AbortController>()
  private available = false
  private lastAvailabilityCheck = 0
  readonly subscriptionManager: SubscriptionManager

  constructor() {
    this.baseUrl = env.OPENCODE_URL
    this.subscriptionManager = new SubscriptionManager(this.baseUrl)
  }

  async initialize(): Promise<void> {
    await this.checkAvailability()
  }

  private async checkAvailability(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/session`, {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
      })
      this.available = res.ok
    } catch {
      this.available = false
    }
    this.lastAvailabilityCheck = Date.now()
    return this.available
  }

  isAvailable(): boolean {
    if (Date.now() - this.lastAvailabilityCheck > 30000) {
      this.checkAvailability()
    }
    return this.available
  }

  async executeTask(task: BridgeTask): Promise<BridgeResult> {
    return this.streamResponse(task, () => {})
  }

  async createOrResolveSession(directory: string, title?: string, existingId?: string): Promise<string> {
    if (existingId) {
      try {
        const res = await fetch(`${this.baseUrl}/session/${existingId}`, {
          method: 'GET',
          signal: AbortSignal.timeout(5000),
        })
        if (res.ok) return existingId
      } catch { /* session not found, create new */ }
    }

    const url = new URL(`${this.baseUrl}/session`)
    if (directory) url.searchParams.set('directory', directory)

    const body: Record<string, string> = {}
    if (title) body.title = title

    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    })

    if (!res.ok) {
      throw new Error(`Failed to create OpenCode session: status ${res.status}`)
    }

    const session = (await res.json()) as OpenCodeSession
    return session.id
  }

  async sendPromptAsync(sessionId: string, prompt: string, model?: string): Promise<void> {
    const body: Record<string, unknown> = {
      parts: [{ type: 'text', text: prompt }],
    }

    if (model && model.includes('/')) {
      const [providerID, ...rest] = model.split('/')
      const modelID = rest.join('/')
      body.model = { providerID, modelID }
    }

    const res = await fetch(`${this.baseUrl}/session/${sessionId}/prompt_async`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })

    if (res.status !== 204 && !res.ok) {
      const errText = await res.text().catch(() => 'Unknown error')
      throw new Error(`Failed to send prompt: status ${res.status}: ${errText}`)
    }
  }

  async streamResponse(task: BridgeTask, onEvent: (event: BridgeStreamEvent) => void): Promise<BridgeResult> {
    const controller = new AbortController()
    this.activeSessions.set(task.sessionId, controller)

    try {
      const reachable = await this.checkAvailability()
      if (!reachable) {
        return {
          success: false,
          output: '',
          error: `OpenCode server is not reachable at ${this.baseUrl}. Make sure OpenCode is running with: opencode serve`,
        }
      }

      console.log('[OpenCode] Starting stream for session:', task.sessionId, 'project:', task.projectId)
      onEvent({ type: 'status', content: 'Connecting to OpenCode...', timestamp: new Date().toISOString() })

      const directory = task.context?.projectDirectory ?? '.'
      const opencodeSessionId = await this.createOrResolveSession(
        directory,
        task.context?.projectLinkId ?? task.projectId,
        task.context?.opencodeSessionId,
      )

      onEvent({ type: 'status', content: 'Sending prompt to AI agent...', timestamp: new Date().toISOString() })

      // Clear stale buffered events from previous messages so they aren't replayed
      this.subscriptionManager.clearBuffer(directory, opencodeSessionId)

      // Subscribe to events for real-time forwarding + completion detection
      const collectedText: string[] = []
      const thinkingParts = new Map<string, { content: string; done: boolean }>()
      const filePartsById = new Map<string, { action: string; path: string; newPath?: string; tool: string }>()
      const seenParts = new Set<string>()
      const orderedRefs: Array<{ type: 'thinking' | 'file' | 'tool' | 'text'; id: string }> = []
      let latestTodos: TodoItem[] = []
      let resolved = false

      let timedOut = false
      let lastEventTime = Date.now()

      // Track intermediate text segments for proper ordering
      const textSegments: Array<{ id: string; text: string }> = []
      let pendingText = ''

      const completionPromise = new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (!resolved) { resolved = true; timedOut = true; unsub?.(); resolve() }
        }, 1800000)

        let unsub: (() => void) | null = null
        unsub = this.subscriptionManager.subscribe(directory, opencodeSessionId, (event) => {
          if (controller.signal.aborted || resolved) return
          lastEventTime = Date.now()

          switch (event.type) {
            case 'text-delta':
              pendingText += event.content
              collectedText.push(event.content)
              onEvent({ type: 'text-delta', content: event.content, timestamp: new Date().toISOString() })
              break

            case 'thinking': {
              // Capture any pending text as a segment before adding thinking
              if (pendingText.trim()) {
                const textId = `text-${textSegments.length}`
                textSegments.push({ id: textId, text: pendingText.trim() })
                orderedRefs.push({ type: 'text', id: textId })
              }
              pendingText = ''

              const existing = thinkingParts.get(event.id) ?? { content: '', done: false }
              existing.content += event.content
              existing.done = event.done
              thinkingParts.set(event.id, existing)
              if (!seenParts.has(event.id)) {
                seenParts.add(event.id)
                orderedRefs.push({ type: 'thinking', id: event.id })
              }
              onEvent({ type: 'thinking', content: event.content, timestamp: new Date().toISOString() })
              break
            }

            case 'file-op': {
              // Capture any pending text as a segment before adding file-op
              if (pendingText.trim()) {
                const textId = `text-${textSegments.length}`
                textSegments.push({ id: textId, text: pendingText.trim() })
                orderedRefs.push({ type: 'text', id: textId })
              }
              pendingText = ''

              if (!seenParts.has(event.id)) {
                seenParts.add(event.id)
                orderedRefs.push({ type: event.action === 'tool' ? 'tool' : 'file', id: event.id })
              }
              if (event.status === 'completed' || event.status === 'error') {
                filePartsById.set(event.id, {
                  action: event.action,
                  path: event.path,
                  newPath: event.newPath,
                  tool: event.tool,
                })
              }
              const verb = event.status === 'running'
                ? `${event.action.replace(/e$/, '')}ing`
                : `${event.action}${event.action.endsWith('e') ? 'd' : 'ed'}`
              onEvent({
                type: 'file-op',
                content: `${verb} ${event.path}`,
                timestamp: new Date().toISOString(),
                metadata: { action: event.action, path: event.path, newPath: event.newPath, status: event.status },
              })
              break
            }

            case 'todo':
              latestTodos = event.items.map((t) => ({
                text: t.content,
                status: t.status === 'completed'
                  ? 'completed' as const
                  : t.status === 'in_progress'
                    ? 'in-progress' as const
                    : 'pending' as const,
              }))
              onEvent({ type: 'todo', content: JSON.stringify(event.items), timestamp: new Date().toISOString() })
              break

            case 'status':
              onEvent({ type: 'status', content: event.status, timestamp: new Date().toISOString() })
              break

            case 'complete':
              if (!resolved) {
                resolved = true
                clearTimeout(timeout)
                unsub?.()
                resolve()
              }
              break

            case 'error':
              onEvent({ type: 'error', content: event.message, timestamp: new Date().toISOString() })
              break
          }
        })

        controller.signal.addEventListener('abort', () => {
          if (!resolved) {
            resolved = true
            clearTimeout(timeout)
            unsub?.()
            resolve()
          }
        }, { once: true })
      })

      // Build context prompt and send to OpenCode
      const contextPrompt = this.buildContextPrompt(task)

      // Get baseline assistant message count before sending prompt
      // so pollUntilIdle only considers NEW messages for completion
      let baselineAssistantCount = 0
      try {
        const msgRes = await fetch(`${this.baseUrl}/session/${opencodeSessionId}/message`, {
          method: 'GET',
          signal: AbortSignal.timeout(5000),
        })
        if (msgRes.ok) {
          const existingMessages = (await msgRes.json()) as OpenCodeMessage[]
          baselineAssistantCount = existingMessages.filter((m) => m.info?.role === 'assistant').length
        }
      } catch {
        // If we can't determine baseline, set high so poll waits for SSE-based completion instead
        baselineAssistantCount = Number.MAX_SAFE_INTEGER
      }

      console.log('[OpenCode] Sending prompt to session:', opencodeSessionId, 'baseline msgs:', baselineAssistantCount)
      await this.sendPromptAsync(opencodeSessionId, contextPrompt, task.context?.model)
      console.log('[OpenCode] Prompt sent successfully')

      // Start permission polling to detect stuck permissions
      const permAbort = new AbortController()
      controller.signal.addEventListener('abort', () => permAbort.abort(), { once: true })
      this.pollPermissions(opencodeSessionId, permAbort.signal)

      // Monitor for stuck operations — warn user if no events for 3 minutes
      const progressChecker = setInterval(() => {
        if (resolved || controller.signal.aborted) {
          clearInterval(progressChecker)
          return
        }
        const elapsed = Date.now() - lastEventTime
        if (elapsed > 180000) {
          const stuckMsg = 'No progress detected for 3 minutes — the operation may be stuck. You can cancel and retry.'
          onEvent({ type: 'error', content: stuckMsg, timestamp: new Date().toISOString() })
          this.subscriptionManager.dispatchError(directory, opencodeSessionId, stuckMsg)
          lastEventTime = Date.now()
        }
      }, 60000)

      // Wait for completion via SSE events, with polling fallback
      const pollFallback = this.pollUntilIdle(opencodeSessionId, controller.signal, baselineAssistantCount)
      await Promise.race([completionPromise, pollFallback]).catch(() => {})
      clearInterval(progressChecker)

      // Stop permission polling once the main stream completes
      permAbort.abort()

      // Handle timeout — return failure instead of silently succeeding
      if (timedOut) {
        this.subscriptionManager.dispatchComplete(directory, opencodeSessionId)
        onEvent({ type: 'error', content: 'Session timed out — the AI agent may still be working in the background. You can send a new message to check.', timestamp: new Date().toISOString() })
        onEvent({ type: 'complete', content: 'Timed out', timestamp: new Date().toISOString() })
        const partialText = await this.fetchAssistantText(opencodeSessionId)

        // Flush any remaining pending text into segments
        if (pendingText.trim()) {
          const textId = `text-${textSegments.length}`
          textSegments.push({ id: textId, text: pendingText.trim() })
          orderedRefs.push({ type: 'text', id: textId })
          pendingText = ''
        }

        // Assemble partial metadata so file-op badges are preserved
        const timeoutParts: MessagePart[] = []
        for (const ref of orderedRefs) {
          if (ref.type === 'thinking') {
            const t = thinkingParts.get(ref.id)
            if (t) timeoutParts.push({ type: 'thinking', content: t.content })
          } else if (ref.type === 'text') {
            const seg = textSegments.find((s) => s.id === ref.id)
            if (seg) timeoutParts.push({ type: 'text', content: seg.text })
          } else {
            const fp = filePartsById.get(ref.id)
            if (fp) {
              if (fp.action === 'tool') {
                timeoutParts.push({ type: 'tool', tool: fp.tool, path: fp.path })
              } else {
                timeoutParts.push({
                  type: 'file',
                  action: fp.action as 'create' | 'update' | 'delete' | 'rename' | 'read',
                  path: fp.path,
                  newPath: fp.newPath,
                })
              }
            }
          }
        }

        return {
          success: false,
          output: partialText || collectedText.join(''),
          error: 'Session timed out after 30 minutes',
          metadata: {
            opencodeSessionId,
            parts: timeoutParts.length > 0 ? timeoutParts : undefined,
          },
        }
      }

      // Handle abort/cancellation
      if (controller.signal.aborted) {
        return { success: false, output: '', error: 'Execution cancelled', metadata: { opencodeSessionId } }
      }

      // If poll fallback resolved but SSE hasn't sent 'complete' yet,
      // dispatch it now so the frontend SSE listener gets the signal promptly
      if (!resolved) {
        console.log('[OpenCode] Poll fallback resolved before SSE complete — dispatching complete for:', opencodeSessionId)
        resolved = true
        this.subscriptionManager.dispatchComplete(directory, opencodeSessionId)
      }

      onEvent({ type: 'status', content: 'AI agent completed. Processing response...', timestamp: new Date().toISOString() })

      // Fetch full messages from OpenCode for accurate persistence
      const fullText = await this.fetchAssistantText(opencodeSessionId)
      const outputText = fullText || collectedText.join('')
      console.log('[OpenCode] Stream complete for session:', opencodeSessionId, 'text length:', outputText.length, 'parts:', orderedRefs.length)

      onEvent({ type: 'complete', content: 'Done', timestamp: new Date().toISOString() })

      // Flush any remaining pending text into segments so the last text block is included in parts
      if (pendingText.trim()) {
        const textId = `text-${textSegments.length}`
        textSegments.push({ id: textId, text: pendingText.trim() })
        orderedRefs.push({ type: 'text', id: textId })
        pendingText = ''
      }

      // Assemble metadata parts
      const parts: MessagePart[] = []
      for (const ref of orderedRefs) {
        if (ref.type === 'thinking') {
          const t = thinkingParts.get(ref.id)
          if (t) parts.push({ type: 'thinking', content: t.content })
        } else if (ref.type === 'text') {
          const seg = textSegments.find((s) => s.id === ref.id)
          if (seg) parts.push({ type: 'text', content: seg.text })
        } else {
          const fp = filePartsById.get(ref.id)
          if (fp) {
            if (fp.action === 'tool') {
              parts.push({ type: 'tool', tool: fp.tool, path: fp.path })
            } else {
              parts.push({
                type: 'file',
                action: fp.action as 'create' | 'update' | 'delete' | 'rename' | 'read',
                path: fp.path,
                newPath: fp.newPath,
              })
            }
          }
        }
      }
      if (latestTodos.length > 0) {
        parts.push({ type: 'todo-list', items: latestTodos })
      }

      return {
        success: true,
        output: outputText,
        metadata: {
          opencodeSessionId,
          parts: parts.length > 0 ? parts : undefined,
        },
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return { success: false, output: '', error: 'Execution cancelled' }
      }
      const msg = err instanceof Error ? err.message : 'Unknown error'
      console.error('[OpenCode] Bridge error for session:', task.sessionId, msg)
      return { success: false, output: '', error: `OpenCode bridge error: ${msg}` }
    } finally {
      this.activeSessions.delete(task.sessionId)
    }
  }

  async cancelExecution(sessionId: string): Promise<void> {
    const controller = this.activeSessions.get(sessionId)
    if (controller) {
      controller.abort()
      this.activeSessions.delete(sessionId)
    }
  }

  async deleteSession(opencodeSessionId: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/session/${opencodeSessionId}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(5000),
      })
    } catch { /* best-effort cleanup */ }
  }

  // ── Private helpers ──────────────────────────────────────────────

  private async pollPermissions(sessionId: string, signal: AbortSignal): Promise<void> {
    // Diagnostic: periodically check for pending permissions that may block tool execution
    while (!signal.aborted) {
      await new Promise((r) => setTimeout(r, 10000))
      if (signal.aborted) return
      try {
        const res = await fetch(`${this.baseUrl}/permission`, {
          method: 'GET',
          signal: AbortSignal.timeout(5000),
        })
        if (res.ok) {
          const permissions = (await res.json()) as Array<{ id?: string; sessionID?: string; permission?: string; metadata?: Record<string, unknown> }>
          const pending = permissions.filter((p) => p.sessionID === sessionId)
          if (pending.length > 0) {
            console.warn('[OpenCode] ⚠ STUCK PERMISSION DETECTED for session:', sessionId,
              pending.map((p) => `${p.permission} (${p.id})`).join(', '))
          }
        }
      } catch { /* ignore polling errors */ }
    }
  }

  private async pollUntilIdle(sessionId: string, signal: AbortSignal, baselineAssistantCount: number): Promise<void> {
    // Initial delay before polling starts
    await new Promise((r) => setTimeout(r, 5000))

    let quietSince = 0
    let lastSeenCount = baselineAssistantCount

    while (!signal.aborted) {
      try {
        const res = await fetch(`${this.baseUrl}/session/${sessionId}/message`, {
          method: 'GET',
          signal: AbortSignal.timeout(5000),
        })
        if (res.ok) {
          const messages = (await res.json()) as OpenCodeMessage[]
          const assistantMessages = messages.filter((m) => m.info?.role === 'assistant')
          if (assistantMessages.length > baselineAssistantCount) {
            // Reset quiet timer when new messages appear (new step started)
            if (assistantMessages.length !== lastSeenCount) {
              lastSeenCount = assistantMessages.length
              quietSince = 0
            }
            const lastAssistant = assistantMessages[assistantMessages.length - 1]
            if (lastAssistant?.info?.time?.completed) {
              if (quietSince === 0) {
                quietSince = Date.now()
              } else if (Date.now() - quietSince >= 15000) {
                return
              }
            } else {
              quietSince = 0
            }
          }
        }
      } catch { /* ignore polling errors */ }

      await new Promise((r) => setTimeout(r, 3000))
    }
  }

  private async fetchAssistantText(sessionId: string): Promise<string> {
    try {
      const res = await fetch(`${this.baseUrl}/session/${sessionId}/message`, {
        method: 'GET',
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) return ''

      const messages = (await res.json()) as OpenCodeMessage[]
      const assistantMessages = messages.filter((m) => m.info?.role === 'assistant')
      const lastAssistant = assistantMessages[assistantMessages.length - 1]
      if (!lastAssistant) return ''

      return this.extractTextFromMessage(lastAssistant)
    } catch {
      return ''
    }
  }

  private extractTextFromMessage(message: OpenCodeMessage): string {
    const textChunks: string[] = []

    if (Array.isArray(message.parts)) {
      for (const part of message.parts) {
        if (part.type === 'text' || part.type === 'text-delta' || part.type === 'text-start') {
          const text = part.text ?? (part as Record<string, unknown>).content ?? ''
          if (typeof text === 'string' && text) textChunks.push(text)
        }
      }
    }

    return textChunks.join('')
  }

  private buildContextPrompt(task: BridgeTask): string {
    const ctx = task.context
    if (!ctx?.projectName) return task.prompt

    const lines: string[] = []
    lines.push('[AuroraCraft Project Context]')
    lines.push(`Project: ${ctx.projectName}`)
    if (ctx.software) lines.push(`Server Software: ${ctx.software}`)
    if (ctx.language) lines.push(`Language: ${ctx.language}`)
    if (ctx.compiler) lines.push(`Build Tool: ${ctx.compiler}`)
    if (ctx.javaVersion) lines.push(`Java Version: ${ctx.javaVersion}`)
    if (ctx.projectDirectory) {
      lines.push('')
      lines.push(`Working Directory: ${ctx.projectDirectory}`)
      lines.push(`IMPORTANT: Your current working directory may NOT be the project directory. You MUST create all files using absolute paths under ${ctx.projectDirectory}/. For example, to create build.gradle, write to ${ctx.projectDirectory}/build.gradle. Do NOT create files in any other location.`)
    }
    lines.push('')
    lines.push('RESTRICTIONS:')
    lines.push('- Do NOT execute build commands (mvn, gradle, javac, make)')
    lines.push('- Do NOT execute destructive or long-running terminal commands')
    lines.push('- You may only use terminal for file/folder finding and essential read operations')
    lines.push('- Focus on writing clean, well-structured Minecraft plugin code')
    lines.push('')
    lines.push(`User Request: ${task.prompt}`)

    return lines.join('\n')
  }
}
