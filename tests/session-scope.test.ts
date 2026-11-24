/**
 * Behaviour tests for the session the lists belong to: the flags and the
 * highlights of another session are dropped, a flag of this session that no
 * message holds yet is listed, the highlights of the older shape still load,
 * the removal the pane offers (the `✕` at the end of a row, the `remove` of
 * the header) asks and removes, and a highlight's handle reorders the
 * highlights.
 *
 * The test's own `ui.render` hook stands in for the engine beneath the mod:
 * it draws a Text reading ENGINE, so a row the mod draws its own way shows
 * the highlighted words, and a row it leaves to the engine shows ENGINE.
 */
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { CommandRunInput, On, RenderPropsOf, SessionMessage } from 'claude-code'

const PLUGIN = 'output-filter'

/** The pane's id, as the mod opens it. */
const PANE = 'flags'

/** The id of the session the test runs in. */
const SESSION = 'S1'

/** The id of another session, whose entries the pane must not list. */
const OTHER = 'OTHER'

/** An output the text rules label `Report`. */
const REPORT = '**What I did:** ran the suite and it is green.'

/** A second output, the text rules label `Finding`. */
const FINDING = 'The suite reports three failures.'

/** The words the person selects inside the first output. */
const SELECTED = 'the suite'

/** The words the person selects inside the second output. */
const ALSO_SELECTED = 'three failures'

/** The words of an output the transcript of this session does not carry. */
const UNMATCHED = 'An output the transcript of this session does not carry.'

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
 * @param store What the store holds at the start; the test's own store then
 *              answers it, and the test can read what the mod wrote.
 * @returns The toasts the mod raised, the store it wrote, and the way to
 *          change what the person has selected.
 */
