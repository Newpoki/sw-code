/**
 * The one mapping from a {@link StoreFailure} onto the {@link Envelope} a caller
 * returns (Requirements 2.8, 2.14, 3.7, 3.10).
 *
 * Three modules need this mapping — the Member_Registry server functions, the
 * Redemption_History server functions, and the run coordinator — and two of them
 * are reachable from the browser bundle, so it lives in `src/domain/` beside the
 * sentences themselves rather than in a `.server` module.
 *
 * ## Nothing here composes a sentence
 *
 * `failure.message` is already the fixed sentence the store chose from
 * `src/domain/storeMessages.ts`, worded for the operation that failed — the
 * roster read, the named roster change, the history read, the history append. It
 * is carried through verbatim. This module never interpolates, truncates, or
 * paraphrases it, and it never sees a driver error: by the time a
 * {@link StoreFailure} exists, the driver's own message has already been dropped
 * (Requirement 1.6).
 *
 * ## Why the code needs the operation and the reason
 *
 * The `reason` alone cannot pick the code. A deployment that is not configured or
 * not reachable failed the same way for a read and for a write — nothing was
 * attempted, so `STORE_UNAVAILABLE` says all there is to say — while a deployment
 * that answered "no" to something that *was* attempted has to distinguish the two:
 * Requirement 2.14 is a roster that could not be read and Requirement 2.8 is a
 * change that was not saved, and the Web_Client offers different affordances for
 * them. So the caller states which kind of operation it was performing and the
 * `reason` decides the rest.
 */

import type { AppErrorCode, Envelope, StoreFailure } from "@/domain/types"

/** The codes a failed read can carry (Requirements 2.14, 3.10). */
export type StoreReadErrorCode = Extract<
  AppErrorCode,
  "STORE_UNAVAILABLE" | "STORE_READ_FAILED"
>

/** The codes a failed write can carry (Requirements 2.8, 3.7). */
export type StoreWriteErrorCode = Extract<
  AppErrorCode,
  "STORE_UNAVAILABLE" | "STORE_WRITE_FAILED"
>

/** The three codes a store failure can carry. */
export type StoreErrorCode = StoreReadErrorCode | StoreWriteErrorCode

/**
 * Which kind of operation the failure belongs to. A history append is a `"write"`
 * for the purposes of this mapping, even though its only caller turns it into a
 * warning rather than into an envelope.
 */
export type StoreOperationKind = "read" | "write"

/**
 * Whether the failure was settled before the operation was attempted at all —
 * an absent or unparsable `MONGODB_URI` (Requirements 1.3, 1.10), or no
 * connection yet (Requirements 1.5, 1.11). Nothing was read and nothing was
 * written, so there is no read or write to name and `STORE_UNAVAILABLE` says all
 * there is to say.
 */
function nothingWasServed(failure: StoreFailure): boolean {
  return failure.reason !== "rejected"
}

/**
 * The code for a roster or Redemption_History read that did not complete
 * (Requirements 2.14, 3.10).
 *
 * Read and write get a function each rather than one function taking the kind,
 * so a caller that can only produce one of the two — the run coordinator, whose
 * roster snapshot is a read — is typed to exactly that pair instead of to all
 * three codes.
 */
export function storeReadFailureCode(
  failure: StoreFailure
): StoreReadErrorCode {
  return nothingWasServed(failure) ? "STORE_UNAVAILABLE" : "STORE_READ_FAILED"
}

/**
 * The code for a Member_Registry write that did not complete; the collection is
 * unchanged (Requirement 2.8).
 */
export function storeWriteFailureCode(
  failure: StoreFailure
): StoreWriteErrorCode {
  return nothingWasServed(failure) ? "STORE_UNAVAILABLE" : "STORE_WRITE_FAILED"
}

/**
 * The rejection envelope for `failure`, carrying the store's own sentence
 * unchanged.
 *
 * A rejection envelope holds no `warnings`, which is right for every store
 * failure this maps: the collection is unchanged, so there is no applied change
 * to warn about.
 */
export function storeFailureEnvelope<T>(
  failure: StoreFailure,
  operation: StoreOperationKind
): Envelope<T> {
  const code =
    operation === "read"
      ? storeReadFailureCode(failure)
      : storeWriteFailureCode(failure)
  return { ok: false, error: { code, message: failure.message } }
}
