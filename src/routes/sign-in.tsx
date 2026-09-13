/**
 * The `/sign-in` document: Clerk's hosted sign-in component
 * (Requirement 7.3, and the destination of a Requirement 7.8 rejection).
 *
 * ## Why this is a splat route
 *
 * Clerk's `<SignIn />` drives a multi-step flow (email, social connection,
 * verification) by navigating to sub-paths beneath its `path` — `/sign-in`,
 * `/sign-in/factor-one`, and so on. A `$` splat route catches every path under
 * `/sign-in`, so the component keeps rendering as it walks the sender through
 * those steps rather than 404-ing on the second screen. This mirrors Clerk's
 * TanStack Start quickstart.
 *
 * ## What this route does and does not own
 *
 * It hosts Clerk's component and nothing else. Clerk owns the whole sign-in
 * flow — the anti-forgery state, the authorization-code exchange with Google,
 * the session token, and the session cookie. This app builds none of it: there
 * is no Sign_In_State store, no code exchange, no cookie handling, and no
 * `user_sessions` collection. This route is client-safe and imports no `.server`
 * module.
 *
 * The Access_Gate does not yet exempt `/sign-in`; that exemption is wired later
 * in this feature. Until then the gate may still turn an unauthorized sender
 * away from this path — expected, and corrected by that later step.
 */

import { SignIn } from "@clerk/tanstack-react-start"
import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/sign-in")({
  component: SignInPage,
})

function SignInPage() {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <SignIn />
    </main>
  )
}
