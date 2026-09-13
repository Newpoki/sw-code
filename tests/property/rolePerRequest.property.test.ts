// Feature: mongodb-google-auth-admin, Property 15: Every Admin_Page decision reads the Account_Role again
//
// For any sequence of stored Account_Role values written for one Clerk user
// identifier, interleaved with requests for an Admin_Page value, every request
// is decided by the Account_Role stored in the Mongo_Database at the moment
// that request is decided and by no value stored earlier, and each decision
// performs exactly one read of that User_Account record.
//
// Validates: Requirements 6.8.
//
// The claim has three independently falsifiable halves, so each is its own `it`:
//
//   1. A `decide()` on a request that carries a Clerk session reads the mirror
//      exactly once — the spy's `resolve` counter rises by exactly one per call,
//      never zero (a cache) and never more than one.
//   2. A second `decide()` returns the role the mirror holds *now*, not the one
//      the first `decide()` read. The spy is armed with a sequence of outcomes
//      and hands out the next one on each call, so a cached first answer would
//      make the second decision disagree with the second stored role. "An
//      Account_Role written after a User_Session was granted decides that
//      request" is exactly this: the write lands between two calls and the
//      later call sees it.
//   3. An anonymous request — `identity.current()` resolves to null — costs no
//      mirror read at all: the counter stays at zero, because the decision
//      short-circuits before any `resolve`.
//
// The seams are stubbed, never mocked with a library: `stubIdentity` is a
// three-function `Identity` literal whose `current()` returns whatever identity
// the arrangement fixes, and `spyStore` is a `UserAccountStore` literal whose
// `resolve` counts its calls and reads the next armed outcome. Neither touches
// Clerk, MongoDB, or the network, exactly as the module's own doc comment
// promises the decision is exercisable.
//
// Arbitraries are defined locally rather than in `tests/property/generators.ts`:
// roles, identifiers, and sequences of resolve outcomes are what this one
// property turns on and no other property needs them.

import fc from "fast-check"
import { describe, expect, it } from "vitest"

import type { AccountRole, UserAccountView } from "@/domain/accounts"
import { createAuthorization } from "@/server/authorization.server"
import type {
  ClerkProfile,
  Identity,
  ProfileFailure,
  RequestIdentity,
} from "@/server/identity.server"
import type {
  ResolveAccountResult,
  UserAccountStore,
} from "@/server/store/userAccounts.server"

/* -------------------------------------------------------------------------- */
/* Stub seams                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * An {@link Identity} whose `current()` resolves to the fixed identity the
 * arrangement chose. `configured` and `profile` are never reached by `decide()`
 * once `current()` has answered, so they are honest no-ops: `profile` rejects
 * so a stray call would fail loudly rather than pass quietly.
 */
function stubIdentity(current: RequestIdentity | null): Identity {
  return {
    configured: () => true,
    current: async () => current,
    profile: async (): Promise<ClerkProfile | ProfileFailure> => {
      throw new Error("profile() must not be reached by decide()")
    },
  }
}

/** A spy {@link UserAccountStore} and the counter its `resolve` increments. */
interface SpyStore {
  readonly store: UserAccountStore
  /** How many times `resolve` has been invoked so far. */
  resolveCalls: number
  /** Every identity `resolve` was handed, in call order. */
  readonly seen: RequestIdentity[]
}

/**
 * A {@link UserAccountStore} whose `resolve` counts its calls and hands out the
 * next outcome from `outcomes`, so successive `decide()` calls can be made to
 * see different stored roles. It holds no cache of its own — that is the whole
 * point — and `listForAdminPage` is never reached by `decide()`, so it rejects.
 *
 * When `outcomes` is exhausted the last outcome repeats, which keeps a test
 * that calls `decide()` more times than it armed outcomes well-defined without
 * changing what the earlier, armed calls observe.
 */
function spyStore(outcomes: readonly ResolveAccountResult[]): SpyStore {
  const spy: SpyStore = {
    resolveCalls: 0,
    seen: [],
    store: {
      resolve: async (identity: RequestIdentity) => {
        const at = spy.resolveCalls
        spy.resolveCalls += 1
        spy.seen.push(identity)
        return outcomes[Math.min(at, outcomes.length - 1)]
      },
      listForAdminPage: async () => {
        throw new Error("listForAdminPage() must not be reached by decide()")
      },
    },
  }
  return spy
}

/* -------------------------------------------------------------------------- */
/* Local arbitraries                                                          */
/* -------------------------------------------------------------------------- */

/** A non-empty identifier, as a Clerk user id or session id. */
const idArb: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 24 })

/** A request identity: a Clerk user id and the session id of its session. */
const requestIdentityArb: fc.Arbitrary<RequestIdentity> = fc.record({
  userId: idArb,
  sessionId: idArb,
})

/** One of the two roles a stored User_Account can hold. */
const roleArb: fc.Arbitrary<AccountRole> = fc.constantFrom("admin", "member")

/** A stored User_Account holding `role`, keyed on `identity.userId`. */
function accountFor(
  identity: RequestIdentity,
  role: AccountRole
): UserAccountView {
  return {
    clerkUserId: identity.userId,
    email: "person@example.test",
    displayName: "Person",
    role,
    lastSignInAt: new Date(0).toISOString(),
  }
}

/**
 * A `resolve` outcome the mirror can return for a request: an account holding
 * either role, or the "authorization could not be determined" failure. The
 * account is filled in against the request identity at use, so its key matches.
 */
