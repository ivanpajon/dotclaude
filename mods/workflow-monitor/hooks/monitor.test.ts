import { expect, mock, test } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const
const USAGE = { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 10000, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' }
const SCRIPT = `export const meta = {
  name: 'store-switch-design',
  description: 'Investigate and design fixes',
  phases: [{ title: 'Investigate' }, { title: 'Critique' }],
}
phase('Investigate')`
// A background task's end, as its notification reaches the session.
const ended = (toolUseId: string, status: string) =>
  `<task-notification>\n<task-id>bg_${toolUseId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n<summary>Workflow ${status}</summary>\n</task-notification>`

test('tracks a workflow agent, applies overrides, and pauses, stops and inspects it', async ($, on) => {
  let n = 0
  let clock = 1_000_000
  const sent: { model: string; effort?: unknown }[] = []
  on('clock.now', () => ({ value: (clock += 500) }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `agent-${++n}` }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const ran: string[] = []
  let releaseSlow = () => {}
  on('tool.call', (_$, e) => (ran.push(e.tool), { result: 'launched' }))
  on('turn.step', async function* (_$, e) {
    sent.push({ model: e.model, effort: e.effort })
    if (e.agentId === 'agent-3') {
      yield { kind: 'text', index: 0, text: 'Thinking slowly' }
      await new Promise<void>(resolve => { releaseSlow = resolve })
    }
    yield { kind: 'thinking', index: 0, text: 'Checking the detail pages' }
    yield { kind: 'text', index: 1, text: 'Reading the ' }
    yield { kind: 'text', index: 1, text: 'store page.' }
    yield { kind: 'tool', index: 2, id: 'toolu_r', name: 'Read' }
    yield { kind: 'input', index: 2, json: '{"file_path":"src/' }
    yield { kind: 'input', index: 2, json: 'store.ts"}' }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: USAGE }
  })
  on('turn.complete', () => ({ text: 'ok' }))

  await $.tool.call({ tool: 'Workflow', tool_use_id: 'toolu_wf', input: { script: SCRIPT } })
  const spawn = (index: number, description: string) => $.agent.spawn({
    tool_use_id: 'toolu_wf', prompt: 'p', description, subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false,
    workflow: { runId: 'wf_test1', agentIndex: index },
  })
  await spawn(1, 'investigate:detail-pages')
  await spawn(2, 'critique:detail-pages')

  const step = async (agentId: string, index: number) => {
    const stream = $.turn.step({ turnId: `t-${agentId}`, index, model: 'claude-opus-5-5', effort: 'high', messageCount: 1, agentId })
    let answer = ''
    // A stop chunk ends the reply; a cut request may still be winding down beneath it.
    const it = stream[Symbol.asyncIterator]()
    for (let r = await it.next(); !r.done; r = await it.next()) {
      if (r.value.kind === 'text') answer += r.value.text
      if (r.value.kind === 'stop') return { answer }
    }
    await stream.result
    return { answer }
  }
  await step('agent-1', 0)
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't-agent-1', agentId: 'agent-1', reason: 'answer' })

  const viewport = { columns: 110, rows: 40 }
  const props = { title: 'Workflows', isFocused: false, bodyColumns: 110 }
  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ plugin: 'workflow-monitor', surface, component: 'Pane', requestId: 'workflow-monitor', props, viewport })
    expect(await pane.find({ text: 'store-switch-design' })).toBeTruthy()
    expect(await pane.find({ text: 'Investigate' })).toBeTruthy()
    expect(await pane.find({ text: 'Critique' })).toBeTruthy()
    expect(await pane.find({ text: /investigate:detail-pages/ })).toBeTruthy()
    expect(await pane.find({ text: 'Opus 5.5' })).toBeTruthy()
    // 1000 in × $4 + 2000 out × $20 + 10000 cache read × $0.20, per million = $0.046
    expect(await pane.find({ text: '$0.046' })).toBeTruthy()
    await pane.unmount()
  }

  // A narrow pane stacks each agent on two lines and still shows its model, time and cost.
  for (const surface of SURFACES) {
    const narrow = { ...props, bodyColumns: 44 }
    const pane = await $.ui.mount({ plugin: 'workflow-monitor', surface, component: 'Pane', requestId: 'workflow-monitor', props: narrow, viewport: { columns: 44, rows: 40 } })
    expect(await pane.find({ text: /investigate:detail-pages/ })).toBeTruthy()
    expect(await pane.find({ text: 'Opus 5.5' })).toBeTruthy()
    expect(await pane.find({ text: '$0.046' })).toBeTruthy()
    await pane.unmount()
  }

  // The gear opens agent 2's panel; Haiku 5.5 at low effort applies to its next request.
  const pane = await $.ui.mount({ plugin: 'workflow-monitor', surface: 'terminal', component: 'Pane', requestId: 'workflow-monitor', props, viewport })
  await pane.press({ key: 'gear-agent-2' })
  await $.ui.select({ plugin: 'workflow-monitor', key: 'model-agent-2', value: 'claude-haiku-5-5' })
  await $.ui.select({ plugin: 'workflow-monitor', key: 'effort-agent-2', value: 'low' })
  await step('agent-2', 0)
  expect(sent.at(-1)).toEqual({ model: 'claude-haiku-5-5', effort: 'low' })
  expect(sent[0]).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
  expect(await pane.find({ text: 'Haiku 5.5' })).toBeTruthy()

  // Inspect shows the agent's streamed thinking, text and tool calls.
  await pane.press({ key: 'activity-agent-2' })
  for (const surface of SURFACES) {
    const inspect = await $.ui.mount({ plugin: 'workflow-monitor', surface, component: 'Pane', requestId: 'workflow-monitor-agent', props, viewport })
    expect(await inspect.find({ text: 'Checking the detail pages' })).toBeTruthy()
    expect(await inspect.find({ text: 'Reading the store page.' })).toBeTruthy()
    expect(await inspect.find({ text: /src\/store\.ts/ })).toBeTruthy()
    // A tool call's dot: drawn on the desktop, a glyph elsewhere.
    if (surface === 'desktop') expect(JSON.stringify(await inspect.drawn())).toContain('"alt":"activity"')
    await inspect.unmount()
  }

  // Pause holds the next request until Resume.
  await pane.press({ key: 'pause-agent-2' })
  const before = sent.length
  let finished = false
  const held = step('agent-2', 1).then(() => { finished = true })
  for (let i = 0; i < 5; i++) await Promise.resolve()
  expect(finished).toBe(false)
  expect(sent.length).toBe(before)
  await pane.press({ key: 'pause-agent-2' })
  await held
  expect(sent.length).toBe(before + 1)

  // Stop refuses its tool calls and answers its next request with a final reply.
  await pane.press({ key: 'stop-agent-2' })
  const denied = await $.tool.call({ tool: 'Read', tool_use_id: 'toolu_x', input: { file_path: 'a' }, agentId: 'agent-2' })
  expect('deny' in denied).toBe(true)
  expect(ran).not.toContain('Read')
  expect((await step('agent-2', 2)).answer).toMatch(/Stopped/)
  expect(sent.length).toBe(before + 1)
  // Its settings panel, open until now, closes once it finishes.
  expect(await pane.find({ key: 'model-agent-2' })).toBeTruthy()
  await $.turn.complete({ answer: 'stopped', durationMs: 1000, isAborted: false, turnId: 't-agent-2', agentId: 'agent-2', reason: 'answer' })
  expect(await pane.find({ text: '⏹' })).toBeTruthy()
  expect(await pane.find({ key: 'model-agent-2' })).toBeFalsy()

  // Stop cuts a reply that is still streaming, without waiting for it to end.
  await spawn(3, 'critique:slow')
  const slow = step('agent-3', 0)
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await pane.press({ key: 'gear-agent-3' })
  await pane.press({ key: 'stop-agent-3' })
  const first = await Promise.race([slow, new Promise<{ answer: string }>(resolve => setTimeout(() => resolve({ answer: 'still waiting' }), 1000))])
  releaseSlow()
  expect(first.answer).toMatch(/Stopped/)
  await pane.unmount()
})

