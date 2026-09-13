/**
 * Unit tests for the roster page's two presentational components
 * (Requirements 1.2, 1.3, 1.4, 1.8, 1.10, 1.11, plus the confirmation of 1.5
 * and the toggle of 1.9).
 *
 * `RosterTable` and `AddMemberForm` hold no data fetching, so every case here
 * renders one component with plain props: no router, no query client, no server.
 *
 * The message helpers are imported from the modules that own them —
 * `duplicateHiveIdMessage`/`rosterFullMessage` from the store and
 * `lengthRangeMessage` from the shared schemas — so a test asserts the exact
 * sentence the application produces rather than a paraphrase that could drift.
 * The two `.server` modules only reach for `zod`, `node:crypto`, and `node:fs`
 * at module scope, all of which resolve in the jsdom project.
 *
 * The roster write path no longer carries a persistence warning of its own —
 * task 12.1 deleted `PERSISTENCE_WARNING` when Requirement 2.8 turned a failed
 * write into a rejection. `RosterTable` and `AddMemberForm` still render any
 * `warningMessage` prop they are handed, though, so the two cases that exercise
 * that rendering path feed it a plain fixture string ({@link WARNING_FIXTURE})
 * rather than sourcing it from a constant that no longer exists.
 *
 * `jest-dom` is not installed, so assertions are plain DOM reads: attribute
 * values, `value`, `textContent`, and `queryBy* === null`.
 */

import { describe, expect, it, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { AddMemberForm } from "@/components/AddMemberForm"
import {
  EMPTY_ROSTER_MESSAGE,
  ENABLED_STATE_LABELS,
  RosterTable,
} from "@/components/RosterTable"
import {
  HIVE_ID_MAX_LENGTH,
  MEMBER_LABEL_MAX_LENGTH,
  lengthRangeMessage,
} from "@/domain/schemas"
import {
  duplicateHiveIdMessage,
  rosterFullMessage,
} from "@/server/store/memberRegistry.server"
import type { AddMemberFormProps } from "@/components/AddMemberForm"
import type { MemberRegistryEntry } from "@/domain/types"

/**
 * A stand-in warning string for the two cases that prove `RosterTable` and
 * `AddMemberForm` render whatever `warningMessage` they are handed. The roster
 * write path produces no warning of its own any more (task 12.1), so the string
 * is a local fixture rather than an application constant.
 */
const WARNING_FIXTURE = "A stand-in warning the component is asked to display."

function entry(
  overrides: Partial<MemberRegistryEntry> & Pick<MemberRegistryEntry, "id">
): MemberRegistryEntry {
  return {
    memberLabel: `Member ${overrides.id}`,
    hiveId: `hive-${overrides.id}`,
    enabled: true,
    createdAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  }
}

/**
 * Insertion order that no naive sort could reproduce: not alphabetical by label
 * (`Zoe` first, `alice` second), not ordered by Hive_ID, and not ordered by id.
 */
const INSERTION_ORDER: readonly MemberRegistryEntry[] = [
  entry({ id: "m3", memberLabel: "Zoe", hiveId: "3003" }),
  entry({ id: "m1", memberLabel: "alice", hiveId: "1001", enabled: false }),
  entry({ id: "m2", memberLabel: "Bob", hiveId: "2002" }),
]

function rowCells(container: HTMLElement): string[][] {
  return Array.from(container.querySelectorAll("tbody tr")).map((row) =>
    Array.from(row.querySelectorAll("td")).map((cell) => cell.textContent)
  )
}

describe("RosterTable", () => {
  it("shows the empty-roster message and no table when the registry holds nothing", () => {
    const { container } = render(
      <RosterTable entries={[]} onSetEnabled={vi.fn()} onRemove={vi.fn()} />
    )

    expect(screen.getByRole("status").textContent).toBe(EMPTY_ROSTER_MESSAGE)
    expect(container.querySelector("table")).toBe(null)
    expect(screen.queryByRole("table")).toBe(null)
  })

  it("renders the entries in the given order, never sorted", () => {
    const { container } = render(
      <RosterTable
        entries={INSERTION_ORDER}
        onSetEnabled={vi.fn()}
        onRemove={vi.fn()}
      />
    )

    const cells = rowCells(container)

    expect(cells.map((row) => row[0])).toEqual(["Zoe", "alice", "Bob"])
    expect(cells.map((row) => row[1])).toEqual(["3003", "1001", "2002"])
  })

  it("shows each entry's enabled state as text", () => {
    const { container } = render(
      <RosterTable
        entries={INSERTION_ORDER}
        onSetEnabled={vi.fn()}
        onRemove={vi.fn()}
      />
    )

    expect(rowCells(container).map((row) => row[2])).toEqual([
      ENABLED_STATE_LABELS.enabled,
      ENABLED_STATE_LABELS.disabled,
      ENABLED_STATE_LABELS.enabled,
    ])
  })

  it("submits the new enabled state of the toggled row", async () => {
    const user = userEvent.setup()
    const onSetEnabled = vi.fn()
    render(
      <RosterTable
        entries={INSERTION_ORDER}
        onSetEnabled={onSetEnabled}
        onRemove={vi.fn()}
      />
    )

    await user.click(screen.getByRole("switch", { name: "Enabled: Zoe" }))
    await user.click(screen.getByRole("switch", { name: "Enabled: alice" }))

    expect(onSetEnabled.mock.calls).toEqual([
      ["m3", false],
      ["m1", true],
    ])
  })

  it("removes only after the dialog is confirmed", async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    render(
      <RosterTable
        entries={INSERTION_ORDER}
        onSetEnabled={vi.fn()}
        onRemove={onRemove}
      />
    )

    await user.click(screen.getByRole("button", { name: "Remove alice" }))

    // The trigger only opened the confirmation; nothing was removed yet.
    expect(onRemove.mock.calls.length).toBe(0)

    const dialog = screen.getByRole("dialog")
    await user.click(
      within(dialog).getByRole("button", { name: "Remove alice" })
    )

    expect(onRemove.mock.calls).toEqual([["m1"]])
  })

  it("displays the warning it is given", () => {
    render(
      <RosterTable
        entries={INSERTION_ORDER}
        onSetEnabled={vi.fn()}
        onRemove={vi.fn()}
        warningMessage={WARNING_FIXTURE}
      />
    )

    expect(screen.getByText(WARNING_FIXTURE)).toBeTruthy()
  })
})

