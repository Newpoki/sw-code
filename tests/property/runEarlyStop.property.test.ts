/**
 * Property 6 of shared-coupon-redemption: the early stop on an
 * `INVALID_COUPON`.
 *
 * The claim under test is about the boundary between what a Redemption_Run did
 * and what it deliberately did not do. Once the Response_Parser derives
 * `INVALID_COUPON` at some position of the fixed list, the run must spend no
 * further Hive_ID on the Upstream_API: the request count stops at that position,
 * every later Group_Member is reported `SKIPPED` with no Upstream_Result, and
 * the Member_Outcomes already derived stay exactly as they were derived
 * (Requirements 5.1, 5.2, 5.3).
 *
 * The interesting half is Requirement 5.5. "The Group_Members reported as
 * `SKIPPED` are exactly the ones positioned after the stop" is only meaningful
 * if the list is fixed at run start, so this property attacks that snapshot
 * while the run is in progress. The stub's `gate` runs after a request is
 * recorded and before the scripted response is applied — the one place where the
 * Member_Registry can be mutated with a `useCoupon` call genuinely in flight —
 * and there the test adds a new enabled entry, removes an entry the run has not
 * processed yet, disables another one, and enables a previously disabled one.
 * The run must ignore all four: it processes the originally snapshotted fixed
 * list, in the original order, and reports one Member_Outcome per snapshotted
 * entry — including for the entry that no longer exists in the Member_Registry
 * by the time the run ends, and none for the entry that joined mid-run.
 *
 * Two scenario shapes are generated: one plain run that stops early, and one
 * that stops early while the Member_Registry is mutated underneath it. The
 * mutating shape places the mutation at or before the stopping position and
 * always leaves at least one unprocessed entry to remove, so the "removed an
 * entry that has not yet been processed" case is covered by construction rather
 * than by luck.
 *
 * The oracle for a single Member_Outcome is `parseUpstreamBody` applied to the
 * scripted response of that position: Properties 1 to 4 pin the parser itself,
 * here the point is that the coordinator carries its Upstream_Result through
 * untouched. The script also carries a few surplus steps beyond the fixed-list
 * length, so a run that over-issued requests is caught by the request-count
 * assertion instead of by the stub running out of script.
 *
 * An early stop is a *completed* run (Requirement 5.7), so the terminal event is
 * `run-completed` and exactly one Redemption_History record is appended.
 *
 * No filesystem is touched: the store is built over an unused temporary path
 * with the flush replaced by a resolved promise.
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.5
 */

import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"

import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { parseUpstreamBody } from "@/domain/responseParser"
import type {
  MemberRegistryEntry,
  RedemptionRunResult,
  RunEvent,
} from "@/domain/types"
import { createRunCoordinator } from "@/server/run/coordinator.server"
import { createHistoryStore } from "@/server/store/history.server"
import type { HistoryStore } from "@/server/store/history.server"
import { createJsonStore } from "@/server/store/jsonStore.server"
import { createMemberRegistryStore } from "@/server/store/memberRegistry.server"
import type { MemberRegistryStore } from "@/server/store/memberRegistry.server"

import {
  StubUpstreamClient,
  respondWithBody,
} from "../support/stubUpstreamClient"
import type { StubScriptEntry } from "../support/stubUpstreamClient"
import { FIXTURE_BODIES, runScenarioArb } from "./generators"
import type { RunScenario, StubStep } from "./generators"

/* -------------------------------------------------------------------------- */
/* Scenarios                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Rosters stay small. The property is about positions relative to the stop, not
 * about roster size, and 20 entries keep 100 runs of a sequential loop quick.
 */
const MAX_ROSTER_ENTRIES = 20

/** Scripted steps beyond the fixed-list length; see the module comment. */
const SURPLUS_STEPS = 3

/** Member_Label of the entry added while the run is in progress. */
const MID_RUN_LABEL = "Mid-run addition"

/** The Member_Registry mutations applied while a run is in progress. */
interface MutationPlan {
  /** `useCoupon` call during which the mutation is applied; at most `stopIndex`. */
  readonly atCallIndex: number
  /** Fixed-list position of the entry removed; always after `atCallIndex`. */
  readonly removeFixedIndex: number
  /** Fixed-list position disabled mid-run, or null. */
  readonly disableFixedIndex: number | null
  /** Roster position of a disabled entry enabled mid-run, or null. */
  readonly enableRosterIndex: number | null
}