function engineBeneath(
  on: On,
  store: Record<string, unknown> = {},
): {
  toasts: string[]
  written: Map<string, unknown>
  select: (text: string, requestId: string) => void
} {
  const written = new Map<string, unknown>(Object.entries(store))
  const toasts: string[] = []
  let selection: { text: string; requestId?: string } | undefined

  on('store.get', (_$, e) => ({ value: written.get(e.key) }))
  on('store.set', (_$, e) => {
    written.set(e.key, e.value)

    return { value: undefined }
  })

  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  // The session the mod runs in: the entries of this session are its own,
  // the entries of another one are not.
  on('session.id', () => ({ value: SESSION }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.selection', () => ({ value: selection }))
  on('ui.scroll', () => ({ deny: 'no implementation for ui.scroll' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return Text({ children: 'ENGINE' })
  })

  return {
    toasts,
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

/**
 * The text the row draws with a yellow ground: the words of the highlight.
 *
 * @param row The mounted row.
 * @returns The highlighted text, or undefined when the row holds none.
 */
async function highlightedText(row: Awaited<ReturnType<typeof mountRow>>): Promise<string | undefined> {
  await row.redraw()

  const texts = await row.findAll({ type: 'Text' })
  const hit = texts.find(text => String(text.props.backgroundColor) === 'yellow')

  return hit?.text
}

describe('the lists of one session', () => {
  test('a flag of another session is neither listed nor counted', async ($, on) => {
    mock.clock(on)
    engineBeneath(on, {
      flags: {
        elsewhere: { label: null, preview: UNMATCHED, at: 1, sessionId: OTHER },
      },
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const pane = await mountPane($)

    // The flag of the other session is not this session's: it is never listed.
    expect(await entryKeys(pane)).toEqual([])

    // And it is not counted either.
    expect(await pane.find({ type: 'Text', text: '0 flags' })).toBeDefined()
  })

  test('a flag of this session no message holds yet is listed', async ($, on) => {
    mock.clock(on)
    engineBeneath(on, {
      flags: {
        mine: { label: null, preview: UNMATCHED, at: 1, sessionId: SESSION },
      },
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const pane = await mountPane($)

    // The flag names no message of the transcript (it is a row the
    // transcript has not drawn yet), but it is this session's own.
    expect(await entryKeys(pane)).toEqual(['go:mine'])
    expect(await pane.find({ type: 'Text', text: '1 flag' })).toBeDefined()
  })

  test('the highlights of the older shape still load and draw', async ($, on) => {
    mock.clock(on)
    engineBeneath(on, { highlights: { older: [SELECTED] } })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    // The store holds the words alone, as the older shape does.
    const row = await mountRow($, 'older', REPORT)

    expect(await highlightedText(row)).toBe(SELECTED)

    const pane = await mountPane($)

    expect(await entryKeys(pane)).toEqual(['go-hl:older:0'])
    expect(await pane.find({ type: 'Text', text: '1 highlight' })).toBeDefined()
  })

  test('the ✕ of a flag row, then yes, removes the flag', async ($, on) => {
    mock.clock(on)
    engineBeneath(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const row = await mountRow($, 'r1', REPORT)

    await row.press({ key: 'flag:r1' })

    const pane = await mountPane($)

    expect(await entryKeys(pane)).toEqual(['go:r1'])

    // The ✕ at the end of the row asks.
    await pane.press({ key: 'rm:go:r1' })

    expect(await asksRemoval(pane)).toBe(true)
    expect(await pane.find({ type: 'Button', key: 'rm-yes:go:r1' })).toBeDefined()

    // And yes removes it.
    await pane.press({ key: 'rm-yes:go:r1' })

    expect(await entryKeys(pane)).toEqual([])
  })

  test('the ✕ of a highlight row, then yes, removes the highlight', async ($, on) => {
    mock.clock(on)
    const { select } = engineBeneath(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    await mountRow($, 'h1', REPORT)

    select(SELECTED, 'h1')
    await $.command.run(run('hl'))

    const pane = await mountPane($)

    expect(await entryKeys(pane)).toEqual(['go-hl:h1:0'])

    await pane.press({ key: 'rm:go-hl:h1:0' })

    expect(await asksRemoval(pane)).toBe(true)
    expect(await pane.find({ type: 'Button', key: 'rm-yes:go-hl:h1:0' })).toBeDefined()

    await pane.press({ key: 'rm-yes:go-hl:h1:0' })

    expect(await entryKeys(pane)).toEqual([])
  })

  test('the remove button of the header asks about the active entry', async ($, on) => {
    mock.clock(on)
    engineBeneath(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const row = await mountRow($, 'r1', REPORT)

    await row.press({ key: 'flag:r1' })

    const pane = await mountPane($)

    const remove = await pane.find({ type: 'Button', key: 'remove' })

    expect(remove).toBeDefined()
    expect(remove?.props.hotkey).toBe('x')

    // No entry is active yet: there is nothing to ask about.
    await pane.press({ key: 'remove' })

    expect(await asksRemoval(pane)).toBe(false)

    // A press on the entry makes it the active one.
    await pane.press({ key: 'go:r1' })

    await pane.press({ key: 'remove' })

    expect(await asksRemoval(pane)).toBe(true)
    expect(await pane.find({ type: 'Button', key: 'rm-yes:go:r1' })).toBeDefined()
  })

  test('a highlight handle reorders the highlights, and next follows it', async ($, on) => {
    mock.clock(on)
    const { select } = engineBeneath(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    await mountRow($, 'h1', REPORT)
    await mountRow($, 'h2', FINDING)

    select(SELECTED, 'h1')
    await $.command.run(run('hl'))

    select(ALSO_SELECTED, 'h2')
    await $.command.run(run('hl'))

    const pane = await mountPane($)

    expect(await entryKeys(pane)).toEqual(['go-hl:h1:0', 'go-hl:h2:0'])

    // The handle of a highlight row carries the highlight's entry key.
    const handle = `drag:hl:h1\n${SELECTED}`

    expect(await pane.find({ type: 'Client', key: handle })).toBeDefined()

    await pane.post({ move: `hl:h1\n${SELECTED}`, by: 1 }, { in: handle })

    expect(await entryKeys(pane)).toEqual(['go-hl:h2:0', 'go-hl:h1:0'])

    // The next button of the highlights follows the new order.
    await pane.press({ key: 'hl-next' })

    expect(await cursorKey(pane)).toBe('go-hl:h2:0')

    await pane.press({ key: 'hl-next' })

    expect(await cursorKey(pane)).toBe('go-hl:h1:0')
  })
})
