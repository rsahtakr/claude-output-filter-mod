/**
 * The way an output that carries highlights is drawn: the blocks the output
 * is cut into, the visual lines a block with a hit is drawn as, and the runs
 * a hit falls on.
 *
 * The engine's own reply reaches a hook as an opaque node, so a reply with a
 * highlight is drawn by the mod (decisions.md D16). The drawing keeps the
 * reply's layout: the blocks that hold no hit stay one Markdown (the engine's
 * renderer keeps its own spacing inside), a block that holds a hit is drawn as
 * its lines (one per list item, heading or paragraph), and only the words a
 * highlight covers are marked.
 *
 * The helpers are pure first, so they can be reasoned about (and tested) on
 * their own; the drawing calls them.
 */
import type {
  BoxProps,
  ButtonProps,
  CodeProps,
  ElementConstructor,
  MarkdownProps,
  RenderElement,
  TextProps,
} from 'claude-code'

import { splitBlocks } from './marks'

// --------------------------------------------------
// The elements
// --------------------------------------------------

/** The elements a highlighted body is drawn with, as `$.ui.resolve(e)` hands them out. */
export type HighlightElements = {
  Box: ElementConstructor<BoxProps>
  Button: ElementConstructor<ButtonProps>
  Code: ElementConstructor<CodeProps>
  Markdown: ElementConstructor<MarkdownProps>
  Text: ElementConstructor<TextProps>
}

// --------------------------------------------------
// Inline runs
// --------------------------------------------------

/**
 * One piece of a line: the words, and how they are drawn.
 *
 * A run is the smallest piece the drawing keeps together: the words between
 * two changes of style (bold, italic, a link, inline code).
 */
export type InlineRun = {
  /** The words of the piece. */
  text: string
  /** True for bold words (`**x**`, `__x__`, a heading's words). */
  bold: boolean
  /** True for italic words (`*x*`, `_x_`). */
  italic: boolean
  /** True for a link's text (`[t](u)`). */
  underline: boolean
  /** True for inline code (`` `x` ``). */
  code: boolean
}

/** The style a run inherits from the words around it. */
type Style = {
  bold: boolean
  italic: boolean
  underline: boolean
  code: boolean
}

/** The style of plain words. */
const PLAIN: Style = { bold: false, italic: false, underline: false, code: false }

/** A link: its text and its address. */
const LINK = /^\[([^\]]*)\]\([^)]*\)/

/**
 * Whether a character is part of a word: a letter, a digit or an underscore.
 *
 * @param char The character as it stands.
 * @returns Whether the character belongs to a word.
 */
function isWordChar(char: string): boolean {
  return /[A-Za-z0-9_]/.test(char)
}

/**
 * Where the marker that closes an italic run stands.
 *
 * The marker must stand at a word's edge: the one that opens it after a word
 * character is part of the word (`snake_case`), not a marker.
 *
 * @param text   The text as it was written.
 * @param at     Where the opening marker stands.
 * @param marker The marker itself (`*` or `_`).
 * @returns The index of the closing marker, or -1 when there is none.
 */
function closingMarker(text: string, at: number, marker: string): number {
  let from = at + 1

  while (from < text.length) {
    const found = text.indexOf(marker, from)

    if (found < 0) {
      return -1
    }

    if (!isWordChar(text.charAt(found + 1))) {
      return found
    }

    from = found + 1
  }

  return -1
}

/**
 * The runs of a piece of text: the words, split where the markdown changes
 * the style.
 *
 * `**x**` and `__x__` are bold, `*x*` and `_x_` italic, `` `x` `` inline code
 * and `[t](u)` a link, whose text is underlined. A marker without its partner
 * is text, as it was written.
 *
 * @param text  The text as it was written.
 * @param style The style the text inherits.
 * @returns The runs, in the order they are drawn.
 */