/** One generated Redemption_Run that stops early. */
interface EarlyStopCase {
  readonly roster: readonly MemberRegistryEntry[]
  readonly fixedList: readonly MemberRegistryEntry[]
  readonly couponCode: string
  readonly steps: readonly StubStep[]
  /** Fixed-list position whose scripted response yields `INVALID_COUPON`. */
  readonly stopIndex: number
  readonly mutation: MutationPlan | null
}

/**
 * The position of the `INVALID_COUPON` step. `runScenarioArb` places exactly one
 * whenever the fixed list holds an entry, and both scenarios below force at
 * least one enabled Group_Member, so a null here means the generator changed
 * under the test rather than a legitimate sample.
 */
function stopIndexOf(scenario: RunScenario): number {
  const { invalidCouponIndex } = scenario.sequence
  if (invalidCouponIndex === null) {
    throw new Error(
      "scenario was generated without an INVALID_COUPON step, so there is no early stop to assert"
    )
  }
  return invalidCouponIndex
}

/**
 * A run that stops early on its own. The base steps come from the non-stopping
 * outcomes, so `INVALID_COUPON` appears at exactly one position.
 */
const plainCaseArb: fc.Arbitrary<EarlyStopCase> = runScenarioArb({
  minLength: 1,
  maxLength: MAX_ROSTER_ENTRIES,
  atLeastOneEnabled: true,
  withInvalidCoupon: true,
}).map((scenario) => ({
  roster: scenario.roster,
  fixedList: scenario.fixedList,
  couponCode: scenario.couponCode,
  steps: scenario.sequence.steps,
  stopIndex: stopIndexOf(scenario),
  mutation: null,
}))

/**
 * The mutation timing and targets for one scenario.
 *
 * `atCallIndex` is capped at both the stopping position — a mutation after the
 * stop would not be "while the run is in progress" in any interesting sense —
 * and at the second-to-last fixed-list position, which guarantees that an
 * unprocessed entry exists to remove.
 */
function mutationPlanArb(
  roster: readonly MemberRegistryEntry[],
  fixedListLength: number,
  stopIndex: number
): fc.Arbitrary<MutationPlan> {
  const lastMutationPoint = Math.min(stopIndex, fixedListLength - 2)
  const disabledRosterPositions = roster.flatMap((entry, index) =>
    entry.enabled ? [] : [index]
  )

  return fc.nat({ max: lastMutationPoint }).chain((atCallIndex) => {
    const unprocessedArb = fc.integer({
      min: atCallIndex + 1,
      max: fixedListLength - 1,
    })
    const enableRosterIndexArb: fc.Arbitrary<number | null> =
      disabledRosterPositions.length === 0
        ? fc.constant(null)
        : fc.option(fc.constantFrom(...disabledRosterPositions), { nil: null })

    return fc
      .record({
        removeFixedIndex: unprocessedArb,
        disableFixedIndex: fc.option(unprocessedArb, { nil: null }),
        enableRosterIndex: enableRosterIndexArb,
      })
      .map((choices) => ({
        atCallIndex,
        removeFixedIndex: choices.removeFixedIndex,
        // Disabling the entry that was just removed would only exercise the
        // not-found branch of the store, so the two targets stay distinct.
        disableFixedIndex:
          choices.disableFixedIndex === choices.removeFixedIndex
            ? null
            : choices.disableFixedIndex,
        enableRosterIndex: choices.enableRosterIndex,
      }))
  })
}

/**
 * A run that stops early while the Member_Registry is mutated underneath it.
 * At least two enabled Group_Members are required, so the mutation always has an
 * unprocessed entry to remove.
 */
const mutatingCaseArb: fc.Arbitrary<EarlyStopCase> = runScenarioArb({
  minLength: 2,
  maxLength: MAX_ROSTER_ENTRIES,
  atLeastOneEnabled: true,
  withInvalidCoupon: true,
})
  .filter((scenario) => scenario.fixedList.length >= 2)
  .chain((scenario) => {
    const stopIndex = stopIndexOf(scenario)
    return mutationPlanArb(
      scenario.roster,
      scenario.fixedList.length,
      stopIndex
    ).map((mutation) => ({
      roster: scenario.roster,
      fixedList: scenario.fixedList,
      couponCode: scenario.couponCode,
      steps: scenario.sequence.steps,
      stopIndex,
      mutation,
    }))
  })

