// Feature: shared-coupon-redemption, Property 14: For any sequence of roster
// mutations and Redemption_Run appends, reloading the store from its written
// file yields a Member_Registry holding the same entries in the same order with
// the same Member_Labels, Hive_IDs, and enabled states, and a
// Redemption_History holding at least the 100 most recent records with their
// Coupon_Code, completion timestamp, and Member_Outcomes unchanged.
//
// Validates: Requirements 1.7, 6.5.
//
// ## Why this test does real file I/O
//
// A round trip asserted against an injected flush would only prove that the
// in-memory document survives a copy. Requirement 1.7 is about a restart, so
// every sample here writes through the default `atomicFlush` into a `DATA_FILE`
// inside a fresh `mkdtemp` directory, then builds a SECOND `JsonStore` over the
// same path — the constructor load path is the restart. The repository's
// `./data/store.json` is never touched: no test in this file uses the default
// data file path, and every temporary directory is removed in a `finally`.
//
// ## Why the retention case is split off
//
// The retention rule of Requirement 6.5 only becomes observable past
// `HISTORY_RETENTION_LIMIT` records, and every append is one real atomic write
// (temp file, `fsync`, rename). Appending 200+ records at `numRuns: 100` would
// mean tens of thousands of `fsync` calls and a suite that crawls. So the main
// property runs at `numRuns: 100` over modest sizes (roster 0-8 entries,
// history 0-5 records), and the over-the-limit case runs as a separate property
// at a small `numRuns` where a few hundred writes per sample are affordable.
// Together they cover both halves of the requirement.

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import fc from "fast-check"
import { afterAll, describe, expect, it } from "vitest"

import { MEMBER_OUTCOME_VALUES } from "@/domain/types"
import {
  createJsonStore,
  serializeStoreDocument,
  STORE_VERSION,
} from "@/server/store/jsonStore.server"
import { createMemberRegistryStore } from "@/server/store/memberRegistry.server"
import {
  createHistoryStore,
  HISTORY_RETENTION_LIMIT,
  toHistoryOutcomeRows,
} from "@/server/store/history.server"
import type { JsonStore, StoreLogger } from "@/server/store/jsonStore.server"
import type {
  MemberOutcome,
  MemberOutcomeValue,
  MemberRegistryEntry,
  RedemptionHistoryRecord,
} from "@/domain/types"

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

/** The store logs warnings on a corrupt or unwritable file; none is expected. */
const silentLogger: StoreLogger = { warn: () => undefined }

/* -------------------------------------------------------------------------- */
/* Temporary DATA_FILE handling                                               */
/* -------------------------------------------------------------------------- */

/** Directories still on disk, as a safety net if a sample throws mid-way. */
const liveTempDirs = new Set<string>()

afterAll(async () => {
  await Promise.all(
    [...liveTempDirs].map((dir) => rm(dir, { recursive: true, force: true }))
  )
  liveTempDirs.clear()
})

/**
 * Runs `body` against a `DATA_FILE` inside a fresh temporary directory, then
 * removes that directory. The path is always `<mkdtemp>/store.json`, so nothing
 * outside the OS temporary directory is ever written.
 */
async function withTempDataFile<T>(
  body: (filePath: string) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "scr-round-trip-"))
  liveTempDirs.add(dir)
  try {
    return await body(join(dir, "store.json"))
  } finally {
    liveTempDirs.delete(dir)
    await rm(dir, { recursive: true, force: true })
  }
}

