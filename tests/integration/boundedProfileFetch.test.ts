/**
 * The bounded profile fetch of Requirement 5.14 (restated in design.md's
 * Identity section: the equivalent bound we own is the 5-second cap on the
 * Clerk Backend call that reads the user's email and name).
 *
 * `Identity.profile(userId)` races `clerkClient().users.getUser(userId)` against
 * a timer of `timeoutMs` (default {@link PROFILE_FETCH_TIMEOUT_MS} = 5000). This
 * test pins two things at once:
 *
 *   1. **The race is bounded.** A `getUser` that never resolves (a stall) does
 *      not stall `profile()`: with a short injected `timeoutMs`, `profile()`
 *      resolves to `{ kind: "profile-failed", reason: "unreachable" }` in well
 *      under any real 5 seconds, and no earlier than the injected bound. We use
 *      a short *real* timeout rather than fake timers: it is the simplest and
 *      most robust way to prove the `Promise.race` actually elapses, and it
 *      keeps the test deterministic and fast.
 *   2. **The default bound is 5 seconds.** `PROFILE_FETCH_TIMEOUT_MS === 5000`
 *      is asserted directly, so the "roughly 5 seconds" contract is checked
 *      without a test that waits 5 seconds.
 *
 * ## "A stalled fetch writes no User_Account"
 *
 * `Identity.profile` does not write anything — the User_Account mirror (task 16)
 * is the only writer, and by construction it upserts only on a `ClerkProfile`,
 * never on a `ProfileFailure`. So the guarantee that a stalled fetch writes no
 * User_Account is, at this layer, exactly the guarantee that a stalled fetch
 * returns a `ProfileFailure` rather than a `ClerkProfile`. That is what the
 * `reason: "unreachable"` assertion below establishes. The stronger,
 * mirror-level statement — that the `user_accounts` collection stays empty after
 * a request whose profile stalled — belongs with the mirror's own tests (task
 * 16.2), because `src/server/store/userAccounts.server.ts` is the writer and
 * does not yet exist at this layer.
 *
 * ## Why the control case matters
 *
 * A stall assertion is only meaningful if the same seam, fed a healthy user,
 * produces a `ClerkProfile`. Without that control, a `profile()` that always
 * returned `unreachable` would pass the stall assertion vacuously. So a
 * resolves-with-a-verified-user case is included, and it must yield a profile.
 *
 * The whole test injects a `users` factory through `createIdentity` and never
 * touches Clerk or the network; there is no MongoDB here either.
 */

import { describe, expect, it } from "vitest"

import {
  PROFILE_FETCH_TIMEOUT_MS,
  createIdentity,
} from "@/server/identity.server"
import type {
  ClerkProfile,
  ClerkUser,
  ClerkUserReader,
  ProfileFailure,
} from "@/server/identity.server"

/** The injected bound for the stall cases: short, so the race elapses fast. */
const SHORT_TIMEOUT_MS = 50

/**
 * A ceiling far below any real 5-second bound. A stalled fetch bounded at
 * {@link SHORT_TIMEOUT_MS} must answer well under this; the gap between this and
 * `PROFILE_FETCH_TIMEOUT_MS` is the whole point — the injected bound is what
 * decides, not some hard-coded 5 seconds.
 */
const WELL_UNDER_REAL_BOUND_MS = 1000

/** An arbitrary Clerk user id; its value never matters to a stub reader. */
const USER_ID = "user_2abc"

/** A `users` factory whose `getUser` never settles — the stall under test. */
function stallingReader(): ClerkUserReader {
  return {
    getUser: () => new Promise<ClerkUser>(() => undefined),
  }
}

/** A `users` factory whose `getUser` rejects — the other route to `unreachable`. */
function rejectingReader(): ClerkUserReader {
  return {
    getUser: () => Promise.reject(new Error("clerk backend is down")),
  }
}

