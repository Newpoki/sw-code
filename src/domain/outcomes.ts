/**
 * Member_Outcome helpers for shared-coupon-redemption.
 *
 * Pure and client-safe: the Web_Client summary and the server-side
 * RunCoordinator share these functions, so nothing here imports from
 * `src/server/`.
 */

import { MEMBER_OUTCOME_VALUES } from "@/domain/types"
import type {
  MemberOutcome,
  MemberOutcomeValue,
  OutcomeCounts,
} from "@/domain/types"

/** The `SKIPPED` variant of {@link MemberOutcome}: no request was ever issued. */
export type SkippedMemberOutcome = Extract<
  MemberOutcome,
  { outcome: "SKIPPED" }
>

/**
 * The fields a `SKIPPED` Member_Outcome copies from a roster entry. Accepting
 * this structural shape rather than a full `MemberRegistryEntry` lets the run
 * loop build outcomes from its fixed-list snapshot without carrying `id`,
 * `enabled`, or `createdAt` along.
 */
export interface OutcomeMemberRef {
  readonly hiveId: string
  readonly memberLabel: string
}

/**
 * A fresh mutable counter holding all six Member_Outcome keys at zero, inserted
 * in `MEMBER_OUTCOME_VALUES` order so `Object.keys` and `for...in` iterate in
 * the order the summary renders (Requirement 6.3).
 */
function zeroedCounts(): Record<MemberOutcomeValue, number> {
  const counts = {} as Record<MemberOutcomeValue, number>
  for (const value of MEMBER_OUTCOME_VALUES) {
    counts[value] = 0
  }
  return counts
}

/**
 * `OutcomeCounts` with every one of the six values at zero. Used for a
 * Redemption_Run that ends before any Member_Outcome exists.
 *
 * Requirement 6.3.
 */
export function emptyOutcomeCounts(): OutcomeCounts {
  return zeroedCounts()
}

/**
 * Counts the Member_Outcomes of a Redemption_Run.
 *
 * All six keys are always present, including the ones whose count is zero, and
 * the six counts sum to `outcomes.length`.
 *
 * Requirement 6.3.
 */
export function countOutcomes(
  outcomes: readonly MemberOutcome[]
): OutcomeCounts {
  const counts = zeroedCounts()
  for (const { outcome } of outcomes) {
    counts[outcome] += 1
  }
  return counts
}

/**
 * Builds the `SKIPPED` Member_Outcome of a roster entry at its 0-based position
 * in the fixed list of a Redemption_Run. `upstreamResult` is null because no
 * Upstream_API request was issued for that Group_Member.
 *
 * Requirements 5.2, 5.8.
 */
export function skippedOutcome(
  member: OutcomeMemberRef,
  position: number
): SkippedMemberOutcome {
  return {
    hiveId: member.hiveId,
    memberLabel: member.memberLabel,
    position,
    outcome: "SKIPPED",
    upstreamResult: null,
  }
}

/**
 * Builds one `SKIPPED` Member_Outcome for every fixed-list position that
 * `outcomes` does not already cover, in ascending position order.
 *
 * This is the backfill the run loop appends in its `finally` block, which is
 * what keeps the outcome count equal to the fixed-list size on every path,
 * including a Redemption_Run that fails before its first request.
 *
 * Requirements 5.6, 5.8.
 */
export function missingSkippedOutcomes(
  fixedList: readonly OutcomeMemberRef[],
  outcomes: readonly MemberOutcome[]
): SkippedMemberOutcome[] {
  const covered = new Set(outcomes.map((outcome) => outcome.position))
  const missing: SkippedMemberOutcome[] = []
  for (const [position, member] of fixedList.entries()) {
    if (!covered.has(position)) {
      missing.push(skippedOutcome(member, position))
    }
  }
  return missing
}
