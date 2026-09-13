/**
 * Redemption_History semantics over the `history` collection of the Mongo_Store
 * (Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.10, 3.11, 3.12).
 *
 * This module owns three things and nothing else: how a record is appended, how
 * records are ordered, and how many are kept. It reads no environment variable,
 * constructs no `MongoClient`, and composes no HTTP-shaped error;
 * `src/functions/history.functions.ts` turns a read into an {@link
 * import("@/domain/types").Envelope}, and the RunCoordinator turns a failed
 * append into the single Requirement 3.7 warning.
 *
 * ## What changed with MongoDB
 *
 * Every method is `async`, including the two reads: a read is a round trip to a
 * deployment that may not answer, so it can fail, and both reads therefore carry
 * a `failed` variant (Requirement 3.10). No result carries `persisted` any more.
 * A `kind` of `appended` means the Store_Document is in the database, which is
 * what Requirement 3.12 asks for — there is no appended-but-not-saved state left
 * to warn about.
 *
 * Ordering moved into the database. Requirement 3.4 is a sort on
 * `{ completedAtMs: -1, seq: -1 }`, served by the `completedAtMs_desc` index of
 * Requirement 1.7, and no comparator lives in this module any more. That is why
 * the Store_Document carries `completedAtMs` beside the ISO `completedAt`
 * string: sorting the string would order `2025-01-04T18:00:00Z` and
 * `2025-01-04T19:00:00+01:00` differently even though they name the same
 * instant. `documents.server.ts` derives the epoch milliseconds and the
 * round-trip property of Requirement 3.9 pins that derivation.
 *
 * ## Invariants enforced on every append
 *
 * - `seq` comes from the `history_seq` counter, which only ever increases — never
 *   resetting, not even when the retention trim deletes the record that held the
 *   highest `seq`, and never rebuilt from `max(seq) + 1` over the survivors,
 *   which is exactly the quantity that forgets the deleted ones (Requirement
 *   3.2).
 * - The collection holds at most {@link HISTORY_RETENTION_LIMIT} Store_Documents
 *   after a successful append, trimmed from the lowest `seq` up
 *   (Requirement 3.3).
 * - Outcome rows are denormalized: each row carries its own `hiveId` and
 *   `memberLabel`, so deleting the Member_Registry entry it was copied from
 *   cannot alter, renumber, or remove a history record.
 *
 * ## Why an append failure and a trim failure are reported differently
 *
 * An `insertOne` that fails is `failed`: nothing was written, not even partially
 * — a document either inserts or does not — no retention delete runs, and the
 * caller reports exactly one warning (Requirement 3.7). The `seq` that was
 * consumed is simply never used, which is fine, because Requirement 3.2 asks for
 * strictly increasing values and not for gapless ones.
 *
 * A trim that fails is **not** reported to the Web_Client at all
 * (Requirement 3.11). The append succeeded, so the run's outcome carries zero
 * warnings; one warning naming the collection goes to the log, the extra
 * Store_Document stays, and the next append attempts the trim again.
 *
 * ## Which sentence a failure speaks with
 *
 * The same split as the Member_Registry, decided by the same question: was this
 * failure settled **before** this module attempted anything, or is it the failure
 * of something this module **did** attempt?
 *
 * A failure the Mongo_Store handed back before any attempt keeps its own
 * sentence — an absent or unparsable `MONGODB_URI` (Requirements 1.3, 1.10), or
 * no connection yet (Requirement 1.11) — because each of those requirements asks
 * for exactly that sentence, and `store.collection(...)` performs no driver
 * operation so those two are the only failures it can report. That is
 * {@link asOperationFailure}.
 *
 * A failure of an operation this module attempted speaks with the operation's
 * own sentence, whatever went wrong: {@link historyAppendFailedMessage} for an
 * append (Requirement 3.7), {@link historyReadFailedMessage} for either read
 * (Requirement 3.10). Requirement 3.7 makes no exception for *how* the
 * deployment failed — a deployment that gave no answer inside its bound still
 * owes the caller a warning that names the append — so the sentence belongs to
 * the operation and the `reason` on the {@link StoreFailure} is what still says
 * why. That is {@link asAttemptedOperationFailure}, and it is what the failure of
 * the `history_seq` increment goes through: asking for the next append counter
 * value is something the append attempted.
 *
 * No driver message, host name, or fragment of the Mongo_Connection_URI is ever
 * read into a returned value or into the retention warning (Requirement 1.6).
 */

