/**
 * Behaviour tests for the highlights an assistant output carries: the
 * selection that becomes a highlight, the highlight the row draws, the one
 * that is taken off again, and the ones a later session finds again.
 *
 * The test's own `ui.render` hook stands in for the engine beneath the mod:
 * it draws a Text reading ENGINE, so a row the mod draws its own way shows
 * the highlighted words, and a row it leaves to the engine shows ENGINE.
 */
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { CommandRunInput, On, RenderPropsOf } from 'claude-code'

const PLUGIN = 'output-filter'

/** An output the text rules label `Report`. */
const REPORT = '**What I did:** ran the suite and it is green.'

/** The words the person selects inside the output. */
const SELECTED = 'the suite'

/** What `/hl` says when there is nothing selected. */
const NOTHING_SELECTED =
  'Nothing is selected. Highlights need the fullscreen layout: select text inside one output, then run /hl.'

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
 * @param on        The test's `on`.
 * @param selection What the person has selected, or undefined for nothing.
 * @param store     What the store holds at the start; the kit's own store then
 *                  answers it, and the test cannot read what the mod wrote.
 * @returns The toasts the mod raised and the store it wrote (empty when the
 *          kit holds the store).
 */
function engineBeneath(
  on: On,
  selection?: { text: string; requestId?: string },
  store?: Record<string, unknown>,
): { toasts: string[]; written: Map<string, unknown> } {
  const written = new Map<string, unknown>()
  const toasts: string[] = []

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
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.selection', () => ({ value: selection }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return Text({ children: 'ENGINE' })
  })

  return { toasts, written }
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
 * The text the row draws with a yellow ground: the words of the highlight.
 *
 * The row is drawn again first, so the check does not depend on when the kit
 * flushes the redraw a state write asks for.
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

describe('highlights', () => {
  test('the selected words become a highlight the row draws', async ($, on) => {
    mock.clock(on)
    engineBeneath(on, { text: SELECTED, requestId: 'r1' })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const row = await mountRow($, 'r1', REPORT)

    const result = await $.command.run(run('hl'))

    expect(result.text).toBe('Highlighted.')
    expect(await highlightedText(row)).toBe(SELECTED)

    // The row draws its own body now, not the engine's.
    expect(await row.find({ type: 'Text', text: 'ENGINE' })).toBeUndefined()
  })

  test('the same words again take the highlight off', async ($, on) => {
    mock.clock(on)
    engineBeneath(on, { text: SELECTED, requestId: 'r2' })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const row = await mountRow($, 'r2', REPORT)

    await $.command.run(run('hl'))

    const result = await $.command.run(run('hl'))

    expect(result.text).toBe('Highlight removed.')
    expect(await highlightedText(row)).toBeUndefined()

    // Without a highlight the row is the engine's own again.
    expect(await row.find({ type: 'Text', text: 'ENGINE' })).toBeDefined()
  })

  test('nothing selected says what to do', async ($, on) => {
    mock.clock(on)
    engineBeneath(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const result = await $.command.run(run('hl'))

    expect(result.text).toBe(NOTHING_SELECTED)
  })

  test('the highlights of an earlier session are found again', async ($, on) => {
    mock.clock(on)
    engineBeneath(on, undefined, { highlights: { kept: [SELECTED] } })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const row = await mountRow($, 'kept', REPORT)

    expect(await highlightedText(row)).toBe(SELECTED)
  })

  test('the highlights are written to the store and read back in a new session', async ($, on) => {
    mock.clock(on)
    const { written } = engineBeneath(on, { text: SELECTED, requestId: 'r3' })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    await $.command.run(run('hl'))

    const stored = written.get('highlights') as Record<string, { texts: string[] }> | undefined

    expect(stored?.r3?.texts).toEqual([SELECTED])

    // A new session finds them again.
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const row = await mountRow($, 'r3', REPORT)

    expect(await highlightedText(row)).toBe(SELECTED)
  })

  test('the band highlights the selection and says so', async ($, on) => {
    mock.clock(on)
    const { toasts } = engineBeneath(on, { text: SELECTED, requestId: 'r4' })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const band = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'AbovePrompt',
      props: BAND_PROPS,
    })

    expect(await band.find({ type: 'Button', key: 'hl' })).toBeDefined()

    await band.press({ key: 'hl' })

    expect(toasts.some(text => text.includes('Highlighted.'))).toBe(true)
  })
})
