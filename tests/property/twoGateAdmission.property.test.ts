// Feature: mongodb-google-auth-admin, Property 17: The Access_Gate admits exactly four kinds of request
//
// Validates: Requirements 7.1, 7.2, 7.3, 7.5, 7.8.
//
// *For any* gate-fact tuple — the Shared_Passphrase configured or not, a
// pathname drawn from the exempt entries, the exempt prefixes, and arbitrary
// non-exempt and server-function paths, the handler type, the Clerk handshake
// flag, the Passphrase_Session verdict, and the resolved authorization kind —
// the async `evaluateGate` produces exactly one of the four admit reasons or a
// rejection, matching the gate's ordered rule:
//
//   1. no Shared_Passphrase configured  ⇒ admit "gate-disabled"        (7.5)
//   2. Clerk handshake                  ⇒ admit "clerk-handshake"      (7.3)
//   3. exempt router path               ⇒ admit "exempt-path"
//   4. valid Passphrase_Session         ⇒ admit "valid-session"        (7.1)
//   5. resolved Account_Role: admin     ⇒ admit "admin-authorized"     (7.1)
//                             member    ⇒ reject needs "passphrase"    (7.2)
//                    anonymous|unknown  ⇒ reject "passphrase-and-sign-in" (7.8)
//
// ## The resolver is consulted only on the step-5 path
//
// `resolveAuthorization` is injected as a spy whose call count is checked on
// every run: steps 1–4 must admit without ever reaching it, and only the
// fall-through to step 5 may call it, exactly once. The generated tuple carries
// `resolverExpected`, computed independently from the same ordered rule, so the
// property asserts the real call count against a value derived outside
// `evaluateGate` rather than restating the decision inline.
//
// ## No Clerk, no Mongo, no socket
//
// `auth` is a two-function literal (`passphraseRequired`,
// `verifySessionCookieHeader`) and `resolveAuthorization` is a plain async
// function, exactly the seams `GateInput` is built to receive, so the real
// decision runs with no process-wide state.

import fc from "fast-check"
import { describe, expect, it } from "vitest"

import type { UserAccountView } from "@/domain/accounts"
import type { StoreFailure } from "@/domain/types"
import { evaluateGate } from "@/server/gate.server"
import type { GateAuth, GateInput } from "@/server/gate.server"
import type { AuthorizationDecision } from "@/server/authorization.server"
import type { SessionPayload, SessionVerification } from "@/server/auth.server"

import { gateFactsArb } from "./generators"
import type { GateAuthorizationKind, GateSessionKind } from "./generators"

/* -------------------------------------------------------------------------- */
/* Building the injected seams from a generated tuple                         */
/* -------------------------------------------------------------------------- */

/** A stub {@link GateAuth} armed (or not) and returning the given verdict. */
function stubAuth(
  passphraseRequired: boolean,
  sessionKind: GateSessionKind
): GateAuth {
  return {
    passphraseRequired: () => passphraseRequired,
    verifySessionCookieHeader: (): SessionVerification =>
      // The gate branches on `.kind` alone and never reads the payload, so a
      // minimal `SessionPayload` suffices for the valid case.
      sessionKind === "valid"
        ? { kind: "valid", session: VALID_SESSION_PAYLOAD }
        : { kind: sessionKind },
  }
}

/** A minimal valid {@link SessionPayload}; the gate never inspects its fields. */
const VALID_SESSION_PAYLOAD: SessionPayload = {
  id: "sess_gate_property",
  issuedAt: 0,
  expiresAt: 1,
}

/** A stored account for an admin/member decision; its fields are never read. */
const STUB_ACCOUNT: UserAccountView = {
  clerkUserId: "user_gate_property",
  email: "gate@example.com",
  displayName: "Gate Property",
  role: "admin",
  lastSignInAt: "2025-01-04T18:00:00.000Z",
}

/** A resolve failure for the `unknown` decision; its message is never read. */
const STUB_FAILURE: StoreFailure = {
  reason: "unreachable",
  message: "unreachable",
}

/** The {@link AuthorizationDecision} a generated authorization kind stands for. */
function decisionForKind(kind: GateAuthorizationKind): AuthorizationDecision {
  switch (kind) {
    case "admin":
      return { kind: "admin", account: { ...STUB_ACCOUNT, role: "admin" } }
    case "member":
      return { kind: "member", account: { ...STUB_ACCOUNT, role: "member" } }
    case "anonymous":
      return { kind: "anonymous" }
    case "unknown":
      return { kind: "unknown", failure: STUB_FAILURE }
  }
}

