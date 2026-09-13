/**
 * Property 20 of mongodb-google-auth-admin: the Admin_Page is a partial page.
 *
 * Each of its three reads — the Member_Registry count, the Redemption_History
 * count, and the account list — answers on its own, so the page must render
 * every value a read supplied *beside* the sentence of one that did not. This
 * file exercises the whole subset lattice: an `AdminOverview` arbitrary makes
 * each of the three reads independently `ok` or failed, so all-ok, all-failed,
 * and every mix in between are generated, and asserts that:
 *
 *   - the signed-in email always reaches its slot (Requirement 8.1);
 *   - a count that answered shows its integer in that count's card, and a count
 *     that did not shows {@link mongoUnavailableCountMessage} in that same card
 *     (Requirement 8.5) — while the *sibling* count and the connection indicator
 *     are still on the page, which is the partial-page guarantee itself
 *     (Requirement 8.6);
 *   - the Mock_Mode word is exactly `enabled` or `disabled`, matching the flag;
 *   - the connection indicator is exactly one of its two sentences, present
 *     whether or not any read failed (Requirement 8.6);
 *   - the account region is the table (a successful read of rows), the empty
 *     sentence (a successful read of zero rows), or the read's own sentence (a
 *     failed read), and never two of the three at once.
 *
 * `AdminPage` is presentational — the overview arrives as a prop — so each
 * sample is a plain `render` with no router and no live server, the same seam
 * `tests/unit/adminPage.dom.test.tsx` uses. Globals are off, so this file tears
 * each sample's DOM down in a `finally` rather than leaning on the `afterEach`
 * cleanup, which would otherwise leave 100 detached pages mounted for the whole
 * assertion (see `tests/property/resultRendering.property.test.tsx`).
 *
 * Every sentence is imported from the module that owns it — the failed-read
 * sentence from `src/domain/storeMessages.ts`, and the Mock_Mode, connection,
 * and empty-accounts copy from `src/routes/admin.tsx` — so a sample asserts the
 * exact text the application renders rather than a paraphrase that could drift.
 *
 * `jest-dom` is not installed, so the assertions are plain DOM reads:
 * `textContent`, `data-slot` lookups, `queryByRole`, and `within`.
 *
 * Validates: Requirements 8.1, 8.5, 8.6
 */

import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { cleanup, render, within } from "@testing-library/react"

import { mongoUnavailableCountMessage } from "@/domain/storeMessages"
import {
  AdminPage,
  CONNECTION_INDICATOR_STATES,
  MOCK_MODE_STATES,
  NO_ACCOUNTS_MESSAGE,
} from "@/routes/admin"
import type {
  AccountRole,
  AccountsRead,
  AdminAccountRow,
  AdminOverview,
  CountRead,
} from "@/domain/accounts"

/* -------------------------------------------------------------------------- */
/* Arbitraries                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The two Requirement 8.5 count bounds: the roster count is an integer 0..100
 * (Requirement 1.11's cap) and the retained-record count an integer 0..200
 * (the Redemption_History retention window). Property 20 states each read's
 * value is displayed within these ranges whenever the read answered.
 */
const MEMBER_COUNT_MAX = 100
const HISTORY_COUNT_MAX = 200

/** A signed-in email address (Requirement 8.1); never empty. */
const emailArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim() !== ""),
    fc.constantFrom("example.com", "hive.test", "mail.co.uk")
  )
  .map(([local, domain]) => `${local.trim()}@${domain}`)

/**
 * A count read: either the integer it supplied (within its bound), or the
 * failure carrying {@link mongoUnavailableCountMessage} — the fixed sentence a
 * failed count always carries into this page. Both branches are weighted so the
 * subset lattice reaches all-ok, all-failed, and every mix.
 */
function countReadArb(maxValue: number): fc.Arbitrary<CountRead> {
  return fc.oneof(
    {
      weight: 3,
      arbitrary: fc
        .integer({ min: 0, max: maxValue })
        .map((value): CountRead => ({ ok: true, value })),
    },
    {
      weight: 2,
      arbitrary: fc.constant<CountRead>({
        ok: false,
        message: mongoUnavailableCountMessage(),
      }),
    }
  )
}

