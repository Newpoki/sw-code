/**
 * The Redemption_History view: one row per retained record, or the empty-state
 * message (Requirements 6.6, 6.9).
 *
 * ## Presentational only
 *
 * Records arrive as a prop. This module imports no server function, opens no
 * query, and reads nothing from the router, so `src/routes/history.tsx` owns the
 * fetching and task 15.2 renders this component with nothing but
 * `@testing-library/react`.
 *
 * ## Why nothing is sorted here
 *
 * Requirement 6.6 orders the records by completion timestamp descending, and
 * among records sharing a completion timestamp from the most recently appended
 * to the least recently appended. `HistoryStore.list` already applies exactly
 * that — it has the monotonic `seq` to break ties with — and
 * `listHistory` documents that it adds no comparator of its own. So `records` is
 * rendered in the order it was handed over. A client-side re-sort would be a
 * second statement of the same rule, free to drift from the first, and it would
 * re-derive a tie-break the server can read directly.
 *
 * ## Why the upstream message is a plain text child
 *
 * A stored `responseMessage` may hold markup: the documented `(H306)` body is
 * `Invalid coupon code.<br/>Please check again.`. Every message below is passed
 * as a JSX child, which React escapes into a text node, so those characters
 * reach the page as characters rather than as a line break (Requirement 6.2).
 * Nothing here uses `dangerouslySetInnerHTML`, and the repo-wide
 * `react/no-danger` ESLint rule keeps it that way.
 *
 * ## Why the timestamp is formatted in UTC
 *
 * `toLocaleString()` with no arguments resolves the locale and the time zone of
 * whichever runtime calls it, so the server and the browser would render two
 * different strings for one record and hydration would report a mismatch.
 * {@link formatCompletedAt} pins both, and the exact stored value stays
 * machine-readable in the `dateTime` attribute of the `<time>` element.
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
import type {
  MemberOutcomeValue,
  RedemptionHistoryRecord,
} from "@/domain/types"

/**
 * The message Requirement 6.9 asks for: it states that no Redemption_Run has
 * been recorded. Exported so a test asserts this exact sentence rather than a
 * paraphrase of it.
 */
export const EMPTY_HISTORY_MESSAGE =
  "No redemption run has been recorded yet. Redeem a coupon and its outcomes appear here."

/**
 * Accessible name of the table, carried by its `<caption>`. It states the order
 * of the rows, which is the one thing a reader cannot infer from a single row.
 */
export const HISTORY_TABLE_CAPTION =
  "Recorded redemption runs, from the most recent completion to the oldest."

/** Visible marks of a record's data source (Requirement 7.9). */
export const SOURCE_LABELS = {
  mock: "Mock data",
  live: "Live",
} as const

/** Visible note on a record whose Redemption_Run ended early. */
export const STOPPED_EARLY_LABEL = "Stopped early"

/** Stand-in for a cell whose value is an empty string, so the column stays legible. */
const NO_VALUE = "—"

/** The Badge variants this module uses, named so the map below is checked. */
type OutcomeBadgeVariant = "default" | "secondary" | "destructive" | "outline"

/**
 * Badge appearance per Member_Outcome value. Colour is decoration only: every
 * outcome is also rendered as text, so no row conveys its outcome by colour
 * alone.
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
 * Fixed formatter: the same output on the server and in the browser, so the
 * markup the loader produced is the markup the client hydrates.
 */
const COMPLETED_AT_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
})

/**
 * The human-readable completion timestamp of a record.
 *
 * A value `Date` cannot parse is returned as stored: the stored characters are
 * more useful to a reader than the string `Invalid Date`, and this component is
 * a view, not a validator.
 */
export function formatCompletedAt(completedAt: string): string {
  const parsed = new Date(completedAt)
  if (Number.isNaN(parsed.getTime())) return completedAt
  return `${COMPLETED_AT_FORMAT.format(parsed)} UTC`
}

export interface HistoryTableProps {
  /**
   * The retained Redemption_History records, already in the Requirement 6.6
   * order the server applied. Rendered as received, never sorted.
   */
  readonly records: readonly RedemptionHistoryRecord[]
  readonly className?: string
}

