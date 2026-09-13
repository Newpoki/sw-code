/**
 * A full Redemption_Run, end to end (Requirements 3.1, 5.6, 6.1, 6.3, 6.5).
 *
 * This is the happy-path complement to `tests/integration/redemptionPreflight.test.ts`.
 * That file drives the same pipeline into its four rejections, where nothing is
 * requested and nothing is recorded; here the pipeline is driven all the way
 * through, over a roster that holds **disabled entries as well as enabled ones**,
 * and everything a run produces is asserted at once:
 *
 *   1. **The event stream** — exactly one `run-started`, then exactly one
 *      `member-outcome` per enabled Group_Member with `processed` counting
 *      1..total, then exactly one terminal event, with no event of any kind for a
 *      disabled entry (Requirements 3.1, 6.1).
 *   2. **The requests issued** — one `useCoupon` call per enabled Group_Member,
 *      in Member_Registry order, and nothing else. The `UpstreamClient` boundary
 *      declares no `checkUser`, so the recorded call list holding only
 *      `useCoupon` requests is the whole statement (Requirement 3.4). The three
 *      Fixed_Request_Fields are asserted on the wire in their own case below,
 *      where the run is driven through a real `LiveUpstreamClient` over an
 *      injected `fetch` (Requirement 3.3).
 *   3. **The complete result set** — one Member_Outcome per enabled
 *      Group_Member, no duplicate Hive_ID, none for a disabled entry, in
 *      processing order with `position` equal to the index, each carrying the
 *      Member_Label and the Upstream_Result its response produced
 *      (Requirements 3.1, 5.6, 6.1).
 *   4. **The six counts** — all six keys present including the zeros, summing to
 *      the outcome count, and agreeing with the outcomes they summarize
 *      (Requirement 6.3).
 *   5. **The one Redemption_History record** — the submitted Coupon_Code
 *      character for character, the completion timestamp, the Mock_Mode flag,
 *      and one denormalized row per enabled entry (Requirement 6.5).
 *
 * Three runs are exercised, because the three shapes a completed run can take
 * make different claims: an all-success run, a mixed run in which an `(H304)`
 * answer must *not* stop the run, and an `(H306)` run that must stop it with the
 * remainder recorded `SKIPPED`. All three read their response bodies from
 * `fixtures/upstream/` through `FIXTURE_BODIES`, so the answers are the
 * documented ones rather than a restatement of them, and the expected
 * Upstream_Result of each position comes from the Response_Parser applied to
 * that same body rather than from a hand-written literal.
 *
 * ## Why the seam is `runRedemptionEvents`
 *
 * `createServerFn(...).handler(fn)` cannot be invoked outside the framework, so
 * `src/functions/redemption.functions.ts` is a thin wrapper over
 * {@link runRedemptionEvents}, which takes its collaborators as a parameter.
 * Driving that function is therefore the deepest point a test can reach, and it
 * still exercises the whole pre-flight-plus-coordinator pipeline: the length
 * check, the Mock_Mode fixture check, the single-run lock, the fixed list, the
 * run loop, and the Redemption_History append.
 *
 * The collaborators are real apart from the Upstream_API: an actual
 * `RunCoordinator` over an actual Member_Registry and an actual
 * Redemption_History, both over an actual `JsonStore`. Only the network is
 * replaced.
 *
 * ## What is not touched
 *
 * `./data/store.json` is never written: every store is built over an unused path
 * under the system temporary directory with the flush replaced by a resolved
 * promise, so no file and no directory is created. The network is never reached
 * either — the global `fetch` is replaced by a throwing spy that `afterEach`
 * asserts was never called.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { parseUpstreamBody } from "@/domain/responseParser"
import { MEMBER_OUTCOME_VALUES } from "@/domain/types"
import type {
  MemberOutcomeValue,
  RedemptionRunResult,
  RunEvent,
  UpstreamResult,
} from "@/domain/types"
import { createRunCoordinator } from "@/server/run/coordinator.server"
import type { RunCoordinator } from "@/server/run/coordinator.server"
import {
  readActiveRun,
  runRedemptionEvents,
} from "@/server/run/redemptionRequest.server"
import type { RedemptionCollaborators } from "@/server/run/redemptionRequest.server"
import { createHistoryStore } from "@/server/store/history.server"
import type { HistoryStore } from "@/server/store/history.server"
import { createMemberRegistryStore } from "@/server/store/memberRegistry.server"
import type { UpstreamClient } from "@/server/upstream/client"
import {
  FIXED_REQUEST_FIELDS,
  USE_COUPON_PATH,
  createLiveUpstreamClient,
} from "@/server/upstream/live.server"
import type {
  UpstreamFetch,
  UpstreamFetchInit,
} from "@/server/upstream/live.server"

import { FIXTURE_BODIES, FIXTURE_OUTCOMES } from "../property/generators"
import type { FixtureFileName } from "../property/generators"
import {
  StubUpstreamClient,
  respondWithBody,
} from "../support/stubUpstreamClient"
import { createInMemoryMongoStore } from "../support/inMemoryMongoStore"

/** Fixed clock, so `startedAt` and `completedAt` are predictable. */
const FIXED_TIME = Date.parse("2025-01-06T11:15:00.000Z")

