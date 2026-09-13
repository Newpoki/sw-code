// Feature: shared-coupon-redemption, Property 14: For any sequence of roster
// mutations and Redemption_Run appends, reloading the store from its written
// file yields a Member_Registry holding the same entries in the same order with
// the same Member_Labels, Hive_IDs, and enabled states, and a
// Redemption_History holding at least the 100 most recent records with their
// Coupon_Code, completion timestamp, and Member_Outcomes unchanged.
//
// Validates: Requirements 1.7, 6.5.
//
// ## What "reloading the store" means now
//
// There is no `DATA_FILE` behind a request path any more. Requirement 1.7 of
// `shared-coupon-redemption` is superseded by Requirements 2.3 and 3.6 of
// `mongodb-google-auth-admin`: after a restart the Redemption_Server serves the
// roster and the Redemption_History the collections hold, because neither store
// module keeps state of its own. So the restart modelled here is a **second
// store over the same collections** — write through the first, read through the
// second — which is what `createInMemoryBackingStore` is for.
//
// That is a weaker claim than the old one and deliberately so. It shows the two
// store modules hold nothing per instance, not that a deployment durably wrote
// anything. The durability half belongs to a deployment and stays with
// `tests/support/mongoFixture.ts` and `tests/integration/mongoBootstrap.test.ts`,
// which skip when none is configured. Nothing about the round trip is asserted
// against a serialized document, because the document a collection holds is not
// a file this suite can read back.
//
// ## Why both halves now run at the full run count
//
// The retention half used to be pinned in `RUNS_BELOW_MINIMUM` at `numRuns: 3`,
// because it crosses `HISTORY_RETENTION_LIMIT` records and every append was one
// real atomic write — a temp file, an `fsync`, a rename — which measured at
// roughly 850ms per sample. Over the in-memory store an append is a counter
// bump, an insert, a count, and past the window a find and a delete, all against
// arrays. The reason for the exception is gone, so the pin was deleted along
// with it and both properties run at `numRuns: 100`.

import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { MEMBER_OUTCOME_VALUES } from "@/domain/types"
import { createMemberRegistryStore } from "@/server/store/memberRegistry.server"
import type { MemberRegistryStore } from "@/server/store/memberRegistry.server"
import {
  createHistoryStore,
  HISTORY_RETENTION_LIMIT,
  toHistoryOutcomeRows,
} from "@/server/store/history.server"
import type { HistoryStore } from "@/server/store/history.server"
import type {
  MemberOutcome,
  MemberOutcomeValue,
  MemberRegistryEntry,
  RedemptionHistoryRecord,
} from "@/domain/types"

import {
  createInMemoryBackingStore,
  createInMemoryMongoStore,
} from "../support/inMemoryMongoStore"
import type { InMemoryBackingStore } from "../support/inMemoryMongoStore"
import {
  rosterArb,
  trimmedCouponCodeArb,
  trimmedHiveIdArb,
  trimmedMemberLabelArb,
} from "./generators"

/** Requirement 6.5 states the floor; the design retains 200. */
const RETENTION_FLOOR = 100

/** Fixed base instant so generated `completedAt` values are deterministic. */
const BASE_TIME = Date.parse("2025-01-04T18:00:00.000Z")

/* -------------------------------------------------------------------------- */
/* The two stores over one set of collections                                  */
/* -------------------------------------------------------------------------- */

interface Stores {
  readonly registry: MemberRegistryStore
  readonly history: HistoryStore
  /** Everything this store logged; expected to stay empty. */
  readonly warnings: readonly string[]
}

/** A Member_Registry and a Redemption_History over `backing`. */
function storesOver(backing: InMemoryBackingStore): Stores {
  const handle = createInMemoryMongoStore({ backing })
  return {
    registry: createMemberRegistryStore(handle.store),
    history: createHistoryStore(handle.store, { logger: handle.logger }),
    warnings: handle.warnings,
  }
}

