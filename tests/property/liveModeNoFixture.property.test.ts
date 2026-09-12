/**
 * Property 22 of shared-coupon-redemption: live mode reads no fixture
 * (Requirement 7.11).
 *
 * The claim has two halves, and both are checked on the same generated
 * Redemption_Run: every reported Member_Outcome comes from an Upstream_API
 * response, and the number of response fixtures read is zero.
 *
 * ## How a fixture read is observed
 *
 * `mock.server.ts` is the only module that can serve a fixture, and it reaches
 * the filesystem through exactly two functions: `readFile` from
 * `node:fs/promises` when it loads a fixture body, and `existsSync` from
 * `node:fs` when it resolves the default fixture directory. Both are replaced
 * here with `vi.mock` passthrough wrappers that count the calls whose path lies
 * inside `fixtures/upstream` and then delegate to the real implementation, so
 * the instrumentation observes the actual call rather than a re-implementation
 * of it. Every other export of both modules is passed through untouched, so the
 * JSON store — which reads and writes with `readFileSync`, `mkdir`, `rename` —
 * behaves normally.
 *
 * Counting reads is only meaningful if the counter can move, so the first test
 * in this file drives one `MockUpstreamClient` request over the repository's
 * real fixtures and asserts that both counters register it. Without that check a
 * broken instrument would make the property below pass vacuously.
 *
 * A third, independent witness is asserted alongside: `cachedFixturePaths()`
 * stays empty. A fixture read that succeeds populates that cache, so an empty
 * cache after a run is evidence no fixture was loaded even if a read had
 * somehow slipped past the wrappers.
 *
 * ## The failure paths matter as much as the success path
 *
 * `LiveUpstreamClient` has three failure exits — a timeout, a network failure,
 * and a non-2xx response — and Requirement 7.11 admits no fixture fallback on
 * any of them. All three are driven through the injected `fetch`, the kinds
 * actually exercised are accumulated across the whole property run, and the
 * tally is asserted afterwards, so a generator that stopped producing failures
 * would fail the test rather than quietly narrow it.
 *
 * The pre-flight check is covered too: `checkUpstreamFixtures(liveClient)`
 * reports success without touching the filesystem, and it keeps doing so when
 * the fixture directory handed to the factory does not exist — with Mock_Mode
 * disabled that option is ignored, so an absent fixture directory cannot even be
 * noticed, let alone block a live run.
 *
 * ## The oracle
 *
 * `parseUpstreamBody` applied to the response the injected `fetch` returned. The
 * Member_Outcome, the response code, and the response message of every processed
 * Group_Member must equal what that response parses to. To make "derived from an
 * Upstream_API response" more than a type-level claim, every generated body
 * carries a `retMsg` prefixed with a marker string no fixture holds, and each
 * response-derived message is asserted to be that marker-bearing message and to
 * be absent from the set of fixture messages.
 *
 * No real network and no real fixture: `fetch` is injected, and the store flush
 * resolves without writing a file.
 *
 * Validates: Requirements 7.11
 */

import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type * as NodeFs from "node:fs"
import type * as NodeFsPromises from "node:fs/promises"

import fc from "fast-check"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { parseUpstreamBody } from "@/domain/responseParser"
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
import type { UpstreamRawResponse } from "@/server/upstream/client"
import {
  checkUpstreamFixtures,
  createUpstreamClient,
} from "@/server/upstream/factory.server"
import {
  FIXED_REQUEST_FIELDS,
  LiveUpstreamClient,
  useCouponEndpoint,
} from "@/server/upstream/live.server"
import type { UpstreamFetch } from "@/server/upstream/live.server"
import {
  cachedFixturePaths,
  clearFixtureCache,
} from "@/server/upstream/mock.server"

import {
  FIXTURE_BODIES,
  FIXTURE_FILE_NAMES,
  enabledEntries,
  rosterArb,
  trimmedCouponCodeArb,
} from "./generators"

/* -------------------------------------------------------------------------- */
/* Fixture-read instrumentation                                               */
/* -------------------------------------------------------------------------- */

