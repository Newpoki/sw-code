// Feature: shared-coupon-redemption, Property 18: For any entered value, the
// Web_Client submits exactly the value with leading and trailing whitespace
// removed and the letter case of the remainder preserved; and for any entered
// value holding fewer than 1 or more than 64 characters after that removal, the
// Web_Client displays a message stating the permitted length of 1 to 64
// characters, keeps the entered value in the input field, and sends no request
// to the Redemption_Server.
//
// Validates: Requirements 2.2, 2.3.
//
// ## What is under test, and what stands in for the request
//
// `CouponForm` is presentational: it holds the entered value in a prop and hands
// an accepted submission to `onSubmit`, which is where `src/routes/index.tsx`
// opens the confirmation dialog and, after confirmation, calls `runRedemption`.
// A call to `onSubmit` is therefore the only path by which a request can ever
// reach the Redemption_Server from this form, so "sends no request" is observed
// as "`onSubmit` was not called" and "submits exactly the trimmed value" is
// observed as the argument it was called with. Nothing is mocked away: the form
// renders with `@testing-library/react` and parses with the same
// `couponCodeSchema` the server validates with.
//
// ## The entered value is held by a harness, not by the assertion
//
// `CouponForm` owns no value state, so "keeps the entered value in the input
// field" would be trivially true if this test passed a constant prop. The
// {@link CouponFormHarness} below holds the value in `useState` and feeds every
// `onValueChange` back into it, exactly as the page does. If a rejected
// submission ever cleared or rewrote the field, it could only do so through that
// setter, and the `input.value` assertion would catch it.
//
// ## The rule is restated, not borrowed
//
// {@link isAcceptedValue} decides the expected verdict from the entered value
// alone — trim, then accept a length of 1 to 64 — rather than asking
// `couponCodeSchema` what it considers valid, because a test that asked the
// implementation would agree with a broken one. The single borrowed constant is
// {@link COUPON_CODE_MAX_LENGTH}, asserted below to be the 64 the requirement
// names, so the literal in this file cannot drift from the schema.
//
// ## Two neighbouring guards are held fixed
//
// Requirement 2.9 (`disabled`) short-circuits the handler before any parse and
// Requirement 2.4 (`hasEnabledMember: false`) rejects after the length check.
// Both would mask the behaviour claimed here, and both are covered by the unit
// tests of the redemption page, so this file renders with the submission control
// enabled and a non-empty enabled roster throughout.

