// Feature: mongodb-google-auth-admin, Property 9: The history read order is total, and the latest record for a Coupon_Code is exact
//
// Validates: Requirements 3.4, 3.5.
//
// *For any* set of retained Redemption_History records — including records
// sharing a completion timestamp, records whose timestamps name the same instant
// in different spellings, and records whose Coupon_Codes differ only in letter
// case or surrounding whitespace — the history read returns at most 200 records
// ordered from the most recent completion instant to the oldest with the highest
// append counter value first among records sharing an instant, that order is
// identical across repeated reads, an empty collection returns zero records
// together with zero error messages, and the most-recent-record-for-a-Coupon_Code
// read returns the first record of that same order whose Coupon_Code is
// character-for-character identical to the given code and returns no record when
// the given code matches none of them character for character or holds zero
// characters.
//
// ## Why the expected order is computed from the instant, not from the text
//
// Each generated record carries the epoch milliseconds it was built from, and
// the expected order is computed from *that* number, never from the stored
// `completedAt` string and never from the `completedAtMs` the mapping derived.
// So a read that ordered `2025-01-04T18:00:00.000Z` and
// `2025-01-04T19:00:00.000+01:00` by their text — they name one instant and must
// therefore fall to the append-counter tie-break — fails here, and so would a
// read that trusted a mis-derived `completedAtMs`.
//
// ## Where the records come from
//
// Records are seeded straight into the `history` collection through the
// fixture's driver handle, mapped by `toHistoryDocument`, the same function the
// store writes through. Two reasons. Appending 205 records through the store is
// 200+ round trips per sample and is Property 8's subject, not this file's; and
// seeding is the only way to control the `seq` values and the exact `completedAt`
// spellings a sample needs. The `history_seq` counter is seeded alongside, so the
// collection looks exactly as it would had those records been appended.
//
// Seeding also lets the collection hold more than the retention window, which is
// the state a failed trim leaves behind (Requirement 3.11) and the only way to
// observe the "at most 200 records" half of Requirement 3.4 as a real cap rather
// than as a bound the data never reaches.
//
// ## No MongoDB, no vacuous pass
//
// Every clause needs a real deployment, so the suite is guarded by
// `mongoAvailability()` and states its skip reason as a test name that runs.

import fc from "fast-check"
import { afterAll, describe, expect, it } from "vitest"

import { HISTORY_RETENTION_LIMIT, MEMBER_OUTCOME_VALUES } from "@/domain/types"
import {
  fromHistoryDocument,
  toHistoryDocument,
} from "@/server/store/documents.server"
import { createHistoryStore } from "@/server/store/history.server"

import {
  closeMongoFixture,
  mongoAvailability,
  mongoSkipReason,
  reportMongoSkip,
  withThrowawayDatabase,
} from "../support/mongoFixture"

import type { RedemptionHistoryRecord } from "@/domain/types"
import type {
  CounterDocument,
  HistoryDocumentInput,
} from "@/server/store/documents.server"
import type { MongoSample } from "../support/mongoFixture"

/* -------------------------------------------------------------------------- */
/* Generators: instants, their spellings, and Coupon_Code variants            */
/* -------------------------------------------------------------------------- */

/** Fixed base instant, so a generated sample is deterministic across runs. */
const BASE_INSTANT_MS = Date.parse("2025-01-04T18:00:00.000Z")

/**
 * An instant, at whole hours around the base and with a millisecond component
 * that is sometimes zero and sometimes not.
 *
 * A zero millisecond component is what makes the fraction-free spellings below
 * available, so both fractional and fraction-free forms of one instant occur.
 */
const instantMsArb: fc.Arbitrary<number> = fc
  .tuple(fc.integer({ min: -6, max: 6 }), fc.constantFrom(0, 0, 250, 500, 999))
  .map(
    ([hours, milliseconds]) =>
      BASE_INSTANT_MS + hours * 3_600_000 + milliseconds
  )

/**
 * Every spelling this file uses for one instant: the canonical `Z` form, the
 * same instant written against three UTC offsets, and — when the instant lands
 * on a whole second — the fraction-free form of each.
 *
 * Every element names the same instant, which the property re-checks with
 * `Date.parse` before it trusts the sample: a spelling that did not would make
 * the expected order wrong rather than the store wrong.
 */