type Outcome =
  | { readonly kind: "role"; readonly role: AccountRole }
  | { readonly kind: "unknown" }

const outcomeArb: fc.Arbitrary<Outcome> = fc.oneof(
  {
    weight: 4,
    arbitrary: roleArb.map((role) => ({ kind: "role", role }) as const),
  },
  { weight: 1, arbitrary: fc.constant({ kind: "unknown" } as const) }
)

/** Realizes an {@link Outcome} into a {@link ResolveAccountResult}. */
function resultOf(
  identity: RequestIdentity,
  outcome: Outcome
): ResolveAccountResult {
  if (outcome.kind === "unknown") {
    return {
      kind: "unknown",
      failure: { reason: "unreachable", message: "unknown" },
    }
  }
  return { kind: "account", account: accountFor(identity, outcome.role) }
}

/** The decision kind Property 15 expects an outcome to produce. */
function expectedKind(outcome: Outcome): "admin" | "member" | "unknown" {
  if (outcome.kind === "unknown") return "unknown"
  return outcome.role === "admin" ? "admin" : "member"
}

/* -------------------------------------------------------------------------- */
/* The property                                                               */
/* -------------------------------------------------------------------------- */

describe("Property 15: every Admin_Page decision reads the Account_Role again", () => {
  it("reads the mirror exactly once per decision for a request with a valid identity", async () => {
    await fc.assert(
      fc.asyncProperty(
        requestIdentityArb,
        fc.array(outcomeArb, { minLength: 1, maxLength: 6 }),
        async (identity, outcomes) => {
          const spy = spyStore(
            outcomes.map((outcome) => resultOf(identity, outcome))
          )
          const authorization = createAuthorization({
            identity: stubIdentity(identity),
            accounts: spy.store,
          })

          // Each decision costs exactly one read: the counter rises by one on
          // every call, so no call reuses an earlier read (a zero increment)
          // and none reads twice.
          for (let call = 1; call <= outcomes.length; call += 1) {
            await authorization.decide()
            expect(spy.resolveCalls).toBe(call)
          }

          // Every read was handed the request's own identity, never a stale one.
          for (const seen of spy.seen) {
            expect(seen).toEqual(identity)
          }
        }
      ),
      { numRuns: 200 }
    )
  })

  it("decides each call by the role stored at that moment, never a value read earlier", async () => {
    await fc.assert(
      fc.asyncProperty(
        requestIdentityArb,
        fc.array(outcomeArb, { minLength: 2, maxLength: 6 }),
        async (identity, outcomes) => {
          const spy = spyStore(
            outcomes.map((outcome) => resultOf(identity, outcome))
          )
          const authorization = createAuthorization({
            identity: stubIdentity(identity),
            accounts: spy.store,
          })

          // The mirror is armed to return a different role (or an unknown) on
          // each successive call. The nth decision must equal the nth armed
          // outcome — a cached first answer would make a later decision
          // disagree with the role written after the first call.
          for (const outcome of outcomes) {
            const decision = await authorization.decide()
            expect(decision.kind).toBe(expectedKind(outcome))
            if (outcome.kind === "role") {
              // The account decided against is the one the mirror just returned,
              // holding the role stored now.
              if (decision.kind === "admin" || decision.kind === "member") {
                expect(decision.account.role).toBe(outcome.role)
              }
            }
          }

          expect(spy.resolveCalls).toBe(outcomes.length)
        }
      ),
      { numRuns: 200 }
    )
  })

  it("reflects a role written between two requests on the second request", async () => {
    await fc.assert(
      fc.asyncProperty(requestIdentityArb, roleArb, async (identity, first) => {
        // The two calls straddle a write: the second role is always the
        // opposite of the first, so the second decision can only be right by
        // having read the mirror again rather than by reusing the first read.
        const second: AccountRole = first === "admin" ? "member" : "admin"
        const spy = spyStore([
          { kind: "account", account: accountFor(identity, first) },
          { kind: "account", account: accountFor(identity, second) },
        ])
        const authorization = createAuthorization({
          identity: stubIdentity(identity),
          accounts: spy.store,
        })

        const firstDecision = await authorization.decide()
        const secondDecision = await authorization.decide()

        expect(firstDecision.kind).toBe(first)
        expect(secondDecision.kind).toBe(second)
        expect(spy.resolveCalls).toBe(2)
      }),
      { numRuns: 200 }
    )
  })

  it("reads the mirror not at all for an anonymous request", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.array(outcomeArb, { minLength: 1, maxLength: 3 }),
        async (calls, outcomes) => {
          // No Clerk session: `current()` resolves to null. The decision is
          // anonymous and short-circuits before any mirror read, so however
          // many times it is called the counter never leaves zero.
          const identity = fc.sample(requestIdentityArb, 1)[0]
          const spy = spyStore(
            outcomes.map((outcome) => resultOf(identity, outcome))
          )
          const authorization = createAuthorization({
            identity: stubIdentity(null),
            accounts: spy.store,
          })

          for (let call = 0; call < calls; call += 1) {
            const decision = await authorization.decide()
            expect(decision.kind).toBe("anonymous")
          }

          expect(spy.resolveCalls).toBe(0)
          expect(spy.seen).toEqual([])
        }
      ),
      { numRuns: 200 }
    )
  })
})
