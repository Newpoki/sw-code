/**
 * The history-append failure warning (Requirement 6.8 of the
 * shared-coupon-redemption spec, superseded in wording by Requirement 3.7 of the
 * mongodb-google-auth-admin spec).
 *
 * Requirement 6.8 is a *both* claim, not a single one: when appending the
 * Redemption_History record fails, the Member_Outcomes of the completed
 * Redemption_Run still come back **and** exactly one warning states that the
 * record was not saved. A test that only checked the warning would pass against a
 * coordinator that dropped the result set, and a test that only checked the
 * outcomes would pass against one that stayed silent. So every case below
 * asserts the complete result set — one Member_Outcome per fixed-list entry,
 * with the right outcome values, and all six counts — together with
 * `warnings` being exactly `[HISTORY_NOT_PERSISTED_WARNING]`: one warning, not
 * zero and not two.
 *
 * Four cases, because "the append failed" has more than one shape:
 *
 *   1. A deployment that refuses the `insertOne`. `HistoryStore.append` resolves
 *      with `failed`, which is the ordinary Requirement 3.7 case: nothing was
 *      written, not even partially, and the retention trim is never reached.
 *   2. The complement: the same run against a deployment that serves the insert
 *      yields `warnings: []` and one stored record. This is what proves the
 *      warning accompanies only the failing case rather than being attached to
 *      every run.
 *   3. A `HistoryStore` whose `append` rejects outright. The coordinator catches
 *      it (`appendHistoryRecord`), so the run still ends in `run-completed`, the
 *      outcomes survive, and the same single warning is produced. Nothing
 *      escapes to the consumer as an error.
 *   4. An early-stop run (a scripted `INVALID_COUPON`) against the same refusing
 *      deployment: the `SKIPPED` Member_Outcomes are returned alongside the
 *      single warning.
 *
 * **No seeding noise to work around.** The roster and the Redemption_History are
 * two collections of one in-memory Mongo_Store, and a rejection is injected per
 * collection and per method — so `history.insertOne` can refuse while every
 * roster write keeps working. The failure is therefore installed once, up front,
 * and every seeding add is still asserted to have landed.
 *
 * No filesystem and no deployment is touched: the store is the in-memory
 * {@link MongoStore} of `tests/support/inMemoryMongoStore.ts`.
 */

import { MongoServerError } from "mongodb"
import { describe, expect, it } from "vitest"

import { parseUpstreamBody } from "@/domain/responseParser"
import type {
  MemberOutcomeValue,
  MemberRegistryEntry,
  OutcomeCounts,
  RedemptionHistoryRecord,
  RedemptionRunResult,
  RunEvent,
} from "@/domain/types"
import {
  HISTORY_NOT_PERSISTED_WARNING,
  createRunCoordinator,
} from "@/server/run/coordinator.server"
import { createHistoryStore } from "@/server/store/history.server"
import type {
  AppendHistoryInput,
  AppendHistoryResult,
  HistoryStore,
} from "@/server/store/history.server"
import { createMemberRegistryStore } from "@/server/store/memberRegistry.server"
import type { MemberRegistryStore } from "@/server/store/memberRegistry.server"

import {
  StubUpstreamClient,
  respondWithBody,
  respondWithTransportFailure,
} from "../support/stubUpstreamClient"
import type { StubScriptEntry } from "../support/stubUpstreamClient"
import { createInMemoryMongoStore } from "../support/inMemoryMongoStore"
import type { InMemoryMongoStoreHandle } from "../support/inMemoryMongoStore"
import { FIXTURE_BODIES } from "../property/generators"

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** The Coupon_Code every run below submits. */
const COUPON_CODE = "SW2025NEWYEAR"

/** Cause of the injected `HistoryStore.append` rejection of case 3. */
const APPEND_FAILURE_MESSAGE = "history append exploded"

/** Fixed clocks, so `createdAt` and `completedAt` are deterministic. */
const SEED_TIME = Date.parse("2025-01-04T18:00:00.000Z")
const RUN_TIME = Date.parse("2025-01-04T18:24:55.900Z")