import { useState } from "react"
import fc from "fast-check"
import { describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import {
  COUPON_CODE_LABEL,
  CouponForm,
  SUBMIT_LABEL,
} from "@/components/CouponForm"
import {
  COUPON_CODE_MAX_LENGTH,
  FIELD_NAMES,
  lengthRangeMessage,
} from "@/domain/schemas"

import {
  anyCouponCodeArb,
  blankTextArb,
  invalidCouponCodeArb,
  validCouponCodeArb,
  whitespacePaddingArb,
} from "./generators"

/* -------------------------------------------------------------------------- */
/* The rule, stated independently of the component                            */
/* -------------------------------------------------------------------------- */

/** The permitted range Requirements 2.2 and 2.3 name, written out. */
const MIN_LENGTH = 1
const MAX_LENGTH = 64

/** The exact sentence Requirement 2.3 demands, produced by the shared helper. */
const RANGE_MESSAGE = lengthRangeMessage(
  FIELD_NAMES.couponCode,
  MIN_LENGTH,
  MAX_LENGTH
)

/**
 * Whether an entered value passes the length guard: trim first, then measure in
 * UTF-16 code units, which is what `String.prototype.length` counts and what the
 * schema checks.
 */
function isAcceptedValue(value: string): boolean {
  const trimmed = value.trim()
  return trimmed.length >= MIN_LENGTH && trimmed.length <= MAX_LENGTH
}

/**
 * Replaces every carriage return and line feed with a space.
 *
 * A single-line `<input>` applies the HTML value sanitization algorithm, which
 * removes exactly those two characters from its value, so neither can ever sit
 * in the Coupon_Code field: typing them is impossible and a pasted line break is
 * dropped by the browser before the field holds it. The generated entries below
 * substitute a space instead, which leaves every sample in the same length class
 * — `trim` removes a space just as it removes a line feed — while keeping "the
 * entered value is retained in the input field" a claim about a value the field
 * can actually hold. The schema trims line breaks all the same, which the schema
 * unit tests and the server-side rejection property cover.
 */
function toSingleLine(value: string): string {
  return value.replace(/[\r\n]/g, " ")
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface HarnessProps {
  readonly initialValue: string
  readonly onSubmit: (couponCode: string) => void
}

/**
 * The form wired the way the redemption page wires it: the entered value lives
 * in state above the component, every keystroke flows back into that state, and
 * both client-side guards other than the length check are left open.
 */
function CouponFormHarness({ initialValue, onSubmit }: HarnessProps) {
  const [value, setValue] = useState(initialValue)
  return (
    <CouponForm
      value={value}
      onValueChange={setValue}
      onSubmit={onSubmit}
      disabled={false}
      hasEnabledMember={true}
    />
  )
}

interface SubmissionOutcome {
  /** Arguments of every `onSubmit` call, one array per call. */
  readonly submissions: Array<Array<string>>
  /** The value still sitting in the input field after the submission. */
  readonly fieldValue: string
  /** Text of the displayed guard message, or null when none is displayed. */
  readonly alertText: string | null
  /** The field's `aria-invalid` state, which announces the rejection. */
  readonly ariaInvalid: string | null
}

/**
 * Renders the form holding `entered`, activates the submission control, and
 * reports everything the property needs to read.
 *
 * `fireEvent.click` on the submit button is the activation of Requirement 2.2:
 * it produces the same `submit` event the `Enter` key would, without
 * `user-event`'s per-character timers, which is what keeps 100 runs of a full
 * React render inside the 30-second budget.
 */
function submitValue(entered: string): SubmissionOutcome {
  const onSubmit = vi.fn<(couponCode: string) => void>()
  render(<CouponFormHarness initialValue={entered} onSubmit={onSubmit} />)

  const input = screen.getByLabelText<HTMLInputElement>(COUPON_CODE_LABEL)
  // The value reaches the field untouched: neither trimmed nor cased on entry.
  expect(input.value).toBe(entered)

  fireEvent.click(screen.getByRole("button", { name: SUBMIT_LABEL }))

  const alert = screen.queryByRole("alert")
  return {
    submissions: onSubmit.mock.calls.map((call) => [...call]),
    fieldValue: input.value,
    alertText: alert === null ? null : alert.textContent,
    ariaInvalid: input.getAttribute("aria-invalid"),
  }
}

/* -------------------------------------------------------------------------- */
/* Local arbitraries                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Cased ASCII letters. A value built from these changes under a case swap, so a
 * form that folded the case of what it submits could not hide behind a sample
 * that holds no letters.
 */
const CASED_LETTERS = Array.from(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
)

/** A Coupon_Code of 1 to 64 cased letters, holding no whitespace. */
const casedCouponCodeArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...CASED_LETTERS), {
    minLength: MIN_LENGTH,
    maxLength: MAX_LENGTH,
    size: "max",
  })
  .map((letters) => letters.join(""))

/** Whitespace padding, holding no line break, that `trim` removes entirely. */
const paddingArb: fc.Arbitrary<string> = whitespacePaddingArb.map(toSingleLine)

/** Whitespace padding guaranteed to make the entered value differ from its trim. */
const nonEmptyPaddingArb: fc.Arbitrary<string> = paddingArb.filter(
  (padding) => padding.length > 0
)

/** An entry a single-line Coupon_Code field can hold, accepted by the guard. */
const enteredValidArb: fc.Arbitrary<string> =
  validCouponCodeArb.map(toSingleLine)

/** An entry the length guard rejects: blank, or over 64 characters trimmed. */
const enteredInvalidArb: fc.Arbitrary<string> = fc
  .oneof(
    { weight: 3, arbitrary: invalidCouponCodeArb },
    // The blank cases stated on their own, so the over-long samples of the
    // arbitrary above cannot squeeze them out.
    { weight: 1, arbitrary: blankTextArb }
  )
  .map(toSingleLine)

/** Any entry at all, accepted or rejected, for the classification property. */
const enteredAnyArb: fc.Arbitrary<string> = anyCouponCodeArb.map(toSingleLine)

