/**
 * The `/` document: the redemption page (Requirements 2.7, 2.9, 3.2, 6.4, 6.7,
 * 6.8, 7.4, 7.8).
 *
 * This is the composition point of tasks 14.1 to 14.4. Every pixel already
 * exists — {@link CouponForm}, {@link ConfirmRunDialog}, {@link RunProgress},
 * {@link RunResultTable}, {@link OutcomeSummary} — and each of those components
 * deferred its wiring here. What this module adds is exactly four things: the
 * Coupon_Code the Group_Member is typing, the run-state machine of
 * `runState.ts`, the calls to the three server functions a redemption needs, and
 * the Mock_Mode indicators Requirement 7.4 asks for.
 *
 * ## Two components, one seam
 *
 * {@link RedemptionPage} holds the whole page and takes its collaborators as
 * props: the roster, the Mock_Mode flag, and the three server functions. The
 * route `component` below binds the real ones. That seam is deliberate — task
 * 14.11 drives the streaming, the guards, the dialog, and the indicators with
 * stub collaborators and `@testing-library/react` alone, with no router, no
 * query client, and no live server, which is the same shape
 * `redemptionRequest.server.ts` uses for `runRedemptionEvents`.
 *
 * ## Why a route loader and not TanStack Query
 *
 * `@tanstack/react-query` is not a dependency of this repository and no
 * `QueryClient` is created anywhere, so `useQuery` is not reachable.
 * `src/routes/roster.tsx` and `src/routes/history.tsx` read through their route
 * loaders for the same reason, and task 16.1 confirmed that one mechanism across
 * all three data pages instead of introducing a second. The loader is also the
 * better fit here: the roster is needed for the first paint — the Requirement 2.4
 * guard and the Requirement 2.5 member list both read it — and a loader has it
 * before the page renders.
 *
 * ## Why `{ couponCode }` is the whole payload
 *
 * Requirement 3.2: the Web_Client sends the Coupon_Code and nothing else, and no
 * Hive_ID is ever part of the payload. The single call site below builds that
 * object literal inline, so there is one place where the payload is constructed
 * and it holds one key. The Hive_IDs the run needs never leave the server: the
 * coordinator reads them from the Member_Registry itself.
 *
 * ## Where each message is shown
 *
 * - A run that failed (Requirement 6.4): `runFailureMessage(runState)` is passed
 *   to `CouponForm`'s `errorMessage`, so the returned sentence appears directly
 *   under the field the Group_Member is still holding a Coupon_Code in, and the
 *   control is re-enabled by virtue of the machine having left `running`. The
 *   `<Toaster />` in the shell is deliberately *not* the primary surface: a toast
 *   auto-dismisses, and Requirement 6.4 gives no expiry for the notification,
 *   so the message would stop being visible while the failure is still current.
 * - `RedemptionRunResult.warnings` (Requirement 6.8): rendered in the result view,
 *   one alert each. The persistence warning of a failed Redemption_History append
 *   is a property of the completed run, not of the input field, so it belongs
 *   next to the Member_Outcomes it qualifies.
 * - A failed roster read: its own alert above the form, because without the
 *   roster neither the Requirement 2.4 guard nor the dialog's member list can be
 *   trusted.
 *
 * ## Mock_Mode (Requirements 7.4, 7.8)
 *
 * Two indicators, both suppressed entirely while Mock_Mode is disabled:
 *
 * - On the page: from the `mockMode` flag the root loader already read, taken
 *   from the root route's loader data rather than by calling `getAppConfig`
 *   again, so the flag is still read once per document.
 * - In the result view: from `RedemptionRunResult.mock`, the flag the
 *   Redemption_Server attached to *these* Member_Outcomes. That is strictly
 *   better than re-reading the page-level flag, because it states what actually
 *   produced the results being displayed rather than what the process was
 *   configured with when the page loaded.
 *
 * The shell also renders `MockModeBanner` app-wide. That banner is chrome for
 * every document; these two are the page-scoped statements Requirement 7.4 names
 * specifically, and the result one carries the server's own verdict, so neither
 * is a duplicate of the other's source of truth.
 */

import { useEffect, useReducer, useRef, useState } from "react"
import {
  createFileRoute,
  rootRouteId,
  useLoaderData,
} from "@tanstack/react-router"

import {
  ConfirmRunDialog,
  formatCompletedAt,
} from "@/components/ConfirmRunDialog"
import { CouponForm } from "@/components/CouponForm"
import { OutcomeSummary } from "@/components/OutcomeSummary"
import { RunProgress } from "@/components/RunProgress"
import { RunResultTable } from "@/components/RunResultTable"
import {
  INITIAL_RUN_STATE,
  isRunInProgress,
  runFailureMessage,
  runStateReducer,
} from "@/components/runState"
import {
  ROSTER_UNAVAILABLE_TITLE,
  StoreFailureNotice,
} from "@/components/StoreFailureNotice"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { findLatestRunForCoupon } from "@/functions/history.functions"
import { listMembers } from "@/functions/members.functions"
import { getActiveRun, runRedemption } from "@/functions/redemption.functions"
import type {
  ActiveRunSnapshot,
  Envelope,
  MemberRegistryEntry,
  RedemptionHistoryRecord,
  RedemptionRunResult,
  RunEvent,
} from "@/domain/types"

