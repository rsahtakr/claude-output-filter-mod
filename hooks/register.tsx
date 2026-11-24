/**
 * output-filter: a bar above the prompt that controls what the transcript
 * draws.
 *
 * Display only: the model, the stored transcript and the ctrl+o view's
 * records are untouched.
 *
 * 1. Category toggles (Prompts, Output, Tools, Edits, Agents, Commands,
 *    Status), each with three states that a press cycles through:
 *    `[x]` every row, `[o]` only the category's newest row (Tools at `[o]`
 *    shows the last tool call), `[ ]` none. Each transcript row component
 *    (`ToolUse`, `AssistantMessage`, ...) has a `ui.render` hook that maps the
 *    row to a category and draws an empty Box in place of a hidden row.
 * 2. Click-to-fold: each of the person's prompts draws as a pressable row
 *    (`▾ prompt`); pressing it hides every row drawn after it up to the next
 *    prompt (`▸ prompt`), pressing again shows them.
 * 3. In the fullscreen terminal a second line, the scroll bar: a track whose
 *    filled part is the viewport's place in the transcript; a click on a
 *    cell jumps there. No drag: the engine moves the transcript only in
 *    answer to a press, a key or a command, never to a pointer drag a mod
 *    reports. The keyboard scrolls with the engine's own keys (PgUp/PgDn,
 *    ctrl+Home/ctrl+End), and the track follows them.
 *
 * The bar's keys (1-7, a) answer while the band holds the focus:
 * ctrl+x tab or a click on the band gives it, Esc hands it back. The
 * composer never sends them.
 *
 * Never hidden: permission prompts and the AskUserQuestion dialog (they need
 * an answer), the spinner, and the prompt footer.
 */
import { atom, memberOf, read, update } from 'claude-code'
import type {
  BoxProps,
  ButtonProps,
  ClientProps,
  ElementConstructor,
  EngineInterface,
  RenderElement,
  RenderPropsOf,
  Register,
  StateDollar,
  TextProps,
  Timer,
  UiScrollBlock,
} from 'claude-code'

import type { CategoryId, FlagEntry, OutputLabel, Shown, ViewportSummary, Visibility } from '../types'

import { classifyByRules, haikuPrompt, LABEL_COLOR, LABELS, parseHaikuReply } from './classify'
import { highlightedBody, labelChip, labelled } from './draw-marks'
import { flagOrder, highlightEntryKey, highlightKey, highlightOrder, highlightSegments, highlightStep, mergeOrder, moveInOrder, normalize, previewOf, splitBlocks, step } from './marks'
import type { FlagOrderEntry, HighlightOrderEntry, HighlightStoreEntry } from './marks'

// --------------------------------------------------
// Categories
// --------------------------------------------------

/**
 * The bar's toggles, in drawing order. `hotkey` presses the toggle while the
 * band holds the focus (ctrl+x tab, or a click on the band).
 */
const CATEGORIES: ReadonlyArray<{ id: CategoryId; label: string; hotkey: string }> = [
  { id: 'prompts', label: 'Prompts', hotkey: '1' },
  { id: 'output', label: 'Output', hotkey: '2' },
  { id: 'tools', label: 'Tools', hotkey: '3' },
  { id: 'edits', label: 'Edits', hotkey: '4' },
  { id: 'agents', label: 'Agents', hotkey: '5' },
  { id: 'commands', label: 'Commands', hotkey: '6' },
  { id: 'status', label: 'Status', hotkey: '7' },
]

const ALL_SHOWN: Shown = {
  prompts: 'all',
  output: 'all',
  tools: 'all',
  edits: 'all',
  agents: 'all',
  commands: 'all',
  status: 'all',
}

/** What a press on a toggle moves to: all -> newest only -> none -> all. */
const NEXT_VISIBILITY: Record<Visibility, Visibility> = { all: 'last', last: 'none', none: 'all' }

/** How each state reads on its toggle. */
const MARK: Record<Visibility, string> = { all: '[x]', last: '[o]', none: '[ ]' }

/**
 * Tools whose rows are file diffs. They get their own category because they
 * are usually the tool output worth keeping while shell and search noise is
 * hidden.
 */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

// --------------------------------------------------
// Element and value types
// --------------------------------------------------

/** The elements this mod draws with, as `$.ui.resolve(e)` hands them out. */
type Table = {
  Box: ElementConstructor<BoxProps>
  Button: ElementConstructor<ButtonProps>
  Text: ElementConstructor<TextProps>
}

/**
 * The part of a transcript row on screen (`first`..`last` of `of` rows), as
 * the row's `onScreen` prop reports it. Derived from a row's props because
 * the engine's own `OnScreen` type is not exported.
 */
type OnScreen = NonNullable<RenderPropsOf['ToolUse']['onScreen']>

/** What `$.ui.scroll` needs to bring one transcript row into view. */
type ScrollTarget = { requestId: string; block: UiScrollBlock }

/** A hook's `$` narrowed to what scrolling needs (scroll, toast). */
type UiDollar = Pick<EngineInterface, 'ui'>

/** A hook's `$` narrowed to session values and the cross-session store. */
type StoreDollar = StateDollar & Pick<EngineInterface, 'store'>

/** A hook's `$` narrowed to what the clock tick needs: state, the timer, the transcript. */
type TickDollar = StateDollar & Pick<EngineInterface, 'clock' | 'session'>

/** A hook's `$` narrowed to what the flags need: state, the store, the transcript, the ui. */
type FlagDollar = StateDollar & Pick<EngineInterface, 'store' | 'session' | 'ui'>

/** What a message row says, to find it among `$.session.messages()`. */
type RowText = { role: 'user' | 'assistant'; text: string }

// --------------------------------------------------
// State
// --------------------------------------------------
// Every `atom` reference spells the plugin name as a literal: the engine's
// state scan reads references from source and refuses a name held in a const.

/** Session value every row hook reads; a write redraws exactly those rows. */
const shown = atom({ plugin: 'output-filter', key: 'visibility' } as const, ALL_SHOWN)

/**
 * Per row requestId: true once a newer row of the row's category was drawn.
 * Only rows of a category at `[o]` read their member, so marking one stale
 * redraws that row alone.
 */
const isStale = atom({ plugin: 'output-filter', key: 'isStale' } as const, false)

/**
 * Per prompt requestId: true while the prompt's answer is folded. A row reads
 * only its own prompt's member, so a fold redraws only that prompt's rows.
 */
const collapsed = atom({ plugin: 'output-filter', key: 'collapsed' } as const, false)

/** The prompts whose `collapsed` member is true, for the band and `/filter`. */
const collapsedIds = atom({ plugin: 'output-filter', key: 'collapsedIds' } as const, [] as string[])

/**
 * Per message id: the category Haiku gave the output, for the outputs the
 * text rules could not decide. A row reads its own member while drawing, so
 * the write redraws that row alone.
 */
const aiLabel = { plugin: 'output-filter', key: 'aiLabel' } as const

/** The scroll bar's viewport summary; written by the clock tick only. */
const NO_VIEWPORT: ViewportSummary = { top: -1, bottom: -1, count: 0 }
const viewport = atom({ plugin: 'output-filter', key: 'viewport' } as const, NO_VIEWPORT)

/**
 * The flagged outputs, by message id, for the Flags pane. A press on a row's
 * chip writes the flag, so the pane lists it at once.
 */
const flags = atom({ plugin: 'output-filter', key: 'flags' } as const, {} as Record<string, FlagEntry>)

/**
 * Per message id: true while the output carries a flag. A row reads its own
 * member while drawing, so a press on the chip redraws that row alone.
 */
const isFlagged = { plugin: 'output-filter', key: 'isFlagged' } as const

/**
 * Per message id: the passages of the output the person highlighted. A row
 * reads its own member while drawing, so a write redraws that row alone.
 */
const highlights = { plugin: 'output-filter', key: 'highlights' } as const

/** The flagged output the cursor is on, for the pane and `/flag next|prev`. */
const flagCursor = atom({ plugin: 'output-filter', key: 'flagCursor' } as const, null as string | null)

/**
 * The person's own order of the flags, by message id: what the pane's drag
 * handles and ctrl+n/ctrl+p set (D15).
 *
 * The pane reads it while it draws, so a write redraws it at once. Empty
 * means no order of their own, and the pane lists the flags in transcript
 * order as before.
 */
const flagOrderList = atom({ plugin: 'output-filter', key: 'flagOrderList' } as const, [] as string[])

/**
 * The person's own order of the highlights, by entry key (the message id and
 * the words, behind `hl:`): what the pane's drag handles set (D22).
 *
 * The pane reads it while it draws, so a write redraws it at once. Empty
 * means no order of their own, and the pane lists the highlights in
 * transcript order as before.
 */
const hlOrderList = atom({ plugin: 'output-filter', key: 'hlOrderList' } as const, [] as string[])

/**
 * The pane entry the person last pressed or travelled to, by its row key:
 * the one the `remove` button asks about (D21).
 *
 * Empty means no entry is active, and the button says so.
 */
const activeEntry = atom({ plugin: 'output-filter', key: 'activeEntry' } as const, null as string | null)

/**
 * The highlight the cursor is on, for the pane and `/hl next|prev`.
 *
 * The name of a highlight is its message id and its words, one line between
 * them, so two highlights of one message are told apart.
 */
const hlCursor = atom({ plugin: 'output-filter', key: 'hlCursor' } as const, null as string | null)

/**
 * The pane entry whose removal is asked for: its key, after a double press
 * on the entry. Empty means nothing is asked for.
 */
const confirmRemove = atom({ plugin: 'output-filter', key: 'confirmRemove' } as const, null as string | null)

/** `$.store` key that carries the toggles into later sessions. */
const STORE_KEY = 'visibility'

/** The key 0.1/0.2 stored booleans under, read once when `STORE_KEY` is empty. */
const LEGACY_STORE_KEY = 'shown'

/**
 * Read a stored toggle map over the defaults.
 *
 * Takes this version's values (`all`/`last`/`none`) and the older on/off
 * booleans (true -> all, false -> none). A category missing from the stored
 * value (added in a later version) shows; anything else is ignored.
 *
 * @param stored Whatever `$.store.get` returned; may be `undefined` or junk.
 * @returns A complete Shown.
 */
function fromStored(stored: unknown): Shown {
  const merged: Shown = { ...ALL_SHOWN }

  if (typeof stored !== 'object' || stored === null) {
    return merged
  }

  for (const { id } of CATEGORIES) {
    const value = (stored as Record<string, unknown>)[id]

    if (value === 'all' || value === 'last' || value === 'none') {
      merged[id] = value
    } else if (typeof value === 'boolean') {
      merged[id] = value ? 'all' : 'none'
    }
  }

  return merged
}

/**
 * Write a new toggle map to the session value and the store.
 *
 * @param change Maps the current map to the next one.
 */
async function setShown($: StoreDollar, change: (current: Shown) => Shown): Promise<void> {
  const next = await update($, shown, change)
  await $.store.set(STORE_KEY, next)
}

/**
 * Fold or unfold one prompt's answer.
 *
 * Toggles the prompt's `collapsed` member (which its rows read) and keeps
 * `collapsedIds` (which the band reads) in step.
 *
 * @param promptId The prompt row's requestId.
 */
async function toggleCollapsed($: StateDollar, promptId: string): Promise<void> {
  const isNowCollapsed = await update($, memberOf(collapsed, { requestId: promptId }), current => !current)

  await update($, collapsedIds, ids => {
    const others = ids.filter(id => id !== promptId)

    return isNowCollapsed ? [...others, promptId] : others
  })
}

/** Unfold every folded prompt. */
async function expandAll($: StateDollar): Promise<void> {
  const ids = await read($, collapsedIds)

  for (const id of ids) {
    await update($, memberOf(collapsed, { requestId: id }), () => false)
  }

  await update($, collapsedIds, () => [])
}

/** Back to the defaults: every category at `[x]`, every prompt unfolded. */
async function resetAll($: StoreDollar): Promise<void> {
  await setShown($, () => ({ ...ALL_SHOWN }))
  await expandAll($)
}

// --------------------------------------------------
// Row registry (module memory, not session state)
// --------------------------------------------------
// Render hooks may not write `$.state`, so what the rows report while drawing
// lives here, and the clock tick turns it into state. A reload of the module
// empties it, and the engine then draws the rows near the viewport again,
// which fills it again.