function swapCase(value: string): string {
  return Array.from(value, (character) => {
    const lower = character.toLowerCase()
    return character === lower ? character.toUpperCase() : lower
  }).join("")
}

/* -------------------------------------------------------------------------- */
/* The property                                                               */
/* -------------------------------------------------------------------------- */

describe("Property 18: coupon submission trims, preserves case, and blocks invalid lengths", () => {
  it("keeps the permitted maximum of this test aligned with the schema", () => {
    // The 64 written into this file is the schema's maximum, not a second
    // opinion about it.
    expect(COUPON_CODE_MAX_LENGTH).toBe(MAX_LENGTH)
    expect(RANGE_MESSAGE).toContain(String(MIN_LENGTH))
    expect(RANGE_MESSAGE).toContain(String(MAX_LENGTH))
  })

  it("submits exactly the trimmed value for any accepted entry", () => {
    fc.assert(
      fc.property(enteredValidArb, (entered) => {
        try {
          const outcome = submitValue(entered)

          // Requirement 2.2: one submission, carrying the trimmed value with
          // every remaining character — letter case included — untouched.
          expect(outcome.submissions).toEqual([[entered.trim()]])
          // Nothing was rejected, so no guard message is displayed.
          expect(outcome.alertText).toBe(null)
          expect(outcome.ariaInvalid).toBe("false")
          // Requirement 2.8's retention starts here: the field still holds what
          // was entered, padding and all, not the trimmed submission.
          expect(outcome.fieldValue).toBe(entered)
        } finally {
          cleanup()
        }
      }),
      { numRuns: 100 }
    )
  })

  it("preserves the letter case of a padded entry, character for character", () => {
    fc.assert(
      fc.property(
        casedCouponCodeArb,
        nonEmptyPaddingArb,
        paddingArb,
        (core, left, right) => {
          const entered = `${left}${core}${right}`
          // The entry differs from its trimmed form, and only by whitespace, so
          // a submission of the entry itself would have to skip the trim.
          expect(entered).not.toBe(core)
          expect(entered.trim()).toBe(core)

          try {
            const outcome = submitValue(entered)

            expect(outcome.submissions).toEqual([[core]])
            // Folding the case either way would have produced a different
            // string, and the swapped variant is a different Coupon_Code.
            const submitted = outcome.submissions[0][0]
            expect(submitted).not.toBe(swapCase(core))
            expect(submitted.toLowerCase()).toBe(core.toLowerCase())
          } finally {
            cleanup()
          }
        }
      ),
      { numRuns: 100 }
    )
  })

  it("rejects a blank or over-long entry with the 1-to-64 message, sending nothing", () => {
    fc.assert(
      fc.property(enteredInvalidArb, (entered) => {
        expect(isAcceptedValue(entered)).toBe(false)

        try {
          const outcome = submitValue(entered)

          // Requirement 2.3: the message states the permitted length, the
          // entered value stays in the field, and nothing is submitted.
          expect(outcome.alertText).toBe(RANGE_MESSAGE)
          expect(outcome.alertText).toContain(String(MIN_LENGTH))
          expect(outcome.alertText).toContain(String(MAX_LENGTH))
          expect(outcome.fieldValue).toBe(entered)
          expect(outcome.submissions).toEqual([])
          expect(outcome.ariaInvalid).toBe("true")
        } finally {
          cleanup()
        }
      }),
      { numRuns: 100 }
    )
  })

  it("classifies every entry exactly as the trim-then-length rule predicts", () => {
    fc.assert(
      fc.property(enteredAnyArb, (entered) => {
        try {
          const outcome = submitValue(entered)

          // Whatever the entry, the field keeps it: acceptance and rejection
          // both leave the Group_Member's own text in place.
          expect(outcome.fieldValue).toBe(entered)

          if (isAcceptedValue(entered)) {
            expect(outcome.submissions).toEqual([[entered.trim()]])
            expect(outcome.alertText).toBe(null)
            return
          }

          expect(outcome.submissions).toEqual([])
          expect(outcome.alertText).toBe(RANGE_MESSAGE)
        } finally {
          cleanup()
        }
      }),
      { numRuns: 100 }
    )
  })
})
