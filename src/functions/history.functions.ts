/**
 * The Redemption_History server function surface (Requirements 6.6, 6.7).
 *
 * Two `createServerFn` reads, each returning an {@link Envelope} instead of
 * throwing, exactly as `src/functions/members.functions.ts` does:
 *
 * - {@link listHistory} — the retained records in Requirement 6.6 order, with
 *   an optional cap.
 * - {@link findLatestRunForCoupon} — the most recent record whose Coupon_Code
 *   matches the submitted one character for character, or null
 *   (Requirement 6.7).
 *
 * ## Why the ordering is not re-stated here
 *
 * `HistoryStore.list()` already applies the Requirement 6.6 ordering — most
 * recent `completedAt` first, most recently appended (`seq` descending) among
 * records sharing a completion timestamp — and applies the cap *after* ordering,
 * so a cap keeps the newest records. This module therefore adds no comparator of
 * its own and the history page renders the array in the order it arrives; a
 * client-side re-sort would be a second, drifting statement of the same rule.
 *
 * ## Why Requirement 6.7 gets its own function
 *
 * The confirmation dialog needs the completion timestamp of the most recent
 * record holding the submitted Coupon_Code, compared character for character.
 * Deriving that by filtering a {@link listHistory} result would only be correct
 * when the client happens to hold the whole retained window, and it would move a
 * character-exact comparison into the browser. {@link findLatestRunForCoupon}
 * keeps the comparison on the server, on top of
 * `HistoryStore.findLatestByCouponCode`, and returns one record or null.
 *
 * ## Validation
 *
 * Same convention as the Member_Registry surface: the validator never throws,
 * it returns a {@link Validated} verdict, and the handler turns a failed verdict
 * into a `VALIDATION` envelope. `Validated` is imported from
 * `members.functions.ts`; the `verdictValidator` helper there is module-private,
 * so the two-line equivalent is mirrored below rather than exported from there.
 *
 * The limit and the Coupon_Code schemas live in this module rather than in
 * `src/domain/schemas.ts`: the limit is a read knob of this endpoint, not a
 * field of any Web_Client form, so nothing outside this module has to agree with
 * it. The Coupon_Code schema is the shared `couponCodeSchema`, so the value
 * compared against history is trimmed the same way the value the run stored was
 * (Requirements 2.2, 2.10).
 *
 * Neither function writes anything, so no envelope returned here ever carries a
 * warning.
 */

import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"

import { couponCodeSchema, firstErrorMessage } from "@/domain/schemas"
import { HISTORY_RETENTION_LIMIT } from "@/domain/types"
import { getHistoryStore } from "@/server/store/history.server"
import type { Validated } from "@/functions/members.functions"
import type { Envelope, RedemptionHistoryRecord } from "@/domain/types"
import type { HistoryStore } from "@/server/store/history.server"

/** Smallest accepted `limit`. Zero is rejected: an empty page is not a read. */
export const HISTORY_LIMIT_MIN = 1

/**
 * Largest accepted `limit`. Equal to the retention window, because no larger
 * value could ever return more records.
 */
export const HISTORY_LIMIT_MAX = HISTORY_RETENTION_LIMIT

/**
 * The single rejection message for a bad `limit`, naming the field and its
 * permitted range in the same shape the roster messages use.
 */
export function limitRangeMessage(): string {
  return `limit must be an integer from ${HISTORY_LIMIT_MIN} to ${HISTORY_LIMIT_MAX}`
}

/* -------------------------------------------------------------------------- */
/* Input schemas                                                              */
/* -------------------------------------------------------------------------- */

/**
 * An accepted `limit`: a finite integer inside the retention window.
 *
 * The store tolerates more than this — it returns every retained record for an
 * absent or non-finite limit, and floors a negative finite limit into an empty
 * slice — but tolerating is not the same as accepting. A caller that sends
 * `-3`, `2.7`, `NaN`, or `1e21` has a bug, and silently answering it with
 * "everything" or with "nothing" hides that bug at the boundary where it is
 * cheapest to see. So the surface is deliberately narrower than the store: the
 * four shapes above are rejected with {@link limitRangeMessage}, and only an
 * absent `limit` means "every retained record".
 */
