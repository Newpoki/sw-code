/**
 * The app shell: the HTML document, the navigation, the Mock_Mode indicator,
 * and the notification host (Requirements 7.4, 7.8, 6.4).
 *
 * Two components, because the root route renders two different things:
 *
 * - {@link RootDocument} is the `shellComponent`, the `<html>` document itself.
 *   It carries the stylesheet link, the devtools, and `<Scripts />`, all of which
 *   the framework needs, and it renders for every route including `/login`.
 * - {@link RootLayout} is the route `component`, the chrome drawn around every
 *   page's `<Outlet />`: the navigation, the Mock_Mode banner, and one
 *   `<Toaster />`.
 *
 * ## Why Mock_Mode and the Account_Role are read in the loader
 *
 * `getAppConfig` and `getSessionRole` are server functions. Called from a
 * component each would become a network round trip per mount, and every page
 * that wants the Mock_Mode state or the admin-link decision would make its own.
 * The root loader runs once per document, so both are read once and reach the
 * page through loader data (Requirements 7.4, 6.11, 6.12). Each envelope is a
 * discriminated union, so `ok` is narrowed before `data` is touched; neither can
 * fail, and the safe reading of a failure is the withholding one — Requirement
 * 7.8 forbids the Mock_Mode indicator while Mock_Mode is disabled, and
 * Requirements 6.11/6.12 withhold the admin link for anything but the Admin_Role
 * — so an unknown state must display neither. The signed-in email and the
 * sign-out control (Requirement 5.11) come instead from Clerk's own client
 * components, which read the live Clerk session rather than loader data.
 *
 * ## Why the chrome is hidden on `/login`
 *
 * The login document is what an unauthorized sender is redirected to, so it has
 * no Session: every navigation link would bounce straight back to it and the
 * sign-out control would refer to a Session that does not exist. The Mock_Mode
 * banner is suppressed there for the same reason — it describes redemption
 * results, and no redemption is reachable from the login page.
 */

import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRoute,
  useRouterState,
} from "@tanstack/react-router"
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools"
import { TanStackDevtools } from "@tanstack/react-devtools"
import {
  ClerkProvider,
  Show,
  UserButton,
  useUser,
} from "@clerk/tanstack-react-start"

import { LogoutButton } from "@/components/LogoutButton"
import { MockModeBanner } from "@/components/MockModeBanner"
import { Toaster } from "@/components/ui/sonner"
import { getAppConfig } from "@/functions/config.functions"
import { getSessionRole } from "@/functions/session.functions"

import appCss from "../styles.css?url"

/**
 * Path of the login document. A literal rather than an import, because
 * `LOGIN_PATH` lives in `auth.server.ts`, which must not reach the browser
 * bundle; `src/routes/login.tsx` declares the same path.
 */
const LOGIN_PATH = "/login"

/** Everything the shell reads from the server, per document. */
interface ShellData {
  /** True while Mock_Mode is enabled (Requirements 7.4, 7.8). */
  readonly mockMode: boolean
  /**
   * True only when the request's guarded role read reported the Admin_Role
   * (Requirements 6.11, 6.12). Withheld for `member`, `anonymous`, and
   * `unknown` alike — the same "unknown means withhold" reading the Mock_Mode
   * banner applies, so any envelope failure defaults this to `false`.
   */
  readonly isAdmin: boolean
}

/** Props merged into the navigation link of the page being viewed. */
const ACTIVE_LINK_PROPS = {
  "aria-current": "page",
  className: "text-foreground font-medium underline",
} as const

/** Base classes for every navigation link. */
const NAV_LINK_CLASS = "text-muted-foreground hover:text-foreground text-sm"

