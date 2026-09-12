// Feature: shared-coupon-redemption, Property 2: For any JSON body whose
// `retCode` is a number or a string, the normalized response code follows the
// normalization rule — a number rendered as a decimal digit string without
// grouping separators and without trailing fractional zeros, a string trimmed
// with its letter case preserved, truncated to 100 characters — and the derived
// Member_Outcome equals `SUCCESS` when that code is exactly `100`,
// `ALREADY_USED` when it is exactly `(H304)`, `INVALID_COUPON` when it is
// exactly `(H306)`, `UPSTREAM_ERROR` when it holds at least one character and
// matches none of those three under case-sensitive comparison, and
// `TRANSPORT_ERROR` when it holds no character; and the Upstream_Result retains
// that code together with the normalized response message, which is empty
// whenever `retMsg` was absent, null, or not a string.
//
// Validates: Requirements 4.2, 4.3, 4.4, 4.5, 4.9, 4.10.
//
// The normalization rule is restated here from the requirements rather than
// borrowed from the implementation: a string `retCode` has its expected code
// computed with `trim` + `slice`, and a number `retCode` is characterized by
// what the rule demands of the rendering (digits only, no grouping separator,
// no trailing fractional zero, same numeric value) instead of by re-running the
// renderer. `normalizeRetCode` and `normalizeRetMsg` appear only in the
// idempotence check, where the point is that the parser's own output is already
// normalized.

import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
  normalizeRetCode,
  normalizeRetMsg,
  parseUpstreamBody,
} from "@/domain/responseParser"
import { MEMBER_OUTCOME_VALUES } from "@/domain/types"
import type { MemberOutcomeValue } from "@/domain/types"

import {
  KNOWN_RET_CODES,
  RET_CODE_CASE_VARIANTS,
  retCodeStringArb,
  upstreamBodySampleArb,
} from "./generators"
import type { RetMsgSample } from "./generators"

/** Requirements 4.1 / 4.9: the normalized response code holds <= 100 chars. */
const MAX_CODE_CHARS = 100

/** Requirement 4.1: the response message holds <= 500 chars. */
const MAX_MESSAGE_CHARS = 500

/**
 * Requirement 4.9 for a string `retCode`: leading and trailing whitespace
 * removed, the letter case of the remaining characters untouched, the first 100
 * characters kept.
 */
function expectedCodeFromString(raw: string): string {
  return raw.trim().slice(0, MAX_CODE_CHARS)
}

/**
 * Requirement 4.10: the response message is the empty string when `retMsg` is
 * absent, null, or not a string, and otherwise the first 500 characters of the
 * value, neither trimmed nor unescaped.
 */
function expectedMessage(sample: RetMsgSample): string {
  if (!sample.present) {
    return ""
  }
  return typeof sample.value === "string"
    ? sample.value.slice(0, MAX_MESSAGE_CHARS)
    : ""
}

/** Requirements 4.2 - 4.5 as the case-sensitive mapping table they state. */
function expectedOutcomeForCode(code: string): MemberOutcomeValue {
  switch (code) {
    case "100":
      return "SUCCESS"
    case "(H304)":
      return "ALREADY_USED"
    case "(H306)":
      return "INVALID_COUPON"
    case "":
      // Requirements 4.2 - 4.5 leave a present-but-empty code unclassified; the
      // design decision is to treat it the way an absent code is treated.
      return "TRANSPORT_ERROR"
    default:
      return "UPSTREAM_ERROR"
  }
}

/** A body carrying exactly the given `retCode`, with no `retMsg`. */
function bodyWithCode(retCode: number | string): string {
  return JSON.stringify({ retCode })
}

function parseBody(bodyText: string) {
  return parseUpstreamBody({ bodyText, transportFailure: null })
}

function swapCase(character: string): string {
  const lower = character.toLowerCase()
  return character === lower ? character.toUpperCase() : lower
}

/**
 * A code that differs from a documented code only in letter case, plus the
 * near-miss variants of the shared generators. Requirement 4.5 compares
 * case-sensitively, so none of these may classify as the code it resembles.
 */
const caseVariantRetCodeArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 1, arbitrary: fc.constantFrom(...RET_CODE_CASE_VARIANTS) },
  {
    weight: 3,
    arbitrary: fc
      .constantFrom("(H304)", "(H306)")
      .chain((code) =>
        fc
          .array(fc.boolean(), {
            minLength: code.length,
            maxLength: code.length,
            size: "max",
          })
          .map((flips) =>
            Array.from(code, (character, index) =>
              flips[index] ? swapCase(character) : character
            ).join("")
          )
      )
      .filter((variant) => !KNOWN_RET_CODES.some((code) => code === variant)),
  }
)

/** Whitespace padding `trim` removes, including the empty padding. */
const paddingArb: fc.Arbitrary<string> = fc.constantFrom(
  "",
  " ",
  "   ",
  "\t",
  "\n",
  "\r\n",
  "\u00a0",
  " \t\n "
)

/** `retMsg` values Requirement 4.10 maps to the empty message. */
const nonStringRetMsgArb: fc.Arbitrary<unknown> = fc.oneof<
  Array<fc.Arbitrary<unknown>>
>(
  fc.constant(null),
  fc.integer(),
  fc.boolean(),
  fc.constant([]),
  fc.constant({ nested: "value" })
)

