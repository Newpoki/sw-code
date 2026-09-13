// Feature: mongodb-google-auth-admin, Property 3: Member_Registry mapping round
// trip — for any Member_Registry entry, any identifier, any Member_Label of 1 to
// 40 characters including astral-plane and combining characters, any Hive_ID of
// 1 to 64 characters, either enabled state, and any ISO 8601 creation timestamp
// the domain produces, mapping the entry to a Store_Document and then mapping
// that Store_Document back produces an entry whose identifier, Member_Label,
// Hive_ID, enabled state, and creation timestamp each equal those of the
// original entry.
//
// Validates: Requirements 2.10, 2.11.
//
// The two mappings are pure and take no connection, which is the whole reason
// the design put them in `documents.server.ts` rather than inside the store: a
// round trip through the driver can hide a mapping bug, and a mapping bug can
// hide behind a driver that never ran. So this file calls
// `toMemberDocument` / `fromMemberDocument` directly and never opens a database.
//
// Three things the property is deliberately strict about:
//
//   * **Code units, not glyphs.** The Member_Label generator reaches
//     astral-plane characters (surrogate pairs), combining marks, joined
//     sequences, and the decomposed spelling of characters that also have a
//     precomposed one. The comparison is `Array.from` over code units, so a
//     mapping that normalized, re-encoded, or split a surrogate pair fails
//     here rather than in production against a member whose name carries an
//     accent.
//
//   * **`position` stays out of the domain.** It is the counter's value
//     (Requirement 2.1) and no field of a Member_Registry entry, so the round
//     trip must answer the same entry whatever position was supplied, and the
//     restored entry must not carry one.
//
//   * **The creation timestamp is compared as the string the domain holds.** It
//     travels as a BSON `Date` and comes back through `toISOString()`, which is
//     exact for the values the domain produces — every
//     `MemberRegistryEntry.createdAt` is `Date.prototype.toISOString()` output.
//     The generator therefore builds timestamps that way rather than from
//     free-form text, which is what makes the equality claim of Requirement
//     2.11 a claim about this mapping and not about `Date` parsing.

import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { HIVE_ID_MAX_LENGTH, MEMBER_LABEL_MAX_LENGTH } from "@/domain/schemas"
import {
  fromMemberDocument,
  toMemberDocument,
} from "@/server/store/documents.server"

import type { MemberRegistryEntry } from "@/domain/types"

/* -------------------------------------------------------------------------- */
/* Local arbitraries                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Text units a Member_Label is assembled from. Every group is here on purpose:
 * plain ASCII, precomposed and decomposed spellings of the same accented
 * character, standalone combining marks, astral-plane characters (each one a
 * surrogate pair), a zero-width-joiner sequence, a variation selector, and
 * bidirectional text. Lengths are counted in UTF-16 code units, the reading
 * `MEMBER_LABEL_MAX_LENGTH` already uses.
 */
const LABEL_UNITS: ReadonlyArray<string> = [
  /* ASCII, including the internal space a label may hold. */
  "a",
  "Z",
  "7",
  " ",
  "-",
  "'",
  /* Precomposed, then the same character decomposed: e + U+0301. */
  "é",
  "e\u0301",
  /* Combining marks on their own, which must not migrate or be dropped. */
  "\u0301",
  "\u0327",
  "\u0654",
  /* Astral plane: one surrogate pair each. */
  "😀",
  "🐝",
  "𝔘",
  "𠜎",
  /* A joined sequence and a variation selector. */
  "🏳\u200d🌈",
  "❤\ufe0f",
  /* Non-Latin scripts, including right-to-left. */
  "漢",
  "ب",
  "Ж",
]

/** Hive_ID units: the shape a Hive_ID takes, in both cases and with digits. */
const HIVE_UNITS: ReadonlyArray<string> = Array.from(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"
)

/**
 * `units` joined while the total stays inside `maxUnits` UTF-16 code units, so
 * a sample never lands over the limit and no surrogate pair is ever cut in
 * half — which slicing a joined string to a length would do.
 */
