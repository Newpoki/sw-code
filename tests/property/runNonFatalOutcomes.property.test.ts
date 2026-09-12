/**
 * Property 7 of shared-coupon-redemption: a non-fatal Member_Outcome neither
 * stops a Redemption_Run nor costs a second Upstream_API request.
 *
 * `ALREADY_USED`, `UPSTREAM_ERROR`, and `TRANSPORT_ERROR` are answers, not
 * failures. The coordinator has to fall through all three to the next
 * Group_Member (Requirement 5.4) while keeping the request budget of Requirement
 * 3.4 — exactly one `useCoupon` call per enabled Group_Member, no `checkUser`
 * call at all — and the sequencing of Requirement 3.5: Member_Registry order,
 * at most one request in flight, and the next request issued only after the
 * preceding Member_Outcome is recorded.
 *
 * The scenario generator draws every scripted answer from
 * `NON_STOPPING_OUTCOMES`, so `INVALID_COUPON` never appears and no scripted
 * step throws. Under that constraint the run has no legitimate reason to end
 * before the last fixed-list entry, which makes three otherwise-separate
 * failure modes observable as one property: a premature stop shows up as a
 * `SKIPPED` outcome, an over-issuing loop shows up in the request count, and a
 * concurrent loop shows up in `maxInFlight`.
 *
 * Three mechanisms carry the sequencing claims:
 *
 * - **At most one request in flight.** The stub always suspends at least once
 *   before it settles, so two `useCoupon` calls started without an intervening
 *   `await` would overlap and raise `maxInFlight` above 1. One scripted step per
 *   run also carries a real timer delay, so the overlap window is wider than a
 *   microtask for at least one call.
 * - **Outcome recorded before the next request.** The stub's `gate` runs inside
 *   call `i`, after the request is recorded and before the response is produced.
 *   At that instant the consumer of the event stream must have seen exactly `i`
 *   `member-outcome` events, and the coordinator's own snapshot must report
 *   exactly `i` recorded outcomes. The consumer count works because an async
 *   generator suspends at each `yield` until the consumer asks for the next
 *   value: the `for await` body increments the counter and only then resumes the
 *   loop that issues request `i`.
 * - **No extra request.** The script is generated longer than the fixed list, so
 *   surplus entries left unconsumed are direct evidence that the loop stopped
 *   issuing requests when the fixed list ran out.
 *
 * No filesystem is touched: the store is built over an unused temporary path
 * with the flush replaced by a resolved promise.
 *
 * Validates: Requirements 3.4, 3.5, 5.4
 */

import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"

import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { parseUpstreamBody } from "@/domain/responseParser"
import type {
  MemberOutcome,
  MemberRegistryEntry,
  RedemptionRunResult,
  RunEvent,
} from "@/domain/types"
import { createRunCoordinator } from "@/server/run/coordinator.server"
import type { RunCoordinator } from "@/server/run/coordinator.server"
import { createHistoryStore } from "@/server/store/history.server"
import { createJsonStore } from "@/server/store/jsonStore.server"
import { createMemberRegistryStore } from "@/server/store/memberRegistry.server"
import type { UpstreamClient } from "@/server/upstream/client"

import { StubUpstreamClient } from "../support/stubUpstreamClient"
import type { StubScriptEntry } from "../support/stubUpstreamClient"
import { NON_STOPPING_OUTCOMES, runScenarioArb } from "./generators"
import type { RunScenario, StubStep } from "./generators"

/* -------------------------------------------------------------------------- */
/* Scenarios                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Rosters of 1 to 30 entries, at least one of them enabled. The 100-entry cap is
 * exercised by Property 5; here a smaller bound keeps 100 sequential runs quick
 * while still covering fixed lists long enough for an ordering or a retry defect
 * to show.
 */
const ROSTER_BOUNDS = {
  minLength: 1,
  maxLength: 30,
  atLeastOneEnabled: true,
} as const

/** A generated run whose scripted answers all let the run continue. */
interface NonFatalScenario {
  readonly scenario: RunScenario
  /** Scripted entries beyond the fixed-list length; always at least one. */
  readonly extraSteps: number
  /** Fixed-list position whose scripted response is held open by a real timer. */
  readonly delayPosition: number
}

const nonFatalScenarioArb: fc.Arbitrary<NonFatalScenario> = fc
  .integer({ min: 1, max: 3 })
  .chain((extraSteps) =>
    runScenarioArb({
      ...ROSTER_BOUNDS,
      outcomes: NON_STOPPING_OUTCOMES,
      extraSteps,
    }).chain((scenario) =>
      fc
        .nat({ max: Math.max(0, scenario.fixedList.length - 1) })
        .map((delayPosition) => ({ scenario, extraSteps, delayPosition }))
    )
  )

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

/** What the stub observed at the moment `useCoupon` call `callIndex` started. */
interface CallObservation {
  readonly callIndex: number
  /** `member-outcome` events the consumer had received by then. */
  readonly outcomesSeen: number
  /** Member_Outcomes the coordinator had recorded by then. */
  readonly outcomesRecorded: number | null
  /** `useCoupon` calls overlapping right now, this one included. */
  readonly inFlight: number
}