/**
 * The submitted Coupon_Code. Mixed case and a digit group, so the
 * character-for-character claims of Requirements 6.5 and 6.7 are asserted on a
 * value that a case fold or a normalization step would visibly damage.
 */
const COUPON_CODE = "FullRun-2025-Ete"

/** Upstream_API base URL of the live-client case; nothing connects to it. */
const BASE_URL = "https://event.withhive.test/ci/smon/evt_coupon"

/** One roster entry to seed, in the words of the Member_Registry. */
interface RosterSeed {
  readonly memberLabel: string
  readonly hiveId: string
  readonly enabled: boolean
}

/**
 * The roster of every case: six Group_Members, two of them disabled, with a
 * disabled entry in the middle and another one next to the last enabled entry,
 * so a loop that read the roster instead of the fixed list would report a
 * disabled Group_Member at a position the assertions notice.
 */
const ROSTER: readonly RosterSeed[] = [
  { memberLabel: "Ada", hiveId: "hive-ada", enabled: true },
  { memberLabel: "Bruno", hiveId: "hive-bruno", enabled: false },
  { memberLabel: "Chen", hiveId: "hive-chen", enabled: true },
  { memberLabel: "Dmitri", hiveId: "hive-dmitri", enabled: true },
  { memberLabel: "Elif", hiveId: "hive-elif", enabled: false },
  { memberLabel: "Farah", hiveId: "hive-farah", enabled: true },
]

/** The fixed list a run over {@link ROSTER} must process (Requirement 5.5). */
const ENABLED: readonly RosterSeed[] = ROSTER.filter((entry) => entry.enabled)

/** The entries that must appear nowhere in a run (Requirement 5.6). */
const DISABLED: readonly RosterSeed[] = ROSTER.filter((entry) => !entry.enabled)

function spyOnFetch() {
  return vi.spyOn(globalThis, "fetch")
}

let fetchSpy: ReturnType<typeof spyOnFetch>

beforeEach(() => {
  fetchSpy = spyOnFetch().mockImplementation(() => {
    throw new Error("no case in this file may reach the network")
  })
})

afterEach(() => {
  expect(fetchSpy, "no run reached the global fetch").not.toHaveBeenCalled()
  vi.restoreAllMocks()
})

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface Harness {
  readonly collaborators: RedemptionCollaborators
  readonly coordinator: RunCoordinator
  readonly history: HistoryStore
}

