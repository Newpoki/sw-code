/**
 * The run-state machine of the redemption page (Requirements 2.7, 2.8, 2.9,
 * 6.4).
 *
 * `idle → confirming → running → completed | failed`, exactly as the design's
 * Web_Client composition states, driven by a `useReducer` in
 * `src/routes/index.tsx` (task 14.5) and fed by the {@link RunEvent} stream of
 * `runRedemption`.
 *
 * ## Why the machine is its own module and why it is pure
 *
 * The submission control is disabled for the whole `running` state, which makes
 * the machine the single source of that disabled state (task 16.1): Requirement
 * 2.9 — "activating the submission control while a Redemption_Run is in progress
 * withholds the request and keeps the progress indicator displayed" — then holds
 * because no state other than `running` exists in which a run is in progress,
 * instead of holding because some boolean happened to be set correctly at every
 * assignment site.
 *
 * Nothing here fetches, subscribes, or reads a clock. {@link runStateReducer} is
 * a total function of `(state, action)`, so task 14.6 drives the whole transition
 * table — including event orders a real server would never produce — without a
 * router, a query client, or a live server.
 *
 * ## What the machine does *not* hold
 *
 * The Coupon_Code *in the input field* is not part of this state. Requirements
 * 2.3, 2.6, 2.8, and 6.4 all say the entered value is retained across events the
 * machine reacts to, and the cheapest way to guarantee that is for the machine to
 * have no way of clearing it: the page owns the input value as its own `useState`
 * and this reducer never sees it. The `couponCode` the `confirming` and `running`
 * states do carry is the *submitted* value — trimmed with its letter case
 * preserved (Requirement 2.2) — which the confirmation dialog and the progress
 * indicator display.
 *
 * ## Ignored actions are a feature
 *
 * Every transition that is not part of the table above returns the state
 * unchanged rather than throwing. Two of them are load-bearing:
 *   - `request-confirmation` while `running` is ignored, which is Requirement 2.9
 *     for the one submission path a disabled button cannot block — `Enter` in the
 *     input field.
 *   - `seed` is honoured only from `idle`, so the `getActiveRun` read that arrives
 *     shortly after mount can never overwrite a run this tab started in the
 *     meantime.
 */

import type {
  ActiveRunSnapshot,
  MemberOutcome,
  RedemptionRunResult,
  RunEvent,
} from "@/domain/types"

/** The five states of the machine. */
export type RunState =
  /** No Redemption_Run is in progress and none has completed in this tab. */
  | { readonly status: "idle" }
  /**
   * The confirmation dialog is open for {@link couponCode} and nothing has been
   * sent yet (Requirement 2.5).
   */
  | {
      readonly status: "confirming"
      /** The submitted value, already trimmed with its letter case preserved. */
      readonly couponCode: string
    }
  /**
   * A Redemption_Run is in progress: the request is in flight or its events are
   * arriving. The submission control is disabled for this whole state
   * (Requirements 2.7, 2.9).
   */
  | {
      readonly status: "running"
      /**
       * The `runId` of the run, or `""` until `run-started` arrives — the state is
       * entered when the request is sent, which is before the server has named the
       * run.
       */
      readonly runId: string
      readonly couponCode: string
      /**
       * Size of the fixed list, or `0` until `run-started` arrives.
       * `RunProgress` renders `total === 0` as an indeterminate bar, which is
       * exactly the "size not known yet" case.
       */
      readonly total: number
      /** Member_Outcomes recorded so far. */
      readonly processed: number
      /** The recorded Member_Outcomes, in processing order. */
      readonly outcomes: readonly MemberOutcome[]
      /** Whether the run is served by Mock_Mode fixtures (Requirements 7.4, 7.8). */
      readonly mock: boolean
    }
  /**
   * The run delivered its complete result set. The submission control is
   * re-enabled and the entered Coupon_Code is still in the input, because the
   * page never cleared it (Requirement 2.8).
   */
  | { readonly status: "completed"; readonly result: RedemptionRunResult }
  /**
   * The run did not deliver Member_Outcomes, or delivered them alongside a
   * failure. {@link message} is the message the Redemption_Server returned and is
   * what the error notification of Requirement 6.4 holds; the control is
   * re-enabled by virtue of leaving `running`.
   */
  | {
      readonly status: "failed"
      readonly message: string
      /**
       * The complete result set of the terminal `run-failed` event — still one
       * Member_Outcome per Group_Member of the fixed list, empty for a pre-flight
       * rejection. `null` when the stream itself broke before any terminal event
       * arrived, in which case there is no server-built result to show.
       */
      readonly result: RedemptionRunResult | null
    }

/**
 * The `running` variant on its own, for the helpers and for a page that has
 * already narrowed the state.
 */
export type RunningState = Extract<RunState, { readonly status: "running" }>

