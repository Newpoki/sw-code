/**
 * Redemption_History semantics on top of the {@link JsonStore} document
 * (Requirements 1.5, 6.5, 6.6, 6.7, 6.8).
 *
 * This module owns three things and nothing else: how a record is appended, how
 * records are ordered, and how long they are kept. It reads no environment
 * variable, touches no filesystem, and composes no HTTP-shaped error;
 * `src/functions/history.functions.ts` turns a read into an {@link
 * import("@/domain/types").Envelope}, and the RunCoordinator turns a failed
 * append into the Requirement 6.8 warning.
 *
 * ## Invariants enforced on every append
 *
 * - `seq` is taken from `nextHistorySeq` and that counter only ever increases.
 *   It never resets, not even when the retention trim drops the record that
 *   held the highest `seq`, so the Requirement 6.6 tie-break stays correct
 *   across restarts. The load path in `jsonStore.server.ts` repairs a lagging
 *   counter to one past the highest retained `seq` for the same reason.
 * - `history` stays append-ordered, and the trim drops from the FRONT, so the
 *   newest {@link HISTORY_RETENTION_LIMIT} records always survive.
 * - Outcome rows are denormalized: each row carries its own `hiveId` and
 *   `memberLabel`, so deleting the Member_Registry entry it was copied from
 *   cannot alter, renumber, or remove a history record (Requirement 1.5).
 *
 * ## Why 200 records
 *
 * Requirement 6.5 asks for "at least the 100 most recent" records. The design
 * chose 200: it satisfies the requirement with headroom, and 200 records of at
 * most 100 outcome rows each keeps the document in the low hundreds of
 * kilobytes, which is well inside what the load-everything-into-memory store
 * can serve.
 *
 * ## Why `append` returns a promise and the reads do not
 *
 * Same split as the Member_Registry: a durable write cannot be known
 * synchronously, so `append` resolves with `persisted` once the flush settles
 * (Requirement 6.8 is driven off that flag), while `list` and
 * `findLatestByCouponCode` are plain reads of the in-memory document. The record
 * is on the in-memory history before `append` suspends, so the next read sees it
 * whether or not the flush lands.
 */

import { getJsonStore } from "@/server/store/jsonStore.server"
import { HISTORY_RETENTION_LIMIT } from "@/domain/types"
import type { JsonStore } from "@/server/store/jsonStore.server"
import type { MemberOutcome, RedemptionHistoryRecord } from "@/domain/types"

/**
 * How many Redemption_History records are retained (Requirement 6.5 asks for at
 * least 100). Declared in `src/domain/types.ts`, which the browser bundle may
 * import, and re-exported here so the trim can be exercised without hard-coding
 * the number in a test and so every existing importer keeps its import path.
 */
export { HISTORY_RETENTION_LIMIT }

/** One denormalized outcome row of a stored Redemption_History record. */
export type HistoryOutcomeRow = RedemptionHistoryRecord["outcomes"][number]

/** What {@link HistoryStore.append} accepts: everything but the assigned `seq`. */
export type AppendHistoryInput = Omit<RedemptionHistoryRecord, "seq">

/** Outcome of {@link HistoryStore.append}. */
export interface AppendHistoryResult {
  /** False when the flush for this append failed (Requirement 6.8). */
  readonly persisted: boolean
  /** The stored record, including the `seq` this append assigned. */
  readonly record: RedemptionHistoryRecord
}

/**
 * The Redemption_History seam. It exposes no JSON-specific concept, so another
 * persistence layer can be swapped in behind it without touching callers.
 */
export interface HistoryStore {
  /** Requirements 6.5, 6.8. */
  append: (record: AppendHistoryInput) => Promise<AppendHistoryResult>
  /** Retained records in Requirement 6.6 order, optionally capped to `limit`. */
  list: (limit?: number) => RedemptionHistoryRecord[]
  /** The most recent record holding exactly `couponCode` (Requirement 6.7). */
  findLatestByCouponCode: (couponCode: string) => RedemptionHistoryRecord | null
}

/**
 * Denormalizes Member_Outcomes into stored history rows (Requirement 1.5).
 *
 * `position` is deliberately dropped: array order already carries it, and a
 * stored position would be one more thing that could disagree with the array.
 *
 * A `SKIPPED` Member_Outcome has no Upstream_Result — no request was issued for
 * that Group_Member — so it has no response code and no response message. Both
 * fields are stored as `""` rather than omitted or nulled, which keeps every row
 * the same shape (the store's row validator requires both to be strings) and
 * keeps the history view free of null handling. `""` is not ambiguous here:
 * `outcome` says `SKIPPED`, so an empty code means "never asked", not "asked and
 * got nothing back".
 */
export function toHistoryOutcomeRows(
  outcomes: readonly MemberOutcome[]
): HistoryOutcomeRow[] {
  return outcomes.map((outcome) => ({
    hiveId: outcome.hiveId,
    memberLabel: outcome.memberLabel,
    outcome: outcome.outcome,
    responseCode: outcome.upstreamResult?.responseCode ?? "",
    responseMessage: outcome.upstreamResult?.responseMessage ?? "",
  }))
}

