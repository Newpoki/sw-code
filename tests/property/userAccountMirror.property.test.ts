// Feature: mongodb-google-auth-admin, Property 11: The User_Account mirror is the projection of the most recent Clerk profile
//
// Validates: Requirements 5.4, 5.5, 5.15.
//
// *For any* Clerk user identifier and *for any* non-empty sequence of Clerk
// profiles for it — display names of any length including zero characters,
// whitespace-only names, and names longer than 100 characters, and email
// addresses in any letter case — refreshed in that order against any
// Admin_Allowlist, the `user_accounts` collection afterwards holds exactly one
// Store_Document for that identifier, its key equals that identifier and never
// changed, its email address equals the folded email of the last profile, its
// display name equals that profile's name trimmed and truncated to its first
// 100 characters or that email address when the trimmed name holds zero
// characters, its Account_Role equals the role that allowlist derives for that
// email, and its most recent sign-in timestamp is not earlier than the timestamp
// of the refresh that first stored it; and *for any* profile holding no usable
// email address, no Store_Document is written and the authorization decision
// reports that it could not be determined.
//
// ## What "the mirror stores" means here, and where the expected value comes from
//
// The mirror stores exactly what `Identity.profile()` returns — a `ClerkProfile`
// of `{ email, displayName }`, both already projected. So the stub injected
// below returns `projectProfile(user)` for a generated raw Clerk user, which is
// the very function the real seam calls before handing a profile to the mirror.
// The expected stored `email`/`displayName` are therefore that same projection,
// computed here from the generated `ClerkUserSample` with `projectProfile` — not
// restated — and the expected `emailLower` is `foldEmail(email)`, the expected
// `role` is `deriveAccountRole(email, allowlist)`. The projection rule itself
// (join firstName/lastName, trim, truncate 100, fallback to email) is Property 2's
// subject; this file asserts that whatever the projection is, the *mirror* stores
// it, keyed once, for the most recent successful profile.
//
// ## The clock and the session drive every refresh trigger
//
// Each step carries a session id and an injected `now`. A step whose session id
// differs from the stored document's, or whose `now` is past the TTL, forces a
// refresh; the expected `lastSignInAt` advances only when the session id changed
// (or the document was absent). The clock is a mutable holder the stub reads, so
// the test controls exactly which `now` each `resolve` sees.
//
// ## No MongoDB
//
// The mirror runs over the in-memory Mongo_Store fake, whose `.userAccounts()`
// is inspected directly and whose backing store is shared across two mirrors for
// a restart-style read. No real database is touched.

import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
  deriveAccountRole,
  foldEmail,
  parseAdminAllowlist,
} from "@/domain/accounts"
import {
  DISPLAY_NAME_MAX_LENGTH as SEAM_DISPLAY_NAME_MAX_LENGTH,
  projectProfile,
} from "@/server/identity.server"
import type {
  ClerkProfile,
  Identity,
  ProfileFailure,
  RequestIdentity,
} from "@/server/identity.server"
import {
  createUserAccountStore,
  USER_MIRROR_TTL_MS,
} from "@/server/store/userAccounts.server"

import {
  clerkProfileSampleArb,
  clerkEmailAddressArb,
  DISPLAY_NAME_MAX_LENGTH,
  usableClerkProfileSampleArb,
} from "./generators"
import type { ClerkProfileSample, ClerkUserSample } from "./generators"

import {
  createInMemoryBackingStore,
  createInMemoryMongoStore,
} from "../support/inMemoryMongoStore"
import type { InMemoryBackingStore } from "../support/inMemoryMongoStore"

/* -------------------------------------------------------------------------- */
/* The rule, stated independently of the mirror                               */
/* -------------------------------------------------------------------------- */

/**
 * What the mirror should store for a profile the projection accepts. Derived
 * from the raw Clerk user with the seam's own projection, so a mistake in the
 * mirror's copy of the fields is caught, not a mistake restated identically.
 * Returns null for a profile that projects to a failure — nothing is stored.
 */
