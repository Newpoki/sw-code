/**
 * The confirmation dialog of the redemption page (Requirements 2.5, 2.6, 6.7).
 *
 * Requirement 2.5 has two halves: the dialog *lists* the Member_Label of every
 * enabled Group_Member in Member_Registry order, and the redemption request is
 * sent *only after* the Group_Member confirms. This component owns the listing
 * and the confirm/dismiss signals; the page (task 14.5) owns the sending,
 * because it is the only place that can call the server function.
 *
 * ## Presentational on purpose
 *
 * Nothing is fetched here. The previously-used notice of Requirement 6.7 needs a
 * character-for-character Coupon_Code comparison against Redemption_History, and
 * that comparison stays on the server in `findLatestRunForCoupon`
 * (`src/functions/history.functions.ts`); the page calls it and hands the
 * resulting record — or `null` — down as
 * {@link ConfirmRunDialogProps.previousRun}. `null` means "no matching record",
 * so no notice renders. Re-deriving the match in the browser would fold letter
 * case or surrounding whitespace sooner or later and announce a "last used"
 * timestamp for a Coupon_Code that was never redeemed.
 *
 * Because no data is fetched and no router hook is read, tasks 14.7 and 14.8
 * render this component with `@testing-library/react` alone — no router, no
 * query client, no live server.
 *
 * ## Requirement 2.6 is a shared obligation
 *
 * "Dismissing the dialog retains the entered Coupon_Code and withholds the
 * request." The input lives in `CouponForm` (task 14.1), so *retaining* is the
 * form's and the page's job: on {@link ConfirmRunDialogProps.onDismiss} the page
 * returns the run state machine to `idle` and leaves the Coupon_Code state
 * untouched. What this component guarantees is the other half — it owns no draft
 * of the Coupon_Code, so it can clear nothing, and every dismissal path (the
 * dismiss control, the close button, `Escape`, an overlay click) ends in exactly
 * one `onDismiss` call and never in `onConfirm`.
 *
 * ## Order, duplicates, and keys
 *
 * `members` is rendered in the order it is given and is never sorted: the store
 * returns the Member_Registry in insertion order and `listMembers` passes it
 * through untouched, so array order *is* the Member_Registry order Requirement
 * 2.5 asks for. Nothing is de-duplicated either — only the Hive_ID is unique, so
 * two Group_Members may legitimately share a Member_Label and both must appear.
 * That is also why the list is keyed on `id` and never on the label.
 */

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type {
  MemberRegistryEntry,
  RedemptionHistoryRecord,
} from "@/domain/types"

/** Accessible name of the dialog. Exported so a test can name it exactly. */
export const CONFIRM_RUN_DIALOG_TITLE = "Redeem this coupon code?"

/** Heading of the Requirement 6.7 notice. */
export const PREVIOUSLY_USED_TITLE = "This coupon code was already used"

/** Visible text of the dismiss control (Requirement 2.6). */
export const DISMISS_LABEL = "Cancel, keep the coupon code"

export interface ConfirmRunDialogProps {
  /**
   * Controlled visibility. The page holds it and passes `true` only while the
   * run state machine is in `confirming`. Defaults to `true` so a test can
   * render the dialog without wiring state.
   */
  readonly open?: boolean
  /**
   * The submitted Coupon_Code, already trimmed by the form (Requirement 2.2).
   * Rendered as literal text, never as markup.
   */
  readonly couponCode: string
  /**
   * The enabled Member_Registry entries, in Member_Registry order. Rendered as
   * received: not sorted, not de-duplicated. An entry with `enabled: false` is
   * left out, so handing over the whole registry is equally correct and no
   * disabled Group_Member can ever be listed (Requirement 2.5).
   */
  readonly members: readonly MemberRegistryEntry[]
  /**
   * The most recent Redemption_History record whose Coupon_Code matches the
   * submitted one character for character, as returned by
   * `findLatestRunForCoupon`, or `null` when none matches — in which case no
   * notice renders (Requirement 6.7).
   */
  readonly previousRun: RedemptionHistoryRecord | null
  /**
   * The Group_Member confirmed. The page sends the redemption request, which is
   * the only moment at which it may be sent (Requirement 2.5).
   */
  readonly onConfirm: () => void
  /**
   * The Group_Member dismissed — the dismiss control, the close button,
   * `Escape`, or an overlay click. The page keeps the entered Coupon_Code and
   * sends nothing (Requirement 2.6).
   */
  readonly onDismiss: () => void
}

