// Feature: mongodb-google-auth-admin, Property 7: Removing a roster entry
// preserves the history and every other position — for any Member_Registry, for
// any Redemption_History whose outcome rows reference the Hive_IDs of that
// registry, and for any selection of entries to remove, each confirmed removal
// deletes exactly one Store_Document, the removed entries are absent from every
// subsequent roster read, the position value of every surviving Store_Document
// is unchanged, and every Redemption_History record — including every outcome
// row referencing a removed Hive_ID — is unchanged in its Member_Outcome, its
// Member_Label, and its response fields.
//
// **Validates: Requirements 2.6**
//
// ## What this property needs a real database for
//
// Two of its four claims are claims about stored documents rather than about
// returned values. "The position value of every surviving Store_Document is
// unchanged" names a field the Member_Registry seam deliberately does not
// expose — `fromMemberDocument` drops `position`, because roster order is the
// domain's contract and `position` is only how the database keeps it. And
// "deletes exactly one Store_Document" is a count of documents, not a count of
// results. Both are read here through `sample.db()`, the fixture's own driver
// handle on the same throwaway database, so the assertion is against what the
// collection holds and not against what the store says it holds.
//
// ## Why the history half is seeded through the driver
//
// The Redemption_History store is being rewritten alongside this file, so
// importing it would couple this property to work in flight and would make a
// failure here ambiguous between "removal touched the history" and "the history
// store changed". The records are therefore inserted straight into the `history`
// collection as {@link HistoryDocumentInput} values — the types come from
// `documents.server.ts`, which is pure and settled — and the invariant is
// asserted as *these documents are unchanged*: same `_id`, same `seq`, same
// `couponCode`, same `completedAt`, same outcome rows in the same order, each
// row's `outcome`, `memberLabel`, `responseCode`, and `responseMessage`
// included. That is a stronger reading of Requirement 2.6 than a comparison of
// domain records would be, and it holds regardless of how the history store
// reads them back.
//
// The comparison is safe against aliasing: every snapshot is a fresh read of the
// collection, so the "before" documents are separate objects from the "after"
// ones and an in-place edit of a stored row cannot hide inside a shared
// reference.
//
// ## Why removals run to exhaustion
//
// One generated removal would mostly land in the middle of the roster. Each
// sample instead removes every entry one at a time under a generated strategy —
// always the first, always the last, always the middle, or a generated pick — so
// the lowest position, the highest, the interior, and the transition to the
// empty roster are all covered, and the position map and the history are
// re-checked after each step. A removal addressed to an identifier no document
// holds is checked before the loop and again after it, because "deletes exactly
// one Store_Document" also has to mean "deletes none when there is none".
//
// ## Sizes, and the time budget
//
// Every sample bootstraps a Mongo_Store over a throwaway database of its own and
// then runs on the order of forty round trips against it, so the roster is
// capped at four entries and the history at two records: 100 runs of a
// four-entry sample is already several thousand operations. The `fc.assert`
// still runs the full 100 cases; the generous per-test timeout is what pays for
// them, since the 30-second default is a suite-wide figure chosen for in-memory
// properties.

import fc from "fast-check"
import { afterAll, describe, expect, it } from "vitest"

import { MEMBER_OUTCOME_VALUES } from "@/domain/types"
import { createMemberRegistryStore } from "@/server/store/memberRegistry.server"

import {
  closeMongoFixture,
  mongoAvailability,
  mongoSkipReason,
  reportMongoSkip,
  withThrowawayDatabase,
} from "../support/mongoFixture"
import { rosterArb, trimmedCouponCodeArb } from "./generators"

import type { Db, WithId } from "mongodb"
import type {
  HistoryDocumentInput,
  MemberDocumentInput,
} from "@/server/store/documents.server"
import type { MemberRegistryStore } from "@/server/store/memberRegistry.server"
import type { MemberOutcomeValue, MemberRegistryEntry } from "@/domain/types"
import type { MongoSample } from "../support/mongoFixture"

/** Roster ceiling. Small on purpose: every entry is removed, per sample. */
const MAX_ROSTER = 4

/** Redemption_History ceiling per sample, for the same reason. */
const MAX_HISTORY_RECORDS = 2

/** Fixed base instant, so every generated timestamp is deterministic. */
const BASE_TIME = Date.parse("2025-01-04T18:00:00.000Z")

/**
 * How long the property is allowed. Every sample opens a pool, creates the
 * indexes, writes a roster and a history, and drops a database, which the
 * suite-wide 30-second default was never sized for.
 */
const PROPERTY_TIMEOUT_MS = 600_000

