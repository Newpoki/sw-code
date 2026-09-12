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
import { fireEvent, render, screen, within } from "@testing-library/react"

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

  it("summarises the outcomes as one badge per group, not one per Group_Member", () => {
    const { row } = renderRow()
    const badges = row.querySelectorAll("[data-summary]")

    /*
     * `stored` holds one SUCCESS, one ALREADY_USED, and one SKIPPED. The latter
     * two share the warning group, so three Group_Members summarise to two
     * badges — which is the whole point of the change.
     */
    expect(
      Array.from(badges).map((badge) => [
        badge.getAttribute("data-summary"),
        badge.textContent,
      ])
    ).toEqual([
      ["default", "1 succeeded"],
      ["warning", "2 already used or skipped"],
    ])
  })

  it("omits a group with no members rather than rendering a zero", () => {
    const { row } = renderRow()

    // No outcome of `stored` is a failure, so no destructive badge appears.
    expect(row.querySelector('[data-summary="destructive"]')).toBe(null)
  })

  it("shows the count visibly and names what was counted for assistive tech", () => {
    const { row } = renderRow()
    const badge = row.querySelector('[data-summary="default"]') as HTMLElement

    /*
     * The digit is the visible part; the noun is `sr-only`, so the cell stays
     * glanceable without leaving colour as the only carrier of what it counts.
     */
    const srOnly = badge.querySelector(".sr-only")
    expect(srOnly?.textContent.trim()).toBe("succeeded")
    expect(badge.textContent).toContain("1")
  })

  it("keeps the response code and message out of the cell", () => {
    const { row } = renderRow()

    for (const expected of stored.outcomes) {
      if (expected.responseMessage.length > 0) {
        expect(within(row).queryByText(expected.responseMessage)).toBe(null)
      }
    }
  })

  it("keeps the per-member breakdown out of the cell", () => {
    const { row } = renderRow()

    // The Member_Labels live in the drawer now, not in the column.
    for (const expected of stored.outcomes) {
      expect(within(row).queryByText(expected.memberLabel)).toBe(null)
    }
  })

  it("names the trigger by the run it opens, not by a bare 'View details'", () => {
    const { row } = renderRow()
    const trigger = within(row).getByRole("button")

    const name = trigger.textContent
    expect(name).toContain(stored.couponCode)
    // The counts are part of the name, so the action is not just "View details".
    expect(name).toContain("succeeded")
  })
})

/**
 * Opens the detail drawer of the first row and returns the drawer element.
 *
 * The drawer renders into a portal on `document.body`, not inside the render
 * container, so everything about it is queried from `screen`.
 */
function openDetails(): HTMLElement {
  fireEvent.click(screen.getAllByRole("button")[0])
  return screen.getByRole("dialog")
}

describe("HistoryTable outcome details drawer", () => {
  const stored = record({
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
        outcome: "TRANSPORT_ERROR",
        responseCode: "",
        responseMessage: "response body is not valid JSON",
      }),
    ],
  })

  it("stays closed until the summary is activated", () => {
    render(<HistoryTable records={[stored]} />)

    expect(screen.queryByRole("dialog")).toBe(null)
  })

  it("shows each Group_Member with its outcome badge and message", () => {
    render(<HistoryTable records={[stored]} />)
    const drawer = openDetails()

    for (const expected of stored.outcomes) {
      expect(within(drawer).getByText(expected.memberLabel)).toBeTruthy()
      // The outcome value, in a badge (Requirement 6.2 keeps it literal text).
      expect(within(drawer).getByText(expected.outcome)).toBeTruthy()
      if (expected.responseCode.length > 0) {
        expect(within(drawer).getByText(expected.responseCode)).toBeTruthy()
      }
      expect(within(drawer).getByText(expected.responseMessage)).toBeTruthy()
    }
  })

  it("gives each detail badge the same outcome mark as the summary", () => {
    render(<HistoryTable records={[stored]} />)
    const drawer = openDetails()

    /*
     * The variant is derived from `data-outcome` through one shared map, so
     * matching marks are what guarantee "the same colour in both views" without
     * this test having to know a class name.
     */
    expect(
      Array.from(drawer.querySelectorAll("[data-outcome]")).map((badge) =>
        badge.getAttribute("data-outcome")
      )
    ).toEqual(stored.outcomes.map((expected) => expected.outcome))
  })

  it("lists the members in the stored order", () => {
    render(<HistoryTable records={[stored]} />)
    const drawer = openDetails()

    expect(
      Array.from(drawer.querySelectorAll("li")).map(
        (entry) => entry.querySelector("span")?.textContent
      )
    ).toEqual(["Ada", "Grace"])
  })
})

