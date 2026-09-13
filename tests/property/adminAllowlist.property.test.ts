// Feature: mongodb-google-auth-admin, Property 12: Admin_Allowlist parsing is
// total and normalizing — for any string, the parsed Admin_Allowlist holds only
// elements that are lower-case, hold no leading or trailing whitespace
// character, hold 1 to 254 characters, and hold at least one commercial at
// character; holds no two elements that are character-for-character identical;
// holds at most 50 elements; preserves the relative order of the first
// occurrence of each surviving element as they appear in that string; and holds
// zero elements for an absent value, a value holding only whitespace
// characters, and any value whose every comma-separated element fails one of
// those tests.
//
// Validates: Requirements 6.1, 6.2.
//
// The rule the parser is measured against is restated here from Requirement
// 6.1, not borrowed from `parseAdminAllowlist`: split on the comma character,
// trim each element, lower-case each element, discard elements of zero or more
// than 254 characters, discard elements holding no commercial at character,
// keep the first occurrence of each distinct value, take the first 50
// survivors. `expectedAllowlist` below is that rule written as a filter chain,
// where the implementation is a single accumulating loop, so agreement between
// the two is evidence rather than a tautology.
//
// The invariant half of the property is asserted directly on the output as
// well, because it has to hold for inputs no reference implementation was
// consulted about: arbitrary strings, strings holding no comma at all, and the
// absent value.
//
// No I/O and no environment: `parseAdminAllowlist` takes the raw value as an
// argument, which is why the design placed it in `src/domain/accounts.ts`
// rather than in `config.server.ts`.

import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
  ADMIN_ALLOWLIST_MAX_EMAIL_LENGTH,
  ADMIN_ALLOWLIST_MAX_ENTRIES,
  parseAdminAllowlist,
} from "@/domain/accounts"

import { blankTextArb, whitespacePaddingArb } from "./generators"

/* -------------------------------------------------------------------------- */
/* The rule, stated independently of the parser                               */
/* -------------------------------------------------------------------------- */

/** Requirement 6.1's six steps, as a filter chain. */
function expectedAllowlist(raw: string | undefined): ReadonlyArray<string> {
  if (raw === undefined) return []

  const folded = raw.split(",").map((element) => element.trim().toLowerCase())
  const surviving = folded.filter(
    (element) =>
      element.length >= 1 &&
      element.length <= ADMIN_ALLOWLIST_MAX_EMAIL_LENGTH &&
      element.includes("@")
  )
  const distinct = surviving.filter(
    (element, at) => surviving.indexOf(element) === at
  )

  return distinct.slice(0, ADMIN_ALLOWLIST_MAX_ENTRIES)
}

/* -------------------------------------------------------------------------- */
/* Local arbitraries                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Characters an address part is built from: cased letters, digits, and the
 * punctuation an address may hold. No comma, so an element never splits itself,
 * and no whitespace, so padding is the only source of trimmable characters.
 */
const ADDRESS_UNITS = Array.from(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-_+"
)

/** 1 to 10 address characters. */
const addressPartArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...ADDRESS_UNITS), {
    minLength: 1,
    maxLength: 10,
    size: "max",
  })
  .map((units) => units.join(""))

/** An address of mixed case holding exactly one commercial at character. */
const emailArb: fc.Arbitrary<string> = fc
  .tuple(addressPartArb, addressPartArb, fc.constantFrom("com", "IO", "Test"))
  .map(([local, domain, tld]) => `${local}@${domain}.${tld}`)

/** Wraps a value in whitespace that `trim` removes, either side possibly empty. */
function paddedArb(core: fc.Arbitrary<string>): fc.Arbitrary<string> {
  return fc
    .tuple(whitespacePaddingArb, core, whitespacePaddingArb)
    .map(([left, value, right]) => `${left}${value}${right}`)
}

