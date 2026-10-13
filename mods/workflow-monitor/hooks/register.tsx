import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { AgentRow, AgentStatus, AgentUsage, Override, WorkflowMeta } from '../types'

const PANE = 'workflow-monitor'
const TITLE = 'Workflows'
const MAX_ROWS = 500
const SUBAGENTS = 'subagents'

const agents = atom({ plugin: 'workflow-monitor', key: 'agents' } as const, [] as AgentRow[])
const now = atom({ plugin: 'workflow-monitor', key: 'now' } as const, 0)
const workflows = atom({ plugin: 'workflow-monitor', key: 'workflows' } as const, {} as Record<string, WorkflowMeta>)
const agentOverrides = atom({ plugin: 'workflow-monitor', key: 'agentOverrides' } as const, {} as Record<string, Override>)
const groupOverrides = atom({ plugin: 'workflow-monitor', key: 'groupOverrides' } as const, {} as Record<string, Override>)
const editing = atom({ plugin: 'workflow-monitor', key: 'editing' } as const, null as string | null)
const collapsed = atom({ plugin: 'workflow-monitor', key: 'collapsed' } as const, {} as Record<string, boolean>)

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

const GLYPH: Record<AgentStatus, [string, string]> = {
  running: ['●', 'claude'],
  done: ['✓', 'success'],
  failed: ['✗', 'error'],
  stopped: ['■', 'warning'],
}