/**
 * Requirement 6.2, in its current reading: no upstream markup reaches the reader
 * as markup, and none reaches them as visible text either.
 *
 * The second half is what changed. The message used to be displayed with its tags
 * spelled out, which is safe but shows `<br/>` to a reader; the tags are now
 * removed before display. The injection guarantee is untouched and is still
 * asserted here — a tag is deleted, never interpreted.
 */
describe("HistoryTable upstream message rendering (Requirement 6.2)", () => {
  function renderMessage(message: string, code = "(H306)"): HTMLElement {
    render(
      <HistoryTable
        records={[
          record({
            outcomes: [
              outcome({
                outcome: "INVALID_COUPON",
                responseCode: code,
                responseMessage: message,
              }),
            ],
          }),
        ]}
      />
    )
    return openDetails()
  }

  it("turns the documented (H306) line break into a real break, showing no tag", () => {
    const drawer = renderMessage("Invalid coupon code.<br/>Please check again.")

    /*
     * Read from `textContent` rather than through `getByText`, whose default
     * normalizer collapses the newline this assertion is about.
     */
    expect(drawer.textContent).toContain(
      "Invalid coupon code.\nPlease check again."
    )
    // Neither an element nor the tag as text.
    expect(drawer.querySelector("br")).toBe(null)
    expect(drawer.textContent).not.toContain("<br")
  })

  it("removes hostile markup, creating no element and showing no tag", () => {
    const drawer = renderMessage(
      '<script>alert("xss")</script><img src=x onerror=alert(1)> Contact support.',
      "(H999)"
    )

    expect(drawer.querySelector("script")).toBe(null)
    expect(drawer.querySelector("img")).toBe(null)
    expect(drawer.textContent).not.toContain("<script")
    expect(drawer.textContent).not.toContain("<img")
    /*
     * The tag is gone; the text it wrapped survives as inert characters, which is
     * more useful to a reader than deleting the sentence with it.
     */
    expect(within(drawer).getByText(/Contact support\./)).toBeTruthy()
  })

  it("shows the placeholder for a message that was nothing but a tag", () => {
    const drawer = renderMessage("<br/>")

    /* Emptiness is decided after stripping, so this is a dash rather than a blank
     * line where a reader expects a value. */
    expect(within(drawer).getAllByText("—").length).toBeGreaterThan(0)
  })
})

describe("HistoryTable accessibility", () => {
  it("names the table by its caption, which states the row order", () => {
    render(<HistoryTable records={[record()]} />)

    expect(
      screen.getByRole("table", { name: HISTORY_TABLE_CAPTION })
    ).toBeTruthy()
  })

  it("exposes every outcome value as text in the details drawer", () => {
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
    /*
     * The summary column counts rather than naming outcomes, so the guarantee
     * that no outcome is conveyed by colour alone now lives in the drawer, where
     * each value is a text badge.
     */
    const drawer = openDetails()

    expect(within(drawer).getByText("SUCCESS")).toBeTruthy()
    expect(within(drawer).getByText("TRANSPORT_ERROR")).toBeTruthy()
    expect(within(drawer).getByText("SKIPPED")).toBeTruthy()
  })
})
