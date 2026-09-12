/**
 * Property 10 of shared-coupon-redemption: an out-of-range Coupon_Code is
 * rejected without side effects.
 *
 * The claim is about what does *not* happen. A Coupon_Code holding zero
 * characters before trimming, zero characters after trimming, or more than 64
 * characters must be turned away by the Redemption_Server with a message stating
 * the permitted length of 1 to 64 characters, and the rejection must cost
 * nothing: not one Upstream_API request, not one Redemption_History record, not
 * one change to the Member_Registry.
 *
 * ## The harness is real on both sides of the boundary
 *
 * `runRedemptionEvents` is driven over a real `RunCoordinator` built on a real
 * Member_Registry and a real Redemption_History, with only two substitutions: a
 * `StubUpstreamClient` in place of the Upstream_API, so a request that should
 * never be issued is *counted* rather than sent, and a store whose flush
 * resolves without writing, over an unused temporary `DATA_FILE` path, so no
 * file is touched. "Zero Upstream_API requests" and "zero Redemption_History
 * records" are therefore read off the same collaborators the application uses,
 * not off a double that was told to expect nothing.
 *
 * Every roster generated here holds at least one enabled Group_Member and the
 * stub is scripted for every one of them, so a run *would* proceed if the
 * Coupon_Code check let it through. Without that, the property would pass on a
 * server that rejects every submission for an unrelated reason.
 *
 * ## The rule is restated, not borrowed
 *
 * {@link verdictOf} decides the expected verdict from the payload alone: read
 * `couponCode`, trim it, accept a length of 1 to 64 and reject everything else.
 * It does not call `couponCodeSchema`, because a test that asked the
 * implementation what it considers valid would agree with a broken
 * implementation. The one thing it does borrow is the maximum, asserted against
 * {@link COUPON_CODE_MAX_LENGTH} below so the literal 64 written into this file
 * cannot drift away from the schema.
 *
 * ## The complement keeps the property honest
 *
 * A Coupon_Code that *is* in range is generated too, and the same assertions run
 * with their sense reversed: the events begin with `run-started`, one request per
 * enabled Group_Member reaches the stub, and exactly one Redemption_History
 * record is appended. So the rejection branch cannot be satisfied by a server
 * that rejects everything.
 *
 * Payloads that are not even the right shape — a non-string `couponCode`, an
 * absent field, a value that is not an object at all — are generated alongside
 * the out-of-range strings. They must be turned away as the same single terminal
 * event rather than thrown out of the generator, which is what makes the
 * `unknown` parameter of `runRedemptionEvents` safe to expose to a caller. Their
 * message is only required to be non-empty: Property 10 speaks about a submitted
 * Coupon_Code, so the 1-to-64 sentence is demanded of the string cases.
 *
 * Validates: Requirements 2.10, 3.7
 */

import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"

import fc from "fast-check"
import { describe, expect, it } from "vitest"

import { COUPON_CODE_MAX_LENGTH } from "@/domain/schemas"
import { MEMBER_OUTCOME_VALUES } from "@/domain/types"
import {
  COUPON_CODE_RANGE_MESSAGE,
  PREFLIGHT_RUN_ID,
  runRedemptionEvents,
} from "@/server/run/redemptionRequest.server"
import { createRunCoordinator } from "@/server/run/coordinator.server"
import { createHistoryStore } from "@/server/store/history.server"
import { createJsonStore } from "@/server/store/jsonStore.server"
import { createMemberRegistryStore } from "@/server/store/memberRegistry.server"
import type {
  MemberRegistryEntry,
  RedemptionRunResult,
  RunEvent,
} from "@/domain/types"
import type { HistoryStore } from "@/server/store/history.server"
import type { MemberRegistryStore } from "@/server/store/memberRegistry.server"

import {
  StubUpstreamClient,
  respondWithBody,
} from "../support/stubUpstreamClient"
import {
  FIXTURE_BODIES,
  enabledEntries,
  invalidCouponCodeArb,
  rosterArb,
  validCouponCodeArb,
} from "./generators"

/* -------------------------------------------------------------------------- */
/* The rule, restated                                                         */
/* -------------------------------------------------------------------------- */

/** The permitted Coupon_Code length, written out rather than imported. */
const PERMITTED_MIN_LENGTH = 1
const PERMITTED_MAX_LENGTH = 64

/** A rejected submission must not push unbounded text back to the caller. */
const ECHO_LIMIT = PERMITTED_MAX_LENGTH

/**
 * How many entries a generated roster holds. Small on purpose: the property is
 * about whether a run starts at all, and one enabled Group_Member is enough to
 * make the difference observable, so there is nothing to buy by seeding a
 * hundred of them a hundred times over.
 */
const MAX_ROSTER_SIZE = 6

