// Feature: mongodb-google-auth-admin, Property 19: The Admin_Page response holds no Hive_ID and no identity key
//
// Validates: Requirements 8.4.
//
// *For any* set of seeded User_Account documents — each carrying a distinctive
// sentinel `clerkUserId` (the identity key that takes the Google_Subject's
// place, Requirement 5.4 restated) — together with seeded Member_Registry and
// Redemption_History documents carrying sentinel `hiveId` values, the SERIALIZED
// Admin_Page response holds none of those sentinel values and no object key
// named `clerkUserId` or `hiveId` anywhere. The Member_Registry reaches the
// Admin_Page only as a count (Requirement 8.4), never as a Hive_ID list, and the
// identity key is projected away by `listForAdminPage`; neither may reappear in
// what a client receives.
//
// ## Why assert over the serialized form
//
// The point of the property is that a field added to the response later cannot
// leak silently. Asserting over `JSON.stringify(...)` — of the full
// `buildAdminOverview` envelope and, separately, of `listForAdminPage()` —
// catches a leak wherever in the structure it surfaces: a new nested field, a
// mapping that forgets to drop the key, a projection that regresses. A
// structural assertion over today's known shape would not.
//
// ## The response is the real one
//
// The overview is produced by the real `buildAdminOverview`, over the real
// `createUserAccountStore` reading a real (in-memory) `user_accounts` collection
// through its real projection, with an authorization stub that returns an
// `admin` decision so the overview is *produced* rather than *rejected*. No
// Clerk and no MongoDB deployment are touched: the store is the in-memory fake
// and the identity seam is a stub that `listForAdminPage` never reaches.

import fc from "fast-check"
import { describe, expect, it } from "vitest"

import type { AccountRole, AdminOverview } from "@/domain/accounts"
import { buildAdminOverview } from "@/functions/admin.functions"
import type { Authorization } from "@/server/authorization.server"
import type { Identity } from "@/server/identity.server"
import type {
  HistoryDocumentInput,
  MemberDocumentInput,
  UserAccountDocument,
} from "@/server/store/documents.server"
import { createUserAccountStore } from "@/server/store/userAccounts.server"

import { createInMemoryMongoStore } from "../support/inMemoryMongoStore"

/* -------------------------------------------------------------------------- */
/* Sentinels                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A long, distinctive prefix for the identity-key value seeded into every
 * `clerkUserId`. It is unlikely to occur incidentally, and it survives
 * `JSON.stringify` unchanged, so finding it inside the serialized response is a
 * genuine leak signal rather than an accidental substring of some fixed prose.
 *
 * Defined locally on purpose: this wave must not edit `tests/property/generators.ts`,
 * which a concurrent task owns. This mirrors the rare-marker reasoning behind
 * that file's `HIVE_ID_SENTINEL` without depending on it.
 */
const CLERK_ID_SENTINEL = "user_LEAKSENTINEL_CLERK_9f3c1a"

/** The same idea for the Hive_ID value that must never reach the Admin_Page. */
const HIVE_ID_SENTINEL = "hive_LEAKSENTINEL_HIVE_7b2e4d"

/**
 * Object keys that must never appear in the serialized Admin_Page response. A
 * field added later that reintroduces either would surface as one of these JSON
 * keys and fail the property.
 */
const FORBIDDEN_KEYS = ["clerkUserId", "hiveId"] as const

/* -------------------------------------------------------------------------- */
/* Arbitraries (defined locally)                                              */
/* -------------------------------------------------------------------------- */

/** An Account_Role. */
const roleArb: fc.Arbitrary<AccountRole> = fc.constantFrom("admin", "member")

/**
 * One seeded `user_accounts` document carrying a sentinel `clerkUserId`. The
 * index makes each identity key distinct while every one carries the sentinel,
 * so a leak of any single document is caught.
 */
const accountSeedArb = (
  index: number
): fc.Arbitrary<Omit<UserAccountDocument, "_id">> =>
  fc
    .record({
      email: fc.emailAddress(),
      displayName: fc.string({ maxLength: 60 }),
      role: roleArb,
      lastSignInMs: fc.integer({ min: 0, max: 4_102_444_800_000 }),
    })
    .map(({ email, displayName, role, lastSignInMs }) => {
      const at = new Date(lastSignInMs)
      return {
        clerkUserId: `${CLERK_ID_SENTINEL}_${index}`,
        email,
        emailLower: email.trim().toLowerCase(),
        displayName,
        role,
        lastSyncedAt: at,
        lastSessionId: `sess_${index}`,
        lastSignInAt: at,
      }
    })

/** A set of 0..8 seeded accounts, each with its own sentinel identity key. */
const accountsSeedArb: fc.Arbitrary<Omit<UserAccountDocument, "_id">[]> = fc
  .integer({ min: 0, max: 8 })
  .chain((count) =>
    fc.tuple(
      ...Array.from({ length: count }, (_, index) => accountSeedArb(index))
    )
  )
  .map((accounts) => accounts.slice())

/**
 * A set of 0..5 seeded Member_Registry documents, each carrying a sentinel
 * `hiveId`. These feed the `members` count only — the Admin_Page never lists
 * them — so a sentinel `hiveId` surfacing in the response would be a regression.
 */
