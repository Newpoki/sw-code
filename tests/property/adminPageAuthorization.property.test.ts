// Feature: mongodb-google-auth-admin, Property 14: No Admin_Page value leaves the server for a non-admin request
//
// Validates: Requirements 5.13, 6.4, 6.5, 6.6, 6.7, 6.15.
//
// *For any* authorization state — the request identity present or absent, the
// stored User_Account holding the Admin_Role, holding the Member_Role, absent,
// or unreadable, and the endpoint a document or a server function — a request
// that is not an admin (anonymous, member, or unknown) yields a guard result
// carrying no `account` and no other Admin_Page value; only an `admin` decision
// yields `proceed`/`authorized` with the account. The document guard redirects
// an anonymous browser to `/sign-in`; the server-function guard rejects an
// anonymous caller with a `NOT_AUTHENTICATED` envelope and never a redirect. A
// member is `NOT_AUTHORIZED` and an unknown is `AUTHORIZATION_UNKNOWN` in both
// shapes.
//
// ## The decision is the real one
//
// The state is expressed as *inputs* to `createAuthorization().decide()` — a
// stub `Identity.current()` that returns a `RequestIdentity` or null, and a stub
// `UserAccountStore.resolve` that returns an account or a failure — so the test
// drives the real `decide()` and the real `requireAdmin*` guards rather than
// restating their output. No Clerk and no MongoDB are touched: both seams are
// injected literals, exactly as `createAuthorization` is meant to receive them.
//
// ## "No Admin_Page value leaves" is asserted structurally
//
// The only Admin_Page value a guard can carry is the `account` field of a
// `proceed`/`authorized` result. A non-admin result is either a `redirect`, a
// `rejected` document result (which carries only `code` and `message`), or a
// `rejected` server-fn result (which carries only an `Envelope` with `ok:false`
// and an `error`). None of those shapes has an `account`, and none embeds a
// `UserAccountView`, so the assertion is that a non-admin guard result has no
// `account` property and its serialized form holds none of the account's field
// values.

import fc from "fast-check"
import { describe, expect, it } from "vitest"

import type { UserAccountView } from "@/domain/accounts"
import {
  authorizationUnknownMessage,
  notAuthorizedMessage,
} from "@/domain/storeMessages"
import {
  createAuthorization,
  NOT_AUTHENTICATED_MESSAGE,
  requireAdminForDocument,
  requireAdminForServerFn,
  SIGN_IN_PATH,
} from "@/server/authorization.server"
import type {
  AdminDocumentGuard,
  AdminServerFnGuard,
} from "@/server/authorization.server"
import type { Identity, RequestIdentity } from "@/server/identity.server"
import type {
  ResolveAccountResult,
  UserAccountStore,
} from "@/server/store/userAccounts.server"

import { authorizationStateArb } from "./generators"
import type { AuthorizationStateSample } from "./generators"

/* -------------------------------------------------------------------------- */
/* Building the injected seams from a generated state                         */
/* -------------------------------------------------------------------------- */

/**
 * A stub {@link Identity} whose `current()` returns the state's request identity
 * (or null when anonymous). `configured()` and `profile()` are never reached by
 * `decide()` and throw if they somehow are, so an accidental call is a loud
 * failure rather than a silent pass.
 */
function stubIdentity(sample: AuthorizationStateSample): Identity {
  return {
    configured: () => true,
    current: async (): Promise<RequestIdentity | null> =>
      sample.requestIdentity,
    profile: async () => {
      throw new Error("decide() must not fetch a Clerk profile")
    },
  }
}

/**
 * A stub {@link UserAccountStore} whose `resolve` returns the account or the
 * failure the state carries. An `anonymous` state never reaches `resolve` — its
 * `identity.current()` is null — so `resolve` throws to prove that short-circuit
 * holds. `listForAdminPage` is never part of the guard path and throws too.
 */