/**
 * A `resolveAuthorization` spy: it counts its calls, so the property can assert
 * the resolver is reached only on the step-5 fall-through and never on a tuple
 * an earlier step already decided.
 */
function spyResolver(kind: GateAuthorizationKind): {
  resolve: GateInput["resolveAuthorization"]
  calls: () => number
} {
  let calls = 0
  return {
    resolve: async () => {
      calls += 1
      return decisionForKind(kind)
    },
    calls: () => calls,
  }
}

/* -------------------------------------------------------------------------- */
/* The property                                                               */
/* -------------------------------------------------------------------------- */

describe("Property 17: the Access_Gate admits exactly four kinds of request", () => {
  it("matches the ordered rule and calls the resolver only on the step-5 fall-through", async () => {
    await fc.assert(
      fc.asyncProperty(gateFactsArb, async (facts) => {
        const resolver = spyResolver(facts.authorizationKind)

        const decision = await evaluateGate({
          auth: stubAuth(facts.passphraseRequired, facts.sessionKind),
          pathname: facts.pathname,
          handlerType: facts.handlerType,
          cookieHeader: null,
          clerkHandshake: facts.clerkHandshake,
          resolveAuthorization: resolver.resolve,
        })

        // The resolver is consulted exactly when — and only when — steps 1–4
        // did not already decide (Requirement 7.1: the common valid-session
        // path pays for no resolver call).
        expect(resolver.calls()).toBe(facts.resolverExpected ? 1 : 0)

        if (facts.expectedAdmitReason !== null) {
          // One of the four admit reasons, matching the ordered rule.
          expect(decision).toEqual({
            kind: "admit",
            reason: facts.expectedAdmitReason,
          })
          return
        }

        // A rejection: member needs the passphrase alone (7.2); anonymous and
        // unknown need both the passphrase and a sign-in (7.8).
        expect(decision.kind).toBe("reject")
        if (decision.kind !== "reject") return
        const expectedNeeds =
          facts.authorizationKind === "member"
            ? "passphrase"
            : "passphrase-and-sign-in"
        expect(decision.needs).toBe(expectedNeeds)
        // The rejection reports the invalid session verdict, never "valid".
        expect(decision.reason).toBe(facts.sessionKind)
        expect(decision.reason).not.toBe("valid")
      }),
      { numRuns: 300 }
    )
  })

  it("admits every request when the gate is disabled, without reaching the resolver", async () => {
    await fc.assert(
      fc.asyncProperty(
        gateFactsArb.filter((facts) => !facts.passphraseRequired),
        async (facts) => {
          const resolver = spyResolver(facts.authorizationKind)
          const decision = await evaluateGate({
            auth: stubAuth(false, facts.sessionKind),
            pathname: facts.pathname,
            handlerType: facts.handlerType,
            cookieHeader: null,
            clerkHandshake: facts.clerkHandshake,
            resolveAuthorization: resolver.resolve,
          })

          // Requirement 7.5: gate off ⇒ admit everything, no resolver call.
          expect(decision).toEqual({ kind: "admit", reason: "gate-disabled" })
          expect(resolver.calls()).toBe(0)
        }
      ),
      { numRuns: 100 }
    )
  })

  it("never exempts a server-function request by path", async () => {
    await fc.assert(
      fc.asyncProperty(
        gateFactsArb.filter(
          (facts) =>
            facts.passphraseRequired &&
            !facts.clerkHandshake &&
            facts.handlerType === "serverFn"
        ),
        async (facts) => {
          const resolver = spyResolver(facts.authorizationKind)
          const decision = await evaluateGate({
            auth: stubAuth(true, facts.sessionKind),
            pathname: facts.pathname,
            handlerType: "serverFn",
            cookieHeader: null,
            clerkHandshake: false,
            resolveAuthorization: resolver.resolve,
          })

          // No path admits a server function: it can only reach step 4
          // (valid session) or step 5 (the resolver). "exempt-path" is
          // impossible whatever the pathname.
          if (decision.kind === "admit") {
            expect(decision.reason).not.toBe("exempt-path")
          }
        }
      ),
      { numRuns: 100 }
    )
  })
})