const earlyStopCaseArb: fc.Arbitrary<EarlyStopCase> = fc.oneof(
  { weight: 2, arbitrary: plainCaseArb },
  { weight: 3, arbitrary: mutatingCaseArb }
)

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

/** What the mid-run mutation actually did, for the assertions to check against. */
interface AppliedMutation {
  readonly addedHiveIds: string[]
  readonly removedHiveIds: string[]
  readonly disabledHiveIds: string[]
  readonly enabledHiveIds: string[]
}

interface Harness {
  readonly registry: MemberRegistryStore
  readonly history: HistoryStore
  readonly upstream: StubUpstreamClient
  /** The fixed list the coordinator snapshots, read before the run starts. */
  readonly snapshot: readonly MemberRegistryEntry[]
  readonly applied: AppliedMutation
  readonly run: (couponCode: string) => Promise<readonly RunEvent[]>
}

/** Translates a generated {@link StubStep} into a stub script entry. */
function toScriptEntry(step: StubStep): StubScriptEntry {
  if (step.kind === "throw") {
    throw new Error(
      "the early-stop scenarios script no throwing step; that path belongs to Property 5"
    )
  }
  return { kind: "respond", response: step.response }
}

/** A Hive_ID no Member_Registry entry holds, so the mid-run add cannot conflict. */
function freshHiveId(taken: ReadonlySet<string>): string {
  let suffix = 0
  let candidate = "mid-run-hive-id"
  while (taken.has(candidate)) {
    suffix += 1
    candidate = `mid-run-hive-id-${suffix}`
  }
  return candidate
}

/**
 * Applies the four mutations of Requirement 5.5 to a Member_Registry whose run
 * is in progress: an entry joins, an unprocessed entry leaves, another
 * unprocessed entry is disabled, and a disabled entry is enabled.
 *
 * Every store answer is checked, so a mutation that silently did not happen
 * cannot make the property pass by leaving the Member_Registry untouched.
 */
async function applyMutation(
  registry: MemberRegistryStore,
  snapshot: readonly MemberRegistryEntry[],
  rosterBefore: readonly MemberRegistryEntry[],
  plan: MutationPlan,
  applied: AppliedMutation
): Promise<void> {
  const hiveId = freshHiveId(new Set(registry.list().map((e) => e.hiveId)))
  const added = await registry.add({ memberLabel: MID_RUN_LABEL, hiveId })
  if (added.kind !== "added") {
    throw new Error(`mid-run add was rejected as ${added.kind}`)
  }
  applied.addedHiveIds.push(added.entry.hiveId)

  const removeTarget = snapshot[plan.removeFixedIndex]
  const removed = await registry.remove(removeTarget.id)
  if (removed.kind !== "removed") {
    throw new Error(`mid-run removal was rejected as ${removed.kind}`)
  }
  applied.removedHiveIds.push(removeTarget.hiveId)

  if (plan.disableFixedIndex !== null) {
    const target = snapshot[plan.disableFixedIndex]
    const updated = await registry.setEnabled(target.id, false)
    if (updated.kind !== "updated") {
      throw new Error(`mid-run disable was rejected as ${updated.kind}`)
    }
    applied.disabledHiveIds.push(target.hiveId)
  }

  if (plan.enableRosterIndex !== null) {
    // Resolved against the roster as it stood before this mutation: the add and
    // the removal above already shifted the live positions.
    const target = rosterBefore[plan.enableRosterIndex]
    const updated = await registry.setEnabled(target.id, true)
    if (updated.kind !== "updated") {
      throw new Error(`mid-run enable was rejected as ${updated.kind}`)
    }
    applied.enabledHiveIds.push(target.hiveId)
  }
}

/**
 * A coordinator over a real Member_Registry and a real Redemption_History, both
 * backed by a store whose flush resolves without writing a file, and a stub
 * upstream client replaying the scripted sequence.
 *
 * The roster is seeded through the registry itself, so the fixed list the
 * coordinator snapshots comes from the same `listEnabled()` the application uses
 * (Requirements 1.1, 1.6, 1.9).
 */
