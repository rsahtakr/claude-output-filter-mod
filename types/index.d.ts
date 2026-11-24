/**
 * State contract of the output-filter mod.
 *
 * Session values, written by the bar's buttons, `/filter` or the mod's clock
 * tick, and read by the transcript-row and band render hooks (a read while
 * drawing subscribes the drawing, so a write redraws exactly the readers):
 *
 * - `visibility`: how each transcript category draws: every row, only its
 *   newest row, or none (persisted in `$.store`).
 * - `isStale`: per row, true once a newer row of its category was drawn, so
 *   a category showing only its newest row hides the one it superseded.
 * - `collapsed` / `collapsedIds`: which prompts have their answer folded, as
 *   a per-prompt flag (read by that prompt's rows) and as a list (read by the
 *   band and `/filter`).
 * - `aiLabel`: per message id, the category Haiku gave the output, for the
 *   outputs the text rules could not decide (read by that row, so the write
 *   redraws it alone).
 * - `highlights`: per message id, the passages of the output the person
 *   highlighted (read by that row, so the write redraws it alone).
 * - `viewport`: where the transcript's viewport sits, for the scroll bar.
 *
 * `StateFamily` resolves inside the `declare module 'claude-code'` block
 * below (an augmentation sees the module's own names), so the file imports
 * nothing and stays self-contained, as `claude plugin validate` expects.
 */

/** A transcript category the bar can toggle. */
export type CategoryId =
  | 'prompts'
  | 'output'
  | 'tools'
  | 'edits'
  | 'agents'
  | 'commands'
  | 'status'

/**
 * How a category draws: `all` its rows (`[x]`), `last` only its newest row
 * (`[o]`), `none` (`[ ]`).
 */
export type Visibility = 'all' | 'last' | 'none'

/** Visibility per category. */
export type Shown = Record<CategoryId, Visibility>

/**
 * The eight category labels an assistant output can carry (decisions.md D1).
 *
 * The set the user approved: `Plan` announces the next step, `Wait` says jobs
 * run or wait, `Finding` says a check or measurement came back, `Done` says
 * the work landed, `Problem` says something failed, `Ask` says a decision is
 * the user's to make, `Report` summarises the task and `Explain` answers or
 * explains.
 */
export type OutputLabel =
  | 'Plan'
  | 'Wait'
  | 'Finding'
  | 'Done'
  | 'Problem'
  | 'Ask'
  | 'Report'
  | 'Explain'

/**
 * One flagged output: the category it carried, a preview of its text, the
 * time it was flagged and the session that flagged it.
 *
 * The preview is the output's plain text cut short (see `hooks/marks.ts`); it
 * is what the Flags pane lists and what the pane matches against the
 * transcript to find the row the flag names.
 *
 * The session id is what keeps the flags of one session out of another's
 * pane: a flag of another session is dropped, not listed last.
 */
export type FlagEntry = {
  label: OutputLabel | null
  preview: string
  at: number
  /** The session that flagged the output; absent in the older shape. */
  sessionId?: string
}

/**
 * Where the transcript's viewport sits over the whole transcript.
 *
 * Once `$.session.messages()` has been read, the unit is one transcript
 * message: `top` and `bottom` are the message indices of the first and last
 * row with any part on screen, and `count` is the message count, so the bar
 * is true even for history the terminal has not drawn yet (a resumed
 * session). Before that read (or where it answers nothing), the unit is one
 * drawn row, in transcript order, and `count` is the drawn rows' count.
 * `top` and `bottom` are -1 while nothing is known (the main screen, where
 * the terminal's own scrollback scrolls, never reports).
 */
export type ViewportSummary = {
  top: number
  bottom: number
  count: number
}

declare module 'claude-code' {
  interface PluginState {
    'output-filter': {
      /** How each category draws. */
      visibility: Shown
      /** Per row requestId: true once a newer row of its category was drawn. */
      isStale: StateFamily<boolean>
      /** Per prompt requestId: true while that prompt's answer is folded. */
      collapsed: StateFamily<boolean>
      /** The prompt requestIds whose `collapsed` member is true. */
      collapsedIds: string[]
      /** Per message id: the category Haiku gave the output. */
      aiLabel: StateFamily<OutputLabel>
      /** The flagged outputs, by message id, for the Flags pane. */
      flags: Record<string, FlagEntry>
      /** Per message id: true while the output carries a flag. */
      isFlagged: StateFamily<boolean>
      /** Per message id: the passages of the output the person highlighted. */
      highlights: StateFamily<string[]>
      /** The flagged output the cursor is on, for the pane and `/flag next|prev`. */
      flagCursor: string | null
      /**
       * The person's own order of the flags, by message id: what the pane's
       * drag handles and ctrl+n/ctrl+p set, kept across sessions.
       *
       * Empty means no order of their own, and the pane lists the flags in
       * transcript order as before.
       */
      flagOrderList: string[]
      /**
       * The person's own order of the highlights, by entry key (the message
       * id and the words, one line between them, behind `hl:`): what the
       * pane's drag handles set, kept across sessions.
       *
       * Empty means no order of their own, and the pane lists the highlights
       * in transcript order as before.
       */
      hlOrderList: string[]
      /**
       * The pane entry the person last pressed or travelled to, by its row
       * key: the one the `remove` button asks about.
       *
       * Empty means no entry is active.
       */
      activeEntry: string | null
      /**
       * The highlight the cursor is on, for the pane and `/hl next|prev`.
       *
       * The name of a highlight is its message id and its words, one line
       * between them, so two highlights of one message are told apart.
       */
      hlCursor: string | null
      /**
       * The pane entry whose removal is asked for: its key, after a double
       * press on the entry. Empty means nothing is asked for.
       */
      confirmRemove: string | null
      /** The scroll bar's view of the transcript viewport. */
      viewport: ViewportSummary
    }
  }
}