const membersSeedArb: fc.Arbitrary<MemberDocumentInput[]> = fc
  .array(fc.record({ label: fc.string({ minLength: 1, maxLength: 40 }) }), {
    maxLength: 5,
  })
  .map((rows) =>
    rows.map((row, index) => ({
      entryId: `m-${index}`,
      memberLabel: row.label,
      hiveId: `${HIVE_ID_SENTINEL}_${index}`,
      enabled: true,
      createdAt: new Date("2025-01-04T18:00:00.000Z"),
      position: index + 1,
    }))
  )

/**
 * A set of 0..4 seeded Redemption_History documents whose outcome rows carry a
 * sentinel `hiveId`. These feed the `history` count only.
 */
const historySeedArb: fc.Arbitrary<HistoryDocumentInput[]> = fc
  .array(fc.record({ coupon: fc.string({ minLength: 1, maxLength: 20 }) }), {
    maxLength: 4,
  })
  .map((rows) =>
    rows.map((row, index) => ({
      runId: `run-${index}`,
      seq: index + 1,
      couponCode: row.coupon,
      completedAt: "2025-01-04T18:00:00.000Z",
      completedAtMs: Date.parse("2025-01-04T18:00:00.000Z"),
      mock: false,
      stoppedEarly: false,
      outcomes: [
        {
          hiveId: `${HIVE_ID_SENTINEL}_${index}`,
          memberLabel: "seeded",
          outcome: "SUCCESS" as const,
          responseCode: "(100)",
          responseMessage: "Coupon redeemed.",
        },
      ],
    }))
  )

/** The three seeded collections together. */
const seedArb = fc.record({
  accounts: accountsSeedArb,
  members: membersSeedArb,
  history: historySeedArb,
})

/* -------------------------------------------------------------------------- */
/* Seams                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * An {@link Identity} stub. `listForAdminPage` never reaches the identity seam —
 * only `resolve` does — so every method throws to prove the projection path
 * touches neither Clerk nor the network.
 */
const throwingIdentity: Identity = {
  configured: () => true,
  current: async () => {
    throw new Error("listForAdminPage() must not resolve a request identity")
  },
  profile: async () => {
    throw new Error("listForAdminPage() must not fetch a Clerk profile")
  },
}

/**
 * An {@link Authorization} stub returning an `admin` decision, so
 * `buildAdminOverview` produces the overview rather than a rejection envelope.
 * The account it carries deliberately holds the identity-key sentinel, so if the
 * overview ever echoed the deciding account's `clerkUserId` the property would
 * catch it.
 */
const adminAuthorization: Authorization = {
  decide: async () => ({
    kind: "admin",
    account: {
      clerkUserId: `${CLERK_ID_SENTINEL}_decider`,
      email: "admin@example.com",
      displayName: "Admin",
      role: "admin",
      lastSignInAt: "2025-01-04T18:00:00.000Z",
    },
  }),
}

/* -------------------------------------------------------------------------- */
/* Leak detection                                                             */
/* -------------------------------------------------------------------------- */

/** Every JSON key present anywhere in a parsed structure. */
function collectKeys(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const element of value) collectKeys(element, into)
    return
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      into.add(key)
      collectKeys(nested, into)
    }
  }
}

/**
 * Asserts that a serialized response holds no sentinel identity-key value, no
 * sentinel Hive_ID value, and no forbidden object key anywhere.
 */
function expectNoLeak(serialized: string): void {
  // 1. No sentinel VALUE appears as a substring of the serialized response.
  expect(serialized).not.toContain(CLERK_ID_SENTINEL)
  expect(serialized).not.toContain(HIVE_ID_SENTINEL)

  // 2. No forbidden KEY appears anywhere in the parsed structure.
  const keys = new Set<string>()
  collectKeys(JSON.parse(serialized), keys)
  for (const forbidden of FORBIDDEN_KEYS) {
    expect(keys.has(forbidden)).toBe(false)
    // The key would also surface as a JSON key token in the raw string.
    expect(serialized).not.toContain(`"${forbidden}"`)
  }
}

/* -------------------------------------------------------------------------- */
/* The property                                                               */
/* -------------------------------------------------------------------------- */

describe("Property 19: the Admin_Page response holds no Hive_ID and no identity key", () => {
  it("leaks neither a sentinel clerkUserId nor a hiveId through the serialized overview or account list", async () => {
    await fc.assert(
      fc.asyncProperty(seedArb, async (seed) => {
        const handle = createInMemoryMongoStore({
          seed: {
            user_accounts: seed.accounts,
            members: seed.members,
            history: seed.history,
          },
        })

        const accounts = createUserAccountStore(handle.store, {
          identity: throwingIdentity,
          allowlist: ["admin@example.com"],
        })

        // The account list on its own, serialized.
        const accountsRead = await accounts.listForAdminPage()
        expect(accountsRead.ok).toBe(true)
        expectNoLeak(JSON.stringify(accountsRead))

        // The full Admin_Page response a client receives, serialized.
        const envelope = await buildAdminOverview({
          authorization: adminAuthorization,
          store: handle.store,
          accounts,
          mockMode: false,
        })
        expect(envelope.ok).toBe(true)
        expectNoLeak(JSON.stringify(envelope))

        // The seeded accounts really were read back, so the check is not vacuous.
        if (envelope.ok) {
          const overview: AdminOverview = envelope.data
          if (overview.accounts.ok) {
            expect(overview.accounts.rows.length).toBe(seed.accounts.length)
          }
        }
      }),
      { numRuns: 200 }
    )
  })
})
