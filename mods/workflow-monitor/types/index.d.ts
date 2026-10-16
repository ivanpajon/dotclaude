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
  /** The phase its workflow script ran it in, as its meta says; absent until read, or with none named. */
  phase?: string
  label: string
  type: string
  /** The model it shows: one set from the pane while one is, else its own (see present). */
  model: string
  /** The effort it shows, the same way. */
  effort?: string
  /** The model its own requests name, before any setting from the pane. */
  baseModel: string
  /** The effort its own requests name (none for a model without effort), before any setting from the pane. */
  baseEffort?: string
  /** True while a model set from the pane (on it or its card) is what it shows: for a finished agent, at its end (drawn grey all the same). */
  isModelOverridden: boolean
  /** True while an effort set from the pane is what it shows, the same way. */
  isEffortOverridden: boolean
  /** What its latest request was sent with, as its row showed it then: what it shows once it ends. */
  sent?: { model: string; effort?: string; isModelOverridden: boolean; isEffortOverridden: boolean }
  status: AgentStatus
  startedAt: number
  endedAt?: number
  steps: number
  usage: AgentUsage
  /** When its counter froze (paused or stopped from the pane); absent while it counts. */
  pausedSince?: number
  /** Time spent paused and since resumed, left out of its elapsed time. */
  pausedTotal?: number
  /** The attempt this one retries: Claude Code started that agent again, under this id, after it stalled. */
  retryOf?: string
  /** The attempt that retried this one. */
  retriedBy?: string
  /** When its last model request ended: the latest progress the monitor counted. */
  activeAt?: number
  /** How long it had gone without progress when it ended aborted and not stopped from the monitor. */
  quietMs?: number
}

/** How a workflow run ended, as its task notification said: its script finished, threw, or was stopped. */
export type RunOutcome = 'completed' | 'failed' | 'killed'

/** What the Workflow tool call's script said about itself (`export const meta`). */
export type WorkflowMeta = {
  name: string
  description?: string
  phases: string[]
}

/** One line of an agent's live activity: its transcript, when its own can't be read. */
export type LogEntry = {
  kind: 'text' | 'thinking' | 'tool' | 'note'
  text: string
  /** A tool call's name; its arguments summary is `text`. */
  tool?: string
  /** Its place in the agent's whole stream, from 0: kept as the oldest entries fall off the log. */
  at?: number
}

/** What the person asked of a running agent from the pane. */
export type Control = 'pause' | 'stop'

/** One Button or Select a pane draws; a press or pick runs it by `key` (and the picked `value`). */
export type ControlItem =
  | { kind: 'button'; key: string; label: string; plain?: boolean; prefix?: string; bold?: boolean; dim?: boolean }
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

/** A model and effort picked in a settings panel and not yet set: Done sets them. */
export type Draft = {
  /** The panel they were picked in, as `editing` names it. */
  editor: string
  picks: Override
}

declare module 'claude-code' {
  interface PluginState {
    'workflow-monitor': {
      agents: AgentRow[]
      /** Keyed by workflow run id, from the Workflow call's launch result; else by the call's tool_use_id. */
      workflows: Record<string, WorkflowMeta>
      /** The run each Workflow call launched or resumed, by the call's tool_use_id. */
      calls: Record<string, string>
      /** How each workflow run ended, by run id; absent while it goes on, and cleared when it starts again. */
      outcomes: Record<string, RunOutcome>
      /**
       * Workflow runs that went quiet with no word of their end, by run id: the last agent start or
       * end it was judged from. A run is shown as likely over only while that is still its last.
       */
      quiet: Record<string, number>
      /** Keyed by agent id. */
      agentOverrides: Record<string, Override>
      /** Keyed by group key (workflow run id, or `subagents`). */
      groupOverrides: Record<string, Override>
      /** Which editor is open: `agent:<id>`, `group:<key>`, or none. */
      editing: string | null
      /** Picks in the open editor that Done has not set yet; closing it any other way drops them. */
      draft: Draft | null
      /** Time each group (by group key) spent with no agent working, left out of its counter. */
      idle: Record<string, Idle>
      /** Agents archived from the pane (closed cards), by agent id: when. Kept, and listed under Archived. */
      archived: Record<string, number>
      /** Whether the Archived section is unfolded. */
      archiveOpen: boolean
      /** Whether the Finished section is unfolded (it is, until folded). */
      finishedOpen: boolean
      /** Cards the person folded or unfolded, by group key, and phases on them by `<group>::<phase>`. */
      collapsed: Record<string, boolean>
      /** Pause or stop asked of a running agent, by agent id. */
      controls: Record<string, Control>
      /** Agents a pause is holding right now, before a tool call of theirs runs. */
      held: Record<string, boolean>
      /** The latest activity of each agent, by agent id, capped. */
      logs: Record<string, LogEntry[]>
      /** The transcript panes open, one per agent: the agent each shows, by pane id. */
      inspected: Record<string, string>
      /**
       * Parts of a transcript the person unfolded: `<agent id>:prompt`, its prompt shown whole, and
       * `<agent id>:<call id>`, the run of tool calls that call opens listed.
       */
      unfolded: Record<string, boolean>
      /**
       * The folder Claude Code keeps this session's transcript and subagent files in, once a hook
       * named it: where an agent the monitor didn't see start is looked up.
       */
      sessionDir: string | null
    }
  }
}
