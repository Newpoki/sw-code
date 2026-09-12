/**
 * The early-stop response bound of Requirement 5.7.
 *
 * Requirement 5.7 makes three claims about a Redemption_Run that stops early,
 * and this test is written so that all three have to hold, not just the timer:
 *
 *   1. The run counts as **completed** — the terminal event is `run-completed`,
 *      not `run-failed`, and exactly one Redemption_History record is appended.
 *   2. The result set is **complete** — one Member_Outcome per fixed-list entry,
 *      the reported one at the stopping position and `SKIPPED` for the whole
 *      remainder.
 *   3. It arrives **within 1 second** of the `INVALID_COUPON` Member_Outcome
 *      being derived.
 *
 * The worst case for the bound is the largest roster the Member_Registry allows
 * (100 entries, Requirement 1.11) stopping at the *first* position, because that
 * is when the most work — 99 `SKIPPED` records plus a 100-row history record —
 * sits between the derived `INVALID_COUPON` and the terminal event. So the
 * roster here is 100 enabled Group_Members and the stub answers the first
 * request with the documented `(H306)` body.
 *
 * The remaining 99 scripted answers would all succeed and must never be
 * consumed: `upstream.callCount === 1` is what proves the run stopped rather
 * than raced to a fast finish.
 *
 * ## Why two bounds
 *
 * `expect(elapsedMs).toBeLessThan(1000)` is the requirement, verbatim. On its
 * own it is a poor regression detector: an implementation that degraded from
 * ~1 ms to 900 ms would still pass while being, in practice, broken. So a second
 * and much tighter assertion follows — {@link SANITY_BOUND_MS} — which reflects
 * what the loop actually costs (building 99 in-memory outcome records and
 * writing one history record). A change that pushes the measurement anywhere
 * near the requirement's ceiling fails on the tight bound first, with the
 * measured value in the failure message. The tight bound is a canary; the
 * 1-second bound is the contract.
 *
 * ## Two flush strategies, one loop
 *
 * The coordinator appends the Redemption_History record *before* it yields
 * `run-completed`, so the durable write is inside the measured window. Both
 * halves of that are measured:
 *
 *   - an injected flush that resolves immediately, which keeps the measurement
 *     about the run loop itself, and
 *   - the real {@link atomicFlush} into a temporary directory, which is what a
 *     deployment actually pays (write, `fsync`, `rename`).
 *
 * Both must clear the bound; if they did not, the requirement would only hold
 * for a store nobody runs.
 *
 * `./data/store.json` is never touched: every store here is built over a path
 * inside a `mkdtemp` directory that `afterEach` removes.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { MEMBER_OUTCOME_VALUES } from "@/domain/types"
import type {
  RedemptionHistoryRecord,
  RedemptionRunResult,
  RunEvent,
} from "@/domain/types"
import { createRunCoordinator } from "@/server/run/coordinator.server"
import { createHistoryStore } from "@/server/store/history.server"
import { atomicFlush, createJsonStore } from "@/server/store/jsonStore.server"
import type { FlushFn } from "@/server/store/jsonStore.server"
import { createMemberRegistryStore } from "@/server/store/memberRegistry.server"

import { FIXTURE_BODIES } from "../property/generators"
import {
  StubUpstreamClient,
  respondWithBody,
} from "../support/stubUpstreamClient"

/** The Member_Registry cap of Requirement 1.11: the worst case for the bound. */
const ROSTER_SIZE = 100

/** The bound Requirement 5.7 states, in milliseconds. */
const REQUIRED_BOUND_MS = 1000

/**
 * The regression canary. Building 99 `SKIPPED` records and writing one history
 * record measures around 0.6 ms with an injected flush and around 3 ms with a
 * real `fsync`, so 250 ms absorbs a heavily loaded CI machine while still
 * failing roughly two orders of magnitude before the requirement's ceiling is
 * approached.
 */
