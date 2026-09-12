/**
 * Property 20 of shared-coupon-redemption: result rendering is literal and
 * complete.
 *
 * Three claims are asserted over generated result sets, all of them about what
 * reaches the page rather than about what the components were handed:
 *
 * 1. **Literal text (Requirement 6.2).** The response message of an
 *    `UPSTREAM_ERROR` or `TRANSPORT_ERROR` row lands in the message cell as
 *    characters. The generated messages carry the real `(H306)` body
 *    `Invalid coupon code.<br/>Please check again.` alongside script tags, an
 *    `onerror` handler, a table-structure escape, HTML entities, and quotes, and
 *    the assertion has two halves: the cell's `textContent` equals the message,
 *    and the cell holds no element descendants at all. The first half alone
 *    would pass on a page where `<br/>` had become a line break, because
 *    `textContent` skips element boundaries; the second half is what proves each
 *    markup character stayed a character.
 * 2. **Truncation at 500 (Requirement 6.2).** For messages longer than
 *    `MAX_DISPLAYED_MESSAGE_CHARS`, the displayed text is exactly
 *    `message.slice(0, MAX_DISPLAYED_MESSAGE_CHARS)`. `slice` counts UTF-16 code
 *    units, and one generated case straddles the cap with a surrogate pair, so
 *    the property states the code-unit truncation the component performs rather
 *    than a grapheme-aware one it does not claim.
 * 3. **Completeness (Requirements 6.1, 6.3).** One row per Member_Outcome,
 *    `SKIPPED` ones included, in the order the array holds them, each row
 *    carrying its Member_Label and its Member_Outcome; and a summary holding an
 *    entry for every one of the six Member_Outcome values, including the ones
 *    whose count is zero, with the six counts summing to the number of rows.
 *
 * Both components are presentational, so each sample is a plain `render` with no
 * router and no query client. The summary is fed `countOutcomes` of the same
 * generated list the table renders, which is what the redemption page does with
 * `RedemptionRunResult.counts`, so the two views always describe one run.
 *
 * Generated messages are never looked up with `getByText`: a hostile string is
 * matched as a substring across normalized whitespace, which makes a text query
 * ambiguous or empty for reasons that have nothing to do with the property. Every
 * assertion here reads a cell located by position and compares `textContent`.
 *
 * `jest-dom` is not installed, so the assertions are plain DOM reads.
 *
 * Validates: Requirements 6.1, 6.2, 6.3
 */

import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { cleanup, render } from "@testing-library/react"

import { OutcomeSummary } from "@/components/OutcomeSummary"
import {
  MAX_DISPLAYED_MESSAGE_CHARS,
  RunResultTable,
} from "@/components/RunResultTable"
import { countOutcomes } from "@/domain/outcomes"
import { MEMBER_OUTCOME_VALUES } from "@/domain/types"
import type { MemberOutcome } from "@/domain/types"

import {
  MESSAGE_BEARING_OUTCOMES,
  hostileMessageArb,
  overlongHostileMessageArb,
  resultOutcomesArb,
} from "./generators"

/* -------------------------------------------------------------------------- */
/* Rendering harness                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The placeholder a row with no displayable message shows. `NO_MESSAGE` is
 * module-private in `RunResultTable`, so the em dash is restated here; the
 * property needs it to tell "the message was withheld" apart from "the message
 * was displayed", which is the whole point of the `SKIPPED` case.
 */
const NO_MESSAGE = "\u2014"

/**
 * Renders the result view of one Redemption_Run: the rows and the summary of the
 * counts derived from those same rows.
 *
 * `@testing-library/react` mounts into a container appended to the document, and
 * one `it` here performs 100 of these, so every sample tears its own render down
 * again rather than leaving 100 detached tables behind for the `afterEach`
 * cleanup registered in `tests/setup/dom.ts`.
 */
function withResultView(
  outcomes: readonly MemberOutcome[],
  assertions: (container: HTMLElement) => void
): void {
  const { container } = render(
    <>
      <RunResultTable outcomes={outcomes} />
      <OutcomeSummary counts={countOutcomes(outcomes)} />
    </>
  )
  try {
    assertions(container)
  } finally {
    cleanup()
  }
}

/** The result rows, in document order. */
function resultRows(container: HTMLElement): Array<HTMLTableRowElement> {
  return Array.from(container.querySelectorAll<HTMLTableRowElement>("tbody tr"))
}

