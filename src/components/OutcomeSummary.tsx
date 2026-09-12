/**
 * The outcome summary of a Redemption_Run (Requirement 6.3).
 *
 * Presentational only: it takes the six counts it is handed and renders them. It
 * fetches nothing and calls no server function, so a test renders it with
 * `@testing-library/react` alone.
 *
 * ## Counts in, not outcomes in
 *
 * The prop is `OutcomeCounts`, not the outcome list. Requirement 6.3 is about
 * the counts *the Redemption_Server reported*: `RedemptionRunResult.counts` is
 * produced server-side by `countOutcomes` over the same fixed list that decides
 * the number of rows, so displaying that object shows what the server concluded
 * rather than a second, client-side tally that could disagree with it. A caller
 * that only holds a partial outcome list — a run still in progress — can call
 * the same pure, client-safe `countOutcomes` from `@/domain/outcomes` and pass
 * the result in, and a caller with no run yet can pass `emptyOutcomeCounts()`.
 *
 * ## Why it iterates `MEMBER_OUTCOME_VALUES`
 *
 * Requirement 6.3 asks for the count of each of the six Member_Outcome values
 * *including every value whose count equals zero*. Iterating the counts object
 * would satisfy that only as long as the object really carries all six keys;
 * iterating the value tuple satisfies it by construction, because the tuple *is*
 * the list of the six values and each entry reads its count by key. A missing
 * key would surface as a rendered `0`, never as a missing entry. The tuple also
 * fixes the reading order in one place rather than per call site.
 *
 * The second half of Requirement 6.3 — the six counts summing to the number of
 * enabled Group_Members of the run — is a property of `countOutcomes`, verified
 * server-side; this component adds nothing to and removes nothing from the
 * counts it is given, so the sum it displays is the sum it received.
 *
 * The `<dl>` is deliberate: each outcome value is a term and its count is that
 * term's description, which is what a definition list means, and it gives
 * assistive technology the pairing that a stack of `<div>`s would not.
 */

import { OutcomeBadge } from "@/components/RunResultTable"
import { MEMBER_OUTCOME_VALUES } from "@/domain/types"
import type { OutcomeCounts } from "@/domain/types"
import { cn } from "@/lib/utils"

/** Default accessible name of the summary group. */
export const OUTCOME_SUMMARY_LABEL = "Outcome summary"

export interface OutcomeSummaryProps {
  /**
   * The six Member_Outcome counts of the run, as reported by the
   * Redemption_Server. All six keys are always present on `OutcomeCounts`, and
   * every one of them is rendered, zero included.
   */
  readonly counts: OutcomeCounts
  /** Accessible name of the summary group. */
  readonly label?: string
  readonly className?: string
}

/** The six Member_Outcome counts of a Redemption_Run. */
export function OutcomeSummary({
  counts,
  label = OUTCOME_SUMMARY_LABEL,
  className,
}: OutcomeSummaryProps) {
  return (
    <dl
      aria-label={label}
      className={cn(
        "grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6",
        className
      )}
    >
      {MEMBER_OUTCOME_VALUES.map((outcome) => (
        <div
          key={outcome}
          data-outcome={outcome}
          className="flex flex-col items-start gap-1 rounded-md border p-3"
        >
          <dt>
            <OutcomeBadge outcome={outcome} />
          </dt>
          {/* The count is text, so it is queryable as text; `data-outcome`
           * pairs it with its value for a test that needs one exact node. */}
          <dd
            data-outcome={outcome}
            className="text-2xl font-medium tabular-nums"
          >
            {counts[outcome]}
          </dd>
        </div>
      ))}
    </dl>
  )
}
