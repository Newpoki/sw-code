// Feature: mongodb-google-auth-admin, Property 8: A sequence of history appends assigns strictly increasing counters and retains the newest 200
//
// For any sequence of Redemption_History appends, of any length including
// lengths past 200, interleaved with rebuilds of the Mongo_Store over the same
// database and starting from a database that a Data_Import may already have
// populated, every assigned append counter value is greater than every append
// counter value assigned before it in that database — including values on
// records the retention rule has deleted and values a Data_Import assigned — the
// first append into an empty database is assigned 1, the collection afterwards
// holds exactly the lesser of the number of appends and 200 Store_Documents, the
// retained Store_Documents are exactly those holding the 200 highest assigned
// counter values, every retained record carries the run identifier, Coupon_Code,
// completion timestamp, Mock_Mode state, early-stop state, and outcome rows it
// was appended with, each outcome row holds a response message of at most 500
// characters, and every accepted append returns its outcomes with zero
// persistence warnings.
//
// Validates: Requirements 3.1, 3.2, 3.3, 3.6, 3.12.
//
// ## Why this one runs against a real database
//
// Every clause is a claim about the database rather than about this process. The
// counter is a `findOneAndUpdate` with `$inc` on the `counters` collection, so
// "greater than every value assigned before it, including across a rebuild and
// including values the retention rule has since deleted" is a claim about what
// that document holds — the one quantity a `max(seq) + 1` over the survivors
// would get wrong. The retention window is a count, a sort, and a `deleteMany`.
// And the restart clause of Requirement 3.6 means a second Mongo_Store — its own
// client, its own pool, its own bootstrap — reads only what the first one
// durably wrote.
//
// `tests/support/mongoFixture.ts` gives each sample a throwaway database, and
// `sample.createStore()` builds that second store over it. Every `createStore`
// call in a sample is a rebuild, which is the interleaving this property asks
// for.
//
// ## The model
//
// A plain array of the records the database should hold, ascending by `seq`,
// plus the list of counter values the store handed out, in the order it handed
// them out. The retained set is the model's last 200 entries, because `seq` only
// ever increases and the trim deletes from the lowest up. Comparing the whole
// collection against that array covers the field-retention clause and the
// exactly-which-200 clause at once: a store that trimmed the wrong end, dropped
// an outcome row, or renumbered a survivor would stop equalling it.
//
// The collection is read through the fixture's own driver handle and projected
// into a record here, rather than through `fromHistoryDocument`, so a bug in the
// document mapping cannot cancel out against itself. `HISTORY_RETENTION_LIMIT`
// is imported for sizing rather than hard-coded, and pinned to 200 below so the
// import cannot quietly move the window this property is about.
//
// ## A Data_Import as a starting condition
//
// A sample may begin with records already in the collection and the counter
// already raised to the highest value they hold — which is the state a
// Data_Import hands over (Requirement 4.1). Those are written with the driver,
// not through a store: the store's own import slot is empty in this suite, and
// seeding directly is what lets the first append be checked against `imported +
// 1` rather than against 1.
//
// ## Why the over-the-window case has its own assertion and its own run count
//
// Crossing the retention window costs 200+ appends per sample, and every append
// is a counter round trip, an insert, a count, and past the window a find and a
// delete. The property itself is therefore stated over short sequences at the
// full 100 runs, and the over-the-window case is a second `fc.assert` at a
// pinned low run count — the same split, for the same reason, that
// `tests/property/persistenceRoundTrip.property.test.ts` already uses for the
// retention half of Requirement 6.5 of the other feature. That site is recorded
// in `RUNS_BELOW_MINIMUM` in `tests/unit/propertyCoverage.test.ts`, pinned by
// file and value, so no other low setting can slip in unnoticed.
//
// With no MongoDB configured the suite skips, and the reason is stated as the
// name of a test that does run — the pattern
// `tests/integration/mongoBootstrap.test.ts` established, so a skipped property
// says why in the report rather than passing vacuously.

