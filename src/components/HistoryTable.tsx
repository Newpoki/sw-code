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

import {
  HISTORY_UNAVAILABLE_TITLE,
  StoreFailureNotice,
} from "@/components/StoreFailureNotice"
import { Badge } from "@/components/ui/badge"
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { stripUpstreamMarkup } from "@/domain/upstreamMessage"
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

/** The Badge variants this module uses, named so the map below is checked. */
type OutcomeBadgeVariant = "default" | "warning" | "destructive"

/**
 * Badge appearance per Member_Outcome value: a success, something to notice, and
 * a failure.
 *
 * `ALREADY_USED` and `SKIPPED` share the warning variant because neither is a
 * failure — the first means the coupon was already spent on that account, the
 * second means the run stopped before reaching it — but neither is the outcome
 * the Group_Member wanted either. Everything left over is a failure.
 *
 * Written as a total map over `MemberOutcomeValue` rather than a `switch` with a
 * default, so adding a seventh outcome value is a type error here instead of
 * silently rendering as a failure.
 */
const OUTCOME_BADGE_VARIANT: Readonly<
  Record<MemberOutcomeValue, OutcomeBadgeVariant>
> = {
  SUCCESS: "default",
  ALREADY_USED: "warning",
  SKIPPED: "warning",
  INVALID_COUPON: "destructive",
  UPSTREAM_ERROR: "destructive",
  TRANSPORT_ERROR: "destructive",
}

/** Stand-in for a detail the upstream did not supply. */
const NO_VALUE = "—"

/**
 * The upstream message as the drawer shows it: tags removed, and the placeholder
 * when nothing is left to show.
 *
 * A message that held only markup — `<br/>` alone — strips to the empty string,
 * so the emptiness is decided *after* stripping rather than before. Checking the
 * raw length first would leave a blank line where a reader expects a dash.
 */
function displayedMessage(responseMessage: string): string {
  const stripped = stripUpstreamMarkup(responseMessage)
  return stripped.length > 0 ? stripped : NO_VALUE
}

/**
 * The three groups the summary column tallies, in reading order, each named by
 * the Badge variant that renders it.
 *
 * Derived from {@link OUTCOME_BADGE_VARIANT} rather than listed again, so the
 * grouping in the summary is by construction the grouping the detail badges use:
 * moving an outcome between colours is one edit in that map and both views
 * follow. `SKIPPED` counting as a warning alongside `ALREADY_USED` is that map's
 * decision, not a second opinion here.
 */
const SUMMARY_GROUPS = [
  { variant: "default", noun: "succeeded" },
  { variant: "warning", noun: "already used or skipped" },
  { variant: "destructive", noun: "failed" },
] as const satisfies ReadonlyArray<{
  readonly variant: OutcomeBadgeVariant
  readonly noun: string
}>

/** One tallied group of a record's Member_Outcomes. */
interface SummaryCount {
  readonly variant: OutcomeBadgeVariant
  readonly noun: string
  readonly count: number
  /** The outcome values that fell into this group, for the accessible name. */
  readonly outcomes: readonly MemberOutcomeValue[]
}

/**
 * Tallies a record's Member_Outcomes into the three summary groups, dropping any
 * group with no members.
 *
 * A zero is omitted rather than rendered: the summary exists to be read at a
 * glance down a column, and three badges per row where two of them say `0` is
 * noise. That is the opposite of the result view's `OutcomeSummary`, which must
 * show every zero because Requirement 6.3 asks for the count of each of the six
 * values — a different question for a different audience.
 */
export function summariseOutcomes(
  record: RedemptionHistoryRecord
): readonly SummaryCount[] {
  return SUMMARY_GROUPS.map(({ variant, noun }) => {
    const matching = record.outcomes.filter(
      (outcome) => OUTCOME_BADGE_VARIANT[outcome.outcome] === variant
    )
    return {
      variant,
      noun,
      count: matching.length,
      /* De-duplicated, so `TRANSPORT_ERROR` twice reads once. */
      outcomes: [...new Set(matching.map((outcome) => outcome.outcome))],
    }
  }).filter((group) => group.count > 0)
}

/** Visible text of the control that opens the detail drawer. */
export const OUTCOME_DETAILS_HINT = "View details"

