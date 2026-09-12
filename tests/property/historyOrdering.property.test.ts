// Feature: shared-coupon-redemption, Property 16: History ordering is total and
// stable — For any set of Redemption_History records, the history view orders
// them from the most recent completion timestamp to the oldest, and orders
// records sharing a completion timestamp from the most recently appended to the
// least recently appended.
//
// Validates: Requirements 6.6.
//
// ## How the ordering rule is stated here
//
// The store's own comparator is module-private and is deliberately not reused:
// re-sorting `list()` with it would only prove that sorting twice is
// idempotent. Instead every assertion below states the rule from scratch —
// adjacent pairs of the returned sequence must be non-increasing by instant,
// and must be strictly decreasing by `seq` whenever two records land on the
// same instant. `Date.parse` is used for the comparison because Requirement 6.6
// speaks of a completion timestamp, not of its spelling: the generator emits
// both `...Z` and `...+01:00` renderings of the same moment, so records that are
// textually different but simultaneous fall to the `seq` tie-break.
//
// ## Why no file is written
//
// Ordering is a pure read over the in-memory document, so every sample injects
// a resolving flush and a `DATA_FILE` path that is never created. Nothing here
// touches the repository's `./data/store.json`, and the durable round trip is
// covered by `persistenceRoundTrip.property.test.ts` instead.
//
// ## A note on `list(-3)`
//
// `HistoryStore.list` short-circuits only on `undefined` and non-finite limits;
// a negative finite limit is clamped to zero and floors into an empty slice.
// Requirement 6.6 says nothing about a negative limit and no caller passes one,
// so this test is what defines the contract, and the doc comment on `list` was
// corrected in task 16.1 to state exactly this behaviour.

import { tmpdir } from "node:os"
import { join } from "node:path"

import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { MEMBER_OUTCOME_VALUES } from "@/domain/types"
import { createJsonStore } from "@/server/store/jsonStore.server"
import {
  createHistoryStore,
  toHistoryOutcomeRows,
} from "@/server/store/history.server"
import type { JsonStore, StoreLogger } from "@/server/store/jsonStore.server"
import type { HistoryStore } from "@/server/store/history.server"
import type { MemberOutcome, RedemptionHistoryRecord } from "@/domain/types"

import {
  trimmedCouponCodeArb,
  trimmedHiveIdArb,
  trimmedMemberLabelArb,
} from "./generators"

/** Fixed base instant, so generated `completedAt` values are deterministic. */
const BASE_TIME = Date.parse("2025-01-04T18:00:00.000Z")

/** Kept well under `HISTORY_RETENTION_LIMIT`, so no sample is ever trimmed. */
const MAX_APPENDS = 25

/** No warning is expected: the injected flush resolves and no file is read. */
const silentLogger: StoreLogger = { warn: () => undefined }

let storeCounter = 0

/**
 * A store whose flush resolves without touching the filesystem, over a
 * `DATA_FILE` path that is unique per store and never created — so the load
 * path starts from an empty document every time.
 */
function emptyStore(): JsonStore {
  storeCounter += 1
  return createJsonStore({
    dataFilePath: join(
      tmpdir(),
      `scr-history-ordering-${process.pid}-${storeCounter}.unused.json`
    ),
    flush: () => Promise.resolve(),
    logger: silentLogger,
  })
}

/* -------------------------------------------------------------------------- */
/* Generated appends                                                          */
/* -------------------------------------------------------------------------- */

/**
 * How a generated `completedAt` is rendered. Both spellings of the same offset
 * denote the same instant, which is what makes the `seq` tie-break observable
 * on records whose timestamp text differs.
 */
type TimestampSpelling = "utc" | "plus-one"

interface AppendSeed {
  /**
   * Seconds added to {@link BASE_TIME}. Drawn from a deliberately narrow set so
   * duplicates are common, and generated per append rather than per position so
   * an append routinely carries an OLDER timestamp than a record appended
   * before it.
   */
  readonly offsetSeconds: number
  readonly spelling: TimestampSpelling
  /** True when this append reuses the sample's shared Coupon_Code. */
  readonly useSharedCode: boolean
  readonly ownCouponCode: string
  readonly mock: boolean
  readonly stoppedEarly: boolean
  readonly outcomeSeeds: ReadonlyArray<{
    readonly hiveId: string
    readonly memberLabel: string
    readonly outcome: (typeof MEMBER_OUTCOME_VALUES)[number]
  }>
}

const offsetSecondsArb: fc.Arbitrary<number> = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(0, 1, 2, 3) },
  { weight: 1, arbitrary: fc.constantFrom(-86_400, -60, 3_600, 604_800) }
)

const appendSeedArb: fc.Arbitrary<AppendSeed> = fc.record({
  offsetSeconds: offsetSecondsArb,
  spelling: fc.constantFrom<TimestampSpelling>("utc", "plus-one"),
  useSharedCode: fc.oneof(
    { weight: 3, arbitrary: fc.constant(true) },
    { weight: 2, arbitrary: fc.constant(false) }
  ),
  ownCouponCode: trimmedCouponCodeArb,
  mock: fc.boolean(),
  stoppedEarly: fc.boolean(),
  outcomeSeeds: fc.array(
    fc.record({
      hiveId: trimmedHiveIdArb,
      memberLabel: trimmedMemberLabelArb,
      outcome: fc.constantFrom(...MEMBER_OUTCOME_VALUES),
    }),
    { maxLength: 2 }
  ),
})