function expectedProfile(user: ClerkUserSample): ClerkProfile | null {
  const projected = projectProfile(user)
  return "kind" in projected ? null : projected
}

/* -------------------------------------------------------------------------- */
/* A stub Identity and a controllable clock                                   */
/* -------------------------------------------------------------------------- */

/** A clock the test advances; the stub and the store read `value` on each call. */
interface Clock {
  value: Date
}

/**
 * An {@link Identity} whose `profile()` answers from a lookup keyed on the Clerk
 * user id, controlled entirely by the test. `current()` is never called by the
 * mirror (the mirror is handed the `RequestIdentity` directly), and `configured`
 * is a constant; both exist only to satisfy the seam shape.
 */
function stubIdentity(
  profileFor: (userId: string) => ClerkProfile | ProfileFailure
): Identity {
  return {
    configured: () => true,
    current: () => Promise.resolve(null),
    profile: (userId) => Promise.resolve(profileFor(userId)),
  }
}

/** The `ProfileFailure` the seam returns for a profile holding no usable email. */
const NO_VERIFIED_EMAIL: ProfileFailure = {
  kind: "profile-failed",
  reason: "no-verified-email",
}

/**
 * Turns a {@link ClerkProfileSample} into what `Identity.profile()` returns:
 * the projection for a usable profile, and the `no-verified-email` failure for
 * an unusable one — the same two outcomes the real seam produces.
 */
function profileResult(
  sample: ClerkProfileSample
): ClerkProfile | ProfileFailure {
  const projected = projectProfile(sample.user)
  return "kind" in projected ? NO_VERIFIED_EMAIL : projected
}

/* -------------------------------------------------------------------------- */
/* One step of a refresh sequence                                             */
/* -------------------------------------------------------------------------- */

/**
 * One `resolve` in a sequence: the profile the stub will return for it, the
 * session id the request carries, and how far the clock advances before it.
 */
interface Step {
  readonly sample: ClerkProfileSample
  readonly sessionId: string
  /** Milliseconds added to the clock before this step's `resolve`. */
  readonly advanceMs: number
}

/** Fixed base instant, so a generated sequence is deterministic across runs. */
const BASE_MS = Date.parse("2025-01-04T18:00:00.000Z")

/** A session id, from a small pool so a repeat (no advance of `lastSignInAt`) is common. */
const sessionIdArb: fc.Arbitrary<string> = fc.constantFrom(
  "session-a",
  "session-b",
  "session-c"
)

/**
 * A clock advance: often small (well inside the TTL, so a same-session step uses
 * the document as read), and often past the TTL (so a same-session step still
 * refreshes).
 */
const advanceArb: fc.Arbitrary<number> = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 0, max: USER_MIRROR_TTL_MS - 1 }) },
  {
    weight: 2,
    arbitrary: fc.integer({
      min: USER_MIRROR_TTL_MS,
      max: USER_MIRROR_TTL_MS * 3,
    }),
  }
)

/** A step whose profile is always usable, for the "most recent" clause. */
const usableStepArb: fc.Arbitrary<Step> = fc.record({
  sample: usableClerkProfileSampleArb,
  sessionId: sessionIdArb,
  advanceMs: advanceArb,
})

/** An `ADMIN_EMAILS` value, so the allowlist a step derives its role from varies. */
const allowlistArb: fc.Arbitrary<readonly string[]> = fc
  .oneof(
    { weight: 3, arbitrary: fc.array(clerkEmailAddressArb, { maxLength: 5 }) },
    { weight: 1, arbitrary: fc.constant<string[]>([]) }
  )
  .map((emails) => parseAdminAllowlist(emails.join(",")))

/* -------------------------------------------------------------------------- */
/* Running a sequence                                                         */
/* -------------------------------------------------------------------------- */

