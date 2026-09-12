/**
 * Property 9 of shared-coupon-redemption: the single-run lock.
 *
 * Requirement 3.9 is a safety claim, so the interesting part of it is not what
 * the rejected request returns but what it fails to do: it must not run, must
 * not touch the Upstream_API, and must not perturb the Redemption_Run that
 * holds the lock. Each `it` below pins one half of that claim.
 *
 * The lock is exercised through the coordinator's real seams — a real
 * Member_Registry, a real Redemption_History, and a `StubUpstreamClient` — and
 * concurrency is made observable rather than hoped for: the stub's `gate` holds
 * one `useCoupon` call open, so a contending `start()` is issued at a moment
 * when the first run is provably mid-flight. The alternative (racing on timing
 * alone) would pass on a coordinator with no lock at all whenever the scheduler
 * happened to serialize the calls.
 *
 * Two mechanics of the coordinator shape these tests:
 *
 * - The body of an async generator is deferred, so `start()` alone runs nothing.
 *   Both the lock acquisition and the `RUN_IN_PROGRESS` rejection surface on the
 *   first `next()`, which is why every assertion here drives `next()` explicitly
 *   instead of trusting `start()` to have done something.
 * - The lock is released in a `finally` covering everything after the
 *   acquisition, so a completed run, a failed run, an empty fixed list, and a
 *   consumer that abandons the generator must all leave the coordinator idle.
 *   Each of those four paths gets its own property, because a lock that leaks on
 *   one of them would leave the application permanently unable to start a run.
 *
 * Identical runs are compared event by event, which needs the two runs to be
 * comparable in the first place: every harness injects a fixed clock and a
 * counting run-id generator, so a `run-started` / `member-outcome` /
 * `run-completed` sequence is a pure function of the roster and the script.
 *
 * No filesystem is touched: the store is built over an unused temporary path
 * with the flush replaced by a resolved promise.
 *
 * Validates: Requirements 3.9
 */

import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"

import fc from "fast-check"
import { describe, expect, it } from "vitest"

import type { MemberRegistryEntry, RunEvent } from "@/domain/types"
import {
  RunStartError,
  createRunCoordinator,
  runInProgressMessage,
} from "@/server/run/coordinator.server"
import type { RunCoordinator } from "@/server/run/coordinator.server"
import { createHistoryStore } from "@/server/store/history.server"
import { createJsonStore } from "@/server/store/jsonStore.server"
import { createMemberRegistryStore } from "@/server/store/memberRegistry.server"

import { StubUpstreamClient, throwOnCall } from "../support/stubUpstreamClient"
import type {
  StubGateContext,
  StubScriptEntry,
} from "../support/stubUpstreamClient"
import { rosterArb, runScenarioArb, trimmedCouponCodeArb } from "./generators"
import type { StubStep } from "./generators"

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Rosters stay small. The claim under test is about the lock, not about roster
 * size — Property 5 covers the 100-entry fixed list — and a short run keeps the
 * five properties below well inside the test timeout.
 */
const MAX_LOCK_ROSTER = 6

/** Fixed clock, so two runs of the same script produce equal timestamps. */
const FIXED_TIME = Date.parse("2025-01-04T18:00:00.000Z")

interface Harness {
  readonly coordinator: RunCoordinator
  readonly upstream: StubUpstreamClient
}

/** Translates a generated {@link StubStep} into a stub script entry. */
function toScriptEntry(step: StubStep): StubScriptEntry {
  if (step.kind === "throw") {
    return throwOnCall(new Error(step.message))
  }
  return { kind: "respond", response: step.response }
}

/**
 * A coordinator over a real Member_Registry and Redemption_History, both backed
 * by a store whose flush resolves without writing a file, plus a stub upstream
 * client replaying `script` behind an optional `gate`.
 *
 * The run id is a counter (`run-1`, `run-2`, ...) and the clock is fixed, so the
 * event stream of a run depends on nothing but the roster and the script. That
 * is what lets the contended run be compared to an uncontended one directly.
 *
 * The roster is seeded through the registry rather than injected, so the fixed
 * list the coordinator snapshots comes from the same `listEnabled()` the
 * application uses.
 */