/**
 * The navigation links of the shell, including the Admin_Page link (Requirements
 * 6.11, 6.12).
 *
 * Exported and prop-driven — the admin-link decision arrives as `isAdmin` — so
 * the chrome can be rendered without a router or a live server, the same seam
 * `RosterPage`/`AdminPage` expose. `RootLayout` computes `isAdmin` from the
 * projected Account_Role the loader read (`sessionRoleEnvelope(...).data.role
 * === "admin"`) and hands it here; nothing else decides the link.
 *
 * The `/admin` link renders exactly when `isAdmin` is true, and is withheld for
 * `member`, `anonymous`, and `unknown` alike — the projection folds all three to
 * a role that is not the Admin_Role, so `isAdmin` is false for each.
 */
export function ShellNav({ isAdmin }: { readonly isAdmin: boolean }) {
  return (
    <nav aria-label="Main" className="flex items-center gap-4">
      {/*
       * `exact` on `/`, or it would count as the current page on every
       * route, since every path starts with it.
       */}
      <Link
        to="/"
        activeOptions={{ exact: true }}
        activeProps={ACTIVE_LINK_PROPS}
        className={NAV_LINK_CLASS}
      >
        Redeem
      </Link>
      <Link
        to="/roster"
        activeProps={ACTIVE_LINK_PROPS}
        className={NAV_LINK_CLASS}
      >
        Roster
      </Link>
      <Link
        to="/history"
        activeProps={ACTIVE_LINK_PROPS}
        className={NAV_LINK_CLASS}
      >
        History
      </Link>
      {/*
       * Requirements 6.11, 6.12: the admin link is shown only when the
       * guarded role read reported the Admin_Role, and withheld for
       * `member`, `anonymous`, and `unknown` alike — `isAdmin` is true
       * for none of those.
       */}
      {isAdmin ? (
        <Link
          to="/admin"
          activeProps={ACTIVE_LINK_PROPS}
          className={NAV_LINK_CLASS}
          data-slot="admin-link"
        >
          Admin
        </Link>
      ) : null}
    </nav>
  )
}

/**
 * The signed-in Clerk controls of the shell: the signed-in email address and a
 * sign-out control, shown exactly when the request carries a valid Clerk session
 * (Requirement 5.11).
 *
 * Exported and prop-driven so the chrome rule is renderable without a
 * `ClerkProvider`: `hasClerkSession` stands for "the request carries a valid
 * Clerk session", `email` for the bound User_Account's email, and `imageUrl`
 * for the account's avatar image. When `hasClerkSession` is false none of the
 * avatar, the email, or the sign-out control renders; when it is true the
 * sign-out control always renders, the email renders when present, and the
 * avatar renders when an image URL is present. `RootLayout` supplies these from
 * Clerk's own client session — `<Show when="signed-in">` gates on the live
 * session and `useUser()` reads the email and the avatar URL — so the live
 * app's `hasClerkSession` is exactly Clerk's client-session state.
 */
export function ShellSessionControls({
  hasClerkSession,
  email,
  imageUrl = null,
}: {
  readonly hasClerkSession: boolean
  readonly email: string | null
  readonly imageUrl?: string | null
}) {
  if (!hasClerkSession) return null
  return (
    <>
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={email ?? "Signed-in user"}
          className="size-7 rounded-full object-cover"
          data-slot="session-avatar"
        />
      ) : null}
      {email ? (
        <span
          className="text-sm text-muted-foreground"
          data-slot="session-email"
        >
          {email}
        </span>
      ) : null}
      <span data-slot="sign-out">
        <UserButton />
      </span>
    </>
  )
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "Shared coupon redemption",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),

  /**
   * The one server read of a document (Requirements 7.4, 7.8, 6.11, 6.12).
   * During SSR the server functions run in process; on a client-side reload of
   * the root each is a single call, not one per page. The two reads run
   * concurrently — neither depends on the other.
   *
   * `isAdmin` is true only when the guarded role read reported the Admin_Role;
   * a `member`/`anonymous`/`unknown` role, or any envelope failure, withholds
   * the admin link (Requirements 6.11, 6.12), mirroring how `mockMode` defaults
   * `false` on an unreadable state.
   */
  loader: async (): Promise<ShellData> => {
    const [config, session] = await Promise.all([
      getAppConfig(),
      getSessionRole(),
    ])
    return {
      mockMode: config.ok && config.data.mockMode,
      isAdmin: session.ok && session.data.role === "admin",
    }
  },

  notFoundComponent: () => (
    <main className="container mx-auto p-4 pt-16">
      <h1>404</h1>
      <p>The requested page could not be found.</p>
    </main>
  ),

  component: RootLayout,
  shellComponent: RootDocument,
})

