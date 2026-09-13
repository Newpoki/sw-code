/**
 * The `/roster` document: the Member_Registry, the add-a-member form, and the
 * per-entry enable/disable and removal controls
 * (Requirements 1.1, 1.4, 1.5, 1.9).
 *
 * Thin on purpose. Every pixel lives in
 * {@link RosterTable | `src/components/RosterTable.tsx`} and
 * {@link AddMemberForm | `src/components/AddMemberForm.tsx`}, both of which take
 * entries, callbacks, and messages as props. This module owns three things and
 * nothing else: reading the roster, calling the four member server functions,
 * and re-reading the roster after a write lands.
 *
 * ## Why a route loader and not TanStack Query
 *
 * The loader is the read and `router.invalidate()` is the invalidation. That is
 * the mechanism the design settled on for all three data pages — `/`, `/roster`,
 * and `/history` use it identically — and task 16.1 confirmed it rather than
 * replacing it.
 *
 * TanStack Query is not reachable here: `@tanstack/react-query` is not a
 * dependency of this repository (`@tanstack/react-router-ssr-query` is, but it
 * only *integrates* the two and declares react-query as a peer), and no
 * `QueryClient` is created or provided anywhere. Introducing it would mean adding
 * the dependency, mounting a provider in the shell, *and* calling
 * `setupRouterSsrQueryIntegration` in `src/router.tsx` — without that last step
 * a `useQuery` renders an empty first paint and refetches after hydration, which
 * is strictly worse than what the loader already does.
 *
 * The loader satisfies the *behaviour* the requirements ask for: each of the
 * three mutations below awaits the revalidation — `router.invalidate()` — only
 * after its envelope came back `ok`, so the roster is re-read after every
 * successful mutation and after no failed one, and the table always reflects
 * stored state (Requirement 1.4).
 *
 * ## Three states, not two
 *
 * The roster read is a round trip to a deployment that may not answer, so
 * `listMembers` can come back rejected. That is a third state and Requirement
 * 2.14 asks for it to be visibly its own: entries render as the table, zero
 * entries render the Requirement 1.10 empty-roster sentence, and a read that did
 * not complete renders the store's own sentence *in place of both*. So the read
 * failure travels to `RosterTable` as `readFailureMessage`, not as
 * `errorMessage`: `errorMessage` qualifies a write over a roster that *was* read
 * and leaves the rows on screen beside it, which is exactly the wrong shape for a
 * read that produced no rows. Conflating the two is what made "the database is
 * unreachable" render as "the roster is empty".
 *
 * ## Why nothing is sorted here
 *
 * `MemberRegistryStore.list` returns the Member_Registry in insertion order and
 * `listMembers` passes it through untouched, so the array *is* the order
 * Requirement 1.4 asks for. It reaches `RosterTable` exactly as the server sent
 * it.
 *
 * ## Where each message goes
 *
 * Server messages are passed through verbatim — a duplicate Hive_ID names the
 * conflicting Member_Label (Requirement 1.2), a full roster states the maximum of
 * 100 entries (Requirement 1.11), a validation rejection names the field and its
 * range (Requirement 1.3), a write that did not reach the database names the
 * attempted change and states that the roster is unchanged (Requirement 2.8), and
 * a read that did not complete states that the roster could not be read
 * (Requirement 2.14). This module composes no sentence of its own. A rejection
 * from `addMember` belongs to the form the Group_Member is still filling in, so
 * it goes to `AddMemberForm`; a rejection from the enable/disable switch or the
 * removal dialog belongs to the table, so it goes there.
 *
 * There is no applied-but-unsaved state left to warn about: Requirement 2.8
 * replaced it with a rejection, so a successful write is a write that is in the
 * database (Requirement 2.9) and the roster write envelopes below carry zero
 * warnings. `PERSISTENCE_WARNING` — the one message this path used to raise — is
 * gone (task 12.1). The `warnings` field is still read because `Envelope<T>`
 * still declares it, so `warnings[0]` is simply always absent here; the code
 * keeps reading it rather than assuming an emptiness the envelope type does not
 * guarantee.
 */

