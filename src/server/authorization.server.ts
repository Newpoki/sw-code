/**
 * The Account_Role decision and the two `requireAdmin` enforcement points for
 * mongodb-google-auth-admin (Requirements 5.13 restated, 6.4, 6.5, 6.6, 6.7,
 * 6.8, 6.15).
 *
 * This module is the third layer of the design's three-layer split: persistence
 * (`store/*.server.ts`) knows MongoDB and nothing about identity; identity
 * (`identity.server.ts`) knows Clerk and nothing about MongoDB; and this module
 * knows the Account_Role rule and takes both of the others as injected seams. It
 * imports nothing that forces Clerk or Mongo at module load — the two default
 * singletons it reaches for ({@link getIdentity}, {@link getUserAccountStore})
 * are lazy — so the whole decision is exercisable in the node test project with
 * a stub identity and an in-memory User_Account store, exactly as `createAuth`
 * is exercised with a two-function `Auth` literal.
 *
 * ## Why `decide()` holds no cache (Requirement 6.8)
 *
 * `decide()` calls {@link UserAccountStore.resolve} on *every* call and keeps no
 * memoized decision, because an Account_Role written to Mongo after the Clerk
 * session began must decide the current request. For the same reason the role is
 * never taken from a Clerk session claim: a claim is minted once at sign-in and
 * would go stale exactly when the requirement says it must not. `resolve`
 * already reads the User_Account document per call; this module simply never
 * remembers the answer between calls.
 *
 * ## The role is not re-derived here
 *
 * The Account_Role rule (fold the email, test membership in the Admin_Allowlist)
 * lives in the mirror's refresh, in `store/userAccounts.server.ts`, where the
 * write happens. This module reads the role that refresh persisted — it does not
 * fold an email or consult the Admin_Allowlist itself. `deps.allowlist` is
 * accepted to match the design's `createAuthorization` signature and to keep the
 * seam future-proof, but it is deliberately unused: re-deriving the role here
 * would duplicate the rule and could disagree with the value the request will be
 * decided against. See the note on {@link AuthorizationOptions.allowlist}.
 *
 * ## Why `requireAdmin` has two shapes (Requirement 6.7)
 *
 * The `/admin` document and every server function that serves an Admin_Page
 * value both enforce the same three-way rule (admin serves, anonymous is turned
 * away, member/unknown are refused), but the shape of "turned away" differs
 * because the callers differ:
 *
 * - The **document** guard ({@link requireAdminForDocument}) turns `anonymous`
 *   into a redirect to `/sign-in`, because a browser navigating to `/admin`
 *   should be sent to sign in (Requirement 6.5).
 * - The **server-function** guard ({@link requireAdminForServerFn}) turns
 *   `anonymous` into a `NOT_AUTHENTICATED` {@link Envelope}, *not* a redirect,
 *   because its caller is `fetch` and would silently follow a redirect into an
 *   HTML sign-in document where it expected a serialized envelope
 *   (Requirement 6.7).
 *
 * In both shapes `member` produces `NOT_AUTHORIZED` and `unknown` produces
 * `AUTHORIZATION_UNKNOWN`, and neither outcome carries any Admin_Page value —
 * the guards yield only a decision to proceed with an account or a rejection.
 */

import type { UserAccountView } from "@/domain/accounts"
import {
  authorizationUnknownMessage,
  notAuthorizedMessage,
} from "@/domain/storeMessages"
import type { Envelope, StoreFailure } from "@/domain/types"
import { getIdentity } from "@/server/identity.server"
import type { Identity } from "@/server/identity.server"
import { getUserAccountStore } from "@/server/store/userAccounts.server"
import type { UserAccountStore } from "@/server/store/userAccounts.server"

/** The path a document guard redirects an anonymous sender to (Requirement 6.5). */
export const SIGN_IN_PATH = "/sign-in"

/**
 * The authorization decision for one request, read fresh from Mongo every time
 * (Requirement 6.8). A discriminated union so `requireAdmin` branches on it
 * rather than throwing:
 *
 * - `admin`: a valid Clerk session whose mirrored User_Account holds the
 *   Admin_Role this request (Requirements 6.4, 7.1). Serve the Admin_Page.
 * - `member`: a valid Clerk session whose mirrored User_Account holds the
 *   Member_Role (Requirements 6.6, 7.2). Refuse with `NOT_AUTHORIZED`.
 * - `anonymous`: no valid Clerk session (Requirement 6.5). The document guard
 *   redirects to `/sign-in`; the server-function guard returns
 *   `NOT_AUTHENTICATED`.
 * - `unknown`: the Account_Role could not be read — a store read/write failure
 *   or a stalled/failed Clerk profile fetch (Requirements 6.15, 5.13 restated).
 *   Refuse with `AUTHORIZATION_UNKNOWN`, carrying the underlying
 *   {@link StoreFailure}.
 */