import fc from "fast-check"
import { afterAll, describe, expect, it } from "vitest"

import { MEMBER_OUTCOME_VALUES } from "@/domain/types"
import {
  HISTORY_RETENTION_LIMIT,
  createHistoryStore,
} from "@/server/store/history.server"

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
  HistoryDocument,
} from "@/server/store/documents.server"
import type {
  AppendHistoryInput,
  HistoryStore,
} from "@/server/store/history.server"
import type { MongoSample } from "../support/mongoFixture"

/**
 * Longest response message a stored outcome row holds (Requirement 3.1).
 * Written out here rather than imported, so this property states the number the
 * requirement states and a change to the store's own constant shows up as a
 * failure.
 */
const MAX_RESPONSE_MESSAGE_CHARS = 500

/* -------------------------------------------------------------------------- */
/* Local arbitraries                                                          */
/* -------------------------------------------------------------------------- */

/** Characters a run identifier and a Coupon_Code are drawn from. */
const CODE_UNITS: ReadonlyArray<string> = Array.from(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"
)

/**
 * Text units a Member_Label and a short response message are assembled from:
 * ASCII, the precomposed and decomposed spellings of an accented character, a
 * standalone combining mark, an astral-plane character (a surrogate pair), and
 * non-Latin scripts including a right-to-left one. A record that survives the
 * round trip has to survive all of them.
 */
const TEXT_UNITS: ReadonlyArray<string> = [
  "a",
  "Q",
  "7",
  " ",
  "-",
  "é",
  "e\u0301",
  "🐝",
  "漢",
  "ب",
]

/**
 * Units a long response message is assembled from: one UTF-16 code unit each,
 * deliberately excluding surrogate pairs. Truncation to 500 characters is a
 * slice by code unit, so a pair straddling the boundary would be cut in half and
 * the stored string would hold a lone surrogate — a property about what MongoDB
 * gives back should not turn into a property about how a lone surrogate encodes.
 */
const SINGLE_UNITS: ReadonlyArray<string> = ["a", "Z", "4", " ", "é", "漢", "ب"]

const runIdArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...CODE_UNITS), { minLength: 1, maxLength: 12 })
  .map((units) => `run-${units.join("")}`)

const couponCodeArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...CODE_UNITS), { minLength: 1, maxLength: 16 })
  .map((units) => units.join(""))

const labelArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...TEXT_UNITS), { minLength: 1, maxLength: 8 })
  .map((units) => units.join(""))

/**
 * Spellings of a completion instant. The two constants name one instant twice —
 * once as `Z`, once as a `+01:00` offset — because Requirement 3.6 asks for the
 * same completion timestamp back, and an ISO string that goes through a `Date`
 * does not come back character for character.
 */
const completedAtArb: fc.Arbitrary<string> = fc.oneof(
  fc
    .integer({
      min: Date.parse("2025-01-01T00:00:00.000Z"),
      max: Date.parse("2025-06-30T23:59:59.000Z"),
    })
    .map((ms) => new Date(ms).toISOString()),
  fc.constantFrom(
    "2025-01-04T18:00:00Z",
    "2025-01-04T19:00:00+01:00",
    "2025-01-04T18:00:00.500+00:00"
  )
)

/** A response message inside the limit: no truncation is expected of it. */
const shortMessageArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...TEXT_UNITS), { maxLength: 12 })
  .map((units) => units.join(""))

/**
 * A response message past the limit, so the first-500-characters clause of
 * Requirement 3.1 is exercised rather than assumed.
 */
const longMessageArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...SINGLE_UNITS), {
    minLength: 260,
    maxLength: 300,
    size: "max",
  })
  .map((units) =>
    units.join("").padEnd(MAX_RESPONSE_MESSAGE_CHARS + 20, "padding")
  )