const RUN_ID = "run-history-append-failure"

/** A small roster: four enabled Group_Members, seeded in this order. */
const ROSTER: readonly { memberLabel: string; hiveId: string }[] = [
  { memberLabel: "Alice", hiveId: "hive-alice" },
  { memberLabel: "Bob", hiveId: "hive-bob" },
  { memberLabel: "Carol", hiveId: "hive-carol" },
  { memberLabel: "Dave", hiveId: "hive-dave" },
]

/** An Upstream_API body holding a code none of the three documented ones is. */
const UNKNOWN_CODE_BODY = '{"retCode":"(H999)","retMsg":"Server is busy."}'

/**
 * A run over the whole roster with one Member_Outcome of four different kinds,
 * so the counts assertion has something to distinguish rather than four
 * identical values.
 */
const FULL_RUN_SCRIPT: readonly StubScriptEntry[] = [
  respondWithBody(FIXTURE_BODIES["success-100.json"]),
  respondWithBody(FIXTURE_BODIES["already-used-h304.json"]),
  respondWithTransportFailure("timeout"),
  respondWithBody(UNKNOWN_CODE_BODY),
]

const FULL_RUN_OUTCOMES: readonly MemberOutcomeValue[] = [
  "SUCCESS",
  "ALREADY_USED",
  "TRANSPORT_ERROR",
  "UPSTREAM_ERROR",
]

const FULL_RUN_COUNTS: OutcomeCounts = {
  SUCCESS: 1,
  ALREADY_USED: 1,
  INVALID_COUPON: 0,
  SKIPPED: 0,
  UPSTREAM_ERROR: 1,
  TRANSPORT_ERROR: 1,
}

/** A run that stops early: the second Group_Member yields `INVALID_COUPON`. */
const EARLY_STOP_SCRIPT: readonly StubScriptEntry[] = [
  respondWithBody(FIXTURE_BODIES["success-100.json"]),
  respondWithBody(FIXTURE_BODIES["invalid-coupon-h306.json"]),
  // Surplus answers: a loop that kept going past the early stop is caught by
  // the request-count assertion rather than by an exhausted script.
  respondWithBody(FIXTURE_BODIES["success-100.json"]),
  respondWithBody(FIXTURE_BODIES["success-100.json"]),
]

const EARLY_STOP_OUTCOMES: readonly MemberOutcomeValue[] = [
  "SUCCESS",
  "INVALID_COUPON",
  "SKIPPED",
  "SKIPPED",
]

