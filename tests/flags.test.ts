/**
 * Behaviour tests for the flags an assistant output carries: the chip that
 * flags a row, the Flags pane that lists the flags of the session, the move
 * between them, and the flags a later session finds again.
 *
 * The test's own `ui.render` hook stands in for the engine beneath the mod:
 * it draws a Text reading ENGINE, so a row the mod draws shows the label
 * beside the engine's own text and a row the mod blanks shows neither.
 */
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf, SessionMessage } from 'claude-code'

const PLUGIN = 'output-filter'

/** The pane's id, as the mod opens it. */
const PANE = 'flags'

/** An output the text rules label `Report`. */
const REPORT = '**What I did:** ran the suite and it is green.'

/** A second output, the text rules label `Finding`. */
const FINDING = 'The suite reports three failures.'

/** The plain words of `REPORT`, which is what a flag's preview holds. */
const REPORT_PREVIEW = 'What I did: ran the suite and it is green.'

/** The transcript the mod reads to place the flags. */
const MESSAGES: SessionMessage[] = [
  { role: 'user', text: 'run the suite', toolUses: [] },
  { role: 'assistant', text: REPORT, toolUses: [] },
  { role: 'assistant', text: FINDING, toolUses: [] },
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

describe('flags', () => {
  test('a press on the chip flags the row, and the pane lists it', async ($, on) => {
    mock.clock(on)
    const { written } = engineBeneath(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const row = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'AssistantMessage',
      requestId: 'r1',
      props: reply(REPORT),
    })

    // The chip is a button, so a press on the label flags the row.
    expect(await row.find({ type: 'Button', key: 'flag:r1' })).toBeDefined()

    await row.press({ key: 'flag:r1' })

    const chip = await row.find({ type: 'Button', key: 'flag:r1' })

    expect(chip?.text).toContain('⚑')

    // The flag is kept for the next session.
    expect(written.get('flags')).toBeDefined()

    const pane = await mountPane($)

    expect(await pane.find({ type: 'Button', key: 'go:r1' })).toBeDefined()
  })

  test('the pane lists the flags in transcript order, not in the order they were set', async ($, on) => {
    mock.clock(on)
    engineBeneath(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const first = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'AssistantMessage',
      requestId: 'r1',
      props: reply(REPORT),
    })
    const second = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'AssistantMessage',
      requestId: 'r2',
      props: reply(FINDING),
    })

    // The later row is flagged first.
    await second.press({ key: 'flag:r2' })
    await first.press({ key: 'flag:r1' })

    const pane = await mountPane($)
    const buttons = await pane.findAll({ type: 'Button' })
    const listed = buttons.filter(button => button.key?.startsWith('go:')).map(button => button.key)

    expect(listed).toEqual(['go:r1', 'go:r2'])
  })

  test('next and prev move between the flags and wrap round', async ($, on) => {
    mock.clock(on)
    engineBeneath(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    for (const [id, text] of [['r1', REPORT], ['r2', FINDING]] as const) {
      const row = await $.ui.mount({
        plugin: PLUGIN,
        surface: 'terminal',
        component: 'AssistantMessage',
        requestId: id,
        props: reply(text),
      })

      await row.press({ key: `flag:${id}` })
    }

    const pane = await mountPane($)

    const cursor = async (): Promise<string | undefined> => {
      const buttons = await pane.findAll({ type: 'Button' })
      const marked = buttons.find(button => button.text.startsWith('▶'))

      return marked?.key
    }

    // No cursor yet: next takes the first flag, and again it wraps to it.
    await pane.press({ key: 'next' })

    expect(await cursor()).toBe('go:r1')

    await pane.press({ key: 'next' })

    expect(await cursor()).toBe('go:r2')

    await pane.press({ key: 'next' })

    expect(await cursor()).toBe('go:r1')

    // Back the other way, wrapping again.
    await pane.press({ key: 'prev' })

    expect(await cursor()).toBe('go:r2')
  })

  test('a press on an entry asks the engine to scroll to that row', async ($, on) => {
    mock.clock(on)
    const { toasts, scrolls } = engineBeneath(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const row = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'AssistantMessage',
      requestId: 'r2',
      props: reply(FINDING),
    })

    await row.press({ key: 'flag:r2' })

    const pane = await mountPane($)

    await pane.press({ key: 'go:r2' })

    // The kit has no transcript: the scroll is refused, and the refusal names
    // the row it was asked for.
    expect(scrolls.length + toasts.length).toBeGreaterThan(0)
    expect([...scrolls, ...toasts].some(text => text.includes('r2'))).toBe(true)
  })

  test('a second press on the chip takes the flag off', async ($, on) => {
    mock.clock(on)
    const { written } = engineBeneath(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const row = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'AssistantMessage',
      requestId: 'r1',
      props: reply(REPORT),
    })

    await row.press({ key: 'flag:r1' })
    await row.press({ key: 'flag:r1' })

    const chip = await row.find({ type: 'Button', key: 'flag:r1' })

    expect(chip?.text).not.toContain('⚑')
    expect((written.get('flags') as Record<string, unknown> | undefined)?.r1).toBeUndefined()

    const pane = await mountPane($)

    expect(await pane.find({ type: 'Button', key: 'go:r1' })).toBeUndefined()
  })

  test('the flags of an earlier session are found again', async ($, on) => {
    mock.clock(on)
    engineBeneath(on, {
      flags: { r1: { label: 'Report', preview: REPORT_PREVIEW, at: 1 } },
    })

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const pane = await mountPane($)
    const entry = await pane.find({ type: 'Button', key: 'go:r1' })

    expect(entry).toBeDefined()
    expect(entry?.text).toContain(REPORT_PREVIEW)
  })
})