/** A plausible response code and message per Member_Outcome. */
const UPSTREAM_BY_OUTCOME: Readonly<
  Record<
    MemberOutcomeValue,
    { readonly responseCode: string; readonly responseMessage: string }
  >
> = Object.freeze({
  SUCCESS: {
    responseCode: "100",
    responseMessage: "The coupon gift has been sent.",
  },
  ALREADY_USED: {
    responseCode: "(H304)",
    responseMessage: "This coupon code has already been used.",
  },
  INVALID_COUPON: {
    responseCode: "(H306)",
    responseMessage: "Invalid coupon code.<br/>Please check again.",
  },
  UPSTREAM_ERROR: {
    responseCode: "(H999)",
    responseMessage: "Unexpected code.",
  },
  TRANSPORT_ERROR: {
    responseCode: "",
    responseMessage: "response body absent",
  },
  /* A skipped Group_Member reached no Upstream_API, so it stored no response. */
  SKIPPED: { responseCode: "", responseMessage: "" },
})

/* -------------------------------------------------------------------------- */
/* Generated input                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One Redemption_History record to seed.
 *
 * `rowMask` and `outcomes` are as long as the roster, so a record either reports
 * an outcome for a roster entry or omits it — which is what a run against a
 * partly disabled roster produced. The mask is weighted towards covering the
 * whole roster, so the entry being removed is usually referenced by every record
 * rather than by a lucky few.
 */
interface HistorySeed {
  readonly couponCode: string
  readonly completedAtOffsetSeconds: number
  readonly mock: boolean
  readonly stoppedEarly: boolean
  readonly rowMask: readonly boolean[]
  readonly outcomes: readonly MemberOutcomeValue[]
}

function historySeedArb(rosterSize: number): fc.Arbitrary<HistorySeed> {
  const maskArb = fc.oneof(
    {
      weight: 3,
      arbitrary: fc.constant(Array.from({ length: rosterSize }, () => true)),
    },
    {
      weight: 1,
      arbitrary: fc.array(fc.boolean(), {
        minLength: rosterSize,
        maxLength: rosterSize,
        size: "max",
      }),
    }
  )

  return fc.record({
    couponCode: trimmedCouponCodeArb,
    /* A narrow range, so records sharing a completion instant occur. */
    completedAtOffsetSeconds: fc.integer({ min: 0, max: 3 }),
    mock: fc.boolean(),
    stoppedEarly: fc.boolean(),
    rowMask: maskArb,
    outcomes: fc.array(fc.constantFrom(...MEMBER_OUTCOME_VALUES), {
      minLength: rosterSize,
      maxLength: rosterSize,
      size: "max",
    }),
  })
}

/** How the removal loop picks its next victim. */
type RemovalStrategy = "first" | "last" | "middle" | "picked"

interface Sample {
  /** Seed values only: the stored entries are whatever `add` returns. */
  readonly roster: readonly MemberRegistryEntry[]
  readonly historySeeds: readonly HistorySeed[]
  readonly strategy: RemovalStrategy
  /** Reduced modulo the current roster size by the `picked` strategy. */
  readonly picks: readonly number[]
}

const sampleArb: fc.Arbitrary<Sample> = rosterArb({
  maxLength: MAX_ROSTER,
}).chain((roster) =>
  fc.record({
    roster: fc.constant(roster),
    historySeeds: fc.array(historySeedArb(roster.length), {
      minLength: 0,
      maxLength: MAX_HISTORY_RECORDS,
      size: "max",
    }),
    strategy: fc.constantFrom<RemovalStrategy>(
      "first",
      "last",
      "middle",
      "picked"
    ),
    picks: fc.array(fc.nat({ max: 999 }), {
      minLength: MAX_ROSTER,
      maxLength: MAX_ROSTER,
      size: "max",
    }),
  })
)

/** The index the strategy removes next. */
function nextIndex(
  strategy: RemovalStrategy,
  size: number,
  pick: number
): number {
  switch (strategy) {
    case "first":
      return 0
    case "last":
      return size - 1
    case "middle":
      return Math.floor(size / 2)
    case "picked":
      return pick % size
  }
}

/* -------------------------------------------------------------------------- */
/* Reading what the collections hold                                          */
/* -------------------------------------------------------------------------- */

/** The `position` of every stored Member_Registry entry, keyed by `entryId`. */
async function readPositions(db: Db): Promise<Map<string, number>> {
  const documents = await db
    .collection<MemberDocumentInput>("members")
    .find(
      {},
      { sort: { position: 1 }, projection: { entryId: 1, position: 1 } }
    )
    .toArray()
  return new Map(
    documents.map((document) => [document.entryId, document.position])
  )
}