import { useState } from "react"
import { createFileRoute, useRouter } from "@tanstack/react-router"

import { AddMemberForm } from "@/components/AddMemberForm"
import { RosterTable } from "@/components/RosterTable"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  addMember,
  listMembers,
  removeMember,
  setMemberEnabled,
} from "@/functions/members.functions"
import type {
  AddMemberInput,
  RemoveMemberInput,
  SetMemberEnabledInput,
} from "@/domain/schemas"
import type {
  AppErrorCode,
  Envelope,
  MemberRegistryEntry,
} from "@/domain/types"
import type { RemovedMember } from "@/functions/members.functions"

/** A rejection as the envelope carries it, in the shape the form takes. */
interface EnvelopeError {
  readonly code: AppErrorCode
  readonly message: string
}

/** Everything the document renders before any mutation. */
interface RosterView {
  /** The Member_Registry in insertion order (Requirement 1.4). Never sorted. */
  readonly entries: readonly MemberRegistryEntry[]
  /** A rejection from the roster read, or null. */
  readonly error: string | null
}

export const Route = createFileRoute("/roster")({
  /**
   * The one roster read of a document, re-run by `router.invalidate()` after
   * every successful mutation.
   */
  loader: async (): Promise<RosterView> => {
    const envelope = await listMembers()
    return envelope.ok
      ? { entries: envelope.data, error: null }
      : { entries: [], error: envelope.error.message }
  },

  component: RosterRoute,
})

/* -------------------------------------------------------------------------- */
/* The page                                                                   */
/* -------------------------------------------------------------------------- */

export interface RosterPageProps {
  /** The Member_Registry in insertion order (Requirement 1.4). Never sorted. */
  readonly entries: readonly MemberRegistryEntry[]
  /**
   * The store's own sentence when the roster read did not complete, or null
   * (Requirement 2.14). Replaces the table and the empty state; it is never shown
   * beside either.
   */
  readonly loadError?: string | null
  /** Stores a new entry (Requirements 1.1, 1.2, 1.3, 1.11, 2.8). */
  readonly submitMember: (options: {
    readonly data: AddMemberInput
  }) => Promise<Envelope<MemberRegistryEntry>>
  /** Stores the submitted enabled state of an entry (Requirements 1.9, 2.8). */
  readonly submitEnabled: (options: {
    readonly data: SetMemberEnabledInput
  }) => Promise<Envelope<MemberRegistryEntry>>
  /** Deletes an entry (Requirements 1.5, 2.8). */
  readonly submitRemoval: (options: {
    readonly data: RemoveMemberInput
  }) => Promise<Envelope<RemovedMember>>
  /**
   * Re-runs the loader after a write landed — `router.invalidate()` in the route
   * below. Injected rather than reached for through `useRouter`, so the page
   * renders in a test with no router mounted, which is the same seam
   * `src/routes/index.tsx` uses for its three server functions.
   */
  readonly revalidate: () => Promise<void>
}

/**
 * The roster document: the table, the add-a-member form, and the messages of the
 * last read and the last write.
 *
 * Exported and prop-driven so it can be driven without a router or a live server.
 */
