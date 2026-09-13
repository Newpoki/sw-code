/**
 * The request middleware chain, exercised without a socket (Requirements 7.1,
 * 7.3, 7.4).
 *
 * `src/start.ts` runs three request middlewares in order — csrf,
 * `clerkMiddleware()`, then the Access_Gate `passphraseMiddleware`. The gate
 * middleware computes a `clerkHandshake` fact from the request URL's query
 * parameters, calls {@link evaluateGate}, and — only when the decision rejects —
 * returns {@link gateRejectionResponse}, which short-circuits the chain so the
 * handler below (and therefore every store module) is never reached. When the
 * decision admits it calls `next()`, leaving `clerkMiddleware()`'s `Set-Cookie`
 * intact.
 *
 * This file transcribes that wiring — the handshake computation and the
 * reject/admit branch — over the injected {@link GateAuth} seam and a spy
 * resolver, so the chain's behaviour is asserted with no server booted. It does
 * not repeat the passphrase-only flows of `tests/integration/accessGate.test.ts`;
 * it covers the two claims the second dimension of the gate adds:
 *
 * 1. a gated request never reaches a store module — the reject short-circuits
 *    before `next()`, and the common valid-session case admits without the
 *    authorization resolver being called at all (no Mongo read); and
 * 2. a Clerk handshake is admitted so its `Set-Cookie` is not discarded — for
 *    both handshake query parameters, even on a non-exempt path with no valid
 *    session.
 */

import { describe, expect, it, vi } from "vitest"

import {
  CLERK_HANDSHAKE_QUERY_PARAMS,
  evaluateGate,
  gateRejectionResponse,
} from "@/server/gate.server"

import type { Auth, SessionVerification } from "@/server/auth.server"
import type { AuthorizationDecision } from "@/server/authorization.server"
import type { GateAuth, GateHandlerType } from "@/server/gate.server"

/** A non-exempt document path: the roster, which no stranger may read. */
const GATED_PATH = "/roster"

/**
 * A {@link GateAuth} with the gate armed and a fixed verdict on any `Cookie:`
 * header. Only the two members the gate reads are provided; the rest of
 * {@link Auth} is never touched on this path.
 */
function stubAuth(verification: SessionVerification): GateAuth {
  return {
    passphraseRequired: () => true,
    verifySessionCookieHeader: () => verification,
  } satisfies Pick<Auth, "passphraseRequired" | "verifySessionCookieHeader">
}

/** A verdict standing for a request that carried no session cookie. */
const NO_SESSION: SessionVerification = { kind: "missing" }

/** A verdict standing for a request that carried a valid Passphrase_Session. */
const VALID_SESSION: SessionVerification = {
  kind: "valid",
  session: {
    id: "session-under-test",
    issuedAt: Date.parse("2025-01-04T12:00:00.000Z"),
    expiresAt: Date.parse("2025-01-05T12:00:00.000Z"),
  },
}

/**
 * A spy authorization resolver returning `anonymous` — the verdict for a sender
 * with no Clerk session. Its call count stands for a Mongo read having been
 * paid for (Requirement 7.1).
 */
function anonymousResolver(): () => Promise<AuthorizationDecision> {
  return vi.fn(() =>
    Promise.resolve<AuthorizationDecision>({ kind: "anonymous" })
  )
}

/** The result of running the gate middleware over one request. */
interface ChainStep {
  /** True only when the gate admitted and the chain proceeded to `next()`. */
  readonly reachedNext: boolean
  /** The short-circuit response the reject branch produced, if any. */
  readonly rejection: Response | null
  /** What the gate decided. */
  readonly reason: string
}

/**
 * Transcribes `src/start.ts`'s gate middleware: compute the handshake fact from
 * the request URL exactly as it does, evaluate the gate, and on reject return
 * the short-circuit response (never calling `next()`), else proceed.
 *
 * `next` is a sentinel: the store read lives on the far side of it, so a chain
 * step whose `reachedNext` is false demonstrably read nothing.
 */
