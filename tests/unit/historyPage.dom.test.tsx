/**
 * Unit tests for the history view (Requirements 6.2, 6.6, 6.9).
 *
 * `HistoryTable` is the whole rendered surface of `src/routes/history.tsx`: the
 * route fetches, the component renders. So these tests hand it records directly
 * and need neither a router nor a query client.
 *
 * Two things are worth stating about what is asserted here.
 *
 * The Requirement 6.6 order is applied by the server — `HistoryStore.list` has
 * the monotonic `seq` that breaks a completion-timestamp tie — and the component
 * renders `records` as received. The assertion that carries that contract is
 * therefore order *preservation*: a component that re-sorted would reorder an
 * input whose order a naive client-side sort disagrees with, so one test passes
 * exactly such an input and asserts the DOM keeps it.
 *
 * Requirement 6.2 asks for every markup character of a stored upstream message
 * to reach the page as a character. Asserting the text is visible is only half
 * of that: text is also "visible" when the browser has parsed a tag next to it.
 * So each literal-rendering test asserts both halves — the characters are found
 * as text *and* no corresponding element exists in the container.
 */

import { describe, expect, it } from "vitest"
import { render, screen, within } from "@testing-library/react"

import {
  EMPTY_HISTORY_MESSAGE,
  HISTORY_TABLE_CAPTION,
  HistoryTable,
  SOURCE_LABELS,
  STOPPED_EARLY_LABEL,
  formatCompletedAt,
} from "@/components/HistoryTable"
import type { RedemptionHistoryRecord } from "@/domain/types"

type HistoryOutcome = RedemptionHistoryRecord["outcomes"][number]

function outcome(overrides: Partial<HistoryOutcome> = {}): HistoryOutcome {
  return {
    hiveId: "hive-1",
    memberLabel: "Ada",
    outcome: "SUCCESS",
    responseCode: "100",
    responseMessage: "The coupon gift has been sent.",
    ...overrides,
  }
}

function record(
  overrides: Partial<RedemptionHistoryRecord> = {}
): RedemptionHistoryRecord {
  return {
    runId: "run-1",
    seq: 1,
    couponCode: "SPRING2024",
    completedAt: "2024-05-02T10:00:00.000Z",
    mock: false,
    stoppedEarly: false,
    outcomes: [outcome()],
    ...overrides,
  }
}

/**
 * The Coupon_Code of every body row, top to bottom. The Coupon_Code is the row
 * header, so this reads the rendered order straight off the DOM without relying
 * on how the accessibility tree names a `<th scope="row">`.
 */
function renderedCouponCodes(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("tbody tr")).map(
    (row) => row.querySelector("th")?.textContent ?? ""
  )
}

describe("HistoryTable empty state (Requirement 6.9)", () => {
  it("states that no redemption run has been recorded", () => {
    render(<HistoryTable records={[]} />)

    expect(screen.getByText(EMPTY_HISTORY_MESSAGE)).toBeTruthy()
  })

  it("renders no table when there is no record", () => {
    const { container } = render(<HistoryTable records={[]} />)

    expect(screen.queryByRole("table")).toBe(null)
    expect(container.querySelector("table")).toBe(null)
    expect(screen.queryByText(HISTORY_TABLE_CAPTION)).toBe(null)
  })
})

