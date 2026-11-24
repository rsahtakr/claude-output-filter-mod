/**
 * The marks an assistant output carries: the one-word category label in
 * front of it, and the row that holds the label beside the output.
 *
 * The chip is drawn by the mod and the engine's own row is kept whole, so
 * the label sits in a column of its own and the output still reads as the
 * engine drew it. The chip is a button: pressing it flags the output.
 */
import type { RenderElement } from 'claude-code'

import { LABEL_COLOR } from './classify'
import { drawHighlighted } from './highlight-render'
import type { HighlightElements } from './highlight-render'
import type { OutputLabel } from '../types'

// --------------------------------------------------
// The chip
// --------------------------------------------------

/** The elements the marks are drawn with, as `$.ui.resolve(e)` hands them out. */
export type MarkElements = HighlightElements

/**
 * The chip's width in cells: the longest label (`Finding`, seven cells) and
 * a gap, so every output's text starts in the same column.
 */
const CHIP_WIDTH = 9

/** What an output without a label draws: a dot, in the chip's own column. */
const UNDECIDED = '·'

/** The mark a flagged output carries after its label. */
const FLAG_MARK = '⚑'

/**
 * The label chip in front of an output: the category's name in its own
 * colour, or a dim dot while no label is known yet.
 *
 * The chip is nine cells wide, so the outputs line up under one another; a
 * Text has no width of its own, so the name is padded to that width and the
 * column around it is fixed by `labelled`.
 *
 * A flagged output's chip carries the flag's mark behind the name; the name
 * gives up the two cells the mark takes, so the chip stays nine cells wide.
 *
 * @param els       The surface's element table.
 * @param label     The category, or undefined while it is undecided.
 * @param isFlagged Whether the output is flagged; a flag adds its mark.
 * @param requestId The row's requestId, the chip's address.
 * @param onPress   What a press on the chip runs.
 * @returns The chip, as a Button.
 */
export function labelChip(
  els: MarkElements,
  label: OutputLabel | undefined,
  isFlagged: boolean,
  requestId: string,
  onPress: () => void,
): RenderElement {
  const { Button, Text } = els

  if (label === undefined) {
    return (
      <Button plain key={`flag:${requestId}`} onPress={onPress}>
        <Text dimColor>{UNDECIDED.padEnd(CHIP_WIDTH)}</Text>
      </Button>
    )
  }

  const name = label.padEnd(isFlagged ? CHIP_WIDTH - 2 : CHIP_WIDTH)
  const chip = <Text key="label" color={LABEL_COLOR[label]} bold>{name}</Text>
  const children = isFlagged ? [chip, ` ${FLAG_MARK}`] : [chip]

  return (
    <Button plain key={`flag:${requestId}`} onPress={onPress}>
      {children}
    </Button>
  )
}

// --------------------------------------------------
// The row
// --------------------------------------------------

/**
 * The row as the mod draws it: the chip in a fixed column of its own, and
 * the engine's own row in the rest of the line.
 *
 * The chip's column does not shrink (a long label never eats the output's
 * width) and the body takes what is left.
 *
 * @param els  The surface's element table.
 * @param chip The chip, as `labelChip` made it.
 * @param body The engine's own row.
 * @returns The row, as a Box.
 */
export function labelled(els: MarkElements, chip: RenderElement, body: RenderElement): RenderElement {
  const { Box } = els

  return (
    <Box flexDirection="row">
      <Box width={CHIP_WIDTH} flexShrink={0}>{chip}</Box>
      <Box flexGrow={1}>{body}</Box>
    </Box>
  )
}

// --------------------------------------------------
// The highlighted body
// --------------------------------------------------

/**
 * The body of an output that carries highlights: its blocks, the ones holding
 * a highlight drawn as the lines they are.
 *
 * A block that holds no highlight is drawn as the markdown it is, as the
 * engine draws it. A block that holds one is drawn as its lines, with the
 * words the highlight covers marked.
 *
 * A line that holds a highlight is a Button, so a press on it takes the
 * highlights that fall on it off.
 *
 * @param els        The surface's element table.
 * @param text       The output's whole text.
 * @param highlights The highlights the output holds.
 * @param requestId  The row's requestId, the buttons' address.
 * @param onRemove   What a press on a highlighted line runs: it takes the
 *                   highlights that fall on that line off.
 * @returns The body, as a Box of parts.
 */
export function highlightedBody(
  els: MarkElements,
  text: string,
  highlights: readonly string[],
  requestId: string,
  onRemove: (hits: readonly string[]) => void,
): RenderElement {
  return drawHighlighted(els, text, highlights, requestId, onRemove)
}
