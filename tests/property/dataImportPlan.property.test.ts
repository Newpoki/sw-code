// Feature: mongodb-google-auth-admin, Property 10: The Data_Import accepts, orders, counts, and caps deterministically — for any Legacy_Json_Store document holding zero or more Member_Registry entries and zero or more Redemption_History records in any order, mixing valid values with out-of-range Member_Labels and Hive_IDs, Hive_IDs duplicating an earlier accepted one, zero-character Coupon_Codes, absent completion timestamps, present and absent creation timestamps, and present and absent append counter values, the plan holds one document per accepted element and none per skipped element, inserts the first 100 accepted entries in relative order and the 200 accepted records holding the most recent completion timestamps, preserves each createdAt or falls back to the startup timestamp, preserves each finite seq and assigns the rest without collision, seeds both counters to the highest value assigned, reports skipped and discarded counts whose sums close the books on every element, and is a deterministic function of its input.
//
// Validates: Requirements 4.1, 4.3, 4.7, 4.8.
//
// `planDataImport` is the pure half of the Data_Import: a function of a parsed
// `StoreDocument` and a startup timestamp, with no database. This property
// exercises it directly, which is the whole reason the plan was split out of the
// imperative `runDataImport`.
//
// The expectation is stated against a *locally restated* reading of Requirement
// 4's accept / order / count / cap / assign rules — an independent
// re-derivation over the same generated document, never a second call to
// `planDataImport`. Agreement between the planner and that re-derivation is
// therefore evidence, not a tautology: a bug in the planner would have to be
// mirrored by an identical bug in this file's restatement to hide, and the two
// are written to look nothing alike.

import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { HIVE_ID_MAX_LENGTH, MEMBER_LABEL_MAX_LENGTH } from "@/domain/schemas"
import { MEMBER_REGISTRY_MAX_ENTRIES } from "@/domain/rosterMessages"
import { HISTORY_RETENTION_LIMIT } from "@/domain/types"
import { planDataImport } from "@/server/store/dataImport.server"
import type { StoreDocument } from "@/server/store/jsonStore.server"

import {
  DATA_IMPORT_ENTRY_CAP,
  DATA_IMPORT_RECORD_CAP,
  legacyStoreSampleArb,
} from "./generators"
import type { LegacyStoreSample } from "./generators"

/* -------------------------------------------------------------------------- */
/* A local restatement of Requirement 4's rules                               */
/* -------------------------------------------------------------------------- */

/** A fixed startup timestamp, so an entry that holds no `createdAt` has a known fallback. */
const STARTUP_TIMESTAMP = "2099-06-15T12:00:00.000Z"

/**
 * The accept / skip decision of Requirement 4.7 for entries, re-derived here
 * over the raw entries rather than by trusting the sample's `disposition`. The
 * sample's tag is convenient, but re-deriving from the strings is what keeps
 * this file honest against the generator too.
 */
interface ExpectedEntry {
  readonly memberLabel: string
  readonly hiveId: string
  readonly enabled: boolean
  readonly expectedCreatedAt: string
}

function trimmedLength(value: string): number {
  return value.trim().length
}

/** Re-derives the accepted entries in document order, applying Requirements 4.7 and 4.8. */
function expectedEntries(document: StoreDocument): {
  kept: ReadonlyArray<ExpectedEntry>
  accepted: number
  skipped: number
  discarded: number
} {
  const takenHiveIds = new Set<string>()
  const accepted: ExpectedEntry[] = []
  let skipped = 0

  for (const entry of document.members) {
    const label = entry.memberLabel
    const hive = entry.hiveId
    const inRange =
      trimmedLength(label) >= 1 &&
      trimmedLength(label) <= MEMBER_LABEL_MAX_LENGTH &&
      trimmedLength(hive) >= 1 &&
      trimmedLength(hive) <= HIVE_ID_MAX_LENGTH
    const trimmedHive = hive.trim()
    if (!inRange || takenHiveIds.has(trimmedHive)) {
      skipped += 1
      continue
    }
    takenHiveIds.add(trimmedHive)
    const created = entry.createdAt
    accepted.push({
      memberLabel: label,
      hiveId: hive,
      enabled: entry.enabled,
      expectedCreatedAt:
        typeof created === "string" && created.length > 0
          ? created
          : STARTUP_TIMESTAMP,
    })
  }

  const kept = accepted.slice(0, DATA_IMPORT_ENTRY_CAP)
  return {
    kept,
    accepted: accepted.length,
    skipped,
    discarded: accepted.length - kept.length,
  }
}

