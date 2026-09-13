/**
 * The Start entry: global request middleware for every request this server
 * handles (Requirements 8.2, 8.3, 8.9).
 *
 * This file is not part of the default TanStack Start template. Its presence is
 * what makes `requestMiddleware` exist, and the export **must** be named
 * `startInstance` — the route-tree generator emits
 * `import type { startInstance } from './start.ts'` and registers its options as
 * the app's Start config.
 *
 * Three middlewares run, in this order, for every request — server functions,
 * SSR documents, and static requests that reach the handler alike:
 *
 * 1. {@link csrfMiddleware}, which refuses cross-site calls to server functions.
 * 2. {@link clerkMiddleware}, which establishes the request's Clerk session and
 *    consumes the Clerk cross-domain handshake.
 * 3. {@link passphraseMiddleware}, the Access_Gate.
 *
 * CSRF first because it is the cheaper check and because a cross-site caller has
 * no business learning whether the gate is armed.
 *
 * Clerk in the middle, ahead of the gate, is load-bearing. The gate asks who the
 * sender is — its decision reads the request's identity via `auth()`, which is
 * only populated after `clerkMiddleware()` has run. And Clerk completes a
 * cross-domain handshake by redirecting back with a `__clerk_handshake` query
 * parameter and setting the session cookie on the way out; the gate returns a
 * `Response` to reject, which short-circuits the chain. If the gate ran first it
 * could reject a handshake request before Clerk had a chance to attach its
 * `Set-Cookie`, discarding the cookie and looping the browser. Running Clerk
 * before the gate is what keeps that handshake's `Set-Cookie` alive.
 *
 * This module wires Clerk into the chain and threads two facts into the gate:
 * whether the request is a Clerk handshake (computed from the request URL's
 * query parameters) and a lazy authorization resolver the gate invokes only when
 * a request carries no valid Passphrase_Session. The gate combines the
 * Passphrase_Session gate with the Account_Role gate; its own decision logic
 * lives in {@link evaluateGate}.
 *
 * ## Why the CSRF middleware is written out here
 *
 * TanStack Start installs `createCsrfMiddleware({ filter: (ctx) =>
 * ctx.handlerType === 'serverFn' })` by itself **only while an app defines no
 * Start entry**. Creating this file switches that off: the handler uses the
 * `requestMiddleware` array as given. Omitting the line below would therefore
 * silently drop cross-site protection from every server function, which is why
 * it is registered explicitly with exactly the filter the framework default
 * uses — server functions are the same-origin RPC endpoints that need it, while
 * a document request has no such expectation.
 *
 * ## Why the gate lives in request middleware
 *
 * Request middleware runs before the request reaches a handler, and returning a
 * `Response` from it short-circuits the chain. That ordering is the whole
 * guarantee Requirement 8.3 asks for: a request without a valid Session never
 * reaches the router or a server function, so no Member_Registry or
 * Redemption_History read happens and `RunCoordinator.start` is never called.
 * A per-route `beforeLoad` guard would be route UX, not the data boundary,
 * because a server function is reachable on its own URL.
 *
 * The decision itself is {@link evaluateGate} in `@/server/gate.server`, which
 * is a plain function over a pathname, a handler type, a `Cookie:` header
 * string, a handshake fact, and an injected authorization resolver. This module
 * is only the wiring: read the header, compute the handshake fact, pass the
 * resolver, await the decision, and either return the rejection response or call
 * `next()`. The exemption list — the login and sign-in paths and the static
 * files needed to render them, never a server function — is documented there.
 * `evaluateGate` is `async` because resolving the Account_Role awaits Mongo, so
 * this middleware awaits it.
 *
 * The Shared_Passphrase is never read on this path and never appears in a
 * response or a log line (Requirement 8.10); neither this module nor the gate
 * module contains a logging call.
 */

import {
  createCsrfMiddleware,
  createMiddleware,
  createStart,
} from "@tanstack/react-start"
import { clerkMiddleware } from "@clerk/tanstack-react-start/server"

import { getAuth } from "@/server/auth.server"
import { getAuthorization } from "@/server/authorization.server"
import {
  CLERK_HANDSHAKE_QUERY_PARAMS,
  evaluateGate,
  gateRejectionResponse,
} from "@/server/gate.server"

/**
 * Cross-site protection for server functions, registered explicitly because
 * this file exists (see the module note).
 */
const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
})

/**
 * The Access_Gate: admits a request only when a Session is present, unless no
 * Shared_Passphrase is configured, in which case every request is admitted
 * (Requirements 8.2, 8.9).
 *
 * A thin wrapper over {@link evaluateGate} on purpose — the rule is tested
 * directly, without booting a server.
 */
const passphraseMiddleware = createMiddleware({ type: "request" }).server(
  async ({ next, request, pathname, handlerType }) => {
    /*
     * Clerk completes its cross-domain handshake by redirecting back with a
     * `__clerk_handshake` (or `__clerk_db_jwt`) query parameter and a
     * `Set-Cookie`. The gate admits such a request (step 2) so clerkMiddleware()
     * above can consume it; computing the fact here keeps the gate a pure
     * function over plain facts, with no URL to parse.
     */
    const searchParams = new URL(request.url).searchParams
    const clerkHandshake = CLERK_HANDSHAKE_QUERY_PARAMS.some((param) =>
      searchParams.has(param)
    )

    const decision = await evaluateGate({
      auth: getAuth(),
      pathname,
      handlerType,
      cookieHeader: request.headers.get("cookie"),
      clerkHandshake,
      /*
       * Lazy: the gate invokes this only at step 4, so a request with a valid
       * Passphrase_Session (the common case) is admitted at step 3 without a
       * Mongo read or a Clerk call (Requirement 7.1).
       */
      resolveAuthorization: () => getAuthorization().decide(),
    })

    if (decision.kind === "reject") {
      /*
       * Returning a Response here ends the chain: the handler below this
       * middleware never runs, so nothing is read and no Redemption_Run starts
       * (Requirement 8.3).
       */
      return gateRejectionResponse(decision)
    }

    return next()
  }
)

/** The app's Start options. The name is fixed by the framework. */
export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware, clerkMiddleware(), passphraseMiddleware],
}))
