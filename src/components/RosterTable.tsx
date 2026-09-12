/**
 * The roster view: every Member_Registry entry with its Member_Label, its
 * Hive_ID, and its enabled state, an enable/disable switch, a confirmed removal
 * control, and the empty state (Requirements 1.4, 1.5, 1.8, 1.9, 1.10).
 *
 * ## Presentational only
 *
 * No data fetching, no server function import, no TanStack Query. Entries and
 * callbacks arrive as props, so `src/routes/roster.tsx` owns the wiring and this
 * component renders in a test with nothing but `@testing-library/react` — no
 * router, no live server.
 *
 * ## Order
 *
 * `entries` is rendered in the order it is given and is never sorted. The store
 * returns the Member_Registry in insertion order and `listMembers` passes it
 * through untouched, so array order *is* the order Requirement 1.4 asks for; a
 * sort here could only break it.
 *
 * ## Removal is confirmed, not immediate
 *
 * Requirement 1.5 acts on a *confirmed* removal, so the per-row control opens a
 * dialog and `onRemove` fires only from the dialog's confirm button. The dialog
 * is the shadcn/radix one, which traps focus, restores it to the trigger on
 * close, and closes on Escape, so the confirmation is reachable by keyboard
 * without any focus handling here.
 */

import { useState } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { MemberRegistryEntry } from "@/domain/types"

/**
 * The empty-roster message of Requirement 1.10: it states that the roster is
 * empty and instructs the Group_Member to add a Group_Member. Exported so a test
 * asserts this exact sentence.
 */
export const EMPTY_ROSTER_MESSAGE =
  "The roster is empty. Add a group member to redeem a coupon for them."

/** Visible enabled-state text of a row (Requirement 1.4). */
export const ENABLED_STATE_LABELS = {
  enabled: "Enabled",
  disabled: "Disabled",
} as const

export interface RosterTableProps {
  /** The Member_Registry, in the order the server returned it. Never sorted. */
  readonly entries: readonly MemberRegistryEntry[]
  /** Submits the new enabled state of one entry (Requirement 1.9). */
  readonly onSetEnabled: (id: string, enabled: boolean) => void
  /** Fires only after the Group_Member confirms the dialog (Requirement 1.5). */
  readonly onRemove: (id: string) => void
  /**
   * Id of the entry whose mutation is in flight, if any. That row's switch and
   * removal control are disabled so one click cannot be counted twice; every
   * other row stays usable.
   */
  readonly pendingMemberId?: string | null
  /** Rejection message of the last enable/disable or removal, if any. */
  readonly errorMessage?: string | null
  /** Persistence warning of the last successful write (Requirement 1.8). */
  readonly warningMessage?: string | null
}

/** The roster table, or the empty state when the Member_Registry holds nothing. */
export function RosterTable({
  entries,
  onSetEnabled,
  onRemove,
  pendingMemberId = null,
  errorMessage = null,
  warningMessage = null,
}: RosterTableProps) {
  return (
    <div className="flex flex-col gap-3">
      {/*
       * Both notices render the server's own sentence as text. Never as markup:
       * a message is server-supplied content, and the `react/no-danger` rule is
       * on repo-wide for exactly this reason.
       */}
      {errorMessage !== null ? (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      ) : null}

      {warningMessage !== null ? (
        <Alert role="status">
          <AlertDescription>{warningMessage}</AlertDescription>
        </Alert>
      ) : null}

      {entries.length === 0 ? (
        /* Requirement 1.10. `role="status"` so it is announced when the last
         * entry is removed and the table is replaced by this message. */
        <p role="status" className="text-sm text-muted-foreground">
          {EMPTY_ROSTER_MESSAGE}
        </p>
      ) : (
        <Table>
          <TableCaption>
            Group members, from the earliest added to the most recently added.
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Member</TableHead>
              <TableHead scope="col">Hive ID</TableHead>
              <TableHead scope="col">State</TableHead>
              <TableHead scope="col">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => (
              <RosterRow
                key={entry.id}
                entry={entry}
                pending={entry.id === pendingMemberId}
                onSetEnabled={onSetEnabled}
                onRemove={onRemove}
              />
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}

/** One Member_Registry entry (Requirements 1.4, 1.5, 1.9). */
function RosterRow({
  entry,
  pending,
  onSetEnabled,
  onRemove,
}: {
  readonly entry: MemberRegistryEntry
  readonly pending: boolean
  readonly onSetEnabled: (id: string, enabled: boolean) => void
  readonly onRemove: (id: string) => void
}) {
  return (
    <TableRow>
      <TableCell className="font-medium">{entry.memberLabel}</TableCell>
      {/* A Hive_ID may be long; let it wrap rather than widen the table. */}
      <TableCell className="font-mono text-xs break-all whitespace-normal">
        {entry.hiveId}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          {/*
           * The switch is a button, which `<label for>` cannot name, so the
           * accessible name is an `aria-label` that identifies the member. The
           * state itself is carried by the switch's own checked state and is
           * repeated as visible text for sighted readers (Requirement 1.4).
           */}
          <Switch
            checked={entry.enabled}
            disabled={pending}
            onCheckedChange={(enabled) => onSetEnabled(entry.id, enabled)}
            aria-label={`Enabled: ${entry.memberLabel}`}
          />
          <Badge variant={entry.enabled ? "secondary" : "outline"}>
            {entry.enabled
              ? ENABLED_STATE_LABELS.enabled
              : ENABLED_STATE_LABELS.disabled}
          </Badge>
        </div>
      </TableCell>
      <TableCell className="text-right">
        <RemoveMemberDialog
          entry={entry}
          pending={pending}
          onRemove={onRemove}
        />
      </TableCell>
    </TableRow>
  )
}

/**
 * The confirmed removal control of Requirement 1.5: a trigger that opens a
 * dialog, and a confirm button that is the only path to `onRemove`.
 *
 * Open state is local because it is pure view state of one row — the page has no
 * reason to know which confirmation is on screen. Confirming closes the dialog
 * before the mutation resolves; the row disappears when the parent's next
 * `entries` omits it, and if the removal is rejected the parent renders the
 * message and the row stays.
 */
function RemoveMemberDialog({
  entry,
  pending,
  onRemove,
}: {
  readonly entry: MemberRegistryEntry
  readonly pending: boolean
  readonly onRemove: (id: string) => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {/*
         * The visible text is just "Remove" — repeating the Member_Label in
         * every row would be noise next to the label in the first cell. The
         * accessible name carries it, so the control still identifies *which*
         * Group_Member it acts on out of context. It is an `aria-label` rather
         * than a visually hidden span because the name of a hidden span is
         * concatenated without a separator ("RemoveAna"), which is not the
         * sentence a screen reader should announce.
         */}
        <Button
          variant="destructive"
          size="sm"
          disabled={pending}
          aria-label={`Remove ${entry.memberLabel}`}
        >
          Remove
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove {entry.memberLabel}?</DialogTitle>
          <DialogDescription>
            {entry.memberLabel} is removed from the roster and is left out of
            every later redemption run. Past run results keep their recorded
            outcome.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => {
              setOpen(false)
              onRemove(entry.id)
            }}
          >
            Remove {entry.memberLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
