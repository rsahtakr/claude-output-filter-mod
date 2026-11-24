/**
 * Behaviour tests for the pane of the flags and the highlights: the two
 * sections it holds, the travel between the highlights, the double press that
 * asks whether an entry is removed, and the band's own key for a highlight.
 *
 * The test's own `ui.render` hook stands in for the engine beneath the mod:
 * it draws a Text reading ENGINE, so a row the mod draws shows the label
 * beside the engine's own text and a row the mod blanks shows neither.
 */
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { CommandRunInput, On, RenderPropsOf, SessionMessage } from 'claude-code'

const PLUGIN = 'output-filter'

/** The pane's id, as the mod opens it. */
const PANE = 'flags'

/** An output the text rules label `Report`. */
const REPORT = '**What I did:** ran the suite and it is green.'

/** A second output, the text rules label `Finding`. */
const FINDING = 'The suite reports three failures.'

/** The words the person selects inside the first output. */
const SELECTED = 'the suite'

/** The words the person selects inside the second output. */
const ALSO_SELECTED = 'three failures'

/** What `/hl` says when the selection lies across two paragraphs. */
const SPANS_PARAGRAPHS =
  'That selection spans paragraphs; select text inside one paragraph, then run /hl.'

/** The transcript the mod reads to place the flags and the highlights. */
const MESSAGES: SessionMessage[] = [
  { role: 'user', text: 'run the suite', toolUses: [] },
  { role: 'assistant', text: REPORT, toolUses: [] },
  { role: 'assistant', text: FINDING, toolUses: [] },
]

/** The pane's props, as the surface draws it. */
const PANE_PROPS: RenderPropsOf['Pane'] = {
  title: 'Flags · Highlights',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
}

/** The bar's props, as the band draws. */
const BAND_PROPS: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 1 },
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
 * @returns The toasts the mod raised, the scrolls it asked for, the store it
 *          wrote (empty when the kit holds the store), and the way to change
 *          what the person has selected.
 */