const EARLY_STOP_COUNTS: OutcomeCounts = {
  SUCCESS: 1,
  ALREADY_USED: 0,
  INVALID_COUPON: 1,
  SKIPPED: 2,
  UPSTREAM_ERROR: 0,
  TRANSPORT_ERROR: 0,
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

/** One observed `HistoryStore.append` call. */
interface AppendAttempt {
  readonly input: AppendHistoryInput
  /** The `kind` the append reported, or null when it rejected. */
  readonly kind: AppendHistoryResult["kind"] | null
}

/** How the wrapped {@link HistoryStore} behaves on `append`. */
type AppendBehaviour = "delegate" | "reject"

interface HarnessOptions {
  readonly script: readonly StubScriptEntry[]
  /** Defaults to `"delegate"`, i.e. the real Redemption_History append. */
  readonly appendBehaviour?: AppendBehaviour
  /** Whether the deployment refuses the history insert. Defaults to true. */
  readonly refuseHistoryInsert?: boolean
}

interface Harness {
  readonly registry: MemberRegistryStore
  /** The real Redemption_History, read to check what actually got stored. */
  readonly history: HistoryStore
  /** The store behind both collections, for the stored documents. */
  readonly handle: InMemoryMongoStoreHandle
  readonly upstream: StubUpstreamClient
  /** Every `append` the coordinator issued, in call order. */
  readonly appends: readonly AppendAttempt[]
  /** The fixed list of the run, read before it starts. */
  readonly fixedList: readonly MemberRegistryEntry[]
  readonly run: (couponCode: string) => Promise<readonly RunEvent[]>
  /** The stored Redemption_History records, newest first. */
  readonly storedRecords: () => Promise<readonly RedemptionHistoryRecord[]>
}

/**
 * Wraps a real {@link HistoryStore} so the coordinator's single `append` is
 * observable, and — for case 3 — so it rejects instead of resolving.
 *
 * `reject` records the attempt before throwing, so a test can still assert that
 * the coordinator tried exactly once.
 */
function observableHistory(
  inner: HistoryStore,
  behaviour: AppendBehaviour
): { readonly history: HistoryStore; readonly appends: AppendAttempt[] } {
  const appends: AppendAttempt[] = []

  return {
    appends,
    history: {
      list: inner.list,
      findLatestByCouponCode: inner.findLatestByCouponCode,
      append: async (input) => {
        if (behaviour === "reject") {
          appends.push({ input, kind: null })
          return Promise.reject(new Error(APPEND_FAILURE_MESSAGE))
        }
        const result = await inner.append(input)
        appends.push({ input, kind: result.kind })
        return result
      },
    },
  }
}

/**
 * A coordinator over a real Member_Registry and a real Redemption_History, both
 * over one in-memory Mongo_Store, plus a stub upstream client replaying
 * `script`.
 *
 * The roster is seeded through the registry itself — the same `add` /
 * `listEnabled` path the application uses — and the injected refusal reaches
 * only the `history` collection's `insertOne`, so seeding cannot fail for a
 * reason the run is about to assert.
 */
async function createHarness(options: HarnessOptions): Promise<Harness> {
  const handle = createInMemoryMongoStore()

  let nextId = 0
  const registry = createMemberRegistryStore(handle.store, {
    generateId: () => {
      nextId += 1
      return `m-${nextId}`
    },
    now: () => new Date(SEED_TIME),
  })

  for (const member of ROSTER) {
    const added = await registry.add(member)
    if (added.kind !== "added") {
      throw new Error(
        `could not seed roster entry ${JSON.stringify(member.hiveId)}: ${added.kind}`
      )
    }
  }

  const realHistory = createHistoryStore(handle.store, {
    logger: handle.logger,
  })
  const { history, appends } = observableHistory(
    realHistory,
    options.appendBehaviour ?? "delegate"
  )
  const upstream = new StubUpstreamClient({ script: options.script })
  const coordinator = createRunCoordinator({
    registry,
    history,
    upstream,
    now: () => new Date(RUN_TIME),
    generateRunId: () => RUN_ID,
  })

  const roster = await registry.listEnabled()
  if (roster.kind !== "entries") {
    throw new Error(`the roster read reported "${roster.kind}" while seeding`)
  }

  if (options.refuseHistoryInsert ?? true) {
    handle.setRejection(
      "history",
      "insertOne",
      new MongoServerError({
        message: "Document failed validation",
        code: 121,
      })
    )
  }

  return {
    registry,
    history: realHistory,
    handle,
    upstream,
    appends,
    fixedList: roster.entries,
    run: async (couponCode) => {
      const events: RunEvent[] = []
      for await (const event of coordinator.start(couponCode)) {
        events.push(event)
      }
      return events
    },
    storedRecords: async () => {
      handle.clearRejection("history", "insertOne")
      const listed = await realHistory.list()
      if (listed.kind !== "records") {
        throw new Error(`the history read reported "${listed.kind}"`)
      }
      return listed.records
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Assertion helpers                                                          */
/* -------------------------------------------------------------------------- */

/** The terminal `run-completed` event, which carries the complete result set. */
function completedResult(events: readonly RunEvent[]): RedemptionRunResult {
  const terminal = events.at(-1)
  if (terminal === undefined || terminal.type !== "run-completed") {
    throw new Error(
      `expected a run-completed event, got ${terminal?.type ?? "no event at all"}`
    )
  }
  return terminal.result
}

/**
 * Asserts the complete result set: one Member_Outcome per fixed-list entry, in
 * processing order, holding the expected outcome value, and all six counts.
 *
 * A `SKIPPED` Member_Outcome carries no Upstream_Result — no request was issued
 * for it — while every other one carries the Upstream_Result the
 * Response_Parser derives from the scripted response of that position.
 */
function expectCompleteResultSet(
  result: RedemptionRunResult,
  fixedList: readonly MemberRegistryEntry[],
  script: readonly StubScriptEntry[],
  expectedOutcomes: readonly MemberOutcomeValue[],
  expectedCounts: OutcomeCounts
): void {
  expect(result.outcomes).toHaveLength(fixedList.length)
  expect(result.outcomes.map((outcome) => outcome.hiveId)).toEqual(
    fixedList.map((member) => member.hiveId)
  )
  expect(result.outcomes.map((outcome) => outcome.memberLabel)).toEqual(
    fixedList.map((member) => member.memberLabel)
  )
  expect(result.outcomes.map((outcome) => outcome.position)).toEqual(
    fixedList.map((_unused, position) => position)
  )
  expect(result.outcomes.map((outcome) => outcome.outcome)).toEqual(
    expectedOutcomes
  )

  result.outcomes.forEach((outcome, position) => {
    if (outcome.outcome === "SKIPPED") {
      expect(outcome.upstreamResult).toBeNull()
      return
    }
    const entry = script[position]
    if (entry.kind !== "respond") {
      throw new Error(`position ${position} holds no scripted response`)
    }
    expect(outcome.upstreamResult).toEqual(
      parseUpstreamBody({
        bodyText: entry.response.bodyText,
        transportFailure: entry.response.transportFailure,
      })
    )
  })

  expect(result.counts).toEqual(expectedCounts)
  expect(
    Object.values(result.counts).reduce((sum, count) => sum + count, 0)
  ).toBe(fixedList.length)

  expect(result.runId).toBe(RUN_ID)
  expect(result.couponCode).toBe(COUPON_CODE)
  expect(result.completedAt).toBe(new Date(RUN_TIME).toISOString())
}

/**
 * Asserts the Requirement 6.8 warning: exactly one, character-identical to
 * {@link HISTORY_NOT_PERSISTED_WARNING}.
 *
 * The constant is compared rather than its text. Task 12.1 rewords it to the
 * `historyAppendFailedMessage()` sentence of Requirement 3.7, and this claim —
 * one warning, that one — is what has to hold either way.
 */
function expectSingleNotPersistedWarning(result: RedemptionRunResult): void {
  expect(result.warnings).toEqual([HISTORY_NOT_PERSISTED_WARNING])
  expect(result.warnings).toHaveLength(1)
}

/* -------------------------------------------------------------------------- */
/* Requirement 6.8                                                            */
/* -------------------------------------------------------------------------- */

describe("a failed Redemption_History append returns the outcomes with one warning (Requirement 6.8)", () => {
  it("returns the complete result set and exactly one warning when the insert is refused", async () => {
    const harness = await createHarness({ script: FULL_RUN_SCRIPT })
    expect(harness.fixedList).toHaveLength(ROSTER.length)

    const events = await harness.run(COUPON_CODE)
    const result = completedResult(events)

    // The run completed: one request per Group_Member, and the terminal event is
    // `run-completed`, not `run-failed`.
    expect(harness.upstream.callCount).toBe(ROSTER.length)
    expect(events.map((event) => event.type)).toEqual([
      "run-started",
      "member-outcome",
      "member-outcome",
      "member-outcome",
      "member-outcome",
      "run-completed",
    ])
    expect(result.stoppedEarly).toBe(false)

    // The Member_Outcomes are all still there, and all still correct.
    expectCompleteResultSet(
      result,
      harness.fixedList,
      FULL_RUN_SCRIPT,
      FULL_RUN_OUTCOMES,
      FULL_RUN_COUNTS
    )

    // One warning, stating that the record was not saved.
    expectSingleNotPersistedWarning(result)

    // The append was attempted exactly once and reported the failure it saw.
    expect(harness.appends).toHaveLength(1)
    expect(harness.appends[0].kind).toBe("failed")
    expect(harness.appends[0].input.couponCode).toBe(COUPON_CODE)

    /* Requirement 3.7: nothing was written, not even partially, and the
     * retention trim was never reached — so no record was deleted either and no
     * retention warning was logged. */
    expect(harness.handle.history()).toEqual([])
    expect(harness.handle.callsTo("history")).not.toContain("deleteMany")
    expect(harness.handle.warnings).toEqual([])
  })

  it("returns zero warnings and one stored record when the insert is served", async () => {
    const harness = await createHarness({
      script: FULL_RUN_SCRIPT,
      refuseHistoryInsert: false,
    })

    const result = completedResult(await harness.run(COUPON_CODE))

    // Same run, same Member_Outcomes.
    expectCompleteResultSet(
      result,
      harness.fixedList,
      FULL_RUN_SCRIPT,
      FULL_RUN_OUTCOMES,
      FULL_RUN_COUNTS
    )

    // The warning accompanies only the failing case: none here.
    expect(result.warnings).toEqual([])
    expect(harness.handle.warnings).toEqual([])

    // Exactly one Redemption_History record, appended once and stored.
    expect(harness.appends).toHaveLength(1)
    expect(harness.appends[0].kind).toBe("appended")

    const records = await harness.storedRecords()
    expect(records).toHaveLength(1)
    expect(records[0].runId).toBe(RUN_ID)
    expect(records[0].couponCode).toBe(COUPON_CODE)
    expect(records[0].completedAt).toBe(new Date(RUN_TIME).toISOString())
    expect(records[0].outcomes.map((row) => row.outcome)).toEqual(
      FULL_RUN_OUTCOMES
    )
  })

  it("survives a HistoryStore whose append rejects outright, with the same single warning", async () => {
    const harness = await createHarness({
      script: FULL_RUN_SCRIPT,
      appendBehaviour: "reject",
      // The collection is irrelevant here: `append` never reaches it.
      refuseHistoryInsert: false,
    })

    // Nothing escapes as an error: iterating the run resolves normally.
    const events = await harness.run(COUPON_CODE)
    const result = completedResult(events)

    expectCompleteResultSet(
      result,
      harness.fixedList,
      FULL_RUN_SCRIPT,
      FULL_RUN_OUTCOMES,
      FULL_RUN_COUNTS
    )
    expectSingleNotPersistedWarning(result)

    // Attempted once, and not retried after the rejection.
    expect(harness.appends).toHaveLength(1)
    expect(harness.appends[0].kind).toBeNull()

    // The rejection happened before the real store was touched, so nothing was
    // recorded and nothing was logged.
    expect(harness.handle.callsTo("history")).toEqual([])
    expect(await harness.storedRecords()).toEqual([])
    expect(harness.handle.warnings).toEqual([])
  })

  it("returns the SKIPPED outcomes of an early-stopped run with the single warning", async () => {
    const harness = await createHarness({ script: EARLY_STOP_SCRIPT })

    const events = await harness.run(COUPON_CODE)
    const result = completedResult(events)

    // The early stop held: no request after the invalid coupon.
    expect(harness.upstream.callCount).toBe(2)
    expect(harness.upstream.requests.map((request) => request.hiveid)).toEqual([
      "hive-alice",
      "hive-bob",
    ])
    expect(result.stoppedEarly).toBe(true)

    // Requirement 6.8 over an early stop: the SKIPPED Member_Outcomes are part
    // of the returned result set, and the warning is still exactly one.
    expectCompleteResultSet(
      result,
      harness.fixedList,
      EARLY_STOP_SCRIPT,
      EARLY_STOP_OUTCOMES,
      EARLY_STOP_COUNTS
    )
    expectSingleNotPersistedWarning(result)

    expect(harness.appends).toHaveLength(1)
    expect(harness.appends[0].kind).toBe("failed")
    expect(harness.appends[0].input.stoppedEarly).toBe(true)
    expect(harness.handle.history()).toEqual([])
  })
})