async function createHarness(
  roster: readonly MemberRegistryEntry[],
  script: readonly StubScriptEntry[],
  gate?: (context: StubGateContext) => Promise<void> | void
): Promise<Harness> {
  const store = createJsonStore({
    dataFilePath: join(
      tmpdir(),
      `scr-single-lock-${randomUUID()}`,
      "store.json"
    ),
    flush: () => Promise.resolve(),
    logger: { warn: () => undefined },
  })

  let nextMemberId = 0
  const registry = createMemberRegistryStore(store, {
    generateId: () => {
      nextMemberId += 1
      return `m-${nextMemberId}`
    },
    now: () => new Date(FIXED_TIME),
  })

  for (const entry of roster) {
    const added = await registry.add({
      memberLabel: entry.memberLabel,
      hiveId: entry.hiveId,
    })
    if (added.kind !== "added") {
      throw new Error(
        `could not seed roster entry ${JSON.stringify(entry.hiveId)}: ${added.kind}`
      )
    }
    if (!entry.enabled) {
      const updated = await registry.setEnabled(added.entry.id, false)
      if (updated.kind !== "updated") {
        throw new Error(
          `could not disable roster entry ${JSON.stringify(entry.hiveId)}: ${updated.kind}`
        )
      }
    }
  }

  let nextRunNumber = 0
  const upstream = new StubUpstreamClient({ script, gate })
  const coordinator = createRunCoordinator({
    registry,
    history: createHistoryStore(store),
    upstream,
    now: () => new Date(FIXED_TIME),
    generateRunId: () => {
      nextRunNumber += 1
      return `run-${nextRunNumber}`
    },
  })

  return { coordinator, upstream }
}

/* -------------------------------------------------------------------------- */
/* Driving generators                                                         */
/* -------------------------------------------------------------------------- */

/** A held `useCoupon` call: the lever that makes "mid-run" a defined moment. */
interface CallHold {
  readonly gate: (context: StubGateContext) => Promise<void> | void
  /** Resolves once the held call has entered the gate. */
  readonly reached: Promise<void>
  readonly release: () => void
}

/**
 * Holds the `useCoupon` call at `callIndex` open until `release()` is called.
 * Every other call passes through untouched, so the run is ordinary apart from
 * one request that stays in flight for as long as the test needs it.
 */
function holdCall(callIndex: number): CallHold {
  let signalReached: () => void = () => undefined
  let signalReleased: () => void = () => undefined
  const reached = new Promise<void>((resolve) => {
    signalReached = resolve
  })
  const released = new Promise<void>((resolve) => {
    signalReleased = resolve
  })

  return {
    reached,
    release: () => signalReleased(),
    gate: (context) => {
      if (context.callIndex !== callIndex) return undefined
      signalReached()
      return released
    },
  }
}

interface DrainedRun {
  readonly events: readonly RunEvent[]
  /** The rejection of a `next()` call, or null when the run produced events. */
  readonly rejection: unknown
}

/** Consumes a run to its end, keeping a pre-flight rejection rather than throwing. */
async function drain(
  generator: AsyncGenerator<RunEvent, void, void>
): Promise<DrainedRun> {
  const events: Array<RunEvent> = []
  try {
    for (
      let next = await generator.next();
      !next.done;
      next = await generator.next()
    ) {
      events.push(next.value)
    }
  } catch (caught) {
    return { events, rejection: caught }
  }
  return { events, rejection: null }
}

/**
 * Asserts a rejection is the Requirement 3.9 rejection: the typed
 * `RUN_IN_PROGRESS` code and the shared message stating a Redemption_Run is in
 * progress.
 */
function assertRunInProgress(rejection: unknown): void {
  if (!(rejection instanceof RunStartError)) {
    throw new Error(
      `expected a RunStartError, got ${String(rejection)} (${typeof rejection})`
    )
  }
  expect(rejection.code).toBe("RUN_IN_PROGRESS")
  expect(rejection.message).toBe(runInProgressMessage())
}

/**
 * Starts a run, takes its first event, and abandons it again. Used to show the
 * lock was released: an admitted run reaches `run-started`, a run rejected by
 * the lock never does.
 */