/**
 * The Mock_Mode statement shown on the page (Requirement 7.4). Its own sentence
 * rather than `MOCK_MODE_MESSAGE`, so the page-scoped statement and the shell's
 * app-wide banner stay separately addressable in a test.
 */
export const MOCK_MODE_PAGE_MESSAGE =
  "Mock mode is enabled, so redemption results come from mock data."

/**
 * The Mock_Mode statement shown in the result view (Requirement 7.4). Derived
 * from the `mock` flag of the result itself, so it describes the displayed
 * Member_Outcomes.
 */
export const MOCK_MODE_RESULT_MESSAGE =
  "These redemption results come from mock data. No request reached the coupon service."

/**
 * The message of a stream that ended without a terminal event — the connection
 * dropped, or the response was cut short. Requirement 6.4 asks for the message
 * the Redemption_Server returned; on this path it returned none, so the Web_Client
 * states what it observed instead of inventing a server verdict.
 */
export const STREAM_INTERRUPTED_MESSAGE =
  "The redemption run stopped reporting before it finished. Open the history page to check whether it completed."

/**
 * What the form's description says while the roster read is the thing that
 * failed (Requirement 2.14).
 *
 * A failed read hands this page zero entries, and the description that goes with
 * zero entries states that no Group_Member is enabled yet — which would be a claim
 * about the roster that the read never learned. So the two are told apart here for
 * the same reason the roster page tells them apart: an unreachable database must
 * not read as an empty roster. The store's own sentence is above, in
 * {@link StoreFailureNotice}; this is the line that would otherwise contradict it.
 */
export const ROSTER_UNREAD_DESCRIPTION =
  "The roster could not be read, so no redemption run can start."

/** Everything the document reads before any submission. */
interface RedemptionView {
  /** The Member_Registry in insertion order (Requirements 2.4, 2.5). */
  readonly entries: readonly MemberRegistryEntry[]
  /** A rejection from the roster read, or null. */
  readonly error: string | null
}

export const Route = createFileRoute("/")({
  /**
   * The one roster read of a document. Wrapped in `try`/`catch` because a call
   * can be rejected by the Access_Gate instead of returning an envelope, and a
   * thrown loader would replace the page with an error boundary rather than a
   * page that states what went wrong.
   */
  loader: async (): Promise<RedemptionView> => {
    try {
      const envelope = await listMembers()
      return envelope.ok
        ? { entries: envelope.data, error: null }
        : { entries: [], error: envelope.error.message }
    } catch (cause) {
      return {
        entries: [],
        error: cause instanceof Error ? cause.message : String(cause),
      }
    }
  },

  component: RedemptionRoute,
})

/* -------------------------------------------------------------------------- */
/* The page                                                                   */
/* -------------------------------------------------------------------------- */

/** The `runRedemption` payload, as this page builds it (Requirement 3.2). */
export interface RedemptionPayload {
  readonly couponCode: string
}

export interface RedemptionPageProps {
  /**
   * The Member_Registry in insertion order. Feeds the Requirement 2.4 guard and
   * the dialog's member list; passed to the dialog whole, which filters the
   * disabled entries out itself (Requirement 2.5).
   */
  readonly entries: readonly MemberRegistryEntry[]
  /** True while Mock_Mode is enabled (Requirements 7.4, 7.8). */
  readonly mockMode: boolean
  /** A rejection from the roster read, or null. */
  readonly loadError?: string | null
  /**
   * Starts a Redemption_Run and returns its event stream. Shaped exactly like
   * the `runRedemption` server function — one `data` object holding the
   * Coupon_Code and nothing else — so a test observes the real payload
   * (Requirement 3.2).
   */
  readonly startRun: (options: {
    readonly data: RedemptionPayload
  }) => Promise<AsyncIterable<RunEvent>>
  /**
   * The Redemption_Run in progress, if any. Read once on mount, so a reload or a
   * second tab shows a correct progress indicator and a disabled submission
   * control (Requirements 2.7, 2.9).
   */
  readonly readActiveRun: () => Promise<Envelope<ActiveRunSnapshot | null>>
  /**
   * The most recent Redemption_History record holding exactly the submitted
   * Coupon_Code, for the previously-used notice of Requirement 6.7. The
   * comparison stays on the server; this page only forwards the answer.
   */
  readonly findPreviousRun: (options: {
    readonly data: RedemptionPayload
  }) => Promise<Envelope<RedemptionHistoryRecord | null>>
}

