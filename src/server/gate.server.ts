/**
 * The Access_Gate decision, as a plain function over plain facts
 * (Requirements 8.2, 8.3, 8.9, 8.10).
 *
 * `src/start.ts` registers the global request middleware; this module holds the
 * whole rule it applies. The split exists so the decision can be exercised
 * without a socket, a server, or a browser: {@link evaluateGate} takes the
 * {@link Auth} seam, a pathname, a handler type, and a raw `Cookie:` header
 * string, and returns a value. {@link gateRejectionResponse} is the only part
 * that builds a `Response`.
 *
 * ## What the rejection response holds
 *
 * A rejection carries a status, the {@link SESSION_REQUIRED_MESSAGE}, the
 * {@link LOGIN_PATH} it points at, the {@link SIGN_IN_PATH} an unauthenticated
 * sender may need, and a {@link GateRejectionNeeds} discriminator saying whether
 * the sender must submit the passphrase alone (a signed-in `member`,
 * Requirement 7.2) or must both submit the passphrase and sign in (an
 * `anonymous`/`unknown` sender, Requirement 7.8). No Member_Registry value, no
 * Redemption_History value, and no character of the Shared_Passphrase — this
 * module never reads the passphrase, so it cannot leak one, and it contains no
 * logging call at all (Requirement 8.10).
 *
 * ## Why rejecting here is "before any store read"
 *
 * Request middleware runs before the request reaches a handler. Returning a
 * `Response` from it short-circuits the chain: neither the router nor a server
 * function is invoked, so no store module is loaded, no Member_Registry or
 * Redemption_History read happens, and `RunCoordinator.start` is never called
 * (Requirement 8.3). Ordering is the mechanism — this module deliberately
 * imports nothing from `@/server/store` or `@/server/run`, so it could not read
 * or start anything even by accident. The Account_Role decision reaches Mongo
 * through the injected {@link GateInput.resolveAuthorization} resolver — a
 * function passed in by the wiring, invoked only at step 4 — so this module's
 * own import graph stays free of any store module and Requirement 7.4 holds
 * structurally: it imports only the {@link AuthorizationDecision} *type*, which
 * is erased at build time.
 *
 * ## The exemptions, and why each one exists
 *
 * A gate that covered the login submission would lock everyone out: nobody
 * could ever obtain a Session. So the exemption list has to exist, and it has to
 * stay as small as possible, because everything on it is reachable without a
 * Session. Two kinds of entry, both restricted to `handlerType: "router"` so
 * that **no server function is ever exempt**:
 *
 * 1. {@link LOGIN_PATH} exactly. The login document, and a form submission
 *    posted to the same path. This is the one entry that must accept a POST.
 * 2. {@link SIGN_IN_PATH} and `/sign-up` (exactly), their sub-route prefixes
 *    `/sign-in/` and `/sign-up/`, and `/sso-callback`. Clerk's
 *    hosted-or-embedded sign-in surface and the path Google returns to; a
 *    Requirement 7.8 rejection points an anonymous sender here, so it must be
 *    reachable without a Session or the sender could never sign in.
 * 3. The static files needed to render those documents: the built client
 *    bundle, the built asset directory, the three files in `public/`, and the
 *    dev server's module-graph prefixes. These are build artifacts served
 *    identically to every visitor; they hold no roster value, no history value,
 *    and no secret, because every environment read lives in a `.server.ts`
 *    module that the client build excludes. Without them the login page loads
 *    as unstyled, unhydrated HTML.
 *
 * Alongside the path list, one exemption is keyed on a **query parameter**
 * rather than a path: a request carrying `__clerk_handshake` or `__clerk_db_jwt`
 * is admitted (see {@link evaluateGate} step 2 and
 * {@link CLERK_HANDSHAKE_QUERY_PARAMS}). Clerk completes its cross-domain
 * handshake by redirecting back with that parameter and a `Set-Cookie`;
 * `clerkMiddleware()` consumes it. A gate rejection at that moment would
 * short-circuit the chain, discard the cookie, and loop the browser — so the
 * handshake is admitted whatever its path, keyed on the parameter the caller
 * computes into {@link GateInput.clerkHandshake}.
 *
 * Not exempt, deliberately:
 *
 * - **Every server function.** Requests under the server-function base arrive
 *   with `handlerType: "serverFn"` and {@link isGateExemptPath} returns false
 *   for them unconditionally. That is the data boundary: `listMembers`,
 *   `listHistory`, and `redeem` are independently reachable endpoints, and they
 *   are what a stranger would call.
 * - **Every other document**, `/` included. An SSR'd roster or history page
 *   would embed the very values Requirement 8.3 says to withhold.
 * - **`/@fs/`**, the dev server's arbitrary-file route. It can serve any file
 *   inside the Vite root, `.env` and `data/store.json` included. The dev server
 *   answers those requests before this middleware ever runs, so listing the
 *   prefix would buy nothing and would read as an endorsement.
 *
 * ## Consequence for the login submission
 *
 * A server function's URL is `<base>/<functionId>`, and `functionId` is
 * generated by the compiler — a SHA-256 hash in a build, a base64url blob in
 * dev. It cannot be written into an allowlist by hand. So the login submission
 * must arrive at {@link LOGIN_PATH} itself (a `POST` handler on the `/login`
 * file route, or a plain HTML form posting there), not as a server function
 * call. The alternative, if a server function is ever wanted for it, is to
 * configure a stable id generator (`tanstackStart({ serverFns: {
 * generateFunctionId } })`) and add that one id here explicitly.
 */