function instantSpellings(instantMs: number): Array<string> {
  const spellings: Array<string> = []
  const push = (text: string) => {
    if (!spellings.includes(text)) {
      spellings.push(text)
    }
  }

  /* The canonical form, always `YYYY-MM-DDTHH:mm:ss.sssZ`. */
  const canonical = new Date(instantMs).toISOString()
  push(canonical)
  if (canonical.endsWith(".000Z")) {
    push(canonical.replace(".000Z", "Z"))
  }

  /*
   * A local time shifted by the offset, written with that offset, names the
   * original instant: 19:00 at +01:00 is 18:00Z.
   */
  for (const [offsetMinutes, suffix] of [
    [60, "+01:00"],
    [-330, "-05:30"],
    [0, "+00:00"],
  ] as const) {
    const shifted = new Date(instantMs + offsetMinutes * 60_000).toISOString()
    push(shifted.replace(/Z$/, suffix))
    if (shifted.endsWith(".000Z")) {
      push(shifted.replace(".000Z", suffix))
    }
  }

  return spellings
}

/** Units a Coupon_Code of this file is built from. */
const CODE_UNITS = "abcdefghijklmnopqrstuvwxyz0123456789-".split("")

/** The letters one of which every generated base code holds. */
const LOWER_LETTERS = "abcdefghijklmnopqrstuvwxyz".split("")

/**
 * A lower-case Coupon_Code holding at least one ASCII letter, so it has case
 * variants that differ from it. Every value is its own trimmed form and stays
 * well inside the 1-to-64-character range of Requirement 3.1.
 */
const baseCouponCodeArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.string({ unit: fc.constantFrom(...CODE_UNITS), maxLength: 8 }),
    fc.constantFrom(...LOWER_LETTERS),
    fc.string({ unit: fc.constantFrom(...CODE_UNITS), maxLength: 8 })
  )
  .map(([before, letter, after]) => `${before}${letter}${after}`)

/**
 * `base` together with the spellings that differ from it only in letter case or
 * only in surrounding whitespace.
 *
 * These are the values Requirement 3.5 is exact about: the lookup folds nothing,
 * so every one of them is a distinct Coupon_Code, and a store that trimmed or
 * lower-cased would attach one record to a code that was never redeemed.
 */
function couponCodeVariants(base: string): Array<string> {
  const variants = new Set<string>([
    base,
    base.toUpperCase(),
    base[0].toUpperCase() + base.slice(1),
    ` ${base}`,
    `${base} `,
    `\t${base}\t`,
  ])
  return [...variants]
}

/* -------------------------------------------------------------------------- */
/* Samples                                                                    */
/* -------------------------------------------------------------------------- */

/** One record to be seeded, in append order. */
interface RecordSeed {
  readonly runId: string
  readonly couponCode: string
  /** The instant {@link completedAt} spells. The expected order sorts on this. */
  readonly instantMs: number
  /** One spelling of {@link instantMs}, stored character for character. */
  readonly completedAt: string
  readonly mock: boolean
  readonly stoppedEarly: boolean
  readonly outcomeCount: number
}

/** One sample: the records to seed, and the codes to look up afterwards. */
interface HistorySample {
  /** Append order; the record at index `i` is seeded with `seq` `i + 1`. */
  readonly seeds: ReadonlyArray<RecordSeed>
  /** Codes the lookup is exercised with, hits and misses alike. */
  readonly probes: ReadonlyArray<string>
}

/** The raw choices one record is drawn from, resolved against the pools below. */
const rawSeedArb = fc.record({
  runIndex: fc.nat({ max: 9_999 }),
  codePick: fc.nat(),
  instantPick: fc.nat(),
  spellingPick: fc.nat(),
  mock: fc.boolean(),
  stoppedEarly: fc.boolean(),
  outcomeCount: fc.nat({ max: 2 }),
})

/**
 * A set of records drawn from a deliberately small pool of instants and a
 * deliberately small pool of Coupon_Code variants, so records sharing an instant
 * and records whose codes differ only in case or whitespace are the common case
 * rather than a rare coincidence.
 */
function historySampleArb(options: {
  readonly minRecords: number
  readonly maxRecords: number
}): fc.Arbitrary<HistorySample> {
  return fc
    .tuple(
      fc.array(baseCouponCodeArb, { minLength: 1, maxLength: 3 }),
      fc.uniqueArray(instantMsArb, { minLength: 1, maxLength: 3 })
    )
    .chain(([bases, instants]) => {
      const codes = [...new Set(bases.flatMap(couponCodeVariants))]
      return fc
        .tuple(
          fc.array(rawSeedArb, {
            minLength: options.minRecords,
            maxLength: options.maxRecords,
          }),
          fc.array(fc.nat(), { minLength: 1, maxLength: 3 })
        )
        .map(([raws, probePicks]) => ({
          seeds: raws.map((raw, at): RecordSeed => {
            const instantMs = instants[raw.instantPick % instants.length]
            const spellings = instantSpellings(instantMs)
            return {
              runId: `run-${at}-${raw.runIndex}`,
              couponCode: codes[raw.codePick % codes.length],
              instantMs,
              completedAt: spellings[raw.spellingPick % spellings.length],
              mock: raw.mock,
              stoppedEarly: raw.stoppedEarly,
              outcomeCount: raw.outcomeCount,
            }
          }),
          probes: probePicks.map((pick) => codes[pick % codes.length]),
        }))
    })
}

