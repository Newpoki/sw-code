/**
 * The client-visible session surface: the current request's Account_Role, read
 * once per document by the root loader (Requirements 6.11, 6.12).
 *
 * One `createServerFn` read — {@link getSessionRole} — returning an
 * {@link Envelope} holding a single client-safe field: the role the shell needs
 * to decide whether to show the admin navigation link, and nothing else. It
 * mirrors `src/functions/config.functions.ts`: the root loader calls it once per
 * document, so the guarded role read happens once rather than per component, and
 * the browser bundle reaches the authorization seam only through this
 * `createServerFn` boundary (never by importing `@/server/*` from a route).
 *
 * ## Why the projection collapses `anonymous` and `unknown` to `null`
 *
 * The shell shows the admin link *only* for the Admin_Role and withholds it for
 * `anonymous`, `member`, and `unknown` alike (Requirements 6.11, 6.12) — the
 * same "unknown means withhold" reading the Mock_Mode banner applies to an
 * unreadable state. So the projection carries just enough to draw that one
 * decision: `admin` and `member` pass through, and both `anonymous` and
 * `unknown` become `null`. The Clerk user id, the email, and the underlying
 * store failure never cross to the browser — the shell needs none of them to
 * decide the link, and Requirement 8.10 keeps every server-only value out of the
 * client surface by construction.
 *
 * {@link sessionRoleEnvelope} is exported separately from the server function
 * and takes the authorization decision as a parameter, so the projection is
 * directly testable without booting the framework.
 */

import { createServerFn } from "@tanstack/react-start"

import { getAuthorization } from "@/server/authorization.server"
import type { AuthorizationDecision } from "@/server/authorization.server"
import type { AccountRole } from "@/domain/accounts"
import type { Envelope } from "@/domain/types"

/**
 * The client-visible session projection: the Account_Role the shell reads, or
 * `null` when there is no role to show the admin link for.
 *
 * `null` covers both `anonymous` (no valid Clerk session) and `unknown` (the
 * Account_Role could not be read) — the two states the admin link is withheld
 * for alongside `member` (Requirements 6.11, 6.12).
 */
export interface SessionRole {
  readonly role: AccountRole | null
}

/**
 * Projects an {@link AuthorizationDecision} onto the client-visible
 * {@link SessionRole}: `admin` ⇒ `"admin"`, `member` ⇒ `"member"`, and both
 * `anonymous` and `unknown` ⇒ `null` (Requirements 6.11, 6.12).
 *
 * A read, so `warnings` is always empty, and it cannot fail, so the envelope is
 * always `ok`: the decision already folded every failure into its `unknown`
 * arm, which this projection reads as `null` — withhold the link.
 */
export function sessionRoleEnvelope(
  decision: AuthorizationDecision
): Envelope<SessionRole> {
  const role: AccountRole | null =
    decision.kind === "admin" || decision.kind === "member"
      ? decision.kind
      : null
  return { ok: true, data: { role }, warnings: [] }
}

/**
 * The Account_Role of the current request as a client-safe value
 * (Requirements 6.11, 6.12).
 *
 * A `GET`: it writes nothing and takes no caller-supplied value. It reads a
 * fresh authorization decision — `getAuthorization().decide()` reads the mirror
 * per call with no cache (Requirement 6.8) — and projects it to the single field
 * the shell needs. The Access_Gate and the cross-site check are applied globally
 * in `src/start.ts`, so nothing here re-checks them.
 */
export const getSessionRole = createServerFn().handler(async () =>
  sessionRoleEnvelope(await getAuthorization().decide())
)