import { LOGIN_PATH, SESSION_REQUIRED_MESSAGE } from "@/server/auth.server"

import type { Auth, SessionVerification } from "@/server/auth.server"
import type { AuthorizationDecision } from "@/server/authorization.server"

/**
 * Route a Requirement 7.8 rejection directs an unauthenticated sender to, so
 * they can start a Sign_In_Flow.
 *
 * Defined here as a literal rather than imported from
 * `@/server/authorization.server` on purpose: that module reaches the
 * User_Account store, and importing any value from it would pull `@/server/store`
 * into this module's graph, breaking the structural guarantee of Requirement
 * 7.4. This module imports only the {@link AuthorizationDecision} *type*, which
 * is erased at build time and carries no runtime dependency.
 */
export const SIGN_IN_PATH = "/sign-in"

/**
 * Query parameters Clerk attaches while completing its cross-domain handshake.
 * A request carrying either is admitted (see {@link evaluateGate} step 2), so
 * that `clerkMiddleware()` can consume it and set its session cookie: a gate
 * rejection at that moment would short-circuit the chain, discard the
 * `Set-Cookie`, and loop the browser.
 */
export const CLERK_HANDSHAKE_QUERY_PARAMS: readonly string[] = [
  "__clerk_handshake",
  "__clerk_db_jwt",
]

/** Which Start handler a request was heading for. */
export type GateHandlerType = "router" | "serverFn"

/**
 * The part of {@link Auth} the decision needs: whether the gate is armed, and
 * the verdict on a `Cookie:` header. Narrowed so a test can pass a two-function
 * literal, and so this module cannot come to depend on the passphrase
 * comparison or on session issuance.
 */
export type GateAuth = Pick<
  Auth,
  "passphraseRequired" | "verifySessionCookieHeader"
>

/** Everything about a request that the decision looks at. */
export interface GateRequestFacts {
  /** URL pathname, already normalized by URL parsing. No query, no hash. */
  readonly pathname: string
  /** Handler the request was heading for. */
  readonly handlerType: GateHandlerType
  /** Raw `Cookie:` header value, or null when the request carried none. */
  readonly cookieHeader: string | null | undefined
  /**
   * Whether this request is a Clerk cross-domain handshake, computed by the
   * caller from the request URL's query parameters (see
   * {@link CLERK_HANDSHAKE_QUERY_PARAMS}). A handshake is admitted at step 2 so
   * `clerkMiddleware()` can consume it without the gate discarding its
   * `Set-Cookie`.
   */
  readonly clerkHandshake: boolean
}