describe("AddMemberForm", () => {
  const labelRangeMessage = lengthRangeMessage(
    "Member_Label",
    1,
    MEMBER_LABEL_MAX_LENGTH
  )
  const hiveRangeMessage = lengthRangeMessage("Hive_ID", 1, HIVE_ID_MAX_LENGTH)

  function renderForm(props: Partial<AddMemberFormProps> = {}) {
    const onSubmit = vi.fn()
    const view = render(<AddMemberForm onSubmit={onSubmit} {...props} />)
    return {
      ...view,
      onSubmit,
      memberLabel: screen.getByLabelText<HTMLInputElement>("Member label"),
      hiveId: screen.getByLabelText<HTMLInputElement>("Hive ID"),
      submit: screen.getByRole("button", { name: "Add member" }),
    }
  }

  it("rejects a blank member label without submitting", async () => {
    const user = userEvent.setup()
    const form = renderForm()

    await user.type(form.hiveId, "1001")
    await user.click(form.submit)

    expect(screen.getByRole("alert").textContent).toBe(labelRangeMessage)
    expect(form.memberLabel.getAttribute("aria-invalid")).toBe("true")
    expect(form.hiveId.value).toBe("1001")
    expect(form.onSubmit.mock.calls.length).toBe(0)
  })

  it("rejects an over-long member label, keeping the entered value", async () => {
    const user = userEvent.setup()
    const form = renderForm()
    const tooLong = "a".repeat(MEMBER_LABEL_MAX_LENGTH + 1)

    await user.type(form.memberLabel, tooLong)
    await user.type(form.hiveId, "1001")
    await user.click(form.submit)

    expect(screen.getByRole("alert").textContent).toBe(labelRangeMessage)
    // No `maxLength` on the input, so the over-long value is rejected whole
    // rather than silently truncated.
    expect(form.memberLabel.value).toBe(tooLong)
    expect(form.onSubmit.mock.calls.length).toBe(0)
  })

  it("rejects an over-long Hive ID, keeping the entered value", async () => {
    const user = userEvent.setup()
    const form = renderForm()
    const tooLong = "1".repeat(HIVE_ID_MAX_LENGTH + 1)

    await user.type(form.memberLabel, "Alice")
    await user.type(form.hiveId, tooLong)
    await user.click(form.submit)

    expect(screen.getByRole("alert").textContent).toBe(hiveRangeMessage)
    expect(form.hiveId.getAttribute("aria-invalid")).toBe("true")
    expect(form.hiveId.value).toBe(tooLong)
    expect(form.onSubmit.mock.calls.length).toBe(0)
  })

  it("submits the trimmed pair with its letter case preserved", async () => {
    const user = userEvent.setup()
    const form = renderForm()

    await user.type(form.memberLabel, "  Alice  ")
    await user.type(form.hiveId, "  1001  ")
    await user.click(form.submit)

    expect(form.onSubmit.mock.calls).toEqual([
      [{ memberLabel: "Alice", hiveId: "1001" }],
    ])
  })

  it("names the conflicting member and marks the Hive ID invalid on a duplicate", () => {
    const message = duplicateHiveIdMessage("Alice")
    const form = renderForm({ error: { code: "DUPLICATE_HIVE_ID", message } })

    expect(screen.getByText(message).textContent).toContain("Alice")
    expect(form.hiveId.getAttribute("aria-invalid")).toBe("true")
  })

  it("states the maximum roster size when the roster is full", () => {
    const message = rosterFullMessage()
    const form = renderForm({ error: { code: "ROSTER_FULL", message } })

    expect(screen.getByText(message).textContent).toContain("100")
    // The cap is a form-level rejection, not a rejection of the Hive_ID field.
    expect(form.hiveId.getAttribute("aria-invalid")).toBe("false")
  })

  it("displays the warning it is given", () => {
    renderForm({ warningMessage: WARNING_FIXTURE })

    expect(screen.getByText(WARNING_FIXTURE)).toBeTruthy()
  })
})
