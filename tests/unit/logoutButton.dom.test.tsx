/**
 * Unit tests for the logout control (Requirement 8.7).
 *
 * The control has to reach the `/logout` POST handler with no JavaScript, so the
 * markup itself is the contract: a form, `method="post"`, and a submit button.
 * A link, or a GET form, would let a prefetch or a crawler end a Session.
 */

import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"

import { LogoutButton } from "@/components/LogoutButton"

describe("LogoutButton", () => {
  it("posts to the logout endpoint", () => {
    render(<LogoutButton />)

    const button = screen.getByRole("button", { name: "Sign out" })
    const form = button.closest("form")

    expect(button.getAttribute("type")).toBe("submit")
    expect(form?.getAttribute("method")).toBe("post")
    expect(form?.getAttribute("action")).toBe("/logout")
  })

  it("renders no session detail", () => {
    const { container } = render(<LogoutButton />)

    expect(container.textContent).toBe("Sign out")
  })
})
