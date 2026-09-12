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
import { MEMBER_OUTCOME_VALUES } from "@/domain/types"
import type {
  MemberOutcome,
  MemberOutcomeValue,
  MemberRegistryEntry,
} from "@/domain/types"
import type { UpstreamRawResponse } from "@/server/upstream/client"

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
