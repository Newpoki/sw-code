/**
 * The Coupon_Code form of the redemption page (Requirements 2.1, 2.2, 2.3, 2.4,
 * 2.7, 2.8, 2.9, 6.4).
 *
 * One input field, one submission control, and the two client-side guards that
 * decide whether a redemption request may be attempted at all.
 *
 * ## Presentational only
 *
 * The input value is a prop, not local state, and the submission is handed to
 * {@link CouponFormProps.onSubmit}: this component calls no server function and
 * holds no query. `src/routes/index.tsx` (task 14.5) owns `runRedemption`,
 * `getActiveRun`, and `findLatestRunForCoupon`, so a test renders this form with
 * nothing but `@testing-library/react`.
 *
 * The page owning the value is also what makes "the entered value is retained"
 * true by construction in all four places the requirements ask for it — a failed
 * length check (2.3), an empty enabled roster (2.4), a dismissed dialog (2.6), a
 * completed run (2.8), and a server error (6.4). None of those paths runs through
 * a setter that could clear it, because this component has no such setter.
 *
 * ## Why the input carries no `maxLength`
 *
 * Requirement 2.1 asks for an input that accepts at most 64 characters and
 * Requirement 2.3 asks for a *message* stating the permitted length of 1 to 64
 * characters whenever the trimmed value falls outside it. A DOM `maxLength` of 64
 * would satisfy the first by silently discarding the tail of an over-long paste,
 * and in doing so would make the over-long branch of the second unreachable —
 * the Group_Member would be left wondering which characters went missing instead
 * of being told the code is too long. The cap is therefore enforced by rejecting
 * the value with that message and keeping it in the field, which is the same
 * choice `AddMemberForm` documents for the Member_Label and Hive_ID fields, so
 * both forms treat an over-long value the same way. The server re-checks the
 * length regardless (Requirements 2.10, 3.7), so nothing depends on this guard
 * for correctness.
 *
 * ## Why the length message comes from the shared schema
 *
 * `couponCodeSchema` is the schema `runRedemptionInputSchema` is built from, and
 * that is what `runRedemption` validates with on the server. Parsing here with
 * the same schema means the message shown before the request and the message
 * returned by a rejected request are produced by the same call to
 * `lengthRangeMessage` — the identical sentence
 * `src/server/run/redemptionRequest.server.ts` exports as
 * `COUPON_CODE_RANGE_MESSAGE`. Importing that constant directly is not an
 * option: it lives in a `.server` module, which must never enter a client
 * component. The parse output
 * is also the trimmed value with the letter case of the remainder preserved
 * (Requirement 2.2), so what is submitted is exactly what the server would
 * validate.
 */

import { useId, useState } from "react"
import { cn } from "cn"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  COUPON_CODE_MAX_LENGTH,
  couponCodeSchema,
  firstErrorMessage,
} from "@/domain/schemas"

/** Visible label of the Coupon_Code field. Exported so a test names it exactly. */
export const COUPON_CODE_LABEL = "Coupon code"

/**
 * Visible text of the submission control. It does not change while a run is in
 * progress — the control's accessible name has to stay stable for the disabled
 * and re-enabled assertions of Requirements 2.7, 2.8, and 6.4 to be about the
 * same control, and the progress indicator is what reports the run.
 */
export const SUBMIT_LABEL = "Redeem coupon"

/** The permitted-length hint shown next to the field (Requirement 2.1). */
export const COUPON_CODE_HINT = `1 to ${COUPON_CODE_MAX_LENGTH} characters`

/**
 * The Requirement 2.4 message: it instructs the Group_Member to add a
 * Group_Member first. This is the Web_Client's own sentence — the server's
 * equivalent lives in `coordinator.server.ts` and cannot be imported here — and
 * it is exported so a test asserts this exact wording.
 */
export const NO_ENABLED_MEMBER_MESSAGE =
  "Add a group member first. The roster holds no enabled group member, so there is nothing to redeem."