/** Swaps the case of every cased character, so the fold has work to do. */
function swapCase(value: string): string {
  return Array.from(value, (character) => {
    const lower = character.toLowerCase()
    return character === lower ? character.toUpperCase() : lower
  }).join("")
}

/** An address padded, case-swapped, or both: the same element, spelled otherwise. */
function spellingsOfArb(email: string): fc.Arbitrary<string> {
  return paddedArb(fc.constantFrom(email, swapCase(email)))
}

/**
 * An element that survives none of Requirement 6.1's tests: blank, holding no
 * commercial at character, or longer than 254 characters after the fold. Each
 * failing element still holds no comma, so it stays one element.
 */
const doomedElementArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 2, arbitrary: blankTextArb },
  { weight: 3, arbitrary: paddedArb(addressPartArb) },
  {
    weight: 2,
    arbitrary: fc
      .integer({ min: ADMIN_ALLOWLIST_MAX_EMAIL_LENGTH + 1, max: 300 })
      .map((length) => `${"a".repeat(length - 8)}@long.io`),
  }
)

/**
 * An address of exactly 254 folded characters — the longest one parsing keeps,
 * so the boundary is not left to chance.
 */
const boundaryEmailArb: fc.Arbitrary<string> = fc.constant(
  `${"b".repeat(ADMIN_ALLOWLIST_MAX_EMAIL_LENGTH - 8)}@edge.io`
)

/**
 * A raw `ADMIN_EMAILS` value assembled from a pool of distinct addresses, their
 * re-spellings, and elements that fail a test, so a sample reaches survivors,
 * duplicates differing only in case or padding, and rejects at once.
 */
const rawAllowlistArb: fc.Arbitrary<string> = fc
  .uniqueArray(
    fc.oneof(
      { weight: 6, arbitrary: emailArb },
      { weight: 1, arbitrary: boundaryEmailArb }
    ),
    {
      minLength: 1,
      maxLength: 6,
      selector: (email) => email.toLowerCase(),
    }
  )
  .chain((pool) =>
    fc
      .array(
        fc.oneof(
          {
            weight: 6,
            arbitrary: fc.constantFrom(...pool).chain(spellingsOfArb),
          },
          { weight: 3, arbitrary: doomedElementArb }
        ),
        { minLength: 0, maxLength: 14 }
      )
      .map((elements) => elements.join(","))
  )

/** A raw value whose every element fails a test, so nothing may survive it. */
const rawDoomedArb: fc.Arbitrary<string> = fc
  .array(doomedElementArb, { minLength: 1, maxLength: 8 })
  .map((elements) => elements.join(","))

/**
 * Every shape of input the parser must answer: assembled values, wholly doomed
 * values, blank values, and arbitrary text that may hold commas, whitespace, or
 * neither. This is the totality generator of the property.
 */
const anyRawArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 5, arbitrary: rawAllowlistArb },
  { weight: 2, arbitrary: rawDoomedArb },
  { weight: 2, arbitrary: blankTextArb },
  { weight: 3, arbitrary: fc.string() },
  {
    weight: 2,
    arbitrary: fc.string({
      unit: fc.constantFrom(",", " ", "@", "a", "B", "\t", "é", "😀"),
      maxLength: 40,
    }),
  }
)

/* -------------------------------------------------------------------------- */
/* Shared assertions                                                          */
/* -------------------------------------------------------------------------- */

/** The element-shape, distinctness, and cap claims of the property. */
function expectWellFormed(allowlist: ReadonlyArray<string>): void {
  expect(Array.isArray(allowlist)).toBe(true)

  for (const element of allowlist) {
    expect(element).toBe(element.toLowerCase())
    expect(element).toBe(element.trim())
    expect(element.length).toBeGreaterThanOrEqual(1)
    expect(element.length).toBeLessThanOrEqual(ADMIN_ALLOWLIST_MAX_EMAIL_LENGTH)
    expect(element).toContain("@")
  }

  expect(new Set(allowlist).size).toBe(allowlist.length)
  expect(allowlist.length).toBeLessThanOrEqual(ADMIN_ALLOWLIST_MAX_ENTRIES)
}

