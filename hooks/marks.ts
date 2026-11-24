/**
 * The plain text a flag carries: the words of an output without its markdown,
 * the preview the Flags pane lists, the order the flags stand in, and the
 * move from one flag to the next. The blocks an output is cut into and the
 * segments a highlight cuts them into, for the same reason.
 *
 * Pure: no `$`, no state, no clock. The mod draws and writes elsewhere (in
 * `hooks/draw-marks.tsx` and `hooks/register.tsx`); this file only computes
 * what they draw, so it can be reasoned about (and tested) on its own.
 */
import type { FlagEntry } from '../types'

// --------------------------------------------------
// Plain text
// --------------------------------------------------

/**
 * The text as plain words: the markdown markers off, the whitespace folded.
 *
 * Inline `**bold**` and `__bold__` lose their markers, a backtick loses its
 * own, a link `[text](url)` keeps its text and drops its address, and a
 * heading's leading `#`s go. What is left is one line of words, which is
 * what a flag's preview is cut from and what a preview is matched against.
 *
 * @param text The text as it was written.
 * @returns The same text as plain words.
 */
export function normalize(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/^[ \t]*#{1,6}[ \t]*/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** How many characters a flag's preview holds. */
const PREVIEW_LENGTH = 120

/**
 * The flag's preview of an output: its plain words, cut short.
 *
 * @param text The output's text.
 * @returns At most 120 characters of plain words.
 */
export function previewOf(text: string): string {
  return normalize(text).slice(0, PREVIEW_LENGTH)
}

// --------------------------------------------------
// The order of the flags
// --------------------------------------------------

/** One flag, with the place the flag names in the transcript. */
export type FlagOrderEntry = {
  /** The message id the flag belongs to. */
  id: string
  /** The flag itself. */
  entry: FlagEntry
  /** The index of the transcript message the flag names; -1 while unmatched. */
  pos: number
}

/**
 * Whether an entry belongs to the session the pane is drawn in.
 *
 * An entry that names no session is of an older store, written before the
 * session was kept with it: it is not of this session by name, so it is kept
 * only where it names a message of this session.
 *
 * @param entrySessionId The session that wrote the entry, if it names one.
 * @param sessionId      The session the pane is drawn in, if it is known.
 * @returns Whether the entry is this session's own.
 */
function isOwnSession(entrySessionId: string | undefined, sessionId: string | undefined): boolean {
  if (entrySessionId === undefined || sessionId === undefined) {
    return false
  }

  return entrySessionId === sessionId
}

/**
 * The flags in the order the pane lists them: the person's own order first
 * (where they set one), then the rest by where they sit in the transcript,
 * then by when they were flagged.
 *
 * A flag names a row by its preview, not by an id (the transcript carries no
 * ids), so a flag is matched against the messages: the first assistant
 * message whose plain words hold the preview is the row the flag names. A
 * flag no message holds (a row the transcript has not drawn yet, or a text
 * that changed) is unmatched and stands last, the newest first.
 *
 * A flag of another session is dropped: it is kept only when it names a
 * message of this session (its preview is in one) or when the session that
 * flagged it is this one. A flag that is neither is not this session's, and
 * is never listed.
 *
 * @param flags     The flags, by message id.
 * @param messages  The transcript's messages, in order.
 * @param custom    The person's own order of the flags, by message id. Empty
 *                  means no order of their own, and the flags stand in
 *                  transcript order as before.
 * @param sessionId The session the pane is drawn in; a flag of another
 *                  session is dropped.
 * @returns The flags, in the order the pane lists them.
 */
export function flagOrder(
  flags: Record<string, FlagEntry>,
  messages: readonly { role: string; text: string }[],
  custom: readonly string[] = [],
  sessionId?: string,
): FlagOrderEntry[] {
  const texts = messages.map(row => (row.role === 'assistant' ? normalize(row.text) : ''))
  const entries: FlagOrderEntry[] = []

  for (const [id, entry] of Object.entries(flags)) {
    let pos = -1

    for (let index = 0; index < texts.length; index += 1) {
      const text = texts[index]

      if (text !== undefined && text !== '' && entry.preview !== '' && text.includes(entry.preview)) {
        pos = index
        break
      }
    }

    // A flag of another session is not this session's: it is dropped, never
    // listed last.
    if (pos < 0 && !isOwnSession(entry.sessionId, sessionId)) {
      continue
    }

    entries.push({ id, entry, pos })
  }

  if (custom.length === 0) {
    return entries.sort(byTranscript)
  }

  // The person's order first: the flags it names, in its order. The flags it
  // does not name follow, in transcript order.
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  const ordered: FlagOrderEntry[] = []
  const placed = new Set<string>()

  for (const id of custom) {
    const entry = byId.get(id)

    if (entry === undefined || placed.has(id)) {
      continue
    }

    placed.add(id)
    ordered.push(entry)
  }

  const rest = entries.filter(entry => !placed.has(entry.id)).sort(byTranscript)

  ordered.push(...rest)

  return ordered
}

/**
 * Two flags, the one before the other: by where they sit in the transcript,
 * then by when they were flagged.
 *
 * A flag the transcript does not hold stands last, the newest first.
 *
 * @param one  The first flag.
 * @param other The second flag.
 * @returns A negative number when `one` comes first, a positive one when
 *          `other` does, zero when the two stand alike.
 */
function byTranscript(one: FlagOrderEntry, other: FlagOrderEntry): number {
  if (one.pos !== other.pos) {
    if (one.pos < 0) {
      return 1
    }

    if (other.pos < 0) {
      return -1
    }

    return one.pos - other.pos
  }

  return one.entry.at - other.entry.at
}

// --------------------------------------------------
// The person's own order
// --------------------------------------------------

/**
 * The shown ids with `id` moved `by` places.
 *
 * The move is clamped to the ends: a drag past the first row or the last one
 * stops there. An id the list does not hold leaves the list as it was.
 *
 * @param shown The ids as the pane shows them, in order.
 * @param id    The id to move.
 * @param by    How many places to move it: down is positive.
 * @returns The ids, moved.
 */
export function moveInOrder(shown: readonly string[], id: string, by: number): string[] {
  const at = shown.indexOf(id)

  if (at < 0) {
    return [...shown]
  }

  const rest = [...shown]

  rest.splice(at, 1)

  // The row the id lands on, clamped: the list is one shorter without it.
  const to = Math.max(0, Math.min(rest.length, at + by))

  rest.splice(to, 0, id)

  return rest
}

/**
 * The person's order and the shown ids as one list: the shown ids first, then
 * the global ids the shown list does not name. No id stands twice.
 *
 * The global order holds the ids of every session's flags, so the ids this
 * session does not show (a flag of an earlier session, or one this session
 * has not flagged) keep their place behind the ones on screen.
 *
 * @param global The order as it was stored, over every session.
 * @param shown  The ids as the pane shows them now.
 * @returns The one list.
 */
export function mergeOrder(global: readonly string[], shown: readonly string[]): string[] {
  const merged: string[] = []
  const seen = new Set<string>()

  for (const id of [...shown, ...global]) {
    if (seen.has(id)) {
      continue
    }

    seen.add(id)
    merged.push(id)
  }

  return merged
}

/**
 * The flag one step on from the cursor, wrapping round.
 *
 * A cursor on no flag (or on one that is gone) starts at the first flag
 * going forwards and at the last going back.
 *
 * @param order     The flags, in the order the pane lists them.
 * @param cursor    The flag the cursor is on, or null.
 * @param direction 1 to go on, -1 to go back.
 * @returns The flag the cursor lands on, or undefined with no flags at all.
 */
export function step(order: readonly { id: string }[], cursor: string | null, direction: 1 | -1): string | undefined {
  if (order.length === 0) {
    return undefined
  }

  const at = cursor === null ? -1 : order.findIndex(entry => entry.id === cursor)

  if (at < 0) {
    return direction === 1 ? order[0]?.id : order[order.length - 1]?.id
  }

  const next = (at + direction + order.length) % order.length

  return order[next]?.id
}

// --------------------------------------------------
// The order of the highlights
// --------------------------------------------------
// A highlight names a passage of one output, so it is placed by where that
// output stands in the transcript and by where the passage lies inside it.
// The pane lists the highlights in that order, so the person walks them in
// the order they fall in the transcript.

/** One highlight, with the place the highlight names in the transcript. */
export type HighlightOrderEntry = {
  /** The message id the highlight belongs to. */
  id: string
  /** The highlight's words, as plain text. */
  text: string
  /** The index of the transcript message the highlight lies in; -1 while unmatched. */
  pos: number
  /** Where the highlight lies in that message's words; 0 while unmatched. */
  offset: number
}

/**
 * The name of a highlight: its message id and its words, one line between
 * them.
 *
 * Two highlights of one message are told apart by their words, and the name
 * is what the cursor holds.
 *
 * @param id   The message id the highlight belongs to.
 * @param text The highlight's words.
 * @returns The name of the highlight.
 */
export function highlightKey(id: string, text: string): string {
  return `${id}\n${text}`
}

/**
 * The key a highlight carries in the pane's list and in the person's own
 * order: its name behind `hl:`.
 *
 * The name holds the message id and the words, so two highlights of one
 * message are told apart; the `hl:` prefix tells a highlight's key from a
 * flag's id, which is what the pane's move posts are routed by.
 *
 * @param id   The message id the highlight belongs to.
 * @param text The highlight's words.
 * @returns The key of the highlight.
 */
export function highlightEntryKey(id: string, text: string): string {
  return `hl:${highlightKey(id, text)}`
}

/**
 * One message's highlights, as the store keeps them: the words, and the
 * session that marked them.
 */
export type HighlightStoreEntry = {
  /** The words the person highlighted in that message. */
  texts: string[]
  /** The session that marked them; absent in the older shape. */
  sessionId?: string
}

/**
 * The highlights in the order the pane lists them: by the message they lie
 * in, then by where in that message they lie.
 *
 * A highlight names its passage by its words, not by a place (the transcript
 * carries no places), so a highlight is matched against the messages: the
 * first assistant message whose plain words hold it is the message it lies
 * in. A highlight no message holds stands last.
 *
 * A highlight of another session is dropped: it is kept only when it names a
 * message of this session or when the session that marked it is this one.
 *
 * The person's own order comes first when they have one: the highlights it
 * names, in its order, then the rest in transcript order.
 *
 * @param highlights The highlights, by message id.
 * @param messages   The transcript's messages, in order.
 * @param custom     The person's own order of the highlights, by entry key.
 *                    Empty means no order of their own.
 * @param sessionId  The session the pane is drawn in; a highlight of another
 *                    session is dropped.
 * @returns The highlights, in the order the pane lists them.
 */
export function highlightOrder(
  highlights: ReadonlyMap<string, HighlightStoreEntry>,
  messages: readonly { role: string; text: string }[],
  custom: readonly string[] = [],
  sessionId?: string,
): HighlightOrderEntry[] {
  const texts = messages.map(row => (row.role === 'assistant' ? normalize(row.text) : ''))
  const entries: HighlightOrderEntry[] = []

  for (const [id, held] of highlights) {
    const own = isOwnSession(held.sessionId, sessionId)

    for (const text of held.texts) {
      const wanted = normalize(text)

      if (wanted === '') {
        continue
      }

      let pos = -1
      let offset = 0

      for (let index = 0; index < texts.length; index += 1) {
        const plain = texts[index]

        if (plain === undefined || plain === '') {
          continue
        }

        const at = plain.indexOf(wanted)

        if (at >= 0) {
          pos = index
          offset = at
          break
        }
      }

      // A highlight of another session is not this session's: it is dropped,
      // never listed last.
      if (pos < 0 && !own) {
        continue
      }

      entries.push({ id, text, pos, offset })
    }
  }

  if (custom.length === 0) {
    return entries.sort(byPlace)
  }

  // The person's order first: the highlights it names, in its order. The
  // highlights it does not name follow, in transcript order.
  const byKey = new Map(entries.map(entry => [highlightEntryKey(entry.id, entry.text), entry]))
  const ordered: HighlightOrderEntry[] = []
  const placed = new Set<string>()

  for (const key of custom) {
    const entry = byKey.get(key)

    if (entry === undefined || placed.has(key)) {
      continue
    }

    placed.add(key)
    ordered.push(entry)
  }

  const rest = entries
    .filter(entry => !placed.has(highlightEntryKey(entry.id, entry.text)))
    .sort(byPlace)

  ordered.push(...rest)

  return ordered
}

/**
 * Two highlights, the one before the other: by the message they lie in, then
 * by where in that message they lie.
 *
 * A highlight the transcript does not hold stands last.
 *
 * @param one  The first highlight.
 * @param other The second highlight.
 * @returns A negative number when `one` comes first, a positive one when
 *          `other` does, zero when the two stand alike.
 */
function byPlace(one: HighlightOrderEntry, other: HighlightOrderEntry): number {
  if (one.pos !== other.pos) {
    if (one.pos < 0) {
      return 1
    }

    if (other.pos < 0) {
      return -1
    }

    return one.pos - other.pos
  }

  if (one.offset !== other.offset) {
    return one.offset - other.offset
  }

  if (one.id !== other.id) {
    return one.id < other.id ? -1 : 1
  }

  if (one.text === other.text) {
    return 0
  }

  return one.text < other.text ? -1 : 1
}

/**
 * The highlight one step on from the cursor, wrapping round.
 *
 * A cursor on no highlight (or on one that is gone) starts at the first
 * highlight going forwards and at the last going back.
 *
 * @param order     The highlights, in the order the pane lists them.
 * @param cursor    The name of the highlight the cursor is on, or null.
 * @param direction 1 to go on, -1 to go back.
 * @returns The highlight the cursor lands on, or undefined with none at all.
 */
export function highlightStep(
  order: readonly HighlightOrderEntry[],
  cursor: string | null,
  direction: 1 | -1,
): HighlightOrderEntry | undefined {
  const keyed = order.map(entry => ({ id: highlightKey(entry.id, entry.text) }))
  const next = step(keyed, cursor, direction)

  if (next === undefined) {
    return undefined
  }

  return order.find(entry => highlightKey(entry.id, entry.text) === next)
}

// --------------------------------------------------
// Highlights
// --------------------------------------------------
// A highlight is a passage of an output the person selected: the words, as
// plain text (the same words a flag's preview holds), so a highlight is found
// again in the output no matter how the markdown around it is written.
//
// An output is cut into blocks before it is drawn with highlights: a fenced
// code block is kept whole (its words are code, not prose), the rest is cut
// on the blank lines between the paragraphs. A block that holds no highlight
// is drawn as markdown, as the engine draws it; a block that holds one is
// drawn as plain words, cut at the highlights.

/** A fence that opens a code block: three backticks or three tildes. */
const FENCE = /^\s{0,3}(```|~~~)/

/**
 * The blocks of an output: a fenced code block kept whole, the rest cut on
 * the blank lines between the paragraphs.
 *
 * A fence that is never closed keeps the rest of the output as its block, so
 * no code is lost to a missing closing fence.
 *
 * @param text The output's whole text.
 * @returns The output's blocks, in the order they stand in.
 */
export function splitBlocks(text: string): string[] {
  const lines = text.split('\n')
  const blocks: string[] = []
  let paragraph: string[] = []

  const flush = (): void => {
    if (paragraph.length > 0) {
      blocks.push(paragraph.join('\n'))
      paragraph = []
    }
  }

  let at = 0

  while (at < lines.length) {
    const line = lines[at] ?? ''
    const fence = FENCE.exec(line)

    if (fence === null) {
      if (line.trim() === '') {
        flush()
      } else {
        paragraph.push(line)
      }

      at += 1
      continue
    }

    // A fence opens a code block, which is kept whole.
    flush()

    const marker = fence[1] ?? '```'
    const block = [line]

    at += 1

    while (at < lines.length) {
      const next = lines[at] ?? ''

      block.push(next)
      at += 1

      if (next.trimStart().startsWith(marker)) {
        break
      }
    }

    blocks.push(block.join('\n'))
  }

  flush()

  return blocks
}