/**
 * The retained Redemption_History records, or the Requirement 6.9 message when
 * there is no record to show.
 */
export function HistoryTable({ records, className }: HistoryTableProps) {
  if (records.length === 0) {
    /*
     * Requirement 6.9. `role="status"` so the message is announced when the
     * table it replaces disappears, e.g. after a re-read that returns nothing.
     */
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {EMPTY_HISTORY_MESSAGE}
      </p>
    )
  }

  return (
    <Table className={className}>
      <TableCaption>{HISTORY_TABLE_CAPTION}</TableCaption>

      <TableHeader>
        <TableRow>
          <TableHead scope="col">Coupon code</TableHead>
          <TableHead scope="col">Completed</TableHead>
          <TableHead scope="col">Source</TableHead>
          <TableHead scope="col">Member outcomes</TableHead>
        </TableRow>
      </TableHeader>

      <TableBody>
        {/*
         * Keyed by `runId`: it identifies one Redemption_Run, so it is unique
         * across the retained window even when two records share a completion
         * timestamp.
         */}
        {records.map((record) => (
          <HistoryRow key={record.runId} record={record} />
        ))}
      </TableBody>
    </Table>
  )
}

/** One retained Redemption_History record. */
function HistoryRow({ record }: { readonly record: RedemptionHistoryRecord }) {
  return (
    <TableRow>
      {/* The Coupon_Code names the row, so it is a row header. */}
      <TableHead
        scope="row"
        className="font-mono font-normal break-all whitespace-normal"
      >
        {record.couponCode}
      </TableHead>

      <TableCell className="align-top">
        {/* Readable text, exact stored value in `dateTime`. */}
        <time dateTime={record.completedAt}>
          {formatCompletedAt(record.completedAt)}
        </time>
      </TableCell>

      <TableCell className="align-top">
        <div className="flex flex-col items-start gap-1">
          {/*
           * The Requirement 7.9 flag of this record: whether its outcomes came
           * from the mock fixtures or from the coupon service. It describes one
           * past run, not the current Mock_Mode state, which the shell banner
           * owns.
           */}
          <Badge variant={record.mock ? "secondary" : "outline"}>
            {record.mock ? SOURCE_LABELS.mock : SOURCE_LABELS.live}
          </Badge>
          {record.stoppedEarly ? (
            <span className="text-xs text-muted-foreground">
              {STOPPED_EARLY_LABEL}
            </span>
          ) : null}
        </div>
      </TableCell>

      <TableCell className="align-top whitespace-normal">
        {/*
         * A list rather than a nested table: a stored outcome carries four
         * short values, and one flat table per record keeps the whole page a
         * single grid for keyboard and screen-reader navigation.
         */}
        <ul className="flex flex-col gap-1">
          {record.outcomes.map((outcome) => (
            /*
             * Keyed by Hive_ID: it is unique in the Member_Registry, so a
             * Redemption_Run holds at most one outcome per Hive_ID, and a stored
             * record is only ever rendered, never reordered.
             */
            <li
              key={outcome.hiveId}
              className="flex flex-wrap items-baseline gap-x-2 gap-y-1"
            >
              <span className="font-medium">{outcome.memberLabel}</span>
              <Badge variant={OUTCOME_BADGE_VARIANT[outcome.outcome]}>
                {outcome.outcome}
              </Badge>
              <span className="font-mono text-xs text-muted-foreground">
                {outcome.responseCode.length > 0
                  ? outcome.responseCode
                  : NO_VALUE}
              </span>
              {/*
               * The upstream message as a JSX child, never
               * `dangerouslySetInnerHTML`: this is what renders every markup
               * character it holds as a visible character (Requirement 6.2).
               * `whitespace-pre-wrap` only wraps the text; no character is
               * added, removed, or replaced.
               */}
              {outcome.responseMessage.length > 0 ? (
                <span className="max-w-prose text-xs break-words whitespace-pre-wrap text-muted-foreground">
                  {outcome.responseMessage}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </TableCell>
    </TableRow>
  )
}