const SANITY_BOUND_MS = 250

const COUPON_CODE = "EARLYSTOPBOUND"

/** Directories created by {@link temporaryDataFile}, removed after each test. */
const temporaryDirectories: Array<string> = []

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory === undefined) continue
    await rm(directory, { recursive: true, force: true })
  }
})

/** A `DATA_FILE` path inside a fresh temporary directory. */
async function temporaryDataFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "scr-early-stop-bound-"))
  temporaryDirectories.push(directory)
  return join(directory, "store.json")
}

/** What one measured Redemption_Run produced. */
interface Measured {
  /** Type of the terminal event; `run-completed` for an early stop. */
  readonly terminalType: RunEvent["type"]
  readonly result: RedemptionRunResult
  /**
   * Milliseconds between observing the `INVALID_COUPON` `member-outcome` event
   * and observing the terminal event.
   */
  readonly elapsedMs: number
  /** `useCoupon` calls the run issued. */
  readonly callCount: number
  readonly historyRecords: readonly RedemptionHistoryRecord[]
}

/**
 * Runs the worst-case early stop over a store built with `flush`, and measures
 * the window Requirement 5.7 bounds.
 *
 * The roster is seeded through the Member_Registry itself, so the fixed list the
 * coordinator snapshots is the same `listEnabled()` the application uses. The
 * seeding is fully awaited (and `whenIdle` drains the flush chain), so no
 * roster write is still pending when the measured window opens — the only write
 * inside the window is the run's own history record.
 */
async function measureEarlyStop(flush?: FlushFn): Promise<Measured> {
  const dataFilePath = await temporaryDataFile()
  const store = createJsonStore({
    dataFilePath,
    ...(flush === undefined ? {} : { flush }),
    logger: { warn: () => undefined },
  })

  let nextId = 0
  const registry = createMemberRegistryStore(store, {
    generateId: () => {
      nextId += 1
      return `m-${nextId}`
    },
    now: () => new Date(Date.parse("2025-01-04T18:00:00.000Z")),
  })

  for (let index = 0; index < ROSTER_SIZE; index += 1) {
    const label = String(index + 1).padStart(3, "0")
    const added = await registry.add({
      memberLabel: `Member ${label}`,
      hiveId: `hive-${label}`,
    })
    if (added.kind !== "added") {
      throw new Error(`could not seed roster entry ${label}: ${added.kind}`)
    }
  }
  await store.whenIdle()

  const fixedList = registry.listEnabled()
  if (fixedList.length !== ROSTER_SIZE) {
    throw new Error(
      `expected ${ROSTER_SIZE} enabled Group_Members, got ${fixedList.length}`
    )
  }

  const upstream = new StubUpstreamClient({
    script: [
      // Position 0 stops the run.
      respondWithBody(FIXTURE_BODIES["invalid-coupon-h306.json"]),
      // Positions 1 to 99 would succeed. None of them may be consumed.
      ...Array.from({ length: ROSTER_SIZE - 1 }, () =>
        respondWithBody(FIXTURE_BODIES["success-100.json"])
      ),
    ],
  })

  const history = createHistoryStore(store)
  const coordinator = createRunCoordinator({ registry, history, upstream })

  let invalidCouponAt: number | null = null
  let terminalAt: number | null = null
  let terminal: RunEvent | null = null

  for await (const event of coordinator.start(COUPON_CODE)) {
    if (
      event.type === "member-outcome" &&
      event.outcome.outcome === "INVALID_COUPON"
    ) {
      invalidCouponAt = performance.now()
    }
    if (event.type === "run-completed" || event.type === "run-failed") {
      terminalAt = performance.now()
      terminal = event
    }
  }

  if (invalidCouponAt === null) {
    throw new Error("the run never derived an INVALID_COUPON Member_Outcome")
  }
  // Only a terminal event is ever assigned above, so `terminal` is narrowed to
  // `run-completed | run-failed` here; which of the two it is, is an assertion
  // rather than a precondition (Requirement 5.7 demands the success one).
  if (terminal === null || terminalAt === null) {
    throw new Error("the run produced no terminal event")
  }

  await store.whenIdle()

  return {
    terminalType: terminal.type,
    result: terminal.result,
    elapsedMs: terminalAt - invalidCouponAt,
    callCount: upstream.callCount,
    historyRecords: history.list(),
  }
}