/** How many Store_Documents the `members` collection holds. */
function countMembers(db: Db): Promise<number> {
  return db.collection<MemberDocumentInput>("members").countDocuments()
}

/**
 * Every Redemption_History Store_Document, in a fixed order, as the collection
 * holds it — `_id` included, so a re-insert would be caught as readily as an
 * edit. Each call is a fresh read, which is what makes the before/after
 * comparison meaningful.
 */
function readHistory(db: Db): Promise<Array<WithId<HistoryDocumentInput>>> {
  return db
    .collection<HistoryDocumentInput>("history")
    .find({}, { sort: { seq: 1 } })
    .toArray()
}

/** Every stored outcome row that references `hiveId`, in stored order. */
function rowsFor(
  documents: ReadonlyArray<WithId<HistoryDocumentInput>>,
  hiveId: string
): Array<HistoryDocumentInput["outcomes"][number]> {
  return documents.flatMap((document) =>
    document.outcomes.filter((row) => row.hiveId === hiveId)
  )
}

/* -------------------------------------------------------------------------- */
/* Seeding                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Adds the generated roster through the Member_Registry and returns the stored
 * entries in position order. An entry generated disabled is added — `add`
 * always stores an enabled entry — and then switched off, which is the sequence
 * a real roster goes through.
 */
async function seedRoster(
  registry: MemberRegistryStore,
  roster: readonly MemberRegistryEntry[]
): Promise<Array<MemberRegistryEntry>> {
  const stored: Array<MemberRegistryEntry> = []

  for (const seed of roster) {
    const added = await registry.add({
      memberLabel: seed.memberLabel,
      hiveId: seed.hiveId,
    })
    /* The generated roster is trimmed, unique, in range, and below the cap. */
    if (added.kind !== "added") {
      throw new Error(`could not seed a roster entry: ${added.kind}`)
    }

    if (seed.enabled) {
      stored.push(added.entry)
      continue
    }
    const updated = await registry.setEnabled(added.entry.id, false)
    if (updated.kind !== "updated") {
      throw new Error(`could not disable a roster entry: ${updated.kind}`)
    }
    stored.push(updated.entry)
  }

  return stored
}

/**
 * Inserts the generated Redemption_History straight into the collection, with
 * every outcome row referencing a Hive_ID and a Member_Label of the seeded
 * roster.
 */
async function seedHistory(
  db: Db,
  stored: readonly MemberRegistryEntry[],
  seeds: readonly HistorySeed[]
): Promise<void> {
  if (seeds.length === 0) {
    return
  }

  const documents = seeds.map((seed, index): HistoryDocumentInput => {
    const completedAtMs = BASE_TIME + seed.completedAtOffsetSeconds * 1_000
    return {
      runId: `run-${index}`,
      seq: index + 1,
      couponCode: seed.couponCode,
      completedAt: new Date(completedAtMs).toISOString(),
      completedAtMs,
      mock: seed.mock,
      stoppedEarly: seed.stoppedEarly,
      outcomes: stored
        .filter((_entry, at) => seed.rowMask[at])
        .map((entry, at) => {
          const outcome = seed.outcomes[at]
          return {
            hiveId: entry.hiveId,
            memberLabel: entry.memberLabel,
            outcome,
            ...UPSTREAM_BY_OUTCOME[outcome],
          }
        }),
    }
  })

  await db
    .collection<HistoryDocumentInput>("history")
    .insertMany(documents.map((document) => ({ ...document })))
}

/* -------------------------------------------------------------------------- */
/* One sample                                                                 */
/* -------------------------------------------------------------------------- */

/** Builds a Member_Registry over the sample's database with a fixed clock. */
function createRegistry(
  store: Awaited<ReturnType<MongoSample["createStore"]>>
) {
  let nextId = 0
  let clock = BASE_TIME

  return createMemberRegistryStore(store, {
    generateId: () => {
      nextId += 1
      return `entry-${nextId}`
    },
    now: () => {
      clock += 1_000
      return new Date(clock)
    },
  })
}

/** The entries `list()` returned, or a thrown failure. */
async function listEntries(
  registry: MemberRegistryStore
): Promise<ReadonlyArray<MemberRegistryEntry>> {
  const result = await registry.list()
  if (result.kind !== "entries") {
    throw new Error(`the roster read failed: ${result.failure.reason}`)
  }
  return result.entries
}

