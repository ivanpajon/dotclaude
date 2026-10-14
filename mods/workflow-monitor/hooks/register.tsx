import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, AgentStatus, AgentUsage, Control, ControlItem, Idle, LogEntry, Override, RunOutcome, WorkflowMeta } from '../types'

const PANE = 'workflow-monitor'
const INSPECT = 'workflow-monitor-agent'
const TITLE = 'Workflows'
// What /workflows help prints after an opening line: markdown, as a command's output row draws it
// on every surface (spaces don't line up columns there, a table does).
const USAGE = [
  '| Command | What it does |',
  '|---|---|',
  '| `/workflows` | Open the pane. It also opens by itself when a subagent starts. |',
  '| `/workflows demo` | Load a sample workflow to try the pane out. |',
  '| `/workflows clear` | Remove finished, archived and demo agents. Running ones stay. |',
  '| `/workflows help` | Show this help. |',
  '',
  '**In the pane**',
  '- **⚙** opens the settings panel. On a running agent: pause it (at its next tool call) or resume it, stop it,'
    + ' and pick the model and effort of its next requests. On a card\'s header: the same for every agent in the workflow, the ones it starts later'
    + ' too (an agent\'s own setting wins); once the workflow is over, Archive or Remove it. It shows **◆** while a'
    + ' model or effort is set.',
  '- **↗** opens the Inspect view in another tab: a finished agent\'s latest activity, its thinking, text and tool'
    + ' calls. For a running agent, Inspect is in its settings panel and follows along live.',
  '- **✕** removes a finished workflow from the board. It isn\'t deleted: it moves under **Archived** at the bottom,'
    + ' where Restore brings it back and Remove deletes it from the monitor for good. If the run starts again, it'
    + ' comes back by itself.',
  '',
  '**Status**: ● working · ⏸ paused · ⏹ stopped · ✓ done · ✗ failed · ○ between phases · ⚠ script failed',
].join('\n')
const MAX_ROWS = 500
const SUBAGENTS = 'subagents'
const MAX_LOG = 200
const MAX_ENTRY = 4000
// The final answer a stopped agent gives in place of its next model request.
const STOP_TEXT = '(Stopped from the workflow monitor before it finished.)'

const agents = atom({ plugin: 'workflow-monitor', key: 'agents' } as const, [] as AgentRow[])
const workflows = atom({ plugin: 'workflow-monitor', key: 'workflows' } as const, {} as Record<string, WorkflowMeta>)
const calls = atom({ plugin: 'workflow-monitor', key: 'calls' } as const, {} as Record<string, string>)
const outcomes = atom({ plugin: 'workflow-monitor', key: 'outcomes' } as const, {} as Record<string, RunOutcome>)
const quiet = atom({ plugin: 'workflow-monitor', key: 'quiet' } as const, {} as Record<string, number>)
const agentOverrides = atom({ plugin: 'workflow-monitor', key: 'agentOverrides' } as const, {} as Record<string, Override>)
const groupOverrides = atom({ plugin: 'workflow-monitor', key: 'groupOverrides' } as const, {} as Record<string, Override>)
const editing = atom({ plugin: 'workflow-monitor', key: 'editing' } as const, null as string | null)
const collapsed = atom({ plugin: 'workflow-monitor', key: 'collapsed' } as const, {} as Record<string, boolean>)
const controls = atom({ plugin: 'workflow-monitor', key: 'controls' } as const, {} as Record<string, Control>)
const held = atom({ plugin: 'workflow-monitor', key: 'held' } as const, {} as Record<string, boolean>)
const logs = atom({ plugin: 'workflow-monitor', key: 'logs' } as const, {} as Record<string, LogEntry[]>)
const inspecting = atom({ plugin: 'workflow-monitor', key: 'inspecting' } as const, null as string | null)
const idle = atom({ plugin: 'workflow-monitor', key: 'idle' } as const, {} as Record<string, Idle>)
const archived = atom({ plugin: 'workflow-monitor', key: 'archived' } as const, {} as Record<string, number>)
const archiveOpen = atom({ plugin: 'workflow-monitor', key: 'archiveOpen' } as const, false)
const sessionDir = atom({ plugin: 'workflow-monitor', key: 'sessionDir' } as const, null as string | null)

// USD per million tokens: [input, output, cache write (5 min), cache read].
// Anthropic first-party list prices, 2026-10. Longer keys first: matched by substring.
const PRICES: [string, [number, number, number, number]][] = [
  ['fable-5-1', [10, 50, 12.5, 0.25]],
  ['mythos-5-1', [10, 50, 12.5, 0.25]],
  ['fable-5', [10, 50, 12.5, 1]],
  ['opus-5-5', [4, 20, 5, 0.2]],
  ['opus-5', [5, 25, 6.25, 0.5]],
  ['opus-4', [5, 25, 6.25, 0.5]],
  ['sonnet-5', [2, 10, 2.5, 0.2]],
  ['sonnet-4', [3, 15, 3.75, 0.3]],
  ['haiku-5', [0.1, 0.5, 0.125, 0.01]],
  ['haiku-4', [1, 5, 1.25, 0.1]],
]