function inlineRuns(text: string, style: Style = PLAIN): InlineRun[] {
  const runs: InlineRun[] = []
  let plain = ''

  const flush = (): void => {
    if (plain === '') {
      return
    }

    runs.push({ text: plain, ...style })
    plain = ''
  }

  let at = 0

  while (at < text.length) {
    const two = text.slice(at, at + 2)
    const one = text.charAt(at)

    if (two === '**' || two === '__') {
      const close = text.indexOf(two, at + 2)
      const inner = close < 0 ? '' : text.slice(at + 2, close)

      if (inner !== '') {
        flush()
        runs.push(...inlineRuns(inner, { ...style, bold: true }))
        at = close + 2
        continue
      }
    }

    if (one === '`') {
      const close = text.indexOf('`', at + 1)
      const inner = close < 0 ? '' : text.slice(at + 1, close)

      if (inner !== '') {
        flush()
        runs.push(...inlineRuns(inner, { ...style, code: true }))
        at = close + 1
        continue
      }
    }

    if (one === '*' || one === '_') {
      const before = at === 0 ? '' : text.charAt(at - 1)
      const close = isWordChar(before) ? -1 : closingMarker(text, at, one)

      if (close > at) {
        flush()
        runs.push(...inlineRuns(text.slice(at + 1, close), { ...style, italic: true }))
        at = close + 1
        continue
      }
    }

    if (one === '[') {
      const link = LINK.exec(text.slice(at))

      if (link !== null) {
        flush()
        runs.push(...inlineRuns(link[1] ?? '', { ...style, underline: true }))
        at += link[0].length
        continue
      }
    }

    plain += one
    at += 1
  }

  flush()

  return runs
}

// --------------------------------------------------
// Visual lines
// --------------------------------------------------

/**
 * One visual line: the runs it is drawn as.
 *
 * A line is what the person reads as one row of the reply: a list item, a
 * heading, a paragraph or a line of code.
 */
export type VisualLine = {
  /** What the line is. */
  kind: 'heading' | 'list' | 'para' | 'code'
  /** The runs of the line, in the order they are drawn. */
  runs: InlineRun[]
}

/** A heading: up to three spaces, then `#`s, then the words. */
const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/

/** A list item: its indentation, its marker and its words. */
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/

/**
 * The visual lines of a block: one per list item, one per heading, and one
 * per paragraph (a paragraph's own line breaks are gone, as markdown reflows
 * them).
 *
 * @param block The block's text.
 * @returns The lines, in the order they stand in.
 */
export function inlineLines(block: string): VisualLine[] {
  const lines: VisualLine[] = []
  let paragraph: string[] = []

  const flush = (): void => {
    if (paragraph.length === 0) {
      return
    }

    const text = paragraph.join(' ')
    paragraph = []

    if (text.trim() !== '') {
      lines.push({ kind: 'para', runs: inlineRuns(text) })
    }
  }

  for (const line of block.split('\n')) {
    const heading = HEADING.exec(line)

    if (heading !== null) {
      flush()
      lines.push({ kind: 'heading', runs: inlineRuns(heading[1] ?? '', { ...PLAIN, bold: true }) })
      continue
    }

    const item = LIST_ITEM.exec(line)

    if (item !== null) {
      flush()
      // The marker is kept as it was written; the words after it are parsed.
      const marker = `${item[1] ?? ''}${item[2] ?? ''} `
      lines.push({ kind: 'list', runs: inlineRuns(`${marker}${item[3] ?? ''}`) })
      continue
    }

    paragraph.push(line)
  }

  flush()

  return lines
}

// --------------------------------------------------
// Fenced code
// --------------------------------------------------

/** A fence that opens a code block: three backticks or three tildes. */
const FENCE = /^\s{0,3}(```|~~~)/

/**
 * The code of a fenced block: the fence markers off, the code as it was
 * written.
 *
 * @param block The block's text, the opening fence first.
 * @returns The code the block holds.
 */
function fenceSource(block: string): string {
  const lines = block.split('\n')
  const opening = FENCE.exec(lines[0] ?? '')
  const marker = opening?.[1] ?? '```'
  const inner = lines.slice(1)
  const last = inner[inner.length - 1]

  if (last !== undefined && last.trimStart().startsWith(marker)) {
    inner.pop()
  }

  return inner.join('\n')
}