async function assertNextRunAdmitted(
  coordinator: RunCoordinator,
  couponCode: string,
  expectedRunId: string
): Promise<void> {
  const generator = coordinator.start(couponCode)
  const first = await generator.next()
  if (first.done) {
    throw new Error("expected an admitted run to yield a run-started event")
  }
  expect(first.value.type).toBe("run-started")
  expect(first.value.runId).toBe(expectedRunId)
  expect(coordinator.snapshot()?.runId).toBe(expectedRunId)

  // Abandoning it puts the coordinator back where it was, so a caller of this
  // helper is free to keep asserting on an idle coordinator.
  await generator.return(undefined)
  expect(coordinator.snapshot()).toBeNull()
}

/* -------------------------------------------------------------------------- */
/* Scenarios                                                                  */
/* -------------------------------------------------------------------------- */

const ROSTER_BOUNDS = {
  minLength: 1,
  maxLength: MAX_LOCK_ROSTER,
  atLeastOneEnabled: true,
} as const

/**
 * A run that answers every Group_Member without stopping early — the default
 * outcome set of `runScenarioArb` excludes `INVALID_COUPON` — together with the
 * number of contending requests and the position of the held call.
 */
const contendedRunArb = fc
  .tuple(
    runScenarioArb(ROSTER_BOUNDS),
    fc.integer({ min: 1, max: 4 }),
    fc.nat({ max: 99 })
  )
  .map(([scenario, contenders, seed]) => ({
    scenario,
    contenders,
    // The fixed list holds at least one entry, and no scripted answer stops the
    // run, so every position is reached and any of them can be held open.
    holdIndex: seed % scenario.fixedList.length,
  }))

/** A run plus the number of `start()` calls racing for the lock from idle. */
const simultaneousStartArb = fc.tuple(
  runScenarioArb(ROSTER_BOUNDS),
  fc.integer({ min: 2, max: 5 })
)

/** A run abandoned after a generated number of events, before its terminal one. */
const abandonedRunArb = fc
  .tuple(runScenarioArb(ROSTER_BOUNDS), fc.nat({ max: 99 }))
  .map(([scenario, seed]) => ({
    scenario,
    // 1 keeps the `run-started` event and no request; the upper bound stops
    // short of the terminal event, so the run is genuinely abandoned.
    breakAfter: 1 + (seed % scenario.fixedList.length),
  }))

/** A run whose `useCoupon` call at a generated position throws (Requirement 5.8). */
const failingRunArb = fc
  .tuple(runScenarioArb(ROSTER_BOUNDS), fc.nat({ max: 99 }))
  .map(([scenario, seed]) => ({
    scenario,
    throwIndex: seed % scenario.fixedList.length,
  }))

/** A Member_Registry holding no enabled Group_Member (Requirement 3.8). */
const noEnabledMembersArb = fc.tuple(
  rosterArb({ maxLength: MAX_LOCK_ROSTER }).map((roster) =>
    roster.map((entry) => ({ ...entry, enabled: false }))
  ),
  trimmedCouponCodeArb
)

/* -------------------------------------------------------------------------- */
/* Properties                                                                 */
/* -------------------------------------------------------------------------- */