/** An Account_Role, exactly `admin` or `member` (Requirement 8.2). */
const roleArb: fc.Arbitrary<AccountRole> = fc.constantFrom("admin", "member")

/**
 * A display name reaching the three cases Requirement 8.8 separates: a normal
 * name, one that trims to empty (whitespace only), and the empty string. The
 * page shows the email in the name position for the last two.
 */
const displayNameArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: fc.string({ minLength: 1, maxLength: 24 }) },
  { weight: 1, arbitrary: fc.constant("") },
  {
    weight: 1,
    arbitrary: fc
      .array(fc.constantFrom(" ", "\t", "\n"), { minLength: 1, maxLength: 4 })
      .map((units) => units.join("")),
  }
)

/** One account row; the email is a unique key, so rows are made unique on it. */
function accountRowArb(): fc.Arbitrary<AdminAccountRow> {
  return fc.record({
    email: emailArb,
    displayName: displayNameArb,
    role: roleArb,
    lastSignInAt: fc.constant("2024-01-01T00:00:00.000Z"),
  })
}

/**
 * The account read: a successful read of 0..N rows (0 rows is the empty state),
 * or a failed read carrying the store's sentence. Rows are unique on email,
 * because the page keys them by it.
 */
const accountsReadArb: fc.Arbitrary<AccountsRead> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc
      .uniqueArray(accountRowArb(), {
        maxLength: 6,
        selector: (row) => row.email,
      })
      .map((rows): AccountsRead => ({ ok: true, rows })),
  },
  {
    weight: 2,
    arbitrary: fc.constant<AccountsRead>({
      ok: false,
      message: mongoUnavailableCountMessage(),
    }),
  }
)

/**
 * A whole Admin_Overview: an email, three independent reads (so the subset
 * lattice is covered), and arbitrary Mock_Mode and connection booleans.
 */
const adminOverviewArb: fc.Arbitrary<AdminOverview> = fc.record({
  email: emailArb,
  memberCount: countReadArb(MEMBER_COUNT_MAX),
  historyCount: countReadArb(HISTORY_COUNT_MAX),
  mockMode: fc.boolean(),
  connected: fc.boolean(),
  accounts: accountsReadArb,
})

/* -------------------------------------------------------------------------- */
/* Rendering harness                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Renders `<AdminPage overview={overview} />` and tears the DOM down again after
 * the assertions run, so a 100-sample assertion does not leave 100 detached
 * pages mounted.
 */
function withAdminPage(
  overview: AdminOverview,
  assertions: (container: HTMLElement) => void
): void {
  const { container } = render(<AdminPage overview={overview} />)
  try {
    assertions(container)
  } finally {
    cleanup()
  }
}

