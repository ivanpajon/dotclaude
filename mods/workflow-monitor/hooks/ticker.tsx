import type { ClientModule, ClientSurface } from 'claude-code'

// An elapsed time that counts up on the surface by itself, so the pane isn't redrawn every
// second to move it: it redraws only when something changes.
//
// `base` is the elapsed time when the mod last drew; `rate` is how many seconds it gains per
// second: 1 for a running agent or workflow, the running count for a sum, 0 once finished.
type Props = { base: number; rate: number; dim?: boolean }
// Seconds counted since the figure `base` arrived; a count for an older figure is ignored.
type State = { base: number; ticks: number }

// Per instance: the figure its timer counts from, and how to stop that timer.
const counting = new WeakMap<object, { base: number; rate: number; stop: () => void }>()

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`
}

// A new figure from the mod restarts the count: a fresh timer that tags every count with its
// figure. The state is only ever written from the timer, never while drawing.
function countFrom(surface: ClientSurface<State>, base: number, rate: number) {
  const was = counting.get(surface)
  if (was && was.base === base && was.rate === rate) return
  was?.stop()
  let ticks = 0
  const stop = rate > 0 ? surface.every(1000, () => surface.setState({ base, ticks: ++ticks })) : () => {}
  counting.set(surface, { base, rate, stop })
}

const Ticker: ClientModule<Props, State> = (props, surface) => {
  const { Text } = surface.elements
  countFrom(surface, props.base, props.rate)
  const s = surface.state
  const ticks = s && s.base === props.base ? s.ticks : 0

  return <Text dimColor={props.dim}>{duration(props.base + ticks * 1000 * props.rate)}</Text>
}

export default Ticker
