/**
 * The progress indicator of a Redemption_Run in progress (Requirement 2.7).
 *
 * ## What this component is responsible for — and what it is not
 *
 * Requirement 2.7 has two halves. This component owns one of them: stating the
 * number of already processed Group_Members and the total number of enabled
 * Group_Members of the Redemption_Run. The other half — the submission control
 * being disabled while the run is in progress — belongs to `CouponForm` and the
 * run state machine (tasks 14.1 and 14.5), because the machine is the single
 * source of the disabled state (task 16.1). A progress bar that also reached
 * into the form would give that state two owners.
 *
 * Presentational only: it fetches nothing and subscribes to nothing. The page
 * derives `processed` / `total` from the streamed `run-started` and
 * `member-outcome` events (and from `getActiveRun` on mount, so a reload or a
 * second tab shows a correct counter) and passes them down.
 *
 * ## The numbers are text, not just a bar
 *
 * Requirement 2.7 says the indicator *states* both numbers, so both are rendered
 * as readable characters. The bar is decoration layered on top of that text — if
 * the bar were the only carrier, the count would exist solely as a CSS width.
 *
 * ## Accessibility
 *
 * The wrapper is an ARIA `progressbar` named by the visible heading, carrying
 * `aria-valuemin` / `aria-valuemax` / `aria-valuenow` plus an `aria-valuetext`
 * that spells out the counter, because "3" alone (or a percentage a screen
 * reader computes from it) says nothing about Group_Members. No `progress`
 * shadcn primitive is installed and none is added: the element below is a plain
 * `div`, so the feature adds no dependency.
 *
 * The counter line is a `status` region (implicitly `aria-live="polite"`,
 * `aria-atomic="true"`), not a bare paragraph, so a screen reader hears the run
 * advance without the user polling the page. `polite` is deliberate on both
 * counts: an `assertive` region would interrupt on every one of up to 100
 * Group_Members, whereas a polite region waits for a pause and drops the
 * announcements it superseded, so a fast run is heard as a few checkpoints
 * rather than a hundred interruptions. Only this one short line is live — the
 * heading and the Coupon_Code are outside it, so they are never re-announced.
 *
 * ## `total === 0`
 *
 * It should not happen: a Redemption_Run with no enabled Group_Member is
 * rejected before it starts (`NO_ENABLED_MEMBERS`). If it arrives anyway the
 * component still must not divide by zero, so it renders the counter text as
 * given and marks the bar *indeterminate* — `aria-valuenow` and the fill are
 * both omitted, which is exactly what ARIA reserves for "progress is unknown".
 */

import { useId } from "react"
import { cn } from "cn"

/** Heading of the indicator. Exported so a test asserts the text, not a paraphrase. */
export const RUN_PROGRESS_TITLE = "Redemption run in progress"

/**
 * The sentence carrying both numbers Requirement 2.7 asks for. Exported so the
 * page, the unit tests, and the accessible `aria-valuetext` all state the
 * progress identically.
 */
export function formatRunProgress(processed: number, total: number): string {
  return `Processed ${processed} of ${total} group members`
}

export interface RunProgressProps {
  /** Group_Members already recorded — `processed` of a `member-outcome` event. */
  readonly processed: number
  /** Enabled Group_Members in the fixed list of the run — `total` of the events. */
  readonly total: number
  /** Coupon_Code of the run, shown when known. Useful when the page was seeded
   *  from `getActiveRun` and the input field is empty. */
  readonly couponCode?: string
  readonly className?: string
}

/** The progress indicator of a Redemption_Run (Requirement 2.7). */
export function RunProgress({
  processed,
  total,
  couponCode,
  className,
}: RunProgressProps) {
  const headingId = useId()

  // A run of a known size is the only case with a meaningful ratio. Guarding on
  // `total > 0` keeps the percentage away from a division by zero.
  const determinate = total > 0
  // Clamped so an out-of-order or duplicated event cannot push the bar past its
  // track or produce an aria-valuenow outside the declared range.
  const value = determinate ? Math.min(Math.max(processed, 0), total) : 0
  const percent = determinate ? (value / total) * 100 : 0
  const label = formatRunProgress(processed, total)

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <p id={headingId} className="text-sm font-medium">
        {RUN_PROGRESS_TITLE}
      </p>
      {couponCode === undefined ? null : (
        <p className="text-sm text-muted-foreground">
          Coupon code: <span className="font-mono">{couponCode}</span>
        </p>
      )}
      <p role="status" className="text-sm">
        {label}
      </p>
      <div
        role="progressbar"
        aria-labelledby={headingId}
        aria-valuemin={0}
        aria-valuemax={determinate ? total : undefined}
        aria-valuenow={determinate ? value : undefined}
        aria-valuetext={determinate ? label : undefined}
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-200"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}