/**
 * Every transcript row the mod has drawn, keyed by requestId (a message id,
 * or a tool call's tool_use_id, which its ToolUse, ToolResult and
 * ToolProgress rows share).
 *
 * First-drawn order is not transcript order: the fullscreen terminal draws
 * only the rows near the viewport, so a resumed session draws its last rows
 * first and older ones as the person scrolls up. The tick places each row at
 * its transcript position (`pos`, from `$.session.messages()`) and keeps
 * `order` sorted by it; a row it cannot place yet stays after every placed
 * row, in first-drawn order (a live row the transcript does not hold yet).
 */
const registry = {
  /** requestIds in transcript order, as far as the tick has placed them. */
  order: [] as string[],
  /** requestId -> its index in `order`. */
  index: new Map<string, number>(),
  /** requestId -> the index of the transcript message it belongs to, once placed. */
  pos: new Map<string, number>(),
  /** requestId -> its first-drawn sequence number; breaks ties within a message. */
  seq: new Map<string, number>(),
  /** requestId -> the tick window it was first drawn in: rows drawn in one pass are adjacent. */
  batch: new Map<string, number>(),
  /** requestId -> what a message row says, to place it by text. */
  text: new Map<string, RowText>(),
  /** The person's prompt rows. */
  prompts: new Set<string>(),
  /** First-drawn counter, the next `seq`. */
  drawCount: 0,
  /** The current tick window, the next `batch`. */
  batchNo: 0,
  /** requestId -> its category, fixed when first drawn. */
  category: new Map<string, CategoryId>(),
  /** category -> its newest row's requestId (the last in transcript order). */
  newest: new Map<CategoryId, string>(),
  /** requestId -> the person's prompt it answers; undefined before any prompt and for prompts. */
  owner: new Map<string, string | undefined>(),
  /** requestId -> whether its last drawing was the row (true) or a blank (false). */
  drawn: new Map<string, boolean>(),
  /** Rows already marked stale this module load, so a tick writes each once. */
  markedStale: new Set<string>(),
  /**
   * `component:requestId` -> its latest on-screen report. Keyed per component
   * because a tool call's ToolUse and ToolResult share one requestId but
   * report their own extents.
   */
  visible: new Map<string, { requestId: string; onScreen: OnScreen; seq: number }>(),
  /** Report counter: a `visible` entry's `seq`, higher = reported later. */
  reportSeq: 0,
  /**
   * Rows that report `onScreen` at all (null or a value): the rows inside the
   * transcript's scroller, the only ones `$.ui.scroll` can reveal. A notice
   * drawn in the footer reports none and is never a scroll target.
   */
  scrollable: new Set<string>(),
  /**
   * Rows the engine has no drawing for, so no scroll target: tool calls a
   * ToolGroup folded (drawn alone while running, then under the group's id),
   * and any id a scroll was refused for as drawn nowhere.
   */
  unreachable: new Set<string>(),
  /** The terminal's height in rows, from the latest drawing's `viewport`; 0 unknown. */
  screenRows: 0,
  /** The prompt rows drawn so far answer to; the latest prompt. */
  currentPrompt: undefined as string | undefined,
  /** Set by any report; the clock tick does its work only when set. */
  isDirty: false,
}

/**
 * Note a row the first time it is drawn and return the prompt it answers.
 *
 * Called before the hook awaits anything, so first-drawn order is dispatch
 * order, which the tick uses to place rows the transcript cannot tell apart.
 * A new row is placed at once when its position is known (a tool call by its
 * id, a message by unique text); an older row than its category's newest then
 * does not take that title. A row with no known position is taken as new (a
 * live row), and the tick corrects it. A person's prompt owns the rows after
 * it until the next prompt; the tick re-derives owners in transcript order.
 *
 * @param requestId The row's `e.requestId`.
 * @param category  The checkbox that governs it.
 * @param isPrompt  True for the person's own prompt row.
 * @param text      What a message row says; absent on tool and status rows.
 * @returns The owning prompt's requestId; undefined for prompts and for rows
 *          before the first prompt (never folded).
 */
function registerRow(requestId: string, category: CategoryId, isPrompt: boolean, text?: RowText): string | undefined {
  if (!registry.index.has(requestId)) {
    registry.index.set(requestId, registry.order.length)
    registry.order.push(requestId)
    registry.category.set(requestId, category)
    registry.seq.set(requestId, registry.drawCount++)
    registry.batch.set(requestId, registry.batchNo)
    transcript.isStale = true

    if (text !== undefined) {
      registry.text.set(requestId, text)
    }

    const pos = exactPos(requestId)
    const newest = registry.newest.get(category)
    const newestPos = newest === undefined ? undefined : registry.pos.get(newest)
    const isOlder = pos !== undefined && newestPos !== undefined && pos < newestPos

    if (pos !== undefined) {
      registry.pos.set(requestId, pos)
    }

    if (!isOlder) {
      registry.newest.set(category, requestId)
    }

    if (isPrompt) {
      registry.prompts.add(requestId)
      registry.currentPrompt = isOlder ? registry.currentPrompt : requestId
    }

    registry.owner.set(requestId, isPrompt ? undefined : registry.currentPrompt)
    registry.isDirty = true
  }

  return registry.owner.get(requestId)
}

/**
 * Record whether a row drew and what of it is on screen.
 *
 * The terminal re-reports `onScreen` only for rows at the viewport's edges,
 * so a row that left the screen in a long jump may keep a stale report. The
 * edge rule repairs that: a row cut at the top proves every earlier row is
 * off screen, a row cut at the bottom proves every later one is.
 *
 * @param component The row's component, half of its `visible` key.
 * @param requestId The row's `e.requestId`.
 * @param isDrawn   False when the hook drew a blank (no rows on screen).
 * @param onScreen  The row's `onScreen` prop; null off screen, undefined where
 *                  the surface does not say (both count as off screen).
 * @param screenRows The terminal's height (`e.viewport.rows`), when measured.
 */
function recordRow(
  component: string,
  requestId: string,
  isDrawn: boolean,
  onScreen: OnScreen | null | undefined,
  screenRows: number | undefined,
): void {
  const key = `${component}:${requestId}`

  registry.drawn.set(requestId, isDrawn)
  registry.screenRows = screenRows ?? registry.screenRows
  registry.isDirty = true

  if (onScreen !== undefined) {
    registry.scrollable.add(requestId)
  }

  if (!isDrawn || onScreen === null || onScreen === undefined) {
    registry.visible.delete(key)
    return
  }

  registry.reportSeq += 1
  registry.visible.set(key, { requestId, onScreen, seq: registry.reportSeq })

  // `of` is the row's extent, so its last row is `of - 1`.
  const isCutAtTop = onScreen.first > 0
  const isCutAtBottom = onScreen.last < onScreen.of - 1

  if (!isCutAtTop && !isCutAtBottom) {
    return
  }

  const at = registry.index.get(requestId) ?? -1

  for (const [otherKey, other] of registry.visible) {
    const otherAt = registry.index.get(other.requestId) ?? -1
    const isAbove = isCutAtTop && otherAt < at
    const isBelow = isCutAtBottom && otherAt > at

    if (isAbove || isBelow) {
      registry.visible.delete(otherKey)
    }
  }
}

/**
 * The rows a scroll can land on: inside the transcript's scroller and drawn
 * (not blank), in transcript order.
 */
function scrollTargets(): string[] {
  return registry.order.filter(
    id => registry.drawn.get(id) === true && registry.scrollable.has(id) && !registry.unreachable.has(id),
  )
}

/** Rows of row `requestId` on screen now, summed over its components' reports. */
function rowsOnScreen(requestId: string): number {
  let rows = 0

  for (const entry of registry.visible.values()) {
    if (entry.requestId === requestId) {
      rows += entry.onScreen.last - entry.onScreen.first + 1
    }
  }

  return rows
}

/** The latest report's `seq` for row `requestId`; 0 when it has none. */
function latestReport(requestId: string): number {
  let seq = 0

  for (const entry of registry.visible.values()) {
    if (entry.requestId === requestId) {
      seq = Math.max(seq, entry.seq)
    }
  }

  return seq
}

/**
 * Drop on-screen reports that cannot still be true: more rows than the
 * terminal has.
 *
 * Rows re-report only on a scroll, at the viewport's edges, so while new rows
 * append at the bottom the old top rows keep their first "on screen" report
 * long after they left. The window is rebuilt around the freshest report:
 * from that row it grows over on-screen neighbours, the fresher side first,
 * while their rows fit in the terminal's height; reports outside are dropped.
 * The height is the whole terminal's, so the window may keep a few rows too
 * many (the footer's), never too few.
 */
function trimToScreen(): void {
  const budget = registry.screenRows
  const targets = scrollTargets()

  if (budget <= 0) {
    return
  }

  let anchor = -1
  let freshest = 0

  targets.forEach((id, at) => {
    const seq = latestReport(id)

    if (seq > freshest) {
      freshest = seq
      anchor = at
    }
  })

  const anchorId = targets[anchor]

  if (anchorId === undefined) {
    return
  }

  let low = anchor
  let high = anchor
  let used = rowsOnScreen(anchorId)

  // Grow one neighbour at a time, the fresher side first; a neighbour with no
  // report ends its side, and the first that does not fit ends the growth.
  while (true) {
    const above = targets[low - 1]
    const below = targets[high + 1]
    const aboveSeq = above === undefined ? 0 : latestReport(above)
    const belowSeq = below === undefined ? 0 : latestReport(below)

    if (aboveSeq === 0 && belowSeq === 0) {
      break
    }

    const takesAbove = aboveSeq >= belowSeq
    const next = takesAbove ? above : below
    const rows = next === undefined ? 0 : rowsOnScreen(next)

    if (used + rows > budget) {
      break
    }

    used += rows
    low = takesAbove ? low - 1 : low
    high = takesAbove ? high : high + 1
  }

  const kept = new Set(targets.slice(low, high + 1))

  for (const [key, entry] of registry.visible) {
    if (!kept.has(entry.requestId)) {
      registry.visible.delete(key)
    }
  }
}

/** Whether any part of row `requestId` is on screen, and whether its top is cut. */
function screenState(requestId: string): { isOnScreen: boolean; isTopCut: boolean } {
  let isOnScreen = false
  let isTopCut = false

  for (const entry of registry.visible.values()) {
    if (entry.requestId === requestId) {
      isOnScreen = true
      isTopCut = isTopCut || entry.onScreen.first > 0
    }
  }

  return { isOnScreen, isTopCut }
}

/**
 * Where the viewport sits over the transcript (see ViewportSummary for the
 * unit): messages once the transcript is read, drawn rows before.
 *
 * @returns The first and last position on screen (-1 when none) and the count.
 */
function summarize(): ViewportSummary {
  trimToScreen()

  const targets = scrollTargets()
  const isRead = transcript.count > 0
  let top = -1
  let bottom = -1

  targets.forEach((id, at) => {
    const pos = isRead ? registry.pos.get(id) : at

    if (pos === undefined || !screenState(id).isOnScreen) {
      return
    }

    top = top < 0 ? pos : Math.min(top, pos)
    bottom = Math.max(bottom, pos)
  })

  return { top, bottom, count: isRead ? transcript.count : targets.length }
}

// --------------------------------------------------
// Transcript positions (module memory)
// --------------------------------------------------
// The engine tells a row nothing of where it sits in the transcript, and the
// fullscreen terminal draws only the rows near the viewport. The transcript
// itself (`$.session.messages()`) gives the true order and length: a tool row
// is found by its tool_use_id, a message row by its text.

/** How many ticks apart transcript reads may be (4 x 250 ms = 1 s). */
const READ_EVERY_TICKS = 4

/** Characters of a message's text that key it; enough to tell messages apart. */
const TEXT_KEY_LENGTH = 80

/**
 * The shortest text start searched for inside whole messages: a short line
 * ("Done.") turns up inside many replies, and would misplace its row.
 */
const MIN_HELD_TEXT = 24

/** The transcript as last read: positions by tool_use_id and by text. */
const transcript = {
  /** Messages in the transcript; 0 until a read answered (positions unknown). */
  count: 0,
  /** tool_use_id -> the index of the assistant message holding the call. */
  toolAt: new Map<string, number>(),
  /** Every tool call's id, in transcript order: jump targets, drawn or not. */
  toolIds: [] as string[],
  /** `role:text-start` -> indices of the messages it opens. */
  textAt: new Map<string, number[]>(),
  /** Each message's role and whole text, for a row that shows a later block. */
  texts: [] as RowText[],
  /** Set when a row is first drawn: the transcript may have grown. */
  isStale: true,
  /** Ticks since the last read. */
  ticksSinceRead: READ_EVERY_TICKS,
}

/** The key `transcript.textAt` files a message under; undefined for no text. */
function textKey(row: RowText): string | undefined {
  const start = row.text.trim().slice(0, TEXT_KEY_LENGTH)

  return start === '' ? undefined : `${row.role}:${start}`
}

