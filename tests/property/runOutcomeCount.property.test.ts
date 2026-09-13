/**
 * Property 5 of shared-coupon-redemption: the outcome-count invariant of a
 * Redemption_Run.
 *
 * The claim under test is structural rather than behavioural: whatever the
 * Upstream_API answers, and whether the run finishes, stops early on an
 * `INVALID_COUPON`, or dies because the client itself failed, the result set
 * holds exactly one Member_Outcome per entry of the fixed list — in processing
 * order, carrying that Group_Member's Member_Label and the response message of
 * its Upstream_Result — and the six counts of the summary sum to that same
 * length. That is what makes the result table of Requirement 6.1 and the summary
 * of Requirement 6.3 total: no Group_Member of the fixed list is ever missing,
 * duplicated, or invented.
 *
 * Three scenario shapes are generated, so the invariant is exercised on every
 * path the coordinator has:
 *
 * - a run whose scripted answers never stop it, so the loop reaches the last
 *   fixed-list entry and issues one request per Group_Member;
 * - a run carrying an `INVALID_COUPON` at a generated position, plus possibly a
 *   throwing step, so the early stop and the server failure compete;
 * - a run whose very first scripted step throws, which is the "fails before the
 *   first Upstream_API request is issued" case of Requirement 5.8.
 *
 * The empty roster is generated too and asserted as its own branch: `start()`
 * rejects with `NO_ENABLED_MEMBERS` on the first `next()` (Requirement 3.8), so
 * the run reports zero outcomes for a fixed list of zero entries, issues zero
 * upstream requests, and appends no Redemption_History record — which is the
 * degenerate reading of the Requirement 5.6 clause about a Redemption_Run that
 * terminates before any Upstream_API request.
 *
 * The oracle for a single Member_Outcome is `parseUpstreamBody`, applied to the
 * scripted response the stub returned. Properties 1 to 4 pin the parser itself;
 * here the point is that the coordinator carries its Upstream_Result through
 * unchanged and attaches it to the right Group_Member.
 *
 * No filesystem is touched: the store is built over an unused temporary path
 * with the flush replaced by a resolved promise.
 *
 * Validates: Requirements 3.1, 5.6, 5.8, 6.3
 */

import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { countOutcomes } from "@/domain/outcomes"
import { parseUpstreamBody } from "@/domain/responseParser"
import { MEMBER_OUTCOME_VALUES } from "@/domain/types"
import type {
  MemberOutcome,
  MemberRegistryEntry,
  RedemptionRunResult,
  RunEvent,
} from "@/domain/types"
import {
  RunStartError,
  createRunCoordinator,
} from "@/server/run/coordinator.server"
import { createHistoryStore } from "@/server/store/history.server"
import type { HistoryStore } from "@/server/store/history.server"
import { createMemberRegistryStore } from "@/server/store/memberRegistry.server"

import { createInMemoryMongoStore } from "../support/inMemoryMongoStore"
import { StubUpstreamClient, throwOnCall } from "../support/stubUpstreamClient"
import type { StubScriptEntry } from "../support/stubUpstreamClient"
import {
  ALL_STUBBABLE_OUTCOMES,
  MAX_ROSTER_ENTRIES,
  runScenarioArb,
  throwStepArb,
} from "./generators"
import type { RunScenario, StubStep } from "./generators"

/* -------------------------------------------------------------------------- */
/* Scenarios                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Rosters of 0 to 100 entries with arbitrary enabled flags. The lower bound is 0
 * on purpose: the empty fixed list is one of the cases Requirement 5.6 names.
 */
const ROSTER_BOUNDS = { minLength: 0, maxLength: MAX_ROSTER_ENTRIES } as const

/** A run whose answers never stop it: one request per fixed-list entry. */
const completingScenarioArb: fc.Arbitrary<RunScenario> =
  runScenarioArb(ROSTER_BOUNDS)

/**
 * A run that stops early, fails mid-loop, or both. `INVALID_COUPON` is placed at
 * a generated position and the base steps may produce it as well, so the stop
 * lands anywhere in the fixed list.
 */
const stoppingScenarioArb: fc.Arbitrary<RunScenario> = runScenarioArb({
  ...ROSTER_BOUNDS,
  outcomes: ALL_STUBBABLE_OUTCOMES,
  withInvalidCoupon: true,
  withThrow: true,
})

/**
 * A run whose first scripted step throws, so the Redemption_Server fails before
 * a single usable response exists (Requirement 5.8). The throw is relocated to
 * position 0 rather than left to the generated position, which for a 100-entry
 * fixed list would land there once in a hundred samples.
 */
const throwsFirstScenarioArb: fc.Arbitrary<RunScenario> = fc
  .tuple(
    runScenarioArb({
      ...ROSTER_BOUNDS,
      minLength: 1,
      atLeastOneEnabled: true,
      outcomes: ALL_STUBBABLE_OUTCOMES,
    }),
    throwStepArb
  )
  .map(([scenario, throwStep]) => {
    const steps = [...scenario.sequence.steps]
    steps[0] = throwStep
    return {
      ...scenario,
      sequence: { steps, invalidCouponIndex: null, throwIndex: 0 },
    }
  })