/**
 * Everything Requirement 5.7 claims apart from the timing: a completed run, a
 * complete result set, a stop that really stopped, and one history record.
 */
function expectCompleteEarlyStopResult(measured: Measured): void {
  // An early stop is a success, not a failure.
  expect(measured.terminalType).toBe("run-completed")

  // Exactly one Upstream_API request: the run stopped instead of finishing fast.
  expect(measured.callCount).toBe(1)

  const { result } = measured
  expect(result.stoppedEarly).toBe(true)
  expect(result.couponCode).toBe(COUPON_CODE)
  expect(result.outcomes).toHaveLength(ROSTER_SIZE)

  const [first, ...remainder] = result.outcomes
  expect(first.position).toBe(0)
  expect(first.outcome).toBe("INVALID_COUPON")
  expect(first.upstreamResult).not.toBeNull()

  expect(remainder).toHaveLength(ROSTER_SIZE - 1)
  remainder.forEach((outcome, index) => {
    expect(outcome.position).toBe(index + 1)
    expect(outcome.outcome).toBe("SKIPPED")
    expect(outcome.upstreamResult).toBeNull()
  })

  // All six counts are present, they sum to the fixed-list size, and they say
  // the same thing the outcome list says.
  const total = MEMBER_OUTCOME_VALUES.reduce(
    (sum, value) => sum + result.counts[value],
    0
  )
  expect(total).toBe(ROSTER_SIZE)
  expect(result.counts.INVALID_COUPON).toBe(1)
  expect(result.counts.SKIPPED).toBe(ROSTER_SIZE - 1)

  // One Redemption_History record, holding one row per fixed-list entry.
  expect(measured.historyRecords).toHaveLength(1)
  const [record] = measured.historyRecords
  expect(record.couponCode).toBe(COUPON_CODE)
  expect(record.stoppedEarly).toBe(true)
  expect(record.outcomes).toHaveLength(ROSTER_SIZE)
}

/** Both bounds, with the measurement in the failure message either way. */
function expectWithinBound(elapsedMs: number, label: string): void {
  expect(
    elapsedMs,
    `${label}: ${elapsedMs.toFixed(2)} ms from the derived INVALID_COUPON to the complete result set`
  ).toBeLessThan(REQUIRED_BOUND_MS)
  expect(
    elapsedMs,
    `${label}: ${elapsedMs.toFixed(2)} ms exceeds the ${SANITY_BOUND_MS} ms regression canary, well before the ${REQUIRED_BOUND_MS} ms requirement`
  ).toBeLessThan(SANITY_BOUND_MS)
}

describe("early-stop response bound (Requirement 5.7)", () => {
  it("returns the complete result set as a success within 1 second of the INVALID_COUPON, with the store write injected", async () => {
    const measured = await measureEarlyStop(() => Promise.resolve())

    expectCompleteEarlyStopResult(measured)
    expectWithinBound(measured.elapsedMs, "injected flush")
  })

  it("returns the complete result set as a success within 1 second of the INVALID_COUPON, with the real atomic store write", async () => {
    // The real flush: write the temporary file, `fsync` it, rename it over the
    // data file. A deployment pays this inside the measured window, so the bound
    // has to hold with it too.
    const measured = await measureEarlyStop(atomicFlush)

    expectCompleteEarlyStopResult(measured)
    expectWithinBound(measured.elapsedMs, "real atomic flush")
  })
})