/**
 * Read the transcript again when rows were first drawn since the last read,
 * at most once a second. A failed read (a host with no transcript) keeps the
 * last one.
 */
async function readTranscript($: TickDollar): Promise<void> {
  transcript.ticksSinceRead += 1

  if (!transcript.isStale || transcript.ticksSinceRead < READ_EVERY_TICKS) {
    return
  }

  transcript.isStale = false
  transcript.ticksSinceRead = 0

  let messages: Awaited<ReturnType<TickDollar['session']['messages']>>

  try {
    messages = await $.session.messages()
  } catch {
    return
  }

  if (!Array.isArray(messages)) {
    return
  }

  transcript.count = messages.length
  transcript.toolAt.clear()
  transcript.toolIds = []
  transcript.textAt.clear()
  transcript.texts = messages.map(({ role, text }) => ({ role, text }))

  messages.forEach((message, at) => {
    for (const use of message.toolUses) {
      transcript.toolAt.set(use.tool_use_id, at)
      transcript.toolIds.push(use.tool_use_id)
    }

    const key = textKey(message)

    if (key !== undefined) {
      transcript.textAt.set(key, [...(transcript.textAt.get(key) ?? []), at])
    }
  })
}

/**
 * Every message a row's text could be: those its text opens, else (a reply's
 * later block) those whose whole text holds its start, when that start is
 * long enough to mean one place.
 */
function textCandidates(row: RowText): number[] {
  const key = textKey(row)

  if (key === undefined) {
    return []
  }

  const opened = transcript.textAt.get(key)

  if (opened !== undefined) {
    return opened
  }

  const start = row.text.trim().slice(0, TEXT_KEY_LENGTH)
  const held: number[] = []

  if (start.length < MIN_HELD_TEXT) {
    return held
  }

  transcript.texts.forEach((message, at) => {
    if (message.role === row.role && message.text.includes(start)) {
      held.push(at)
    }
  })

  return held
}

/** A row's position when the transcript names it alone: its tool call, or unique text. */
function exactPos(requestId: string): number | undefined {
  const toolPos = transcript.toolAt.get(requestId)

  if (toolPos !== undefined) {
    return toolPos
  }

  const text = registry.text.get(requestId)
  const candidates = text === undefined ? [] : textCandidates(text)

  return candidates.length === 1 ? candidates[0] : undefined
}

/**
 * Give every unplaced row a transcript position, then sort `order` by it and
 * re-derive what depends on order: each category's newest row and each row's
 * owning prompt.
 *
 * A row the transcript names alone takes that position. One that could be
 * several messages (a repeated prompt) or none (a notice, a status line)
 * goes by its neighbours of the same drawing pass, which the terminal draws
 * top to bottom: the first candidate between the rows drawn just before and
 * just after it, or the neighbour's own position. A row with no placed
 * neighbour stays unplaced: a guess could put it anywhere, and an unplaced
 * row is only left out of the bar and the jumps.
 * A category's new newest row that the tick had hidden as stale is shown
 * again.
 */
async function placeRows($: StateDollar): Promise<void> {
  if (transcript.count === 0) {
    return
  }

  const unplaced = registry.order.filter(id => !registry.pos.has(id))

  for (const id of unplaced) {
    const pos = exactPos(id)

    if (pos !== undefined) {
      registry.pos.set(id, pos)
    }
  }

  const bySeq = [...registry.order].sort((a, b) => (registry.seq.get(a) ?? 0) - (registry.seq.get(b) ?? 0))

  bySeq.forEach((id, at) => {
    if (registry.pos.has(id)) {
      return
    }

    const before = bySeq[at - 1]
    const after = bySeq[at + 1]
    const isSameBatch = (other: string | undefined) =>
      other !== undefined && registry.batch.get(other) === registry.batch.get(id)
    const beforePos = isSameBatch(before) ? registry.pos.get(before as string) : undefined
    const afterPos = isSameBatch(after) ? registry.pos.get(after as string) : undefined
    const text = registry.text.get(id)
    const candidates = text === undefined ? [] : textCandidates(text)
    const floor = beforePos ?? -1
    const ceiling = afterPos ?? Number.MAX_SAFE_INTEGER
    const hasNeighbour = beforePos !== undefined || afterPos !== undefined
    const fromText = hasNeighbour ? candidates.find(c => c >= floor && c <= ceiling) : undefined
    const pos = fromText ?? beforePos ?? afterPos

    if (pos !== undefined) {
      registry.pos.set(id, pos)
    }
  })

  /** Sort key: placed rows by position, unplaced after them; ties by first draw. */
  const posOf = (id: string) => registry.pos.get(id) ?? Number.MAX_SAFE_INTEGER

  registry.order.sort((a, b) => posOf(a) - posOf(b) || (registry.seq.get(a) ?? 0) - (registry.seq.get(b) ?? 0))
  registry.order.forEach((id, at) => registry.index.set(id, at))

  let owner: string | undefined
  const newest = new Map<CategoryId, string>()

  for (const id of registry.order) {
    const category = registry.category.get(id)

    if (registry.prompts.has(id)) {
      owner = id
    } else {
      registry.owner.set(id, owner)
    }

    if (category !== undefined) {
      newest.set(category, id)
    }
  }

  registry.currentPrompt = owner

  for (const [category, id] of newest) {
    registry.newest.set(category, id)

    if (registry.markedStale.delete(id)) {
      await update($, memberOf(isStale, { requestId: id }), () => false)
    }
  }
}

/**
 * Every row a jump can land on, in transcript order, with its position: the
 * drawn scroll targets, and once the transcript is read every tool call it
 * holds, drawn or not (the engine scrolls to an undrawn row by its id).
 * Before a read, a row's position is its index among the drawn targets.
 */
function jumpTargets(): Array<{ requestId: string; at: number }> {
  const drawn = scrollTargets()

  if (transcript.count === 0) {
    return drawn.map((requestId, at) => ({ requestId, at }))
  }

  const placed = drawn.flatMap(requestId => {
    const at = registry.pos.get(requestId)

    return at === undefined ? [] : [{ requestId, at }]
  })
  const undrawn = transcript.toolIds
    .filter(id => !registry.index.has(id) && !registry.unreachable.has(id))
    .map(requestId => ({ requestId, at: transcript.toolAt.get(requestId) ?? 0 }))

  return [...placed, ...undrawn].sort((a, b) => a.at - b.at)
}

// --------------------------------------------------
// Clock tick: registry -> state
// --------------------------------------------------

/** How often the tick may turn row reports into state, in milliseconds. */
const TICK_MS = 250

/** The running tick; one per module load. */
let tickTimer: Timer | undefined

/** The viewport summary last written, so an unchanged one is not written again. */
let lastWrittenViewport: ViewportSummary = NO_VIEWPORT

/**
 * Mark stale every row that drew while a newer row of its category exists,
 * for categories at `[o]`. Each such row reads its `isStale` member, so the
 * write redraws it, and it then draws blank.
 */
async function markStaleRows($: StateDollar): Promise<void> {
  const modes = await read($, shown)

  for (const [requestId, isDrawn] of registry.drawn) {
    const category = registry.category.get(requestId)

    if (!isDrawn || category === undefined || registry.markedStale.has(requestId)) {
      continue
    }

    if (modes[category] !== 'last' || registry.newest.get(category) === requestId) {
      continue
    }

    registry.markedStale.add(requestId)
    await update($, memberOf(isStale, { requestId }), () => true)
  }
}

/** Write the viewport summary when it changed since the last write. */
async function flushViewport($: StateDollar): Promise<void> {
  const summary = summarize()
  const isSame =
    summary.top === lastWrittenViewport.top &&
    summary.bottom === lastWrittenViewport.bottom &&
    summary.count === lastWrittenViewport.count

  if (isSame) {
    return
  }

  lastWrittenViewport = summary
  await update($, viewport, () => summary)
}

/**
 * One tick: when rows reported since the last, place new rows in transcript
 * order, hide superseded `[o]` rows and refresh the scroll bar. Render hooks
 * may not write `$.state`; this does. Each tick opens a new drawing window
 * (`registry.batch`).
 */
async function tick($: TickDollar): Promise<void> {
  registry.batchNo += 1

  if (!registry.isDirty) {
    return
  }

  registry.isDirty = false
  await readTranscript($)
  await placeRows($)
  await markStaleRows($)
  await flushViewport($)

  // A read the throttle held back is still owed: come back for it. Rows the
  // transcript did not hold yet (a reply still streaming) are placed by the
  // read the next first-drawn row asks for.
  registry.isDirty = transcript.isStale
}

/**
 * Start the tick unless one runs. `session.start` (re)starts it with the
 * session's `$`; the band starts it on its first drawing, which covers a
 * plugin enabled mid-session, where no `session.start` fires.
 */
function ensureTick($: TickDollar): void {
  if (tickTimer !== undefined) {
    return
  }

  tickTimer = $.clock.every(TICK_MS, () => {
    tick($).catch(() => undefined)
  })
}

// --------------------------------------------------
// Row drawing decisions
// --------------------------------------------------

/** Tool rows split into edits (diffs) and everything else. */
function toolCategory(tool: string): CategoryId {
  return EDIT_TOOLS.has(tool) ? 'edits' : 'tools'
}

/**
 * A user-role row is the person's own prompt unless it carries a `task`
 * (a background task's notification) or a `from` (a subagent, teammate or
 * other session's message); those belong to Agents.
 */
function userCategory(props: RenderPropsOf['UserMessage']): CategoryId {
  return props.task !== undefined || props.from !== undefined ? 'agents' : 'prompts'
}

/** A row's `onScreen` prop, on any row component (some do not declare it). */
function onScreenOf(props: object): OnScreen | null | undefined {
  return (props as { onScreen?: OnScreen | null }).onScreen
}

/**
 * Whether a row passes its category's toggle.
 *
 * Called while drawing: the reads subscribe the row, so a toggle (`shown`)
 * or, under `[o]`, the tick marking it stale redraws it.
 *
 * @param requestId The row's `e.requestId`.
 * @param category  The checkbox that governs it.
 */
async function passesToggle($: StateDollar, requestId: string, category: CategoryId): Promise<boolean> {
  const mode = (await read($, shown))[category]

  if (mode !== 'last') {
    return mode === 'all'
  }

  // The registry answers at once for a row just drawn; the member makes the
  // row redraw when a newer one supersedes it.
  const isMarkedStale = await read($, memberOf(isStale, { requestId }))

  return !isMarkedStale && registry.newest.get(category) === requestId
}

/**
 * Decide whether a non-prompt transcript row draws, and record the answer.
 *
 * A row is hidden when its category is at `[ ]`, when it is at `[o]` and a
 * newer row of the category exists, or when the prompt it answers is folded.
 *
 * @param row.component The row's component (for the on-screen record).
 * @param row.requestId The row's `e.requestId`.
 * @param row.category  The checkbox that governs it.
 * @param row.onScreen  The row's `onScreen` prop.
 * @param row.screenRows The terminal's height (`e.viewport.rows`), when measured.
 * @param row.text     What a message row says, to place it in the transcript.
 * @returns True to draw the engine's row, false to draw a blank.
 */
async function isRowDrawn(
  $: StateDollar,
  row: {
    component: string
    requestId: string
    category: CategoryId
    onScreen: OnScreen | null | undefined
    screenRows: number | undefined
    text?: RowText
  },
): Promise<boolean> {
  // Before any await: first-drawn order must be dispatch order.
  const owner = registerRow(row.requestId, row.category, false, row.text)

  let isDrawn = await passesToggle($, row.requestId, row.category)

  if (isDrawn && owner !== undefined) {
    isDrawn = !(await read($, memberOf(collapsed, { requestId: owner })))
  }

  recordRow(row.component, row.requestId, isDrawn, row.onScreen, row.screenRows)

  return isDrawn
}

/**
 * What a hidden row draws: an empty Box, which takes no rows. Returning a tree
 * skips the engine's own drawing of the row.
 *
 * @param table The surface's element table (`$.ui.resolve(e)`).
 */
function blank(table: { Box: ElementConstructor<BoxProps> }): RenderElement {
  const { Box } = table

  return <Box />
}

/**
 * The first line of a prompt, marked with an ellipsis when more follows.
 * What a folded prompt shows, so a long paste folds to one row.
 */
function firstLine(text: string): string {
  const newline = text.indexOf('\n')

  return newline < 0 ? text : `${text.slice(0, newline)} …`
}

