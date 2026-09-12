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
import {
  evaluateGate,
  gateRejectionResponse,
  isGateExemptPath,
} from "@/server/gate.server"

const PASSPHRASE = "correct horse battery staple"
const SESSION_KEY = "k".repeat(32)

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
  it("admits every request when no Shared_Passphrase is configured", () => {
    const auth = openAuth()

    for (const facts of [
      { pathname: "/roster", handlerType: "router" as const },
      { pathname: "/_serverFn/abc123", handlerType: "serverFn" as const },
    ]) {
      expect(evaluateGate({ auth, cookieHeader: null, ...facts })).toEqual({
        kind: "admit",
        reason: "gate-disabled",
      })
    }
  })

  it("rejects a server function call that carries no Session", () => {
    const decision = evaluateGate({
      auth: armedAuth(),
      pathname: "/_serverFn/abc123",
      handlerType: "serverFn",
      cookieHeader: null,
    })

    expect(decision.kind).toBe("reject")
    if (decision.kind !== "reject") return

    expect(decision.reason).toBe("missing")
    expect(decision.status).toBe(401)
    expect(decision.location).toBeNull()
    expect(decision.body).toContain("SESSION_REQUIRED")
    expect(decision.body).toContain("/login")
    expect(decision.body).not.toContain(PASSPHRASE)

    const response = gateRejectionResponse(decision)
    expect(response.status).toBe(401)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("location")).toBeNull()
  })

  it("sends a document request without a Session to the login route", () => {
    const decision = evaluateGate({
      auth: armedAuth(),
      pathname: "/history",
      handlerType: "router",
      cookieHeader: "scr_session=not-a-real-token",
    })

    expect(decision.kind).toBe("reject")
    if (decision.kind !== "reject") return

    expect(decision.reason).toBe("malformed")
    expect(decision.status).toBe(303)
    expect(decision.loginPath).toBe("/login")
    expect(decision.body).not.toContain(PASSPHRASE)

    const response = gateRejectionResponse(decision)
    expect(response.headers.get("location")).toBe("/login")
  })

  it("admits a request that carries a granted Session", () => {
    const auth = armedAuth()
    const outcome = auth.submitPassphrase({
      sender: "203.0.113.7",
      submitted: PASSPHRASE,
    })

    expect(outcome.kind).toBe("granted")
    if (outcome.kind !== "granted") return

    const cookieHeader = outcome.setCookie.split(";")[0]

    expect(
      evaluateGate({
        auth,
        pathname: "/roster",
        handlerType: "router",
        cookieHeader,
      })
    ).toEqual({ kind: "admit", reason: "valid-session" })
  })

  it("rejects a request whose Session was ended", () => {
    const auth = armedAuth()
    const outcome = auth.submitPassphrase({
      sender: "203.0.113.7",
      submitted: PASSPHRASE,
    })
    if (outcome.kind !== "granted") throw new Error("expected a Session")

    const cookieHeader = outcome.setCookie.split(";")[0]
    auth.logout(cookieHeader)

    const decision = evaluateGate({
      auth,
      pathname: "/_serverFn/abc123",
      handlerType: "serverFn",
      cookieHeader,
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
    expect(isGateExemptPath("/_buildish/x.js", "router")).toBe(false)
    expect(isGateExemptPath("/@fs/etc/passwd", "router")).toBe(false)
  })
})
