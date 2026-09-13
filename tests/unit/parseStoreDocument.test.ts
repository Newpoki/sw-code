/**
 * `parseStoreDocument`: the definition of "the expected shape".
 *
 * `jsonStore.server.ts` is retired as a live store by the
 * mongodb-google-auth-admin feature — the Mongo_Store is the only store on a
 * request path now. But `parseStoreDocument` survives, exported and tested,
 * because it is the reader the Data_Import reads the Legacy_Json_Store through:
 * it is exactly the "expected shape" Requirement 4.1 turns on, and its three
 * failure modes are the three conditions Requirement 4.4 names (absent /
 * unreadable file is handled by the caller; a file that does not parse is this
 * function's `{ ok: false }`).
 *
 * These tests frame `parseStoreDocument` as that definition: a well-formed
 * document parses into a list of Member_Registry entries and a list of
 * Redemption_History records, each list holding zero or more elements; anything
 * the store cannot serve is reported as a reason rather than half-understood;
 * and `nextHistorySeq` is repaired to `max(highest retained seq + 1, declared,
 * 1)` so the append counter never lands on or below a value a retained record
 * already holds.
 *
 * No filesystem, no store construction: this is the pure parser over strings.
 */

import { describe, expect, it } from "vitest"

import {
  STORE_VERSION,
  parseStoreDocument,
} from "@/server/store/jsonStore.server"
import type {
  MemberRegistryEntry,
  RedemptionHistoryRecord,
} from "@/domain/types"

/** A valid Member_Registry entry, overridable field by field. */
function member(
  overrides: Partial<MemberRegistryEntry> = {}
): MemberRegistryEntry {
  return {
    id: "member-1",
    memberLabel: "Alice",
    hiveId: "1001",
    enabled: true,
    createdAt: "2025-01-04T18:00:00.000Z",
    ...overrides,
  }
}

/** A valid Redemption_History record with one outcome row, overridable. */
function record(
  overrides: Partial<RedemptionHistoryRecord> = {}
): RedemptionHistoryRecord {
  return {
    runId: "run-1",
    seq: 1,
    couponCode: "COUPON-1",
    completedAt: "2025-01-04T18:05:00.000Z",
    mock: false,
    stoppedEarly: false,
    outcomes: [
      {
        hiveId: "1001",
        memberLabel: "Alice",
        outcome: "SUCCESS",
        responseCode: "100",
        responseMessage: "The coupon gift has been sent.",
      },
    ],
    ...overrides,
  }
}

/** Serializes a value the way a real `DATA_FILE` holds it. */
function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/* -------------------------------------------------------------------------- */
/* The expected shape: a well-formed document parses                          */
/* -------------------------------------------------------------------------- */

describe("a well-formed document parses to { ok: true } with its lists preserved", () => {
  it("keeps every member and every history record, in order", () => {
    const members = [
      member({ id: "member-1", hiveId: "1001", memberLabel: "Alice" }),
      member({ id: "member-2", hiveId: "1002", memberLabel: "Bob" }),
    ]
    const history = [
      record({ runId: "run-1", seq: 1, couponCode: "COUPON-1" }),
      record({ runId: "run-2", seq: 2, couponCode: "COUPON-2" }),
    ]

    const result = parseStoreDocument(
      serialize({ version: STORE_VERSION, nextHistorySeq: 3, members, history })
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document.version).toBe(STORE_VERSION)
    expect(result.document.members).toEqual(members)
    expect(result.document.history).toEqual(history)
  })

  it("parses an empty document (members: [], history: []) as ok", () => {
    const result = parseStoreDocument(
      serialize({
        version: STORE_VERSION,
        nextHistorySeq: 1,
        members: [],
        history: [],
      })
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document.members).toEqual([])
    expect(result.document.history).toEqual([])
    // An empty history leaves the counter at its floor of 1.
    expect(result.document.nextHistorySeq).toBe(1)
  })
})

/* -------------------------------------------------------------------------- */
/* nextHistorySeq is repaired to max(highest seq + 1, declared, 1)            */
/* -------------------------------------------------------------------------- */