/** What the payload should produce, derived from the payload alone. */
interface Verdict {
  /** True when the Redemption_Server must turn the submission away. */
  readonly rejected: boolean
  /**
   * True when the rejection must state the permitted length of 1 to 64
   * characters, i.e. when a Coupon_Code was actually submitted and its trimmed
   * length falls outside that range.
   */
  readonly statesRange: boolean
  /** The Coupon_Code the rejection echoes back. */
  readonly echoedCouponCode: string
}

/**
 * Trim, then check 1 to 64. Nothing else, and nothing from `src/domain/schemas`.
 *
 * A payload that is not an object, or whose `couponCode` is not a string, submits
 * no Coupon_Code at all: it is rejected, and the 1-to-64 sentence is not
 * demanded of it.
 */
function verdictOf(payload: unknown): Verdict {
  if (typeof payload !== "object" || payload === null) {
    return { rejected: true, statesRange: false, echoedCouponCode: "" }
  }

  const { couponCode } = payload as { readonly couponCode?: unknown }
  if (typeof couponCode !== "string") {
    return { rejected: true, statesRange: false, echoedCouponCode: "" }
  }

  const trimmed = couponCode.trim()
  const inRange =
    trimmed.length >= PERMITTED_MIN_LENGTH &&
    trimmed.length <= PERMITTED_MAX_LENGTH

  return {
    rejected: !inRange,
    statesRange: !inRange,
    echoedCouponCode: trimmed.slice(0, ECHO_LIMIT),
  }
}

/* -------------------------------------------------------------------------- */
/* Payloads                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A payload carrying an out-of-range Coupon_Code: the empty string,
 * whitespace only, over 64 characters, and over 64 characters wrapped in
 * whitespace padding. These are the three cases Property 10 enumerates.
 */
const outOfRangePayloadArb: fc.Arbitrary<unknown> = invalidCouponCodeArb.map(
  (couponCode) => ({ couponCode })
)

/** A payload that is not the shape the endpoint accepts. */
const malformedPayloadArb: fc.Arbitrary<unknown> = fc.oneof<
  Array<fc.Arbitrary<unknown>>
>(
  // The field is absent, or spelled differently.
  fc.constant({}),
  fc.record({ coupon: fc.string({ unit: "grapheme-ascii" }) }),
  // The field is present but is not a string.
  fc
    .oneof<Array<fc.Arbitrary<unknown>>>(
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
      fc.array(fc.string({ unit: "grapheme-ascii" }), { maxLength: 2 }),
      fc.record({ value: fc.string({ unit: "grapheme-ascii" }) })
    )
    .map((couponCode) => ({ couponCode })),
  // The payload is not an object at all.
  fc.constant(null),
  fc.constant(undefined),
  fc.integer(),
  fc.boolean(),
  fc.string({ unit: "grapheme-ascii" }),
  fc.array(fc.integer(), { maxLength: 2 })
)

/** A payload carrying a Coupon_Code the Redemption_Server must admit. */
const inRangePayloadArb: fc.Arbitrary<unknown> = validCouponCodeArb.map(
  (couponCode) => ({ couponCode })
)

/**
 * Any payload. Weighted towards the rejections this property is about, with
 * enough in-range samples that the complement is exercised on every run.
 */
const payloadArb: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 5, arbitrary: outOfRangePayloadArb },
  { weight: 3, arbitrary: malformedPayloadArb },
  { weight: 3, arbitrary: inRangePayloadArb }
)

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface Harness {
  readonly registry: MemberRegistryStore
  readonly history: HistoryStore
  readonly upstream: StubUpstreamClient
  readonly fixedList: readonly MemberRegistryEntry[]
  readonly submit: (payload: unknown) => Promise<RunEvent[]>
}

/**
 * A redemption surface over real stores, a real coordinator, and a stub
 * Upstream_API scripted with one `SUCCESS` response per enabled Group_Member, so
 * an admitted run completes and a withheld one leaves the whole script unused.
 *
 * The roster is seeded through the Member_Registry itself rather than injected,
 * so the fixed list is produced by the same `listEnabled()` the application
 * reads (Requirements 1.1, 1.6, 1.9).
 */