/**
 * The person's prompt as a pressable row: the fold glyph, then the prompt.
 *
 * A Button holds only strings and Text, so the row is drawn by the mod rather
 * than wrapping the engine's drawing. `marginTop` keeps the blank row the
 * engine draws above a message.
 *
 * @param text        The prompt as typed.
 * @param isCollapsed True draws `▸` and the first line; false `▾` and all of it.
 * @param onToggle    What a press runs.
 */
function promptRow(table: Table, text: string, isCollapsed: boolean, onToggle: () => void): RenderElement {
  const { Box, Button, Text } = table
  const body = isCollapsed ? firstLine(text) : text

  const children = isCollapsed
    ? [<Text bold>{'▸ '}</Text>, body, <Text dimColor>{'  (folded, click to unfold)'}</Text>]
    : [<Text bold>{'▾ '}</Text>, body]

  return (
    <Box marginTop={1}>
      <Button key="fold" plain onPress={onToggle}>
        {children}
      </Button>
    </Box>
  )
}

// --------------------------------------------------
// Output labels: the rules, the cache and Haiku
// --------------------------------------------------
// The text rules decide most outputs (hooks/classify.ts). The rest are asked
// of Haiku, outside the drawing: the row queues its text, a clock tick asks
// Haiku about at most two of them, and the answer is kept in the module's
// map, in the store (so a later session draws it at once) and in the row's
// own member (so the row redraws with it).

/** `$.store` key the cached labels live under, across sessions (D3). */
const LABEL_STORE_KEY = 'labels'

/** How many labels the cache holds; the oldest is dropped past that (D11). */
const MAX_CACHED_LABELS = 5000

/** How often the label clock asks Haiku, in milliseconds. */
const LABEL_TICK_MS = 1500

/** How many outputs one tick asks Haiku about. */
const LABELS_PER_TICK = 2

/** The cap on Haiku's answer, in tokens: it answers with one word. */
const LABEL_MAX_TOKENS = 8

/** How long one Haiku call may take, in milliseconds. */
const LABEL_TIMEOUT_MS = 20_000

/** The labels Haiku answered, by requestId; the store's cache, in memory. */
const cachedLabels = new Map<string, OutputLabel>()

/** The outputs waiting for a label, by requestId (the queue). */
const waitingLabels = new Map<string, string>()

/** The ids Haiku was asked about this session; one that failed is not asked again. */
const askedLabels = new Set<string>()

/** The label clock; one per module load, restarted by `session.start`. */
let labelTimer: Timer | undefined

/**
 * True while a tick is asking Haiku about the queued outputs. A tick that
 * finds it true goes no further, so a slow call never overlaps the next tick.
 */
let isAskingLabels = false

/** A hook's `$` narrowed to what the label clock needs: state, the store, the model. */
type LabelDollar = StateDollar & Pick<EngineInterface, 'store' | 'model'>

/**
 * Whether a value read back from the store is one of the eight categories.
 *
 * @param value Whatever `$.store` answered.
 * @returns Whether the value names a category.
 */
function isOutputLabel(value: unknown): value is OutputLabel {
  return typeof value === 'string' && LABELS.some(label => label === value)
}

/**
 * The label a row draws: the rules' answer, else the cached one, else the
 * member Haiku wrote.
 *
 * The member is read only when the two others say nothing, so a row the
 * rules decided is never subscribed to it and never redrawn by it.
 *
 * @param $         The hook's `$`.
 * @param requestId The row's requestId (the message id).
 * @param text      The output's text, for the rules.
 * @returns The category, or undefined while it is undecided.
 */
async function labelOf($: StateDollar, requestId: string, text: string): Promise<OutputLabel | undefined> {
  const byRules = classifyByRules(text)

  if (byRules !== undefined) {
    return byRules
  }

  const cached = cachedLabels.get(requestId)

  if (cached !== undefined) {
    return cached
  }

  const { value } = await $.state.get({ ...aiLabel, id: requestId })

  return value
}

/**
 * Ask Haiku about an output the rules could not label, once per session.
 *
 * An output that is already queued, or that Haiku was asked about already
 * (and failed to answer), is left alone.
 *
 * @param requestId The row's requestId (the message id).
 * @param text      The output's text, for Haiku.
 */
function queueLabel(requestId: string, text: string): void {
  if (askedLabels.has(requestId) || waitingLabels.has(requestId)) {
    return
  }

  waitingLabels.set(requestId, text)
}

/**
 * Load the cached labels from the store, so a session that resumes draws the
 * labels it already paid for.
 *
 * @param $ The hook's `$`.
 */
async function loadLabels($: StoreDollar): Promise<void> {
  const stored = await $.store.get(LABEL_STORE_KEY)

  if (typeof stored !== 'object' || stored === null) {
    return
  }

  for (const [id, label] of Object.entries(stored)) {
    if (isOutputLabel(label)) {
      cachedLabels.set(id, label)
    }
  }
}

/**
 * The cached labels as the store keeps them: a plain object of message id
 * to category, oldest first.
 *
 * @returns The labels, as JSON data.
 */
function labelsAsStoreValue(): Record<string, OutputLabel> {
  const value: Record<string, OutputLabel> = {}

  for (const [id, label] of cachedLabels) {
    value[id] = label
  }

  return value
}

/**
 * Remember a label Haiku gave: in the module's map, in the store and in the
 * row's own member, so the row redraws with it.
 *
 * The cache is capped (D11): the oldest label is dropped once there are too
 * many, since a later session is served by the freshest ones.
 *
 * @param $         The hook's `$`.
 * @param requestId The row's requestId (the message id).
 * @param label     The category Haiku named.
 */
async function rememberLabel($: LabelDollar, requestId: string, label: OutputLabel): Promise<void> {
  cachedLabels.set(requestId, label)

  while (cachedLabels.size > MAX_CACHED_LABELS) {
    const oldest = cachedLabels.keys().next().value

    if (oldest === undefined) {
      break
    }

    cachedLabels.delete(oldest)
  }

  await $.store.set(LABEL_STORE_KEY, labelsAsStoreValue())
  await $.state.set({ ...aiLabel, id: requestId }, label)
}

/**
 * One tick of the label clock: ask Haiku about at most two of the queued
 * outputs and remember what it answers.
 *
 * A call that failed (an API error, an abort, a reply with no text) leaves no
 * label and is not made again this session (D6, D11).
 *
 * @param $ The hook's `$`.
 */
async function askAboutLabels($: LabelDollar): Promise<void> {
  isAskingLabels = true

  try {
    for (let asked = 0; asked < LABELS_PER_TICK; asked += 1) {
      const next = waitingLabels.entries().next()

      if (next.done === true) {
        return
      }

      const [requestId, text] = next.value

      waitingLabels.delete(requestId)
      askedLabels.add(requestId)

      const result = await $.model.complete({
        model: 'haiku',
        prompt: haikuPrompt(text),
        maxTokens: LABEL_MAX_TOKENS,
        timeoutMs: LABEL_TIMEOUT_MS,
      })

      if (!result.isAnswered) {
        continue
      }

      await rememberLabel($, requestId, parseHaikuReply(result.text) ?? 'Explain')
    }
  } finally {
    isAskingLabels = false
  }
}

// --------------------------------------------------
// The session
// --------------------------------------------------
// The flags and the highlights are kept in the store, over every session, so
// a later session finds them again. Each entry names the session that wrote
// it, and a pane lists only the entries of its own session (D20): the flags
// and the highlights of another session are dropped, never listed last.

/**
 * The id of the session the mod runs in, if the engine tells it.
 *
 * The id is what tells an entry of this session from an entry of another
 * one. A session that cannot be named (a surface with no session id, a
 * refusal) leaves the entries to be placed by their words alone.
 *
 * @param $ The hook's `$`.
 * @returns The session's id, or undefined when it is not known.
 */
async function sessionIdOf($: FlagDollar): Promise<string | undefined> {
  try {
    const id = await $.session.id()

    return typeof id === 'string' && id !== '' ? id : undefined
  } catch {
    return undefined
  }
}

// --------------------------------------------------
// Flags
// --------------------------------------------------
// A flag marks one output as worth keeping: the chip in front of it carries
// the flag's mark, and the Flags pane lists the flagged outputs of the
// session, each one a way back to its row.
//
// The flags live in `$.store` under one key, by message id (D3), so a later
// session finds them again; the pane reads the session's copy and each row
// reads its own member, which a press on the chip writes.

/** `$.store` key the flags live under, across sessions (D3). */
const FLAG_STORE_KEY = 'flags'

/** `$.store` key the person's own order of the flags lives under (D15). */
const FLAG_ORDER_STORE_KEY = 'flagOrder'

/** How many flags one session holds; the next one is refused (D11). */
const MAX_FLAGS = 200

/** How many ids the order holds; the ones past it are dropped (D11). */
const MAX_FLAG_ORDER = 200

/** The pane's id, the `ui.render` matcher and the open's id alike. */
const FLAGS_PANE = 'flags'

/** The pane's title: the flags on top, the highlights below. */
const PANE_TITLE = 'Flags · Highlights'

/** The rule between the pane's two sections. */
const RULE = '─'.repeat(24)

/**
 * The key a flag row's drag handle carries in the pane (`drag:<id>`), and so
 * the way a post from one is told from another post of the plugin's.
 */
const HANDLE_PREFIX = 'drag:'

/**
 * Read a stored flag back as a flag.
 *
 * @param value Whatever `$.store` answered.
 * @returns The flag, or undefined when the value is not one.
 */
function asFlagEntry(value: unknown): FlagEntry | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }

  const stored = value as { label?: unknown; preview?: unknown; at?: unknown; sessionId?: unknown }

  if (typeof stored.preview !== 'string' || typeof stored.at !== 'number') {
    return undefined
  }

  return {
    label: isOutputLabel(stored.label) ? stored.label : null,
    preview: stored.preview,
    at: stored.at,
    sessionId: typeof stored.sessionId === 'string' ? stored.sessionId : undefined,
  }
}

/**
 * Read a stored order back as a list of flag ids.
 *
 * @param value Whatever `$.store` answered.
 * @returns The ids, without a duplicate, without a name that is not a string
 *          and no more than the cap holds.
 */
function asFlagOrder(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const ids: string[] = []

  for (const entry of value) {
    if (typeof entry === 'string' && !ids.includes(entry)) {
      ids.push(entry)
    }
  }

  return ids.slice(0, MAX_FLAG_ORDER)
}

/**
 * Read a handle's post back as a move.
 *
 * A post is code-origin: it is input to check, not a fact, so anything that
 * is not a move of a named flag is ignored.
 *
 * @param value Whatever the handle posted.
 * @returns The move, or undefined when the post is not one.
 */
function asMoveMessage(value: unknown): { move: string; by: number } | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }

  const posted = value as { move?: unknown; by?: unknown }

  if (typeof posted.move !== 'string' || typeof posted.by !== 'number') {
    return undefined
  }

  return { move: posted.move, by: posted.by }
}

/**
 * Read a handle's post back as a request to remove an entry.
 *
 * A post is code-origin: it is input to check, not a fact, so anything that
 * is not the naming of an entry is ignored.
 *
 * @param value Whatever the handle posted.
 * @returns The entry's key, or undefined when the post is not one.
 */
function asConfirmMessage(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }

  const posted = value as { confirm?: unknown }

  if (typeof posted.confirm !== 'string' || posted.confirm === '') {
    return undefined
  }

  return posted.confirm
}

/**
 * Load the stored order into the session: the value the pane reads, so a
 * resumed session shows the flags in the order the person left them.
 *
 * @param $ The hook's `$`.
 */
async function loadFlagOrder($: FlagDollar): Promise<void> {
  const stored = await $.store.get(FLAG_ORDER_STORE_KEY)

  await update($, flagOrderList, () => asFlagOrder(stored))
}

/**
 * Take a flag out of the person's order: the flag is gone, so its place in
 * the order goes with it.
 *
 * @param $  The hook's `$`.
 * @param id The row's requestId (the message id).
 */
async function forgetInOrder($: FlagDollar, id: string): Promise<void> {
  const next = await update($, flagOrderList, current => current.filter(entry => entry !== id))

  await $.store.set(FLAG_ORDER_STORE_KEY, next)
}

/**
 * Read a stored order of the highlights back as a list of entry keys.
 *
 * @param value Whatever `$.store` answered.
 * @returns The keys, without a duplicate, without a name that is not a string
 *          and no more than the cap holds.
 */
function asHlOrder(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const keys: string[] = []

  for (const entry of value) {
    if (typeof entry === 'string' && !keys.includes(entry)) {
      keys.push(entry)
    }
  }

  return keys.slice(0, MAX_HL_ORDER)
}

