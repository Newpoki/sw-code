/**
 * Property 1 of shared-coupon-redemption: the Response_Parser is total.
 *
 * The parser sits directly on network input, so every claim the rest of the
 * server makes about an Upstream_Result — that a Member_Outcome exists, that a
 * response code fits a history row, that a message fits a result row — rests on
 * this property holding for input nobody chose.
 *
 * Requirements 4.1 and 4.10.
 */

import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { parseUpstreamBody } from "@/domain/responseParser"
import { MEMBER_OUTCOME_VALUES } from "@/domain/types"
import type { UpstreamResult } from "@/domain/types"

import { MAX_BODY_BYTES, parserInputArb } from "./generators"
import type { ParserInput } from "./generators"

/** Requirement 4.1: the normalized response code holds <= 100 characters. */
const MAX_CODE_CHARS = 100

/** Requirement 4.1: the response message holds <= 500 characters. */
const MAX_MESSAGE_CHARS = 500

/** The three fields an Upstream_Result holds, and no others. */
const UPSTREAM_RESULT_KEYS = [
  "outcome",
  "responseCode",
  "responseMessage",
] as const

const encoder = new TextEncoder()

/** A short rendering of the input, so a counterexample is readable. */
function describeInput(input: ParserInput): string {
  const body =
    input.bodyText === null
      ? "null"
      : `${JSON.stringify(input.bodyText.slice(0, 120))} (${input.bodyText.length} chars)`
  return `bodyText=${body}, transportFailure=${String(input.transportFailure)}`
}

/**
 * The `retCode` value the parser would classify, or `null` when the parser never
 * reaches classification for this input — a transport failure, an absent body, a
 * body over 64 KiB, invalid JSON, a non-object, a missing `retCode`, or a
 * `retCode` that is neither a number nor a finite string.
 *
 * Derived here from the raw input rather than read back from the parser, so the
 * Requirement 4.10 clause below is checked against the body, not against the
 * result it is meant to constrain.
 */
function classifiableRetCode(input: ParserInput): {
  readonly retCode: number | string
  readonly retMsg: unknown
  readonly retMsgPresent: boolean
} | null {
  if (input.transportFailure !== null || input.bodyText === null) {
    return null
  }
  if (encoder.encode(input.bodyText).length > MAX_BODY_BYTES) {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(input.bodyText) as unknown
  } catch {
    return null
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Object.prototype.hasOwnProperty.call(parsed, "retCode")
  ) {
    return null
  }

  const record = parsed as Record<string, unknown>
  const retCode = record.retCode
  const usable =
    typeof retCode === "string" ||
    (typeof retCode === "number" && Number.isFinite(retCode))
  if (!usable) {
    return null
  }

  return {
    retCode,
    retMsg: record.retMsg,
    retMsgPresent: Object.prototype.hasOwnProperty.call(record, "retMsg"),
  }
}

describe("Response_Parser totality", () => {
  // Feature: shared-coupon-redemption, Property 1: For any input body text —
  // arbitrary Unicode strings, valid and invalid JSON, empty, and oversized —
  // together with any transport-failure flag, parseUpstreamBody returns exactly
  // one Upstream_Result whose response code holds at most 100 characters, whose
  // response message holds at most 500 characters, and whose Member_Outcome is
  // one of the six allowed values, without throwing.
  // Validates: Requirements 4.1, 4.10
  it("returns exactly one bounded Upstream_Result for every input, without throwing", () => {
    fc.assert(
      fc.property(parserInputArb, (input) => {
        let result: UpstreamResult
        try {
          result = parseUpstreamBody(input)
        } catch (error) {
          throw new Error(
            `parseUpstreamBody threw for ${describeInput(input)}: ${String(error)}`
          )
        }

        // Exactly one Upstream_Result: a single object holding the three
        // declared fields and nothing else.
        expect(typeof result).toBe("object")
        expect(result).not.toBeNull()
        expect(Array.isArray(result)).toBe(false)
        expect(Object.keys(result).sort()).toEqual([...UPSTREAM_RESULT_KEYS])

        // Requirement 4.1: both strings stay inside their character bounds and
        // the Member_Outcome is one of the six allowed values.
        expect(typeof result.responseCode).toBe("string")
        expect(result.responseCode.length).toBeLessThanOrEqual(MAX_CODE_CHARS)
        expect(typeof result.responseMessage).toBe("string")
        expect(result.responseMessage.length).toBeLessThanOrEqual(
          MAX_MESSAGE_CHARS
        )
        expect(MEMBER_OUTCOME_VALUES).toContain(result.outcome)

        // Requirement 4.10: an absent, null, or non-string `retMsg` yields an
        // empty response message, and the Member_Outcome comes from the
        // normalized code alone — identical to the outcome for a body holding
        // that same `retCode` and no `retMsg` at all.
        const classifiable = classifiableRetCode(input)
        if (
          classifiable !== null &&
          (!classifiable.retMsgPresent ||
            typeof classifiable.retMsg !== "string")
        ) {
          expect(result.responseMessage).toBe("")

          const codeOnly = parseUpstreamBody({
            bodyText: JSON.stringify({ retCode: classifiable.retCode }),
            transportFailure: null,
          })
          expect(result.responseCode).toBe(codeOnly.responseCode)
          expect(result.outcome).toBe(codeOnly.outcome)
        }
      }),
      { numRuns: 100 }
    )
  })
})
