/**
 * Unit tests for the independence of the two Access_Gate mechanisms — the
 * Passphrase_Session gate and the User_Session (Clerk) gate — and for the
 * post-sign-in destination the login flow relies on (Requirements 7.4, 7.6,
 * 7.7, 7.9, 7.10; 5.4 restated).
 *
 * The two seams the gate reads are deliberately modelled as independent
 * injected functions: the Passphrase_Session is read through a real
 * {@link createAuth} over injected secrets (`verifySessionCookieHeader`), and
 * the Clerk decision is read through the injected `resolveAuthorization`
 * resolver. Every test asserts that perturbing one seam does not perturb the
 * other, and that a valid Passphrase_Session never reaches the resolver at all
 * (so no Admin_Page value is read on the passphrase path).
 *
 * The import-graph test (Requirement 7.4) reads the module source with `fs` and
 * asserts a claim about what the module *cannot* do — that it statically imports
 * nothing from `@/server/store` or `@/server/run` — which is the only way to
 * test a negative structural property. `evaluateGate` is async; every call is
 * awaited.
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, it, vi } from "vitest"

import { createAuth } from "@/server/auth.server"
import type { AuthorizationDecision } from "@/server/authorization.server"
import { evaluateGate } from "@/server/gate.server"
import type { GateInput } from "@/server/gate.server"

const PASSPHRASE = "correct horse battery staple"
const SESSION_KEY = "k".repeat(32)

/** The gate module's source path, resolved relative to this test file. */
const GATE_SOURCE_PATH = fileURLToPath(
  new URL("../../src/server/gate.server.ts", import.meta.url)
)

/** An Access_Gate with a Shared_Passphrase configured (the gate is armed). */
const armedAuth = () =>
  createAuth({
    readSharedPassphrase: () => PASSPHRASE,
    readSessionSecret: () => SESSION_KEY,
  })

/** A resolver returning a fixed Account_Role decision (the Clerk seam). */
const resolverReturning =
  (decision: AuthorizationDecision): (() => Promise<AuthorizationDecision>) =>
  () =>
    Promise.resolve(decision)

/** A minimal `admin` Account_Role decision — no real Admin_Page value needed. */
const adminDecision = (): AuthorizationDecision => ({
  kind: "admin",
  account: { role: "admin" } as unknown as Extract<
    AuthorizationDecision,
    { kind: "admin" }
  >["account"],
})

/** A minimal `member` Account_Role decision. */
const memberDecision = (): AuthorizationDecision => ({
  kind: "member",
  account: { role: "member" } as unknown as Extract<
    AuthorizationDecision,
    { kind: "member" }
  >["account"],
})

/** Grants a Passphrase_Session and returns the `Cookie:` header value for it. */
const grantSessionCookie = (auth: ReturnType<typeof createAuth>): string => {
  const outcome = auth.submitPassphrase({
    sender: "203.0.113.7",
    submitted: PASSPHRASE,
  })
  if (outcome.kind !== "granted") {
    throw new Error("expected a granted Passphrase_Session")
  }
  return outcome.setCookie.split(";")[0]
}

/** Builds a `GateInput` for a document request against an armed gate. */
const documentRequest = (
  overrides: Partial<GateInput> &
    Pick<GateInput, "auth" | "resolveAuthorization">
): GateInput => ({
  pathname: "/roster",
  handlerType: "router",
  cookieHeader: null,
  clerkHandshake: false,
  ...overrides,
})