/** A Clerk user holding a primary verified email address — the control. */
const VERIFIED_USER: ClerkUser = {
  primaryEmailAddressId: "idn_primary",
  emailAddresses: [
    {
      id: "idn_primary",
      emailAddress: "Owner@Example.com",
      verification: { status: "verified" },
    },
  ],
  firstName: "Ada",
  lastName: "Lovelace",
}

/** A `users` factory whose `getUser` resolves with {@link VERIFIED_USER}. */
function resolvingReader(user: ClerkUser): ClerkUserReader {
  return {
    getUser: () => Promise.resolve(user),
  }
}

/**
 * True when the value is a {@link ProfileFailure} rather than a
 * {@link ClerkProfile}. The `kind` field is the discriminant: only a
 * `ProfileFailure` carries it, so its presence alone decides the branch.
 */
function isProfileFailure(
  value: ClerkProfile | ProfileFailure
): value is ProfileFailure {
  return "kind" in value
}

describe("bounded profile fetch (Requirement 5.14 restated)", () => {
  it("pins the default bound at 5 seconds", () => {
    // The "roughly 5 seconds" contract, checked without waiting 5 seconds.
    expect(PROFILE_FETCH_TIMEOUT_MS).toBe(5000)
  })

  it("answers a stalled Clerk fetch with `unreachable`, inside the injected bound, writing no profile", async () => {
    const identity = createIdentity({
      users: stallingReader,
      timeoutMs: SHORT_TIMEOUT_MS,
    })

    const startedAt = performance.now()
    const result = await identity.profile(USER_ID)
    const elapsedMs = performance.now() - startedAt

    // A stall yields a failure, not a profile — and the failure is the coarse,
    // Clerk-free `unreachable`. Because it is a ProfileFailure, a mirror that
    // upserts only on a ClerkProfile would write no User_Account (Requirement
    // 5.14 restated: a stalled fetch writes nothing).
    expect(isProfileFailure(result)).toBe(true)
    expect(result).toStrictEqual<ProfileFailure>({
      kind: "profile-failed",
      reason: "unreachable",
    })

    // The race is bounded: it resolved far below any real 5-second wait...
    expect(
      elapsedMs,
      `a stalled fetch answered in ${elapsedMs.toFixed(2)} ms, which is not far below the real ${PROFILE_FETCH_TIMEOUT_MS} ms bound`
    ).toBeLessThan(WELL_UNDER_REAL_BOUND_MS)

    // ...and it was the injected timer that decided, so it did not answer before
    // the timer could have fired. A small slack absorbs timer coarseness.
    expect(
      elapsedMs,
      `a stalled fetch answered in ${elapsedMs.toFixed(2)} ms, before the injected ${SHORT_TIMEOUT_MS} ms bound could elapse`
    ).toBeGreaterThanOrEqual(SHORT_TIMEOUT_MS - 15)
  })

  it("answers a rejected Clerk fetch with `unreachable` as well", async () => {
    // A rejection, like a timeout, is mapped to the same coarse failure so no
    // Clerk-side error text rides along and no profile is produced.
    const identity = createIdentity({
      users: rejectingReader,
      timeoutMs: SHORT_TIMEOUT_MS,
    })

    const result = await identity.profile(USER_ID)

    expect(isProfileFailure(result)).toBe(true)
    expect(result).toStrictEqual<ProfileFailure>({
      kind: "profile-failed",
      reason: "unreachable",
    })
  })

  it("resolves a healthy user to a ClerkProfile, so the stall assertion is not vacuous", async () => {
    // The control: fed a user with a primary verified email address, the very
    // same seam produces a profile, not `unreachable`. This is what proves the
    // stall/rejection cases above are catching the bound, not a seam that always
    // fails.
    const identity = createIdentity({
      users: () => resolvingReader(VERIFIED_USER),
      timeoutMs: SHORT_TIMEOUT_MS,
    })

    const result = await identity.profile(USER_ID)

    expect(isProfileFailure(result)).toBe(false)
    expect(result).toStrictEqual<ClerkProfile>({
      email: "owner@example.com",
      displayName: "Ada Lovelace",
    })
  })
})
