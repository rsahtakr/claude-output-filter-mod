/**
 * Behaviour tests for the order the person gives the flags: the drag handle
 * of a flag row, the move a drag or ctrl+n/ctrl+p makes, and the order a
 * later session finds again.
 *
 * The test's own `ui.render` hook stands in for the engine beneath the mod:
 * it draws a Text reading ENGINE, so a row the mod draws shows the label
 * beside the engine's own text and a row the mod blanks shows neither.
 */
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { CommandRunInput, On, RenderPropsOf, SessionMessage } from 'claude-code'

import { mergeOrder, moveInOrder } from '../hooks/marks'

const PLUGIN = 'output-filter'

/** The pane's id, as the mod opens it. */
const PANE = 'flags'

/** The first output, as the transcript holds it. */
const FIRST = 'First output: the suite is green.'

/** The second output. */
const SECOND = 'Second output: three failures.'

/** The third output. */
const THIRD = 'Third output: the run took two minutes.'

/** The transcript the mod reads to place the flags. */
const MESSAGES: SessionMessage[] = [
  { role: 'user', text: 'run the suite', toolUses: [] },
  { role: 'assistant', text: FIRST, toolUses: [] },
  { role: 'assistant', text: SECOND, toolUses: [] },
  { role: 'assistant', text: THIRD, toolUses: [] },
]

/** The pane's props, as the surface draws it. */
const PANE_PROPS: RenderPropsOf['Pane'] = {
  title: 'Flags',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
}

/** One assistant reply block. */
function reply(text: string): RenderPropsOf['AssistantMessage'] {
  return { text, isFirstOfReply: true, onScreen: null }
}

/**
 * The input of a command run, as the engine stamps it.
 *
 * @param command The command's name, without its slash.
 * @param args    What follows the name, as the person typed it.
 * @returns The run's input.
 */
function run(command: string, args = ''): CommandRunInput {
  return {
    command,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  }
}

/**
 * Register the engine stand-ins the test needs beneath the mod, and record
 * what the mod asked of the engine.
 *
 * @param on    The test's `on`.
 * @param store What the store holds at the start; the kit's own store then
 *              answers it, and the test cannot read what the mod wrote.
 * @returns The toasts the mod raised, the scrolls it asked for, and the store
 *          it wrote (empty when the kit holds the store).
 */
function engineBeneath(
  on: On,
  store?: Record<string, unknown>,
): { toasts: string[]; scrolls: string[]; written: Map<string, unknown> } {
  const written = new Map<string, unknown>()
  const toasts: string[] = []
  const scrolls: string[] = []

  if (store === undefined) {
    on('store.get', (_$, e) => ({ value: written.get(e.key) }))
    on('store.set', (_$, e) => {
      written.set(e.key, e.value)

      return { value: undefined }
    })
  } else {
    mock.store(on, store)
  }

  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.scroll', (_$, e) => {
    scrolls.push(e.requestId)

    // The kit has no transcript to scroll: the refusal is what shows the
    // press reached the scroll.
    return { deny: 'no implementation for ui.scroll' }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return Text({ children: 'ENGINE' })
  })

  return { toasts, scrolls, written }
}

/**
 * Mount the Flags pane, as the surface draws it.
 *
 * @param $ The test's `$`.
 * @returns The mounted pane.
 */
async function mountPane($: Engine) {
  return $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'Pane',
    requestId: PANE,
    props: PANE_PROPS,
  })
}

/**
 * Mount one assistant row, as the surface draws it.
 *
 * @param $         The test's `$`.
 * @param requestId The row's requestId (the message id).
 * @param text      The output's text.
 * @returns The mounted row.
 */
async function mountRow($: Engine, requestId: string, text: string) {
  return $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId,
    props: reply(text),
  })
}

/**
 * The ids of the flags the pane lists, in the order it lists them.
 *
 * The pane is drawn again first, so the check does not depend on when the
 * kit flushes the redraw a state write asks for.
 *
 * @param pane The mounted pane.
 * @returns The rows' keys, `go:<id>` each.
 */
async function listedIds(pane: Awaited<ReturnType<typeof mountPane>>): Promise<string[]> {
  await pane.redraw()

  const buttons = await pane.findAll({ type: 'Button' })

  return buttons.filter(button => button.key?.startsWith('go:')).map(button => button.key ?? '')
}

/**
 * Flag three outputs, so the pane has three rows to order.
 *
 * @param $ The test's `$`.
 * @returns The mounted rows, by their requestId.
 */
async function flagThree($: Engine): Promise<Map<string, Awaited<ReturnType<typeof mountRow>>>> {
  const rows = new Map<string, Awaited<ReturnType<typeof mountRow>>>()

  for (const [id, text] of [['r1', FIRST], ['r2', SECOND], ['r3', THIRD]] as const) {
    const row = await mountRow($, id, text)

    await row.press({ key: `flag:${id}` })

    rows.set(id, row)
  }

  return rows
}

