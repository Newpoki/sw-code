/**
 * Property 16 of mongodb-google-auth-admin: the shell chrome follows the
 * identity state exactly.
 *
 * The chrome the app draws around every page has two identity-driven decisions,
 * and each is a pure function of one input the shell already holds:
 *
 *   - the **Admin_Page link** is shown exactly when the bound User_Account holds
 *     the Admin_Role (Requirements 6.11, 6.12). The shell reads that as
 *     `isAdmin = sessionRoleEnvelope(decision).ok && role === "admin"` over the
 *     `AuthorizationDecision` the loader resolved, and hands the boolean to the
 *     presentational `ShellNav`. So the property projects an
 *     `AuthorizationDecision` arbitrary spanning all four identity states —
 *     `admin`, `member`, `anonymous`, `unknown` — through the real
 *     `sessionRoleEnvelope` seam to derive `isAdmin`, then renders the nav
 *     markup conditioned on `isAdmin` and asserts the `/admin` link is present
 *     exactly for the `admin` kind and absent for the other three.
 *
 *     `ShellNav` itself renders TanStack Router `<Link>`s, which reach for a
 *     `RouterProvider` at mount and so cannot render in a presentational test
 *     without standing up a whole router — the case the design's own Property 16
 *     note anticipates, calling instead for the decision to drive "the minimal
 *     nav markup the shell uses conditioned on `isAdmin`". So the render side is
 *     asserted over `ShellNavMarkup`, a faithful reproduction of the shell's
 *     admin-link markup (`data-slot`, `/admin` href, label) and its `{isAdmin ?
 *     … : null}` gate, while the `isAdmin` value driving it comes through the
 *     real projection seam.
 *   - the **email + sign-out control** is shown exactly when the request carries
 *     a valid Clerk session (Requirement 5.11). In the live app `<Show
 *     when="signed-in">` gates this on Clerk's client session; the shell's
 *     `ShellSessionControls` takes that gate as the boolean `hasClerkSession`
 *     and the bound email as `email`. So the property drives
 *     `ShellSessionControls` over a `hasClerkSession` boolean and an email
 *     arbitrary and asserts the email and a sign-out control appear exactly when
 *     `hasClerkSession` is true, and neither appears when it is false.
 *
 * `ShellSessionControls` is an exported presentational component — the same
 * prop-driven seam `RosterPage`/`AdminPage` expose — so each sample is a plain
 * `render` with no router and no live Clerk session, mirroring
 * `tests/property/adminPagePartialRender.property.test.tsx` and
 * `tests/property/resultRendering.property.test.tsx`. `RootLayout` keeps the
 * live `loader`/`Show`/`useUser` wiring that supplies `isAdmin`/`hasClerkSession`
 * from the real request; this file exercises the chrome rule those inputs drive.
 *
 * Clerk's `<UserButton>` (the sign-out control) needs a `ClerkProvider` to
 * mount, which the live app supplies but a presentational render does not, so
 * the `@clerk/tanstack-react-start` module is stubbed with a marked placeholder.
 * The gate the property is about — "shown exactly when `hasClerkSession`" — is
 * the shell's own `ShellSessionControls` logic, not Clerk's, so the placeholder
 * leaves the property intact: it only lets the sign-out control mount without a
 * provider so its presence or absence can be read.
 *
 * Globals are off (see `tests/setup/dom.ts`), so each sample tears its DOM down
 * in a `finally` rather than leaning on the `afterEach` cleanup, which would
 * otherwise leave 100 detached renders mounted for the whole assertion.
 *
 * `jest-dom` is not installed, so the assertions are plain DOM reads.
 *
 * Validates: Requirements 5.11, 6.11, 6.12
 */

// Feature: mongodb-google-auth-admin, Property 16: The shell chrome follows the identity state exactly

import fc from "fast-check"
import { describe, expect, it, vi } from "vitest"
import { cleanup, render } from "@testing-library/react"

import { ShellSessionControls } from "@/routes/__root"
import { sessionRoleEnvelope } from "@/functions/session.functions"
import type { UserAccountView } from "@/domain/accounts"
import type { AuthorizationDecision } from "@/server/authorization.server"
import type { StoreFailure } from "@/domain/types"