/** One piece of a block: the words, and whether a highlight falls on them. */
export type HighlightSegment = {
  /** The words of the piece. */
  text: string
  /** True when a highlight falls on the piece. */
  isHit: boolean
}

/**
 * The pieces of a block, cut at the highlights it holds.
 *
 * The block is read as plain words, the same words a highlight holds, so a
 * hit is found in it however the markdown around it is written. A block that
 * holds no highlight has no pieces: it is drawn as markdown instead.
 *
 * Where two highlights meet, the longer one wins, so a hit is never cut in
 * half.
 *
 * @param text       The block's text.
 * @param highlights The highlights to look for.
 * @returns The block's pieces, or undefined when it holds no highlight.
 */
export function highlightSegments(
  text: string,
  highlights: readonly string[],
): HighlightSegment[] | undefined {
  const plain = normalize(text)
  const hits = highlights.filter(highlight => highlight !== '').sort((one, other) => other.length - one.length)

  if (plain === '' || hits.length === 0) {
    return undefined
  }

  const segments: HighlightSegment[] = []
  let words = ''

  for (let at = 0; at < plain.length; ) {
    const hit = hits.find(candidate => plain.startsWith(candidate, at))

    if (hit === undefined) {
      words += plain.charAt(at)
      at += 1
      continue
    }

    if (words !== '') {
      segments.push({ text: words, isHit: false })
      words = ''
    }

    segments.push({ text: hit, isHit: true })
    at += hit.length
  }

  if (words !== '') {
    segments.push({ text: words, isHit: false })
  }

  return segments.some(segment => segment.isHit) ? segments : undefined
}
