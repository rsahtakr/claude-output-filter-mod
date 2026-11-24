/**
 * Behaviour tests for output-filter: the three-state toggles and the rows
 * they hide, the reset button, the choice persisted to `$.store`,
 * click-to-fold prompts, and the scroll bar.
 *
 * The test's own `ui.render` hook stands in for the engine beneath the mod:
 * it draws a Text reading ENGINE, so a row the mod passes through shows
 * ENGINE and a row it blanks does not.
 */
import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

const PLUGIN = 'output-filter'
const SURFACES = ['terminal', 'desktop'] as const

/** The fullscreen terminal's measurements: the only place the scroll bar draws. */
const FULLSCREEN = { columns: 120, rows: 40, isFullscreen: true }

const BAND_PROPS: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 1 },
  view: {},
}

/** A tool row as the engine hands it to `ui.render`, for tool `tool`. */
function toolRow(tool: string, toolUseId = `toolu_${tool}`): RenderPropsOf['ToolUse'] {
  return {
    tool_use_id: toolUseId,
    tool,
    input: {},
    isRunning: false,
    isErrored: false,
    isInterrupted: false,
  }
}

/** The person's prompt row, as typed in the composer. */
function prompt(text: string): RenderPropsOf['UserMessage'] {
  return { text, origin: { kind: 'composer' }, isExpanded: false }
}

/** One assistant reply block. */
function reply(text: string, onScreen: RenderPropsOf['AssistantMessage']['onScreen'] = null): RenderPropsOf['AssistantMessage'] {
  return { text, isFirstOfReply: true, onScreen }
}

/**
 * Register the engine stand-ins every test needs beneath the mod.
 *
 * @returns The values the mod wrote to `$.store`, by key, newest last, and
 *          the toasts it raised, in order.
 */
function engineBeneath(on: On): { stored: Map<string, unknown>; toasts: string[] } {
  const stored = new Map<string, unknown>()
  const toasts: string[] = []

  on('store.get', (_$, e) => ({ value: stored.get(e.key) }))
  on('store.set', (_$, e) => {
    stored.set(e.key, e.value)

    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return Text({ children: 'ENGINE' })
  })

  return { stored, toasts }
}