const historyLimitSchema = z
  .number({ error: limitRangeMessage() })
  .refine(
    (value) =>
      Number.isInteger(value) &&
      value >= HISTORY_LIMIT_MIN &&
      value <= HISTORY_LIMIT_MAX,
    { error: limitRangeMessage() }
  )

/** Payload of {@link listHistory}. Every field is optional (Requirement 6.6). */
export const listHistoryInputSchema = z.object({
  limit: historyLimitSchema.optional(),
})

/** Payload of {@link findLatestRunForCoupon} (Requirement 6.7). */
export const findLatestRunInputSchema = z.object({
  couponCode: couponCodeSchema,
})

export type ListHistoryInput = z.output<typeof listHistoryInputSchema>
export type FindLatestRunInput = z.output<typeof findLatestRunInputSchema>

/* -------------------------------------------------------------------------- */
/* Envelope construction                                                      */
/* -------------------------------------------------------------------------- */

/** A read envelope: nothing was written, so there is nothing to warn about. */
function read<T>(data: T): Envelope<T> {
  return { ok: true, data, warnings: [] }
}

/** A rejection envelope. Only validation can reject a read. */
function rejected<T>(message: string): Envelope<T> {
  return { ok: false, error: { code: "VALIDATION", message } }
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Validator of the {@link listHistory} payload.
 *
 * An absent payload is valid and means "every retained record", which is what
 * keeps `listHistory()` callable with no argument at all.
 */
export function validateListHistoryInput(
  input: ListHistoryInput | undefined
): Validated<ListHistoryInput> {
  if (input === undefined) return { ok: true, value: {} }
  const parsed = listHistoryInputSchema.safeParse(input)
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, message: firstErrorMessage(parsed.error) }
}

/** Validator of the {@link findLatestRunForCoupon} payload (Requirement 6.7). */
export function validateFindLatestRunInput(
  input: FindLatestRunInput
): Validated<FindLatestRunInput> {
  const parsed = findLatestRunInputSchema.safeParse(input)
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, message: firstErrorMessage(parsed.error) }
}

/* -------------------------------------------------------------------------- */
/* Envelope operations over a store                                           */
/* -------------------------------------------------------------------------- */

/**
 * The retained Redemption_History records in Requirement 6.6 order, capped to
 * `limit` when one was submitted.
 *
 * Exported separately from the server function, taking the store as a
 * parameter, because `createServerFn(...).handler(fn)` cannot be invoked
 * directly in a unit test.
 */
export function readHistory(
  store: HistoryStore,
  input: ListHistoryInput = {}
): Envelope<RedemptionHistoryRecord[]> {
  return read(store.list(input.limit))
}

/**
 * The most recent record whose Coupon_Code is character-for-character identical
 * to the submitted one, or null when no record matches (Requirement 6.7).
 *
 * The comparison happens in the store and folds nothing: a differing letter
 * case or a differing surrounding whitespace run is a different Coupon_Code, so
 * the dialog cannot announce a "last used" timestamp for a code that was never
 * redeemed.
 */
export function readLatestRunForCoupon(
  store: HistoryStore,
  input: FindLatestRunInput
): Envelope<RedemptionHistoryRecord | null> {
  return read(store.findLatestByCouponCode(input.couponCode))
}

/* -------------------------------------------------------------------------- */
/* The server functions                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The retained Redemption_History records in Requirement 6.6 order, optionally
 * capped (Requirement 6.6).
 *
 * A `GET`: it writes nothing. The Access_Gate and the cross-site check are
 * applied globally in `src/start.ts`, so nothing here re-checks them.
 */
export const listHistory = createServerFn()
  .validator(validateListHistoryInput)
  .handler(({ data }) =>
    data.ok
      ? readHistory(getHistoryStore(), data.value)
      : rejected<RedemptionHistoryRecord[]>(data.message)
  )

/**
 * The most recent Redemption_History record holding exactly the submitted
 * Coupon_Code, or null (Requirement 6.7). Backs the "last used" notice of the
 * confirmation dialog.
 */
export const findLatestRunForCoupon = createServerFn()
  .validator(validateFindLatestRunInput)
  .handler(({ data }) =>
    data.ok
      ? readLatestRunForCoupon(getHistoryStore(), data.value)
      : rejected<RedemptionHistoryRecord | null>(data.message)
  )
