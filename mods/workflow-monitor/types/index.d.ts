export type AgentStatus = 'running' | 'done' | 'failed' | 'stopped'

export type AgentUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type AgentRow = {
  id: string
  /** Workflow run id (`wf_...`); absent for a plain Agent-tool subagent. */
  runId?: string
  /** The Agent or Workflow tool call that started it; a workflow's agents share one. */
  toolUseId: string
  /** Position among the run's agent() calls, from 1. */
  index?: number
  label: string
  type: string
  model: string
  effort?: string
  /** True once a model or effort override from the pane applied to a request. */
  isOverridden: boolean
  status: AgentStatus
  startedAt: number
  endedAt?: number
  steps: number
  usage: AgentUsage
}

/** What the Workflow tool call's script said about itself (`export const meta`). */
export type WorkflowMeta = {
  name: string
  description?: string
  phases: string[]
}

/** A model or effort the pane forces on a subagent's next requests. */
export type Override = {
  model?: string
  effort?: string
}

declare module 'claude-code' {
  interface PluginState {
    'workflow-monitor': {
      agents: AgentRow[]
      now: number
      /** Keyed by the Workflow tool call's tool_use_id. */
      workflows: Record<string, WorkflowMeta>
      /** Keyed by agent id. */
      agentOverrides: Record<string, Override>
      /** Keyed by group key (workflow run id, or `subagents`). */
      groupOverrides: Record<string, Override>
      /** Which editor is open: `agent:<id>`, `group:<key>`, or none. */
      editing: string | null
      /** Groups the person folded or unfolded, by group key. */
      collapsed: Record<string, boolean>
    }
  }
}