/**
 * A completion timestamp rendered as `YYYY-MM-DD HH:MM:SS UTC`.
 *
 * Deliberately not `toLocaleString`: this dialog is server-rendered, and a
 * locale- or time-zone-dependent format produces different text on the server
 * and in the browser, which React reports as a hydration mismatch. A fixed UTC
 * rendering built from the `getUTC*` accessors is identical everywhere, and it is
 * unambiguous — `completedAt` is an ISO 8601 instant, so showing it in UTC states
 * the same instant the store and the history page hold.
 *
 * An unparseable value falls back to the raw string rather than showing
 * `Invalid Date`: whatever the server stored is more informative than that.
 */
export function formatCompletedAt(completedAt: string): string {
  const at = new Date(completedAt)
  if (Number.isNaN(at.getTime())) return completedAt

  const pad = (value: number, width = 2) => String(value).padStart(width, "0")
  const date = `${pad(at.getUTCFullYear(), 4)}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`
  const time = `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`
  return `${date} ${time} UTC`
}

/** The confirmation dialog (Requirements 2.5, 2.6, 6.7). */
export function ConfirmRunDialog({
  open = true,
  couponCode,
  members,
  previousRun,
  onConfirm,
  onDismiss,
}: ConfirmRunDialogProps) {
  const enabled = members.filter((member) => member.enabled)
  const memberWord = enabled.length === 1 ? "group member" : "group members"

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Radix reports every dismissal path through this callback. Confirming
        // does not close the dialog from here — the page flips `open` when the
        // run starts — so a `false` is always a dismissal (Requirement 2.6).
        if (!next) onDismiss()
      }}
    >
      {/*
       * Focus handling is left to the primitive: it traps focus inside the
       * dialog, restores it on close, and lands the initial focus on the first
       * control, which is the dismiss control. Moving the initial focus to the
       * confirm control would put a real redemption run one `Enter` away.
       */}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{CONFIRM_RUN_DIALOG_TITLE}</DialogTitle>
          {/* Radix wires this element as the dialog's accessible description. */}
          <DialogDescription>
            The coupon code{" "}
            <code className="font-mono break-all">{couponCode}</code> is
            redeemed for {enabled.length} enabled {memberWord}, one after
            another, in roster order.
          </DialogDescription>
        </DialogHeader>

        {previousRun === null ? null : (
          /*
           * Requirement 6.7. `Alert` carries `role="alert"`, so the notice is
           * announced rather than sitting silently next to the description. The
           * `<time>` keeps the stored ISO 8601 instant machine-readable while
           * the text stays queryable.
           */
          <Alert data-slot="previously-used-notice">
            <AlertTitle>{PREVIOUSLY_USED_TITLE}</AlertTitle>
            <AlertDescription>
              Most recently completed at{" "}
              <time dateTime={previousRun.completedAt}>
                {formatCompletedAt(previousRun.completedAt)}
              </time>
              . Redeeming it again is allowed and every enabled group member is
              still contacted.
            </AlertDescription>
          </Alert>
        )}

        {enabled.length === 0 ? (
          /*
           * Unreachable through the page: the form's Requirement 2.4 guard keeps
           * the dialog shut while no entry is enabled. Stated rather than left
           * as an empty list, so a wiring mistake reads as a mistake.
           */
          <p>No group member is enabled, so there is nothing to redeem.</p>
        ) : (
          /* Member_Registry order, enabled only, as received (Requirement 2.5). */
          <ul
            data-slot="confirm-member-list"
            aria-label={`Enabled group members (${enabled.length})`}
            className="flex list-none flex-col gap-1"
          >
            {enabled.map((member) => (
              <li key={member.id}>{member.memberLabel}</li>
            ))}
          </ul>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onDismiss}>
            {DISMISS_LABEL}
          </Button>
          <Button
            type="button"
            disabled={enabled.length === 0}
            onClick={onConfirm}
          >
            Redeem for {enabled.length} {memberWord}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
