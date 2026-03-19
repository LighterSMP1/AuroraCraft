import { Cpu, Zap, Clock, CheckCircle2, Globe } from 'lucide-react'
import { AI_MODELS } from '@/types'

const bridges = [
  { name: 'OpenCode', status: 'active' as const, description: 'Open-source AI coding agent with multi-model support' },
  { name: 'Codex', status: 'coming_soon' as const, description: "OpenAI's code generation platform" },
]

export default function AdminAIRuntimePage() {
  const freeModels = AI_MODELS

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight text-text">AI Runtime</h1>
      <p className="mt-1 text-sm text-text-muted">Configure AI bridges and available models</p>

      {/* Bridges */}
      <h2 className="mt-8 text-lg font-semibold text-text">AI Bridges</h2>
      <p className="mt-1 text-sm text-text-muted">External AI coding agents connected to AuroraCraft</p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {bridges.map((bridge) => (
          <div key={bridge.name} className="rounded-xl border border-border bg-surface p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {bridge.status === 'active' ? (
                  <Cpu className="h-4 w-4 text-primary" />
                ) : (
                  <Globe className="h-4 w-4 text-text-dim" />
                )}
                <span className="font-medium text-text">{bridge.name}</span>
              </div>
              {bridge.status === 'active' ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2 py-0.5 text-xs text-success">
                  <span className="h-1.5 w-1.5 rounded-full bg-success" />
                  Active
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-hover px-2 py-0.5 text-xs text-text-dim">
                  <Clock className="h-3 w-3" />
                  Coming Soon
                </span>
              )}
            </div>
            <p className="mt-2 text-xs text-text-muted">{bridge.description}</p>
          </div>
        ))}
      </div>

      {/* Available Models */}
      <h2 className="mt-8 text-lg font-semibold text-text">Available Models</h2>
      <p className="mt-1 text-sm text-text-muted">AI models available for Minecraft plugin generation</p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {freeModels.map((model) => (
          <div key={model.id} className="rounded-xl border border-success/20 bg-surface p-5">
            <div className="flex items-center justify-between">
              <span className="font-medium text-text">{model.name}</span>
              <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-xs text-success">
                <Zap className="h-3 w-3" />
                Free
              </span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] text-text-dim">{model.provider}</span>
              <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] text-text-dim">via OpenCode</span>
            </div>
            <p className="mt-2 text-xs text-text-muted">{model.description}</p>
            <div className="mt-3 flex items-center gap-1.5 text-xs text-success">
              <CheckCircle2 className="h-3 w-3" />
              <span>Active</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
