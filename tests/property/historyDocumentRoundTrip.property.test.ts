// Feature: mongodb-google-auth-admin, Property 4: Redemption_History mapping
// round trip — For any Redemption_History record, mapping the record to a
// Store_Document and then mapping that Store_Document back produces a record
// whose run identifier, append counter value, Coupon_Code, completion
// timestamp, Mock_Mode state, early-stop state, and outcome rows each equal
// those of the original record, character for character and row for row in the
// same order.
//
// Validates: Requirements 3.8, 3.9.
//
// ## The one place the round trip is not the identity
//
// Requirement 3.9 asks for equality; Requirement 3.1 caps a stored response
// message at 500 characters and keeps "the first 500 characters of a longer
// response message". Both cannot hold verbatim for a record carrying a longer
// message, and 3.1 is the one the store obeys, so the property is stated in two
// halves:
//
//   1. For a record whose every response message holds at most 500 characters —
//      which is every record the Response_Parser produces, since it applies the
//      same cap at the same width — the round trip is the identity, field for
//      field and row for row.
//   2. For any record at all, including messages longer than 500 characters, the
//      round trip yields the record with each response message replaced by its
//      first 500 characters, and mapping THAT record again changes nothing. The
//      truncation is a fixed point, so 3.9's equality holds for everything the
//      store can hold, and a message is shortened at most once however many
//      times it crosses the mapping.
//
// "Character" is one UTF-16 code unit, the reading `src/domain/responseParser.ts`
// already applies to the same 500. A boundary landing inside a surrogate pair
// therefore splits it, and one generated message below is built to land exactly
// there, so that behaviour is pinned rather than discovered later.
//
// ## Why the timestamp clause is separate
//
// `completedAt` is the one field whose storage is not its domain type: the
// document holds the domain's string verbatim and derives `completedAtMs` beside
// it for the Requirement 3.4 sort. A `Date` round trip would collapse `+05:45`
// to `Z` and cut fractional seconds to milliseconds, so the timestamps generated
// here carry UTC offsets, zero to nine fractional digits, and one unparsable
// spelling, and the assertion is character-for-character identity of the string
// the domain gets back — not equality of the instants it denotes.

import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { MEMBER_OUTCOME_VALUES } from "@/domain/types"
import type { RedemptionHistoryRecord } from "@/domain/types"
import {
  MAX_RESPONSE_MESSAGE_CHARS,
  fromHistoryDocument,
  toHistoryDocument,
} from "@/server/store/documents.server"

/* -------------------------------------------------------------------------- */
/* The rule, restated                                                         */
/* -------------------------------------------------------------------------- */

/** Requirement 3.1: the first 500 UTF-16 code units of a response message. */
function firstFiveHundred(message: string): string {
  return message.slice(0, MAX_RESPONSE_MESSAGE_CHARS)
}

/** The record the store can hold: `record` with every message capped. */
function asStored(record: RedemptionHistoryRecord): RedemptionHistoryRecord {
  return {
    ...record,
    outcomes: record.outcomes.map((row) => ({
      ...row,
      responseMessage: firstFiveHundred(row.responseMessage),
    })),
  }
}

/** One pass through both mappings. */
function roundTrip(record: RedemptionHistoryRecord): RedemptionHistoryRecord {
  return fromHistoryDocument(toHistoryDocument(record))
}

/* -------------------------------------------------------------------------- */
/* Local arbitraries                                                          */
/*                                                                            */
/* Defined here rather than in `tests/property/generators.ts`: they are about  */
/* Store_Document field widths and timestamp spellings, which no other         */
/* property needs.                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Text of 1 to `maxLength` UTF-16 code units, reaching astral-plane and
 * combining characters — the mapping copies every string verbatim, so nothing
 * here needs to be a well-formed identifier.
 */
function textArb(maxLength: number): fc.Arbitrary<string> {
  return fc
    .oneof(
      { weight: 4, arbitrary: fc.string({ unit: "grapheme", maxLength }) },
      { weight: 2, arbitrary: fc.string({ unit: "binary", maxLength }) },
      {
        weight: 1,
        arbitrary: fc.constantFrom(
          "a",
          "😀🐝",
          "e\u0301\u0327",
          "\u200b \t",
          "A".repeat(maxLength)
        ),
      }
    )
    .map((value) => (value.length === 0 ? "x" : value.slice(0, maxLength)))
}

/** A run identifier, 1 to 64 characters (Requirement 3.1). */
const runIdArb: fc.Arbitrary<string> = textArb(64)

/** A Coupon_Code, 1 to 64 characters (Requirement 3.1). */
const couponCodeArb: fc.Arbitrary<string> = textArb(64)