/** The row header holding the Member_Label of a row. */
function memberCell(row: HTMLTableRowElement): HTMLTableCellElement {
  const cell = row.querySelector<HTMLTableCellElement>("th[scope='row']")
  if (cell === null) {
    throw new Error("a result row carried no row header")
  }
  return cell
}

/** The data cells of a row: the outcome badge first, the message second. */
function dataCells(row: HTMLTableRowElement): Array<HTMLTableCellElement> {
  return Array.from(row.querySelectorAll<HTMLTableCellElement>("td"))
}

/** The message cell of a row. */
function messageCell(row: HTMLTableRowElement): HTMLTableCellElement {
  const cells = dataCells(row)
  if (cells.length !== 2) {
    throw new Error(
      `expected an outcome cell and a message cell, found ${cells.length} cells`
    )
  }
  return cells[1]
}

/* -------------------------------------------------------------------------- */
/* Assertions                                                                 */
/* -------------------------------------------------------------------------- */

/** What Requirement 6.2 says the message cell of `outcome` displays. */
function expectedCellText(outcome: MemberOutcome): string {
  if (
    outcome.outcome !== "UPSTREAM_ERROR" &&
    outcome.outcome !== "TRANSPORT_ERROR"
  ) {
    return NO_MESSAGE
  }
  return outcome.upstreamResult.responseMessage.slice(
    0,
    MAX_DISPLAYED_MESSAGE_CHARS
  )
}

/**
 * Requirement 6.2: the message rendered as literal text.
 *
 * The element-descendant check is the load-bearing half. A cell whose message
 * became markup would still answer the right `textContent` — `<br/>` parsed as an
 * element contributes nothing to it — so the property also states that the cell
 * holds text nodes only: no `<br>`, `<script>`, or `<img>`, and in fact no
 * element of any name, because the component adds none of its own here.
 */
function assertLiteralMessageCell(
  cell: HTMLTableCellElement,
  expectedText: string
): void {
  expect(cell.textContent).toBe(expectedText)

  expect(cell.querySelector("br, script, img, b, i, div, span, tr, td")).toBe(
    null
  )
  expect(cell.querySelectorAll("*")).toHaveLength(0)
  // Every child is a text node, so nothing was interpreted as markup and no
  // character was moved into an attribute or a comment.
  expect(Array.from(cell.childNodes).every((node) => node.nodeType === 3)).toBe(
    true
  )
}

/**
 * Requirement 6.1: one row per Member_Outcome, in the given order, each holding
 * the Member_Label and the Member_Outcome. Compared positionally, because two
 * Group_Members may share a Member_Label.
 */
function assertRowsMatchOutcomes(
  container: HTMLElement,
  outcomes: readonly MemberOutcome[]
): void {
  const rows = resultRows(container)

  expect(rows).toHaveLength(outcomes.length)
  expect(rows.map((row) => memberCell(row).textContent)).toEqual(
    outcomes.map((outcome) => outcome.memberLabel)
  )
  expect(rows.map((row) => dataCells(row)[0].textContent)).toEqual(
    outcomes.map((outcome) => outcome.outcome)
  )
}

/**
 * Requirement 6.3: an entry for each of the six Member_Outcome values, zero
 * counts included, and the six counts summing to the number of rows.
 *
 * The counts are read from the `<dd>` elements rather than from the props, so a
 * summary that dropped an entry fails here instead of passing on the object it
 * was handed. `[data-outcome]` is carried by the badge too, hence the `dd`
 * qualifier.
 */
function assertSummaryCounts(
  container: HTMLElement,
  outcomes: readonly MemberOutcome[]
): void {
  const counts = countOutcomes(outcomes)
  const rendered = MEMBER_OUTCOME_VALUES.map((value) => {
    const cell = container.querySelector(`dd[data-outcome="${value}"]`)
    if (cell === null) {
      throw new Error(`the summary rendered no entry for ${value}`)
    }
    return { value, text: cell.textContent }
  })

  expect(rendered).toEqual(
    MEMBER_OUTCOME_VALUES.map((value) => ({
      value,
      text: String(counts[value]),
    }))
  )
  expect(rendered.reduce((sum, entry) => sum + Number(entry.text), 0)).toBe(
    outcomes.length
  )
}

/* -------------------------------------------------------------------------- */
/* Properties                                                                 */
/* -------------------------------------------------------------------------- */

