export interface User {
  id: string
  username: string
  email: string
  role: 'user' | 'admin'
  createdAt: string
  updatedAt: string
}

export interface Project {
  id: string
  userId: string
  name: string
  linkId: string | null
  description: string | null
  status: 'active' | 'archived'
  software: string
  language: 'java' | 'kotlin'
  javaVersion: string
  compiler: 'maven' | 'gradle'
  createdAt: string
  updatedAt: string
}

export interface CreateProjectInput {
  name: string
  description?: string
  software?: string
  language?: 'java' | 'kotlin'
  javaVersion?: string
  compiler?: 'maven' | 'gradle'
}

export interface UpdateProjectInput {
  name?: string
  description?: string | null
  status?: 'active' | 'archived'
  software?: string
  language?: 'java' | 'kotlin'
  javaVersion?: string
  compiler?: 'maven' | 'gradle'
}

export type AgentStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface AgentSession {
  id: string
  projectId: string
  status: AgentStatus
  opencodeSessionId?: string | null
  createdAt: string
  updatedAt: string
}

export interface AgentSessionWithMessages extends AgentSession {
  messages: AgentMessage[]
}

export interface AgentMessage {
  id: string
  sessionId: string
  role: 'user' | 'agent' | 'system'
  content: string
  metadata?: MessageMetadata | null
  createdAt: string
}

export interface MessageMetadata {
  parts?: MessagePart[]
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

export interface AgentLog {
  id: string
  sessionId: string
  logType: string
  message: string
  createdAt: string
}

export interface AdminStats {
  totalUsers: number
  totalProjects: number
  totalAgentSessions: number
}

export interface AdminProject {
  id: string
  name: string
  status: 'active' | 'archived'
  software: string
  language: 'java' | 'kotlin'
  compiler: 'maven' | 'gradle'
  createdAt: string
  updatedAt: string
  ownerUsername: string | null
}

export interface AIModel {
  id: string
  name: string
  provider: string
  description: string
}

export const AI_MODELS: AIModel[] = [
  { id: 'opencode/minimax-m2.5-free', name: 'MiniMax M2.5', provider: 'MiniMax', description: 'Free, fast AI model for coding tasks' },
  { id: 'opencode/mimo-v2-flash-free', name: 'Mimo V2 Flash', provider: 'Mimo', description: 'Free flash model optimized for code generation' },
  { id: 'opencode/nemotron-3-super-free', name: 'Nemotron 3 Super', provider: 'NVIDIA', description: 'Free NVIDIA model with strong reasoning capabilities' },
  { id: 'opencode/gpt-5-nano', name: 'GPT-5 Nano', provider: 'OpenAI', description: 'Compact free model with GPT-5 intelligence' },
  { id: 'opencode/big-pickle', name: 'Big Pickle', provider: 'OpenCode', description: 'Free community model for general coding' },
]

export const DEFAULT_MODEL_ID = AI_MODELS[0].id

// ── Streaming event types (mirroring server StreamEvent) ─────────────

export type StreamEvent =
  | { type: 'text-delta'; content: string }
  | { type: 'thinking'; id: string; content: string; done: boolean }
  | { type: 'file-op'; id: string; action: string; path: string; newPath?: string; status: 'running' | 'completed' | 'error'; tool: string }
  | { type: 'todo'; items: StreamTodoItem[] }
  | { type: 'status'; status: string; message?: string }
  | { type: 'file-change'; file: string }
  | { type: 'error'; message: string }
  | { type: 'complete' }

export interface StreamTodoItem {
  id: string
  content: string
  status: string
  priority: string
}

export interface FileTreeEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileTreeEntry[]
}

// ── Streaming state for real-time rendering ──────────────────────────

export interface ThinkingBlock {
  id: string
  content: string
  done: boolean
  order: number
}

export interface FileOpBlock {
  id: string
  action: string
  path: string
  newPath?: string
  status: 'running' | 'completed' | 'error'
  tool: string
  order: number
}

export interface StreamingState {
  text: string
  thinkingBlocks: ThinkingBlock[]
  fileOps: FileOpBlock[]
  todos: StreamTodoItem[]
  isStreaming: boolean
  fileChanges: string[]
}

export interface ApiError {
  message: string
  statusCode: number
}
