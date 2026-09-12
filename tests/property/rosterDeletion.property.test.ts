// Feature: shared-coupon-redemption, Property 15: For any Member_Registry and
// any Redemption_History, removing a roster entry leaves every
// Redemption_History record that references the removed Hive_ID present with its
// Member_Outcome, response code, and response message unchanged, and omits that
// entry from every later roster response; and for any Member_Registry, every
// disabled entry is absent from the fixed list of every later Redemption_Run and
// from the enabled count reported for it.
//
// Validates: Requirements 1.5, 1.6.
//
// ## What makes the two halves testable at the store level
//
// Requirement 1.5 is a claim about two collections at once, so the assertion has
// to compare the whole Redemption_History before and after a deletion, not just
// the records that mention the removed Hive_ID. The comparison is made against a
// `structuredClone` of the history taken before the removal: `list()` hands back
// the stored record objects themselves, so a snapshot of references would follow
// any in-place mutation and the deep equality would pass vacuously.
//
// Requirement 1.6 says a disabled entry is absent from the fixed list of every
// later Redemption_Run. The fixed list *is* `listEnabled()` — the RunCoordinator
// snapshots it and reports its length as the total (design: "MemberRegistryStore
// .listEnabled used for the fixed list and the reported total") — so asserting
// against `listEnabled()` asserts against the fixed list and the enabled count
// together, without running a coordinator.
//
// ## Why removals run to exhaustion
//
// A single generated removal would mostly hit the middle of the roster. Each
// sample instead removes every entry one at a time under a generated strategy
// (always the first, always the last, always the middle, or a generated pick),
// so the first, middle, and last positions and the transition to the empty
// roster are all covered, and the history invariant is re-checked after each
// step.
//
// No file is written: the store is built over an unused temporary path with the
// filesystem flush replaced by a resolving stub, so `persisted` is true on every
// mutation and the warning sink stays empty.

import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"

import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { MEMBER_OUTCOME_VALUES } from "@/domain/types"
import { createJsonStore } from "@/server/store/jsonStore.server"
import { createMemberRegistryStore } from "@/server/store/memberRegistry.server"
import {
  createHistoryStore,
  toHistoryOutcomeRows,
} from "@/server/store/history.server"
import type { HistoryStore } from "@/server/store/history.server"
import type { MemberRegistryStore } from "@/server/store/memberRegistry.server"
import type {
  MemberOutcome,
  MemberOutcomeValue,
  MemberRegistryEntry,
  RedemptionHistoryRecord,
} from "@/domain/types"

import { enabledEntries, rosterArb, trimmedCouponCodeArb } from "./generators"

/** Roster size ceiling. Small on purpose: every entry is removed per sample. */
const MAX_ROSTER = 10

/** Fixed base instant so generated `completedAt` values are deterministic. */
const BASE_TIME = Date.parse("2025-01-04T18:00:00.000Z")

/** A plausible response code and message per Member_Outcome. */
const UPSTREAM_BY_OUTCOME: Readonly<
  Record<
    Exclude<MemberOutcomeValue, "SKIPPED">,
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
})

/* -------------------------------------------------------------------------- */
/* Generated input                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One Redemption_History record to append.
 *
 * `rowMask` and `outcomes` are both as long as the roster, so a record either
 * reports an outcome for a roster entry or omits it — which is what a run
 * against a partly disabled roster looks like. The mask is weighted towards
 * covering the whole roster, so the removed entry is usually referenced by every
 * record rather than by a lucky few.
 */
interface HistorySeed {
  readonly couponCode: string
  readonly completedAtOffsetSeconds: number
  readonly mock: boolean
  readonly stoppedEarly: boolean
  readonly rowMask: readonly boolean[]
  readonly outcomes: readonly MemberOutcomeValue[]
}