/**
 * The lines of a fenced block, as plain lines: code is never split into
 * runs, so a highlight inside a fence is ignored (the fence is drawn as code).
 *
 * @param block The block's text, the opening fence first.
 * @returns The lines of the code.
 */
function fenceLines(block: string): VisualLine[] {
  return fenceSource(block)
    .split('\n')
    .map(line => ({ kind: 'code' as const, runs: [{ text: line, ...PLAIN }] }))
}

// --------------------------------------------------
// Hits
// --------------------------------------------------

/**
 * One line's hits: the ranges of the line's words a highlight covers, and the
 * highlights that fall on it.
 *
 * A range is a pair of places in the line's own words: the first the
 * highlight covers and the one past its last word.
 */
export type LineHit = {
  /** The ranges of the line's words that are hits. */
  ranges: Array<[number, number]>
  /** The highlights that fall on the line. */
  highlights: string[]
}

/**
 * The words of a text with the whitespace folded, and where each of them
 * stands in the text it came from.
 *
 * A highlight is matched against these words, so a selection that crossed a
 * line break is found again.
 *
 * @param text The text as it was written.
 * @returns The folded words, and for each of them its place in the text.
 */
function collapse(text: string): { words: string; places: number[] } {
  const words: string[] = []
  const places: number[] = []
  let isSpace = false

  for (let at = 0; at < text.length; at += 1) {
    const char = text.charAt(at)

    if (/\s/.test(char)) {
      // A run of whitespace is one space, and it stands for its first space.
      if (isSpace || words.length === 0) {
        continue
      }

      words.push(' ')
      places.push(at)
      isSpace = true
      continue
    }

    words.push(char)
    places.push(at)
    isSpace = false
  }

  // A trailing space is no word.
  if (words[words.length - 1] === ' ') {
    words.pop()
    places.pop()
  }

  return { words: words.join(''), places }
}

/**
 * The ranges of one line, sorted and joined where they overlap, so a run is
 * never cut in half by two hits that meet.
 *
 * @param ranges The ranges as they were found.
 * @returns The ranges, without overlaps.
 */
function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((one, other) => one[0] - other[0])
  const merged: Array<[number, number]> = []

  for (const range of sorted) {
    const last = merged[merged.length - 1]

    if (last !== undefined && range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1])
      continue
    }

    merged.push([range[0], range[1]])
  }

  return merged
}

/**
 * The hits of a block's lines: where each highlight falls, and which lines it
 * touches.
 *
 * A highlight is matched against the block's words (the lines' words joined by
 * a space, as markdown reflows a paragraph), so a selection that crossed a
 * line break is found again. The match is mapped back to the lines, and to
 * the places in each line's own words.
 *
 * @param lines      The lines of the block.
 * @param highlights The highlights to look for.
 * @returns The hits, one entry per line.
 */
export function layoutHits(lines: readonly VisualLine[], highlights: readonly string[]): LineHit[] {
  const hits: LineHit[] = lines.map(() => ({ ranges: [], highlights: [] }))

  // The words each line shows, and how many there are.
  const shown = lines.map(line => line.runs.map(run => run.text).join(''))

  // The words of each line, folded, and where each of them stands.
  const folded = shown.map(text => collapse(text))

  // The block's words (the lines' words joined by a space), and where each of
  // them stands: the line it is on and the place in that line's own words.
  const words: string[] = []
  const places: Array<{ line: number; at: number }> = []
  let lastLine = -1

  lines.forEach((_line, index) => {
    const line = folded[index]

    if (line === undefined || line.words === '') {
      return
    }

    if (words.length > 0) {
      // The space between two lines stands for the end of the line before, so
      // a highlight that covers it covers that line's last word.
      words.push(' ')
      places.push({ line: lastLine, at: (shown[lastLine] ?? '').length })
    }

    for (let at = 0; at < line.words.length; at += 1) {
      words.push(line.words.charAt(at))
      places.push({ line: index, at: line.places[at] ?? 0 })
    }

    lastLine = index
  })

  const block = words.join('')

  for (const highlight of highlights) {
    const wanted = highlight.replace(/\s+/g, ' ').trim()

    if (wanted === '') {
      continue
    }

    let from = 0

    while (from <= block.length - wanted.length) {
      const at = block.indexOf(wanted, from)

      if (at < 0) {
        break
      }

      addHit(hits, places, shown, folded, at, at + wanted.length, highlight)
      from = at + 1
    }
  }

  for (const hit of hits) {
    hit.ranges = mergeRanges(hit.ranges)
  }

  return hits
}

