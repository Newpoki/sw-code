/**
 * The `/history` document: the retained Redemption_History records
 * (Requirements 6.6, 6.9).
 *
 * Thin on purpose. Everything visual lives in
 * {@link HistoryTable | `src/components/HistoryTable.tsx`}, which takes the
 * records as a prop, so the view is testable with `@testing-library/react`
 * alone — no router, no query client. This module only reads the records and
 * reports a rejection.
 *
 * ## Why a route loader and not TanStack Query
 *
 * The route `loader` is the read and `router.invalidate()` is the invalidation,
 * the same mechanism `/` and `/roster` use, and the one the design settled on for
 * every data page. `@tanstack/react-query` is not a dependency of this repository
 * and no `QueryClient` is created or provided anywhere, so `useQuery` is not
 * reachable; the loader is a complete answer for a read-only page anyway — it
 * runs on the server during SSR, so the first paint already holds the records,
 * with no post-hydration refetch. If a client cache is ever introduced, swapping
 * this loader for a query over the same server function is a local change:
 * `HistoryTable` does not care where the array came from.
 *
 * ## Why nothing is sorted here
 *
 * `HistoryStore.list` already applies the Requirement 6.6 ordering, and
 * `listHistory` adds no comparator of its own, so the records reach
 * `HistoryTable` untouched and are rendered in the order the server chose.
 *
 * ## Three states, not two
 *
 * The store read is a round trip to a deployment that may not answer, so
 * `listHistory` can come back rejected. That is a third state, and Requirement
 * 3.10 asks for it to be visibly its own: records render as the table, zero
 * records render as the Requirement 6.9 empty-state sentence, and a read that did
 * not complete renders the store's own sentence *in place of both*. The failed
 * read is handed to `HistoryTable` rather than shown beside it, so there is one
 * component deciding which of the three is on screen and the empty state cannot
 * appear next to a failure.
 */

import { createFileRoute } from "@tanstack/react-router"

import { HistoryTable } from "@/components/HistoryTable"
import { listHistory } from "@/functions/history.functions"
import type { RedemptionHistoryRecord } from "@/domain/types"

/** Everything the document renders. */
interface HistoryView {
  /** The retained records, already in Requirement 6.6 order. */
  readonly records: readonly RedemptionHistoryRecord[]
  /** A rejection message from the server, or null. */
  readonly error: string | null
}

export const Route = createFileRoute("/history")({
  /**
   * The one history read of a document. `listHistory` is callable with no
   * argument, which means "every retained record": the retention window is 200,
   * so no paging is needed to show the whole history.
   */
  loader: async (): Promise<HistoryView> => {
    const envelope = await listHistory()
    return envelope.ok
      ? { records: envelope.data, error: null }
      : { records: [], error: envelope.error.message }
  },

  component: HistoryRoute,
})

export interface HistoryPageProps {
  /** The retained records, already in Requirement 6.6 order. */
  readonly records: readonly RedemptionHistoryRecord[]
  /**
   * The store's own sentence when the read did not complete, or null
   * (Requirement 3.10).
   */
  readonly loadError?: string | null
}

/**
 * The history document.
 *
 * Exported and prop-driven, the same seam `src/routes/index.tsx` uses for
 * {@link import("@/routes/index").RedemptionPage}, so the three-state rendering
 * of Requirement 3.10 is testable with `@testing-library/react` alone — no
 * router, no loader, no live server.
 */
export function HistoryPage({ records, loadError = null }: HistoryPageProps) {
  return (
    <main className="container mx-auto flex flex-col gap-4 p-4">
      <div>
        <h1 className="text-lg font-medium">Redemption history</h1>
        <p className="text-sm text-muted-foreground">
          Recorded redemption runs, most recent first.
        </p>
      </div>

      {/*
       * Records, the empty state, or the store's sentence — `HistoryTable` picks
       * one of the three. The sentence is passed as a JSX child down there, so
       * every character of it renders as a character (Requirement 6.2).
       */}
      <HistoryTable records={records} readFailureMessage={loadError} />
    </main>
  )
}

function HistoryRoute() {
  const { records, error } = Route.useLoaderData()

  return <HistoryPage records={records} loadError={error} />
}