const outcomeRowArb: fc.Arbitrary<RedemptionHistoryRecord["outcomes"][number]> =
  fc.record({
    hiveId: couponCodeArb,
    memberLabel: labelArb,
    outcome: fc.constantFrom(...MEMBER_OUTCOME_VALUES),
    responseCode: fc.constantFrom("", "0", "1001", "SUCCESS", "429"),
    responseMessage: fc.oneof(
      { weight: 4, arbitrary: shortMessageArb },
      { weight: 1, arbitrary: longMessageArb }
    ),
  })

/**
 * One append, exactly as a completed Redemption_Run submits it: everything but
 * the counter value, which is the store's to assign.
 *
 * Zero outcome rows is a legal record — a run over an empty enabled roster — and
 * three is enough to pin row order. The 100-row cap of Requirement 3.1 is the
 * roster cap's business (Requirement 2.5) and is not re-tested here.
 */
const appendArb: fc.Arbitrary<AppendHistoryInput> = fc.record({
  runId: runIdArb,
  couponCode: couponCodeArb,
  completedAt: completedAtArb,
  mock: fc.boolean(),
  stoppedEarly: fc.boolean(),
  outcomes: fc.array(outcomeRowArb, { maxLength: 3 }),
})

/** One step of a sequence: an append, or a rebuild of the store over the same database. */
type Step =
  | { readonly kind: "append"; readonly plan: AppendHistoryInput }
  | { readonly kind: "rebuild" }

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 4,
    arbitrary: appendArb.map((plan) => ({ kind: "append" as const, plan })),
  },
  { weight: 1, arbitrary: fc.constant({ kind: "rebuild" as const }) }
)

/**
 * A sequence, plus how many records a Data_Import left behind before it. At most
 * six steps, because every append is a round trip to a real deployment; the
 * lengths past 200 are the second assertion's subject.
 */
const sequenceArb = fc
  .record({
    imported: fc.nat({ max: 3 }),
    steps: fc.array(stepArb, { minLength: 1, maxLength: 6 }),
  })
  .filter(({ steps }) => steps.some((step) => step.kind === "append"))

/* -------------------------------------------------------------------------- */
/* The model, and reading the collection under the seam                       */
/* -------------------------------------------------------------------------- */

/** A Store_Document as this test reads it: no mapping module involved. */
function projectDocument(document: HistoryDocument): RedemptionHistoryRecord {
  return {
    runId: document.runId,
    seq: document.seq,
    couponCode: document.couponCode,
    completedAt: document.completedAt,
    mock: document.mock,
    stoppedEarly: document.stoppedEarly,
    outcomes: document.outcomes.map((row) => ({
      hiveId: row.hiveId,
      memberLabel: row.memberLabel,
      outcome: row.outcome,
      responseCode: row.responseCode,
      responseMessage: row.responseMessage,
    })),
  }
}

/** Every Store_Document of the collection, ascending by counter value. */
async function storedRecords(
  sample: MongoSample
): Promise<Array<RedemptionHistoryRecord>> {
  const documents = await sample
    .db()
    .collection<HistoryDocument>("history")
    .find({}, { sort: { seq: 1 } })
    .toArray()
  return documents.map(projectDocument)
}

/**
 * The record an accepted append should return and the collection should hold:
 * the submission, the assigned counter value, and each response message cut to
 * its first 500 characters (Requirement 3.1).
 */
function expectedRecord(
  plan: AppendHistoryInput,
  seq: number
): RedemptionHistoryRecord {
  return {
    runId: plan.runId,
    seq,
    couponCode: plan.couponCode,
    completedAt: plan.completedAt,
    mock: plan.mock,
    stoppedEarly: plan.stoppedEarly,
    outcomes: plan.outcomes.map((row) => ({
      hiveId: row.hiveId,
      memberLabel: row.memberLabel,
      outcome: row.outcome,
      responseCode: row.responseCode,
      responseMessage: row.responseMessage.slice(0, MAX_RESPONSE_MESSAGE_CHARS),
    })),
  }
}