function RootLayout() {
  const { mockMode, isAdmin } = Route.useLoaderData()

  /*
   * Subscribing to the pathname alone keeps this re-render to navigations that
   * actually cross into or out of the login document.
   */
  const onLoginPage = useRouterState({
    select: (state) => state.location.pathname === LOGIN_PATH,
  })

  return (
    <>
      {onLoginPage ? null : (
        <>
          <header className="border-b">
            <div className="container mx-auto flex items-center gap-6 p-4">
              <ShellNav isAdmin={isAdmin} />
              <div className="ml-auto flex items-center gap-3">
                {/*
                 * Requirement 5.11: on every page rendered for a request
                 * carrying a valid Clerk session, show the signed-in email and a
                 * sign-out control (Clerk's `<UserButton>`). `<Show
                 * when="signed-in">` gates on the client Clerk session — exactly
                 * "a request carrying a valid Clerk session" — and renders
                 * nothing when there is no Clerk session or while auth is still
                 * loading. Inside the gate `hasClerkSession` is therefore true,
                 * and `ClerkSessionEmail` reads the email from `useUser()`.
                 */}
                <Show when="signed-in">
                  <ClerkSessionEmail />
                </Show>
                {/*
                 * The Passphrase_Session sign-out stays: it is a separate session
                 * mechanism from the Clerk session, and Requirement 7.7 keeps the
                 * two independent.
                 */}
                <LogoutButton />
              </div>
            </div>
          </header>

          {/* Requirement 7.8: nothing at all while Mock_Mode is disabled. */}
          {mockMode ? (
            <div className="container mx-auto px-4 pt-4">
              <MockModeBanner />
            </div>
          ) : null}
        </>
      )}

      <Outlet />

      {/* One notification host for the whole app (Requirement 6.4). */}
      <Toaster />
    </>
  )
}

/**
 * The signed-in email address and sign-out control for the current Clerk session
 * (Requirement 5.11).
 *
 * Rendered only inside `<Show when="signed-in">`, so the request carries a valid
 * Clerk session whenever this mounts — hence `hasClerkSession` is fixed `true`
 * here, and the presentational {@link ShellSessionControls} draws the avatar,
 * the email, and the sign-out control. `useUser()` supplies the email and the
 * avatar URL; the optional chains are defensive against the brief window before
 * the user object hydrates, against an Identity_Provider that asserted no
 * primary email, and against an account with no avatar image, and
 * `ShellSessionControls` withholds only the affected element in each case, never
 * the sign-out control.
 */
function ClerkSessionEmail() {
  const { user } = useUser()
  const email = user?.primaryEmailAddress?.emailAddress ?? null
  const imageUrl = user?.hasImage ? user.imageUrl : null
  return (
    <ShellSessionControls hasClerkSession email={email} imageUrl={imageUrl} />
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  /*
   * `<ClerkProvider>` wraps the document body so every route — and the chrome
   * around it — is inside Clerk's context and can read the session and render
   * Clerk controls. It sits inside `<body>` rather than around `<html>` because
   * the `<html>`/`<head>`/`<Scripts />` scaffold is the framework's shell and
   * must stay at the top of the tree. The publishable key reaches the provider
   * through `VITE_CLERK_PUBLISHABLE_KEY`; this route builds none of Clerk's own
   * flow.
   */
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <ClerkProvider>
          {children}
          <TanStackDevtools
            config={{
              position: "bottom-right",
            }}
            plugins={[
              {
                name: "Tanstack Router",
                render: <TanStackRouterDevtoolsPanel />,
              },
            ]}
          />
        </ClerkProvider>
        <Scripts />
      </body>
    </html>
  )
}