describe("HistoryTable row order (Requirement 6.6)", () => {
  /*
   * The order the server produces: completion timestamp descending, and among
   * records sharing a completion timestamp the most recently appended (the
   * higher `seq`) first.
   */
  const serverOrdered: readonly RedemptionHistoryRecord[] = [
    record({
      runId: "run-newest",
      seq: 9,
      couponCode: "NEWEST",
      completedAt: "2024-05-03T12:00:00.000Z",
    }),
    record({
      runId: "run-tie-later",
      seq: 8,
      couponCode: "TIE-LATER",
      completedAt: "2024-05-01T09:30:00.000Z",
    }),
    record({
      runId: "run-tie-earlier",
      seq: 3,
      couponCode: "TIE-EARLIER",
      completedAt: "2024-05-01T09:30:00.000Z",
    }),
    record({
      runId: "run-oldest",
      seq: 5,
      couponCode: "OLDEST",
      completedAt: "2024-04-28T08:00:00.000Z",
    }),
  ]

  it("renders one row per record plus the header row", () => {
    render(<HistoryTable records={serverOrdered} />)

    expect(screen.getAllByRole("row").length).toBe(serverOrdered.length + 1)
  })

  it("renders the server order, tie-break included", () => {
    const { container } = render(<HistoryTable records={serverOrdered} />)

    expect(renderedCouponCodes(container)).toEqual([
      "NEWEST",
      "TIE-LATER",
      "TIE-EARLIER",
      "OLDEST",
    ])
  })

  it("preserves an input order that a client-side sort would change", () => {
    /*
     * Oldest first, and the same-timestamp pair with the lower `seq` first: every
     * adjacent pair here is the reverse of what the Requirement 6.6 comparator
     * yields, so a component that re-sorted would reverse this list. The server
     * owns that comparator; the view renders what it was handed.
     */
    const reversed = [...serverOrdered].reverse()

    const { container } = render(<HistoryTable records={reversed} />)

    expect(renderedCouponCodes(container)).toEqual([
      "OLDEST",
      "TIE-EARLIER",
      "TIE-LATER",
      "NEWEST",
    ])
  })
})

describe("HistoryTable record fields", () => {
  const stored = record({
    runId: "run-fields",
    seq: 12,
    couponCode: "gIfT-2024",
    completedAt: "2024-05-02T10:15:30.000Z",
    mock: true,
    stoppedEarly: true,
    outcomes: [
      outcome({
        hiveId: "hive-ada",
        memberLabel: "Ada",
        outcome: "SUCCESS",
        responseCode: "100",
        responseMessage: "The coupon gift has been sent.",
      }),
      outcome({
        hiveId: "hive-grace",
        memberLabel: "Grace",
        outcome: "ALREADY_USED",
        responseCode: "(H304)",
        responseMessage: "This coupon code has already been used.",
      }),
      outcome({
        hiveId: "hive-linus",
        memberLabel: "Linus",
        outcome: "SKIPPED",
        responseCode: "",
        responseMessage: "",
      }),
    ],
  })

  function renderRow() {
    const { container } = render(<HistoryTable records={[stored]} />)
    const row = container.querySelector("tbody tr")
    if (row === null) throw new Error("expected one body row")
    return { container, row: row as HTMLElement }
  }

  it("renders the coupon code as stored", () => {
    const { row } = renderRow()

    expect(row.querySelector("th")?.textContent).toBe("gIfT-2024")
  })

  it("renders the formatted completion timestamp and keeps the stored value machine-readable", () => {
    const { row } = renderRow()
    const time = row.querySelector("time")

    expect(time?.textContent).toBe(formatCompletedAt(stored.completedAt))
    expect(time?.getAttribute("datetime")).toBe(stored.completedAt)
  })

  it("returns an unparseable completion timestamp as stored", () => {
    const unparseable = "not-a-timestamp"
    const { container } = render(
      <HistoryTable records={[record({ completedAt: unparseable })]} />
    )
    const time = container.querySelector("time")

    expect(formatCompletedAt(unparseable)).toBe(unparseable)
    expect(time?.textContent).toBe(unparseable)
    expect(time?.getAttribute("datetime")).toBe(unparseable)
  })

  it("marks the source of the record and notes the early stop", () => {
    const { row } = renderRow()

    expect(within(row).getByText(SOURCE_LABELS.mock)).toBeTruthy()
    expect(within(row).queryByText(SOURCE_LABELS.live)).toBe(null)
    expect(within(row).getByText(STOPPED_EARLY_LABEL)).toBeTruthy()
  })

  it("marks a live record and omits the early-stop note when the run completed", () => {
    const { container } = render(
      <HistoryTable records={[record({ mock: false, stoppedEarly: false })]} />
    )
    const row = container.querySelector("tbody tr") as HTMLElement

    expect(within(row).getByText(SOURCE_LABELS.live)).toBeTruthy()
    expect(within(row).queryByText(SOURCE_LABELS.mock)).toBe(null)
    expect(within(row).queryByText(STOPPED_EARLY_LABEL)).toBe(null)
  })

  it("renders every stored outcome with its label, outcome, code, and message", () => {
    const { row } = renderRow()
    const entries = row.querySelectorAll("li")

    expect(entries.length).toBe(stored.outcomes.length)

    stored.outcomes.forEach((expected, index) => {
      const entry = entries[index] as HTMLElement

      expect(within(entry).getByText(expected.memberLabel)).toBeTruthy()
      // The outcome value as text, so no row conveys it by colour alone.
      expect(within(entry).getByText(expected.outcome)).toBeTruthy()

      if (expected.responseCode.length > 0) {
        expect(within(entry).getByText(expected.responseCode)).toBeTruthy()
      }
      if (expected.responseMessage.length > 0) {
        expect(within(entry).getByText(expected.responseMessage)).toBeTruthy()
      }
    })
  })

  it("renders the outcomes in the stored order", () => {
    const { row } = renderRow()
    const labels = Array.from(row.querySelectorAll("li")).map(
      (entry) => entry.querySelector("span")?.textContent
    )

    expect(labels).toEqual(["Ada", "Grace", "Linus"])
  })
})