/**
 * A coordinator over a real Member_Registry and a real Redemption_History, both
 * backed by a store at an unused temporary path whose flush resolves without
 * writing anything, plus the given Upstream_API client.
 *
 * The roster is seeded through the registry rather than injected, so the fixed
 * list the coordinator snapshots comes from the same `listEnabled()` the
 * application uses — which is what makes "a disabled entry appears nowhere in the
 * run" an exercise of the roster rather than of a stub.
 *
 * The clock is fixed and the run id is a counter, so a run's event stream is a
 * pure function of the roster and the scripted responses.
 */
async function createHarness(upstream: UpstreamClient): Promise<Harness> {
  const handle = createInMemoryMongoStore({
    logger: { warn: () => undefined },
  })
  const store = handle.store

  let nextMemberId = 0
  const registry = createMemberRegistryStore(store, {
    generateId: () => {
      nextMemberId += 1
      return `m-${nextMemberId}`
    },
    now: () => new Date(FIXED_TIME),
  })

  for (const entry of ROSTER) {
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
  let nextRunNumber = 0
  const coordinator = createRunCoordinator({
    registry,
    history,
    upstream,
    now: () => new Date(FIXED_TIME),
    generateRunId: () => {
      nextRunNumber += 1
      return `run-${nextRunNumber}`
    },
  })

  return {
    collaborators: { coordinator, upstream, now: () => new Date(FIXED_TIME) },
    coordinator,
    history,
  }
}

async function collect(
  events: AsyncGenerator<RunEvent, void, void>
): Promise<Array<RunEvent>> {
  const collected: Array<RunEvent> = []
  for await (const event of events) {
    collected.push(event)
  }
  return collected
}

/* -------------------------------------------------------------------------- */
/* Expected outcomes                                                          */
/* -------------------------------------------------------------------------- */

/**
 * What one enabled Group_Member is expected to end the run with.
 *
 * A `fixture` names the documented body its `useCoupon` call is answered with,
 * and the expected Upstream_Result is derived by the Response_Parser from that
 * same body — so this file states which answer arrived, never what parsing it
 * produces. A null `fixture` is a Group_Member no request was issued for, which
 * must end the run `SKIPPED` with no Upstream_Result (Requirement 5.2).
 */
interface ExpectedRow {
  readonly member: RosterSeed
  readonly fixture: FixtureFileName | null
}

function expectedOutcomeValue(row: ExpectedRow): MemberOutcomeValue {
  return row.fixture === null ? "SKIPPED" : FIXTURE_OUTCOMES[row.fixture]
}

function expectedUpstreamResult(row: ExpectedRow): UpstreamResult | null {
  if (row.fixture === null) return null
  return parseUpstreamBody({
    bodyText: FIXTURE_BODIES[row.fixture],
    transportFailure: null,
  })
}

/** The scripted answers of a run: one documented body per issued request. */
function scriptOf(fixtures: readonly FixtureFileName[]) {
  return fixtures.map((fixture) => respondWithBody(FIXTURE_BODIES[fixture]))
}

/* -------------------------------------------------------------------------- */
/* Event-stream assertions                                                    */
/* -------------------------------------------------------------------------- */

type RunStartedEvent = Extract<RunEvent, { readonly type: "run-started" }>
type MemberOutcomeEvent = Extract<RunEvent, { readonly type: "member-outcome" }>
type TerminalEvent = Extract<
  RunEvent,
  { readonly type: "run-completed" | "run-failed" }
>

interface SplitStream {
  readonly started: RunStartedEvent
  readonly outcomes: readonly MemberOutcomeEvent[]
  readonly terminal: TerminalEvent
}

/**
 * Splits a collected stream into its three parts, failing if the shape of
 * Requirement 3.1 is not the shape that arrived: a `run-started` first, one or
 * more `member-outcome` events, and exactly one terminal event, last. Anything
 * else — a second `run-started`, a terminal event mid-stream, a stream that ends
 * without one — throws here rather than being silently sliced away.
 */
function splitStream(events: readonly RunEvent[]): SplitStream {
  expect(
    events.length,
    "a run streams a start, one outcome per Group_Member, and one terminal event"
  ).toBeGreaterThanOrEqual(3)

  const [started] = events
  if (started.type !== "run-started") {
    throw new Error(`the first event is ${started.type}, not run-started`)
  }

  const terminal = events[events.length - 1]
  if (terminal.type !== "run-completed" && terminal.type !== "run-failed") {
    throw new Error(`the last event is ${terminal.type}, not a terminal event`)
  }

  const outcomes: Array<MemberOutcomeEvent> = []
  for (const event of events.slice(1, -1)) {
    if (event.type !== "member-outcome") {
      throw new Error(`a ${event.type} event appeared mid-stream`)
    }
    outcomes.push(event)
  }

  return { started, outcomes, terminal }
}

/**
 * The streamed events of a completed run (Requirements 3.1, 6.1).
 *
 * Asserts the progress contract the Web_Client renders against: one event per
 * enabled Group_Member, `processed` counting 1..total with `total` constant, one
 * run id throughout, the Member_Labels announced up front, and no trace of a
 * disabled entry anywhere in the stream.
 */
function expectStream(
  events: readonly RunEvent[],
  rows: readonly ExpectedRow[],
  mock: boolean
): TerminalEvent {
  const { started, outcomes, terminal } = splitStream(events)
  const total = rows.length

  expect(started.runId).not.toBe("")
  expect(started.total).toBe(total)
  expect(started.mock).toBe(mock)
  expect(started.memberLabels).toEqual(
    rows.map((row) => row.member.memberLabel)
  )

  // One `member-outcome` per enabled Group_Member, and no more.
  expect(outcomes).toHaveLength(total)
  outcomes.forEach((event, index) => {
    expect(event.runId).toBe(started.runId)
    expect(event.processed).toBe(index + 1)
    expect(event.total).toBe(total)
    expect(event.outcome.position).toBe(index)
    expect(event.outcome.hiveId).toBe(rows[index].member.hiveId)
    expect(event.outcome.memberLabel).toBe(rows[index].member.memberLabel)
    expect(event.outcome.outcome).toBe(expectedOutcomeValue(rows[index]))
  })

  // No event mentions a disabled entry, in its labels or in its outcomes.
  const streamedHiveIds = outcomes.map((event) => event.outcome.hiveId)
  for (const entry of DISABLED) {
    expect(streamedHiveIds).not.toContain(entry.hiveId)
    expect(started.memberLabels).not.toContain(entry.memberLabel)
  }

  expect(terminal.runId).toBe(started.runId)
  return terminal
}

/* -------------------------------------------------------------------------- */
/* Result-set assertions                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The six counts, tallied here rather than through `countOutcomes`, so the
 * counts a run reports are compared against an independent count of the very
 * outcomes it reported (Requirement 6.3).
 */
function tally(
  values: readonly MemberOutcomeValue[]
): Record<MemberOutcomeValue, number> {
  const counts = {} as Record<MemberOutcomeValue, number>
  for (const value of MEMBER_OUTCOME_VALUES) {
    counts[value] = 0
  }
  for (const value of values) {
    counts[value] += 1
  }
  return counts
}

/**
 * The complete result set of a run (Requirements 3.1, 5.6, 6.1, 6.3).
 *
 * Requirement 5.6 is the multiset claim: exactly one Member_Outcome per enabled
 * Group_Member, none for a Group_Member absent from the fixed list, so the
 * Hive_IDs reported are the enabled Hive_IDs with no duplicate and no stranger.
 * Requirement 6.1 is the ordering claim, checked through `position`.
 * Requirement 3.1 is the content claim: each outcome carries the Member_Label
 * and the response message of its Upstream_Result.
 */
function expectResultSet(
  result: RedemptionRunResult,
  rows: readonly ExpectedRow[],
  expected: {
    readonly couponCode: string
    readonly mock: boolean
    readonly stoppedEarly: boolean
  }
): void {
  expect(result.couponCode).toBe(expected.couponCode)
  expect(result.mock).toBe(expected.mock)
  expect(result.stoppedEarly).toBe(expected.stoppedEarly)
  expect(result.completedAt).toBe(new Date(FIXED_TIME).toISOString())
  // The success path writes its history record, so nothing warns about it
  // (Requirement 6.8 is the failed-append case and is asserted elsewhere).
  expect(result.warnings).toEqual([])

  // Requirement 5.6: one outcome per enabled Group_Member, no duplicate
  // Hive_ID, and nothing from outside the fixed list.
  expect(result.outcomes).toHaveLength(rows.length)
  expect(result.outcomes).toHaveLength(ENABLED.length)
  const reportedHiveIds = result.outcomes.map((outcome) => outcome.hiveId)
  expect([...reportedHiveIds].sort()).toEqual(
    ENABLED.map((entry) => entry.hiveId).sort()
  )
  expect(new Set(reportedHiveIds).size).toBe(reportedHiveIds.length)
  for (const entry of DISABLED) {
    expect(reportedHiveIds).not.toContain(entry.hiveId)
  }

  // Requirements 3.1, 6.1: processing order, and the Member_Label plus the
  // Upstream_Result of each Group_Member.
  result.outcomes.forEach((outcome, index) => {
    const row = rows[index]
    expect(outcome.position).toBe(index)
    expect(outcome.hiveId).toBe(row.member.hiveId)
    expect(outcome.memberLabel).toBe(row.member.memberLabel)
    expect(outcome.outcome).toBe(expectedOutcomeValue(row))
    expect(outcome.upstreamResult).toEqual(expectedUpstreamResult(row))
  })

  // Requirement 6.3: all six keys, the zeros included, summing to the outcome
  // count and agreeing with the outcomes themselves.
  expect(Object.keys(result.counts).sort()).toEqual(
    [...MEMBER_OUTCOME_VALUES].sort()
  )
  const countValues = Object.values(result.counts)
  expect(countValues).toHaveLength(MEMBER_OUTCOME_VALUES.length)
  expect(countValues.reduce((sum, count) => sum + count, 0)).toBe(
    result.outcomes.length
  )
  expect(result.counts).toEqual(
    tally(result.outcomes.map((outcome) => outcome.outcome))
  )
}

/**
 * The one Redemption_History record a completed run appends (Requirement 6.5).
 *
 * The rows are denormalized, so each one is checked field by field against the
 * roster entry and the Upstream_Result it was copied from; a `SKIPPED` row
 * carries the empty response code and the empty response message, because no
 * request was ever issued for that Group_Member.
 */
async function expectHistoryRecord(
  history: HistoryStore,
  result: RedemptionRunResult,
  rows: readonly ExpectedRow[]
): Promise<void> {
  const listed = await history.list()
  if (listed.kind !== "records") {
    throw new Error(`the history read reported "${listed.kind}"`)
  }
  const records = listed.records
  expect(
    records,
    "exactly one record per completed Redemption_Run"
  ).toHaveLength(1)
  const [record] = records

  expect(record.runId).toBe(result.runId)
  // Character for character, which is what the Requirement 6.7 lookup compares.
  expect(record.couponCode).toBe(result.couponCode)
  expect(record.completedAt).toBe(result.completedAt)
  expect(record.mock).toBe(result.mock)
  expect(record.stoppedEarly).toBe(result.stoppedEarly)

  expect(record.outcomes).toHaveLength(rows.length)
  record.outcomes.forEach((row, index) => {
    const expectedRow = rows[index]
    const upstreamResult = expectedUpstreamResult(expectedRow)
    expect(row).toEqual({
      hiveId: expectedRow.member.hiveId,
      memberLabel: expectedRow.member.memberLabel,
      outcome: expectedOutcomeValue(expectedRow),
      responseCode: upstreamResult?.responseCode ?? "",
      responseMessage: upstreamResult?.responseMessage ?? "",
    })
  })

  // The record the store returns is the one the run reported, so a reader of the
  // Redemption_History sees the same result set the Web_Client just rendered.
  expect(record.outcomes.map((row) => row.outcome)).toEqual(
    result.outcomes.map((outcome) => outcome.outcome)
  )
}

/** The result set of a run that had to complete. */
function completedResult(terminal: TerminalEvent): RedemptionRunResult {
  if (terminal.type !== "run-completed") {
    throw new Error(`the run ended with run-failed: ${terminal.message}`)
  }
  return terminal.result
}

/* -------------------------------------------------------------------------- */
/* 1. The three shapes of a completed Redemption_Run                          */
/* -------------------------------------------------------------------------- */

/** One end-to-end case: the answers scripted, and the run they must produce. */
interface RunCase {
  readonly name: string
  /** One documented body per request the run is expected to issue. */
  readonly fixtures: readonly FixtureFileName[]
  /** The Member_Outcome expected for each enabled Group_Member, in order. */
  readonly rows: readonly ExpectedRow[]
  readonly stoppedEarly: boolean
}

/** Answers positions 0..3 in order; a null tail means no request was issued. */
function rowsFrom(
  fixtures: readonly (FixtureFileName | null)[]
): ExpectedRow[] {
  return ENABLED.map((member, index) => ({
    member,
    fixture: fixtures[index],
  }))
}

const RUN_CASES: readonly RunCase[] = [
  {
    name: "every Group_Member succeeds",
    fixtures: [
      "success-100.json",
      "success-100.json",
      "success-100.json",
      "success-100.json",
    ],
    rows: rowsFrom([
      "success-100.json",
      "success-100.json",
      "success-100.json",
      "success-100.json",
    ]),
    stoppedEarly: false,
  },
  {
    // `(H304)` is ALREADY_USED, which Requirement 5.4 lets the run carry on
    // past: every later Group_Member is still requested.
    name: "an (H304) answer does not stop the run",
    fixtures: [
      "success-100.json",
      "already-used-h304.json",
      "success-100.json",
      "success-100.json",
    ],
    rows: rowsFrom([
      "success-100.json",
      "already-used-h304.json",
      "success-100.json",
      "success-100.json",
    ]),
    stoppedEarly: false,
  },
  {
    // `(H306)` is INVALID_COUPON, which stops the run: only two requests are
    // issued, and the remainder is recorded SKIPPED (Requirements 5.1 - 5.3).
    name: "an (H306) answer stops the run and skips the remainder",
    fixtures: ["success-100.json", "invalid-coupon-h306.json"],
    rows: rowsFrom([
      "success-100.json",
      "invalid-coupon-h306.json",
      null,
      null,
    ]),
    stoppedEarly: true,
  },
]

describe("a full Redemption_Run over a roster holding disabled entries", () => {
  it.each(RUN_CASES)(
    "streams, returns, counts, and records one outcome per enabled Group_Member: $name",
    async (runCase) => {
      // Two surplus answers, so a loop that over-issued requests fails on the
      // request-count assertion below rather than on an exhausted script.
      const upstream = new StubUpstreamClient({
        script: [
          ...scriptOf(runCase.fixtures),
          ...scriptOf(["success-100.json", "success-100.json"]),
        ],
      })
      const { collaborators, coordinator, history } =
        await createHarness(upstream)

      const events = await collect(
        runRedemptionEvents(collaborators, { couponCode: COUPON_CODE })
      )

      /* 1. The streamed events, in order (Requirements 3.1, 6.1). */
      const terminal = expectStream(events, runCase.rows, false)
      const result = completedResult(terminal)

      /*
       * 2. The requests: one `useCoupon` call per Group_Member the run reached,
       * in Member_Registry order, each carrying that Group_Member's Hive_ID and
       * the submitted Coupon_Code, and nothing for a disabled entry. The
       * boundary declares no `checkUser`, so this recorded list is every request
       * the run could have made (Requirements 3.4, 3.5).
       */
      expect(upstream.callCount).toBe(runCase.fixtures.length)
      expect(upstream.requests).toEqual(
        runCase.rows
          .filter((row) => row.fixture !== null)
          .map((row) => ({ hiveid: row.member.hiveId, coupon: COUPON_CODE }))
      )
      expect(
        upstream.maxInFlight,
        "at most one Upstream_API request was in flight"
      ).toBe(1)

      /* 3. and 4. The complete result set and the six counts. */
      expectResultSet(result, runCase.rows, {
        couponCode: COUPON_CODE,
        mock: false,
        stoppedEarly: runCase.stoppedEarly,
      })

      /* 5. The one appended Redemption_History record (Requirement 6.5). */
      await expectHistoryRecord(history, result, runCase.rows)

      // The lock is released, so the next request is admitted.
      expect(readActiveRun(coordinator).ok).toBe(true)
      expect(coordinator.snapshot()).toBeNull()
    }
  )
})

/* -------------------------------------------------------------------------- */
/* 2. The Fixed_Request_Fields, on the wire (Requirement 3.3)                  */
/* -------------------------------------------------------------------------- */

/**
 * The same pipeline, driven over a real `LiveUpstreamClient` whose `fetch` is
 * an injected recorder, so the five fields of Requirement 3.3 are read back off
 * the request bodies exactly as they would leave the process.
 *
 * `StubUpstreamClient` cannot answer this question: the Fixed_Request_Fields are
 * owned by the client implementation and are not part of the `useCoupon`
 * argument, so a stub never sees them. Property 8
 * (`tests/property/fixedRequestFields.property.test.ts`) pins the field builder
 * over generated inputs; what this case adds is that a whole run issues one such
 * request per enabled Group_Member and nothing else.
 */
describe("the requests a full Redemption_Run issues (Requirements 3.3, 3.4)", () => {
  it("posts the five fields to useCoupon once per enabled Group_Member", async () => {
    const calls: Array<{
      readonly url: string
      readonly init: UpstreamFetchInit
    }> = []
    const recordingFetch: UpstreamFetch = (url, init) => {
      calls.push({ url, init })
      return Promise.resolve({
        status: 200,
        text: () => Promise.resolve(FIXTURE_BODIES["success-100.json"]),
      })
    }

    const upstream = createLiveUpstreamClient({
      baseUrl: BASE_URL,
      fetch: recordingFetch,
    })
    const { collaborators, history } = await createHarness(upstream)
    const rows = rowsFrom([
      "success-100.json",
      "success-100.json",
      "success-100.json",
      "success-100.json",
    ])

    const events = await collect(
      runRedemptionEvents(collaborators, { couponCode: COUPON_CODE })
    )
    const result = completedResult(expectStream(events, rows, false))

    // Exactly one request per enabled Group_Member, all of them to `useCoupon`:
    // the run issues no second request for a Group_Member and no `checkUser`.
    expect(calls).toHaveLength(ENABLED.length)
    for (const call of calls) {
      expect(call.url).toBe(`${BASE_URL}/${USE_COUPON_PATH}`)
      expect(call.url).toBe(`${BASE_URL}/useCoupon`)
      expect(call.init.method).toBe("POST")
    }

    calls.forEach((call, index) => {
      const params = new URLSearchParams(call.init.body)
      expect([...params.keys()].sort()).toEqual(
        ["country", "coupon", "hiveid", "lang", "server"].sort()
      )
      // The Fixed_Request_Fields, against the requirement's literals and the
      // exported constants alike.
      expect(params.get("country")).toBe("FR")
      expect(params.get("lang")).toBe("en")
      expect(params.get("server")).toBe("europe")
      expect(params.get("country")).toBe(FIXED_REQUEST_FIELDS.country)
      expect(params.get("lang")).toBe(FIXED_REQUEST_FIELDS.lang)
      expect(params.get("server")).toBe(FIXED_REQUEST_FIELDS.server)
      // The per-Group_Member fields, in Member_Registry order.
      expect(params.get("hiveid")).toBe(ENABLED[index].hiveId)
      expect(params.get("coupon")).toBe(COUPON_CODE)
    })

    expectResultSet(result, rows, {
      couponCode: COUPON_CODE,
      mock: false,
      stoppedEarly: false,
    })
    await expectHistoryRecord(history, result, rows)
  })
})

/* -------------------------------------------------------------------------- */
/* 3. The reconnect read, mid-run and after (Requirement 3.1)                  */
/* -------------------------------------------------------------------------- */

describe("readActiveRun during and after a Redemption_Run", () => {
  it("reports the run in progress while a request is in flight and nothing once it ends", async () => {
    // A held first request, so "mid-run" is a defined moment rather than a race:
    // the gate runs after the request is recorded and before it is answered.
    let signalReached: () => void = () => undefined
    let signalReleased: () => void = () => undefined
    const reached = new Promise<void>((resolve) => {
      signalReached = resolve
    })
    const released = new Promise<void>((resolve) => {
      signalReleased = resolve
    })

    const rows = rowsFrom([
      "success-100.json",
      "success-100.json",
      "success-100.json",
      "success-100.json",
    ])
    const upstream = new StubUpstreamClient({
      script: scriptOf([
        "success-100.json",
        "success-100.json",
        "success-100.json",
        "success-100.json",
      ]),
      gate: ({ callIndex }) => {
        if (callIndex !== 0) return undefined
        signalReached()
        return released
      },
    })
    const { collaborators, coordinator, history } =
      await createHarness(upstream)

    // Idle before anything starts.
    expect(readActiveRun(coordinator)).toEqual({
      ok: true,
      data: null,
      warnings: [],
    })

    const run = runRedemptionEvents(collaborators, { couponCode: COUPON_CODE })
    const events: Array<RunEvent> = []

    // The body of an async generator is deferred, so the run starts here.
    const started = await run.next()
    if (started.done) throw new Error("the run yielded no event")
    events.push(started.value)

    // This `next()` stalls inside the gate, with request #0 in flight.
    const pending = run.next()
    await reached

    const during = readActiveRun(coordinator)
    expect(during.ok).toBe(true)
    if (!during.ok) throw new Error(during.error.message)
    expect(during.warnings).toEqual([])
    const snapshot = during.data
    if (snapshot === null) {
      throw new Error("a Redemption_Run is in progress, so it must be readable")
    }
    expect(snapshot.runId).toBe("run-1")
    expect(snapshot.couponCode).toBe(COUPON_CODE)
    expect(snapshot.startedAt).toBe(new Date(FIXED_TIME).toISOString())
    expect(snapshot.mock).toBe(false)
    expect(snapshot.total).toBe(ENABLED.length)
    // The first answer has not arrived, so no Member_Outcome exists yet.
    expect(snapshot.processed).toBe(0)
    expect(snapshot.outcomes).toEqual([])

    signalReleased()
    const resumed = await pending
    if (!resumed.done) events.push(resumed.value)
    for await (const event of run) {
      events.push(event)
    }

    const result = completedResult(expectStream(events, rows, false))
    expectResultSet(result, rows, {
      couponCode: COUPON_CODE,
      mock: false,
      stoppedEarly: false,
    })
    await expectHistoryRecord(history, result, rows)

    // The coordinator released its lock in its `finally`, so the read is idle
    // again the moment the terminal event has landed.
    expect(readActiveRun(coordinator)).toEqual({
      ok: true,
      data: null,
      warnings: [],
    })
  })
})