// What the editors offer. `inherit` keeps whatever the agent would have used.
const MODEL_OPTIONS = [
  { value: 'inherit', label: 'Inherit' },
  { value: 'claude-fable-5-1', label: 'Fable 5.1' },
  { value: 'claude-opus-5-5', label: 'Opus 5.5' },
  { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { value: 'claude-haiku-5-5', label: 'Haiku 5.5' },
]
const EFFORT_OPTIONS = [
  { value: 'inherit', label: 'Inherit' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
]

const ZERO: AgentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

// Running is blue, as in Claude Code's own workflow view. Paused is amber; stopped is a neutral
// grey, apart from both paused and failed: ended on purpose, not gone wrong.
const RUNNING = '#4D9DF0'
const STOPPED = '#8C929C'
const PAUSED = '#E5A50A'

// Done is a quiet grey check, as Claude Code's own panel draws a finished agent: color is for
// what still goes on, or went wrong. The stopped grey, a fixed one: the desktop draws the
// 'inactive' theme key almost as plain text.
const GLYPH: Record<AgentStatus, [string, string]> = {
  running: ['●', RUNNING],
  done: ['✓', STOPPED],
  failed: ['✗', 'error'],
  stopped: ['⏹', STOPPED],
}

// The same status colors as raw hex, for SVG (theme keys don't reach inside it). A done square is
// this grey half-faded; a stopped one its outline (see progress).
const HEX: Record<AgentStatus, string> = {
  running: RUNNING,
  done: STOPPED,
  failed: '#E5484D',
  stopped: STOPPED,
}

// Fills, where the surface paints them (the terminal keeps its borders instead): a card, and on
// it a phase's header or a settings panel, a step darker. Grey at a low alpha reads on light and
// dark themes alike.
const CARD_FILL = '#80808014'
const BLOCK_FILL = '#8080801f'
// No color at all: a border drawn in it rounds a box's corners and shows nothing else.
const CLEAR = '#00000000'
// Faint text on those surfaces (column headings, section headings, phases not started yet): a
// mid grey, fainter than the values on either theme. The desktop draws `dimColor` too close to
// plain text to tell them apart.
const HEADING = '#8C929C'

// An agent's icon and colour. One asked to pause or stop shows it while it still runs.
function look(r: AgentRow, c: Control | undefined): [string, string] {
  if (r.status === 'running' && c === 'pause') return ['⏸', 'warning']
  if (r.status === 'running' && c === 'stop') return ['⏹', STOPPED]
  return GLYPH[r.status]
}

// Column widths, shared by the header row and every agent row so they line up, each the widest its
// values run to: "Sonnet 5.5", "Extra high", "999.9k", "59m 59s", "$12.34". The row button's label
// is three cells; a surface that draws native buttons adds its own chrome round it, which a
// three-cell column cuts down to "…", so it gets `nativeGear`.
const W = { glyph: 2, model: 10, effort: 10, tokens: 7, time: 7, cost: 7, gear: 3, nativeGear: 6 }
// What a card takes from each agent row's width, both sides together: its border and padding on
// the terminal; filled, its padding and that of the phase's table, which lines up with the
// phase's header.
const CARD_X = 4
// The fewest columns an agent's name gets in a row of columns ("investigate…"); less, and each
// agent goes on two lines instead.
const LABEL_MIN = 12

function costOf(model: string, u: AgentUsage): number | undefined {
  const hit = PRICES.find(([key]) => model.includes(key))
  if (!hit) return undefined
  const [i, o, w, r] = hit[1]
  return (u.input * i + u.output * o + u.cacheWrite * w + u.cacheRead * r) / 1e6
}

function shortModel(model: string): string {
  const m = model.match(/(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?!\d)/)
  if (!m) return model
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}`
}

function tokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1e6) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1e6).toFixed(2)}M`
}

function money(n: number | undefined): string {
  if (n === undefined) return '—'
  return n < 0.1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

const effortLabel = (e?: string) => EFFORT_OPTIONS.find(o => o.value === e)?.label ?? e ?? '—'
// The costliest efforts stand out in red.
const effortColor =(e?: string) => (e === 'xhigh' || e === 'max' ? 'error' : undefined)

type ApiUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

const addUsage = (a: AgentUsage, u: ApiUsage): AgentUsage => ({
  input: a.input + u.input_tokens,
  output: a.output + u.output_tokens,
  cacheRead: a.cacheRead + u.cache_read_input_tokens,
  cacheWrite: a.cacheWrite + u.cache_creation_input_tokens,
})

const totalTokens = (u: AgentUsage) => u.input + u.output + u.cacheRead + u.cacheWrite

const sumTokens = (rows: AgentRow[]) => rows.reduce((t, r) => t + totalTokens(r.usage), 0)

const sumCost = (rows: AgentRow[]): number | undefined => {
  let total = 0
  for (const r of rows) {
    const c = costOf(r.model, r.usage)
    if (c === undefined && r.usage.output > 0) return undefined
    total += c ?? 0
  }
  return total
}

const groupKey = (a: AgentRow) => a.runId ?? SUBAGENTS

// Reads `name`, `description` and phase titles out of a script's `export const meta = {...}`.
function parseMeta(script: string): WorkflowMeta | undefined {
  const start = script.indexOf('export const meta')
  if (start < 0) return undefined
  const end = script.indexOf('\n}', start)
  const block = script.slice(start, end < 0 ? undefined : end)
  const str = (field: string) => block.match(new RegExp(`\\b${field}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`))?.[2]
  const name = str('name')
  if (!name) return undefined
  const phases = [...block.matchAll(/\btitle\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/g)].map(m => m[2])
  return { name, description: str('description'), phases }
}

// The background tasks a task notification reports as ended: the call that started each, and how
// it ended. Each `<task-notification>` block names its call and status before its result text.
function endedTasks(text: string): { toolUseId: string; status: string }[] {
  return text.split('<task-notification>').slice(1).flatMap(block => {
    const toolUseId = /<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/.exec(block)?.[1]
    const status = /<status>\s*([^<\s]+)\s*<\/status>/.exec(block)?.[1]
    return toolUseId && status ? [{ toolUseId, status }] : []
  })
}
const OUTCOMES: readonly RunOutcome[] = ['completed', 'failed', 'killed']

// Records how the listed workflow runs a task notification reports on ended, by run: the Workflow
// call it names launched or resumed the run (its launch result says, or its agents carry the call).
// A plain subagent's own notification is left out.
async function noteRunEnds($: EngineInterface, text: string) {
  const list = (await read($, agents)).filter(a => a.runId)
  const runOf: Record<string, string> = { ...Object.fromEntries(list.filter(a => a.toolUseId).map(a => [a.toolUseId, a.runId!])), ...(await read($, calls)) }
  const listed = new Set(list.map(a => a.runId))
  const ended = endedTasks(text).filter(t => listed.has(runOf[t.toolUseId]) && (OUTCOMES as readonly string[]).includes(t.status))
  if (!ended.length) return
  await update($, outcomes, all => ({ ...all, ...Object.fromEntries(ended.map(x => [runOf[x.toolUseId], x.status as RunOutcome])) }))
}

// What a Workflow call's launch result says (the tool's own record): the run, the script's
// `meta.name` and description, and where the script was saved.
type Launch = { runId?: string; workflowName?: string; summary?: string; scriptPath?: string }

// Remembers a workflow's name and phases by its run, and which run the call launched or resumed.
// The call's input reaches plugins empty, so the name comes from the launch result and the phases
// from the saved script; an input that does carry the script (or a name) is read first.
async function noteLaunch($: EngineInterface, toolUseId: string, input: { script?: string; name?: string; scriptPath?: string }, launch: Launch | undefined) {
  const run = launch?.runId || undefined
  const path = launch?.scriptPath ?? input.scriptPath
  await noteSessionDir($, launch?.scriptPath)
  const script = input.script ?? (path ? await $.fs.read(path).catch(() => undefined) : undefined)
  const name = input.name ?? launch?.workflowName ?? path?.split(/[\\/]/).pop()?.replace(/\.[a-z]+$/, '')
  // With no script to read, a resume keeps the description and phases its first launch gave
  // (kept by the run, or by the call its agents carry).
  const known = await read($, workflows)
  const byAgents = run ? (await read($, agents)).filter(a => a.runId === run).map(a => known[a.toolUseId]).find(Boolean) : undefined
  const before = known[run ?? toolUseId] ?? byAgents
  const meta = (typeof script === 'string' && parseMeta(script))
    || (name ? { name, description: launch?.summary ?? before?.description, phases: before?.phases ?? [] } : undefined)
  if (meta) await update($, workflows, all => ({ ...all, [run ?? toolUseId]: meta }))
  if (!run) return
  await update($, calls, all => ({ ...all, [toolUseId]: run }))
  // A new call for a run (a resume) starts it again: how it ended before no longer holds.
  if ((await read($, outcomes))[run]) await update($, outcomes, ({ [run]: _, ...rest }) => rest)
}

// Remembers the folder Claude Code keeps the session's files in (beside its `<id>.jsonl`
// transcript): from a hook's transcript path, or a workflow script saved under it.
let knownDir: string | undefined
async function noteSessionDir($: EngineInterface, path: string | undefined) {
  const p = path?.replace(/\\/g, '/')
  const cut = (mark: string) => (p?.includes(mark) ? p.slice(0, p.indexOf(mark)) : undefined)
  const dir = cut('/subagents/') ?? cut('/workflows/scripts/') ?? (p?.endsWith('.jsonl') ? p.slice(0, -6) : undefined)
  if (!dir || dir === knownDir) return
  knownDir = dir
  if ((await read($, sessionDir)) !== dir) await update($, sessionDir, () => dir)
}

// Lists a started agent: its row (with `change` made to the others in the same write), its card
// back from Archived, its run going on again, and the pane open if nothing was running.
async function listAgent($: EngineInterface, row: AgentRow, change = (all: AgentRow[]) => all) {
  const before = await read($, agents)
  const list = await update($, agents, all => [...change(all.filter(a => a.id !== row.id)), row].slice(-MAX_ROWS))
  // A workflow archived between its phases comes back whole when its next agent starts; an
  // agent started again under its old id comes back too.
  await restoreAgents($, row.runId ? list.filter(a => a.runId === row.runId).map(a => a.id) : [row.id])
  // A run that starts an agent goes on (a resumed one): how it ended before no longer holds.
  if (row.runId && (await read($, outcomes))[row.runId]) await update($, outcomes, ({ [row.runId!]: _, ...rest }) => rest)
  await syncIdle($, list, await read($, controls))
  if (!before.some(a => a.status === 'running')) void $.ui.open({ id: PANE, title: TITLE })
}

// Agents the monitor didn't see start: a workflow agent Claude Code started again after it
// stalled (a retry raises no agent.spawn), or one already running when the monitor loaded. Each is
// looked up by id in the files Claude Code keeps for the session's subagents, a few times (they
// may not be written yet), then given up on: the engine's own forks have none.
const lookups = new Map<string, { tries: number; at: number }>()
const adopting = new Map<string, Promise<AgentRow | undefined>>()
// Agents removed from the monitor, never looked up again.
const removed = new Set<string>()

type Found = { runId?: string; label: string; type: string; effort?: string; toolUseId?: string; startedAt: number; retryOf?: string; index?: number }

async function adopt($: EngineInterface, id: string, model: string): Promise<AgentRow | undefined> {
  if (removed.has(id) || !(await read($, sessionDir))) return undefined
  const pending = adopting.get(id)
  if (pending) return pending
  const t = await $.clock.now()
  const seen = lookups.get(id)
  if (seen && (seen.tries >= 5 || t - seen.at < 3000)) return undefined
  const run = (async () => {
    const found = await findAgent($, id, (seen?.tries ?? 0) >= 4).catch(() => undefined)
    if (!found) {
      lookups.set(id, { tries: (seen?.tries ?? 0) + 1, at: t })
      return undefined
    }
    lookups.delete(id)
    return adoptRow($, id, found, model)
  })().finally(() => adopting.delete(id))
  adopting.set(id, run)
  return run
}

// Where an agent stands in the session's files: a plain subagent's meta, or a workflow run's, with
// the run's journal naming every attempt at the agent() call it runs.
async function findAgent($: EngineInterface, id: string, final: boolean): Promise<Found | undefined> {
  const dir = await read($, sessionDir)
  if (!dir) return undefined
  const meta = async (path: string) => JSON.parse(await $.fs.read(path)) as { description?: string; agentType?: string; effort?: string; toolUseId?: string }
  // The meta is written as the agent starts, and never again.
  const startedAt = async (path: string) => (await $.fs.stat(path)).mtimeMs
  const plain = `${dir}/subagents/agent-${id}.meta.json`
  if (await $.fs.exists(plain)) {
    const m = await meta(plain)
    const base = m.description || m.agentType || id
    // A background agent started again keeps its Agent call: any other attempt at that call came
    // before, and the latest one not yet retried is the one this retries.
    const earlier = m.toolUseId ? (await read($, agents)).filter(a => !a.runId && a.toolUseId === m.toolUseId && a.id !== id) : []
    const prev = earlier.filter(a => !a.retriedBy && a.status !== 'done').at(-1)
    return {
      label: prev ? `${base} (retry ${earlier.length})` : base, type: m.agentType ?? 'subagent', effort: m.effort,
      toolUseId: m.toolUseId, startedAt: await startedAt(plain), retryOf: prev?.id,
    }
  }
  const root = `${dir}/subagents/workflows`
  for (const run of (await $.fs.list(root).catch(() => [])).filter(x => x.kind === 'dir')) {
    const file = `${root}/${run.name}/agent-${id}.meta.json`
    if (!(await $.fs.exists(file))) continue
    const m = await meta(file)
    type Started = { type?: string; key?: string; agentId?: string; label?: string }
    const journal = await $.fs.read(`${root}/${run.name}/journal.jsonl`).catch(() => '')
    const started = journal.split('\n').filter(l => l.includes('"started"')).flatMap((l): Started[] => {
      try { return [JSON.parse(l) as Started] } catch { return [] }
    }).filter(s => s.type === 'started' && s.key)
    const mine = started.find(s => s.agentId === id)
    // Its line may not be written yet: looked for again, unless this is the last look.
    if (journal && !mine && !final) return undefined
    const base = mine?.label || m.description || id
    const attempts = mine ? started.filter(s => s.key === mine.key) : []
    let n = mine ? attempts.indexOf(mine) : 0
    let retryOf = n > 0 ? attempts[n - 1]?.agentId : undefined
    if (!journal) {
      // No journal to read (over the read limit, or not there yet): an attempt with its label that
      // already ended without progress, and wasn't retried yet, is the one this retries. One still
      // running can't be told from a sibling with the same label, so it's left be.
      const list = await read($, agents)
      const prev = list.filter(a => a.runId === run.name && !a.retriedBy && a.status === 'stopped' && a.quietMs !== undefined
        && (a.label === base || a.label.startsWith(`${base} (retry `))).at(-1)
      const byId = new Map(list.map(a => [a.id, a]))
      n = 0
      for (let a = prev; a; a = a.retryOf ? byId.get(a.retryOf) : undefined) n++
      retryOf = prev?.id
    }
    return {
      runId: run.name, label: n > 0 ? `${base} (retry ${n})` : base, type: m.agentType ?? 'workflow-subagent',
      startedAt: await startedAt(file), retryOf,
      index: mine ? [...new Set(started.map(s => s.key))].indexOf(mine.key) + 1 : undefined,
    }
  }
  return undefined
}

// Lists an agent found in the session's files. A retry takes its first attempt's place: that one is
// over (Claude Code ended it before starting this one), and what the person set on it (pause or
// stop, model and effort) carries over.
async function adoptRow($: EngineInterface, id: string, found: Found, model: string): Promise<AgentRow> {
  const t = await $.clock.now()
  const first = found.retryOf ? (await read($, agents)).find(a => a.id === found.retryOf && !a.retriedBy && a.status !== 'done') : undefined
  const row: AgentRow = {
    id, runId: found.runId, toolUseId: found.toolUseId || first?.toolUseId || '', index: first?.index ?? found.index,
    label: found.label, type: found.type, model, effort: found.effort, isOverridden: false,
    status: 'running', startedAt: Math.min(found.startedAt || t, t), steps: 0, usage: ZERO,
    ...(found.retryOf ? { retryOf: found.retryOf } : {}),
  }
  // A run that began before the monitor loaded: its name and phases from its saved script.
  if (found.runId && !(await read($, workflows))[found.runId]) {
    const scripts = `${await read($, sessionDir)}/workflows/scripts`
    const file = (await $.fs.list(scripts).catch(() => [])).find(x => x.name.endsWith(`-${found.runId}.js`))
    const meta = file && parseMeta(await $.fs.read(`${scripts}/${file.name}`).catch(() => ''))
    if (meta) await update($, workflows, all => ({ ...all, [found.runId!]: meta }))
  }
  // Its agent.spawn may have listed it meanwhile.
  const listed = (await read($, agents)).find(a => a.id === id)
  if (listed) return listed
  if (first) {
    const carried = (await read($, controls))[first.id] ?? ended.get(first.id)?.control
    ended.delete(first.id)
    const quietMs = quietOf(first, t)
    pauseRequested.delete(first.id)
    stopRequested.delete(first.id)
    stoppers.delete(first.id)
    progress.delete(first.id)
    wake(first.id)
    await closeSettings($, [first.id])
    await update($, controls, ({ [first.id]: _, ...rest }) => rest)
    const own = (await read($, agentOverrides))[first.id]
    if (own) await update($, agentOverrides, all => ({ ...all, [id]: own }))
    await listAgent($, row, all => all.map(a => (a.id !== first.id ? a : {
      ...a, retriedBy: id, ...(a.status === 'running' ? { status: 'stopped' as const, endedAt: t, quietMs } : {}),
    })))
    if (carried) await setControl($, [id], carried)
  } else {
    await listAgent($, row)
  }
  return row
}

// An agent's phase: its label's prefix (`investigate:x`) matched to a phase title.
function phaseOf(label: string, phases: string[]): string | undefined {
  const prefix = label.split(':')[0]?.trim().toLowerCase()
  if (!prefix || prefix === label.trim().toLowerCase()) return undefined
  return phases.find(p => p.toLowerCase() === prefix) ?? prefix[0].toUpperCase() + prefix.slice(1)
}

// A tool call's arguments in a few words: the field a person would look for first.
function toolSummary(json: string): string {
  try {
    const input = JSON.parse(json) as Record<string, unknown>
    for (const k of ['file_path', 'command', 'pattern', 'path', 'url', 'query', 'description', 'prompt', 'skill']) {
      if (typeof input[k] === 'string') return (input[k] as string).replace(/\s+/g, ' ').slice(0, 160)
    }
    return ''
  } catch {
    return ''
  }
}

// Releases a paused agent's held tool calls (several run at once): on resume, stop, or the abort.
const waiters = new Map<string, Set<() => void>>()
const wake = (id: string) => {
  for (const resolve of waiters.get(id) ?? []) resolve()
  waiters.delete(id)
}
// How many of each agent's tool calls a pause holds right now.
const holds = new Map<string, number>()
// Pause and Stop asked of each agent, as this module knows them this instant; the cut for the
// reply a stopped agent is streaming now. The hold and the cut go by these, not by `controls`:
// every read of one dispatch sees one moment, so a request that read `controls` just before a
// Resume would go on seeing the pause and never let go. Seeded from `controls` on load.
const pauseRequested = new Set<string>()
const stopRequested = new Set<string>()
const stoppers = new Map<string, () => void>()
// The latest progress of each listed agent (a request starting, streaming or ending, a tool call
// ending), and how many of its tool calls are running: what Claude Code's stall check goes by.
const progress = new Map<string, number>()
const busy = new Map<string, number>()
// The pause or stop on an agent that ended aborted, for the retry Claude Code may start in its
// place once that end is reported; kept half an hour.
const ended = new Map<string, { control: Control; at: number }>()

// How long an agent had gone without progress at `t`; none while a tool call of its runs.
const quietOf = (a: AgentRow, t: number) =>
  (busy.get(a.id) ? 0 : t - Math.max(progress.get(a.id) ?? 0, a.activeAt ?? a.startedAt))

// Pause, resume (null) or stop agents, from either pane, and the workflow counters that follow.
async function setControl($: EngineInterface, ids: string[], v: Control | null) {
  for (const id of ids) {
    if (v === 'pause') pauseRequested.add(id)
    else pauseRequested.delete(id)
    if (v === 'stop') stopRequested.add(id)
  }
  const ctl = await update($, controls, all => {
    const next = { ...all }
    for (const id of ids) {
      if (v) next[id] = v
      else delete next[id]
    }
    return next
  })
  // Its counter stops while paused or stopping, and a resume leaves the paused time out.
  const t = await $.clock.now()
  const list = await update($, agents, all => all.map(a => {
    if (!ids.includes(a.id) || a.status !== 'running') return a
    if (v && a.pausedSince === undefined) return { ...a, pausedSince: t }
    if (!v && a.pausedSince !== undefined) {
      const { pausedSince, ...rest } = a
      return { ...rest, pausedTotal: (a.pausedTotal ?? 0) + t - pausedSince }
    }
    return a
  }))
  for (const id of ids) {
    if (v === 'stop') stoppers.get(id)?.()
    if (v !== 'pause') wake(id)
  }
  // From what it just wrote: read back in this dispatch, the state would still show the moment before.
  await syncIdle($, list, ctl)
}

// A pause holds an agent at a tool call, never at a model request: Claude Code ends a workflow
// agent whose request makes no progress for 10 minutes, but never while one of its tool calls is
// running, so a pause there can last all night. A hook's 10-second budget counts a plain wait and
// not a `$` call, so the hold waits on the host (see nap), racing the resume, which lets go at once.
// False if the host ran no wait, so the hold couldn't last.
async function hold($: EngineInterface, id: string, signal: AbortSignal): Promise<boolean> {
  holds.set(id, (holds.get(id) ?? 0) + 1)
  if (holds.get(id) === 1) await update($, held, all => ({ ...all, [id]: true }))
  try {
    while (pauseRequested.has(id) && !stopRequested.has(id) && !signal.aborted) {
      let release = () => {}
      const resumed = new Promise<void>(resolve => { release = resolve })
      const set = waiters.get(id) ?? new Set<() => void>()
      set.add(release)
      waiters.set(id, set)
      signal.addEventListener('abort', release, { once: true })
      // A resume that landed while the hold began still lets it go.
      if (!pauseRequested.has(id)) release()
      const waited = await Promise.race([resumed.then(() => true), nap($)])
      set.delete(release)
      signal.removeEventListener('abort', release)
      if (!waited) return false
    }
    return true
  } finally {
    const left = (holds.get(id) ?? 1) - 1
    if (left > 0) holds.set(id, left)
    else {
      holds.delete(id)
      await update($, held, ({ [id]: _, ...rest }) => rest)
    }
  }
}

// Half a minute's wait on the host: a child that sleeps (`ping` on Windows, which has no `sleep`).
// One that fails (it can't start, a sleeping machine cut it short, another `ping` comes first on
// the PATH) gives way to the next; false once none would wait.
let sleepers: (readonly string[])[] | undefined
let sleeper = 0
async function nap($: EngineInterface): Promise<boolean> {
  sleepers ??= (await $.env.get('OS').catch(() => undefined)) === 'Windows_NT'
    ? [['ping', '-n', '31', '127.0.0.1'], ['powershell', '-NoProfile', '-Command', 'Start-Sleep -Seconds 30']]
    : [['sleep', '30'], ['/bin/sleep', '30']]
  for (let tries = 0; tries < sleepers.length * 2; tries++) {
    const argv = sleepers[sleeper % sleepers.length] ?? []
    const done = await $.process.run(argv, { timeoutMs: 60_000 }).catch(() => undefined)
    if (done?.exitCode === 0) return true
    sleeper++
  }
  return false
}

// An agent is working while it runs with no pause or stop asked of it; only then does its time count.
function isWorking(a: AgentRow, ctl: Record<string, Control>): boolean {
  return a.status === 'running' && !ctl[a.id]
}

// How long a workflow run may stay quiet (no agent running, no word of its end) before its card
// reads as likely over rather than between phases.
const QUIET_MS = 10 * 60_000

// A group's agents by where each stands. Paused counts those still pausing (not yet held).
type Tally = { working: number; paused: number; pausing: number; stopping: number; done: number; failed: number; stopped: number }
function tallyOf(rows: AgentRow[], ctl: Record<string, Control>, holding: Record<string, boolean>): Tally {
  const t: Tally = { working: 0, paused: 0, pausing: 0, stopping: 0, done: 0, failed: 0, stopped: 0 }
  for (const r of rows) {
    if (r.status !== 'running') t[r.status]++
    else if (ctl[r.id] === 'pause') { t.paused++; if (!holding[r.id]) t.pausing++ }
    else if (ctl[r.id] === 'stop') t.stopping++
    else t.working++
  }
  return t
}

// What a card's status chip says of its group, the first that holds: some agent works; else some
// is paused; else some is stopping; else none runs and the run's own end decides (a workflow), or
// it may be between phases (idle) until it has been quiet a while; else the agents' own outcome
// (a workflow whose end never came reads from its agents too).
type GroupState =
  | { kind: 'working' | 'paused' | 'stopping' }
  | { kind: 'idle'; since: number }
  | { kind: 'done' | 'stopped' | 'script-failed' | 'failed' }
function groupState(rows: AgentRow[], t: Tally, isWorkflow: boolean, outcome: RunOutcome | undefined, isQuiet: boolean): GroupState {
  if (t.working) return { kind: 'working' }
  if (t.paused) return { kind: 'paused' }
  if (t.stopping) return { kind: 'stopping' }
  if (outcome === 'killed') return { kind: 'stopped' }
  if (outcome === 'failed') return { kind: 'script-failed' }
  if (outcome === 'completed') return { kind: 'done' }
  if (isWorkflow && !isQuiet) return { kind: 'idle', since: lastEnd(rows) }
  return { kind: t.done ? 'done' : t.failed ? 'failed' : 'stopped' }
}
const isActive = (s: GroupState) => s.kind === 'working' || s.kind === 'paused' || s.kind === 'stopping' || s.kind === 'idle'

// A group's last agent start or end.
const lastEnd = (rows: AgentRow[]) => Math.max(...rows.map(r => r.endedAt ?? r.startedAt))

// Marks workflow runs gone quiet: no agent running and no word of their end for a while. Each mark
// keeps the last start or end it was judged from, so an agent starting or ending since leaves it
// stale (see the Pane's `isQuiet`) with nothing to clear.
async function noteQuiet($: EngineInterface, t: number) {
  const list = await read($, agents)
  const ends = await read($, outcomes)
  const marked = await read($, quiet)
  const runs = new Map<string, AgentRow[]>()
  for (const a of list) if (a.runId) runs.set(a.runId, [...(runs.get(a.runId) ?? []), a])
  const lapsed = [...runs].filter(([run, rows]) => marked[run] !== lastEnd(rows)
    && rows.every(r => r.status !== 'running')
    && !ends[run]
    && lastEnd(rows) + QUIET_MS <= t)
  if (lapsed.length) await update($, quiet, all => ({ ...all, ...Object.fromEntries(lapsed.map(([run, rows]) => [run, lastEnd(rows)])) }))
}

// A workflow's counter stops while none of its agents is working (all paused, stopping or done
// beside them) and picks up from there when one works again. Written only when that changes.
// `list` and `ctl` are as the caller just wrote them.
async function syncIdle($: EngineInterface, list: AgentRow[], ctl: Record<string, Control>) {
  const t = await $.clock.now()
  const all = await read($, idle)
  const changes: Record<string, Idle> = {}
  for (const g of new Set(list.map(groupKey))) {
    const rows = list.filter(a => groupKey(a) === g)
    const was = all[g] ?? { total: 0 }
    const working = rows.some(a => isWorking(a, ctl))
    if (working && was.since !== undefined) changes[g] = { total: was.total + t - was.since }
    else if (!working && was.since === undefined && rows.some(a => a.status === 'running')) changes[g] = { since: t, total: was.total }
  }
  if (Object.keys(changes).length) await update($, idle, cur => ({ ...cur, ...changes }))
}

// A finished agent's settings panel closes: nothing in it applies any more. So does the panel of
// a group whose card leaves the pane.
async function closeSettings($: EngineInterface, ids: string[], groups: string[] = []) {
  const open = await read($, editing)
  if (open && (ids.some(id => open === `agent:${id}`) || groups.some(g => open === `group:${g}`))) {
    await update($, editing, cur => (cur === open ? null : cur))
  }
}

// A keyed value without `keys`.
const without = <V,>(all: Record<string, V>, keys: Set<string>): Record<string, V> =>
  Object.fromEntries(Object.entries(all).filter(([k]) => !keys.has(k)))

// Brings archived agents back to their card; written only when one of them is archived.
async function restoreAgents($: EngineInterface, ids: string[]) {
  const back = new Set(ids)
  if (Object.keys(await read($, archived)).some(id => back.has(id))) await update($, archived, all => without(all, back))
}

// Archives agents: their card leaves the pane for the Archived section, whole and restorable.
async function archiveAgents($: EngineInterface, ids: string[]) {
  if (!ids.length) return
  const t = await $.clock.now()
  const list = await read($, agents)
  await closeSettings($, ids, [...new Set(list.filter(a => ids.includes(a.id)).map(groupKey))])
  await update($, archived, all => ({
    // Entries whose rows are gone since (capped or cleared) go with this write.
    ...Object.fromEntries(Object.entries(all).filter(([id]) => list.some(a => a.id === id))),
    ...Object.fromEntries(ids.map(id => [id, t])),
  }))
}

// Removes agents from the monitor for good: their rows, activity and all the pane kept about
// them. Their work itself is untouched. A group left with no agents starts afresh if one joins.
async function removeAgents($: EngineInterface, ids: string[]) {
  if (!ids.length) return
  const gone = new Set(ids)
  for (const id of ids) {
    pauseRequested.delete(id)
    stopRequested.delete(id)
    stoppers.delete(id)
    progress.delete(id)
    ended.delete(id)
    removed.add(id)
    wake(id)
  }
  const groups = [...new Set((await read($, agents)).filter(a => gone.has(a.id)).map(groupKey))]
  if (gone.has((await read($, inspecting)) ?? '')) await update($, inspecting, () => null)
  const list = await update($, agents, all => all.filter(a => !gone.has(a.id)))
  const drop = <V,>(all: Record<string, V>) => without(all, gone)
  await update($, logs, drop)
  await update($, agentOverrides, drop)
  await update($, controls, drop)
  await update($, held, drop)
  const arch = await update($, archived, drop)
  // A group's panel closes only once its card has left the board (plain subagents can have a
  // card on it and older ones under Archived at once).
  await closeSettings($, ids, groups.filter(g => !list.some(a => groupKey(a) === g && !arch[a.id])))
  const emptied = new Set(groups.filter(g => !list.some(a => groupKey(a) === g)))
  if (emptied.size) {
    await update($, idle, all => without(all, emptied))
    // Its card's fold and those of its phases.
    await update($, collapsed, all => Object.fromEntries(Object.entries(all).filter(([k]) => !emptied.has(foldGroup(k)))))
    // Its model and effort too: with no card left to show them, they'd apply unseen.
    await update($, groupOverrides, all => without(all, emptied))
    // And what the monitor knew of the run: its name, how it ended, whether it went quiet, its calls.
    await update($, workflows, all => without(all, emptied))
    await update($, outcomes, all => without(all, emptied))
    await update($, quiet, all => without(all, emptied))
    await update($, calls, all => Object.fromEntries(Object.entries(all).filter(([, run]) => !emptied.has(run))))
  }
  for (const k of foldedNow.keys()) if (emptied.has(foldGroup(k))) foldedNow.delete(k)
}

// Which cards the person last saw folded, as the pane drew them: by group key, and a phase on
// one by `<group>::<phase>`.
const foldedNow = new Map<string, boolean>()
const foldGroup = (k: string) => (k.includes('::') ? k.slice(0, k.indexOf('::')) : k)

// Each Button or Select a pane draws again just as before is handed back as the same element,
// so it keeps its press handle. Every element built takes a fresh handle, and the host holds one
// only while the drawing that carried it is the latest: a click landing just after a redraw (a
// step finishing, a time ticking over) would name a retired handle, be dropped, and need a second
// click. A kept element keeps its handle through any number of redraws. By site (surface and
// pane), then key; whatever a drawing leaves out goes with it.
type Kept = { shape: string; element: unknown }
const kept = new Map<string, Map<string, Kept>>()
function keeper(site: string) {
  const before = kept.get(site) ?? new Map<string, Kept>()
  const drawn = new Map<string, Kept>()
  kept.set(site, drawn)
  return <T,>(key: string, element: T): T => {
    // What the surface draws: everything but the handle (and the closures, which JSON leaves out).
    const shape = JSON.stringify(element, (k, v) => (k === 'press' ? undefined : v))
    const was = before.get(key)
    const entry = was && was.shape === shape ? was : { shape, element }
    drawn.set(key, entry)
    return entry.element as T
  }
}
// The handler every pane control carries. The `ui.press` and `ui.select` hooks run the control by
// its key with their own `$`, so a kept element's closure needs nothing from the drawing it came from.
const byHook = () => {}

// Runs a control by its key, as pressed or picked in either pane.
async function perform($: EngineInterface, key: string, value?: string) {
  const list = await read($, agents)
  const ctl = await read($, controls)
  const agent = (id: string) => list.find(a => a.id === id)
  const running = (group: string) => list.filter(a => groupKey(a) === group && a.status === 'running')
  const toggleEditor = (id: string) => update($, editing, cur => (cur === id ? null : id))
  const inspect = async (id: string) => {
    await update($, inspecting, () => id)
    await $.ui.open({ id: INSPECT, title: `Agent · ${agent(id)?.label ?? id}` })
  }
  const choose = (o: Override, field: keyof Override): Override => ({ ...o, [field]: value === 'inherit' ? undefined : value })
  const rest = (prefix: string) => key.slice(prefix.length)
  // Pause and Stop act on running agents only (a panel can outlive its agent), and a stop already
  // asked for stands: a later Pause or Resume leaves it be.
  const stoppable = (id: string) => agent(id)?.status === 'running' && ctl[id] !== 'stop'
  const control = async (ids: string[], v: Control | null) => { if (ids.length) await setControl($, ids, v) }
  // A group's agents on its card, and those under Archived. A card closes once none of it runs.
  const arch = await read($, archived)
  const onCard = (g: string) => list.filter(a => groupKey(a) === g && !arch[a.id])
  const stored = (g: string) => list.filter(a => groupKey(a) === g && arch[a.id]).map(a => a.id)
  const closable = (g: string) => onCard(g).every(a => a.status !== 'running') ? onCard(g).map(a => a.id) : []

  if (key === 'archived-toggle') await update($, archiveOpen, v => !v)
  else if (key === 'purge-archived') await removeAgents($, list.filter(a => arch[a.id]).map(a => a.id))
  else if (key.startsWith('close-')) await archiveAgents($, closable(rest('close-')))
  else if (key.startsWith('archive-')) await archiveAgents($, closable(rest('archive-')))
  else if (key.startsWith('remove-')) await removeAgents($, closable(rest('remove-')))
  else if (key.startsWith('restore-')) await restoreAgents($, stored(rest('restore-')))
  else if (key.startsWith('purge-')) await removeAgents($, stored(rest('purge-')))
  // A card's name (`fold-<group>`); a phase's chevron (`fold-<group>::<phase>`), name
  // (`phase-<group>::<phase>`) or count (`count-<group>::<phase>`).
  else if (key.startsWith('fold-') || key.startsWith('phase-') || key.startsWith('count-')) {
    const k = key.slice(key.indexOf('-') + 1)
    await update($, collapsed, all => ({ ...all, [k]: !(foldedNow.get(k) ?? false) }))
  }
  else if (key.startsWith('gear-group-')) await toggleEditor(`group:${rest('gear-group-')}`)
  else if (key.startsWith('gear-')) agent(rest('gear-'))?.status === 'running' ? await toggleEditor(`agent:${rest('gear-')}`) : await inspect(rest('gear-'))
  else if (key.startsWith('pause-all-')) {
    const rows = running(rest('pause-all-')).filter(r => stoppable(r.id))
    const resume = rows.some(r => ctl[r.id] === 'pause')
    await control(rows.map(r => r.id), resume ? null : 'pause')
  } else if (key.startsWith('stop-all-')) await control(running(rest('stop-all-')).filter(r => stoppable(r.id)).map(r => r.id), 'stop')
  else if (key.startsWith('pause-')) { const id = rest('pause-'); if (stoppable(id)) await control([id], ctl[id] === 'pause' ? null : 'pause') }
  else if (key.startsWith('stop-')) { const id = rest('stop-'); if (stoppable(id)) await control([id], 'stop') }
  else if (key.startsWith('activity-')) await inspect(rest('activity-'))
  else if (key.startsWith('done-')) await update($, editing, () => null)
  else if (key.startsWith('model-group-') || key.startsWith('effort-group-')) {
    const field = key.startsWith('model-') ? 'model' : 'effort'
    const g = rest(`${field}-group-`)
    await update($, groupOverrides, all => ({ ...all, [g]: choose(all[g] ?? {}, field) }))
  } else if (key.startsWith('model-') || key.startsWith('effort-')) {
    const field = key.startsWith('model-') ? 'model' : 'effort'
    const id = rest(`${field}-`)
    await update($, agentOverrides, all => ({ ...all, [id]: choose(all[id] ?? {}, field) }))
  }
}

// `/workflows demo`: a made-up workflow whose agents "work" on the clock tick, so every control can be tried.
const DEMO = 'demo-'
const DEMO_SCRIPT: LogEntry[] = [
  { kind: 'thinking', text: 'The handler validates the cart twice; the second pass can go if the first one is cached.' },
  { kind: 'tool', tool: 'Grep', text: 'validateCart' },
  { kind: 'tool', tool: 'Read', text: 'src/checkout/cart.ts' },
  { kind: 'text', text: 'Found the duplicate validation in `cart.ts:88`. Checking whether anything relies on it.' },
  { kind: 'tool', tool: 'Bash', text: 'npm test -- checkout' },
  { kind: 'thinking', text: 'Tests pass without the second call. Next: the payment retry path.' },
  { kind: 'tool', tool: 'Read', text: 'src/checkout/payment.ts' },
  { kind: 'text', text: 'Payment retries reuse the same idempotency key, which is correct.' },
]

function demoSeed(t: number): { rows: AgentRow[]; logs: Record<string, LogEntry[]> } {
  const row = (n: number, label: string, model: string, effort: string, status: AgentStatus, ago: number, took: number | undefined, out: number, runId?: string): AgentRow => ({
    id: `${DEMO}${n}`, runId, toolUseId: runId ? 'toolu_demo' : 'toolu_demo_sub', index: runId ? n : undefined,
    label, type: runId ? 'workflow' : 'Explore', model, effort, isOverridden: false, status,
    startedAt: t - ago * 1000, endedAt: took === undefined ? undefined : t - (ago - took) * 1000,
    steps: Math.ceil(out / 900), usage: { input: out * 2, output: out, cacheRead: out * 12, cacheWrite: out },
  })
  const wf = 'wf_demo'
  const rows = [
    row(1, 'investigate:payment-flow', 'claude-opus-5-5', 'high', 'done', 240, 95, 6200, wf),
    row(2, 'investigate:cart-state', 'claude-sonnet-5-5', 'medium', 'done', 238, 70, 4100, wf),
    row(3, 'investigate:analytics-events', 'claude-haiku-5-5', 'low', 'failed', 236, 40, 900, wf),
    row(4, 'design:api-contract', 'claude-opus-5-5', 'high', 'running', 120, undefined, 3900, wf),
    row(5, 'design:ui-components', 'claude-sonnet-5-5', 'medium', 'running', 118, undefined, 2800, wf),
    row(6, 'design:migration-plan', 'claude-sonnet-5-5', 'high', 'running', 115, undefined, 2100, wf),
    row(7, 'review:accessibility', 'claude-haiku-5-5', 'low', 'stopped', 60, 25, 700, wf),
    row(8, 'review:performance', 'claude-opus-5-5', 'xhigh', 'running', 55, undefined, 1500, wf),
    row(9, 'Map the checkout module', 'claude-haiku-5-5', 'low', 'running', 30, undefined, 800),
  ]
  // The paused one has been paused for 20s: its time stands still from there.
  rows[5] = { ...rows[5], pausedSince: t - 20_000 }
  const logs: Record<string, LogEntry[]> = {}
  rows.forEach((r, i) => { logs[r.id] = DEMO_SCRIPT.slice(0, 3 + (i % 5)) })
  logs[`${DEMO}7`] = [...logs[`${DEMO}7`], { kind: 'note', text: 'Stopped from the workflow monitor.' }]
  return { rows, logs }
}

// Takes the demo away: its rows as Remove does, then anything else keyed by a demo id (a tick
// that read the demo just before its rows went may still have written some).
async function clearDemo($: EngineInterface) {
  await removeAgents($, (await read($, agents)).filter(a => a.id.startsWith(DEMO)).map(a => a.id))
  const ids = [
    ...pauseRequested, ...stopRequested,
    ...Object.keys(await read($, logs)), ...Object.keys(await read($, controls)), ...Object.keys(await read($, held)),
  ]
  const demo = new Set(ids.filter(id => id.startsWith(DEMO)))
  if (!demo.size) return
  for (const id of demo) { pauseRequested.delete(id); stopRequested.delete(id); wake(id) }
  await update($, logs, all => without(all, demo))
  await update($, controls, all => without(all, demo))
  await update($, held, all => without(all, demo))
}

// One second of the demo, written only when something changed, as real agents are: Pause and
// Stop land at once, and every other second one working agent finishes a model step.
async function demoTick($: EngineInterface, t: number) {
  const ctl = await read($, controls)
  const holding = await read($, held)
  const demo = (await read($, agents)).filter(a => a.id.startsWith(DEMO) && a.status === 'running')
  const stopped = demo.filter(a => ctl[a.id] === 'stop').map(a => a.id)
  const paused = demo.filter(a => ctl[a.id] === 'pause').map(a => a.id)
  const working = demo.filter(a => !ctl[a.id])
  const second = Math.floor(t / 1000)
  const stepper = second % 2 === 0 && working.length ? working[(second / 2) % working.length] : undefined

  const heldNow = Object.keys(holding).filter(id => id.startsWith(DEMO)).sort().join()
  if (heldNow !== [...paused].sort().join()) {
    await update($, held, all => ({
      ...Object.fromEntries(Object.entries(all).filter(([id]) => !id.startsWith(DEMO))),
      ...Object.fromEntries(paused.map(id => [id, true])),
    }))
  }
  if (!stopped.length && !stepper) return

  if (stopped.length) await closeSettings($, stopped)
  const list = await update($, agents, all => all.map(a => {
    if (stopped.includes(a.id)) return { ...a, status: 'stopped' as const, endedAt: t }
    if (a.id !== stepper?.id) return a
    const out = 400 + (a.label.length * 37 + second) % 700
    return { ...a, steps: a.steps + 1, usage: { input: a.usage.input + out * 2, output: a.usage.output + out, cacheRead: a.usage.cacheRead + out * 12, cacheWrite: a.usage.cacheWrite } }
  }))
  await update($, logs, all => {
    const next = { ...all }
    for (const id of stopped) next[id] = [...(next[id] ?? []), { kind: 'note' as const, text: 'Stopped from the workflow monitor.' }]
    if (stepper) {
      const list = next[stepper.id] ?? []
      next[stepper.id] = [...list, DEMO_SCRIPT[list.length % DEMO_SCRIPT.length]].slice(-MAX_LOG)
    }
    return next
  })
  for (const id of stopped) stopRequested.delete(id)
  if (stopped.length) await update($, controls, all => Object.fromEntries(Object.entries(all).filter(([id]) => !stopped.includes(id))))
  // The demo's agents only end when stopped: its run is over, stopped, once none of them runs.
  if (stopped.some(id => list.find(a => a.id === id)?.runId) && !list.some(a => a.runId === 'wf_demo' && a.status === 'running')) {
    await update($, outcomes, all => ({ ...all, wf_demo: 'killed' as const }))
  }
}

export const register: Register = on => {
  // Every press and pick in the two panes, run by the control's key (see byHook).
  on('ui.press', { plugin: 'workflow-monitor' }, async ($, e, next) => {
    if (e.requestId !== PANE && e.requestId !== INSPECT) return next(e)
    await perform($, e.element)
    return { element: e.element }
  })
  on('ui.select', { plugin: 'workflow-monitor' }, async ($, e, next) => {
    if (e.requestId !== PANE && e.requestId !== INSPECT) return next(e)
    await perform($, e.element, e.value)
    return { element: e.element, value: e.value }
  })

  // A click on a phase's header, through its press region (press.tsx): fold or unfold the phase,
  // as its chevron does. A phase the pane draws, and nothing else: the post is the region's code.
  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE || !e.element.startsWith('hit-')) return next(e)
    const k = (e.data as { toggle?: unknown } | null)?.toggle
    if (typeof k === 'string' && k.includes('::') && foldedNow.has(k)) await perform($, `fold-${k}`)
    return {}
  })

  on('session.start', async ($, e, next) => {
    // The typeahead's line for it, and its options drawn dim after the name (USAGE spells them out).
    await $.command.register({
      name: 'workflows',
      description: 'Live pane of workflows and subagents: model, effort, tokens, time, cost; pause, stop, inspect',
      argumentHint: '[demo|clear|help]',
    })
    // A reload starts this module afresh: pick up the pauses and stops already asked for.
    for (const [id, v] of Object.entries(await read($, controls))) (v === 'pause' ? pauseRequested : stopRequested).add(id)
    // Elapsed times tick by themselves on the surface (./ticker.tsx): nothing here redraws the
    // pane on a clock, so it redraws only when something changes. A run going quiet does (see
    // noteQuiet), and the demo's agents run on this.
    $.clock.every(1000, () => {
      void (async () => {
        const t = await $.clock.now()
        await noteQuiet($, t)
        const list = await read($, agents)
        if (!list.some(a => a.id.startsWith(DEMO) && a.status === 'running')) return
        await demoTick($, t)
      })()
    })

    return next(e)
  })

  on('command.run', { command: 'workflows' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'clear') {
      await removeAgents($, (await read($, agents)).filter(a => a.status !== 'running').map(a => a.id))
      await clearDemo($)
      return { text: 'Cleared finished, archived and demo agents from the workflow monitor.' }
    }
    if (arg === 'demo') {
      const t = await $.clock.now()
      const seed = demoSeed(t)
      // A fresh demo: whatever is left of the last one (rows, pauses, archive) goes first.
      await clearDemo($)
      await update($, workflows, all => ({
        ...all,
        wf_demo: { name: 'checkout-redesign', description: 'Investigate the checkout flow, design the fixes, and review them (demo data).', phases: ['Investigate', 'Design', 'Review'] },
      }))
      await update($, agents, list => [...list, ...seed.rows])
      await update($, logs, all => ({ ...all, ...seed.logs }))
      await update($, controls, all => ({ ...all, [`${DEMO}6`]: 'pause' as const }))
      await update($, held, all => ({ ...all, [`${DEMO}6`]: true }))
      pauseRequested.add(`${DEMO}6`)
      await update($, idle, ({ wf_demo: _, [SUBAGENTS]: __, ...rest }) => rest)
      await $.ui.open({ id: PANE, title: TITLE })
      return { text: 'Demo workflow loaded: its running agents tick every second. Try ⚙ on a running row. /workflows clear removes it.' }
    }
    // Each opening line follows the plugin's name the row starts with ("workflow-monitor: …").
    if (arg === 'help') return { text: `a live pane of your workflows and subagents.\n\n${USAGE}` }
    // An option it doesn't know: say so with the ones it does, rather than open the pane unasked.
    if (arg) return { text: `unknown option \`${arg.replace(/`/g, '')}\`. It takes these:\n\n${USAGE}` }
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Workflow monitor opened.' }
  })

  // A workflow run's end: its task notification names the Workflow call and how the run ended.
  // Until then a run with no agent running may only be between phases.
  // Every prompt passes here, so nothing this notes can hold one up.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'task-notification') await noteRunEnds($, e.text).catch(() => {})

    return next(e)
  })

  // A workflow's name and phases, and the run the call launched or resumed (see noteLaunch). The
  // Workflow tool runs in the background: its result is the launch, back at once.
  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
    const done = await next(e)
    const launch = 'result' in done && !done.isError && typeof done.result === 'object' ? done.result as Launch : undefined
    await noteLaunch($, e.tool_use_id, ((e as { input?: unknown }).input ?? e) as { script?: string; name?: string; scriptPath?: string }, launch).catch(() => {})

    return done
  })

  // A paused agent's tool call waits here until it is resumed (see hold). A stopped agent runs no
  // more tools: the calls it already asked for are refused.
  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (!id) return next(e)
    busy.set(id, (busy.get(id) ?? 0) + 1)
    try {
      const isHeld = pauseRequested.has(id) && !stopRequested.has(id)
      if (isHeld && !(await hold($, id, next.signal)) && pauseRequested.has(id)) {
        // No wait would start on this machine: the pause is lifted, saying so, and the call runs.
        await setControl($, [id], null)
        const text = 'The pause couldn’t hold this agent (no wait process would start here), so it went on.'
        await update($, logs, all => ({ ...all, [id]: [...(all[id] ?? []), { kind: 'note' as const, text }].slice(-MAX_LOG) }))
        $.ui.toast(`Workflow monitor: ${text}`)
      }
      if (stopRequested.has(id)) return { deny: 'Stopped from the workflow monitor. Do not retry; finish now.' }
      if (isHeld && next.signal.aborted) return { deny: 'Interrupted while paused from the workflow monitor.' }
      return await next(e)
    } finally {
      const left = (busy.get(id) ?? 1) - 1
      if (left > 0) busy.set(id, left)
      else busy.delete(id)
      if (progress.has(id)) progress.set(id, await $.clock.now())
    }
  })

  // The session's folder, where agents the monitor didn't see start are looked up (see adopt):
  // every tool call's classic hook names it, in any agent.
  on('classic.PostToolUse', async ($, e, next) => {
    await noteSessionDir($, e.transcript_path).catch(() => {})

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if ('deny' in started || !started.agentId) return started

    const row: AgentRow = {
      id: started.agentId,
      runId: e.workflow?.runId || undefined,
      toolUseId: e.tool_use_id,
      index: e.workflow?.agentIndex,
      label: e.description || e.subagentType,
      type: e.subagentType,
      model: started.model,
      isOverridden: false,
      status: 'running',
      startedAt: await $.clock.now(),
      steps: 0,
      usage: ZERO,
    }
    await listAgent($, row)

    return started
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) return yield* next(e)

    const id = e.agentId

    // Stop: answer in the model's place with a final reply, so the agent's loop ends cleanly.
    if (stopRequested.has(id)) {
      await update($, logs, all => ({ ...all, [id]: [...(all[id] ?? []), { kind: 'note' as const, text: 'Stopped from the workflow monitor.' }].slice(-MAX_LOG) }))
      yield { kind: 'text', index: 0, text: STOP_TEXT }
      return { turnId: e.turnId, index: e.index, answer: STOP_TEXT, toolUses: [], stopReason: 'end_turn', usage: null }
    }

    // An agent the monitor didn't see start is looked up (see adopt); one it can't place, or removed
    // from it, is left be.
    const row = (await read($, agents)).find(a => a.id === id) ?? await adopt($, id, e.model)
    if (!row) return yield* next(e)
    progress.set(id, await $.clock.now())
    const own = (await read($, agentOverrides))[id] ?? {}
    const group = (await read($, groupOverrides))[groupKey(row)] ?? {}
    const model = own.model ?? group.model
    const effort = own.effort ?? group.effort
    const sent = { ...e, ...(model ? { model } : {}), ...(effort ? { effort: effort as typeof e.effort } : {}) }

    // Written only when it changes: every write redraws the pane.
    const shown = (a: AgentRow): AgentRow =>
      ({ ...a, model: sent.model || a.model, effort: sent.effort === undefined ? a.effort : String(sent.effort), isOverridden: a.isOverridden || !!(model || effort) })
    if (JSON.stringify(shown(row)) !== JSON.stringify(row)) {
      await update($, agents, list => list.map(a => (a.id === id ? shown(a) : a)))
    }
    // Pass the stream through untouched, keeping a copy of it for the Inspect pane.
    const before = (await read($, logs))[id] ?? []
    const blocks = new Map<number, LogEntry>()
    const inputs = new Map<number, string>()
    const flush = () => update($, logs, all => ({
      ...all,
      [id]: [...before, ...[...blocks.entries()].map(([i, b]) => (b.kind === 'tool' ? { ...b, text: toolSummary(inputs.get(i) ?? '') } : b))].slice(-MAX_LOG),
    }))
    const stream = next(sent)[Symbol.asyncIterator]()
    // Stop cuts the reply mid-stream: whichever comes first, the next chunk or the stop.
    const cut = new Promise<'stop'>(resolve => {
      stoppers.set(id, () => resolve('stop'))
      if (stopRequested.has(id)) resolve('stop')
    })
    let chunks = 0
    let last = -1
    let step = await Promise.race([stream.next(), cut])
    while (step !== 'stop' && !step.done) {
      const c = step.value
      if ('index' in c && typeof c.index === 'number') last = Math.max(last, c.index)
      if (c.kind === 'text' || c.kind === 'thinking') {
        const b = blocks.get(c.index)
        blocks.set(c.index, { kind: c.kind, text: ((b?.text ?? '') + c.text).slice(-MAX_ENTRY) })
      } else if (c.kind === 'tool') {
        blocks.set(c.index, { kind: 'tool', tool: c.name, text: '' })
      } else if (c.kind === 'input') {
        inputs.set(c.index, (inputs.get(c.index) ?? '') + c.json)
      }
      if (c.kind === 'tool' || ++chunks % 12 === 0) {
        await flush()
        progress.set(id, await $.clock.now())
      }
      yield c
      step = stopRequested.has(id) ? 'stop' : await Promise.race([stream.next(), cut])
    }
    stoppers.delete(id)
    if (step === 'stop') {
      // Cancel the request, then end the reply with the stop note and no tool calls.
      void stream.return?.(undefined)
      blocks.set(last + 1, { kind: 'note', text: 'Stopped from the workflow monitor.' })
      await flush()
      yield { kind: 'text', index: last + 1, text: STOP_TEXT }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return { turnId: e.turnId, index: e.index, answer: STOP_TEXT, toolUses: [], stopReason: 'end_turn', usage: null }
    }
    const result = step.value
    await flush()
    const usage = result.usage
    const activeAt = await $.clock.now()
    progress.set(id, activeAt)
    await update($, agents, list =>
      list.map(a => (a.id === id ? { ...a, steps: a.steps + 1, activeAt, usage: usage ? addUsage(a.usage, usage) : a.usage } : a)),
    )

    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      const id = e.agentId
      const endedAt = await $.clock.now()
      const wasStopped = stopRequested.has(id)
      const status: AgentStatus = wasStopped || e.reason === 'aborted' ? 'stopped' : e.reason === 'answer' ? 'done' : 'failed'
      // Ended from outside the monitor (Claude Code's stall check, the run stopped, an interrupt):
      // how long it had gone without progress, for its Inspect view. A retried attempt was ended,
      // with all that, as its retry started.
      const row = (await read($, agents)).find(a => a.id === id)
      const outside = row && e.reason === 'aborted' && !wasStopped ? { quietMs: quietOf(row, endedAt) } : {}
      const control = (await read($, controls))[id]
      for (const [k, v] of ended) if (endedAt - v.at > 30 * 60_000) ended.delete(k)
      if (row && !row.retriedBy && e.reason === 'aborted' && control) ended.set(id, { control, at: endedAt })
      pauseRequested.delete(id)
      stopRequested.delete(id)
      stoppers.delete(id)
      progress.delete(id)
      wake(id)
      await closeSettings($, [id])
      const ctl = await update($, controls, ({ [id]: _, ...rest }) => rest)
      const list = await update($, agents, all =>
        all.map(a => {
          if (a.id !== id) return a
          // Steps already counted each request; fall back to the turn's total if none reported.
          const counted = totalTokens(a.usage) > 0
          const usage = !counted && e.usage ? addUsage(ZERO, e.usage) : a.usage
          return a.retriedBy ? { ...a, usage } : { ...a, status, endedAt, ...outside, usage }
        }),
      )
      await syncIdle($, list, ctl)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Select } = elements
    // Terminal and desktop run `Client` regions (the ticking times); the other surfaces don't.
    const Client = 'Client' in elements ? elements.Client : undefined
    const list = await read($, agents)
    const metas = await read($, workflows)
    const own = await read($, agentOverrides)
    const groups = await read($, groupOverrides)
    const open = await read($, editing)
    const folded = await read($, collapsed)
    const ctl = await read($, controls)
    const holding = await read($, held)
    const arch = await read($, archived)
    const archOpen = await read($, archiveOpen)
    const idleBy = await read($, idle)
    const ends = await read($, outcomes)
    const lapsed = await read($, quiet)
    const tick = Math.max(await $.clock.now(), ...list.map(a => a.endedAt ?? a.startedAt), 0)
    const width = e.props.bodyColumns ?? e.viewport?.columns ?? 100
    // A card's chip: spelled out on wide ("⏸ 1 · ✓ 1"), tight on medium ("⏸1 ✓1"), and on narrow a
    // lead alone keeps no word either ("⏸1", not "⏸ 1 paused").
    const layout = width >= 84 ? 'wide' : width >= 58 ? 'medium' : 'narrow'
    const wide = layout === 'wide'
    // Agent rows hide no column at any width: the agent's name is cut short instead, and once that
    // leaves it under LABEL_MIN, each agent goes on two lines, every column's value on the second.
    // A surface that paints fills draws Claude Code's own panel look: filled cards, no borders.
    const gui = e.surface !== 'terminal'
    const gearW = gui ? W.nativeGear : W.gear
    const beside = CARD_X + [W.glyph, W.model, W.effort, W.tokens, W.time, W.cost, gearW].reduce((sum, w) => sum + w + 1, 0)
    const inline = width - beside < LABEL_MIN

    if (list.length === 0) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text bold>Workflow monitor</Text>
          <Text dimColor>No subagents yet. Workflows and Agent-tool subagents show up here as they start.</Text>
        </Box>
      )
    }

    // Group by workflow run; plain subagents share one group. Groups still going first (working,
    // paused, stopping or between phases), then newest. Archived agents leave their cards for the
    // Archived section at the end.
    const grouped = (rows: AgentRow[]) => {
      const byGroup = new Map<string, AgentRow[]>()
      for (const a of rows) byGroup.set(groupKey(a), [...(byGroup.get(groupKey(a)) ?? []), a])
      return byGroup
    }
    const shown = list.filter(a => !arch[a.id])
    const board = [...grouped(shown).entries()]
    const tallies = new Map(board.map(([key, rows]) => [key, tallyOf(rows, ctl, holding)]))
    // A run is quiet while its mark still holds its last start or end, archived agents included.
    const isQuiet = (key: string) => lapsed[key] !== undefined && lapsed[key] === lastEnd(list.filter(a => groupKey(a) === key))
    const states = new Map(board.map(([key, rows]) =>
      [key, groupState(rows, tallies.get(key)!, key !== SUBAGENTS, ends[key], isQuiet(key))]))
    const active = (key: string) => isActive(states.get(key)!)
    const ordered = board.sort(([ka, a], [kb, b]) =>
      Number(active(kb)) - Number(active(ka)) || Math.max(...b.map(r => r.startedAt)) - Math.max(...a.map(r => r.startedAt)))
    // Most recently archived first.
    const shelf = [...grouped(list.filter(a => arch[a.id])).entries()]
      .sort(([, a], [, b]) => Math.max(...b.map(r => arch[r.id] ?? 0)) - Math.max(...a.map(r => arch[r.id] ?? 0)))
    const anyActive = ordered.some(([key]) => active(key))
    // A workflow's name and phases: by its run, or by a call one of its agents carries.
    const metaOf = (key: string, rows: AgentRow[]) => metas[key] ?? rows.map(r => metas[r.toolUseId]).find(Boolean)

    // Time an agent spent working: frozen from a pause or stop, with earlier pauses left out.
    const worked = (r: AgentRow) => (r.pausedSince ?? r.endedAt ?? tick) - r.startedAt - (r.pausedTotal ?? 0)
    const working = (r: AgentRow) => isWorking(r, ctl)

    // A square's color: as the row's icon (see look), amber while paused, grey while stopping.
    const squareHex = (r: AgentRow) =>
      r.status === 'running' && ctl[r.id] ? (ctl[r.id] === 'pause' ? PAUSED : STOPPED) : HEX[r.status]

    // An elapsed time: it counts up by itself where the surface runs `Client` regions, so no redraw is needed.
    const timer = (key: string, ms: number, rate: number, dim = false) =>
      Client
        ? <Client key={key} module="./ticker.tsx" props={{ base: ms, rate, ...(dim ? { dim } : {}) }} />
        : <Text dimColor={dim}>{duration(ms)}</Text>

    const cell = (w: number, child: unknown, right = false) => (
      <Box width={w} flexShrink={0} justifyContent={right ? 'flex-end' : 'flex-start'}>{child}</Box>
    )
    // Status icons differ in width (✓ ✗ ⏸ ⏹ ●): centred, they line up in one column.
    const glyphCell = (child: unknown) => (
      <Box width={W.glyph} flexShrink={0} justifyContent="center" alignItems="center">{child}</Box>
    )
    // The row button, centred both ways in its column (⚙ ◆ ▴ ↗ line up; a native button sits mid-row).
    const gearCell = (child: unknown) => (
      <Box width={gearW} flexShrink={0} justifyContent="center" alignItems="center">{child}</Box>
    )

    // Faint text (see HEADING): a fixed grey where the surface paints its own type, dim on the terminal.
    const faint = gui ? { color: HEADING } : { dimColor: true }
    const heading = (text: string) => <Text {...faint}>{text}</Text>
    const columns = (key: string) => (
      <Box key={key} flexDirection="row" gap={1}>
        {cell(W.glyph, <Text> </Text>)}
        <Box flexGrow={1} flexShrink={1} minWidth={0}>{heading('Agent')}</Box>
        {cell(W.model, heading('Model'))}
        {cell(W.effort, heading('Effort'))}
        {cell(W.tokens, heading('Tokens'), true)}
        {cell(W.time, heading('Time'), true)}
        {cell(W.cost, heading('Cost'), true)}
        {gearCell(<Text> </Text>)}
      </Box>
    )

    // The surface's own Buttons and Selects, each kept while it draws the same (see keeper), so a
    // click that lands while the pane redraws still counts. Presses and picks run in the hooks.
    const keep = keeper(`${e.surface}:${PANE}`)
    const button = (key: string, label: string, look: { plain?: boolean; prefix?: string; bold?: boolean; dim?: boolean } = {}): ControlItem =>
      ({ kind: 'button', key, label, ...look })
    const picker = (key: string, label: string, value: string, options: { value: string; label: string }[]): ControlItem =>
      ({ kind: 'select', key, label, value, options })
    const control = (c: ControlItem) => keep(c.key,
      c.kind === 'select'
        ? <Select key={c.key} label={c.label} options={c.options} value={c.value} onSelect={byHook} />
        : c.prefix !== undefined || c.bold
          ? <Button key={c.key} plain={c.plain} dimColor={c.dim} onPress={byHook}>{c.prefix ?? ''}<Text bold={c.bold}>{c.label}</Text></Button>
          : <Button key={c.key} plain={c.plain} dimColor={c.dim} label={c.label} onPress={byHook} />)
    const controlsRow = (items: ControlItem[], gap = 1) =>
      <Box flexDirection="row" gap={gap} flexWrap="wrap">{items.map(control)}</Box>
    // Where a block sits on a card: filled, or bordered on the terminal. Its corners are the
    // surface's plain radius (any border but a round one, drawn in no color), a step under the card's.
    const block = gui
      ? { backgroundColor: BLOCK_FILL, paddingX: 1, paddingY: 1, borderStyle: 'single', borderColor: CLEAR }
      : { borderStyle: 'round', borderDimColor: true, paddingX: 1 }
    // A fold's chevron.
    const chevron = (shut: boolean) => (shut ? '▸' : '▾')

    // The panel under a row or a card header: controls first, then the model and effort pickers
    // and Done. With no request left for pickers to apply to, its actions alone: the gear closes it.
    const editor = (id: string, current: Override, note: string, actions: ControlItem[] = [], pickers = true) => (
      <Box key={`ed-${id}`} flexDirection="column" marginY={1} {...block}>
        {pickers && actions.length > 0 && <Box marginBottom={1}>{controlsRow(actions)}</Box>}
        {pickers
          ? controlsRow([
            picker(`model-${id}`, 'Model', current.model ?? 'inherit', MODEL_OPTIONS),
            picker(`effort-${id}`, 'Effort', current.effort ?? 'inherit', EFFORT_OPTIONS),
            button(`done-${id}`, 'Done'),
          ], 2)
          : controlsRow(actions)}
        <Box marginTop={1}><Text color="inactive" italic>{note}</Text></Box>
      </Box>
    )

    const agentRow = (r: AgentRow) => {
      const paused = r.status === 'running' && ctl[r.id] === 'pause'
      const stopping = r.status === 'running' && ctl[r.id] === 'stop'
      const [glyph, color] = look(r, ctl[r.id])
      const isOpen = open === `agent:${r.id}`
      const hasOverride = !!(own[r.id]?.model || own[r.id]?.effort)
      const accent = r.isOverridden ? 'merged' : undefined
      // Running: the settings gear. Finished: Inspect's own ↗, its one action left, straight to its
      // activity (perform() tells them apart). Padded with no-break spaces, which no surface trims: a
      // wider target than the glyph alone, in a column wide enough for it (see gearCell).
      const icon = r.status !== 'running' ? '↗' : isOpen ? '▴' : hasOverride ? '◆' : '⚙'
      // A finished agent is drawn grey throughout, its icon aside, as Claude Code's own panel does.
      const over = r.status !== 'running'
      const gear = control(button(`gear-${r.id}`, ` ${icon} `, { plain: true, dim: over }))
      // The icon says paused or stopped; after the label, only that it's still on its way there.
      const state = paused ? (holding[r.id] ? '' : ' · pausing…') : stopping ? ' · stopping…' : ''
      const label = <Text wrap="truncate-end" dimColor={over}>{r.label}<Text color={color}>{state}</Text></Text>
      const time = timer(`time-${r.id}`, worked(r), working(r) ? 1 : 0, over)
      // The costliest effort stands out in red while it still spends.
      const effortHue = accent ?? (over ? undefined : effortColor(r.effort))
      // Pause and Stop while it runs (a panel left open when it finishes keeps only Inspect).
      const settings = isOpen && editor(
        r.id,
        own[r.id] ?? {},
        'Pause holds its next tool call; Stop ends it now. Model and effort apply from its next request.',
        [
          ...(r.status === 'running' ? [
            button(`pause-${r.id}`, paused ? '▶ Resume' : '⏸ Pause'),
            button(`stop-${r.id}`, stopping ? '⏹ Stopping…' : '⏹ Stop'),
          ] : []),
          button(`activity-${r.id}`, '↗ Inspect'),
        ],
      )

      if (inline) {
        return [
          <Box key={r.id} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              {glyphCell(<Text color={color}>{glyph}</Text>)}
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                {label}
              </Box>
              {gearCell(gear)}
            </Box>
            <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginLeft={W.glyph + 1}>
              <Text color={accent} dimColor={over}>{shortModel(r.model)}</Text>
              <Text color={effortHue} dimColor={over || !effortHue}>{effortLabel(r.effort)}</Text>
              <Text dimColor={over}>{tokens(totalTokens(r.usage))}<Text dimColor> tok</Text></Text>
              {time}
              <Text dimColor>{money(costOf(r.model, r.usage))}</Text>
            </Box>
          </Box>,
          settings,
        ].filter(Boolean)
      }

      return [
        <Box key={r.id} flexDirection="row" gap={1}>
          {glyphCell(<Text color={color}>{glyph}</Text>)}
          <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
            {label}
          </Box>
          {cell(W.model, <Text wrap="truncate-end" color={accent} dimColor={over}>{shortModel(r.model)}</Text>)}
          {cell(W.effort, <Text color={effortHue} dimColor={over}>{effortLabel(r.effort)}</Text>)}
          {cell(W.tokens, <Text dimColor={over}>{tokens(totalTokens(r.usage))}</Text>, true)}
          {cell(W.time, time, true)}
          {cell(W.cost, <Text dimColor>{money(costOf(r.model, r.usage))}</Text>, true)}
          {gearCell(gear)}
        </Box>,
        settings,
      ].filter(Boolean)
    }

    // A stopped agent's square, or one on its way there, is an outline: it ended without finishing.
    const hollow = (r: AgentRow) => r.status === 'stopped' || (r.status === 'running' && ctl[r.id] === 'stop')

    // Small rounded squares where the surface draws SVG (desktop); block glyphs elsewhere.
    const progress = (key: string, rows: AgentRow[]) => {
      if (e.surface === 'desktop') {
        // px of air above and below the squares, inside the drawing: finer than a row margin. Little
        // below, where the phase header's own padding follows.
        const size = 8, step = 11, padTop = 4, padBottom = 1
        const perRow = Math.max(1, Math.floor(((width - CARD_X - 2) * 6) / step))
        const lines = Math.ceil(rows.length / perRow)
        const rects = rows.map((r, i) => {
          const x = (i % perRow) * step, y = padTop + Math.floor(i / perRow) * step
          // An outline sits inside the square's bounds, half its stroke in from each edge.
          return hollow(r)
            ? `<rect x="${x + 0.75}" y="${y + 0.75}" width="${size - 1.5}" height="${size - 1.5}" rx="2" fill="none" stroke="${STOPPED}" stroke-width="1.5"/>`
            : `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="2" fill="${squareHex(r)}"${r.status === 'done' ? ' fill-opacity="0.6"' : ''}/>`
        }).join('')
        const w = Math.max(size, Math.min(rows.length, perRow) * step - (step - size))
        const barHeight = lines * step - (step - size) + padTop + padBottom
        const { Svg } = $.ui.resolve(e)
        return (
          <Box key={`bar-${key}`} marginY={0}>
            <Svg
              source={`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${barHeight}" viewBox="0 0 ${w} ${barHeight}">${rects}</svg>`}
              alt={`${rows.filter(r => r.status !== 'running').length} of ${rows.length} agents finished`}
              width={w}
              height={barHeight}
            />
          </Box>
        )
      }
      return <Text key={`bar-${key}`}>{rows.map(r => <Text color={look(r, ctl[r.id])[1]}>{hollow(r) ? '□' : '■'}</Text>)}</Text>
    }

    // A card's status chip (see groupState): a lead for where the group stands, then a mark for each
    // other kind of agent in it, at any width: ⏸ paused, ✗ failed, ⏹ stopped, and a dim ✓ done
    // while the group goes on or once it was stopped. Alone, the lead says it in a word
    // ("⏸ 2 paused", "✓ done"); beside marks it is an icon and a count like them ("⏸ 4 · ✗ 1"), a
    // zero too ("✓ 0 · ✗ 3": the run completed, none of its agents did). A count spells "⏸ 3" on
    // wide, "⏸3" narrower; "…" marks agents on their way to paused or stopped.
    const chip = (key: string, s: GroupState, t: Tally) => {
      const roomy = layout !== 'narrow'
      // No count: a lead that is the run's own state alone (○ between phases, ⚠ its script threw).
      const count = (glyph: string, n: number | undefined, tail = '') =>
        (n === undefined ? `${glyph}${tail}` : wide ? `${glyph} ${n}${tail}` : `${glyph}${n}${tail}`)
      // Each lead: its icon, color, agents (none for a state of the run alone), word, and whether its
      // word carries the count too (`said` where the word counts fewer: stopping folds in the ⏹
      // mark, the agents already stopped too).
      type Lead = { glyph: string; color: string; n?: number; said?: number; tail?: string; word: string; counted?: boolean }
      const { glyph, color, n, said = n, tail = '', word, counted = false }: Lead =
        s.kind === 'working' ? { glyph: '●', color: RUNNING, n: t.working, word: 'working', counted: true }
        : s.kind === 'paused' ? { glyph: '⏸', color: 'warning', n: t.paused, tail: t.pausing ? '…' : '', word: t.pausing ? 'pausing…' : 'paused', counted: true }
        : s.kind === 'stopping' ? { glyph: '⏹', color: STOPPED, n: t.stopping + t.stopped, said: t.stopping, tail: '…', word: 'stopping…', counted: true }
        : s.kind === 'idle' ? { glyph: '○', color: RUNNING, word: 'idle' }
        : s.kind === 'done' ? { glyph: '✓', color: 'success', n: t.done, word: 'done' }
        : s.kind === 'stopped' ? { glyph: '⏹', color: STOPPED, n: t.stopped, word: 'stopped' }
        // The run's own script threw: apart from ✗, which counts agents that failed.
        : s.kind === 'script-failed' ? { glyph: '⚠', color: 'error', word: 'script failed' }
        : { glyph: '✗', color: 'error', n: t.failed, word: 'failed', counted: true }
      const marks = [
        s.kind !== 'paused' && t.paused > 0 && <Text key="paused" color="warning">{count('⏸', t.paused, t.pausing ? '…' : '')}</Text>,
        s.kind !== 'failed' && t.failed > 0 && <Text key="failed" color="error">{count('✗', t.failed)}</Text>,
        s.kind !== 'stopped' && s.kind !== 'stopping' && t.stopped + t.stopping > 0
          && <Text key="stopped" color={STOPPED}>{count('⏹', t.stopped + t.stopping, t.stopping ? '…' : '')}</Text>,
        // Not beside ⚠, whose word would go for a mark that matters less than it.
        (isActive(s) || s.kind === 'stopped') && t.done > 0 && <Text key="done" color="success" dimColor>{count('✓', t.done)}</Text>,
      ].filter(Boolean)
      const lead = (
        <Text color={color} dimColor={s.kind === 'idle'}>
          {roomy && !marks.length ? `${glyph} ${counted ? `${said} ` : ''}${word}` : count(glyph, marks.length || counted ? n : undefined, tail)}
        </Text>
      )
      // Between phases, how long since its last agent ended, counting on the surface.
      const quietFor = s.kind === 'idle' && (Client
        ? <Client key={`idle-${key}`} module="./ticker.tsx" props={{ base: tick - s.since, rate: 1, dim: true }} />
        : <Text dimColor>{duration(tick - s.since)}</Text>)
      return (
        <Box key={`status-${key}`} flexDirection="row" gap={1} flexShrink={0}>
          {lead}
          {quietFor}
          {marks.flatMap((m, i) => (wide ? [<Text key={`dot-${i}`} dimColor>·</Text>, m] : [m]))}
        </Box>
      )
    }

    const cards = ordered.map(([key, rows]) => {
      const meta = metaOf(key, rows)
      const live = rows.filter(r => r.status === 'running').length
      const state = states.get(key)!
      const isWorkflow = key !== SUBAGENTS
      // A workflow: wall-clock from its first agent, standing still while none of its agents works
      // (see syncIdle). Plain subagents are unrelated, so the sum of their own working times.
      const anyWorking = rows.some(working)
      const w = idleBy[key] ?? { total: 0 }
      const end = anyWorking ? tick : w.since ?? Math.max(...rows.map(r => r.endedAt ?? r.pausedSince ?? tick))
      const span = isWorkflow ? end - Math.min(...rows.map(r => r.startedAt)) - w.total : rows.reduce((t, r) => t + worked(r), 0)
      const rate = isWorkflow ? (anyWorking ? 1 : 0) : rows.filter(working).length
      // Unfolded while it goes on or waits on the person; folded once it's over.
      const isFolded = folded[key] ?? (anyActive ? !active(key) : key !== ordered[0][0])
      foldedNow.set(key, isFolded)
      const groupOpen = open === `group:${key}`
      // A workflow that has ended (done, failed or stopped) starts no more agents, so a model or
      // effort is left nothing to apply to; one between phases may still, and plain subagents can
      // start any time.
      const tunable = !isWorkflow || isActive(state)
      const go = groups[key] ?? {}
      const hasGroupOverride = tunable && !!(go.model || go.effort)
      const running = rows.filter(r => r.status === 'running')
      const anyPaused = running.some(r => ctl[r.id] === 'pause')
      // Running: pause or stop them all. Finished: archive the card (restorable) or remove it.
      const groupActions = running.length > 0
        ? [button(`pause-all-${key}`, anyPaused ? '▶ Resume all' : '⏸ Pause all'), button(`stop-all-${key}`, '⏹ Stop all')]
        : [button(`archive-${key}`, '⊟ Archive'), button(`remove-${key}`, 'Remove')]
      const groupNote = running.length > 0
        ? isWorkflow
          ? 'Applies to every agent in this workflow from its next request, including agents not started yet. A per-agent setting wins.'
          : 'Applies to every subagent in this group from its next request. A per-agent setting wins.'
        : isWorkflow
          ? `Archive (or ✕ on the card) moves it under Archived, where it can be restored; Remove deletes it from the monitor.${tunable ? ' Model and effort apply to agents it starts later.' : ''}`
          : 'Archive (or ✕ on the card) moves them under Archived, where they can be restored; Remove deletes them from the monitor. Model and effort apply to subagents started later.'

      // Phases from the label prefix; agents without one go under "Agents". While the run goes on,
      // the phases its script names that started no agent yet are listed too, greyed and folded.
      const phases = new Map<string, AgentRow[]>()
      for (const r of [...rows].sort((a, b) => (a.index ?? a.startedAt) - (b.index ?? b.startedAt))) {
        const p = (isWorkflow && phaseOf(r.label, meta?.phases ?? [])) || 'Agents'
        phases.set(p, [...(phases.get(p) ?? []), r])
      }
      const planned = isWorkflow ? meta?.phases ?? [] : []
      const upcoming = isActive(state) ? planned.filter(p => !phases.has(p)) : []
      const phaseOrder = [...phases.keys(), ...upcoming].sort((a, b) => {
        const ia = planned.indexOf(a), ib = planned.indexOf(b)
        return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib)
      })
      const hasPhases = isWorkflow && (planned.length > 0 || phaseOrder.some(p => p !== 'Agents'))

      // A phase: its header (name, how many of its agents finished, the fold), its squares, and
      // below them its table. Unfolded once it has agents, until folded by hand; its name and its
      // count fold it too.
      const phaseBlock = (p: string) => {
        const prs = phases.get(p) ?? []
        const pk = `${key}::${p}`
        const started = prs.length > 0
        const shut = !started || (folded[pk] ?? false)
        if (started) foldedNow.set(pk, shut)
        const done = prs.filter(r => r.status !== 'running').length
        // Where the surface paints fills, a padded box with rounded corners (see block): filled
        // while unfolded; folded, the card's own until the pointer is on it.
        const head = gui
          ? {
            paddingX: 1, paddingY: 1, borderStyle: 'single', borderColor: CLEAR,
            ...(shut ? {} : { backgroundColor: BLOCK_FILL }),
            ...(started && shut ? { hover: { backgroundColor: BLOCK_FILL } } : {}),
          }
          : {}
        // On the desktop the whole header takes a click, through a see-through region laid over it
        // (press.tsx), so the name is plain text there, flush with the squares under it: a plain
        // button sits a little in from its box. The chevron stays a button, for the keyboard.
        const pressable = started && gui && Client
        return (
          <Box key={`phase-${key}-${p}`} flexDirection="column" marginTop={1}>
            <Box key={`head-${key}-${p}`} flexDirection="column" {...head}>
              <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
                <Box flexShrink={1} minWidth={0}>
                  {started && !pressable
                    ? control(button(`phase-${pk}`, p, { plain: true, bold: !gui }))
                    : <Text wrap="truncate-end" {...(started ? {} : faint)}>{p}</Text>}
                </Box>
                {/* The count and the chevron are plain buttons alike, drawn the same way, so they sit
                    level; the chevron centred in the row buttons' column, as the ↗ and ⚙ below it. */}
                <Box flexDirection="row" alignItems="center" flexShrink={0}>
                  {started && control(button(`count-${pk}`, `${done}/${prs.length}`, { plain: true, dim: true }))}
                  {gearCell(started
                    ? control(button(`fold-${pk}`, `\u00a0${chevron(shut)}\u00a0`, { plain: true, dim: true }))
                    : <Text {...faint}>{chevron(true)}</Text>)}
                </Box>
              </Box>
              {started && progress(`${key}-${p}`, prs)}
              {pressable && (
                <Box position="absolute" top={0} left={0} right={0} bottom={0}>
                  <Client key={`hit-${pk}`} module="./press.tsx" props={{ id: pk }} width="100%" height="100%" />
                </Box>
              )}
            </Box>
            {!shut && (
              <Box flexDirection="column" paddingX={gui ? 1 : 0} marginTop={gui ? 1 : 0}>
                {!inline && columns(`cols-${key}-${p}`)}
                {prs.flatMap(agentRow)}
              </Box>
            )}
          </Box>
        )
      }

      // Filled where the surface paints fills, as Claude Code's own panel draws a task, its corners
      // rounded a step more than its blocks' (a round border drawn in no color); on the terminal a
      // border, blue while it works and amber while paused.
      const frame = gui
        ? { backgroundColor: CARD_FILL, paddingY: 1, borderStyle: 'round', borderColor: CLEAR }
        : {
          borderStyle: 'round',
          borderColor: state.kind === 'working' ? RUNNING : state.kind === 'paused' ? 'warning' : undefined,
          borderDimColor: state.kind !== 'working' && state.kind !== 'paused',
        }

      return (
        <Box key={`card-${key}`} flexDirection="column" paddingX={1} marginBottom={1} {...frame}>
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Box flexShrink={1} minWidth={0}>
              {control(button(`fold-${key}`, isWorkflow ? meta?.name ?? key : 'Subagents', { plain: true, prefix: `${chevron(isFolded)} `, bold: true }))}
            </Box>
            <Box flexDirection="row" gap={1} flexShrink={0}>
              {chip(key, state, tallies.get(key)!)}
              {control(button(`gear-group-${key}`, groupOpen ? '▴' : hasGroupOverride ? '◆' : '⚙', { plain: true }))}
              {live === 0 && control(button(`close-${key}`, '✕', { plain: true }))}
            </Box>
          </Box>
          <Box flexDirection="row" gap={1}>
            <Text bold>{isWorkflow ? 'Workflow' : 'Agent tool'}</Text>
            {timer(`span-${key}`, span, rate, true)}
          </Box>
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            <Text><Text bold>{rows.length}</Text><Text dimColor> {rows.length === 1 ? 'agent' : 'agents'}</Text></Text>
            <Text><Text bold>{tokens(sumTokens(rows))}</Text><Text dimColor> tokens</Text></Text>
            <Text><Text bold>{money(sumCost(rows))}</Text><Text dimColor> est.</Text></Text>
          </Box>
          {!isFolded && meta?.description && <Text dimColor wrap="wrap">{meta.description}</Text>}
          {groupOpen && editor(`group-${key}`, go, groupNote, groupActions, tunable)}
          {!isFolded && hasPhases && <Box marginTop={1}><Text bold>Phases</Text></Box>}
          {!isFolded && phaseOrder.map(phaseBlock)}
        </Box>
      )
    })
    // Under "Running" the cards still going (working, paused, stopping or between phases), then
    // the rest under "Finished", as Claude Code's own panel heads them.
    const goingOn = ordered.filter(([key]) => active(key)).length
    const section = (title: string) => (
      <Box key={`section-${title}`} paddingX={1}><Text {...faint}>{title}</Text></Box>
    )

    // Archived cards, folded into one line until unfolded: each can come back or go for good.
    const archive = shelf.length > 0 && (
      <Box key="archived" flexDirection="column" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Box flexShrink={1} minWidth={0}>
            {control(button('archived-toggle', `Archived (${shelf.length})`, { plain: true, prefix: archOpen ? '▾ ' : '▸ ' }))}
          </Box>
          {archOpen && <Box flexShrink={0}>{control(button('purge-archived', 'Remove all', { plain: true }))}</Box>}
        </Box>
        {archOpen && shelf.map(([key, rows]) => (
          <Box key={`arch-${key}`} flexDirection="row" justifyContent="space-between" gap={1} marginTop={1}>
            <Box flexDirection="column" flexShrink={1} minWidth={0}>
              <Text wrap="truncate-end" dimColor>{key !== SUBAGENTS ? metaOf(key, rows)?.name ?? key : 'Subagents'}</Text>
              <Text wrap="truncate-end" color="inactive">
                {rows.length} {rows.length === 1 ? 'agent' : 'agents'} · {tokens(sumTokens(rows))} tokens · {money(sumCost(rows))}
              </Text>
            </Box>
            <Box flexShrink={0}>{controlsRow([button(`restore-${key}`, 'Restore'), button(`purge-${key}`, 'Remove')])}</Box>
          </Box>
        ))}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {goingOn > 0 && section('Running')}
        {cards.slice(0, goingOn)}
        {goingOn < cards.length && section('Finished')}
        {cards.slice(goingOn)}
        {ordered.length === 0 && (
          <Box paddingX={1} marginBottom={1}><Text dimColor>Nothing on the board: everything is archived.</Text></Box>
        )}
        {archive}
      </Box>
    )
  })

  // One agent's live activity: thinking, text and tool calls as they stream.
  on('ui.render', { component: 'Pane', requestId: INSPECT }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const id = await read($, inspecting)
    const list = await read($, agents)
    const r = list.find(a => a.id === id)
    if (!id || !r) {
      return <Box paddingX={1}><Text dimColor>Pick Inspect on an agent in the Workflows pane.</Text></Box>
    }
    // How it ended when the monitor didn't end it: a retry says Claude Code's stall check did;
    // without one it may have been that, the run stopped, or an interrupt. Said here, not on its row.
    const labelOf = (other: string) => list.find(a => a.id === other)?.label
    const quiet = r.quietMs !== undefined && r.quietMs >= 60_000 ? ` after ${duration(r.quietMs)} without progress` : ''
    const ending = r.retriedBy
      ? `Ended by Claude Code${quiet}; retried as “${labelOf(r.retriedBy) ?? 'a new attempt'}”.`
      : r.status === 'stopped' && r.quietMs !== undefined ? `Ended outside the monitor${quiet}.` : undefined
    const origin = r.retryOf && labelOf(r.retryOf)
    const retried = origin ? `Started by Claude Code after “${origin}” made no progress.` : undefined
    const ctl = (await read($, controls))[id]
    const entries = ((await read($, logs))[id] ?? []).slice(-80)
    const [glyph, color] = look(r, ctl)
    const status = r.status === 'running' ? (ctl === 'pause' ? 'paused' : ctl === 'stop' ? 'stopping' : 'running') : r.status
    // Kept as in the Workflows pane: the log redraws this pane at every few chunks it streams.
    const keep = keeper(`${e.surface}:${INSPECT}`)
    const control = (key: string, label: string) => keep(key, <Button key={key} label={label} onPress={byHook} />)
    // A line led by a small dot in a cell of its own, so the dots stand in one column, centred on
    // the line. Desktop draws the dot (a font's ● sits off its line and runs into the text).
    const dot = e.surface === 'desktop'
      ? (() => {
          const { Svg } = $.ui.resolve(e)
          return <Svg source={`<svg xmlns="http://www.w3.org/2000/svg" width="6" height="6" viewBox="0 0 6 6"><circle cx="3" cy="3" r="3" fill="${RUNNING}"/></svg>`} alt="activity" width={6} height={6} />
        })()
      : <Text color={RUNNING}>●</Text>
    const dotted = (key: string, line: unknown) => (
      <Box key={key} flexDirection="row" gap={1} alignItems="center">
        <Box width={1} flexShrink={0} justifyContent="center" alignItems="center">{dot}</Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>{line}</Box>
      </Box>
    )

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between" columnGap={2} flexWrap="wrap">
          <Box flexShrink={1} minWidth={0}><Text bold wrap="truncate-end">{r.label}</Text></Box>
          <Text><Text color={color}>{glyph} {status}</Text><Text dimColor> · {shortModel(r.model)} · {effortLabel(r.effort)} · {tokens(totalTokens(r.usage))} tok</Text></Text>
        </Box>
        {retried && <Box marginTop={1}><Text color="inactive" wrap="wrap">{retried}</Text></Box>}
        {ending && <Box marginTop={1}><Text color={STOPPED} wrap="wrap">{ending}</Text></Box>}
        {r.status === 'running' && (
          <Box flexDirection="row" gap={1} marginTop={1}>
            {control(`pause-${id}`, ctl === 'pause' ? '▶ Resume' : '⏸ Pause')}
            {control(`stop-${id}`, ctl === 'stop' ? '⏹ Stopping…' : '⏹ Stop')}
          </Box>
        )}
        <Box flexDirection="column" marginTop={1} gap={1}>
          {entries.length === 0 && <Text dimColor>Nothing yet: activity shows here from the agent's next model request.</Text>}
          {entries.map((x, i) =>
            x.kind === 'thinking' ? <Text key={`l-${i}`} color="inactive" italic wrap="wrap">{x.text.trim()}</Text>
            : x.kind === 'tool' ? dotted(`l-${i}`, <Text wrap="truncate-end"><Text bold>{x.tool}</Text><Text dimColor>  {x.text}</Text></Text>)
            : x.kind === 'note' ? <Text key={`l-${i}`} color={STOPPED}>{x.text}</Text>
            : <Text key={`l-${i}`} wrap="wrap">{x.text.trim()}</Text>,
          )}
          {r.status === 'running' && ctl !== 'pause' && dotted('working', <Text color={RUNNING}>working…</Text>)}
        </Box>
      </Box>
    )
  })
}
