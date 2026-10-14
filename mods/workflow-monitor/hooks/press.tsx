import type { ClientModule } from 'claude-code'

// A see-through region laid over a phase's header on the desktop, so a click anywhere on the
// header folds or unfolds the phase, not just one on its name, count or chevron: it posts the
// phase's id to the hooks module (see the `ui.message` hook), which folds it as the chevron does.
//
// `id` is the phase's fold key, `<group>::<phase>`.
type Props = { id: string }

// Instances a left button went down in: a press counts once it comes up inside the same region,
// as a button's click does, so one dragged in from elsewhere or out of it does nothing.
const armed = new WeakSet<object>()

// Inside the region, in cells. `columns` and `rows` count whole cells, and the header is rarely a
// whole number of them (its padding, the squares drawn in pixels): the cell just past the last
// whole one is its unfinished edge, so it counts too.
const inside = (x: number, y: number, s: { columns: number; rows: number }) =>
  x >= 0 && y >= 0 && x <= s.columns && y <= s.rows

// Taller than any header: the region clips it, and so fills the header to its bottom edge (the
// instance is as tall as what it draws, up to its region).
const ROWS = 40

const Press: ClientModule<Props> = (props, surface) => {
  const { Box } = surface.elements
  surface.onPointer(e => {
    if (e.button !== 'left') return
    if (e.type === 'down') armed.add(surface)
    else if (e.type === 'up' && armed.delete(surface) && inside(e.x, e.y, surface)) surface.post({ toggle: props.id })
  })
  return <Box height={ROWS} />
}

export default Press