/**
 * The shared counter. Created with `vi.hoisted` because the `vi.mock` factories
 * below are hoisted above every import and may not reach a module-level binding
 * declared normally.
 */
const fixtureIo = vi.hoisted(() => {
  const reads: Array<string> = []
  const existsChecks: Array<string> = []

  const asPath = (target: unknown): string =>
    typeof target === "string"
      ? target
      : target instanceof URL
        ? target.pathname
        : String(target)

  /** True for a path inside `fixtures/upstream`, on POSIX and on Windows. */
  const isFixturePath = (target: unknown): boolean =>
    asPath(target).replace(/\\/g, "/").includes("fixtures/upstream")

  return {
    reads,
    existsChecks,
    record: (kind: "read" | "exists", target: unknown): void => {
      if (!isFixturePath(target)) return
      const log = kind === "read" ? reads : existsChecks
      log.push(asPath(target))
    },
    reset: (): void => {
      reads.length = 0
      existsChecks.length = 0
    },
    /** Every fixture-directory filesystem call observed since the last reset. */
    all: (): Array<string> => [...reads, ...existsChecks],
  }
})

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      fixtureIo.record("read", args[0])
      return actual.readFile(...args)
    },
  }
})

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    existsSync: (...args: Parameters<typeof actual.existsSync>) => {
      fixtureIo.record("exists", args[0])
      return actual.existsSync(...args)
    },
  }
})

/** Asserts that nothing under `fixtures/upstream` was read or probed. */
function expectNoFixtureIo(context: string): void {
  expect(fixtureIo.all(), `no fixture filesystem call ${context}`).toEqual([])
  expect(cachedFixturePaths(), `fixture cache stays empty ${context}`).toEqual(
    []
  )
}

beforeEach(() => {
  clearFixtureCache()
  fixtureIo.reset()
})

/* -------------------------------------------------------------------------- */
/* The instrumentation catches a real read                                    */
/* -------------------------------------------------------------------------- */

describe("fixture-read instrumentation", () => {
  it("counts the reads a Mock_Mode request performs", async () => {
    const mock = createUpstreamClient({
      mockMode: true,
      upstreamBaseUrl: "https://event.invalid/ci/smon/evt_coupon",
    })

    const raw = await mock.useCoupon({
      hiveid: "probe-hive-id",
      coupon: "PROBE",
    })

    expect(mock.isMock).toBe(true)
    expect(raw.bodyText).not.toBeNull()
    // `resolveDefaultFixtureDir` probes with `existsSync`, `useCoupon` loads the
    // selected fixture with `readFile`: both instruments register.
    expect(fixtureIo.existsChecks.length).toBeGreaterThan(0)
    expect(fixtureIo.reads.length).toBeGreaterThan(0)
    expect(cachedFixturePaths().length).toBeGreaterThan(0)

    fixtureIo.reset()
    clearFixtureCache()
  })
})

/* -------------------------------------------------------------------------- */
/* Generated upstream behaviour                                               */
/* -------------------------------------------------------------------------- */

/** Prefix of every generated `retMsg`. No fixture body contains it. */
const LIVE_MESSAGE_MARKER = "live-upstream-body:"

/** The response messages the three fixtures would produce, if one were read. */
const FIXTURE_MESSAGES: ReadonlySet<string> = new Set(
  FIXTURE_FILE_NAMES.map(
    (name) =>
      parseUpstreamBody({
        bodyText: FIXTURE_BODIES[name],
        transportFailure: null,
      }).responseMessage
  )
)

/** The four exits of `LiveUpstreamClient`, as generated scenario steps. */
type FetchStepKind = "ok" | "non-2xx" | "timeout" | "network"

/** A step whose `fetch` resolves: the Upstream_API answered, 2xx or not. */
interface RespondedStep {
  readonly kind: "ok" | "non-2xx"
  readonly status: number
  readonly bodyText: string
  /** The generated `retMsg`, or null for a body that carries none. */
  readonly message: string | null
  readonly outcome: MemberOutcomeValue
}