describe("HistoryTable literal message rendering (Requirement 6.2)", () => {
  it("renders the documented (H306) message as characters, creating no line break", () => {
    const message = "Invalid coupon code.<br/>Please check again."
    const { container } = render(
      <HistoryTable
        records={[
          record({
            outcomes: [
              outcome({
                outcome: "INVALID_COUPON",
                responseCode: "(H306)",
                responseMessage: message,
              }),
            ],
          }),
        ]}
      />
    )

    expect(screen.getByText(message)).toBeTruthy()
    expect(container.querySelector("br")).toBe(null)
  })

  it("renders hostile markup as characters, creating no element", () => {
    const message =
      '<script>alert("xss")</script><img src=x onerror=alert(1)> Contact support.'
    const { container } = render(
      <HistoryTable
        records={[
          record({
            outcomes: [
              outcome({
                outcome: "UPSTREAM_ERROR",
                responseCode: "(H999)",
                responseMessage: message,
              }),
            ],
          }),
        ]}
      />
    )

    expect(screen.getByText(message)).toBeTruthy()
    expect(container.querySelector("script")).toBe(null)
    expect(container.querySelector("img")).toBe(null)
  })
})

describe("HistoryTable accessibility", () => {
  it("names the table by its caption, which states the row order", () => {
    render(<HistoryTable records={[record()]} />)

    expect(
      screen.getByRole("table", { name: HISTORY_TABLE_CAPTION })
    ).toBeTruthy()
  })

  it("exposes every outcome value as text", () => {
    render(
      <HistoryTable
        records={[
          record({
            outcomes: [
              outcome({ hiveId: "h1", memberLabel: "Ada", outcome: "SUCCESS" }),
              outcome({
                hiveId: "h2",
                memberLabel: "Grace",
                outcome: "TRANSPORT_ERROR",
                responseCode: "",
                responseMessage: "network failure",
              }),
              outcome({
                hiveId: "h3",
                memberLabel: "Linus",
                outcome: "SKIPPED",
                responseCode: "",
                responseMessage: "",
              }),
            ],
          }),
        ]}
      />
    )

    expect(screen.getByText("SUCCESS")).toBeTruthy()
    expect(screen.getByText("TRANSPORT_ERROR")).toBeTruthy()
    expect(screen.getByText("SKIPPED")).toBeTruthy()
  })
})