/**
 * An append counter value. The mapping copies it verbatim, so the range is
 * deliberately wider than the counter can reach: 1 is the first value
 * Requirement 3.2 assigns, and the extremes are here so a future change that
 * routes `seq` through anything narrower than a double fails.
 */
const seqArb: fc.Arbitrary<number> = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: 1, max: 100_000 }) },
  {
    weight: 1,
    arbitrary: fc.constantFrom(0, 1, -1, Number.MAX_SAFE_INTEGER),
  }
)

/** A Hive_ID as an outcome row holds it, 1 to 64 characters. */
const hiveIdArb: fc.Arbitrary<string> = textArb(64)

/** A Member_Label as an outcome row holds it, 1 to 40 characters. */
const memberLabelArb: fc.Arbitrary<string> = textArb(40)

/** A response code, 0 to 100 characters — the empty string is reachable. */
const responseCodeArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 4, arbitrary: fc.string({ maxLength: 12 }) },
  { weight: 1, arbitrary: fc.constantFrom("", "100", "Z".repeat(100)) }
)

/** A response message of at most 500 characters: the mapping keeps it whole. */
const shortResponseMessageArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 4, arbitrary: fc.string({ unit: "grapheme", maxLength: 60 }) },
  {
    weight: 2,
    arbitrary: fc
      .nat({ max: MAX_RESPONSE_MESSAGE_CHARS })
      .map((length) => "m".repeat(length)),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      "",
      "The coupon gift has been sent.",
      /* Exactly at the cap, and exactly at the cap ending mid-pair. */
      "z".repeat(MAX_RESPONSE_MESSAGE_CHARS),
      "y".repeat(MAX_RESPONSE_MESSAGE_CHARS - 2) + "😀"
    ),
  }
)

/**
 * A response message longer than 500 characters, so the truncation half of the
 * property is exercised on every sample of its clause.
 *
 * The third arm puts a surrogate pair across the boundary: its high surrogate
 * sits at index 499 and its low surrogate at 500, so the stored message ends in
 * a lone surrogate. That is the documented consequence of counting code units,
 * and the property asserts it rather than avoiding it.
 */
const longResponseMessageArb: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc
      .tuple(
        fc.integer({ min: MAX_RESPONSE_MESSAGE_CHARS + 1, max: 1_400 }),
        fc.string({ unit: "grapheme", minLength: 1, maxLength: 8 })
      )
      .map(([length, unit]) => unit.repeat(length).slice(0, length)),
  },
  {
    weight: 2,
    arbitrary: fc
      .string({ unit: "grapheme", minLength: 1, maxLength: 30 })
      .map((tail) => "😀".repeat(400) + tail),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      "b".repeat(MAX_RESPONSE_MESSAGE_CHARS + 1),
      "c".repeat(MAX_RESPONSE_MESSAGE_CHARS - 1) + "😀" + "tail",
      "\u0301".repeat(MAX_RESPONSE_MESSAGE_CHARS + 200)
    ),
  }
)

/** One outcome row, with the response message drawn from `messageArb`. */
function outcomeRowArb(messageArb: fc.Arbitrary<string>) {
  return fc.record({
    hiveId: hiveIdArb,
    memberLabel: memberLabelArb,
    outcome: fc.constantFrom(...MEMBER_OUTCOME_VALUES),
    responseCode: responseCodeArb,
    responseMessage: messageArb,
  })
}

/**
 * Zero to 100 outcome rows (Requirement 3.1). Most samples stay small so the
 * clause runs at full strength; the low-weight arm reaches the cap, where row
 * order over a long list is the thing worth checking.
 */
function outcomeRowsArb(messageArb: fc.Arbitrary<string>) {
  return fc.oneof(
    {
      weight: 6,
      arbitrary: fc.array(outcomeRowArb(messageArb), {
        minLength: 0,
        maxLength: 5,
      }),
    },
    {
      weight: 1,
      arbitrary: fc.array(outcomeRowArb(messageArb), {
        minLength: 95,
        maxLength: 100,
      }),
    }
  )
}

/* -------------------------------------------------------------------------- */
/* Completion timestamps                                                      */
/* -------------------------------------------------------------------------- */

/** Offsets a completion timestamp can carry, in minutes east of UTC. */
const ZONE_OFFSET_MINUTES = [0, 60, 120, -300, 345, 840, -720]

/** The fraction part, from none through nine digits. */
const fractionArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: fc.constant(".123") },
  { weight: 1, arbitrary: fc.constant("") },
  { weight: 1, arbitrary: fc.constant(".7") },
  { weight: 1, arbitrary: fc.constant(".123456") },
  { weight: 1, arbitrary: fc.constant(".987654321") }
)