export type AuthorizationDecision =
  | { readonly kind: "admin"; readonly account: UserAccountView }
  | { readonly kind: "member"; readonly account: UserAccountView }
  | { readonly kind: "anonymous" }
  | { readonly kind: "unknown"; readonly failure: StoreFailure }

/** Injection points of {@link createAuthorization}. */
export interface AuthorizationOptions {
  /**
   * The Clerk boundary. Defaults to the process-wide {@link getIdentity}. A test
   * injects a stub and never touches Clerk or the network.
   */
  readonly identity?: Identity
  /**
   * The User_Account mirror. Defaults to the process-wide
   * {@link getUserAccountStore}. A test injects an in-memory store and never
   * touches MongoDB.
   */
  readonly accounts?: UserAccountStore
  /**
   * The Admin_Allowlist. Present to match the design's `createAuthorization`
   * signature, but deliberately **unused**: the Account_Role rule lives in the
   * mirror's refresh (`store/userAccounts.server.ts`), which derives the role
   * from this same allowlist and persists it. This module reads the persisted
   * role rather than re-deriving it here, so it neither folds an email nor tests
   * membership. Left in the seam so a future decision that genuinely needs the
   * allowlist has a place to receive it without a signature change.
   */
  readonly allowlist?: readonly string[]
  /**
   * The clock. Present for parity with `createAuth`/the design signature and for
   * a future decision that needs a request timestamp; the current rule delegates
   * all time-sensitive logic (staleness, sign-in timestamps) to the injected
   * {@link UserAccountStore}, so it is unused today.
   */
  readonly now?: () => Date
}

/** The authorization seam consumed by the route guard and the server functions. */
export interface Authorization {
  /**
   * The Account_Role decision for the current request, read from Mongo on every
   * call with no cache (Requirement 6.8). `identity.current()` deciding the
   * request carries no valid Clerk session yields `anonymous` and costs no Mongo
   * read; otherwise the mirror is resolved and its role becomes `admin` or
   * `member`, or its failure becomes `unknown`.
   */
  readonly decide: () => Promise<AuthorizationDecision>
}

/**
 * The outcome of {@link requireAdminForDocument}: the three ways the `/admin`
 * route document reacts to a decision. A discriminated result the route matches
 * on rather than a thrown redirect, so the route owns the framework-specific act
 * of redirecting or rejecting and this module stays server-framework-free and
 * directly testable.
 */
export type AdminDocumentGuard =
  /** `admin`: proceed and render the Admin_Page with this account. */
  | { readonly kind: "proceed"; readonly account: UserAccountView }
  /** `anonymous`: redirect the browser to {@link SIGN_IN_PATH} (Requirement 6.5). */
  | { readonly kind: "redirect"; readonly location: string }
  /**
   * `member` or `unknown`: refuse with an error and no Admin_Page value
   * (Requirements 6.6, 6.15). The route renders `message`; `code` distinguishes
   * the not-authorized refusal from the authorization-unknown one.
   */
  | {
      readonly kind: "rejected"
      readonly code: "NOT_AUTHORIZED" | "AUTHORIZATION_UNKNOWN"
      readonly message: string
    }

/**
 * The outcome of {@link requireAdminForServerFn}: proceed with the account, or a
 * failed {@link Envelope} the server function returns verbatim. An `anonymous`
 * sender becomes a `NOT_AUTHENTICATED` envelope rather than a redirect, because
 * the caller is `fetch` (Requirement 6.7); `member` and `unknown` become
 * `NOT_AUTHORIZED` and `AUTHORIZATION_UNKNOWN`. No variant carries an
 * Admin_Page value.
 */
export type AdminServerFnGuard =
  | { readonly kind: "authorized"; readonly account: UserAccountView }
  | { readonly kind: "rejected"; readonly envelope: Envelope<never> }

/**
 * The message an `anonymous` server-function call is rejected with. It directs
 * the caller to sign in without redirecting, since a `fetch` caller cannot
 * follow a redirect into an HTML sign-in document (Requirement 6.7).
 */
export const NOT_AUTHENTICATED_MESSAGE =
  "This request is not signed in. Sign in with a Google account to continue."