/**
 * The accessible name of one row's detail control, so a screen-reader user
 * hears which run they are opening rather than a page of identical
 * "View details" buttons.
 */
export function outcomeDetailsLabel(record: RedemptionHistoryRecord): string {
  const count = record.outcomes.length
  const memberWord = count === 1 ? "group member" : "group members"
  return `View outcome details for ${record.couponCode}: ${count} ${memberWord}`
}

/** Heading of the detail drawer. */
export function outcomeDetailsTitle(record: RedemptionHistoryRecord): string {
  return `Outcomes for ${record.couponCode}`
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
})

/**
 * The completion **day** of a record.
 *
 * The hour, minute, and second are deliberately not shown: the column answers
 * "when was this coupon run", and to a day is the resolution a reader of a
 * redemption history acts on. The exact instant is not lost — the `<time>`
 * element keeps the stored ISO 8601 value in its `dateTime` attribute, so it
 * stays machine-readable and is one inspection away.
 *
 * Still *computed* in UTC even though the zone is no longer written out, because
 * that is what keeps the server and the browser producing the same string, so
 * hydration reports no mismatch. The consequence of dropping the label: for a run
 * completed late in the UTC evening, a reader east of UTC sees the previous day
 * from their point of view. The `dateTime` attribute remains exact.
 *
 * A value `Date` cannot parse is returned as stored: the stored characters are
 * more useful to a reader than the string `Invalid Date`, and this component is
 * a view, not a validator.
 */
export function formatCompletedAt(completedAt: string): string {
  const parsed = new Date(completedAt)
  if (Number.isNaN(parsed.getTime())) return completedAt
  return COMPLETED_AT_FORMAT.format(parsed)
}

export interface HistoryTableProps {
  /**
   * The retained Redemption_History records, already in the Requirement 6.6
   * order the server applied. Rendered as received, never sorted.
   */
  readonly records: readonly RedemptionHistoryRecord[]
  readonly className?: string
  /**
   * The store's own sentence when the Redemption_History read did not complete,
   * or null when it did (Requirement 3.10).
   *
   * A failed read withholds every partially read record, so there is nothing to
   * put in a table and nothing that justifies the Requirement 6.9 message either:
   * "no run has been recorded" is a statement about the collection, and a read
   * that failed learned nothing about the collection.
   */
  readonly readFailureMessage?: string | null
}

/**
 * The retained Redemption_History records, the Requirement 6.9 message when there
 * is no record to show, or the store's sentence when the read did not complete.
 */
export function HistoryTable({
  records,
  className,
  readFailureMessage = null,
}: HistoryTableProps) {
  if (readFailureMessage !== null) {
    /* Requirement 3.10, in place of the table and in place of the empty state. */
    return (
      <StoreFailureNotice
        title={HISTORY_UNAVAILABLE_TITLE}
        message={readFailureMessage}
      />
    )
  }

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
      {/*
       * The Coupon_Code names the row, so it is a row header.
       *
       * Kept on one line: a Coupon_Code is a single opaque token, and breaking it
       * mid-string invites a reader to transcribe it wrongly. `whitespace-nowrap`
       * is what `TableHead` already applies, restated here because this cell
       * previously overrode it with `whitespace-normal break-all` — so the intent
       * is explicit rather than inherited. `break-all` is dropped with it: under
       * `white-space: nowrap` there are no soft-wrap opportunities for it to act
       * on, so keeping both would only mislead.
       *
       * A 64-character code is wider than a narrow viewport. That is contained,
       * not ignored: `Table` renders inside `overflow-x-auto`, so the table
       * scrolls horizontally instead of the page layout breaking.
       */}
      <TableHead
        scope="row"
        className="font-mono font-normal whitespace-nowrap"
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
        <OutcomeDetailsDrawer record={record} />
      </TableCell>
    </TableRow>
  )
}

