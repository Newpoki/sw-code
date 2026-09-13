/**
 * Shared fast-check arbitraries for the shared-coupon-redemption property tests.
 *
 * This module holds generators only: no `describe`, no `test`, no assertion, so
 * Vitest does not collect it. Every property test under `tests/property/`
 * imports from here, which keeps the edge cases the prework analysis identified
 * — whitespace padding, boundary lengths, non-ASCII text, oversized and
 * malformed bodies — in one place instead of scattered across test files.
 *
 * Three conventions hold throughout:
 *
 * 1. **Lengths are UTF-16 code units.** `String.prototype.length` is what
 *    `src/domain/schemas.ts` and `src/domain/responseParser.ts` measure, so the
 *    text arbitraries below produce a value whose `length` is exactly the length
 *    they were asked for, including the astral variants, which are built from
 *    surrogate pairs counted as two units each.
 * 2. **Valid and invalid are separate arbitraries.** A property that needs an
 *    accepted submission takes `validMemberLabelArb`; a property that needs a
 *    rejected one takes `invalidMemberLabelArb`. Neither has to filter.
 * 3. **Oversized bodies are built with `repeat`, never generated character by
 *    character.** One `String.prototype.repeat` call per sample keeps the
 *    64 KiB cases cheap enough to run at `numRuns: 100`.
 *
 * Requirements 4.1, 4.6, 4.8, 5.6.
 */

import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import fc from "fast-check"

import {
  HIVE_ID_MAX_LENGTH,
  COUPON_CODE_MAX_LENGTH,
  MEMBER_LABEL_MAX_LENGTH,
} from "@/domain/schemas"
import type { AccountRole, UserAccountView } from "@/domain/accounts"
import { MEMBER_OUTCOME_VALUES } from "@/domain/types"
import type {
  MemberOutcome,
  MemberOutcomeValue,
  MemberRegistryEntry,
  StoreFailure,
  StoreFailureReason,
} from "@/domain/types"
import type { UpstreamRawResponse } from "@/server/upstream/client"
import type { StoreDocument } from "@/server/store/jsonStore.server"
import type { UserAccountDocument } from "@/server/store/documents.server"
import type { GateHandlerType, GateAdmitReason } from "@/server/gate.server"
import type { AuthorizationDecision } from "@/server/authorization.server"

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** The three response fixtures mirrored from the API_Reference_Document. */
export const FIXTURE_FILE_NAMES = [
  "success-100.json",
  "already-used-h304.json",
  "invalid-coupon-h306.json",
] as const

export type FixtureFileName = (typeof FIXTURE_FILE_NAMES)[number]

/**
 * Absolute path of `fixtures/upstream/`.
 *
 * `import.meta.url` is the natural base and is what the `node` project sees. The
 * `jsdom` project transforms this module for a browser-like module graph, in
 * which `import.meta.url` is root-relative, so the `../../` walk climbs out of
 * the repository and lands on a path that does not exist. The Vitest root — the
 * repository root, and the working directory of the run — is the fallback, and
 * both resolutions name the same directory.
 */
function resolveFixtureDirectory(): string {
  try {
    const fromModule = fileURLToPath(
      new URL("../../fixtures/upstream/", import.meta.url)
    )
    if (existsSync(fromModule)) return fromModule
  } catch {
    // `import.meta.url` is not a `file:` URL under this transform.
  }
  return resolve(process.cwd(), "fixtures", "upstream")
}

const FIXTURE_DIRECTORY = resolveFixtureDirectory()

/**
 * Fixture bodies read from `fixtures/upstream/` as raw text, so the files stay
 * the single source of truth: nothing here restates a documented body, and a
 * fixture edit reaches every property test that unions these in.
 *
 * The read is synchronous and happens once at module load. The files carry no
 * trailing newline and the text is used unchanged, which is what Requirement 4.8
 * needs — the round trip is asserted over the documented bytes, not over a
 * re-formatted copy of them.
 */
export const FIXTURE_BODIES: Readonly<Record<FixtureFileName, string>> =
  Object.freeze(
    Object.fromEntries(
      FIXTURE_FILE_NAMES.map((name) => [
        name,
        readFileSync(join(FIXTURE_DIRECTORY, name), "utf8"),
      ])
    ) as Record<FixtureFileName, string>
  )

/**
 * The Member_Outcome the Response_Parser derives from each fixture
 * (Requirement 7.2). Used to script a stubbed response sequence that yields a
 * chosen outcome without restating a response body.
 */
export const FIXTURE_OUTCOMES: Readonly<
  Record<FixtureFileName, MemberOutcomeValue>
> = Object.freeze({
  "success-100.json": "SUCCESS",
  "already-used-h304.json": "ALREADY_USED",
  "invalid-coupon-h306.json": "INVALID_COUPON",
})

/** One of the three documented response bodies, read from disk. */
export const fixtureBodyArb: fc.Arbitrary<string> = fc.constantFrom(
  ...FIXTURE_FILE_NAMES.map((name) => FIXTURE_BODIES[name])
)

/* -------------------------------------------------------------------------- */
/* Text building blocks                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The boundary lengths named by the design: 1 and 40 bracket a Member_Label,
 * 1 and 64 bracket a Hive_ID and a Coupon_Code, and 41 and 65 are the first
 * length each of those rejects.
 */
export const BOUNDARY_LENGTHS = [1, 40, 41, 64, 65] as const

/**
 * Characters `String.prototype.trim` removes: ASCII whitespace, the no-break
 * space, the line separator, and the ideographic space. Every one of them is
 * one UTF-16 code unit.
 */
const WHITESPACE_UNITS = [
  " ",
  "\t",
  "\n",
  "\r",
  "\f",
  "\v",
  "\u00a0",
  "\u2028",
  "\u3000",
] as const

/** Non-ASCII characters that occupy exactly one UTF-16 code unit. */
const NON_ASCII_UNITS = [
  "é",
  "ü",
  "ñ",
  "ß",
  "Ω",
  "日",
  "本",
  "語",
  "→",
  "€",
] as const

/** A surrogate pair: two UTF-16 code units, one code point. */
const ASTRAL_CHARACTER = "😀"

/** One character that is neither whitespace nor a surrogate half. */
const nonBlankUnitArb: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc
      .integer({ min: 0x21, max: 0x7e })
      .map((code) => String.fromCharCode(code)),
  },
  { weight: 1, arbitrary: fc.constantFrom(...NON_ASCII_UNITS) }
)

/** Leading or trailing padding, possibly empty, that `trim` removes entirely. */
export const whitespacePaddingArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...WHITESPACE_UNITS), {
    minLength: 0,
    maxLength: 4,
    size: "max",
  })
  .map((units) => units.join(""))

/** Text of exactly `length` code units, holding no whitespace. */
function textOfLengthArb(length: number): fc.Arbitrary<string> {
  if (length <= 0) {
    return fc.constant("")
  }
  const fromUnits = fc
    .array(nonBlankUnitArb, {
      minLength: length,
      maxLength: length,
      size: "max",
    })
    .map((units) => units.join(""))
  // Same code-unit count, built from surrogate pairs, so truncation and length
  // checks are exercised on a value where a character spans two units.
  const fromAstral = fc.constant(
    ASTRAL_CHARACTER.repeat(Math.floor(length / 2)) +
      (length % 2 === 1 ? "a" : "")
  )
  return fc.oneof(
    { weight: 4, arbitrary: fromUnits },
    { weight: 1, arbitrary: fromAstral }
  )
}

/** Wraps a core value in whitespace padding that `trim` removes. */
function paddedArb(core: fc.Arbitrary<string>): fc.Arbitrary<string> {
  return fc
    .tuple(whitespacePaddingArb, core, whitespacePaddingArb)
    .map(([left, value, right]) => `${left}${value}${right}`)
}

/**
 * Text whose trimmed length lies in `1..maxLength`, biased towards the boundary
 * lengths of {@link BOUNDARY_LENGTHS} that fit. Holds no leading or trailing
 * whitespace, so it equals its own trimmed form.
 */
function trimmedTextArb(maxLength: number): fc.Arbitrary<string> {
  const boundaries = BOUNDARY_LENGTHS.filter((length) => length <= maxLength)
  return fc
    .oneof(
      { weight: 3, arbitrary: fc.constantFrom(...boundaries) },
      { weight: 2, arbitrary: fc.integer({ min: 1, max: maxLength }) }
    )
    .chain(textOfLengthArb)
}

/** Text that trims to nothing: the empty string or whitespace only. */
export const blankTextArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 1, arbitrary: fc.constant("") },
  {
    weight: 2,
    arbitrary: fc
      .array(fc.constantFrom(...WHITESPACE_UNITS), {
        minLength: 1,
        maxLength: 8,
        size: "max",
      })
      .map((units) => units.join("")),
  }
)

/** Text whose trimmed length exceeds `maxLength`, biased to `maxLength + 1`. */
function overlongTextArb(maxLength: number): fc.Arbitrary<string> {
  const boundaries = BOUNDARY_LENGTHS.filter((length) => length > maxLength)
  const lengths = boundaries.length > 0 ? boundaries : [maxLength + 1]
  return fc
    .oneof(
      { weight: 3, arbitrary: fc.constantFrom(...lengths) },
      {
        weight: 1,
        arbitrary: fc.integer({ min: maxLength + 1, max: maxLength + 40 }),
      }
    )
    .chain(textOfLengthArb)
}

/**
 * A field that is accepted after trimming: its trimmed form holds 1 to
 * `maxLength` code units. Half of the samples carry whitespace padding, so a
 * consumer sees both `value === value.trim()` and `value !== value.trim()`.
 */
function acceptedFieldArb(maxLength: number): fc.Arbitrary<string> {
  const core = trimmedTextArb(maxLength)
  return fc.oneof(
    { weight: 2, arbitrary: core },
    { weight: 1, arbitrary: paddedArb(core) }
  )
}

/** A field rejected by the 1..`maxLength` rule: blank, or too long. */
function rejectedFieldArb(maxLength: number): fc.Arbitrary<string> {
  return fc.oneof(
    { weight: 2, arbitrary: blankTextArb },
    { weight: 2, arbitrary: overlongTextArb(maxLength) },
    { weight: 1, arbitrary: paddedArb(overlongTextArb(maxLength)) }
  )
}

/* -------------------------------------------------------------------------- */
/* Member_Label, Hive_ID, Coupon_Code                                         */
/* -------------------------------------------------------------------------- */

/** Member_Label accepted by Requirement 1.1: 1 to 40 characters after trimming. */
export const validMemberLabelArb: fc.Arbitrary<string> = acceptedFieldArb(
  MEMBER_LABEL_MAX_LENGTH
)

/** Member_Label already trimmed, i.e. stored exactly as generated. */
export const trimmedMemberLabelArb: fc.Arbitrary<string> = trimmedTextArb(
  MEMBER_LABEL_MAX_LENGTH
)

/** Member_Label rejected by Requirement 1.3: blank, or over 40 characters. */
export const invalidMemberLabelArb: fc.Arbitrary<string> = rejectedFieldArb(
  MEMBER_LABEL_MAX_LENGTH
)

/** Either kind of Member_Label, for a property that classifies rather than assumes. */
export const anyMemberLabelArb: fc.Arbitrary<string> = fc.oneof(
  validMemberLabelArb,
  invalidMemberLabelArb
)

/** Hive_ID accepted by Requirement 1.1: 1 to 64 characters after trimming. */
export const validHiveIdArb: fc.Arbitrary<string> =
  acceptedFieldArb(HIVE_ID_MAX_LENGTH)

/** Hive_ID already trimmed, i.e. stored exactly as generated. */
export const trimmedHiveIdArb: fc.Arbitrary<string> =
  trimmedTextArb(HIVE_ID_MAX_LENGTH)

/** Hive_ID rejected by Requirement 1.3: blank, or over 64 characters. */
export const invalidHiveIdArb: fc.Arbitrary<string> =
  rejectedFieldArb(HIVE_ID_MAX_LENGTH)

/** Either kind of Hive_ID. */
export const anyHiveIdArb: fc.Arbitrary<string> = fc.oneof(
  validHiveIdArb,
  invalidHiveIdArb
)

/**
 * The marker every {@link sentinelHiveIdArb} value carries. Nothing the
 * Coupon_Code and Member_Label arbitraries produce holds this sequence in
 * practice, so finding it in a payload means a Hive_ID reached that payload.
 */
export const HIVE_ID_SENTINEL = "hive-sentinel-"

/** Characters `JSON.stringify` never escapes, used for the sentinel suffix. */
const SENTINEL_SUFFIX_UNITS = "0123456789abcdefghijklmnopqrstuvwxyz".split("")