/**
 * Note one match of a highlight: the ranges of the words it covers on every
 * line it touches, and the highlight itself on each of them.
 *
 * A line with no words (a blank line of a code fence) is not touched: it has
 * nothing to mark.
 *
 * @param hits      The hits of the lines, to note the match in.
 * @param places    Where each word of the block stands.
 * @param shown     The words each line shows.
 * @param folded    The folded words of each line; a line with none is empty.
 * @param start     Where the match starts in the block's words.
 * @param end       Where the match ends in the block's words.
 * @param highlight The highlight that matched.
 */
function addHit(
  hits: LineHit[],
  places: Array<{ line: number; at: number }>,
  shown: string[],
  folded: Array<{ words: string; places: number[] }>,
  start: number,
  end: number,
  highlight: string,
): void {
  const first = places[start]
  const last = places[end - 1]

  if (first === undefined || last === undefined) {
    return
  }

  const touched: number[] = []

  if (first.line === last.line) {
    touched.push(first.line)
    hits[first.line]?.ranges.push([first.at, last.at + 1])
  } else {
    touched.push(first.line)
    hits[first.line]?.ranges.push([first.at, (shown[first.line] ?? '').length])

    for (let line = first.line + 1; line < last.line; line += 1) {
      if ((folded[line]?.words ?? '') === '') {
        continue
      }

      touched.push(line)
      hits[line]?.ranges.push([0, (shown[line] ?? '').length])
    }

    touched.push(last.line)
    hits[last.line]?.ranges.push([0, last.at + 1])
  }

  for (const line of touched) {
    hits[line]?.highlights.push(highlight)
  }
}

// --------------------------------------------------
// The runs as they are drawn
// --------------------------------------------------

/**
 * One run as it is drawn: the words, and whether a highlight falls on them.
 */
export type DrawnRun = InlineRun & {
  /** True when a highlight covers the words. */
  isHit: boolean
}

/**
 * The runs of a line, cut at the edges of the hits that fall on it.
 *
 * A run a hit covers in part is cut into three: the words before the hit, the
 * hit itself and the words after it. The hit keeps the run's own style.
 *
 * @param runs   The line's runs.
 * @param ranges The ranges of the line's words that are hits.
 * @returns The runs as they are drawn.
 */
export function splitRuns(
  runs: readonly InlineRun[],
  ranges: readonly (readonly [number, number])[],
): DrawnRun[] {
  const drawn: DrawnRun[] = []
  let at = 0

  for (const run of runs) {
    const start = at
    const end = at + run.text.length
    at = end

    const cuts = ranges
      .filter(([from, to]) => to > start && from < end)
      .sort((one, other) => one[0] - other[0])

    if (cuts.length === 0) {
      drawn.push({ ...run, isHit: false })
      continue
    }

    let cursor = start

    for (const [from, to] of cuts) {
      const cutFrom = Math.max(from, start)
      const cutTo = Math.min(to, end)

      if (cutFrom > cursor) {
        drawn.push({ ...run, text: run.text.slice(cursor - start, cutFrom - start), isHit: false })
      }

      drawn.push({ ...run, text: run.text.slice(cutFrom - start, cutTo - start), isHit: true })
      cursor = cutTo
    }

    if (cursor < end) {
      drawn.push({ ...run, text: run.text.slice(cursor - start), isHit: false })
    }
  }

  return drawn
}

// --------------------------------------------------
// The parts of a drawn body
// --------------------------------------------------

/**
 * One part of a drawn body: the markdown of the blocks that hold no hit, the
 * code of a fence that holds one, or the lines of a block that holds one.
 */
export type HighlightPart =
  | { kind: 'markdown'; text: string }
  | { kind: 'code'; source: string }
  | { kind: 'lines'; lines: VisualLine[]; hits: LineHit[] }

