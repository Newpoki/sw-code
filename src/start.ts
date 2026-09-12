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
 * Two middlewares run, in this order, for every request — server functions, SSR
 * documents, and static requests that reach the handler alike:
 *
 * 1. {@link csrfMiddleware}, which refuses cross-site calls to server functions.
 * 2. {@link passphraseMiddleware}, the Access_Gate.
 *
 * CSRF first because it is the cheaper check and because a cross-site caller has
 * no business learning whether the gate is armed.
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
 * is a plain function over a pathname, a handler type, and a `Cookie:` header
 * string. This module is only the wiring: read the header, ask, and either
 * return the rejection response or call `next()`. The exemption list — the
 * login path and the static files needed to render it, never a server function —
 * is documented there.
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

import { getAuth } from "@/server/auth.server"
import { evaluateGate, gateRejectionResponse } from "@/server/gate.server"

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
  ({ next, request, pathname, handlerType }) => {
    const decision = evaluateGate({
      auth: getAuth(),
      pathname,
      handlerType,
      cookieHeader: request.headers.get("cookie"),
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
  requestMiddleware: [csrfMiddleware, passphraseMiddleware],
}))