/** The roster in position order, or a thrown explanation. */
async function rosterOf(
  registry: MemberRegistryStore
): Promise<readonly MemberRegistryEntry[]> {
  const listed = await registry.list()
  if (listed.kind !== "entries") {
    throw new Error(`the roster read reported "${listed.kind}"`)
  }
  return listed.entries
}

/** The retained records in read order, or a thrown explanation. */
async function recordsOf(
  history: HistoryStore,
  limit?: number
): Promise<readonly RedemptionHistoryRecord[]> {
  const listed = await history.list(limit)
  if (listed.kind !== "records") {
    throw new Error(`the history read reported "${listed.kind}"`)
  }
  return listed.records
}

/* -------------------------------------------------------------------------- */
/* Generated Redemption_History records                                       */
/* -------------------------------------------------------------------------- */

/** One denormalized outcome row, generated independently of the roster. */
interface OutcomeSeed {
  readonly hiveId: string
  readonly memberLabel: string
  readonly outcome: MemberOutcomeValue
  readonly responseCode: string
  readonly responseMessage: string
}

const outcomeSeedArb: fc.Arbitrary<OutcomeSeed> = fc.record({
  hiveId: trimmedHiveIdArb,
  memberLabel: trimmedMemberLabelArb,
  outcome: fc.constantFrom(...MEMBER_OUTCOME_VALUES),
  responseCode: fc.constantFrom("100", "(H304)", "(H306)", "(H999)", ""),
  responseMessage: fc.constantFrom(
    "The coupon gift has been sent.",
    "This coupon code has already been used.",
    "Invalid coupon code.<br/>Please check again.",
    ""
  ),
})

/**
 * Member_Outcomes built from the seeds, so the rows go through the same
 * `toHistoryOutcomeRows` denormalization the RunCoordinator uses.
 */
function toOutcomes(seeds: readonly OutcomeSeed[]): MemberOutcome[] {
  return seeds.map((seed, position) =>
    seed.outcome === "SKIPPED"
      ? {
          hiveId: seed.hiveId,
          memberLabel: seed.memberLabel,
          position,
          outcome: "SKIPPED",
          upstreamResult: null,
        }
      : {
          hiveId: seed.hiveId,
          memberLabel: seed.memberLabel,
          position,
          outcome: seed.outcome,
          upstreamResult: {
            responseCode: seed.responseCode,
            responseMessage: seed.responseMessage,
            outcome: seed.outcome,
          },
        }
  )
}

interface HistorySeed {
  readonly couponCode: string
  /**
   * Seconds added to {@link BASE_TIME}. The narrow range deliberately produces
   * records sharing a `completedAt`, so the `seq` tie-break of Requirement 6.6
   * has to survive the restart too.
   */
  readonly completedAtOffsetSeconds: number
  readonly mock: boolean
  readonly stoppedEarly: boolean
  readonly outcomeSeeds: readonly OutcomeSeed[]
}

const historySeedArb: fc.Arbitrary<HistorySeed> = fc.record({
  couponCode: trimmedCouponCodeArb,
  completedAtOffsetSeconds: fc.integer({ min: 0, max: 4 }),
  mock: fc.boolean(),
  stoppedEarly: fc.boolean(),
  outcomeSeeds: fc.array(outcomeSeedArb, { maxLength: 4 }),
})

/* -------------------------------------------------------------------------- */
/* Applying the generated mutations                                           */
/* -------------------------------------------------------------------------- */

/**
 * Adds every roster entry through the Member_Registry and appends every history
 * record through the Redemption_History.
 *
 * `add` always stores an enabled entry, so a disabled sample is followed by a
 * `setEnabled(false)`: that is the sequence a real roster goes through, and it
 * is what the restart has to preserve.
 */