/**
 * A Hive_ID built to be *searched for* rather than displayed: the
 * {@link HIVE_ID_SENTINEL} marker followed by 8 to 16 generated characters, so
 * every value is 22 to 30 characters long and stays inside the 64-character cap.
 *
 * A property that asserts a Hive_ID is *absent* from a payload cannot use
 * {@link trimmedHiveIdArb}, for two reasons. That arbitrary happily produces the
 * single character `c`, which every serialized payload holding the key
 * `couponCode` contains, so a substring search would report a leak that never
 * happened. It also produces quotation marks and backslashes, which serialization
 * escapes, so a Hive_ID that genuinely *did* leak would not be found by the same
 * search. Both hazards disappear here: the marker makes an accidental match
 * implausible, and the suffix alphabet survives `JSON.stringify` unchanged.
 *
 * Used by Property 11.
 */
export const sentinelHiveIdArb: fc.Arbitrary<string> = fc
  .string({
    unit: fc.constantFrom(...SENTINEL_SUFFIX_UNITS),
    minLength: 8,
    maxLength: 16,
  })
  .map((suffix) => `${HIVE_ID_SENTINEL}${suffix}`)

/** Coupon_Code accepted by Requirements 2.3 / 3.7: 1 to 64 after trimming. */
export const validCouponCodeArb: fc.Arbitrary<string> = acceptedFieldArb(
  COUPON_CODE_MAX_LENGTH
)

/** Coupon_Code already trimmed. */
export const trimmedCouponCodeArb: fc.Arbitrary<string> = trimmedTextArb(
  COUPON_CODE_MAX_LENGTH
)

/** Coupon_Code rejected by Requirements 2.3 / 3.7: blank, or over 64. */
export const invalidCouponCodeArb: fc.Arbitrary<string> = rejectedFieldArb(
  COUPON_CODE_MAX_LENGTH
)

/** Either kind of Coupon_Code. */
export const anyCouponCodeArb: fc.Arbitrary<string> = fc.oneof(
  validCouponCodeArb,
  invalidCouponCodeArb
)

/* -------------------------------------------------------------------------- */
/* Upstream_API response bodies                                               */
/* -------------------------------------------------------------------------- */

/** Requirements 4.1 / 4.6: the size limit of a response body, in UTF-8 bytes. */
export const MAX_BODY_BYTES = 65_536

/** The three response codes Requirements 4.2 - 4.4 classify by name. */
export const KNOWN_RET_CODES = ["100", "(H304)", "(H306)"] as const

/**
 * Case variants of the known codes. Requirement 4.5 compares case-sensitively,
 * so each of these must classify as `UPSTREAM_ERROR` rather than as the code it
 * resembles.
 */
export const RET_CODE_CASE_VARIANTS = [
  "(h304)",
  "(h306)",
  "(H304a)",
  "(H30 4)",
] as const

/** A `retCode` string value: known codes, case variants, padded, and long. */
export const retCodeStringArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(...KNOWN_RET_CODES) },
  {
    weight: 2,
    arbitrary: paddedArb(fc.constantFrom(...KNOWN_RET_CODES)),
  },
  { weight: 2, arbitrary: fc.constantFrom(...RET_CODE_CASE_VARIANTS) },
  { weight: 1, arbitrary: blankTextArb },
  { weight: 1, arbitrary: fc.constant("9".repeat(150)) },
  { weight: 2, arbitrary: fc.string({ unit: "grapheme" }) }
)

/**
 * A `retCode` number value. Every sample is finite, so it survives
 * `JSON.stringify` as a JSON number; a non-finite value is not representable in
 * JSON and is covered by the `ret-code-wrong-type` malformed case instead.
 *
 * The constants exercise the rendering rules of Requirement 4.9: an integer, a
 * value with trailing fractional zeros, a negative value, and a magnitude large
 * enough that `String(value)` reaches for exponential notation.
 */
export const retCodeNumberArb: fc.Arbitrary<number> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.constantFrom(
      100,
      100.0,
      100.5,
      0,
      -1,
      304,
      306,
      1.1,
      1e21,
      Number.MAX_SAFE_INTEGER
    ),
  },
  { weight: 2, arbitrary: fc.integer() },
  {
    weight: 1,
    arbitrary: fc
      .double({ noNaN: true, noDefaultInfinity: true })
      .filter((value) => Number.isFinite(value)),
  }
)

/** A `retCode` of either accepted type (Requirement 4.1). */
export const retCodeArb: fc.Arbitrary<number | string> = fc.oneof(
  retCodeStringArb,
  retCodeNumberArb
)

/**
 * A `retMsg` value. `{ present: false }` models the field being absent, which
 * `JSON.stringify` cannot express through `undefined`, so the field is omitted
 * from the payload instead.
 */
export type RetMsgSample =
  | { readonly present: false }
  | { readonly present: true; readonly value: unknown }

/**
 * `retMsg` values: strings, including one over the 500-character cap and one
 * carrying the `<br/>` fragment of the documented body, plus the absent, null,
 * and non-string cases of Requirement 4.10.
 */
export const retMsgSampleArb: fc.Arbitrary<RetMsgSample> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc
      .oneof(
        fc.string({ unit: "grapheme" }),
        fc.constantFrom(
          "The coupon gift has been sent.",
          "This coupon code has already been used.",
          "Invalid coupon code.<br/>Please check again.",
          "m".repeat(600)
        )
      )
      .map((value): RetMsgSample => ({ present: true, value })),
  },
  { weight: 2, arbitrary: fc.constant<RetMsgSample>({ present: false }) },
  {
    weight: 3,
    arbitrary: fc
      .oneof<Array<fc.Arbitrary<unknown>>>(
        fc.constant(null),
        fc.integer(),
        fc.boolean(),
        fc.array(fc.string({ unit: "grapheme-ascii" }), { maxLength: 3 }),
        fc.record({ nested: fc.string({ unit: "grapheme-ascii" }) })
      )
      .map((value): RetMsgSample => ({ present: true, value })),
  }
)

/**
 * A well-formed response body: valid JSON, an object, a `retCode` of an
 * accepted type. The generated inputs are exposed alongside the body text so a
 * property can state the expected normalization without re-parsing the body.
 */
export interface UpstreamBodySample {
  readonly retCode: number | string
  readonly retMsg: RetMsgSample
  /** The object that was serialized, including any extra ignored keys. */
  readonly payload: Readonly<Record<string, unknown>>
  readonly bodyText: string
}

/** Extra keys the Response_Parser must ignore. */
const extraKeysArb: fc.Arbitrary<Readonly<Record<string, unknown>>> = fc.oneof(
  { weight: 3, arbitrary: fc.constant<Record<string, unknown>>({}) },
  {
    weight: 1,
    arbitrary: fc.record({
      status: fc.integer(),
      data: fc.constant(null),
    }),
  }
)

/** Well-formed response bodies (Requirements 4.1, 4.9, 4.10). */
export const upstreamBodySampleArb: fc.Arbitrary<UpstreamBodySample> = fc
  .tuple(retCodeArb, retMsgSampleArb, extraKeysArb)
  .map(([retCode, retMsg, extraKeys]) => {
    const payload: Record<string, unknown> = { ...extraKeys, retCode }
    if (retMsg.present) {
      payload.retMsg = retMsg.value
    }
    return {
      retCode,
      retMsg,
      payload,
      bodyText: JSON.stringify(payload),
    }
  })

/** The five conditions Requirement 4.6 enumerates. */
export type MalformedBodyKind =
  | "absent"
  | "too-large"
  | "invalid-json"
  | "ret-code-absent"
  | "ret-code-wrong-type"

/**
 * The message the Response_Parser emits for each condition. Kept here so the
 * property test for Requirement 4.6 can assert that the message names the
 * condition that actually occurred, rather than merely that some message exists.
 */
export const MALFORMED_BODY_MESSAGES: Readonly<
  Record<MalformedBodyKind, string>
> = Object.freeze({
  absent: "response body absent",
  "too-large": "response body exceeds 64 kilobytes",
  "invalid-json": "response body is not valid JSON",
  "ret-code-absent": "retCode field absent",
  "ret-code-wrong-type": "retCode field is neither a number nor a string",
})

/** A body that triggers exactly one of the {@link MalformedBodyKind} conditions. */
export interface MalformedBodySample {
  readonly kind: MalformedBodyKind
  /** Null for the `absent` condition, a string otherwise. */
  readonly bodyText: string | null
}

/** True when `JSON.parse` rejects the text. */
function isInvalidJson(text: string): boolean {
  try {
    JSON.parse(text)
    return false
  } catch {
    return true
  }
}

/**
 * A body over 64 KiB, built with one `repeat` call. `extraBytes` pushes it past
 * the limit by a generated margin so the boundary is approached from just above
 * rather than from a single fixed size.
 */
function oversizedAsciiBody(extraBytes: number): string {
  const envelope = `{"retCode":100,"retMsg":""}`
  const filler = "x".repeat(MAX_BODY_BYTES - envelope.length + extraBytes)
  return `{"retCode":100,"retMsg":"${filler}"}`
}

/** A body over 64 KiB whose bytes come from four-byte characters. */
function oversizedAstralBody(): string {
  // Each surrogate pair is 4 UTF-8 bytes, so a quarter of the byte budget plus
  // one character clears the limit while keeping the string short.
  return `{"retCode":100,"retMsg":"${ASTRAL_CHARACTER.repeat(
    MAX_BODY_BYTES / 4 + 1
  )}"}`
}

/** Response bodies rejected by Requirement 4.6, tagged with the condition. */
export const malformedBodySampleArb: fc.Arbitrary<MalformedBodySample> =
  fc.oneof(
    {
      weight: 2,
      arbitrary: fc.constant<MalformedBodySample>({
        kind: "absent",
        bodyText: null,
      }),
    },
    {
      weight: 1,
      arbitrary: fc
        .oneof(
          fc.integer({ min: 1, max: 64 }).map(oversizedAsciiBody),
          fc.constant(oversizedAstralBody()),
          fc
            .integer({ min: 1, max: 64 })
            .map((extra) => "z".repeat(MAX_BODY_BYTES + extra))
        )
        .map((bodyText): MalformedBodySample => ({
          kind: "too-large",
          bodyText,
        })),
    },
    {
      weight: 3,
      arbitrary: fc
        .oneof(
          fc.constantFrom(
            "",
            "   ",
            "not json",
            "{",
            '{"retCode":}',
            "<html>503</html>",
            "{'retCode':100}"
          ),
          fc.string({ unit: "grapheme" }).filter(isInvalidJson)
        )
        .filter(isInvalidJson)
        .map((bodyText): MalformedBodySample => ({
          kind: "invalid-json",
          bodyText,
        })),
    },
    {
      weight: 3,
      arbitrary: fc
        .oneof<Array<fc.Arbitrary<unknown>>>(
          // Valid JSON that is not an object.
          fc.integer(),
          fc.boolean(),
          fc.constant(null),
          fc.string({ unit: "grapheme-ascii" }),
          // An object or array holding no `retCode`.
          fc.record({ retMsg: fc.string({ unit: "grapheme-ascii" }) }),
          fc.constant({}),
          fc.array(fc.integer(), { maxLength: 3 })
        )
        .map((value): MalformedBodySample => ({
          kind: "ret-code-absent",
          bodyText: JSON.stringify(value),
        })),
    },
    {
      weight: 3,
      arbitrary: fc
        .oneof<Array<fc.Arbitrary<unknown>>>(
          fc.constant(null),
          fc.boolean(),
          fc.array(fc.integer(), { maxLength: 3 }),
          fc.record({ value: fc.integer() })
        )
        .map((retCode): MalformedBodySample => ({
          kind: "ret-code-wrong-type",
          bodyText: JSON.stringify({ retCode, retMsg: "" }),
        })),
    }
  )

/**
 * Any response body text: well-formed, documented, malformed, and arbitrary
 * Unicode, including the empty string. Null is excluded — see
 * {@link parserInputArb} for the absent-body case.
 */
export const anyBodyTextArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 4, arbitrary: upstreamBodySampleArb.map((s) => s.bodyText) },
  { weight: 3, arbitrary: fixtureBodyArb },
  {
    weight: 2,
    arbitrary: malformedBodySampleArb
      .filter((sample) => sample.bodyText !== null)
      .map((sample) => sample.bodyText as string),
  },
  { weight: 2, arbitrary: fc.string({ unit: "grapheme" }) },
  { weight: 1, arbitrary: fc.json() }
)

/** The argument shape of `parseUpstreamBody`. */
export interface ParserInput {
  readonly bodyText: string | null
  readonly transportFailure: "timeout" | "network" | null
}

/**
 * Any parser input, including an absent body and both transport-failure flags.
 * This is the totality generator of Property 1.
 */
export const parserInputArb: fc.Arbitrary<ParserInput> = fc
  .tuple(
    fc.oneof(
      { weight: 9, arbitrary: anyBodyTextArb },
      { weight: 1, arbitrary: fc.constant<string | null>(null) }
    ),
    fc.oneof(
      {
        weight: 8,
        arbitrary: fc.constant<"timeout" | "network" | null>(null),
      },
      {
        weight: 1,
        arbitrary: fc.constant<"timeout" | "network" | null>("timeout"),
      },
      {
        weight: 1,
        arbitrary: fc.constant<"timeout" | "network" | null>("network"),
      }
    )
  )
  .map(([bodyText, transportFailure]) => ({ bodyText, transportFailure }))

