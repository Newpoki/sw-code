/**
 * Property 19 of shared-coupon-redemption: the confirmation dialog lists exactly
 * the enabled Group_Members.
 *
 * Requirement 2.5 asks the dialog to list "the Member_Label of every enabled
 * Group_Member in Member_Registry order". Three things can go wrong there, and
 * only a whole-list assertion catches all three: a disabled entry leaking in, a
 * sort or a de-duplication rewriting the list, and the order silently becoming
 * the enabled-first order of some other view. So this property compares the `li`
 * children of the roster list, read in DOM order, against the expected label
 * array positionally — never with a text query, because a Member_Label may hold
 * characters that make `getByText` ambiguous (two Group_Members legitimately
 * share a label, since only the Hive_ID is unique).
 *
 * `ConfirmRunDialog` fetches nothing and reads no router hook, so a bare
 * `render` with plain props is the whole harness: no router, no query client, no
 * server. `previousRun` is fixed at `null` here, which renders no Requirement 6.7
 * notice — that notice is Property 20's subject (task 14.8) and would only add
 * unrelated text to the dialog.
 *
 * The empty case is *inside* the property rather than filtered out of the
 * generator: `members` may legitimately arrive holding no enabled entry (the
 * whole registry may be handed over, and every entry may be disabled), and the
 * component answers that with a stated sentence instead of an empty list. A
 * property that filtered it away would never notice an empty `<ul>` appearing
 * there.
 *
 * `jest-dom` is not installed, so every assertion is a plain DOM read. Radix
 * renders the dialog into a portal, so the queries start at `document.body`
 * rather than at the render container, and `cleanup` runs inside the property
 * body — one `it` performs 100 renders, and the per-test `afterEach` of
 * `tests/setup/dom.ts` would only fire after the last of them.
 *
 * Validates: Requirements 2.5
 */

import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { cleanup, render } from "@testing-library/react"

import { ConfirmRunDialog } from "@/components/ConfirmRunDialog"
import type { MemberRegistryEntry } from "@/domain/types"

import { MAX_ROSTER_ENTRIES, enabledEntries, rosterArb } from "./generators"

/* -------------------------------------------------------------------------- */
/* Generators                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A Member_Registry of 0 to 100 entries, as Requirement 1.11 bounds it, with
 * arbitrary enabled flags and labels that are free to repeat.
 *
 * The size is weighted towards small rosters: the claim is about order and
 * membership, which a three-entry roster falsifies just as well as a
 * hundred-entry one, and every sample costs a full Radix dialog render. The
 * heavy branch still runs so the cap is exercised, and the small branch reaches
 * down to the empty roster.
 */
const dialogRosterArb: fc.Arbitrary<Array<MemberRegistryEntry>> = fc.oneof(
  { weight: 6, arbitrary: rosterArb({ maxLength: 5 }) },
  { weight: 3, arbitrary: rosterArb({ maxLength: 20 }) },
  {
    weight: 1,
    arbitrary: rosterArb({ minLength: 90, maxLength: MAX_ROSTER_ENTRIES }),
  }
)

/* -------------------------------------------------------------------------- */
/* DOM readers                                                                */
/* -------------------------------------------------------------------------- */

/** The roster list of the open dialog, or null when the empty branch rendered. */
function memberList(): HTMLUListElement | null {
  return document.body.querySelector<HTMLUListElement>(
    '[data-slot="confirm-member-list"]'
  )
}

/**
 * The text of every `li` of `list`, in DOM order. `textContent` of an element is
 * always a string, so no fallback is needed — and a Member_Label is never read
 * through a text query, which two Group_Members sharing a label would make
 * ambiguous.
 */
function listedLabels(list: HTMLUListElement): Array<string> {
  return Array.from(list.querySelectorAll("li")).map((item) => item.textContent)
}

/* -------------------------------------------------------------------------- */
/* Property                                                                   */
/* -------------------------------------------------------------------------- */

describe("ConfirmRunDialog roster listing", () => {
  // Feature: shared-coupon-redemption, Property 19: For any Member_Registry
  // holding at least one enabled entry, the confirmation dialog lists the
  // Member_Label of every enabled Group_Member in Member_Registry order and
  // lists no disabled Group_Member.
  // Validates: Requirements 2.5
  it("lists exactly the enabled Member_Labels, in Member_Registry order", () => {
    fc.assert(
      fc.property(dialogRosterArb, (members) => {
        // The expectation is derived the way Requirement 1.6 derives a fixed
        // list: a filter, which preserves order and keeps duplicates.
        const expected = enabledEntries(members).map(
          (entry) => entry.memberLabel
        )

        try {
          render(
            <ConfirmRunDialog
              couponCode="COUPON-2025"
              members={members}
              previousRun={null}
              onConfirm={() => {}}
              onDismiss={() => {}}
            />
          )

          const list = memberList()

          if (expected.length === 0) {
            // No enabled entry: the stated sentence, and no list at all. An
            // empty `<ul>` here would read as "nothing to show" to a screen
            // reader without saying why.
            expect(list).toBe(null)
            expect(document.body.textContent).toContain(
              "No group member is enabled"
            )
            return
          }

          if (list === null) {
            throw new Error(
              `expected the roster list to be rendered for ${expected.length} enabled entries`
            )
          }

          // The whole-list, positional comparison: exactly the enabled labels,
          // in the given array order, duplicates preserved, nothing sorted and
          // nothing de-duplicated. Any reorder shows up as an inequality here.
          expect(listedLabels(list)).toEqual(expected)

          // The count in the accessible name is the count that was listed, so
          // the announced name cannot drift from the visible list.
          expect(list.getAttribute("aria-label")).toBe(
            `Enabled group members (${expected.length})`
          )

          // The other half of "lists no disabled Group_Member": a disabled
          // entry whose label no enabled entry shares must appear in no `li`.
          // Restricted to labels that are absent from `expected`, because a
          // shared label is rightly listed on behalf of the enabled entry.
          const listed = new Set(listedLabels(list))
          const expectedLabels = new Set(expected)
          for (const entry of members) {
            if (entry.enabled || expectedLabels.has(entry.memberLabel)) continue
            expect(listed.has(entry.memberLabel)).toBe(false)
          }
        } finally {
          // 100 renders in one `it`, so each sample tears its own DOM down
          // instead of leaving the portal in place for the next one.
          cleanup()
        }
      }),
      { numRuns: 100 }
    )
  })
})
