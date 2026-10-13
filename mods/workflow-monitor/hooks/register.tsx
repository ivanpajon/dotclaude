import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { AgentRow, AgentStatus, AgentUsage, Control, ControlItem, Idle, LogEntry, Override, WorkflowMeta } from '../types'

const PANE = 'workflow-monitor'
const INSPECT = 'workflow-monitor-agent'
const TITLE = 'Workflows'
const MAX_ROWS = 500
const SUBAGENTS = 'subagents'
const MAX_LOG = 200
const MAX_ENTRY = 4000
// The final answer a stopped agent gives in place of its next model request.
const STOP_TEXT = '(Stopped from the workflow monitor before it finished.)'

const agents = atom({ plugin: 'workflow-monitor', key: 'agents' } as const, [] as AgentRow[])
const workflows = atom({ plugin: 'workflow-monitor', key: 'workflows' } as const, {} as Record<string, WorkflowMeta>)
const agentOverrides = atom({ plugin: 'workflow-monitor', key: 'agentOverrides' } as const, {} as Record<string, Override>)
const groupOverrides = atom({ plugin: 'workflow-monitor', key: 'groupOverrides' } as const, {} as Record<string, Override>)
const editing = atom({ plugin: 'workflow-monitor', key: 'editing' } as const, null as string | null)
const collapsed = atom({ plugin: 'workflow-monitor', key: 'collapsed' } as const, {} as Record<string, boolean>)
const controls = atom({ plugin: 'workflow-monitor', key: 'controls' } as const, {} as Record<string, Control>)
const held = atom({ plugin: 'workflow-monitor', key: 'held' } as const, {} as Record<string, boolean>)
const logs = atom({ plugin: 'workflow-monitor', key: 'logs' } as const, {} as Record<string, LogEntry[]>)
const inspecting = atom({ plugin: 'workflow-monitor', key: 'inspecting' } as const, null as string | null)
const idle = atom({ plugin: 'workflow-monitor', key: 'idle' } as const, {} as Record<string, Idle>)

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

// Running is blue, apart from the amber of paused and stopped, as in Claude Code's own workflow view.
const RUNNING = '#4D9DF0'

const GLYPH: Record<AgentStatus, [string, string]> = {
  running: ['●', RUNNING],
  done: ['✓', 'success'],
  failed: ['✗', 'error'],
  stopped: ['■', 'warning'],
}

// The same status colors as raw hex, for SVG (theme keys don't reach inside it).
const HEX: Record<AgentStatus, string> = {
  running: RUNNING,
  done: '#4EBA65',
  failed: '#E5484D',
  stopped: '#E5A50A',
}

// Column widths, shared by the header row and every agent row so they line up.
const W = { glyph: 2, model: 11, effort: 8, tokens: 8, time: 8, cost: 8, gear: 3 }

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

// Releases a paused agent's held request: on resume, stop, or the turn's abort.
const waiters = new Map<string, () => void>()
const wake = (id: string) => {
  waiters.get(id)?.()
  waiters.delete(id)
}
// Pause and Stop asked of each agent, as this module knows them this instant; the cut for the
// reply a stopped agent is streaming now. The hold and the cut go by these, not by `controls`:
// every read of one dispatch sees one moment, so a request that read `controls` just before a
// Resume would go on seeing the pause and never let go. Seeded from `controls` on load.
const pauseRequested = new Set<string>()
const stopRequested = new Set<string>()
const stoppers = new Map<string, () => void>()