/* -------------------------------------------------------------------------- */
/* Member_Registry rosters                                                    */
/* -------------------------------------------------------------------------- */

/** Requirement 1.11: the Member_Registry holds at most 100 entries. */
export const MAX_ROSTER_ENTRIES = 100

/** Fixed base instant so `createdAt` is deterministic across runs. */
const ROSTER_BASE_TIME = Date.parse("2025-01-04T18:00:00.000Z")

export interface RosterOptions {
  /** Defaults to 0, so the empty roster is generated too (Requirement 5.6). */
  readonly minLength?: number
  /** Defaults to {@link MAX_ROSTER_ENTRIES}. */
  readonly maxLength?: number
  /**
   * Forces at least one entry to hold the enabled state, which is what a
   * property about a Redemption_Run that actually issues a request needs
   * (Property 6). Implies `minLength >= 1`.
   */
  readonly atLeastOneEnabled?: boolean
  /**
   * The arbitrary the Hive_IDs are drawn from. Defaults to
   * {@link trimmedHiveIdArb}, which is what a property about the roster itself
   * wants. A property that asserts a Hive_ID never reaches somewhere passes
   * {@link sentinelHiveIdArb} instead — see the note there for why the default is
   * unusable for that (Property 11).
   */
  readonly hiveIdArb?: fc.Arbitrary<string>
}

/**
 * A Member_Registry: 0 to 100 entries in insertion order, Hive_IDs unique under
 * exact character comparison, arbitrary enabled flags, and `createdAt` values
 * that increase with position.
 *
 * Member_Labels and Hive_IDs come from the trimmed arbitraries, because a stored
 * entry always holds the trimmed value (Requirement 1.1). Labels are *not*
 * unique: two Group_Members may share a label, only the Hive_ID is a key.
 */
export function rosterArb(
  options: RosterOptions = {}
): fc.Arbitrary<Array<MemberRegistryEntry>> {
  const atLeastOneEnabled = options.atLeastOneEnabled ?? false
  const minLength = Math.max(options.minLength ?? 0, atLeastOneEnabled ? 1 : 0)
  const maxLength = Math.max(options.maxLength ?? MAX_ROSTER_ENTRIES, minLength)

  const seedArb = fc.record({
    memberLabel: trimmedMemberLabelArb,
    hiveId: options.hiveIdArb ?? trimmedHiveIdArb,
    enabled: fc.boolean(),
  })

  const entriesArb = fc
    .uniqueArray(seedArb, {
      minLength,
      maxLength,
      size: "max",
      selector: (seed) => seed.hiveId,
    })
    .map((seeds) =>
      seeds.map((seed, index): MemberRegistryEntry => ({
        id: `member-${index}`,
        memberLabel: seed.memberLabel,
        hiveId: seed.hiveId,
        enabled: seed.enabled,
        createdAt: new Date(ROSTER_BASE_TIME + index * 1000).toISOString(),
      }))
    )

  if (!atLeastOneEnabled) {
    return entriesArb
  }
  return entriesArb.chain((entries) =>
    fc
      .nat({ max: entries.length - 1 })
      .map((index) =>
        entries.map((entry, position) =>
          position === index ? { ...entry, enabled: true } : entry
        )
      )
  )
}

/**
 * The fixed list of a Redemption_Run: the enabled entries in roster order
 * (Requirements 1.6, 5.5).
 */
export function enabledEntries(
  roster: readonly MemberRegistryEntry[]
): Array<MemberRegistryEntry> {
  return roster.filter((entry) => entry.enabled)
}

/* -------------------------------------------------------------------------- */
/* Stubbed upstream response sequences                                        */
/* -------------------------------------------------------------------------- */

/** The five Member_Outcomes a single upstream response can produce. */
export type StubbableOutcome = Exclude<MemberOutcomeValue, "SKIPPED">

/**
 * Outcomes that let a Redemption_Run continue (Requirement 5.4). The default of
 * {@link stubSequenceArb}, so a property about a run that never stops early
 * needs no filter.
 */
export const NON_STOPPING_OUTCOMES: readonly StubbableOutcome[] = [
  "SUCCESS",
  "ALREADY_USED",
  "UPSTREAM_ERROR",
  "TRANSPORT_ERROR",
]

/** Every outcome a scripted response can produce, including the stopping one. */
export const ALL_STUBBABLE_OUTCOMES: readonly StubbableOutcome[] = [
  ...NON_STOPPING_OUTCOMES,
  "INVALID_COUPON",
]

/**
 * One scripted step of a stubbed `UpstreamClient`.
 *
 * A `response` step carries the raw response the stub returns together with the
 * Member_Outcome that response is built to produce, so a property can state its
 * expectation without parsing the body again. A `throw` step models the client
 * itself failing mid-run, which is the Requirement 5.8 path.
 */
export type StubStep =
  | {
      readonly kind: "response"
      readonly outcome: StubbableOutcome
      readonly response: UpstreamRawResponse
    }
  | { readonly kind: "throw"; readonly message: string }

/** A raw response built to produce `outcome` when parsed. */
function responseArb(
  outcome: StubbableOutcome
): fc.Arbitrary<UpstreamRawResponse> {
  switch (outcome) {
    case "SUCCESS":
      return fc.constant({
        bodyText: FIXTURE_BODIES["success-100.json"],
        status: 200,
        transportFailure: null,
      })
    case "ALREADY_USED":
      return fc.constant({
        bodyText: FIXTURE_BODIES["already-used-h304.json"],
        status: 200,
        transportFailure: null,
      })
    case "INVALID_COUPON":
      return fc.constant({
        bodyText: FIXTURE_BODIES["invalid-coupon-h306.json"],
        status: 200,
        transportFailure: null,
      })
    case "UPSTREAM_ERROR":
      return fc
        .constantFrom(...RET_CODE_CASE_VARIANTS, "(H999)", "500", "0")
        .map((retCode) => ({
          bodyText: JSON.stringify({ retCode, retMsg: "Unexpected code." }),
          status: 200,
          transportFailure: null,
        }))
    case "TRANSPORT_ERROR":
      return fc.oneof<Array<fc.Arbitrary<UpstreamRawResponse>>>(
        fc.constant({
          bodyText: null,
          status: null,
          transportFailure: "timeout",
        }),
        fc.constant({
          bodyText: null,
          status: null,
          transportFailure: "network",
        }),
        fc.constant({
          bodyText: "<html>502 Bad Gateway</html>",
          status: 502,
          transportFailure: null,
        })
      )
  }
}

/** A `response` step yielding `outcome`. */
export function stubStepArb(outcome: StubbableOutcome): fc.Arbitrary<StubStep> {
  return responseArb(outcome).map((response) => ({
    kind: "response" as const,
    outcome,
    response,
  }))
}

/** A `throw` step: the stubbed client rejects instead of answering. */
export const throwStepArb: fc.Arbitrary<StubStep> = fc
  .constantFrom(
    "stub upstream failure",
    "connection pool exhausted",
    "unexpected client defect"
  )
  .map((message) => ({ kind: "throw" as const, message }))

/**
 * A scripted sequence for a stubbed `UpstreamClient`, together with the
 * positions that make the run stop, so a property can assert against them
 * instead of re-deriving them.
 */
export interface StubSequence {
  readonly steps: readonly StubStep[]
  /** Position of the step yielding `INVALID_COUPON`, or null when absent. */
  readonly invalidCouponIndex: number | null
  /** Position of the throwing step, or null when absent. */
  readonly throwIndex: number | null
}

export interface StubSequenceOptions {
  /** Number of steps to script. Normally the fixed-list length. */
  readonly length: number
  /**
   * Outcomes allowed for the steps that are not deliberately placed. Defaults to
   * {@link NON_STOPPING_OUTCOMES}, so `INVALID_COUPON` appears only when
   * `withInvalidCoupon` asks for it.
   */
  readonly outcomes?: readonly StubbableOutcome[]
  /**
   * Places exactly one `INVALID_COUPON` at a generated position, which is the
   * early-stop trigger of Requirement 5.1. Ignored when `length` is 0.
   */
  readonly withInvalidCoupon?: boolean
  /**
   * Lets one step throw instead of answering, at a generated position that may
   * be 0 — the "throws before the first request" case of Requirement 5.8. Some
   * samples carry no throwing step at all.
   */
  readonly withThrow?: boolean
}

/**
 * A stubbed response sequence of exactly `options.length` steps.
 *
 * When both a stopping step and a throwing step are requested they never land on
 * the same position: the `INVALID_COUPON` placement wins and the throw moves
 * elsewhere or is dropped, so `invalidCouponIndex` and `throwIndex` always
 * describe two distinct steps and the earlier of the two is unambiguous.
 */
export function stubSequenceArb(
  options: StubSequenceOptions
): fc.Arbitrary<StubSequence> {
  const { length } = options
  const outcomes = options.outcomes ?? NON_STOPPING_OUTCOMES
  const wantsInvalidCoupon = (options.withInvalidCoupon ?? false) && length > 0
  const wantsThrow = (options.withThrow ?? false) && length > 0

  const baseStepsArb = fc.array(
    fc.constantFrom(...outcomes).chain(stubStepArb),
    { minLength: length, maxLength: length, size: "max" }
  )

  const positionArb: fc.Arbitrary<number | null> =
    length > 0 ? fc.nat({ max: length - 1 }) : fc.constant(null)

  const invalidCouponIndexArb: fc.Arbitrary<number | null> = wantsInvalidCoupon
    ? positionArb
    : fc.constant(null)

  const throwIndexArb: fc.Arbitrary<number | null> = wantsThrow
    ? fc.oneof(
        { weight: 1, arbitrary: fc.constant(null) },
        { weight: 3, arbitrary: positionArb }
      )
    : fc.constant(null)

  return fc
    .tuple(
      baseStepsArb,
      invalidCouponIndexArb,
      throwIndexArb,
      stubStepArb("INVALID_COUPON"),
      throwStepArb
    )
    .map(
      ([
        baseSteps,
        invalidCouponIndex,
        rawThrowIndex,
        invalidCouponStep,
        throwStep,
      ]) => {
        const steps = [...baseSteps]
        if (invalidCouponIndex !== null) {
          steps[invalidCouponIndex] = invalidCouponStep
        }
        const throwIndex =
          rawThrowIndex !== null && rawThrowIndex === invalidCouponIndex
            ? null
            : rawThrowIndex
        if (throwIndex !== null) {
          steps[throwIndex] = throwStep
        }
        return { steps, invalidCouponIndex, throwIndex }
      }
    )
}

/* -------------------------------------------------------------------------- */
/* Whole Redemption_Run scenarios                                             */
/* -------------------------------------------------------------------------- */

/**
 * Everything one Redemption_Run property needs: the Member_Registry, the fixed
 * list derived from it, the submitted Coupon_Code, and a scripted response
 * sequence long enough to answer every Group_Member of that fixed list.
 */
export interface RunScenario {
  readonly roster: readonly MemberRegistryEntry[]
  /** The enabled entries in roster order (Requirement 5.5). */
  readonly fixedList: readonly MemberRegistryEntry[]
  /** Already trimmed, so it is exactly the value the run submits upstream. */
  readonly couponCode: string
  readonly sequence: StubSequence
}

export interface RunScenarioOptions
  extends RosterOptions, Omit<StubSequenceOptions, "length"> {
  /**
   * Steps scripted beyond the fixed-list length. Defaults to 0. A positive value
   * lets a property show that the surplus steps are never consumed, i.e. that no
   * extra upstream request was issued.
   */
  readonly extraSteps?: number
}

/** A complete Redemption_Run scenario (Properties 5, 6, 7). */
export function runScenarioArb(
  options: RunScenarioOptions = {}
): fc.Arbitrary<RunScenario> {
  const extraSteps = options.extraSteps ?? 0
  return rosterArb(options).chain((roster) => {
    const fixedList = enabledEntries(roster)
    return fc
      .tuple(
        trimmedCouponCodeArb,
        stubSequenceArb({
          length: fixedList.length + extraSteps,
          outcomes: options.outcomes,
          withInvalidCoupon: options.withInvalidCoupon,
          withThrow: options.withThrow,
        })
      )
      .map(([couponCode, sequence]) => ({
        roster,
        fixedList,
        couponCode,
        sequence,
      }))
  })
}

/* -------------------------------------------------------------------------- */
/* Result-view rendering (Property 20)                                        */
/* -------------------------------------------------------------------------- */

/**
 * The two Member_Outcome values whose result row displays the response message
 * of its Upstream_Result (Requirement 6.2). Every other value, `SKIPPED`
 * included, shows the placeholder instead.
 */
export const MESSAGE_BEARING_OUTCOMES = [
  "UPSTREAM_ERROR",
  "TRANSPORT_ERROR",
] as const

