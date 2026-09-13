/**
 * The durable counters behind a Member_Registry `position` and a
 * Redemption_History `seq` (Requirements 2.1, 3.2).
 *
 * One document per counter in the `counters` collection, advanced by a single
 * `findOneAndUpdate` with `$inc`. That is the whole module: no cached value, no
 * read-then-write, and no state of its own, so two callers racing for the next
 * value are serialized by the database rather than by this process.
 *
 * ## Why a counter rather than `max(...) + 1`
 *
 * Requirement 3.2 asks every appended Redemption_History Store_Document to hold
 * an append counter value greater than that of **every** record appended before
 * it — including records appended before the preceding shutdown, records the
 * retention rule of Requirement 3.3 has since deleted, and records a
 * Data_Import inserted. `max(seq) + 1` over the surviving documents is exactly
 * the quantity that forgets the deleted ones: trim the collection to 200, and
 * the maximum drops back to a value the collection has already used. A stored
 * counter never drops, so the guarantee holds across restarts and across
 * retention. The Data_Import raises the counter to the highest value it assigned
 * before it hands control over, which is what keeps imported records covered
 * too.
 *
 * Requirement 2.1 asks the same of a `position`: greater than the position of
 * every Store_Document already in the collection. Roster removal deletes
 * documents without renumbering (Requirement 2.6), so the same argument applies
 * and the same counter shape answers it.
 *
 * ## `$inc` on an absent document yields 1
 *
 * With `upsert: true`, the update applies to a document that does not exist yet;
 * `$inc` treats the missing field as 0, so the first call returns 1 — which is
 * the value Requirement 3.2 requires of the first appended record.
 *
 * ## Failures carry no sentence of their own
 *
 * A counter value is never rendered. The operation that asked for it — a roster
 * add, a history append — is the one with a sentence to speak, and it supplies
 * its own from `src/domain/storeMessages.ts` when it turns this failure into a
 * response. So a driver rejection here becomes {@link driverStoreFailure}'s
 * default, {@link unreachableMessage}, and the `reason` is what the caller
 * actually reads.
 */

import { unreachableMessage } from "@/domain/storeMessages"
import type { StoreFailure } from "@/domain/types"
import type {
  CounterDocument,
  CounterName,
} from "@/server/store/documents.server"
import { driverStoreFailure, getMongoStore } from "@/server/store/mongo.server"
import type { MongoStore } from "@/server/store/mongo.server"

/**
 * Re-exported from `documents.server.ts`, where it is declared beside
 * {@link CounterDocument} so the document shape and the set of legal `_id`
 * values cannot drift apart.
 */
export type { CounterName }

/**
 * The newly assigned counter value, or the reason there is none.
 *
 * A `number` is the success case, so callers discriminate with
 * `typeof result === "number"` — or with {@link isCounterFailure}, which says
 * the same thing where the negation reads better.
 */
export type CounterValueResult = number | StoreFailure

/** Whether a {@link CounterValueResult} is the failure case. */
export function isCounterFailure(
  result: CounterValueResult
): result is StoreFailure {
  return typeof result !== "number"
}

/**
 * Advances the named counter and returns the value it now holds: 1 on first
 * use, and strictly greater than every value this counter has handed out before,
 * across restarts.
 *
 * Atomic: one `findOneAndUpdate` with `$inc: { value: 1 }`, `upsert: true`, and
 * `returnDocument: "after"`, so the returned value is the one this call
 * reserved and no other caller can be handed it.
 *
 * The 5-second bound of Requirement 1.5 applies through the client's
 * `timeoutMS`, so nothing is raced here; a timeout arrives as a driver
 * rejection like any other and is classified by type, never by its text
 * (Requirement 1.6).
 *
 * @param store The Mongo_Store to advance the counter in. Defaults to the
 * process-wide store; a test supplies its own over a throwaway database.
 */
export async function nextCounterValue(
  name: CounterName,
  store: MongoStore = getMongoStore()
): Promise<CounterValueResult> {
  const handle = await store.collection<CounterDocument>("counters")
  if (handle.kind === "failure") {
    return handle.failure
  }

  try {
    const document = await handle.collection.findOneAndUpdate(
      { _id: name },
      { $inc: { value: 1 } },
      { upsert: true, returnDocument: "after" }
    )

    if (document === null || !Number.isFinite(document.value)) {
      /*
       * `upsert: true` with `returnDocument: "after"` always has a document to
       * return, and `$inc` refuses a non-numeric field with a server error
       * rather than storing one, so neither branch is a path the driver takes.
       * It is here because the alternative is returning a value the caller
       * would store as a `position` or a `seq`, and a `null` or a `NaN` in
       * either place would break the ordering both requirements are about. The
       * reason is `rejected`: the database answered, and its answer was not one
       * this module can use.
       */
      return { reason: "rejected", message: unreachableMessage() }
    }

    return document.value
  } catch (error) {
    return driverStoreFailure(error)
  }
}