test('/workflows demo loads sample agents that honour Stop', async ($, on) => {
  let clock = 3_000_000
  on('clock.now', () => ({ value: (clock += 1000) }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.command.run({ command: 'workflows', args: 'demo' })
  const props = { title: 'Workflows', isFocused: false, bodyColumns: 110 }
  const pane = await $.ui.mount({ plugin: 'workflow-monitor', surface: 'desktop', component: 'Pane', requestId: 'workflow-monitor', props, viewport: { columns: 110, rows: 60 } })
  expect(await pane.find({ text: 'checkout-redesign' })).toBeTruthy()
  // A stopped row shows the stop icon in grey, apart from the amber of paused; a paused row says so by its icon alone.
  expect((await pane.findAll({ text: '⏹' })).some(x => x.type === 'Text' && x.props.color === '#8C929C')).toBe(true)
  expect(JSON.stringify(await pane.drawn())).not.toContain('"alt":"stopped"')
  expect(await pane.find({ text: /⏸/ })).toBeTruthy()
  expect(await pane.find({ text: /· paused/ })).toBeFalsy()
  // The costliest effort stands out in red; a finished row opens its activity from a padded ↗.
  expect((await pane.findAll({ text: 'Extra high' })).some(x => x.type === 'Text' && x.props.color === 'error')).toBe(true)
  expect((await pane.find({ key: 'gear-demo-3' }))?.props.label).toBe(' ↗ ')
  // It sits centred in a column wide enough for the desktop's native button round it.
  type Node = { key?: string; props?: Record<string, unknown>; children?: unknown[] }
  const holder = (n: unknown, key: string): Node | undefined => {
    const kids = ((n as Node)?.children ?? []) as Node[]
    return kids.some(c => c?.key === key || c?.props?.key === key) ? n as Node : kids.map(c => holder(c, key)).find(Boolean)
  }
  expect(holder(await pane.drawn(), 'gear-demo-3')?.props).toMatchObject({ width: 6, justifyContent: 'center', alignItems: 'center' })
  // Narrow, on its own line under the label, the costliest effort is red too, not dim.
  const narrow = await $.ui.mount({ plugin: 'workflow-monitor', surface: 'terminal', component: 'Pane', requestId: 'workflow-monitor', props: { ...props, bodyColumns: 50 }, viewport: { columns: 50, rows: 60 } })
  expect((await narrow.findAll({ text: 'Extra high' })).some(x => x.type === 'Text' && x.props.color === 'error' && !x.props.dimColor)).toBe(true)
  expect(holder(await narrow.drawn(), 'gear-demo-3')?.props).toMatchObject({ width: 3 })
  await narrow.unmount()
  await pane.press({ key: 'gear-demo-4' })
  await pane.press({ key: 'stop-demo-4' })
  await pane.unmount()
})

test('an elapsed time counts up on the surface without the pane redrawing', async ($, on) => {
  let clock = 5_000_000
  on('clock.now', () => ({ value: clock }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'agent-t' }))
  await $.agent.spawn({
    tool_use_id: 'toolu_t', prompt: 'p', description: 'Timed agent', subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false,
  })
  for (const surface of SURFACES) {
    clock = 5_004_000
    const props = { title: 'Workflows', isFocused: false, bodyColumns: 110 }
    const pane = await $.ui.mount({ plugin: 'workflow-monitor', surface, component: 'Pane', requestId: 'workflow-monitor', props, viewport: { columns: 110, rows: 40 } })
    expect(await pane.find({ text: '4s', in: 'time-agent-t' })).toBeTruthy()
    await pane.advance(3000)
    expect(await pane.find({ text: '7s', in: 'time-agent-t' })).toBeTruthy()
    // A click redraws the pane; the time keeps counting from the redraw's figure.
    clock += 3000
    await pane.press({ key: 'gear-agent-t' })
    expect(await pane.find({ text: '7s', in: 'time-agent-t' })).toBeTruthy()
    await pane.advance(2000)
    expect(await pane.find({ text: '9s', in: 'time-agent-t' })).toBeTruthy()
    await pane.unmount()
  }
})

test('paused and stopped agents stop counting, and a workflow with none working stops too', async ($, on) => {
  let clock = 7_000_000
  let n = 0
  on('clock.now', () => ({ value: clock }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', () => ({ result: 'launched' }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `agent-p${++n}` }))
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'toolu_p', input: { script: SCRIPT } })
  for (const index of [1, 2]) {
    await $.agent.spawn({
      tool_use_id: 'toolu_p', prompt: 'p', description: `investigate:part-${index}`, subagentType: 'general-purpose',
      provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false,
      workflow: { runId: 'wf_p', agentIndex: index },
    })
  }
  const props = { title: 'Workflows', isFocused: false, bodyColumns: 110 }
  clock += 10_000
  const pane = await $.ui.mount({ plugin: 'workflow-monitor', surface: 'desktop', component: 'Pane', requestId: 'workflow-monitor', props, viewport: { columns: 110, rows: 40 } })
  const shows = async (key: string, text: string) => expect(await pane.find({ text, in: key })).toBeTruthy()
  const wait = async (ms: number) => { await pane.advance(ms); clock += ms }
  await shows('time-agent-p1', '10s')
  await shows('span-wf_p', '10s')

  // Paused, agent 1's time stands still; the workflow goes on counting with agent 2.
  await pane.press({ key: 'gear-agent-p1' })
  await pane.press({ key: 'pause-agent-p1' })
  await wait(5000)
  await shows('time-agent-p1', '10s')
  await shows('time-agent-p2', '15s')
  await shows('span-wf_p', '15s')

  // With agent 2 paused as well, none works: the workflow's time stands still too.
  await pane.press({ key: 'gear-agent-p2' })
  await pane.press({ key: 'pause-agent-p2' })
  await wait(5000)
  await shows('time-agent-p2', '15s')
  await shows('span-wf_p', '15s')

  // Resumed, agent 1 and the workflow count on from where they stood.
  await pane.press({ key: 'gear-agent-p1' })
  await pane.press({ key: 'pause-agent-p1' })
  await wait(3000)
  await shows('time-agent-p1', '13s')
  await shows('span-wf_p', '18s')

  // Stopped, agent 2 stays at the time it had.
  await pane.press({ key: 'gear-agent-p2' })
  await pane.press({ key: 'stop-agent-p2' })
  await wait(2000)
  await shows('time-agent-p2', '15s')
  await shows('span-wf_p', '20s')

  // A stop asked for stands: a later Pause or Resume all leaves agent 2 stopping, not held.
  await pane.press({ key: 'pause-agent-p2' })
  await pane.press({ key: 'gear-group-wf_p' })
  await pane.press({ key: 'pause-all-wf_p' })
  await pane.press({ key: 'pause-all-wf_p' })
  expect(await pane.find({ text: /stopping…/ })).toBeTruthy()
  const answer = await Promise.race([
    (async () => {
      const stream = $.turn.step({ turnId: 't-p2', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1, agentId: 'agent-p2' })
      let text = ''
      for await (const c of stream) if (c.kind === 'text') text += c.text
      return text
    })(),
    new Promise<string>(resolve => setTimeout(() => resolve('held'), 1000)),
  ])
  expect(answer).toMatch(/Stopped/)
  await pane.unmount()
})

test('on the desktop the pickers are the surface\'s own Selects and apply the pick', async ($, on) => {
  const sent: string[] = []
  on('clock.now', () => ({ value: 9_000_000 }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'agent-d' }))
  on('turn.step', async function* (_$, e) {
    sent.push(e.model)
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: USAGE }
  })
  await $.agent.spawn({
    tool_use_id: 'toolu_d', prompt: 'p', description: 'Desktop agent', subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false,
  })
  const props = { title: 'Workflows', isFocused: false, bodyColumns: 110 }
  const pane = await $.ui.mount({ plugin: 'workflow-monitor', surface: 'desktop', component: 'Pane', requestId: 'workflow-monitor', props, viewport: { columns: 110, rows: 40 } })
  await pane.press({ key: 'gear-agent-d' })
  expect((await pane.find({ key: 'model-agent-d' }))?.type).toBe('Select')
  await pane.select({ key: 'model-agent-d', value: 'claude-haiku-5-5' })

  const stream = $.turn.step({ turnId: 't-d', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1, agentId: 'agent-d' })
  for await (const _ of stream) { /* drain */ }
  await stream.result
  expect(sent).toEqual(['claude-haiku-5-5'])
  expect(await pane.find({ text: 'Haiku 5.5' })).toBeTruthy()
  await pane.unmount()
})