/**
 * Message fragments that must reach the page as characters rather than as
 * markup. The first entry is the real `(H306)` body of the
 * API_Reference_Document — the reason Requirement 6.2 exists at all — and the
 * rest are the shapes an injected string would take if the message were ever
 * interpolated as HTML: element tags, an event handler, a table-structure
 * escape, HTML entities, and quote characters.
 */
export const MARKUP_MESSAGE_FRAGMENTS = [
  "Invalid coupon code.<br/>Please check again.",
  "<br/>",
  "<br>",
  "<script>alert(1)</script>",
  '<img src=x onerror="alert(1)">',
  "<b>bold</b><i>italic</i>",
  "</td></tr><tr><td>injected",
  "&lt;br/&gt;",
  "&amp;&quot;&#39;",
  "\"double\" and 'single' quotes",
  "1 < 2 && 3 > 2",
  "<<>>&",
  '<div style="display:none">hidden</div>',
] as const

/** One of the {@link MARKUP_MESSAGE_FRAGMENTS}. */
export const markupMessageFragmentArb: fc.Arbitrary<string> = fc.constantFrom(
  ...MARKUP_MESSAGE_FRAGMENTS
)

/**
 * A message built by interleaving markup fragments with arbitrary Unicode text,
 * so a sample carries markup characters both in isolation and surrounded by
 * text that could hide them.
 */
const composedHostileMessageArb: fc.Arbitrary<string> = fc
  .array(fc.tuple(markupMessageFragmentArb, fc.string({ unit: "grapheme" })), {
    minLength: 1,
    maxLength: 4,
    size: "max",
  })
  .map((parts) => parts.map(([fragment, text]) => fragment + text).join(""))

/**
 * A hostile response message of any length: a documented body, a composed
 * markup-and-text mixture, a bare fragment, and the empty string, which is what
 * an `UPSTREAM_ERROR` whose `retMsg` was absent carries (Requirement 4.10).
 */
export const hostileMessageArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 4, arbitrary: composedHostileMessageArb },
  { weight: 3, arbitrary: markupMessageFragmentArb },
  { weight: 1, arbitrary: fc.string({ unit: "grapheme" }) },
  { weight: 1, arbitrary: fc.constant("") }
)

/** Repeats `core` until it holds at least `length` code units. */
function grownToLength(core: string, length: number): string {
  const seed = core.length > 0 ? core : "x"
  return seed.repeat(Math.ceil(length / seed.length))
}

/**
 * A hostile message longer than `cap` code units, so the display truncation of
 * Requirement 6.2 is actually exercised.
 *
 * The `cap` is passed in rather than restated here, because the number lives in
 * `MAX_DISPLAYED_MESSAGE_CHARS` on the component that enforces it.
 *
 * Lengths are UTF-16 code units throughout, and the third case is deliberately
 * adversarial about that: it places a surrogate pair straddling the cap, so
 * truncating at `cap` cuts the pair in half and the displayed text ends on a
 * lone surrogate. `slice` is what the component uses, so that is the behaviour
 * the property states — no grapheme-aware rounding is claimed anywhere.
 */
export function overlongHostileMessageArb(cap: number): fc.Arbitrary<string> {
  const surplusArb = fc.integer({ min: 1, max: 700 })
  return fc.oneof(
    {
      weight: 3,
      arbitrary: fc
        .tuple(composedHostileMessageArb, surplusArb)
        .map(([core, surplus]) => grownToLength(core, cap + surplus)),
    },
    {
      weight: 2,
      arbitrary: surplusArb.map(
        (surplus) =>
          `${MARKUP_MESSAGE_FRAGMENTS[0]}${"filler ".repeat(
            Math.ceil((cap + surplus) / 7)
          )}<script>alert(1)</script>`
      ),
    },
    {
      // A surrogate pair straddling the cap: the message holds cap - 1 single
      // units, then astral characters.
      weight: 2,
      arbitrary: fc.constant(
        `${"x".repeat(Math.max(cap - 1, 0))}${ASTRAL_CHARACTER.repeat(3)}`
      ),
    },
    {
      weight: 1,
      arbitrary: fc
        .tuple(fc.string({ unit: "grapheme", minLength: 1 }), surplusArb)
        .map(([core, surplus]) => grownToLength(core, cap + surplus)),
    }
  )
}

/** The generated inputs of one result row, before a position is assigned. */
interface ResultOutcomeSeed {
  readonly memberLabel: string
  readonly outcome: MemberOutcomeValue
  readonly responseMessage: string
  readonly responseCode: string
}

export interface ResultOutcomesOptions {
  /** Defaults to 0, so the zero-row result view is generated too. */
  readonly minLength?: number
  /**
   * Defaults to 6. A handful of rows proves the ordering and the placeholder
   * rules; the 100-entry fixed list belongs to the coordinator properties.
   */
  readonly maxLength?: number
  /** Outcome values the rows may hold. Defaults to all six. */
  readonly outcomeValues?: readonly MemberOutcomeValue[]
  /** Message arbitrary for the Upstream_Results. Defaults to {@link hostileMessageArb}. */
  readonly messageArb?: fc.Arbitrary<string>
}

/**
 * The `outcomes` prop of the result view: a list of Member_Outcomes in
 * processing order, one per Group_Member of the fixed list of a Redemption_Run.
 *
 * Positions are assigned after generation so they always equal the array index,
 * which is what the coordinator produces (Requirement 5.5), and Hive_IDs are
 * derived from the position so no two rows collide on the React key. The Hive_ID
 * is not rendered by the result view, so nothing is lost by fixing it.
 *
 * Member_Labels come from {@link trimmedMemberLabelArb} and are *not* unique:
 * two Group_Members may share a label, so a property must compare rows
 * positionally rather than by looking a label up.
 *
 * A `SKIPPED` row carries `upstreamResult: null`, because no Upstream_API
 * request was issued for it (Requirement 5.2). Every other row carries a full
 * Upstream_Result, including the ones whose message the view does not display —
 * that is what lets a property assert the placeholder rather than merely observe
 * that no message was available.
 */
export function resultOutcomesArb(
  options: ResultOutcomesOptions = {}
): fc.Arbitrary<Array<MemberOutcome>> {
  const minLength = options.minLength ?? 0
  const maxLength = Math.max(options.maxLength ?? 6, minLength)
  const outcomeValues = options.outcomeValues ?? MEMBER_OUTCOME_VALUES
  const messageArb = options.messageArb ?? hostileMessageArb

  const seedArb: fc.Arbitrary<ResultOutcomeSeed> = fc.record({
    memberLabel: trimmedMemberLabelArb,
    outcome: fc.constantFrom(...outcomeValues),
    responseMessage: messageArb,
    responseCode: fc.constantFrom(...KNOWN_RET_CODES, "(H999)", "500", ""),
  })

  return fc.array(seedArb, { minLength, maxLength, size: "max" }).map((seeds) =>
    seeds.map((seed, position): MemberOutcome => {
      if (seed.outcome === "SKIPPED") {
        return {
          hiveId: `hive-${position}`,
          memberLabel: seed.memberLabel,
          position,
          outcome: "SKIPPED",
          upstreamResult: null,
        }
      }
      return {
        hiveId: `hive-${position}`,
        memberLabel: seed.memberLabel,
        position,
        outcome: seed.outcome,
        upstreamResult: {
          // A TRANSPORT_ERROR always holds the empty code (Requirement 4.6).
          responseCode:
            seed.outcome === "TRANSPORT_ERROR" ? "" : seed.responseCode,
          responseMessage: seed.responseMessage,
          outcome: seed.outcome,
        },
      }
    })
  )
}

/* -------------------------------------------------------------------------- */
/* Mongo_Connection_URIs                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The two schemes a MongoDB connection string may carry, restated here rather
 * than imported.
 *
 * `src/server/config.server.ts` exports the same pair, but this module is loaded
 * by both Vitest projects, including the `jsdom` one, and pulling a `.server`
 * module into it would drag server-only configuration into a browser-like module
 * graph for every property test that imports a generator. The property test that
 * uses these asserts the two lists agree, so the restatement cannot drift.
 */
export const MONGO_URI_SCHEMES = ["mongodb://", "mongodb+srv://"] as const

export type MongoUriScheme = (typeof MONGO_URI_SCHEMES)[number]

/** Characters a host label is built from. */
const HOST_UNITS = Array.from("abcdefghijklmnopqrstuvwxyz0123456789-.")

/** Characters a credential part and a database name are built from. */
const NAME_UNITS = Array.from(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_."
)

/** Text of 1 to `maxLength` units drawn from `units`. */
function joinedUnitsArb(
  units: readonly string[],
  maxLength: number
): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...units), {
      minLength: 1,
      maxLength,
      size: "max",
    })
    .map((drawn) => drawn.join(""))
}

/** One `host` or `host:port`. */
const singleHostArb: fc.Arbitrary<string> = fc
  .tuple(
    joinedUnitsArb(HOST_UNITS, 12),
    fc.option(fc.integer({ min: 1, max: 65_535 }), { nil: undefined })
  )
  .map(([host, port]) => (port === undefined ? host : `${host}:${port}`))

/**
 * A host list: one host, or the comma-separated replica-set form. The
 * multi-host form is the reason the parser under test does not use `new URL`, so
 * it belongs in the generator rather than in a single example.
 */
const mongoHostsArb: fc.Arbitrary<string> = fc
  .array(singleHostArb, { minLength: 1, maxLength: 3, size: "max" })
  .map((hosts) => hosts.join(","))

/**
 * The credentials of a connection string, including the trailing `@`, or the
 * empty string for a URI carrying none.
 *
 * Two of the cases place an extra `@` inside the password — one literal, one
 * percent-encoded — because the host list starts after the *last* `@` of the
 * authority, and a password holding one is exactly what makes that rule
 * observable.
 */
const mongoCredentialsArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 2, arbitrary: fc.constant("") },
  {
    weight: 3,
    arbitrary: fc
      .tuple(joinedUnitsArb(NAME_UNITS, 10), joinedUnitsArb(NAME_UNITS, 10))
      .map(([user, secret]) => `${user}:${secret}@`),
  },
  {
    weight: 1,
    arbitrary: fc
      .tuple(joinedUnitsArb(NAME_UNITS, 8), joinedUnitsArb(NAME_UNITS, 8))
      .map(([user, secret]) => `${user}:${secret}@vault@`),
  },
  {
    weight: 1,
    arbitrary: fc
      .tuple(joinedUnitsArb(NAME_UNITS, 8), joinedUnitsArb(NAME_UNITS, 8))
      .map(([user, secret]) => `${user}:${secret}%40vault@`),
  }
)

/**
 * A plausible database name: 1 to 20 characters holding neither `/` nor `?`,
 * neither of which a name may carry, and neither of which the resolution is
 * allowed to produce. A fifth of the samples are non-ASCII, since a name is not
 * restricted to ASCII.
 */
export const mongoDatabaseNameArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 4, arbitrary: joinedUnitsArb(NAME_UNITS, 20) },
  { weight: 1, arbitrary: joinedUnitsArb(NON_ASCII_UNITS, 8) }
)

/**
 * The path segment of a connection string as it is *written*, paired with the
 * database name it supplies once trimmed.
 *
 * `written` of null is a URI carrying no `/` at all; the empty string is the
 * trailing-slash form; a whitespace-only value and a padded name are what
 * Requirement 1.2's "after removal of leading and trailing whitespace
 * characters" is about.
 */
interface PathSegmentSample {
  readonly written: string | null
  readonly supplied: string
}

const pathSegmentSampleArb: fc.Arbitrary<PathSegmentSample> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.constant<PathSegmentSample>({ written: null, supplied: "" }),
  },
  {
    weight: 2,
    arbitrary: fc.constant<PathSegmentSample>({ written: "", supplied: "" }),
  },
  {
    weight: 2,
    arbitrary: fc
      .array(fc.constantFrom(...WHITESPACE_UNITS), {
        minLength: 1,
        maxLength: 4,
        size: "max",
      })
      .map((units): PathSegmentSample => ({
        written: units.join(""),
        supplied: "",
      })),
  },
  {
    weight: 6,
    arbitrary: fc
      .tuple(whitespacePaddingArb, mongoDatabaseNameArb, whitespacePaddingArb)
      .map(([left, name, right]): PathSegmentSample => ({
        written: `${left}${name}${right}`,
        supplied: name,
      })),
  }
)

/** The option string of a connection string, including the `?`, or empty. */
const mongoQueryArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: fc.constant("") },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      "?retryWrites=false",
      "?w=majority&readPreference=primary",
      "?authSource=admin&tls=true",
      "?replicaSet=rs0&appName=sw-code"
    ),
  }
)

/**
 * One generated Mongo_Connection_URI together with the parts it was assembled
 * from, so a property can state what the URI supplies without parsing it again.
 */