import { HISTORY_RETENTION_LIMIT } from "@/domain/types"
import {
  historyAppendFailedMessage,
  historyReadFailedMessage,
} from "@/domain/storeMessages"
import {
  isCounterFailure,
  nextCounterValue,
} from "@/server/store/counters.server"
import {
  fromHistoryDocument,
  toHistoryDocument,
} from "@/server/store/documents.server"
import type { HistoryDocumentInput } from "@/server/store/documents.server"
import { driverStoreFailure, getMongoStore } from "@/server/store/mongo.server"
import type { MongoStore, StoreLogger } from "@/server/store/mongo.server"
import type {
  MemberOutcome,
  RedemptionHistoryRecord,
  StoreFailure,
} from "@/domain/types"
import type { Collection } from "mongodb"

/**
 * How many Redemption_History Store_Documents are retained (Requirement 3.3).
 * Declared in `src/domain/types.ts`, which the browser bundle may import, and
 * re-exported here so the trim can be exercised without hard-coding the number
 * in a test and so every existing importer keeps its import path.
 */
export { HISTORY_RETENTION_LIMIT }

/** One denormalized outcome row of a stored Redemption_History record. */
export type HistoryOutcomeRow = RedemptionHistoryRecord["outcomes"][number]

/** What {@link HistoryStore.append} accepts: everything but the assigned `seq`. */
export type AppendHistoryInput = Omit<RedemptionHistoryRecord, "seq">

/** Outcome of {@link HistoryStore.append}. */
export type AppendHistoryResult =
  /** Requirements 3.1, 3.12: the Store_Document is in the database. */
  | { readonly kind: "appended"; readonly record: RedemptionHistoryRecord }
  /** Requirement 3.7: nothing was written, not even partially. */
  | { readonly kind: "failed"; readonly failure: StoreFailure }

/** Outcome of {@link HistoryStore.list}. */
export type ListHistoryResult =
  /** Requirement 3.4 order. An empty collection is zero records and no error. */
  | {
      readonly kind: "records"
      readonly records: readonly RedemptionHistoryRecord[]
    }
  /** Requirement 3.10: zero records, the collection unchanged, one fixed sentence. */
  | { readonly kind: "failed"; readonly failure: StoreFailure }

/** Outcome of {@link HistoryStore.findLatestByCouponCode}. */
export type FindHistoryResult =
  | { readonly kind: "record"; readonly record: RedemptionHistoryRecord }
  /** Requirement 3.5: no record, and zero error messages. */
  | { readonly kind: "not-found" }
  /** Requirement 3.10. */
  | { readonly kind: "failed"; readonly failure: StoreFailure }

/**
 * The Redemption_History seam. It exposes no MongoDB concept — no `Collection`,
 * no `ObjectId`, no `completedAtMs` — so the persistence layer behind it can
 * change again without touching callers.
 */
export interface HistoryStore {
  /** Requirements 3.1, 3.2, 3.3, 3.7, 3.11, 3.12. */
  append: (record: AppendHistoryInput) => Promise<AppendHistoryResult>
  /** Requirements 3.4, 3.6, 3.10. */
  list: (limit?: number) => Promise<ListHistoryResult>
  /** Requirements 3.5, 3.10. */
  findLatestByCouponCode: (couponCode: string) => Promise<FindHistoryResult>
}

export interface HistoryStoreOptions {
  /**
   * Where the Requirement 3.11 retention warning goes. Defaults to `console`,
   * mirroring the Mongo_Store, and injected so a test can capture the warning
   * without reading process output.
   */
  readonly logger?: StoreLogger
}

/**
 * The one warning logged when the retention trim does not complete while the
 * append it followed succeeded (Requirement 3.11).
 *
 * It names the collection and states what did not happen, and nothing of the
 * driver error — which is why it is a constant rather than a function of that
 * error: there is no parameter through which a host name could leak
 * (Requirement 1.6).
 */
