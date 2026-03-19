import { useState, useEffect, useRef, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type {
  AgentSession,
  AgentSessionWithMessages,
  AgentMessage,
  AgentLog,
  StreamEvent,
  StreamingState,
  StreamingItem,
  FileTreeEntry,
  StreamTodoItem,
} from '@/types'

export function useAgentSessions(projectId: string) {
  const queryClient = useQueryClient()

  const { data: sessions, isLoading } = useQuery({
    queryKey: ['projects', projectId, 'agent', 'sessions'],
    queryFn: () => api.get<AgentSession[]>(`/projects/${projectId}/agent/sessions`),
    enabled: !!projectId,
  })

  const createSessionMutation = useMutation({
    mutationFn: () =>
      api.post<AgentSession>(`/projects/${projectId}/agent/sessions`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'agent', 'sessions'] })
    },
  })

  const cancelSessionMutation = useMutation({
    mutationFn: (sessionId: string) =>
      api.post<AgentSession>(`/projects/${projectId}/agent/sessions/${sessionId}/cancel`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'agent', 'sessions'] })
    },
  })

  return {
    sessions: sessions ?? [],
    isLoading,
    createSession: createSessionMutation.mutateAsync,
    isCreatingSession: createSessionMutation.isPending,
    cancelSession: cancelSessionMutation.mutateAsync,
    isCancellingSession: cancelSessionMutation.isPending,
  }
}

export function useAgentSession(projectId: string, sessionId: string) {
  const queryClient = useQueryClient()

  const { data: session, isLoading, refetch } = useQuery({
    queryKey: ['projects', projectId, 'agent', 'sessions', sessionId],
    queryFn: () => api.get<AgentSessionWithMessages>(`/projects/${projectId}/agent/sessions/${sessionId}`),
    enabled: !!projectId && !!sessionId,
    refetchInterval: (query) => {
      const data = query.state.data
      if (data && (data.status === 'running' || data.status === 'idle')) {
        return 2000
      }
      return false
    },
  })

  const invalidateAndRefetch = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'agent', 'sessions', sessionId] })
    void refetch()
  }, [queryClient, projectId, sessionId, refetch])

  const sendMessageMutation = useMutation({
    mutationFn: ({ content, model }: { content: string; model?: string }) =>
      api.post<AgentMessage>(`/projects/${projectId}/agent/sessions/${sessionId}/messages`, { content, model }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'agent', 'sessions', sessionId] })
    },
  })

  const cancelSessionMutation = useMutation({
    mutationFn: () =>
      api.post<AgentSession>(`/projects/${projectId}/agent/sessions/${sessionId}/cancel`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'agent', 'sessions', sessionId] })
    },
  })

  return {
    session: session ?? null,
    messages: session?.messages ?? [],
    isLoading,
    sendMessage: sendMessageMutation.mutateAsync,
    isSending: sendMessageMutation.isPending,
    sendError: sendMessageMutation.error,
    invalidateAndRefetch,
    cancelSession: cancelSessionMutation.mutateAsync,
    isCancelling: cancelSessionMutation.isPending,
  }
}

export function useAgentLogs(projectId: string, sessionId: string) {
  const { data: logs, isLoading } = useQuery({
    queryKey: ['projects', projectId, 'agent', 'sessions', sessionId, 'logs'],
    queryFn: () => api.get<AgentLog[]>(`/projects/${projectId}/agent/sessions/${sessionId}/logs`),
    enabled: !!projectId && !!sessionId,
    refetchInterval: 3000,
  })

  return {
    logs: logs ?? [],
    isLoading,
  }
}

// ── Mutable accumulator for streaming events (not React state) ───────

interface PendingTransition {
  id: string
  status: 'completed' | 'error'
  at: number
}

interface StreamAccumulator {
  items: StreamingItem[]
  itemById: Map<string, StreamingItem>
  todos: StreamTodoItem[]
  isStreaming: boolean
  completed: boolean
  fileChanges: string[]
  nextOrder: number
  pendingTransitions: PendingTransition[]
  activeStream: boolean
}

function createEmptyAccumulator(): StreamAccumulator {
  return {
    items: [],
    itemById: new Map(),
    todos: [],
    isStreaming: false,
    completed: false,
    fileChanges: [],
    nextOrder: 0,
    pendingTransitions: [],
    activeStream: false,
  }
}

function snapshotAccumulator(acc: StreamAccumulator): StreamingState {
  const now = Date.now()
  for (let i = acc.pendingTransitions.length - 1; i >= 0; i--) {
    const t = acc.pendingTransitions[i]
    if (now >= t.at) {
      const item = acc.itemById.get(t.id)
      if (item && item.kind === 'file-op') item.fileStatus = t.status
      acc.pendingTransitions.splice(i, 1)
    }
  }
  return {
    items: acc.items.filter(item => item.kind !== 'text' || item.textContent),
    todos: acc.todos,
    isStreaming: acc.isStreaming,
    fileChanges: [...acc.fileChanges],
  }
}