export interface MongoConnectionStringSample {
  readonly scheme: MongoUriScheme
  /** Credentials including the trailing `@`, or the empty string. */
  readonly credentials: string
  /** One host, or the comma-separated replica-set form. Never blank. */
  readonly hosts: string
  /** The path segment as written, or null for a URI carrying no `/`. */
  readonly pathSegment: string | null
  /** The option string including the `?`, or the empty string. */
  readonly query: string
  readonly leadingWhitespace: string
  readonly trailingWhitespace: string
  /** The assembled value, surrounding whitespace included. */
  readonly uri: string
  /** The database name this URI supplies: the trimmed path segment. */
  readonly suppliedDatabaseName: string
}

/**
 * A MongoDB connection string built from a scheme, a host list, an optional path
 * segment, and an optional query string, surrounded by arbitrary leading and
 * trailing whitespace (Requirements 1.1, 1.2 of `mongodb-google-auth-admin`).
 *
 * Every sample parses: the scheme is one of the two accepted ones and the host
 * list always holds at least one character after the credentials. What varies is
 * whether the URI supplies a database name at all, and how that name is spelled
 * — padded, whitespace-only, absent, or after a trailing slash.
 */
export const mongoConnectionStringSampleArb: fc.Arbitrary<MongoConnectionStringSample> =
  fc
    .record({
      scheme: fc.constantFrom(...MONGO_URI_SCHEMES),
      credentials: mongoCredentialsArb,
      hosts: mongoHostsArb,
      segment: pathSegmentSampleArb,
      query: mongoQueryArb,
      leadingWhitespace: whitespacePaddingArb,
      trailingWhitespace: whitespacePaddingArb,
    })
    .map((parts) => {
      const path =
        parts.segment.written === null ? "" : `/${parts.segment.written}`
      const core = `${parts.scheme}${parts.credentials}${parts.hosts}${path}${parts.query}`
      return {
        scheme: parts.scheme,
        credentials: parts.credentials,
        hosts: parts.hosts,
        pathSegment: parts.segment.written,
        query: parts.query,
        leadingWhitespace: parts.leadingWhitespace,
        trailingWhitespace: parts.trailingWhitespace,
        uri: `${parts.leadingWhitespace}${core}${parts.trailingWhitespace}`,
        suppliedDatabaseName: parts.segment.supplied,
      }
    })

/** Just the URI text of {@link mongoConnectionStringSampleArb}. */
export const mongoConnectionStringArb: fc.Arbitrary<string> =
  mongoConnectionStringSampleArb.map((sample) => sample.uri)

/* -------------------------------------------------------------------------- */
/* Legacy_Json_Store documents (Data_Import, Property 10)                     */
/* -------------------------------------------------------------------------- */

/**
 * The two caps the Data_Import applies: the first 100 accepted entries and the
 * newest 200 accepted records (Requirement 4.8). Restated from
 * `MEMBER_REGISTRY_MAX_ENTRIES` and `HISTORY_RETENTION_LIMIT` so this module
 * pulls in no `.server` code: `MEMBER_REGISTRY_MAX_ENTRIES` lives in
 * `@/domain/rosterMessages` and `HISTORY_RETENTION_LIMIT` in `@/domain/types`,
 * and the Property 10 test asserts the caps it uses equal the ones the planner
 * imports, so the restatement cannot drift.
 */
export const DATA_IMPORT_ENTRY_CAP = 100
export const DATA_IMPORT_RECORD_CAP = 200

/**
 * How a generated legacy entry stands against the Data_Import accept rule of
 * Requirement 4.7: `accepted` iff its trimmed Member_Label and trimmed Hive_ID
 * both hold 1..max characters and its trimmed Hive_ID does not duplicate an
 * earlier accepted one. `out-of-range` and `duplicate` are the two skip reasons,
 * carried on the sample so the property can count skips by reason rather than by
 * re-running the rule.
 */
export type LegacyEntryDisposition = "accepted" | "out-of-range" | "duplicate"

/** A generated legacy Member_Registry entry, tagged with why it is kept or skipped. */
export interface LegacyEntrySample {
  /** The entry as the Legacy_Json_Store holds it. `createdAt` may be absent. */
  readonly entry: LegacyMemberEntry
  /** Its standing against Requirement 4.7's entry rule, in isolation. */
  readonly disposition: LegacyEntryDisposition
  /**
   * True when this sample was built to duplicate an earlier accepted Hive_ID.
   * The whitespace-and-case variants live here, so the property knows a `trim`
   * collision was intended even though the raw strings differ.
   */
  readonly duplicatesEarlier: boolean
}

/**
 * A legacy Member_Registry entry as the operator's file holds it. `createdAt` is
 * optional, because Requirement 4.1 uses the startup timestamp for an entry that
 * holds none, and that branch has to be reachable. The other fields are always
 * present, matching what `parseStoreDocument` accepts.
 */
export interface LegacyMemberEntry {
  readonly id: string
  readonly memberLabel: string
  readonly hiveId: string
  readonly enabled: boolean
  readonly createdAt?: string
}

/**
 * A legacy Redemption_History record as the operator's file holds it. `seq` and
 * `completedAt` are loosened to optional and `seq` widened to allow the
 * non-finite values the planner treats as "holds none", because Requirement 4.1
 * assigns append counters to records that hold none and Requirement 4.7 skips
 * records that hold no completion timestamp — both branches have to be
 * reachable from a generated document.
 */
export interface LegacyHistoryRecord {
  readonly runId: string
  readonly seq?: number
  readonly couponCode: string
  readonly completedAt?: string
  readonly mock: boolean
  readonly stoppedEarly: boolean
  readonly outcomes: readonly {
    readonly hiveId: string
    readonly memberLabel: string
    readonly outcome: MemberOutcomeValue
    readonly responseCode: string
    readonly responseMessage: string
  }[]
}

/** How a generated legacy record stands against Requirement 4.7's record rule. */
export type LegacyRecordDisposition =
  "accepted" | "blank-coupon" | "no-timestamp"

/** A generated legacy Redemption_History record, tagged with why it is kept or skipped. */
export interface LegacyRecordSample {
  readonly record: LegacyHistoryRecord
  readonly disposition: LegacyRecordDisposition
  /** The instant its completion timestamp names, for the "most recent" cap; 0 when it holds none. */
  readonly completionMs: number
}

/** A `createdAt`/`completedAt` instant, spread across a wide window so the cap has ties and order to find. */
const LEGACY_BASE_TIME = Date.parse("2020-01-01T00:00:00.000Z")

/** A timestamp string at a generated offset from {@link LEGACY_BASE_TIME}, plus the instant it names. */
const legacyTimestampArb: fc.Arbitrary<{ iso: string; ms: number }> = fc
  .integer({ min: 0, max: 400 })
  .map((days) => {
    const ms = LEGACY_BASE_TIME + days * 86_400_000
    return { iso: new Date(ms).toISOString(), ms }
  })

/** A Hive_ID that trims into the 1..64 range, biased short so duplicates land often. */
const legacyValidHiveIdArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...NON_ASCII_UNITS, "a", "b", "c", "H", "0", "9"), {
    minLength: 1,
    maxLength: 6,
    size: "max",
  })
  .map((units) => units.join(""))

/**
 * An accepted legacy entry: both fields in range, possibly padded so the
 * planner's `trim` matters, and half the time carrying a `createdAt` while the
 * rest hold none.
 */
function acceptedLegacyEntryArb(
  index: number
): fc.Arbitrary<LegacyEntrySample> {
  return fc
    .record({
      memberLabel: validMemberLabelArb,
      hiveId: fc.oneof(
        { weight: 3, arbitrary: legacyValidHiveIdArb },
        { weight: 1, arbitrary: paddedArb(legacyValidHiveIdArb) }
      ),
      enabled: fc.boolean(),
      createdAt: fc.option(
        legacyTimestampArb.map((t) => t.iso),
        {
          nil: undefined,
        }
      ),
    })
    .map((fields): LegacyEntrySample => ({
      entry: {
        id: `legacy-member-${index}`,
        memberLabel: fields.memberLabel,
        hiveId: fields.hiveId,
        enabled: fields.enabled,
        ...(fields.createdAt === undefined
          ? {}
          : { createdAt: fields.createdAt }),
      },
      disposition: "accepted",
      duplicatesEarlier: false,
    }))
}

/** An entry skipped for an out-of-range Member_Label or Hive_ID (Requirement 4.7). */
function outOfRangeLegacyEntryArb(
  index: number
): fc.Arbitrary<LegacyEntrySample> {
  return fc
    .record({
      memberLabel: fc.oneof(validMemberLabelArb, invalidMemberLabelArb),
      hiveId: fc.oneof(validHiveIdArb, invalidHiveIdArb),
      enabled: fc.boolean(),
      createdAt: fc.option(
        legacyTimestampArb.map((t) => t.iso),
        {
          nil: undefined,
        }
      ),
    })
    .filter(
      (fields) =>
        fields.memberLabel.trim().length < 1 ||
        fields.memberLabel.trim().length > MEMBER_LABEL_MAX_LENGTH ||
        fields.hiveId.trim().length < 1 ||
        fields.hiveId.trim().length > HIVE_ID_MAX_LENGTH
    )
    .map((fields): LegacyEntrySample => ({
      entry: {
        id: `legacy-member-${index}`,
        memberLabel: fields.memberLabel,
        hiveId: fields.hiveId,
        enabled: fields.enabled,
        ...(fields.createdAt === undefined
          ? {}
          : { createdAt: fields.createdAt }),
      },
      disposition: "out-of-range",
      duplicatesEarlier: false,
    }))
}

/**
 * A list of legacy entries mixing accepted, out-of-range, and duplicate cases.
 *
 * Duplicates are woven in *after* the base list is generated, so a duplicate
 * always follows an entry it collides with under `trim` and case is
 * distinguished. A duplicate is produced three ways: the same trimmed Hive_ID
 * verbatim, the same value wrapped in whitespace (so the planner's `trim` is
 * what makes it a collision), and a case-flip (so it stays *distinct* and is
 * therefore an accepted entry, not a duplicate). The case-flip carries
 * `disposition: "accepted"`, because two Hive_IDs differing only in letter case
 * are two different Hive_IDs (Requirement 4.7).
 */
export function legacyEntryListArb(
  options: { minLength?: number; maxLength?: number } = {}
): fc.Arbitrary<ReadonlyArray<LegacyEntrySample>> {
  const minLength = options.minLength ?? 0
  const maxLength = options.maxLength ?? 8
  const baseArb = fc.array(
    fc
      .nat()
      .chain((seed) =>
        fc.oneof(
          { weight: 3, arbitrary: acceptedLegacyEntryArb(seed) },
          { weight: 2, arbitrary: outOfRangeLegacyEntryArb(seed) }
        )
      ),
    { minLength, maxLength, size: "max" }
  )

  return baseArb.chain((base) => {
    // Choose how many duplicate entries to weave in, capped by the base length.
    const maxDuplicates = Math.min(base.length, 4)
    return fc
      .array(
        fc.record({
          sourceIndex: fc.nat({ max: Math.max(base.length - 1, 0) }),
          variant: fc.constantFrom<"verbatim" | "whitespace" | "case">(
            "verbatim",
            "whitespace",
            "case"
          ),
          insertAfter: fc.nat({ max: Math.max(base.length, 0) }),
        }),
        { minLength: 0, maxLength: maxDuplicates, size: "max" }
      )
      .map((duplications) => {
        const result: LegacyEntrySample[] = base.map((sample) => sample)

        let counter = base.length
        for (const dup of duplications) {
          if (base.length === 0) break
          const source = base[Math.min(dup.sourceIndex, base.length - 1)]
          // Only entries that would themselves be accepted can seed a duplicate;
          // an out-of-range source has no trimmed Hive_ID worth colliding with.
          if (source.disposition !== "accepted") continue
          const trimmed = source.entry.hiveId.trim()
          const hiveId =
            dup.variant === "verbatim"
              ? trimmed
              : dup.variant === "whitespace"
                ? `  ${trimmed}  `
                : flipCase(trimmed)
          const isCaseFlip =
            dup.variant === "case" && flipCase(trimmed) !== trimmed
          const sample: LegacyEntrySample = {
            entry: {
              id: `legacy-dup-${counter}`,
              memberLabel: source.entry.memberLabel,
              hiveId,
              enabled: source.entry.enabled,
            },
            // A case-flip that actually changes the string is a *distinct*
            // Hive_ID, so it is an accepted entry, not a duplicate. A case-flip
            // that changes nothing (all-digit Hive_ID) collides like verbatim.
            disposition: isCaseFlip ? "accepted" : "duplicate",
            duplicatesEarlier: !isCaseFlip,
          }
          counter += 1
          const at = Math.min(dup.insertAfter, result.length)
          result.splice(at, 0, sample)
        }
        return result
      })
  })
}

/** Swaps the letter case of every cased character; leaves caseless characters be. */
function flipCase(value: string): string {
  let flipped = ""
  for (const char of value) {
    const upper = char.toUpperCase()
    const lower = char.toLowerCase()
    flipped += char === lower && char !== upper ? upper : lower
  }
  return flipped
}

