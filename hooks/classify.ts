/**
 * The text rules that give an assistant output its category label, and the
 * helpers that ask Haiku for one when the rules cannot decide.
 *
 * The rules are pure text functions: no state, no engine, no I/O, so a
 * transcript-row hook can call them while it draws.
 *
 * The convention (decisions.md D8, the same one the fixture's labels follow):
 * `Report` and `Ask` are looked for in the whole output, because a summary or
 * a question may open a long block; the other six are judged on the output's
 * first sentence, because that is where a plan, a wait, a finding, a
 * completion, a failure or an explanation announces itself. The order of
 * precedence is `Report > Ask > Problem > Done > Wait > Finding > Plan >
 * Explain`, and an output that matches nothing stays undecided
 * (`undefined`), so the caller can ask Haiku instead.
 *
 * One case sits outside that order: a first sentence that opens with a
 * gerund (`Updating the handoff`) is a `Plan`, and it is read before the
 * `Wait` and `Finding` markers, because an output that says what it is about
 * to do is not a wait and not a finding.
 */
import type { OutputLabel } from '../types'

// --------------------------------------------------
// The labels
// --------------------------------------------------

/** The eight output categories, in the order the table lists them. */
export const LABELS: readonly OutputLabel[] = [
  'Plan',
  'Wait',
  'Finding',
  'Done',
  'Problem',
  'Ask',
  'Report',
  'Explain',
]

/**
 * The colour each category draws its label in: blue for a plan, grey for a
 * wait, cyan for a finding, green for a completion, red for a problem, yellow
 * for a question, magenta for a report and white for an explanation.
 */
export const LABEL_COLOR: Record<OutputLabel, string> = {
  Plan: 'blue',
  Wait: 'gray',
  Finding: 'cyan',
  Done: 'green',
  Problem: 'red',
  Ask: 'yellow',
  Report: 'magenta',
  Explain: 'white',
}

// --------------------------------------------------
// First sentence
// --------------------------------------------------

/**
 * The index where the sentence that starts at `from` ends: the first `. `,
 * the first `: ` that a capital letter follows, the first `?`, the first `!`
 * or the first newline.
 *
 * A colon only ends the sentence when a capital follows it, so a sentence
 * that names a value (`Recorded as: 434030e`) is not cut in two. The
 * delimiter itself is left out, so the sentence ends where the delimiter
 * starts.
 *
 * @param text The output's whole text.
 * @param from Where the sentence starts.
 * @returns The index of the delimiter that ends the sentence, or the text's
 *          length when it holds none.
 */
function sentenceEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    const ch = text[i]

    if (ch === '\n' || ch === '?' || ch === '!') return i

    if (ch === '.' && text[i + 1] === ' ') return i

    if (ch === ':' && text[i + 1] === ' ') {
      const next = text[i + 2]

      if (next !== undefined && next >= 'A' && next <= 'Z') return i
    }
  }

  return text.length
}

/**
 * The output's first sentence: the text up to the first `. `, the first `: `
 * that a capital letter follows, the first `?`, the first `!` or the first
 * newline.
 *
 * The delimiter itself is left out, so the text ends where the sentence does.
 *
 * @param text The output's whole text.
 * @returns The first sentence, or the whole text when it holds no delimiter.
 */
export function firstSentence(text: string): string {
  return text.slice(0, sentenceEnd(text, 0))
}

/**
 * The output's second sentence: what follows the first sentence's
 * delimiter, up to the next delimiter.
 *
 * An output often opens with a status (`The suite is green.`) and says what
 * it does next in its second sentence, so the rules look there too when the
 * first sentence says nothing.
 *
 * @param text The output's whole text.
 * @returns The second sentence, or an empty string when the output holds
 *          only one.
 */
export function secondSentence(text: string): string {
  const end = sentenceEnd(text, 0)

  if (end >= text.length) return ''

  // Step over the delimiter (`. ` and `: ` are two characters) and the
  // whitespace behind it.
  let start = end + 1

  if (text[end] === '.' || text[end] === ':') start = end + 2

  while (start < text.length && /\s/.test(text[start] ?? '')) start++

  if (start >= text.length) return ''

  return text.slice(start, sentenceEnd(text, start))
}

// --------------------------------------------------
// The markers
// --------------------------------------------------

/**
 * The markers of the two labels that are looked for in the whole output.
 *
 * A report opens with what was done, a result or a status, and a question
 * asks for the person's answer; both may sit at the end of a long block, so
 * the whole text is searched.
 */