/** Input of {@link evaluateGate}. */
export interface GateInput extends GateRequestFacts {
  /** The Access_Gate seam. Injected, so tests need no process-wide state. */
  readonly auth: GateAuth
  /**
   * The Account_Role decision for this request, resolved lazily. Invoked by the
   * gate only at step 4 — a request with a valid Passphrase_Session is admitted
   * at step 3 without ever calling it, so the common case pays for no Mongo read
   * and no Clerk call (Requirement 7.1).
   */
  readonly resolveAuthorization: () => Promise<AuthorizationDecision>
}

/** Why a request was admitted. */
export type GateAdmitReason =
  /** No Shared_Passphrase is configured, so the gate is off (Requirements 8.9, 7.5). */
  | "gate-disabled"
  /** The path is on the exemption list, so the login page stays reachable. */
  | "exempt-path"
  /** The request is a Clerk cross-domain handshake (Requirement 7.3). */
  | "clerk-handshake"
  /** The request carried a valid Passphrase_Session (Requirements 8.2, 7.1). */
  | "valid-session"
  /**
   * No Passphrase_Session, but the resolved Account_Role is the Admin_Role
   * (Requirement 7.1). The one admit reason that costs a resolver call.
   */
  | "admin-authorized"

/** An admitted request. */
export interface GateAdmission {
  readonly kind: "admit"
  readonly reason: GateAdmitReason
}

/**
 * What a rejected sender must do to be admitted, so the login page can say the
 * right thing (Requirements 7.2, 7.8):
 *
 * - `"passphrase"` — submit the Shared_Passphrase and nothing else. Produced for
 *   a `member` at step 4: the sender is already signed in with a non-admin
 *   account, so a Passphrase_Session alone would admit them (Requirement 7.2).
 * - `"passphrase-and-sign-in"` — submit the passphrase *and* sign in. Produced
 *   for an `anonymous` or `unknown` sender at step 4, and for every rejection
 *   before authorization is resolved (a passphrase-only path with no valid
 *   Passphrase_Session): the sender has neither credential, so directing them to
 *   both is correct (Requirement 7.8).
 *
 * A discriminator over fixed strings, not a value read from anywhere — it
 * carries no Member_Registry value, no Redemption_History value, and no
 * character of the passphrase.
 */
export type GateRejectionNeeds = "passphrase" | "passphrase-and-sign-in"

/**
 * A refused request (Requirements 8.3, 7.2, 7.8).
 *
 * Every field is a status, the fixed {@link SESSION_REQUIRED_MESSAGE}, one of the
 * fixed paths ({@link LOGIN_PATH}, {@link SIGN_IN_PATH}), or the fixed
 * {@link GateRejectionNeeds} discriminator. Nothing here is derived from the
 * Member_Registry, the Redemption_History, or the Shared_Passphrase.
 */
export interface GateRejection {
  readonly kind: "reject"
  /** Why the Session was not accepted. Never `"valid"`. */
  readonly reason: Exclude<SessionVerification["kind"], "valid">
  /** HTTP status of the response. */
  readonly status: number
  /** Always {@link SESSION_REQUIRED_MESSAGE}. */
  readonly message: string
  /** Always {@link LOGIN_PATH}: where the sender submits the passphrase. */
  readonly loginPath: string
  /** Always {@link SIGN_IN_PATH}: where the sender starts a Sign_In_Flow. */
  readonly signInPath: string
  /** What the sender must do to be admitted (Requirements 7.2, 7.8). */
  readonly needs: GateRejectionNeeds
  /** `Location:` value for a document request; null for a server function. */
  readonly location: string | null
  /** Exact response body. */
  readonly body: string
  /** `Content-Type:` of {@link body}. */
  readonly contentType: string
}

/** The whole result of the decision. */
export type GateDecision = GateAdmission | GateRejection

/**
 * Status returned to a server-function call made without a Session. 401 rather
 * than a redirect: the caller is `fetch`, which would follow a redirect and get
 * an HTML document where it expected a serialized result.
 */