describe('the order of the flags', () => {
  test('a move shifts the flag and stops at the ends', () => {
    // Down one and up one.
    expect(moveInOrder(['a', 'b', 'c'], 'a', 1)).toEqual(['b', 'a', 'c'])
    expect(moveInOrder(['a', 'b', 'c'], 'c', -1)).toEqual(['a', 'c', 'b'])

    // Past the ends, the move stops there.
    expect(moveInOrder(['a', 'b', 'c'], 'a', 9)).toEqual(['b', 'c', 'a'])
    expect(moveInOrder(['a', 'b', 'c'], 'c', -9)).toEqual(['c', 'a', 'b'])

    // A flag the list does not hold leaves the list as it was.
    expect(moveInOrder(['a', 'b'], 'z', 1)).toEqual(['a', 'b'])
  })

  test('the merge puts the shown ids first, and no id twice', () => {
    expect(mergeOrder(['x', 'a', 'b'], ['b', 'a'])).toEqual(['b', 'a', 'x'])
    expect(mergeOrder(['a', 'b'], ['b', 'a'])).toEqual(['b', 'a'])
    expect(mergeOrder([], ['b'])).toEqual(['b'])
  })

  test('the pane draws a drag handle for every flag', async ($, on) => {
    mock.clock(on)
    engineBeneath(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    await flagThree($)

    const pane = await mountPane($)

    expect(await pane.find({ type: 'Client', key: 'drag:r1' })).toBeDefined()
    expect(await pane.find({ type: 'Client', key: 'drag:r2' })).toBeDefined()
    expect(await pane.find({ type: 'Client', key: 'drag:r3' })).toBeDefined()

    // The header says how to reorder.
    expect(await pane.find({ type: 'Text', text: /ctrl\+n\/p to reorder/ })).toBeDefined()
  })

  test('a move swaps the rows, and /flag next follows the new order', async ($, on) => {
    mock.clock(on)
    engineBeneath(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    await flagThree($)

    const pane = await mountPane($)

    expect(await listedIds(pane)).toEqual(['go:r1', 'go:r2', 'go:r3'])

    await pane.post({ move: 'r1', by: 1 }, { in: 'drag:r1' })

    expect(await listedIds(pane)).toEqual(['go:r2', 'go:r1', 'go:r3'])

    // The move between the flags follows the pane's order too.
    const result = await $.command.run(run('flag', 'next'))

    expect(result.text).toContain('Flag 1 of 3')
    expect(result.text).toContain(SECOND)
  })

  test('the order is kept, and a new session finds it again', async ($, on) => {
    mock.clock(on)
    const { written } = engineBeneath(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    await flagThree($)

    const pane = await mountPane($)

    await pane.post({ move: 'r1', by: 1 }, { in: 'drag:r1' })

    expect(written.get('flagOrder')).toEqual(['r2', 'r1', 'r3'])

    await pane.unmount()

    // A new session finds the flags in the order the person left them.
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const later = await mountPane($)

    expect(await listedIds(later)).toEqual(['go:r2', 'go:r1', 'go:r3'])
  })

  test('a drag on the handle moves the flag that many rows', async ($, on) => {
    mock.clock(on)
    engineBeneath(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    await flagThree($)

    const pane = await mountPane($)

    await pane.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'drag:r1' })
    await pane.pointer({ type: 'move', x: 0, y: 2, button: 'left', in: 'drag:r1' })
    await pane.pointer({ type: 'up', x: 0, y: 2, button: 'left', in: 'drag:r1' })

    expect(await listedIds(pane)).toEqual(['go:r2', 'go:r3', 'go:r1'])
  })

  test('ctrl+n and ctrl+p move the flag one row', async ($, on) => {
    mock.clock(on)
    engineBeneath(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    await flagThree($)

    const pane = await mountPane($)

    await pane.key({ key: 'n', ctrl: true, in: 'drag:r1' })

    expect(await listedIds(pane)).toEqual(['go:r2', 'go:r1', 'go:r3'])

    await pane.key({ key: 'p', ctrl: true, in: 'drag:r1' })

    expect(await listedIds(pane)).toEqual(['go:r1', 'go:r2', 'go:r3'])
  })

  test('an unflagged output leaves the order too', async ($, on) => {
    mock.clock(on)
    const { written } = engineBeneath(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const rows = await flagThree($)

    const pane = await mountPane($)

    await pane.post({ move: 'r1', by: 1 }, { in: 'drag:r1' })

    expect(written.get('flagOrder')).toEqual(['r2', 'r1', 'r3'])

    // The flag is taken off: its place in the order goes with it.
    await rows.get('r1')?.press({ key: 'flag:r1' })

    expect(written.get('flagOrder')).toEqual(['r2', 'r3'])
  })
})