/* -------------------------------------------------------------------------- */
/* Seeding, and the order the store is measured against                       */
/* -------------------------------------------------------------------------- */

/** Outcome rows of one seeded record. Deterministic: order is what is under test. */
function outcomeRows(
  at: number,
  count: number
): RedemptionHistoryRecord["outcomes"] {
  return Array.from({ length: count }, (_, row) => ({
    hiveId: `hive-${at}-${row}`,
    memberLabel: `Member ${at}-${row}`,
    outcome: MEMBER_OUTCOME_VALUES[(at + row) % MEMBER_OUTCOME_VALUES.length],
    responseCode: "100",
    responseMessage: "Redeemed.",
  }))
}

/**
 * The Store_Documents of a sample, in append order, with `seq` running 1..n —
 * exactly what the `history_seq` counter would have assigned.
 */
function toSeededDocuments(
  seeds: ReadonlyArray<RecordSeed>
): Array<HistoryDocumentInput> {
  return seeds.map((seed, at) =>
    toHistoryDocument({
      runId: seed.runId,
      seq: at + 1,
      couponCode: seed.couponCode,
      completedAt: seed.completedAt,
      mock: seed.mock,
      stoppedEarly: seed.stoppedEarly,
      outcomes: outcomeRows(at, seed.outcomeCount),
    })
  )
}

/**
 * Inserts `documents` into the `history` collection and raises the `history_seq`
 * counter above every seeded `seq`, so the collection is indistinguishable from
 * one the store appended to.
 */
async function seedHistory(
  sample: MongoSample,
  documents: ReadonlyArray<HistoryDocumentInput>
): Promise<void> {
  if (documents.length === 0) {
    return
  }
  const db = sample.db()
  await db
    .collection<HistoryDocumentInput>("history")
    .insertMany(documents.map((document) => ({ ...document })))
  await db
    .collection<CounterDocument>("counters")
    .insertOne({ _id: "history_seq", value: documents.length })
}

/**
 * The Requirement 3.4 order, as indices into the append-ordered seeds: most
 * recent instant first, and among records sharing an instant the highest `seq`
 * — which is the highest index — first.
 *
 * Computed from `instantMs`, the number each spelling was built from, so the
 * expected order is independent of both the stored text and the derived
 * `completedAtMs`.
 */
function expectedOrder(seeds: ReadonlyArray<RecordSeed>): Array<number> {
  return seeds
    .map((_, at) => at)
    .sort(
      (left, right) =>
        seeds[right].instantMs - seeds[left].instantMs || right - left
    )
}

/** The records a read must return, in order and capped at the retention window. */
function expectedRecords(
  seeds: ReadonlyArray<RecordSeed>,
  documents: ReadonlyArray<HistoryDocumentInput>
): Array<RedemptionHistoryRecord> {
  return expectedOrder(seeds)
    .slice(0, HISTORY_RETENTION_LIMIT)
    .map((at) => fromHistoryDocument(documents[at]))
}

/**
 * The record Requirement 3.5 asks for: the first of the same order whose
 * `couponCode` is character-for-character `code`, and none for a code that
 * matches nothing or holds zero characters.
 *
 * The whole collection is searched rather than the first 200: the lookup is a
 * filter over the retained records, not a read of the history view's window.
 */
function expectedLatest(
  seeds: ReadonlyArray<RecordSeed>,
  documents: ReadonlyArray<HistoryDocumentInput>,
  code: string
): RedemptionHistoryRecord | null {
  if (code.length === 0) {
    return null
  }
  const at = expectedOrder(seeds).find(
    (index) => documents[index].couponCode === code
  )
  return at === undefined ? null : fromHistoryDocument(documents[at])
}

/* -------------------------------------------------------------------------- */
/* The property                                                               */
/* -------------------------------------------------------------------------- */

const mongo = await mongoAvailability()

