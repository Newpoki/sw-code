/**
 * The control that ends a Session (Requirement 8.7).
 *
 * A one-field HTML form posting to `/logout`, so signing out works with
 * JavaScript disabled and needs no client state: the response is a 303 to
 * `/login` carrying the `Set-Cookie` that removes the session cookie, and the
 * server has already dropped the Session from its registry by then, which is
 * what makes every subsequent request carrying that cookie fail the gate.
 *
 * `POST`, not a link: a `GET` would let a prefetch, a crawler, or a bookmark
 * sign someone out.
 *
 * This component renders nothing about the Session — no id, no expiry — so it is
 * safe to mount unconditionally. It has no home yet: task 13.1 owns
 * `src/routes/__root.tsx` and must mount it in the app shell.
 */

import { Button } from "@/components/ui/button"

/**
 * Path of the logout endpoint. A literal rather than an import, because
 * `auth.server.ts` holds no logout constant and must not be imported from a
 * client component; `src/routes/logout.ts` declares the same path.
 */
const LOGOUT_PATH = "/logout"

/** The sign-out control. Mount it wherever the shell shows session controls. */
export function LogoutButton({ className }: { className?: string }) {
  return (
    <form method="post" action={LOGOUT_PATH} className={className}>
      <Button type="submit" variant="outline" size="sm">
        Sign out
      </Button>
    </form>
  )
}