/**
 * Load the stored order of the highlights into the session: the value the
 * pane reads, so a resumed session shows the highlights in the order the
 * person left them.
 *
 * @param $ The hook's `$`.
 */
async function loadHlOrder($: FlagDollar): Promise<void> {
  const stored = await $.store.get(HL_ORDER_STORE_KEY)

  await update($, hlOrderList, () => asHlOrder(stored))
}

/**
 * Take a highlight out of the person's order: the highlight is gone, so its
 * place in the order goes with it.
 *
 * @param $      The hook's `$`.
 * @param entryKey The highlight's entry key.
 */
async function forgetInHlOrder($: FlagDollar, entryKey: string): Promise<void> {
  const next = await update($, hlOrderList, current => current.filter(entry => entry !== entryKey))

  await $.store.set(HL_ORDER_STORE_KEY, next)
}

/**
 * Load the stored flags into the session: the value the pane reads and the
 * member each row reads, so a resumed session shows its flags at once.
 *
 * @param $ The hook's `$`.
 */
async function loadFlags($: FlagDollar): Promise<void> {
  const stored = await $.store.get(FLAG_STORE_KEY)

  if (typeof stored !== 'object' || stored === null) {
    return
  }

  const entries: Record<string, FlagEntry> = {}

  for (const [id, value] of Object.entries(stored)) {
    const entry = asFlagEntry(value)

    if (entry !== undefined) {
      entries[id] = entry
      await $.state.set({ ...isFlagged, id }, true)
    }
  }

  await update($, flags, () => entries)
}

/**
 * Flag an output, or unflag one that is flagged.
 *
 * The flag goes to the store (a later session finds it), to the value the
 * pane reads and to the row's own member, which redraws the row with the
 * flag's mark.
 *
 * @param $      The hook's `$`.
 * @param id     The row's requestId (the message id).
 * @param label  The category the output carries, if it has one.
 * @param text   The output's text, for the preview.
 */
async function toggleFlag($: FlagDollar, id: string, label: OutputLabel | undefined, text: string): Promise<void> {
  const stored = await read($, flags)
  const isNowFlagged = stored[id] === undefined

  if (isNowFlagged && Object.keys(stored).length >= MAX_FLAGS) {
    $.ui.toast(`output-filter: ${MAX_FLAGS} flags is the cap; unflag one first.`)

    return
  }

  const sessionId = await sessionIdOf($)
  const entry: FlagEntry = {
    label: label ?? null,
    preview: previewOf(text),
    at: Date.now(),
    sessionId,
  }
  const next = await update($, flags, current => {
    const copy = { ...current }

    if (copy[id] === undefined) {
      copy[id] = entry
    } else {
      delete copy[id]
    }

    return copy
  })

  await $.store.set(FLAG_STORE_KEY, next)
  await $.state.set({ ...isFlagged, id }, next[id] !== undefined)

  if (next[id] === undefined) {
    // The flag is gone, so its place in the person's order goes with it.
    await forgetInOrder($, id)
  }
}

/**
 * The flags in the order the pane lists them: the stored flags, placed by
 * the transcript's messages (D4) and by the person's own order (D15).
 *
 * A flag of another session is dropped (D20): the pane lists this session's
 * flags only.
 *
 * @param $ The hook's `$`.
 * @returns The flags, in the pane's order.
 */
async function orderedFlags($: FlagDollar): Promise<FlagOrderEntry[]> {
  const stored = await read($, flags)
  const custom = await read($, flagOrderList)
  const sessionId = await sessionIdOf($)
  let rows: readonly { role: string; text: string }[] = []

  try {
    const messages = await $.session.messages()

    if (Array.isArray(messages)) {
      rows = messages
    }
  } catch {
    rows = []
  }

  return flagOrder(stored, rows, custom, sessionId)
}

/**
 * Bring a transcript row into view.
 *
 * A refusal (a row the engine does not draw, a move it did not take) is
 * told to the person, once per press.
 *
 * @param $         The hook's `$`.
 * @param requestId The row's requestId.
 * @param block     Where the row lands in the window.
 */
async function scrollToRow($: UiDollar, requestId: string, block: UiScrollBlock): Promise<void> {
  try {
    const result = await $.ui.scroll({ to: { requestId }, block })

    if (result.deny !== undefined) {
      $.ui.toast(`output-filter: scroll refused for ${requestId}: ${result.deny}`)
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)

    $.ui.toast(`output-filter: scroll refused for ${requestId}: ${reason}`)
  }
}

/**
 * Bring a flagged output's row into view.
 *
 * @param $         The hook's `$`.
 * @param requestId The flagged row's requestId.
 */
async function scrollToFlag($: UiDollar, requestId: string): Promise<void> {
  await scrollToRow($, requestId, 'start')
}

/**
 * Move the flag cursor one flag on and bring that flag's row into view.
 *
 * The flag the cursor lands on is the pane's active entry: the `remove`
 * button asks about it.
 *
 * @param $         The hook's `$`.
 * @param direction 1 to go on, -1 to go back.
 */
async function moveFlag($: FlagDollar, direction: 1 | -1): Promise<void> {
  const order = await orderedFlags($)
  const cursor = await read($, flagCursor)
  const next = step(order, cursor, direction)

  if (next === undefined) {
    return
  }

  await update($, flagCursor, () => next)
  await update($, activeEntry, () => flagRowKey(next))
  await scrollToFlag($, next)
}

/**
 * Put the flag cursor on a flag and bring its row into view.
 *
 * The flag is the pane's active entry: the `remove` button asks about it.
 *
 * @param $  The hook's `$`.
 * @param id The flagged row's requestId.
 */
async function goToFlag($: FlagDollar, id: string): Promise<void> {
  await update($, flagCursor, () => id)
  await update($, activeEntry, () => flagRowKey(id))
  await scrollToFlag($, id)
}

// --------------------------------------------------
// Highlights
// --------------------------------------------------
// A highlight is a passage of an output the person selected with the mouse:
// the words, as plain text, so the same words are found in the output again
// however the markdown around them is written.
//
// The highlights live in `$.store` under one key, by message id (D3), so a
// later session finds them again; each row reads its own member, which a
// write redraws.

/** `$.store` key the highlights live under, across sessions (D3). */
const HIGHLIGHT_STORE_KEY = 'highlights'

/** `$.store` key the person's own order of the highlights lives under (D22). */
const HL_ORDER_STORE_KEY = 'hlOrder'

/** How many highlights one message may hold; the next one is refused (D11). */
const MAX_HIGHLIGHTS = 20

/** How many keys the highlights' order holds; the ones past it are dropped. */
const MAX_HL_ORDER = 400

/**
 * The highlights of the session, by message id: the store's copy, in memory.
 *
 * Each entry holds the words and the session that marked them, so the pane
 * can tell this session's highlights from another's (D20).
 */
const highlightMap = new Map<string, HighlightStoreEntry>()

/** A hook's `$` narrowed to what the highlights need: state, the store, the session, the ui. */
type HighlightDollar = StateDollar & Pick<EngineInterface, 'store' | 'session' | 'ui'>

/**
 * A hook's `$` narrowed to what the pane's entries need: state, the clock
 * (the double press is timed with it), the store, the session and the ui.
 */
type PaneDollar = StateDollar & Pick<EngineInterface, 'clock' | 'store' | 'session' | 'ui'>

/** What `/hl` says when the person has selected nothing. */
const NOTHING_SELECTED =
  'Nothing is selected. Highlights need the fullscreen layout: select text inside one output, then run /hl.'

/**
 * What `/hl` says when the selection lies across two paragraphs: the words
 * would never be drawn, so they are not kept (checks.md F1).
 */
const SPANS_PARAGRAPHS =
  'That selection spans paragraphs; select text inside one paragraph, then run /hl.'

/**
 * Read a stored value back as one message's highlights.
 *
 * Two shapes are read: the newer one, an object holding the words and the
 * session that marked them, and the older one, a plain list of words (D20).
 *
 * @param value Whatever `$.store` answered.
 * @returns The highlights, or undefined when the value holds none.
 */
function asHighlightEntry(value: unknown): HighlightStoreEntry | undefined {
  if (Array.isArray(value)) {
    const texts = value
      .filter((item): item is string => typeof item === 'string' && item !== '')
      .slice(0, MAX_HIGHLIGHTS)

    return texts.length > 0 ? { texts } : undefined
  }

  if (typeof value !== 'object' || value === null) {
    return undefined
  }

  const stored = value as { texts?: unknown; sessionId?: unknown }

  if (!Array.isArray(stored.texts)) {
    return undefined
  }

  const texts = stored.texts
    .filter((item): item is string => typeof item === 'string' && item !== '')
    .slice(0, MAX_HIGHLIGHTS)

  if (texts.length === 0) {
    return undefined
  }

  return {
    texts,
    sessionId: typeof stored.sessionId === 'string' ? stored.sessionId : undefined,
  }
}

/**
 * Load the stored highlights into the session: the value the rows read and
 * the module's map, so a resumed session shows its highlights at once.
 *
 * The map holds the store's highlights and nothing else: a highlight of an
 * earlier session that the store does not hold is gone with that session.
 * The rows read their own member whatever session marked the words, so a
 * highlight of an earlier session still draws on its own row (D20).
 *
 * @param $ The hook's `$`.
 */
async function loadHighlights($: HighlightDollar): Promise<void> {
  const stored = await $.store.get(HIGHLIGHT_STORE_KEY)
  const entries = typeof stored === 'object' && stored !== null ? stored : {}

  highlightMap.clear()

  for (const [id, value] of Object.entries(entries)) {
    const entry = asHighlightEntry(value)

    if (entry !== undefined) {
      highlightMap.set(id, entry)
      await $.state.set({ ...highlights, id }, entry.texts)
    }
  }
}

/**
 * The highlights as the store keeps them: a plain object of message id to
 * the words and the session that marked them.
 *
 * @returns The highlights, as JSON data.
 */
function highlightsAsStoreValue(): Record<string, HighlightStoreEntry> {
  const value: Record<string, HighlightStoreEntry> = {}

  for (const [id, entry] of highlightMap) {
    value[id] = { texts: entry.texts, sessionId: entry.sessionId }
  }

  return value
}

/**
 * The highlights of one message: the member the row read (the freshest copy),
 * else the module's map (what the store held when the session began).
 *
 * @param $  The hook's `$`.
 * @param id The message id (the row's requestId).
 * @returns The message's highlights; empty when it holds none.
 */
async function highlightsOf($: StateDollar, id: string): Promise<string[]> {
  const { value } = await $.state.get({ ...highlights, id })

  return value ?? highlightMap.get(id)?.texts ?? []
}

/**
 * Remember a message's highlights: in the module's map, in the store (a later
 * session finds them) and in the row's own member (which redraws the row).
 *
 * The map's entry names this session, so the pane lists these highlights and
 * not another's (D20).
 *
 * @param $   The hook's `$`.
 * @param id  The message id (the row's requestId).
 * @param list The highlights the message holds.
 */
async function setHighlights($: HighlightDollar, id: string, list: string[]): Promise<void> {
  if (list.length === 0) {
    highlightMap.delete(id)
  } else {
    highlightMap.set(id, { texts: list, sessionId: await sessionIdOf($) })
  }

  await $.store.set(HIGHLIGHT_STORE_KEY, highlightsAsStoreValue())
  await $.state.set({ ...highlights, id }, list)
}

/**
 * Whether a row's text holds the selection in one of its blocks.
 *
 * A selection that lies across two paragraphs would never be drawn (the
 * blocks are drawn apart), so it is refused (checks.md F1). A selection no
 * block holds at all is kept: the row's text may be unknown, or the words may
 * differ from the row's own (a list glyph the terminal draws), and refusing
 * those would lose a highlight the person meant.
 *
 * @param text The row's whole text.
 * @param held The selection's words, as plain text.
 * @returns Whether the selection lies across blocks.
 */
function spansBlocks(text: string, held: string): boolean {
  if (!normalize(text).includes(held)) {
    return false
  }

  return !splitBlocks(text).some(block => {
    const segments = highlightSegments(block, [held])

    return segments !== undefined && segments.some(segment => segment.isHit)
  })
}

/**
 * The `/hl` action: the selected words become a highlight of the output they
 * lie in, or go away when they are one already. `clear` empties that output's
 * highlights.
 *
 * @param $      The hook's `$`.
 * @param action `clear` empties the output's highlights; anything else toggles.
 * @returns The message the command prints and the band's button toasts.
 */
