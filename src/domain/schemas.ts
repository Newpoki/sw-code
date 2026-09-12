/**
 * zod schemas for every validated input of shared-coupon-redemption.
 *
 * This module is client-safe: it imports only `zod` and `./types`, never
 * anything from `src/server/`. The client forms and the server validators
 * (`createServerFn().validator(...)`, a plain non-throwing function over the
 * same schema) share these schemas, so a client-side message and a server-side
 * message for the same rejection cannot drift
 * (Requirements 1.3, 2.3, 2.10, 3.7).
 *
 * Two rules hold for every text field below:
 *   - Validation is applied *after* leading and trailing whitespace is removed,
 *     and the parsed output is the trimmed value. A value holding zero
 *     characters before trimming is therefore rejected by the same check as a
 *     value holding zero characters after trimming (Requirement 3.7).
 *   - The letter case of the remaining characters is preserved
 *     (Requirement 2.3).
 */

import { z } from "zod"

/** Maximum characters of a Member_Label after trimming (Requirement 1.1). */
export const MEMBER_LABEL_MAX_LENGTH = 40

/** Maximum characters of a Hive_ID after trimming (Requirement 1.1). */
export const HIVE_ID_MAX_LENGTH = 64

/** Maximum characters of a Coupon_Code after trimming (Requirements 2.1, 3.1). */
export const COUPON_CODE_MAX_LENGTH = 64

/** Maximum characters of a Member_Registry entry id. */
export const MEMBER_ID_MAX_LENGTH = 64

/** Field names as they appear in a rejection message. */
export const FIELD_NAMES = {
  memberLabel: "Member_Label",
  hiveId: "Hive_ID",
  couponCode: "Coupon_Code",
  memberId: "Member id",
} as const

/**
 * The single rejection message shape used for every length violation: it names
 * the rejected field and its allowed character-count range, which is what
 * Requirements 1.3, 2.3, 2.10, and 3.7 each demand. Exported so a hand-written
 * check outside zod (a store guard, a component hint) can render the identical
 * sentence instead of an approximation of it.
 */
export function lengthRangeMessage(
  fieldName: string,
  min: number,
  max: number
): string {
  return `${fieldName} must hold ${min} to ${max} characters`
}

/**
 * A text field that is trimmed first and length-checked second, so the check
 * and the stored value always agree. `transform` runs before `refine`, so the
 * refinement sees the trimmed value and the parsed output is that same trimmed
 * value with its letter case untouched.
 */
function trimmedText(fieldName: string, maxLength: number) {
  const message = lengthRangeMessage(fieldName, 1, maxLength)
  return z
    .string({ error: message })
    .transform((value) => value.trim())
    .refine((value) => value.length >= 1 && value.length <= maxLength, {
      error: message,
    })
}

/** Member_Label: 1 to 40 characters after trimming (Requirements 1.1, 1.3). */
export const memberLabelSchema = trimmedText(
  FIELD_NAMES.memberLabel,
  MEMBER_LABEL_MAX_LENGTH
)

/** Hive_ID: 1 to 64 characters after trimming (Requirements 1.1, 1.3). */
export const hiveIdSchema = trimmedText(FIELD_NAMES.hiveId, HIVE_ID_MAX_LENGTH)

/**
 * Coupon_Code: 1 to 64 characters after trimming. The same schema backs the
 * Web_Client form check (Requirement 2.3) and the Redemption_Server check
 * (Requirements 2.10, 3.7), which is what keeps the two messages identical.
 */
export const couponCodeSchema = trimmedText(
  FIELD_NAMES.couponCode,
  COUPON_CODE_MAX_LENGTH
)

/** Member_Registry entry id: the server-generated surrogate key of an entry. */
export const memberIdSchema = trimmedText(
  FIELD_NAMES.memberId,
  MEMBER_ID_MAX_LENGTH
)

/** Enabled flag of a Member_Registry entry (Requirement 1.9). */
export const enabledSchema = z.boolean({
  error: "enabled must hold true or false",
})

/** Payload of `addMember` (Requirements 1.1, 1.3). */
export const addMemberInputSchema = z.object({
  memberLabel: memberLabelSchema,
  hiveId: hiveIdSchema,
})

/** Payload of `setMemberEnabled` (Requirement 1.9). */
export const setMemberEnabledInputSchema = z.object({
  id: memberIdSchema,
  enabled: enabledSchema,
})

/** Payload of `removeMember` (Requirement 1.5). */
export const removeMemberInputSchema = z.object({
  id: memberIdSchema,
})

/**
 * Payload of `runRedemption`. The Coupon_Code is the only caller-supplied
 * value; no Hive_ID is ever part of this payload (Requirements 3.1, 3.2).
 */
export const runRedemptionInputSchema = z.object({
  couponCode: couponCodeSchema,
})

export type AddMemberInput = z.output<typeof addMemberInputSchema>
export type SetMemberEnabledInput = z.output<typeof setMemberEnabledInputSchema>
export type RemoveMemberInput = z.output<typeof removeMemberInputSchema>
export type RunRedemptionInput = z.output<typeof runRedemptionInputSchema>

/**
 * First rejection message of a failed parse, or null when the parse succeeded.
 * Server functions map this straight onto the `VALIDATION` envelope error, and
 * the client forms render the same string, so neither side has to compose a
 * message of its own.
 */
export function firstErrorMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "The submitted value is invalid"
}