// The double click: the host holds a press handle only while the drawing that carried it is the
// latest, so a Button drawn afresh at each redraw drops a click that lands just after one.
test('a control keeps its press handle while the panes redraw around it', async ($, on) => {
  let clock = 11_000_000
  on('clock.now', () => ({ value: (clock += 100) }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', () => ({ result: 'launched' }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'agent-k' }))
  on('turn.step', async function* (_$, e) {
    yield { kind: 'text', index: 0, text: 'Working on it.' }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: USAGE }
  })
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'toolu_k', input: { script: SCRIPT } })
  await $.agent.spawn({
    tool_use_id: 'toolu_k', prompt: 'p', description: 'investigate:kept', subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false,
    workflow: { runId: 'wf_k', agentIndex: 1 },
  })
  const step = async (index: number) => {
    const stream = $.turn.step({ turnId: 't-k', index, model: 'claude-opus-5-5', effort: 'high', messageCount: 1, agentId: 'agent-k' })
    for await (const _ of stream) { /* drain */ }
    await stream.result
  }
  type Node = { type?: string; props?: { key?: unknown }; press?: { handle?: number }; children?: unknown[] }
  const handleOf = (tree: unknown, key: string): number | undefined => {
    const n = tree as Node
    if (!n || typeof n !== 'object') return undefined
    if ((n.type === 'Button' || n.type === 'Select') && n.props?.key === key) return n.press?.handle
    for (const c of n.children ?? []) {
      const found = handleOf(c, key)
      if (found !== undefined) return found
    }
    return undefined
  }
  const props = { title: 'Workflows', isFocused: false, bodyColumns: 110 }
  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ plugin: 'workflow-monitor', surface, component: 'Pane', requestId: 'workflow-monitor', props, viewport: { columns: 110, rows: 40 } })
    await pane.press({ key: 'gear-agent-k' })
    const keys = ['gear-agent-k', 'fold-wf_k', 'pause-agent-k', 'stop-agent-k', 'model-agent-k', 'done-agent-k']
    const first = await pane.drawn()
    const handles = keys.map(k => handleOf(first, k))
    for (const h of handles) expect(typeof h).toBe('number')

    // A step lands: new tokens and cost redraw the pane, and every control keeps its handle.
    await step(surface === 'terminal' ? 0 : 1)
    expect(await pane.find({ text: surface === 'terminal' ? '$0.046' : '$0.092' })).toBeTruthy()
    const second = await pane.drawn()
    expect(second).not.toEqual(first)
    expect(keys.map(k => handleOf(second, k))).toEqual(handles)

    // A control that changes is drawn afresh; the others still keep theirs.
    await pane.press({ key: 'pause-agent-k' })
    const third = await pane.drawn()
    expect(handleOf(third, 'pause-agent-k')).not.toBe(handles[2])
    expect(handleOf(third, 'stop-agent-k')).toBe(handles[3])
    await pane.press({ key: 'pause-agent-k' })
    await pane.press({ key: 'done-agent-k' })
    await pane.unmount()
  }

  // The Inspect pane redraws as the agent's activity streams in; its Pause and Stop stay put.
  const pane = await $.ui.mount({ plugin: 'workflow-monitor', surface: 'desktop', component: 'Pane', requestId: 'workflow-monitor', props, viewport: { columns: 110, rows: 40 } })
  await pane.press({ key: 'gear-agent-k' })
  await pane.press({ key: 'activity-agent-k' })
  await pane.unmount()
  const inspect = await $.ui.mount({ plugin: 'workflow-monitor', surface: 'desktop', component: 'Pane', requestId: 'workflow-monitor-agent', props, viewport: { columns: 110, rows: 40 } })
  const before = await inspect.drawn()
  const pause = handleOf(before, 'pause-agent-k')
  expect(typeof pause).toBe('number')
  await step(2)
  expect(await inspect.find({ text: /39\.0k tok/ })).toBeTruthy()
  const after = await inspect.drawn()
  expect(after).not.toEqual(before)
  expect(handleOf(after, 'pause-agent-k')).toBe(pause)
  // And a press on it still runs: Pause, then Resume.
  await inspect.press({ key: 'pause-agent-k' })
  expect(await inspect.find({ text: /paused/ })).toBeTruthy()
  await inspect.press({ key: 'pause-agent-k' })
  await inspect.unmount()
})

