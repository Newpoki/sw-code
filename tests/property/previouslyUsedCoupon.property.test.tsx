// Feature: shared-coupon-redemption, Property 17: A previously used Coupon_Code
// is announced with its latest timestamp — For any Redemption_History and any
// submitted Coupon_Code, the confirmation dialog states the completion
// timestamp of the most recent Redemption_History record whose Coupon_Code is
// character-for-character identical to the submitted Coupon_Code, and states no
// such timestamp when no record matches under that exact comparison.
//
// Validates: Requirements 6.7.
//
// ## Both halves of the requirement, in one property
//
// Requirement 6.7 spans two collaborators, so one sample exercises both:
//
//   1. The match. `HistoryStore.findLatestByCouponCode`, reached through
//      `readLatestRunForCoupon`, compares the Coupon_Code character for
//      character and returns the most recent match under the Requirement 6.6
//      ordering (`completedAt` descending, then `seq` descending).
//   2. The announcement. `ConfirmRunDialog` renders the notice only when it is
//      handed a record, and the notice states that record's completion
//      timestamp.
//
// Wiring them together is the point: a sample that matched correctly but
// rendered nothing, or rendered a timestamp belonging to a different record,
// would satisfy either half alone and still break the requirement.
//
// `createServerFn(...).handler(fn)` cannot be invoked without the Start plugin,
// so the server half goes through `readLatestRunForCoupon`, the pure operation
// `history.functions.ts` exports for exactly this reason.
//
// ## How "most recent" is decided without reusing the store's comparator
//
// The expected record is chosen by a single pass over the records this sample
// appended — greatest instant wins, a tie goes to the greater `seq` — so the
// store's own ordering is never used to predict the store's own answer.
// `Date.parse` does the comparison because Requirement 6.6 speaks of a
// completion timestamp rather than of its spelling: the generator emits both a
// `...Z` and a `...+01:00` rendering of the same moment, so simultaneous records
// whose timestamp text differs fall to the `seq` tie-break.
//
// ## The near misses
//
// Every generated Coupon_Code is built from non-whitespace units, which is what
// makes the near misses constructible: a stored code holding whitespace, or the
// same characters in the other letter case, is guaranteed to be a *different*
// code, so it must never be announced for the submitted one. The distinct codes
// carry an interior space for the same reason.
//
// ## Why nothing is written to disk
//
// The match is a pure read over the in-memory document, so every sample injects
// a resolving flush and a `DATA_FILE` path that is never created. The
// repository's `./data/store.json` is neither read nor written.
//
// `jest-dom` is not installed, so the DOM assertions are plain reads:
// `querySelector`, `textContent`, and attribute values. Radix renders the dialog
// into a portal, so the queries start from `document.body`, and `cleanup()` runs
// after every render rather than once per test — an `afterEach` hook fires once
// per `it`, not once per fast-check run.

import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { cleanup, render } from "@testing-library/react"

import {
  ConfirmRunDialog,
  PREVIOUSLY_USED_TITLE,
  formatCompletedAt,
} from "@/components/ConfirmRunDialog"
import { readLatestRunForCoupon } from "@/functions/history.functions"
import { createHistoryStore } from "@/server/store/history.server"
import type { HistoryStore } from "@/server/store/history.server"
import type { MongoStore, StoreLogger } from "@/server/store/mongo.server"
import type {
  MemberRegistryEntry,
  RedemptionHistoryRecord,
} from "@/domain/types"

import { createInMemoryMongoStore } from "../support/inMemoryMongoStore"
import { rosterArb, trimmedCouponCodeArb } from "./generators"

/** Fixed base instant, so every generated `completedAt` is deterministic. */
const BASE_TIME = Date.parse("2025-01-04T18:00:00.000Z")

/** Kept far under `HISTORY_RETENTION_LIMIT`, so no sample is ever trimmed. */
const MAX_APPENDS = 6

/**
 * A Coupon_Code no generator can produce: `trimmedCouponCodeArb` builds its
 * values from non-whitespace units, and every stored near miss below holds at
 * most one interior space, so a code holding three of them is guaranteed absent
 * from the history.
 */
