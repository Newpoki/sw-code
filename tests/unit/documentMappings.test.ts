import { describe, expect, it } from "vitest"

import {
  fromHistoryDocument,
  fromMemberDocument,
  toHistoryDocument,
  toMemberDocument,
} from "@/server/store/documents.server"
import type {
  MemberRegistryEntry,
  RedemptionHistoryRecord,
} from "@/domain/types"

/**
 * The mapping surface of `src/server/store/documents.server.ts`
 * (Requirements 2.10, 3.8).
 *
 * Criteria 2.10 and 3.8 ask only that the four mappings exist. This file is that
 * assertion and nothing more: each of the four is exported, is callable, and
 * hands back a value of the right shape for one concrete example. "Right shape"
 * means the field set — that a Store_Document carries `entryId` rather than `id`
 * and a BSON `Date`, that a history Store_Document carries the derived
 * `completedAtMs`, and that neither derived field leaks back into the domain.
 *
 * The claims that hold for *every* input — that a round trip through either pair
 * returns the original value (Requirements 2.11, 3.9) — belong to
 * `tests/property/memberDocumentRoundTrip.property.test.ts` and
 * `tests/property/historyDocumentRoundTrip.property.test.ts`. Nothing here
 * restates them, so a change in the round-trip contract has exactly one place to
 * fail.
 */

/** One Member_Registry entry, with the ISO creation timestamp the domain holds. */
const ENTRY: MemberRegistryEntry = {
  id: "entry-a1",
  memberLabel: "Ada Lovelace",
  hiveId: "hive-ada",
  enabled: true,
  createdAt: "2024-03-01T12:00:00.000Z",
}

/** One Redemption_History record, with a single outcome row. */
const RECORD: RedemptionHistoryRecord = {
  runId: "run-a1",
  seq: 4,
  couponCode: "SPRING2024",
  completedAt: "2024-03-01T12:00:05.000Z",
  mock: false,
  stoppedEarly: false,
  outcomes: [
    {
      hiveId: "hive-ada",
      memberLabel: "Ada Lovelace",
      outcome: "SUCCESS",
      responseCode: "0",
      responseMessage: "redeemed",
    },
  ],
}

describe("the four mappings are exported and callable (Requirements 2.10, 3.8)", () => {
  it.each([
    ["toMemberDocument", toMemberDocument],
    ["fromMemberDocument", fromMemberDocument],
    ["toHistoryDocument", toHistoryDocument],
    ["fromHistoryDocument", fromHistoryDocument],
  ])("exports %s as a function", (_name, mapping) => {
    expect(typeof mapping).toBe("function")
  })
})

describe("toMemberDocument returns a Member_Registry Store_Document", () => {
  const document = toMemberDocument(ENTRY, 7)

  it("carries the document field set, with no _id of its own", () => {
    expect(Object.keys(document).sort()).toEqual([
      "createdAt",
      "enabled",
      "entryId",
      "hiveId",
      "memberLabel",
      "position",
    ])
  })

  it("holds the domain id as entryId, the creation timestamp as a Date, and the supplied position", () => {
    expect(document.entryId).toBe(ENTRY.id)
    expect(document.createdAt).toBeInstanceOf(Date)
    expect(document.position).toBe(7)
  })
})

describe("fromMemberDocument returns a Member_Registry entry", () => {
  const entry = fromMemberDocument({
    entryId: "entry-b2",
    memberLabel: "Grace Hopper",
    hiveId: "hive-grace",
    enabled: false,
    createdAt: new Date("2024-04-02T09:30:00.000Z"),
    position: 3,
  })

  it("carries the domain field set, dropping position", () => {
    expect(Object.keys(entry).sort()).toEqual([
      "createdAt",
      "enabled",
      "hiveId",
      "id",
      "memberLabel",
    ])
  })

  it("holds entryId as the domain id and the creation timestamp as an ISO string", () => {
    expect(entry.id).toBe("entry-b2")
    expect(entry.createdAt).toBe("2024-04-02T09:30:00.000Z")
  })
})

describe("toHistoryDocument returns a Redemption_History Store_Document", () => {
  const document = toHistoryDocument(RECORD)

  it("carries the document field set, including the derived completedAtMs", () => {
    expect(Object.keys(document).sort()).toEqual([
      "completedAt",
      "completedAtMs",
      "couponCode",
      "mock",
      "outcomes",
      "runId",
      "seq",
      "stoppedEarly",
    ])
  })

  it("derives completedAtMs beside the stored completion timestamp", () => {
    expect(document.completedAt).toBe(RECORD.completedAt)
    expect(document.completedAtMs).toBe(Date.parse(RECORD.completedAt))
  })

  it("gives each outcome row the five stored fields, in its own object", () => {
    expect(document.outcomes).toHaveLength(1)
    expect(Object.keys(document.outcomes[0]).sort()).toEqual([
      "hiveId",
      "memberLabel",
      "outcome",
      "responseCode",
      "responseMessage",
    ])
    expect(document.outcomes[0]).not.toBe(RECORD.outcomes[0])
  })
})

describe("fromHistoryDocument returns a Redemption_History record", () => {
  const record = fromHistoryDocument(toHistoryDocument(RECORD))

  it("carries the domain field set, dropping the derived completedAtMs", () => {
    expect(Object.keys(record).sort()).toEqual([
      "completedAt",
      "couponCode",
      "mock",
      "outcomes",
      "runId",
      "seq",
      "stoppedEarly",
    ])
  })

  it("gives each outcome row the domain field set, in its own object", () => {
    expect(record.outcomes).toHaveLength(1)
    expect(Object.keys(record.outcomes[0]).sort()).toEqual([
      "hiveId",
      "memberLabel",
      "outcome",
      "responseCode",
      "responseMessage",
    ])
    expect(record.outcomes[0]).not.toBe(RECORD.outcomes[0])
  })
})