async function createHarness(
  roster: readonly MemberRegistryEntry[]
): Promise<Harness> {
  const store = createJsonStore({
    dataFilePath: join(
      tmpdir(),
      `scr-coupon-rejection-${randomUUID()}`,
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

  const fixedList = registry.listEnabled()
  const history = createHistoryStore(store)
  const upstream = new StubUpstreamClient({
    script: fixedList.map(() =>
      respondWithBody(FIXTURE_BODIES["success-100.json"])
    ),
  })
  const coordinator = createRunCoordinator({ registry, history, upstream })

  return {
    registry,
    history,
    upstream,
    fixedList,
    submit: async (payload) => {
      const events: RunEvent[] = []
      for await (const event of runRedemptionEvents(
        { coordinator, upstream },
        payload
      )) {
        events.push(event)
      }
      return events
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Assertions                                                                 */
/* -------------------------------------------------------------------------- */

/** The result set carried by a terminal event. */
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

/** All six counts present and zero: no Group_Member was ever considered. */
function expectEveryCountZero(result: RedemptionRunResult): void {
  expect(Object.keys(result.counts).sort()).toEqual(
    [...MEMBER_OUTCOME_VALUES].sort()
  )
  for (const value of MEMBER_OUTCOME_VALUES) {
    expect(result.counts[value]).toBe(0)
  }
}

/* -------------------------------------------------------------------------- */
/* Property                                                                   */
/* -------------------------------------------------------------------------- */

describe("out-of-range Coupon_Code rejection", () => {
  it("keeps the permitted maximum of this test aligned with the schema", () => {
    expect(COUPON_CODE_MAX_LENGTH).toBe(PERMITTED_MAX_LENGTH)
    expect(COUPON_CODE_RANGE_MESSAGE).toContain(String(PERMITTED_MIN_LENGTH))
    expect(COUPON_CODE_RANGE_MESSAGE).toContain(String(PERMITTED_MAX_LENGTH))
  })

  // Feature: shared-coupon-redemption, Property 10: The server rejects
  // out-of-range Coupon_Codes without side effects — For any submitted
  // Coupon_Code that holds zero characters before trimming, zero characters
  // after trimming, or more than 64 characters, the Redemption_Server rejects
  // the request with a message stating the permitted length of 1 to 64
  // characters, issues zero Upstream_API requests, and appends zero
  // Redemption_History records.
  // Validates: Requirements 2.10, 3.7
  it("rejects it with the 1-to-64 message, no upstream request, and no history record", async () => {
    await fc.assert(
      fc.asyncProperty(
        rosterArb({
          minLength: 1,
          maxLength: MAX_ROSTER_SIZE,
          atLeastOneEnabled: true,
        }),
        payloadArb,
        async (roster, payload) => {
          const harness = await createHarness(roster)

          // A run would otherwise proceed: the fixed list is non-empty, so a
          // withheld request is withheld because of the Coupon_Code and for no
          // other reason.
          expect(harness.fixedList.length).toBeGreaterThan(0)
          expect(harness.fixedList).toHaveLength(enabledEntries(roster).length)

          const rosterBefore = harness.registry.list()
          const historyBefore = harness.history.list()
          expect(historyBefore).toEqual([])

          const events = await harness.submit(payload)
          const verdict = verdictOf(payload)

          if (verdict.rejected) {
            // Exactly one event, and it is terminal.
            expect(events).toHaveLength(1)
            const event = events[0]
            expect(event.type).toBe("run-failed")
            if (event.type !== "run-failed") return

            expect(event.runId).toBe(PREFLIGHT_RUN_ID)
            expect(typeof event.message).toBe("string")
            expect(event.message.length).toBeGreaterThan(0)
            if (verdict.statesRange) {
              expect(event.message).toBe(COUPON_CODE_RANGE_MESSAGE)
              expect(event.message).toContain(String(PERMITTED_MIN_LENGTH))
              expect(event.message).toContain(String(PERMITTED_MAX_LENGTH))
            }

            const result = event.result
            expect(result.runId).toBe(PREFLIGHT_RUN_ID)
            expect(result.couponCode).toBe(verdict.echoedCouponCode)
            expect(result.outcomes).toEqual([])
            expectEveryCountZero(result)
            expect(result.warnings).toEqual([])
            expect(result.stoppedEarly).toBe(false)

            // Requirements 2.10, 3.7: every Upstream_API request withheld.
            expect(harness.upstream.callCount).toBe(0)
            expect(harness.upstream.requests).toEqual([])

            // Requirements 2.10, 3.7: the Redemption_History unchanged.
            expect(harness.history.list()).toEqual([])
          } else {
            // The complement, so the rejection branch above cannot be satisfied
            // by a Redemption_Server that turns every submission away.
            expect(events.length).toBeGreaterThan(1)
            expect(events[0]?.type).toBe("run-started")

            const result = terminalResult(events)
            expect(result.runId).not.toBe(PREFLIGHT_RUN_ID)
            expect(result.couponCode).toBe(verdict.echoedCouponCode)
            expect(result.outcomes).toHaveLength(harness.fixedList.length)

            // One request per enabled Group_Member, and one history record.
            expect(harness.upstream.callCount).toBe(harness.fixedList.length)
            expect(harness.history.list()).toHaveLength(1)
            expect(harness.history.list()[0]?.couponCode).toBe(
              verdict.echoedCouponCode
            )
          }

          // Neither branch touches the roster.
          expect(harness.registry.list()).toEqual(rosterBefore)
        }
      ),
      { numRuns: 100 }
    )
  })
})
