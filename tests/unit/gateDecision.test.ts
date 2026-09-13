/**
 * Unit tests for the Access_Gate decision function (Requirements 8.2, 8.3, 8.9).
 *
 * These exercise `evaluateGate` and `gateRejectionResponse` directly, with a
 * real {@link createAuth} over injected secrets, so no server, socket, or
 * browser is involved. Property 24 (`tests/property/`) covers the same rule over
 * generated input; the gate's behaviour over live requests is covered by the
 * integration tests.
 */

import { describe, expect, it } from "vitest"

import { createAuth } from "@/server/auth.server"
import type { AuthorizationDecision } from "@/server/authorization.server"
import {
  evaluateGate,
  gateRejectionResponse,
  isGateExemptPath,
} from "@/server/gate.server"

const PASSPHRASE = "correct horse battery staple"
const SESSION_KEY = "k".repeat(32)

/**
 * A resolver that must never run. Most of these cases are decided at steps 1–3,
 * before authorization is resolved; using this as the default proves the
 * short-circuit holds (Requirement 7.1).
 */
const resolverNeverCalled = (): Promise<AuthorizationDecision> => {
  throw new Error("resolveAuthorization must not be called on this path")
}

/** A resolver that returns a fixed Account_Role decision, for step-4 cases. */
const resolverReturning =
  (decision: AuthorizationDecision): (() => Promise<AuthorizationDecision>) =>
  () =>
    Promise.resolve(decision)

/** An Access_Gate with a Shared_Passphrase configured. */
const armedAuth = () =>
  createAuth({
    readSharedPassphrase: () => PASSPHRASE,
    readSessionSecret: () => SESSION_KEY,
  })

/** An Access_Gate with no Shared_Passphrase configured. */
const openAuth = () =>
  createAuth({
    readSharedPassphrase: () => null,
    readSessionSecret: () => SESSION_KEY,
  })

describe("evaluateGate", () => {
  it("admits every request when no Shared_Passphrase is configured", async () => {
    const auth = openAuth()

    for (const facts of [
      { pathname: "/roster", handlerType: "router" as const },
      { pathname: "/_serverFn/abc123", handlerType: "serverFn" as const },
    ]) {
      expect(
        await evaluateGate({
          auth,
          cookieHeader: null,
          clerkHandshake: false,
          resolveAuthorization: resolverNeverCalled,
          ...facts,
        })
      ).toEqual({
        kind: "admit",
        reason: "gate-disabled",
      })
    }
  })

  it("admits a Clerk handshake without resolving authorization", async () => {
    expect(
      await evaluateGate({
        auth: armedAuth(),
        pathname: "/roster",
        handlerType: "router",
        cookieHeader: null,
        clerkHandshake: true,
        resolveAuthorization: resolverNeverCalled,
      })
    ).toEqual({ kind: "admit", reason: "clerk-handshake" })
  })

  it("rejects a server function call that carries no Session", async () => {
    const decision = await evaluateGate({
      auth: armedAuth(),
      pathname: "/_serverFn/abc123",
      handlerType: "serverFn",
      cookieHeader: null,
      clerkHandshake: false,
      resolveAuthorization: resolverReturning({ kind: "anonymous" }),
    })

    expect(decision.kind).toBe("reject")
    if (decision.kind !== "reject") return

    expect(decision.reason).toBe("missing")
    expect(decision.status).toBe(401)
    expect(decision.location).toBeNull()
    expect(decision.needs).toBe("passphrase-and-sign-in")
    expect(decision.signInPath).toBe("/sign-in")
    expect(decision.body).toContain("SESSION_REQUIRED")
    expect(decision.body).toContain("/login")
    expect(decision.body).not.toContain(PASSPHRASE)

    const response = gateRejectionResponse(decision)
    expect(response.status).toBe(401)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("location")).toBeNull()
  })

  it("sends a document request without a Session to the login route", async () => {
    const decision = await evaluateGate({
      auth: armedAuth(),
      pathname: "/history",
      handlerType: "router",
      cookieHeader: "scr_session=not-a-real-token",
      clerkHandshake: false,
      resolveAuthorization: resolverReturning({ kind: "anonymous" }),
    })

    expect(decision.kind).toBe("reject")
    if (decision.kind !== "reject") return

    expect(decision.reason).toBe("malformed")
    expect(decision.status).toBe(303)
    expect(decision.loginPath).toBe("/login")
    expect(decision.needs).toBe("passphrase-and-sign-in")
    expect(decision.body).not.toContain(PASSPHRASE)

    const response = gateRejectionResponse(decision)
    expect(response.headers.get("location")).toBe("/login")
  })

  it("directs a signed-in member to submit the passphrase and nothing else", async () => {
    const account = {
      role: "member" as const,
    } as unknown as Extract<
      AuthorizationDecision,
      { kind: "member" }
    >["account"]

    const decision = await evaluateGate({
      auth: armedAuth(),
      pathname: "/roster",
      handlerType: "router",
      cookieHeader: null,
      clerkHandshake: false,
      resolveAuthorization: resolverReturning({ kind: "member", account }),
    })

    expect(decision.kind).toBe("reject")
    if (decision.kind !== "reject") return
    expect(decision.needs).toBe("passphrase")
    expect(decision.loginPath).toBe("/login")
    expect(decision.signInPath).toBe("/sign-in")
  })

  it("admits a request whose resolved Account_Role is admin", async () => {
    const account = {
      role: "admin" as const,
    } as unknown as Extract<AuthorizationDecision, { kind: "admin" }>["account"]

    expect(
      await evaluateGate({
        auth: armedAuth(),
        pathname: "/roster",
        handlerType: "router",
        cookieHeader: null,
        clerkHandshake: false,
        resolveAuthorization: resolverReturning({ kind: "admin", account }),
      })
    ).toEqual({ kind: "admit", reason: "admin-authorized" })
  })

  it("admits a request that carries a granted Session", async () => {
    const auth = armedAuth()
    const outcome = auth.submitPassphrase({
      sender: "203.0.113.7",
      submitted: PASSPHRASE,
    })

    expect(outcome.kind).toBe("granted")
    if (outcome.kind !== "granted") return

    const cookieHeader = outcome.setCookie.split(";")[0]

    expect(
      await evaluateGate({
        auth,
        pathname: "/roster",
        handlerType: "router",
        cookieHeader,
        clerkHandshake: false,
        resolveAuthorization: resolverNeverCalled,
      })
    ).toEqual({ kind: "admit", reason: "valid-session" })
  })

  it("rejects a request whose Session was ended", async () => {
    const auth = armedAuth()
    const outcome = auth.submitPassphrase({
      sender: "203.0.113.7",
      submitted: PASSPHRASE,
    })
    if (outcome.kind !== "granted") throw new Error("expected a Session")

    const cookieHeader = outcome.setCookie.split(";")[0]
    auth.logout(cookieHeader)

    const decision = await evaluateGate({
      auth,
      pathname: "/_serverFn/abc123",
      handlerType: "serverFn",
      cookieHeader,
      clerkHandshake: false,
      resolveAuthorization: resolverReturning({ kind: "anonymous" }),
    })

    expect(decision.kind).toBe("reject")
    if (decision.kind !== "reject") return
    expect(decision.reason).toBe("revoked")
  })
})