/** A failed {@link Envelope} carrying `code` and `message` and no data. */
function rejection(
  code: "NOT_AUTHENTICATED" | "NOT_AUTHORIZED" | "AUTHORIZATION_UNKNOWN",
  message: string
): Envelope<never> {
  return { ok: false, error: { code, message } }
}

/**
 * Builds the authorization seam over the injected identity and User_Account
 * store.
 *
 * Holds no state of its own — no cache, by design (Requirement 6.8) — so two
 * instances built over the same seams decide identically, and one built with the
 * defaults reaches the process-wide singletons lazily. `decide()` first asks the
 * identity whether the request carries a Clerk session at all: a `null` there is
 * `anonymous` and short-circuits before any Mongo read, which is also what keeps
 * the passphrase-only path (a request with a Passphrase_Session but no Clerk
 * session) from paying for a User_Account read it does not need.
 */
export function createAuthorization(
  options: AuthorizationOptions = {}
): Authorization {
  const identity = options.identity ?? getIdentity()
  const accounts = options.accounts ?? getUserAccountStore()

  return {
    decide: async () => {
      const requestIdentity = await identity.current()
      if (requestIdentity === null) {
        return { kind: "anonymous" }
      }

      const resolved = await accounts.resolve(requestIdentity)
      if (resolved.kind === "unknown") {
        return { kind: "unknown", failure: resolved.failure }
      }

      const { account } = resolved
      return account.role === "admin"
        ? { kind: "admin", account }
        : { kind: "member", account }
    },
  }
}

/**
 * Maps a decision to the `/admin` route document's reaction (Requirements 6.4,
 * 6.5, 6.6, 6.15): `admin` proceeds, `anonymous` redirects to {@link SIGN_IN_PATH},
 * and `member`/`unknown` are refused with `NOT_AUTHORIZED`/`AUTHORIZATION_UNKNOWN`
 * and no Admin_Page value. Pure over the decision so the route's `beforeLoad`
 * can call it and act on the discriminated result.
 */
export function requireAdminForDocument(
  decision: AuthorizationDecision
): AdminDocumentGuard {
  switch (decision.kind) {
    case "admin":
      return { kind: "proceed", account: decision.account }
    case "anonymous":
      return { kind: "redirect", location: SIGN_IN_PATH }
    case "member":
      return {
        kind: "rejected",
        code: "NOT_AUTHORIZED",
        message: notAuthorizedMessage(),
      }
    case "unknown":
      return {
        kind: "rejected",
        code: "AUTHORIZATION_UNKNOWN",
        message: authorizationUnknownMessage(),
      }
  }
}

/**
 * Maps a decision to a server function's reaction (Requirement 6.7): `admin`
 * authorizes with the account, `anonymous` becomes a `NOT_AUTHENTICATED`
 * envelope (never a redirect — the caller is `fetch`), `member` becomes
 * `NOT_AUTHORIZED`, and `unknown` becomes `AUTHORIZATION_UNKNOWN`. No rejection
 * carries an Admin_Page value. Pure over the decision so a server function can
 * call it and return the envelope verbatim.
 */
export function requireAdminForServerFn(
  decision: AuthorizationDecision
): AdminServerFnGuard {
  switch (decision.kind) {
    case "admin":
      return { kind: "authorized", account: decision.account }
    case "anonymous":
      return {
        kind: "rejected",
        envelope: rejection("NOT_AUTHENTICATED", NOT_AUTHENTICATED_MESSAGE),
      }
    case "member":
      return {
        kind: "rejected",
        envelope: rejection("NOT_AUTHORIZED", notAuthorizedMessage()),
      }
    case "unknown":
      return {
        kind: "rejected",
        envelope: rejection(
          "AUTHORIZATION_UNKNOWN",
          authorizationUnknownMessage()
        ),
      }
  }
}

let processAuthorization: Authorization | null = null

/**
 * The process-wide authorization seam, created on first use over the process
 * default identity and User_Account store.
 *
 * A singleton to match the `getAuth`/`getIdentity` house shape and to give the
 * route guard and the server functions one point to override in a test. It holds
 * no mutable state (Requirement 6.8: no cache), so a second instance would
 * behave identically — the singleton exists for the override seam, not for
 * shared state.
 */
export function getAuthorization(): Authorization {
  processAuthorization ??= createAuthorization()
  return processAuthorization
}

/** Installs the process-wide authorization seam. Used by wiring and by tests. */
export function setAuthorization(authorization: Authorization): void {
  processAuthorization = authorization
}

/** Drops the process-wide seam so the next {@link getAuthorization} rebuilds it. */
export function resetAuthorization(): void {
  processAuthorization = null
}
