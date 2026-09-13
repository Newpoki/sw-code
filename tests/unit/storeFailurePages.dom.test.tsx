/**
 * Unit tests for the three-state rendering of the data pages
 * (Requirements 2.14, 3.10).
 *
 * A store read is a round trip to a deployment that may not answer, so every data
 * page now has three states to tell apart, not two:
 *
 *   1. a read that returned rows       → the table
 *   2. a read that returned zero rows  → the empty-state sentence
 *   3. a read that did not complete    → the store's own fixed sentence
 *
 * State 3 is the new one, and the failure mode these tests exist to prevent is
 * conflating it with state 2: a read that failed learned nothing about the
 * collection, so "the roster is empty" and "no redemption run has been recorded"
 * are claims it is not entitled to make. Requirements 2.14 and 3.10 ask for the
 * store's sentence *in place of* the table, which means in place of the empty
 * state too.
 *
 * The subjects are the prop-driven halves of the three route modules —
 * `RedemptionPage` from `src/routes/index.tsx`, `RosterPage` from
 * `src/routes/roster.tsx`, `HistoryPage` from `src/routes/history.tsx` — so the
 * wiring under test is the route's own choice of which message goes where, not
 * just the components' ability to render one. No router and no live server: the
 * loaders are represented by the loader data they produce, and the mutations are
 * stubs that are never called here.
 *
 * Every sentence is imported from the module that owns it — the store's failure
 * sentences from `src/domain/storeMessages.ts`, the empty-state sentences from the
 * two table components — so a test asserts the exact text the application renders
 * rather than a paraphrase that could drift.
 *
 * `jest-dom` is not installed, so assertions are plain DOM reads: `textContent`,
 * `data-slot` lookups, and `queryBy* === null`.
 */

import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"

import { EMPTY_HISTORY_MESSAGE } from "@/components/HistoryTable"
import { EMPTY_ROSTER_MESSAGE } from "@/components/RosterTable"
import {
  HISTORY_UNAVAILABLE_TITLE,
  ROSTER_UNAVAILABLE_TITLE,
} from "@/components/StoreFailureNotice"
import {
  historyReadFailedMessage,
  notConfiguredMessage,
  rosterReadFailedMessage,
  unreachableMessage,
} from "@/domain/storeMessages"
import { HistoryPage } from "@/routes/history"
import { ROSTER_UNREAD_DESCRIPTION, RedemptionPage } from "@/routes/index"
import { RosterPage } from "@/routes/roster"
import type {
  MemberRegistryEntry,
  RedemptionHistoryRecord,
} from "@/domain/types"

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The three sentences a failed read can carry, each from the module that owns it:
 * the collection-specific one, and the two that describe a deployment that served
 * nothing at all. All three must reach the page verbatim.
 */
const ROSTER_FAILURE_MESSAGES = [
  rosterReadFailedMessage(),
  notConfiguredMessage(),
  unreachableMessage(),
] as const

const HISTORY_FAILURE_MESSAGES = [
  historyReadFailedMessage(),
  notConfiguredMessage(),
  unreachableMessage(),
] as const

const ENTRY: MemberRegistryEntry = {
  id: "m1",
  memberLabel: "Ada",
  hiveId: "1001",
  enabled: true,
  createdAt: "2024-01-01T00:00:00.000Z",
}

const RECORD: RedemptionHistoryRecord = {
  runId: "run-1",
  seq: 1,
  couponCode: "SPRING2024",
  completedAt: "2024-05-02T10:00:00.000Z",
  mock: false,
  stoppedEarly: false,
  outcomes: [
    {
      hiveId: "1001",
      memberLabel: "Ada",
      outcome: "SUCCESS",
      responseCode: "100",
      responseMessage: "The coupon gift has been sent.",
    },
  ],
}

/** The notice a failed read renders, or null when none is on screen. */
function readFailureNotice(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-slot="store-read-failure"]')
}

/** The mutations of the roster page. Never called by these tests. */
function rosterStubs() {
  return {
    submitMember: vi.fn(),
    submitEnabled: vi.fn(),
    submitRemoval: vi.fn(),
    revalidate: vi.fn(async () => {}),
  }
}

/* -------------------------------------------------------------------------- */
/* /roster (Requirement 2.14)                                                 */
/* -------------------------------------------------------------------------- */