/**
 * Epoch milliseconds of a `completedAt` value, or null when it is not a
 * timestamp the runtime can parse.
 */
function epoch(completedAt: string): number | null {
  const parsed = Date.parse(completedAt)
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * Requirement 6.6 ordering: most recent `completedAt` first, and among records
 * sharing a completion timestamp the most recently appended (highest `seq`)
 * first.
 *
 * Timestamps are compared as instants, not as text, so `2025-01-04T18:00:00Z`
 * and `2025-01-04T19:00:00+01:00` are recognized as the same moment and fall to
 * the `seq` tie-break instead of being ordered by their spelling. A value the
 * runtime cannot parse falls back to a plain string comparison, and an
 * unparseable value sorts after every parseable one, so one malformed record
 * cannot push itself to the top of the history view.
 */
function compareRecords(
  left: RedemptionHistoryRecord,
  right: RedemptionHistoryRecord
): number {
  const leftEpoch = epoch(left.completedAt)
  const rightEpoch = epoch(right.completedAt)

  if (leftEpoch !== null && rightEpoch !== null) {
    if (leftEpoch !== rightEpoch) return rightEpoch - leftEpoch
  } else if (leftEpoch !== null) {
    return -1
  } else if (rightEpoch !== null) {
    return 1
  } else if (left.completedAt !== right.completedAt) {
    return left.completedAt < right.completedAt ? 1 : -1
  }

  return right.seq - left.seq
}

/**
 * The retained records in Requirement 6.6 order.
 *
 * `Array.prototype.sort` is stable, and the comparator falls back to `seq`,
 * which is unique across retained records, so the ordering is total: two calls
 * over the same document return the same sequence.
 */
function ordered(
  history: readonly RedemptionHistoryRecord[]
): RedemptionHistoryRecord[] {
  return [...history].sort(compareRecords)
}

/**
 * Builds a Redemption_History over `store`.
 *
 * Holds no state of its own: every read and every append goes through the
 * document `store` owns, so two histories built over the same store see the
 * same records.
 */
export function createHistoryStore(store: JsonStore): HistoryStore {
  return {
    /**
     * Assigns the next `seq`, appends, then trims the front.
     *
     * The whole thing happens inside one mutator, so it runs synchronously and
     * indivisibly: no second append can observe the counter between the read
     * and the increment, and no read can observe the history between the append
     * and the trim.
     *
     * The outcome rows are copied into fresh objects, so a caller that keeps
     * mutating the array it passed in cannot reach into stored history.
     */
    append: async (input) => {
      const { value, persisted } = await store.mutate((document) => {
        const record: RedemptionHistoryRecord = {
          runId: input.runId,
          seq: document.nextHistorySeq,
          couponCode: input.couponCode,
          completedAt: input.completedAt,
          mock: input.mock,
          stoppedEarly: input.stoppedEarly,
          outcomes: input.outcomes.map((row) => ({ ...row })),
        }

        document.nextHistorySeq += 1
        document.history.push(record)

        const excess = document.history.length - HISTORY_RETENTION_LIMIT
        if (excess > 0) {
          document.history.splice(0, excess)
        }

        return record
      })

      return { persisted, record: value }
    },

    /**
     * Requirement 6.6 order, capped after ordering so the cap keeps the newest
     * records rather than an arbitrary slice. A limit that is absent or not a
     * finite number returns every retained record; a fractional limit is
     * floored; a limit of zero or less returns no record, because the cap is
     * clamped to zero rather than read as an offset from the end.
     * `tests/property/historyOrdering.property.test.ts` pins that behaviour.
     */
    list: (limit) => {
      const records = ordered(store.read().history)
      if (limit === undefined || !Number.isFinite(limit)) {
        return records
      }
      return records.slice(0, Math.max(0, Math.floor(limit)))
    },

    /**
     * The first record of the Requirement 6.6 ordering whose `couponCode` is
     * character-for-character identical to `couponCode` — case, whitespace, and
     * all. Nothing is trimmed or folded here: the caller submits the same
     * trimmed Coupon_Code the run stored (Requirement 2.10), and loosening the
     * comparison would attach a "last used" notice to a code that was never
     * redeemed (Requirement 6.7).
     */
    findLatestByCouponCode: (couponCode) =>
      ordered(store.read().history).find(
        (record) => record.couponCode === couponCode
      ) ?? null,
  }
}

/**
 * A Redemption_History over the process-wide {@link JsonStore}.
 *
 * A fresh, stateless wrapper is returned on every call, so installing another
 * store with `setJsonStore` cannot leave a caller holding a history bound to the
 * previous document.
 */
export function getHistoryStore(): HistoryStore {
  return createHistoryStore(getJsonStore())
}