function historySeedArb(size: number): fc.Arbitrary<HistorySeed> {
  const maskArb = fc.oneof(
    {
      weight: 3,
      arbitrary: fc.constant(Array.from({ length: size }, () => true)),
    },
    {
      weight: 1,
      arbitrary: fc.array(fc.boolean(), {
        minLength: size,
        maxLength: size,
        size: "max",
      }),
    }
  )

  return fc.record({
    couponCode: trimmedCouponCodeArb,
    // A narrow range on purpose: records sharing a `completedAt` exercise the
    // `seq` tie-break of the history ordering while the roster shrinks.
    completedAtOffsetSeconds: fc.integer({ min: 0, max: 3 }),
    mock: fc.boolean(),
    stoppedEarly: fc.boolean(),
    rowMask: maskArb,
    outcomes: fc.array(fc.constantFrom(...MEMBER_OUTCOME_VALUES), {
      minLength: size,
      maxLength: size,
      size: "max",
    }),
  })
}

/** How the removal loop picks its next victim. */
type RemovalStrategy = "first" | "last" | "middle" | "picked"

interface Sample {
  readonly roster: readonly MemberRegistryEntry[]
  readonly historySeeds: readonly HistorySeed[]
  readonly strategy: RemovalStrategy
  /** Reduced modulo the current roster size by the `picked` strategy. */
  readonly picks: readonly number[]
  /** Which entry is toggled to disabled before the removals start. */
  readonly disablePick: number
}