/** One outcome row of a legacy record, kept small since the planner copies it verbatim. */
const legacyOutcomeRowArb = fc.record({
  hiveId: legacyValidHiveIdArb,
  memberLabel: trimmedMemberLabelArb,
  outcome: fc.constantFrom(...MEMBER_OUTCOME_VALUES),
  responseCode: fc.constantFrom("100", "(H304)", "(H306)", ""),
  responseMessage: fc.string({ unit: "grapheme-ascii", maxLength: 20 }),
})

/**
 * A `seq` value a legacy record may carry: a finite counter, one that repeats
 * a value another record could also hold (so preserved values can collide with
 * would-be assigned ones and the planner has to climb above them), or one of the
 * "holds none" shapes — absent, `NaN`, or an infinity — that Requirement 4.1
 * assigns a fresh value to.
 */
const legacySeqArb: fc.Arbitrary<number | undefined> = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: 1, max: 50 }) },
  { weight: 2, arbitrary: fc.constant<number | undefined>(undefined) },
  { weight: 1, arbitrary: fc.constantFrom(Number.NaN, Infinity, -Infinity) }
)

/** An accepted legacy record: a non-blank Coupon_Code and a completion timestamp. */
function acceptedLegacyRecordArb(
  index: number
): fc.Arbitrary<LegacyRecordSample> {
  return fc
    .record({
      couponCode: validCouponCodeArb,
      completedAt: legacyTimestampArb,
      seq: legacySeqArb,
      mock: fc.boolean(),
      stoppedEarly: fc.boolean(),
      outcomes: fc.array(legacyOutcomeRowArb, { maxLength: 3, size: "max" }),
    })
    .map((fields): LegacyRecordSample => ({
      record: {
        runId: `legacy-run-${index}`,
        ...(fields.seq === undefined ? {} : { seq: fields.seq }),
        couponCode: fields.couponCode,
        completedAt: fields.completedAt.iso,
        mock: fields.mock,
        stoppedEarly: fields.stoppedEarly,
        outcomes: fields.outcomes,
      },
      disposition: "accepted",
      completionMs: fields.completedAt.ms,
    }))
}

/** A record skipped for a zero-character Coupon_Code (Requirement 4.7). */
function blankCouponLegacyRecordArb(
  index: number
): fc.Arbitrary<LegacyRecordSample> {
  return fc
    .record({
      completedAt: legacyTimestampArb,
      seq: legacySeqArb,
      mock: fc.boolean(),
      stoppedEarly: fc.boolean(),
      outcomes: fc.array(legacyOutcomeRowArb, { maxLength: 2, size: "max" }),
    })
    .map((fields): LegacyRecordSample => ({
      record: {
        runId: `legacy-run-${index}`,
        ...(fields.seq === undefined ? {} : { seq: fields.seq }),
        couponCode: "",
        completedAt: fields.completedAt.iso,
        mock: fields.mock,
        stoppedEarly: fields.stoppedEarly,
        outcomes: fields.outcomes,
      },
      disposition: "blank-coupon",
      completionMs: fields.completedAt.ms,
    }))
}

/** A record skipped for an absent or empty completion timestamp (Requirement 4.7). */
function noTimestampLegacyRecordArb(
  index: number
): fc.Arbitrary<LegacyRecordSample> {
  return fc
    .record({
      couponCode: validCouponCodeArb,
      completedAt: fc.oneof(
        fc.constant<string | undefined>(undefined),
        fc.constant("")
      ),
      seq: legacySeqArb,
      mock: fc.boolean(),
      stoppedEarly: fc.boolean(),
      outcomes: fc.array(legacyOutcomeRowArb, { maxLength: 2, size: "max" }),
    })
    .map((fields): LegacyRecordSample => ({
      record: {
        runId: `legacy-run-${index}`,
        ...(fields.seq === undefined ? {} : { seq: fields.seq }),
        couponCode: fields.couponCode,
        ...(fields.completedAt === undefined
          ? {}
          : { completedAt: fields.completedAt }),
        mock: fields.mock,
        stoppedEarly: fields.stoppedEarly,
        outcomes: fields.outcomes,
      },
      disposition: "no-timestamp",
      completionMs: 0,
    }))
}

/** A list of legacy records mixing accepted, blank-coupon, and no-timestamp cases. */
export function legacyRecordListArb(
  options: { minLength?: number; maxLength?: number } = {}
): fc.Arbitrary<ReadonlyArray<LegacyRecordSample>> {
  const minLength = options.minLength ?? 0
  const maxLength = options.maxLength ?? 8
  return fc.array(
    fc
      .nat()
      .chain((seed) =>
        fc.oneof(
          { weight: 3, arbitrary: acceptedLegacyRecordArb(seed) },
          { weight: 1, arbitrary: blankCouponLegacyRecordArb(seed) },
          { weight: 1, arbitrary: noTimestampLegacyRecordArb(seed) }
        )
      ),
    { minLength, maxLength, size: "max" }
  )
}

/**
 * A whole Legacy_Json_Store sample: the entry and record samples that went into
 * it, and the `StoreDocument`-shaped value the Data_Import planner reads.
 *
 * The `document` is typed as `StoreDocument` for the planner, but its entries
 * may omit `createdAt` and its records may omit or hold a non-finite `seq` —
 * exactly the operator-supplied shapes the planner is written to be forgiving
 * of. The cast is deliberate: the planner reads these fields defensively, and
 * the point of Property 10 is to prove it does.
 */
export interface LegacyStoreSample {
  readonly entries: ReadonlyArray<LegacyEntrySample>
  readonly records: ReadonlyArray<LegacyRecordSample>
  readonly document: StoreDocument
}

export interface LegacyStoreOptions {
  readonly minEntries?: number
  readonly maxEntries?: number
  readonly minRecords?: number
  readonly maxRecords?: number
}

/**
 * A Legacy_Json_Store document for the Data_Import plan property
 * (Requirements 4.1, 4.3, 4.7, 4.8).
 *
 * Reaches, across its cases: valid entries and records; out-of-range
 * Member_Labels and Hive_IDs (zero characters and past the max after trimming);
 * intra-document duplicate Hive_IDs verbatim, differing only by surrounding
 * whitespace, and differing only by case (those stay distinct); zero-character
 * Coupon_Codes; absent and empty completion timestamps; present and absent
 * `createdAt`; and present, absent, and non-finite `seq`. The default size
 * ranges stay small, and a caller reaches past both caps by raising the maxima
 * (see the over-the-cap arbitrary the property builds on top of this).
 */
export function legacyStoreSampleArb(
  options: LegacyStoreOptions = {}
): fc.Arbitrary<LegacyStoreSample> {
  return fc
    .tuple(
      legacyEntryListArb({
        minLength: options.minEntries,
        maxLength: options.maxEntries,
      }),
      legacyRecordListArb({
        minLength: options.minRecords,
        maxLength: options.maxRecords,
      })
    )
    .map(([entries, records]): LegacyStoreSample => {
      const document = {
        version: 1,
        nextHistorySeq: 1,
        members: entries.map((sample) => sample.entry),
        history: records.map((sample) => sample.record),
      } as unknown as StoreDocument
      return { entries, records, document }
    })
}

/* -------------------------------------------------------------------------- */
/* Clerk profiles (User_Account mirror, Property 11)                          */
/* -------------------------------------------------------------------------- */

/**
 * The longest display name the User_Account mirror stores, in UTF-16 code
 * units, restated here rather than imported.
 *
 * `DISPLAY_NAME_MAX_LENGTH` lives in `src/server/identity.server.ts`, a
 * `.server` module this generators file must not pull into the browser-like
 * module graph the `jsdom` Vitest project builds — the same reasoning
 * {@link MONGO_URI_SCHEMES} records. The Property 11 test imports the real
 * constant and asserts it equals this one, so the restatement cannot drift.
 */
export const DISPLAY_NAME_MAX_LENGTH = 100

/**
 * One Clerk email-address record, shaped like the `ClerkEmailAddress` the
 * identity seam reads: an id, the address itself, and a verification whose
 * `status` is `"verified"` or something else, or which is absent entirely.
 *
 * A profile arbitrary carries a *list* of these plus a `primaryEmailAddressId`,
 * so the rule `primaryVerifiedEmail` turns on — "the address whose id equals
 * `primaryEmailAddressId`, and only when its verification status is
 * `verified`" — is exercised through data rather than restated.
 */
export interface ClerkEmailAddressSample {
  readonly id: string
  readonly emailAddress: string
  readonly verification: { readonly status: string } | null
}

/**
 * A Clerk user profile as the identity seam's `ClerkUser` reads it, narrowed to
 * the four fields the projection uses: the primary address id, the address
 * list, and the two name parts. This is the *raw* profile — the projection
 * (fold, join, trim, truncate, fallback) is what the mirror stores, and the
 * Property 11 test derives the expected stored values from this shape with the
 * seam's own `projectProfile`.
 */
export interface ClerkUserSample {
  readonly primaryEmailAddressId: string | null
  readonly emailAddresses: ReadonlyArray<ClerkEmailAddressSample>
  readonly firstName: string | null
  readonly lastName: string | null
}

/**
 * How a generated Clerk profile stands against the primary-verified-email rule,
 * carried on the sample so the Property 11 test can reach the two `unknown`
 * branches deliberately rather than by chance:
 *
 * - `usable`: a primary address that is verified and folds to a non-empty
 *   value, so the profile projects to a {@link ClerkUserSample} the mirror
 *   stores.
 * - `no-primary`: `primaryEmailAddressId` names no address in the list (or is
 *   null), so `primaryVerifiedEmail` returns null.
 * - `unverified-primary`: the primary address is present but its verification
 *   status is not `"verified"`, so `primaryVerifiedEmail` returns null.
 *
 * The last two are the shapes that make the mirror report Requirement 5.15's
 * "no usable email address" and write nothing.
 */
export type ClerkProfileDisposition =
  "usable" | "no-primary" | "unverified-primary"

/** A generated Clerk profile, tagged with how it stands against the email rule. */
export interface ClerkProfileSample {
  readonly user: ClerkUserSample
  readonly disposition: ClerkProfileDisposition
}

/** ASCII characters an email local part or domain label is built from. */
const CLERK_LOCAL_UNITS = Array.from(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-+"
)
const CLERK_DOMAIN_UNITS = Array.from(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-"
)

/** Text of 1 to `maxLength` units drawn from `units`. */
function clerkPartArb(
  units: readonly string[],
  maxLength: number
): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...units), { minLength: 1, maxLength, size: "max" })
    .map((drawn) => drawn.join(""))
}

/**
 * A well-formed email address in an arbitrary letter case, sometimes wrapped in
 * whitespace the fold removes.
 *
 * ASCII on purpose: the fold is `trim().toLowerCase()`, and outside ASCII
 * `toLowerCase` is not a clean inverse of `toUpperCase` (`"ß"`, `"İ"`), so a
 * Unicode address would make the *expected* fold ambiguous. The address the
 * mirror stores is whatever the profile asserted, and its `emailLower` is that
 * folded, so a mixed-case, padded ASCII address is what exercises the fold
 * (Requirements 5.4 restated, 6.3).
 */
export const clerkEmailAddressArb: fc.Arbitrary<string> = fc
  .tuple(
    clerkPartArb(CLERK_LOCAL_UNITS, 14),
    clerkPartArb(CLERK_DOMAIN_UNITS, 10),
    clerkPartArb(CLERK_DOMAIN_UNITS, 3)
  )
  .chain(([local, domain, tld]) => {
    const address = `${local}@${domain}.${tld}`
    return fc.oneof(
      { weight: 3, arbitrary: fc.constant(address) },
      { weight: 3, arbitrary: fc.constant(address.toUpperCase()) },
      { weight: 3, arbitrary: fc.constant(swapEmailCase(address)) },
      {
        weight: 2,
        arbitrary: fc
          .tuple(whitespacePaddingArb, whitespacePaddingArb)
          .map(([left, right]) => `${left}${address}${right}`),
      }
    )
  })

/** Each character of `value` with its letter case swapped. */
function swapEmailCase(value: string): string {
  return Array.from(value, (character) => {
    const lower = character.toLowerCase()
    return character === lower ? character.toUpperCase() : lower
  }).join("")
}

/**
 * A display-name part (`firstName` or `lastName`) reaching the edges of the
 * Requirement 5.4 rule: absent (null), zero characters, whitespace only,
 * ordinary short text, and text long enough that the joined name crosses the
 * 100-character truncation boundary.
 */