export const SESSION_REQUIRED_STATUS = 401

/**
 * Status returned to a document request made without a Session. 303 sends the
 * browser to {@link LOGIN_PATH} with a GET whatever the original method was,
 * which is precisely "directs the sender to submit the Shared_Passphrase".
 */
export const SESSION_REQUIRED_REDIRECT_STATUS = 303

/** Machine-readable code on the server-function rejection body. */
export const SESSION_REQUIRED_CODE = "SESSION_REQUIRED"

/**
 * Paths that stay reachable without a Session, matched exactly.
 *
 * `/login` is the only entry that exists for the gate's own sake; the other
 * three are the files in `public/`, which browsers and crawlers request
 * unprompted while the login page loads.
 */
export const GATE_EXEMPT_PATHS: readonly string[] = [
  LOGIN_PATH,
  SIGN_IN_PATH,
  "/sign-up",
  "/sso-callback",
  "/favicon.ico",
  "/manifest.json",
  "/robots.txt",
]

/**
 * Prefixes that stay reachable without a Session, each ending in `/` so that a
 * route named `/_buildish` cannot slip through a `/_build` prefix.
 *
 * - `/sign-in/`, `/sign-up/` — Clerk's hosted-or-embedded sign-in surface,
 *   whose sub-routes (`/sign-in/factor-one`, `/sign-up/verify-email-address`,
 *   and the like) must stay reachable without a Session so a person can sign in.
 *   The exact paths `/sign-in` and `/sign-up` are in {@link GATE_EXEMPT_PATHS}.
 * - `/_build/` — the client bundle base configured by TanStack Start.
 * - `/assets/` — the built client asset directory (JS, CSS, fonts).
 * - `/@vite/`, `/@id/`, `/node_modules/`, `/src/` — the dev server's module
 *   graph. The dev server normally answers these itself, before this middleware
 *   runs; they are listed so a login page that reaches the middleware in dev is
 *   still able to load its modules. In a build these paths hold nothing.
 */
export const GATE_EXEMPT_PATH_PREFIXES: readonly string[] = [
  "/sign-in/",
  "/sign-up/",
  "/_build/",
  "/assets/",
  "/@vite/",
  "/@id/",
  "/node_modules/",
  "/src/",
]

/** Exact paths a dev-only request may carry with no trailing segment. */
const GATE_EXEMPT_DEV_PATHS: readonly string[] = ["/@react-refresh"]

/** Drops a single trailing slash, so `/login/` matches `/login`. */
function withoutTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname
}

/**
 * True when `pathname` may be served without a Session.
 *
 * A server function is never exempt: the `handlerType` check is the first thing
 * this function does, and it is what keeps the exemption list from ever opening
 * the data boundary.
 */