const ABSENT_COUPON_CODE = "NO SUCH COUPON CODE"

/** No warning is expected: every store operation is served in memory. */
const silentLogger: StoreLogger = { warn: () => undefined }

/**
 * A fresh in-memory Mongo_Store holding no Store_Document, so the read path
 * starts from an empty collection every time.
 */
function emptyStore(): MongoStore {
  /* The in-memory Mongo_Store of `tests/support/inMemoryMongoStore.ts`: no
   * deployment and no file, and every operation served, so a `failed` result
   * anywhere below is a genuine falsification. */
  return createInMemoryMongoStore({ logger: silentLogger }).store
}

/** The latest run for a Coupon_Code as a record or null, or a thrown reason. */
async function latestRunFor(
  history: HistoryStore,
  couponCode: string
): Promise<RedemptionHistoryRecord | null> {
  const result = await history.findLatestByCouponCode(couponCode)
  switch (result.kind) {
    case "record":
      return result.record
    case "not-found":
      return null
    case "failed":
      throw new Error(`the history read reported "${result.kind}"`)
  }
}

/* -------------------------------------------------------------------------- */
/* Generated history                                                          */
/* -------------------------------------------------------------------------- */

/**
 * What a generated record stores as its Coupon_Code, relative to the submitted
 * one:
 *
 * - `match` — the submitted code exactly. Only these may ever be announced.
 * - `case-variant` — the same characters in the other letter case.
 * - `padded` — the same characters wrapped in whitespace, which the store must
 *   not trim away before comparing.
 * - `distinct` — an unrelated code.
 */
type CodeKind = "match" | "case-variant" | "padded" | "distinct"

/** How a generated `completedAt` is spelled. Both denote the same instant. */
type TimestampSpelling = "utc" | "plus-one"

interface HistorySeed {
  readonly codeKind: CodeKind
  /**
   * Seconds added to {@link BASE_TIME}. Drawn from a narrow set so several
   * records routinely share an instant, and generated per append rather than
   * per position so an append often carries an OLDER timestamp than a record
   * appended before it — which is what makes "most recent" a real choice rather
   * than "the last one appended".
   */
  readonly offsetSeconds: number
  readonly spelling: TimestampSpelling
}

const historySeedArb: fc.Arbitrary<HistorySeed> = fc.record({
  // Matches are weighted up so the announcing branch is exercised often, and
  // the three near misses together stay frequent enough to keep the
  // no-match branch populated as well.
  codeKind: fc.oneof(
    { weight: 4, arbitrary: fc.constant<CodeKind>("match") },
    { weight: 2, arbitrary: fc.constant<CodeKind>("case-variant") },
    { weight: 2, arbitrary: fc.constant<CodeKind>("padded") },
    { weight: 2, arbitrary: fc.constant<CodeKind>("distinct") }
  ),
  offsetSeconds: fc.oneof(
    { weight: 4, arbitrary: fc.constantFrom(0, 1, 2) },
    { weight: 1, arbitrary: fc.constantFrom(-86_400, -60, 3_600) }
  ),
  spelling: fc.constantFrom<TimestampSpelling>("utc", "plus-one"),
})

/**
 * The same characters in the other letter case, or null when the code has no
 * letter case to shift (digits, punctuation, ideographs). A shifted value may
 * differ in length — `"ß".toUpperCase()` is `"SS"` — which is fine: it is still
 * a different Coupon_Code.
 */
function caseVariantOf(couponCode: string): string | null {
  const upper = couponCode.toUpperCase()
  if (upper !== couponCode) return upper
  const lower = couponCode.toLowerCase()
  return lower === couponCode ? null : lower
}

/**
 * Whitespace wrappings of the submitted code. None of them equals
 * `` ` ${target} ` `` — the padding the property submits below — so that
 * submission is guaranteed to find nothing.
 */
const PADDINGS: ReadonlyArray<(code: string) => string> = [
  (code) => ` ${code}`,
  (code) => `${code}\n`,
  (code) => `\t${code}\t`,
]

