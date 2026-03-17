import { useState, useRef, useEffect, useCallback } from 'react'
import { Link, useParams } from 'react-router'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import {
  ArrowLeft,
  File,
  FilePlus2,
  FilePenLine,
  FileX2,
  FileSymlink,
  FileSearch,
  Folder,
  FolderOpen,
  Play,
  Settings,
  Send,
  MessageSquare,
  Bot,
  User,
  Loader2,
  AlertCircle,
  Brain,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Circle,
  ListTodo,
  Cpu,
  RefreshCw,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useProject } from '@/hooks/use-projects'
import { useAgentSessions, useAgentSession, useStreamingAgent, useProjectFiles } from '@/hooks/use-agent'
import { AI_MODELS, DEFAULT_MODEL_ID } from '@/types'
import type {
  AgentMessage,
  MessagePart,
  TodoItem,
  FileTreeEntry,
  ThinkingBlock,
  FileOpBlock,
  StreamTodoItem,
  StreamingState,
} from '@/types'

// ── Markdown renderer ────────────────────────────────────────────────

function MarkdownContent({ content }: { content: string }) {
  if (!content) return null
  return (
    <div className="markdown-content text-sm">
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {content}
      </Markdown>
    </div>
  )
}

// ── File tree ────────────────────────────────────────────────────────

function FileTreeNode({ entry, depth = 0 }: { entry: FileTreeEntry; depth?: number }) {
  const [expanded, setExpanded] = useState(depth < 2)
  const pl = depth * 12 + 8

  if (entry.type === 'directory') {
    const DirIcon = expanded ? FolderOpen : Folder
    return (
      <div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-center gap-1.5 py-1 text-xs text-text-muted hover:bg-surface-hover hover:text-text"
          style={{ paddingLeft: pl }}
        >
          <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', expanded && 'rotate-90')} />
          <DirIcon className="h-3.5 w-3.5 shrink-0 text-primary/70" />
          <span className="truncate">{entry.name}</span>
        </button>
        {expanded && entry.children?.map((child) => (
          <FileTreeNode key={child.path} entry={child} depth={depth + 1} />
        ))}
      </div>
    )
  }

  return (
    <div
      className="flex items-center gap-1.5 py-1 text-xs text-text-dim hover:bg-surface-hover hover:text-text-muted"
      style={{ paddingLeft: pl + 15 }}
    >
      <File className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate" title={entry.path}>{entry.name}</span>
    </div>
  )
}

// ── Static badges (persisted messages) ───────────────────────────────

function FileOpBadge({ part }: { part: Extract<MessagePart, { type: 'file' }> }) {
  const actionConfigs: Record<string, { icon: typeof File; label: string; color: string }> = {
    create: { icon: FilePlus2, label: 'Created', color: 'text-success bg-success/10 border-success/20' },
    update: { icon: FilePenLine, label: 'Updated', color: 'text-[#f97316] bg-[#f97316]/10 border-[#f97316]/20' },
    delete: { icon: FileX2, label: 'Deleted', color: 'text-destructive bg-destructive/10 border-destructive/20' },
    rename: { icon: FileSymlink, label: 'Renamed', color: 'text-warning bg-warning/10 border-warning/20' },
    read: { icon: FileSearch, label: 'Read', color: 'text-primary bg-primary/10 border-primary/20' },
  }
  const config = actionConfigs[part.action] ?? { icon: File, label: 'Modified', color: 'text-text-muted bg-surface-hover border-border' }
  const Icon = config.icon
  const filename = part.path.split('/').pop() ?? part.path

  return (
    <div className={cn('inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs', config.color)}>
      <Icon className="h-3 w-3" />
      <span className="font-medium">{config.label}</span>
      <span className="opacity-75" title={part.path}>{filename}</span>
      {part.action === 'rename' && part.newPath && (
        <span className="opacity-75">→ {part.newPath.split('/').pop()}</span>
      )}
    </div>
  )
}