/**
 * The parts an output with highlights is drawn as.
 *
 * The blocks that hold no hit are joined back into one Markdown (the engine's
 * renderer keeps its own spacing inside); a block that holds a hit is a part
 * of its own, drawn as its lines. A fence that holds a hit is drawn as code:
 * code is never split into runs, so the hit is ignored there.
 *
 * @param text       The output's whole text.
 * @param highlights The highlights the output holds.
 * @returns The parts, in the order they stand in.
 */
export function splitHighlightParts(text: string, highlights: readonly string[]): HighlightPart[] {
  const parts: HighlightPart[] = []
  let markdown: string[] = []

  const flush = (): void => {
    if (markdown.length === 0) {
      return
    }

    parts.push({ kind: 'markdown', text: markdown.join('\n\n') })
    markdown = []
  }

  for (const block of splitBlocks(text)) {
    const isFence = FENCE.test(block)
    const lines = isFence ? fenceLines(block) : inlineLines(block)
    const hits = layoutHits(lines, highlights)
    const hasHit = hits.some(hit => hit.ranges.length > 0)

    if (!hasHit) {
      markdown.push(block)
      continue
    }

    flush()

    if (isFence) {
      parts.push({ kind: 'code', source: fenceSource(block) })
      continue
    }

    parts.push({ kind: 'lines', lines, hits })
  }

  flush()

  return parts
}

// --------------------------------------------------
// The drawing
// --------------------------------------------------

/** The empty row between two drawn parts. */
const PART_GAP = 1

/** The colour inline code is drawn in (the theme holds no key of its own). */
const CODE_COLOR = 'cyan'

/**
 * The body of an output that carries highlights: the blocks that hold no hit
 * as the engine's own markdown, and the blocks that hold one as their lines,
 * with the hit marked.
 *
 * A line that holds a hit is a Button, so a press on it takes the highlights
 * that fall on it off (decisions.md D17).
 *
 * @param els        The surface's element table.
 * @param text       The output's whole text.
 * @param highlights The highlights the output holds.
 * @param requestId  The row's requestId, the buttons' address.
 * @param onRemove   What a press on a hit line runs: it takes the highlights
 *                   that fall on that line off.
 * @returns The body, as a Box of parts.
 */
export function drawHighlighted(
  els: HighlightElements,
  text: string,
  highlights: readonly string[],
  requestId: string,
  onRemove: (hits: readonly string[]) => void,
): RenderElement {
  const { Box, Button, Code, Markdown, Text } = els
  const children: RenderElement[] = []
  let line = 0

  splitHighlightParts(text, highlights).forEach((part, index) => {
    if (index > 0) {
      children.push(<Box key={`gap-${index}`} height={PART_GAP} />)
    }

    if (part.kind === 'markdown') {
      children.push(<Markdown key={`md-${index}`} text={part.text} />)
      return
    }

    if (part.kind === 'code') {
      children.push(<Code key={`code-${index}`} source={part.source} />)
      return
    }

    part.lines.forEach((visual, at) => {
      const hit = part.hits[at]
      const ranges = hit?.ranges ?? []
      const number = line
      const key = `hl:${requestId}:${number}`
      line += 1

      const drawn = splitRuns(visual.runs, ranges).map((run, runAt) => {
        const props: TextProps = {}

        if (run.bold) {
          props.bold = true
        }

        if (run.italic) {
          props.italic = true
        }

        if (run.underline) {
          props.underline = true
        }

        if (run.code) {
          props.color = CODE_COLOR
        }

        if (run.isHit) {
          props.backgroundColor = 'yellow'
          props.color = 'black'
        }

        return (
          <Text key={`r-${number}-${runAt}`} {...props}>
            {run.text}
          </Text>
        )
      })

      if (hit === undefined || ranges.length === 0) {
        children.push(<Text key={key}>{drawn}</Text>)
        return
      }

      children.push(
        <Button plain key={key} onPress={() => onRemove(hit.highlights)}>
          {drawn}
        </Button>,
      )
    })
  })

  return <Box flexDirection="column">{children}</Box>
}
