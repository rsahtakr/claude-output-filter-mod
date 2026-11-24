/**
 * Behaviour tests for the way an output with a highlight is drawn: the
 * paragraphs around the hit keep their own layout, a list keeps one line per
 * item, the hit keeps the style of the words it covers, a press on it takes
 * it off, and a hit inside a code fence leaves the fence as code.
 *
 * The test's own `ui.render` hook stands in for the engine beneath the mod:
 * it draws a Text reading ENGINE, so a row the mod draws its own way shows
 * the highlighted words, and a row it leaves to the engine shows ENGINE.
 */
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import { inlineLines, splitHighlightParts } from '../hooks/highlight-render'

const PLUGIN = 'output-filter'

/** A reply of three paragraphs, the second holding the words to highlight. */
const THREE = 'First paragraph.\n\nSecond paragraph with the suite green.\n\nThird paragraph.'

/** The words the person selects inside the second paragraph. */
const SUITE = 'the suite'

/** A reply that is a list of three items. */
const LIST = '- first item\n- second item\n- third item'

/** The words of the list that are highlighted. */
const SECOND = 'second item'

/** A reply whose words are bold. */
const BOLD = 'The **bold words** are here.'

/** The bold words, as the person selects them. */
const BOLD_WORDS = 'bold words'

/** A reply with a fenced code block. */
const CODE = 'Here is the code:\n\n```js\nconst suite = 1\n```\n'

/** The words of the code that are highlighted. */
const CODE_WORDS = 'const suite'

/**
 * Register the engine stand-ins the test needs beneath the mod.
 *
 * @param on The test's `on`.
 */
function engineBeneath(on: On): void {
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return Text({ children: 'ENGINE' })
  })
}

/**
 * One assistant reply block.
 *
 * @param text The output's text.
 * @returns The reply's props, as the surface draws it.
 */
function reply(text: string): RenderPropsOf['AssistantMessage'] {
  return { text, isFirstOfReply: true, onScreen: null }
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

describe('highlight render', () => {
  test('the paragraphs around a hit keep their own markdown', async ($, on) => {
    mock.clock(on)
    mock.store(on, { highlights: { r1: [SUITE] } })
    engineBeneath(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const row = await mountRow($, 'r1', THREE)

    // The block with the hit is a part of its own; the blocks around it are
    // one Markdown each, not one Markdown per paragraph.
    const parts = splitHighlightParts(THREE, [SUITE])

    expect(parts.map(part => part.kind)).toEqual(['markdown', 'lines', 'markdown'])
    expect(parts.map(part => (part.kind === 'markdown' ? part.text : ''))).toEqual([
      'First paragraph.',
      '',
      'Third paragraph.',
    ])

    const markdowns = await row.findAll({ type: 'Markdown' })

    expect(markdowns).toHaveLength(2)
    expect(markdowns[0]?.text).toBe('First paragraph.')
    expect(markdowns[1]?.text).toBe('Third paragraph.')

    // The hit is a line of its own, and it is drawn between the two.
    const texts = await row.findAll({ type: 'Text' })
    const hit = texts.find(text => text.props.backgroundColor === 'yellow')

    expect(hit?.text).toBe(SUITE)
  })

  test('a list block keeps one line per item', async ($, on) => {
    mock.clock(on)
    mock.store(on, { highlights: { r1: [SECOND] } })
    engineBeneath(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const row = await mountRow($, 'r1', LIST)

    // One line per item, the marker kept as it was written.
    const lines = inlineLines(LIST)

    expect(lines).toHaveLength(3)
    expect(lines.map(line => line.runs.map(run => run.text).join(''))).toEqual([
      '- first item',
      '- second item',
      '- third item',
    ])

    // The row draws the items as they are, not as one block of words.
    const texts = await row.findAll({ type: 'Text' })

    expect(texts.some(text => text.text === '- first item')).toBe(true)
    expect(texts.some(text => text.text === '- third item')).toBe(true)
  })

  test('a hit over bold words keeps the bold', async ($, on) => {
    mock.clock(on)
    mock.store(on, { highlights: { r1: [BOLD_WORDS] } })
    engineBeneath(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const row = await mountRow($, 'r1', BOLD)

    const texts = await row.findAll({ type: 'Text' })
    const hit = texts.find(text => text.props.backgroundColor === 'yellow')

    expect(hit?.text).toBe(BOLD_WORDS)
    expect(hit?.props.bold).toBe(true)
  })

  test('a press on the highlighted line takes the highlight off', async ($, on) => {
    mock.clock(on)
    mock.store(on, { highlights: { r1: [SUITE] } })
    engineBeneath(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const row = await mountRow($, 'r1', THREE)

    const buttons = await row.findAll({ type: 'Button' })
    const hitLine = buttons.find(button => button.key?.startsWith('hl:'))

    expect(hitLine).toBeDefined()

    await row.press({ key: hitLine?.key ?? '' })

    // The row is drawn again first, so the check does not depend on when the
    // kit flushes the redraw a state write asks for.
    await row.redraw()

    // Without a highlight the row is the engine's own again.
    expect(await row.find({ type: 'Text', text: 'ENGINE' })).toBeDefined()

    const texts = await row.findAll({ type: 'Text' })

    expect(texts.find(text => text.props.backgroundColor === 'yellow')).toBeUndefined()
  })

  test('a hit inside a code fence leaves the fence as code', async ($, on) => {
    mock.clock(on)
    mock.store(on, { highlights: { r1: [CODE_WORDS] } })
    engineBeneath(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const row = await mountRow($, 'r1', CODE)

    const codes = await row.findAll({ type: 'Code' })

    expect(codes).toHaveLength(1)
    expect(codes[0]?.text).toContain(CODE_WORDS)

    // The hit inside the fence is ignored: no word is marked.
    const texts = await row.findAll({ type: 'Text' })

    expect(texts.find(text => text.props.backgroundColor === 'yellow')).toBeUndefined()
  })
})