describe("gate.server.ts import-graph independence (Requirement 7.4)", () => {
  const source = readFileSync(GATE_SOURCE_PATH, "utf8")

  it("statically imports nothing from @/server/store", () => {
    expect(source).not.toMatch(/from\s+["']@\/server\/store/)
  })

  it("statically imports nothing from @/server/run", () => {
    expect(source).not.toMatch(/from\s+["']@\/server\/run/)
  })

  it("reaches @/server/authorization only as an erased type import", () => {
    // The one authorization import present must be a `import type` — a value
    // import would pull the store into the graph and break the guarantee.
    const authorizationImports = source.match(
      /^import[^\n]*from\s+["']@\/server\/authorization\.server["']/gm
    )
    expect(authorizationImports).not.toBeNull()
    for (const line of authorizationImports ?? []) {
      expect(line).toMatch(/^import\s+type\b/)
    }
  })
})

describe("passphrase alone reaches no Admin_Page value (Requirement 7.6)", () => {
  it("admits a valid Passphrase_Session without ever calling the resolver", async () => {
    const auth = armedAuth()
    const cookieHeader = grantSessionCookie(auth)
    const resolver = vi.fn(resolverReturning(adminDecision()))

    const decision = await evaluateGate(
      documentRequest({ auth, cookieHeader, resolveAuthorization: resolver })
    )

    expect(decision).toEqual({ kind: "admit", reason: "valid-session" })
    // No Account_Role, and therefore no Admin_Page value, was ever read.
    expect(resolver).not.toHaveBeenCalled()
  })
})

describe("independence of the Passphrase_Session and the Clerk session", () => {
  it("retains the Passphrase_Session when Clerk is signed out (Requirement 7.7)", async () => {
    // Clerk signed out ⇒ resolver returns `anonymous`; the Passphrase_Session
    // is still valid ⇒ the gate admits on `valid-session`. Signing out of Clerk
    // did not clear the passphrase session.
    const auth = armedAuth()
    const cookieHeader = grantSessionCookie(auth)
    const resolver = vi.fn(resolverReturning({ kind: "anonymous" }))

    const decision = await evaluateGate(
      documentRequest({ auth, cookieHeader, resolveAuthorization: resolver })
    )

    expect(decision).toEqual({ kind: "admit", reason: "valid-session" })
    expect(resolver).not.toHaveBeenCalled()
  })

  it("leaves the Clerk decision untouched by a wrong passphrase (Requirement 7.9)", async () => {
    // A wrong/invalid passphrase means the session verification is not "valid",
    // so the gate falls to the resolver. What the resolver returns is entirely
    // its own — the invalid passphrase does not perturb it. Prove it by driving
    // the same invalid-passphrase request against two different resolvers and
    // asserting each Clerk decision is honoured verbatim.
    const auth = armedAuth()
    const invalidCookie = "scr_session=not-a-real-token"

    const adminResolver = vi.fn(resolverReturning(adminDecision()))
    const adminDecisionResult = await evaluateGate(
      documentRequest({
        auth,
        cookieHeader: invalidCookie,
        resolveAuthorization: adminResolver,
      })
    )
    expect(adminDecisionResult).toEqual({
      kind: "admit",
      reason: "admin-authorized",
    })
    expect(adminResolver).toHaveBeenCalledTimes(1)

    const anonResolver = vi.fn(resolverReturning({ kind: "anonymous" }))
    const anonDecisionResult = await evaluateGate(
      documentRequest({
        auth,
        cookieHeader: invalidCookie,
        resolveAuthorization: anonResolver,
      })
    )
    expect(anonDecisionResult.kind).toBe("reject")
    expect(anonResolver).toHaveBeenCalledTimes(1)
  })

  it("leaves the Clerk decision untouched by an expired Passphrase_Session (Requirement 7.10)", async () => {
    // An expired Passphrase_Session verifies as kind "expired" (not "valid"),
    // so the gate falls to step 4 and the Clerk decision is whatever the
    // resolver says — the expiry does not touch it. Build a session that has
    // already expired by advancing the injected clock past its TTL.
    let clock = 1_000_000
    const auth = createAuth({
      readSharedPassphrase: () => PASSPHRASE,
      readSessionSecret: () => SESSION_KEY,
      now: () => clock,
      sessionTtlMs: 1_000,
    })

    const cookieHeader = grantSessionCookie(auth)
    clock += 5_000 // past the 1s TTL: the Passphrase_Session is now expired

    // Confirm the passphrase seam reports expiry independently.
    expect(auth.verifySessionCookieHeader(cookieHeader).kind).toBe("expired")

    const resolver = vi.fn(resolverReturning(adminDecision()))
    const decision = await evaluateGate(
      documentRequest({ auth, cookieHeader, resolveAuthorization: resolver })
    )

    // The Clerk (admin) decision is honoured, untouched by the expiry.
    expect(decision).toEqual({ kind: "admit", reason: "admin-authorized" })
    expect(resolver).toHaveBeenCalledTimes(1)
  })
})

describe("post-sign-in destination, admin and member (5.4 restated)", () => {
  it("admits when the resolved Account_Role is admin", async () => {
    const auth = armedAuth()
    const decision = await evaluateGate(
      documentRequest({
        auth,
        resolveAuthorization: resolverReturning(adminDecision()),
      })
    )

    expect(decision).toEqual({ kind: "admit", reason: "admin-authorized" })
  })

  it("rejects a member with the passphrase-only need", async () => {
    const auth = armedAuth()
    const decision = await evaluateGate(
      documentRequest({
        auth,
        resolveAuthorization: resolverReturning(memberDecision()),
      })
    )

    expect(decision.kind).toBe("reject")
    if (decision.kind !== "reject") return
    expect(decision.needs).toBe("passphrase")
  })
})
