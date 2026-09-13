// Feature: mongodb-google-auth-admin, Property 18: The Admin_Page account rows are the newest hundred, ordered and projected
//
// Validates: Requirements 8.2, 8.7, 8.8.
//
// *For any* set of mirrored User_Account documents — possibly more than a
// hundred, with sign-in instants that collide, with emails that differ only in
// letter case (so their folded `emailLower` collides), and with display names
// that are empty or whitespace only — `UserAccountStore.listForAdminPage()`
// returns at most {@link ADMIN_PAGE_MAX_ROWS} rows (Requirement 8.2 cap), and
// those rows are the ones with the newest `lastSignInAt`, ordered descending by
// `lastSignInAt` with the folded email ascending as the tiebreak (Requirement
// 8.2 order). An empty collection yields `{ ok: true, rows: [] }` (Requirement
// 8.7). Display names are stored and returned unchanged — the store never
// trims them, which is what lets the render layer decide to show the email in
// their place (Requirement 8.8 is a render concern; here the store passes them
// through).
//
// ## The ordering is the query's, not the test's
//
// The store applies `{ sort: { lastSignInAt: -1, emailLower: 1 }, limit: 100 }`
// in the Mongo query itself. The in-memory store honors a multi-key sort (dates
// compared by their instant, strings lexicographically), a `limit`, and the
// inclusion projection, so this drives the *real* `listForAdminPage()` against a
// store that behaves like MongoDB for exactly the operations it uses — no Clerk
// and no deployment are touched. The expected order is computed independently by
// sorting the generated documents by the same key and taking the first hundred,
// so the assertion is "the query ordered them the way the requirement states",
// not a restatement of the store's own call.

import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { toAdminAccountRow } from "@/domain/accounts"
import type { AdminAccountRow } from "@/domain/accounts"
import {
  ADMIN_PAGE_MAX_ROWS,
  createUserAccountStore,
} from "@/server/store/userAccounts.server"
import type { Identity } from "@/server/identity.server"
import { createInMemoryMongoStore } from "../support/inMemoryMongoStore"
import { adminAccountSetArb } from "./generators"
import type { AdminAccountSeed } from "./generators"

/* -------------------------------------------------------------------------- */
/* The injected Clerk seam                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A stub {@link Identity}. `listForAdminPage()` never touches Clerk — it reads
 * the mirror and projects it — so every method throws if it is somehow reached,
 * turning an accidental call into a loud failure rather than a silent pass.
 */
function stubIdentity(): Identity {
  return {
    configured: () => true,
    current: async () => {
      throw new Error("listForAdminPage() must not read the request identity")
    },
    profile: async () => {
      throw new Error("listForAdminPage() must not fetch a Clerk profile")
    },
  }
}

/* -------------------------------------------------------------------------- */
/* The expected rows, computed independently of the store                     */
/* -------------------------------------------------------------------------- */

/**
 * The rows the requirement says `listForAdminPage()` must return: the generated
 * documents sorted newest-sign-in-first with the folded email as the ascending
 * tiebreak, capped at the cap, then projected to an {@link AdminAccountRow}.
 *
 * `Array.prototype.sort` is stable, matching the driver's behavior for a tie the
 * sort key cannot separate, so two accounts that share both `lastSignInAt` and
 * `emailLower` keep their insertion order in both the expected list and the
 * store's output.
 */
function expectedRows(seeds: readonly AdminAccountSeed[]): AdminAccountRow[] {
  return [...seeds]
    .sort((left, right) => {
      const byInstant =
        right.lastSignInAt.getTime() - left.lastSignInAt.getTime()
      if (byInstant !== 0) {
        return byInstant
      }
      if (left.emailLower < right.emailLower) return -1
      if (left.emailLower > right.emailLower) return 1
      return 0
    })
    .slice(0, ADMIN_PAGE_MAX_ROWS)
    .map((seed) =>
      toAdminAccountRow({
        clerkUserId: "",
        email: seed.email,
        displayName: seed.displayName,
        role: seed.role,
        lastSignInAt: seed.lastSignInAt.toISOString(),
      })
    )
}

/* -------------------------------------------------------------------------- */
/* The property                                                               */
/* -------------------------------------------------------------------------- */

describe("Property 18: the Admin_Page account rows are the newest hundred, ordered and projected", () => {
  it("returns at most 100 rows, the newest by sign-in, tie-broken by folded email, projected unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(adminAccountSetArb, async (seeds) => {
        const handle = createInMemoryMongoStore({
          seed: { user_accounts: seeds },
        })
        const store = createUserAccountStore(handle.store, {
          identity: stubIdentity(),
        })

        const read = await store.listForAdminPage()

        // A well-formed collection is always readable here (no fault injected).
        expect(read.ok).toBe(true)
        if (!read.ok) return

        // Requirement 8.2: the cap holds, and never exceeds what was stored.
        expect(read.rows.length).toBeLessThanOrEqual(ADMIN_PAGE_MAX_ROWS)
        expect(read.rows.length).toBe(
          Math.min(seeds.length, ADMIN_PAGE_MAX_ROWS)
        )

        // Requirement 8.2: the exact newest-hundred order, and Requirement 8.8:
        // display names pass through the store unchanged.
        expect(read.rows).toEqual(expectedRows(seeds))

        // Descending by sign-in, ascending folded email on a tie — asserted
        // directly on the returned rows, independently of the expected list.
        for (let i = 1; i < read.rows.length; i += 1) {
          const previous = Date.parse(read.rows[i - 1].lastSignInAt)
          const current = Date.parse(read.rows[i].lastSignInAt)
          expect(previous).toBeGreaterThanOrEqual(current)
        }
      }),
      { numRuns: 200 }
    )
  })

  it("returns zero rows with ok:true for an empty set (Requirement 8.7)", async () => {
    const handle = createInMemoryMongoStore({ seed: { user_accounts: [] } })
    const store = createUserAccountStore(handle.store, {
      identity: stubIdentity(),
    })

    const read = await store.listForAdminPage()

    expect(read).toEqual({ ok: true, rows: [] })
  })
})