// Pause, resume (null) or stop agents, from either pane, and the workflow counters that follow.
async function setControl($: Parameters<typeof read>[0], ids: string[], v: Control | null) {
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

// An agent is working while it runs with no pause or stop asked of it; only then does its time count.
function isWorking(a: AgentRow, ctl: Record<string, Control>): boolean {
  return a.status === 'running' && !ctl[a.id]
}

// A workflow's counter stops while none of its agents is working (all paused, stopping or done
// beside them) and picks up from there when one works again. Written only when that changes.
// `list` and `ctl` are as the caller just wrote them.
async function syncIdle($: Parameters<typeof read>[0], list: AgentRow[], ctl: Record<string, Control>) {
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

// Which cards the person last saw folded, by group key, as the pane drew them.
const foldedNow = new Map<string, boolean>()

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
async function perform($: Parameters<typeof read>[0], key: string, value?: string) {
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

  if (key.startsWith('fold-')) await update($, collapsed, all => ({ ...all, [rest('fold-')]: !(foldedNow.get(rest('fold-')) ?? false) }))
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

// One second of the demo, written only when something changed, as real agents are: Pause and
// Stop land at once, and every other second one working agent finishes a model step.
async function demoTick($: Parameters<typeof read>[0], t: number) {
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

  await update($, agents, list => list.map(a => {
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

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'workflows',
      description: 'Show running workflows and subagents in a pane (/workflows demo: sample data; /workflows clear: tidy up)',
    })
    // A reload starts this module afresh: pick up the pauses and stops already asked for.
    for (const [id, v] of Object.entries(await read($, controls))) (v === 'pause' ? pauseRequested : stopRequested).add(id)
    // Elapsed times tick by themselves on the surface (./ticker.tsx): nothing here redraws the
    // pane on a clock, so it redraws only when something changes. The demo's agents run on this.
    $.clock.every(1000, () => {
      void (async () => {
        const list = await read($, agents)
        if (!list.some(a => a.id.startsWith(DEMO) && a.status === 'running')) return
        await demoTick($, await $.clock.now())
      })()
    })

    return next(e)
  })

  on('command.run', { command: 'workflows' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'clear') {
      await update($, agents, list => list.filter(a => a.status === 'running' && !a.id.startsWith(DEMO)))
      await update($, logs, all => Object.fromEntries(Object.entries(all).filter(([id]) => !id.startsWith(DEMO))))
      return { text: 'Cleared finished and demo agents from the workflow monitor.' }
    }
    if (arg === 'demo') {
      const t = await $.clock.now()
      const seed = demoSeed(t)
      await update($, workflows, all => ({
        ...all,
        toolu_demo: { name: 'checkout-redesign', description: 'Investigate the checkout flow, design the fixes, and review them (demo data).', phases: ['Investigate', 'Design', 'Review'] },
      }))
      await update($, agents, list => [...list.filter(a => !a.id.startsWith(DEMO)), ...seed.rows])
      await update($, logs, all => ({ ...all, ...seed.logs }))
      await update($, controls, all => ({ ...Object.fromEntries(Object.entries(all).filter(([id]) => !id.startsWith(DEMO))), [`${DEMO}6`]: 'pause' as const }))
      await update($, held, all => ({ ...all, [`${DEMO}6`]: true }))
      for (const s of [pauseRequested, stopRequested]) for (const id of s) if (id.startsWith(DEMO)) s.delete(id)
      pauseRequested.add(`${DEMO}6`)
      await update($, idle, ({ wf_demo: _, [SUBAGENTS]: __, ...rest }) => rest)
      await $.ui.open({ id: PANE, title: TITLE })
      return { text: 'Demo workflow loaded: its running agents tick every second. Try ⚙ on a running row. /workflows clear removes it.' }
    }
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Workflow monitor opened.' }
  })

  // Remember a workflow's name and phases, keyed by the call its agents will carry.
  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
    const input = e.input as { script?: string; name?: string; scriptPath?: string }
    const meta = (input.script && parseMeta(input.script))
      || (input.name || input.scriptPath ? { name: input.name ?? input.scriptPath!.split(/[\\/]/).pop()!.replace(/\.[a-z]+$/, ''), phases: [] } : undefined)
    if (meta) await update($, workflows, all => ({ ...all, [e.tool_use_id]: meta }))

    return next(e)
  })

  // A stopped agent runs no more tools: the calls it already asked for are refused.
  on('tool.call', async ($, e, next) => {
    if (e.agentId && stopRequested.has(e.agentId)) {
      return { deny: 'Stopped from the workflow monitor. Do not retry; finish now.' }
    }

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
    const before = await read($, agents)
    const list = await update($, agents, all => [...all.filter(a => a.id !== row.id), row].slice(-MAX_ROWS))
    await syncIdle($, list, await read($, controls))
    if (!before.some(a => a.status === 'running')) void $.ui.open({ id: PANE, title: TITLE })

    return started
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) return yield* next(e)

    const id = e.agentId

    // Pause: hold this request until resumed, stopped, or the turn is aborted. A stop wins.
    if (pauseRequested.has(id) && !stopRequested.has(id)) {
      await update($, held, all => ({ ...all, [id]: true }))
      while (pauseRequested.has(id) && !next.signal.aborted) {
        await new Promise<void>(resolve => {
          waiters.set(id, resolve)
          next.signal.addEventListener('abort', () => resolve(), { once: true })
          // A resume that landed while the hold began still lets it go.
          if (!pauseRequested.has(id)) resolve()
        })
      }
      await update($, held, ({ [id]: _, ...rest }) => rest)
    }

    // Stop: answer in the model's place with a final reply, so the agent's loop ends cleanly.
    if (stopRequested.has(id)) {
      await update($, logs, all => ({ ...all, [id]: [...(all[id] ?? []), { kind: 'note' as const, text: 'Stopped from the workflow monitor.' }].slice(-MAX_LOG) }))
      yield { kind: 'text', index: 0, text: STOP_TEXT }
      return { turnId: e.turnId, index: e.index, answer: STOP_TEXT, toolUses: [], stopReason: 'end_turn', usage: null }
    }

    const row = (await read($, agents)).find(a => a.id === id)
    const own = (await read($, agentOverrides))[id] ?? {}
    const group = row ? (await read($, groupOverrides))[groupKey(row)] ?? {} : {}
    const model = own.model ?? group.model
    const effort = own.effort ?? group.effort
    const sent = { ...e, ...(model ? { model } : {}), ...(effort ? { effort: effort as typeof e.effort } : {}) }

    // Written only when it changes: every write redraws the pane.
    const shown = (a: AgentRow): AgentRow =>
      ({ ...a, model: sent.model || a.model, effort: sent.effort === undefined ? a.effort : String(sent.effort), isOverridden: a.isOverridden || !!(model || effort) })
    if (row && JSON.stringify(shown(row)) !== JSON.stringify(row)) {
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
      if (c.kind === 'tool' || ++chunks % 12 === 0) await flush()
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
    await update($, agents, list =>
      list.map(a => (a.id === id ? { ...a, steps: a.steps + 1, usage: usage ? addUsage(a.usage, usage) : a.usage } : a)),
    )

    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      const id = e.agentId
      const endedAt = await $.clock.now()
      const wasStopped = stopRequested.has(id)
      const status: AgentStatus = wasStopped || e.reason === 'aborted' ? 'stopped' : e.reason === 'answer' ? 'done' : 'failed'
      pauseRequested.delete(id)
      stopRequested.delete(id)
      stoppers.delete(id)
      wake(id)
      const ctl = await update($, controls, ({ [id]: _, ...rest }) => rest)
      const list = await update($, agents, all =>
        all.map(a => {
          if (a.id !== id) return a
          // Steps already counted each request; fall back to the turn's total if none reported.
          const counted = totalTokens(a.usage) > 0
          return { ...a, status, endedAt, usage: !counted && e.usage ? addUsage(ZERO, e.usage) : a.usage }
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
    const tick = Math.max(await $.clock.now(), ...list.map(a => a.endedAt ?? a.startedAt), 0)
    const width = e.props.bodyColumns ?? e.viewport?.columns ?? 100
    // Wide: every column. Medium: no effort/cost columns. Narrow: each agent on two lines.
    const layout = width >= 84 ? 'wide' : width >= 58 ? 'medium' : 'narrow'
    const wide = layout === 'wide'

    if (list.length === 0) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text bold>Workflow monitor</Text>
          <Text dimColor>No subagents yet. Workflows and Agent-tool subagents show up here as they start.</Text>
        </Box>
      )
    }

    // Group by workflow run; plain subagents share one group. Running groups first, then newest.
    const byGroup = new Map<string, AgentRow[]>()
    for (const a of list) byGroup.set(groupKey(a), [...(byGroup.get(groupKey(a)) ?? []), a])
    const ordered = [...byGroup.entries()].sort(([, a], [, b]) => {
      const live = (rows: AgentRow[]) => (rows.some(r => r.status === 'running') ? 1 : 0)
      return live(b) - live(a) || Math.max(...b.map(r => r.startedAt)) - Math.max(...a.map(r => r.startedAt))
    })
    const anyLive = list.some(a => a.status === 'running')

    const idleBy = await read($, idle)
    // Time an agent spent working: frozen from a pause or stop, with earlier pauses left out.
    const worked = (r: AgentRow) => (r.pausedSince ?? r.endedAt ?? tick) - r.startedAt - (r.pausedTotal ?? 0)
    const working = (r: AgentRow) => isWorking(r, ctl)

    // The row's status icon. On desktop a stop square is drawn rounded, like the progress squares; a font's ■ can't be.
    const icon = (glyph: string, color: string) => {
      if (glyph !== '■' || e.surface !== 'desktop') return <Text color={color}>{glyph}</Text>
      const { Svg } = $.ui.resolve(e)
      return <Svg source={`<svg xmlns="http://www.w3.org/2000/svg" width="7" height="7" viewBox="0 0 7 7"><rect width="7" height="7" rx="2" fill="${HEX.stopped}"/></svg>`} alt="stopped" width={7} height={7} />
    }
    // A square's color: amber while paused, like the row's icon.
    const squareHex = (r: AgentRow) => (r.status === 'running' && ctl[r.id] ? HEX.stopped : HEX[r.status])

    // An elapsed time: it counts up by itself where the surface runs `Client` regions, so no redraw is needed.
    const timer = (key: string, ms: number, rate: number) =>
      Client
        ? <Client key={key} module="./ticker.tsx" props={{ base: ms, rate }} />
        : <Text>{duration(ms)}</Text>

    const cell = (w: number, child: unknown, right = false) => (
      <Box width={w} flexShrink={0} justifyContent={right ? 'flex-end' : 'flex-start'}>{child}</Box>
    )
    // Status icons differ in width (✓ ✗ ⏸ ● and the drawn square): centred, they line up in one column.
    const glyphCell = (child: unknown) => (
      <Box width={W.glyph} flexShrink={0} justifyContent="center" alignItems="center">{child}</Box>
    )

    const columns = (key: string) => (
      <Box key={key} flexDirection="row" gap={1}>
        {cell(W.glyph, <Text> </Text>)}
        <Box flexGrow={1} flexShrink={1} minWidth={0}><Text dimColor>Agent</Text></Box>
        {cell(W.model, <Text dimColor>Model</Text>)}
        {wide && cell(W.effort, <Text dimColor>Effort</Text>)}
        {cell(W.tokens, <Text dimColor>Tokens</Text>, true)}
        {cell(W.time, <Text dimColor>Time</Text>, true)}
        {wide && cell(W.cost, <Text dimColor>Cost</Text>, true)}
        {cell(W.gear, <Text> </Text>)}
      </Box>
    )

    // The surface's own Buttons and Selects, each kept while it draws the same (see keeper), so a
    // click that lands while the pane redraws still counts. Presses and picks run in the hooks.
    const keep = keeper(`${e.surface}:${PANE}`)
    const button = (key: string, label: string, look: { plain?: boolean; prefix?: string; bold?: boolean } = {}): ControlItem =>
      ({ kind: 'button', key, label, ...look })
    const picker = (key: string, label: string, value: string, options: { value: string; label: string }[]): ControlItem =>
      ({ kind: 'select', key, label, value, options })
    const control = (c: ControlItem) => keep(c.key,
      c.kind === 'select'
        ? <Select key={c.key} label={c.label} options={c.options} value={c.value} onSelect={byHook} />
        : c.prefix !== undefined || c.bold
          ? <Button key={c.key} plain={c.plain} onPress={byHook}>{c.prefix ?? ''}<Text bold={c.bold}>{c.label}</Text></Button>
          : <Button key={c.key} plain={c.plain} label={c.label} onPress={byHook} />)
    const controlsRow = (items: ControlItem[], gap = 1) =>
      <Box flexDirection="row" gap={gap} flexWrap="wrap">{items.map(control)}</Box>

    // The panel under a row or a card header: controls first, then the model and effort pickers.
    const editor = (id: string, current: Override, note: string, actions: ControlItem[] = []) => (
      <Box key={`ed-${id}`} flexDirection="column" marginTop={1} paddingX={1} borderStyle="round" borderDimColor>
        {actions.length > 0 && <Box marginBottom={1}>{controlsRow(actions)}</Box>}
        {controlsRow([
          picker(`model-${id}`, 'Model', current.model ?? 'inherit', MODEL_OPTIONS),
          picker(`effort-${id}`, 'Effort', current.effort ?? 'inherit', EFFORT_OPTIONS),
          button(`done-${id}`, 'Done'),
        ], 2)}
        <Text color="inactive" italic>{note}</Text>
      </Box>
    )

    const agentRow = (r: AgentRow) => {
      const paused = r.status === 'running' && ctl[r.id] === 'pause'
      const stopping = r.status === 'running' && ctl[r.id] === 'stop'
      const [glyph, color] = paused ? ['⏸', 'warning'] : stopping ? ['■', 'warning'] : GLYPH[r.status]
      const isOpen = open === `agent:${r.id}`
      const hasOverride = !!(own[r.id]?.model || own[r.id]?.effort)
      const accent = r.isOverridden ? 'merged' : undefined
      // Running: the settings gear. Finished: straight to its activity (perform() tells them apart).
      const gear = control(button(`gear-${r.id}`, r.status !== 'running' ? '›' : isOpen ? '▴' : hasOverride ? '◆' : '⚙', { plain: true }))
      // Why a running agent isn't moving, after its label.
      const state = paused ? (holding[r.id] ? ' · paused' : ' · pausing…') : stopping ? ' · stopping…' : ''
      const label = <Text wrap="truncate-end" dimColor={r.status !== 'running'}>{r.label}<Text color="warning">{state}</Text></Text>
      const time = timer(`time-${r.id}`, worked(r), working(r) ? 1 : 0)
      // Pause and Stop while it runs (a panel left open when it finishes keeps only Inspect).
      const settings = isOpen && editor(
        r.id,
        own[r.id] ?? {},
        'Pause holds its next model request; Stop ends it now. Model and effort apply from its next request.',
        [
          ...(r.status === 'running' ? [
            button(`pause-${r.id}`, paused ? '▶ Resume' : '⏸ Pause'),
            button(`stop-${r.id}`, stopping ? '■ Stopping…' : '■ Stop'),
          ] : []),
          button(`activity-${r.id}`, '◉ Inspect'),
        ],
      )

      if (layout === 'narrow') {
        return [
          <Box key={r.id} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              {glyphCell(icon(glyph, color))}
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                {label}
              </Box>
              {cell(W.gear, gear)}
            </Box>
            <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginLeft={W.glyph + 1}>
              <Text color={accent}>{shortModel(r.model)}</Text>
              <Text color={accent} dimColor={!accent}>{effortLabel(r.effort)}</Text>
              <Text>{tokens(totalTokens(r.usage))}<Text dimColor> tok</Text></Text>
              {time}
              <Text dimColor>{money(costOf(r.model, r.usage))}</Text>
            </Box>
          </Box>,
          settings,
        ].filter(Boolean)
      }

      return [
        <Box key={r.id} flexDirection="row" gap={1}>
          {glyphCell(icon(glyph, color))}
          <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
            {label}
          </Box>
          {cell(W.model, <Text wrap="truncate-end" color={r.isOverridden ? 'merged' : undefined}>{shortModel(r.model)}</Text>)}
          {wide && cell(W.effort, <Text color={r.isOverridden ? 'merged' : r.effort === 'max' || r.effort === 'xhigh' ? 'warning' : undefined}>{effortLabel(r.effort)}</Text>)}
          {cell(W.tokens, <Text>{tokens(totalTokens(r.usage))}</Text>, true)}
          {cell(W.time, time, true)}
          {wide && cell(W.cost, <Text dimColor>{money(costOf(r.model, r.usage))}</Text>, true)}
          {cell(W.gear, gear)}
        </Box>,
        settings,
      ].filter(Boolean)
    }

    // Rounded squares where the surface draws SVG (desktop); block glyphs elsewhere.
    const progress = (key: string, rows: AgentRow[]) => {
      if (e.surface === 'desktop') {
        // `pad` px of air above and below the squares, inside the drawing: finer than a row margin.
        const size = 10, step = 14, pad = 5
        const perRow = Math.max(1, Math.floor(((width - 4) * 6) / step))
        const lines = Math.ceil(rows.length / perRow)
        const rects = rows.map((r, i) =>
          `<rect x="${(i % perRow) * step}" y="${pad + Math.floor(i / perRow) * step}" width="${size}" height="${size}" rx="3" fill="${squareHex(r)}"/>`).join('')
        const w = Math.max(size, Math.min(rows.length, perRow) * step - (step - size))
        const barHeight = lines * step - (step - size) + pad * 2
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
      return <Text key={`bar-${key}`}>{rows.map(r => <Text color={r.status === 'running' && ctl[r.id] ? 'warning' : GLYPH[r.status][1]}>■</Text>)}</Text>
    }

    const cards = ordered.map(([key, rows]) => {
      const meta = metas[rows[0]?.toolUseId ?? '']
      const live = rows.filter(r => r.status === 'running').length
      const failed = rows.filter(r => r.status === 'failed').length
      const isWorkflow = key !== SUBAGENTS
      // A workflow: wall-clock from its first agent, standing still while none of its agents works
      // (see syncIdle). Plain subagents are unrelated, so the sum of their own working times.
      const anyWorking = rows.some(working)
      const w = idleBy[key] ?? { total: 0 }
      const end = anyWorking ? tick : w.since ?? Math.max(...rows.map(r => r.endedAt ?? r.pausedSince ?? tick))
      const span = isWorkflow ? end - Math.min(...rows.map(r => r.startedAt)) - w.total : rows.reduce((t, r) => t + worked(r), 0)
      const rate = isWorkflow ? (anyWorking ? 1 : 0) : rows.filter(working).length
      const isFolded = folded[key] ?? (anyLive ? live === 0 : key !== ordered[0][0])
      foldedNow.set(key, isFolded)
      const groupOpen = open === `group:${key}`
      const go = groups[key] ?? {}
      const hasGroupOverride = !!(go.model || go.effort)
      const running = rows.filter(r => r.status === 'running')
      const anyPaused = running.some(r => ctl[r.id] === 'pause')
      const groupActions = running.length === 0 ? [] : [
        button(`pause-all-${key}`, anyPaused ? '▶ Resume all' : '⏸ Pause all'),
        button(`stop-all-${key}`, '■ Stop all'),
      ]

      // Phases from the label prefix; agents without one go under "Agents".
      const phases = new Map<string, AgentRow[]>()
      for (const r of [...rows].sort((a, b) => (a.index ?? a.startedAt) - (b.index ?? b.startedAt))) {
        const p = (isWorkflow && phaseOf(r.label, meta?.phases ?? [])) || 'Agents'
        phases.set(p, [...(phases.get(p) ?? []), r])
      }
      const phaseOrder = [...phases.keys()].sort((a, b) => {
        const order = meta?.phases ?? []
        const ia = order.indexOf(a), ib = order.indexOf(b)
        return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib)
      })

      return (
        <Box key={`card-${key}`} flexDirection="column" borderStyle="round" borderColor={live > 0 ? RUNNING : undefined} borderDimColor={live === 0} paddingX={1} marginBottom={1}>
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Box flexShrink={1} minWidth={0}>
              {control(button(`fold-${key}`, isWorkflow ? meta?.name ?? key : 'Subagents', { plain: true, prefix: isFolded ? '▸ ' : '▾ ', bold: true }))}
            </Box>
            <Box flexDirection="row" gap={1} flexShrink={0}>
              {live > 0 ? <Text color={RUNNING}>● {live}{layout === 'narrow' ? '' : ' running'}</Text> : failed > 0 ? <Text color="error">✗ {failed}{layout === 'narrow' ? '' : ' failed'}</Text> : <Text color="success">✓{layout === 'narrow' ? '' : ' done'}</Text>}
              {control(button(`gear-group-${key}`, groupOpen ? '▴' : hasGroupOverride ? '◆' : '⚙', { plain: true }))}
            </Box>
          </Box>
          <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
            <Box flexDirection="row" gap={1}>
              <Text dimColor>{isWorkflow ? 'Workflow' : 'Agent tool'}</Text>
              {timer(`span-${key}`, span, rate)}
            </Box>
            <Text>{rows.length}<Text dimColor> {rows.length === 1 ? 'agent' : 'agents'}</Text></Text>
            <Text>{tokens(sumTokens(rows))}<Text dimColor> tokens</Text></Text>
            <Text color="error">{money(sumCost(rows))}</Text>
          </Box>
          {!isFolded && meta?.description && <Text dimColor wrap="wrap">{meta.description}</Text>}
          {groupOpen && editor(
            `group-${key}`,
            go,
            isWorkflow
              ? 'Applies to every agent in this workflow from its next request, including agents not started yet. A per-agent setting wins.'
              : 'Applies to every subagent in this group from its next request. A per-agent setting wins.',
            groupActions,
          )}
          {!isFolded && phaseOrder.map(p => {
            const prs = phases.get(p)!
            const done = prs.filter(r => r.status !== 'running').length
            return (
              <Box key={`phase-${key}-${p}`} flexDirection="column" marginTop={1}>
                <Box flexDirection="row" justifyContent="space-between">
                  <Text bold>{p}</Text>
                  <Text dimColor>{done}/{prs.length}</Text>
                </Box>
                {progress(`${key}-${p}`, prs)}
                {layout !== 'narrow' && columns(`cols-${key}-${p}`)}
                {prs.flatMap(agentRow)}
              </Box>
            )
          })}
        </Box>
      )
    })

    return <Box flexDirection="column">{cards}</Box>
  })

  // One agent's live activity: thinking, text and tool calls as they stream.
  on('ui.render', { component: 'Pane', requestId: INSPECT }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const id = await read($, inspecting)
    const r = (await read($, agents)).find(a => a.id === id)
    if (!id || !r) {
      return <Box paddingX={1}><Text dimColor>Pick Inspect on an agent in the Workflows pane.</Text></Box>
    }
    const ctl = (await read($, controls))[id]
    const entries = ((await read($, logs))[id] ?? []).slice(-80)
    const [glyph, color] = r.status === 'running' && ctl === 'pause' ? ['⏸', 'warning'] : GLYPH[r.status]
    const status = r.status === 'running' ? (ctl === 'pause' ? 'paused' : ctl === 'stop' ? 'stopping' : 'running') : r.status
    // Kept as in the Workflows pane: the log redraws this pane at every few chunks it streams.
    const keep = keeper(`${e.surface}:${INSPECT}`)
    const control = (key: string, label: string) => keep(key, <Button key={key} label={label} onPress={byHook} />)

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between" columnGap={2} flexWrap="wrap">
          <Box flexShrink={1} minWidth={0}><Text bold wrap="truncate-end">{r.label}</Text></Box>
          <Text><Text color={color}>{glyph} {status}</Text><Text dimColor> · {shortModel(r.model)} · {effortLabel(r.effort)} · {tokens(totalTokens(r.usage))} tok</Text></Text>
        </Box>
        {r.status === 'running' && (
          <Box flexDirection="row" gap={1} marginTop={1}>
            {control(`pause-${id}`, ctl === 'pause' ? '▶ Resume' : '⏸ Pause')}
            {control(`stop-${id}`, ctl === 'stop' ? '■ Stopping…' : '■ Stop')}
          </Box>
        )}
        <Box flexDirection="column" marginTop={1} gap={1}>
          {entries.length === 0 && <Text dimColor>Nothing yet: activity shows here from the agent's next model request.</Text>}
          {entries.map((x, i) =>
            x.kind === 'thinking' ? <Text key={`l-${i}`} color="inactive" italic wrap="wrap">{x.text.trim()}</Text>
            : x.kind === 'tool' ? <Text key={`l-${i}`} wrap="truncate-end"><Text color={RUNNING}>⏺ </Text><Text bold>{x.tool}</Text><Text dimColor>  {x.text}</Text></Text>
            : x.kind === 'note' ? <Text key={`l-${i}`} color="warning">{x.text}</Text>
            : <Text key={`l-${i}`} wrap="wrap">{x.text.trim()}</Text>,
          )}
          {r.status === 'running' && ctl !== 'pause' && <Text color={RUNNING}>● working…</Text>}
        </Box>
      </Box>
    )
  })
}
