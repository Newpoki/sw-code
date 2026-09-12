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
 * three mutations below awaits `router.invalidate()` only after its envelope came
 * back `ok`, so the roster is re-read after every successful mutation and after
 * no failed one, and the table always reflects stored state (Requirement 1.4).
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
 * range (Requirement 1.3), and a failed flush carries `PERSISTENCE_WARNING`
 * (Requirement 1.8). This module composes no sentence of its own. A rejection
 * from `addMember` belongs to the form the Group_Member is still filling in, so
 * it goes to `AddMemberForm`; a rejection from the enable/disable switch or the
 * removal dialog belongs to the table, so it goes there.
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
import type { AddMemberInput } from "@/domain/schemas"
import type {
  AppErrorCode,
  Envelope,
  MemberRegistryEntry,
} from "@/domain/types"

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

  component: RosterPage,
})

function RosterPage() {
  const router = useRouter()
  const { entries, error: loadError } = Route.useLoaderData()

  /* The add form's own verdict: a rejection it can mark a field with, and the
   * persistence warning of a write that landed. */
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

  /** Requirements 1.1, 1.2, 1.3, 1.8, 1.11. */
  async function handleAdd(input: AddMemberInput): Promise<boolean> {
    setAddPending(true)
    const envelope = await call(() => addMember({ data: input }))
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
    await router.invalidate()
    return true
  }

  /** Requirement 1.9. */
  async function handleSetEnabled(id: string, enabled: boolean): Promise<void> {
    setPendingMemberId(id)
    const envelope = await call(() =>
      setMemberEnabled({ data: { id, enabled } })
    )
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
    await router.invalidate()
  }

  /** Requirement 1.5. Reached only from the confirmation dialog of the table. */
  async function handleRemove(id: string): Promise<void> {
    setPendingMemberId(id)
    const envelope = await call(() => removeMember({ data: { id } }))
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
    await router.invalidate()
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
        errorMessage={rowError ?? requestFailure ?? loadError}
        warningMessage={rowWarning}
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