export function RosterPage({
  entries,
  loadError = null,
  submitMember,
  submitEnabled,
  submitRemoval,
  revalidate,
}: RosterPageProps) {
  /* The add form's own verdict: a rejection it can mark a field with, and any
   * warning the envelope of a write that landed carried. */
  const [addPending, setAddPending] = useState(false)
  const [addError, setAddError] = useState<EnvelopeError | null>(null)
  const [addWarning, setAddWarning] = useState<string | null>(null)

  /* The table's verdict: which row is mid-write, and the messages of the last
   * enable/disable or removal. */
  const [pendingMemberId, setPendingMemberId] = useState<string | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)
  const [rowWarning, setRowWarning] = useState<string | null>(null)

  /**
   * A call that never produced an envelope at all — the Session expired, or the
   * request never arrived. Kept apart from the envelope rejections because it
   * carries no {@link AppErrorCode}, and shown in the table because it belongs
   * to no single control.
   */
  const [requestFailure, setRequestFailure] = useState<string | null>(null)

  /**
   * Calls one server function, returning its envelope, or null when the call
   * itself failed. Without this a rejected call would be a silent no-op: the
   * control would go back to idle with nothing on screen.
   */
  async function call<T>(
    mutate: () => Promise<Envelope<T>>
  ): Promise<Envelope<T> | null> {
    setRequestFailure(null)
    try {
      return await mutate()
    } catch (cause) {
      setRequestFailure(cause instanceof Error ? cause.message : String(cause))
      return null
    }
  }

  /** Requirements 1.1, 1.2, 1.3, 1.11, 2.8. */
  async function handleAdd(input: AddMemberInput): Promise<boolean> {
    setAddPending(true)
    const envelope = await call(() => submitMember({ data: input }))
    setAddPending(false)

    if (envelope === null) {
      return false
    }
    if (!envelope.ok) {
      /* The entered values stay put so they can be corrected. */
      setAddError(envelope.error)
      setAddWarning(null)
      return false
    }

    setAddError(null)
    setAddWarning(envelope.warnings[0] ?? null)
    /* The stored entry is surfaced by re-reading the roster it now belongs to. */
    await revalidate()
    return true
  }

  /** Requirement 1.9. */
  async function handleSetEnabled(id: string, enabled: boolean): Promise<void> {
    setPendingMemberId(id)
    const envelope = await call(() => submitEnabled({ data: { id, enabled } }))
    setPendingMemberId(null)

    if (envelope === null) {
      return
    }
    if (!envelope.ok) {
      setRowError(envelope.error.message)
      setRowWarning(null)
      return
    }

    setRowError(null)
    setRowWarning(envelope.warnings[0] ?? null)
    await revalidate()
  }

  /** Requirement 1.5. Reached only from the confirmation dialog of the table. */
  async function handleRemove(id: string): Promise<void> {
    setPendingMemberId(id)
    const envelope = await call(() => submitRemoval({ data: { id } }))
    setPendingMemberId(null)

    if (envelope === null) {
      return
    }
    if (!envelope.ok) {
      setRowError(envelope.error.message)
      setRowWarning(null)
      return
    }

    setRowError(null)
    setRowWarning(envelope.warnings[0] ?? null)
    /* The entry disappears because the next read no longer holds it. */
    await revalidate()
  }

  return (
    <main className="container mx-auto flex flex-col gap-6 p-4">
      <div>
        <h1 className="text-lg font-medium">Group roster</h1>
        <p className="text-sm text-muted-foreground">
          Every enabled member receives the coupon of the next redemption run.
        </p>
      </div>

      <RosterTable
        entries={entries}
        onSetEnabled={(id, enabled) => {
          void handleSetEnabled(id, enabled)
        }}
        onRemove={(id) => {
          void handleRemove(id)
        }}
        pendingMemberId={pendingMemberId}
        /* Write-path messages only: they qualify a roster that was read, so the
         * rows stay on screen next to them. */
        errorMessage={rowError ?? requestFailure}
        warningMessage={rowWarning}
        /* Requirement 2.14: a read that produced nothing replaces the table and
         * the empty-roster sentence rather than sitting above either. */
        readFailureMessage={loadError}
      />

      <Card>
        <CardHeader>
          <CardTitle>Add a member</CardTitle>
          <CardDescription>
            A Hive ID may appear in the roster once.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AddMemberForm
            onSubmit={handleAdd}
            pending={addPending}
            error={addError}
            warningMessage={addWarning}
          />
        </CardContent>
      </Card>
    </main>
  )
}

/* -------------------------------------------------------------------------- */
/* The route component                                                        */
/* -------------------------------------------------------------------------- */

function RosterRoute() {
  const router = useRouter()
  const { entries, error } = Route.useLoaderData()

  return (
    <RosterPage
      entries={entries}
      loadError={error}
      submitMember={addMember}
      submitEnabled={setMemberEnabled}
      submitRemoval={removeMember}
      /* The loader is the read, so re-running it is the invalidation. Wrapped so
       * the page depends on "re-read the roster" rather than on the router. */
      revalidate={async () => {
        await router.invalidate()
      }}
    />
  )
}