const WHOLE_TEXT_MARKERS: ReadonlyArray<{ label: OutputLabel; pattern: RegExp }> = [
  // Report: what was done, a result, a status heading, what happened, the
  // checks a report lists, what a summary says is left.
  { label: 'Report', pattern: /\*\*what i did:?\*\*/i },
  { label: 'Report', pattern: /^\s*result:/im },
  { label: 'Report', pattern: /^\s*#{1,6}\s*status\b/im },
  { label: 'Report', pattern: /\*\*status\b/i },
  { label: 'Report', pattern: /\*\*what happened\b/i },
  { label: 'Report', pattern: /\*\*checks:?\*\*/i },
  { label: 'Report', pattern: /\bwhat remains\b/i },
  // Ask: a decision that is the person's to make, or input the output waits
  // for. The yes is looked for as a request (`needs your yes`, `your yes on`),
  // not as any mention of one, so a report that remembers a past yes stays a
  // report.
  { label: 'Ask', pattern: /^\s*needs input:/im },
  { label: 'Ask', pattern: /needs? your yes/i },
  { label: 'Ask', pattern: /your (?:explicit )?yes on\b/i },
  { label: 'Ask', pattern: /decision only you/i },
  { label: 'Ask', pattern: /decisions are yours/i },
  { label: 'Ask', pattern: /\*\*recommendation:?\*\*/i },
]

/**
 * The markers of the two labels that outrank how the sentence opens: a
 * failure, a completion.
 *
 * The markers were tuned on the labelled fixture, which is the measure the
 * rules are held to, and the tuning is where the exceptions come from:
 *
 * - `error` is matched apart from the counts that report success (`0 errors`,
 *   `no errors`).
 * - `OOM` keeps its capitals, since the letters appear inside ordinary words
 *   (`room`).
 * - `can't` is left out: in the fixture it is a limitation (`ws1 can't use
 *   CUDA graphs`), not a failure. `cannot` stays, as it reads as a hard stop.
 * - `correction` is matched only where it is announced (`one correction`,
 *   `correction:`), because a `learned correction` is part of a design, not a
 *   failure.
 * - `shouldn't` and `should not have` name a mistake the output admits to
 *   (`the planner edited files it shouldn't have`), so they read as a
 *   failure.
 */
const PROBLEM_AND_DONE_MARKERS: ReadonlyArray<{ label: OutputLabel; pattern: RegExp }> = [
  // Problem: a failure, a refusal, a correction of the output's own.
  { label: 'Problem', pattern: /fail/i },
  { label: 'Problem', pattern: /(?<!0 )(?<!no )(?<!zero )\berrors?\b/i },
  { label: 'Problem', pattern: /crash/i },
  { label: 'Problem', pattern: /killed/i },
  { label: 'Problem', pattern: /refuses/i },
  { label: 'Problem', pattern: /rejects/i },
  { label: 'Problem', pattern: /denied/i },
  { label: 'Problem', pattern: /broke/i },
  { label: 'Problem', pattern: /wrong/i },
  { label: 'Problem', pattern: /timed out/i },
  { label: 'Problem', pattern: /rate limit/i },
  { label: 'Problem', pattern: /busy until/i },
  { label: 'Problem', pattern: /blocked/i },
  { label: 'Problem', pattern: /cannot/i },
  { label: 'Problem', pattern: /\b(?:one|a) correction\b|\bcorrection\s*:/i },
  { label: 'Problem', pattern: /(?<![A-Za-z])OOM(?![A-Za-z])/ },
  { label: 'Problem', pattern: /\b(?:were|was) off\b/i },
  { label: 'Problem', pattern: /\bcollides\b/i },
  { label: 'Problem', pattern: /\bconflicts\b/i },
  { label: 'Problem', pattern: /shouldn['’]t/i },
  { label: 'Problem', pattern: /should not have/i },
  // Done: the work landed.
  { label: 'Done', pattern: /committed/i },
  { label: 'Done', pattern: /merged/i },
  { label: 'Done', pattern: /landed/i },
  { label: 'Done', pattern: /recorded as/i },
  { label: 'Done', pattern: /is done/i },
  { label: 'Done', pattern: /finished/i },
  { label: 'Done', pattern: /\b\d+ (?:tests? )?pass/i },
  { label: 'Done', pattern: /tests pass/i },
  { label: 'Done', pattern: /left the queue/i },
  { label: 'Done', pattern: /is created/i },
  { label: 'Done', pattern: /now points/i },
]

/**
 * The markers of the three labels that are judged after a failure, a
 * completion and a sentence that opens with a gerund: a wait, a finding, a
 * plan.
 */
const WAIT_FINDING_AND_PLAN_MARKERS: ReadonlyArray<{ label: OutputLabel; pattern: RegExp }> = [
  // Wait: jobs run, or the output waits for them.
  { label: 'Wait', pattern: /is running/i },
  { label: 'Wait', pattern: /are running/i },
  { label: 'Wait', pattern: /running again/i },
  { label: 'Wait', pattern: /still running/i },
  { label: 'Wait', pattern: /waiting/i },
  { label: 'Wait', pattern: /wait for/i },
  { label: 'Wait', pattern: /in the background/i },
  { label: 'Wait', pattern: /submitted/i },
  { label: 'Wait', pattern: /queued/i },
  { label: 'Wait', pattern: /pending/i },
  { label: 'Wait', pattern: /paused/i },
  { label: 'Wait', pattern: /has been training/i },
  // Finding: a check or a measurement came back.
  { label: 'Finding', pattern: /match/i },
  { label: 'Finding', pattern: /verif/i },
  { label: 'Finding', pattern: /agree/i },
  { label: 'Finding', pattern: /exactly/i },
  { label: 'Finding', pattern: /only/i },
  { label: 'Finding', pattern: /shows/i },
  { label: 'Finding', pattern: /is clean/i },
  { label: 'Finding', pattern: /are clean/i },
  // Plan: the next step, announced.
  { label: 'Plan', pattern: /^i['’]?ll\b/i },
  { label: 'Plan', pattern: /^i will\b/i },
  { label: 'Plan', pattern: /^next\b/i },
  { label: 'Plan', pattern: /^now\b/i },
  { label: 'Plan', pattern: /^starting\b/i },
  { label: 'Plan', pattern: /^submitting\b/i },
  { label: 'Plan', pattern: /^loading\b/i },
  { label: 'Plan', pattern: /^reading\b/i },
  { label: 'Plan', pattern: /^checking\b/i },
  { label: 'Plan', pattern: /^building\b/i },
  { label: 'Plan', pattern: /^updating\b/i },
  { label: 'Plan', pattern: /^appending\b/i },
  { label: 'Plan', pattern: /^extracting\b/i },
  { label: 'Plan', pattern: /^first\b/i },
  { label: 'Plan', pattern: /^while\b/i },
  { label: 'Plan', pattern: /^before\b/i },
  { label: 'Plan', pattern: /^this time\b/i },
  { label: 'Plan', pattern: /\bi['’]?ll\b/i },
]

/**
 * The markers of the label that answers: an output that opens with `Yes`,
 * `No`, a short answer or a reason explains rather than works.
 *
 * `Yes` and `No` count only when a comma, a full stop or a colon follows
 * them, because `No `x` exists` is a finding about a missing thing, not an
 * answer.
 */
const EXPLAIN_MARKERS: ReadonlyArray<{ label: OutputLabel; pattern: RegExp }> = [
  { label: 'Explain', pattern: /^yes\b[.,:]/i },
  { label: 'Explain', pattern: /^no\b[.,:]/i },
  { label: 'Explain', pattern: /^short answer/i },
  { label: 'Explain', pattern: /^because\b/i },
  { label: 'Explain', pattern: /^\*\*why\b/i },
]

// --------------------------------------------------
// The rules
// --------------------------------------------------

/**
 * Whether the output announces what it does next.
 *
 * It does when it opens with a gerund (`Running the suite`) or when a plan
 * word (`I'll`, `Next`, `Now`) stands near its top, which is how an output
 * that opens with a status and then says what it does next is read.
 *
 * @param text The output's whole text.
 * @returns Whether the output announces a next step.
 */
function announcesAPlan(text: string): boolean {
  // A gerund opens the output: `Running the suite`, `Recording the result`.
  if (opensWithAGerund(text)) return true

  const top = text.slice(0, 200)

  return /\bi['’]?ll\b/.test(top) || /\bNext\b/.test(top) || /\bNow\b/.test(top)
}

/**
 * The words that end in `ing` without being gerunds, so that an output
 * opening with `Everything` is not read as a plan.
 */
const NOT_GERUNDS = new Set([
  'everything',
  'nothing',
  'anything',
  'something',
  'morning',
  'evening',
  'ceiling',
])

/**
 * Whether a sentence opens with a gerund, which is how an output says what
 * it is about to do (`Running the suite`, `Updating the handoff`).
 *
 * The word has to be capitalised and end in `ing`, and the everyday words
 * that end in `ing` without being gerunds are left out.
 *
 * @param sentence The sentence to look at.
 * @returns Whether the sentence opens with a gerund.
 */
function opensWithAGerund(sentence: string): boolean {
  const first = /^[A-Za-z][A-Za-z']*/.exec(sentence.trim())?.[0]

  if (first === undefined) return false

  return /^[A-Z][a-z]*ing$/.test(first) && !NOT_GERUNDS.has(first.toLowerCase())
}

/**
 * The label the text rules give an output, or `undefined` when they cannot
 * decide.
 *
 * The whole text is searched for the `Report` and `Ask` markers, the first
 * sentence for the other six, and the first label that matches in the order
 * `Report > Ask > Problem > Done > Wait > Finding > Plan > Explain` wins.
 *
 * A sentence that opens with a gerund (`Updating the handoff`) is the one
 * exception to that order: it is a `Plan`, and it is read after the `Problem`
 * and `Done` markers but before the `Wait` and `Finding` ones, so an output
 * that says what it is about to do is not read as a wait.
 *
 * When the first sentence says nothing, the second one is read the same way
 * (the `Explain` markers excepted, since a second sentence rarely opens an
 * answer), and when that says nothing too, an output that names a next step
 * near its top (`I'll`, `Next`, `Now`) is a `Plan`.
 *
 * @param text The output's whole text.
 * @returns The category the text belongs to, or `undefined` when no marker
 *          matched.
 */
export function classifyByRules(text: string): OutputLabel | undefined {
  for (const marker of WHOLE_TEXT_MARKERS) {
    if (marker.pattern.test(text)) return marker.label
  }

  const head = firstSentence(text)

  for (const marker of PROBLEM_AND_DONE_MARKERS) {
    if (marker.pattern.test(head)) return marker.label
  }

  if (opensWithAGerund(head)) return 'Plan'

  for (const marker of WAIT_FINDING_AND_PLAN_MARKERS) {
    if (marker.pattern.test(head)) return marker.label
  }

  for (const marker of EXPLAIN_MARKERS) {
    if (marker.pattern.test(head)) return marker.label
  }

  const second = secondSentence(text)

  if (second !== '') {
    for (const marker of PROBLEM_AND_DONE_MARKERS) {
      if (marker.pattern.test(second)) return marker.label
    }

    if (opensWithAGerund(second)) return 'Plan'

    for (const marker of WAIT_FINDING_AND_PLAN_MARKERS) {
      if (marker.pattern.test(second)) return marker.label
    }
  }

  if (announcesAPlan(text)) return 'Plan'

  return undefined
}

// --------------------------------------------------
// Haiku
// --------------------------------------------------

/**
 * The prompt that asks Haiku for an output's label.
 *
 * It names the eight labels with what each of them means, so the answer is a
 * category rather than a paraphrase, then gives the output's text (cut to
 * 1,500 characters, so the prompt stays inside the model's cap) and asks for
 * one word.
 *
 * @param text The output's whole text.
 * @returns The prompt to send to the model.
 */
export function haikuPrompt(text: string): string {
  const meanings: ReadonlyArray<[OutputLabel, string]> = [
    ['Plan', 'announces the next step'],
    ['Wait', 'jobs run, or the output waits for them'],
    ['Finding', 'a check or measurement came back'],
    ['Done', 'the work landed: committed, merged, tests pass'],
    ['Problem', 'something failed: an error, a mistake, a rate limit'],
    ['Ask', 'a decision or input is needed from the user'],
    ['Report', 'an end-of-task summary: what I did, did it work, next'],
    ['Explain', 'an answer, an explanation, science or literature'],
  ]

  const names = meanings.map(([label, meaning]) => `${label} (${meaning})`).join(', ')

  return [
    `Label the assistant output below with exactly one of these eight labels: ${names}.`,
    text.slice(0, 1500),
    'Answer with one word: the label.',
  ].join('\n\n')
}

/**
 * The eight names as whole words, matched whatever their case, so a reply of
 * `done.` is the `Done` label and `Plan` is not found inside `Planned`.
 */
const LABEL_WORDS: ReadonlyArray<{ label: OutputLabel; word: RegExp }> = LABELS.map(label => ({
  label,
  word: new RegExp(`\\b${label}\\b`, 'i'),
}))

/**
 * The label in a model's answer, or `undefined` when the answer holds none.
 *
 * The first name in the table's order that the answer holds wins, and the
 * answer may carry it in a sentence (`It is a Plan`).
 *
 * @param reply The model's answer.
 * @returns The label the answer names, or `undefined`.
 */
export function parseHaikuReply(reply: string): OutputLabel | undefined {
  for (const { label, word } of LABEL_WORDS) {
    if (word.test(reply)) return label
  }

  return undefined
}