/**
 * The Coupon_Code a seed stores. A `case-variant` seed whose code has no letter
 * case falls back to a distinct code, so the seed never silently turns into a
 * match.
 */
function storedCodeFor(
  seed: HistorySeed,
  target: string,
  index: number
): string {
  switch (seed.codeKind) {
    case "match":
      return target
    case "case-variant":
      return caseVariantOf(target) ?? `${target} ${index}`
    case "padded":
      return PADDINGS[index % PADDINGS.length](target)
    case "distinct":
      // The target holds no whitespace, so an interior space guarantees this is
      // a different code.
      return `${target} ${index}`
  }
}

/** The same instant, rendered either as UTC or with a `+01:00` offset. */
function completedAtOf(seed: HistorySeed): string {
  const instant = new Date(BASE_TIME + seed.offsetSeconds * 1000)
  if (seed.spelling === "utc") return instant.toISOString()
  const shifted = new Date(instant.getTime() + 3_600_000)
  return `${shifted.toISOString().slice(0, -1)}+01:00`
}

/**
 * Appends every seed in order and returns the stored records paired with
 * whether they hold the submitted Coupon_Code exactly.
 *
 * Outcome rows are left empty: Requirement 6.7 is about the Coupon_Code and the
 * completion timestamp, and the denormalization of outcome rows is covered by
 * `historyOrdering.property.test.ts` and the store's unit tests.
 */
async function appendAll(
  history: HistoryStore,
  seeds: ReadonlyArray<HistorySeed>,
  target: string
): Promise<Array<{ record: RedemptionHistoryRecord; matches: boolean }>> {
  const appended: Array<{
    record: RedemptionHistoryRecord
    matches: boolean
  }> = []
  for (const [index, seed] of seeds.entries()) {
    const couponCode = storedCodeFor(seed, target, index)
    const result = await history.append({
      runId: `run-${index}`,
      couponCode,
      completedAt: completedAtOf(seed),
      mock: false,
      stoppedEarly: false,
      outcomes: [],
    })
    // Requirement 2.9: a `kind` of `appended` means the write is in the
    // database, so a successful append carries no warning to check.
    if (result.kind !== "appended") {
      throw new Error(`could not seed the history: ${result.kind}`)
    }
    appended.push({ record: result.record, matches: couponCode === target })
  }
  return appended
}

/** Epoch milliseconds of a generated `completedAt`; every one is parseable. */
function instantOf(record: RedemptionHistoryRecord): number {
  const parsed = Date.parse(record.completedAt)
  expect(Number.isNaN(parsed)).toBe(false)
  return parsed
}

/**
 * The record that must be announced: among the records holding the submitted
 * Coupon_Code exactly, the one with the greatest instant, and among those the
 * one with the greatest `seq`. Found in one pass, without sorting and without
 * the store's comparator.
 */
function expectedAnnouncement(
  appended: ReadonlyArray<{
    record: RedemptionHistoryRecord
    matches: boolean
  }>
): RedemptionHistoryRecord | null {
  let best: RedemptionHistoryRecord | null = null
  for (const { record, matches } of appended) {
    if (!matches) continue
    if (best === null) {
      best = record
      continue
    }
    const bestInstant = instantOf(best)
    const instant = instantOf(record)
    if (instant > bestInstant) {
      best = record
    } else if (instant === bestInstant && record.seq > best.seq) {
      best = record
    }
  }
  return best
}

/* -------------------------------------------------------------------------- */
/* The announcement, read out of the rendered dialog                          */
/* -------------------------------------------------------------------------- */

/** `YYYY-MM-DD HH:MM:SS UTC`, the fixed rendering the dialog commits to. */
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/

/**
 * Renders the dialog and asserts what it announces about `previousRun`.
 *
 * `render` mounts into `document.body`, and Radix moves the dialog content into
 * a portal, so both the presence check and the absence check read from
 * `document.body`. The DOM is torn down in a `finally`, so a failing sample
 * cannot leave a mounted dialog behind for the shrinking runs that follow.
 */