/** Everything the page can tell the machine. */
export type RunAction =
  /**
   * The Group_Member submitted a Coupon_Code that passed the client-side guards
   * of Requirements 2.3 and 2.4. Carries the trimmed value (Requirement 2.2).
   * Ignored while `running` (Requirement 2.9).
   */
  | { readonly type: "request-confirmation"; readonly couponCode: string }
  /** The confirmation dialog was dismissed: nothing is sent (Requirement 2.6). */
  | { readonly type: "dismiss-confirmation" }
  /** The dialog was confirmed: the page sends the request as it dispatches this. */
  | { readonly type: "confirm" }
  /** One event of the `runRedemption` stream. */
  | { readonly type: "run-event"; readonly event: RunEvent }
  /**
   * The stream ended without a terminal event — a dropped connection, or a
   * rejected request. Re-enables the submission control and carries a message for
   * the notification, which is what Requirement 6.4 asks for on the paths where
   * the server produced no `run-failed` event of its own.
   */
  | { readonly type: "run-aborted"; readonly message: string }
  /**
   * The `getActiveRun` read of a fresh mount: a snapshot seeds `running` so a
   * reload or a second tab shows a correct progress indicator and a disabled
   * submission control; `null` leaves the state alone.
   */
  | { readonly type: "seed"; readonly snapshot: ActiveRunSnapshot | null }
  /** Clears a `completed` or `failed` result view back to `idle`. */
  | { readonly type: "reset" }

/** The state a freshly mounted redemption page starts in. */
export const INITIAL_RUN_STATE: RunState = { status: "idle" }

/**
 * True exactly while a Redemption_Run is in progress.
 *
 * This is the single source of the submission control's disabled state: the page
 * passes it straight to `CouponForm`'s `disabled` prop, and the form's own submit
 * handler refuses to submit when it is set, so the `Enter` key is blocked as well
 * as the button (Requirements 2.7, 2.9). It is false in `completed` and in
 * `failed`, which is Requirement 2.8 and the re-enabling half of Requirement 6.4.
 */
export function isRunInProgress(state: RunState): boolean {
  return state.status === "running"
}

/**
 * The message the error notification of Requirement 6.4 holds, or null when the
 * run did not fail. Rendered as a React text child, never as markup.
 */
export function runFailureMessage(state: RunState): string | null {
  return state.status === "failed" ? state.message : null
}

/**
 * Whether an event belongs to the run the `running` state is tracking.
 *
 * Until `run-started` arrives the tracked `runId` is `""` and every event is
 * accepted — including the pre-flight `run-failed` event, whose `runId` is
 * `PREFLIGHT_RUN_ID`, the empty string, because no run was created. Once the run
 * is named, an event carrying a different `runId` is a leftover of an abandoned
 * stream and is dropped rather than corrupting the counter.
 */
function belongsToRun(trackedRunId: string, eventRunId: string): boolean {
  return trackedRunId === "" || trackedRunId === eventRunId
}

/**
 * The transitions a {@link RunEvent} performs on a run in progress.
 *
 * Split out of {@link runStateReducer} so the switch over the four event types is
 * exhaustive on its own and every branch is a `return`.
 */
function applyRunEvent(state: RunningState, event: RunEvent): RunState {
  /* An event of a different run is a leftover of an abandoned stream: dropping it
   * keeps it from corrupting the counter of the run actually in progress. */
  if (!belongsToRun(state.runId, event.runId)) return state

  switch (event.type) {
    case "run-started":
      return {
        ...state,
        runId: event.runId,
        total: event.total,
        mock: event.mock,
      }
    case "member-outcome":
      return {
        ...state,
        /* The server counts; the client does not recount. `processed` and `total`
         * are taken from the event so a dropped or duplicated event cannot make
         * the indicator drift from the run. */
        processed: event.processed,
        total: event.total,
        outcomes: [...state.outcomes, event.outcome],
      }
    case "run-completed":
      /* Requirement 2.8: leaving `running` re-enables the control, and the page's
       * input state still holds the submitted Coupon_Code. */
      return { status: "completed", result: event.result }
    case "run-failed":
      /* Requirement 6.4: the returned message, verbatim, plus the complete result
       * set the server built. */
      return { status: "failed", message: event.message, result: event.result }
  }
}

/**
 * The transition table. Total: every unlisted `(state, action)` pair returns the
 * state unchanged.
 */
export function runStateReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case "request-confirmation":
      /* Requirement 2.9: a submission during a run changes nothing, so the
       * progress indicator of that run stays on screen untouched. */
      if (state.status === "running") return state
      return { status: "confirming", couponCode: action.couponCode }

    case "dismiss-confirmation":
      /* Requirement 2.6: back to idle with nothing sent. The entered Coupon_Code
       * lives in the page's input state, which this machine cannot touch. */
      return state.status === "confirming" ? INITIAL_RUN_STATE : state

    case "confirm":
      /* Only a confirmed dialog can start a run (Requirement 2.5), so this is the
       * one action that may enter `running`. `runId` and `total` are unknown until
       * `run-started` arrives. */
      if (state.status !== "confirming") return state
      return {
        status: "running",
        runId: "",
        couponCode: state.couponCode,
        total: 0,
        processed: 0,
        outcomes: [],
        mock: false,
      }

    case "run-event":
      /* Events outside `running` are stale: a stream that outlived a dismissal or
       * a reset has nothing left to report to. */
      return state.status === "running"
        ? applyRunEvent(state, action.event)
        : state

    case "run-aborted":
      if (state.status !== "running") return state
      return { status: "failed", message: action.message, result: null }

    case "seed": {
      const { snapshot } = action
      /* Only a fresh mount is seeded: a run this tab started in the meantime is
       * the more current truth. */
      if (snapshot === null || state.status !== "idle") return state
      return {
        status: "running",
        runId: snapshot.runId,
        couponCode: snapshot.couponCode,
        total: snapshot.total,
        processed: snapshot.processed,
        outcomes: snapshot.outcomes,
        mock: snapshot.mock,
      }
    }

    case "reset":
      return INITIAL_RUN_STATE
  }
}