describe.skipIf(!mongo.available)(
  "Property 9: the history read order is total, and the latest record for a Coupon_Code is exact",
  () => {
    afterAll(closeMongoFixture)

    it("orders by instant with the append counter breaking ties, repeatably, and looks a Coupon_Code up exactly", async () => {
      await fc.assert(
        fc.asyncProperty(
          historySampleArb({ minRecords: 0, maxRecords: 12 }),
          async (sample) => {
            /*
             * A generator self-check, not a claim about the store: every
             * spelling must name the instant the expected order sorts on, or
             * the sample would be measuring the wrong thing.
             */
            for (const seed of sample.seeds) {
              expect(Date.parse(seed.completedAt)).toBe(seed.instantMs)
            }

            await withThrowawayDatabase(
              async (throwaway) => {
                const history = createHistoryStore(
                  await throwaway.createStore()
                )

                // Requirement 3.4: an empty collection is zero records, no error.
                const empty = await history.list()
                expect(empty.kind).toBe("records")
                if (empty.kind === "records") {
                  expect(empty.records).toEqual([])
                }

                const documents = toSeededDocuments(sample.seeds)
                await seedHistory(throwaway, documents)

                const first = await history.list()
                expect(first.kind).toBe("records")
                if (first.kind !== "records") return

                // The order, the content, and the cap in one comparison.
                expect(first.records).toEqual(
                  expectedRecords(sample.seeds, documents)
                )
                expect(first.records.length).toBeLessThanOrEqual(
                  HISTORY_RETENTION_LIMIT
                )

                // Total: a second read of an unchanged collection agrees.
                const second = await history.list()
                expect(second.kind).toBe("records")
                if (second.kind === "records") {
                  expect(second.records).toEqual(first.records)
                }

                /*
                 * Requirement 3.5, over the stored codes and over the case and
                 * whitespace variants of them: each probe is compared against
                 * the locally computed answer, so a hit and a miss are both
                 * pinned by the same assertion.
                 */
                const storedCodes = [
                  ...new Set(documents.map((document) => document.couponCode)),
                ].slice(0, 3)
                const probes = [
                  ...new Set([...sample.probes, ...storedCodes]),
                ].slice(0, 6)

                for (const code of probes) {
                  const found = await history.findLatestByCouponCode(code)
                  const expected = expectedLatest(sample.seeds, documents, code)
                  if (expected === null) {
                    expect(found).toEqual({ kind: "not-found" })
                  } else {
                    expect(found.kind).toBe("record")
                    if (found.kind === "record") {
                      expect(found.record).toEqual(expected)
                    }
                  }
                }

                // A Coupon_Code of zero characters is always "no record".
                expect(await history.findLatestByCouponCode("")).toEqual({
                  kind: "not-found",
                })
              },
              { label: "read-order" }
            )
          }
        ),
        { numRuns: 100 }
      )
    } /*
     * Each sample is one bulk insert plus a handful of reads over its own
     * throwaway database, and there are 100 of them, so the bound is raised
     * above the 30s default rather than the run count lowered.
     */, 120_000)

    it("returns at most 200 records, the newest 200 of that order, from a collection holding more", async () => {
      await fc.assert(
        fc.asyncProperty(
          historySampleArb({
            minRecords: HISTORY_RETENTION_LIMIT + 1,
            maxRecords: HISTORY_RETENTION_LIMIT + 5,
          }),
          async (sample) => {
            await withThrowawayDatabase(
              async (throwaway) => {
                const documents = toSeededDocuments(sample.seeds)
                /*
                 * Seeded past the retention window on purpose: this is the
                 * state a trim that did not complete leaves behind
                 * (Requirement 3.11), and the read must not widen because of
                 * it.
                 */
                await seedHistory(throwaway, documents)

                const history = createHistoryStore(
                  await throwaway.createStore()
                )
                const read = await history.list()
                expect(read.kind).toBe("records")
                if (read.kind !== "records") return

                expect(read.records.length).toBe(HISTORY_RETENTION_LIMIT)
                expect(read.records).toEqual(
                  expectedRecords(sample.seeds, documents)
                )

                const again = await history.list()
                expect(again.kind).toBe("records")
                if (again.kind === "records") {
                  expect(again.records).toEqual(read.records)
                }
              },
              { label: "read-cap" }
            )
          }
        ),
        { numRuns: 100 }
      )
    }, 180_000)
  }
)

it.runIf(!mongo.available)(
  `skipped, no MongoDB: ${mongoSkipReason(mongo) ?? ""}`,
  () => {
    reportMongoSkip(
      "historyReadOrder property (Property 9, Requirements 3.4, 3.5)",
      mongo
    )
    expect(mongo.available).toBe(false)
    expect(mongoSkipReason(mongo)).not.toBeNull()
  }
)
