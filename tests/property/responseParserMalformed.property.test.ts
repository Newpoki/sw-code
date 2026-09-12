/**
 * Property 3 of the shared-coupon-redemption design: malformed Upstream_API
 * response bodies classify as TRANSPORT_ERROR with a message that names which
 * condition occurred (Requirement 4.6).
 *
 * The generator tags every sample with the condition it triggers, and
 * `MALFORMED_BODY_MESSAGES` holds the message the Response_Parser emits for
 * each condition, so the assertion below is stronger than "some message
 * exists": the message must name the condition that *actually* occurred, and
 * must name none of the other four. The first test pins the property that makes
 * that check meaningful — no message is a substring of another, so a wrong
 * condition cannot slip through.
 *
 * **Validates: Requirements 4.6**
 */

import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { parseUpstreamBody } from "@/domain/responseParser"
import { MALFORMED_BODY_MESSAGES, malformedBodySampleArb } from "./generators"
import type { MalformedBodyKind } from "./generators"

/** Requirements 4.1 / 4.6: a response message holds at most 500 characters. */
const MAX_MESSAGE_CHARS = 500

/** The five conditions Requirement 4.6 enumerates. */
const MALFORMED_BODY_KINDS = Object.keys(
  MALFORMED_BODY_MESSAGES
) as MalformedBodyKind[]

describe("Property 3: malformed responses classify as TRANSPORT_ERROR with a naming message", () => {
  it("names the five conditions with mutually distinguishable messages", () => {
    expect(MALFORMED_BODY_KINDS).toHaveLength(5)

    for (const kind of MALFORMED_BODY_KINDS) {
      for (const other of MALFORMED_BODY_KINDS) {
        if (other === kind) {
          continue
        }
        expect(MALFORMED_BODY_MESSAGES[kind]).not.toContain(
          MALFORMED_BODY_MESSAGES[other]
        )
      }
    }
  })

  // Feature: shared-coupon-redemption, Property 3: For any input that is an absent body, a body larger than 64 kilobytes, a string that is not valid JSON, a JSON object without a `retCode` field, or a JSON object whose `retCode` is neither a number nor a string, the Upstream_Result holds the Member_Outcome `TRANSPORT_ERROR`, an empty response code, and a message of at most 500 characters that names which of those five conditions occurred.
  // Validates: Requirements 4.6
  it("yields TRANSPORT_ERROR, an empty response code, and a bounded message naming the condition that occurred", () => {
    const kindsExercised = new Set<MalformedBodyKind>()

    fc.assert(
      fc.property(malformedBodySampleArb, (sample) => {
        kindsExercised.add(sample.kind)

        const result = parseUpstreamBody({ bodyText: sample.bodyText })

        expect(result.outcome).toBe("TRANSPORT_ERROR")
        expect(result.responseCode).toBe("")
        expect(result.responseMessage.length).toBeLessThanOrEqual(
          MAX_MESSAGE_CHARS
        )
        expect(result.responseMessage).toContain(
          MALFORMED_BODY_MESSAGES[sample.kind]
        )
        for (const other of MALFORMED_BODY_KINDS) {
          if (other === sample.kind) {
            continue
          }
          expect(result.responseMessage).not.toContain(
            MALFORMED_BODY_MESSAGES[other]
          )
        }
      }),
      // Above the 100-run minimum so every one of the five conditions is
      // exercised, which the coverage assertion below then confirms.
      { numRuns: 250 }
    )

    expect([...kindsExercised].sort()).toEqual([...MALFORMED_BODY_KINDS].sort())
  })
})
