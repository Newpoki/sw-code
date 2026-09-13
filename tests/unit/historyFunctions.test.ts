/**
 * The Redemption_History envelope mapping (Requirements 6.6, 6.7 of the
 * shared-coupon-redemption spec; Requirement 3.10 of the
 * mongodb-google-auth-admin spec).
 *
 * These exercise the two envelope operations of
 * `src/functions/history.functions.ts` and their validators directly, over a
 * Redemption_History built on the in-memory Mongo_Store of
 * `tests/support/inMemoryMongoStore.ts`: no `createServerFn` call site, no HTTP,
 * and no deployment. Both reads are `async` now, so each envelope is awaited.
 *
 * The ordering itself is proved over generated records by
 * `tests/property/historyReadOrder.property.test.ts`, and it is the database's
 * sort rather than a comparator in this layer; what is asserted here is that this
 * layer passes the order through untouched, applies the limit, keeps the
 * Requirement 6.7 comparison character-exact, and turns a read that did not
 * complete into a rejection rather than into an empty page (Requirement 3.10).
 */

import { MongoServerError } from "mongodb"
import { describe, expect, it } from "vitest"

import { lengthRangeMessage } from "@/domain/schemas"
import {
  historyReadFailedMessage,
  notConfiguredMessage,
} from "@/domain/storeMessages"
import {
  HISTORY_LIMIT_MAX,
  limitRangeMessage,
  readHistory,
  readLatestRunForCoupon,
  validateFindLatestRunInput,
  validateListHistoryInput,
} from "@/functions/history.functions"
import { createHistoryStore } from "@/server/store/history.server"
import type { HistoryStore } from "@/server/store/history.server"

import { createInMemoryMongoStore } from "../support/inMemoryMongoStore"
import type { InMemoryMongoStoreHandle } from "../support/inMemoryMongoStore"

/** A deployment that answered, and its answer was no. */
function refused(): MongoServerError {
  return new MongoServerError({
    message: "Document failed validation",
    code: 121,
  })
}

/** A Redemption_History over a fresh in-memory store, and its handle. */
function emptyHistory(): {
  readonly handle: InMemoryMongoStoreHandle
  readonly history: HistoryStore
} {
  const handle = createInMemoryMongoStore()
  return {
    handle,
    history: createHistoryStore(handle.store, { logger: handle.logger }),
  }
}

/** Appends one record with no outcome rows; only ordering fields matter here. */
async function append(
  history: HistoryStore,
  couponCode: string,
  completedAt: string
): Promise<number> {
  const appended = await history.append({
    runId: `run-${couponCode}-${completedAt}`,
    couponCode,
    completedAt,
    mock: false,
    stoppedEarly: false,
    outcomes: [],
  })
  expect(appended.kind).toBe("appended")
  if (appended.kind !== "appended") {
    throw new Error(`the append reported "${appended.kind}"`)
  }
  return appended.record.seq
}

const EARLIER = "2025-01-04T18:00:00.000Z"
const LATER = "2025-01-04T19:00:00.000Z"