async function runHighlight($: HighlightDollar, action: string): Promise<string> {
  const selection = await $.ui.selection()

  if (selection === undefined) {
    return NOTHING_SELECTED
  }

  const id = selection.requestId

  if (id === undefined) {
    return 'Select text inside a single output.'
  }

  if (action === 'clear') {
    await setHighlights($, id, [])

    return 'Highlights cleared.'
  }

  const text = normalize(selection.text)

  if (text === '') {
    return NOTHING_SELECTED
  }

  // A selection that lies across two paragraphs is never drawn, so it is not
  // kept either.
  const rowText = registry.text.get(id)?.text

  if (rowText !== undefined && spansBlocks(rowText, text)) {
    return SPANS_PARAGRAPHS
  }

  const list = await highlightsOf($, id)
  const isHeld = list.includes(text)

  if (!isHeld && list.length >= MAX_HIGHLIGHTS) {
    return `That output already holds ${MAX_HIGHLIGHTS} highlights; remove one first.`
  }

  await setHighlights($, id, isHeld ? list.filter(held => held !== text) : [...list, text])

  return isHeld ? 'Highlight removed.' : 'Highlighted.'
}

/**
 * Take the highlights of a message off, the way `/hl` takes one off.
 *
 * The write path is the one `/hl` uses: the module's map, the store (a later
 * session finds them) and the row's own member, which redraws the row with
 * the highlights gone.
 *
 * @param $     The hook's `$`.
 * @param id    The message id (the row's requestId).
 * @param texts The highlights to take off.
 */
async function removeHighlights($: HighlightDollar, id: string, texts: readonly string[]): Promise<void> {
  const list = await highlightsOf($, id)
  const next = list.filter(held => !texts.includes(held))

  if (next.length === list.length) {
    return
  }

  await setHighlights($, id, next)
}

/**
 * The highlights in the order the pane lists them: the session's highlights,
 * placed by the transcript's messages and by the person's own order (D22).
 *
 * A highlight of another session is dropped (D20): the pane lists this
 * session's highlights only.
 *
 * @param $ The hook's `$`.
 * @returns The highlights, in the pane's order.
 */
async function orderedHighlights($: HighlightDollar): Promise<HighlightOrderEntry[]> {
  const custom = await read($, hlOrderList)
  const sessionId = await sessionIdOf($)
  let rows: readonly { role: string; text: string }[] = []

  try {
    const messages = await $.session.messages()

    if (Array.isArray(messages)) {
      rows = messages
    }
  } catch {
    rows = []
  }

  return highlightOrder(highlightMap, rows, custom, sessionId)
}

/**
 * Put the highlight cursor on a highlight and bring its row into view.
 *
 * The highlight is the pane's active entry: the `remove` button asks about
 * it.
 *
 * @param $     The hook's `$`.
 * @param entry The highlight the cursor lands on.
 */
async function goToHighlight($: HighlightDollar, entry: HighlightOrderEntry): Promise<void> {
  await update($, hlCursor, () => highlightKey(entry.id, entry.text))
  await update($, activeEntry, () => highlightRowKey(entry.id, entry.text))
  await scrollToRow($, entry.id, 'center')
}

/**
 * Move the highlight cursor one highlight on and bring that highlight's row
 * into view.
 *
 * @param $         The hook's `$`.
 * @param direction 1 to go on, -1 to go back.
 */
async function moveHighlight($: HighlightDollar, direction: 1 | -1): Promise<void> {
  const order = await orderedHighlights($)
  const cursor = await read($, hlCursor)
  const next = highlightStep(order, cursor, direction)

  if (next === undefined) {
    return
  }

  await goToHighlight($, next)
}

// --------------------------------------------------
// The entries of the pane
// --------------------------------------------------
// The pane lists two kinds of entry: the flags (an output the person kept)
// and the highlights (a passage of an output the person marked). A press on
// an entry jumps to it.
//
// The engine reports no double click, so the mod times the presses itself:
// two presses on one entry within the double-press window are a double press,
// and the pane then asks whether the entry is to be removed.

/** The window within which two presses on one entry are a double press. */
const DOUBLE_PRESS_MS = 400

/** The last press of each entry of the pane, by the entry's key. */
const lastPress = new Map<string, number>()

/** The key of a flag's row in the pane. */
const FLAG_ROW_PREFIX = 'go:'

/** The key of a highlight's row in the pane. */
const HIGHLIGHT_ROW_PREFIX = 'go-hl:'

/** The prefix of a highlight's entry key, the one the pane's moves carry. */
const HIGHLIGHT_ENTRY_PREFIX = 'hl:'

/**
 * The row key of a flag in the pane: the flag's id behind `go:`.
 *
 * @param id The flagged row's requestId (the message id).
 * @returns The row's key.
 */
function flagRowKey(id: string): string {
  return `${FLAG_ROW_PREFIX}${id}`
}

/**
 * The row key of a highlight in the pane: the message id and the place of the
 * words in that message's list, behind `go-hl:`.
 *
 * @param id   The message id the highlight belongs to.
 * @param text The highlight's words.
 * @returns The row's key.
 */
function highlightRowKey(id: string, text: string): string {
  const index = (highlightMap.get(id)?.texts ?? []).indexOf(text)

  return `${HIGHLIGHT_ROW_PREFIX}${id}:${index}`
}

/**
 * The row key of the entry an entry key names: the handle of a row posts its
 * entry key, and the pane answers about the row that holds it.
 *
 * A flag's entry key is its message id; a highlight's is its entry key, the
 * message id and the words behind `hl:`.
 *
 * @param entryKey The entry's key, as a handle carries it.
 * @returns The row's key, or undefined when the entry is gone.
 */
function rowKeyOfEntry(entryKey: string): string | undefined {
  if (!entryKey.startsWith(HIGHLIGHT_ENTRY_PREFIX)) {
    return flagRowKey(entryKey)
  }

  const rest = entryKey.slice(HIGHLIGHT_ENTRY_PREFIX.length)
  const at = rest.lastIndexOf('\n')

  if (at < 0) {
    return undefined
  }

  const id = rest.slice(0, at)
  const text = rest.slice(at + 1)
  const index = (highlightMap.get(id)?.texts ?? []).indexOf(text)

  if (index < 0) {
    return undefined
  }

  return `${HIGHLIGHT_ROW_PREFIX}${id}:${index}`
}

/**
 * What a press on an entry of the pane does: it jumps to the entry, and a
 * second press on the same entry within the double-press window asks whether
 * the entry is to be removed.
 *
 * The entry becomes the pane's active entry, so the `remove` button asks
 * about it (D21).
 *
 * @param $    The hook's `$`.
 * @param key  The entry's key.
 * @param jump What the press jumps to.
 */
async function pressEntry($: PaneDollar, key: string, jump: () => Promise<void>): Promise<void> {
  const now = await $.clock.now()
  const before = lastPress.get(key)

  lastPress.set(key, now)

  await update($, activeEntry, () => key)
  await jump()

  if (before !== undefined && now - before <= DOUBLE_PRESS_MS) {
    await update($, confirmRemove, () => key)
  }
}

/**
 * Ask whether an entry is to be removed: the pane draws the question under
 * the entry.
 *
 * This is what the `✕` of a row and the `remove` button of the header do
 * (D21): both end in the same question.
 *
 * @param $   The hook's `$`.
 * @param key The entry's row key.
 */
async function askRemove($: PaneDollar, key: string): Promise<void> {
  if (key === '') {
    return
  }

  await update($, confirmRemove, () => key)
}

/**
 * Ask whether the active entry is to be removed: the one the person last
 * pressed or travelled to.
 *
 * @param $ The hook's `$`.
 */
async function askRemoveActive($: PaneDollar): Promise<void> {
  const active = await read($, activeEntry)

  if (active === null) {
    $.ui.toast('output-filter: no entry to remove yet: press one first.')

    return
  }

  await askRemove($, active)
}

/**
 * Forget that an entry's removal is asked for.
 *
 * @param $   The hook's `$`.
 * @param key The entry's key; only that entry's question is answered.
 */
async function clearConfirm($: PaneDollar, key: string): Promise<void> {
  if ((await read($, confirmRemove)) !== key) {
    return
  }

  await update($, confirmRemove, () => null)
}

/**
 * Remove the entry the pane asks about: a flag is unflagged, a highlight is
 * taken off.
 *
 * The write paths are the ones the chip and `/hl` use, so the row redraws
 * itself; the flag leaves the person's order and so does the highlight.
 *
 * @param $  The hook's `$`.
 * @param key The entry's key.
 */
async function removeEntry($: PaneDollar, key: string): Promise<void> {
  if (key.startsWith(HIGHLIGHT_ROW_PREFIX)) {
    const rest = key.slice(HIGHLIGHT_ROW_PREFIX.length)
    const at = rest.lastIndexOf(':')
    const id = rest.slice(0, at)
    const index = Number(rest.slice(at + 1))
    const text = (highlightMap.get(id)?.texts ?? [])[index]

    if (text !== undefined) {
      await removeHighlights($, id, [text])
      await forgetInHlOrder($, highlightEntryKey(id, text))
    }
  } else if (key.startsWith(FLAG_ROW_PREFIX)) {
    const id = key.slice(FLAG_ROW_PREFIX.length)
    const stored = await read($, flags)

    if (stored[id] !== undefined) {
      await toggleFlag($, id, undefined, registry.text.get(id)?.text ?? '')
    }
  }

  await update($, confirmRemove, () => null)
}

// --------------------------------------------------
// Scrolling
// --------------------------------------------------

/** The refusal last shown, so a drag the engine refuses toasts once, not per move. */
let lastToastedDeny: string | undefined

/** Most rows a press tries before it gives up and tells the person why. */
const MAX_SCROLL_TRIES = 6

/** The refusal `$.ui.scroll` gives for an id with no drawing (a folded tool call). */
const NOT_DRAWN = 'nothing drawn'

/**
 * The rows from index `at` outward, as scroll targets: `at` first, then one
 * row each side at a time, the `toward` side first. A press tries them in
 * turn, so a row the engine no longer draws falls back to its neighbour.
 *
 * @param ids    Jump targets in transcript order.
 * @param at     The index the press wants.
 * @param block  Where each row lands in the window.
 * @param toward -1 to try earlier rows first, 1 later ones.
 */
function outward(ids: string[], at: number, block: UiScrollBlock, toward: -1 | 1): ScrollTarget[] {
  const targets: ScrollTarget[] = []

  for (let step = 0; targets.length < ids.length && step <= ids.length; step += 1) {
    const sides = step === 0 ? [at] : [at + toward * step, at - toward * step]

    for (const index of sides) {
      const requestId = ids[index]

      if (requestId !== undefined) {
        targets.push({ requestId, block })
      }
    }
  }

  return targets
}

/**
 * The rows a press on track cell `cell` jumps to, best first: the last jump
 * target at or before that fraction of the transcript (the first target when
 * none is). The last cell lands the last row at the window's bottom, any
 * other cell its row at the top.
 *
 * @param cell  0-based cell index.
 * @param cells The track's length in cells.
 */
function cellTargets(cell: number, cells: number): ScrollTarget[] {
  const targets = jumpTargets()
  const ids = targets.map(({ requestId }) => requestId)
  const count = transcript.count > 0 ? transcript.count : targets.length

  if (cell === cells - 1) {
    return outward(ids, ids.length - 1, 'end', -1)
  }

  const wanted = Math.floor((cell * count) / cells)
  const atOrBefore = targets.filter(({ at }) => at <= wanted).length - 1

  return outward(ids, Math.max(0, atOrBefore), 'start', -1)
}

/**
 * Which track cells the thumb fills: the viewport's rows as a share of all
 * targets, at least one cell.
 *
 * @returns Inclusive cell range, or undefined while the position is unknown.
 */
function thumbRange(summary: ViewportSummary, cells: number): { start: number; end: number } | undefined {
  if (summary.count === 0 || summary.top < 0) {
    return undefined
  }

  const start = Math.min(cells - 1, Math.floor((summary.top * cells) / summary.count))
  const end = Math.min(cells - 1, Math.max(start, Math.ceil(((summary.bottom + 1) * cells) / summary.count) - 1))

  return { start, end }
}

/**
 * Scroll the transcript to the first of `targets` the engine can show,
 * telling the person once when it refuses them all.
 *
 * A row refused as drawn nowhere (a tool call a ToolGroup folded) is marked
 * unreachable and the next target tried, at most MAX_SCROLL_TRIES; any other
 * refusal (the main screen, another move first) ends the press.
 *
 * Only a press may call it: the engine moves the transcript only in answer to
 * the person's own input, and refuses a move a `Client`'s pointer post asks
 * for (`not person-initiated`), which is why the track is cells to click and
 * not a thumb to drag.
 */