/*
 * Clerk's `<UserButton>` reaches for a `ClerkProvider` context at mount, which a
 * presentational render outside the app does not set up. The stub renders a
 * marked placeholder so the sign-out control can mount and be located; the
 * "shown exactly when a valid Clerk session" gate under test lives in the
 * shell's own `ShellSessionControls`, not in this component. `vi.mock` is
 * hoisted above these imports by Vitest, so `@/routes/__root` sees the stub.
 */
vi.mock("@clerk/tanstack-react-start", () => ({
  UserButton: () => <button data-testid="clerk-user-button">Sign out</button>,
}))

/* -------------------------------------------------------------------------- */
/* Arbitraries                                                                */
/* -------------------------------------------------------------------------- */

/** A signed-in email address (Requirement 5.11); never empty. */
const emailArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim() !== ""),
    fc.constantFrom("example.com", "hive.test", "mail.co.uk")
  )
  .map(([local, domain]) => `${local.trim()}@${domain}`)

/** A mirrored account holding the given role, with otherwise fixed fields. */
function accountWith(role: "admin" | "member"): fc.Arbitrary<UserAccountView> {
  return emailArb.map((email) => ({
    clerkUserId: "user_zzz-distinctive-clerk-id-zzz",
    email,
    displayName: "A Person",
    role,
    lastSignInAt: "2024-01-01T00:00:00.000Z",
  }))
}

/** A store failure carried by the `unknown` decision. */
const storeFailureArb: fc.Arbitrary<StoreFailure> = fc.record({
  reason: fc.constantFrom<StoreFailure["reason"]>(
    "not-configured",
    "unreachable",
    "rejected"
  ),
  message: fc.constantFrom(
    "The database is currently unavailable. Try again shortly.",
    "The database did not respond in time. Try again shortly."
  ),
})

/**
 * An `AuthorizationDecision` spanning all four request identity states the
 * chrome must distinguish: `anonymous` (no Clerk session), `member` (a session
 * whose account holds the Member_Role), `admin` (a session whose account holds
 * the Admin_Role), and `unknown` (a session whose Account_Role could not be
 * read). Each kind is weighted so all four are exercised.
 */
const authorizationDecisionArb: fc.Arbitrary<AuthorizationDecision> = fc.oneof(
  accountWith("admin").map((account): AuthorizationDecision => ({
    kind: "admin",
    account,
  })),
  accountWith("member").map((account): AuthorizationDecision => ({
    kind: "member",
    account,
  })),
  fc.constant<AuthorizationDecision>({ kind: "anonymous" }),
  storeFailureArb.map((failure): AuthorizationDecision => ({
    kind: "unknown",
    failure,
  }))
)

/* -------------------------------------------------------------------------- */
/* Rendering harness                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The nav markup the shell draws, conditioned on `isAdmin` exactly as the
 * exported `ShellNav` conditions it.
 *
 * `ShellNav` itself renders TanStack Router `<Link>`s, which reach for a
 * `RouterProvider` at mount and so cannot render in a presentational test
 * without standing up a whole router — machinery the design's Property 16 note
 * calls out as the case for asserting "the decision function drives link
 * presence by rendering the minimal nav markup the shell uses conditioned on
 * `isAdmin`". This reproduction is that minimal markup: the same `data-slot`,
 * href, and label the shell's admin `<Link>` renders to, and the same
 * `{isAdmin ? … : null}` gate, so the render consequence of `isAdmin` is
 * asserted here while the `isAdmin` value itself is driven through the real
 * `sessionRoleEnvelope` projection above. The standing links are plain anchors
 * to the same paths, so the admin link's absence reads as a withheld link
 * rather than an empty nav — the same distinction `ShellNav` draws.
 */
function ShellNavMarkup({ isAdmin }: { readonly isAdmin: boolean }) {
  return (
    <nav aria-label="Main">
      <a href="/">Redeem</a>
      <a href="/roster">Roster</a>
      <a href="/history">History</a>
      {isAdmin ? (
        <a href="/admin" data-slot="admin-link">
          Admin
        </a>
      ) : null}
    </nav>
  )
}

/** Renders `element` and tears the DOM down again after the assertions run. */
function withRender(
  element: React.ReactElement,
  assertions: (container: HTMLElement) => void
): void {
  const { container } = render(element)
  try {
    assertions(container)
  } finally {
    cleanup()
  }
}

