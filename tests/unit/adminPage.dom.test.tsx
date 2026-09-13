/**
 * Smoke tests for the Admin_Page presentational component
 * (Requirements 8.1, 8.2, 8.3, 8.5, 8.7, 8.8, and the 6.6/6.15 refusal shape).
 *
 * `AdminPage` holds no data fetching — the overview arrives as a prop — so every
 * case renders it with plain props: no router, no server. These cases are the
 * light verification of the exact rendering rules; the exhaustive partial-render
 * property test is task 20.5 and is deliberately not duplicated here.
 *
 * Sentences are imported from the modules that own them — the failed-count
 * sentence and the guard refusals from `src/domain/storeMessages.ts`, and the
 * empty-accounts and Mock_Mode copy from `src/routes/admin.tsx` — so a test
 * asserts the exact text the application
 * renders rather than a paraphrase that could drift.
 *
 * `jest-dom` is not installed, so assertions are plain DOM reads: `textContent`,
 * `data-slot` lookups, and `queryBy* === null`.
 */

import { describe, expect, it } from "vitest"
import { render, screen, within } from "@testing-library/react"

import {
  authorizationUnknownMessage,
  mongoUnavailableCountMessage,
  notAuthorizedMessage,
} from "@/domain/storeMessages"
import {
  AdminPage,
  CONNECTION_INDICATOR_STATES,
  MOCK_MODE_STATES,
  NO_ACCOUNTS_MESSAGE,
} from "@/routes/admin"
import type { AdminAccountRow, AdminOverview } from "@/domain/accounts"

function overview(overrides: Partial<AdminOverview> = {}): AdminOverview {
  return {
    email: "owner@example.com",
    memberCount: { ok: true, value: 3 },
    historyCount: { ok: true, value: 7 },
    mockMode: false,
    connected: true,
    accounts: { ok: true, rows: [] },
    ...overrides,
  }
}

function row(overrides: Partial<AdminAccountRow> = {}): AdminAccountRow {
  return {
    email: "person@example.com",
    displayName: "A Person",
    role: "member",
    lastSignInAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  }
}

describe("AdminPage", () => {
  it("shows the email, both counts, the mock-mode word, and the connection state", () => {
    const { container } = render(
      <AdminPage
        overview={overview({
          email: "owner@example.com",
          memberCount: { ok: true, value: 12 },
          historyCount: { ok: true, value: 99 },
          mockMode: true,
          connected: true,
        })}
      />
    )

    expect(
      container.querySelector('[data-slot="admin-email"]')?.textContent
    ).toContain("owner@example.com")
    expect(
      within(
        container.querySelector<HTMLElement>('[data-slot="member-count"]')!
      ).getByText("12")
    ).toBeTruthy()
    expect(
      within(
        container.querySelector<HTMLElement>('[data-slot="history-count"]')!
      ).getByText("99")
    ).toBeTruthy()
    expect(
      container.querySelector('[data-slot="mock-mode"]')?.textContent
    ).toContain(MOCK_MODE_STATES.enabled)
    expect(
      container.querySelector('[data-slot="connection-indicator"]')?.textContent
    ).toBe(CONNECTION_INDICATOR_STATES.connected)
  })

  it("renders exactly the disabled/disconnected states from a false overview", () => {
    const { container } = render(
      <AdminPage overview={overview({ mockMode: false, connected: false })} />
    )

    expect(
      container.querySelector('[data-slot="mock-mode"]')?.textContent
    ).toContain(MOCK_MODE_STATES.disabled)
    expect(
      container.querySelector('[data-slot="connection-indicator"]')?.textContent
    ).toBe(CONNECTION_INDICATOR_STATES.disconnected)
  })

  it("replaces a failed count with the unreachable message and keeps the other count (8.5, 8.6)", () => {
    const { container } = render(
      <AdminPage
        overview={overview({
          memberCount: { ok: false, message: mongoUnavailableCountMessage() },
          historyCount: { ok: true, value: 42 },
        })}
      />
    )

    const memberCard = container.querySelector<HTMLElement>(
      '[data-slot="member-count"]'
    )!
    const historyCard = container.querySelector<HTMLElement>(
      '[data-slot="history-count"]'
    )!

    expect(
      within(memberCard).getByText(mongoUnavailableCountMessage())
    ).toBeTruthy()
    /* The sibling count still renders (partial page). */
    expect(within(historyCard).getByText("42")).toBeTruthy()
    /* The connection indicator is still shown alongside the failed read. */
    expect(
      container.querySelector('[data-slot="connection-indicator"]')
    ).not.toBe(null)
  })

  it("shows the empty-accounts message for a successful read of zero rows (8.7)", () => {
    render(
      <AdminPage overview={overview({ accounts: { ok: true, rows: [] } })} />
    )

    expect(screen.getByText(NO_ACCOUNTS_MESSAGE)).toBeTruthy()
    expect(screen.queryByRole("table")).toBe(null)
  })

  it("shows the account read's own sentence when the read did not complete (8.5)", () => {
    render(
      <AdminPage
        overview={overview({
          accounts: { ok: false, message: mongoUnavailableCountMessage() },
        })}
      />
    )

    expect(screen.getByText(mongoUnavailableCountMessage())).toBeTruthy()
    expect(screen.queryByText(NO_ACCOUNTS_MESSAGE)).toBe(null)
    expect(screen.queryByRole("table")).toBe(null)
  })

  it("shows the email in the name position when the display name trims to zero (8.8)", () => {
    const { container } = render(
      <AdminPage
        overview={overview({
          accounts: {
            ok: true,
            rows: [
              row({ email: "blank@example.com", displayName: "   " }),
              row({ email: "named@example.com", displayName: "Named Person" }),
            ],
          },
        })}
      />
    )

    const nameCells = Array.from(container.querySelectorAll("tbody tr th")).map(
      (cell) => cell.textContent
    )

    expect(nameCells).toEqual(["blank@example.com", "Named Person"])
  })

  it("renders the guard refusal sentence and no Admin_Page value for a member (6.6)", () => {
    render(
      <AdminPage
        overview={null}
        rejection={{ code: "NOT_AUTHORIZED", message: notAuthorizedMessage() }}
      />
    )

    expect(screen.getByRole("alert").textContent).toBe(notAuthorizedMessage())
    expect(screen.queryByText("owner@example.com")).toBe(null)
    expect(screen.queryByRole("table")).toBe(null)
  })

  it("renders the guard refusal sentence for an unknown authorization (6.15)", () => {
    render(
      <AdminPage
        overview={null}
        rejection={{
          code: "AUTHORIZATION_UNKNOWN",
          message: authorizationUnknownMessage(),
        }}
      />
    )

    expect(screen.getByRole("alert").textContent).toBe(
      authorizationUnknownMessage()
    )
  })
})
