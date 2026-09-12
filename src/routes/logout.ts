/**
 * The `/logout` endpoint: ends a Session (Requirement 8.7).
 *
 * ## Why a route handler rather than a server function
 *
 * Logout could be a server function — unlike login it needs a valid Session to
 * be meaningful, so the Access_Gate would admit the call rather than lock it
 * out. It is a `POST` handler anyway, for three reasons: it mirrors `/login`, so
 * the whole gate flow is one mechanism instead of two; it needs no JavaScript,
 * because {@link LogoutButton} is a plain HTML form; and it sets a `Set-Cookie`
 * header directly on a `Response`, which is what clearing a cookie takes.
 *
 * This route is **not** on the gate's exemption list, and that is deliberate: a
 * request arriving here without a valid Session has nothing to end, and the gate
 * sends it to `/login` before this handler runs. A request that does carry a
 * valid Session passes the gate and reaches the `POST` handler below.
 *
 * ## What ending a Session means
 *
 * `Auth.logout` removes the session id from the server-side registry, so a
 * captured copy of the cookie stops working immediately; the `Set-Cookie` it
 * returns only removes the browser's copy. Both halves are applied here.
 *
 * The route declares no `component`, which makes it a server-only route: the
 * Start router plugin prunes it from the client route tree entirely, so neither
 * this module nor its `auth.server.ts` import reaches the browser bundle.
 */

import { createFileRoute } from "@tanstack/react-router"

import { LOGIN_PATH, getAuth } from "@/server/auth.server"

/** Where a `GET` of this path goes. Ending a Session takes a `POST`. */
const NOT_A_LOGOUT_PATH = "/"

/**
 * A 303 redirect carrying a `Set-Cookie`. 303 makes the browser GET the target
 * whatever method it arrived with, and `no-store` keeps a logout out of the
 * cache. Mirrors the helper in `login.tsx`.
 */
function seeOther(location: string, setCookie?: string): Response {
  const headers = new Headers({
    Location: location,
    "Cache-Control": "no-store",
  })
  if (setCookie !== undefined) {
    headers.append("Set-Cookie", setCookie)
  }
  return new Response(null, { status: 303, headers })
}

export const Route = createFileRoute("/logout")({
  server: {
    handlers: ({ createHandlers }) =>
      createHandlers({
        /**
         * Ends the Session the request carries and sends the sender to the
         * login page, which is what they now need (Requirement 8.7).
         *
         * Idempotent: a request whose Session was already ended — possible when
         * no Shared_Passphrase is configured, in which case the gate admits
         * everything — clears the cookie and redirects just the same.
         */
        POST: ({ request }) => {
          const outcome = getAuth().logout(request.headers.get("cookie"))
          return seeOther(LOGIN_PATH, outcome.setCookie)
        },

        /**
         * A `GET` ends nothing. Link prefetching, a crawler, and a stray
         * bookmark all issue GETs, and none of them is a person choosing to
         * sign out.
         */
        GET: () => seeOther(NOT_A_LOGOUT_PATH),
      }),
  },
})