/* -------------------------------------------------------------------------- */
/* The property                                                               */
/* -------------------------------------------------------------------------- */

describe("Property 12: Admin_Allowlist parsing is total and normalizing", () => {
  it("answers every input with a well-formed allowlist", () => {
    fc.assert(
      fc.property(anyRawArb, (raw) => {
        expectWellFormed(parseAdminAllowlist(raw))
      }),
      { numRuns: 300 }
    )
  })

  it("agrees with Requirement 6.1 read as a filter chain", () => {
    fc.assert(
      fc.property(anyRawArb, (raw) => {
        expect(parseAdminAllowlist(raw)).toEqual([...expectedAllowlist(raw)])
      }),
      { numRuns: 300 }
    )
  })

  it("preserves the relative order of the first occurrence of each survivor", () => {
    fc.assert(
      fc.property(rawAllowlistArb, (raw) => {
        const folded = raw
          .split(",")
          .map((element) => element.trim().toLowerCase())
        const allowlist = parseAdminAllowlist(raw)

        const firstOccurrences = allowlist.map((element) =>
          folded.indexOf(element)
        )

        /* Every element came from the string, and they arrive in the order
         * those first occurrences appear in it — strictly increasing, which
         * also restates the distinctness claim. */
        expect(firstOccurrences).not.toContain(-1)
        for (let at = 1; at < firstOccurrences.length; at += 1) {
          expect(firstOccurrences[at]).toBeGreaterThan(firstOccurrences[at - 1])
        }

        expectWellFormed(allowlist)
      }),
      { numRuns: 200 }
    )
  })

  it("keeps one element per distinct value, whatever its spelling", () => {
    fc.assert(
      fc.property(
        emailArb,
        fc.array(whitespacePaddingArb, { minLength: 2, maxLength: 6 }),
        (email, paddings) => {
          const raw = paddings
            .map((padding, at) =>
              at % 2 === 0
                ? `${padding}${email}${padding}`
                : `${padding}${swapCase(email)}`
            )
            .join(",")

          /* The same address spelled several ways is one element, and it is the
           * folded spelling that survives (Requirement 6.1). */
          expect(parseAdminAllowlist(raw)).toEqual([email.toLowerCase()])
        }
      ),
      { numRuns: 150 }
    )
  })

  it("takes at most the first 50 survivors, in order", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: ADMIN_ALLOWLIST_MAX_ENTRIES - 5, max: 70 }),
        fc.array(whitespacePaddingArb, { minLength: 1, maxLength: 4 }),
        (count, paddings) => {
          const addresses = Array.from(
            { length: count },
            (_, at) => `user-${at}@Example.COM`
          )
          const raw = addresses
            .map((address, at) => {
              const padding = paddings[at % paddings.length]
              return `${padding}${address}${padding}`
            })
            .join(",")

          const allowlist = parseAdminAllowlist(raw)
          const kept = Math.min(count, ADMIN_ALLOWLIST_MAX_ENTRIES)

          expect(allowlist.length).toBe(kept)
          expect(allowlist).toEqual(
            addresses.slice(0, kept).map((address) => address.toLowerCase())
          )
        }
      ),
      { numRuns: 100 }
    )
  })

  it("yields zero elements for an absent, blank, or wholly unusable value", () => {
    expect(parseAdminAllowlist(undefined)).toEqual([])

    fc.assert(
      fc.property(
        fc.oneof(
          { weight: 2, arbitrary: blankTextArb },
          { weight: 3, arbitrary: rawDoomedArb }
        ),
        (raw) => {
          /* Requirement 6.2: no element survives, and the answer is an empty
           * allowlist rather than a failure. */
          expect(parseAdminAllowlist(raw)).toEqual([])
        }
      ),
      { numRuns: 200 }
    )
  })
})