export const HISTORY_RETENTION_FAILED_WARNING =
  "The retention rule did not complete for the history collection: the " +
  "Redemption_History record was appended and is retained, but the trim to " +
  `${HISTORY_RETENTION_LIMIT} records did not finish, so the collection may ` +
  "hold more than that for now. The next append applies the retention rule " +
  "again. No warning is delivered to the Web_Client, because the append itself " +
  "succeeded."

/**
 * The Requirement 3.4 ordering, as a database sort: most recent completion
 * timestamp first, and among Store_Documents sharing a completion timestamp the
 * most recently appended — the highest `seq` — first.
 *
 * `completedAtMs` is compared rather than `completedAt`, so two spellings of one
 * instant fall to the `seq` tie-break instead of being ordered by their text.
 * `seq` is unique across retained Store_Documents, so the ordering is total: two
 * reads of an unchanged collection return the same sequence.
 */
const NEWEST_FIRST = { completedAtMs: -1, seq: -1 } as const

/** Ascending `seq`: the order the retention trim deletes in (Requirement 3.3). */
const OLDEST_SEQ_FIRST = { seq: 1 } as const

/**
 * Denormalizes Member_Outcomes into stored history rows.
 *
 * `position` is deliberately dropped: array order already carries it, and a
 * stored position would be one more thing that could disagree with the array.
 *
 * A `SKIPPED` Member_Outcome has no Upstream_Result — no request was issued for
 * that Group_Member — so it has no response code and no response message. Both
 * fields become `""` rather than being omitted or nulled, which keeps every row
 * the same shape and keeps the history view free of null handling. `""` is not
 * ambiguous here: `outcome` says `SKIPPED`, so an empty code means "never
 * asked", not "asked and got nothing back".
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
 * Re-speaks a {@link StoreFailure} that was settled **before** this module
 * attempted anything — the failure of a `store.collection(...)` call, which
 * performs no driver operation.
 *
 * `not-configured` and `unreachable` keep their own sentence: an absent or
 * unparsable `MONGODB_URI` (Requirements 1.3, 1.10) and a connection that does
 * not exist yet (Requirement 1.11) are the only two failures a handle lookup can
 * report, and each of those requirements asks for exactly the sentence it
 * already carries.
 *
 * `rejected` means the database answered, and its answer was no, to something
 * this operation asked for. That is Requirement 3.7's and Requirement 3.10's
 * case, so the sentence becomes the operation's own and the `reason` is what
 * still says why.
 *
 * For the failure of something this module *did* attempt, use
 * {@link asAttemptedOperationFailure} instead.
 */
function asOperationFailure(
  failure: StoreFailure,
  message: string
): StoreFailure {
  return failure.reason === "rejected"
    ? { reason: "rejected", message }
    : failure
}

/**
 * Re-speaks a {@link StoreFailure} returned by an operation this module **did**
 * attempt — the `history_seq` increment behind an append — in the sentence of
 * that append.
 *
 * Every reason is re-spoken, unlike {@link asOperationFailure}. Nothing was
 * settled ahead of this call: the module asked the deployment to advance the
 * append counter and the deployment did not serve it, so no Store_Document was
 * written and Requirement 3.7 wants the one warning that says the record was not
 * saved. Its first clause — no answer inside the 5 seconds of Requirement 1.5 —
 * arrives as `unreachable`, and leaving that failure to speak about the database
 * in general would answer a different requirement than the one at hand.
 *
 * The original `reason` is preserved rather than replaced. It is the only thing
 * left that distinguishes a deployment that timed out from one that refused, and
 * inventing one here would make the store claim something it did not observe.
 */
function asAttemptedOperationFailure(
  failure: StoreFailure,
  message: string
): StoreFailure {
  return { reason: failure.reason, message }
}

/**
 * How many records a `list` call returns: the requested limit, floored, clamped
 * into `0..HISTORY_RETENTION_LIMIT`, and the full retention window when no
 * finite limit was given.
 *
 * The upper clamp is Requirement 3.4's "at most 200 records", and it holds even
 * for a caller that asks for more; the collection cannot exceed that after a
 * successful trim, but a trim that failed leaves it briefly larger
 * (Requirement 3.11) and the read must not widen because of it.
 */
function resolveLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return HISTORY_RETENTION_LIMIT
  }
  return Math.min(HISTORY_RETENTION_LIMIT, Math.max(0, Math.floor(limit)))
}

/**
 * Builds a Redemption_History over `store`.
 *
 * Holds no state of its own beyond the injected logger: every read and every
 * append goes to the `history` collection, so two histories built over the same
 * Mongo_Store — or over the same database through two Mongo_Stores, which is
 * what the restart clause of Requirement 3.6 exercises — see the same records.
 */
export function createHistoryStore(
  store: MongoStore,
  options: HistoryStoreOptions = {}
): HistoryStore {
  const logger = options.logger ?? console

  /**
   * The `history` collection, or the failure explaining why there is none.
   *
   * Typed by {@link HistoryDocumentInput} — the Store_Document without its
   * `_id` — because that is the shape this module writes: `_id` is the driver's
   * to assign, so nothing here invents one, and a read still comes back as
   * `WithId<HistoryDocumentInput>`, which is the full
   * {@link import("@/server/store/documents.server").HistoryDocument}.
   */
  const history = () => store.collection<HistoryDocumentInput>("history")

  /**
   * Requirement 3.3, applied after a successful append: count, and when the
   * count exceeds the retention window delete the lowest `seq` values so that
   * exactly {@link HISTORY_RETENTION_LIMIT} remain.
   *
   * The delete addresses the `_id` values of the Store_Documents the ascending
   * `seq` read selected, rather than restating the `seq` range as a filter.
   * That deletes exactly the documents that were chosen and exactly as many as
   * the count called for, which a `$lt` on `seq` would not guarantee if two
   * Store_Documents ever shared a `seq` — the counter makes that impossible, and
   * addressing identities rather than a range means the trim does not depend on
   * it.
   *
   * One pass, not a loop. An append arriving between the count and the delete
   * can leave the collection one Store_Document over the window; the next append
   * counts again and trims it, which is the same self-correcting behaviour
   * Requirement 3.11 already asks for after a failed trim.
   *
   * Every failure is swallowed into one logged warning: the append already
   * succeeded, so the caller has nothing to report and the record stays
   * (Requirement 3.11).
   */
  const applyRetention = async (
    collection: Collection<HistoryDocumentInput>
  ): Promise<void> => {
    try {
      const excess =
        (await collection.countDocuments()) - HISTORY_RETENTION_LIMIT
      if (excess <= 0) {
        return
      }

      const doomed = await collection
        .find(
          {},
          {
            sort: OLDEST_SEQ_FIRST,
            limit: excess,
            projection: { _id: 1 },
          }
        )
        .toArray()
      if (doomed.length === 0) {
        return
      }

      await collection.deleteMany({
        _id: { $in: doomed.map((document) => document._id) },
      })
    } catch {
      /*
       * The caught error is dropped on the floor deliberately: a driver message
       * names the topology it could not reach, and Requirement 1.6 keeps every
       * part of the Mongo_Connection_URI out of every log entry. The constant
       * names the collection and says what did not happen.
       */
      logger.warn(HISTORY_RETENTION_FAILED_WARNING)
    }
  }

  /**
   * One read of the collection in Requirement 3.4 order, `filter` selecting the
   * whole collection for `list` and one Coupon_Code for
   * `findLatestByCouponCode`. Ordering and the cap are both the deployment's
   * work; nothing here compares two records.
   */
  const read = async (
    filter: Partial<Pick<HistoryDocumentInput, "couponCode">>,
    limit: number
  ): Promise<ListHistoryResult> => {
    const handle = await history()
    if (handle.kind === "failure") {
      return {
        kind: "failed",
        failure: asOperationFailure(handle.failure, historyReadFailedMessage()),
      }
    }

    try {
      const documents = await handle.collection
        .find(filter, { sort: NEWEST_FIRST, limit })
        .toArray()
      return { kind: "records", records: documents.map(fromHistoryDocument) }
    } catch (error) {
      /*
       * Requirement 3.10: zero records and one fixed sentence. Nothing
       * partially read is returned — `toArray` either yields the whole cursor
       * or throws — and a read changes nothing either way.
       */
      return {
        kind: "failed",
        failure: driverStoreFailure(error, historyReadFailedMessage()),
      }
    }
  }

  return {
    /**
     * Three steps: take the next `seq`, insert, then trim.
     *
     * The counter is advanced after the collection handle is in hand, so a store
     * with no usable `MONGODB_URI` and a store with no connection yet consume no
     * counter value. A value that *is* consumed and then not used — because the
     * insert failed — leaves a gap, which is fine: Requirement 3.2 asks for
     * strictly increasing append counter values, not for gapless ones.
     *
     * The returned record is mapped back out of the very document that was
     * inserted, so it reflects what the collection now holds — including the
     * first 500 characters of a response message that arrived longer
     * (Requirement 3.1) — and its outcome rows are fresh objects, so a caller
     * that keeps mutating the array it passed in cannot reach into stored
     * history.
     */
    append: async (input) => {
      const handle = await history()
      if (handle.kind === "failure") {
        return {
          kind: "failed",
          failure: asOperationFailure(
            handle.failure,
            historyAppendFailedMessage()
          ),
        }
      }
      const collection = handle.collection

      const counter = await nextCounterValue("history_seq", store)
      if (isCounterFailure(counter)) {
        /* An operation this append attempted, so every reason is re-spoken as
         * the append: an increment that timed out is still a record that was not
         * saved (Requirement 3.7). */
        return {
          kind: "failed",
          failure: asAttemptedOperationFailure(
            counter,
            historyAppendFailedMessage()
          ),
        }
      }

      const document = toHistoryDocument({
        runId: input.runId,
        seq: counter,
        couponCode: input.couponCode,
        completedAt: input.completedAt,
        mock: input.mock,
        stoppedEarly: input.stoppedEarly,
        outcomes: input.outcomes,
      })

      try {
        await collection.insertOne(document)
      } catch (error) {
        /*
         * Requirement 3.7: the collection is unchanged, no partial
         * Store_Document exists — a document either inserts or does not — and
         * the trim below is not reached, so no retained record is deleted.
         */
        return {
          kind: "failed",
          failure: driverStoreFailure(error, historyAppendFailedMessage()),
        }
      }

      await applyRetention(collection)

      // Requirement 3.12: the record, and nothing to warn about.
      return { kind: "appended", record: fromHistoryDocument(document) }
    },

    /**
     * Requirement 3.4: the retained records, newest completion timestamp first,
     * at most {@link HISTORY_RETENTION_LIMIT} of them, ordered and capped by the
     * database. An empty collection is zero records and zero error messages.
     *
     * A limit of zero — or a negative one, which is clamped to zero rather than
     * read as an offset from the end — returns zero records without touching the
     * database. That short-circuit is not an optimization: the driver reads a
     * `limit` of 0 as "no limit", so a zero that reached the cursor would return
     * the whole window.
     */
    list: async (limit) => {
      const effective = resolveLimit(limit)
      if (effective === 0) {
        return { kind: "records", records: [] }
      }
      return read({}, effective)
    },

    /**
     * The first Store_Document of the Requirement 3.4 ordering whose
     * `couponCode` is character-for-character identical to `couponCode` — case,
     * whitespace, and all. Nothing is trimmed or folded: the caller submits the
     * same trimmed Coupon_Code the run stored, and loosening the comparison
     * would attach a "last used" notice to a code that was never redeemed
     * (Requirement 3.5).
     *
     * A Coupon_Code of zero characters is "no record" and never reaches the
     * database (Requirement 3.5), so it cannot report a read failure either.
     */
    findLatestByCouponCode: async (couponCode) => {
      if (couponCode.length === 0) {
        return { kind: "not-found" }
      }

      const outcome = await read({ couponCode }, 1)
      if (outcome.kind === "failed") {
        return outcome
      }

      return outcome.records.length === 0
        ? { kind: "not-found" }
        : { kind: "record", record: outcome.records[0] }
    },
  }
}

/**
 * A Redemption_History over the process-wide Mongo_Store.
 *
 * A fresh, stateless wrapper is returned on every call, so installing another
 * store with `setMongoStore` cannot leave a caller holding a history bound to
 * the previous connection pool.
 */
export function getHistoryStore(
  options: HistoryStoreOptions = {}
): HistoryStore {
  return createHistoryStore(getMongoStore(), options)
}