describe("nextHistorySeq is repaired to max(highest retained seq + 1, declared, 1)", () => {
  it("raises a declared counter that lags behind the highest retained seq", () => {
    // Declared 4, but a retained record already holds seq 9: the counter must
    // land at 10 so the next append cannot collide with a retained value.
    const result = parseStoreDocument(
      serialize({
        version: STORE_VERSION,
        nextHistorySeq: 4,
        members: [],
        history: [record({ runId: "run-9", seq: 9 })],
      })
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document.nextHistorySeq).toBe(10)
  })

  it("keeps a declared counter that already leads the highest retained seq", () => {
    const result = parseStoreDocument(
      serialize({
        version: STORE_VERSION,
        nextHistorySeq: 50,
        members: [],
        history: [record({ runId: "run-9", seq: 9 })],
      })
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document.nextHistorySeq).toBe(50)
  })

  it("falls back to one past the highest retained seq when nextHistorySeq is absent", () => {
    const result = parseStoreDocument(
      serialize({
        version: STORE_VERSION,
        members: [],
        history: [
          record({ runId: "run-2", seq: 2 }),
          record({ runId: "run-7", seq: 7 }),
        ],
      })
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document.nextHistorySeq).toBe(8)
  })

  it("treats a NaN nextHistorySeq as absent and repairs from the history", () => {
    // JSON has no NaN literal; a non-numeric value stands in for a counter the
    // parser cannot use.
    const result = parseStoreDocument(
      serialize({
        version: STORE_VERSION,
        nextHistorySeq: "not-a-number",
        members: [],
        history: [record({ runId: "run-4", seq: 4 })],
      })
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document.nextHistorySeq).toBe(5)
  })

  it("never drops below the floor of 1 for an empty history and no declared counter", () => {
    const result = parseStoreDocument(
      serialize({ version: STORE_VERSION, members: [], history: [] })
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document.nextHistorySeq).toBe(1)
  })
})

/* -------------------------------------------------------------------------- */
/* Rejections: anything the store cannot serve is a reason, not a repair      */
/* -------------------------------------------------------------------------- */

describe("a document the store cannot serve is rejected with a reason", () => {
  it("rejects text that is not valid JSON", () => {
    const result = parseStoreDocument("}{ not JSON at all \u0000")

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain("valid JSON")
  })

  it("rejects valid JSON that is not an object", () => {
    for (const nonObject of ["[]", "42", '"a string"', "null", "true"]) {
      const result = parseStoreDocument(nonObject)
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.reason).toContain("not a JSON object")
    }
  })

  it("rejects a document carrying the wrong version", () => {
    const result = parseStoreDocument(
      serialize({ version: 999, nextHistorySeq: 1, members: [], history: [] })
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain("999")
    expect(result.reason).toContain(String(STORE_VERSION))
  })

  it("rejects a missing members field", () => {
    const result = parseStoreDocument(
      serialize({ version: STORE_VERSION, nextHistorySeq: 1, history: [] })
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain("members array")
  })

  it("rejects a members field that is not an array", () => {
    const result = parseStoreDocument(
      serialize({
        version: STORE_VERSION,
        nextHistorySeq: 1,
        members: "nope",
        history: [],
      })
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain("members array")
  })

  it("rejects a members array holding a malformed entry", () => {
    const result = parseStoreDocument(
      serialize({
        version: STORE_VERSION,
        nextHistorySeq: 1,
        // `enabled` is the wrong type, so the row is not a Member_Registry entry.
        members: [{ ...member(), enabled: "yes" }],
        history: [],
      })
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain("members array")
  })

  it("rejects a missing history field", () => {
    const result = parseStoreDocument(
      serialize({ version: STORE_VERSION, nextHistorySeq: 1, members: [] })
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain("history array")
  })

  it("rejects a history field that is not an array", () => {
    const result = parseStoreDocument(
      serialize({
        version: STORE_VERSION,
        nextHistorySeq: 1,
        members: [],
        history: { seq: 1 },
      })
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain("history array")
  })

  it("rejects a history record whose seq is non-finite", () => {
    // A finite `seq` is what the retention tie-break in Requirement 3.4 sorts
    // on, so a non-finite one makes the whole document unusable.
    const result = parseStoreDocument(
      serialize({
        version: STORE_VERSION,
        nextHistorySeq: 1,
        members: [],
        history: [{ ...record(), seq: null }],
      })
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain("history array")
  })

  it("rejects a history record whose outcome row is malformed", () => {
    const result = parseStoreDocument(
      serialize({
        version: STORE_VERSION,
        nextHistorySeq: 1,
        members: [],
        history: [
          {
            ...record(),
            outcomes: [
              {
                hiveId: "1001",
                memberLabel: "Alice",
                // Not one of the six Member_Outcome values.
                outcome: "MAYBE",
                responseCode: "100",
                responseMessage: "ok",
              },
            ],
          },
        ],
      })
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain("history array")
  })
})