test('finished cards close to Archived, come back, and can be removed for good', async ($, on) => {
  let clock = 13_000_000
  let n = 0
  on('clock.now', () => ({ value: (clock += 100) }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', () => ({ result: 'launched' }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `agent-a${++n}` }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'toolu_a', input: { script: SCRIPT } })
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'toolu_b', input: { script: SCRIPT.replace('store-switch-design', 'other-run') } })
  const spawn = (toolUseId: string, runId: string | undefined, index: number) => $.agent.spawn({
    tool_use_id: toolUseId, prompt: 'p', description: `investigate:part-${index}`, subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false,
    ...(runId ? { workflow: { runId, agentIndex: index } } : {}),
  })
  const finish = (id: string) => $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: `t-${id}`, agentId: id, reason: 'answer' })
  await spawn('toolu_a', 'wf_a', 1) // agent-a1
  await spawn('toolu_a', 'wf_a', 2) // agent-a2
  await spawn('toolu_b', 'wf_b', 1) // agent-a3, left running
  await spawn('toolu_s', undefined, 1) // agent-a4, a plain subagent
  for (const id of ['agent-a1', 'agent-a2', 'agent-a4']) await finish(id)

  const props = { title: 'Workflows', isFocused: false, bodyColumns: 110 }
  const pane = await $.ui.mount({ plugin: 'workflow-monitor', surface: 'desktop', component: 'Pane', requestId: 'workflow-monitor', props, viewport: { columns: 110, rows: 60 } })
  const has = async (key: string) => !!(await pane.find({ key }))

  // A finished card has a close button; a running one doesn't.
  expect(await has('close-wf_a')).toBe(true)
  expect(await has('close-wf_b')).toBe(false)

  // Closing archives it: the card leaves for a folded Archived line, and Restore brings it back.
  await pane.press({ key: 'close-wf_a' })
  expect(await has('fold-wf_a')).toBe(false)
  expect(await pane.find({ text: /Archived \(1\)/ })).toBeTruthy()
  expect(await has('restore-wf_a')).toBe(false)
  await pane.press({ key: 'archived-toggle' })
  expect(await pane.find({ text: 'store-switch-design' })).toBeTruthy()
  await pane.press({ key: 'restore-wf_a' })
  expect(await has('fold-wf_a')).toBe(true)
  expect(await has('archived-toggle')).toBe(false)

  // A finished card's settings offer Archive and Remove instead of Pause and Stop all; archiving closes them.
  await pane.press({ key: 'gear-group-wf_a' })
  expect(await has('pause-all-wf_a')).toBe(false)
  expect(await has('archive-wf_a')).toBe(true)
  await pane.press({ key: 'archive-wf_a' })
  expect(await has('fold-wf_a')).toBe(false)
  expect(await has('model-group-wf_a')).toBe(false)
  expect(await has('restore-wf_a')).toBe(true)

  // A new agent in an archived run brings its card back.
  await spawn('toolu_a', 'wf_a', 3) // agent-a5
  expect(await has('fold-wf_a')).toBe(true)
  expect(await has('restore-wf_a')).toBe(false)
  expect(await has('close-wf_a')).toBe(false)
  await finish('agent-a5')
  // Its run's end comes as the Workflow task's notification: the card reads done, and folds.
  await $.prompt.submit({ text: ended('toolu_a', 'completed'), wait: false, origin: { kind: 'task-notification' } })
  expect((await pane.find({ key: 'status-wf_a' }))?.text).toBe('✓ done')

  // Inspecting one of its agents, then removing the card: it leaves the monitor, and Inspect lets go.
  await pane.press({ key: 'fold-wf_a' })
  await pane.press({ key: 'gear-agent-a1' })
  await pane.press({ key: 'gear-group-wf_a' })
  await pane.press({ key: 'remove-wf_a' })
  expect(await has('fold-wf_a')).toBe(false)
  expect(await has('archived-toggle')).toBe(false)
  const inspect = await $.ui.mount({ plugin: 'workflow-monitor', surface: 'desktop', component: 'Pane', requestId: 'workflow-monitor-agent', props, viewport: { columns: 110, rows: 40 } })
  expect(await inspect.find({ text: /Pick Inspect/ })).toBeTruthy()
  await inspect.unmount()

  // Remove all takes everything archived; the running workflow stays.
  await pane.press({ key: 'close-subagents' })
  expect(await pane.find({ text: /Archived \(1\)/ })).toBeTruthy()
  await pane.press({ key: 'purge-archived' })
  expect(await has('archived-toggle')).toBe(false)
  expect(await has('fold-subagents')).toBe(false)
  expect(await has('fold-wf_b')).toBe(true)

  // With every card archived the board says so; removing the last one empties the monitor.
  await finish('agent-a3')
  await pane.press({ key: 'close-wf_b' })
  expect(await pane.find({ text: /everything is archived/ })).toBeTruthy()
  await pane.press({ key: 'purge-wf_b' })
  expect(await pane.find({ text: /No subagents yet/ })).toBeTruthy()
  await pane.unmount()
})

