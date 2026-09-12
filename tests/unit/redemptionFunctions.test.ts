/**
 * The redemption server function surface (Requirements 2.10, 3.2, 3.7, 3.8, 3.9).
 *
 * These drive `runRedemptionEvents` and `readActiveRun` from
 * `src/server/run/redemptionRequest.server.ts` directly, over an injected coordinator
 * and a `StubUpstreamClient`: no `createServerFn` call site, no HTTP, no store,
 * and no filesystem access. The Mock_Mode fixture rejection and the full
 * pre-flight matrix belong to the integration tests of task 10.6.
 */

import { describe, expect, it } from "vitest"

import { emptyOutcomeCounts } from "@/domain/outcomes"
import {
  COUPON_CODE_RANGE_MESSAGE,
  PREFLIGHT_RUN_ID,
  readActiveRun,
  runRedemptionEvents,
} from "@/server/run/redemptionRequest.server"
import {
  RunStartError,
  noEnabledMembersMessage,
  runInProgressMessage,
} from "@/server/run/coordinator.server"
import { StubUpstreamClient } from "../support/stubUpstreamClient"
import type { ActiveRunSnapshot, RunEvent } from "@/domain/types"
import type { RunCoordinator } from "@/server/run/coordinator.server"

/** A coordinator that records its calls and replays scripted events. */
function scriptedCoordinator(
  events: readonly RunEvent[],
  snapshot: ActiveRunSnapshot | null = null
): RunCoordinator & { readonly startedWith: string[] } {
  const startedWith: string[] = []
  return {
    startedWith,
    start: async function* (couponCode) {
      startedWith.push(couponCode)
      for (const event of events) {
        yield event
      }
    },
    snapshot: () => snapshot,
  }
}

/** A coordinator whose `start` rejects on the first `next()`. */
function rejectingCoordinator(
  error: Error
): RunCoordinator & { readonly startedWith: string[] } {
  const startedWith: string[] = []
  return {
    startedWith,
    // eslint-disable-next-line require-yield -- rejecting before the first yield is exactly what the coordinator does for a pre-flight rejection
    start: async function* (couponCode) {
      startedWith.push(couponCode)
      throw error
    },
    snapshot: () => null,
  }
}

async function collect(
  events: AsyncGenerator<RunEvent, void, void>
): Promise<RunEvent[]> {
  const collected: RunEvent[] = []
  for await (const event of events) {
    collected.push(event)
  }
  return collected
}

/** Asserts the shape every pre-flight rejection shares. */
function expectPreflightRejection(
  events: readonly RunEvent[],
  couponCode: string,
  message: string
): void {
  expect(events).toHaveLength(1)
  const event = events[0]
  expect(event.type).toBe("run-failed")
  if (event.type !== "run-failed") return

  expect(event.runId).toBe(PREFLIGHT_RUN_ID)
  expect(event.message).toBe(message)
  expect(event.result.outcomes).toEqual([])
  expect(event.result.counts).toEqual(emptyOutcomeCounts())
  expect(event.result.warnings).toEqual([])
  expect(event.result.stoppedEarly).toBe(false)
  expect(event.result.couponCode).toBe(couponCode)
}

describe("an out-of-range Coupon_Code (Requirements 2.10, 3.7)", () => {
  it.each([
    ["zero characters before trimming", ""],
    ["whitespace only", "   \t\n "],
    ["65 characters after trimming", `  ${"c".repeat(65)}  `],
  ])(
    "is rejected without a run or a request: %s",
    async (_case, couponCode) => {
      const coordinator = scriptedCoordinator([])
      const upstream = new StubUpstreamClient()

      const events = await collect(
        runRedemptionEvents({ coordinator, upstream }, { couponCode })
      )

      expectPreflightRejection(
        events,
        couponCode.trim().slice(0, 64),
        COUPON_CODE_RANGE_MESSAGE
      )
      expect(coordinator.startedWith).toEqual([])
      expect(upstream.callCount).toBe(0)
    }
  )

  it("rejects a payload whose couponCode is not a string at all", async () => {
    const coordinator = scriptedCoordinator([])
    const upstream = new StubUpstreamClient()

    const events = await collect(
      runRedemptionEvents({ coordinator, upstream }, { couponCode: 42 })
    )

    expectPreflightRejection(events, "", COUPON_CODE_RANGE_MESSAGE)
    expect(coordinator.startedWith).toEqual([])
    expect(upstream.callCount).toBe(0)
  })
})

