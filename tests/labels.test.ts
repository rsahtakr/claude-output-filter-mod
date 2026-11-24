/**
 * Behaviour tests for the labels an assistant output carries: the rules'
 * answer on the row, the dot while an output waits for Haiku, Haiku's answer
 * arriving on the clock, and a failed call that is not made again.
 *
 * The test's own `ui.render` hook stands in for the engine beneath the mod:
 * it draws a Text reading ENGINE, so a row the mod draws shows the label
 * beside the engine's own text and a row the mod blanks shows neither.
 */
import { describe, expect, mock, test } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { ModelCompleteResult, On, RenderPropsOf } from 'claude-code'

const PLUGIN = 'output-filter'

/** The surfaces the labels are drawn on. */
const SURFACES = ['terminal', 'desktop'] as const

/** An output the text rules label `Report`. */
const REPORT = '**What I did:** ran the suite and it is green.'

/** An output no rule decides, so Haiku is asked about it. */
const UNDECIDED = 'The garden gate was painted blue.'

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

/** The usage every mocked model call reports. */
const USAGE = {
  input_tokens: 10,
  output_tokens: 1,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

/** Haiku's answer: one word, the name of a category. */
const ANSWERED: ModelCompleteResult = { isAnswered: true, text: 'Finding', usage: USAGE }

/** Haiku's failure: the API answered with an error. */
const FAILED: ModelCompleteResult = {
  isAnswered: false,
  reason: 'api-error',
  status: 500,
  error: 'server_error',
  usage: USAGE,
}

/**
 * Register the engine stand-ins the test needs beneath the mod, and record
 * what Haiku was asked.
 *
 * @param on     The test's `on`.
 * @param answer What Haiku answers, or the failure it reports.
 * @returns The prompts Haiku was asked for, in order.
 */
function engineBeneath(on: On, answer: ModelCompleteResult = ANSWERED): string[] {
  const stored = new Map<string, unknown>()
  const prompts: string[] = []

  on('store.get', (_$, e) => ({ value: stored.get(e.key) }))
  on('store.set', (_$, e) => {
    stored.set(e.key, e.value)

    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'filter' } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return Text({ children: 'ENGINE' })
  })
  on('model.complete', (_$, e) => {
    prompts.push(e.prompt)

    return { value: answer }
  })

  return prompts
}

/**
 * Let the label clock fire, Haiku answer and the row redraw with the label.
 *
 * The clock moves past the tick (1,500 ms) and past a redraw's own frame, so
 * the row has drawn again before the test reads it.
 *
 * @param clock The mocked clock.
 */
async function settleLabels(clock: MockClock): Promise<void> {
  await clock.advance(1500)
  await clock.advance(300)
  await clock.settle()
}

describe('labels', () => {
  test('a rule text draws its label in the category colour', async ($, on) => {
    const clock = mock.clock(on)
    const prompts = engineBeneath(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    for (const surface of SURFACES) {
      const row = await $.ui.mount({
        plugin: PLUGIN,
        surface,
        component: 'AssistantMessage',
        requestId: `rule-${surface}`,
        props: reply(REPORT),
      })
      const chip = await row.find({ type: 'Text', text: 'Report' })

      expect(chip?.text).toStartWith('Report')
      expect(chip?.text).toHaveLength(9)
      expect(chip?.props.color).toBe('magenta')
      expect(chip?.props.bold).toBe(true)
      expect(await row.find({ type: 'Text', text: 'ENGINE' })).toBeDefined()

      await row.unmount()
    }

    // The rules decided, so Haiku is never asked.
    await settleLabels(clock)

    expect(prompts).toHaveLength(0)
  })

  test('an undecided output draws a dot, then the label Haiku gives it', async ($, on) => {
    const clock = mock.clock(on)
    const prompts = engineBeneath(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const row = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'AssistantMessage',
      requestId: 'asked',
      props: reply(UNDECIDED),
    })

    const dot = await row.find({ type: 'Text', text: '·' })

    expect(dot?.props.dimColor).toBe(true)
    expect(prompts).toHaveLength(0)

    await settleLabels(clock)

    const chip = await row.find({ type: 'Text', text: 'Finding' })

    expect(chip?.props.color).toBe('cyan')
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain(UNDECIDED)
  })

  test('drawing the output again asks Haiku nothing', async ($, on) => {
    const clock = mock.clock(on)
    const prompts = engineBeneath(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const row = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'AssistantMessage',
      requestId: 'again',
      props: reply(UNDECIDED),
    })

    await settleLabels(clock)

    expect(prompts).toHaveLength(1)

    await row.redraw(reply(UNDECIDED))
    await settleLabels(clock)

    expect(prompts).toHaveLength(1)
    expect((await row.find({ type: 'Text', text: 'Finding' }))?.props.color).toBe('cyan')
  })

  test('a hidden output draws no label', async ($, on) => {
    const clock = mock.clock(on)

    engineBeneath(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const band = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'AbovePrompt',
      props: BAND_PROPS,
    })

    // [x] -> [o] -> [ ]: the output category draws no row at all.
    await band.press({ key: 'output' })
    await band.press({ key: 'output' })

    const row = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'AssistantMessage',
      requestId: 'hidden',
      props: reply(REPORT),
    })

    expect(await row.find({ type: 'Text' })).toBeUndefined()

    await settleLabels(clock)
  })

  test('a failed answer leaves the dot and is not made again', async ($, on) => {
    const clock = mock.clock(on)
    const prompts = engineBeneath(on, FAILED)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    const row = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'AssistantMessage',
      requestId: 'failed',
      props: reply(UNDECIDED),
    })

    await settleLabels(clock)

    expect(prompts).toHaveLength(1)
    expect(await row.find({ type: 'Text', text: 'Finding' })).toBeUndefined()
    expect((await row.find({ type: 'Text', text: '·' }))?.props.dimColor).toBe(true)

    // The call is not made again this session, whatever the row does.
    await row.redraw(reply(UNDECIDED))
    await settleLabels(clock)

    expect(prompts).toHaveLength(1)
    expect((await row.find({ type: 'Text', text: '·' }))?.props.dimColor).toBe(true)
  })
})