function expectAnnouncement(
  couponCode: string,
  members: readonly MemberRegistryEntry[],
  previousRun: RedemptionHistoryRecord | null
): void {
  try {
    render(
      <ConfirmRunDialog
        couponCode={couponCode}
        members={members}
        previousRun={previousRun}
        onConfirm={() => undefined}
        onDismiss={() => undefined}
      />
    )

    const notice = document.body.querySelector<HTMLElement>(
      '[data-slot="previously-used-notice"]'
    )

    if (previousRun === null) {
      /* No match: no notice, and no timestamp stated anywhere. */
      expect(notice).toBe(null)
      expect(document.body.textContent).not.toContain(PREVIOUSLY_USED_TITLE)
      expect(document.body.querySelector("time")).toBe(null)
      return
    }

    expect(notice).not.toBe(null)
    if (notice === null) return

    /* The notice is announced, not merely present. */
    expect(notice.getAttribute("role")).toBe("alert")
    expect(notice.textContent).toContain(PREVIOUSLY_USED_TITLE)

    const time = notice.querySelector("time")
    expect(time).not.toBe(null)
    if (time === null) return

    /* The machine-readable value is the stored instant, unaltered. */
    expect(time.getAttribute("datetime")).toBe(previousRun.completedAt)

    /* The visible text is the fixed UTC rendering of that same instant. */
    const shown = time.textContent
    expect(shown).toBe(formatCompletedAt(previousRun.completedAt))
    expect(shown).toMatch(UTC_TIMESTAMP_PATTERN)
    expect(Date.parse(shown.replace(" UTC", "Z").replace(" ", "T"))).toBe(
      instantOf(previousRun)
    )
  } finally {
    cleanup()
  }
}

/* -------------------------------------------------------------------------- */
/* Property 17                                                                */
/* -------------------------------------------------------------------------- */

describe("Property 17: a previously used Coupon_Code is announced with its latest timestamp", () => {
  it("announces the latest character-exact match and announces nothing otherwise", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(historySeedArb, { minLength: 0, maxLength: MAX_APPENDS }),
        trimmedCouponCodeArb,
        rosterArb({ maxLength: 3 }),
        async (seeds, target, roster) => {
          const store = emptyStore()
          const history = createHistoryStore(store)
          const appended = await appendAll(history, seeds, target)
          const expected = expectedAnnouncement(appended)

          /* ---- The match ------------------------------------------------- */

          const envelope = await readLatestRunForCoupon(history, {
            couponCode: target,
          })
          expect(envelope.ok).toBe(true)
          if (!envelope.ok) return
          expect(envelope.data).toEqual(expected)
          /* A read writes nothing, so it warns about nothing. */
          expect(envelope.warnings).toEqual([])

          /* The store seam agrees with the envelope operation over it. */
          expect(await latestRunFor(history, target)).toEqual(expected)

          /* Whatever comes back holds the submitted code, character for
             character — never a near miss that merely resembles it. */
          if (envelope.data !== null) {
            expect(envelope.data.couponCode).toBe(target)
          }

          /* Surrounding whitespace is not trimmed away before comparing, so a
             padded submission matches only a record stored padded that way. */
          expect(await latestRunFor(history, ` ${target} `)).toBe(null)

          /* Letter case is compared, not folded: a shifted submission can only
             ever find a record stored in that shifted form. */
          const variant = caseVariantOf(target)
          if (variant !== null) {
            const byVariant = await latestRunFor(history, variant)
            expect(byVariant?.couponCode ?? variant).toBe(variant)
          }

          /* ---- The announcement ------------------------------------------ */

          expectAnnouncement(target, roster, expected)

          /* And the other branch, on every sample: a Coupon_Code no record
             holds yields null, and null states no timestamp at all. */
          const absent = await readLatestRunForCoupon(history, {
            couponCode: ABSENT_COUPON_CODE,
          })
          expect(absent.ok).toBe(true)
          if (!absent.ok) return
          expect(absent.data).toBe(null)
          expectAnnouncement(ABSENT_COUPON_CODE, roster, absent.data)
        }
      ),
      { numRuns: 100 }
    )
  })
})