/** A step whose `fetch` never produced a usable response. */
interface FailedStep {
  readonly kind: "timeout" | "network"
  readonly outcome: "TRANSPORT_ERROR"
}

/** One scripted `fetch` behaviour, plus what the run must derive from it. */
type FetchStep = RespondedStep | FailedStep

/**
 * A hand-written predicate rather than a `kind` comparison: each member of
 * {@link FetchStep} carries a union of two literals as its discriminant, which
 * is not enough for the compiler to narrow the union on its own.
 */
function isResponded(step: FetchStep): step is RespondedStep {
  return step.kind === "ok" || step.kind === "non-2xx"
}

/** The {@link UpstreamRawResponse} the live client must produce for a step. */
function rawResponseOf(step: FetchStep): UpstreamRawResponse {
  if (!isResponded(step)) {
    return { bodyText: null, status: null, transportFailure: step.kind }
  }
  return {
    bodyText: step.bodyText,
    status: step.status,
    transportFailure: null,
  }
}

/** A generated `retMsg`, marked so its origin is unambiguous. */
const messageArb: fc.Arbitrary<string> = fc
  .string({ unit: "grapheme-ascii", maxLength: 40 })
  .map((suffix) => `${LIVE_MESSAGE_MARKER}${suffix}`)

function responseStep(
  kind: "ok" | "non-2xx",
  status: number,
  bodyText: string,
  message: string | null
): FetchStep {
  return {
    kind,
    status,
    bodyText,
    message,
    outcome: parseUpstreamBody({ bodyText, transportFailure: null }).outcome,
  }
}

/** A 2xx response body: a known code, a case variant, or an unknown code. */
const okStepArb: fc.Arbitrary<FetchStep> = fc
  .tuple(
    fc.oneof(
      { weight: 6, arbitrary: fc.constant("100") },
      { weight: 3, arbitrary: fc.constant("(H304)") },
      { weight: 2, arbitrary: fc.constantFrom("(H999)", "(h304)", "0") },
      { weight: 1, arbitrary: fc.constant("(H306)") }
    ),
    messageArb
  )
  .map(([retCode, message]) =>
    responseStep(
      "ok",
      200,
      JSON.stringify({ retCode, retMsg: message }),
      message
    )
  )

/**
 * A non-2xx response. It is still a response, so the Response_Parser classifies
 * its body: a JSON body with an unknown code yields `UPSTREAM_ERROR`, an HTML
 * error page yields `TRANSPORT_ERROR` — and neither may fall back to a fixture.
 */
const nonOkStepArb: fc.Arbitrary<FetchStep> = fc
  .tuple(fc.constantFrom(400, 429, 500, 502, 503), messageArb, fc.boolean())
  .map(([status, message, jsonBody]) =>
    jsonBody
      ? responseStep(
          "non-2xx",
          status,
          JSON.stringify({ retCode: `(H${status})`, retMsg: message }),
          message
        )
      : responseStep(
          "non-2xx",
          status,
          `<html><body>${status} upstream failure</body></html>`,
          null
        )
  )

const timeoutStep: FetchStep = { kind: "timeout", outcome: "TRANSPORT_ERROR" }
const networkStep: FetchStep = { kind: "network", outcome: "TRANSPORT_ERROR" }

const fetchStepArb: fc.Arbitrary<FetchStep> = fc.oneof(
  { weight: 6, arbitrary: okStepArb },
  { weight: 3, arbitrary: nonOkStepArb },
  { weight: 2, arbitrary: fc.constant(timeoutStep) },
  { weight: 2, arbitrary: fc.constant(networkStep) }
)

/* -------------------------------------------------------------------------- */
/* Generated scenario                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Rosters stay small: every sample runs a full Redemption_Run through the real
 * coordinator and the real stores, and the property is about what is *not* read
 * rather than about scale.
 */
const ROSTER_BOUNDS = {
  minLength: 1,
  maxLength: 8,
  atLeastOneEnabled: true,
} as const

