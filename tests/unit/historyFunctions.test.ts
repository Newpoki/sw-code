/**
 * The Redemption_History envelope mapping (Requirements 6.6, 6.7).
 *
 * These exercise the two envelope operations of
 * `src/functions/history.functions.ts` and their validators directly, over a
 * history built on an injected resolving flush: no `createServerFn` call site,
 * no HTTP, and no filesystem write. The `DATA_FILE` path handed to the store
 * points into a fresh temporary directory that never exists, so the
 * repository's own `data/store.json` is neither read nor written.
 *
 * The Requirement 6.6 ordering itself is proved over generated documents by
 * `tests/property/historyOrdering.property.test.ts`; what is asserted here is
 * that this layer passes that ordering through untouched, applies the limit, and
 * keeps the Requirement 6.7 comparison character-exact.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { lengthRangeMessage } from "@/domain/schemas"
import {
  HISTORY_LIMIT_MAX,
  limitRangeMessage,
  readHistory,
  readLatestRunForCoupon,
  validateFindLatestRunInput,
  validateListHistoryInput,
} from "@/functions/history.functions"
import { createHistoryStore } from "@/server/store/history.server"
import { createJsonStore } from "@/server/store/jsonStore.server"
import type { HistoryStore } from "@/server/store/history.server"

const tempDirs: Array<string> = []

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

/** A Redemption_History over a store whose flush lands and writes nothing. */
async function emptyHistory(): Promise<HistoryStore> {
  const dir = await mkdtemp(join(tmpdir(), "scr-history-fn-"))
  tempDirs.push(dir)
  return createHistoryStore(
    createJsonStore({
      dataFilePath: join(dir, "store.json"),
      flush: () => Promise.resolve(),
      logger: { warn: () => {} },
    })
  )
}

/** Appends one record with no outcome rows; only ordering fields matter here. */
async function append(
  history: HistoryStore,
  couponCode: string,
  completedAt: string
): Promise<number> {
  const { record, persisted } = await history.append({
    runId: `run-${couponCode}-${completedAt}`,
    couponCode,
    completedAt,
    mock: false,
    stoppedEarly: false,
    outcomes: [],
  })
  expect(persisted).toBe(true)
  return record.seq
}

const EARLIER = "2025-01-04T18:00:00.000Z"
const LATER = "2025-01-04T19:00:00.000Z"

describe("the history read (Requirement 6.6)", () => {
  it("returns the store's ordering unchanged, with no warning", async () => {
    const history = await emptyHistory()
    await append(history, "OLD", EARLIER)
    await append(history, "NEW", LATER)

    const envelope = readHistory(history)

    expect(envelope.ok).toBe(true)
    if (!envelope.ok) return
    // Most recent completion timestamp first, exactly as `list()` returned it.
    expect(envelope.data.map((record) => record.couponCode)).toEqual([
      "NEW",
      "OLD",
    ])
    expect(envelope.data).toEqual(history.list())
    expect(envelope.warnings).toEqual([])
  })

  it("breaks a shared completion timestamp by append order", async () => {
    const history = await emptyHistory()
    const firstSeq = await append(history, "FIRST", EARLIER)
    const secondSeq = await append(history, "SECOND", EARLIER)
    expect(secondSeq).toBeGreaterThan(firstSeq)

    const envelope = readHistory(history)

    expect(envelope.ok).toBe(true)
    if (!envelope.ok) return
    expect(envelope.data.map((record) => record.couponCode)).toEqual([
      "SECOND",
      "FIRST",
    ])
  })

  it("returns an empty list for an empty history", async () => {
    const envelope = readHistory(await emptyHistory())

    expect(envelope.ok).toBe(true)
    if (!envelope.ok) return
    expect(envelope.data).toEqual([])
  })

  it("caps to the submitted limit, keeping the newest records", async () => {
    const history = await emptyHistory()
    await append(history, "OLD", EARLIER)
    await append(history, "MID", LATER)
    await append(history, "NEW", "2025-01-04T20:00:00.000Z")

    const capped = readHistory(history, { limit: 2 })
    expect(capped.ok).toBe(true)
    if (!capped.ok) return
    expect(capped.data.map((record) => record.couponCode)).toEqual([
      "NEW",
      "MID",
    ])

    // An absent limit returns every retained record.
    const all = readHistory(history, {})
    expect(all.ok && all.data).toHaveLength(3)
    const defaulted = readHistory(history)
    expect(defaulted.ok && defaulted.data).toHaveLength(3)

    // A limit above the record count is not an error; it just returns them all.
    const generous = readHistory(history, { limit: HISTORY_LIMIT_MAX })
    expect(generous.ok && generous.data).toHaveLength(3)
  })
})

describe("the latest run for a Coupon_Code (Requirement 6.7)", () => {
  it("returns the most recent record holding exactly that Coupon_Code", async () => {
    const history = await emptyHistory()
    await append(history, "SUMMER2025", EARLIER)
    await append(history, "OTHER", LATER)
    await append(history, "SUMMER2025", LATER)

    const envelope = readLatestRunForCoupon(history, {
      couponCode: "SUMMER2025",
    })

    expect(envelope.ok).toBe(true)
    if (!envelope.ok) return
    expect(envelope.data?.couponCode).toBe("SUMMER2025")
    expect(envelope.data?.completedAt).toBe(LATER)
    expect(envelope.warnings).toEqual([])
  })

  it("prefers the most recently appended record at a shared timestamp", async () => {
    const history = await emptyHistory()
    const firstSeq = await append(history, "SUMMER2025", EARLIER)
    const secondSeq = await append(history, "SUMMER2025", EARLIER)

    const envelope = readLatestRunForCoupon(history, {
      couponCode: "SUMMER2025",
    })

    expect(envelope.ok).toBe(true)
    if (!envelope.ok) return
    expect(envelope.data?.seq).toBe(secondSeq)
    expect(envelope.data?.seq).not.toBe(firstSeq)
  })

  it("returns null when no record holds that Coupon_Code", async () => {
    const history = await emptyHistory()
    await append(history, "SUMMER2025", EARLIER)

    const envelope = readLatestRunForCoupon(history, { couponCode: "WINTER" })

    expect(envelope.ok).toBe(true)
    if (!envelope.ok) return
    expect(envelope.data).toBeNull()
  })

  it("treats a differing letter case as a different Coupon_Code", async () => {
    const history = await emptyHistory()
    await append(history, "SUMMER2025", EARLIER)

    const lower = readLatestRunForCoupon(history, {
      couponCode: "summer2025",
    })

    expect(lower.ok).toBe(true)
    if (!lower.ok) return
    expect(lower.data).toBeNull()
  })

  it("compares the trimmed value, so padding neither matches nor misses", async () => {
    const history = await emptyHistory()
    await append(history, "SUMMER2025", EARLIER)

    // The validator trims, so a padded submission finds the stored code.
    const verdict = validateFindLatestRunInput({
      couponCode: "  SUMMER2025 \n",
    })
    expect(verdict).toEqual({ ok: true, value: { couponCode: "SUMMER2025" } })
    if (!verdict.ok) return

    const envelope = readLatestRunForCoupon(history, verdict.value)
    expect(envelope.ok && envelope.data?.couponCode).toBe("SUMMER2025")

    // An inner whitespace difference is a different code, and stays one.
    const inner = readLatestRunForCoupon(history, {
      couponCode: "SUMMER 2025",
    })
    expect(inner.ok && inner.data).toBeNull()
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
