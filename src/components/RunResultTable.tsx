/**
 * The per-Group_Member result rows of a Redemption_Run (Requirements 6.1, 6.2).
 *
 * Presentational only: it takes the Member_Outcomes it is handed and renders
 * them. It fetches nothing and calls no server function, so the redemption page
 * (task 14.5) can feed it either the `outcomes` of a `RedemptionRunResult` or
 * the partial list of an `ActiveRunSnapshot`, and a test can render it with
 * `@testing-library/react` alone — no router, no query client.
 *
 * ## One row per Member_Outcome, in the order given
 *
 * Requirement 6.1 asks for one row for every enabled Group_Member of the run,
 * `SKIPPED` ones included, ordered by the processing order of that run. The
 * RunCoordinator already returns `outcomes` in processing order and backfills a
 * `SKIPPED` entry for every Group_Member it never reached, so this component
 * maps the array as received and never sorts, filters, or de-duplicates: a
 * reordering here would be a second, competing definition of "processing
 * order", and a filter would drop a row Requirement 6.1 demands.
 *
 * ## Why the message is a plain text child
 *
 * Requirement 6.2 wants the response message of an `UPSTREAM_ERROR` or
 * `TRANSPORT_ERROR` row shown as literal text, with every markup character
 * visible as a character. The documented `(H306)` body carries
 * `Invalid coupon code.<br/>Please check again.`, so this is not hypothetical.
 * Passing the string as a React text child is exactly that: React escapes it
 * into a text node, so `<br/>` reaches the page as the six characters `<br/>`
 * rather than a line break. Nothing here uses `dangerouslySetInnerHTML`, and
 * the `react/no-danger` ESLint rule enabled in task 1.3 keeps it that way.
 *
 * The message is truncated with `slice` at {@link MAX_DISPLAYED_MESSAGE_CHARS}.
 * `normalizeRetMsg` in the Response_Parser already caps every
 * `UpstreamResult.responseMessage` at the same 500 characters, so the slice is
 * normally a no-op — it is kept because Requirement 6.2 states the limit on
 * what the Web_Client *displays* independently of how the message was produced,
 * and this component is the only place that can hold that guarantee for a
 * message that reached it by some other path (a hand-built fixture, a future
 * parser change, a `run-failed` result assembled elsewhere).
 */

import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { MemberOutcome, MemberOutcomeValue } from "@/domain/types"

/** Requirement 6.2: the displayed message holds at most 500 characters. */
export const MAX_DISPLAYED_MESSAGE_CHARS = 500

/**
 * Stand-in for the message cell of a row that carries no message at all — a
 * `SUCCESS`, `ALREADY_USED`, `INVALID_COUPON`, or `SKIPPED` row — so the column
 * stays legible. Never substituted for a message-bearing row: Requirement 6.2
 * asks for the message of that row and nothing else, so an `UPSTREAM_ERROR`
 * whose message is the empty string renders an empty cell rather than this.
 */
const NO_MESSAGE = "\u2014"

/**
 * Accessible name of the table, carried by its `<caption>`. Exported so a test
 * can look the table up by name.
 */
export const RESULT_TABLE_CAPTION =
  "Redemption result per group member, in processing order"

/** The Badge variants this module uses, named so the map below is checked. */
type OutcomeBadgeVariant = "default" | "secondary" | "destructive" | "outline"

/**
 * Badge appearance per Member_Outcome value. Colour is decoration only: the
 * value itself is always rendered as text inside the badge, so the outcome of a
 * row is never conveyed by colour or by an icon alone.
 */
const OUTCOME_BADGE_VARIANT: Readonly<
  Record<MemberOutcomeValue, OutcomeBadgeVariant>
> = {
  SUCCESS: "default",
  ALREADY_USED: "secondary",
  INVALID_COUPON: "destructive",
  SKIPPED: "outline",
  UPSTREAM_ERROR: "destructive",
  TRANSPORT_ERROR: "destructive",
}

/**
 * Renders a Member_Outcome value as a badge holding the value as text. Shared
 * with `OutcomeSummary` so one outcome looks the same in a row and in the
 * summary, and `data-outcome` gives a test a hook that does not depend on which
 * of the two rendered the badge.
 */
export function OutcomeBadge({ outcome }: { outcome: MemberOutcomeValue }) {
  return (
    <Badge variant={OUTCOME_BADGE_VARIANT[outcome]} data-outcome={outcome}>
      {outcome}
    </Badge>
  )
}

/**
 * The message a row displays: the first {@link MAX_DISPLAYED_MESSAGE_CHARS}
 * characters of the Upstream_Result message for an `UPSTREAM_ERROR` or
 * `TRANSPORT_ERROR` outcome (Requirement 6.2), and null for every other
 * outcome, including `SKIPPED`, whose `upstreamResult` is null because no
 * Upstream_API request was issued.
 *
 * The two explicit comparisons are what narrow `MemberOutcome` away from its
 * `SKIPPED` variant, so `upstreamResult` is known to be present below.
 */
function displayedMessage(outcome: MemberOutcome): string | null {
  if (
    outcome.outcome !== "UPSTREAM_ERROR" &&
    outcome.outcome !== "TRANSPORT_ERROR"
  ) {
    return null
  }
  return outcome.upstreamResult.responseMessage.slice(
    0,
    MAX_DISPLAYED_MESSAGE_CHARS
  )
}

export interface RunResultTableProps {
  /**
   * The Member_Outcomes of the run, in the processing order the server
   * produced. Rendered as received: one row each, never sorted or filtered.
   */
  readonly outcomes: readonly MemberOutcome[]
  readonly className?: string
}

/** The per-Group_Member result rows of a Redemption_Run. */
export function RunResultTable({ outcomes, className }: RunResultTableProps) {
  return (
    <Table className={className}>
      {/* The caption is the accessible name of the table. */}
      <TableCaption>{RESULT_TABLE_CAPTION}</TableCaption>

      <TableHeader>
        <TableRow>
          <TableHead scope="col">Member</TableHead>
          <TableHead scope="col">Outcome</TableHead>
          <TableHead scope="col">Message</TableHead>
        </TableRow>
      </TableHeader>

      <TableBody>
        {outcomes.map((outcome) => {
          const message = displayedMessage(outcome)
          return (
            <TableRow key={`${outcome.position}-${outcome.hiveId}`}>
              {/* A row header, so screen readers announce which
               * Group_Member the outcome and message cells belong to. */}
              <TableHead scope="row" className="font-normal">
                {outcome.memberLabel}
              </TableHead>
              <TableCell>
                <OutcomeBadge outcome={outcome.outcome} />
              </TableCell>
              {/*
               * A React text child, never `dangerouslySetInnerHTML`: this is
               * what renders every markup character of the message as a
               * character (Requirement 6.2). `whitespace-pre-wrap` keeps a long
               * message readable without altering it — wrapping is a layout
               * concern, and no character is added, removed, or replaced.
               */}
              <TableCell className="max-w-prose break-words whitespace-pre-wrap">
                {message ?? NO_MESSAGE}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
