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
  FileTreeEntry,
  ThinkingBlock,
  FileOpBlock,
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

  const { data: session, isLoading } = useQuery({
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

  const sendMessageMutation = useMutation({
    mutationFn: ({ content, model }: { content: string; model?: string }) =>
      api.post<AgentMessage>(`/projects/${projectId}/agent/sessions/${sessionId}/messages`, { content, model }),
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

interface StreamAccumulator {
  text: string
  thinkingBlocks: Map<string, ThinkingBlock>
  fileOps: Map<string, FileOpBlock>
  todos: StreamTodoItem[]
  isStreaming: boolean
  completed: boolean
  fileChanges: string[]
  nextOrder: number
}

function createEmptyAccumulator(): StreamAccumulator {
  return {
    text: '',
    thinkingBlocks: new Map(),
    fileOps: new Map(),
    todos: [],
    isStreaming: false,
    completed: false,
    fileChanges: [],
    nextOrder: 0,
  }
}

function snapshotAccumulator(acc: StreamAccumulator): StreamingState {
  return {
    text: acc.text,
    thinkingBlocks: Array.from(acc.thinkingBlocks.values()),
    fileOps: Array.from(acc.fileOps.values()),
    todos: acc.todos,
    isStreaming: acc.isStreaming,
    fileChanges: [...acc.fileChanges],
  }
}

const EMPTY_STREAMING_STATE: StreamingState = {
  text: '',
  thinkingBlocks: [],
  fileOps: [],
  todos: [],
  isStreaming: false,
  fileChanges: [],
}

function processStreamEvent(acc: StreamAccumulator, event: StreamEvent): void {
  switch (event.type) {
    case 'text-delta':
      acc.text += event.content
      break

    case 'thinking': {
      const existing = acc.thinkingBlocks.get(event.id)
      if (existing) {
        existing.content += event.content
        existing.done = event.done
      } else {
        acc.thinkingBlocks.set(event.id, {
          id: event.id,
          content: event.content,
          done: event.done,
          order: acc.nextOrder++,
        })
      }
      break
    }

    case 'file-op': {
      const existingOp = acc.fileOps.get(event.id)
      acc.fileOps.set(event.id, {
        id: event.id,
        action: event.action,
        path: event.path,
        newPath: event.newPath,
        status: event.status,
        tool: event.tool,
        order: existingOp?.order ?? acc.nextOrder++,
      })
      break
    }

    case 'todo':
      acc.todos = event.items
      break

    case 'status':
      if (event.status === 'running' && !acc.completed) {
        acc.isStreaming = true
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
      if (dirtyRef.current) {
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
