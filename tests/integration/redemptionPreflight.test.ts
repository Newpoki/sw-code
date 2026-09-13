/**
 * The pre-flight rejections of a redemption request, end to end
 * (Requirements 3.8, 3.9, 7.6, 7.10).
 *
 * This is the integration counterpart to `tests/unit/redemptionFunctions.test.ts`.
 * That file drives `runRedemptionEvents` over a *scripted* coordinator, so it
 * establishes the shape of a rejection and nothing about the machinery that
 * produces one. Here the collaborators are real: the actual
 * {@link createRunCoordinator} over a real Member_Registry and a real
 * Redemption_History, and — for the Mock_Mode cases — the actual
 * {@link MockUpstreamClient} reading real fixture files. So the three claims the
 * requirements make about a rejection are checked against the code that has to
 * keep them:
 *
 *   1. **No enabled Group_Member** (Requirement 3.8) — an empty roster, and a
 *      roster whose every entry is disabled, are both rejected with the sentence
 *      {@link noEnabledMembersMessage} produces, and neither issues an
 *      Upstream_API request nor appends a Redemption_History record.
 *   2. **An unusable Mock_Mode fixture** (Requirements 7.6, 7.10) — a deleted
 *      fixture and a corrupted fixture each name the fixture and state the
 *      condition, before any Member_Outcome exists: `useCoupon` is never called,
 *      `fetch` is never called, and the history stays empty.
 *   3. **A Redemption_Run already in progress** (Requirement 3.9) — the second
 *      request is rejected with the sentence {@link runInProgressMessage}
 *      produces while the first run carries on *unchanged*, which is asserted by
 *      comparing it event for event and request for request against an
 *      uncontended baseline run, and by requiring exactly one history record.
 *
 * All four share one shape, checked by {@link expectPreflightRejection} on every
 * path: a single terminal `run-failed` event whose `runId` is
 * {@link PREFLIGHT_RUN_ID}, with no Member_Outcome, all six counts at zero, no
 * warning, and `stoppedEarly` false.
 *
 * ## What this test is careful not to touch
 *
 * The repository's own `fixtures/upstream/*.json` are byte-compared against
 * `docs/upstream-api.md` elsewhere, so nothing here writes to them: every
 * Mock_Mode case works on a `mkdtemp` **copy** of the three fixtures, and every
 * temporary directory is removed in `afterEach`. The fixture cache lives at
 * module scope inside `mock.server.ts` and is shared by every client instance in
 * the process, so `clearFixtureCache()` runs before and after each test.
 *
 * `./data/store.json` is never touched either: every store is built over a path
 * inside a temporary directory with the flush replaced by a resolved promise.
 */