describe("Property 2: the normalized code determines the Member_Outcome", () => {
  it("normalizes retCode by the stated rule and derives the outcome from it", () => {
    fc.assert(
      fc.property(upstreamBodySampleArb, (sample) => {
        const result = parseBody(sample.bodyText)
        const code = result.responseCode

        // Requirement 4.1: the code is a string of at most 100 characters.
        expect(typeof code).toBe("string")
        expect(code.length).toBeLessThanOrEqual(MAX_CODE_CHARS)

        // Requirement 4.9, split by the two accepted `retCode` types.
        if (typeof sample.retCode === "string") {
          expect(code).toBe(expectedCodeFromString(sample.retCode))
        } else {
          const value = sample.retCode
          // A decimal rendering: digits, an optional sign, an optional
          // fraction, and — for magnitudes JavaScript renders exponentially —
          // an exponent. No grouping separator and no whitespace anywhere.
          expect(code).toMatch(/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i)
          expect(code).not.toMatch(/[\s,_']/)
          // No trailing fractional zeros: a rendered fraction never ends in a
          // zero, and never leaves a dangling decimal point.
          if (code.includes(".") && !/e/i.test(code)) {
            expect(code.endsWith("0")).toBe(false)
            expect(code.endsWith(".")).toBe(false)
          }
          // The rendering denotes the same number it was derived from. No
          // finite double renders to more than 100 characters, so truncation
          // cannot interfere; the guard states that rather than assuming it.
          if (code.length < MAX_CODE_CHARS) {
            expect(Number(code) === value).toBe(true)
          }
        }

        // Requirements 4.2 - 4.5: the code alone decides the Member_Outcome.
        // For a number the expectation is stated independently of the
        // rendering: only the value 100 can render to `100`, and no finite
        // number can render to `(H304)`, `(H306)`, or the empty string.
        const expectedOutcome =
          typeof sample.retCode === "string"
            ? expectedOutcomeForCode(expectedCodeFromString(sample.retCode))
            : sample.retCode === 100
              ? "SUCCESS"
              : "UPSTREAM_ERROR"
        expect(result.outcome).toBe(expectedOutcome)
        expect(MEMBER_OUTCOME_VALUES).toContain(result.outcome)

        // Requirements 4.2 - 4.5 / 4.10: the Upstream_Result retains the code
        // together with the normalized message.
        expect(result.responseMessage).toBe(expectedMessage(sample.retMsg))
        expect(result.responseMessage.length).toBeLessThanOrEqual(
          MAX_MESSAGE_CHARS
        )

        // The parser's own output is already normalized. Checked only when no
        // truncation happened, since truncating at 100 characters can expose
        // interior whitespace that a further trim would remove.
        if (code.length < MAX_CODE_CHARS) {
          expect(normalizeRetCode(code)).toBe(code)
        }
        expect(normalizeRetMsg(result.responseMessage)).toBe(
          result.responseMessage
        )
      }),
      { numRuns: 300 }
    )
  })

  it("classifies a documented code surrounded by whitespace, case preserved", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...KNOWN_RET_CODES),
        paddingArb,
        paddingArb,
        (knownCode, left, right) => {
          const result = parseBody(bodyWithCode(`${left}${knownCode}${right}`))

          expect(result.responseCode).toBe(knownCode)
          expect(result.outcome).toBe(expectedOutcomeForCode(knownCode))
        }
      ),
      { numRuns: 100 }
    )
  })

  it("treats a code that differs only in letter case as UPSTREAM_ERROR", () => {
    fc.assert(
      fc.property(caseVariantRetCodeArb, paddingArb, (variant, padding) => {
        const result = parseBody(bodyWithCode(`${padding}${variant}${padding}`))

        expect(result.responseCode).toBe(variant)
        expect(result.responseCode.length).toBeGreaterThan(0)
        expect(result.outcome).toBe("UPSTREAM_ERROR")
        expect(result.outcome).not.toBe("ALREADY_USED")
        expect(result.outcome).not.toBe("INVALID_COUPON")
        expect(result.outcome).not.toBe("SUCCESS")
      }),
      { numRuns: 100 }
    )
  })

  it("treats a present retCode that normalizes to nothing as TRANSPORT_ERROR", () => {
    fc.assert(
      fc.property(paddingArb, paddingArb, (left, right) => {
        const result = parseBody(bodyWithCode(`${left}${right}`))

        expect(result.responseCode).toBe("")
        expect(result.outcome).toBe("TRANSPORT_ERROR")
      }),
      { numRuns: 100 }
    )
  })

  it("derives the outcome from the code alone when retMsg is unusable", () => {
    fc.assert(
      fc.property(retCodeStringArb, nonStringRetMsgArb, (retCode, retMsg) => {
        const withoutMessage = parseBody(JSON.stringify({ retCode }))
        const withUnusableMessage = parseBody(
          JSON.stringify({ retCode, retMsg })
        )
        const withMessage = parseBody(
          JSON.stringify({ retCode, retMsg: "any message" })
        )

        // Requirement 4.10: absent, null, and non-string all mean no message.
        expect(withoutMessage.responseMessage).toBe("")
        expect(withUnusableMessage.responseMessage).toBe("")
        expect(withMessage.responseMessage).toBe("any message")

        // The message never moves the Member_Outcome.
        const expected = expectedOutcomeForCode(expectedCodeFromString(retCode))
        expect(withoutMessage.outcome).toBe(expected)
        expect(withUnusableMessage.outcome).toBe(expected)
        expect(withMessage.outcome).toBe(expected)

        // ... and never moves the code either.
        expect(withUnusableMessage.responseCode).toBe(
          withoutMessage.responseCode
        )
        expect(withMessage.responseCode).toBe(withoutMessage.responseCode)
      }),
      { numRuns: 100 }
    )
  })
})