interface Scenario {
  readonly roster: Array<MemberRegistryEntry>
  readonly couponCode: string
  /** One step per fixed-list entry. */
  readonly steps: Array<FetchStep>
}

const scenarioArb: fc.Arbitrary<Scenario> = rosterArb(ROSTER_BOUNDS).chain(
  (roster) => {
    const size = enabledEntries(roster).length
    return fc.record({
      roster: fc.constant(roster),
      couponCode: trimmedCouponCodeArb,
      steps: fc.array(fetchStepArb, {
        minLength: size,
        maxLength: size,
        size: "max",
      }),
    })
  }
)

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

/** A `useCoupon` request as the injected `fetch` saw it on the wire. */
interface RecordedFetch {
  readonly url: string
  readonly fields: Record<string, string>
}

/**
 * An `UpstreamFetch` replaying `steps`, one per call, recording the URL and the
 * decoded form fields. A timeout rejects with the `TimeoutError` Node raises for
 * an elapsed `AbortSignal.timeout`; a network failure rejects with the
 * `TypeError` a failed `fetch` raises.
 */
function scriptedFetch(
  steps: readonly FetchStep[],
  recorded: Array<RecordedFetch>
): UpstreamFetch {
  return (url, init) => {
    const callIndex = recorded.length
    recorded.push({
      url,
      fields: Object.fromEntries(new URLSearchParams(init.body)),
    })

    const step = steps.at(callIndex)
    if (step === undefined) {
      return Promise.reject(
        new Error(`no scripted fetch step for useCoupon call #${callIndex}`)
      )
    }

    if (!isResponded(step)) {
      return Promise.reject(
        step.kind === "timeout"
          ? new DOMException(
              "The operation was aborted due to timeout",
              "TimeoutError"
            )
          : new TypeError("fetch failed")
      )
    }

    return Promise.resolve({
      status: step.status,
      text: () => Promise.resolve(step.bodyText),
    })
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
    dataFilePath: join(tmpdir(), `scr-live-mode-${randomUUID()}`, "store.json"),
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

/* -------------------------------------------------------------------------- */
/* Model                                                                      */
/* -------------------------------------------------------------------------- */

/** What the scripted `fetch` behaviour predicts about the run it drives. */
interface Expectation {
  /** Member_Outcome per fixed-list entry, in processing order. */
  readonly outcomes: readonly MemberOutcomeValue[]
  /** Number of `useCoupon` requests the run issues. */
  readonly requests: number
}

/**
 * Derives the expected run from the scripted steps and the early-stop rule: the
 * first step that parses to `INVALID_COUPON` is the last one a request is issued
 * for, and every Group_Member after it reports `SKIPPED` (Requirements 5.1-5.3).
 */
function expectationOf(steps: readonly FetchStep[]): Expectation {
  const stopIndex = steps.findIndex((step) => step.outcome === "INVALID_COUPON")
  const lastRequested = stopIndex === -1 ? steps.length - 1 : stopIndex

  return {
    outcomes: steps.map((step, position): MemberOutcomeValue =>
      position <= lastRequested ? step.outcome : "SKIPPED"
    ),
    requests: lastRequested + 1,
  }
}

/* -------------------------------------------------------------------------- */
/* Property                                                                   */
/* -------------------------------------------------------------------------- */

/** Fetch behaviours actually exercised, accumulated over the property run. */
const exercised = new Set<FetchStepKind>()

/**
 * A fixture directory that does not exist, used to show that the option is
 * ignored in live mode. The path lies inside a `fixtures/upstream` segment, so
 * any attempt to read or probe it would be counted.
 */
const ABSENT_FIXTURE_DIR = join(
  tmpdir(),
  `scr-absent-${randomUUID()}`,
  "fixtures",
  "upstream"
)

describe("live mode reads no fixture", () => {
  afterEach(() => {
    // Holds after every sample, including the ones that timed out, failed at
    // the network, or received a non-2xx response.
    expectNoFixtureIo("after the Redemption_Run")
  })

  // Feature: shared-coupon-redemption, Property 22: Live mode reads no fixture
  // — For any Redemption_Run performed while Mock_Mode is disabled, every
  // reported Member_Outcome is derived from an Upstream_API response and zero
  // response fixtures are read.
  // Validates: Requirements 7.11
  it("derives every Member_Outcome from the Upstream_API response and reads zero fixtures", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ roster, couponCode, steps }) => {
        const fixedList = enabledEntries(roster)
        const expectation = expectationOf(steps)
        const { registry, history } = await seedStores(roster)

        const recorded: Array<RecordedFetch> = []
        const client = createUpstreamClient(
          {
            mockMode: false,
            upstreamBaseUrl: "https://event.invalid/ci/smon/evt_coupon",
          },
          {
            fetch: scriptedFetch(steps, recorded),
            timeoutMs: 1_000,
            // Ignored in live mode, and it does not exist (Requirement 7.11).
            fixtureDir: ABSENT_FIXTURE_DIR,
          }
        )

        // The factory chose the live implementation, so no fixture is reachable.
        expect(client).toBeInstanceOf(LiveUpstreamClient)
        expect(client.isMock).toBe(false)

        // The pre-flight check reports success without looking at the
        // filesystem, even with the fixture directory pointed at a path that
        // does not exist.
        await expect(checkUpstreamFixtures(client)).resolves.toEqual({
          ok: true,
        })
        expectNoFixtureIo("after the pre-flight check")

        const events: Array<RunEvent> = []
        for await (const event of createRunCoordinator({
          registry,
          history,
          upstream: client,
        }).start(couponCode)) {
          events.push(event)
        }

        const terminal = events.at(-1)
        if (terminal === undefined || terminal.type !== "run-completed") {
          throw new Error(
            `expected a run-completed event, got ${terminal?.type ?? "no event at all"}`
          )
        }
        const result: RedemptionRunResult = terminal.result

        expect(result.mock).toBe(false)
        expect(result.couponCode).toBe(couponCode)

        // One `fetch` per processed Group_Member, carrying that Group_Member's
        // Hive_ID and the submitted Coupon_Code.
        expect(recorded).toHaveLength(expectation.requests)
        recorded.forEach((call, position) => {
          expect(call.url).toBe(
            useCouponEndpoint("https://event.invalid/ci/smon/evt_coupon")
          )
          expect(call.fields).toEqual({
            ...FIXED_REQUEST_FIELDS,
            hiveid: fixedList[position].hiveId,
            coupon: couponCode,
          })
        })

        // Every Member_Outcome follows from the response the injected `fetch`
        // returned, Upstream_Result included.
        expect(result.outcomes.map((outcome) => outcome.outcome)).toEqual(
          expectation.outcomes
        )
        result.outcomes.forEach((outcome, position) => {
          const step = steps[position]
          if (position >= expectation.requests) {
            expect(outcome.outcome).toBe("SKIPPED")
            expect(outcome.upstreamResult).toBeNull()
            return
          }

          exercised.add(step.kind)
          expect(outcome.upstreamResult).toEqual(
            parseUpstreamBody({
              bodyText: rawResponseOf(step).bodyText,
              transportFailure: rawResponseOf(step).transportFailure,
            })
          )

          // The message came from the generated response body, not from a
          // fixture body.
          if (isResponded(step)) {
            if (step.message !== null) {
              expect(outcome.upstreamResult?.responseMessage).toBe(step.message)
              expect(outcome.upstreamResult?.responseMessage).toContain(
                LIVE_MESSAGE_MARKER
              )
            }
            expect(
              FIXTURE_MESSAGES.has(
                outcome.upstreamResult?.responseMessage ?? ""
              ),
              "the response message is not a fixture message"
            ).toBe(false)
          }
        })

        expectNoFixtureIo("at the end of the Redemption_Run")
      }),
      { numRuns: 100 }
    )

    // The generated runs exercised the success path and all three failure
    // exits, so the zero-fixture-read assertions above covered each of them.
    expect([...exercised].sort()).toEqual([
      "network",
      "non-2xx",
      "ok",
      "timeout",
    ])
  })
})