/** The same instant, rendered either as UTC or with a `+01:00` offset. */
function completedAtOf(seed: AppendSeed): string {
  const instant = new Date(BASE_TIME + seed.offsetSeconds * 1000)
  if (seed.spelling === "utc") {
    return instant.toISOString()
  }
  const shifted = new Date(instant.getTime() + 3_600_000)
  return `${shifted.toISOString().slice(0, -1)}+01:00`
}

/** Outcome rows built through the denormalization the RunCoordinator uses. */
function outcomeRowsOf(seed: AppendSeed) {
  const outcomes: Array<MemberOutcome> = seed.outcomeSeeds.map(
    (row, position) =>
      row.outcome === "SKIPPED"
        ? {
            hiveId: row.hiveId,
            memberLabel: row.memberLabel,
            position,
            outcome: "SKIPPED",
            upstreamResult: null,
          }
        : {
            hiveId: row.hiveId,
            memberLabel: row.memberLabel,
            position,
            outcome: row.outcome,
            upstreamResult: {
              responseCode: "100",
              responseMessage: "The coupon gift has been sent.",
              outcome: row.outcome,
            },
          }
  )
  return toHistoryOutcomeRows(outcomes)
}

/**
 * Appends every seed in order and returns the assigned `seq` values in append
 * order, so the monotonicity of the counter can be asserted against the order
 * the appends actually happened in.
 */
async function appendAll(
  history: HistoryStore,
  seeds: ReadonlyArray<AppendSeed>,
  sharedCouponCode: string
): Promise<Array<number>> {
  const seqs: Array<number> = []
  for (const [index, seed] of seeds.entries()) {
    const { persisted, record } = await history.append({
      runId: `run-${index}`,
      couponCode: seed.useSharedCode ? sharedCouponCode : seed.ownCouponCode,
      completedAt: completedAtOf(seed),
      mock: seed.mock,
      stoppedEarly: seed.stoppedEarly,
      outcomes: outcomeRowsOf(seed),
    })
    // The injected flush resolves, so every append is durable.
    expect(persisted).toBe(true)
    seqs.push(record.seq)
  }
  return seqs
}

/* -------------------------------------------------------------------------- */
/* The ordering rule, restated                                                */
/* -------------------------------------------------------------------------- */

function instantOf(record: RedemptionHistoryRecord): number {
  const parsed = Date.parse(record.completedAt)
  // Every generated timestamp is a parseable instant; a NaN here would make the
  // comparisons below meaningless, so it is asserted rather than tolerated.
  expect(Number.isNaN(parsed)).toBe(false)
  return parsed
}

/**
 * Requirement 6.6, stated over adjacent pairs: never older-before-newer, and
 * never lower-`seq`-before-higher-`seq` at the same instant. Also checks that
 * the ordering is TOTAL — no two records compare as equal, because `seq` is
 * unique across the retained window.
 */
function expectRequirement66Order(
  records: ReadonlyArray<RedemptionHistoryRecord>
): void {
  const seqs = records.map((record) => record.seq)
  expect(new Set(seqs).size).toBe(seqs.length)

  for (let index = 0; index + 1 < records.length; index += 1) {
    const earlier = records[index]
    const later = records[index + 1]
    const earlierInstant = instantOf(earlier)
    const laterInstant = instantOf(later)

    if (earlierInstant === laterInstant) {
      // Same completion timestamp: most recently appended first.
      expect(earlier.seq).toBeGreaterThan(later.seq)
    } else {
      // Otherwise: most recent completion timestamp first.
      expect(earlierInstant).toBeGreaterThan(laterInstant)
    }
  }
}

/** Within every group of simultaneous records, `seq` strictly decreases. */
function expectSeqDescendingWithinInstants(
  records: ReadonlyArray<RedemptionHistoryRecord>
): void {
  const groups = new Map<number, Array<number>>()
  for (const record of records) {
    const instant = instantOf(record)
    const group = groups.get(instant) ?? []
    group.push(record.seq)
    groups.set(instant, group)
  }
  for (const group of groups.values()) {
    for (let index = 0; index + 1 < group.length; index += 1) {
      expect(group[index]).toBeGreaterThan(group[index + 1])
    }
  }
}

/**
 * The newest record holding exactly `couponCode`, found without sorting: a
 * single pass keeping the record with the greatest instant, breaking ties on
 * the greater `seq`. Independent of the store's ordering implementation.
 */
function latestFor(
  records: ReadonlyArray<RedemptionHistoryRecord>,
  couponCode: string
): RedemptionHistoryRecord | null {
  let best: RedemptionHistoryRecord | null = null
  for (const record of records) {
    if (record.couponCode !== couponCode) continue
    if (best === null) {
      best = record
      continue
    }
    const bestInstant = instantOf(best)
    const instant = instantOf(record)
    if (instant > bestInstant) {
      best = record
    } else if (instant === bestInstant && record.seq > best.seq) {
      best = record
    }
  }
  return best
}