describe("RosterPage read states (Requirement 2.14)", () => {
  for (const message of ROSTER_FAILURE_MESSAGES) {
    it(`states that the read failed, and not that the roster is empty: "${message}"`, () => {
      const { container } = render(
        <RosterPage entries={[]} loadError={message} {...rosterStubs()} />
      )

      const notice = readFailureNotice(container)
      expect(notice).not.toBe(null)
      expect(notice?.textContent).toContain(ROSTER_UNAVAILABLE_TITLE)
      /* The store's sentence, character for character. */
      expect(notice?.textContent).toContain(message)

      /* The point of the requirement: the empty-roster copy is *not* what a
       * failed read looks like, and there is no table either. */
      expect(screen.queryByText(EMPTY_ROSTER_MESSAGE)).toBe(null)
      expect(container.querySelector("table")).toBe(null)
    })
  }

  it("keeps the empty-roster message for a successful read of zero entries", () => {
    const { container } = render(
      <RosterPage entries={[]} loadError={null} {...rosterStubs()} />
    )

    expect(screen.getByText(EMPTY_ROSTER_MESSAGE)).toBeTruthy()
    expect(readFailureNotice(container)).toBe(null)
    for (const message of ROSTER_FAILURE_MESSAGES) {
      expect(screen.queryByText(message)).toBe(null)
    }
  })

  it("renders the table for a successful read of one entry, and neither message", () => {
    const { container } = render(
      <RosterPage entries={[ENTRY]} loadError={null} {...rosterStubs()} />
    )

    expect(container.querySelector("table")).not.toBe(null)
    expect(screen.queryByText(EMPTY_ROSTER_MESSAGE)).toBe(null)
    expect(readFailureNotice(container)).toBe(null)
  })
})

/* -------------------------------------------------------------------------- */
/* /history (Requirement 3.10)                                                */
/* -------------------------------------------------------------------------- */

describe("HistoryPage read states (Requirement 3.10)", () => {
  for (const message of HISTORY_FAILURE_MESSAGES) {
    it(`states that the read failed, and not that nothing was recorded: "${message}"`, () => {
      const { container } = render(
        <HistoryPage records={[]} loadError={message} />
      )

      const notice = readFailureNotice(container)
      expect(notice).not.toBe(null)
      expect(notice?.textContent).toContain(HISTORY_UNAVAILABLE_TITLE)
      expect(notice?.textContent).toContain(message)

      expect(screen.queryByText(EMPTY_HISTORY_MESSAGE)).toBe(null)
      expect(container.querySelector("table")).toBe(null)
    })
  }

  it("keeps the empty-history message for a successful read of zero records", () => {
    const { container } = render(<HistoryPage records={[]} loadError={null} />)

    expect(screen.getByText(EMPTY_HISTORY_MESSAGE)).toBeTruthy()
    expect(readFailureNotice(container)).toBe(null)
    for (const message of HISTORY_FAILURE_MESSAGES) {
      expect(screen.queryByText(message)).toBe(null)
    }
  })

  it("renders the table for a successful read of one record, and neither message", () => {
    const { container } = render(
      <HistoryPage records={[RECORD]} loadError={null} />
    )

    expect(container.querySelector("table")).not.toBe(null)
    expect(screen.queryByText(EMPTY_HISTORY_MESSAGE)).toBe(null)
    expect(readFailureNotice(container)).toBe(null)
  })
})

/* -------------------------------------------------------------------------- */
/* / (Requirement 2.14)                                                       */
/* -------------------------------------------------------------------------- */

describe("RedemptionPage roster read states (Requirement 2.14)", () => {
  function renderPage(loadError: string | null, entries = [] as const) {
    return render(
      <RedemptionPage
        entries={entries}
        mockMode={false}
        loadError={loadError}
        startRun={vi.fn()}
        readActiveRun={vi.fn(async () => ({
          ok: true as const,
          data: null,
          warnings: [],
        }))}
        findPreviousRun={vi.fn()}
      />
    )
  }

  for (const message of ROSTER_FAILURE_MESSAGES) {
    it(`states that the roster read failed rather than that no member is enabled: "${message}"`, () => {
      const { container } = renderPage(message)

      const notice = readFailureNotice(container)
      expect(notice).not.toBe(null)
      expect(notice?.textContent).toContain(ROSTER_UNAVAILABLE_TITLE)
      expect(notice?.textContent).toContain(message)

      /* Zero entries reached this page, but nothing here knows the roster holds
       * no enabled member — the read never said so. */
      expect(screen.getByText(ROSTER_UNREAD_DESCRIPTION)).toBeTruthy()
    })
  }

  it("states the empty-roster description for a successful read of zero entries", () => {
    const { container } = renderPage(null)

    expect(readFailureNotice(container)).toBe(null)
    expect(screen.queryByText(ROSTER_UNREAD_DESCRIPTION)).toBe(null)
  })
})