const clerkNamePartArb: fc.Arbitrary<string | null> = fc.oneof(
  { weight: 3, arbitrary: fc.constant<string | null>(null) },
  { weight: 2, arbitrary: fc.constant("") },
  {
    weight: 2,
    arbitrary: fc
      .array(fc.constantFrom(" ", "\t", "\u00a0", "\u3000"), {
        minLength: 1,
        maxLength: 4,
        size: "max",
      })
      .map((units) => units.join("")),
  },
  {
    weight: 4,
    arbitrary: fc.oneof(
      fc.string({ unit: "grapheme", minLength: 1, maxLength: 20 }),
      clerkPartArb(CLERK_LOCAL_UNITS, 20)
    ),
  },
  {
    // A part on its own longer than the 100-unit cap, so truncation is reached
    // even without a second part.
    weight: 2,
    arbitrary: fc
      .integer({
        min: DISPLAY_NAME_MAX_LENGTH + 1,
        max: DISPLAY_NAME_MAX_LENGTH + 60,
      })
      .map((length) => "n".repeat(length)),
  },
  {
    // An astral-heavy part, so truncation lands on a surrogate boundary — the
    // seam truncates by code unit with `slice`, not by grapheme.
    weight: 1,
    arbitrary: fc.constant(`${ASTRAL_CHARACTER.repeat(60)}tail`),
  }
)

/** A verification whose status is `verified`, some other status, or absent. */
const clerkVerificationArb: fc.Arbitrary<{ readonly status: string } | null> =
  fc.oneof(
    { weight: 5, arbitrary: fc.constant({ status: "verified" }) },
    {
      weight: 2,
      arbitrary: fc
        .constantFrom("unverified", "transferable", "expired", "")
        .map((status) => ({ status })),
    },
    {
      weight: 1,
      arbitrary: fc.constant<{ readonly status: string } | null>(null),
    }
  )

/**
 * A Clerk profile whose primary address is verified and folds to a non-empty
 * value, so it projects to a stored User_Account. The address list holds the
 * primary plus zero or more decoy addresses, verified or not, so the projection
 * has to pick the primary by id rather than scan for any verified address.
 */
function usableClerkProfileArb(): fc.Arbitrary<ClerkProfileSample> {
  return fc
    .record({
      primaryAddress: clerkEmailAddressArb,
      decoys: fc.array(
        fc.record({
          emailAddress: clerkEmailAddressArb,
          verification: clerkVerificationArb,
        }),
        { maxLength: 3, size: "max" }
      ),
      firstName: clerkNamePartArb,
      lastName: clerkNamePartArb,
      primaryFirst: fc.boolean(),
    })
    .map((fields): ClerkProfileSample => {
      const primary: ClerkEmailAddressSample = {
        id: "email-primary",
        emailAddress: fields.primaryAddress,
        verification: { status: "verified" },
      }
      const decoys: ClerkEmailAddressSample[] = fields.decoys.map(
        (decoy, at) => ({
          id: `email-decoy-${at}`,
          emailAddress: decoy.emailAddress,
          verification: decoy.verification,
        })
      )
      const emailAddresses = fields.primaryFirst
        ? [primary, ...decoys]
        : [...decoys, primary]
      return {
        user: {
          primaryEmailAddressId: primary.id,
          emailAddresses,
          firstName: fields.firstName,
          lastName: fields.lastName,
        },
        disposition: "usable",
      }
    })
}

/**
 * A Clerk profile with no usable primary address: either
 * `primaryEmailAddressId` names no address in the list (or is null), or the
 * primary address is present but unverified. Both make `primaryVerifiedEmail`
 * return null and the mirror write nothing (Requirement 5.15 restated).
 */
function unusableClerkProfileArb(): fc.Arbitrary<ClerkProfileSample> {
  const noPrimary: fc.Arbitrary<ClerkProfileSample> = fc
    .record({
      addresses: fc.array(
        fc.record({
          emailAddress: clerkEmailAddressArb,
          verification: clerkVerificationArb,
        }),
        { maxLength: 3, size: "max" }
      ),
      firstName: clerkNamePartArb,
      lastName: clerkNamePartArb,
      nullPrimary: fc.boolean(),
    })
    .map((fields): ClerkProfileSample => ({
      user: {
        // Either explicitly null, or an id that matches none of the addresses,
        // whose ids are all `email-N`.
        primaryEmailAddressId: fields.nullPrimary ? null : "email-absent",
        emailAddresses: fields.addresses.map((address, at) => ({
          id: `email-${at}`,
          emailAddress: address.emailAddress,
          verification: address.verification,
        })),
        firstName: fields.firstName,
        lastName: fields.lastName,
      },
      disposition: "no-primary",
    }))

  const unverifiedPrimary: fc.Arbitrary<ClerkProfileSample> = fc
    .record({
      primaryAddress: clerkEmailAddressArb,
      status: fc.constantFrom("unverified", "transferable", "expired", ""),
      absentVerification: fc.boolean(),
      firstName: clerkNamePartArb,
      lastName: clerkNamePartArb,
    })
    .map((fields): ClerkProfileSample => {
      const primary: ClerkEmailAddressSample = {
        id: "email-primary",
        emailAddress: fields.primaryAddress,
        verification: fields.absentVerification
          ? null
          : { status: fields.status },
      }
      return {
        user: {
          primaryEmailAddressId: primary.id,
          emailAddresses: [primary],
          firstName: fields.firstName,
          lastName: fields.lastName,
        },
        disposition: "unverified-primary",
      }
    })

  return fc.oneof(noPrimary, unverifiedPrimary)
}

/**
 * A Clerk profile the User_Account mirror might see (Property 11), reaching
 * every edge Requirement 5.4, 5.5, and 5.15 turn on:
 *
 * - display names of zero characters, whitespace only, ordinary length, and
 *   longer than 100 characters (both single-part and joined), so the join,
 *   trim, truncate, and email-fallback rule is exercised in full;
 * - email addresses in upper, mixed, and lower case, sometimes padded, so the
 *   stored `email` and its folded `emailLower` are exercised;
 * - profiles holding no usable primary verified email — no primary at all, and
 *   a present but unverified primary — so the `no-verified-email` failure path
 *   the mirror turns into "authorization could not be determined" is reachable.
 *
 * Roughly a quarter of samples are unusable, so both the stored-projection
 * clauses and the writes-nothing clause see plenty of cases.
 */
export const clerkProfileSampleArb: fc.Arbitrary<ClerkProfileSample> = fc.oneof(
  { weight: 3, arbitrary: usableClerkProfileArb() },
  { weight: 1, arbitrary: unusableClerkProfileArb() }
)

/** A Clerk profile that always projects to a stored User_Account (usable only). */
export const usableClerkProfileSampleArb: fc.Arbitrary<ClerkProfileSample> =
  usableClerkProfileArb()

/* -------------------------------------------------------------------------- */
/* Authorization state (Admin_Page guards, Property 14)                       */
/* -------------------------------------------------------------------------- */

/**
 * The Account_Role decision `createAuthorization().decide()` reaches for one
 * request, named by the branch of `decide()` it stands for. These are the four
 * `AuthorizationDecision` kinds, but expressed as *inputs* to the decision so a
 * property drives the real `decide()` rather than restating its output:
 *
 * - `admin` / `member`: the request carries a Clerk session, and the mirror
 *   resolves to an account holding that role (Requirements 6.4, 6.6).
 * - `anonymous`: the request carries no valid Clerk session, so `decide()`
 *   returns before any store read (Requirement 6.5).
 * - `unknown`: the request carries a session, but the mirror could not read the
 *   Account_Role (Requirements 5.13, 6.15).
 *
 * `admin` and `member` are the only two that carry an account, which is the
 * whole of Property 14: only an `admin` state may let an Admin_Page value out.
 */
export type AuthorizationStateKind =
  "admin" | "member" | "anonymous" | "unknown"

/** The two enforcement points a guard is built for (Requirement 6.7). */
export type AuthorizationEndpointKind = "document" | "serverFn"

/**
 * One authorization state: everything a property needs to build the two stub
 * seams `createAuthorization` is injected with, plus the endpoint the guard is
 * asked for and the decision the state must produce.
 *
 * `identityPresent` is what a stub `Identity.current()` returns — a
 * `RequestIdentity` when true, `null` when false — and `account` / `failure`
 * are what a stub `UserAccountStore.resolve` yields when it is reached. Exactly
 * one of `account` and `failure` is set, and only for the state kinds that read
 * the mirror: an `anonymous` state carries neither, because `decide()` never
 * calls `resolve` once `current()` is null.
 */
export interface AuthorizationStateSample {
  readonly kind: AuthorizationStateKind
  readonly endpoint: AuthorizationEndpointKind
  /** True unless the state is `anonymous`; drives a stub `Identity.current()`. */
  readonly identityPresent: boolean
  /** The request identity a present session resolves to. Null when anonymous. */
  readonly requestIdentity: {
    readonly userId: string
    readonly sessionId: string
  } | null
  /** The resolved account for an `admin`/`member` state; null otherwise. */
  readonly account: UserAccountView | null
  /** The resolve failure for an `unknown` state; null otherwise. */
  readonly failure: StoreFailure | null
}

/** A Clerk user id / session id pair a present session resolves to. */
const requestIdentityArb: fc.Arbitrary<{
  readonly userId: string
  readonly sessionId: string
}> = fc.record({
  userId: fc
    .string({ minLength: 1, maxLength: 24 })
    .map((suffix) => `user_${suffix}`),
  sessionId: fc
    .string({ minLength: 1, maxLength: 24 })
    .map((suffix) => `sess_${suffix}`),
})

/** An ISO 8601 instant for `lastSignInAt`, drawn around a fixed base. */
const lastSignInAtArb: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 5_000_000_000 })
  .map((offset) =>
    new Date(Date.parse("2025-01-04T18:00:00.000Z") + offset).toISOString()
  )

/**
 * A stored User_Account holding the given role. The email is drawn from
 * {@link clerkEmailAddressArb} so the account looks like one the mirror wrote,
 * and the display name is allowed to be empty (an Identity_Provider need not
 * assert a name).
 */
function userAccountViewArb(role: AccountRole): fc.Arbitrary<UserAccountView> {
  return fc.record({
    clerkUserId: fc
      .string({ minLength: 1, maxLength: 24 })
      .map((suffix) => `user_${suffix}`),
    email: clerkEmailAddressArb.map((email) => email.trim().toLowerCase()),
    displayName: fc.oneof(
      { weight: 3, arbitrary: fc.string({ unit: "grapheme", maxLength: 40 }) },
      { weight: 1, arbitrary: fc.constant("") }
    ),
    role: fc.constant(role),
    lastSignInAt: lastSignInAtArb,
  })
}

/**
 * A resolve failure for an `unknown` state, carrying one of the three
 * {@link StoreFailureReason} values and the fixed authorization-unknown
 * sentence. The message is not restated from `storeMessages.ts`: the property
 * test asserts the guard's message equals the real `authorizationUnknownMessage`
 * it imports, so this generator's `message` is only what the stubbed `resolve`
 * hands back and is generated freely.
 */
const storeFailureArb: fc.Arbitrary<StoreFailure> = fc.record({
  reason: fc.constantFrom<StoreFailureReason>(
    "not-configured",
    "unreachable",
    "rejected"
  ),
  message: fc.string({ minLength: 0, maxLength: 80 }),
})

/**
 * An authorization state over the full product of Property 14: identity present
 * or absent, the stored account admin / member / absent / unknown-failure, and
 * the endpoint document or server-function.
 *
 * The `anonymous` state is the identity-absent leg, and the other three are
 * identity-present legs distinguished by what the mirror resolves to, so the
 * four kinds together are exactly "identity present/absent × stored account
 * admin/member/absent/unknown". The endpoint tag is drawn independently, so both
 * guard shapes see every state. Each kind is weighted so the three non-admin
 * kinds — the ones Property 14 is about — dominate the sample.
 */
export const authorizationStateArb: fc.Arbitrary<AuthorizationStateSample> = fc
  .record({
    endpoint: fc.constantFrom<AuthorizationEndpointKind>(
      "document",
      "serverFn"
    ),
    identity: requestIdentityArb,
    core: fc.oneof(
      {
        weight: 1,
        arbitrary: userAccountViewArb("admin").map((account) => ({
          kind: "admin" as const,
          account,
          failure: null,
        })),
      },
      {
        weight: 2,
        arbitrary: userAccountViewArb("member").map((account) => ({
          kind: "member" as const,
          account,
          failure: null,
        })),
      },
      {
        weight: 2,
        arbitrary: fc.constant({
          kind: "anonymous" as const,
          account: null,
          failure: null,
        }),
      },
      {
        weight: 2,
        arbitrary: storeFailureArb.map((failure) => ({
          kind: "unknown" as const,
          account: null,
          failure,
        })),
      }
    ),
  })
  .map(({ endpoint, identity, core }): AuthorizationStateSample => {
    const identityPresent = core.kind !== "anonymous"
    return {
      kind: core.kind,
      endpoint,
      identityPresent,
      requestIdentity: identityPresent ? identity : null,
      account: core.account,
      failure: core.failure,
    }
  })

/* -------------------------------------------------------------------------- */
/* Access_Gate facts (Property 17)                                            */
/* -------------------------------------------------------------------------- */

