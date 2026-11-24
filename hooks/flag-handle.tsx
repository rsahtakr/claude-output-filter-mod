/**
 * The drag handle of a flag or a highlight row in the Flags pane: the grip
 * that moves an entry up or down the list.
 *
 * The handle is a surface module (a `Client`): it runs on the drawing thread,
 * with no `$` of its own, so what it learns of a drag it posts to the hooks
 * module, which moves the entry and writes the new order.
 *
 * A drag: the pointer goes down on the grip, the person moves it over the
 * rows, and the handle shows the row offset (`↕+2`, `↕-1`) while the drag is
 * on. The pointer comes up and the handle posts the move, unless the flag
 * ended on the row it started from.
 *
 * The keys: once a click has given the handle the focus, ctrl+n moves the
 * flag down and ctrl+p moves it up, and so do shift+down and shift+up.
 *
 * The grip also removes: two presses on it, soon after one another and
 * without a row offset between them, ask whether the entry is removed. The
 * handle posts that ask, and the pane draws the question (D21).
 *
 * Pure of the mod's own state: the handle knows the id of the entry it moves
 * and nothing else.
 */
import type { ClientKeyEvent, ClientModule, ClientPointerEvent, ClientSurface } from 'claude-code'

/**
 * What the handle remembers while the person drags it.
 *
 * The rows are the pane's rows, counted from its top; -1 stands for "no drag
 * on" in both.
 */
export type DragState = {
  /** The id of the entry this handle moves. */
  id: string
  /** The row the pointer went down on; -1 while no drag is on. */
  from: number
  /** The row the pointer is on now; -1 while no drag is on. */
  to: number
  /**
   * The time of the press that began the current double-press window, in
   * milliseconds; absent while no window is open.
   */
  pressedAt?: number
}

/** The grip the handle shows while no drag is on. */
const GRIP = '⠿'

/** The mark the handle shows while a drag is on. */
const DRAG = '↕'

/**
 * The largest row offset the handle shows, so that the mark (three cells:
 * the sign and two digits) fits the region the pane gives it.
 */
const MAX_SHOWN_OFFSET = 9

/**
 * The window within which two presses on the grip are one double press.
 */
const DOUBLE_PRESS_MS = 400

/**
 * The handle: the grip of one flag or highlight row.
 *
 * The listeners are set once, while the instance has no state yet. The id is
 * fixed by the handle's key (`drag:<id>`), so the one captured then is the
 * id of every later event.
 */
const Handle: ClientModule<{ id: string }, DragState> = (props, surface) => {
  const { Text } = surface.elements

  if (surface.state === undefined) {
    const id = props.id

    surface.onPointer(event => onPointer(event, id, surface))
    surface.onKey(event => onKey(event, id, surface))
  }

  const drag = surface.state

  if (drag === undefined || drag.from < 0) {
    return <Text dimColor>{GRIP}</Text>
  }

  return <Text>{offsetMark(drag.to - drag.from)}</Text>
}

/**
 * The mark the handle shows while a drag is on: the arrow and the row offset.
 *
 * @param by The rows the flag moves: down is positive.
 * @returns The mark, three cells at most.
 */
function offsetMark(by: number): string {
  const shown = Math.max(-MAX_SHOWN_OFFSET, Math.min(MAX_SHOWN_OFFSET, by))
  const sign = shown >= 0 ? '+' : ''

  return `${DRAG}${sign}${shown}`
}

/**
 * What the handle does with a pointer over it.
 *
 * A drag is the pointer going down, moving over the rows and coming up: the
 * row it goes down on is remembered, and the move posts the rows the flag
 * moves. The pointer capture the surface gives the instance keeps every move
 * reaching it, past the edges of the region too.
 *
 * Two presses on the grip, soon after one another and with no row offset
 * between them, are a double press: the handle asks whether the entry is
 * removed, and posts that ask.
 *
 * @param event  The pointer event.
 * @param id     The id of the flag the handle moves.
 * @param surface The handle's surface, whose state it keeps.
 */
function onPointer(event: ClientPointerEvent, id: string, surface: ClientSurface<DragState>): void {
  const drag = surface.state

  if (event.type === 'down') {
    // Only the left button drags; the others (a middle click, a right click
    // for a paste) are the terminal's own.
    if (event.button !== undefined && event.button !== 'left') {
      return
    }

    const now = Date.now()

    // The second press of a double press: the window of the first is still
    // open, so the entry is asked about instead of dragged.
    if (drag !== undefined && drag.pressedAt !== undefined && now - drag.pressedAt <= DOUBLE_PRESS_MS) {
      surface.setState({ id, from: -1, to: -1 })

      surface.post({ confirm: id })

      return
    }

    surface.setState({ id, from: event.y, to: event.y, pressedAt: now })

    return
  }

  if (event.type === 'move') {
    if (drag === undefined || drag.from < 0) {
      return
    }

    surface.setState({ id: drag.id, from: drag.from, to: event.y })

    return
  }

  if (event.type === 'up') {
    if (drag === undefined || drag.from < 0) {
      return
    }

    // The row the drag ended on: the last row a move reported, or the row the
    // pointer came up on when no move was reported.
    const row = drag.to === drag.from ? event.y : drag.to
    const by = row - drag.from

    // A drag that moved ends the double-press window: the two presses were
    // not one double press.
    surface.setState({ id: drag.id, from: -1, to: -1, pressedAt: by === 0 ? drag.pressedAt : undefined })

    if (by !== 0) {
      surface.post({ move: drag.id, by })
    }
  }
}

/**
 * What the handle does with a key, once a click has given it the focus.
 *
 * ctrl+n and ctrl+p move the flag down and up, and so do shift+down and
 * shift+up.
 *
 * @param event   The key event.
 * @param id      The id of the flag the handle moves.
 * @param surface The handle's surface, which it posts to.
 */
function onKey(event: ClientKeyEvent, id: string, surface: ClientSurface<DragState>): void {
  const drag = surface.state
  const target = drag === undefined ? id : drag.id

  if (event.ctrl === true && event.key === 'n') {
    surface.post({ move: target, by: 1 })

    return
  }

  if (event.ctrl === true && event.key === 'p') {
    surface.post({ move: target, by: -1 })

    return
  }

  if (event.shift === true && event.key === 'down') {
    surface.post({ move: target, by: 1 })

    return
  }

  if (event.shift === true && event.key === 'up') {
    surface.post({ move: target, by: -1 })
  }
}

export default Handle