async function scrollTo($: UiDollar, targets: ScrollTarget[]): Promise<void> {
  if (targets.length === 0) {
    return
  }

  let deny: string | undefined

  for (const target of targets.slice(0, MAX_SCROLL_TRIES)) {
    // A throw (a surface with no transcript to scroll) counts as a refusal:
    // the press that asked must go on either way.
    try {
      deny = (await $.ui.scroll({ to: { requestId: target.requestId }, block: target.block })).deny
    } catch (error) {
      deny = error instanceof Error ? error.message : String(error)
    }

    if (deny === undefined || !deny.includes(NOT_DRAWN)) {
      break
    }

    registry.unreachable.add(target.requestId)
    registry.isDirty = true
  }

  if (deny === undefined) {
    lastToastedDeny = undefined
  } else if (deny !== lastToastedDeny) {
    lastToastedDeny = deny
    $.ui.toast(`output-filter: scroll refused: ${deny}`)
  }
}

/**
 * The track's length in cells: what the band's width leaves after the
 * label and the position (about 25 cells), 10 to 60.
 */
function trackCells(bodyColumns: number): number {
  return Math.max(10, Math.min(60, bodyColumns - 25))
}

/**
 * The scroll bar line: `Scroll:`, the track, the position
 * (`first-last/rows`).
 *
 * The track is one one-glyph Button per cell, `█` inside the thumb and `░`
 * outside; a click on a cell jumps there. Wheel scrolling over the transcript
 * stays the engine's own, and the thumb follows it.
 *
 * @param $           The band hook's `$`, which the presses scroll with.
 * @param summary     The viewport summary to draw.
 * @param bodyColumns The band's width in cells.
 */
function scrollBar(table: Table, $: UiDollar, summary: ViewportSummary, bodyColumns: number): RenderElement {
  const { Box, Button, Text } = table
  const cells = trackCells(bodyColumns)
  const thumb = thumbRange(summary, cells)
  const position = thumb === undefined ? `${summary.count} rows` : `${summary.top + 1}-${summary.bottom + 1}/${summary.count}`

  const track = Array.from({ length: cells }, (_, cell) => {
    const isThumb = thumb !== undefined && cell >= thumb.start && cell <= thumb.end

    return (
      <Button key={`seg-${cell}`} label={isThumb ? '█' : '░'} plain onPress={() => scrollTo($, cellTargets(cell, cells))} />
    )
  })

  return (
    <Box flexDirection="row" columnGap={2}>
      <Text dimColor>Scroll:</Text>
      <Box flexDirection="row">{track}</Box>
      <Text dimColor>{position}</Text>
    </Box>
  )
}

// --------------------------------------------------
// Hooks
// --------------------------------------------------

/**
 * The help the mod's commands answer with: what each of them does, one line
 * each. `/filter` shows them when its arguments do not fit, so the person who
 * mistypes one sees the whole set of commands.
 */