/**
 * The exempt paths and prefixes duplicated from `@/server/gate.server`.
 *
 * The gate module is a `.server` module: importing its constants as *values*
 * would pull its module graph into this browser-transformed generator file. The
 * types (`GateHandlerType`, `GateAdmitReason`, `AuthorizationDecision`) are
 * imported with `import type` and erased at build time, but a runtime constant
 * cannot be. So the small path lists are restated here. A unit test elsewhere
 * pins the real `GATE_EXEMPT_PATHS`/`GATE_EXEMPT_PATH_PREFIXES`; here they exist
 * only to *build* a pathname that the test then classifies against the real
 * `isGateExemptPath`, so a drift would surface as a failing property, not a
 * silent pass.
 */
const GATE_EXEMPT_PATHS_LOCAL: readonly string[] = [
  "/login",
  "/sign-in",
  "/sign-up",
  "/sso-callback",
  "/favicon.ico",
  "/manifest.json",
  "/robots.txt",
]

/** Prefixes restated from the gate module; see {@link GATE_EXEMPT_PATHS_LOCAL}. */
const GATE_EXEMPT_PATH_PREFIXES_LOCAL: readonly string[] = [
  "/sign-in/",
  "/sign-up/",
  "/_build/",
  "/assets/",
  "/@vite/",
  "/@id/",
  "/node_modules/",
  "/src/",
]

/** Non-exempt paths a real request reaches: the roster, history, admin, root. */
const GATE_NON_EXEMPT_PATHS: readonly string[] = [
  "/",
  "/roster",
  "/history",
  "/admin",
  "/login/extra",
  "/sign",
  "/_buildish",
  "/assets",
]

/** Server-function base paths, never exempt whatever the handler type. */
const GATE_SERVER_FN_PATHS: readonly string[] = [
  "/_serverFn/listMembers",
  "/_serverFn/redeem",
  "/api/functions/abc123",
]

/**
 * A pathname drawn from the whole space Property 17 ranges over: the exact
 * exempt entries, an exempt prefix followed by a generated sub-route segment,
 * arbitrary non-exempt document paths, and the server-function base paths. The
 * mix guarantees both `isGateExemptPath` branches — exact match and prefix
 * match — and the "never exempt" server-function paths are all sampled.
 */
export const gatePathnameArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...GATE_EXEMPT_PATHS_LOCAL) },
  {
    weight: 2,
    arbitrary: fc
      .tuple(
        fc.constantFrom(...GATE_EXEMPT_PATH_PREFIXES_LOCAL),
        fc.string({ unit: "grapheme-ascii", minLength: 1, maxLength: 20 })
      )
      .map(([prefix, suffix]) => `${prefix}${suffix}`),
  },
  { weight: 3, arbitrary: fc.constantFrom(...GATE_NON_EXEMPT_PATHS) },
  { weight: 2, arbitrary: fc.constantFrom(...GATE_SERVER_FN_PATHS) }
)

/**
 * The verdict a stub `verifySessionCookieHeader` returns. Only `"valid"` admits
 * at step 3; the other five are the invalid `SessionVerification` kinds the
 * gate treats identically for admission (they differ only in the `reason` a
 * rejection reports). Restated as literals so this generator holds no `.server`
 * runtime import.
 */
export type GateSessionKind =
  "valid" | "missing" | "malformed" | "tampered" | "expired" | "revoked"

/** The authorization kind a stub `resolveAuthorization` yields at step 4. */
export type GateAuthorizationKind = AuthorizationDecision["kind"]

/**
 * One gate-fact tuple: every input `evaluateGate` looks at, plus the expected
 * admit reason (or `null` when the tuple must be rejected) computed here by the
 * same ordered rule the gate applies. The test constructs the stub `auth` from
 * `passphraseRequired` and `sessionKind`, the stub `resolveAuthorization` from
 * `authorizationKind`, and asserts the decision matches `expectedAdmitReason`
 * and that the resolver was consulted exactly when `resolverExpected` says.
 */
export interface GateFactsSample {
  /** Drives a stub `auth.passphraseRequired()`. */
  readonly passphraseRequired: boolean
  readonly pathname: string
  readonly handlerType: GateHandlerType
  /** Drives `input.clerkHandshake`. */
  readonly clerkHandshake: boolean
  /** Drives a stub `auth.verifySessionCookieHeader()`. */
  readonly sessionKind: GateSessionKind
  /** Drives a stub `input.resolveAuthorization()`. */
  readonly authorizationKind: GateAuthorizationKind
  /** The admit reason the ordered rule yields, or `null` for a rejection. */
  readonly expectedAdmitReason: GateAdmitReason | null
  /** Whether the ordered rule reaches step 4 and calls the resolver. */
  readonly resolverExpected: boolean
}

/**
 * True when `pathname`/`handlerType` is exempt, restated from the gate's
 * `isGateExemptPath` so the expected reason can be computed without a `.server`
 * import. A server function is never exempt; a router path is exempt on an exact
 * match or a prefix match (a single trailing slash is dropped for the exact
 * comparison, mirroring `withoutTrailingSlash`).
 */
function gatePathIsExempt(
  pathname: string,
  handlerType: GateHandlerType
): boolean {
  if (handlerType !== "router") return false
  const path =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname
  if (GATE_EXEMPT_PATHS_LOCAL.includes(path)) return true
  if (path === "/@react-refresh") return true
  return GATE_EXEMPT_PATH_PREFIXES_LOCAL.some((prefix) =>
    pathname.startsWith(prefix)
  )
}

/**
 * Computes what the gate's ordered rule yields for a tuple: the admit reason (or
 * `null` for a rejection) and whether the resolver is reached. The order is the
 * gate's own: gate-disabled, clerk-handshake, exempt-path, valid-session, then
 * the resolver. Only the fall-through to the resolver sets `resolverExpected`.
 */
function gateExpectation(facts: {
  passphraseRequired: boolean
  pathname: string
  handlerType: GateHandlerType
  clerkHandshake: boolean
  sessionKind: GateSessionKind
  authorizationKind: GateAuthorizationKind
}): { expectedAdmitReason: GateAdmitReason | null; resolverExpected: boolean } {
  if (!facts.passphraseRequired) {
    return { expectedAdmitReason: "gate-disabled", resolverExpected: false }
  }
  if (facts.clerkHandshake) {
    return { expectedAdmitReason: "clerk-handshake", resolverExpected: false }
  }
  if (gatePathIsExempt(facts.pathname, facts.handlerType)) {
    return { expectedAdmitReason: "exempt-path", resolverExpected: false }
  }
  if (facts.sessionKind === "valid") {
    return { expectedAdmitReason: "valid-session", resolverExpected: false }
  }
  // Step 4: the resolver is consulted.
  if (facts.authorizationKind === "admin") {
    return { expectedAdmitReason: "admin-authorized", resolverExpected: true }
  }
  return { expectedAdmitReason: null, resolverExpected: true }
}

/**
 * A gate-fact tuple over the full product Property 17 ranges over:
 * passphrase configuration, pathname, handler type, the Clerk handshake flag,
 * Passphrase_Session validity, and the authorization kind. The expected admit
 * reason and whether the resolver is reached are computed by the gate's own
 * ordered rule, so the test asserts the real `evaluateGate` against a value
 * derived independently rather than restating the decision inline.
 *
 * Weights keep the armed gate (`passphraseRequired: true`) common so the later
 * steps — the ones that carry the interesting behaviour — are exercised, while
 * the disabled gate is sampled often enough to pin "gate off admits everything".
 */
export const gateFactsArb: fc.Arbitrary<GateFactsSample> = fc
  .record({
    passphraseRequired: fc.oneof(
      { weight: 4, arbitrary: fc.constant(true) },
      { weight: 1, arbitrary: fc.constant(false) }
    ),
    pathname: gatePathnameArb,
    handlerType: fc.constantFrom<GateHandlerType>("router", "serverFn"),
    clerkHandshake: fc.oneof(
      { weight: 1, arbitrary: fc.constant(true) },
      { weight: 4, arbitrary: fc.constant(false) }
    ),
    sessionKind: fc.constantFrom<GateSessionKind>(
      "valid",
      "missing",
      "malformed",
      "tampered",
      "expired",
      "revoked"
    ),
    authorizationKind: fc.constantFrom<GateAuthorizationKind>(
      "admin",
      "member",
      "anonymous",
      "unknown"
    ),
  })
  .map((facts): GateFactsSample => {
    const { expectedAdmitReason, resolverExpected } = gateExpectation(facts)
    return { ...facts, expectedAdmitReason, resolverExpected }
  })

/* -------------------------------------------------------------------------- */
/* Admin_Page account rows (Property 18)                                      */
/* -------------------------------------------------------------------------- */

/**
 * The seed shape the in-memory store accepts for a `user_accounts` document:
 * every field of a {@link UserAccountDocument} except the driver-assigned `_id`.
 * Declared with `import type` only, so this generator stays client-safe — the
 * document interface is erased at build time and no `.server` runtime import is
 * pulled into the browser-transformed module graph.
 */
export type AdminAccountSeed = Omit<UserAccountDocument, "_id">

/**
 * A base instant for the sign-in timestamps of a generated account set, fixed
 * so a run is deterministic. Offsets are added to it to build the `lastSignInAt`
 * of each account.
 */
const ADMIN_ACCOUNT_BASE_TIME = Date.parse("2025-01-04T18:00:00.000Z")

/**
 * A `lastSignInAt` offset drawn from a *small* set of buckets, so distinct
 * accounts collide on the same instant often. Property 18's tiebreak — folded
 * email ascending among accounts sharing a `lastSignInAt` — is only exercised
 * when timestamps actually collide, and a wide-open instant would almost never
 * repeat across a hundred-account set.
 */
const collidingSignInOffsetArb: fc.Arbitrary<number> = fc
  .integer({ min: 0, max: 20 })
  .map((bucket) => bucket * 60_000)

/**
 * A display name for a mirrored account, biased toward the values Requirement
 * 8.8 cares about: the empty string and whitespace-only text (which trim to
 * nothing), alongside ordinary names. The store stores it unchanged, so this
 * only has to reach the blank cases; the render decision is task 20.4/20.5.
 */
const adminDisplayNameArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: fc.string({ unit: "grapheme", maxLength: 40 }) },
  { weight: 2, arbitrary: blankTextArb },
  { weight: 1, arbitrary: fc.constant("") }
)

/**
 * A set of User_Account documents for Property 18, built to reach every corner
 * the property cares about:
 *
 *   - **above the cap:** the set can hold more than 100 accounts, so the query's
 *     `limit` (`ADMIN_PAGE_MAX_ROWS`) is actually exercised rather than
 *     trivially satisfied;
 *   - **colliding sign-in instants:** `lastSignInAt` is drawn from a small
 *     bucket set (see {@link collidingSignInOffsetArb}), so distinct accounts
 *     share an instant and the folded-email tiebreak decides their order;
 *   - **case-only email collisions:** a share of the accounts are duplicated
 *     from an already-generated one with the email re-cased, so two accounts
 *     differ only in letter case and therefore fold to the same `emailLower`;
 *   - **blank display names:** empty and whitespace-only names occur.
 *
 * `clerkUserId` is unique per account (it is the mirror key); the accounts are
 * otherwise independent. `lastSyncedAt` is a fixed instant — the property does
 * not read it — and `emailLower` is the fold of `email`, exactly as the mirror
 * writes it, so the sort key the query orders by is present and honest.
 *
 * The maximum size deliberately exceeds 100 so the "at most 100 rows" cap and
 * the "the returned rows are the newest hundred" claim are both reached.
 */
export const adminAccountSetArb: fc.Arbitrary<readonly AdminAccountSeed[]> = fc
  .array(
    fc.record({
      emailBase: clerkEmailAddressArb,
      displayName: adminDisplayNameArb,
      role: fc.constantFrom<AccountRole>("admin", "member"),
      signInOffset: collidingSignInOffsetArb,
      /* When true and there is an earlier account to copy, this account becomes
       * a case-only variant of that one's email — a folded-email collision. */
      recaseEarlier: fc.boolean(),
    }),
    { minLength: 0, maxLength: 130, size: "max" }
  )
  .map((rows) => {
    const syncedAt = new Date(ADMIN_ACCOUNT_BASE_TIME)
    const seeds: AdminAccountSeed[] = []
    for (const [index, row] of rows.entries()) {
      /* A folded-email collision: re-case an earlier account's email so the two
       * differ only in letter case and share an `emailLower`. */
      const source =
        row.recaseEarlier && seeds.length > 0
          ? seeds[index % seeds.length].email
          : row.emailBase.trim()
      const email = row.recaseEarlier ? swapEmailCase(source) : source
      seeds.push({
        clerkUserId: `user_${index}`,
        email,
        emailLower: email.trim().toLowerCase(),
        displayName: row.displayName,
        role: row.role,
        lastSignInAt: new Date(ADMIN_ACCOUNT_BASE_TIME + row.signInOffset),
        lastSyncedAt: syncedAt,
        lastSessionId: `session_${index}`,
      })
    }
    return seeds
  })