/**
 * The redemption page: the Coupon_Code form, the confirmation dialog, the
 * progress indicator, and the result view.
 *
 * Exported and prop-driven so it can be driven without a router (task 14.11).
 */
export function RedemptionPage({
  entries,
  mockMode,
  loadError = null,
  startRun,
  readActiveRun,
  findPreviousRun,
}: RedemptionPageProps) {
  /**
   * The entered Coupon_Code. Owned here and never cleared by anything: that is
   * what makes "the entered value is retained" true by construction for a failed
   * length check (2.3), an empty enabled roster (2.4), a dismissed dialog (2.6),
   * a completed run (2.8), and a server error (6.4). The run-state machine has no
   * access to it.
   */
  const [couponCode, setCouponCode] = useState("")

  /** `idle → confirming → running → completed | failed`, from `runState.ts`. */
  const [runState, dispatch] = useReducer(runStateReducer, INITIAL_RUN_STATE)

  /**
   * The record behind the previously-used notice (Requirement 6.7), or null when
   * no Redemption_History record holds the submitted Coupon_Code.
   */
  const [previousRun, setPreviousRun] =
    useState<RedemptionHistoryRecord | null>(null)

  /**
   * Guards the mount read below. A ref rather than a dependency list, so a
   * caller that passes a fresh `readActiveRun` on every render still causes
   * exactly one read per mount.
   */
  const seedRequested = useRef(false)

  useEffect(() => {
    if (seedRequested.current) return
    seedRequested.current = true

    void (async () => {
      try {
        const envelope = await readActiveRun()
        /* No cancellation flag: the reducer honours a seed only from `idle`, so a
         * run started in this tab while the read was in flight is never
         * overwritten, and a dispatch after unmount is a no-op. */
        if (envelope.ok) {
          dispatch({ type: "seed", snapshot: envelope.data })
        }
      } catch {
        /* A rejected read means the page cannot tell whether a run is under way.
         * Staying idle is the honest reading: nothing is claimed, and a
         * submission would be rejected by the server's own single-run lock
         * (Requirement 3.9) rather than by a guess made here. */
      }
    })()
  }, [readActiveRun])

  /**
   * Requirement 6.7. Called as the dialog opens; the notice appears as soon as
   * the answer arrives. A rejected call leaves the notice out — it is advisory,
   * and a run must not be blocked because history could not be consulted.
   */
  async function loadPreviousRun(code: string): Promise<void> {
    try {
      const envelope = await findPreviousRun({ data: { couponCode: code } })
      setPreviousRun(envelope.ok ? envelope.data : null)
    } catch {
      setPreviousRun(null)
    }
  }

  /**
   * Consumes the `runRedemption` stream, feeding every event to the machine
   * (Requirement 2.7).
   *
   * A terminal event is what ends a run; a stream that ends without one, or a
   * call that is rejected outright, becomes `run-aborted`, so the submission
   * control is re-enabled on every path (Requirement 6.4).
   */
  async function consumeRun(code: string): Promise<void> {
    try {
      /* Requirement 3.2: the Coupon_Code is the only value in the payload. */
      const events = await startRun({ data: { couponCode: code } })

      let terminated = false
      for await (const event of events) {
        terminated =
          event.type === "run-completed" || event.type === "run-failed"
        dispatch({ type: "run-event", event })
      }

      if (!terminated) {
        dispatch({ type: "run-aborted", message: STREAM_INTERRUPTED_MESSAGE })
      }
    } catch (cause) {
      dispatch({
        type: "run-aborted",
        message: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }

  /** A submission that passed the form's own guards (Requirements 2.2, 2.5). */
  function handleSubmit(trimmedCouponCode: string): void {
    setPreviousRun(null)
    dispatch({ type: "request-confirmation", couponCode: trimmedCouponCode })
    void loadPreviousRun(trimmedCouponCode)
  }

  /** The dialog was confirmed: this is the only place a request is sent. */
  function handleConfirm(): void {
    /* Read the submitted value off the machine, not off the input: the input may
     * have been edited while the dialog was open, and the dialog listed the
     * members for the value it was opened with. */
    if (runState.status !== "confirming") return
    const submitted = runState.couponCode
    dispatch({ type: "confirm" })
    void consumeRun(submitted)
  }

  /** Requirement 2.6: back to idle, entered value untouched, nothing sent. */
  function handleDismiss(): void {
    dispatch({ type: "dismiss-confirmation" })
  }

  /* Requirements 2.7, 2.9: one source of the disabled state, and it is the
   * machine. */
  const runInProgress = isRunInProgress(runState)
  const hasEnabledMember = entries.some((entry) => entry.enabled)

  /**
   * The server-built result of the last run, whether it completed or failed. A
   * pre-flight rejection carries an empty outcome list — nothing was processed —
   * so the result view is shown only once there is at least one Member_Outcome
   * to report; the rejection message itself is on the form (Requirement 6.4).
   */
  const result: RedemptionRunResult | null =
    runState.status === "completed" || runState.status === "failed"
      ? runState.result
      : null
  const showResult = result !== null && result.outcomes.length > 0

  return (
    <main className="container mx-auto flex flex-col gap-6 p-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-medium">Redeem a coupon code</h1>
        <p className="text-sm text-muted-foreground">
          The code is redeemed once for every enabled group member, one after
          another, in roster order.
        </p>
        {/* Requirement 7.8: nothing at all while Mock_Mode is disabled. */}
        {mockMode ? (
          <p
            data-slot="mock-mode-page-indicator"
            className="text-sm text-muted-foreground"
          >
            {MOCK_MODE_PAGE_MESSAGE}
          </p>
        ) : null}
      </div>

      {/* Requirement 2.14. The store's own sentence, as a JSX child so every
       * character of it renders as a character. */}
      {loadError === null ? null : (
        <StoreFailureNotice
          title={ROSTER_UNAVAILABLE_TITLE}
          message={loadError}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Coupon code</CardTitle>
          <CardDescription>
            {/* Three states, not two: a roster with an enabled member, a roster
             * without one, and a roster this page never got to see. */}
            {loadError !== null
              ? ROSTER_UNREAD_DESCRIPTION
              : hasEnabledMember
                ? "A confirmation lists every enabled group member before anything is sent."
                : "No group member is enabled yet, so no redemption run can start."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <CouponForm
            value={couponCode}
            onValueChange={setCouponCode}
            onSubmit={handleSubmit}
            disabled={runInProgress}
            hasEnabledMember={hasEnabledMember}
            /* Requirement 6.4: the message the Redemption_Server returned. */
            errorMessage={runFailureMessage(runState)}
          />

          {/* Requirement 2.7. Rendered from the machine, which is fed by
           * `run-started` and `member-outcome` events and seeded from
           * `getActiveRun`, so a reloaded page shows a live counter. */}
          {runState.status === "running" ? (
            <RunProgress
              processed={runState.processed}
              total={runState.total}
              couponCode={runState.couponCode}
            />
          ) : null}
        </CardContent>
      </Card>

      {/* Mounted only while confirming, so the dialog always lists the members
       * for the value it was opened with (Requirements 2.5, 2.6, 6.7). */}
      {runState.status === "confirming" ? (
        <ConfirmRunDialog
          open
          couponCode={runState.couponCode}
          members={entries}
          previousRun={previousRun}
          onConfirm={handleConfirm}
          onDismiss={handleDismiss}
        />
      ) : null}

      {showResult ? (
        <Card data-slot="run-result">
          <CardHeader>
            <CardTitle>Redemption result</CardTitle>
            <CardDescription>
              Coupon code{" "}
              <code className="font-mono break-all">{result.couponCode}</code>,
              completed at{" "}
              <time dateTime={result.completedAt}>
                {formatCompletedAt(result.completedAt)}
              </time>
              .
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {/* Requirement 7.4, from the server's own flag for this result. */}
            {result.mock ? (
              <p
                data-slot="mock-mode-result-indicator"
                className="text-sm text-muted-foreground"
              >
                {MOCK_MODE_RESULT_MESSAGE}
              </p>
            ) : null}

            {/* Requirement 6.8: a failed Redemption_History append is stated
             * next to the Member_Outcomes it qualifies, verbatim. */}
            {result.warnings.map((warning) => (
              <Alert key={warning} data-slot="run-warning">
                <AlertDescription>{warning}</AlertDescription>
              </Alert>
            ))}

            {/* Requirement 6.3, from the counts the server reported. */}
            <OutcomeSummary counts={result.counts} />
            {/* Requirements 6.1, 6.2, in the server's processing order. */}
            <RunResultTable outcomes={result.outcomes} />
          </CardContent>
        </Card>
      ) : null}
    </main>
  )
}

/* -------------------------------------------------------------------------- */
/* The route component                                                        */
/* -------------------------------------------------------------------------- */

function RedemptionRoute() {
  const { entries, error } = Route.useLoaderData()

  /* The Mock_Mode flag the root loader already read (Requirements 7.4, 7.8). No
   * second `getAppConfig` call: the shell reads it once per document and this
   * page reads that same loader data. */
  const { mockMode } = useLoaderData({ from: rootRouteId })

  return (
    <RedemptionPage
      entries={entries}
      mockMode={mockMode}
      loadError={error}
      startRun={runRedemption}
      readActiveRun={getActiveRun}
      findPreviousRun={findLatestRunForCoupon}
    />
  )
}