describe('output-filter', () => {
  test('the bar draws every category at [x] at first', async ($, on) => {
    engineBeneath(on)

    for (const surface of SURFACES) {
      const band = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND_PROPS })
      const buttons = await band.findAll({ type: 'Button' })

      expect(buttons.map(button => button.text)).toEqual([
        '[x] Prompts',
        '[x] Output',
        '[x] Tools',
        '[x] Edits',
        '[x] Agents',
        '[x] Commands',
        '[x] Status',
        'hl',
      ])
      await band.unmount()
    }
  })

  test('a toggle cycles [x] -> [o] -> [ ]; [ ] Tools hides shell rows, keeps edits', async ($, on) => {
    const { stored } = engineBeneath(on)

    for (const surface of SURFACES) {
      const band = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND_PROPS })
      const bash = await $.ui.mount({ plugin: PLUGIN, surface, component: 'ToolUse', props: toolRow('Bash') })
      const edit = await $.ui.mount({ plugin: PLUGIN, surface, component: 'ToolUse', props: toolRow('Edit') })

      await band.press({ key: 'tools' })

      // The only shell row is the newest one, so [o] still draws it.
      expect((await band.find({ key: 'tools' }))?.text).toBe('[o] Tools')
      expect(await bash.find({ text: 'ENGINE' })).toBeDefined()

      await band.press({ key: 'tools' })

      expect((await band.find({ key: 'tools' }))?.text).toBe('[ ] Tools')
      expect(await bash.find({ text: 'ENGINE' })).toBeUndefined()
      expect(await edit.find({ text: 'ENGINE' })).toBeDefined()
      expect(stored.get('visibility')).toMatchObject({ tools: 'none', edits: 'all' })

      // "all" appears once anything is off [x], and restores every row.
      await band.press({ key: 'all' })

      expect(await bash.find({ text: 'ENGINE' })).toBeDefined()
      expect(await band.find({ key: 'all' })).toBeUndefined()

      await band.unmount()
      await bash.unmount()
      await edit.unmount()
    }
  })

  test('messages from agents follow Agents, not Prompts', async ($, on) => {
    engineBeneath(on)

    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    const mine = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'UserMessage', props: prompt('hi') })
    const theirs = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'UserMessage',
      props: { ...prompt('done'), from: { name: 'worker' } },
    })

    await band.press({ key: 'agents' })
    await band.press({ key: 'agents' })

    // The person's own prompt draws as the mod's fold row, not the engine's.
    expect(await mine.find({ key: 'fold' })).toBeDefined()
    expect(await theirs.find({ text: 'ENGINE' })).toBeUndefined()
  })

  test('[o] Tools keeps only the newest tool call, and follows new calls', async ($, on) => {
    engineBeneath(on)
    const clock = mock.clock(on)

    /** Mount one tool row; mount order is first-drawn order. */
    const mountTool = (tool: string, id: string) =>
      $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'ToolUse', requestId: id, props: toolRow(tool, id) })

    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    const first = await mountTool('Bash', 't1')
    const edit = await mountTool('Edit', 'e1')
    const second = await mountTool('Grep', 't2')

    await band.press({ key: 'tools' })

    expect(await first.find({ text: 'ENGINE' })).toBeUndefined()
    expect(await second.find({ text: 'ENGINE' })).toBeDefined()
    expect(await edit.find({ text: 'ENGINE' })).toBeDefined()

    // A new call draws at once; the tick then hides the one it superseded.
    const third = await mountTool('Bash', 't3')

    expect(await third.find({ text: 'ENGINE' })).toBeDefined()

    await clock.advance(300)

    expect(await second.find({ text: 'ENGINE' })).toBeUndefined()
    expect(await third.find({ text: 'ENGINE' })).toBeDefined()
  })

  test('pressing a prompt folds the rows answering it, up to the next prompt', async ($, on) => {
    engineBeneath(on)

    /** Mount one transcript row; mount order is first-drawn order. */
    const mountRow = <C extends 'UserMessage' | 'AssistantMessage' | 'ToolUse'>(
      component: C,
      requestId: string,
      props: RenderPropsOf[C],
    ) => $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component, requestId, props })

    const p1 = await mountRow('UserMessage', 'p1', prompt('first question\nsecond line'))
    const a1 = await mountRow('AssistantMessage', 'a1', reply('answer one'))
    const t1 = await mountRow('ToolUse', 't1', toolRow('Bash', 't1'))
    const p2 = await mountRow('UserMessage', 'p2', prompt('next question'))
    const a2 = await mountRow('AssistantMessage', 'a2', reply('answer two'))

    expect((await p1.find({ key: 'fold' }))?.text).toStartWith('▾ first question')

    await p1.press({ key: 'fold' })

    expect((await p1.find({ key: 'fold' }))?.text).toStartWith('▸ first question …')
    expect(await a1.find({ text: 'ENGINE' })).toBeUndefined()
    expect(await t1.find({ text: 'ENGINE' })).toBeUndefined()
    expect((await p2.find({ key: 'fold' }))?.text).toStartWith('▾ next question')
    expect(await a2.find({ text: 'ENGINE' })).toBeDefined()

    await p1.press({ key: 'fold' })

    expect(await a1.find({ text: 'ENGINE' })).toBeDefined()
    expect(await t1.find({ text: 'ENGINE' })).toBeDefined()
  })

  test('the scroll bar tracks the rows on screen, in fullscreen only', async ($, on) => {
    engineBeneath(on)
    const clock = mock.clock(on)

    const band = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'AbovePrompt',
      props: BAND_PROPS,
      viewport: FULLSCREEN,
    })
    const rows = []

    for (const id of ['r0', 'r1', 'r2', 'r3']) {
      rows.push(
        await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AssistantMessage', requestId: id, props: reply(id) }),
      )
    }

    // The bottom two rows come on screen, whole.
    for (const row of rows.slice(2)) {
      await row.redraw(reply('on screen', { first: 0, last: 3, of: 4 }))
    }

    await clock.advance(300)

    expect(await band.find({ text: '3-4/4' })).toBeDefined()
    expect(await band.find({ key: 'seg-0' })).toBeDefined()

    // The main screen scrolls in the terminal's own scrollback: no bar.
    const mainScreen = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })

    expect(await mainScreen.find({ key: 'seg-0' })).toBeUndefined()
  })

  test('the track is clickable cells with the viewport as its thumb', async ($, on) => {
    const { toasts } = engineBeneath(on)
    const clock = mock.clock(on)

    const band = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'AbovePrompt',
      props: BAND_PROPS,
      viewport: FULLSCREEN,
    })
    const rows = []

    for (const id of ['r0', 'r1', 'r2', 'r3']) {
      rows.push(
        await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AssistantMessage', requestId: id, props: reply(id) }),
      )
    }

    for (const row of rows.slice(2)) {
      await row.redraw(reply('on screen', { first: 0, last: 3, of: 4 }))
    }

    await clock.advance(300)

    // 120 columns leave a 60-cell track; rows 3-4 of 4 fill its right half.
    const cells = (await band.findAll({ type: 'Button' })).filter(cell => cell.key?.startsWith('seg-'))

    expect(cells.map(cell => cell.text).join('')).toBe('░'.repeat(30) + '█'.repeat(30))

    // A click is the person's press, so it scrolls; the kit has no transcript
    // and refuses, which shows the press reached the scroll.
    await band.press({ key: 'seg-0' })

    expect(toasts).toEqual(['output-filter: scroll refused: no implementation for ui.scroll'])
  })

  test('rows outside the scroller are no targets; stale top reports are trimmed', async ($, on) => {
    engineBeneath(on)
    const clock = mock.clock(on)

    // A 30-row terminal: three 10-row messages fill it.
    const screen = { columns: 120, rows: 30, isFullscreen: true }
    const band = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'AbovePrompt',
      props: BAND_PROPS,
      viewport: screen,
    })

    // A progress pill reports no onScreen: not in the scroller, never a target.
    await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'ToolProgress',
      requestId: 'pill',
      props: { tool_use_id: 'pill', kind: 'background_hint', hint: '(ctrl+b to run in background)' },
      viewport: screen,
    })

    // Five messages append, each whole on screen when drawn, and none
    // re-reports as the next pushes it up: the first two reports go stale.
    for (const id of ['m0', 'm1', 'm2', 'm3', 'm4']) {
      await $.ui.mount({
        plugin: PLUGIN,
        surface: 'terminal',
        component: 'AssistantMessage',
        requestId: id,
        props: reply(id, { first: 0, last: 9, of: 10 }),
        viewport: screen,
      })
    }

    await clock.advance(300)

    expect(await band.find({ text: '3-5/5' })).toBeDefined()
  })
})
