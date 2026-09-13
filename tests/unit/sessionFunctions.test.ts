/**
 * The client-visible session projection the shell reads to gate the admin
 * navigation link (Requirements 6.11, 6.12).
 *
 * These exercise `sessionRoleEnvelope` from
 * `src/functions/session.functions.ts` directly, over an
 * `AuthorizationDecision` literal: no `createServerFn` call site, no HTTP, no
 * Clerk, and no Mongo. The projection is the shell's whole input for the admin
 * link, so its four cases — admin, member, anonymous, unknown — are the four
 * identity states the link decision distinguishes, and only `admin` yields a
 * role the link is shown for.
 */

import { describe, expect, it } from "vitest"

import {
  getSessionRole,
  sessionRoleEnvelope,
} from "@/functions/session.functions"
import type { UserAccountView } from "@/domain/accounts"
import type {
  AuthorizationDecision,
  Authorization,
} from "@/server/authorization.server"
import type { StoreFailure } from "@/domain/types"

/** A mirrored account carrying the given role, with otherwise fixed fields. */
function accountWith(role: "admin" | "member"): UserAccountView {
  return {
    clerkUserId: "user_zzz-distinctive-clerk-id-zzz",
    email: "person@example.com",
    displayName: "A Person",
    role,
    lastSignInAt: "2024-01-01T00:00:00.000Z",
  }
}

/** The `unknown` decision's underlying store failure. */
const UNKNOWN_FAILURE: StoreFailure = {
  reason: "unreachable",
  message: "The database is currently unavailable. Try again shortly.",
}

describe("sessionRoleEnvelope projects the decision to the admin-link role (Requirements 6.11, 6.12)", () => {
  it("reports the Admin_Role for an admin decision", () => {
    const decision: AuthorizationDecision = {
      kind: "admin",
      account: accountWith("admin"),
    }

    expect(sessionRoleEnvelope(decision)).toEqual({
      ok: true,
      data: { role: "admin" },
      warnings: [],
    })
  })

  it("reports the Member_Role for a member decision, which withholds the link", () => {
    const decision: AuthorizationDecision = {
      kind: "member",
      account: accountWith("member"),
    }

    expect(sessionRoleEnvelope(decision)).toEqual({
      ok: true,
      data: { role: "member" },
      warnings: [],
    })
  })

  it("reports no role for an anonymous decision (Requirement 6.11: no session, no link)", () => {
    const decision: AuthorizationDecision = { kind: "anonymous" }

    expect(sessionRoleEnvelope(decision)).toEqual({
      ok: true,
      data: { role: null },
      warnings: [],
    })
  })

  it("reports no role for an unknown decision — unknown means withhold (Requirement 6.12)", () => {
    const decision: AuthorizationDecision = {
      kind: "unknown",
      failure: UNKNOWN_FAILURE,
    }

    expect(sessionRoleEnvelope(decision)).toEqual({
      ok: true,
      data: { role: null },
      warnings: [],
    })
  })

  it("carries exactly the role key and nothing else", () => {
    const envelope = sessionRoleEnvelope({
      kind: "admin",
      account: accountWith("admin"),
    })

    expect(envelope.ok).toBe(true)
    if (!envelope.ok) return
    expect(Object.keys(envelope.data)).toEqual(["role"])
  })

  it("is a read, so it succeeds with no warning", () => {
    const envelope = sessionRoleEnvelope({ kind: "anonymous" })

    expect(envelope.ok).toBe(true)
    if (!envelope.ok) return
    expect(envelope.warnings).toEqual([])
  })
})

describe("no account identifier reaches the Web_Client through the session projection (Requirement 8.10)", () => {
  it("serializes an admin decision to the role alone, with no email or Clerk id", () => {
    const serialized = JSON.stringify(
      sessionRoleEnvelope({ kind: "admin", account: accountWith("admin") })
    )

    expect(serialized).toBe('{"ok":true,"data":{"role":"admin"},"warnings":[]}')
  })

  it("carries no underlying failure text for an unknown decision", () => {
    const serialized = JSON.stringify(
      sessionRoleEnvelope({ kind: "unknown", failure: UNKNOWN_FAILURE })
    )

    expect(serialized).not.toContain(UNKNOWN_FAILURE.message)
    expect(serialized).toBe('{"ok":true,"data":{"role":null},"warnings":[]}')
  })
})

describe("getSessionRole is the server function the root loader calls", () => {
  it("is exposed as a callable server function", () => {
    expect(typeof getSessionRole).toBe("function")
  })
})

/**
 * The shell reads `isAdmin` as `session.ok && session.data.role === "admin"`,
 * so the admin link appears for exactly the admin decision and is withheld for
 * member, anonymous, and unknown alike. This mirrors the loader's own reading
 * over the projection, over a stubbed authorization seam, so no Clerk or Mongo
 * is touched.
 */
describe("the shell shows the admin link for exactly the Admin_Role", () => {
  function stubAuthorization(decision: AuthorizationDecision): Authorization {
    return { decide: async () => decision }
  }

  async function isAdminFor(decision: AuthorizationDecision): Promise<boolean> {
    const envelope = sessionRoleEnvelope(
      await stubAuthorization(decision).decide()
    )
    return envelope.ok && envelope.data.role === "admin"
  }

  it("shows the link for an admin decision", async () => {
    expect(
      await isAdminFor({ kind: "admin", account: accountWith("admin") })
    ).toBe(true)
  })

  it("withholds the link for member, anonymous, and unknown", async () => {
    expect(
      await isAdminFor({ kind: "member", account: accountWith("member") })
    ).toBe(false)
    expect(await isAdminFor({ kind: "anonymous" })).toBe(false)
    expect(
      await isAdminFor({ kind: "unknown", failure: UNKNOWN_FAILURE })
    ).toBe(false)
  })
})
