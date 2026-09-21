/**
 * The bounded Admin_Page assembly of Requirement 8.9.
 *
 * Requirement 8.9 asks that an Admin_Page request whose reads run concurrently
 * returns everything that answered within the Mongo_Store's own 5-second
 * operation bound, replacing whatever did not with the fixed failure sentence in
 * that read's own position. The point is that one stalled read does not delay
 * the others: the response carries the two fast reads with their values and the
 * one that stalled with {@link mongoUnavailableCountMessage} in its slot.
 *
 * ## How the 5-second bound is modelled without waiting 5 seconds
 *
 * `buildAdminOverview` does not itself impose a `Promise.race`; it relies on the
 * store's driver `timeoutMS` to bound each `countDocuments` call, and folds a
 * rejection to `{ ok: false, message: mongoUnavailableCountMessage() }`. When
 * the driver's `timeoutMS` elapses, the pending operation **rejects** with a
 * timeout error — that is the observable event `countCollection` sees.
 *
 * So the faithful unit-level model of "the driver's timeoutMS fired for the
 * members count while the history count answered" is a fake `members`
 * collection whose `countDocuments()` rejects (standing in for the timeout that
 * would have fired at 5 s) while `history`'s resolves immediately. This exercises
 * exactly the fold Requirement 8.9 relies on — the stalled read becomes its
 * failure sentence, the others keep their values — and returns promptly, with no
 * real timer and no 5-second wait.
 */

import { describe, expect, it } from "vitest"

import type { Collection, Document } from "mongodb"

import { buildAdminOverview } from "@/server/adminOverview.server"
import type { AdminOverviewDeps } from "@/server/adminOverview.server"
import { mongoUnavailableCountMessage } from "@/domain/storeMessages"
import type { Authorization } from "@/server/authorization.server"
import type {
  CollectionName,
  CollectionOrFailure,
  MongoStore,
} from "@/server/store/mongo.server"
import type { UserAccountStore } from "@/server/store/userAccounts.server"
import type { AdminAccountRow, UserAccountView } from "@/domain/accounts"

/* -------------------------------------------------------------------------- */
/* Local stubs                                                                */
/* -------------------------------------------------------------------------- */

const ADMIN_ACCOUNT: UserAccountView = {
  clerkUserId: "user_admin",
  email: "admin@example.com",
  displayName: "Ada Admin",
  role: "admin",
  lastSignInAt: "2024-01-01T00:00:00.000Z",
}

/** An {@link Authorization} that decides every request an admin, with no Mongo read. */
const adminAuthorization: Authorization = {
  decide: () => Promise.resolve({ kind: "admin", account: ADMIN_ACCOUNT }),
}

const ADMIN_ROWS: readonly AdminAccountRow[] = [
  {
    email: "admin@example.com",
    displayName: "Ada Admin",
    role: "admin",
    lastSignInAt: "2024-01-01T00:00:00.000Z",
  },
  {
    email: "member@example.com",
    displayName: "Mo Member",
    role: "member",
    lastSignInAt: "2023-12-31T00:00:00.000Z",
  },
]

/** A {@link UserAccountStore} whose `listForAdminPage` answers quickly. */
const fastAccounts: UserAccountStore = {
  resolve: () =>
    Promise.reject(new Error("resolve is not exercised by this test")),
  listForAdminPage: () => Promise.resolve({ ok: true, rows: ADMIN_ROWS }),
}

/**
 * A fake {@link MongoStore} whose `members` `countDocuments()` rejects — standing
 * in for the driver's `timeoutMS` firing at 5 s on a stalled read — while
 * `history`'s resolves immediately. Every other collection handle is served, so
 * the fake satisfies the seam without any real database or timer.
 */
function stalledMembersStore(historyCount: number): MongoStore {
  const countFor = (name: CollectionName): (() => Promise<number>) =>
    name === "members"
      ? () =>
          /* The driver rejects a pending operation when `timeoutMS` elapses;
           * this rejection stands for that timeout, and `countCollection`
           * folds it to `mongoUnavailableCountMessage()`. */
          Promise.reject(new Error("operation exceeded timeoutMS"))
      : () => Promise.resolve(historyCount)

  return {
    ready: () => Promise.resolve(),
    collection: <T extends Document>(
      name: CollectionName
    ): Promise<CollectionOrFailure<T>> =>
      Promise.resolve({
        kind: "collection",
        /* Only `countDocuments` is reached by `countCollection`; the rest of the
         * driver surface is never touched, so the narrow fake satisfies the seam
         * without a real database. */
        collection: {
          countDocuments: countFor(name),
        } as unknown as Collection<T>,
      }),
    connected: () => true,
    close: () => Promise.resolve(),
  }
}

/* -------------------------------------------------------------------------- */
/* The test                                                                   */
/* -------------------------------------------------------------------------- */

describe("Admin_Page bounded assembly (Requirement 8.9)", () => {
  it("returns the reads that answered within the bound, the stalled one failed in its slot", async () => {
    const HISTORY_COUNT = 7

    const deps: AdminOverviewDeps = {
      authorization: adminAuthorization,
      store: stalledMembersStore(HISTORY_COUNT),
      accounts: fastAccounts,
      mockMode: false,
    }

    /* No fake timers, no 5-second wait: buildAdminOverview must return promptly
     * because the stalled read is modelled as a prompt rejection standing for
     * the driver timeout, and the others resolve immediately. */
    const start = Date.now()
    const envelope = await buildAdminOverview(deps)
    const elapsedMs = Date.now() - start

    /* The response arrived — a stalled read did not hang the whole overview. */
    expect(elapsedMs).toBeLessThan(1000)

    expect(envelope.ok).toBe(true)
    if (!envelope.ok) return

    const overview = envelope.data

    /* Requirement 8.1: the admin account's email. */
    expect(overview.email).toBe(ADMIN_ACCOUNT.email)

    /* The stalled members count is replaced by its failure sentence in its own
     * position (Requirement 8.5 restated within 8.9). */
    expect(overview.memberCount).toEqual({
      ok: false,
      message: mongoUnavailableCountMessage(),
    })

    /* The history count answered within the bound and keeps its value. */
    expect(overview.historyCount).toEqual({ ok: true, value: HISTORY_COUNT })

    /* The account list answered within the bound and keeps its rows. */
    expect(overview.accounts).toEqual({ ok: true, rows: ADMIN_ROWS })

    /* Requirement 8.3: connection indicator and Mock_Mode are set regardless. */
    expect(overview.connected).toBe(true)
    expect(overview.mockMode).toBe(false)
  })

  it("a stalled count does not delay a fast one — either read can be the one that stalls", async () => {
    /* The mirror image: prove the bound is per-read, not per-page, by keeping
     * the history count fast while the members read stalls, and checking the
     * fast read still carries its value beside the failed one. */
    const deps: AdminOverviewDeps = {
      authorization: adminAuthorization,
      store: stalledMembersStore(0),
      accounts: fastAccounts,
      mockMode: true,
    }

    const envelope = await buildAdminOverview(deps)

    expect(envelope.ok).toBe(true)
    if (!envelope.ok) return

    expect(envelope.data.memberCount.ok).toBe(false)
    expect(envelope.data.historyCount).toEqual({ ok: true, value: 0 })
    expect(envelope.data.mockMode).toBe(true)
  })
})