/** The element carrying a `data-slot`, or a thrown error naming the slot. */
function slot(container: HTMLElement, name: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-slot="${name}"]`)
  if (element === null) {
    throw new Error(`the Admin_Page rendered no [data-slot="${name}"]`)
  }
  return element
}

/**
 * What one count's card must display: the integer it supplied, or the fixed
 * unreachable sentence in that integer's position (Requirement 8.5).
 */
function expectedCountText(count: CountRead): string {
  return count.ok ? String(count.value) : mongoUnavailableCountMessage()
}

/* -------------------------------------------------------------------------- */
/* Property                                                                   */
/* -------------------------------------------------------------------------- */

describe("Admin_Page partial rendering", () => {
  // Feature: mongodb-google-auth-admin, Property 20: The Admin_Page displays every value a read supplied and a message for every one it did not
  it("shows every supplied value beside the sentence of every read that failed", () => {
    fc.assert(
      fc.property(adminOverviewArb, (overview) => {
        withAdminPage(overview, (container) => {
          /* Requirement 8.1: the signed-in email address, always. */
          expect(slot(container, "admin-email").textContent).toContain(
            overview.email
          )

          /* Requirement 8.5 for each count, and Requirement 8.6 across them:
           * each card shows its own value or sentence, and neither failure
           * removes the other card. Reading both from their own slots proves
           * the sibling survives a failed read. */
          const memberCard = slot(container, "member-count")
          const historyCard = slot(container, "history-count")

          expect(
            within(memberCard).getByText(
              expectedCountText(overview.memberCount)
            )
          ).toBeTruthy()
          expect(
            within(historyCard).getByText(
              expectedCountText(overview.historyCount)
            )
          ).toBeTruthy()

          /* A count that answered shows an integer inside its declared range;
           * the sentence never poses as a number. */
          if (overview.memberCount.ok) {
            expect(Number.isInteger(overview.memberCount.value)).toBe(true)
            expect(overview.memberCount.value).toBeGreaterThanOrEqual(0)
            expect(overview.memberCount.value).toBeLessThanOrEqual(
              MEMBER_COUNT_MAX
            )
          }
          if (overview.historyCount.ok) {
            expect(Number.isInteger(overview.historyCount.value)).toBe(true)
            expect(overview.historyCount.value).toBeGreaterThanOrEqual(0)
            expect(overview.historyCount.value).toBeLessThanOrEqual(
              HISTORY_COUNT_MAX
            )
          }

          /* Requirement 8.1: exactly one of the two Mock_Mode words, matching
           * the flag. */
          const expectedMockMode = overview.mockMode
            ? MOCK_MODE_STATES.enabled
            : MOCK_MODE_STATES.disabled
          expect(slot(container, "mock-mode").textContent).toContain(
            expectedMockMode
          )
          expect(slot(container, "mock-mode").textContent).not.toContain(
            overview.mockMode
              ? MOCK_MODE_STATES.disabled
              : MOCK_MODE_STATES.enabled
          )

          /* Requirement 8.6: the connection indicator is exactly one of its
           * two sentences, present whether or not any read failed. */
          const expectedConnection = overview.connected
            ? CONNECTION_INDICATOR_STATES.connected
            : CONNECTION_INDICATOR_STATES.disconnected
          expect(slot(container, "connection-indicator").textContent).toBe(
            expectedConnection
          )

          /* The account region is exactly one of its three states. The region
           * is the direct-child paragraph of `<main>` — the table, the empty
           * sentence, or the failure sentence — so it is read from there rather
           * than by text: a failed accounts read carries the very sentence a
           * failed count carries, and a page-wide text query would match all
           * three at once. */
          const table = within(container).queryByRole("table")
          const accountsRegion = container.querySelector<HTMLElement>(
            "main > p[role='status']"
          )
          if (!overview.accounts.ok) {
            /* Requirement 8.5: the read's own sentence in place of the table,
             * and not the empty-state claim it never earned. */
            expect(accountsRegion?.textContent).toBe(overview.accounts.message)
            expect(table).toBe(null)
            expect(within(container).queryByText(NO_ACCOUNTS_MESSAGE)).toBe(
              null
            )
          } else if (overview.accounts.rows.length === 0) {
            /* Requirement 8.7: a claim only a successful read of zero rows may
             * make; no table. */
            expect(
              within(container).getByText(NO_ACCOUNTS_MESSAGE)
            ).toBeTruthy()
            expect(table).toBe(null)
          } else {
            /* A row per account, each showing its email; the name cell shows
             * the display name unless it trims empty, in which case the email
             * stands in (Requirement 8.8). */
            expect(table).not.toBe(null)
            const nameCells = Array.from(
              container.querySelectorAll("tbody tr th")
            ).map((cell) => cell.textContent)
            const emailCells = Array.from(
              container.querySelectorAll("tbody tr td:first-of-type")
            ).map((cell) => cell.textContent)

            expect(nameCells).toEqual(
              overview.accounts.rows.map((row) =>
                row.displayName.trim().length === 0
                  ? row.email
                  : row.displayName
              )
            )
            expect(emailCells).toEqual(
              overview.accounts.rows.map((row) => row.email)
            )
          }
        })
      }),
      { numRuns: 100 }
    )
  })
})