/** `+HH:MM`, `-HH:MM`, or `Z` for UTC. */
function zoneSuffix(offsetMinutes: number, spellZuluAsOffset: boolean): string {
  if (offsetMinutes === 0 && !spellZuluAsOffset) return "Z"
  const sign = offsetMinutes < 0 ? "-" : "+"
  const total = Math.abs(offsetMinutes)
  const hours = String(Math.floor(total / 60)).padStart(2, "0")
  const minutes = String(total % 60).padStart(2, "0")
  return `${sign}${hours}:${minutes}`
}

/**
 * The given instant, spelled as local wall time in the given zone.
 *
 * `instantSeconds` is whole seconds, so the fraction is entirely the caller's:
 * every spelling of one instant with one fraction parses to the same epoch
 * millisecond, whatever offset it carries.
 */
function spellTimestamp(
  instantSeconds: number,
  fraction: string,
  offsetMinutes: number,
  spellZuluAsOffset = false
): string {
  const wall = new Date((instantSeconds + offsetMinutes * 60) * 1_000)
  return `${wall.toISOString().slice(0, 19)}${fraction}${zoneSuffix(
    offsetMinutes,
    spellZuluAsOffset
  )}`
}

/** Whole seconds since the epoch, spanning 1970 to about 2100. */
const instantSecondsArb: fc.Arbitrary<number> = fc.integer({
  min: 0,
  max: 4_102_444_800,
})

/** A parseable completion timestamp, in some zone with some precision. */
const parseableTimestampArb: fc.Arbitrary<string> = fc
  .tuple(
    instantSecondsArb,
    fractionArb,
    fc.constantFrom(...ZONE_OFFSET_MINUTES),
    fc.boolean()
  )
  .map(([seconds, fraction, offsetMinutes, spellZuluAsOffset]) =>
    spellTimestamp(seconds, fraction, offsetMinutes, spellZuluAsOffset)
  )

/**
 * Any completion timestamp the record could hold, including spellings no
 * `Date` can parse. The domain never produces one — `completedAt` is always
 * `toISOString()` output — but Requirement 3.9 says "for all records", and the
 * string is what comes back, so an unparsable value must come back untouched
 * rather than as `"Invalid Date"` or the empty string.
 */
const completedAtArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 8, arbitrary: parseableTimestampArb },
  {
    weight: 1,
    arbitrary: fc.constantFrom("", "not-a-timestamp", "2025-13-45T99:99:99Z"),
  }
)

/* -------------------------------------------------------------------------- */
/* Records                                                                    */
/* -------------------------------------------------------------------------- */

/** A Redemption_History record whose messages are drawn from `messageArb`. */
function recordArb(
  messageArb: fc.Arbitrary<string>
): fc.Arbitrary<RedemptionHistoryRecord> {
  return fc.record({
    runId: runIdArb,
    seq: seqArb,
    couponCode: couponCodeArb,
    completedAt: completedAtArb,
    mock: fc.boolean(),
    stoppedEarly: fc.boolean(),
    outcomes: outcomeRowsArb(messageArb),
  })
}

/** Records the Response_Parser can produce: every message within the cap. */
const storableRecordArb = recordArb(shortResponseMessageArb)

/** Records reaching past the cap, mixed with records inside it. */
const anyRecordArb = recordArb(
  fc.oneof(
    { weight: 3, arbitrary: longResponseMessageArb },
    { weight: 1, arbitrary: shortResponseMessageArb }
  )
)

/* -------------------------------------------------------------------------- */
/* Property 4                                                                 */
/* -------------------------------------------------------------------------- */