/**
 * The shell's own reading of the admin-link decision: `isAdmin` is true exactly
 * when the projected Account_Role is the Admin_Role. This is the same expression
 * the root loader computes, run over the real `sessionRoleEnvelope` seam so the
 * property drives the projection rather than restating it.
 */
function shellIsAdmin(decision: AuthorizationDecision): boolean {
  const envelope = sessionRoleEnvelope(decision)
  return envelope.ok && envelope.data.role === "admin"
}

/* -------------------------------------------------------------------------- */
/* Properties                                                                 */
/* -------------------------------------------------------------------------- */

describe("shell chrome follows the identity state", () => {
  // Feature: mongodb-google-auth-admin, Property 16: The shell chrome follows
  // the identity state exactly — the Admin_Page navigation link is displayed
  // exactly when the bound User_Account holds the Admin_Role.
  // Validates: Requirements 6.11, 6.12
  it("shows the Admin_Page link exactly for the Admin_Role, across all four identity states", () => {
    fc.assert(
      fc.property(authorizationDecisionArb, (decision) => {
        const isAdmin = shellIsAdmin(decision)

        // The projection gates the link on the Admin_Role alone: true for the
        // `admin` kind, false for `member`, `anonymous`, and `unknown`.
        expect(isAdmin).toBe(decision.kind === "admin")

        withRender(<ShellNavMarkup isAdmin={isAdmin} />, (container) => {
          const adminLink = container.querySelector('[data-slot="admin-link"]')

          if (decision.kind === "admin") {
            // The Admin_Role: the link is present and points at the Admin_Page.
            expect(adminLink).not.toBe(null)
            expect(adminLink?.getAttribute("href")).toBe("/admin")
            expect(adminLink?.textContent).toBe("Admin")
          } else {
            // Member, anonymous, and unknown alike: the link is withheld, while
            // the standing links stay on the page.
            expect(adminLink).toBe(null)
          }

          // The non-admin links are present regardless of the identity state, so
          // the admin link's absence is a withheld link and not an empty nav.
          const hrefs = Array.from(container.querySelectorAll("a[href]")).map(
            (anchor) => anchor.getAttribute("href")
          )
          expect(hrefs).toContain("/")
          expect(hrefs).toContain("/roster")
          expect(hrefs).toContain("/history")
        })
      }),
      { numRuns: 200 }
    )
  })

  // Feature: mongodb-google-auth-admin, Property 16: The shell chrome follows
  // the identity state exactly — the bound User_Account's email and a sign-out
  // control are displayed exactly when the request carries a valid Clerk session.
  // Validates: Requirements 5.11
  it("shows the email and a sign-out control exactly when a valid Clerk session is carried", () => {
    fc.assert(
      fc.property(fc.boolean(), emailArb, (hasClerkSession, email) => {
        withRender(
          <ShellSessionControls
            hasClerkSession={hasClerkSession}
            email={email}
          />,
          (container) => {
            const emailSlot = container.querySelector(
              '[data-slot="session-email"]'
            )
            const signOut = container.querySelector('[data-slot="sign-out"]')

            if (hasClerkSession) {
              // A valid Clerk session: the email address and the sign-out
              // control are both on the page.
              expect(emailSlot).not.toBe(null)
              expect(emailSlot?.textContent).toBe(email)
              expect(signOut).not.toBe(null)
              expect(
                container.querySelector('[data-testid="clerk-user-button"]')
              ).not.toBe(null)
            } else {
              // No valid Clerk session: neither the email nor the sign-out
              // control renders at all.
              expect(emailSlot).toBe(null)
              expect(signOut).toBe(null)
              expect(container.textContent).toBe("")
            }
          }
        )
      }),
      { numRuns: 200 }
    )
  })

  // The email span is the only part withheld when a session carries no primary
  // email; the sign-out control still renders, so a signed-in reader can always
  // sign out even before the user object hydrates (Requirement 5.11).
  // Validates: Requirements 5.11
  it("keeps the sign-out control when a valid session carries no email", () => {
    fc.assert(
      fc.property(fc.constant(null), (email) => {
        withRender(
          <ShellSessionControls hasClerkSession email={email} />,
          (container) => {
            expect(container.querySelector('[data-slot="session-email"]')).toBe(
              null
            )
            expect(container.querySelector('[data-slot="sign-out"]')).not.toBe(
              null
            )
          }
        )
      }),
      { numRuns: 100 }
    )
  })
})