async function applyMutations(
  stores: Stores,
  roster: readonly MemberRegistryEntry[],
  historySeeds: readonly HistorySeed[]
): Promise<void> {
  for (const entry of roster) {
    const added = await stores.registry.add({
      memberLabel: entry.memberLabel,
      hiveId: entry.hiveId,
    })
    // The generated roster holds trimmed, unique, in-range values below the
    // cap, so every add is expected to be accepted.
    expect(added.kind).toBe("added")
    if (added.kind === "added" && !entry.enabled) {
      const updated = await stores.registry.setEnabled(added.entry.id, false)
      expect(updated.kind).toBe("updated")
    }
  }

  for (const [index, seed] of historySeeds.entries()) {
    const appended = await stores.history.append({
      runId: `run-${index}`,
      couponCode: seed.couponCode,
      completedAt: new Date(
        BASE_TIME + seed.completedAtOffsetSeconds * 1000
      ).toISOString(),
      mock: seed.mock,
      stoppedEarly: seed.stoppedEarly,
      outcomes: toHistoryOutcomeRows(toOutcomes(seed.outcomeSeeds)),
    })
    expect(appended.kind).toBe("appended")
  }
}

/** The three fields Requirement 1.7 names, in roster order. */
function identityOf(
  entries: readonly MemberRegistryEntry[]
): Array<{ memberLabel: string; hiveId: string; enabled: boolean }> {
  return entries.map((entry) => ({
    memberLabel: entry.memberLabel,
    hiveId: entry.hiveId,
    enabled: entry.enabled,
  }))
}

function highestSeq(records: readonly RedemptionHistoryRecord[]): number {
  return records.reduce((highest, record) => Math.max(highest, record.seq), 0)
}

/* -------------------------------------------------------------------------- */
/* Property 14                                                                */
/* -------------------------------------------------------------------------- */

