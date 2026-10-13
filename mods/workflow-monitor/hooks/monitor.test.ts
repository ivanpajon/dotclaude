import { expect, test } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const
const USAGE = { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 10000, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' }
const SCRIPT = `export const meta = {
  name: 'store-switch-design',
  description: 'Investigate and design fixes',
  phases: [{ title: 'Investigate' }, { title: 'Critique' }],
}
phase('Investigate')`

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
  await $.turn.complete({ answer: 'stopped', durationMs: 1000, isAborted: false, turnId: 't-agent-2', agentId: 'agent-2', reason: 'answer' })
  expect(await pane.find({ text: '■' })).toBeTruthy()

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
  expect(await pane.find({ text: /paused/ })).toBeTruthy()
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
