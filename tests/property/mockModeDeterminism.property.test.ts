/**
 * Property 21 of shared-coupon-redemption: Mock_Mode is deterministic,
 * documented, and offline (Requirements 7.3, 7.9).
 *
 * Three claims are checked on the same generated Redemption_Run, driven through
 * the real {@link MockUpstreamClient} over the repository's real
 * `fixtures/upstream/` directory:
 *
 * 1. **Deterministic.** The same roster and the same Coupon_Code produce the
 *    same Member_Outcome sequence when the run is repeated — twice against a
 *    warm fixture cache, and once more against a fresh client instance with the
 *    module-level cache cleared, which is the "across fresh client instances and
 *    across processes" reading of Requirement 7.3.
 * 2. **Documented.** Every `bodyText` the mock served is character-for-character
 *    one of the three fenced examples of `docs/upstream-api.md`. The examples are
 *    read out of the document here rather than restated, so an edit to either the
 *    document or a fixture reaches this property.
 * 3. **Offline.** `fetch` is replaced by a spy that throws, and the assertion
 *    that it was never called holds after every run and in `afterEach`, so it
 *    covers the failure paths too.
 *
 * Requirement 7.9 is checked alongside: the `run-started` event, the
 * {@link RedemptionRunResult}, and the appended Redemption_History record all
 * carry the Mock_Mode flag.
 *
 * ## The oracle is `selectFixtureName` plus the early-stop rule
 *
 * Fixture selection is a pure function of the (Coupon_Code, Hive_ID) pair, so the
 * expected outcome sequence is derivable without running anything: map the pair
 * of every fixed-list entry to its fixture, take the Member_Outcome the
 * API_Reference_Document states for that fixture, and cut the sequence at the
 * first entry that lands on `invalid-coupon-h306.json` — that Group_Member
 * reports `INVALID_COUPON` and every Group_Member after it reports `SKIPPED`
 * (Requirements 5.1 to 5.3). A run that stops on its first Group_Member is
 * therefore an expected sample, not a failure.
 *
 * Because the FNV prime is odd, a generator that holds the byte parity of the
 * selection key fixed reaches only even buckets and would never select
 * `invalid-coupon-h306.json`. The Coupon_Code and the Hive_IDs are generated
 * independently here, and the fixtures actually served are accumulated across
 * the whole property run and asserted to cover all three.
 *
 * Validates: Requirements 7.3, 7.9
 */

import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import fc from "fast-check"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  MemberOutcomeValue,
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
  INVALID_COUPON_FIXTURE,
  MOCK_FIXTURE_NAMES,
  clearFixtureCache,
  createMockUpstreamClient,
  resolveDefaultFixtureDir,
  selectFixtureName,
} from "@/server/upstream/mock.server"
import type { MockFixtureName } from "@/server/upstream/mock.server"
import type {
  UpstreamClient,
  UpstreamRawResponse,
  UseCouponRequest,
} from "@/server/upstream/client"

import {
  FIXTURE_BODIES,
  FIXTURE_OUTCOMES,
  enabledEntries,
  rosterArb,
  trimmedCouponCodeArb,
} from "./generators"

/* -------------------------------------------------------------------------- */
/* The documented response bodies                                             */
/* -------------------------------------------------------------------------- */

/** The repository's real fixture directory. Read from, never written to. */
const FIXTURE_DIR = resolveDefaultFixtureDir()

const FENCED_JSON = /```json\r?\n([\s\S]*?)```/g

/**
 * The fenced ```json examples of the API_Reference_Document, with the single
 * newline that terminates the last content line removed — the same slicing
 * `tests/unit/upstreamFixtures.test.ts` uses, so "character for character" means
 * the same thing in both places.
 */
const DOCUMENTED_BODIES: ReadonlySet<string> = new Set(
  [
    ...readFileSync(
      new URL("../../docs/upstream-api.md", import.meta.url),
      "utf8"
    ).matchAll(FENCED_JSON),
  ].map((match) => match[1].replace(/\r?\n$/, ""))
)

/** Served body text back to the fixture it came from, for the coverage tally. */
const FIXTURE_BY_BODY: ReadonlyMap<string, MockFixtureName> = new Map(
  MOCK_FIXTURE_NAMES.map((name) => [FIXTURE_BODIES[name], name])
)

/* -------------------------------------------------------------------------- */
/* Generated scenario                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Rosters stay small: every sample runs the coordinator three times over the
 * real fixture files, so a 100-entry roster would cost 300 requests per sample.
 */
const ROSTER_BOUNDS = {
  minLength: 1,
  maxLength: 12,
  atLeastOneEnabled: true,
} as const

interface Scenario {
  readonly roster: Array<MemberRegistryEntry>
  readonly couponCode: string
}

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  roster: rosterArb(ROSTER_BOUNDS),
  couponCode: trimmedCouponCodeArb,
})