/**
 * A Coupon_Code no generator can produce: `trimmedCouponCodeArb` builds its
 * values from non-whitespace units only, so anything holding a space is
 * guaranteed absent from the history.
 */
const ABSENT_COUPON_CODE = "NO SUCH COUPON CODE"

/** The same code in the other letter case, or null when case makes no difference. */
function caseVariantOf(couponCode: string): string | null {
  const upper = couponCode.toUpperCase()
  if (upper !== couponCode) return upper
  const lower = couponCode.toLowerCase()
  return lower === couponCode ? null : lower
}

/* -------------------------------------------------------------------------- */
/* Property 16                                                                */
/* -------------------------------------------------------------------------- */

describe("Property 16: history ordering is total and stable", () => {
  it("orders every read by completion timestamp then append order, and caps after ordering", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(appendSeedArb, { minLength: 0, maxLength: MAX_APPENDS }),
        trimmedCouponCodeArb,
        fc.nat({ max: MAX_APPENDS + 3 }),
        async (seeds, sharedCouponCode, limit) => {
          const store = emptyStore()
          const history = createHistoryStore(store)
          const appendedSeqs = await appendAll(history, seeds, sharedCouponCode)

          /* `seq` climbs with every append and is never reused. */
          expect(new Set(appendedSeqs).size).toBe(appendedSeqs.length)
          for (let index = 0; index + 1 < appendedSeqs.length; index += 1) {
            expect(appendedSeqs[index + 1]).toBeGreaterThan(appendedSeqs[index])
          }

          const records = history.list()

          /* Totality: nothing is dropped and nothing is duplicated. */
          expect(records).toHaveLength(seeds.length)
          const ascending = (left: number, right: number) => left - right
          expect(records.map((record) => record.seq).sort(ascending)).toEqual(
            [...appendedSeqs].sort(ascending)
          )

          /* Requirement 6.6 itself. */
          expectRequirement66Order(records)
          expectSeqDescendingWithinInstants(records)

          /* Stability: the same document reads back the same sequence. */
          expect(history.list()).toEqual(records)
          expect(createHistoryStore(store).list()).toEqual(records)

          /* The cap is applied AFTER ordering, so the newest survive it. */
          expect(history.list(limit)).toEqual(records.slice(0, limit))
          expect(history.list(0)).toEqual([])
          expect(history.list(records.length + 1)).toEqual(records)
          expect(history.list(undefined)).toEqual(records)

          /* A fractional limit is floored. */
          expect(history.list(2.7)).toEqual(records.slice(0, 2))
          expect(history.list(0.9)).toEqual([])

          /* Non-finite limits return everything. */
          expect(history.list(Number.POSITIVE_INFINITY)).toEqual(records)
          expect(history.list(Number.NEGATIVE_INFINITY)).toEqual(records)
          expect(history.list(Number.NaN)).toEqual(records)

          // A negative finite limit is clamped to zero and floors into an empty
          // slice. See the note at the top of this file: Requirement 6.6 is
          // silent on the case, so this assertion is the contract.
          expect(history.list(-3)).toEqual([])

          await store.whenIdle()
        }
      ),
      { numRuns: 100 }
    )
  })

  it("returns the newest record holding exactly the submitted Coupon_Code", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Every seed reuses the shared code, so several records share one
        // Coupon_Code with differing timestamps and `seq` values and "latest"
        // is a real choice rather than the only candidate.
        fc.array(
          appendSeedArb.map((seed) => ({ ...seed, useSharedCode: true })),
          { minLength: 1, maxLength: 8 }
        ),
        trimmedCouponCodeArb,
        async (seeds, sharedCouponCode) => {
          const store = emptyStore()
          const history = createHistoryStore(store)
          await appendAll(history, seeds, sharedCouponCode)

          const records = history.list()
          expectRequirement66Order(records)

          /* The latest match, and the first match of the ordering, agree. */
          const found = history.findLatestByCouponCode(sharedCouponCode)
          expect(found).toEqual(latestFor(records, sharedCouponCode))
          expect(found).toEqual(
            records.find((record) => record.couponCode === sharedCouponCode)
          )
          expect(found?.couponCode).toBe(sharedCouponCode)

          /* No match: null, not a near miss. */
          expect(history.findLatestByCouponCode(ABSENT_COUPON_CODE)).toBeNull()

          /* Surrounding whitespace is not trimmed away before comparing. */
          expect(
            history.findLatestByCouponCode(` ${sharedCouponCode} `)
          ).toBeNull()
          expect(
            history.findLatestByCouponCode(`${sharedCouponCode}\n`)
          ).toBeNull()

          /* Letter case is compared, not folded. */
          const variant = caseVariantOf(sharedCouponCode)
          if (variant !== null) {
            expect(history.findLatestByCouponCode(variant)).toBeNull()
          }

          await store.whenIdle()
        }
      ),
      { numRuns: 100 }
    )
  })
})
