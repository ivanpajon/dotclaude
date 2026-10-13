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
  /** When its counter froze (paused or stopped from the pane); absent while it counts. */
  pausedSince?: number
  /** Time spent paused and since resumed, left out of its elapsed time. */
  pausedTotal?: number
}

/** What the Workflow tool call's script said about itself (`export const meta`). */
export type WorkflowMeta = {
  name: string
  description?: string
  phases: string[]
}

/** One line of an agent's live activity, as the Inspect pane shows it. */
export type LogEntry = {
  kind: 'text' | 'thinking' | 'tool' | 'note'
  text: string
  /** A tool call's name; its arguments summary is `text`. */
  tool?: string
}

/** What the person asked of a running agent from the pane. */
export type Control = 'pause' | 'stop'

/** One Button or Select a pane draws; a press or pick runs it by `key` (and the picked `value`). */
export type ControlItem =
  | { kind: 'button'; key: string; label: string; plain?: boolean; prefix?: string; bold?: boolean }
  | { kind: 'select'; key: string; label: string; value: string; options: { value: string; label: string }[] }

/** A group's time with none of its agents working: since when (while it lasts) and in total before that. */
export type Idle = {
  since?: number
  total: number
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
      /** Keyed by the Workflow tool call's tool_use_id. */
      workflows: Record<string, WorkflowMeta>
      /** Keyed by agent id. */
      agentOverrides: Record<string, Override>
      /** Keyed by group key (workflow run id, or `subagents`). */
      groupOverrides: Record<string, Override>
      /** Which editor is open: `agent:<id>`, `group:<key>`, or none. */
      editing: string | null
      /** Time each group (by group key) spent with no agent working, left out of its counter. */
      idle: Record<string, Idle>
      /** Groups the person folded or unfolded, by group key. */
      collapsed: Record<string, boolean>
      /** Pause or stop asked of a running agent, by agent id. */
      controls: Record<string, Control>
      /** Agents a pause is holding right now, before their next model request. */
      held: Record<string, boolean>
      /** The latest activity of each agent, by agent id, capped. */
      logs: Record<string, LogEntry[]>
      /** The agent the Inspect pane shows. */
      inspecting: string | null
    }
  }
}