function joinWithin(
  units: ReadonlyArray<string>,
  maxUnits: number
): string | null {
  let text = ""
  for (const unit of units) {
    if (text.length + unit.length > maxUnits) break
    text += unit
  }
  return text.length === 0 ? null : text
}

/**
 * A Member_Label of 1 to 40 code units, holding no leading or trailing
 * whitespace character — the domain trims before it ever reaches the mapping.
 */
const memberLabelArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...LABEL_UNITS), {
    minLength: 1,
    maxLength: 24,
    size: "max",
  })
  .map((units) => joinWithin(units, MEMBER_LABEL_MAX_LENGTH))
  .filter((label): label is string => label !== null)
  .map((label) => label.trim())
  .filter((label) => label.length >= 1)

/**
 * A Member_Label drawn only from the units the task singles out: astral-plane
 * characters and combining marks. The general generator reaches them too, but
 * this one guarantees every sample carries them.
 */
const exoticLabelArb: fc.Arbitrary<string> = fc
  .array(
    fc.constantFrom(
      "😀",
      "🐝",
      "𝔘",
      "𠜎",
      "🏳\u200d🌈",
      "e\u0301",
      "a\u0327",
      "\u0301",
      "\u0654"
    ),
    { minLength: 1, maxLength: 20, size: "max" }
  )
  .map((units) => joinWithin(units, MEMBER_LABEL_MAX_LENGTH))
  .filter((label): label is string => label !== null)

/** A Hive_ID of 1 to 64 characters, mixed case. */
const hiveIdArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...HIVE_UNITS), {
    minLength: 1,
    maxLength: HIVE_ID_MAX_LENGTH,
    size: "max",
  })
  .map((units) => units.join(""))

/**
 * An entry identifier: the surrogate key the store hands out. `crypto.randomUUID`
 * output is what production produces, so both spellings are here — a uuid and a
 * short opaque token, since Requirement 2.11 quantifies over any identifier.
 */
const entryIdArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: fc.uuid() },
  {
    weight: 1,
    arbitrary: fc
      .array(fc.constantFrom(...HIVE_UNITS), {
        minLength: 1,
        maxLength: 32,
        size: "max",
      })
      .map((units) => units.join("")),
  }
)

/**
 * A creation timestamp the domain produces: `toISOString()` output, over a range
 * wide enough to cross the epoch, a leap day, and a fractional-second value,
 * while staying inside the four-digit-year ISO form the domain ever writes.
 */
const createdAtArb: fc.Arbitrary<string> = fc
  .date({
    min: new Date("1970-01-01T00:00:00.000Z"),
    max: new Date("2999-12-31T23:59:59.999Z"),
    noInvalidDate: true,
  })
  .map((at) => at.toISOString())

/** The counter's value. Positions start at 1 (Requirement 2.1). */
const positionArb: fc.Arbitrary<number> = fc.integer({ min: 1, max: 1_000_000 })

/** A Member_Registry entry, as the domain holds one. */
const entryArb: fc.Arbitrary<MemberRegistryEntry> = fc.record({
  id: entryIdArb,
  memberLabel: memberLabelArb,
  hiveId: hiveIdArb,
  enabled: fc.boolean(),
  createdAt: createdAtArb,
})

/** The same entry, with its Member_Label drawn from the exotic pool. */
const exoticEntryArb: fc.Arbitrary<MemberRegistryEntry> = fc.record({
  id: entryIdArb,
  memberLabel: exoticLabelArb,
  hiveId: hiveIdArb,
  enabled: fc.boolean(),
  createdAt: createdAtArb,
})

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** `entry` through both mappings. */
function roundTrip(
  entry: MemberRegistryEntry,
  position: number
): MemberRegistryEntry {
  return fromMemberDocument(toMemberDocument(entry, position))
}

/** UTF-16 code units of `text`, so a comparison is per code unit. */
function codeUnits(text: string): Array<number> {
  return Array.from({ length: text.length }, (_, at) => text.charCodeAt(at))
}