describe("isGateExemptPath", () => {
  it("exempts the login route and the files the login page needs", () => {
    expect(isGateExemptPath("/login", "router")).toBe(true)
    expect(isGateExemptPath("/login/", "router")).toBe(true)
    expect(isGateExemptPath("/assets/index-abc123.js", "router")).toBe(true)
    expect(isGateExemptPath("/_build/entry.js", "router")).toBe(true)
    expect(isGateExemptPath("/favicon.ico", "router")).toBe(true)
  })

  it("exempts the sign-in surface and the sign-in return path", () => {
    expect(isGateExemptPath("/sign-in", "router")).toBe(true)
    expect(isGateExemptPath("/sign-in/", "router")).toBe(true)
    expect(isGateExemptPath("/sign-in/factor-one", "router")).toBe(true)
    expect(isGateExemptPath("/sign-up", "router")).toBe(true)
    expect(isGateExemptPath("/sign-up/verify-email-address", "router")).toBe(
      true
    )
    expect(isGateExemptPath("/sso-callback", "router")).toBe(true)
  })

  it("exempts no server function on the sign-in paths either", () => {
    expect(isGateExemptPath("/sign-in", "serverFn")).toBe(false)
    expect(isGateExemptPath("/sign-in/factor-one", "serverFn")).toBe(false)
    expect(isGateExemptPath("/sso-callback", "serverFn")).toBe(false)
  })

  it("exempts no server function, whatever the path looks like", () => {
    expect(isGateExemptPath("/login", "serverFn")).toBe(false)
    expect(isGateExemptPath("/assets/index-abc123.js", "serverFn")).toBe(false)
    expect(isGateExemptPath("/_serverFn/abc123", "serverFn")).toBe(false)
  })

  it("exempts no other document, and matches prefixes on a boundary", () => {
    expect(isGateExemptPath("/", "router")).toBe(false)
    expect(isGateExemptPath("/roster", "router")).toBe(false)
    expect(isGateExemptPath("/history", "router")).toBe(false)
    expect(isGateExemptPath("/loginish", "router")).toBe(false)
    expect(isGateExemptPath("/sign-inish", "router")).toBe(false)
    expect(isGateExemptPath("/_buildish/x.js", "router")).toBe(false)
    expect(isGateExemptPath("/@fs/etc/passwd", "router")).toBe(false)
  })
})
