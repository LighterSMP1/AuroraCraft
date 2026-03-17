export interface BridgeTask {
  sessionId: string
  projectId: string
  prompt: string
  context?: {
    opencodeSessionId?: string
    model?: string
    projectLinkId?: string
    projectName?: string
    software?: string
    language?: string
    compiler?: string
    javaVersion?: string
    projectDirectory?: string
  }
}

export interface BridgeStreamEvent {
  type: 'output' | 'error' | 'status' | 'complete' | 'thinking' | 'file-op' | 'todo'
  content: string
  timestamp: string
  metadata?: Record<string, unknown>
}

export type MessagePart =
  | { type: 'thinking'; content: string }
  | { type: 'file'; action: 'create' | 'update' | 'delete' | 'rename' | 'read'; path: string; newPath?: string }
  | { type: 'tool'; tool: string; path: string }
  | { type: 'todo-list'; items: TodoItem[] }

export interface TodoItem {
  text: string
  status: 'pending' | 'in-progress' | 'completed'
}

export interface BridgeResult {
  success: boolean
  output: string
  files?: Array<{ path: string; content: string }>
  error?: string
  metadata?: {
    opencodeSessionId?: string
    parts?: MessagePart[]
  }
}

export interface BridgeInterface {
  name: string
  initialize(): Promise<void>
  executeTask(task: BridgeTask): Promise<BridgeResult>
  streamResponse(task: BridgeTask, onEvent: (event: BridgeStreamEvent) => void): Promise<BridgeResult>
  cancelExecution(sessionId: string): Promise<void>
  isAvailable(): boolean
}

// ── Streaming event types (for SSE forwarding to client) ─────────────

export type StreamEvent =
  | { type: 'text-delta'; content: string }
  | { type: 'thinking'; id: string; content: string; done: boolean }
  | { type: 'file-op'; id: string; action: string; path: string; newPath?: string; status: 'running' | 'completed' | 'error'; tool: string }
  | { type: 'todo'; items: StreamTodoItem[] }
  | { type: 'status'; status: 'running' | 'idle' | 'error'; message?: string }
  | { type: 'file-change'; file: string }
  | { type: 'error'; message: string }
  | { type: 'complete' }

export interface StreamTodoItem {
  id: string
  content: string
  status: string
  priority: string
}