test('a group can sit on the board and under Archived at once, and starts afresh once removed', async ($, on) => {
  let clock = 14_000_000
  let n = 0
  let reuse: string | undefined
  on('clock.now', () => ({ value: (clock += 100) }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', () => ({ result: 'launched' }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: reuse ?? `agent-s${++n}` }))
  on('turn.complete', () => ({ text: 'ok' }))
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'toolu_r', input: { script: SCRIPT } })
  const spawn = (index: number, runId?: string) => $.agent.spawn({
    tool_use_id: runId ? 'toolu_r' : `toolu_s${index}`, prompt: 'p', description: `investigate:part-${index}`, subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false,
    ...(runId ? { workflow: { runId, agentIndex: index } } : {}),
  })
  const finish = (id: string) => $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: `t-${id}`, agentId: id, reason: 'answer' })
  await spawn(1) // agent-s1, a plain subagent
  await finish('agent-s1')
  const props = { title: 'Workflows', isFocused: false, bodyColumns: 110 }
  const pane = await $.ui.mount({ plugin: 'workflow-monitor', surface: 'desktop', component: 'Pane', requestId: 'workflow-monitor', props, viewport: { columns: 110, rows: 60 } })
  const has = async (key: string) => !!(await pane.find({ key }))

  // Archiving the card of the agent Inspect shows leaves Inspect on it (only Remove lets go).
  await pane.press({ key: 'gear-agent-s1' })
  await pane.press({ key: 'close-subagents' })
  const inspect = await $.ui.mount({ plugin: 'workflow-monitor', surface: 'desktop', component: 'Pane', requestId: 'workflow-monitor-agent', props, viewport: { columns: 110, rows: 40 } })
  expect(await inspect.find({ text: /part-1/ })).toBeTruthy()
  await inspect.unmount()

  // A new subagent gets a card of its own while the earlier one stays archived.
  await spawn(2) // agent-s2
  expect(await has('fold-subagents')).toBe(true)
  await pane.press({ key: 'archived-toggle' })
  expect(await has('restore-subagents')).toBe(true)

  // Removing the archived one leaves the live card, and its open settings, as they were.
  await pane.press({ key: 'gear-group-subagents' })
  expect(await has('model-group-subagents')).toBe(true)
  await pane.press({ key: 'purge-subagents' })
  expect(await has('archived-toggle')).toBe(false)
  expect(await has('model-group-subagents')).toBe(true)
  expect(await pane.find({ text: /part-2/ })).toBeTruthy()
  expect(await pane.find({ text: /part-1/ })).toBeFalsy()
  await pane.press({ key: 'done-group-subagents' })

  // An agent started again under an archived id comes back to the board.
  await finish('agent-s2')
  await pane.press({ key: 'close-subagents' })
  expect(await has('fold-subagents')).toBe(false)
  reuse = 'agent-s2'
  await spawn(2)
  reuse = undefined
  expect(await has('fold-subagents')).toBe(true)
  expect(await has('archived-toggle')).toBe(false)

  // A workflow removed and started again gets a fresh card, without the model it had set.
  await spawn(1, 'wf_r') // agent-s3
  await pane.press({ key: 'gear-group-wf_r' })
  await pane.select({ key: 'model-group-wf_r', value: 'claude-haiku-5-5' })
  await pane.press({ key: 'done-group-wf_r' })
  expect(await pane.find({ text: '◆' })).toBeTruthy()
  await finish('agent-s3')
  await pane.press({ key: 'gear-group-wf_r' })
  await pane.press({ key: 'remove-wf_r' })
  expect(await has('fold-wf_r')).toBe(false)
  await spawn(2, 'wf_r') // agent-s4
  expect(await has('fold-wf_r')).toBe(true)
  expect(await pane.find({ text: '◆' })).toBeFalsy()
  await pane.unmount()
})

test('/workflows clear and a fresh /workflows demo leave nothing of the old behind', async ($, on) => {
  let clock = 15_000_000
  let n = 0
  on('clock.now', () => ({ value: (clock += 100) }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', () => ({ result: 'launched' }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `agent-c${++n}` }))
  on('turn.complete', () => ({ text: 'ok' }))
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'toolu_c', input: { script: SCRIPT } })
  const spawn = (index: number, runId: string) => $.agent.spawn({
    tool_use_id: 'toolu_c', prompt: 'p', description: `investigate:part-${index}`, subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false,
    workflow: { runId, agentIndex: index },
  })
  await spawn(1, 'wf_c') // agent-c1, finished and archived below
  await spawn(2, 'wf_live') // agent-c2, left running
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't-c1', agentId: 'agent-c1', reason: 'answer' })
  await $.command.run({ command: 'workflows', args: 'demo' })
  const props = { title: 'Workflows', isFocused: false, bodyColumns: 110 }
  const pane = await $.ui.mount({ plugin: 'workflow-monitor', surface: 'desktop', component: 'Pane', requestId: 'workflow-monitor', props, viewport: { columns: 110, rows: 80 } })
  const has = async (key: string) => !!(await pane.find({ key }))
  await pane.press({ key: 'close-wf_c' })
  expect(await has('archived-toggle')).toBe(true)

  // A second demo starts afresh: one demo card, and a stop asked of the first one is gone.
  await pane.press({ key: 'gear-demo-4' })
  await pane.press({ key: 'stop-demo-4' })
  expect(await pane.find({ text: /stopping…/ })).toBeTruthy()
  await $.command.run({ command: 'workflows', args: 'demo' })
  expect(await pane.findAll({ key: 'fold-wf_demo' })).toHaveLength(1)
  expect(await pane.find({ text: /stopping…/ })).toBeFalsy()
  expect(await pane.find({ text: /⏸/ })).toBeTruthy()
  const call = await $.tool.call({ tool: 'Read', tool_use_id: 'toolu_d4', input: { file_path: 'a' }, agentId: 'demo-4' })
  expect('deny' in call).toBe(false)

  // Clear takes the finished, the archived and the demo; a running agent stays.
  await $.command.run({ command: 'workflows', args: 'clear' })
  expect(await has('archived-toggle')).toBe(false)
  expect(await has('fold-wf_demo')).toBe(false)
  expect(await has('fold-wf_live')).toBe(true)
  expect(await pane.find({ text: /⏸/ })).toBeFalsy()
  await pane.unmount()
})

