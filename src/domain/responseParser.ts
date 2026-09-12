/**
 * Response_Parser: normalization, classification, and serialization of
 * Upstream_API response bodies (Requirements 4.1 - 4.10).
 *
 * Every function here is pure and total: no I/O, no globals beyond `JSON`,
 * `BigInt`, and `Number`, and no throw for any input, including values that
 * violate the declared parameter types. Classification depends only on the
 * normalized response code, which is what makes the round trip of
 * Requirement 4.8 hold.
 *
 * This module is client-safe: it imports only types from `src/domain/types.ts`
 * and nothing from `src/server/`, so the Web_Client and the property tests can
 * import it directly.
 *
 * ## Truncation is by UTF-16 code unit
 *
 * Requirements 4.1 and 4.9 cap the response code at 100 characters and the
 * response message at 500 characters. "Character" is read here as one UTF-16
 * code unit, so truncation is `String.prototype.slice`, and the invariants
 * `responseCode.length <= 100` and `responseMessage.length <= 500` hold for
 * every input. The consequence is that a truncation boundary that lands inside
 * a surrogate pair splits that pair and leaves a lone surrogate at the end of
 * the result. That is accepted deliberately: the alternative — slicing by code
 * point — would let `.length` reach 200 and 1000 code units respectively and
 * break the bound the requirements state. Upstream response codes are ASCII in
 * every documented example, so the boundary case is not reachable in practice.
 */

import type { MemberOutcomeValue, UpstreamResult } from "@/domain/types"

/** Requirement 4.1 / 4.9: the normalized response code holds <= 100 chars. */
const MAX_CODE_CHARS = 100

/** Requirements 4.1 / 4.6: a response message holds <= 500 chars. */
const MAX_MESSAGE_CHARS = 500

/** Requirement 4.1 / 4.6: 64 kilobytes, measured in UTF-8 bytes. */
const MAX_BODY_BYTES = 65_536

/**
 * The TRANSPORT_ERROR messages of Requirement 4.6. Each one names which of the
 * enumerated conditions occurred; the transport-failure message is built from
 * the failure flag instead, because that condition is reported by the
 * `UpstreamClient` rather than found in a body.
 */
const MESSAGES = {
  bodyAbsent: "response body absent",
  bodyTooLarge: "response body exceeds 64 kilobytes",
  invalidJson: "response body is not valid JSON",
  retCodeAbsent: "retCode field absent",
  retCodeWrongType: "retCode field is neither a number nor a string",
} as const

/** Keeps the first `limit` UTF-16 code units. See the module note above. */
function truncate(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value
}

/**
 * UTF-8 byte length of a string, computed without allocating a byte array.
 * A lone surrogate counts as 3 bytes, matching `TextEncoder`, which replaces
 * it with U+FFFD.
 */
function utf8ByteLength(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit < 0x80) {
      bytes += 1
    } else if (unit < 0x800) {
      bytes += 2
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else {
        bytes += 3
      }
    } else {
      bytes += 3
    }
  }
  return bytes
}

/**
 * Removes trailing fractional zeros, and a then-trailing decimal point, from a
 * rendered number (Requirement 4.9). Left alone when there is no fractional
 * part, and when the rendering carries an exponent, where trailing characters
 * are part of the exponent rather than of a fraction.
 */
function stripTrailingFractionalZeros(rendered: string): string {
  if (
    !rendered.includes(".") ||
    rendered.includes("e") ||
    rendered.includes("E")
  ) {
    return rendered
  }
  return rendered.replace(/0+$/, "").replace(/\.$/, "")
}

/**
 * Derives the normalized response code from a `retCode` value
 * (Requirement 4.9).
 *
 * - A string is trimmed of leading and trailing whitespace, with the case of
 *   the remaining characters preserved.
 * - A number is rendered as a decimal digit string with no grouping
 *   separators and no trailing fractional zeros. Safe integers go through
 *   `BigInt(value).toString()`, which avoids the exponential form
 *   `String(1e21)` produces. Values outside that range keep the rendering of
 *   `String(value)`, with trailing fractional zeros stripped.
 * - A non-finite number carries no decimal rendering, so it is treated the way
 *   Requirement 4.6 treats a `retCode` that is neither a number nor a string:
 *   the result is the empty string, which classifies as TRANSPORT_ERROR.
 *   `parseUpstreamBody` rejects such a value before reaching here.
 * - Anything else, reachable only when the declared parameter type is
 *   violated at runtime, yields the empty string rather than a throw.
 *
 * The result is truncated to 100 characters. The function is idempotent on its
 * own output for string input, which is what Requirement 4.8 rests on.
 *
 * A string is trimmed once more *after* truncation. Trimming only before would
 * leave trailing whitespace whenever the trimmed value is longer than 100
 * characters and its 100th character is whitespace (`'a'.repeat(99) + ' b'`),
 * and re-normalizing that result would trim that whitespace away — a second
 * parse would then disagree with the first and break the round trip of
 * Requirement 4.8. Requirement 4.9 is still met: the result holds no leading or
 * trailing whitespace and holds only characters taken from the first 100 of the
 * trimmed value. The second trim can never empty a non-empty result, because
 * the first trim guarantees the first character is not whitespace, so the
 * classification of Requirements 4.2 - 4.5 is unaffected.
 */