describe("the history read (Requirement 6.6)", () => {
  it("returns the store's ordering unchanged, with no warning", async () => {
    const { history } = emptyHistory()
    await append(history, "OLD", EARLIER)
    await append(history, "NEW", LATER)

    const envelope = await readHistory(history)

    expect(envelope.ok).toBe(true)
    if (!envelope.ok) return
    // Most recent completion timestamp first, exactly as `list()` returned it.
    expect(envelope.data.map((record) => record.couponCode)).toEqual([
      "NEW",
      "OLD",
    ])
    const listed = await history.list()
    expect(envelope.data).toEqual(
      listed.kind === "records" ? listed.records : null
    )
    expect(envelope.warnings).toEqual([])
  })

  it("breaks a shared completion timestamp by append order", async () => {
    const { history } = emptyHistory()
    const firstSeq = await append(history, "FIRST", EARLIER)
    const secondSeq = await append(history, "SECOND", EARLIER)
    expect(secondSeq).toBeGreaterThan(firstSeq)

    const envelope = await readHistory(history)

    expect(envelope.ok).toBe(true)
    if (!envelope.ok) return
    expect(envelope.data.map((record) => record.couponCode)).toEqual([
      "SECOND",
      "FIRST",
    ])
  })

  it("returns an empty list for an empty history", async () => {
    const envelope = await readHistory(emptyHistory().history)

    expect(envelope.ok).toBe(true)
    if (!envelope.ok) return
    expect(envelope.data).toEqual([])
  })

  it("caps to the submitted limit, keeping the newest records", async () => {
    const { history } = emptyHistory()
    await append(history, "OLD", EARLIER)
    await append(history, "MID", LATER)
    await append(history, "NEW", "2025-01-04T20:00:00.000Z")

    const capped = await readHistory(history, { limit: 2 })
    expect(capped.ok).toBe(true)
    if (!capped.ok) return
    expect(capped.data.map((record) => record.couponCode)).toEqual([
      "NEW",
      "MID",
    ])

    // An absent limit returns every retained record.
    const all = await readHistory(history, {})
    expect(all.ok && all.data).toHaveLength(3)
    const defaulted = await readHistory(history)
    expect(defaulted.ok && defaulted.data).toHaveLength(3)

    // A limit above the record count is not an error; it just returns them all.
    const generous = await readHistory(history, { limit: HISTORY_LIMIT_MAX })
    expect(generous.ok && generous.data).toHaveLength(3)
  })

  it("rejects with zero records when the read does not complete (Requirement 3.10)", async () => {
    const { handle, history } = emptyHistory()
    await append(history, "OLD", EARLIER)
    handle.setRejection("history", "find", refused())

    const envelope = await readHistory(history)

    /* Not an empty page: a Redemption_History that could not be read says so,
     * with the store's own sentence and no records at all. */
    expect(envelope.ok).toBe(false)
    if (envelope.ok) return
    expect(envelope.error.code).toBe("STORE_READ_FAILED")
    expect(envelope.error.message).toBe(historyReadFailedMessage())
  })

  it("reports STORE_UNAVAILABLE when nothing was attempted at all", async () => {
    const { handle, history } = emptyHistory()
    handle.setCollectionFailure("history", {
      reason: "not-configured",
      message: notConfiguredMessage(),
    })

    const envelope = await readHistory(history)

    expect(envelope.ok).toBe(false)
    if (envelope.ok) return
    expect(envelope.error.code).toBe("STORE_UNAVAILABLE")
    expect(envelope.error.message).toBe(notConfiguredMessage())
  })
})