test('a card\'s status chip says where its group stands, at any width', async ($, on) => {
  const clock = mock.clock(on, { now: 20_000_000 })
  let n = 0
  // What each Workflow call's launch returns, by call; one not listed launches with no record.
  const launches: Record<string, object> = {}
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', (_$, e) => ({ result: launches[e.tool_use_id] ?? 'launched' }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `agent-c${++n}` }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: USAGE }
  })
  on('turn.complete', () => ({ text: 'ok' }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  // The session starts its clock: a run going quiet is noticed on it.
  on('command.register', () => ({ value: { command: 'workflows' } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const spawn = (toolUseId: string, runId: string | undefined, index: number) => $.agent.spawn({
    tool_use_id: toolUseId, prompt: 'p', description: `investigate:part-${index}`, subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false,
    ...(runId ? { workflow: { runId, agentIndex: index } } : {}),
  })
  const end = (id: string, reason: 'answer' | 'aborted' | 'error') =>
    $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: reason === 'aborted', turnId: `t-${id}`, agentId: id, reason })
  const notify = (toolUseId: string, status: string) =>
    $.prompt.submit({ text: ended(toolUseId, status), wait: false, origin: { kind: 'task-notification' } })
  // An agent's next model request, read to its end: a pause holds it there until resumed.
  const request = async (agentId: string) => {
    const stream = $.turn.step({ turnId: `t-${agentId}`, index: 1, model: 'claude-opus-5-5', effort: 'high', messageCount: 1, agentId })
    const it = stream[Symbol.asyncIterator]()
    while (!(await it.next()).done) { /* read on */ }
  }

  await $.tool.call({ tool: 'Workflow', tool_use_id: 'toolu_c', input: { script: SCRIPT } })
  for (let i = 1; i <= 5; i++) await spawn('toolu_c', 'wf_c', i)

  const mount = (columns: number, surface: 'terminal' | 'desktop' = 'desktop') => $.ui.mount({
    plugin: 'workflow-monitor', surface, component: 'Pane', requestId: 'workflow-monitor',
    props: { title: 'Workflows', isFocused: false, bodyColumns: columns }, viewport: { columns, rows: 80 },
  })
  const pane = await mount(110)
  // What a card's chip reads: its segments, a space apart as the surface lays them out.
  const shown = (node: unknown): string => (typeof node === 'string' ? node
    : ((node as { children?: unknown[] }).children ?? []).map(shown).join(''))
  const chipOf = async (p: typeof pane, key: string) => ((await p.find({ key: `status-${key}` }))?.children ?? [])
    .map(shown).filter(Boolean).join(' ')
  const card = async (key: string) => (await pane.find({ key: `card-${key}` }))?.props
  // Unfolded: its phase rows are drawn.
  const isOpen = async (key: string) => !!(await pane.find({ key: `cols-${key}-Investigate` }))
  // Medium and narrow, on the terminal while the desktop holds the wide one.
  const atWidths = async (key: string) => {
    const out: string[] = []
    for (const columns of [70, 44]) {
      const p = await mount(columns, 'terminal')
      out.push(await chipOf(p, key))
      await p.unmount()
    }
    return out
  }

  // All working: the lead alone says it in a word, but where there's no room.
  expect(await chipOf(pane, 'wf_c')).toBe('● 5 working')
  expect(await atWidths('wf_c')).toEqual(['● 5 working', '●5'])

  // agent-c1..c5: two still working, one done, one failed, one stopped.
  await end('agent-c2', 'answer')
  await end('agent-c3', 'error')
  await end('agent-c4', 'aborted')

  // Working: the lead counts the working, then a mark for each other kind, at any width; the border is blue.
  expect(await chipOf(pane, 'wf_c')).toBe('● 2 · ✗ 1 · ⏹ 1 · ✓ 1')
  expect(await atWidths('wf_c')).toEqual(['●2 ✗1 ⏹1 ✓1', '●2 ✗1 ⏹1 ✓1'])
  expect((await card('wf_c'))?.borderColor).toBe('#4D9DF0')

  // Pausing them all: amber, and "…" until each is held at its next request.
  await pane.press({ key: 'gear-group-wf_c' })
  await pane.press({ key: 'pause-all-wf_c' })
  expect(await chipOf(pane, 'wf_c')).toBe('⏸ 2… · ✗ 1 · ⏹ 1 · ✓ 1')
  expect(await atWidths('wf_c')).toEqual(['⏸2… ✗1 ⏹1 ✓1', '⏸2… ✗1 ⏹1 ✓1'])
  expect((await card('wf_c'))?.borderColor).toBe('warning')
  const held1 = request('agent-c1')
  const held5 = request('agent-c5')
  await clock.settle()
  expect(await chipOf(pane, 'wf_c')).toBe('⏸ 2 · ✗ 1 · ⏹ 1 · ✓ 1')
  expect(await atWidths('wf_c')).toEqual(['⏸2 ✗1 ⏹1 ✓1', '⏸2 ✗1 ⏹1 ✓1'])

  // One resumed works again, the other still waits.
  await pane.press({ key: 'gear-agent-c1' })
  await pane.press({ key: 'pause-agent-c1' })
  await held1
  expect(await chipOf(pane, 'wf_c')).toBe('● 1 · ⏸ 1 · ✗ 1 · ⏹ 1 · ✓ 1')

  // Stopping them: grey, the stopped mark folded into the lead (those already stopped counted in).
  await pane.press({ key: 'gear-group-wf_c' })
  await pane.press({ key: 'stop-all-wf_c' })
  await held5
  expect(await chipOf(pane, 'wf_c')).toBe('⏹ 3… · ✗ 1 · ✓ 1')
  expect(await atWidths('wf_c')).toEqual(['⏹3… ✗1 ✓1', '⏹3… ✗1 ✓1'])

  // None runs and the run hasn't said it ended: idle (it may be between phases), its quiet time counting.
  await end('agent-c1', 'aborted')
  await end('agent-c5', 'aborted')
  expect(await chipOf(pane, 'wf_c')).toBe('○ · ✗ 1 · ⏹ 3 · ✓ 1')
  expect(await atWidths('wf_c')).toEqual(['○ ✗1 ⏹3 ✓1', '○ ✗1 ⏹3 ✓1'])
  expect((await pane.find({ key: 'status-wf_c' }))?.children[1]).toMatchObject({ type: 'Client' })
  expect(await pane.find({ text: '0s', in: 'idle-wf_c' })).toBeTruthy()
  await pane.advance(65_000)
  expect(await pane.find({ text: '1m 05s', in: 'idle-wf_c' })).toBeTruthy()
  expect((await card('wf_c'))?.borderDimColor).toBe(true)

  // Its run's notification says it was stopped: that's the lead, the agents it had beside it.
  await notify('toolu_c', 'killed')
  expect(await chipOf(pane, 'wf_c')).toBe('⏹ 3 · ✗ 1 · ✓ 1')
  expect(await atWidths('wf_c')).toEqual(['⏹3 ✗1 ✓1', '⏹3 ✗1 ✓1'])

  // Resumed by a new call: how the last call ended no longer holds. The launch names the run, so
  // the new call's end counts though its agents carry no call.
  launches.toolu_c2 = { status: 'async_launched', taskId: 'bg_c2', runId: 'wf_c', workflowName: 'store-switch-design' }
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'toolu_c2', input: {} })
  expect(await chipOf(pane, 'wf_c')).toBe('○ · ✗ 1 · ⏹ 3 · ✓ 1')
  await spawn('', 'wf_c', 6) // agent-c6
  expect(await chipOf(pane, 'wf_c')).toBe('● 1 · ✗ 1 · ⏹ 3 · ✓ 1')
  await end('agent-c6', 'answer')
  await notify('toolu_c2', 'completed')
  expect(await chipOf(pane, 'wf_c')).toBe('✓ 2 · ✗ 1 · ⏹ 3')

  // A run whose script completed reads done, its failures beside it; one whose script threw says so.
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'toolu_d', input: { script: SCRIPT } })
  await spawn('toolu_d', 'wf_d', 1) // agent-c7
  await spawn('toolu_d', 'wf_d', 2) // agent-c8
  await end('agent-c7', 'answer')
  await end('agent-c8', 'error')
  await notify('toolu_d', 'completed')
  expect(await chipOf(pane, 'wf_d')).toBe('✓ 1 · ✗ 1')
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'toolu_e', input: { script: SCRIPT } })
  await spawn('toolu_e', 'wf_e', 1) // agent-c9
  await end('agent-c9', 'answer')
  await notify('toolu_e', 'failed')
  expect(await chipOf(pane, 'wf_e')).toBe('⚠ script failed')

  // Runs that never say they ended read idle, then, once quiet ten minutes, what their agents did.
  const quietRuns = [['wf_f', 'agent-c10', 'answer'], ['wf_g', 'agent-c11', 'error'], ['wf_h', 'agent-c12', 'aborted']] as const
  for (const [run, id, reason] of quietRuns) {
    await clock.advance(1_000) // a second apart, so wf_h is the newest
    await $.tool.call({ tool: 'Workflow', tool_use_id: `toolu_${run}`, input: { script: SCRIPT } })
    await spawn(`toolu_${run}`, run, 1)
    await end(id, reason)
  }
  expect(await chipOf(pane, 'wf_f')).toBe('○ · ✓ 1')
  expect(await chipOf(pane, 'wf_g')).toBe('○ · ✗ 1')
  expect(await chipOf(pane, 'wf_h')).toBe('○ · ⏹ 1')
  await clock.advance(10 * 60_000)
  expect(await chipOf(pane, 'wf_f')).toBe('✓ done')
  expect(await chipOf(pane, 'wf_g')).toBe('✗ 1 failed')
  expect(await chipOf(pane, 'wf_h')).toBe('⏹ stopped')
  expect(await atWidths('wf_g')).toEqual(['✗ 1 failed', '✗1'])
  // With every card over, only the newest is unfolded.
  expect(await isOpen('wf_h')).toBe(true)
  expect(await isOpen('wf_f')).toBe(false)

  // A new agent wakes a quiet run up; working or between phases, it alone is unfolded.
  await spawn('toolu_wf_f', 'wf_f', 2) // agent-c13
  expect(await chipOf(pane, 'wf_f')).toBe('● 1 · ✓ 1')
  await end('agent-c13', 'answer')
  expect(await chipOf(pane, 'wf_f')).toBe('○ · ✓ 2')
  expect(await isOpen('wf_f')).toBe(true)
  expect(await isOpen('wf_h')).toBe(false)
  expect(await isOpen('wf_d')).toBe(false)

  // Plain subagents have no run to end: once none runs, their own outcome, and their own
  // task notification changes nothing.
  await spawn('toolu_s', undefined, 1) // agent-c14
  await end('agent-c14', 'answer')
  expect(await chipOf(pane, 'subagents')).toBe('✓ done')
  await notify('toolu_s', 'failed')
  expect(await chipOf(pane, 'subagents')).toBe('✓ done')

  // Beside marks a lead counts its own kind, a zero too: a run that completed with none of its
  // agents done, and one stopped between phases with none caught stopping.
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'toolu_i', input: { script: SCRIPT } })
  await spawn('toolu_i', 'wf_i', 1) // agent-c15
  await end('agent-c15', 'error')
  await notify('toolu_i', 'completed')
  expect(await chipOf(pane, 'wf_i')).toBe('✓ 0 · ✗ 1')
  expect(await atWidths('wf_i')).toEqual(['✓0 ✗1', '✓0 ✗1'])
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'toolu_j', input: { script: SCRIPT } })
  await spawn('toolu_j', 'wf_j', 1) // agent-c16
  await end('agent-c16', 'answer')
  await notify('toolu_j', 'killed')
  expect(await chipOf(pane, 'wf_j')).toBe('⏹ 0 · ✓ 1')
  expect(await atWidths('wf_j')).toEqual(['⏹0 ✓1', '⏹0 ✓1'])
  // A script that threw keeps its word: its done agents are no mark beside it.
  expect(await chipOf(pane, 'wf_e')).toBe('⚠ script failed')

  // A paused subagent beside one done: both, at any width.
  await spawn('toolu_s2', undefined, 2) // agent-c17
  await pane.press({ key: 'gear-agent-c17' })
  await pane.press({ key: 'pause-agent-c17' })
  const held17 = request('agent-c17')
  await clock.settle()
  expect(await chipOf(pane, 'subagents')).toBe('⏸ 1 · ✓ 1')
  expect(await atWidths('subagents')).toEqual(['⏸1 ✓1', '⏸1 ✓1'])
  await pane.press({ key: 'pause-agent-c17' })
  await held17
  await end('agent-c17', 'answer')
  expect(await chipOf(pane, 'subagents')).toBe('✓ done')
  await pane.unmount()
})