import { copyFile, mkdtemp, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { emptyOutcomeCounts } from "@/domain/outcomes"
import {
  PREFLIGHT_RUN_ID,
  runRedemptionEvents,
} from "@/server/run/redemptionRequest.server"
import type { RedemptionCollaborators } from "@/server/run/redemptionRequest.server"
import {
  createRunCoordinator,
  noEnabledMembersMessage,
  runInProgressMessage,
} from "@/server/run/coordinator.server"
import type { RunCoordinator } from "@/server/run/coordinator.server"
import { createHistoryStore } from "@/server/store/history.server"
import type { HistoryStore } from "@/server/store/history.server"
import { createMemberRegistryStore } from "@/server/store/memberRegistry.server"
import {
  MOCK_FIXTURE_NAMES,
  clearFixtureCache,
  createMockUpstreamClient,
  resolveDefaultFixtureDir,
} from "@/server/upstream/mock.server"
import type { MockUpstreamClient } from "@/server/upstream/mock.server"
import type { RunEvent } from "@/domain/types"
import type { UpstreamClient } from "@/server/upstream/client"

import { FIXTURE_BODIES } from "../property/generators"
import {
  StubUpstreamClient,
  respondWithBody,
} from "../support/stubUpstreamClient"
import type { StubGateContext } from "../support/stubUpstreamClient"
import { createInMemoryMongoStore } from "../support/inMemoryMongoStore"

/** Fixed clock, so two runs of the same roster and script are comparable. */
const FIXED_TIME = Date.parse("2025-01-06T09:30:00.000Z")

const COUPON_CODE = "PREFLIGHT2025"

/** The repository's real fixture directory; copied from, never written to. */
const realFixtureDir = resolveDefaultFixtureDir()

/** Temporary directories created by a test, removed in `afterEach`. */
const temporaryDirectories: Array<string> = []

let fetchSpy: ReturnType<typeof spyOnFetch>

function spyOnFetch() {
  return vi.spyOn(globalThis, "fetch")
}

beforeEach(() => {
  clearFixtureCache()
  fetchSpy = spyOnFetch().mockImplementation(() => {
    throw new Error("a pre-flight rejection must never reach the network")
  })
})

afterEach(async () => {
  // Holds for every case below, Mock_Mode and stub alike: a rejected request
  // reaches neither the Upstream_API nor anything else over the network.
  expect(fetchSpy, "no pre-flight path called fetch").not.toHaveBeenCalled()
  vi.restoreAllMocks()
  clearFixtureCache()
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

/** A fresh temporary directory, removed after the test that asked for it. */
async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

/**
 * A throwaway copy of the three real fixtures, so a test can delete or corrupt
 * one without touching the repository.
 */
async function copyFixtureDir(): Promise<string> {
  const directory = await temporaryDirectory("scr-preflight-fixtures-")
  for (const fixtureName of MOCK_FIXTURE_NAMES) {
    await copyFile(
      join(realFixtureDir, fixtureName),
      join(directory, fixtureName)
    )
  }
  return directory
}

/** One roster entry to seed, in the words of the Member_Registry. */
interface RosterSeed {
  readonly memberLabel: string
  readonly hiveId: string
  readonly enabled: boolean
}

/** `count` enabled Group_Members, labelled and numbered in insertion order. */
function enabledRoster(count: number): Array<RosterSeed> {
  return Array.from({ length: count }, (_unused, index) => ({
    memberLabel: `Member ${index + 1}`,
    hiveId: `hive-${index + 1}`,
    enabled: true,
  }))
}

interface Harness {
  readonly collaborators: RedemptionCollaborators
  readonly coordinator: RunCoordinator
  readonly history: HistoryStore
}

/**
 * A coordinator over a real Member_Registry and a real Redemption_History, both
 * backed by a store in a temporary directory whose flush resolves without
 * writing a file, plus the given Upstream_API client.
 *
 * The roster is seeded through the registry rather than injected, so the fixed
 * list the coordinator snapshots comes from the same `listEnabled()` the
 * application uses — which is what makes the "every entry disabled" case of
 * Requirement 3.8 a genuine exercise of the roster rather than of a stub.
 *
 * The clock is fixed and the run id is a counter (`run-1`, `run-2`, ...), so the
 * event stream of a run is a pure function of the roster and the script and two
 * harnesses can be compared directly.
 */
async function createHarness(
  roster: readonly RosterSeed[],
  upstream: UpstreamClient
): Promise<Harness> {
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

/** The `run-failed` variant, which is the only terminal event a rejection has. */
type RunFailedEvent = Extract<RunEvent, { readonly type: "run-failed" }>

/**
 * The shape every pre-flight rejection shares, whichever of the four conditions
 * produced it: one terminal `run-failed` event, `PREFLIGHT_RUN_ID` as the run
 * id, no Member_Outcome, all six counts at zero, no warning, and a run that was
 * never started so was never stopped early.
 *
 * The event is returned so each case can then assert its own message.
 */
function expectPreflightRejection(
  events: readonly RunEvent[],
  couponCode: string
): RunFailedEvent {
  expect(events).toHaveLength(1)
  const [event] = events
  expect(event.type).toBe("run-failed")
  if (event.type !== "run-failed") {
    throw new Error(`the rejection is a ${event.type} event, not run-failed`)
  }

  expect(event.runId).toBe(PREFLIGHT_RUN_ID)
  expect(event.result.runId).toBe(PREFLIGHT_RUN_ID)
  expect(event.result.couponCode).toBe(couponCode)
  expect(event.result.outcomes).toEqual([])
  expect(event.result.counts).toEqual(emptyOutcomeCounts())
  expect(event.result.warnings).toEqual([])
  expect(event.result.stoppedEarly).toBe(false)

  return event
}

/* -------------------------------------------------------------------------- */
/* 1. No enabled Group_Member (Requirement 3.8)                               */
/* -------------------------------------------------------------------------- */

describe("no enabled Group_Member (Requirement 3.8)", () => {
  it.each([
    ["an empty roster", [] as ReadonlyArray<RosterSeed>],
    [
      "a roster whose every entry is disabled",
      enabledRoster(3).map((entry) => ({ ...entry, enabled: false })),
    ],
  ])(
    "is rejected with no upstream request and no history record: %s",
    async (_case, roster) => {
      const upstream = new StubUpstreamClient()
      const { collaborators, history } = await createHarness(roster, upstream)

      const events = await collect(
        runRedemptionEvents(collaborators, { couponCode: COUPON_CODE })
      )

      const rejection = expectPreflightRejection(events, COUPON_CODE)
      expect(rejection.message).toBe(noEnabledMembersMessage())
      expect(upstream.callCount, "no Upstream_API request was issued").toBe(0)
      const listed = await history.list()
      if (listed.kind !== "records") {
        throw new Error(`the history read reported "${listed.kind}"`)
      }
      expect(
        listed.records,
        "no Redemption_History record was appended"
      ).toEqual([])
    }
  )

  it("leaves the coordinator idle, so a later run is not blocked by the rejection", async () => {
    const upstream = new StubUpstreamClient()
    const { collaborators, coordinator } = await createHarness([], upstream)

    await collect(
      runRedemptionEvents(collaborators, { couponCode: COUPON_CODE })
    )

    expect(coordinator.snapshot()).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* 2. and 3. An unusable Mock_Mode fixture (Requirements 7.6, 7.10)           */
/* -------------------------------------------------------------------------- */

/** What one Mock_Mode rejection produced. */
interface MockRejection {
  readonly rejection: RunFailedEvent
  /** `useCoupon` calls the request issued; zero on every rejected path. */
  readonly callCount: number
  readonly historyLength: number
}

/**
 * Runs one redemption request in Mock_Mode over `fixtureDir`, against a roster of
 * two enabled Group_Members so the fixture check is the only thing that can
 * reject.
 *
 * `useCoupon` is spied on rather than replaced, so the client stays a real
 * {@link MockUpstreamClient} — which matters, because the pre-flight check is
 * selected by that very type — while still recording whether the run ever
 * reached the point of asking for a fixture.
 */
async function runInMockMode(fixtureDir: string): Promise<MockRejection> {
  const client: MockUpstreamClient = createMockUpstreamClient({ fixtureDir })
  const useCoupon = vi.spyOn(client, "useCoupon")
  const { collaborators, history } = await createHarness(
    enabledRoster(2),
    client
  )

  const events = await collect(
    runRedemptionEvents(collaborators, { couponCode: COUPON_CODE })
  )

  const rejection = expectPreflightRejection(events, COUPON_CODE)
  // The Mock_Mode flag is part of the rejected result, not only of a completed
  // run (Requirement 7.9 reads on the same flag).
  expect(rejection.result.mock).toBe(true)

  const listed = await history.list()
  if (listed.kind !== "records") {
    throw new Error(`the history read reported "${listed.kind}"`)
  }

  return {
    rejection,
    callCount: useCoupon.mock.calls.length,
    historyLength: listed.records.length,
  }
}

describe("Mock_Mode with a deleted fixture (Requirements 7.6, 7.10)", () => {
  it.each(MOCK_FIXTURE_NAMES)(
    "names %s and states it is absent, deriving no outcome and writing no history",
    async (fixtureName) => {
      const fixtureDir = await copyFixtureDir()
      await unlink(join(fixtureDir, fixtureName))
      clearFixtureCache()

      const { rejection, callCount, historyLength } =
        await runInMockMode(fixtureDir)

      expect(rejection.message).toContain(fixtureName)
      expect(rejection.message).toContain("is absent")
      expect(rejection.message).toContain(join(fixtureDir, fixtureName))
      expect(callCount, "no Upstream_API request was issued").toBe(0)
      expect(historyLength, "no Redemption_History record was appended").toBe(0)
    }
  )
})

describe("Mock_Mode with a corrupted fixture (Requirements 7.6, 7.10)", () => {
  it.each(MOCK_FIXTURE_NAMES)(
    "names %s and states it is not valid JSON, deriving no outcome and writing no history",
    async (fixtureName) => {
      const fixtureDir = await copyFixtureDir()
      await writeFile(
        join(fixtureDir, fixtureName),
        '{"retCode":100,"retMsg"',
        "utf8"
      )
      clearFixtureCache()

      const { rejection, callCount, historyLength } =
        await runInMockMode(fixtureDir)

      expect(rejection.message).toContain(fixtureName)
      expect(rejection.message).toContain("is not valid JSON")
      expect(callCount, "no Upstream_API request was issued").toBe(0)
      expect(historyLength, "no Redemption_History record was appended").toBe(0)
    }
  )
})

/* -------------------------------------------------------------------------- */
/* 4. A Redemption_Run already in progress (Requirement 3.9)                   */
/* -------------------------------------------------------------------------- */

/** A held `useCoupon` call: the lever that makes "mid-run" a defined moment. */
interface CallHold {
  readonly gate: (context: StubGateContext) => Promise<void> | void
  /** Resolves once the held call has entered the gate. */
  readonly reached: Promise<void>
  readonly release: () => void
}

/**
 * Holds the first `useCoupon` call open until `release()` is called. Every later
 * call passes through untouched, so the run is ordinary apart from one request
 * that stays in flight for as long as the test needs it.
 *
 * Racing on timing instead would pass against a coordinator with no lock at all
 * whenever the scheduler happened to serialize the two requests.
 */
function holdFirstCall(): CallHold {
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
      if (context.callIndex !== 0) return undefined
      signalReached()
      return released
    },
  }
}

/** Two enabled Group_Members, both answered with the documented success body. */
const CONTENDED_ROSTER = enabledRoster(2)
const successScript = () =>
  CONTENDED_ROSTER.map(() =>
    respondWithBody(FIXTURE_BODIES["success-100.json"])
  )

describe("a second redemption request during an active run (Requirement 3.9)", () => {
  it("is rejected while the active run completes unchanged and appends the only history record", async () => {
    // The uncontended baseline: the same roster and the same script, run alone.
    const baselineUpstream = new StubUpstreamClient({ script: successScript() })
    const baseline = await createHarness(CONTENDED_ROSTER, baselineUpstream)
    const baselineEvents = await collect(
      runRedemptionEvents(baseline.collaborators, { couponCode: COUPON_CODE })
    )
    expect(baselineEvents.at(-1)?.type).toBe("run-completed")

    // The contended run, with its first request held open.
    const hold = holdFirstCall()
    const upstream = new StubUpstreamClient({
      script: successScript(),
      gate: hold.gate,
    })
    const { collaborators, coordinator, history } = await createHarness(
      CONTENDED_ROSTER,
      upstream
    )

    const firstRun = runRedemptionEvents(collaborators, {
      couponCode: COUPON_CODE,
    })
    const firstEvents: Array<RunEvent> = []

    // The body of an async generator is deferred, so the run starts here.
    const started = await firstRun.next()
    if (started.done) throw new Error("the first run yielded no event")
    firstEvents.push(started.value)

    // This `next()` stalls inside the gate, with request #0 in flight.
    const pending = firstRun.next()
    await hold.reached

    const snapshotDuring = coordinator.snapshot()
    expect(snapshotDuring, "a Redemption_Run is in progress").not.toBeNull()
    const callsBeforeSecondRequest = upstream.callCount

    // The second request, driven to completion while the first run is mid-flight.
    const secondEvents = await collect(
      runRedemptionEvents(collaborators, { couponCode: COUPON_CODE })
    )

    const rejection = expectPreflightRejection(secondEvents, COUPON_CODE)
    expect(rejection.message).toBe(runInProgressMessage())
    expect(
      upstream.callCount,
      "the rejected request issued no Upstream_API request"
    ).toBe(callsBeforeSecondRequest)
    // The active run is untouched by the rejection: same run, same progress.
    expect(coordinator.snapshot()).toEqual(snapshotDuring)

    // Release the held request and let the first run finish.
    hold.release()
    const resumed = await pending
    if (!resumed.done) firstEvents.push(resumed.value)
    for await (const event of firstRun) {
      firstEvents.push(event)
    }

    // Unchanged, event for event and request for request, against the baseline.
    expect(firstEvents).toEqual(baselineEvents)
    expect(upstream.requests).toEqual(baselineUpstream.requests)
    expect(upstream.maxInFlight, "at most one request was ever in flight").toBe(
      1
    )

    // Exactly one Redemption_History record: the first run's, not two.
    const listed = await history.list()
    if (listed.kind !== "records") {
      throw new Error(`the history read reported "${listed.kind}"`)
    }
    const records = listed.records
    expect(records).toHaveLength(1)
    expect(records[0].couponCode).toBe(COUPON_CODE)
    expect(records[0].outcomes).toHaveLength(CONTENDED_ROSTER.length)

    // The lock is released, so the next request is admitted.
    expect(coordinator.snapshot()).toBeNull()
  })
})