const EMPTY_STREAMING_STATE: StreamingState = {
  items: [],
  todos: [],
  isStreaming: false,
  fileChanges: [],
}

function processStreamEvent(acc: StreamAccumulator, event: StreamEvent): void {
  switch (event.type) {
    case 'text-delta': {
      // Find or create a text item for current position
      const lastItem = acc.items[acc.items.length - 1]
      if (lastItem && lastItem.kind === 'text') {
        lastItem.textContent = (lastItem.textContent || '') + event.content
      } else {
        // Create new text item at current position
        const textItem: StreamingItem = {
          id: `text-${acc.nextOrder++}`,
          kind: 'text',
          order: acc.nextOrder,
          textContent: event.content,
        }
        acc.items.push(textItem)
        acc.itemById.set(textItem.id, textItem)
      }
      break
    }

    case 'thinking': {
      const existing = acc.itemById.get(event.id)
      if (existing && existing.kind === 'thinking') {
        existing.thinkingContent = (existing.thinkingContent || '') + event.content
        existing.thinkingDone = event.done
      } else {
        const item: StreamingItem = {
          id: event.id,
          kind: 'thinking',
          order: acc.nextOrder++,
          thinkingContent: event.content,
          thinkingDone: event.done,
        }
        acc.items.push(item)
        acc.itemById.set(item.id, item)
      }
      break
    }

    case 'file-op': {
      if (!acc.activeStream) break
      const existing = acc.itemById.get(event.id)
      if (existing && existing.kind === 'file-op') {
        existing.fileAction = event.action
        existing.filePath = event.path
        existing.fileNewPath = event.newPath
        existing.fileStatus = event.status
        existing.fileTool = event.tool
      } else {
        const showRunning = event.status === 'completed' || event.status === 'error'
        const item: StreamingItem = {
          id: event.id,
          kind: 'file-op',
          order: acc.nextOrder++,
          fileAction: event.action,
          filePath: event.path,
          fileNewPath: event.newPath,
          fileStatus: showRunning ? 'running' : event.status,
          fileTool: event.tool,
        }
        acc.items.push(item)
        acc.itemById.set(item.id, item)
        if (showRunning) {
          acc.pendingTransitions.push({ id: event.id, status: event.status as 'completed' | 'error', at: Date.now() + 600 })
        }
      }
      break
    }

    case 'todo':
      acc.todos = event.items
      break

    case 'status':
      if (event.status === 'running' && !acc.completed) {
        acc.isStreaming = true
        acc.activeStream = true
      }
      break

    case 'file-change':
      if (!acc.fileChanges.includes(event.file)) {
        acc.fileChanges.push(event.file)
      }
      break

    case 'complete':
      acc.isStreaming = false
      acc.completed = true
      acc.activeStream = false
      break

    case 'error':
      break
  }
}

export function useStreamingAgent(projectId: string, sessionId: string, isActive: boolean) {
  const accRef = useRef<StreamAccumulator>(createEmptyAccumulator())
  const dirtyRef = useRef(false)
  const eventSourceRef = useRef<EventSource | null>(null)
  const [snapshot, setSnapshot] = useState<StreamingState>(EMPTY_STREAMING_STATE)
  const [isConnected, setIsConnected] = useState(false)

  // Periodic state sync (batches rapid events into ~10fps renders)
  useEffect(() => {
    if (!isActive) return

    const interval = setInterval(() => {
      const hasDueTransitions = accRef.current.pendingTransitions.some(t => Date.now() >= t.at)
      if (dirtyRef.current || hasDueTransitions) {
        dirtyRef.current = false
        setSnapshot(snapshotAccumulator(accRef.current))
      }
    }, 100)

    return () => clearInterval(interval)
  }, [isActive])

  // EventSource connection
  useEffect(() => {
    if (!isActive || !projectId || !sessionId) {
      return
    }

    const url = `/api/projects/${projectId}/agent/sessions/${sessionId}/stream`
    const es = new EventSource(url, { withCredentials: true })
    eventSourceRef.current = es

    es.onopen = () => {
      setIsConnected(true)
    }

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as StreamEvent
        processStreamEvent(accRef.current, event)
        dirtyRef.current = true
      } catch {
        // ignore malformed events
      }
    }

    es.onerror = () => {
      // EventSource auto-reconnects; we track connection state
      setIsConnected(false)
    }

    return () => {
      es.close()
      eventSourceRef.current = null
      setIsConnected(false)
    }
  }, [projectId, sessionId, isActive])

  const resetStream = useCallback(() => {
    accRef.current = createEmptyAccumulator()
    dirtyRef.current = false
    setSnapshot(EMPTY_STREAMING_STATE)
  }, [])

  return {
    streamingState: snapshot,
    isConnected,
    resetStream,
  }
}

export function useProjectFiles(projectId: string) {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['projects', projectId, 'files'],
    queryFn: () => api.get<{ files: FileTreeEntry[] }>(`/projects/${projectId}/files`),
    enabled: !!projectId,
  })

  return {
    files: data?.files ?? [],
    isLoading,
    refetch,
  }
}