export function normalizeRetCode(raw: number | string): string {
  if (typeof raw === "string") {
    return truncate(raw.trim(), MAX_CODE_CHARS).trim()
  }
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return ""
  }
  if (Number.isSafeInteger(raw)) {
    return truncate(BigInt(raw).toString(), MAX_CODE_CHARS)
  }
  return truncate(stripTrailingFractionalZeros(String(raw)), MAX_CODE_CHARS)
}

/**
 * Derives the response message from a `retMsg` value: the empty string when it
 * is absent, null, or not a string (Requirement 4.10), otherwise the first 500
 * characters (Requirement 4.1).
 *
 * The message is neither trimmed nor unescaped. `<br/>` and every other
 * character arrive at the Web_Client exactly as received, which is the pairing
 * with Requirement 6.2's literal rendering.
 */
export function normalizeRetMsg(raw: unknown): string {
  return typeof raw === "string" ? truncate(raw, MAX_MESSAGE_CHARS) : ""
}

/** An Upstream_Result for one of the Requirement 4.6 conditions. */
function transportError(message: string): UpstreamResult {
  return {
    responseCode: "",
    responseMessage: truncate(message, MAX_MESSAGE_CHARS),
    outcome: "TRANSPORT_ERROR",
  }
}

/**
 * Maps a normalized response code to a Member_Outcome by exact,
 * case-sensitive comparison (Requirements 4.2 - 4.5).
 *
 * The empty-code case is the design decision recorded in design.md: a
 * `retCode` that is present but normalizes to nothing (`{"retCode":"   "}`) is
 * unclassified by the letter of Requirements 4.2 - 4.5, and is treated the way
 * an absent `retCode` is treated. It also keeps the round trip total, because
 * an Upstream_Result with an empty code survives serialize-then-parse.
 */
function classify(responseCode: string): MemberOutcomeValue {
  switch (responseCode) {
    case "100":
      return "SUCCESS"
    case "(H304)":
      return "ALREADY_USED"
    case "(H306)":
      return "INVALID_COUPON"
    case "":
      return "TRANSPORT_ERROR"
    default:
      return "UPSTREAM_ERROR"
  }
}

/**
 * Parses one raw Upstream_API response body into exactly one Upstream_Result
 * (Requirements 4.1 - 4.6, 4.9, 4.10). Total: every input, including a body of
 * arbitrary bytes, yields an Upstream_Result, and nothing throws.
 */
export function parseUpstreamBody(input: {
  bodyText: string | null
  transportFailure?: "timeout" | "network" | null
}): UpstreamResult {
  const transportFailure = input.transportFailure ?? null
  if (transportFailure !== null) {
    return transportError(`upstream request failed: ${transportFailure}`)
  }

  const bodyText = input.bodyText ?? null
  if (typeof bodyText !== "string") {
    return transportError(MESSAGES.bodyAbsent)
  }
  if (utf8ByteLength(bodyText) > MAX_BODY_BYTES) {
    return transportError(MESSAGES.bodyTooLarge)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText) as unknown
  } catch {
    return transportError(MESSAGES.invalidJson)
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Object.prototype.hasOwnProperty.call(parsed, "retCode")
  ) {
    return transportError(MESSAGES.retCodeAbsent)
  }

  const record = parsed as Record<string, unknown>
  const rawCode = record.retCode
  const isUsableCode =
    typeof rawCode === "string" ||
    (typeof rawCode === "number" && Number.isFinite(rawCode))
  if (!isUsableCode) {
    return transportError(MESSAGES.retCodeWrongType)
  }

  const responseCode = normalizeRetCode(rawCode)
  return {
    responseCode,
    responseMessage: normalizeRetMsg(record.retMsg),
    outcome: classify(responseCode),
  }
}

/**
 * Renders an Upstream_Result as an Upstream_API response body
 * (Requirement 4.7). `retCode` is always emitted as a JSON string — the type
 * of `UpstreamResult.responseCode` guarantees that — and `retMsg` holds the
 * response message with no character added or removed.
 */
export function serializeUpstreamResult(result: UpstreamResult): string {
  return JSON.stringify({
    retCode: result.responseCode,
    retMsg: result.responseMessage,
  })
}