describe("a coordinator rejection becomes the same terminal event", () => {
  it("reports a Redemption_Run already in progress (Requirement 3.9)", async () => {
    const coordinator = rejectingCoordinator(
      new RunStartError("RUN_IN_PROGRESS", runInProgressMessage())
    )

    const events = await collect(
      runRedemptionEvents(
        { coordinator, upstream: new StubUpstreamClient() },
        { couponCode: " ABC123 " }
      )
    )

    expectPreflightRejection(events, "ABC123", runInProgressMessage())
    expect(coordinator.startedWith).toEqual(["ABC123"])
  })

  it("reports that no enabled Group_Member exists (Requirement 3.8)", async () => {
    const coordinator = rejectingCoordinator(
      new RunStartError("NO_ENABLED_MEMBERS", noEnabledMembersMessage())
    )

    const events = await collect(
      runRedemptionEvents(
        { coordinator, upstream: new StubUpstreamClient() },
        { couponCode: "ABC123" }
      )
    )

    expectPreflightRejection(events, "ABC123", noEnabledMembersMessage())
  })

  it("lets a failure that is not a RunStartError propagate", async () => {
    const coordinator = rejectingCoordinator(new Error("bug"))

    await expect(
      collect(
        runRedemptionEvents(
          { coordinator, upstream: new StubUpstreamClient() },
          { couponCode: "ABC123" }
        )
      )
    ).rejects.toThrow("bug")
  })
})

describe("a run that starts", () => {
  it("forwards the coordinator's events unchanged and passes only the trimmed Coupon_Code (Requirement 3.2)", async () => {
    const scripted: RunEvent[] = [
      {
        type: "run-started",
        runId: "run-1",
        total: 1,
        memberLabels: ["Ana"],
        mock: false,
      },
      {
        type: "member-outcome",
        runId: "run-1",
        processed: 1,
        total: 1,
        outcome: {
          hiveId: "hive-1",
          memberLabel: "Ana",
          position: 0,
          outcome: "SUCCESS",
          upstreamResult: {
            responseCode: "100",
            responseMessage: "The coupon gift has been sent.",
            outcome: "SUCCESS",
          },
        },
      },
    ]
    const coordinator = scriptedCoordinator(scripted)

    const events = await collect(
      runRedemptionEvents(
        { coordinator, upstream: new StubUpstreamClient() },
        { couponCode: "  ABC123  " }
      )
    )

    expect(events).toEqual(scripted)
    expect(coordinator.startedWith).toEqual(["ABC123"])
  })
})

describe("getActiveRun (Requirement 3.9)", () => {
  it("returns the coordinator's snapshot in a warning-free envelope", () => {
    const snapshot: ActiveRunSnapshot = {
      runId: "run-1",
      couponCode: "ABC123",
      startedAt: "2024-01-01T00:00:00.000Z",
      mock: true,
      total: 3,
      processed: 1,
      outcomes: [],
    }

    expect(readActiveRun(scriptedCoordinator([], snapshot))).toEqual({
      ok: true,
      data: snapshot,
      warnings: [],
    })
  })

  it("returns null while the Redemption_Server is idle", () => {
    expect(readActiveRun(scriptedCoordinator([]))).toEqual({
      ok: true,
      data: null,
      warnings: [],
    })
  })
})