/**
 * The Member_Outcomes of one record: a compact badge summary that opens a drawer
 * holding the full detail.
 *
 * ## Why the summary is a button and not a clickable cell
 *
 * An `onClick` on the `<td>` would be unreachable by keyboard and would announce
 * nothing to a screen reader. The whole summary is therefore a real `<button>`,
 * which brings focus, `Enter`/`Space`, and a role for free.
 *
 * That constrains the markup: a button may only contain phrasing content, so the
 * summary is a row of `<span>` badges rather than the `<ul>` it used to be. The
 * list did carry useful semantics, so it is not lost — it moves into the drawer,
 * where the detail lives and where nesting it is valid.
 *
 * ## Why there is no `aria-label` on the trigger
 *
 * An `aria-label` would *replace* the button's accessible name, which would throw
 * away the per-Group_Member outcome text inside it and leave the badge colour as
 * the only carrier of the outcome. Instead the action is stated in a leading
 * `sr-only` span and the visible "View details" hint is `aria-hidden`, so the
 * computed name reads as the action followed by every Member_Label and its
 * outcome — the guarantee that no outcome is conveyed by colour alone survives.
 */
function OutcomeDetailsDrawer({
  record,
}: {
  readonly record: RedemptionHistoryRecord
}) {
  return (
    <Drawer>
      <DrawerTrigger asChild>
        <button
          type="button"
          className="flex w-full flex-wrap items-center gap-1 rounded-md text-left outline-none hover:opacity-80 focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <span className="sr-only">{outcomeDetailsLabel(record)}</span>
          {/*
           * One badge per group rather than per Group_Member: a run over a large
           * roster used to render up to 100 badges in a table cell, which is not
           * a summary. The per-Group_Member breakdown is in the drawer.
           */}
          {summariseOutcomes(record).map((group) => (
            <Badge
              key={group.variant}
              variant={group.variant}
              data-summary={group.variant}
              className="tabular-nums"
            >
              {group.count}
              {/*
               * The count alone would leave colour as the only carrier of *what*
               * was counted. The noun is in the accessible name instead of on
               * screen, so the cell stays a glanceable number and the outcome is
               * still stated for assistive technology.
               */}
              <span className="sr-only"> {group.noun}</span>
            </Badge>
          ))}
          {/* Hidden from the name computation above, which already states the
           * action; this is the visible affordance for a sighted reader. */}
          <span
            aria-hidden="true"
            className="text-xs text-muted-foreground underline"
          >
            {OUTCOME_DETAILS_HINT}
          </span>
        </button>
      </DrawerTrigger>

      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle className="font-mono break-all">
            {outcomeDetailsTitle(record)}
          </DrawerTitle>
          <DrawerDescription>
            <time dateTime={record.completedAt}>
              {formatCompletedAt(record.completedAt)}
            </time>
            {" · "}
            {record.mock ? SOURCE_LABELS.mock : SOURCE_LABELS.live}
            {record.stoppedEarly ? ` · ${STOPPED_EARLY_LABEL}` : ""}
          </DrawerDescription>
        </DrawerHeader>

        <DrawerBody>
          <ul className="flex flex-col gap-4">
            {record.outcomes.map((outcome) => (
              <li
                key={outcome.hiveId}
                className="flex min-w-0 flex-col gap-1 border-b pb-4 last:border-b-0 last:pb-0"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 font-medium break-words">
                    {outcome.memberLabel}
                  </span>
                  {/* The same variant the summary badge uses, so an outcome keeps
                   * one colour across both views. */}
                  <Badge
                    variant={OUTCOME_BADGE_VARIANT[outcome.outcome]}
                    data-outcome={outcome.outcome}
                    className="h-auto break-words whitespace-normal"
                  >
                    {outcome.outcome}
                  </Badge>
                  <span className="font-mono text-xs text-muted-foreground">
                    {outcome.responseCode.length > 0
                      ? outcome.responseCode
                      : NO_VALUE}
                  </span>
                </div>

                {/*
                 * The upstream message, below its outcome, with HTML tags removed
                 * by `stripUpstreamMarkup` — the upstream sends `<br/>` inside
                 * `retMsg` and a reader should not have to see it.
                 *
                 * Still a JSX child and never `dangerouslySetInnerHTML`, so the
                 * injection defence is unchanged: a tag is deleted, never
                 * interpreted (Requirement 6.2). `whitespace-pre-wrap` is what
                 * turns the newline a `<br>` became into the line break the
                 * upstream meant.
                 */}
                <p className="text-xs break-words whitespace-pre-wrap text-muted-foreground">
                  {displayedMessage(outcome.responseMessage)}
                </p>
              </li>
            ))}
          </ul>
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  )
}