const scenarioArb: fc.Arbitrary<RunScenario> = fc.oneof(
  { weight: 2, arbitrary: completingScenarioArb },
  { weight: 3, arbitrary: stoppingScenarioArb },
  { weight: 2, arbitrary: throwsFirstScenarioArb }
)

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface Harness {
  readonly history: HistoryStore
  readonly upstream: StubUpstreamClient
  readonly run: (couponCode: string) => Promise<RunOutcomeEvents>
}

interface RunOutcomeEvents {
  readonly events: readonly RunEvent[]
  /** The rejection of the first `next()`, or null when the run produced events. */
  readonly rejection: unknown
}

/** Translates a generated {@link StubStep} into a stub script entry. */
function toScriptEntry(step: StubStep): StubScriptEntry {
  if (step.kind === "throw") {
    return throwOnCall(new Error(step.message))
  }
  return { kind: "respond", response: step.response }
}

/**
 * A coordinator over a real Member_Registry and a real Redemption_History, both
 * backed by a store whose flush resolves without writing a file, and a stub
 * upstream client replaying `steps`.
 *
 * The roster is seeded through the registry itself rather than injected, so the
 * fixed list the coordinator snapshots is produced by the same `listEnabled()`
 * the application uses: `add` stores an enabled entry, and the disabled ones are
 * disabled afterwards through `setEnabled` (Requirements 1.1, 1.6, 1.9).
 */
