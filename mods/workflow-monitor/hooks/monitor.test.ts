import { expect, test } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const
const USAGE = { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 10000, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' }
const SCRIPT = `export const meta = {
  name: 'store-switch-design',
  description: 'Investigate and design fixes',
  phases: [{ title: 'Investigate' }, { title: 'Critique' }],
}
phase('Investigate')`

test('tracks a workflow agent, draws it in its phase, and applies a model/effort override', async ($, on) => {
  let n = 0
  let clock = 1_000_000
  const sent: { model: string; effort?: unknown }[] = []
  on('clock.now', () => ({ value: (clock += 500) }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `agent-${++n}` }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', () => ({ result: 'launched' }))
  on('turn.step', async function* (_$, e) {
    sent.push({ model: e.model, effort: e.effort })
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
    for await (const _ of stream) { /* drain */ }
    await stream.result
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

  // Open agent 2's editor and pick Haiku 5.5 at low effort; its next request uses them.
  const pane = await $.ui.mount({ plugin: 'workflow-monitor', surface: 'terminal', component: 'Pane', requestId: 'workflow-monitor', props, viewport })
  await pane.press({ key: 'gear-agent-2' })
  await $.ui.select({ plugin: 'workflow-monitor', key: 'model-agent-2', value: 'claude-haiku-5-5' })
  await $.ui.select({ plugin: 'workflow-monitor', key: 'effort-agent-2', value: 'low' })
  await step('agent-2', 0)
  expect(sent.at(-1)).toEqual({ model: 'claude-haiku-5-5', effort: 'low' })
  expect(sent[0]).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
  expect(await pane.find({ text: 'Haiku 5.5' })).toBeTruthy()
  await pane.unmount()
})