function stubAccounts(sample: AuthorizationStateSample): UserAccountStore {
  return {
    resolve: async (): Promise<ResolveAccountResult> => {
      if (sample.account !== null) {
        return { kind: "account", account: sample.account }
      }
      if (sample.failure !== null) {
        return { kind: "unknown", failure: sample.failure }
      }
      throw new Error(
        "resolve() must not be reached for an anonymous request (Requirement 6.5)"
      )
    },
    listForAdminPage: async () => {
      throw new Error("listForAdminPage() is not part of the guard path")
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Detecting an Admin_Page value in a guard result                            */
/* -------------------------------------------------------------------------- */

/**
 * The field values of an account that must never appear in a non-admin guard
 * result, each long enough to make an accidental substring match implausible.
 * The `role` is deliberately excluded — `"member"`/`"admin"` are short common
 * words a message might contain — so leak detection turns on the identifying
 * fields the account actually carries.
 *
 * `clerkUserId` (prefixed `user_`), `email`, and `lastSignInAt` (an ISO
 * timestamp) are distinctive enough that finding one inside a serialized result
 * is a genuine leak signal. `displayName` is only distinctive when it carries
 * enough meaningful characters: a whitespace-only or one-to-few-character name
 * (e.g. a single space `" "`) trivially occurs inside the fixed English prose
 * of `notAuthorizedMessage()` / `authorizationUnknownMessage()`, so treating it
 * as a marker produces a seed-dependent false positive that cannot be told
 * apart from an incidental substring of that fixed prose. We therefore include
 * `displayName` only when its trimmed length is at least four characters —
 * mirroring the rare-marker/length threshold the `secretRedaction` test uses
 * for the same reason. This narrows false positives without narrowing real
 * coverage: a genuinely leaked account is still caught by `clerkUserId`,
 * `email`, and `lastSignInAt`, and by the structural `not.toHaveProperty(
 * "account")` assertion, which is unaffected.
 */
function accountLeakMarkers(account: UserAccountView): readonly string[] {
  return [
    account.clerkUserId,
    account.email,
    account.lastSignInAt,
    ...(account.displayName.trim().length >= 4 ? [account.displayName] : []),
  ]
}

/**
 * Asserts that a guard result carries no account: it holds no `account`
 * property, and its serialized form holds none of the account's identifying
 * field values. `account` here is the account the *admin* branch would have
 * carried, generated on the same state, so the assertion is "even the value an
 * admin request would have exposed is absent from a non-admin result".
 */
function expectNoAdminValue(
  result: AdminDocumentGuard | AdminServerFnGuard,
  account: UserAccountView | null
): void {
  expect(result).not.toHaveProperty("account")

  if (account === null) {
    return
  }
  const serialized = JSON.stringify(result)
  for (const marker of accountLeakMarkers(account)) {
    expect(serialized).not.toContain(marker)
  }
}

/* -------------------------------------------------------------------------- */
/* The property                                                               */
/* -------------------------------------------------------------------------- */

describe("Property 14: no Admin_Page value leaves the server for a non-admin request", () => {
  it("carries the account only for an admin decision, and never for anonymous, member, or unknown", async () => {
    await fc.assert(
      fc.asyncProperty(authorizationStateArb, async (sample) => {
        const authorization = createAuthorization({
          identity: stubIdentity(sample),
          accounts: stubAccounts(sample),
        })

        const decision = await authorization.decide()
        // The generated state and the real decision must name the same kind:
        // this is what lets the rest of the property trust the state's tag.
        expect(decision.kind).toBe(sample.kind)

        const guard =
          sample.endpoint === "document"
            ? requireAdminForDocument(decision)
            : requireAdminForServerFn(decision)

        if (sample.kind === "admin") {
          // The one state that may expose the account (Requirement 6.4).
          if (sample.endpoint === "document") {
            expect(guard).toEqual({
              kind: "proceed",
              account: sample.account,
            })
          } else {
            expect(guard).toEqual({
              kind: "authorized",
              account: sample.account,
            })
          }
          return
        }

        // Every non-admin state: no account, no Admin_Page value, whichever
        // endpoint asked (Requirements 6.5, 6.6, 6.7, 6.15).
        expect(guard.kind).not.toBe("proceed")
        expect(guard.kind).not.toBe("authorized")
        expectNoAdminValue(guard, sample.account)
      }),
      { numRuns: 300 }
    )
  })

  it("turns anonymous into a /sign-in redirect for a document and a NOT_AUTHENTICATED envelope for a server function", async () => {
    await fc.assert(
      fc.asyncProperty(
        authorizationStateArb.filter((sample) => sample.kind === "anonymous"),
        async (sample) => {
          const authorization = createAuthorization({
            identity: stubIdentity(sample),
            accounts: stubAccounts(sample),
          })
          const decision = await authorization.decide()
          expect(decision.kind).toBe("anonymous")

          if (sample.endpoint === "document") {
            // Requirement 6.5: a browser is redirected to sign in.
            expect(requireAdminForDocument(decision)).toEqual({
              kind: "redirect",
              location: SIGN_IN_PATH,
            })
          } else {
            // Requirement 6.7: a `fetch` caller gets an envelope, never a
            // redirect it would silently follow into an HTML document.
            const guard = requireAdminForServerFn(decision)
            expect(guard.kind).toBe("rejected")
            if (guard.kind !== "rejected") return
            expect(guard.envelope).toEqual({
              ok: false,
              error: {
                code: "NOT_AUTHENTICATED",
                message: NOT_AUTHENTICATED_MESSAGE,
              },
            })
          }
        }
      ),
      { numRuns: 100 }
    )
  })

  it("refuses a member with NOT_AUTHORIZED in both guard shapes", async () => {
    await fc.assert(
      fc.asyncProperty(
        authorizationStateArb.filter((sample) => sample.kind === "member"),
        async (sample) => {
          const authorization = createAuthorization({
            identity: stubIdentity(sample),
            accounts: stubAccounts(sample),
          })
          const decision = await authorization.decide()
          expect(decision.kind).toBe("member")

          if (sample.endpoint === "document") {
            // Requirement 6.6: refused with a message and no Admin_Page value.
            expect(requireAdminForDocument(decision)).toEqual({
              kind: "rejected",
              code: "NOT_AUTHORIZED",
              message: notAuthorizedMessage(),
            })
          } else {
            expect(requireAdminForServerFn(decision)).toEqual({
              kind: "rejected",
              envelope: {
                ok: false,
                error: {
                  code: "NOT_AUTHORIZED",
                  message: notAuthorizedMessage(),
                },
              },
            })
          }
        }
      ),
      { numRuns: 100 }
    )
  })

  it("refuses an unknown decision with AUTHORIZATION_UNKNOWN in both guard shapes", async () => {
    await fc.assert(
      fc.asyncProperty(
        authorizationStateArb.filter((sample) => sample.kind === "unknown"),
        async (sample) => {
          const authorization = createAuthorization({
            identity: stubIdentity(sample),
            accounts: stubAccounts(sample),
          })
          const decision = await authorization.decide()
          expect(decision.kind).toBe("unknown")

          if (sample.endpoint === "document") {
            // Requirement 6.15: authorization could not be determined.
            expect(requireAdminForDocument(decision)).toEqual({
              kind: "rejected",
              code: "AUTHORIZATION_UNKNOWN",
              message: authorizationUnknownMessage(),
            })
          } else {
            expect(requireAdminForServerFn(decision)).toEqual({
              kind: "rejected",
              envelope: {
                ok: false,
                error: {
                  code: "AUTHORIZATION_UNKNOWN",
                  message: authorizationUnknownMessage(),
                },
              },
            })
          }
        }
      ),
      { numRuns: 100 }
    )
  })
})