async function createHarness(
  roster: readonly MemberRegistryEntry[],
  steps: readonly StubStep[]
): Promise<Harness> {
  const handle = createInMemoryMongoStore()
  /* The in-memory Mongo_Store of `tests/support/inMemoryMongoStore.ts`: no
   * deployment and no file, and every operation served, so a `failed` result
   * anywhere below is a genuine falsification. */
  const store = handle.store

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

  const history = createHistoryStore(store)
  const upstream = new StubUpstreamClient({
    script: steps.map(toScriptEntry),
  })
  const coordinator = createRunCoordinator({ registry, history, upstream })

  return {
    history,
    upstream,
    run: async (couponCode) => {
      const events: RunEvent[] = []
      try {
        for await (const event of coordinator.start(couponCode)) {
          events.push(event)
        }
      } catch (caught) {
        return { events, rejection: caught }
      }
      return { events, rejection: null }
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Model                                                                      */
/* -------------------------------------------------------------------------- */

/** What the scripted sequence predicts about the run it drives. */
interface Expectation {
  /** Number of `useCoupon` calls the loop issues before it stops. */
  readonly requests: number
  /** Fixed-list positions that receive a response-derived Member_Outcome. */
  readonly derived: number
  /** True when the run ends on a `run-failed` event. */
  readonly failed: boolean
}

/**
 * Derives the expectation from the script alone.
 *
 * The first step that either throws or answers `INVALID_COUPON` ends the run. A
 * throw consumes its request without producing a usable response, so its own
 * position is `SKIPPED` too; an `INVALID_COUPON` is reported for the
 * Group_Member that triggered it, so its position counts as derived
 * (Requirements 5.1 to 5.3, 5.8).
 */
function expectationOf(steps: readonly StubStep[], total: number): Expectation {
  const scripted = steps.slice(0, total)
  const stopIndex = scripted.findIndex(
    (step) => step.kind === "throw" || step.outcome === "INVALID_COUPON"
  )

  if (stopIndex === -1) {
    return { requests: total, derived: total, failed: false }
  }

  const stopStep = scripted[stopIndex]
  if (stopStep.kind === "throw") {
    return { requests: stopIndex + 1, derived: stopIndex, failed: true }
  }
  return { requests: stopIndex + 1, derived: stopIndex + 1, failed: false }
}

/* -------------------------------------------------------------------------- */
/* Assertions                                                                 */
/* -------------------------------------------------------------------------- */

/** The terminal event of a run, which is the one carrying the result set. */
function terminalResult(events: readonly RunEvent[]): RedemptionRunResult {
  const terminal = events.at(-1)
  if (
    terminal === undefined ||
    (terminal.type !== "run-completed" && terminal.type !== "run-failed")
  ) {
    throw new Error(
      `expected a terminal run event, got ${terminal?.type ?? "no event at all"}`
    )
  }
  return terminal.result
}

/**
 * Requirement 5.6: one Member_Outcome per fixed-list entry, none for anyone
 * else. Asserted as a multiset equality plus a duplicate check, because a run
 * that reported one Group_Member twice and another not at all would still hold
 * the right count.
 */
function assertOneOutcomePerMember(
  outcomes: readonly MemberOutcome[],
  fixedList: readonly MemberRegistryEntry[]
): void {
  expect(outcomes).toHaveLength(fixedList.length)

  const reported = outcomes.map((outcome) => outcome.hiveId)
  expect([...reported].sort()).toEqual(
    fixedList.map((member) => member.hiveId).sort()
  )
  expect(new Set(reported).size).toBe(reported.length)

  // Requirements 3.1 and 6.1: processing order, each outcome carrying its own
  // Group_Member's Member_Label.
  outcomes.forEach((outcome, position) => {
    expect(outcome.position).toBe(position)
    expect(outcome.hiveId).toBe(fixedList[position].hiveId)
    expect(outcome.memberLabel).toBe(fixedList[position].memberLabel)
  })
}

/**
 * Requirement 6.3: all six keys present, including the zero counts, summing to
 * the size of the fixed list.
 */
function assertCounts(result: RedemptionRunResult): void {
  expect(Object.keys(result.counts).sort()).toEqual(
    [...MEMBER_OUTCOME_VALUES].sort()
  )
  expect(result.counts).toEqual(countOutcomes(result.outcomes))

  const sum = MEMBER_OUTCOME_VALUES.reduce(
    (total, value) => total + result.counts[value],
    0
  )
  expect(sum).toBe(result.outcomes.length)
}

/**
 * Exactly one of the six Member_Outcome values per Group_Member, and the
 * Upstream_Result that goes with it: `SKIPPED` means no request was issued and
 * therefore carries none, every other value carries the Upstream_Result its
 * response produced, response message included (Requirements 3.1, 5.2).
 */
function assertOutcomeShape(outcome: MemberOutcome): void {
  expect(MEMBER_OUTCOME_VALUES).toContain(outcome.outcome)

  if (outcome.outcome === "SKIPPED") {
    expect(outcome.upstreamResult).toBeNull()
    return
  }

  expect(outcome.upstreamResult).not.toBeNull()
  expect(typeof outcome.upstreamResult.responseMessage).toBe("string")
}

/**
 * The response-derived positions hold the Upstream_Result of the scripted
 * response, unchanged, and every position from `derived` onwards is `SKIPPED`.
 */
function assertDerivedOutcomes(
  outcomes: readonly MemberOutcome[],
  steps: readonly StubStep[],
  derived: number
): void {
  outcomes.forEach((outcome, position) => {
    if (position >= derived) {
      expect(outcome.outcome).toBe("SKIPPED")
      return
    }

    const step = steps[position]
    if (step.kind !== "response") {
      throw new Error(
        `position ${position} was derived from a throwing step, which produces no Member_Outcome`
      )
    }

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

describe("Redemption_Run outcome-count invariant", () => {
  // Feature: shared-coupon-redemption, Property 5: Every enabled Group_Member
  // gets exactly one Member_Outcome — For any Member_Registry, any Coupon_Code
  // of 1 to 64 characters, and any sequence of stubbed upstream responses —
  // including a sequence that triggers an early stop and a stub that throws
  // before the first request — the completed Redemption_Run reports exactly one
  // Member_Outcome per entry of the fixed list of enabled Group_Members, each
  // carrying that Group_Member's Member_Label and its response message, reports
  // no Member_Outcome for any Group_Member absent from that list, and yields six
  // outcome counts whose sum equals the size of that fixed list.
  // Validates: Requirements 3.1, 5.6, 5.8, 6.3
  it("reports one Member_Outcome per fixed-list entry on every path", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const { roster, fixedList, couponCode, sequence } = scenario
        const harness = await createHarness(roster, sequence.steps)
        const { events, rejection } = await harness.run(couponCode)

        if (fixedList.length === 0) {
          // Requirement 3.8: the run terminates before any Upstream_API request
          // is issued, so it reports zero Member_Outcomes for a fixed list of
          // zero entries and records nothing.
          if (!(rejection instanceof RunStartError)) {
            throw new Error(
              `expected an empty fixed list to be rejected with a RunStartError, got ${String(rejection)}`
            )
          }
          expect(rejection.code).toBe("NO_ENABLED_MEMBERS")
          expect(events).toEqual([])
          expect(harness.upstream.requests).toEqual([])
          const stored = await harness.history.list()
          expect(stored.kind === "records" ? stored.records : null).toEqual([])
          return
        }

        expect(rejection).toBeNull()

        const expectation = expectationOf(sequence.steps, fixedList.length)
        const result = terminalResult(events)

        expect(events.at(-1)?.type).toBe(
          expectation.failed ? "run-failed" : "run-completed"
        )
        // Requirement 3.4: one request per processed Group_Member, and none for
        // the Group_Members the run never reached.
        expect(harness.upstream.callCount).toBe(expectation.requests)

        assertOneOutcomePerMember(result.outcomes, fixedList)
        assertCounts(result)
        result.outcomes.forEach(assertOutcomeShape)
        assertDerivedOutcomes(
          result.outcomes,
          sequence.steps,
          expectation.derived
        )
      }),
      { numRuns: 100 }
    )
  })
})