export function isGateExemptPath(
  pathname: string,
  handlerType: GateHandlerType
): boolean {
  if (handlerType !== "router") {
    return false
  }

  const path = withoutTrailingSlash(pathname)
  if (GATE_EXEMPT_PATHS.includes(path)) {
    return true
  }
  if (GATE_EXEMPT_DEV_PATHS.includes(path)) {
    return true
  }
  return GATE_EXEMPT_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

/** The body a refused server-function call receives. */
function serverFnRejectionBody(needs: GateRejectionNeeds): string {
  return JSON.stringify({
    error: SESSION_REQUIRED_CODE,
    message: SESSION_REQUIRED_MESSAGE,
    loginPath: LOGIN_PATH,
    signInPath: SIGN_IN_PATH,
    needs,
  })
}

/**
 * Builds the rejection for one refused request.
 *
 * Not the {@link Envelope} shape the server functions return, on purpose: the
 * request never reached a server function, and a caller that unwrapped this as
 * an application-level failure would report "the roster could not be read"
 * instead of "sign in".
 */
function reject(
  reason: GateRejection["reason"],
  handlerType: GateHandlerType,
  needs: GateRejectionNeeds
): GateRejection {
  const forServerFn = handlerType === "serverFn"
  return {
    kind: "reject",
    reason,
    status: forServerFn
      ? SESSION_REQUIRED_STATUS
      : SESSION_REQUIRED_REDIRECT_STATUS,
    message: SESSION_REQUIRED_MESSAGE,
    loginPath: LOGIN_PATH,
    signInPath: SIGN_IN_PATH,
    needs,
    /*
     * A document rejection redirects to the passphrase submission whatever the
     * sender still needs: /login is the one path the gate itself owns, and the
     * login page reads `needs` to point the sender on to sign-in when that is
     * also required. The sign-in route is carried in the payload, never as the
     * Location.
     */
    location: forServerFn ? null : LOGIN_PATH,
    body: forServerFn ? serverFnRejectionBody(needs) : SESSION_REQUIRED_MESSAGE,
    contentType: forServerFn
      ? "application/json; charset=utf-8"
      : "text/plain; charset=utf-8",
  }
}

/**
 * The Access_Gate decision, combining the Passphrase_Session gate with the
 * Account_Role gate (Requirements 7.1, 7.2, 7.3, 7.5, 7.8; 8.2, 8.3, 8.9).
 *
 * In order:
 *
 * 1. no Shared_Passphrase configured ⇒ admit, whatever the request carries;
 *    Requirement 6 still governs `/admin` (Requirements 8.9, 7.5);
 * 2. exempt path, or a Clerk handshake ⇒ admit, so the login and sign-in pages,
 *    their assets, and the handshake's `Set-Cookie` stay reachable
 *    (Requirement 7.3);
 * 3. valid Passphrase_Session ⇒ admit (Requirements 8.2, 7.1). **The
 *    authorization resolver is not called on this path**, so the common case
 *    adds no Mongo read and no Clerk call;
 * 4. otherwise resolve the Account_Role: `admin` ⇒ admit (Requirement 7.1);
 *    `member` ⇒ reject, directing the sender to submit the passphrase and
 *    nothing else (Requirement 7.2); `anonymous` or `unknown` ⇒ reject,
 *    directing the sender to both submit the passphrase and sign in
 *    (Requirement 7.8).
 *
 * Reads no environment variable and holds no store import of its own; steps 1–3
 * short-circuit without touching the resolver, so the resolver's Mongo read and
 * Clerk call are paid for only on the uncommon step-4 path. `async` because
 * step 4 awaits {@link GateInput.resolveAuthorization}; steps 1–3 resolve
 * without awaiting anything.
 */
export async function evaluateGate(input: GateInput): Promise<GateDecision> {
  const { auth, pathname, handlerType, cookieHeader, clerkHandshake } = input

  if (!auth.passphraseRequired()) {
    return { kind: "admit", reason: "gate-disabled" }
  }
  if (clerkHandshake) {
    return { kind: "admit", reason: "clerk-handshake" }
  }
  if (isGateExemptPath(pathname, handlerType)) {
    return { kind: "admit", reason: "exempt-path" }
  }

  const verification = auth.verifySessionCookieHeader(cookieHeader)
  if (verification.kind === "valid") {
    return { kind: "admit", reason: "valid-session" }
  }

  const authorization = await input.resolveAuthorization()
  switch (authorization.kind) {
    case "admin":
      return { kind: "admit", reason: "admin-authorized" }
    case "member":
      return reject(verification.kind, handlerType, "passphrase")
    case "anonymous":
    case "unknown":
      return reject(verification.kind, handlerType, "passphrase-and-sign-in")
  }
}

/**
 * Turns a {@link GateRejection} into the response the sender receives.
 *
 * `Cache-Control: no-store` because a cached rejection would keep showing after
 * a Session was obtained, and a cached redirect is worse still. No `Set-Cookie`:
 * the gate reads the Session, it never writes one.
 */
export function gateRejectionResponse(rejection: GateRejection): Response {
  const headers = new Headers({
    "Content-Type": rejection.contentType,
    "Cache-Control": "no-store",
  })
  if (rejection.location !== null) {
    headers.set("Location", rejection.location)
  }
  return new Response(rejection.body, {
    status: rejection.status,
    headers,
  })
}