// The same status colors as raw hex, for SVG (theme keys don't reach inside it).
const HEX: Record<AgentStatus, string> = {
  running: '#D97757',
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'workflows',
      description: 'Show running workflows and subagents in a pane (/workflows clear empties it)',
    })
    // Tick once a second, only while something runs, so an idle pane stays still.
    $.clock.every(1000, () => {
      void (async () => {
        const list = await read($, agents)
        if (!list.some(a => a.status === 'running')) return
        const t = await $.clock.now()
        await update($, now, () => t)
      })()
    })

    return next(e)
  })

  on('command.run', { command: 'workflows' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await update($, agents, list => list.filter(a => a.status === 'running'))
      return { text: 'Cleared finished agents from the workflow monitor.' }
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
    await update($, agents, list => [...list.filter(a => a.id !== row.id), row].slice(-MAX_ROWS))
    await update($, now, () => row.startedAt)
    if (!before.some(a => a.status === 'running')) void $.ui.open({ id: PANE, title: TITLE })

    return started
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) return yield* next(e)

    const id = e.agentId
    const row = (await read($, agents)).find(a => a.id === id)
    const own = (await read($, agentOverrides))[id] ?? {}
    const group = row ? (await read($, groupOverrides))[groupKey(row)] ?? {} : {}
    const model = own.model ?? group.model
    const effort = own.effort ?? group.effort
    const sent = { ...e, ...(model ? { model } : {}), ...(effort ? { effort: effort as typeof e.effort } : {}) }

    await update($, agents, list =>
      list.map(a => (a.id === id
        ? { ...a, model: sent.model || a.model, effort: sent.effort === undefined ? a.effort : String(sent.effort), isOverridden: a.isOverridden || !!(model || effort) }
        : a)),
    )
    const result = yield* next(sent)
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
      const status: AgentStatus = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'stopped' : 'failed'
      await update($, agents, list =>
        list.map(a => {
          if (a.id !== id) return a
          // Steps already counted each request; fall back to the turn's total if none reported.
          const counted = totalTokens(a.usage) > 0
          return { ...a, status, endedAt, usage: !counted && e.usage ? addUsage(ZERO, e.usage) : a.usage }
        }),
      )
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Select } = $.ui.resolve(e)
    const list = await read($, agents)
    const metas = await read($, workflows)
    const own = await read($, agentOverrides)
    const groups = await read($, groupOverrides)
    const open = await read($, editing)
    const folded = await read($, collapsed)
    const tick = Math.max(await read($, now), ...list.map(a => a.endedAt ?? a.startedAt), 0)
    const width = e.props.bodyColumns ?? e.viewport?.columns ?? 100
    const wide = width >= 84

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

    const toggle = (key: string, isFolded: boolean) => () => update($, collapsed, all => ({ ...all, [key]: !isFolded }))
    const edit = (id: string) => () => update($, editing, cur => (cur === id ? null : id))

    const cell = (w: number, child: unknown, right = false) => (
      <Box width={w} flexShrink={0} justifyContent={right ? 'flex-end' : 'flex-start'}>{child}</Box>
    )

    const columns = (key: string) => (
      <Box key={key} flexDirection="row" gap={1}>
        {cell(W.glyph, <Text> </Text>)}
        <Box flexGrow={1} flexShrink={1}><Text dimColor>Agent</Text></Box>
        {cell(W.model, <Text dimColor>Model</Text>)}
        {wide && cell(W.effort, <Text dimColor>Effort</Text>)}
        {cell(W.tokens, <Text dimColor>Tokens</Text>, true)}
        {cell(W.time, <Text dimColor>Time</Text>, true)}
        {wide && cell(W.cost, <Text dimColor>Cost</Text>, true)}
        {cell(W.gear, <Text> </Text>)}
      </Box>
    )

    // The model and effort pickers, for one agent or a whole group.
    const editor = (id: string, current: Override, apply: (o: Override) => Promise<unknown>, note: string) => (
      <Box key={`ed-${id}`} flexDirection="column" marginTop={1} paddingX={1} borderStyle="round" borderDimColor>
        <Box flexDirection="row" gap={2} flexWrap="wrap">
          <Select
            key={`model-${id}`}
            label="Model"
            options={MODEL_OPTIONS}
            value={current.model ?? 'inherit'}
            onSelect={v => void apply({ ...current, model: v === 'inherit' ? undefined : v })}
          />
          <Select
            key={`effort-${id}`}
            label="Effort"
            options={EFFORT_OPTIONS}
            value={current.effort ?? 'inherit'}
            onSelect={v => void apply({ ...current, effort: v === 'inherit' ? undefined : v })}
          />
          <Button key={`done-${id}`} label="Done" onPress={() => void update($, editing, () => null)} />
        </Box>
        <Text color="inactive" italic>{note}</Text>
      </Box>
    )

    const agentRow = (r: AgentRow) => {
      const [glyph, color] = GLYPH[r.status]
      const isOpen = open === `agent:${r.id}`
      const hasOverride = !!(own[r.id]?.model || own[r.id]?.effort)
      return [
        <Box key={r.id} flexDirection="row" gap={1}>
          {cell(W.glyph, <Text color={color}>{glyph}</Text>)}
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="truncate-end" dimColor={r.status !== 'running'}>{r.label}</Text>
          </Box>
          {cell(W.model, <Text wrap="truncate-end" color={r.isOverridden ? 'suggestion' : undefined}>{shortModel(r.model)}</Text>)}
          {wide && cell(W.effort, <Text color={r.isOverridden ? 'suggestion' : r.effort === 'max' || r.effort === 'xhigh' ? 'warning' : undefined}>{effortLabel(r.effort)}</Text>)}
          {cell(W.tokens, <Text>{tokens(totalTokens(r.usage))}</Text>, true)}
          {cell(W.time, <Text>{duration((r.endedAt ?? tick) - r.startedAt)}</Text>, true)}
          {wide && cell(W.cost, <Text dimColor>{money(costOf(r.model, r.usage))}</Text>, true)}
          {cell(W.gear, r.status === 'running'
            ? <Button key={`gear-${r.id}`} plain label={isOpen ? '▴' : hasOverride ? '◆' : '⚙'} onPress={edit(`agent:${r.id}`)} />
            : <Text> </Text>)}
        </Box>,
        isOpen && editor(
          r.id,
          own[r.id] ?? {},
          o => update($, agentOverrides, all => ({ ...all, [r.id]: o })),
          'Applies to this agent from its next model request.',
        ),
      ].filter(Boolean)
    }

    // Rounded squares where the surface draws SVG (desktop); block glyphs elsewhere.
    const progress = (key: string, rows: AgentRow[]) => {
      if (e.surface === 'desktop') {
        // `pad` px of air above and below the squares, inside the drawing: finer than a row margin.
        const size = 10, step = 14, pad = 5
        const rects = rows.map((r, i) =>
          `<rect x="${i * step}" y="${pad}" width="${size}" height="${size}" rx="2.5" fill="${HEX[r.status]}"/>`).join('')
        const w = Math.max(size, rows.length * step - (step - size))
        const barHeight = size + pad * 2
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
      return <Text key={`bar-${key}`}>{rows.map(r => <Text color={GLYPH[r.status][1]}>■</Text>)}</Text>
    }

    const cards = ordered.map(([key, rows]) => {
      const meta = metas[rows[0]?.toolUseId ?? '']
      const live = rows.filter(r => r.status === 'running').length
      const failed = rows.filter(r => r.status === 'failed').length
      const span = Math.max(...rows.map(r => r.endedAt ?? tick)) - Math.min(...rows.map(r => r.startedAt))
      const isFolded = folded[key] ?? (anyLive ? live === 0 : key !== ordered[0][0])
      const isWorkflow = key !== SUBAGENTS
      const groupOpen = open === `group:${key}`
      const go = groups[key] ?? {}
      const hasGroupOverride = !!(go.model || go.effort)

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
        <Box key={`card-${key}`} flexDirection="column" borderStyle="round" borderColor={live > 0 ? 'claude' : undefined} borderDimColor={live === 0} paddingX={1} marginBottom={1}>
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Box flexShrink={1}>
              <Button key={`fold-${key}`} plain onPress={toggle(key, isFolded)}>
                {isFolded ? '▸ ' : '▾ '}<Text bold>{isWorkflow ? meta?.name ?? key : 'Subagents'}</Text>
              </Button>
            </Box>
            <Box flexDirection="row" gap={1} flexShrink={0}>
              {live > 0 ? <Text color="claude">● {live} running</Text> : failed > 0 ? <Text color="error">✗ {failed} failed</Text> : <Text color="success">✓ done</Text>}
              <Button key={`gear-group-${key}`} plain label={groupOpen ? '▴' : hasGroupOverride ? '◆' : '⚙'} onPress={edit(`group:${key}`)} />
            </Box>
          </Box>
          <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
            <Text><Text dimColor>{isWorkflow ? 'Workflow' : 'Agent tool'}</Text> {duration(span)}</Text>
            <Text>{rows.length}<Text dimColor> {rows.length === 1 ? 'agent' : 'agents'}</Text></Text>
            <Text>{tokens(sumTokens(rows))}<Text dimColor> tokens</Text></Text>
            <Text color="error">{money(sumCost(rows))}</Text>
          </Box>
          {!isFolded && meta?.description && <Text dimColor wrap="wrap">{meta.description}</Text>}
          {groupOpen && editor(
            `group-${key}`,
            go,
            o => update($, groupOverrides, all => ({ ...all, [key]: o })),
            isWorkflow
              ? 'Applies to every agent in this workflow from its next request, including agents not started yet. A per-agent setting wins.'
              : 'Applies to every subagent in this group from its next request. A per-agent setting wins.',
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
                {columns(`cols-${key}-${p}`)}
                {prs.flatMap(agentRow)}
              </Box>
            )
          })}
        </Box>
      )
    })

    return <Box flexDirection="column">{cards}</Box>
  })
}
