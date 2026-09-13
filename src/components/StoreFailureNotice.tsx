/**
 * The one way a read that did not complete is stated on a data page
 * (Requirements 2.14, 3.10).
 *
 * ## Why this is its own component
 *
 * A failed read and an empty read used to look the same: both left the page with
 * zero rows, so "the database is unreachable" rendered as "the roster is empty".
 * Requirements 2.14 and 3.10 forbid that conflation, which means every data page
 * has to distinguish three states — rows, no rows, and no answer — and the third
 * one needs a surface of its own. Three routes need it (`/`, `/roster`,
 * `/history`), so it lives here rather than as the same markup pasted three
 * times.
 *
 * ## Nothing here composes a sentence
 *
 * `message` is the fixed sentence the Mongo_Store already chose from
 * `src/domain/storeMessages.ts` — the roster could not be read, the
 * Redemption_History could not be read, no database is configured, the database
 * is unreachable — carried through the envelope verbatim. This component
 * interpolates nothing into it and truncates nothing off it, and it renders it as
 * a JSX child, so every character of it reaches the page as a character and never
 * as markup.
 *
 * The `title` is page chrome: it names *which* read failed, which the store's
 * sentence for an unconfigured or unreachable deployment does not say, because
 * that failure is not specific to one collection.
 */

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

/** Heading of a failed Member_Registry read (Requirement 2.14). */
export const ROSTER_UNAVAILABLE_TITLE = "Roster unavailable"

/** Heading of a failed Redemption_History read (Requirement 3.10). */
export const HISTORY_UNAVAILABLE_TITLE = "History unavailable"

export interface StoreFailureNoticeProps {
  /** Which read did not complete. Page chrome, not a store sentence. */
  readonly title: string
  /** The store's own fixed sentence, rendered verbatim. */
  readonly message: string
}

/**
 * States that a read did not complete, in the position the rows would have
 * occupied.
 *
 * `data-slot` is overridden so a test can address this notice without matching on
 * the sentence, the way `src/routes/index.tsx` already addresses its run
 * warnings.
 */
export function StoreFailureNotice({
  title,
  message,
}: StoreFailureNoticeProps) {
  return (
    <Alert variant="destructive" data-slot="store-read-failure">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}