interface AcceptedRecord {
  readonly index: number
  readonly couponCode: string
  readonly completedAt: string
  readonly heldSeq: number | undefined
  readonly completionMs: number
}

/** Epoch milliseconds for a completion timestamp, 0 when unparsable — matching the planner's guard. */
function completionMs(completedAt: string): number {
  const ms = new Date(completedAt).getTime()
  return Number.isFinite(ms) ? ms : 0
}

/** The finite `seq` a record holds, or undefined when it holds none. */
function heldSeq(record: { seq?: number }): number | undefined {
  const seq = record.seq
  return typeof seq === "number" && Number.isFinite(seq)
    ? Math.floor(seq)
    : undefined
}

/**
 * Re-derives the accepted records: skip the blank-coupon and no-timestamp ones
 * (Requirement 4.7), keep the newest 200 breaking ties by earlier document
 * position, then restore document order among the survivors (Requirement 4.8).
 */
function expectedRecords(document: StoreDocument): {
  kept: ReadonlyArray<AcceptedRecord>
  accepted: number
  skipped: number
  discarded: number
} {
  const accepted: AcceptedRecord[] = []
  let skipped = 0

  document.history.forEach((record, index) => {
    const coupon =
      typeof record.couponCode === "string" ? record.couponCode : ""
    const completed =
      typeof record.completedAt === "string" ? record.completedAt : ""
    if (coupon.length === 0 || completed.length === 0) {
      skipped += 1
      return
    }
    accepted.push({
      index,
      couponCode: coupon,
      completedAt: completed,
      heldSeq: heldSeq(record),
      completionMs: completionMs(completed),
    })
  })

  if (accepted.length <= DATA_IMPORT_RECORD_CAP) {
    return {
      kept: accepted,
      accepted: accepted.length,
      skipped,
      discarded: 0,
    }
  }

  const byRecency = [...accepted].sort((left, right) => {
    const delta = right.completionMs - left.completionMs
    return delta !== 0 ? delta : left.index - right.index
  })
  const survivors = byRecency
    .slice(0, DATA_IMPORT_RECORD_CAP)
    .sort((left, right) => left.index - right.index)

  return {
    kept: survivors,
    accepted: accepted.length,
    skipped,
    discarded: accepted.length - survivors.length,
  }
}

/**
 * The `seq` the plan should assign to the kept records: preserve a finite one,
 * assign the rest starting one above the highest preserved value, climbing in
 * relative order. Returns the per-record `seq` and the highest value present.
 */
function expectedSeqs(kept: ReadonlyArray<AcceptedRecord>): {
  seqs: ReadonlyArray<number>
  maxSeq: number
} {
  const preservedMax = kept.reduce(
    (highest, record) =>
      record.heldSeq === undefined
        ? highest
        : Math.max(highest, record.heldSeq),
    0
  )
  let nextAssigned = preservedMax
  let maxSeq = preservedMax
  const seqs = kept.map((record) => {
    if (record.heldSeq !== undefined) {
      return record.heldSeq
    }
    nextAssigned += 1
    maxSeq = Math.max(maxSeq, nextAssigned)
    return nextAssigned
  })
  return { seqs, maxSeq }
}

/* -------------------------------------------------------------------------- */
/* Arbitraries                                                                */
/* -------------------------------------------------------------------------- */

/** The everyday document: a handful of entries and records, both below their caps. */
const documentArb = legacyStoreSampleArb()

/**
 * A document that reaches past both caps: more than 100 accepted entries and
 * more than 200 accepted records, so the discard counts and the cap ordering are
 * actually exercised. Kept in its own, smaller `fc.assert` because building a
 * 200-plus-record document per sample is not free; still run at the floor.
 */
const overCapDocumentArb = legacyStoreSampleArb({
  minEntries: 110,
  maxEntries: 140,
  minRecords: 220,
  maxRecords: 260,
})

/* -------------------------------------------------------------------------- */
/* The property                                                               */
/* -------------------------------------------------------------------------- */