describe("Property 4: the Redemption_History mapping round-trips", () => {
  it("returns the same record, field for field and row for row, for every record within the 500-character cap", () => {
    fc.assert(
      fc.property(storableRecordArb, (record) => {
        const back = roundTrip(record)

        /* Requirement 3.9 as one equality: nothing added, nothing dropped,
         * nothing reordered, nothing re-spelled. */
        expect(back).toEqual(record)

        /* ... and again field by field, so a failure names the field rather
         * than printing two whole records. */
        expect(back.runId).toBe(record.runId)
        expect(back.seq).toBe(record.seq)
        expect(back.couponCode).toBe(record.couponCode)
        expect(back.completedAt).toBe(record.completedAt)
        expect(back.mock).toBe(record.mock)
        expect(back.stoppedEarly).toBe(record.stoppedEarly)
        expect(back.outcomes).toHaveLength(record.outcomes.length)
        record.outcomes.forEach((row, at) => {
          expect(back.outcomes[at]).toEqual(row)
        })

        /* The mapping is idempotent, so a record that crosses the store twice
         * is the record that crossed it once. */
        expect(roundTrip(back)).toEqual(record)
      }),
      { numRuns: 300 }
    )
  })

  it("keeps the first 500 characters of a longer response message and changes nothing after that", () => {
    fc.assert(
      fc.property(anyRecordArb, (record) => {
        const document = toHistoryDocument(record)
        const back = fromHistoryDocument(document)

        /* Requirement 3.1: no stored message exceeds the cap, and each one is
         * the prefix of the message it came from. */
        document.outcomes.forEach((row, at) => {
          expect(row.responseMessage.length).toBeLessThanOrEqual(
            MAX_RESPONSE_MESSAGE_CHARS
          )
          const original = record.outcomes[at].responseMessage
          expect(row.responseMessage).toBe(firstFiveHundred(original))
          expect(original.startsWith(row.responseMessage)).toBe(true)
        })

        /* Requirement 3.9 over what the store can hold: the round trip is the
         * identity on the truncated record, and every other field is
         * untouched by the truncation. */
        const stored = asStored(record)
        expect(back).toEqual(stored)
        expect(roundTrip(back)).toEqual(stored)
        expect(roundTrip(roundTrip(back))).toEqual(stored)

        /* Row count and row order survive independently of message length. */
        expect(back.outcomes.map((row) => row.hiveId)).toEqual(
          record.outcomes.map((row) => row.hiveId)
        )
        expect(back.outcomes.map((row) => row.outcome)).toEqual(
          record.outcomes.map((row) => row.outcome)
        )
      }),
      { numRuns: 200 }
    )
  })

  it("returns the completion timestamp character for character, whatever offset or precision it carries", () => {
    fc.assert(
      fc.property(
        storableRecordArb,
        instantSecondsArb,
        fractionArb,
        fc.constantFrom(...ZONE_OFFSET_MINUTES),
        (record, seconds, fraction, offsetMinutes) => {
          const spelled = spellTimestamp(seconds, fraction, offsetMinutes)
          const document = toHistoryDocument({
            ...record,
            completedAt: spelled,
          })

          /* The string is authoritative and is stored as the domain holds it:
           * an offset does not collapse to `Z` and a nine-digit fraction is
           * not cut to three. */
          expect(document.completedAt).toBe(spelled)
          expect(fromHistoryDocument(document).completedAt).toBe(spelled)

          /* `completedAtMs` is derived beside it for the Requirement 3.4 sort,
           * is always a finite double, and denotes the same instant however
           * the string spells it. */
          expect(Number.isFinite(document.completedAtMs)).toBe(true)
          expect(document.completedAtMs).toBe(Date.parse(spelled))

          const utc = spellTimestamp(seconds, fraction, 0)
          const alsoUtc = spellTimestamp(seconds, fraction, 0, true)
          for (const same of [utc, alsoUtc]) {
            const other = toHistoryDocument({
              ...record,
              completedAt: same,
            })
            expect(other.completedAtMs).toBe(document.completedAtMs)
            /* Same instant, and — unless the offset was already zero — a
             * different spelling of it, which is exactly why the string and
             * the number are both stored. */
            expect(other.completedAt).toBe(same)
          }

          /* An unparsable spelling still comes back untouched, with a finite
           * sort key rather than a NaN one. */
          const unparsable = toHistoryDocument({
            ...record,
            completedAt: "not-a-timestamp",
          })
          expect(unparsable.completedAt).toBe("not-a-timestamp")
          expect(Number.isFinite(unparsable.completedAtMs)).toBe(true)
          expect(fromHistoryDocument(unparsable).completedAt).toBe(
            "not-a-timestamp"
          )
        }
      ),
      { numRuns: 200 }
    )
  })

  it("copies every outcome row, so neither side can reach into the other", () => {
    fc.assert(
      fc.property(
        recordArb(shortResponseMessageArb).filter(
          (record) => record.outcomes.length > 0
        ),
        (record) => {
          const document = toHistoryDocument(record)

          /* No stored row is the object the caller passed in. */
          document.outcomes.forEach((row, at) => {
            expect(row).not.toBe(record.outcomes[at])
          })
          expect(document.outcomes).not.toBe(record.outcomes)

          /* Writing through the document does not reach the record it came
           * from, and the record read back is a third set of objects. */
          const before = record.outcomes.map((row) => ({ ...row }))
          const rewritten = `${document.outcomes[0].responseMessage}\u0000edit`
          document.outcomes[0] = {
            ...document.outcomes[0],
            responseMessage: rewritten,
          }
          const back = fromHistoryDocument(document)
          expect(back.outcomes[0].responseMessage).toBe(rewritten)
          expect(record.outcomes).toEqual(before)
          back.outcomes.forEach((row, at) => {
            expect(row).not.toBe(document.outcomes[at])
          })
        }
      ),
      { numRuns: 200 }
    )
  })
})