const sampleArb: fc.Arbitrary<Sample> = rosterArb({
  maxLength: MAX_ROSTER,
}).chain((roster) =>
  fc.record({
    roster: fc.constant(roster),
    historySeeds: fc.array(historySeedArb(roster.length), {
      minLength: 0,
      maxLength: 3,
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
    disablePick: fc.nat({ max: 999 }),
  })
)

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface Harness {
  readonly registry: MemberRegistryStore
  readonly history: HistoryStore
  /** Everything the store logged; expected to stay empty. */
  readonly warnings: Array<string>
}

/**
 * A Member_Registry and a Redemption_History over one store that touches no
 * filesystem: the flush resolves immediately and the data file path points at a
 * directory that is never created.
 */
function createHarness(): Harness {
  const warnings: Array<string> = []
  let nextId = 0
  let clock = BASE_TIME

  const store = createJsonStore({
    dataFilePath: join(tmpdir(), `scr-deletion-${randomUUID()}`, "store.json"),
    flush: () => Promise.resolve(),
    logger: {
      warn: (message) => {
        warnings.push(message)
      },
    },
  })

  const registry = createMemberRegistryStore(store, {
    generateId: () => {
      nextId += 1
      return `m-${nextId}`
    },
    now: () => {
      clock += 1000
      return new Date(clock)
    },
  })

  return { registry, history: createHistoryStore(store), warnings }
}

/**
 * Adds the generated roster and returns the stored entries in roster order.
 * A disabled sample is added enabled and then switched off, which is the
 * sequence a real roster goes through (`add` always stores an enabled entry).
 */
async function seedRoster(
  harness: Harness,
  roster: readonly MemberRegistryEntry[]
): Promise<Array<MemberRegistryEntry>> {
  const stored: Array<MemberRegistryEntry> = []

  for (const entry of roster) {
    const added = await harness.registry.add({
      memberLabel: entry.memberLabel,
      hiveId: entry.hiveId,
    })
    // The generated roster is trimmed, unique, in range, and below the cap.
    if (added.kind !== "added") {
      throw new Error(`could not seed ${entry.hiveId}: ${added.kind}`)
    }
    expect(added.persisted).toBe(true)

    if (entry.enabled) {
      stored.push(added.entry)
      continue
    }
    const updated = await harness.registry.setEnabled(added.entry.id, false)
    if (updated.kind !== "updated") {
      throw new Error(`could not disable ${entry.hiveId}: ${updated.kind}`)
    }
    stored.push(updated.entry)
  }

  return stored
}

/** The Member_Outcomes one generated record reports, in roster order. */
function outcomesOf(
  stored: readonly MemberRegistryEntry[],
  seed: HistorySeed
): Array<MemberOutcome> {
  const outcomes: Array<MemberOutcome> = []

  stored.forEach((entry, index) => {
    if (!seed.rowMask[index]) return
    const outcome = seed.outcomes[index]
    const position = outcomes.length

    outcomes.push(
      outcome === "SKIPPED"
        ? {
            hiveId: entry.hiveId,
            memberLabel: entry.memberLabel,
            position,
            outcome: "SKIPPED",
            upstreamResult: null,
          }
        : {
            hiveId: entry.hiveId,
            memberLabel: entry.memberLabel,
            position,
            outcome,
            upstreamResult: { ...UPSTREAM_BY_OUTCOME[outcome], outcome },
          }
    )
  })

  return outcomes
}

/** Appends every generated record, denormalizing the rows as a run would. */
async function seedHistory(
  harness: Harness,
  stored: readonly MemberRegistryEntry[],
  seeds: readonly HistorySeed[]
): Promise<void> {
  for (const [index, seed] of seeds.entries()) {
    const appended = await harness.history.append({
      runId: `run-${index}`,
      couponCode: seed.couponCode,
      completedAt: new Date(
        BASE_TIME + seed.completedAtOffsetSeconds * 1000
      ).toISOString(),
      mock: seed.mock,
      stoppedEarly: seed.stoppedEarly,
      outcomes: toHistoryOutcomeRows(outcomesOf(stored, seed)),
    })
    expect(appended.persisted).toBe(true)
  }
}

/**
 * A detached copy of the whole Redemption_History in its read order.
 *
 * The clone is the point: `list()` returns the stored record objects, so
 * comparing the history against a snapshot of references could not detect an
 * in-place edit of a record or of one of its outcome rows.
 */
function snapshotHistory(harness: Harness): Array<RedemptionHistoryRecord> {
  return structuredClone(harness.history.list())
}

/** How many stored outcome rows reference `hiveId`. */
function rowsFor(
  records: readonly RedemptionHistoryRecord[],
  hiveId: string
): Array<RedemptionHistoryRecord["outcomes"][number]> {
  return records.flatMap((record) =>
    record.outcomes.filter((row) => row.hiveId === hiveId)
  )
}

/**
 * Requirement 1.5, the history half: the retained records are byte-identical to
 * `expected` — same `seq`, same `couponCode`, same `completedAt`, same outcome
 * rows including the rows that reference `removedHiveId` — the record count is
 * unchanged, and every Coupon_Code still resolves through
 * `findLatestByCouponCode`.
 */
function assertHistoryPreserved(
  harness: Harness,
  expected: readonly RedemptionHistoryRecord[],
  removedHiveId: string
): void {
  const after = harness.history.list()

  expect(after).toEqual(expected)
  expect(after).toHaveLength(expected.length)
  expect(after.map((record) => record.seq)).toEqual(
    expected.map((record) => record.seq)
  )
  expect(after.map((record) => record.couponCode)).toEqual(
    expected.map((record) => record.couponCode)
  )
  expect(after.map((record) => record.completedAt)).toEqual(
    expected.map((record) => record.completedAt)
  )

  // The rows of the deleted Group_Member survive with their Member_Outcome,
  // response code, and response message untouched.
  expect(rowsFor(after, removedHiveId)).toEqual(
    rowsFor(expected, removedHiveId)
  )

  // Requirement 6.7 still answers for every retained Coupon_Code.
  for (const record of expected) {
    expect(harness.history.findLatestByCouponCode(record.couponCode)).toEqual(
      expected.find((candidate) => candidate.couponCode === record.couponCode)
    )
  }
}

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
/* Property 15                                                                */
/* -------------------------------------------------------------------------- */

describe("Property 15: roster deletion preserves history, disabled entries are excluded", () => {
  it("removes the entry from every later roster response and leaves the history untouched", async () => {
    await fc.assert(
      fc.asyncProperty(
        sampleArb,
        async ({ roster, historySeeds, strategy, picks, disablePick }) => {
          const harness = createHarness()
          const model = await seedRoster(harness, roster)
          await seedHistory(harness, model, historySeeds)

          /* ---------------------------------------------------------------- */
          /* Requirement 1.6: a disabled entry is not in the fixed list       */
          /* ---------------------------------------------------------------- */

          expect(harness.registry.list()).toEqual(model)
          expect(harness.registry.listEnabled()).toEqual(enabledEntries(model))
          expect(harness.registry.listEnabled()).toHaveLength(
            model.filter((entry) => entry.enabled).length
          )

          if (model.length > 0) {
            const index = disablePick % model.length
            const target = model[index]
            const listBefore = harness.registry.list()
            const enabledBefore = harness.registry.listEnabled()

            const updated = await harness.registry.setEnabled(target.id, false)
            if (updated.kind !== "updated") {
              throw new Error(`could not disable ${target.id}`)
            }
            expect(updated.persisted).toBe(true)
            model[index] = updated.entry

            // Only `enabled` changed, and only for the toggled entry.
            expect(harness.registry.list()).toEqual(
              listBefore.map((entry) =>
                entry.id === target.id ? { ...entry, enabled: false } : entry
              )
            )
            // Exactly that entry left the fixed list; the rest kept their order.
            expect(harness.registry.listEnabled()).toEqual(
              enabledBefore.filter((entry) => entry.id !== target.id)
            )
            // The reported enabled count drops by one when it was enabled.
            expect(harness.registry.listEnabled()).toHaveLength(
              enabledBefore.length - (target.enabled ? 1 : 0)
            )
            expect(
              harness.registry
                .listEnabled()
                .some((entry) => entry.id === target.id)
            ).toBe(false)
          }

          /* ---------------------------------------------------------------- */
          /* An unknown id changes nothing                                   */
          /* ---------------------------------------------------------------- */

          const rosterBeforeUnknown = harness.registry.list()
          const historyBeforeUnknown = snapshotHistory(harness)
          expect(await harness.registry.remove("unknown-before")).toEqual({
            kind: "not-found",
          })
          expect(harness.registry.list()).toEqual(rosterBeforeUnknown)
          expect(harness.history.list()).toEqual(historyBeforeUnknown)

          /* ---------------------------------------------------------------- */
          /* Requirement 1.5: removal by removal, down to the empty roster    */
          /* ---------------------------------------------------------------- */

          for (let step = 0; model.length > 0; step += 1) {
            const index = nextIndex(strategy, model.length, picks[step] ?? 0)
            const target = model[index]
            const listBefore = harness.registry.list()
            const enabledBefore = harness.registry.listEnabled()
            const historyBefore = snapshotHistory(harness)

            const removed = await harness.registry.remove(target.id)

            if (removed.kind !== "removed") {
              throw new Error(
                `expected ${target.id} to be removed, got ${removed.kind}`
              )
            }
            expect(removed.persisted).toBe(true)
            model.splice(index, 1)

            // The entry is gone from every later roster response, and the
            // survivors keep their order: the roster is the pre-removal list
            // with exactly that entry filtered out.
            const list = harness.registry.list()
            expect(list).toEqual(
              listBefore.filter((entry) => entry.id !== target.id)
            )
            expect(list).toEqual(model)
            expect(list).toHaveLength(listBefore.length - 1)
            expect(list.some((entry) => entry.id === target.id)).toBe(false)
            expect(list.some((entry) => entry.hiveId === target.hiveId)).toBe(
              false
            )

            // Requirement 1.6 again: the fixed list of a later Redemption_Run
            // excludes the removed entry and every disabled one.
            const enabled = harness.registry.listEnabled()
            expect(enabled).toEqual(
              enabledBefore.filter((entry) => entry.id !== target.id)
            )
            expect(enabled).toEqual(enabledEntries(model))
            expect(
              enabled.some((entry) => entry.hiveId === target.hiveId)
            ).toBe(false)

            assertHistoryPreserved(harness, historyBefore, target.hiveId)
          }

          expect(harness.registry.list()).toEqual([])
          expect(harness.registry.listEnabled()).toEqual([])

          /* ---------------------------------------------------------------- */
          /* The history survived every removal, and nothing was warned about */
          /* ---------------------------------------------------------------- */

          expect(harness.history.list()).toHaveLength(historySeeds.length)
          expect(harness.history.list()).toEqual(historyBeforeUnknown)
          expect(await harness.registry.remove("unknown-after")).toEqual({
            kind: "not-found",
          })
          expect(harness.history.list()).toEqual(historyBeforeUnknown)
          expect(harness.warnings).toEqual([])
        }
      ),
      { numRuns: 100 }
    )
  })
})