function engineBeneath(
  on: On,
  store?: Record<string, unknown>,
): {
  toasts: string[]
  scrolls: string[]
  opens: Array<{ id: string; title: string | undefined }>
  written: Map<string, unknown>
  select: (text: string, requestId: string) => void
} {
  const written = new Map<string, unknown>()
  const toasts: string[] = []
  const scrolls: string[] = []
  const opens: Array<{ id: string; title: string | undefined }> = []
  let selection: { text: string; requestId?: string } | undefined

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
  on('ui.selection', () => ({ value: selection }))
  on('ui.scroll', (_$, e) => {
    scrolls.push(e.requestId)

    // The kit has no transcript to scroll: the refusal is what shows the
    // press reached the scroll.
    return { deny: 'no implementation for ui.scroll' }
  })
  on('ui.open', (_$, e) => {
    opens.push({ id: e.id, title: e.title })

    return { value: { isPlaced: true } }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return Text({ children: 'ENGINE' })
  })

  return {
    toasts,
    scrolls,
    opens,
    written,
    select: (text: string, requestId: string) => {
      selection = { text, requestId }
    },
  }
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
 * The keys of the pane's entries, in the order the pane lists them.
 *
 * The pane is drawn again first, so the check does not depend on when the
 * kit flushes the redraw a state write asks for.
 *
 * @param pane The mounted pane.
 * @returns The rows' keys.
 */
async function entryKeys(pane: Awaited<ReturnType<typeof mountPane>>): Promise<string[]> {
  await pane.redraw()

  const buttons = await pane.findAll({ type: 'Button' })

  return buttons
    .map(button => button.key ?? '')
    .filter(key => key.startsWith('go:') || key.startsWith('go-hl:'))
}

/**
 * The entry the cursor is on, as the pane draws it.
 *
 * @param pane The mounted pane.
 * @returns The cursor's row key, or undefined when no row carries it.
 */
async function cursorKey(pane: Awaited<ReturnType<typeof mountPane>>): Promise<string | undefined> {
  await pane.redraw()

  const buttons = await pane.findAll({ type: 'Button' })
  const marked = buttons.find(button => button.text.startsWith('▶'))

  return marked?.key
}

/**
 * Whether the pane asks whether an entry is to be removed.
 *
 * @param pane The mounted pane.
 * @returns Whether the question stands under an entry.
 */
async function asksRemoval(pane: Awaited<ReturnType<typeof mountPane>>): Promise<boolean> {
  await pane.redraw()

  return (await pane.find({ type: 'Text', text: 'Remove?' })) !== undefined
}

describe('the pane of the flags and the highlights', () => {
  test('the flags come first, then the highlights', async ($, on) => {
    mock.clock(on)
    const { select } = engineBeneath(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const first = await mountRow($, 'a1', REPORT)
    await mountRow($, 'a2', FINDING)

    await first.press({ key: 'flag:a1' })

    select(ALSO_SELECTED, 'a2')
    await $.command.run(run('hl'))

    const pane = await mountPane($)

    expect(await entryKeys(pane)).toEqual(['go:a1', 'go-hl:a2:0'])

    // The two sections are drawn as two sections: the rule stands between the
    // flags and the highlights.
    expect(await pane.find({ type: 'Text', text: /─+/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /1 flag/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /1 highlight/ })).toBeDefined()

    // The highlight's own row names it.
    expect(await pane.find({ type: 'Button', key: 'go-hl:a2:0' })).toBeDefined()
  })

  test('the travel between the highlights wraps round', async ($, on) => {
    mock.clock(on)
    const { select, scrolls, toasts } = engineBeneath(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    await mountRow($, 'b1', REPORT)
    await mountRow($, 'b2', FINDING)

    select(SELECTED, 'b1')
    await $.command.run(run('hl'))

    select(ALSO_SELECTED, 'b2')
    await $.command.run(run('hl'))

    const pane = await mountPane($)

    expect(await entryKeys(pane)).toEqual(['go-hl:b1:0', 'go-hl:b2:0'])

    // The cursor starts on the first highlight, and its row is brought into
    // view.
    await pane.press({ key: 'hl-next' })

    expect(await cursorKey(pane)).toBe('go-hl:b1:0')
    expect(scrolls.length + toasts.length).toBeGreaterThan(0)
    expect([...scrolls, ...toasts].some(text => text.includes('b1'))).toBe(true)

    await pane.press({ key: 'hl-next' })

    expect(await cursorKey(pane)).toBe('go-hl:b2:0')
    expect([...scrolls, ...toasts].some(text => text.includes('b2'))).toBe(true)

    // Round it goes.
    await pane.press({ key: 'hl-next' })

    expect(await cursorKey(pane)).toBe('go-hl:b1:0')

    await pane.press({ key: 'hl-prev' })

    expect(await cursorKey(pane)).toBe('go-hl:b2:0')
  })

  test('a double press asks whether the entry is removed, and yes removes it', async ($, on) => {
    mock.clock(on)
    const { select } = engineBeneath(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    await mountRow($, 'c1', REPORT)

    select(SELECTED, 'c1')
    await $.command.run(run('hl'))

    const pane = await mountPane($)

    // One press jumps; the second, soon after, asks.
    await pane.press({ key: 'go-hl:c1:0' })
    await pane.press({ key: 'go-hl:c1:0' })

    expect(await asksRemoval(pane)).toBe(true)
    expect(await pane.find({ type: 'Button', key: 'rm-yes:go-hl:c1:0' })).toBeDefined()
    expect(await pane.find({ type: 'Button', key: 'rm-no:go-hl:c1:0' })).toBeDefined()

    await pane.press({ key: 'rm-yes:go-hl:c1:0' })

    expect(await entryKeys(pane)).toEqual([])
  })

  test('no keeps the entry', async ($, on) => {
    mock.clock(on)
    const { select } = engineBeneath(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    await mountRow($, 'd1', REPORT)

    select(SELECTED, 'd1')
    await $.command.run(run('hl'))

    const pane = await mountPane($)

    await pane.press({ key: 'go-hl:d1:0' })
    await pane.press({ key: 'go-hl:d1:0' })

    await pane.press({ key: 'rm-no:go-hl:d1:0' })

    expect(await asksRemoval(pane)).toBe(false)
    expect(await entryKeys(pane)).toEqual(['go-hl:d1:0'])
  })

  test('a double press on a flag asks whether it is unflagged', async ($, on) => {
    mock.clock(on)
    engineBeneath(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const row = await mountRow($, 'e1', REPORT)

    await row.press({ key: 'flag:e1' })

    const pane = await mountPane($)

    await pane.press({ key: 'go:e1' })
    await pane.press({ key: 'go:e1' })

    expect(await asksRemoval(pane)).toBe(true)
    expect(await pane.find({ type: 'Button', key: 'rm-yes:go:e1' })).toBeDefined()

    await pane.press({ key: 'rm-yes:go:e1' })

    expect(await entryKeys(pane)).toEqual([])
  })

  test('two presses apart are two jumps, not a double press', async ($, on) => {
    const clock = mock.clock(on)
    const { select } = engineBeneath(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    await mountRow($, 'f1', REPORT)

    select(SELECTED, 'f1')
    await $.command.run(run('hl'))

    const pane = await mountPane($)

    await pane.press({ key: 'go-hl:f1:0' })

    await clock.advance(600)

    await pane.press({ key: 'go-hl:f1:0' })

    expect(await asksRemoval(pane)).toBe(false)
    expect(await entryKeys(pane)).toEqual(['go-hl:f1:0'])
  })

  test('the band answers 8 with a highlight', async ($, on) => {
    mock.clock(on)
    const { select, toasts } = engineBeneath(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    await mountRow($, 'g1', REPORT)

    select(SELECTED, 'g1')

    const band = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'AbovePrompt',
      props: BAND_PROPS,
    })

    const button = await band.find({ type: 'Button', key: 'hl' })

    expect(button).toBeDefined()
    expect(button?.props.hotkey).toBe('8')

    await band.press({ key: 'hl' })

    expect(toasts.some(text => text.includes('Highlighted.'))).toBe(true)
  })

  test('a selection across paragraphs is refused', async ($, on) => {
    mock.clock(on)
    const { select } = engineBeneath(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const two = 'First paragraph.\n\nSecond paragraph.'

    await mountRow($, 'h1', two)

    select('First paragraph. Second paragraph.', 'h1')

    const result = await $.command.run(run('hl'))

    expect(result.text).toBe(SPANS_PARAGRAPHS)

    // Nothing was kept: the pane lists no highlight.
    const pane = await mountPane($)

    expect(await entryKeys(pane)).toEqual([])
  })

  test('/hl next moves between the highlights, and /highlights opens the pane', async ($, on) => {
    mock.clock(on)
    const { select, opens } = engineBeneath(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    await mountRow($, 'i1', REPORT)
    await mountRow($, 'i2', FINDING)

    select(SELECTED, 'i1')
    await $.command.run(run('hl'))

    select(ALSO_SELECTED, 'i2')
    await $.command.run(run('hl'))

    const first = await $.command.run(run('hl', 'next'))

    expect(first.text).toContain('Highlight 1 of 2')

    const second = await $.command.run(run('hl', 'next'))

    expect(second.text).toContain('Highlight 2 of 2')

    // The pane is the same one the flags live in.
    const opened = await $.command.run(run('highlights'))

    expect(opened.text).toContain('Flags pane')
    expect(opens.some(open => open.id === PANE)).toBe(true)
    expect(opens.some(open => open.title === 'Flags · Highlights')).toBe(true)
  })
})