describe("the latest run for a Coupon_Code (Requirement 6.7)", () => {
  it("returns the most recent record holding exactly that Coupon_Code", async () => {
    const { history } = emptyHistory()
    await append(history, "SUMMER2025", EARLIER)
    await append(history, "OTHER", LATER)
    await append(history, "SUMMER2025", LATER)

    const envelope = await readLatestRunForCoupon(history, {
      couponCode: "SUMMER2025",
    })

    expect(envelope.ok).toBe(true)
    if (!envelope.ok) return
    expect(envelope.data?.couponCode).toBe("SUMMER2025")
    expect(envelope.data?.completedAt).toBe(LATER)
    expect(envelope.warnings).toEqual([])
  })

  it("prefers the most recently appended record at a shared timestamp", async () => {
    const { history } = emptyHistory()
    const firstSeq = await append(history, "SUMMER2025", EARLIER)
    const secondSeq = await append(history, "SUMMER2025", EARLIER)

    const envelope = await readLatestRunForCoupon(history, {
      couponCode: "SUMMER2025",
    })

    expect(envelope.ok).toBe(true)
    if (!envelope.ok) return
    expect(envelope.data?.seq).toBe(secondSeq)
    expect(envelope.data?.seq).not.toBe(firstSeq)
  })

  it("returns null when no record holds that Coupon_Code", async () => {
    const { history } = emptyHistory()
    await append(history, "SUMMER2025", EARLIER)

    const envelope = await readLatestRunForCoupon(history, {
      couponCode: "WINTER",
    })

    /* Requirement 3.5: an answer of null, and zero error messages — not a
     * failure. */
    expect(envelope.ok).toBe(true)
    if (!envelope.ok) return
    expect(envelope.data).toBeNull()
  })

  it("treats a differing letter case as a different Coupon_Code", async () => {
    const { history } = emptyHistory()
    await append(history, "SUMMER2025", EARLIER)

    const lower = await readLatestRunForCoupon(history, {
      couponCode: "summer2025",
    })

    expect(lower.ok).toBe(true)
    if (!lower.ok) return
    expect(lower.data).toBeNull()
  })

  it("compares the trimmed value, so padding neither matches nor misses", async () => {
    const { history } = emptyHistory()
    await append(history, "SUMMER2025", EARLIER)

    // The validator trims, so a padded submission finds the stored code.
    const verdict = validateFindLatestRunInput({
      couponCode: "  SUMMER2025 \n",
    })
    expect(verdict).toEqual({ ok: true, value: { couponCode: "SUMMER2025" } })
    if (!verdict.ok) return

    const envelope = await readLatestRunForCoupon(history, verdict.value)
    expect(envelope.ok && envelope.data?.couponCode).toBe("SUMMER2025")

    // An inner whitespace difference is a different code, and stays one.
    const inner = await readLatestRunForCoupon(history, {
      couponCode: "SUMMER 2025",
    })
    expect(inner.ok && inner.data).toBeNull()
  })

  it("rejects rather than answering null when the read does not complete", async () => {
    const { handle, history } = emptyHistory()
    await append(history, "SUMMER2025", EARLIER)
    handle.setRejection("history", "find", refused())

    const envelope = await readLatestRunForCoupon(history, {
      couponCode: "SUMMER2025",
    })

    /* Requirement 3.10: "the lookup failed" and "the code was never redeemed"
     * are different answers, and the dialog needs to tell them apart. */
    expect(envelope.ok).toBe(false)
    if (envelope.ok) return
    expect(envelope.error.code).toBe("STORE_READ_FAILED")
    expect(envelope.error.message).toBe(historyReadFailedMessage())
  })
})

describe("the validators report instead of throwing", () => {
  it("accepts an absent payload as 'every retained record'", () => {
    expect(validateListHistoryInput(undefined)).toEqual({ ok: true, value: {} })
    expect(validateListHistoryInput({})).toEqual({ ok: true, value: {} })
    expect(validateListHistoryInput({ limit: 10 })).toEqual({
      ok: true,
      value: { limit: 10 },
    })
    expect(validateListHistoryInput({ limit: HISTORY_LIMIT_MAX })).toEqual({
      ok: true,
      value: { limit: HISTORY_LIMIT_MAX },
    })
  })

  it("rejects a non-integer, out-of-range, or absurd limit with the range message", () => {
    for (const limit of [
      0,
      -3,
      2.7,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      HISTORY_LIMIT_MAX + 1,
      1e21,
    ]) {
      expect(validateListHistoryInput({ limit })).toEqual({
        ok: false,
        message: limitRangeMessage(),
      })
    }
    expect(limitRangeMessage()).toContain("1")
    expect(limitRangeMessage()).toContain(String(HISTORY_LIMIT_MAX))
  })

  it("rejects a limit of the wrong type rather than throwing", () => {
    const verdict = validateListHistoryInput({
      limit: "20" as unknown as number,
    })
    expect(verdict).toEqual({ ok: false, message: limitRangeMessage() })
  })

  it("rejects a Coupon_Code outside 1 to 64 characters", () => {
    expect(validateFindLatestRunInput({ couponCode: "   " })).toEqual({
      ok: false,
      message: lengthRangeMessage("Coupon_Code", 1, 64),
    })
    expect(validateFindLatestRunInput({ couponCode: "x".repeat(65) })).toEqual({
      ok: false,
      message: lengthRangeMessage("Coupon_Code", 1, 64),
    })

    const verdict = validateFindLatestRunInput(
      "not an object" as unknown as { couponCode: string }
    )
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.message.length).toBeGreaterThan(0)
  })
})