/** The clerk user id every step of a sequence shares — the mirror key. */
const CLERK_USER_ID = "clerk-user-under-test"

/**
 * The state the test tracks alongside the mirror, so its expectations do not
 * re-read the store: the last profile that was successfully stored, and the
 * `lastSignInAt` the mirror should be holding.
 */
interface Tracking {
  /** The projection last stored, or null while nothing has been stored yet. */
  lastStored: ClerkProfile | null
  /** Session id of the last successful store, for the sign-in-advance rule. */
  lastStoredSession: string | null
  /** The sign-in timestamp the mirror should be holding, in ms. */
  lastSignInMs: number | null
  /** The `lastSyncedAt` the mirror last wrote, in ms; the stale check reads it. */
  lastSyncedMs: number
}

/** A fresh tracking state: nothing stored, and a sync time that always reads stale. */
function freshTracking(): Tracking {
  return {
    lastStored: null,
    lastStoredSession: null,
    lastSignInMs: null,
    lastSyncedMs: Number.NEGATIVE_INFINITY,
  }
}

/**
 * Drives one step against the mirror and updates the tracking, returning the
 * `resolve` result so the caller can assert the discriminant.
 *
 * The tracking mirrors the store's own four-step rule: a refresh happens when
 * the document is absent, the session id changed, or `lastSyncedAt` is at least
 * a TTL old; `lastSignInAt` advances on a refresh only when the session changed
 * or the document was absent. A step whose profile does not project (an unusable
 * profile) writes nothing on a refresh, so the tracking is left unchanged.
 */
async function runStep(
  store: ReturnType<typeof createUserAccountStore>,
  clock: Clock,
  tracking: Tracking,
  step: Step
): Promise<Awaited<ReturnType<typeof store.resolve>>> {
  clock.value = new Date(clock.value.getTime() + step.advanceMs)
  const nowMs = clock.value.getTime()

  const identity: RequestIdentity = {
    userId: CLERK_USER_ID,
    sessionId: step.sessionId,
  }
  const result = await store.resolve(identity)

  const wouldRefresh =
    tracking.lastStored === null ||
    tracking.lastStoredSession !== step.sessionId ||
    nowMs - tracking.lastSyncedMs >= USER_MIRROR_TTL_MS

  if (!wouldRefresh) {
    // Step 4: the document was used as read; nothing changed.
    return result
  }

  const expected = expectedProfile(step.sample.user)
  if (expected === null) {
    // Requirement 5.15: a refresh that fetches an unusable profile writes
    // nothing, so the tracked state is left exactly as it was.
    return result
  }

  const sessionChanged =
    tracking.lastStored === null ||
    tracking.lastStoredSession !== step.sessionId

  tracking.lastStored = expected
  if (sessionChanged) {
    tracking.lastSignInMs = nowMs
  }
  tracking.lastStoredSession = step.sessionId
  tracking.lastSyncedMs = nowMs
  return result
}

/* -------------------------------------------------------------------------- */
/* The property                                                               */
/* -------------------------------------------------------------------------- */