describe("Property 10: the Data_Import plan accepts, orders, counts, and caps deterministically", () => {
  it("uses the same caps the planner imports", () => {
    /* The generator restates the two caps so it stays free of server-only
     * imports; if either drifts from the domain constant, every count and cap
     * assertion below would be about the wrong number. */
    expect(DATA_IMPORT_ENTRY_CAP).toBe(MEMBER_REGISTRY_MAX_ENTRIES)
    expect(DATA_IMPORT_RECORD_CAP).toBe(HISTORY_RETENTION_LIMIT)
  })

  it("keeps every accepted entry once, in relative order, with the right createdAt and positions", () => {
    fc.assert(
      fc.property(documentArb, (sample: LegacyStoreSample) => {
        const plan = planDataImport(sample.document, STARTUP_TIMESTAMP)
        const expected = expectedEntries(sample.document)

        // One document per accepted-and-kept entry, none per skipped.
        expect(plan.members.length).toBe(expected.kept.length)

        plan.members.forEach((doc, offset) => {
          const want = expected.kept[offset]
          // Relative document order preserved, field for field.
          expect(doc.memberLabel).toBe(want.memberLabel)
          expect(doc.hiveId).toBe(want.hiveId)
          expect(doc.enabled).toBe(want.enabled)
          // createdAt preserved when present, else the startup timestamp.
          expect(doc.createdAt.toISOString()).toBe(
            new Date(want.expectedCreatedAt).toISOString()
          )
          // Positions are 1..N, contiguous, in relative order.
          expect(doc.position).toBe(offset + 1)
        })
      }),
      { numRuns: 300 }
    )
  })

  it("keeps every accepted record once and preserves or assigns seq without collision", () => {
    fc.assert(
      fc.property(documentArb, (sample: LegacyStoreSample) => {
        const plan = planDataImport(sample.document, STARTUP_TIMESTAMP)
        const expected = expectedRecords(sample.document)
        const { seqs } = expectedSeqs(expected.kept)

        expect(plan.history.length).toBe(expected.kept.length)

        // The set of *preserved* seq values, so we can check that no assigned
        // value collides with one. Duplicate preserved values are the file's to
        // keep, not ours to fault: Requirement 4.1 preserves each append counter
        // value a record holds verbatim, and two legacy records may hold the
        // same one, so uniqueness is claimed only over the assigned values and
        // between assigned and preserved — never between two preserved.
        const preserved = new Set(
          expected.kept
            .map((record) => record.heldSeq)
            .filter((seq): seq is number => seq !== undefined)
        )
        const assignedValues: number[] = []

        plan.history.forEach((doc, offset) => {
          const want = expected.kept[offset]
          // Accepted records kept in relative document order among survivors.
          expect(doc.couponCode).toBe(want.couponCode)
          expect(doc.completedAt).toBe(want.completedAt)
          // A finite seq is preserved; an assigned one fills in as re-derived.
          expect(doc.seq).toBe(seqs[offset])
          if (want.heldSeq === undefined) {
            assignedValues.push(doc.seq)
          }
        })

        // An assigned seq never collides with a preserved one, and no two
        // assigned values collide with each other (Requirement 4.1).
        for (const assigned of assignedValues) {
          expect(preserved.has(assigned)).toBe(false)
        }
        expect(new Set(assignedValues).size).toBe(assignedValues.length)
      }),
      { numRuns: 300 }
    )
  })

  it("reports skipped counts equal to the number failing each rule", () => {
    fc.assert(
      fc.property(documentArb, (sample: LegacyStoreSample) => {
        const plan = planDataImport(sample.document, STARTUP_TIMESTAMP)
        const entries = expectedEntries(sample.document)
        const records = expectedRecords(sample.document)

        expect(plan.skippedEntries).toBe(entries.skipped)
        expect(plan.skippedRecords).toBe(records.skipped)

        // The books balance: every entry the document held is inserted,
        // skipped, or discarded over the cap; likewise every record.
        expect(
          plan.members.length + plan.skippedEntries + plan.discardedEntries
        ).toBe(sample.document.members.length)
        expect(
          plan.history.length + plan.skippedRecords + plan.discardedRecords
        ).toBe(sample.document.history.length)
      }),
      { numRuns: 300 }
    )
  })

  it("seeds each counter to the highest value it assigned", () => {
    fc.assert(
      fc.property(documentArb, (sample: LegacyStoreSample) => {
        const plan = planDataImport(sample.document, STARTUP_TIMESTAMP)
        const entries = expectedEntries(sample.document)
        const { maxSeq } = expectedSeqs(expectedRecords(sample.document).kept)

        // The position ceiling is the number of kept entries (positions 1..N).
        expect(plan.counters.member_position).toBe(entries.kept.length)
        expect(plan.counters.history_seq).toBe(maxSeq)

        // The ceiling is at least every position and every seq the plan holds.
        for (const doc of plan.members) {
          expect(plan.counters.member_position).toBeGreaterThanOrEqual(
            doc.position
          )
        }
        for (const doc of plan.history) {
          expect(plan.counters.history_seq).toBeGreaterThanOrEqual(doc.seq)
        }
      }),
      { numRuns: 300 }
    )
  })

  it("caps entries at 100 and history at the newest 200, discarding the surplus", () => {
    fc.assert(
      fc.property(overCapDocumentArb, (sample: LegacyStoreSample) => {
        const plan = planDataImport(sample.document, STARTUP_TIMESTAMP)
        const entries = expectedEntries(sample.document)
        const records = expectedRecords(sample.document)

        // Both caps are enforced.
        expect(plan.members.length).toBeLessThanOrEqual(DATA_IMPORT_ENTRY_CAP)
        expect(plan.history.length).toBeLessThanOrEqual(DATA_IMPORT_RECORD_CAP)

        // The discard counts equal accepted-beyond-cap.
        expect(plan.discardedEntries).toBe(entries.discarded)
        expect(plan.discardedRecords).toBe(records.discarded)

        // The kept entries are the first 100 accepted, in relative order.
        expect(plan.members.map((doc) => doc.hiveId)).toEqual(
          entries.kept.map((entry) => entry.hiveId)
        )
        // The kept records are the newest 200, restored to relative order.
        expect(plan.history.map((doc) => doc.completedAt)).toEqual(
          records.kept.map((record) => record.completedAt)
        )
        // Every kept record's completion instant is at least as recent as every
        // discarded record's — the "most recent" cap held.
        const keptMsValues = records.kept.map((record) => record.completionMs)
        const minKept =
          keptMsValues.length > 0 ? Math.min(...keptMsValues) : Infinity
        const acceptedIndexes = new Set(records.kept.map((r) => r.index))
        let seenAccepted = 0
        sample.document.history.forEach((record, index) => {
          const coupon =
            typeof record.couponCode === "string" ? record.couponCode : ""
          const completed =
            typeof record.completedAt === "string" ? record.completedAt : ""
          if (coupon.length === 0 || completed.length === 0) return
          seenAccepted += 1
          if (!acceptedIndexes.has(index)) {
            // A discarded accepted record: its instant is no newer than the
            // oldest kept one (ties resolve to the earlier document position).
            expect(completionMs(completed)).toBeLessThanOrEqual(minKept)
          }
        })
        expect(seenAccepted).toBe(records.accepted)
      }),
      { numRuns: 100 }
    )
  })

  it("yields empty plans with zero counters for a wholly-empty or wholly-skipped document", () => {
    fc.assert(
      fc.property(
        legacyStoreSampleArb({ maxEntries: 6, maxRecords: 6 }).filter(
          (sample) =>
            expectedEntries(sample.document).kept.length === 0 &&
            expectedRecords(sample.document).kept.length === 0
        ),
        (sample: LegacyStoreSample) => {
          const plan = planDataImport(sample.document, STARTUP_TIMESTAMP)
          expect(plan.members).toEqual([])
          expect(plan.history).toEqual([])
          expect(plan.discardedEntries).toBe(0)
          expect(plan.discardedRecords).toBe(0)
          expect(plan.counters.member_position).toBe(0)
          expect(plan.counters.history_seq).toBe(0)
        }
      ),
      { numRuns: 100 }
    )
  })

  it("is a deterministic function of its input", () => {
    fc.assert(
      fc.property(documentArb, (sample: LegacyStoreSample) => {
        const first = planDataImport(sample.document, STARTUP_TIMESTAMP)
        const second = planDataImport(sample.document, STARTUP_TIMESTAMP)
        // Same input, same plan — field for field on the inserted documents.
        expect(second.members).toEqual(first.members)
        expect(second.history).toEqual(first.history)
        expect(second.skippedEntries).toBe(first.skippedEntries)
        expect(second.skippedRecords).toBe(first.skippedRecords)
        expect(second.discardedEntries).toBe(first.discardedEntries)
        expect(second.discardedRecords).toBe(first.discardedRecords)
        expect(second.counters).toEqual(first.counters)
      }),
      { numRuns: 200 }
    )
  })
})
