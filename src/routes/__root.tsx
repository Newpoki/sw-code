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
 * ## Why Mock_Mode is read in the loader and not in a component
 *
 * `getAppConfig` is a server function. Called from a component it would become a
 * network round trip per mount, and every page that wants to know the Mock_Mode
 * state would make its own. The root loader runs once per document, so the flag
 * is read once and reaches the page through loader data (Requirement 7.4). The
 * envelope is a discriminated union, so `ok` is narrowed before `data` is
 * touched; `getAppConfig` cannot fail, and `false` is the safe reading of a
 * failure anyway — Requirement 7.8 forbids the indicator while Mock_Mode is
 * disabled, so an unknown state must not display it.
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

import { LogoutButton } from "@/components/LogoutButton"
import { MockModeBanner } from "@/components/MockModeBanner"
import { Toaster } from "@/components/ui/sonner"
import { getAppConfig } from "@/functions/config.functions"

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
}

/** Props merged into the navigation link of the page being viewed. */
const ACTIVE_LINK_PROPS = {
  "aria-current": "page",
  className: "text-foreground font-medium underline",
} as const

/** Base classes for every navigation link. */
const NAV_LINK_CLASS = "text-muted-foreground hover:text-foreground text-sm"

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
   * The one Mock_Mode read of a document (Requirements 7.4, 7.8). During SSR the
   * server function runs in process; on a client-side reload of the root it is a
   * single call, not one per page.
   */
  loader: async (): Promise<ShellData> => {
    const envelope = await getAppConfig()
    return { mockMode: envelope.ok && envelope.data.mockMode }
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
  const { mockMode } = Route.useLoaderData()

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
              </nav>
              <LogoutButton className="ml-auto" />
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

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
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
        <Scripts />
      </body>
    </html>
  )
}