describe("Property 11: the User_Account mirror is the projection of the most recent Clerk profile", () => {
  it("keeps this generator's cap identical to the identity seam's", () => {
    // The restated constant the profile arbitrary truncates against must equal
    // the one the seam projects against, or the generator would reach a
    // boundary the mirror does not.
    expect(DISPLAY_NAME_MAX_LENGTH).toBe(SEAM_DISPLAY_NAME_MAX_LENGTH)
  })

  it("stores exactly the projection of the most recent successful profile, keyed once", async () => {
    await fc.assert(
      fc.asyncProperty(
        allowlistArb,
        fc.array(usableStepArb, { minLength: 1, maxLength: 8 }),
        async (allowlist, steps) => {
          const clock: Clock = { value: new Date(BASE_MS) }
          const handle = createInMemoryMongoStore()
          const tracking = freshTracking()

          for (const step of steps) {
            // Rebuild the store per step so its stub returns this step's profile.
            const perStep = createUserAccountStore(handle.store, {
              identity: stubIdentity(() => profileResult(step.sample)),
              allowlist,
              now: () => clock.value,
            })
            const result = await runStep(perStep, clock, tracking, step)
            expect(result.kind).toBe("account")
          }

          // Requirement 5.5: exactly one Store_Document for the identifier.
          const stored = handle
            .userAccounts()
            .filter((document) => document.clerkUserId === CLERK_USER_ID)
          expect(stored.length).toBe(1)
          const document = stored[0]

          // The projection of the most recent successful profile.
          const last = tracking.lastStored
          expect(last).not.toBeNull()
          if (last === null) return
          expect(document.email).toBe(last.email)
          expect(document.emailLower).toBe(foldEmail(last.email))
          expect(document.displayName).toBe(last.displayName)
          expect(document.displayName.length).toBeLessThanOrEqual(
            DISPLAY_NAME_MAX_LENGTH
          )
          expect(document.role).toBe(deriveAccountRole(last.email, allowlist))

          // Requirement 5.4 restated: the key equals the identifier, unchanged.
          expect(document.clerkUserId).toBe(CLERK_USER_ID)

          // The most recent sign-in is not earlier than the first store.
          expect(document.lastSignInAt.getTime()).toBe(tracking.lastSignInMs)
        }
      ),
      { numRuns: 200 }
    )
  })

  it("advances lastSignInAt only when the session changed or the document was absent", async () => {
    await fc.assert(
      fc.asyncProperty(
        allowlistArb,
        fc.array(usableStepArb, { minLength: 2, maxLength: 8 }),
        async (allowlist, steps) => {
          const clock: Clock = { value: new Date(BASE_MS) }
          const handle = createInMemoryMongoStore()
          const tracking = freshTracking()

          for (const step of steps) {
            const store = createUserAccountStore(handle.store, {
              identity: stubIdentity(() => profileResult(step.sample)),
              allowlist,
              now: () => clock.value,
            })

            const beforeSignIn = tracking.lastSignInMs
            const beforeSession = tracking.lastStoredSession
            const result = await runStep(store, clock, tracking, step)
            expect(result.kind).toBe("account")

            const document = handle
              .userAccounts()
              .find((entry) => entry.clerkUserId === CLERK_USER_ID)
            expect(document).toBeDefined()
            if (document === undefined) return

            // lastSignInAt matches the tracked value: it only moved when the
            // session changed or nothing was stored before (Requirement 5.5).
            expect(document.lastSignInAt.getTime()).toBe(tracking.lastSignInMs)

            if (
              beforeSignIn !== null &&
              beforeSession === step.sessionId &&
              document.lastSignInAt.getTime() !== beforeSignIn
            ) {
              throw new Error("lastSignInAt moved for an unchanged session")
            }
          }
        }
      ),
      { numRuns: 200 }
    )
  })

  it("writes nothing for a profile with no usable email, leaving any prior document unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(
        allowlistArb,
        // A first usable step (so there is a prior document sometimes) or not,
        // then an unusable step.
        fc.option(usableStepArb, { nil: undefined }),
        clerkProfileSampleArb.filter(
          (sample) => expectedProfile(sample.user) === null
        ),
        fc.record({ sessionId: sessionIdArb, advanceMs: advanceArb }),
        async (allowlist, seedStep, unusableSample, failStep) => {
          const clock: Clock = { value: new Date(BASE_MS) }
          const handle = createInMemoryMongoStore()
          const tracking = freshTracking()

          if (seedStep !== undefined) {
            const seedStore = createUserAccountStore(handle.store, {
              identity: stubIdentity(() => profileResult(seedStep.sample)),
              allowlist,
              now: () => clock.value,
            })
            const seeded = await runStep(seedStore, clock, tracking, seedStep)
            expect(seeded.kind).toBe("account")
          }

          const before = handle
            .userAccounts()
            .find((entry) => entry.clerkUserId === CLERK_USER_ID)
          const beforeSnapshot = before ? { ...before } : null

          // The unusable step, with a new session id so it always forces a
          // refresh, so the "writes nothing" claim is not vacuous.
          clock.value = new Date(clock.value.getTime() + failStep.advanceMs)
          const failingStore = createUserAccountStore(handle.store, {
            identity: stubIdentity(() => profileResult(unusableSample)),
            allowlist,
            now: () => clock.value,
          })
          const failed = await failingStore.resolve({
            userId: CLERK_USER_ID,
            sessionId: `${failStep.sessionId}-new`,
          })

          // Requirement 5.15: authorization could not be determined.
          expect(failed.kind).toBe("unknown")

          const after = handle
            .userAccounts()
            .find((entry) => entry.clerkUserId === CLERK_USER_ID)

          if (beforeSnapshot === null) {
            // An absent document stays absent.
            expect(after).toBeUndefined()
          } else {
            // The prior document is unchanged, field for field.
            expect(after).toBeDefined()
            if (after === undefined) return
            expect(after.clerkUserId).toBe(beforeSnapshot.clerkUserId)
            expect(after.email).toBe(beforeSnapshot.email)
            expect(after.emailLower).toBe(beforeSnapshot.emailLower)
            expect(after.displayName).toBe(beforeSnapshot.displayName)
            expect(after.role).toBe(beforeSnapshot.role)
            expect(after.lastSignInAt.getTime()).toBe(
              beforeSnapshot.lastSignInAt.getTime()
            )
            expect(after.lastSyncedAt.getTime()).toBe(
              beforeSnapshot.lastSyncedAt.getTime()
            )
            expect(after.lastSessionId).toBe(beforeSnapshot.lastSessionId)
          }
        }
      ),
      { numRuns: 200 }
    )
  })

  it("serves the same one document from a second mirror over the same backing store", async () => {
    await fc.assert(
      fc.asyncProperty(allowlistArb, usableStepArb, async (allowlist, step) => {
        const clock: Clock = { value: new Date(BASE_MS) }
        const backing: InMemoryBackingStore = createInMemoryBackingStore()

        const first = createInMemoryMongoStore({ backing })
        const firstStore = createUserAccountStore(first.store, {
          identity: stubIdentity(() => profileResult(step.sample)),
          allowlist,
          now: () => clock.value,
        })
        const stored = await firstStore.resolve({
          userId: CLERK_USER_ID,
          sessionId: step.sessionId,
        })
        expect(stored.kind).toBe("account")

        // A second mirror over the same backing store — the restart shape —
        // reads exactly the one document, without refreshing (fresh, same
        // session).
        const second = createInMemoryMongoStore({ backing })
        const secondStore = createUserAccountStore(second.store, {
          identity: stubIdentity(() => {
            throw new Error("the second mirror must not refresh")
          }),
          allowlist,
          now: () => clock.value,
        })
        const reread = await secondStore.resolve({
          userId: CLERK_USER_ID,
          sessionId: step.sessionId,
        })
        expect(reread.kind).toBe("account")
        if (reread.kind !== "account") return

        const documents = second.backing
          .userAccounts()
          .filter((entry) => entry.clerkUserId === CLERK_USER_ID)
        expect(documents.length).toBe(1)

        const expected = expectedProfile(step.sample.user)
        expect(expected).not.toBeNull()
        if (expected === null) return
        expect(reread.account.email).toBe(expected.email)
        expect(reread.account.displayName).toBe(expected.displayName)
        expect(reread.account.role).toBe(
          deriveAccountRole(expected.email, allowlist)
        )
      }),
      { numRuns: 200 }
    )
  })
})