async function checkSample(sample: MongoSample, generated: Sample) {
  const { roster, historySeeds, strategy, picks } = generated
  const store = await sample.createStore()
  const db = sample.db()
  const registry = createRegistry(store)

  const model = await seedRoster(registry, roster)
  await seedHistory(db, model, historySeeds)

  /* The baseline the whole property is stated against. */
  const positionsAtStart = await readPositions(db)
  const historyAtStart = await readHistory(db)

  expect(await listEntries(registry)).toEqual(model)
  expect(positionsAtStart.size).toBe(model.length)
  expect(historyAtStart).toHaveLength(historySeeds.length)

  /* An absent identifier deletes nothing, and reports absence. */
  expect(await registry.remove("absent-before")).toEqual({ kind: "not-found" })
  expect(await countMembers(db)).toBe(model.length)
  expect(await readPositions(db)).toEqual(positionsAtStart)
  expect(await readHistory(db)).toEqual(historyAtStart)

  const removedHiveIds: Array<string> = []

  for (let step = 0; model.length > 0; step += 1) {
    const index = nextIndex(strategy, model.length, picks[step] ?? 0)
    const target = model[index]
    const listBefore = await listEntries(registry)
    const positionsBefore = await readPositions(db)
    const historyBefore = await readHistory(db)
    const countBefore = await countMembers(db)

    const removed = await registry.remove(target.id)
    if (removed.kind !== "removed") {
      throw new Error(
        `expected ${target.id} to be removed, got ${removed.kind}`
      )
    }
    model.splice(index, 1)
    removedHiveIds.push(target.hiveId)

    /* Exactly one Store_Document went, and it was that entry's. */
    expect(await countMembers(db)).toBe(countBefore - 1)

    /* Every surviving position is the value it already held. */
    const positionsAfter = await readPositions(db)
    expect(positionsAfter.size).toBe(positionsBefore.size - 1)
    for (const [entryId, position] of positionsAfter) {
      expect(position).toBe(positionsBefore.get(entryId))
      expect(position).toBe(positionsAtStart.get(entryId))
    }
    expect(positionsAfter.has(target.id)).toBe(false)

    /* The removed entries are absent from this and every later roster read. */
    const listAfter = await listEntries(registry)
    expect(listAfter).toEqual(
      listBefore.filter((entry) => entry.id !== target.id)
    )
    expect(listAfter).toEqual(model)
    for (const hiveId of removedHiveIds) {
      expect(listAfter.some((entry) => entry.hiveId === hiveId)).toBe(false)
    }

    /* Every Redemption_History Store_Document is exactly as it was. */
    const historyAfter = await readHistory(db)
    expect(historyAfter).toEqual(historyBefore)
    expect(historyAfter).toEqual(historyAtStart)
    /* Stated again for the rows of the Group_Member just deleted. */
    expect(rowsFor(historyAfter, target.hiveId)).toEqual(
      rowsFor(historyAtStart, target.hiveId)
    )
  }

  /* Down to the empty roster, with the history and the counts intact. */
  expect(await listEntries(registry)).toEqual([])
  expect(await countMembers(db)).toBe(0)
  expect(await readPositions(db)).toEqual(new Map())

  /* A second removal of an already-removed identifier deletes nothing. */
  for (const entry of roster) {
    expect(await registry.remove(entry.id)).toEqual({ kind: "not-found" })
  }
  expect(await readHistory(db)).toEqual(historyAtStart)
  expect(await countMembers(db)).toBe(0)
  expect(sample.warnings).toEqual([])
}

/* -------------------------------------------------------------------------- */
/* Property 7                                                                 */
/* -------------------------------------------------------------------------- */

const mongo = await mongoAvailability()

describe.skipIf(!mongo.available)(
  "Property 7: removal preserves the history and every other position",
  () => {
    afterAll(closeMongoFixture)

    it(
      "deletes one Store_Document per removal, keeps every surviving position, and leaves the history untouched",
      async () => {
        await fc.assert(
          fc.asyncProperty(sampleArb, async (generated) => {
            await withThrowawayDatabase(
              (sample) => checkSample(sample, generated),
              { label: "removal" }
            )
          }),
          { numRuns: 100 }
        )
      },
      PROPERTY_TIMEOUT_MS
    )
  }
)

it.runIf(!mongo.available)(
  `skipped, no MongoDB: ${mongoSkipReason(mongo) ?? ""}`,
  () => {
    reportMongoSkip("Property 7 (Requirement 2.6)", mongo)
    expect(mongo.available).toBe(false)
    expect(mongoSkipReason(mongo)).not.toBeNull()
  }
)