/**
 * What a Data_Import leaves behind: `count` Store_Documents holding counter
 * values 1 through `count`, and the counter document raised to `count`, which is
 * what keeps imported records covered by Requirement 3.2.
 *
 * Written with the driver rather than through a store, because the store's
 * import slot is empty in this suite and because the point is to establish the
 * starting condition, not to test the importer.
 */
async function seedDataImport(
  sample: MongoSample,
  count: number
): Promise<Array<RedemptionHistoryRecord>> {
  if (count === 0) {
    return []
  }

  const base = Date.parse("2024-12-01T08:00:00.000Z")
  const records: Array<RedemptionHistoryRecord> = Array.from(
    { length: count },
    (_, at) => ({
      runId: `imported-run-${at + 1}`,
      seq: at + 1,
      couponCode: `IMPORTED-${at + 1}`,
      completedAt: new Date(base + at * 60_000).toISOString(),
      mock: at % 2 === 0,
      stoppedEarly: false,
      outcomes: [
        {
          hiveId: `imported-hive-${at + 1}`,
          memberLabel: `Imported ${at + 1}`,
          outcome: "SUCCESS" as const,
          responseCode: "0",
          responseMessage: "imported",
        },
      ],
    })
  )

  await sample
    .db()
    .collection<Omit<HistoryDocument, "_id">>("history")
    .insertMany(
      records.map((record) => ({
        runId: record.runId,
        seq: record.seq,
        couponCode: record.couponCode,
        completedAt: record.completedAt,
        completedAtMs: Date.parse(record.completedAt),
        mock: record.mock,
        stoppedEarly: record.stoppedEarly,
        outcomes: record.outcomes.map((row) => ({ ...row })),
      }))
    )
  await sample
    .db()
    .collection<CounterDocument>("counters")
    .insertOne({ _id: "history_seq", value: count })

  return records
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface Harness {
  readonly sample: MongoSample
  /** The Redemption_History in use; replaced by every rebuild. */
  history: HistoryStore
  /** Every counter value assigned in this database, in assignment order. */
  readonly assigned: Array<number>
  /** Every record the database should hold before the trim, ascending by counter value. */
  readonly written: Array<RedemptionHistoryRecord>
}

/** A fresh Mongo_Store over the sample's database, and a history over it. */
async function rebuild(sample: MongoSample): Promise<HistoryStore> {
  return createHistoryStore(await sample.createStore(), {
    logger: sample.logger,
  })
}

/** The records the retention rule keeps: the 200 highest counter values. */
function retained(harness: Harness): Array<RedemptionHistoryRecord> {
  return harness.written.slice(-HISTORY_RETENTION_LIMIT)
}

/** The highest counter value assigned or imported so far; 0 in an empty database. */
function highestSoFar(harness: Harness): number {
  return harness.written.reduce((highest, record) => {
    return Math.max(highest, record.seq)
  }, 0)
}

/** The retained records, or a thrown failure: a read that fails falsifies this property. */
async function listRecords(
  history: HistoryStore
): Promise<Array<RedemptionHistoryRecord>> {
  const result = await history.list(HISTORY_RETENTION_LIMIT)
  if (result.kind !== "records") {
    throw new Error(`the history read failed: ${result.failure.reason}`)
  }
  return [...result.records]
}

function bySeq(
  records: ReadonlyArray<RedemptionHistoryRecord>
): Array<RedemptionHistoryRecord> {
  return [...records].sort((left, right) => left.seq - right.seq)
}

/**
 * Requirement 3.2, as a claim about the whole run of assigned values: strictly
 * increasing, so no value repeats and none goes backwards. Gaps are allowed —
 * the requirement asks for increasing values, not gapless ones.
 */
function expectStrictlyIncreasing(assigned: ReadonlyArray<number>): void {
  for (let at = 1; at < assigned.length; at += 1) {
    expect(assigned[at]).toBeGreaterThan(assigned[at - 1])
  }
}

/**
 * One append, checked against the model as it happens.
 *
 * Requirement 3.12 is the absence of a field as much as the presence of a
 * record: a `kind` of `appended` *means* the Store_Document is in the database,
 * so there is no `persisted` flag and nothing to warn about.
 */
async function applyAppend(
  harness: Harness,
  plan: AppendHistoryInput
): Promise<void> {
  const highestBefore = highestSoFar(harness)
  const startedEmpty = harness.written.length === 0

  const result = await harness.history.append(plan)
  if (result.kind !== "appended") {
    throw new Error(
      `expected the append of ${JSON.stringify(plan.runId)} to be accepted, got ${result.kind} (${result.failure.reason})`
    )
  }

  // Requirement 3.2: greater than every value assigned before it in this
  // database, and 1 for the first append into an empty one.
  expect(result.record.seq).toBeGreaterThan(highestBefore)
  if (startedEmpty) {
    expect(result.record.seq).toBe(1)
  }

  // Requirements 3.1, 3.12: the submission back, truncated where it was too
  // long, with nothing resembling a persistence warning beside it.
  expect(result.record).toEqual(expectedRecord(plan, result.record.seq))
  expect(result).not.toHaveProperty("persisted")
  expect(result).not.toHaveProperty("warning")
  expect(harness.sample.warnings).toEqual([])
  for (const row of result.record.outcomes) {
    expect(row.responseMessage.length).toBeLessThanOrEqual(
      MAX_RESPONSE_MESSAGE_CHARS
    )
  }

  harness.assigned.push(result.record.seq)
  harness.written.push(expectedRecord(plan, result.record.seq))
}

/**
 * Requirements 3.3, 3.6: the collection holds the lesser of the appends and 200
 * Store_Documents, and they are exactly the ones holding the highest counter
 * values, field for field.
 */
async function assertCollection(harness: Harness): Promise<void> {
  const stored = await storedRecords(harness.sample)

  expect(stored.length).toBe(
    Math.min(harness.written.length, HISTORY_RETENTION_LIMIT)
  )
  expect(stored).toEqual(retained(harness))
  expectStrictlyIncreasing(harness.assigned)
  expect(harness.sample.warnings).toEqual([])
}

/* -------------------------------------------------------------------------- */
/* The property                                                               */
/* -------------------------------------------------------------------------- */

const mongo = await mongoAvailability()

/** Ten minutes: 100 samples, each a database created, written, read, dropped. */
const PROPERTY_TIMEOUT_MS = 600_000

/** Twenty: a handful of samples, each of them 200+ appends against a deployment. */
const OVER_WINDOW_TIMEOUT_MS = 1_200_000

/**
 * How far past the window the second assertion goes. Small on purpose: one
 * Store_Document over the limit already exercises the trim, and each further one
 * costs another append.
 */
const overWindowArb = fc.record({
  imported: fc.nat({ max: 2 }),
  extra: fc.integer({ min: 1, max: 3 }),
  template: appendArb,
})

it("pins the retention window at 200 records", () => {
  // Requirement 3.3. The loop sizes below are derived from this constant, so the
  // property would still pass against a different window; this is what stops it.
  expect(HISTORY_RETENTION_LIMIT).toBe(200)
})

describe.skipIf(!mongo.available)(
  "Property 8: a sequence of history appends assigns strictly increasing counters and retains the newest 200",
  () => {
    afterAll(closeMongoFixture)

    it(
      "assigns increasing counter values across rebuilds and serves every appended record back",
      async () => {
        await fc.assert(
          fc.asyncProperty(sequenceArb, async ({ imported, steps }) => {
            await withThrowawayDatabase(
              async (sample) => {
                const seeded = await seedDataImport(sample, imported)
                const harness: Harness = {
                  sample,
                  history: await rebuild(sample),
                  assigned: [],
                  written: [...seeded],
                }

                for (const step of steps) {
                  if (step.kind === "rebuild") {
                    /* A rebuild is its own client, its own pool, and its own
                     * bootstrap over the same database — the interleaving this
                     * property quantifies over. */
                    harness.history = await rebuild(sample)
                    continue
                  }
                  await applyAppend(harness, step.plan)
                  await assertCollection(harness)
                }

                /*
                 * Requirement 3.6, the restart: a history over a fresh
                 * Mongo_Store serves every retained record, each with the same
                 * counter value, Coupon_Code, completion timestamp, Mock_Mode
                 * state, early-stop state, and outcome rows in the same order.
                 * Sorted by counter value before comparing, because the read
                 * order itself is Property 9's subject, not this one's.
                 */
                const restarted = await rebuild(sample)
                expect(bySeq(await listRecords(restarted))).toEqual(
                  retained(harness)
                )

                /*
                 * Requirement 3.2 across the restart: the counter did not reset
                 * and was not rebuilt from the survivors.
                 */
                const highest = highestSoFar(harness)
                harness.history = restarted
                await applyAppend(harness, {
                  runId: "run-after-restart",
                  couponCode: "AFTER-RESTART",
                  completedAt: "2025-07-01T12:00:00.000Z",
                  mock: false,
                  stoppedEarly: false,
                  outcomes: [],
                })
                expect(
                  harness.assigned[harness.assigned.length - 1]
                ).toBeGreaterThan(highest)
                await assertCollection(harness)
              },
              { label: "history-seq" }
            )
          }),
          { numRuns: 100 }
        )
      },
      PROPERTY_TIMEOUT_MS
    )

    it(
      "keeps exactly the 200 highest counter values once the window is crossed",
      async () => {
        await fc.assert(
          fc.asyncProperty(
            overWindowArb,
            async ({ imported, extra, template }) => {
              await withThrowawayDatabase(
                async (sample) => {
                  const seeded = await seedDataImport(sample, imported)
                  const harness: Harness = {
                    sample,
                    history: await rebuild(sample),
                    assigned: [],
                    written: [...seeded],
                  }

                  const appends = HISTORY_RETENTION_LIMIT + extra - imported
                  for (let at = 0; at < appends; at += 1) {
                    /*
                     * The collection-wide read stays out of this loop: each
                     * append is already several round trips, and the clauses
                     * about the collection are settled once, below.
                     */
                    await applyAppend(harness, {
                      ...template,
                      runId: `${template.runId}-${at}`,
                      couponCode: `${template.couponCode}-${at}`,
                    })

                    /* One rebuild, exactly as the window fills, so the counter
                     * is asked to keep increasing by a store that never saw the
                     * records the trim is about to delete. */
                    if (harness.written.length === HISTORY_RETENTION_LIMIT) {
                      harness.history = await rebuild(sample)
                    }
                  }

                  // Requirement 3.3: the window is full and no wider.
                  const stored = await storedRecords(harness.sample)
                  expect(stored.length).toBe(HISTORY_RETENTION_LIMIT)
                  expect(stored).toEqual(retained(harness))

                  /* Requirement 3.2: the deleted values are gone from the
                   * collection and still count against every later
                   * assignment. */
                  expectStrictlyIncreasing(harness.assigned)
                  expect(harness.assigned[0]).toBe(imported + 1)
                  expect(stored[0].seq).toBeGreaterThan(extra)

                  // Requirements 3.6, 3.12.
                  const restarted = await rebuild(sample)
                  expect(bySeq(await listRecords(restarted))).toEqual(
                    retained(harness)
                  )
                  expect(sample.warnings).toEqual([])
                },
                { label: "history-window" }
              )
            }
          ),
          { numRuns: 3 }
        )
      },
      OVER_WINDOW_TIMEOUT_MS
    )
  }
)

it.runIf(!mongo.available)(
  `skipped, no MongoDB: ${mongoSkipReason(mongo) ?? ""}`,
  () => {
    reportMongoSkip("Property 8 history append sequences", mongo)
    expect(mongo.available).toBe(false)
    expect(mongoSkipReason(mongo)).not.toBeNull()
  }
)