describe("Property 14: persistence round trip", () => {
  it("reads the roster and the history back through a second store unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(
        rosterArb({ maxLength: 8 }),
        fc.array(historySeedArb, { maxLength: 5 }),
        async (roster, historySeeds) => {
          const backing = createInMemoryBackingStore()
          const written = storesOver(backing)
          await applyMutations(written, roster, historySeeds)

          const rosterBefore = await rosterOf(written.registry)
          const recordsBefore = await recordsOf(written.history)

          // The restart: a second store over the same collections, holding
          // nothing of the first one's.
          const reloaded = storesOver(backing)
          const rosterAfter = await rosterOf(reloaded.registry)
          const recordsAfter = await recordsOf(reloaded.history)

          /* Requirement 1.7, as Requirement 2.3 restates it: same entries, same
           * order, same fields. */
          expect(rosterAfter).toHaveLength(rosterBefore.length)
          expect(identityOf(rosterAfter)).toEqual(identityOf(rosterBefore))
          expect(identityOf(rosterAfter)).toEqual(identityOf(roster))
          expect(rosterAfter).toEqual(rosterBefore)

          /* Requirement 6.5, as Requirement 3.6 restates it: the retained
           * records read back as stored, in the same Requirement 6.6 order. */
          expect(recordsAfter).toEqual(recordsBefore)
          expect(recordsAfter.map((record) => record.seq)).toEqual(
            recordsBefore.map((record) => record.seq)
          )
          expect(recordsAfter).toHaveLength(
            Math.min(historySeeds.length, HISTORY_RETENTION_LIMIT)
          )

          /* And the collections themselves hold exactly that many documents, so
           * the agreement above is not two stores sharing one wrong answer. */
          expect(backing.members()).toHaveLength(roster.length)
          expect(backing.history()).toHaveLength(historySeeds.length)

          /*
           * The append counter keeps climbing across the restart: it lives in
           * the `counters` collection rather than being rebuilt from the
           * records, so the second store hands out a `seq` above every retained
           * one (Requirement 3.2).
           */
          const ceiling = highestSeq(recordsAfter)
          const appended = await reloaded.history.append({
            runId: "run-after-reload",
            couponCode: "AFTER-RELOAD",
            completedAt: new Date(BASE_TIME + 60_000).toISOString(),
            mock: false,
            stoppedEarly: false,
            outcomes: [],
          })
          expect(appended.kind).toBe("appended")
          if (appended.kind !== "appended") return
          expect(appended.record.seq).toBeGreaterThan(ceiling)
          for (const record of recordsAfter) {
            expect(appended.record.seq).toBeGreaterThan(record.seq)
          }

          /* The same holds for the roster counter: a new entry takes a position
           * above every existing one (Requirement 2.1). */
          if (roster.length < 100) {
            const added = await reloaded.registry.add({
              memberLabel: "After the reload",
              hiveId: "hive-after-reload",
            })
            expect(added.kind).toBe("added")
            expect((await rosterOf(reloaded.registry)).at(-1)?.hiveId).toBe(
              "hive-after-reload"
            )
          }

          expect(written.warnings).toEqual([])
          expect(reloaded.warnings).toEqual([])
        }
      ),
      { numRuns: 100 }
    )
  })

  it("keeps the newest retained records when the history exceeds the limit", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 6 }), async (overflow) => {
        const total = HISTORY_RETENTION_LIMIT + overflow

        const backing = createInMemoryBackingStore()
        const written = storesOver(backing)

        for (let index = 0; index < total; index += 1) {
          const appended = await written.history.append({
            runId: `run-${index}`,
            couponCode: `COUPON-${index}`,
            completedAt: new Date(BASE_TIME + index * 1000).toISOString(),
            mock: index % 2 === 0,
            stoppedEarly: false,
            outcomes: toHistoryOutcomeRows([
              {
                hiveId: `hive-${index}`,
                memberLabel: `Member ${index}`,
                position: 0,
                outcome: "SUCCESS",
                upstreamResult: {
                  responseCode: "100",
                  responseMessage: "The coupon gift has been sent.",
                  outcome: "SUCCESS",
                },
              },
            ]),
          })
          expect(appended.kind).toBe("appended")
        }

        const before = await recordsOf(written.history)
        const reloaded = storesOver(backing)
        const after = await recordsOf(reloaded.history)

        /* Requirement 6.5: the retained window survives the restart. */
        expect(after).toEqual(before)
        expect(after).toHaveLength(HISTORY_RETENTION_LIMIT)
        expect(backing.history()).toHaveLength(HISTORY_RETENTION_LIMIT)

        // `seq` starts at 1, so the newest 200 carry `total - 199 .. total`,
        // newest first in the read order.
        const seqs = after.map((record) => record.seq)
        expect(seqs).toEqual(
          Array.from(
            { length: HISTORY_RETENTION_LIMIT },
            (_, offset) => total - offset
          )
        )

        // The literal requirement: at least the 100 most recent survive.
        const retained = new Set(seqs)
        for (let seq = total - RETENTION_FLOOR + 1; seq <= total; seq += 1) {
          expect(retained.has(seq)).toBe(true)
        }

        // Coupon_Code, completion timestamp, and outcome rows unchanged.
        const newest = after[0]
        expect(newest.seq).toBe(total)
        expect(newest.couponCode).toBe(`COUPON-${total - 1}`)
        expect(newest.completedAt).toBe(
          new Date(BASE_TIME + (total - 1) * 1000).toISOString()
        )
        expect(newest.outcomes).toEqual([
          {
            hiveId: `hive-${total - 1}`,
            memberLabel: `Member ${total - 1}`,
            outcome: "SUCCESS",
            responseCode: "100",
            responseMessage: "The coupon gift has been sent.",
          },
        ])

        /* The counter never resets, even though the trim dropped the records
         * holding the lowest values, and the second store reads the same one. */
        const appended = await reloaded.history.append({
          runId: "run-after-trim",
          couponCode: "COUPON-AFTER-TRIM",
          completedAt: new Date(BASE_TIME + total * 1000).toISOString(),
          mock: false,
          stoppedEarly: false,
          outcomes: [],
        })
        expect(appended.kind).toBe("appended")
        if (appended.kind !== "appended") return
        expect(appended.record.seq).toBe(total + 1)
        expect(backing.history()).toHaveLength(HISTORY_RETENTION_LIMIT)

        expect(written.warnings).toEqual([])
        expect(reloaded.warnings).toEqual([])
      }),
      { numRuns: 100 }
    )
  })
})