async function createHarness(testCase: EarlyStopCase): Promise<Harness> {
  const store = createJsonStore({
    dataFilePath: join(
      tmpdir(),
      `scr-early-stop-${randomUUID()}`,
      "store.json"
    ),
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

  for (const entry of testCase.roster) {
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

  // Read before the run: this is the list the coordinator fixes at run start,
  // and the roster the generated mutation targets are indexed against.
  const snapshot = registry.listEnabled()
  const rosterBefore = registry.list()
  const applied: AppliedMutation = {
    addedHiveIds: [],
    removedHiveIds: [],
    disabledHiveIds: [],
    enabledHiveIds: [],
  }

  const { mutation } = testCase
  const upstream = new StubUpstreamClient({
    script: [
      ...testCase.steps.map(toScriptEntry),
      // Surplus answers, so an over-issuing loop is caught by the request-count
      // assertion rather than by an exhausted script turning the run into a
      // server failure.
      ...Array.from({ length: SURPLUS_STEPS }, () =>
        respondWithBody(FIXTURE_BODIES["success-100.json"])
      ),
    ],
    gate:
      mutation === null
        ? undefined
        : async ({ callIndex }) => {
            if (callIndex !== mutation.atCallIndex) return
            await applyMutation(
              registry,
              snapshot,
              rosterBefore,
              mutation,
              applied
            )
          },
  })

  const history = createHistoryStore(store)
  const coordinator = createRunCoordinator({ registry, history, upstream })

  return {
    registry,
    history,
    upstream,
    snapshot,
    applied,
    run: async (couponCode) => {
      const events: RunEvent[] = []
      for await (const event of coordinator.start(couponCode)) {
        events.push(event)
      }
      return events
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Assertion helpers                                                          */
/* -------------------------------------------------------------------------- */

/** The terminal event of the run, which carries the complete result set. */
function terminalResult(events: readonly RunEvent[]): RedemptionRunResult {
  const terminal = events.at(-1)
  if (terminal === undefined || terminal.type !== "run-completed") {
    throw new Error(
      `expected a run-completed event, got ${terminal?.type ?? "no event at all"}`
    )
  }
  return terminal.result
}

/** The scripted response of a position, which is the oracle for its outcome. */
function responseStepAt(
  steps: readonly StubStep[],
  position: number
): Extract<StubStep, { kind: "response" }> {
  const step = steps[position]
  if (step.kind !== "response") {
    throw new Error(`position ${position} holds no scripted response`)
  }
  return step
}

/** The Upstream_Result the Response_Parser derives from a scripted response. */
function expectedUpstreamResult(
  step: Extract<StubStep, { kind: "response" }>
): ReturnType<typeof parseUpstreamBody> {
  return parseUpstreamBody({
    bodyText: step.response.bodyText,
    transportFailure: step.response.transportFailure,
  })
}

/* -------------------------------------------------------------------------- */
/* Property                                                                   */
/* -------------------------------------------------------------------------- */

describe("Redemption_Run early stop on INVALID_COUPON", () => {
  // Feature: shared-coupon-redemption, Property 6: An invalid coupon stops the
  // run and skips exactly the remainder — For any Member_Registry with at least
  // one enabled Group_Member and any stubbed response sequence in which some
  // position yields INVALID_COUPON, the Redemption_Run issues no Upstream_API
  // request after that position, reports INVALID_COUPON at that position,
  // reports SKIPPED for exactly the Group_Members positioned after it in the
  // list fixed at run start, and leaves the Member_Outcomes of the
  // Group_Members before it unchanged — even when the Member_Registry is mutated
  // while the run is in progress.
  // Validates: Requirements 5.1, 5.2, 5.3, 5.5
  it("issues no request after the invalid coupon and skips exactly the remainder", async () => {
    await fc.assert(
      fc.asyncProperty(earlyStopCaseArb, async (testCase) => {
        const harness = await createHarness(testCase)
        const fixedList = harness.snapshot
        const stopIndex = testCase.stopIndex

        // The seeded Member_Registry produces the same fixed list the scenario
        // was generated against, so the scripted positions line up.
        expect(fixedList.map((member) => member.hiveId)).toEqual(
          testCase.fixedList.map((member) => member.hiveId)
        )

        const events = await harness.run(testCase.couponCode)
        const result = terminalResult(events)

        /* Requirement 5.1: the requests stop at the invalid coupon. */
        expect(harness.upstream.callCount).toBe(stopIndex + 1)
        expect(
          harness.upstream.requests.map((request) => request.hiveid)
        ).toEqual(
          fixedList.slice(0, stopIndex + 1).map((member) => member.hiveId)
        )
        for (const request of harness.upstream.requests) {
          expect(request.coupon).toBe(testCase.couponCode)
        }

        /* Requirement 5.7: an early stop is a completed run, recorded once. */
        expect(result.stoppedEarly).toBe(true)
        const records = harness.history.list()
        expect(records).toHaveLength(1)
        expect(records[0].couponCode).toBe(testCase.couponCode)
        expect(records[0].stoppedEarly).toBe(true)
        expect(records[0].outcomes).toHaveLength(fixedList.length)

        /*
         * Requirement 5.5: the reported Member_Outcomes are the entries of the
         * list fixed at run start, in that order — whatever happened to the
         * Member_Registry in the meantime.
         */
        expect(result.outcomes.map((outcome) => outcome.hiveId)).toEqual(
          fixedList.map((member) => member.hiveId)
        )
        result.outcomes.forEach((outcome, position) => {
          expect(outcome.position).toBe(position)
          expect(outcome.memberLabel).toBe(fixedList[position].memberLabel)
        })

        /* Requirement 5.3: the stopping position reports INVALID_COUPON. */
        const stopStep = responseStepAt(testCase.steps, stopIndex)
        const stopOutcome = result.outcomes[stopIndex]
        expect(stopOutcome.outcome).toBe("INVALID_COUPON")
        expect(stopOutcome.upstreamResult).toEqual(
          expectedUpstreamResult(stopStep)
        )

        /*
         * Requirement 5.3: every earlier Group_Member keeps the Member_Outcome
         * derived during the run, unchanged.
         */
        for (let position = 0; position < stopIndex; position += 1) {
          const step = responseStepAt(testCase.steps, position)
          const outcome = result.outcomes[position]
          expect(outcome.outcome).toBe(step.outcome)
          expect(outcome.upstreamResult).toEqual(expectedUpstreamResult(step))
        }

        /*
         * Requirement 5.2: the Group_Members reported SKIPPED are exactly the
         * ones positioned after the stop, and none of them carries an
         * Upstream_Result, because no request was issued for them.
         */
        const skipped = result.outcomes.filter(
          (outcome) => outcome.outcome === "SKIPPED"
        )
        expect(skipped.map((outcome) => outcome.hiveId)).toEqual(
          fixedList.slice(stopIndex + 1).map((member) => member.hiveId)
        )
        for (const outcome of skipped) {
          expect(outcome.upstreamResult).toBeNull()
        }

        const { mutation } = testCase
        if (mutation === null) return

        /*
         * Requirement 5.5, the mutating half: the Member_Registry really did
         * change while the run was in progress, and the run neither picked up
         * the entry that joined nor dropped the entry that left.
         */
        const { addedHiveIds, removedHiveIds } = harness.applied
        expect(addedHiveIds).toHaveLength(1)
        expect(removedHiveIds).toHaveLength(1)

        const rosterAfter = harness.registry.list().map((entry) => entry.hiveId)
        expect(rosterAfter).toContain(addedHiveIds[0])
        expect(rosterAfter).not.toContain(removedHiveIds[0])

        const requested = harness.upstream.requests.map(
          (request) => request.hiveid
        )
        const reported = result.outcomes.map((outcome) => outcome.hiveId)
        for (const hiveId of [
          ...addedHiveIds,
          ...harness.applied.enabledHiveIds,
        ]) {
          expect(requested).not.toContain(hiveId)
          expect(reported).not.toContain(hiveId)
        }
        // The removed and the disabled entries were part of the fixed list, so
        // they still hold exactly one Member_Outcome each.
        for (const hiveId of [
          ...removedHiveIds,
          ...harness.applied.disabledHiveIds,
        ]) {
          expect(reported.filter((value) => value === hiveId)).toHaveLength(1)
        }
      }),
      { numRuns: 100 }
    )
  })
})