interface Harness {
  readonly upstream: StubUpstreamClient
  readonly observations: readonly CallObservation[]
  readonly run: (couponCode: string) => Promise<readonly RunEvent[]>
}

/** Turns a generated step into a stub script entry; a throw would be off-property. */
function toScriptEntry(step: StubStep, delayMs?: number): StubScriptEntry {
  if (step.kind !== "response") {
    throw new Error(
      "a non-fatal scenario scripts responses only, never a throwing step"
    )
  }
  return {
    kind: "respond",
    response: step.response,
    ...(delayMs === undefined ? {} : { delayMs }),
  }
}

/**
 * A coordinator over a real Member_Registry and a real Redemption_History, both
 * backed by a store whose flush resolves without writing a file, driving a stub
 * upstream client that replays `steps`.
 *
 * The roster is seeded through the registry itself, so the fixed list the
 * coordinator snapshots comes from the same `listEnabled()` the application uses
 * (Requirements 1.1, 1.6, 1.9).
 */
async function createHarness(
  roster: readonly MemberRegistryEntry[],
  steps: readonly StubStep[],
  delayPosition: number
): Promise<Harness> {
  const store = createJsonStore({
    dataFilePath: join(tmpdir(), `scr-non-fatal-${randomUUID()}`, "store.json"),
    flush: () => Promise.resolve(),
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

  /**
   * Read by the gate below. `outcomesSeen` is incremented by the `for await`
   * body, which runs while the generator is suspended at its `yield`, so the
   * value the gate reads during call `i` is the number of Member_Outcomes
   * already delivered to the consumer.
   */
  let outcomesSeen = 0
  let coordinator: RunCoordinator | null = null
  const observations: CallObservation[] = []

  const upstream = new StubUpstreamClient({
    script: steps.map((step, position) =>
      toScriptEntry(step, position === delayPosition ? 1 : undefined)
    ),
    gate: ({ callIndex, inFlight }) => {
      observations.push({
        callIndex,
        outcomesSeen,
        outcomesRecorded: coordinator?.snapshot()?.processed ?? null,
        inFlight,
      })
    },
  })

  const history = createHistoryStore(store)
  coordinator = createRunCoordinator({ registry, history, upstream })
  const started = coordinator

  return {
    upstream,
    observations,
    run: async (couponCode) => {
      const events: RunEvent[] = []
      for await (const event of started.start(couponCode)) {
        events.push(event)
        if (event.type === "member-outcome") {
          outcomesSeen += 1
        }
      }
      return events
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Assertions                                                                 */
/* -------------------------------------------------------------------------- */

/** The terminal event of a run, which carries the complete result set. */
function terminalResult(events: readonly RunEvent[]): RedemptionRunResult {
  const terminal = events.at(-1)
  if (terminal === undefined || terminal.type !== "run-completed") {
    throw new Error(
      `expected a run-completed event, got ${terminal?.type ?? "no event at all"}`
    )
  }
  return terminal.result
}

/**
 * Requirement 5.4: the run reached the last fixed-list entry. Nothing is
 * `SKIPPED`, in the terminal result or in the streamed events, and the run does
 * not report itself as stopped early.
 */
function assertRanToCompletion(
  result: RedemptionRunResult,
  events: readonly RunEvent[],
  fixedList: readonly MemberRegistryEntry[]
): void {
  expect(result.stoppedEarly).toBe(false)
  expect(result.counts.SKIPPED).toBe(0)
  expect(
    result.outcomes.filter((outcome) => outcome.outcome === "SKIPPED")
  ).toEqual([])

  const memberOutcomes = events.filter(
    (event): event is Extract<RunEvent, { type: "member-outcome" }> =>
      event.type === "member-outcome"
  )
  expect(memberOutcomes).toHaveLength(fixedList.length)
  memberOutcomes.forEach((event, position) => {
    expect(event.outcome.outcome).not.toBe("SKIPPED")
    expect(event.processed).toBe(position + 1)
    expect(event.total).toBe(fixedList.length)
  })
}

/**
 * Requirement 3.4: exactly one `useCoupon` request per enabled Group_Member, no
 * Group_Member requested twice, and no retry after `ALREADY_USED`,
 * `UPSTREAM_ERROR`, or `TRANSPORT_ERROR` — all three of which the scripted
 * answers produce.
 *
 * Requirement 3.5: the recorded `hiveid` sequence is the Member_Registry order
 * of the fixed list, position for position.
 */
function assertOneRequestPerMemberInOrder(
  upstream: StubUpstreamClient,
  fixedList: readonly MemberRegistryEntry[],
  couponCode: string
): void {
  expect(upstream.callCount).toBe(fixedList.length)

  const requestedHiveIds = upstream.requests.map((request) => request.hiveid)
  expect(requestedHiveIds).toEqual(fixedList.map((member) => member.hiveId))
  expect(new Set(requestedHiveIds).size).toBe(requestedHiveIds.length)

  for (const request of upstream.requests) {
    expect(request.coupon).toBe(couponCode)
    // The caller-supplied payload of the boundary is the pair and nothing else;
    // the Fixed_Request_Fields belong to the live client (Requirement 3.3).
    expect(Object.keys(request).sort()).toEqual(["coupon", "hiveid"])
  }
}

/**
 * Requirement 3.4, the `checkUser` half: the application skips that endpoint by
 * construction, so the boundary offers no way to reach it. Asserted with `in`,
 * which walks the prototype chain, so a method inherited from the stub's class
 * would be caught too.
 */
function assertNoCheckUserCapability(upstream: StubUpstreamClient): void {
  const boundary: UpstreamClient = upstream
  expect("checkUser" in boundary).toBe(false)
  expect("checkUser" in upstream).toBe(false)
  expect(
    Object.getOwnPropertyNames(Object.getPrototypeOf(upstream))
  ).not.toContain("checkUser")
}

/**
 * Requirement 3.5: at most one request in flight at any moment, and the next
 * request issued only after the preceding Member_Outcome is recorded. Every
 * observation is taken inside a `useCoupon` call, before its response exists.
 */
function assertSequentialIssue(
  upstream: StubUpstreamClient,
  observations: readonly CallObservation[],
  fixedList: readonly MemberRegistryEntry[]
): void {
  expect(upstream.maxInFlight).toBe(1)
  expect(upstream.inFlight).toBe(0)

  expect(observations).toHaveLength(fixedList.length)
  observations.forEach((observation, callIndex) => {
    expect(observation.callIndex).toBe(callIndex)
    expect(observation.inFlight).toBe(1)
    expect(observation.outcomesSeen).toBe(callIndex)
    expect(observation.outcomesRecorded).toBe(callIndex)
  })
}

/**
 * Every Member_Outcome is the Upstream_Result the scripted response parses to,
 * attached to the Group_Member at that position of the fixed list.
 */
function assertOutcomesMatchScript(
  outcomes: readonly MemberOutcome[],
  steps: readonly StubStep[],
  fixedList: readonly MemberRegistryEntry[]
): void {
  expect(outcomes).toHaveLength(fixedList.length)

  outcomes.forEach((outcome, position) => {
    const step = steps[position]
    if (step.kind !== "response") {
      throw new Error(`position ${position} was scripted with a throwing step`)
    }

    expect(outcome.position).toBe(position)
    expect(outcome.hiveId).toBe(fixedList[position].hiveId)
    expect(outcome.memberLabel).toBe(fixedList[position].memberLabel)
    expect(outcome.outcome).toBe(step.outcome)
    expect(outcome.upstreamResult).toEqual(
      parseUpstreamBody({
        bodyText: step.response.bodyText,
        transportFailure: step.response.transportFailure,
      })
    )
  })
}

/* -------------------------------------------------------------------------- */
/* Property                                                                   */
/* -------------------------------------------------------------------------- */

describe("Redemption_Run with non-fatal Member_Outcomes", () => {
  // Feature: shared-coupon-redemption, Property 7: Non-fatal outcomes never stop
  // the run and never retry — For any Member_Registry and any stubbed response
  // sequence containing no `INVALID_COUPON`, the Redemption_Run issues exactly
  // one Upstream_API request per enabled Group_Member, every request addressed to
  // `useCoupon` and none to `checkUser`, in Member_Registry order, with at most
  // one request in flight at any moment, and reports no `SKIPPED` outcome.
  // Validates: Requirements 3.4, 3.5, 5.4
  it("issues one useCoupon request per enabled Group_Member, in order, and skips nobody", async () => {
    await fc.assert(
      fc.asyncProperty(
        nonFatalScenarioArb,
        async ({ scenario, extraSteps, delayPosition }) => {
          const { roster, fixedList, couponCode, sequence } = scenario
          const harness = await createHarness(
            roster,
            sequence.steps,
            delayPosition
          )
          const events = await harness.run(couponCode)

          const first = events.at(0)
          expect(first?.type).toBe("run-started")
          const result = terminalResult(events)

          assertRanToCompletion(result, events, fixedList)
          assertOneRequestPerMemberInOrder(
            harness.upstream,
            fixedList,
            couponCode
          )
          assertNoCheckUserCapability(harness.upstream)
          assertSequentialIssue(
            harness.upstream,
            harness.observations,
            fixedList
          )
          assertOutcomesMatchScript(result.outcomes, sequence.steps, fixedList)

          // The surplus scripted entries were never consumed: the loop issued no
          // request beyond the fixed list (Requirement 3.4).
          expect(harness.upstream.remainingScriptLength).toBe(extraSteps)
          expect(harness.upstream.remainingScriptLength).toBeGreaterThan(0)
        }
      ),
      { numRuns: 100 }
    )
  })
})
