import { describe, expect, it } from "vitest"
import {
  countOutcomes,
  emptyOutcomeCounts,
  missingSkippedOutcomes,
  skippedOutcome,
} from "@/domain/outcomes"
import { MEMBER_OUTCOME_VALUES } from "@/domain/types"
import type { MemberOutcome, UpstreamResult } from "@/domain/types"

function upstream(
  outcome: Exclude<UpstreamResult["outcome"], "SKIPPED">
): UpstreamResult {
  return { responseCode: "100", responseMessage: "ok", outcome }
}

function outcomeAt(
  position: number,
  outcome: Exclude<MemberOutcome["outcome"], "SKIPPED">
): MemberOutcome {
  return {
    hiveId: `hive-${position}`,
    memberLabel: `Member ${position}`,
    position,
    outcome,
    upstreamResult: upstream(outcome),
  }
}

describe("emptyOutcomeCounts", () => {
  it("holds all six Member_Outcome keys at zero in MEMBER_OUTCOME_VALUES order", () => {
    const counts = emptyOutcomeCounts()

    expect(Object.keys(counts)).toEqual([...MEMBER_OUTCOME_VALUES])
    expect(Object.values(counts)).toEqual([0, 0, 0, 0, 0, 0])
  })

  it("returns a fresh object on every call", () => {
    expect(emptyOutcomeCounts()).not.toBe(emptyOutcomeCounts())
  })
})

describe("countOutcomes", () => {
  it("returns all six keys with zero counts for an empty run", () => {
    expect(countOutcomes([])).toEqual({
      SUCCESS: 0,
      ALREADY_USED: 0,
      INVALID_COUPON: 0,
      SKIPPED: 0,
      UPSTREAM_ERROR: 0,
      TRANSPORT_ERROR: 0,
    })
  })

  it("keys are in MEMBER_OUTCOME_VALUES order regardless of processing order", () => {
    const counts = countOutcomes([
      outcomeAt(0, "TRANSPORT_ERROR"),
      outcomeAt(1, "SUCCESS"),
    ])

    expect(Object.keys(counts)).toEqual([...MEMBER_OUTCOME_VALUES])
  })

  it("counts every outcome value, and the six counts sum to the outcome count", () => {
    const outcomes: MemberOutcome[] = [
      outcomeAt(0, "SUCCESS"),
      outcomeAt(1, "SUCCESS"),
      outcomeAt(2, "ALREADY_USED"),
      outcomeAt(3, "UPSTREAM_ERROR"),
      outcomeAt(4, "TRANSPORT_ERROR"),
      outcomeAt(5, "INVALID_COUPON"),
      skippedOutcome({ hiveId: "hive-6", memberLabel: "Member 6" }, 6),
      skippedOutcome({ hiveId: "hive-7", memberLabel: "Member 7" }, 7),
    ]

    const counts = countOutcomes(outcomes)

    expect(counts).toEqual({
      SUCCESS: 2,
      ALREADY_USED: 1,
      INVALID_COUPON: 1,
      SKIPPED: 2,
      UPSTREAM_ERROR: 1,
      TRANSPORT_ERROR: 1,
    })
    expect(
      MEMBER_OUTCOME_VALUES.reduce((sum, value) => sum + counts[value], 0)
    ).toBe(outcomes.length)
  })
})

describe("skippedOutcome", () => {
  it("copies the roster identity, records the position, and issues no upstream result", () => {
    expect(
      skippedOutcome({ hiveId: "1234567890", memberLabel: "Alice" }, 3)
    ).toEqual({
      hiveId: "1234567890",
      memberLabel: "Alice",
      position: 3,
      outcome: "SKIPPED",
      upstreamResult: null,
    })
  })
})

describe("missingSkippedOutcomes", () => {
  const fixedList = [
    { hiveId: "a", memberLabel: "Alice" },
    { hiveId: "b", memberLabel: "Bob" },
    { hiveId: "c", memberLabel: "Carol" },
  ]

  it("skips exactly the uncovered positions, in ascending order", () => {
    const missing = missingSkippedOutcomes(fixedList, [outcomeAt(0, "SUCCESS")])

    expect(missing.map((outcome) => outcome.position)).toEqual([1, 2])
    expect(missing.map((outcome) => outcome.hiveId)).toEqual(["b", "c"])
    expect(missing.map((outcome) => outcome.upstreamResult)).toEqual([
      null,
      null,
    ])
  })

  it("skips the whole fixed list when a run failed before its first request", () => {
    expect(missingSkippedOutcomes(fixedList, [])).toHaveLength(fixedList.length)
  })

  it("returns nothing when every position already holds an outcome", () => {
    const outcomes = [
      outcomeAt(0, "SUCCESS"),
      outcomeAt(1, "ALREADY_USED"),
      outcomeAt(2, "INVALID_COUPON"),
    ]

    expect(missingSkippedOutcomes(fixedList, outcomes)).toEqual([])
  })

  it("keeps the outcome count equal to the fixed-list size", () => {
    const outcomes = [outcomeAt(0, "INVALID_COUPON")]
    const complete = [
      ...outcomes,
      ...missingSkippedOutcomes(fixedList, outcomes),
    ]

    expect(complete).toHaveLength(fixedList.length)
    expect(countOutcomes(complete).SKIPPED).toBe(2)
  })
})
