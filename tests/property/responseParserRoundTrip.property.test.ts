import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
  parseUpstreamBody,
  serializeUpstreamResult,
} from "@/domain/responseParser"
import type { UpstreamResult } from "@/domain/types"

import {
  FIXTURE_BODIES,
  FIXTURE_FILE_NAMES,
  anyBodyTextArb,
  fixtureBodyArb,
} from "./generators"

/**
 * Property 4: the parse / serialize / parse round trip (Requirements 4.7, 4.8).
 *
 * ## What is asserted, and what is deliberately not
 *
 * The round trip is a statement about the **Upstream_Result**, not about the
 * body text. `serializeUpstreamResult(parseUpstreamBody(body))` is *not*
 * byte-identical to `body`, and asserting that it were would be wrong: the
 * documented success body carries `"retCode":100` as a JSON *number*, while
 * `UpstreamResult.responseCode` is a string, so the serialized body carries
 * `"retCode":"100"`. Requirement 4.7 mandates exactly that — `retCode` is
 * always emitted as a string — so the body cannot survive unchanged and the
 * requirement never asks it to.
 *
 * What must survive is meaning: the response code, the response message, and
 * the Member_Outcome of the second parse each equal those of the first parse.
 * That makes `parseUpstreamBody ∘ serializeUpstreamResult` the identity on the
 * image of `parseUpstreamBody`, which is what lets the serializer stand in for
 * a real upstream body anywhere in the app (Mock_Mode fixtures, stored history
 * rows, test stubs) without shifting a single Member_Outcome.
 *
 * ## Coverage of "FOR ALL documented bodies"
 *
 * Requirement 4.8 is stated over the bodies documented in the
 * API_Reference_Document. `anyBodyTextArb` unions those three fixture bodies in
 * with arbitrary, malformed, and Unicode bodies, so the documented cases are
 * among the generated ones — but a future edit to the shared generator could
 * silently drop them. The two `describe` blocks below therefore both exist: the
 * property covers "any body", and a separate table-driven test pins each of the
 * three documented bodies explicitly.
 */

/** The three fields Requirement 4.8 compares across the two parses. */
function resultFields(result: UpstreamResult) {
  return {
    responseCode: result.responseCode,
    responseMessage: result.responseMessage,
    outcome: result.outcome,
  }
}

/** Requirement 4.7: the serialized body as an upstream body is read back. */
function serializedFields(serialized: string): {
  retCode: unknown
  retMsg: unknown
} {
  return JSON.parse(serialized) as { retCode: unknown; retMsg: unknown }
}

// Feature: shared-coupon-redemption, Property 4: For any Upstream_API response body —
// including every body documented in the API_Reference_Document — parsing, then
// serializing, then parsing again yields an Upstream_Result whose response code,
// response message, and Member_Outcome each equal those of the first parse, and the
// serialized body holds the response message with no character added or removed.
describe("Property 4: parse / serialize / parse round trip", () => {
  it("preserves the response code, the response message, and the Member_Outcome for any body", () => {
    fc.assert(
      fc.property(anyBodyTextArb, (bodyText) => {
        const first = parseUpstreamBody({ bodyText })
        const serialized = serializeUpstreamResult(first)
        const second = parseUpstreamBody({ bodyText: serialized })

        // Requirement 4.8: the three Upstream_Result fields survive the trip.
        expect(resultFields(second)).toEqual(resultFields(first))
      }),
      { numRuns: 100 }
    )
  })

  it("serializes retCode as a JSON string and retMsg with no character added or removed", () => {
    fc.assert(
      fc.property(anyBodyTextArb, (bodyText) => {
        const result = parseUpstreamBody({ bodyText })
        const { retCode, retMsg } = serializedFields(
          serializeUpstreamResult(result)
        )

        // Requirement 4.7: `retCode` is a string, whatever the input type was.
        expect(typeof retCode).toBe("string")
        expect(retCode).toBe(result.responseCode)
        // Requirement 4.7: `retMsg` holds the message verbatim — same characters,
        // same order, same count. Markup such as `<br/>` stays as received.
        expect(retMsg).toBe(result.responseMessage)
        expect(retMsg as string).toHaveLength(result.responseMessage.length)
      }),
      { numRuns: 100 }
    )
  })

  it("holds for the documented bodies drawn on their own", () => {
    fc.assert(
      fc.property(fixtureBodyArb, (bodyText) => {
        const first = parseUpstreamBody({ bodyText })
        const second = parseUpstreamBody({
          bodyText: serializeUpstreamResult(first),
        })

        expect(resultFields(second)).toEqual(resultFields(first))
      }),
      { numRuns: 100 }
    )
  })
})

/**
 * Requirement 4.8 names the documented bodies specifically, so each one is
 * asserted by name here rather than only reached through a generator.
 */
describe("Requirement 4.8: every documented response body round-trips", () => {
  it.each(FIXTURE_FILE_NAMES.map((name) => ({ name })))(
    "$name survives parse / serialize / parse unchanged",
    ({ name }) => {
      const bodyText = FIXTURE_BODIES[name]
      const first = parseUpstreamBody({ bodyText })
      const serialized = serializeUpstreamResult(first)
      const second = parseUpstreamBody({ bodyText: serialized })

      expect(resultFields(second)).toEqual(resultFields(first))

      // Requirement 4.7 on the documented bodies: a string `retCode`, and a
      // `retMsg` identical to the parsed message.
      const { retCode, retMsg } = serializedFields(serialized)
      expect(typeof retCode).toBe("string")
      expect(retCode).toBe(first.responseCode)
      expect(retMsg).toBe(first.responseMessage)
    }
  )

  it("does not claim byte identity: the numeric retCode of the success body becomes a string", () => {
    // Guards the intent of this file against being "fixed" into a byte-identity
    // assertion. `{"retCode":100,...}` is documented with a JSON number, and
    // Requirement 4.7 requires the serializer to emit a string, so the bytes
    // differ by design while the Upstream_Result does not.
    const bodyText = FIXTURE_BODIES["success-100.json"]
    const serialized = serializeUpstreamResult(parseUpstreamBody({ bodyText }))

    expect(serialized).not.toBe(bodyText)
    expect(bodyText).toContain('"retCode":100')
    expect(serialized).toContain('"retCode":"100"')
  })
})

/**
 * Regression: the 100-character truncation boundary of Requirement 4.9.
 *
 * Trimming a string `retCode` only *before* truncating leaves trailing
 * whitespace whenever the trimmed value is longer than 100 characters and its
 * 100th character is whitespace. Re-normalizing that result trims the
 * whitespace away, so the second parse disagreed with the first and the round
 * trip of Requirement 4.8 broke. `anyBodyTextArb` does not currently reach a
 * `retCode` of that shape, so this case is pinned by example.
 */
describe("Requirement 4.8 at the code-truncation boundary", () => {
  const bodyText = JSON.stringify({
    retCode: `  ${"a".repeat(99)} ${"b".repeat(30)}  `,
    retMsg: "boundary",
  })

  it("round-trips a retCode whose 100th character is whitespace", () => {
    const first = parseUpstreamBody({ bodyText })
    const second = parseUpstreamBody({
      bodyText: serializeUpstreamResult(first),
    })

    expect(resultFields(second)).toEqual(resultFields(first))
  })

  it("holds no trailing whitespace and stays within 100 characters", () => {
    const { responseCode } = parseUpstreamBody({ bodyText })

    expect(responseCode).toBe("a".repeat(99))
    expect(responseCode.length).toBeLessThanOrEqual(100)
    expect(responseCode).toBe(responseCode.trim())
  })
})