const HELP_LINES = [
  '/flag: flag the selected output, else the newest one',
  '/flag next, /flag prev: move between the flags',
  '/flags: open the Flags pane',
  '/hl: highlight the selected text, or take that highlight off',
  '/hl clear: clear the highlights of the output',
  '/hl next, /hl prev: move between the highlights',
  '/highlights: open the Flags pane (the flags and the highlights)',
  'in the Flags pane: x removes the entry, drag ⠿ reorders it',
]

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const stored = (await $.store.get(STORE_KEY)) ?? (await $.store.get(LEGACY_STORE_KEY))
    await update($, shown, () => fromStored(stored))

    // The labels the last session paid for, and a fresh queue: an output
    // Haiku failed on is asked about again in this session, not in the last.
    await loadLabels($)
    waitingLabels.clear()
    askedLabels.clear()

    // The flags the last session left, so a resumed session shows them at once.
    await loadFlags($)

    // The order the person left them in, the same way.
    await loadFlagOrder($)

    // The order of the highlights, the same way.
    await loadHlOrder($)

    // The highlights the last session left, the same way.
    await loadHighlights($)

    // The presses of the last session: a double press is timed against the
    // clock, so the presses of a new session start afresh.
    lastPress.clear()

    // The active entry of the last session is not this session's.
    await update($, activeEntry, () => null)

    // Restart the tick under the session's own `$`.
    tickTimer?.cancel()
    tickTimer = undefined
    ensureTick($)

    // The label clock: Haiku is asked outside the drawing, two outputs a
    // tick, so a row never waits on a model call.
    labelTimer?.cancel()
    labelTimer = undefined
    labelTimer = $.clock.every(LABEL_TICK_MS, () => {
      // A Haiku call still running: this tick goes no further, so two calls
      // never overlap.
      if (isAskingLabels) {
        return
      }

      askAboutLabels($).catch(() => undefined)
    })

    await $.command.register({
      name: 'filter',
      description:
        'Set a transcript toggle: /filter tools [all|last|none] | expand | all | (bare: show state) | /flag (flag an output) | /flag next|prev (move between flags) | /flags (the Flags pane) | /hl (highlight the selected text) | /hl clear | /hl next|prev (move between highlights) | /highlights (the Flags pane)',
    })

    await $.command.register({
      name: 'flag',
      description: 'Flag the selected output (else the newest one), or move between flags: /flag | /flag next | /flag prev',
    })

    await $.command.register({
      name: 'flags',
      description: 'Open the Flags pane: the flagged outputs and the highlights, each a way back to its row',
    })

    await $.command.register({
      name: 'hl',
      description:
        'Highlight the selected text (or remove that highlight), clear the output\'s, or move between the highlights: /hl | /hl clear | /hl next | /hl prev',
    })

    await $.command.register({
      name: 'highlights',
      description: 'Open the Flags pane: the flagged outputs and the highlights, each a way back to its row',
    })

    return next(e)
  })

  // /filter <category> cycles it (or sets it: /filter tools last); /filter
  // expand unfolds every prompt; /filter all resets everything; bare /filter
  // reports the current state. The keyboard path that needs no band focus.
  on('command.run', { command: 'filter' }, async ($, e) => {
    const [name = '', value] = e.args.trim().toLowerCase().split(/\s+/)

    if (name === 'all') {
      await resetAll($)
    } else if (name === 'expand') {
      await expandAll($)
    } else if (name !== '') {
      const match = CATEGORIES.find(({ id, label }) => id === name || label.toLowerCase() === name)
      const isValue = value === 'all' || value === 'last' || value === 'none'

      if (match === undefined || (value !== undefined && !isValue)) {
        const names = CATEGORIES.map(({ id }) => id).join(', ')

        return {
          text: [`Use /filter <${names}> [all|last|none], /filter expand or /filter all.`, ...HELP_LINES].join('\n'),
        }
      }

      await setShown($, current => ({
        ...current,
        [match.id]: isValue ? (value as Visibility) : NEXT_VISIBILITY[current[match.id]],
      }))
    }

    const modes = await read($, shown)
    const foldedCount = (await read($, collapsedIds)).length
    const toggles = CATEGORIES.map(({ id }) => `${MARK[modes[id]]} ${id}`).join('  ')

    return { text: `${toggles}  folded prompts: ${foldedCount}  ([x] all, [o] newest only, [ ] none)` }
  })

  // /flag flags the row the selection lies in, else the newest output the
  // registry holds; /flag next and /flag prev move the flag cursor and bring
  // the flag's row into view.
  on('command.run', { command: 'flag' }, async ($, e) => {
    const action = e.args.trim().toLowerCase()

    if (action === 'next' || action === 'prev') {
      await moveFlag($, action === 'next' ? 1 : -1)

      const order = await orderedFlags($)
      const cursor = await read($, flagCursor)

      if (cursor === null || order.length === 0) {
        return { text: 'No flags yet.' }
      }

      // The move put the cursor on a flag of the order, so its place is that
      // flag's index in the order, counting from one.
      const at = Math.max(order.findIndex(entry => entry.id === cursor), 0)
      const preview = order[at]?.entry.preview ?? ''

      return { text: `Flag ${at + 1} of ${order.length}: ${preview.slice(0, 60)}` }
    }

    if (action !== '') {
      return { text: 'Use /flag, /flag next or /flag prev.' }
    }

    const selection = await $.ui.selection()
    const selected = selection?.requestId

    // Only an assistant row can be flagged: a selection in a prompt row (or in
    // a row the mod does not know) falls back to the newest output.
    const target =
      selected !== undefined && registry.text.get(selected)?.role === 'assistant'
        ? selected
        : registry.newest.get('output')

    if (target === undefined) {
      return { text: 'No output to flag yet: run /flag on a row that carries a label.' }
    }

    const text = registry.text.get(target)?.text ?? ''
    const label = await labelOf($, target, text)

    await toggleFlag($, target, label, text)

    const stored = await read($, flags)

    return { text: stored[target] === undefined ? 'Flag removed.' : 'Flagged.' }
  })

  // /flags opens the pane of the flagged outputs and the highlights.
  on('command.run', { command: 'flags' }, async $ => {
    await $.ui.open({ id: FLAGS_PANE, title: PANE_TITLE })

    return { text: 'Flags pane opened.' }
  })

  // /highlights opens the same pane, for the highlights.
  on('command.run', { command: 'highlights' }, async $ => {
    await $.ui.open({ id: FLAGS_PANE, title: PANE_TITLE })

    return { text: 'Flags pane opened.' }
  })

  // /hl highlights the selected text (or removes that highlight); /hl clear
  // empties the highlights of the output the selection lies in; /hl next and
  // /hl prev move between the highlights.
  on('command.run', { command: 'hl' }, async ($, e) => {
    const action = e.args.trim().toLowerCase()

    if (action === 'next' || action === 'prev') {
      await moveHighlight($, action === 'next' ? 1 : -1)

      const order = await orderedHighlights($)
      const cursor = await read($, hlCursor)

      if (cursor === null || order.length === 0) {
        return { text: 'No highlights yet.' }
      }

      const at = Math.max(
        order.findIndex(entry => highlightKey(entry.id, entry.text) === cursor),
        0,
      )
      const text = order[at]?.text ?? ''

      return { text: `Highlight ${at + 1} of ${order.length}: ${text.slice(0, 60)}` }
    }

    if (action !== '' && action !== 'clear') {
      return { text: 'Use /hl, /hl clear, /hl next or /hl prev.' }
    }

    return { text: await runHighlight($, action) }
  })

  // --------------------------------------------------
  // Transcript rows: draw the engine's row, or blank it
  // --------------------------------------------------
  // Matchers stay literal (not passed through a helper) so the engine and
  // `claude plugin validate` can see which component each hook draws.

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const category = userCategory(e.props)

    // Messages from agents, tasks and peers are ordinary rows of the prompt
    // they arrived under.
    if (category !== 'prompts') {
      const isDrawn = await isRowDrawn($, {
        component: e.component,
        requestId: e.requestId,
        category,
        onScreen: e.props.onScreen,
        screenRows: e.viewport?.rows,
        text: { role: 'user', text: e.props.text },
      })

      return isDrawn ? next(e) : blank($.ui.resolve(e))
    }

    // The person's prompt: never folded itself, drawn as the fold toggle.
    registerRow(e.requestId, 'prompts', true, { role: 'user', text: e.props.text })

    const isDrawn = await passesToggle($, e.requestId, 'prompts')
    recordRow(e.component, e.requestId, isDrawn, e.props.onScreen, e.viewport?.rows)

    if (!isDrawn) {
      return blank($.ui.resolve(e))
    }

    const isCollapsed = await read($, memberOf(collapsed, e))

    return promptRow($.ui.resolve(e), e.props.text, isCollapsed, () => {
      toggleCollapsed($, e.requestId).catch(() => undefined)
    })
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const isDrawn = await isRowDrawn($, {
      component: e.component,
      requestId: e.requestId,
      category: 'output',
      onScreen: e.props.onScreen,
      screenRows: e.viewport?.rows,
      text: { role: 'assistant', text: e.props.text },
    })

    if (!isDrawn) {
      return blank($.ui.resolve(e))
    }

    const els = $.ui.resolve(e)
    const label = await labelOf($, e.requestId, e.props.text)

    // A row the rules could not label asks Haiku about itself, outside the
    // drawing: the tick answers it and the row redraws with the label.
    if (label === undefined) {
      queueLabel(e.requestId, e.props.text)
    }

    // The row reads its own flag member, so a press on the chip (which
    // writes it) redraws this row alone.
    const { value } = await $.state.get({ ...isFlagged, id: e.requestId })

    // The row reads its own highlight member too: an output that carries a
    // highlight is drawn by the mod (the engine's own text has no highlight
    // of its own), and a write redraws this row alone.
    const held = await highlightsOf($, e.requestId)
    const body =
      held.length > 0
        ? highlightedBody(els, e.props.text, held, e.requestId, hits => {
            removeHighlights($, e.requestId, hits).catch(() => undefined)
          })
        : await next(e)

    return labelled(
      els,
      labelChip(els, label, value === true, e.requestId, () =>
        toggleFlag($, e.requestId, label, e.props.text).catch(() => undefined)),
      body,
    )
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const isDrawn = await isRowDrawn($, {
      component: e.component,
      requestId: e.requestId,
      category: toolCategory(e.props.tool),
      onScreen: e.props.onScreen,
      screenRows: e.viewport?.rows,
    })

    return isDrawn ? next(e) : blank($.ui.resolve(e))
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const isDrawn = await isRowDrawn($, {
      component: e.component,
      requestId: e.requestId,
      category: toolCategory(e.props.tool),
      onScreen: e.props.onScreen,
      screenRows: e.viewport?.rows,
    })

    return isDrawn ? next(e) : blank($.ui.resolve(e))
  })

  // A group folds reads, searches and listings only, never edits.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    // The calls it folds were drawn alone while running; now only the group is.
    for (const call of e.props.calls) {
      if (call.tool_use_id !== undefined && call.tool_use_id !== e.requestId) {
        registry.unreachable.add(call.tool_use_id)
      }
    }

    const isDrawn = await isRowDrawn($, {
      component: e.component,
      requestId: e.requestId,
      category: 'tools',
      onScreen: e.props.onScreen,
      screenRows: e.viewport?.rows,
    })

    return isDrawn ? next(e) : blank($.ui.resolve(e))
  })

  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    const isDrawn = await isRowDrawn($, {
      component: e.component,
      requestId: e.requestId,
      category: 'tools',
      onScreen: undefined,
      screenRows: e.viewport?.rows,
    })

    return isDrawn ? next(e) : blank($.ui.resolve(e))
  })

  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    const isDrawn = await isRowDrawn($, {
      component: e.component,
      requestId: e.requestId,
      category: 'commands',
      onScreen: e.props.onScreen,
      screenRows: e.viewport?.rows,
    })

    return isDrawn ? next(e) : blank($.ui.resolve(e))
  })

  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    const isDrawn = await isRowDrawn($, {
      component: e.component,
      requestId: e.requestId,
      category: 'status',
      onScreen: onScreenOf(e.props),
      screenRows: e.viewport?.rows,
    })

    return isDrawn ? next(e) : blank($.ui.resolve(e))
  })

  on('ui.render', { component: 'InfoNotice' }, async ($, e, next) => {
    const isDrawn = await isRowDrawn($, {
      component: e.component,
      requestId: e.requestId,
      category: 'status',
      onScreen: onScreenOf(e.props),
      screenRows: e.viewport?.rows,
    })

    return isDrawn ? next(e) : blank($.ui.resolve(e))
  })

  // --------------------------------------------------
  // The bar above the prompt
  // --------------------------------------------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // A survey owns the band while it is up.
    if (e.props.hasSurvey) {
      return next(e)
    }

    // `[o]` and the scroll bar both depend on the tick.
    ensureTick($)

    const { Box, Button, Text } = $.ui.resolve(e)
    const modes = await read($, shown)
    const foldedCount = (await read($, collapsedIds)).length
    const isDefault = CATEGORIES.every(({ id }) => modes[id] === 'all') && foldedCount === 0

    // Only the fullscreen terminal scrolls its own transcript; on the main
    // screen the terminal's scrollback does, and no row reports `onScreen`.
    let scrollLine: RenderElement | undefined

    if (e.surface === 'terminal' && e.viewport?.isFullscreen === true) {
      const summary = await read($, viewport)
      scrollLine = scrollBar($.ui.resolve(e), $, summary, e.props.bodyColumns)
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Text dimColor>Show:</Text>
          {CATEGORIES.map(({ id, label, hotkey }) => (
            <Button
              key={id}
              label={`${MARK[modes[id]]} ${label}`}
              hotkey={hotkey}
              plain
              dimColor={modes[id] === 'none'}
              onPress={() => setShown($, current => ({ ...current, [id]: NEXT_VISIBILITY[current[id]] }))}
            />
          ))}
          {!isDefault && <Button key="all" label="all" hotkey="a" plain onPress={() => resetAll($)} />}
          <Button
            key="hl"
            label="hl"
            hotkey="8"
            plain
            onPress={() => {
              runHighlight($, 'toggle')
                .then(message => $.ui.toast(`output-filter: ${message}`))
                .catch(() => undefined)
            }}
          />
        </Box>
        {scrollLine}
      </Box>
    )
  })

  // --------------------------------------------------
  // The Flags pane
  // --------------------------------------------------
  // The pane holds two sections in one column: the flags on top (with the
  // drag handles that order them), a rule, and the highlights below. Each
  // entry is a way back to its row, and a double press on one asks whether it
  // is to be removed.

  on('ui.render', { component: 'Pane', requestId: 'flags' }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements

    // The drag handle is a `Client`: the mobile and the vscode tables have
    // none, so those surfaces draw the row without a handle.
    const Client = 'Client' in elements ? elements.Client : undefined

    const order = await orderedFlags($)
    const cursor = await read($, flagCursor)
    const asking = await read($, confirmRemove)
    const active = await read($, activeEntry)
    const held = await orderedHighlights($)
    const hlCursorValue = await read($, hlCursor)

    // The preview's room: the pane's width less the handle, the cursor, the
    // label and the gaps beside them.
    const room = Math.max(8, e.props.bodyColumns - 15)

    const header = (
      <Box flexDirection="row" columnGap={2}>
        <Button
          key="prev"
          label="prev"
          hotkey="p"
          plain
          onPress={() => moveFlag($, -1).catch(() => undefined)}
        />
        <Button
          key="next"
          label="next"
          hotkey="n"
          plain
          onPress={() => moveFlag($, 1).catch(() => undefined)}
        />
        <Button
          key="remove"
          label="remove"
          hotkey="x"
          plain
          dimColor={active === null}
          onPress={() => askRemoveActive($).catch(() => undefined)}
        />
        <Text dimColor>{order.length === 1 ? '1 flag' : `${order.length} flags`}</Text>
        <Text dimColor>drag ⠿ or ctrl+n/p to reorder</Text>
      </Box>
    )

    // The question under the entry a double press asked about.
    const confirmLine = (entryKey: string): RenderElement => (
      <Box key={`confirm:${entryKey}`} flexDirection="row" columnGap={2}>
        <Text dimColor>Remove?</Text>
        <Button
          key={`rm-yes:${entryKey}`}
          label="yes"
          plain
          onPress={() => removeEntry($, entryKey).catch(() => undefined)}
        />
        <Button
          key={`rm-no:${entryKey}`}
          label="no"
          plain
          onPress={() => clearConfirm($, entryKey).catch(() => undefined)}
        />
      </Box>
    )

    // The `✕` at the end of a row: it asks whether that entry is removed.
    const removeMark = (rowKey: string): RenderElement => (
      <Button
        key={`rm:${rowKey}`}
        plain
        onPress={() => askRemove($, rowKey).catch(() => undefined)}
      >
        <Text dimColor>✕</Text>
      </Button>
    )

    const flagRows = order.flatMap(({ id, entry }) => {
      const label =
        entry.label === null
          ? <Text key="label" dimColor>·</Text>
          : <Text key="label" color={LABEL_COLOR[entry.label]} bold>{entry.label}</Text>

      const handle = Client === undefined ? null : (
        <Client
          key={'drag:' + id}
          module="./flag-handle.tsx"
          props={{ id }}
          width={3}
        />
      )

      const rowKey = flagRowKey(id)
      const row = (
        <Box key={`row:${id}`} flexDirection="row">
          {handle}
          <Button
            key={rowKey}
            plain
            onPress={() => pressEntry($, rowKey, () => goToFlag($, id)).catch(() => undefined)}
          >
            {id === cursor ? '▶ ' : '  '}
            {label}
            {` ${entry.preview.slice(0, room)}`}
          </Button>
          {removeMark(rowKey)}
        </Box>
      )

      return asking === rowKey ? [row, confirmLine(rowKey)] : [row]
    })

    // The category each highlighted output carries, so a highlight is read
    // the way its output is.
    const labels = new Map<string, OutputLabel | undefined>()

    for (const entry of held) {
      if (!labels.has(entry.id)) {
        labels.set(entry.id, await labelOf($, entry.id, registry.text.get(entry.id)?.text ?? ''))
      }
    }

    const highlightRows = held.flatMap(entry => {
      const label = labels.get(entry.id)
      const mark =
        label === undefined
          ? <Text key="label" dimColor>·</Text>
          : <Text key="label" color={LABEL_COLOR[label]} bold>{label}</Text>

      // The highlight's place in its own output's list, so the row's key
      // names the highlight and nothing else.
      const index = (highlightMap.get(entry.id)?.texts ?? []).indexOf(entry.text)
      const rowKey = `${HIGHLIGHT_ROW_PREFIX}${entry.id}:${index}`

      // The handle that orders the highlights, the same one the flags have
      // (D22): it carries the highlight's entry key.
      const entryKey = highlightEntryKey(entry.id, entry.text)
      const handle = Client === undefined ? null : (
        <Client
          key={'drag:' + entryKey}
          module="./flag-handle.tsx"
          props={{ id: entryKey }}
          width={3}
        />
      )

      const row = (
        <Box key={`hl-row:${entry.id}:${index}`} flexDirection="row">
          {handle}
          <Button
            key={rowKey}
            plain
            onPress={() => pressEntry($, rowKey, () => goToHighlight($, entry)).catch(() => undefined)}
          >
            {highlightKey(entry.id, entry.text) === hlCursorValue ? '▶ ' : '  '}
            {mark}
            {` ${entry.text.slice(0, room)}`}
          </Button>
          {removeMark(rowKey)}
        </Box>
      )

      return asking === rowKey ? [row, confirmLine(rowKey)] : [row]
    })

    const highlightHeader = (
      <Box flexDirection="row" columnGap={2}>
        <Button
          key="hl-prev"
          label="prev"
          hotkey="k"
          plain
          onPress={() => moveHighlight($, -1).catch(() => undefined)}
        />
        <Button
          key="hl-next"
          label="next"
          hotkey="j"
          plain
          onPress={() => moveHighlight($, 1).catch(() => undefined)}
        />
        <Text dimColor>{held.length === 1 ? '1 highlight' : `${held.length} highlights`}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {header}
        {order.length === 0
          ? <Text dimColor>No flags yet: press an output&apos;s label or run /flag.</Text>
          : flagRows}
        <Text dimColor>{RULE}</Text>
        {highlightHeader}
        {held.length === 0
          ? <Text dimColor>No highlights yet: select text, then press 8 or click hl.</Text>
          : highlightRows}
      </Box>
    )
  })

  // --------------------------------------------------
  // A handle of the Flags pane
  // --------------------------------------------------
  // A handle posts the move the person made (a drag, or ctrl+n/ctrl+p), and
  // the entry moves that many rows up or down the list. The new order is kept
  // for the next session.
  //
  // A handle of a flag row carries the flag's id; a handle of a highlight row
  // carries the highlight's entry key, and the prefix of that key tells the
  // two apart (D22).
  //
  // A handle also posts the double press that asks whether the entry is
  // removed: two presses on the grip, soon after one another (D21).

  on('ui.message', async ($, e) => {
    if (e.requestId !== FLAGS_PANE || !e.element.startsWith(HANDLE_PREFIX)) {
      return {}
    }

    const move = asMoveMessage(e.data)

    if (move === undefined) {
      const confirm = asConfirmMessage(e.data)

      if (confirm !== undefined) {
        const rowKey = rowKeyOfEntry(confirm)

        if (rowKey !== undefined) {
          await update($, confirmRemove, () => rowKey)
        }
      }

      return {}
    }

    if (move.move.startsWith(HIGHLIGHT_ENTRY_PREFIX)) {
      const shown = (await orderedHighlights($)).map(entry =>
        highlightEntryKey(entry.id, entry.text),
      )
      const moved = moveInOrder(shown, move.move, move.by)
      const next = await update($, hlOrderList, old => mergeOrder(old, moved).slice(0, MAX_HL_ORDER))

      await $.store.set(HL_ORDER_STORE_KEY, next)

      return {}
    }

    const shown = (await orderedFlags($)).map(entry => entry.id)
    const moved = moveInOrder(shown, move.move, move.by)
    const next = await update($, flagOrderList, old => mergeOrder(old, moved).slice(0, MAX_FLAG_ORDER))

    await $.store.set(FLAG_ORDER_STORE_KEY, next)

    return {}
  })
}