/* -------------------------------------------------------------------------- */
/* Model                                                                      */
/* -------------------------------------------------------------------------- */

/** What Mock_Mode selection alone predicts about a Redemption_Run. */
interface Expectation {
  /** The fixture each fixed-list entry selects, in processing order. */
  readonly selected: readonly MockFixtureName[]
  /** Member_Outcome per fixed-list entry, `SKIPPED` after the early stop. */
  readonly outcomes: readonly MemberOutcomeValue[]
  /** Number of `useCoupon` requests the run issues. */
  readonly requests: number
  /** True when some entry selects `invalid-coupon-h306.json`. */
  readonly stoppedEarly: boolean
}

/**
 * Derives the expected run from `selectFixtureName` and the early-stop rule.
 *
 * The first entry that selects `invalid-coupon-h306.json` is the last one a
 * request is issued for: it reports `INVALID_COUPON`, and every entry after it
 * reports `SKIPPED` with no request issued (Requirements 5.1 to 5.3).
 */
function expectationOf(
  couponCode: string,
  fixedList: readonly MemberRegistryEntry[]
): Expectation {
  const selected = fixedList.map((member) =>
    selectFixtureName(couponCode, member.hiveId)
  )
  const stopIndex = selected.indexOf(INVALID_COUPON_FIXTURE)
  const lastRequested = stopIndex === -1 ? selected.length - 1 : stopIndex

  return {
    selected,
    outcomes: selected.map((name, position): MemberOutcomeValue =>
      position <= lastRequested ? FIXTURE_OUTCOMES[name] : "SKIPPED"
    ),
    requests: lastRequested + 1,
    stoppedEarly: stopIndex !== -1,
  }
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A {@link MockUpstreamClient} wrapped so the pairs it was asked about and the
 * bytes it served can be asserted. It delegates every decision to the real
 * client, so nothing about selection or fixture reading is modelled here.
 */
interface RecordingMockClient extends UpstreamClient {
  readonly requests: Array<UseCouponRequest>
  readonly servedBodies: Array<string>
}

function recordingMockClient(): RecordingMockClient {
  const inner = createMockUpstreamClient({ fixtureDir: FIXTURE_DIR })
  const requests: Array<UseCouponRequest> = []
  const servedBodies: Array<string> = []

  return {
    isMock: inner.isMock,
    requests,
    servedBodies,
    useCoupon: async (req: UseCouponRequest): Promise<UpstreamRawResponse> => {
      requests.push(req)
      const raw = await inner.useCoupon(req)
      if (raw.bodyText !== null) {
        servedBodies.push(raw.bodyText)
      }
      return raw
    },
  }
}

/**
 * A Member_Registry and a Redemption_History over a store whose flush resolves
 * without writing a file, seeded through the registry itself so the fixed list
 * comes from the same `listEnabled()` the application uses.
 */
async function seedStores(
  roster: readonly MemberRegistryEntry[]
): Promise<{ registry: MemberRegistryStore; history: HistoryStore }> {
  const store = createJsonStore({
    dataFilePath: join(tmpdir(), `scr-mock-mode-${randomUUID()}`, "store.json"),
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

  return { registry, history: createHistoryStore(store) }
}

interface RunOutcome {
  readonly events: readonly RunEvent[]
  readonly result: RedemptionRunResult
  readonly client: RecordingMockClient
}

/** One Redemption_Run over a fresh coordinator and a fresh recording client. */
async function runOnce(
  registry: MemberRegistryStore,
  history: HistoryStore,
  couponCode: string
): Promise<RunOutcome> {
  const client = recordingMockClient()
  const coordinator = createRunCoordinator({
    registry,
    history,
    upstream: client,
  })

  const events: Array<RunEvent> = []
  for await (const event of coordinator.start(couponCode)) {
    events.push(event)
  }

  const terminal = events.at(-1)
  if (terminal === undefined || terminal.type !== "run-completed") {
    throw new Error(
      `expected a run-completed event, got ${terminal?.type ?? "no event at all"}`
    )
  }

  return { events, result: terminal.result, client }
}

/* -------------------------------------------------------------------------- */
/* Assertions                                                                 */
/* -------------------------------------------------------------------------- */

/** Fixtures the mock actually served, accumulated over the whole property run. */
const servedFixtures = new Set<MockFixtureName>()

/**
 * One run against the model: the requests issued, the Member_Outcomes reported,
 * the bytes served, and the Mock_Mode flags of Requirement 7.9.
 */
function assertRunMatchesModel(
  run: RunOutcome,
  fixedList: readonly MemberRegistryEntry[],
  couponCode: string,
  expectation: Expectation
): void {
  // Requirement 7.9: the flag reaches the Web_Client on the first event and on
  // the result set.
  const [started] = run.events
  expect(started.type).toBe("run-started")
  if (started.type === "run-started") {
    expect(started.mock).toBe(true)
    expect(started.total).toBe(fixedList.length)
  }
  expect(run.result.mock).toBe(true)
  expect(run.result.couponCode).toBe(couponCode)
  expect(run.result.stoppedEarly).toBe(expectation.stoppedEarly)

  // Requirement 7.3: the Member_Outcomes follow from the selected fixtures.
  expect(run.result.outcomes.map((outcome) => outcome.outcome)).toEqual(
    expectation.outcomes
  )

  // One request per processed Group_Member, none after the early stop.
  expect(run.client.requests).toHaveLength(expectation.requests)
  run.client.requests.forEach((request, position) => {
    expect(request.coupon).toBe(couponCode)
    expect(request.hiveid).toBe(fixedList[position].hiveId)
  })

  // Requirement 7.3: every body served is a documented example, character for
  // character, and it is the body of the fixture the pair selects.
  expect(run.client.servedBodies).toHaveLength(expectation.requests)
  run.client.servedBodies.forEach((bodyText, position) => {
    const fixtureName = expectation.selected[position]
    expect(bodyText).toBe(FIXTURE_BODIES[fixtureName])
    expect(
      DOCUMENTED_BODIES.has(bodyText),
      `served body is a fenced example of docs/upstream-api.md: ${JSON.stringify(bodyText)}`
    ).toBe(true)

    const served = FIXTURE_BY_BODY.get(bodyText)
    if (served !== undefined) {
      servedFixtures.add(served)
    }
  })
}

/* -------------------------------------------------------------------------- */
/* Offline guard                                                              */
/* -------------------------------------------------------------------------- */

function spyOnFetch() {
  return vi.spyOn(globalThis, "fetch")
}

let fetchSpy: ReturnType<typeof spyOnFetch>

beforeEach(() => {
  clearFixtureCache()
  fetchSpy = spyOnFetch().mockImplementation(() => {
    throw new Error("Mock_Mode must never call fetch")
  })
})

afterEach(() => {
  // Requirement 7.3: holds across every path of every sample, including any run
  // that stopped early.
  expect(fetchSpy, "Mock_Mode issued no fetch call").not.toHaveBeenCalled()
  vi.restoreAllMocks()
  clearFixtureCache()
})

/* -------------------------------------------------------------------------- */
/* Property                                                                   */
/* -------------------------------------------------------------------------- */

describe("Mock_Mode determinism", () => {
  // Feature: shared-coupon-redemption, Property 21: Mock_Mode is deterministic,
  // documented, and offline — For any pair of Coupon_Code and Hive_ID, repeated
  // Mock_Mode redemptions select the same response fixture, every fixture body is
  // character-identical to a response body example of the API_Reference_Document,
  // no request is issued to the Upstream_API, and the Redemption_History record
  // appended for the Redemption_Run is marked as derived from mock data.
  // Validates: Requirements 7.3, 7.9
  it("repeats the same Member_Outcomes from documented fixtures without any fetch", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ roster, couponCode }) => {
        const fixedList = enabledEntries(roster)
        const expectation = expectationOf(couponCode, fixedList)
        const { registry, history } = await seedStores(roster)

        const first = await runOnce(registry, history, couponCode)
        const second = await runOnce(registry, history, couponCode)

        // A fresh client instance reading the fixtures again from a cold cache:
        // selection depends on the pair alone, not on process state.
        clearFixtureCache()
        const third = await runOnce(registry, history, couponCode)

        for (const run of [first, second, third]) {
          assertRunMatchesModel(run, fixedList, couponCode, expectation)
        }

        // Requirement 7.3: identical input, identical Member_Outcomes — labels,
        // positions, and Upstream_Results included.
        expect(second.result.outcomes).toEqual(first.result.outcomes)
        expect(third.result.outcomes).toEqual(first.result.outcomes)
        expect(second.result.counts).toEqual(first.result.counts)
        expect(third.result.counts).toEqual(first.result.counts)
        expect(second.client.servedBodies).toEqual(first.client.servedBodies)
        expect(third.client.servedBodies).toEqual(first.client.servedBodies)

        // Requirement 7.9: every appended Redemption_History record is marked as
        // derived from mock data.
        const records = history.list()
        expect(records).toHaveLength(3)
        for (const record of records) {
          expect(record.mock).toBe(true)
          expect(record.couponCode).toBe(couponCode)
          expect(record.outcomes).toHaveLength(fixedList.length)
          expect(record.outcomes.map((row) => row.outcome)).toEqual(
            expectation.outcomes
          )
        }

        expect(fetchSpy).not.toHaveBeenCalled()
      }),
      { numRuns: 100 }
    )

    // The generated pairs reach all three fixtures, so the documented-body and
    // early-stop assertions above were exercised on each of them rather than on
    // the even-bucket subset an input-parity-preserving generator would produce.
    expect([...servedFixtures].sort()).toEqual([...MOCK_FIXTURE_NAMES].sort())
  })
})
