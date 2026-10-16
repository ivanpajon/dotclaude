import { expect, mock, test } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const
const USAGE = { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 10000, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' }
const SCRIPT = `export const meta = {
  name: 'store-switch-design',
  description: 'Investigate and design fixes',
  phases: [{ title: 'Investigate' }, { title: 'Critique' }],
}
phase('Investigate')`
// The host's wait while a pause holds a tool call (see nap), a tenth of a second here.
const NAP = async () => {
  await new Promise(resolve => setTimeout(resolve, 100))
  return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
}
// A background task's end, as its notification reaches the session.
const ended = (toolUseId: string, status: string) =>
  `<task-notification>\n<task-id>bg_${toolUseId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n<summary>Workflow ${status}</summary>\n</task-notification>`

test('tracks a workflow agent, applies overrides, and pauses, stops and inspects it', async ($, on) => {
  let n = 0
  let clock = 1_000_000
  const sent: { model: string; effort?: unknown }[] = []
  on('clock.now', () => ({ value: (clock += 500) }))
  on('process.run', NAP)
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
  // Max is offered too, and applies like the rest.
  await $.ui.select({ plugin: 'workflow-monitor', key: 'effort-agent-2', value: 'max' })
  await step('agent-2', 1)
  expect(sent.at(-1)).toEqual({ model: 'claude-haiku-5-5', effort: 'max' })
  await $.ui.select({ plugin: 'workflow-monitor', key: 'effort-agent-2', value: 'low' })

  // Inspect shows its model, replies and tool calls: here from the stream the monitor kept
  // (the agent's own transcript is a file, see the test on it), its thinking dim.
  await pane.press({ key: 'transcript-agent-2' })
  for (const surface of SURFACES) {
    const view = await $.ui.mount({ plugin: 'workflow-monitor', surface, component: 'Pane', requestId: 'workflow-monitor-agent-agent-2', props, viewport })
    expect(await view.find({ text: 'Haiku 5.5' })).toBeTruthy()
    const md = (await view.findAll({ type: 'Markdown' })).map(x => [x.props.text, !!x.props.dimColor])
    expect(md).toContainEqual(['Checking the detail pages', true])
    expect(md).toContainEqual(['Reading the store page.', false])
    // Each run of tool calls is a line that unfolds to list them, known by its first call: here the
    // third entry of the stream. Its chevron is the workflows pane's, on every surface.
    const [shut, open] = ['▸', '▾']
    expect((await view.find({ key: 'steps-agent-2:log-2' }))?.props.label).toBe(`Read a file ${shut}`)
    expect(await view.find({ text: /src\/store\.ts/ })).toBeFalsy()
    await view.press({ key: 'steps-agent-2:log-2' })
    expect((await view.find({ key: 'steps-agent-2:log-2' }))?.props.label).toBe(`Read a file ${open}`)
    expect(await view.find({ text: /src\/store\.ts/ })).toBeTruthy()
    await view.press({ key: 'steps-agent-2:log-2' })
    // While it works, what it's doing now, after a dot drawn on the desktop; then its totals.
    expect(await view.find({ text: 'Thinking…' })).toBeTruthy()
    if (surface === 'desktop') expect(JSON.stringify(await view.drawn())).toContain('"alt":"working"')
    expect(await view.find({ text: /^2 tool calls · 26\.0k tokens · $/ })).toBeTruthy()
    await view.unmount()
  }

  // Pause holds its next tool call until Resume; its model requests go on meanwhile.
  await pane.press({ key: 'pause-agent-2' })
  expect(await pane.find({ text: /pausing…/ })).toBeTruthy()
  let finished = false
  const held = $.tool.call({ tool: 'Grep', tool_use_id: 'toolu_g', input: { pattern: 'cart' }, agentId: 'agent-2' }).then(r => { finished = true; return r })
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(finished).toBe(false)
  expect(ran).not.toContain('Grep')
  // Held: no longer on its way to paused.
  expect(await pane.find({ text: /pausing…/ })).toBeFalsy()
  const before = sent.length
  await step('agent-2', 1)
  expect(sent.length).toBe(before + 1)
  await pane.press({ key: 'pause-agent-2' })
  expect('deny' in (await held)).toBe(false)
  expect(ran).toContain('Grep')

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
  // The costliest efforts stand out, Max in red and Extra high in orange; a finished row opens its
  // activity from a padded ↗.
  expect((await pane.findAll({ text: 'Max' })).some(x => x.type === 'Text' && x.props.color === 'error')).toBe(true)
  expect((await pane.findAll({ text: 'Extra high' })).some(x => x.type === 'Text' && x.props.color === '#F0883E')).toBe(true)
  expect((await pane.find({ key: 'gear-demo-3' }))?.props.label).toBe(' ↗ ')
  // It sits centred in a column wide enough for the desktop's native button round it.
  type Node = { key?: string; props?: Record<string, unknown>; children?: unknown[] }
  const holder = (n: unknown, key: string): Node | undefined => {
    const kids = ((n as Node)?.children ?? []) as Node[]
    return kids.some(c => c?.key === key || c?.props?.key === key) ? n as Node : kids.map(c => holder(c, key)).find(Boolean)
  }
  expect(holder(await pane.drawn(), 'gear-demo-3')?.props).toMatchObject({ width: 6, justifyContent: 'center', alignItems: 'center' })
  // Narrow, on its own line under the label, the costliest efforts keep their color, not dim.
  const narrow = await $.ui.mount({ plugin: 'workflow-monitor', surface: 'terminal', component: 'Pane', requestId: 'workflow-monitor', props: { ...props, bodyColumns: 50 }, viewport: { columns: 50, rows: 60 } })
  expect((await narrow.findAll({ text: 'Max' })).some(x => x.type === 'Text' && x.props.color === 'error' && !x.props.dimColor)).toBe(true)
  expect((await narrow.findAll({ text: 'Extra high' })).some(x => x.type === 'Text' && x.props.color === '#F0883E' && !x.props.dimColor)).toBe(true)
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
  // A time that counts does so on the surface, in a Client; one that stands still is plain text.
  const counts = async (key: string, text: string) => expect(await pane.find({ text, in: key })).toBeTruthy()
  const stands = async (key: string, text: string) => {
    expect(await pane.find({ key })).toBeFalsy()
    expect(await pane.find({ type: 'Text', text })).toBeTruthy()
  }
  const wait = async (ms: number) => { await pane.advance(ms); clock += ms }
  await counts('time-agent-p1', '10s')
  await counts('span-wf_p', '10s')

  // Paused, agent 1's time stands still; the workflow goes on counting with agent 2.
  await pane.press({ key: 'gear-agent-p1' })
  await pane.press({ key: 'pause-agent-p1' })
  await wait(5000)
  await stands('time-agent-p1', '10s')
  await counts('time-agent-p2', '15s')
  await counts('span-wf_p', '15s')

  // With agent 2 paused as well, none works: the workflow's time stands still too.
  await pane.press({ key: 'gear-agent-p2' })
  await pane.press({ key: 'pause-agent-p2' })
  await wait(5000)
  await stands('time-agent-p2', '15s')
  await stands('span-wf_p', '15s')

  // Resumed, agent 1 and the workflow count on from where they stood.
  await pane.press({ key: 'gear-agent-p1' })
  await pane.press({ key: 'pause-agent-p1' })
  await wait(3000)
  await counts('time-agent-p1', '13s')
  await counts('span-wf_p', '18s')

  // Stopped, agent 2 stays at the time it had.
  await pane.press({ key: 'gear-agent-p2' })
  await pane.press({ key: 'stop-agent-p2' })
  await wait(2000)
  await stands('time-agent-p2', '15s')
  await counts('span-wf_p', '20s')

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

test('a setting from the pane turns purple only the cells it changed, and leaves the gear be', async ($, on) => {
  let n = 0
  on('clock.now', () => ({ value: 9_500_000 }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', () => ({ result: 'launched' }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `agent-h${++n}` }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: USAGE }
  })
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'toolu_h', input: { script: SCRIPT } })
  for (const index of [1, 2]) {
    await $.agent.spawn({
      tool_use_id: 'toolu_h', prompt: 'p', description: `investigate:part-${index}`, subagentType: 'general-purpose',
      provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false,
      workflow: { runId: 'wf_h', agentIndex: index },
    })
  }
  const step = async (agentId: string, index: number) => {
    const stream = $.turn.step({ turnId: `t-${agentId}`, index, model: 'claude-opus-5-5', effort: 'high', messageCount: 1, agentId })
    for await (const _ of stream) { /* drain */ }
    await stream.result
  }
  const props = { title: 'Workflows', isFocused: false, bodyColumns: 110 }
  const mount = (surface: typeof SURFACES[number]) =>
    $.ui.mount({ plugin: 'workflow-monitor', surface, component: 'Pane', requestId: 'workflow-monitor', props, viewport: { columns: 110, rows: 40 } })
  // The colors of the Texts that read `text`.
  const hues = async (pane: Awaited<ReturnType<typeof mount>>, text: string) =>
    (await pane.findAll({ text })).filter(x => x.type === 'Text').map(x => x.props.color)

  // The whole workflow's effort, set from its card.
  const term = await mount('terminal')
  await term.press({ key: 'gear-group-wf_h' })
  await term.select({ key: 'effort-group-wf_h', value: 'low' })
  await term.press({ key: 'done-group-wf_h' })
  await step('agent-h1', 0)
  await step('agent-h2', 0)
  await term.unmount()
  for (const surface of SURFACES) {
    const pane = await mount(surface)
    // The card's gear stays a plain gear.
    expect(await pane.find({ text: /◆/ })).toBeFalsy()
    expect((await pane.find({ key: 'gear-group-wf_h' }))?.props.label).toBe('⚙')
    // Once it applied, each agent's Effort is purple; its Model, left as it was, is not.
    expect(await hues(pane, 'Low')).toEqual(['merged', 'merged'])
    expect(await hues(pane, 'Opus 5.5')).toEqual([undefined, undefined])
    await pane.unmount()
  }

  // One agent's own model: its Model turns purple, its gear stays as it was.
  const term2 = await mount('terminal')
  await term2.press({ key: 'gear-agent-h1' })
  await term2.select({ key: 'model-agent-h1', value: 'claude-haiku-5-5' })
  await term2.press({ key: 'done-agent-h1' })
  await step('agent-h1', 1)
  await term2.unmount()
  for (const surface of SURFACES) {
    const pane = await mount(surface)
    expect((await pane.find({ key: 'gear-agent-h1' }))?.props.label).toBe('\u00a0⚙\u00a0')
    expect(await hues(pane, 'Haiku 5.5')).toEqual(['merged'])
    expect(await hues(pane, 'Opus 5.5')).toEqual([undefined])
    expect(await hues(pane, 'Low')).toEqual(['merged', 'merged'])
    await pane.unmount()
  }
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
    // Before its first step the agent has cost nothing yet, shown with two decimals.
    if (surface === 'terminal') expect(await pane.find({ text: /\$0\.00(?!\d)/ })).toBeTruthy()

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

  // The transcript pane redraws as the agent's activity streams in; its Pause and Stop stay put.
  const pane = await $.ui.mount({ plugin: 'workflow-monitor', surface: 'desktop', component: 'Pane', requestId: 'workflow-monitor', props, viewport: { columns: 110, rows: 40 } })
  await pane.press({ key: 'gear-agent-k' })
  await pane.press({ key: 'transcript-agent-k' })
  await pane.unmount()
  const inspect = await $.ui.mount({ plugin: 'workflow-monitor', surface: 'desktop', component: 'Pane', requestId: 'workflow-monitor-agent-agent-k', props, viewport: { columns: 110, rows: 40 } })
  const before = await inspect.drawn()
  const pause = handleOf(before, 'pause-agent-k')
  expect(typeof pause).toBe('number')
  await step(2)
  expect(await inspect.find({ text: /39\.0k tokens/ })).toBeTruthy()
  const after = await inspect.drawn()
  expect(after).not.toEqual(before)
  expect(handleOf(after, 'pause-agent-k')).toBe(pause)
  // And a press on it still runs: Pause, then Resume.
  await inspect.press({ key: 'pause-agent-k' })
  expect(await inspect.find({ text: /^Paus(ed|ing…)$/ })).toBeTruthy()
  expect((await inspect.find({ key: 'pause-agent-k' }))?.props.label).toBe('▶ Resume')
  await inspect.press({ key: 'pause-agent-k' })
  await inspect.unmount()
})

test('finished cards close to Archived, come back, and can be removed for good', async ($, on) => {
  let clock = 13_000_000
  let n = 0
  const closed: string[] = []
  on('clock.now', () => ({ value: (clock += 100) }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', (_$, e, next) => (closed.push(e.id), next(e)))
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
  // Over, it starts no more agents: its settings keep Archive and Remove alone, with no model or effort
  // to pick and so no Done; its gear closes them.
  await pane.press({ key: 'gear-group-wf_a' })
  expect(await has('archive-wf_a')).toBe(true)
  expect(await has('done-group-wf_a')).toBe(false)
  expect(await has('model-group-wf_a')).toBe(false)
  expect(await has('effort-group-wf_a')).toBe(false)
  expect(await pane.find({ text: /Model and effort apply/ })).toBeFalsy()
  await pane.press({ key: 'gear-group-wf_a' })
  expect(await has('archive-wf_a')).toBe(false)

  // Viewing one of its agents' transcripts, then removing the card: it leaves the monitor, and the
  // agent's transcript pane closes (one left open would show nothing of it).
  await pane.press({ key: 'fold-wf_a' })
  await pane.press({ key: 'gear-agent-a1' })
  await pane.press({ key: 'gear-group-wf_a' })
  await pane.press({ key: 'remove-wf_a' })
  expect(await has('fold-wf_a')).toBe(false)
  expect(await has('archived-toggle')).toBe(false)
  expect(closed).toEqual(['workflow-monitor-agent-agent-a1'])
  const inspect = await $.ui.mount({ plugin: 'workflow-monitor', surface: 'desktop', component: 'Pane', requestId: 'workflow-monitor-agent-agent-a1', props, viewport: { columns: 110, rows: 40 } })
  expect(await inspect.find({ text: /no longer in the monitor/ })).toBeTruthy()
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
  const titles: string[] = []
  on('clock.now', () => ({ value: (clock += 100) }))
  on('ui.open', (_$, e) => (titles.push(e.title ?? ''), { value: { isPlaced: true } }))
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

  // Archiving the card of the agent whose transcript is open leaves the pane on it (only Remove lets
  // go). The pane is titled with the agent's description, as Claude Code's own is.
  await pane.press({ key: 'gear-agent-s1' })
  expect(titles.at(-1)).toBe('investigate:part-1')
  await pane.press({ key: 'close-subagents' })
  const inspect = await $.ui.mount({ plugin: 'workflow-monitor', surface: 'desktop', component: 'Pane', requestId: 'workflow-monitor-agent-agent-s1', props, viewport: { columns: 110, rows: 40 } })
  expect(await inspect.find({ text: /no longer in the monitor/ })).toBeFalsy()
  expect(await inspect.find({ text: '✓ Completed' })).toBeTruthy()
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
  // Folded by a click on its header (its press region, on the desktop).
  await pane.post({ toggle: 'wf_r::Investigate' }, { in: 'hit-wf_r::Investigate' })
  expect(await has('cols-wf_r-Investigate')).toBe(false)
  await pane.press({ key: 'gear-group-wf_r' })
  await pane.select({ key: 'model-group-wf_r', value: 'claude-haiku-5-5' })
  await pane.press({ key: 'done-group-wf_r' })
  await finish('agent-s3')
  await pane.press({ key: 'gear-group-wf_r' })
  await pane.press({ key: 'remove-wf_r' })
  expect(await has('fold-wf_r')).toBe(false)
  await spawn(2, 'wf_r') // agent-s4
  expect(await has('fold-wf_r')).toBe(true)
  expect(await has('cols-wf_r-Investigate')).toBe(true)
  await pane.press({ key: 'gear-group-wf_r' })
  expect((await pane.find({ key: 'model-group-wf_r' }))?.props.value).toBe('inherit')
  await pane.press({ key: 'gear-group-wf_r' })
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
  on('process.run', NAP)
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
  // An agent's next tool call: a pause holds it there until resumed.
  const request = (agentId: string) => $.tool.call({ tool: 'Read', tool_use_id: `toolu_r_${agentId}`, input: { file_path: 'a' }, agentId })

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
  // How a card is framed: filled on the desktop, its corners rounded by a border in no color;
  // bordered on the terminal.
  const frame = async (key: string) => {
    const term = await mount(110, 'terminal')
    const t = (await term.find({ key: `card-${key}` }))?.props
    await term.unmount()
    const d = await card(key)
    return { fill: d?.backgroundColor, desktopBorder: `${d?.borderStyle} ${d?.borderColor}`, border: t?.borderColor, dim: t?.borderDimColor }
  }
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
  // Claude Code's own panel look: a "Running" heading, a "Phases" one, and a phase the script
  // names that started no agent yet, greyed, with no count and nothing to unfold.
  expect(await pane.find({ key: 'section-Running' })).toBeTruthy()
  expect(await pane.find({ key: 'section-Finished' })).toBeFalsy()
  expect(await pane.find({ text: 'Phases' })).toBeTruthy()
  expect(await pane.find({ key: 'phase-wf_c-Critique' })).toBeTruthy()
  expect(await pane.find({ key: 'fold-wf_c::Critique' })).toBeFalsy()
  expect(await pane.find({ key: 'count-wf_c::Critique' })).toBeFalsy()
  // Faint text is a fixed grey on the desktop, which draws dimColor almost as plain text.
  expect((await pane.findAll({ text: 'Running' })).some(x => x.type === 'Text' && x.props.color === '#8C929C')).toBe(true)
  expect((await pane.findAll({ text: 'Critique' })).some(x => x.type === 'Text' && x.props.color === '#8C929C')).toBe(true)
  // Unfolded, a phase's header is a padded, filled box, its corners rounded less than the card's
  // (a plain border, not a round one); its count and chevron are plain buttons alike, so they sit
  // level. The columns' headings are a grey fainter than the values.
  const head = async () => (await pane.find({ key: 'head-wf_c-Investigate' }))?.props
  // Its hover, which the drawn tree carries beside the props.
  type Drawn = { props?: { key?: string }; hover?: unknown; children?: unknown[] }
  const hoverOf = async (key: string) => {
    const walk = (n: unknown): Drawn | undefined => ((n as Drawn)?.props?.key === key ? n as Drawn
      : ((n as Drawn)?.children ?? []).map(walk).find(Boolean))
    return walk(await pane.drawn())?.hover
  }
  // What holds a node: the Box around it.
  const holderOf = async (p: typeof pane, key: string) => {
    type Node = { key?: string; props?: Record<string, unknown>; children?: unknown[] }
    const walk = (n: unknown): Node | undefined => {
      const kids = ((n as Node)?.children ?? []) as Node[]
      return kids.some(c => c?.props?.key === key) ? n as Node : kids.map(walk).find(Boolean)
    }
    return walk(await p.drawn())?.props
  }
  // As much air above and below as at the sides: a fraction of a row, a row being half a line.
  expect(await head()).toMatchObject({ backgroundColor: '#8080801f', paddingX: 1, paddingY: 0.4, borderStyle: 'single', borderColor: '#00000000' })
  expect(await hoverOf('head-wf_c-Investigate')).toBeUndefined()
  expect((await pane.findAll({ text: 'Tokens' })).some(x => x.type === 'Text' && x.props.color === '#8C929C')).toBe(true)
  // A click anywhere on the header folds it, through a see-through region laid over the whole
  // header; so its name, count and chevron are plain text, not buttons: the name flush with the
  // squares under it and the box's left edge, the count and chevron with its right edge.
  const hit = 'hit-wf_c::Investigate'
  for (const key of ['phase-', 'count-', 'fold-']) expect(await pane.find({ key: `${key}wf_c::Investigate` })).toBeFalsy()
  expect((await pane.findAll({ text: 'Investigate' })).some(x => x.type === 'Text' && x.props.color === undefined)).toBe(true)
  expect((await pane.findAll({ text: '0/5' })).some(x => x.type === 'Text' && x.props.dimColor)).toBe(true)
  expect((await pane.findAll({ text: '▾' })).some(x => x.type === 'Text' && x.props.dimColor)).toBe(true)
  expect(await holderOf(pane, hit)).toMatchObject({ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 })
  await pane.resize({ columns: 100, rows: 3, in: hit })
  const click = async (x: number, y: number, upY = y) => {
    await pane.pointer({ type: 'down', x, y, button: 'left', in: hit })
    await pane.pointer({ type: 'up', x, y: upY, button: 'left', in: hit })
  }
  // It folds to its header and squares, unfilled until the pointer is on it, its chevron turned,
  // and unfolds again.
  await click(60, 2)
  expect(await isOpen('wf_c')).toBe(false)
  expect(await pane.find({ key: 'bar-wf_c-Investigate' })).toBeTruthy()
  expect((await head())?.backgroundColor).toBeUndefined()
  expect(await hoverOf('head-wf_c-Investigate')).toEqual({ backgroundColor: '#8080801f' })
  expect((await pane.findAll({ text: '▸' })).some(x => x.type === 'Text' && x.props.dimColor)).toBe(true)
  await click(1, 0)
  expect(await isOpen('wf_c')).toBe(true)
  // The header's unfinished last row and column, past the whole cells the region counts, take it too.
  await click(100, 3)
  expect(await isOpen('wf_c')).toBe(false)
  await click(100, 3)
  expect(await isOpen('wf_c')).toBe(true)
  // A press dragged off the header (below, past its right edge, left of it), a release with no
  // press before it, another button, or a post naming no phase drawn or a card does nothing.
  await click(60, 1, 5)
  await pane.pointer({ type: 'down', x: 60, y: 1, button: 'left', in: hit })
  await pane.pointer({ type: 'up', x: 102, y: 1, button: 'left', in: hit })
  await pane.pointer({ type: 'down', x: 60, y: 1, button: 'left', in: hit })
  await pane.pointer({ type: 'up', x: -1, y: 1, button: 'left', in: hit })
  await pane.pointer({ type: 'up', x: 3, y: 1, button: 'left', in: hit })
  await pane.pointer({ type: 'down', x: 3, y: 1, button: 'right', in: hit })
  await pane.pointer({ type: 'up', x: 3, y: 1, button: 'right', in: hit })
  await pane.post({ toggle: 'wf_c::Nope' }, { in: hit })
  await pane.post({ toggle: 'wf_c' }, { in: hit })
  // (The card's own key would fold the card, its phases with it.)
  expect(await isOpen('wf_c')).toBe(true)
  // The table sits a little below its header.
  expect(await holderOf(pane, 'cols-wf_c-Investigate')).toMatchObject({ marginTop: 1 })
  // A row's button sits centred in a column wide enough for the desktop's native button.
  expect(await holderOf(pane, 'gear-agent-c1')).toMatchObject({ width: 6, justifyContent: 'center' })
  // A phase not started yet: its chevron faint, at the same right edge, and no region over it.
  expect((await pane.findAll({ text: '▸' })).some(x => x.type === 'Text' && x.props.color === '#8C929C')).toBe(true)
  expect(await pane.find({ key: 'hit-wf_c::Critique' })).toBeFalsy()
  // On the terminal: no fill, padding or border on the header, the headings dim, and the chevron in
  // the three-cell column of the rows' buttons.
  const plain = await mount(110, 'terminal')
  const plainHead = (await plain.find({ key: 'head-wf_c-Investigate' }))?.props
  expect(plainHead).toBeTruthy()
  expect([plainHead?.backgroundColor, plainHead?.borderStyle, plainHead?.paddingY]).toEqual([undefined, undefined, undefined])
  expect((await plain.findAll({ text: 'Tokens' })).some(x => x.type === 'Text' && x.props.dimColor)).toBe(true)
  expect((await plain.find({ key: 'count-wf_c::Investigate' }))?.props.label).toBe('0/5')
  expect((await plain.find({ key: 'fold-wf_c::Investigate' }))?.props.label).toBe(' ▾ ')
  expect(await holderOf(plain, 'fold-wf_c::Investigate')).toMatchObject({ width: 3, justifyContent: 'center' })
  // There the name, the count and the chevron are the buttons that fold it, no region lies over
  // the header, and the table follows it straight away.
  expect(await plain.find({ key: hit })).toBeFalsy()
  expect(await holderOf(plain, 'cols-wf_c-Investigate')).toMatchObject({ marginTop: 0 })
  for (const key of ['phase-', 'count-', 'fold-']) {
    await plain.press({ key: `${key}wf_c::Investigate` })
    expect(await isOpen('wf_c')).toBe(false)
    await plain.press({ key: `${key}wf_c::Investigate` })
    expect(await isOpen('wf_c')).toBe(true)
  }
  // Folded there, its chevron turns.
  await plain.press({ key: 'fold-wf_c::Investigate' })
  expect((await plain.find({ key: 'fold-wf_c::Investigate' }))?.props.label).toBe(' ▸ ')
  await plain.press({ key: 'fold-wf_c::Investigate' })
  await plain.unmount()

  // agent-c1..c5: two still working, one done, one failed, one stopped.
  await end('agent-c2', 'answer')
  await end('agent-c3', 'error')
  await end('agent-c4', 'aborted')

  // Working: the lead counts the working, then a mark for each other kind, at any width; the border is blue.
  expect(await chipOf(pane, 'wf_c')).toBe('● 2 · ✗ 1 · ⏹ 1 · ✓ 1')
  expect(await atWidths('wf_c')).toEqual(['●2 ✗1 ⏹1 ✓1', '●2 ✗1 ⏹1 ✓1'])
  expect(await frame('wf_c')).toEqual({ fill: '#80808014', desktopBorder: 'round #00000000', border: '#4D9DF0', dim: false })
  // A finished agent is grey, a done one's check too; a stopped one's square is an outline.
  expect((await pane.findAll({ text: '✓' })).some(x => x.type === 'Text' && x.props.color === '#8C929C')).toBe(true)
  expect((await pane.findAll({ text: 'investigate:part-2' })).some(x => x.type === 'Text' && x.props.dimColor)).toBe(true)
  expect(JSON.stringify((await pane.find({ key: 'bar-wf_c-Investigate' }))?.children ?? [])).toContain('fill=\\"none\\"')
  const term = await mount(110, 'terminal')
  expect(await term.find({ text: '□' })).toBeTruthy()
  await term.unmount()

  // Pausing them all: amber, and "…" until each is held at its next tool call.
  await pane.press({ key: 'gear-group-wf_c' })
  await pane.press({ key: 'pause-all-wf_c' })
  expect(await chipOf(pane, 'wf_c')).toBe('⏸ 2… · ✗ 1 · ⏹ 1 · ✓ 1')
  expect(await atWidths('wf_c')).toEqual(['⏸2… ✗1 ⏹1 ✓1', '⏸2… ✗1 ⏹1 ✓1'])
  expect(await frame('wf_c')).toEqual({ fill: '#80808014', desktopBorder: 'round #00000000', border: 'warning', dim: false })
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
  // Past an hour it gives the seconds too, as Claude Code's own panel does.
  await pane.advance(3_600_000)
  expect(await pane.find({ text: '1h 01m 05s', in: 'idle-wf_c' })).toBeTruthy()
  expect(await frame('wf_c')).toEqual({ fill: '#80808014', desktopBorder: 'round #00000000', border: undefined, dim: true })
  // Between phases it may start more agents: its settings, still open from Stop all, can set a model for them.
  await pane.select({ key: 'model-group-wf_c', value: 'claude-haiku-5-5' })
  expect(await pane.find({ text: /Model and effort apply to agents it starts later/ })).toBeTruthy()
  await pane.press({ key: 'done-group-wf_c' })

  // Its run's notification says it was stopped: that's the lead, the agents it had beside it.
  await notify('toolu_c', 'killed')
  expect(await chipOf(pane, 'wf_c')).toBe('⏹ 3 · ✗ 1 · ✓ 1')
  expect(await atWidths('wf_c')).toEqual(['⏹3 ✗1 ✓1', '⏹3 ✗1 ✓1'])
  // Over: no pickers.
  await pane.press({ key: 'gear-group-wf_c' })
  expect(await pane.find({ key: 'model-group-wf_c' })).toBeFalsy()
  expect(await pane.find({ key: 'archive-wf_c' })).toBeTruthy()
  expect(await pane.find({ key: 'done-group-wf_c' })).toBeFalsy()
  await pane.press({ key: 'gear-group-wf_c' })
  // Nor a phase still to come: it won't.
  expect(await pane.find({ key: 'phase-wf_c-Critique' })).toBeFalsy()

  // Resumed by a new call: how the last call ended no longer holds. The launch names the run, so
  // the new call's end counts though its agents carry no call.
  launches.toolu_c2 = { status: 'async_launched', taskId: 'bg_c2', runId: 'wf_c', workflowName: 'store-switch-design' }
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'toolu_c2', input: {} })
  expect(await chipOf(pane, 'wf_c')).toBe('○ · ✗ 1 · ⏹ 3 · ✓ 1')
  // Going again, the model it kept applies again, and shows, and so does the phase still to come.
  await pane.press({ key: 'gear-group-wf_c' })
  expect((await pane.find({ key: 'model-group-wf_c' }))?.props.value).toBe('claude-haiku-5-5')
  await pane.press({ key: 'gear-group-wf_c' })
  expect(await pane.find({ key: 'phase-wf_c-Critique' })).toBeTruthy()
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
  // With every card over, only the newest is unfolded, all of them under "Finished".
  expect(await pane.find({ key: 'section-Running' })).toBeFalsy()
  expect(await pane.find({ key: 'section-Finished' })).toBeTruthy()
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
      effort: (await pane.findAll({ text: 'Extra high' })).some(x => x.type === 'Text' && x.props.color === '#F0883E'),
      // Each agent's own cost, dim (the card's total is bold).
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
  expect(await at(75, 'desktop')).toEqual({ columns: true, ...all })
  expect(await at(72, 'terminal')).toEqual({ columns: true, ...all })
  // A column less and each agent goes on two lines, its effort and cost among the rest.
  expect(await at(74, 'desktop')).toEqual({ columns: false, ...all })
  expect(await at(71, 'terminal')).toEqual({ columns: false, ...all })
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

test('a pause outlasts a hook\'s 10-second budget, waiting on the host, and Resume lets go at once', { timeoutMs: 25_000 }, async ($, on) => {
  const ran: string[] = []
  const naps: (readonly string[])[] = []
  mock.env(on, { OS: 'Windows_NT' })
  on('clock.now', () => ({ value: 45_000_000 }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'agent-h' }))
  on('tool.call', (_$, e) => (ran.push(e.tool), { result: 'ok' }))
  // Each wait on the host: a child that sleeps, here two seconds of real time.
  on('process.run', async (_$, e) => {
    naps.push(e.argv)
    await new Promise(resolve => setTimeout(resolve, 2_000))
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.agent.spawn({
    tool_use_id: 'toolu_h', prompt: 'p', description: 'Long task', subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false,
  })
  const pane = await $.ui.mount({
    plugin: 'workflow-monitor', surface: 'terminal', component: 'Pane', requestId: 'workflow-monitor',
    props: { title: 'Workflows', isFocused: false, bodyColumns: 110 }, viewport: { columns: 110, rows: 40 },
  })
  await pane.press({ key: 'gear-agent-h' })
  await pane.press({ key: 'pause-agent-h' })
  let settled = false
  const held = $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_b', input: { command: 'npm test' }, agentId: 'agent-h' })
    .then(r => { settled = true; return r })
  // Past the budget the call is still held: a plain wait would have been cut there, and the tool run.
  await new Promise(resolve => setTimeout(resolve, 11_000))
  expect(settled).toBe(false)
  expect(ran).not.toContain('Bash')
  expect(naps.length).toBeGreaterThanOrEqual(5)
  expect(naps[0]).toEqual(['ping', '-n', '31', '127.0.0.1'])
  // Resume lets it go without waiting out the host's current wait.
  const resumedAt = Date.now()
  await pane.press({ key: 'pause-agent-h' })
  expect('deny' in (await held)).toBe(false)
  expect(Date.now() - resumedAt).toBeLessThan(1_500)
  expect(ran).toContain('Bash')
  await pane.unmount()
})

test('a pause that can\'t wait on the host is lifted, saying so, instead of seeming to hold', async ($, on) => {
  const ran: string[] = []
  const tried: (readonly string[])[] = []
  mock.env(on, { OS: 'Windows_NT' })
  on('clock.now', () => ({ value: 46_000_000 }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'agent-n' }))
  on('tool.call', (_$, e) => (ran.push(e.tool), { result: 'ok' }))
  // Neither way to wait will start.
  on('process.run', (_$, e) => {
    tried.push(e.argv)
    throw new Error(`spawn ${e.argv[0]} ENOENT`)
  })
  await $.agent.spawn({
    tool_use_id: 'toolu_n', prompt: 'p', description: 'Long task', subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false,
  })
  const props = { title: 'Workflows', isFocused: false, bodyColumns: 110 }
  const viewport = { columns: 110, rows: 40 }
  const pane = await $.ui.mount({ plugin: 'workflow-monitor', surface: 'terminal', component: 'Pane', requestId: 'workflow-monitor', props, viewport })
  await pane.press({ key: 'gear-agent-n' })
  await pane.press({ key: 'pause-agent-n' })
  const done = await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_nb', input: { command: 'npm test' }, agentId: 'agent-n' })
  expect('deny' in done).toBe(false)
  expect(ran).toContain('Bash')
  // Each way was tried twice, then the pause lifted: the pane no longer shows it paused.
  expect(tried.length).toBe(4)
  expect(tried[1]?.[0]).toBe('powershell')
  expect(await pane.find({ text: /pausing…/ })).toBeFalsy()
  await pane.press({ key: 'transcript-agent-n' })
  const view = await $.ui.mount({ plugin: 'workflow-monitor', surface: 'terminal', component: 'Pane', requestId: 'workflow-monitor-agent-agent-n', props, viewport })
  expect(await view.find({ text: /The pause couldn’t hold this agent/ })).toBeTruthy()
  await view.unmount()
  await pane.unmount()
})

test('agents it didn\'t see start join their cards: a stalled agent\'s retry, and ones running before it loaded', async ($, on) => {
  const clock = mock.clock(on, { now: 50_000_000 })
  let n = 0
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `agent-r${++n}` }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: USAGE }
  })
  on('turn.complete', () => ({ text: 'ok' }))
  // The session's files as Claude Code keeps them, in a folder beside its transcript.
  const dir = 'C:/u/.claude/projects/repo/sess'
  const files: Record<string, string> = { [`${dir}/workflows/scripts/fixes-wf_r.js`]: SCRIPT }
  const norm = (path: string) => path.replace(/\\/g, '/')
  const missing = (path: string): never => { throw new Error(`ENOENT: no such file, ${path}`) }
  on('fs.read', (_$, e) => (norm(e.path) in files ? { value: files[norm(e.path)] ?? '' } : missing(e.path)))
  on('fs.exists', (_$, e) => ({ value: norm(e.path) in files }))
  on('fs.stat', (_$, e) => (norm(e.path) in files
    ? { value: { kind: 'file' as const, size: 1, mtimeMs: clock.now(), isLink: false } }
    : missing(e.path)))
  on('fs.list', (_$, e) => {
    const at = `${norm(e.path)}/`
    const names = new Set(Object.keys(files).filter(p => p.startsWith(at)).map(p => p.slice(at.length).split('/')[0] ?? ''))
    const kind = (name: string) => (Object.keys(files).some(p => p.startsWith(`${at}${name}/`)) ? 'dir' as const : 'file' as const)
    return { value: [...names].map(name => ({ name, kind: kind(name), size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('tool.call', (_$, e) => ({
    result: e.tool === 'Workflow'
      ? { status: 'async_launched', runId: 'wf_r', workflowName: 'store-switch-design', scriptPath: 'C:\\u\\.claude\\projects\\repo\\sess\\workflows\\scripts\\fixes-wf_r.js' }
      : 'ok',
  }))
  const step = async (agentId: string) => {
    const stream = $.turn.step({ turnId: `t-${agentId}`, index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1, agentId })
    for await (const _ of stream) { /* read on */ }
  }
  const meta = (description: string) => JSON.stringify({ agentType: 'workflow-subagent', description, workflowPhase: 'Investigate', spawnDepth: 1 })
  const started = (agentId: string, key = 'v2:k1', label = 'investigate:payments') => JSON.stringify({ type: 'started', key, agentId, label, phase: 'Investigate' })
  const journal = (...lines: string[]) => [JSON.stringify({ type: 'launched' }), ...lines].join('\n') + '\n'

  // The run's launch names the session's folder; its first agent starts and makes a request.
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'toolu_r', input: {} })
  await $.agent.spawn({
    tool_use_id: 'toolu_r', prompt: 'p', description: 'investigate:payments', subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false,
    workflow: { runId: 'wf_r', agentIndex: 1 },
  })
  files[`${dir}/subagents/workflows/wf_r/agent-agent-r1.meta.json`] = meta('investigate:payments')
  files[`${dir}/subagents/workflows/wf_r/journal.jsonl`] = journal(started('agent-r1'))
  await step('agent-r1')

  // Twelve quiet minutes on, Claude Code starts the same agent() call again under a new id, with
  // no agent.spawn: the run's journal names both attempts.
  await clock.advance(12 * 60_000)
  files[`${dir}/subagents/workflows/wf_r/agent-agent-x2.meta.json`] = meta('investigate:payments')
  files[`${dir}/subagents/workflows/wf_r/journal.jsonl`] = journal(started('agent-r1'), started('agent-x2'))
  await step('agent-x2')

  const viewport = { columns: 110, rows: 60 }
  const props = { title: 'Workflows', isFocused: false, bodyColumns: 110 }
  const pane = await $.ui.mount({ plugin: 'workflow-monitor', surface: 'desktop', component: 'Pane', requestId: 'workflow-monitor', props, viewport })
  const mountInspect = (agent: string) => $.ui.mount({ plugin: 'workflow-monitor', surface: 'desktop', component: 'Pane', requestId: `workflow-monitor-agent-${agent}`, props, viewport })
  const shown = (node: unknown): string => (typeof node === 'string' ? node
    : ((node as { children?: unknown[] }).children ?? []).map(shown).join(''))
  const chip = async () => ((await pane.find({ key: 'status-wf_r' }))?.children ?? []).map(shown).filter(Boolean).join(' ')

  // The retry joins the first attempt's card, and that attempt is over; its row says nothing more.
  expect(await pane.find({ text: /investigate:payments \(retry 1\)/ })).toBeTruthy()
  expect(await chip()).toBe('● 1 · ⏹ 1')
  expect(await pane.find({ text: /Ended by Claude Code/ })).toBeFalsy()

  // Its transcript says what happened, and so does the retry's.
  await pane.press({ key: 'gear-agent-r1' })
  let view = await mountInspect('agent-r1')
  expect(await view.find({ text: 'Ended by Claude Code after 12m 00s without progress; retried as “investigate:payments (retry 1)”.' })).toBeTruthy()
  await view.unmount()
  // Its own end, reported later, changes none of that.
  await $.turn.complete({ answer: '', durationMs: 1000, isAborted: true, turnId: 't-agent-r1', agentId: 'agent-r1', reason: 'aborted' })
  view = await mountInspect('agent-r1')
  expect(await view.find({ text: /after 12m 00s without progress; retried as “investigate:payments \(retry 1\)”/ })).toBeTruthy()
  await view.unmount()
  await pane.press({ key: 'gear-agent-x2' })
  await pane.press({ key: 'transcript-agent-x2' })
  view = await mountInspect('agent-x2')
  expect(await view.find({ text: 'Started by Claude Code after “investigate:payments” made no progress.' })).toBeTruthy()
  await view.unmount()

  // A retry of a paused attempt is paused too. That attempt made its request just now, so no quiet
  // time is told.
  await pane.press({ key: 'pause-agent-x2' })
  files[`${dir}/subagents/workflows/wf_r/agent-agent-x3.meta.json`] = meta('investigate:payments')
  files[`${dir}/subagents/workflows/wf_r/journal.jsonl`] = journal(started('agent-r1'), started('agent-x2'), started('agent-x3'))
  await step('agent-x3')
  expect(await pane.find({ text: /investigate:payments \(retry 2\)/ })).toBeTruthy()
  expect(await chip()).toBe('⏸ 1… · ⏹ 2')
  await pane.press({ key: 'gear-agent-x2' })
  view = await mountInspect('agent-x2')
  expect(await view.find({ text: 'Ended by Claude Code; retried as “investigate:payments (retry 2)”.' })).toBeTruthy()
  await view.unmount()

  // Its pause still reaches the retry when the stalled attempt's end is reported first.
  await clock.advance(11 * 60_000)
  await $.turn.complete({ answer: '', durationMs: 1000, isAborted: true, turnId: 't-agent-x3', agentId: 'agent-x3', reason: 'aborted' })
  files[`${dir}/subagents/workflows/wf_r/agent-agent-x4.meta.json`] = meta('investigate:payments')
  files[`${dir}/subagents/workflows/wf_r/journal.jsonl`] = journal(started('agent-r1'), started('agent-x2'), started('agent-x3'), started('agent-x4'))
  await step('agent-x4')
  expect(await pane.find({ text: /investigate:payments \(retry 3\)/ })).toBeTruthy()
  expect(await chip()).toBe('⏸ 1… · ⏹ 3')
  await pane.press({ key: 'gear-agent-x3' })
  view = await mountInspect('agent-x3')
  expect(await view.find({ text: 'Ended by Claude Code after 11m 00s without progress; retried as “investigate:payments (retry 3)”.' })).toBeTruthy()
  await view.unmount()

  // Agents already running when it loaded join at their next request: a plain subagent, and a
  // workflow agent whose run it names from the saved script.
  files[`${dir}/subagents/agent-agent-p1.meta.json`] = JSON.stringify({ agentType: 'Explore', description: 'Map the checkout module', toolUseId: 'toolu_p' })
  files[`${dir}/subagents/workflows/wf_old/agent-agent-o1.meta.json`] = meta('critique:legacy')
  files[`${dir}/subagents/workflows/wf_old/journal.jsonl`] = journal(started('agent-o1', 'v2:o1', 'critique:legacy'))
  files[`${dir}/workflows/scripts/legacy-audit-wf_old.js`] = SCRIPT.replace('store-switch-design', 'legacy-audit')
  await step('agent-p1')
  await step('agent-o1')
  // One it finds nothing about (the engine's own forks) is left be.
  await step('fork-1')
  expect(await pane.find({ text: /Map the checkout module/ })).toBeTruthy()
  expect(await pane.find({ text: /legacy-audit/ })).toBeTruthy()
  expect(await pane.find({ text: /critique:legacy/ })).toBeTruthy()
  expect(await pane.find({ text: /fork-1/ })).toBeFalsy()

  // A background subagent started again joins its first attempt too, by the Agent call they share.
  files[`${dir}/subagents/agent-agent-p2.meta.json`] = JSON.stringify({ agentType: 'Explore', description: 'Map the checkout module', toolUseId: 'toolu_p' })
  await step('agent-p2')
  expect(await pane.find({ text: /Map the checkout module \(retry 1\)/ })).toBeTruthy()
  await pane.unmount()
})

test('Inspect reads an agent\'s own transcript, as Claude Code\'s own view draws it; its phase is the one it ran in', async ($, on) => {
  const clock = mock.clock(on, { now: 60_000_000 })
  let n = 0
  const titles: string[] = []
  const opened: string[] = []
  const closed: string[] = []
  on('ui.open', (_$, e) => (titles.push(e.title ?? ''), opened.push(e.id), { value: { isPlaced: true } }))
  on('ui.close', (_$, e, next) => (closed.push(e.id), next(e)))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `agent-t${++n}` }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: USAGE }
  })
  // The session's files as Claude Code keeps them (see the test on agents it didn't see start).
  const dir = 'C:/u/.claude/projects/repo/sess'
  const files: Record<string, string> = {}
  // A file said to be bigger than it is here, past what fs.read takes: only the host's own reader
  // reads it, and it comes in pieces.
  const sizes: Record<string, number> = {}
  const norm = (path: string) => path.replace(/\\/g, '/')
  const missing = (path: string): never => { throw new Error(`ENOENT: no such file, ${path}`) }
  const tooBig = (path: string): never => { throw new Error(`EFBIG: file over 4 MiB, ${path}`) }
  on('fs.read', (_$, e) => (!(norm(e.path) in files) ? missing(e.path)
    : (sizes[norm(e.path)] ?? 0) > 4 * 1024 * 1024 ? tooBig(e.path)
    : { value: files[norm(e.path)] ?? '' }))
  on('fs.exists', (_$, e) => ({ value: norm(e.path) in files }))
  on('fs.stat', (_$, e) => (norm(e.path) in files
    ? { value: { kind: 'file' as const, size: sizes[norm(e.path)] ?? files[norm(e.path)]?.length ?? 0, mtimeMs: clock.now(), isLink: false } }
    : missing(e.path)))
  on('fs.list', () => ({ value: [] }))
  const streamed: string[] = []
  on('process.spawn', async function* (_$, e) {
    const path = norm(e.argv.at(-1) ?? '')
    streamed.push(path)
    const text = files[path]
    if (text === undefined) return { value: { code: 1, signal: null } }
    yield { stream: 'stdout' as const, text: text.slice(0, 7) }
    yield { stream: 'stdout' as const, text: text.slice(7) }
    return { value: { code: 0, signal: null } }
  })
  on('tool.call', (_$, e) => ({
    result: e.tool === 'Workflow'
      ? { status: 'async_launched', runId: 'wf_t', workflowName: 'native-transcript-spec', scriptPath: `${dir}/workflows/scripts/native-transcript-spec-wf_t.js` }
      : 'ok',
  }))
  // A plain subagent's transcript the session hands over.
  on('session.messages', (_$, e) => (e.agentId === 'agent-t2'
    ? {
      value: [
        { role: 'user' as const, text: 'Review the diff.', toolUses: [] },
        { role: 'assistant' as const, text: '', toolUses: [{ tool_use_id: 'h1', tool: 'Bash', input: { command: 'git diff' }, text: 'diff' }] },
        { role: 'assistant' as const, text: '', toolUses: [{ tool_use_id: 'h2', tool: 'SubagentHandback', input: { message: 'No **defects** found.' }, text: 'ok' }] },
      ],
    }
    : { value: { deny: `no transcript for ${e.agentId}` } }))

  // A run whose script names one phase, Extract, and an agent of it named spec:view, which Claude
  // Code's meta says runs in Extract.
  files[`${dir}/workflows/scripts/native-transcript-spec-wf_t.js`] = `export const meta = {
  name: 'native-transcript-spec',
  description: 'Extract the native layout',
  phases: [{ title: 'Extract' }],
}
phase('Extract')`
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'toolu_t', input: {} })
  files[`${dir}/subagents/workflows/wf_t/agent-agent-t1.meta.json`] = JSON.stringify({ agentType: 'workflow-subagent', description: 'spec:view', workflowPhase: 'Extract' })
  await $.agent.spawn({
    tool_use_id: 'toolu_t', prompt: 'p', description: 'spec:view', subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false,
    workflow: { runId: 'wf_t', agentIndex: 1 },
  })
  const viewport = { columns: 110, rows: 60 }
  const props = { title: 'Workflows', isFocused: false, bodyColumns: 110 }
  const pane = await $.ui.mount({ plugin: 'workflow-monitor', surface: 'desktop', component: 'Pane', requestId: 'workflow-monitor', props, viewport })
  // It sits under Extract, started (its header takes a click), not under a "Spec" of its label's.
  expect(await pane.find({ key: 'head-wf_t-Extract' })).toBeTruthy()
  expect(await pane.find({ key: 'hit-wf_t::Extract' })).toBeTruthy()
  expect(await pane.find({ key: 'head-wf_t-Spec' })).toBeFalsy()
  // The region that takes the header's click is there only under the pointer: a desktop draws a
  // Client's fault in its region, which at rest would cover the phase's name.
  type Node = { key?: string; props?: Record<string, unknown>; hover?: Record<string, unknown>; children?: unknown[] }
  const around = (n: unknown, key: string): Node | undefined => {
    const kids = ((n as Node)?.children ?? []) as Node[]
    return kids.some(c => c?.key === key || c?.props?.key === key) ? n as Node : kids.map(c => around(c, key)).find(Boolean)
  }
  const region = around(await pane.drawn(), 'hit-wf_t::Extract')
  expect(region?.props).toMatchObject({ position: 'absolute', display: 'none' })
  expect(region?.hover ?? region?.props?.hover).toMatchObject({ display: 'flex' })
  // Its time counts on the surface while it works.
  expect(await pane.find({ key: 'time-agent-t1' })).toBeTruthy()

  // Its transcript file: the harness's relay of the person's request and a reminder, which aren't
  // its prompt; the computed task, which is (indented by the harness); then its work.
  const prompt = `Find the native strings.\n\n${'Read the bundles. '.repeat(80).trim()}`
  const line = (type: string, content: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ type, ...extra, message: { role: type, content } })
  const use = (id: string, name: string, input: Record<string, unknown>) => line('assistant', [{ type: 'tool_use', id, name, input }])
  const result = (id: string, isError = false) => line('user', [{ type: 'tool_result', tool_use_id: id, content: 'out', is_error: isError }])
  const path = `${dir}/subagents/workflows/wf_t/agent-agent-t1.jsonl`
  const write = (...lines: string[]) => { files[path] = [...lines, ''].join('\n') }
  const work = [
    line('user', '[Workflow harness — user request] The harness relays the request:\n  Make it look native.'),
    line('user', `[Workflow harness — computed task] The computed task text follows:\n${prompt.split('\n').map(l => `  ${l}`).join('\n')}`),
    line('user', '<system-reminder>\nReport through StructuredOutput.\n</system-reminder>', { isMeta: true }),
    line('assistant', [{ type: 'thinking', thinking: '', signature: 's' }]),
    use('u1', 'Bash', { command: 'ls', description: 'List the bundles' }), result('u1'),
    use('u2', 'Bash', { command: 'grep -c x f.js' }), result('u2', true),
    line('assistant', [{ type: 'text', text: 'Found the **strings**.' }]),
    line('assistant', [{ type: 'text', text: 'Kept in C:/Users/IVANPA~1/a and C:/Users/IVANPA~1/b, ~~not~~ in `~/x`.\n\n```\n~/y\n```' }]),
    use('u3', 'Read', { file_path: 'C:/b/f_01.js' }), result('u3'),
    use('u4', 'Edit', { file_path: 'C:/b/f_01.js', old_string: 'a', new_string: 'b' }), result('u4'),
    use('u5', 'mcp__docs__search_pages', { query: 'transcript' }),
  ]
  // At first only its first run, its last call failed: not said while the run may go on.
  write(...work.slice(0, 8))
  await pane.press({ key: 'gear-agent-t1' })
  await pane.press({ key: 'transcript-agent-t1' })
  expect(titles.at(-1)).toBe('spec:view')
  const view = await $.ui.mount({ plugin: 'workflow-monitor', surface: 'desktop', component: 'Pane', requestId: 'workflow-monitor-agent-agent-t1', props, viewport })
  const md = async (v = view) => (await v.findAll({ type: 'Markdown' })).map(x => x.props.text as string)
  const label = async (key: string, v = view) => (await v.find({ key }))?.props.label
  expect(await label('steps-agent-t1:u1')).toBe('Ran 2 commands ▸')
  // The rest of its work, drawn at the next redraw (a press below).
  write(...work)
  // Its model and effort; Pause and Stop while it runs.
  expect(await view.find({ text: 'Opus 5.5' })).toBeTruthy()
  expect(await view.find({ key: 'stop-agent-t1' })).toBeTruthy()
  // The prompt, un-indented, cut to a dozen lines past 1200 characters until Show more.
  expect((await md())[0]).toBe(prompt)
  expect((await md()).some(t => t.includes('Make it look native') || t.includes('StructuredOutput'))).toBe(false)
  expect((await view.find({ key: 'prompt-body' }))?.props).toMatchObject({ height: 24, overflow: 'hidden' })
  expect(await label('more-agent-t1')).toBe('Show more')
  await view.press({ key: 'more-agent-t1' })
  expect((await view.find({ key: 'prompt-body' }))?.props.height).toBeUndefined()
  expect(await label('more-agent-t1')).toBe('Show less')
  await view.press({ key: 'more-agent-t1' })
  // Each run of tool calls in a line, worded as Claude Code's own (a failed last call said, its run
  // over); its reply between them; files touched alike counted as one; tools of no kind it names last.
  expect(await label('steps-agent-t1:u1')).toBe('Ran 2 commands (a tool failed) ▸')
  expect(await md()).toContain('Found the **strings**.')
  // A lone `~`, as in a Windows short path, is no strikethrough mark: escaped, but not in a pair
  // or in code, where an escape would show.
  expect(await md()).toContain('Kept in C:/Users/IVANPA\\~1/a and C:/Users/IVANPA\\~1/b, ~~not~~ in `~/x`.\n\n```\n~/y\n```')
  expect(await label('steps-agent-t1:u3')).toBe('Read and edited f_01.js, used a tool ▸')
  // Unfolded, a line a call: what it did, to what, and whether it failed.
  await view.press({ key: 'steps-agent-t1:u1' })
  expect(await view.find({ text: /^List the bundles$/ })).toBeTruthy()
  expect(await view.find({ text: /^grep -c x f\.js \(failed\)$/ })).toBeTruthy()
  await view.press({ key: 'steps-agent-t1:u1' })
  expect(await view.find({ text: /List the bundles/ })).toBeFalsy()
  // What it does now, the call still waiting on its result; and its totals.
  expect(await view.find({ text: 'Using search pages…' })).toBeTruthy()
  expect(await view.find({ text: /^5 tool calls · 0 tokens · $/ })).toBeTruthy()

  // It answers through StructuredOutput and ends: its answer after its work, how it ended, no
  // Pause or Stop, and nothing doing.
  await clock.advance(5000)
  write(...work, result('u5'), use('u6', 'StructuredOutput', { summary: 'ok', strings: ['Show more'] }), result('u6'))
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't-agent-t1', agentId: 'agent-t1', reason: 'answer' })
  expect(await label('steps-agent-t1:u3')).toBe('Read and edited f_01.js, used 2 tools ▸')
  // A field of text read as markdown under its name, anything else as JSON.
  expect((await md()).at(-1)).toBe('**summary**\n\nok\n\n**strings**\n\n```json\n[\n  "Show more"\n]\n```')
  expect(await view.find({ text: '✓ Completed' })).toBeTruthy()
  expect(await view.find({ key: 'stop-agent-t1' })).toBeFalsy()
  expect(await view.find({ text: /…$/ })).toBeFalsy()
  expect(await view.find({ text: /^6 tool calls · / })).toBeTruthy()
  // A time that no longer counts is plain text, here and in its row: no Client to fault.
  expect(await view.find({ key: 'footer-time-agent-t1' })).toBeFalsy()
  expect(await pane.find({ key: 'time-agent-t1' })).toBeFalsy()

  // A plain subagent's transcript, which the session hands over: its report handed back through a
  // tool is its answer, and that call counts among its tools.
  await $.agent.spawn({
    tool_use_id: 'toolu_p', prompt: 'p', description: 'Review the diff', subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false,
  })
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't-agent-t2', agentId: 'agent-t2', reason: 'answer' })
  // (A finished card comes folded.) It opens in a pane of its own, beside the first agent's, which
  // stays on that agent; Inspect on an agent whose pane is open reuses that pane.
  await pane.press({ key: 'fold-subagents' })
  await pane.press({ key: 'gear-agent-t2' })
  expect(titles.at(-1)).toBe('Review the diff')
  expect(opened.at(-1)).toBe('workflow-monitor-agent-agent-t2')
  const other = await $.ui.mount({ plugin: 'workflow-monitor', surface: 'desktop', component: 'Pane', requestId: 'workflow-monitor-agent-agent-t2', props, viewport })
  expect(await md(other)).toEqual(['Review the diff.', 'No **defects** found.'])
  expect(await label('steps-agent-t2:h1', other)).toBe('Ran a command, used a tool ▸')
  expect(await other.find({ text: /No result/ })).toBeFalsy()
  expect(await label('steps-agent-t1:u3')).toBe('Read and edited f_01.js, used 2 tools ▸')
  await pane.press({ key: 'gear-agent-t1' })
  expect(opened.at(-1)).toBe('workflow-monitor-agent-agent-t1')

  // Removing the card closes its agents' panes and forgets what was unfolded in their transcripts;
  // the other agent's pane stays.
  await other.press({ key: 'steps-agent-t2:h1' })
  expect(await label('steps-agent-t2:h1', other)).toBe('Ran a command, used a tool ▾')
  await pane.press({ key: 'gear-group-subagents' })
  await pane.press({ key: 'remove-subagents' })
  expect(closed).toEqual(['workflow-monitor-agent-agent-t2'])
  expect(await other.find({ text: /no longer in the monitor/ })).toBeTruthy()
  expect(await view.find({ text: '✓ Completed' })).toBeTruthy()
  await other.unmount()
  await view.unmount()

  // An agent whose meta isn't written yet as it starts goes by its label until a request of its
  // finds the meta there.
  await $.agent.spawn({
    tool_use_id: 'toolu_t', prompt: 'p', description: 'spec:groups', subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false,
    workflow: { runId: 'wf_t', agentIndex: 2 },
  })
  expect(await pane.find({ key: 'head-wf_t-Spec' })).toBeTruthy()
  files[`${dir}/subagents/workflows/wf_t/agent-agent-t3.meta.json`] = JSON.stringify({ agentType: 'workflow-subagent', description: 'spec:groups', workflowPhase: 'Extract' })
  for await (const _ of $.turn.step({ turnId: 't-agent-t3', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1, agentId: 'agent-t3' })) { /* read on */ }
  expect(await pane.find({ key: 'head-wf_t-Spec' })).toBeFalsy()
  expect(await pane.find({ key: 'head-wf_t-Extract' })).toBeTruthy()

  // Its transcript is past fs.read's 4 MiB: the host's own reader reads it. It ends on a reply, but
  // the run failed it (no result returned to its script): a reply isn't an answer then.
  const big = `${dir}/subagents/workflows/wf_t/agent-agent-t3.jsonl`
  files[big] = [
    line('user', '[Workflow harness — computed task] Group the strings:\n  Sort them by pane.'),
    line('assistant', [{ type: 'text', text: 'I could not sort them.' }]),
  ].join('\n')
  sizes[big] = 5 * 1024 * 1024
  await $.turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 't-agent-t3', agentId: 'agent-t3', reason: 'error' })
  // (A finished row's ↗ opens its transcript.)
  await pane.press({ key: 'gear-agent-t3' })
  const failed = await $.ui.mount({ plugin: 'workflow-monitor', surface: 'desktop', component: 'Pane', requestId: 'workflow-monitor-agent-agent-t3', props, viewport })
  expect(streamed).toContain(big)
  expect((await failed.findAll({ type: 'Markdown' })).map(x => x.props.text)).toEqual(['Sort them by pane.', 'I could not sort them.'])
  expect(await failed.find({ text: 'No result — task failed' })).toBeTruthy()
  await failed.unmount()
  await pane.unmount()
})