describe("Redemption_Run single-run lock", () => {
  // Feature: shared-coupon-redemption, Property 9: At most one Redemption_Run
  // ever executes — For any number of redemption requests issued concurrently
  // while a Redemption_Run is in progress, exactly one Redemption_Run executes,
  // every other request is rejected with a message stating that a
  // Redemption_Run is in progress, no Upstream_API request is issued for a
  // rejected request, and the outcomes of the executing Redemption_Run are
  // identical to those of the same run performed without the rejected requests.
  // Validates: Requirements 3.9
  it("rejects every request issued while a Redemption_Run is in progress, and leaves that run unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(
        contendedRunArb,
        async ({ scenario, contenders, holdIndex }) => {
          const { roster, fixedList, couponCode, sequence } = scenario
          const script = sequence.steps.map(toScriptEntry)

          // The same run performed without the rejected requests: the oracle
          // the contended run has to match.
          const uncontended = await createHarness(roster, script)
          const baseline = await drain(
            uncontended.coordinator.start(couponCode)
          )
          expect(baseline.rejection).toBeNull()

          const hold = holdCall(holdIndex)
          const contended = await createHarness(roster, script, hold.gate)
          expect(contended.coordinator.snapshot()).toBeNull()

          // Not awaited yet: the run has to stay in progress while the
          // contending requests are issued.
          const firstRun = drain(contended.coordinator.start(couponCode))
          await hold.reached

          // The snapshot the reconnect path of Requirement 2.9 reads is
          // non-null exactly while a run is in progress, and describes the
          // first run, not a contender.
          const snapshot = contended.coordinator.snapshot()
          if (snapshot === null) {
            throw new Error(
              "expected a snapshot while a Redemption_Run is in progress"
            )
          }
          expect(snapshot.runId).toBe("run-1")
          expect(snapshot.couponCode).toBe(couponCode)
          expect(snapshot.total).toBe(fixedList.length)
          // The held call is in flight, so every earlier Group_Member — and no
          // one else — has an outcome recorded.
          expect(snapshot.processed).toBe(holdIndex)

          const callsBeforeContenders = contended.upstream.callCount
          const contenderResults = await Promise.allSettled(
            Array.from({ length: contenders }, () =>
              contended.coordinator.start(couponCode)
            ).map((generator) => generator.next())
          )

          // Every contender was rejected, and none of them reached the
          // Upstream_API.
          for (const result of contenderResults) {
            if (result.status !== "rejected") {
              throw new Error(
                `expected every contending request to be rejected, one resolved with ${JSON.stringify(result.value)}`
              )
            }
            assertRunInProgress(result.reason)
          }
          expect(contended.upstream.callCount).toBe(callsBeforeContenders)
          expect(contended.coordinator.snapshot()).toEqual(snapshot)

          hold.release()
          const executed = await firstRun

          // Identical to the uncontended run: same events, same outcomes, same
          // request sequence.
          expect(executed.rejection).toBeNull()
          expect(executed.events).toEqual(baseline.events)
          expect(contended.upstream.requests).toEqual(
            uncontended.upstream.requests
          )
          expect(contended.upstream.callCount).toBe(fixedList.length)
          expect(contended.upstream.maxInFlight).toBe(1)

          // The lock is released with the terminal event, so the next run is
          // admitted (Requirement 3.9 forbids concurrency, not succession).
          expect(contended.coordinator.snapshot()).toBeNull()
          await assertNextRunAdmitted(
            contended.coordinator,
            couponCode,
            "run-2"
          )
        }
      ),
      { numRuns: 100 }
    )
  })

  // Feature: shared-coupon-redemption, Property 9: At most one Redemption_Run
  // ever executes — exactly one of several simultaneous requests executes, and
  // the rest are rejected with the run-in-progress message.
  // Validates: Requirements 3.9
  it("admits exactly one of several simultaneous requests", async () => {
    await fc.assert(
      fc.asyncProperty(simultaneousStartArb, async ([scenario, starters]) => {
        const { roster, fixedList, couponCode, sequence } = scenario
        const harness = await createHarness(
          roster,
          sequence.steps.map(toScriptEntry)
        )

        // Every generator is created first, then all of their first `next()`
        // calls are driven together: the check-and-set is what has to be
        // atomic, not the `start()` calls.
        const generators = Array.from({ length: starters }, () =>
          harness.coordinator.start(couponCode)
        )
        const started = await Promise.allSettled(
          generators.map((generator) => generator.next())
        )

        const winners = started.filter(
          (result) => result.status === "fulfilled"
        )
        expect(winners).toHaveLength(1)

        for (const result of started) {
          if (result.status === "fulfilled") {
            if (result.value.done) {
              throw new Error(
                "expected the admitted run to yield a run-started event"
              )
            }
            expect(result.value.value.type).toBe("run-started")
            continue
          }
          assertRunInProgress(result.reason)
        }

        const winnerIndex = started.findIndex(
          (result) => result.status === "fulfilled"
        )
        const winner = generators[winnerIndex]
        const rest = await drain(winner)
        expect(rest.rejection).toBeNull()
        expect(rest.events.at(-1)?.type).toBe("run-completed")

        // Exactly one run executed: one request per Group_Member of one fixed
        // list, never two in flight.
        expect(harness.upstream.callCount).toBe(fixedList.length)
        expect(harness.upstream.maxInFlight).toBe(1)
        expect(harness.coordinator.snapshot()).toBeNull()
      }),
      { numRuns: 100 }
    )
  })

  // Feature: shared-coupon-redemption, Property 9: At most one Redemption_Run
  // ever executes — a consumer that stops iterating releases the lock, so it
  // cannot lock the coordinator out of every later Redemption_Run.
  // Validates: Requirements 3.9
  it("releases the lock when a run is abandoned mid-iteration", async () => {
    await fc.assert(
      fc.asyncProperty(abandonedRunArb, async ({ scenario, breakAfter }) => {
        const { roster, couponCode, sequence } = scenario
        const harness = await createHarness(
          roster,
          sequence.steps.map(toScriptEntry)
        )

        let seen = 0
        for await (const event of harness.coordinator.start(couponCode)) {
          seen += 1
          if (seen >= breakAfter) {
            // Abandoned before the terminal event, so the lock is released by
            // the `finally` rather than by the run reaching its end.
            expect(event.type).not.toBe("run-completed")
            expect(event.type).not.toBe("run-failed")
            break
          }
        }

        // `break` calls `.return()` on the generator, which runs the `finally`
        // that releases the lock. The generator was suspended at a yield, so no
        // request was in flight: one request per event beyond `run-started`.
        expect(seen).toBe(breakAfter)
        expect(harness.upstream.callCount).toBe(breakAfter - 1)
        expect(harness.coordinator.snapshot()).toBeNull()

        await assertNextRunAdmitted(harness.coordinator, couponCode, "run-2")
      }),
      { numRuns: 100 }
    )
  })

  // Feature: shared-coupon-redemption, Property 9: At most one Redemption_Run
  // ever executes — a Redemption_Run that ends in a server failure releases the
  // lock, so a failure does not block every later Redemption_Run.
  // Validates: Requirements 3.9
  it("releases the lock when a run fails", async () => {
    await fc.assert(
      fc.asyncProperty(failingRunArb, async ({ scenario, throwIndex }) => {
        const { roster, couponCode, sequence } = scenario
        const script = sequence.steps.map(toScriptEntry)
        script[throwIndex] = throwOnCall(new Error("stub upstream failure"))

        const harness = await createHarness(roster, script)
        const failed = await drain(harness.coordinator.start(couponCode))

        expect(failed.rejection).toBeNull()
        expect(failed.events.at(-1)?.type).toBe("run-failed")
        expect(harness.upstream.callCount).toBe(throwIndex + 1)
        expect(harness.upstream.maxInFlight).toBe(1)
        expect(harness.coordinator.snapshot()).toBeNull()

        await assertNextRunAdmitted(harness.coordinator, couponCode, "run-2")
      }),
      { numRuns: 100 }
    )
  })

  // Feature: shared-coupon-redemption, Property 9: At most one Redemption_Run
  // ever executes — a request rejected for holding no enabled Group_Member
  // releases the lock it acquired, so the next request is judged on its own
  // merits rather than reported as a run in progress.
  // Validates: Requirements 3.9
  it("releases the lock when a run finds no enabled Group_Member", async () => {
    await fc.assert(
      fc.asyncProperty(noEnabledMembersArb, async ([roster, couponCode]) => {
        const harness = await createHarness(roster, [])

        for (const attempt of [1, 2]) {
          const rejected = await drain(harness.coordinator.start(couponCode))
          if (!(rejected.rejection instanceof RunStartError)) {
            throw new Error(
              `attempt ${attempt}: expected a RunStartError, got ${String(rejected.rejection)}`
            )
          }
          // The second attempt must report the empty fixed list too. Reporting
          // a run in progress would mean the first attempt leaked the lock.
          expect(rejected.rejection.code).toBe("NO_ENABLED_MEMBERS")
          expect(rejected.events).toEqual([])
          expect(harness.coordinator.snapshot()).toBeNull()
        }

        expect(harness.upstream.callCount).toBe(0)
      }),
      { numRuns: 100 }
    )
  })
})