/** A store over `filePath` using the real atomic flush. */
function storeAt(filePath: string): JsonStore {
  return createJsonStore({ dataFilePath: filePath, logger: silentLogger })
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
   * has to survive the round trip too.
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
 * record through the Redemption_History, then waits for the flush chain to
 * drain, so the file on disk holds the final document.
 *
 * `add` always stores an enabled entry, so a disabled sample is followed by a
 * `setEnabled(false)`: that is the sequence a real roster goes through, and it
 * is what Requirement 1.7 has to preserve.
 */
async function applyMutations(
  store: JsonStore,
  roster: readonly MemberRegistryEntry[],
  historySeeds: readonly HistorySeed[]
): Promise<void> {
  const registry = createMemberRegistryStore(store)
  const history = createHistoryStore(store)

  for (const entry of roster) {
    const added = await registry.add({
      memberLabel: entry.memberLabel,
      hiveId: entry.hiveId,
    })
    // The generated roster holds trimmed, unique, in-range values below the
    // cap, so every add is expected to be accepted.
    expect(added.kind).toBe("added")
    if (added.kind === "added" && !entry.enabled) {
      const updated = await registry.setEnabled(added.entry.id, false)
      expect(updated.kind).toBe("updated")
    }
  }

  for (const [index, seed] of historySeeds.entries()) {
    await history.append({
      runId: `run-${index}`,
      couponCode: seed.couponCode,
      completedAt: new Date(
        BASE_TIME + seed.completedAtOffsetSeconds * 1000
      ).toISOString(),
      mock: seed.mock,
      stoppedEarly: seed.stoppedEarly,
      outcomes: toHistoryOutcomeRows(toOutcomes(seed.outcomeSeeds)),
    })
  }

  await store.whenIdle()
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
  it("reloads the roster and the history from the written file unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(
        rosterArb({ maxLength: 8 }),
        fc.array(historySeedArb, { maxLength: 5 }),
        async (roster, historySeeds) => {
          await withTempDataFile(async (filePath) => {
            const written = storeAt(filePath)
            await applyMutations(written, roster, historySeeds)

            const before = written.read()
            const mutationCount =
              roster.length +
              roster.filter((entry) => !entry.enabled).length +
              historySeeds.length

            // The restart: a second store over the same path, loading the file
            // the first one wrote.
            const reloaded = storeAt(filePath)
            const after = reloaded.read()

            /* Requirement 1.7: same entries, same order, same fields. */
            expect(after.members).toHaveLength(before.members.length)
            expect(identityOf(after.members)).toEqual(
              identityOf(before.members)
            )
            expect(identityOf(after.members)).toEqual(identityOf(roster))
            expect(after.members).toEqual(before.members)

            /* Requirement 6.5: the retained records survive as stored. */
            expect(after.history).toEqual(before.history)
            expect(after.history.map((record) => record.seq)).toEqual(
              before.history.map((record) => record.seq)
            )
            expect(after.history.length).toBe(
              Math.min(historySeeds.length, HISTORY_RETENTION_LIMIT)
            )

            /* The document itself round-trips field for field. */
            expect(after.version).toBe(STORE_VERSION)
            expect(after.version).toBe(before.version)
            expect(after.nextHistorySeq).toBe(before.nextHistorySeq)
            expect(serializeStoreDocument(after)).toBe(
              serializeStoreDocument(before)
            )

            // The bytes on disk are exactly the serialized document. Skipped
            // when nothing was mutated, because then no flush ever ran and the
            // file does not exist — an absent DATA_FILE is an empty store.
            if (mutationCount > 0) {
              expect(await readFile(filePath, "utf8")).toBe(
                serializeStoreDocument(before)
              )
            } else {
              expect(after.members).toHaveLength(0)
              expect(after.history).toHaveLength(0)
            }

            /* The Requirement 6.6 read order survives too. */
            const reloadedHistory = createHistoryStore(reloaded)
            expect(reloadedHistory.list()).toEqual(
              createHistoryStore(written).list()
            )

            /*
             * `nextHistorySeq` keeps climbing after the restart. The retained
             * records are snapshotted first: `read()` hands back the live
             * document, so the append below would otherwise show up inside the
             * very array the new `seq` is compared against.
             */
            const retained = [...after.history]
            const ceiling = highestSeq(retained)
            const appended = await reloadedHistory.append({
              runId: "run-after-reload",
              couponCode: "AFTER-RELOAD",
              completedAt: new Date(BASE_TIME + 60_000).toISOString(),
              mock: false,
              stoppedEarly: false,
              outcomes: [],
            })
            expect(appended.record.seq).toBeGreaterThan(ceiling)
            for (const record of retained) {
              expect(appended.record.seq).toBeGreaterThan(record.seq)
            }
            await reloaded.whenIdle()
          })
        }
      ),
      { numRuns: 100 }
    )
  })

  // Split off from the property above on purpose: each append is a real atomic
  // write, so 200+ of them per sample only stays affordable at a small numRuns.
  it("keeps the newest retained records when the history exceeds the limit", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 6 }), async (overflow) => {
        const total = HISTORY_RETENTION_LIMIT + overflow

        await withTempDataFile(async (filePath) => {
          const written = storeAt(filePath)
          const history = createHistoryStore(written)

          for (let index = 0; index < total; index += 1) {
            await history.append({
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
          }
          await written.whenIdle()

          const before = written.read()
          const after = storeAt(filePath).read()

          /* Requirement 6.5: the retained window survives the restart. */
          expect(after.history).toEqual(before.history)
          expect(after.history).toHaveLength(HISTORY_RETENTION_LIMIT)

          // `seq` starts at 1, so the newest 200 carry
          // `total - 199 .. total`, in append order.
          const seqs = after.history.map((record) => record.seq)
          expect(seqs).toEqual(
            Array.from(
              { length: HISTORY_RETENTION_LIMIT },
              (_, offset) => total - HISTORY_RETENTION_LIMIT + 1 + offset
            )
          )

          // The literal requirement: at least the 100 most recent survive.
          const retained = new Set(seqs)
          for (let seq = total - RETENTION_FLOOR + 1; seq <= total; seq += 1) {
            expect(retained.has(seq)).toBe(true)
          }

          // Coupon_Code, completion timestamp, and outcome rows unchanged.
          const newest = after.history[after.history.length - 1]
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

          /* The counter never resets, even though the trim dropped records. */
          expect(after.nextHistorySeq).toBe(before.nextHistorySeq)
          expect(after.nextHistorySeq).toBeGreaterThan(
            highestSeq(after.history)
          )
        })
      }),
      { numRuns: 3 }
    )
  })
})