test('agent rows hide no column at any width, cutting the name short, then go on two lines', async ($, on) => {
  let clock = 3_000_000
  on('clock.now', () => ({ value: (clock += 1000) }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.command.run({ command: 'workflows', args: 'demo' })
  const at = async (columns: number, surface: 'terminal' | 'desktop') => {
    const props = { title: 'Workflows', isFocused: false, bodyColumns: columns }
    const pane = await $.ui.mount({ plugin: 'workflow-monitor', surface, component: 'Pane', requestId: 'workflow-monitor', props, viewport: { columns, rows: 60 } })
    const headers = await Promise.all(['Model', 'Effort', 'Tokens', 'Time', 'Cost'].map(async text => !!(await pane.find({ text }))))
    const seen = {
      // Column form: every header; two lines: none of them.
      columns: headers.every(Boolean) ? true : headers.some(Boolean) ? 'some' : false,
      effort: (await pane.findAll({ text: 'Extra high' })).some(x => x.type === 'Text' && x.props.color === 'error'),
      // Each agent's own cost, dim (the card's total is red).
      cost: (await pane.findAll({ text: /^\$\d/ })).some(x => x.type === 'Text' && x.props.dimColor),
      // The agent's name ends in an ellipsis where its column is short, rather than wrapping.
      cut: (await pane.findAll({ text: /^design:api-contract/ })).some(x => x.type === 'Text' && x.props.wrap === 'truncate-end'),
    }
    await pane.unmount()
    return seen
  }
  const all = { effort: true, cost: true, cut: true }
  expect(await at(110, 'desktop')).toEqual({ columns: true, ...all })
  // Narrower, the name gets what's left, 12 columns at the least (the desktop's row button takes
  // three more than the terminal's).
  expect(await at(72, 'desktop')).toEqual({ columns: true, ...all })
  expect(await at(69, 'terminal')).toEqual({ columns: true, ...all })
  // A column less and each agent goes on two lines, its effort and cost among the rest.
  expect(await at(71, 'desktop')).toEqual({ columns: false, ...all })
  expect(await at(68, 'terminal')).toEqual({ columns: false, ...all })
})

test('a workflow takes its name and phases from its launch, as the call\'s input reaches the mod empty', async ($, on) => {
  let n = 0
  const saved = 'C:/session/workflows/scripts/store-switch-design-wf_named.js'
  on('clock.now', () => ({ value: 30_000_000 }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `agent-n${++n}` }))
  on('fs.read', (_$, e) => {
    // The engine hands the path on as the platform spells it.
    if (e.path.replace(/\\/g, '/') !== saved) throw new Error(`ENOENT: ${e.path}`)
    return { value: SCRIPT }
  })
  // The launch names the run, the script's meta.name and where the script was saved.
  on('tool.call', (_$, e) => ({
    result: e.tool_use_id === 'toolu_n'
      ? { status: 'async_launched', taskId: 'bg_n', runId: 'wf_named', workflowName: 'store-switch-design', scriptPath: saved }
      : { status: 'async_launched', taskId: 'bg_m', runId: 'wf_unread', workflowName: 'nightly-audit', scriptPath: 'C:/gone.js' },
  }))
  const spawn = (toolUseId: string, runId: string) => $.agent.spawn({
    tool_use_id: toolUseId, prompt: 'p', description: 'critique:detail-pages', subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false,
    workflow: { runId, agentIndex: 1 },
  })
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'toolu_n', input: {} })
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'toolu_m', input: {} })
  await spawn('toolu_n', 'wf_named')
  await spawn('toolu_m', 'wf_unread')
  const props = { title: 'Workflows', isFocused: false, bodyColumns: 110 }
  const pane = await $.ui.mount({ plugin: 'workflow-monitor', surface: 'desktop', component: 'Pane', requestId: 'workflow-monitor', props, viewport: { columns: 110, rows: 60 } })
  // The saved script gives the name, the description and the phases.
  expect((await pane.find({ key: 'fold-wf_named' }))?.text).toContain('store-switch-design')
  expect(await pane.find({ text: 'Investigate and design fixes' })).toBeTruthy()
  // A script that can't be read leaves the name from the launch.
  expect((await pane.find({ key: 'fold-wf_unread' }))?.text).toContain('nightly-audit')
  await pane.unmount()
})