function ThinkingBadge({ content, defaultExpanded = false }: { content: string; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  return (
    <div className="rounded-lg border border-border bg-surface">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs text-text-muted hover:text-text"
      >
        <Brain className="h-3.5 w-3.5 text-primary" />
        <span className="font-medium">Thinking</span>
        {expanded ? <ChevronDown className="ml-auto h-3 w-3" /> : <ChevronRight className="ml-auto h-3 w-3" />}
      </button>
      {expanded && (
        <div className="border-t border-border px-3 py-2">
          <p className="whitespace-pre-wrap text-xs text-text-dim">{content}</p>
        </div>
      )}
    </div>
  )
}

function ToolBadge({ part }: { part: Extract<MessagePart, { type: 'tool' }> }) {
  return (
    <div className="inline-flex items-center gap-1.5 rounded-md border border-primary/20 bg-primary/10 px-2 py-1 text-xs text-primary">
      <Cpu className="h-3 w-3" />
      <span className="font-medium">Ran</span>
      <span className="opacity-75">{part.tool}</span>
    </div>
  )
}

function TodoListBadge({ items }: { items: TodoItem[] }) {
  const allDone = items.length > 0 && items.every((i) => i.status === 'completed')
  const [expanded, setExpanded] = useState(!allDone)

  if (allDone && !expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="inline-flex items-center gap-1.5 rounded-md border border-success/20 bg-success/10 px-2 py-1 text-xs text-success"
      >
        <CheckCircle2 className="h-3 w-3" />
        <span className="font-medium">{items.length} tasks completed</span>
        <ChevronRight className="ml-1 h-3 w-3" />
      </button>
    )
  }

  return (
    <div className="rounded-lg border border-border bg-surface">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs text-text-muted hover:text-text"
      >
        <ListTodo className="h-3.5 w-3.5 text-primary" />
        <span className="font-medium">Tasks ({items.filter((i) => i.status === 'completed').length}/{items.length})</span>
        {expanded ? <ChevronDown className="ml-auto h-3 w-3" /> : <ChevronRight className="ml-auto h-3 w-3" />}
      </button>
      {expanded && (
        <div className="border-t border-border px-3 py-2 space-y-1.5">
          {items.map((item, i) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              {item.status === 'completed' ? (
                <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-success" />
              ) : item.status === 'in-progress' ? (
                <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-warning" />
              ) : (
                <Circle className="mt-0.5 h-3 w-3 shrink-0 text-text-dim" />
              )}
              <span className={cn(
                item.status === 'completed' ? 'text-text-dim line-through' : 'text-text-muted'
              )}>{item.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Live streaming badges ────────────────────────────────────────────

function StreamingThinkingBadge({ block }: { block: ThinkingBlock }) {
  const [expanded, setExpanded] = useState(true)

  useEffect(() => {
    if (block.done) {
      const timer = setTimeout(() => setExpanded(false), 1200)
      return () => clearTimeout(timer)
    }
  }, [block.done])

  return (
    <div className="rounded-lg border border-border bg-surface">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs text-text-muted hover:text-text"
      >
        <Brain className={cn('h-3.5 w-3.5', block.done ? 'text-primary' : 'text-primary animate-pulse')} />
        <span className="font-medium">{block.done ? 'Thought' : 'Thinking...'}</span>
        {!block.done && <Loader2 className="h-3 w-3 animate-spin text-primary" />}
        <span className="ml-auto">
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </span>
      </button>
      {expanded && block.content && (
        <div className="border-t border-border px-3 py-2">
          <p className="whitespace-pre-wrap text-xs text-text-dim">{block.content}</p>
        </div>
      )}
    </div>
  )
}

function StreamingFileOpBadge({ op }: { op: FileOpBlock }) {
  const isRunning = op.status === 'running'
  const filename = op.path.split('/').pop() ?? op.path

  const configs: Record<string, { icon: typeof File; runLabel: string; doneLabel: string; doneColor: string }> = {
    create: { icon: FilePlus2, runLabel: 'Creating', doneLabel: 'Created', doneColor: 'text-success bg-success/10 border-success/20' },
    update: { icon: FilePenLine, runLabel: 'Updating', doneLabel: 'Updated', doneColor: 'text-[#f97316] bg-[#f97316]/10 border-[#f97316]/20' },
    delete: { icon: FileX2, runLabel: 'Deleting', doneLabel: 'Deleted', doneColor: 'text-destructive bg-destructive/10 border-destructive/20' },
    rename: { icon: FileSymlink, runLabel: 'Renaming', doneLabel: 'Renamed', doneColor: 'text-warning bg-warning/10 border-warning/20' },
    read: { icon: FileSearch, runLabel: 'Reading', doneLabel: 'Read', doneColor: 'text-primary bg-primary/10 border-primary/20' },
    tool: { icon: Cpu, runLabel: 'Running', doneLabel: 'Ran', doneColor: 'text-primary bg-primary/10 border-primary/20' },
  }
  const config = configs[op.action] ?? { icon: File, runLabel: 'Processing', doneLabel: 'Done', doneColor: 'text-text-muted bg-surface-hover border-border' }
  const Icon = config.icon

  if (isRunning) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-hover px-2 py-1 text-xs text-text-dim">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span className="font-medium">{config.runLabel}</span>
        <span className="opacity-75">{op.action === 'tool' ? op.tool : op.path}...</span>
      </div>
    )
  }

  return (
    <div className={cn('inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs', config.doneColor)}>
      <Icon className="h-3 w-3" />
      <span className="font-medium">{config.doneLabel}</span>
      <span className="opacity-75" title={op.path}>{op.action === 'tool' ? op.tool : filename}</span>
      {op.action === 'rename' && op.newPath && (
        <span className="opacity-75">→ {op.newPath.split('/').pop()}</span>
      )}
    </div>
  )
}

function StreamingTodoList({ items }: { items: StreamTodoItem[] }) {
  if (items.length === 0) return null
  const completed = items.filter((i) => i.status === 'completed').length

  return (
    <div className="rounded-lg border border-border bg-surface">
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-text-muted">
        <ListTodo className="h-3.5 w-3.5 text-primary" />
        <span className="font-medium">Tasks ({completed}/{items.length})</span>
      </div>
      <div className="border-t border-border px-3 py-2 space-y-1.5">
        {items.map((item) => (
          <div key={item.id} className="flex items-start gap-2 text-xs">
            {item.status === 'completed' ? (
              <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-success" />
            ) : item.status === 'in_progress' ? (
              <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-warning" />
            ) : (
              <Circle className="mt-0.5 h-3 w-3 shrink-0 text-text-dim" />
            )}
            <span className={cn(
              item.status === 'completed' ? 'text-text-dim line-through' : 'text-text-muted'
            )}>{item.content}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Streaming message (live agent response) ──────────────────────────

function StreamingMessage({ state }: { state: StreamingState }) {
  const hasContent = state.thinkingBlocks.length > 0 || state.fileOps.length > 0 || state.text.length > 0 || state.todos.length > 0

  const allParts = [
    ...state.thinkingBlocks.map((block) => ({ kind: 'thinking' as const, block, order: block.order })),
    ...state.fileOps.map((op) => ({ kind: 'file-op' as const, op, order: op.order })),
  ].sort((a, b) => a.order - b.order)

  const groups: Array<{ kind: 'thinking'; block: ThinkingBlock } | { kind: 'file-ops'; ops: FileOpBlock[] }> = []
  for (const part of allParts) {
    if (part.kind === 'thinking') {
      groups.push({ kind: 'thinking', block: part.block })
    } else {
      const last = groups[groups.length - 1]
      if (last && last.kind === 'file-ops') {
        last.ops.push(part.op)
      } else {
        groups.push({ kind: 'file-ops', ops: [part.op] })
      }
    }
  }

  return (
    <div className="flex gap-2.5">
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-hover">
        <Bot className="h-3.5 w-3.5 text-text-muted" />
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-xs font-medium text-text-muted">AI Agent</p>

        {groups.map((group, i) =>
          group.kind === 'thinking'
            ? <StreamingThinkingBadge key={group.block.id} block={group.block} />
            : <div key={`ops-${i}`} className="flex flex-wrap gap-1.5">
                {group.ops.map((op) => <StreamingFileOpBadge key={op.id} op={op} />)}
              </div>
        )}

        {state.text && <MarkdownContent content={state.text} />}

        <StreamingTodoList items={state.todos} />

        {!hasContent && (
          <div className="flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
            <span className="text-xs text-text-dim">Connecting to AI agent...</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Message content (persisted messages) ─────────────────────────────

function MessageContent({ message }: { message: AgentMessage }) {
  const rawParts = message.metadata?.parts
  const parts = Array.isArray(rawParts) ? rawParts : []

  if (parts.length > 0) {
    const groups: Array<
      | { kind: 'thinking'; content: string; idx: number }
      | { kind: 'file-group'; items: Array<{ part: MessagePart; idx: number }> }
      | { kind: 'todo'; items: TodoItem[]; idx: number }
    > = []

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (part.type === 'thinking') {
        groups.push({ kind: 'thinking', content: part.content, idx: i })
      } else if (part.type === 'file' || part.type === 'tool') {
        const last = groups[groups.length - 1]
        if (last && last.kind === 'file-group') {
          last.items.push({ part, idx: i })
        } else {
          groups.push({ kind: 'file-group', items: [{ part, idx: i }] })
        }
      } else if (part.type === 'todo-list') {
        groups.push({ kind: 'todo', items: part.items, idx: i })
      }
    }

    return (
      <div className="mt-0.5 space-y-2">
        {groups.map((group) => {
          if (group.kind === 'thinking') {
            return <ThinkingBadge key={`think-${group.idx}`} content={group.content} />
          }
          if (group.kind === 'file-group') {
            return (
              <div key={`fg-${group.items[0].idx}`} className="flex flex-wrap gap-1.5">
                {group.items.map(({ part, idx }) => {
                  if (part.type === 'file') return <FileOpBadge key={`file-${idx}`} part={part} />
                  if (part.type === 'tool') return <ToolBadge key={`tool-${idx}`} part={part} />
                  return null
                })}
              </div>
            )
          }
          return <TodoListBadge key={`todo-${group.idx}`} items={group.items} />
        })}

        {message.content && (
          message.role === 'agent'
            ? <MarkdownContent content={message.content} />
            : <p className="whitespace-pre-wrap text-sm text-text">{message.content}</p>
        )}
      </div>
    )
  }

  return (
    <div className="mt-0.5 space-y-2">
      {message.content && (
        message.role === 'agent'
          ? <MarkdownContent content={message.content} />
          : <p className="whitespace-pre-wrap text-sm text-text">{message.content}</p>
      )}
    </div>
  )
}

// ── Model selector ───────────────────────────────────────────────────

function ModelSelector({ selectedModel, onModelChange, disabled }: {
  selectedModel: string
  onModelChange: (modelId: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    if (open) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const current = AI_MODELS.find((m) => m.id === selectedModel) ?? AI_MODELS[0]

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        className={cn(
          'inline-flex items-center gap-1 rounded-md border border-border px-2 py-1.5 text-xs text-text-muted transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-50 disabled:pointer-events-none',
          open && 'bg-surface-hover text-text'
        )}
      >
        <Cpu className="h-3 w-3 shrink-0" />
        <span className="max-w-[7rem] truncate">{current.name}</span>
        <ChevronDown className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-1 w-64 rounded-lg border border-border bg-surface shadow-lg">
          <div className="p-1">
            {AI_MODELS.map((model) => (
              <button
                key={model.id}
                type="button"
                onClick={() => { onModelChange(model.id); setOpen(false) }}
                className={cn(
                  'flex w-full flex-col rounded-md px-3 py-2 text-left transition-colors hover:bg-surface-hover',
                  model.id === selectedModel && 'bg-primary/10'
                )}
              >
                <div className="flex items-center gap-2">
                  <span className={cn('text-xs font-medium', model.id === selectedModel ? 'text-primary' : 'text-text')}>
                    {model.name}
                  </span>
                  <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] text-text-dim">{model.provider}</span>
                </div>
                <p className="mt-0.5 text-[11px] text-text-dim">{model.description}</p>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Chat components ──────────────────────────────────────────────────

function ChatPanel({ projectId, onRefreshFiles }: { projectId: string; onRefreshFiles?: () => void }) {
  const { sessions, isLoading: sessionsLoading, createSession } = useAgentSessions(projectId)

  const initialSessionId = sessions.length > 0 ? sessions[0].id : null
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [pendingMessage, setPendingMessage] = useState<string | null>(null)
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL_ID)
  const resolvedSessionId = activeSessionId ?? initialSessionId

  const handleSessionCreated = useCallback((id: string, message: string) => {
    setActiveSessionId(id)
    setPendingMessage(message)
  }, [])

  if (sessionsLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-text-dim" />
      </div>
    )
  }

  if (!resolvedSessionId) {
    return <ChatEmptyState onSessionCreated={handleSessionCreated} createSession={createSession} selectedModel={selectedModel} onModelChange={setSelectedModel} />
  }

  return (
    <ChatSession
      projectId={projectId}
      sessionId={resolvedSessionId}
      pendingMessage={pendingMessage}
      onPendingMessageSent={() => setPendingMessage(null)}
      selectedModel={selectedModel}
      onModelChange={setSelectedModel}
      onRefreshFiles={onRefreshFiles}
    />
  )
}

function ChatEmptyState({ onSessionCreated, createSession, selectedModel, onModelChange }: {
  onSessionCreated: (id: string, message: string) => void
  createSession: () => Promise<{ id: string }>
  selectedModel: string
  onModelChange: (modelId: string) => void
}) {
  const [input, setInput] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  const handleSend = async () => {
    const trimmed = input.trim()
    if (!trimmed || isCreating) return
    setIsCreating(true)
    try {
      const session = await createSession()
      onSessionCreated(session.id, trimmed)
    } catch {
      setIsCreating(false)
    }
  }

  return (
    <>
      <div className="flex-1 overflow-y-auto p-4">
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <div className="mb-3 rounded-xl bg-primary/10 p-3">
            <MessageSquare className="h-6 w-6 text-primary" />
          </div>
          <p className="text-sm font-medium text-text">Start a conversation</p>
          <p className="mt-1 text-xs text-text-dim">
            Describe what you want to build and the AI agent will help you create it.
          </p>
        </div>
      </div>
      <div className="border-t border-border p-3">
        <div className="flex items-center gap-2">
          <ModelSelector selectedModel={selectedModel} onModelChange={onModelChange} disabled={isCreating} />
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
            placeholder="Describe your plugin idea..."
            disabled={isCreating}
            className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm text-text placeholder:text-text-dim focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isCreating}
            className="rounded-lg bg-primary p-2 text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-50"
          >
            {isCreating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </>
  )
}

function ChatSession({ projectId, sessionId, pendingMessage, onPendingMessageSent, selectedModel, onModelChange, onRefreshFiles }: {
  projectId: string
  sessionId: string
  pendingMessage?: string | null
  onPendingMessageSent?: () => void
  selectedModel: string
  onModelChange: (modelId: string) => void
  onRefreshFiles?: () => void
}) {
  const { session, messages, isLoading, sendMessage, isSending, sendError } = useAgentSession(projectId, sessionId)
  const streamActive = !!projectId && !!sessionId && (!session || session.status === 'idle' || session.status === 'running')
  const { streamingState, isConnected, resetStream } = useStreamingAgent(projectId, sessionId, streamActive)
  const [input, setInput] = useState('')
  const [awaitingStream, setAwaitingStream] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const pendingSentRef = useRef(false)
  const prevFileChangesRef = useRef(0)
  const prevCompletedOpsRef = useRef(0)

  useEffect(() => {
    if (pendingMessage && !pendingSentRef.current && isConnected) {
      pendingSentRef.current = true
      setAwaitingStream(true)
      resetStream()
      void sendMessage({ content: pendingMessage, model: selectedModel }).catch(() => setAwaitingStream(false))
      onPendingMessageSent?.()
    }
  }, [pendingMessage, isConnected, sendMessage, onPendingMessageSent, selectedModel, resetStream])

  // Fallback: send message even without SSE connection after timeout
  useEffect(() => {
    if (!pendingMessage || pendingSentRef.current) return
    const timer = setTimeout(() => {
      if (!pendingSentRef.current) {
        pendingSentRef.current = true
        setAwaitingStream(true)
        resetStream()
        void sendMessage({ content: pendingMessage, model: selectedModel }).catch(() => setAwaitingStream(false))
        onPendingMessageSent?.()
      }
    }, 5000)
    return () => clearTimeout(timer)
  }, [pendingMessage, sendMessage, onPendingMessageSent, selectedModel, resetStream])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingState.text.length, streamingState.thinkingBlocks.length, streamingState.fileOps.length, streamingState.todos.length])

  // Clear awaitingStream once real streaming content arrives
  useEffect(() => {
    if (awaitingStream && (streamingState.isStreaming || streamingState.text.length > 0 || streamingState.thinkingBlocks.length > 0)) {
      setAwaitingStream(false)
    }
  }, [awaitingStream, streamingState.isStreaming, streamingState.text.length, streamingState.thinkingBlocks.length])

  useEffect(() => {
    if (session && session.status !== 'running' && session.status !== 'idle') {
      resetStream()
      setAwaitingStream(false)
      prevFileChangesRef.current = 0
      prevCompletedOpsRef.current = 0
    }
  }, [session?.status, resetStream])

  useEffect(() => {
    if (streamingState.fileChanges.length > prevFileChangesRef.current) {
      prevFileChangesRef.current = streamingState.fileChanges.length
      onRefreshFiles?.()
    }
  }, [streamingState.fileChanges.length, onRefreshFiles])

  useEffect(() => {
    const completed = streamingState.fileOps.filter((op) => op.status === 'completed').length
    if (completed > prevCompletedOpsRef.current) {
      prevCompletedOpsRef.current = completed
      onRefreshFiles?.()
    }
  }, [streamingState.fileOps, onRefreshFiles])

  const handleSend = useCallback(async () => {
    const trimmed = input.trim()
    if (!trimmed || isSending) return
    setInput('')
    setAwaitingStream(true)
    resetStream()
    prevFileChangesRef.current = 0
    prevCompletedOpsRef.current = 0
    try {
      await sendMessage({ content: trimmed, model: selectedModel })
    } catch {
      setAwaitingStream(false)
    }
  }, [input, isSending, sendMessage, selectedModel])

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-text-dim" />
      </div>
    )
  }

  const showStreaming = awaitingStream || session?.status === 'running'

  const statusColor =
    session?.status === 'running' ? 'text-warning' :
    session?.status === 'completed' ? 'text-success' :
    session?.status === 'failed' ? 'text-destructive' :
    'text-text-dim'

  return (
    <>
      <div className="flex-1 overflow-y-auto p-4">
        {messages.length === 0 && !showStreaming ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="mb-3 rounded-xl bg-primary/10 p-3">
              <MessageSquare className="h-6 w-6 text-primary" />
            </div>
            <p className="text-sm font-medium text-text">Session started</p>
            <p className="mt-1 text-xs text-text-dim">Send a message to begin.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((msg) => (
              <div key={msg.id} className="flex gap-2.5">
                <div className={cn(
                  'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
                  msg.role === 'user' ? 'bg-primary/10' : 'bg-surface-hover'
                )}>
                  {msg.role === 'user'
                    ? <User className="h-3.5 w-3.5 text-primary" />
                    : <Bot className="h-3.5 w-3.5 text-text-muted" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-text-muted">
                    {msg.role === 'user' ? 'You' : msg.role === 'system' ? 'System' : 'AI Agent'}
                  </p>
                  <MessageContent message={msg} />
                </div>
              </div>
            ))}

            {showStreaming && (
              <StreamingMessage state={streamingState} />
            )}

            <div ref={messagesEndRef} />
          </div>
        )}
      </div>
      <div className="border-t border-border p-3">
        {sendError && (
          <div className="mb-2 flex items-center gap-1.5 text-xs text-destructive">
            <AlertCircle className="h-3 w-3" />
            <span>Failed to send message. Try again.</span>
          </div>
        )}
        {session && session.status !== 'idle' && session.status !== 'running' && (
          <div className="mb-2 flex items-center gap-1.5 text-xs">
            <AlertCircle className={cn('h-3 w-3', statusColor)} />
            <span className={statusColor}>Session {session.status}</span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <ModelSelector selectedModel={selectedModel} onModelChange={onModelChange} disabled={isSending || session?.status === 'running'} />
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
            placeholder="Describe your plugin idea..."
            disabled={isSending || session?.status === 'running'}
            className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm text-text placeholder:text-text-dim focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isSending || session?.status === 'running'}
            className="rounded-lg bg-primary p-2 text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-50"
          >
            {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </>
  )
}

// ── Workspace page ───────────────────────────────────────────────────

export default function WorkspacePage() {
  const { projectId } = useParams<{ projectId: string }>()
  const { project, isLoading } = useProject(projectId ?? '')
  const { files, isLoading: filesLoading, refetch: refetchFiles } = useProjectFiles(projectId ?? '')

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-text-muted">Loading workspace...</p>
        </div>
      </div>
    )
  }

  if (!project) {
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-background">
        <AlertCircle className="h-8 w-8 text-destructive" />
        <p className="mt-3 text-sm text-text-muted">Project not found</p>
        <Link to="/dashboard" className="mt-4 text-sm font-medium text-primary hover:text-primary-hover">
          Back to dashboard
        </Link>
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col bg-background">
      {/* Top bar */}
      <header className="flex h-12 items-center justify-between border-b border-border bg-surface px-4">
        <div className="flex items-center gap-3">
          <Link to="/dashboard" className="text-text-dim hover:text-text-muted">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <span className="text-sm font-medium text-text">{project.name}</span>
          <span className="rounded bg-accent px-2 py-0.5 text-xs text-text-dim">{project.software}</span>
          <span className="rounded bg-accent px-2 py-0.5 text-xs text-text-dim">{project.language}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="inline-flex items-center gap-1.5 rounded-md bg-success/10 px-3 py-1.5 text-xs font-medium text-success opacity-50"
            disabled
          >
            <Play className="h-3 w-3" />
            Compile
          </button>
          <button className="rounded-md border border-border p-1.5 text-text-dim hover:text-text-muted">
            <Settings className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* Main workspace */}
      <div className="flex flex-1 overflow-hidden">
        {/* File tree */}
        <aside className="w-56 shrink-0 overflow-y-auto border-r border-border bg-surface py-2">
          <div className="mb-2 flex items-center justify-between px-3">
            <p className="text-xs font-medium uppercase tracking-wider text-text-dim">Files</p>
            <button
              onClick={() => refetchFiles()}
              className="rounded p-0.5 text-text-dim hover:text-text-muted"
              title="Refresh files"
            >
              <RefreshCw className="h-3 w-3" />
            </button>
          </div>
          {filesLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-4 w-4 animate-spin text-text-dim" />
            </div>
          ) : files.length > 0 ? (
            <div>
              {files.map((entry) => (
                <FileTreeNode key={entry.path} entry={entry} />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
              <FolderOpen className="h-8 w-8 text-text-dim/50" />
              <p className="mt-3 text-xs text-text-dim">No files yet</p>
              <p className="mt-1 text-xs text-text-dim/70">
                Use the AI assistant to generate your plugin code
              </p>
            </div>
          )}
        </aside>

        {/* Editor area — empty state */}
        <main className="flex-1 overflow-hidden">
          <div className="flex h-full flex-col">
            <div className="flex h-9 items-center border-b border-border bg-surface px-4">
              <div className="flex items-center gap-2 text-xs text-text-dim">
                <File className="h-3 w-3" />
                No file selected
              </div>
            </div>
            <div className="flex flex-1 flex-col items-center justify-center text-center">
              <div className="rounded-2xl bg-primary/5 p-4">
                <File className="h-8 w-8 text-primary/40" />
              </div>
              <p className="mt-4 text-sm font-medium text-text-muted">No files to display</p>
              <p className="mt-1 max-w-xs text-xs text-text-dim">
                Start a conversation with the AI assistant to generate plugin code for your project.
              </p>
            </div>
          </div>
        </main>

        {/* Chat panel */}
        <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-surface">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <MessageSquare className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium text-text">AI Assistant</span>
          </div>
          <ChatPanel projectId={project.id} onRefreshFiles={refetchFiles} />
        </aside>
      </div>
    </div>
  )
}