describe("result rendering", () => {
  // Feature: shared-coupon-redemption, Property 20: Result rendering is literal
  // and complete — For any completed Redemption_Run result, the result view
  // renders the response message of every `UPSTREAM_ERROR` and `TRANSPORT_ERROR`
  // row as literal text with every markup character visible as a character.
  // Validates: Requirements 6.2
  it("renders every markup character of a message as a visible character", () => {
    fc.assert(
      fc.property(
        resultOutcomesArb({
          minLength: 1,
          // Only message-bearing rows, so every generated row exercises the
          // literal-rendering claim rather than the placeholder.
          outcomeValues: MESSAGE_BEARING_OUTCOMES,
          messageArb: hostileMessageArb,
        }),
        (outcomes) => {
          withResultView(outcomes, (container) => {
            const rows = resultRows(container)
            expect(rows).toHaveLength(outcomes.length)

            rows.forEach((row, position) => {
              const outcome = outcomes[position]
              if (outcome.outcome === "SKIPPED") {
                throw new Error("expected a message-bearing outcome")
              }
              const message = outcome.upstreamResult.responseMessage

              assertLiteralMessageCell(
                messageCell(row),
                message.slice(0, MAX_DISPLAYED_MESSAGE_CHARS)
              )
            })
          })
        }
      ),
      { numRuns: 100 }
    )
  })

  // Feature: shared-coupon-redemption, Property 20: Result rendering is literal
  // and complete — For any completed Redemption_Run result, the result view
  // limits the displayed response message of an `UPSTREAM_ERROR` or
  // `TRANSPORT_ERROR` row to its first 500 characters.
  // Validates: Requirements 6.2
  it("limits a displayed message to its first 500 characters", () => {
    fc.assert(
      fc.property(
        resultOutcomesArb({
          minLength: 1,
          maxLength: 3,
          outcomeValues: MESSAGE_BEARING_OUTCOMES,
          messageArb: overlongHostileMessageArb(MAX_DISPLAYED_MESSAGE_CHARS),
        }),
        (outcomes) => {
          withResultView(outcomes, (container) => {
            resultRows(container).forEach((row, position) => {
              const outcome = outcomes[position]
              if (outcome.outcome === "SKIPPED") {
                throw new Error("expected a message-bearing outcome")
              }
              const message = outcome.upstreamResult.responseMessage
              expect(message.length).toBeGreaterThan(
                MAX_DISPLAYED_MESSAGE_CHARS
              )

              const cell = messageCell(row)
              // Code units, not graphemes: `slice` is what the component does,
              // so a truncated surrogate pair is expected, not rounded away.
              expect(cell.textContent).toBe(
                message.slice(0, MAX_DISPLAYED_MESSAGE_CHARS)
              )
              expect(cell.textContent).toHaveLength(MAX_DISPLAYED_MESSAGE_CHARS)
              // The characters beyond the cap are gone from the page, tail
              // markup included.
              expect(cell.textContent).not.toBe(message)
              expect(cell.querySelectorAll("*")).toHaveLength(0)
            })
          })
        }
      ),
      { numRuns: 100 }
    )
  })

  // Feature: shared-coupon-redemption, Property 20: Result rendering is literal
  // and complete — For any completed Redemption_Run result, the result view
  // renders one row per Member_Outcome of the fixed list in processing order,
  // including every `SKIPPED` row, each holding the Member_Label and the
  // Member_Outcome, and renders a summary holding all six outcome counts
  // including counts equal to zero.
  // Validates: Requirements 6.1, 6.3
  it("renders one row per outcome in order, and all six counts", () => {
    fc.assert(
      fc.property(
        // The full six values and a minimum length of 0, so both the `SKIPPED`
        // rows and the zero-row result set are generated.
        resultOutcomesArb({ messageArb: hostileMessageArb }),
        (outcomes) => {
          withResultView(outcomes, (container) => {
            assertRowsMatchOutcomes(container, outcomes)
            assertSummaryCounts(container, outcomes)

            // Requirement 6.2 read from the other side: a row that carries no
            // displayable message — `SKIPPED` included, whose `upstreamResult`
            // is null — shows the placeholder, never a message.
            resultRows(container).forEach((row, position) => {
              assertLiteralMessageCell(
                messageCell(row),
                expectedCellText(outcomes[position])
              )
            })
          })
        }
      ),
      { numRuns: 100 }
    )
  })
})