test('/workflows says what it does and takes: in the typeahead, with help, and on a mistyped option', async ($, on) => {
  mock.clock(on, { now: 40_000_000 })
  let spec: { name: string; description: string; argumentHint?: string } | undefined
  let opened = 0
  on('command.register', (_$, e) => { spec = e; return { value: { command: e.name } } })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.open', () => { opened++; return { value: { isPlaced: true } } })
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  expect(spec?.name).toBe('workflows')
  expect(spec?.description).toMatch(/workflows and subagents/)
  expect(spec?.argumentHint).toBe('[demo|clear|help]')
  // Help names every option in a markdown table, the row's way of drawing it; none opens the pane.
  const help = await $.command.run({ command: 'workflows', args: 'help' })
  expect(help.text).toMatch(/^a live pane of your workflows and subagents\.\n\n\| Command \| What it does \|\n\|---\|---\|\n/)
  for (const option of ['/workflows', '/workflows demo', '/workflows clear', '/workflows help']) expect(help.text).toContain('| `' + option + '` |')
  const typo = await $.command.run({ command: 'workflows', args: 'clera' })
  expect(typo.text).toMatch(/^unknown option `clera`\. It takes these:\n\n\| Command/)
  expect(typo.text).toContain('| `/workflows clear` |')
  expect(opened).toBe(0)
  expect((await $.command.run({ command: 'workflows', args: '' })).text).toBe('Workflow monitor opened.')
  expect(opened).toBe(1)
})