export interface CouponFormProps {
  /**
   * The entered value, owned by the page. Passed through untouched: it is neither
   * trimmed nor cased on the way in, so the Group_Member sees exactly what was
   * typed until a submission trims it.
   */
  readonly value: string
  /** Every keystroke, with the raw value. */
  readonly onValueChange: (next: string) => void
  /**
   * A submission that passed both client-side guards, carrying the trimmed value
   * with the letter case of the remainder preserved (Requirement 2.2). The page
   * opens the confirmation dialog from here; the request itself is sent only
   * after that dialog is confirmed (Requirement 2.5).
   */
  readonly onSubmit: (couponCode: string) => void
  /**
   * True while a Redemption_Run is in progress — the page passes
   * `isRunInProgress(runState)` from `runState.ts`, which is the single source of
   * this state. It disables the control and makes the submit handler withhold the
   * request, so the `Enter` key is blocked as well as the button
   * (Requirements 2.7, 2.9).
   */
  readonly disabled?: boolean
  /**
   * Whether the Member_Registry holds at least one enabled entry. `false`
   * triggers the Requirement 2.4 guard. Defaults to true so a roster that has not
   * loaded yet does not produce a "add a group member" message about a roster
   * nobody has read.
   */
  readonly hasEnabledMember?: boolean
  /**
   * A message the Redemption_Server returned for the last request, displayed as
   * an error notification (Requirement 6.4). Rendered as a React text child, so
   * every markup character in it stays a visible character.
   */
  readonly errorMessage?: string | null
  readonly className?: string
}

/** The Coupon_Code form (Requirements 2.1 to 2.4, 2.7 to 2.9, 6.4). */
export function CouponForm({
  value,
  onValueChange,
  onSubmit,
  disabled = false,
  hasEnabledMember = true,
  errorMessage = null,
  className,
}: CouponFormProps) {
  const fieldId = useId()
  const hintId = useId()
  const guardId = useId()

  /**
   * The rejection of the last submission attempt: either the 1-to-64 message of
   * Requirement 2.3 or the "add a group member first" message of Requirement 2.4.
   * One slot for both, because both mean the same thing to the Group_Member — the
   * value stayed in the field and nothing was sent.
   */
  const [guardMessage, setGuardMessage] = useState<string | null>(null)

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    /* Requirement 2.9. The disabled button blocks a click, but `Enter` inside the
     * field still submits the form, so the machine's state is re-checked here.
     * Nothing is displayed and nothing is cleared: the run's progress indicator
     * stays exactly as it is. */
    if (disabled) return

    /* Requirement 2.3, and the trimming of Requirement 2.2. Length first, which
     * is the order the server checks in as well. */
    const parsed = couponCodeSchema.safeParse(value)
    if (!parsed.success) {
      setGuardMessage(firstErrorMessage(parsed.error))
      return
    }

    /* Requirement 2.4: a run over an empty enabled roster is never attempted. */
    if (!hasEnabledMember) {
      setGuardMessage(NO_ENABLED_MEMBER_MESSAGE)
      return
    }

    setGuardMessage(null)
    onSubmit(parsed.data)
  }

  return (
    <form
      onSubmit={handleSubmit}
      className={cn("flex flex-col gap-3", className)}
      noValidate
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor={fieldId} className="text-sm font-medium">
          {COUPON_CODE_LABEL}
        </label>
        <Input
          id={fieldId}
          name="couponCode"
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          /* The letter case of what was typed is never folded here: the coupon
           * code is compared character for character upstream and in history. */
          autoCapitalize="off"
          aria-invalid={guardMessage !== null}
          aria-describedby={
            guardMessage === null ? hintId : `${hintId} ${guardId}`
          }
        />
        <p id={hintId} className="text-sm text-muted-foreground">
          {COUPON_CODE_HINT}
        </p>
        {guardMessage === null ? null : (
          <p id={guardId} className="text-sm text-destructive" role="alert">
            {guardMessage}
          </p>
        )}
      </div>

      {/* The server's own sentence, rendered as text and never as markup. */}
      {errorMessage === null ? null : (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" disabled={disabled} className="self-start">
        {SUBMIT_LABEL}
      </Button>
    </form>
  )
}