async function runGateMiddleware(options: {
  auth: GateAuth
  request: Request
  pathname: string
  handlerType: GateHandlerType
  resolveAuthorization: () => Promise<AuthorizationDecision>
}): Promise<ChainStep> {
  const searchParams = new URL(options.request.url).searchParams
  const clerkHandshake = CLERK_HANDSHAKE_QUERY_PARAMS.some((param) =>
    searchParams.has(param)
  )

  const decision = await evaluateGate({
    auth: options.auth,
    pathname: options.pathname,
    handlerType: options.handlerType,
    cookieHeader: options.request.headers.get("cookie"),
    clerkHandshake,
    resolveAuthorization: options.resolveAuthorization,
  })

  if (decision.kind === "reject") {
    return {
      reachedNext: false,
      rejection: gateRejectionResponse(decision),
      reason: decision.reason,
    }
  }

  return { reachedNext: true, rejection: null, reason: decision.reason }
}

describe("a gated request never reaches a store (Requirements 7.1, 7.4)", () => {
  it("short-circuits the chain with a Response before next(), so no handler runs", async () => {
    const resolveAuthorization = anonymousResolver()

    const step = await runGateMiddleware({
      auth: stubAuth(NO_SESSION),
      request: new Request(`http://localhost:3000${GATED_PATH}`),
      pathname: GATED_PATH,
      handlerType: "router",
      resolveAuthorization,
    })

    // The chain ended in the middleware: next() — and every store behind it —
    // was never reached.
    expect(step.reachedNext).toBe(false)
    expect(step.rejection).toBeInstanceOf(Response)
    expect(step.reason).toBe("missing")

    // A rejection is a plain short-circuit Response, not a store payload: it
    // sets no cookie and directs a document back to the login page.
    const rejection = step.rejection as Response
    expect(rejection.status).toBe(303)
    expect(rejection.headers.get("location")).toBe("/login")
    expect(rejection.headers.get("set-cookie")).toBeNull()
  })

  it("admits a valid Passphrase_Session without calling the resolver, so the common case adds no Mongo read (7.1)", async () => {
    const resolveAuthorization = anonymousResolver()

    const step = await runGateMiddleware({
      auth: stubAuth(VALID_SESSION),
      request: new Request(`http://localhost:3000${GATED_PATH}`, {
        headers: { cookie: "session=valid" },
      }),
      pathname: GATED_PATH,
      handlerType: "router",
      resolveAuthorization,
    })

    expect(step.reachedNext).toBe(true)
    expect(step.rejection).toBeNull()
    expect(step.reason).toBe("valid-session")

    // The gate short-circuited at the valid-session step, so the resolver — the
    // one path that reads Mongo — was never invoked.
    expect(resolveAuthorization).not.toHaveBeenCalled()
  })
})

describe("a Clerk handshake is admitted and keeps its Set-Cookie (Requirement 7.3)", () => {
  it.each(CLERK_HANDSHAKE_QUERY_PARAMS)(
    "admits a request carrying %s on a non-exempt path, so clerkMiddleware()'s cookie is not discarded",
    async (handshakeParam) => {
      const resolveAuthorization = anonymousResolver()

      // A handshake request: non-exempt path, no valid session, anonymous
      // sender — exactly the request that would otherwise be rejected.
      const step = await runGateMiddleware({
        auth: stubAuth(NO_SESSION),
        request: new Request(
          `http://localhost:3000${GATED_PATH}?${handshakeParam}=handshake-token`
        ),
        pathname: GATED_PATH,
        handlerType: "router",
        resolveAuthorization,
      })

      // Admitted for the handshake reason: the chain proceeds to next(), so
      // clerkMiddleware()'s Set-Cookie survives; no rejection Response is built.
      expect(step.reachedNext).toBe(true)
      expect(step.rejection).toBeNull()
      expect(step.reason).toBe("clerk-handshake")

      // The handshake is admitted at step 2, before the session is even read,
      // so the resolver is never called either.
      expect(resolveAuthorization).not.toHaveBeenCalled()
    }
  )

  it("rejects the same non-exempt request once its handshake parameter is gone", async () => {
    const resolveAuthorization = anonymousResolver()

    // The identical request without the handshake query parameter is refused,
    // which is what makes the admissions above attributable to the handshake.
    const step = await runGateMiddleware({
      auth: stubAuth(NO_SESSION),
      request: new Request(`http://localhost:3000${GATED_PATH}`),
      pathname: GATED_PATH,
      handlerType: "router",
      resolveAuthorization,
    })

    expect(step.reachedNext).toBe(false)
    expect(step.rejection).toBeInstanceOf(Response)
  })
})