/* -------------------------------------------------------------------------- */
/* The property                                                               */
/* -------------------------------------------------------------------------- */

describe("Property 3: Member_Registry mapping round trip", () => {
  it("restores the identifier, Member_Label, Hive_ID, enabled state, and creation timestamp", () => {
    fc.assert(
      fc.property(entryArb, positionArb, (entry, position) => {
        const restored = roundTrip(entry, position)

        expect(restored.id).toBe(entry.id)
        expect(restored.memberLabel).toBe(entry.memberLabel)
        expect(restored.hiveId).toBe(entry.hiveId)
        expect(restored.enabled).toBe(entry.enabled)
        expect(restored.createdAt).toBe(entry.createdAt)

        /* Whole-value equality as well, which also says the restored entry
         * carries no sixth field — `position` and `_id` are the database's, not
         * the domain's. */
        expect(restored).toEqual(entry)
        expect(Object.keys(restored).sort()).toEqual([
          "createdAt",
          "enabled",
          "hiveId",
          "id",
          "memberLabel",
        ])
      }),
      { numRuns: 300 }
    )
  })

  it("preserves astral-plane and combining characters code unit for code unit", () => {
    fc.assert(
      fc.property(exoticEntryArb, positionArb, (entry, position) => {
        const restored = roundTrip(entry, position)

        /* Per code unit, so a re-encode, a lost surrogate half, or a migrated
         * combining mark shows up as a difference rather than as an equal
         * glyph. */
        expect(codeUnits(restored.memberLabel)).toEqual(
          codeUnits(entry.memberLabel)
        )
        expect(restored.memberLabel.length).toBe(entry.memberLabel.length)

        /* Nothing normalizes on the way through: a decomposed spelling stays
         * decomposed even where a precomposed one exists. */
        const normalized = entry.memberLabel.normalize("NFC")
        if (normalized !== entry.memberLabel) {
          expect(restored.memberLabel).not.toBe(normalized)
        }
      }),
      { numRuns: 200 }
    )
  })

  it("carries the domain fields into the Store_Document beside the supplied position", () => {
    fc.assert(
      fc.property(entryArb, positionArb, (entry, position) => {
        const document = toMemberDocument(entry, position)

        expect(document.entryId).toBe(entry.id)
        expect(document.memberLabel).toBe(entry.memberLabel)
        expect(document.hiveId).toBe(entry.hiveId)
        expect(document.enabled).toBe(entry.enabled)
        expect(document.position).toBe(position)

        /* The creation timestamp travels as a BSON `Date` naming the same
         * instant, and renders back to the same string. */
        expect(document.createdAt).toBeInstanceOf(Date)
        expect(document.createdAt.getTime()).toBe(Date.parse(entry.createdAt))
        expect(document.createdAt.toISOString()).toBe(entry.createdAt)
      }),
      { numRuns: 200 }
    )
  })

  it("answers the same entry whatever position the counter assigned", () => {
    fc.assert(
      fc.property(
        entryArb,
        positionArb,
        positionArb,
        (entry, first, second) => {
          /* `position` is roster order, not a field of the entry, so it cannot
           * reach the domain value in either direction. */
          expect(roundTrip(entry, first)).toEqual(roundTrip(entry, second))
          expect(roundTrip(entry, first)).toEqual(entry)
        }
      ),
      { numRuns: 150 }
    )
  })

  it("maps the restored entry to the same Store_Document again", () => {
    fc.assert(
      fc.property(entryArb, positionArb, (entry, position) => {
        const once = toMemberDocument(entry, position)
        const twice = toMemberDocument(fromMemberDocument(once), position)

        /* A second trip changes nothing, so the round trip is stable and not
         * merely reversible for one lap. */
        expect(twice).toEqual(once)
        expect(twice.createdAt.getTime()).toBe(once.createdAt.getTime())
      }),
      { numRuns: 150 }
    )
  })
})
