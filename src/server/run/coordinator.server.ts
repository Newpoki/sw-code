/**
 * The RunCoordinator: the single-run lock, the sequential Redemption_Run loop,
 * and the early stop (Requirements 3.1, 3.4, 3.5, 3.8, 3.9, 5.1 - 5.6, 5.8).
 *
 * A Redemption_Run is one piece of server-side state, not a set of parallel
 * jobs, so the lock is a plain in-process flag rather than a distributed lock.
 * The coordinator holds that flag, the fixed list of the run in progress, and
 * the Member_Outcomes recorded so far — which is exactly what the reconnect
 * path of `getActiveRun` reads through {@link RunCoordinator.snapshot}.
 *
 * This module owns the loop and nothing else. It reads no environment variable,
 * selects no {@link UpstreamClient} (the Mock_Mode choice is made once at
 * startup and injected), performs no validation of the Coupon_Code length
 * (Requirements 2.10 and 3.7 are pre-flight checks in
 * `src/server/run/redemptionRequest.server.ts`), and composes no HTTP-shaped error:
 * a rejection is a typed {@link RunStartError} the server function layer turns
 * into a terminal `run-failed` event.
 *
 * ## The order of the first four steps is load-bearing
 *
 * 1. Reject when a Redemption_Run is already active, leaving that run untouched
 *    (Requirement 3.9).
 * 2. Acquire the lock.
 * 3. Snapshot `listEnabled()` as the fixed list (Requirement 5.5).
 * 4. Reject when that list is empty (Requirement 3.8).
 *
 * The lock is acquired **before** the snapshot and released in a `finally` that
 * covers every statement after the acquisition, so neither a throw, nor an
 * empty roster, nor a consumer that abandons the generator can leave the
 * coordinator permanently locked.
 *
 * Steps 1 and 2 are one synchronous check-and-set inside the generator body, so
 * two callers that start a run in the same tick cannot both pass: the body of
 * an async generator does not run until the first `next()`, and from that point
 * to the assignment there is no `await`.
 *
 * ## The `finally` backfill is the whole outcome-count invariant
 *
 * The loop itself records `SKIPPED` for the Group_Members after an
 * `INVALID_COUPON` (Requirements 5.1, 5.2) and yields an event for each. The
 * `finally` backfill covers the paths the loop never reached: a server failure
 * mid-run, a failure before the first request, or a consumer that stopped
 * iterating. That one mechanism makes `outcomes.length` equal the fixed-list
 * size on every path (Requirements 5.6, 5.8) — the backfilled outcomes are part
 * of the terminal result set rather than separate progress events, because
 * nothing may be yielded from a `finally` that runs during a generator return.
 *
 * ## Exactly one request per Group_Member, no retry
 *
 * The loop `await`s each `useCoupon` call before moving on, so at most one
 * request is ever in flight and the next one is issued only after the preceding
 * Member_Outcome is recorded (Requirement 3.5). `ALREADY_USED`,
 * `UPSTREAM_ERROR`, and `TRANSPORT_ERROR` fall through to the next Group_Member;
 * no code path in this module calls `useCoupon` twice for the same
 * Group_Member, and the {@link UpstreamClient} boundary exposes no `checkUser`,
 * so a run costs exactly one upstream request per processed Group_Member
 * (Requirements 3.4, 5.4).
 *
 * ## One terminal event, one Redemption_History record
 *
 * After the loop the coordinator builds the {@link RedemptionRunResult} — the
 * outcomes in processing order plus all six counts from `countOutcomes` — and
 * yields exactly one terminal event: `run-completed`, or `run-failed` carrying
 * the same complete result set when a server failure ended the run
 * (Requirements 5.7, 6.3, 5.8).
 *
 * A run that completes appends exactly one Redemption_History record holding the
 * trimmed Coupon_Code, the completion timestamp, the Mock_Mode flag, and one
 * denormalized row per fixed-list entry (Requirements 6.5, 7.9); a failed append
 * costs one warning and no outcome (Requirement 6.8). A run that ended in a
 * server failure appends nothing: it did not complete, and the failure this loop
 * is most likely to see is an unusable Mock_Mode fixture, for which Requirements
 * 7.6 and 7.10 forbid a Redemption_History record outright.
 *
 * ## A `useCoupon` rejection ends the run
 *
 * `useCoupon` reports every observable *upstream* condition — including a
 * timeout and a network failure — by resolving with a `transportFailure`, so a
 * rejection means the client itself is broken: `MockUpstreamClient` rejects with
 * a `FixtureUnavailableError` when the selected fixture is unusable, and a test
 * stub can be scripted to throw. That is a failure of the Redemption_Server, not
 * an upstream answer, so it ends the run rather than being classified as a
 * Member_Outcome: the Group_Member it happened for gets `SKIPPED` from the
 * backfill (no usable response was ever received for it) and so does the
 * remainder of the fixed list, which keeps the count invariant of Requirement
 * 5.6 and the server-failure case of Requirement 5.8 satisfied.
 */

import { randomUUID } from "node:crypto"

import { parseUpstreamBody } from "@/domain/responseParser"
import {
  countOutcomes,
  missingSkippedOutcomes,
  skippedOutcome,
} from "@/domain/outcomes"
import type {
  ActiveRunSnapshot,
  AppErrorCode,
  MemberOutcome,
  MemberRegistryEntry,
  RedemptionRunResult,
  RunEvent,
  UpstreamResult,
} from "@/domain/types"
import { toHistoryOutcomeRows } from "@/server/store/history.server"
import type {
  AppendHistoryInput,
  HistoryStore,
} from "@/server/store/history.server"
import type { MemberRegistryStore } from "@/server/store/memberRegistry.server"
import type { UpstreamClient } from "@/server/upstream/client"

/** The two rejection codes {@link RunCoordinator.start} can produce. */
export type RunStartErrorCode = Extract<
  AppErrorCode,
  "NO_ENABLED_MEMBERS" | "RUN_IN_PROGRESS"
>

/**
 * A pre-flight rejection of {@link RunCoordinator.start}: no enabled
 * Group_Member (Requirement 3.8) or a Redemption_Run already in progress
 * (Requirement 3.9). Neither issues an Upstream_API request, and neither
 * appends a Redemption_History record.
 *
 * It carries the {@link AppErrorCode} so the server function layer can map it
 * to a terminal `run-failed` event without matching on the message text.
 */
export class RunStartError extends Error {
  readonly code: RunStartErrorCode

  constructor(code: RunStartErrorCode, message: string) {
    super(message)
    this.name = "RunStartError"
    this.code = code
  }
}

/**
 * The rejection message for an empty fixed list (Requirement 3.8). Exported so
 * the client-side guard of Requirement 2.4 and the server rejection can render
 * the same sentence.
 */
export function noEnabledMembersMessage(): string {
  return "No enabled Group_Member exists. Add a Group_Member, or enable one, before starting a run."
}

/** The rejection message for a Redemption_Run already in progress (Requirement 3.9). */
export function runInProgressMessage(): string {
  return "A Redemption_Run is in progress. Wait for it to finish before starting another one."
}

/**
 * The single warning a failed Redemption_History append adds to
 * {@link RedemptionRunResult.warnings} (Requirement 6.8). The Member_Outcomes
 * are still returned; only their durability is lost.
 *
 * A constant rather than a function, so the unit test of the failure path and
 * the run loop cannot drift apart on wording.
 */
export const HISTORY_NOT_PERSISTED_WARNING =
  "The Redemption_History record is not persisted. The Member_Outcomes of this Redemption_Run are complete, but they will be missing from the history view after a restart."

/** How much of a failure message the `run-failed` event repeats. */
const MAX_FAILURE_DETAIL_LENGTH = 300

/**
 * The message of a `run-failed` event when no detail can be recovered from the
 * failure. Exported so a test can assert the fallback without duplicating it.
 */
export const RUN_FAILED_FALLBACK_MESSAGE =
  "The Redemption_Run stopped because the Redemption_Server failed. Every Group_Member for which no Upstream_API request was issued is reported as SKIPPED."

/**
 * A failure carrying the `FIXTURE_UNAVAILABLE` code — in practice a
 * `FixtureUnavailableError` from `mock.server.ts`, whose message already names
 * the fixture and states whether it is absent or invalid JSON (Requirement 7.6).
 *
 * Matched structurally rather than with `instanceof`, so this module needs no
 * import from the Mock_Mode client (which would drag `node:fs` into the run
 * loop) and so a test double that throws the same shape is handled identically.
 */
function fixtureUnavailableMessageOf(failure: unknown): string | null {
  if (!(failure instanceof Error)) return null
  if ((failure as { code?: unknown }).code !== "FIXTURE_UNAVAILABLE")
    return null
  const message = failure.message.trim()
  return message.length === 0 ? null : message
}

/**
 * The message of the terminal `run-failed` event for a server failure that ended
 * a Redemption_Run.
 *
 * Only the failure's own `message` is repeated, capped and reduced to its first
 * line, so no stack trace and no multi-line internal dump reaches the
 * Web_Client. A `FixtureUnavailableError` message is passed through whole
 * because it is already worded for a Group_Member (Requirement 7.6).
 */
export function runFailedMessage(failure: unknown): string {
  const fixtureMessage = fixtureUnavailableMessageOf(failure)
  if (fixtureMessage !== null) return fixtureMessage

  const raw = failure instanceof Error ? failure.message : ""
  const [firstLine = ""] = raw.split("\n")
  const detail = firstLine.trim().slice(0, MAX_FAILURE_DETAIL_LENGTH)
  if (detail.length === 0) return RUN_FAILED_FALLBACK_MESSAGE

  return `The Redemption_Run stopped because the Redemption_Server failed: ${detail}. Every Group_Member for which no Upstream_API request was issued is reported as SKIPPED.`
}

/**
 * Appends the one Redemption_History record of a Redemption_Run and reports
 * whether it was persisted (Requirements 6.5, 6.8).
 *
 * `JsonStore.mutate` already turns a failed flush into `persisted: false`, so a
 * rejection here means the store itself misbehaved. It is caught rather than
 * propagated because the Member_Outcomes must survive a broken history: losing
 * a complete result set over a bookkeeping write would break the count
 * invariant of Requirement 5.6 for the client. Either way the caller sees the
 * same not-persisted warning.
 */
async function appendHistoryRecord(
  history: HistoryStore,
  input: AppendHistoryInput
): Promise<boolean> {
  try {
    const { persisted } = await history.append(input)
    return persisted
  } catch {
    return false
  }
}

/** The Redemption_Run seam consumed by `src/server/run/redemptionRequest.server.ts`. */
export interface RunCoordinator {
  /**
   * Runs one Redemption_Run, yielding a `run-started` event, then one
   * `member-outcome` event per processed Group_Member.
   *
   * Rejects with a {@link RunStartError} carrying `RUN_IN_PROGRESS` while a
   * Redemption_Run is active (Requirement 3.9) and with `NO_ENABLED_MEMBERS`
   * when the fixed list is empty (Requirement 3.8). Because the body of an
   * async generator is deferred, both rejections surface on the first `next()`,
   * which is also when the lock is acquired.
   */
  start: (couponCode: string) => AsyncGenerator<RunEvent, void, void>
  /** The run in progress, or null when the coordinator is idle. */
  snapshot: () => ActiveRunSnapshot | null
}

export interface RunCoordinatorDependencies {
  readonly registry: MemberRegistryStore
  readonly history: HistoryStore
  /** Chosen once at startup from the Mock_Mode state (Requirement 7.5). */
  readonly upstream: UpstreamClient
  /** Clock behind `startedAt` and the completion timestamp. Defaults to the system clock. */
  readonly now?: () => Date
  /** Run identifier source. Defaults to `crypto.randomUUID()`. */
  readonly generateRunId?: () => string
}

/** The mutable bookkeeping of the run in progress; the source of `snapshot()`. */
interface ActiveRun {
  readonly runId: string
  readonly couponCode: string
  readonly startedAt: string
  readonly mock: boolean
  /** Size of the fixed list; 0 only in the same tick the lock is acquired. */
  total: number
  /** Member_Outcomes recorded so far, in processing order. */
  readonly outcomes: MemberOutcome[]
}

/**
 * The Member_Outcome of a Group_Member a request *was* issued for.
 *
 * The `SKIPPED` branch is unreachable: `parseUpstreamBody` classifies only into
 * the five request-derived values, never into `SKIPPED`. It is handled rather
 * than cast away because `UpstreamResult.outcome` is typed as any of the six
 * values, and reporting `SKIPPED` here would claim no request was issued for a
 * Group_Member that just received one. Recording it as `TRANSPORT_ERROR`
 * preserves the meaning of `SKIPPED` (Requirement 5.2) whatever a future
 * classifier does.
 */
function requestedOutcome(
  member: MemberRegistryEntry,
  position: number,
  result: UpstreamResult
): MemberOutcome {
  if (result.outcome === "SKIPPED") {
    return {
      hiveId: member.hiveId,
      memberLabel: member.memberLabel,
      position,
      outcome: "TRANSPORT_ERROR",
      upstreamResult: { ...result, outcome: "TRANSPORT_ERROR" },
    }
  }

  return {
    hiveId: member.hiveId,
    memberLabel: member.memberLabel,
    position,
    outcome: result.outcome,
    upstreamResult: result,
  }
}

/**
 * Builds a coordinator over the injected collaborators. Every dependency is a
 * parameter, so a test can drive the loop with a `StubUpstreamClient`, a
 * temporary {@link HistoryStore}, a fixed clock, and a counting id generator.
 *
 * Each coordinator owns its own lock. The application uses exactly one
 * ({@link getRunCoordinator}); a test can build as many independent ones as it
 * needs.
 */
export function createRunCoordinator(
  dependencies: RunCoordinatorDependencies
): RunCoordinator {
  const { registry, upstream } = dependencies
  const now = dependencies.now ?? (() => new Date())
  const generateRunId = dependencies.generateRunId ?? (() => randomUUID())

  /** The lock. Non-null exactly while a Redemption_Run is in progress. */
  let activeRun: ActiveRun | null = null

  async function* start(
    couponCode: string
  ): AsyncGenerator<RunEvent, void, void> {
    if (activeRun !== null) {
      throw new RunStartError("RUN_IN_PROGRESS", runInProgressMessage())
    }

    /*
     * Trimmed defensively. The length check of Requirements 2.10 and 3.7 belongs
     * to the server function layer, but the value stored on the run — and sent
     * upstream as `coupon` — has to be the same trimmed Coupon_Code the
     * Redemption_History records, so that the Requirement 6.7 "last used" lookup
     * can compare it character for character.
     */
    const coupon = couponCode.trim()
    const runId = generateRunId()
    const mock = upstream.isMock

    // Lock acquired here, before the fixed list is snapshotted, and released in
    // the `finally` below.
    const run: ActiveRun = {
      runId,
      couponCode: coupon,
      startedAt: now().toISOString(),
      mock,
      total: 0,
      outcomes: [],
    }
    activeRun = run

    let fixedList: readonly MemberRegistryEntry[] = []
    let stopped = false
    /** A server failure that ended the run; null on a run that ran to its end. */
    let serverFailure: unknown = null

    try {
      // Snapshotted once. A Member_Registry mutation during the run cannot
      // change this array, so the Group_Members reported as SKIPPED are exactly
      // the ones positioned after the early stop (Requirement 5.5).
      fixedList = registry.listEnabled()
      run.total = fixedList.length

      if (fixedList.length === 0) {
        throw new RunStartError("NO_ENABLED_MEMBERS", noEnabledMembersMessage())
      }

      yield {
        type: "run-started",
        runId,
        total: fixedList.length,
        memberLabels: fixedList.map((member) => member.memberLabel),
        mock,
      }

      for (const [position, member] of fixedList.entries()) {
        if (stopped) {
          // No request is issued for this Group_Member (Requirements 5.1, 5.2).
          const skipped = skippedOutcome(member, position)
          run.outcomes.push(skipped)
          yield {
            type: "member-outcome",
            runId,
            processed: run.outcomes.length,
            total: fixedList.length,
            outcome: skipped,
          }
          continue
        }

        // Exactly one request per Group_Member, awaited before the next one is
        // issued (Requirements 3.4, 3.5). The Fixed_Request_Fields are owned by
        // the client implementation, not passed from here (Requirement 3.3).
        const raw = await upstream.useCoupon({
          hiveid: member.hiveId,
          coupon,
        })
        const result = parseUpstreamBody({
          bodyText: raw.bodyText,
          transportFailure: raw.transportFailure,
        })
        const outcome = requestedOutcome(member, position, result)
        run.outcomes.push(outcome)

        yield {
          type: "member-outcome",
          runId,
          processed: run.outcomes.length,
          total: fixedList.length,
          outcome,
        }

        if (outcome.outcome === "INVALID_COUPON") {
          // Every remaining Group_Member takes the SKIPPED branch above; no
          // further request is issued (Requirements 5.1, 5.3).
          stopped = true
        }
      }
    } catch (error) {
      if (error instanceof RunStartError) {
        // A pre-flight rejection, not a failure of a run that started.
        throw error
      }
      // A rejected `useCoupon` (broken client, unusable fixture) or a consumer
      // that threw into the generator. The run ends here; the backfill below
      // still produces one Member_Outcome per fixed-list entry (Requirement 5.8).
      serverFailure = error
      stopped = true
    } finally {
      run.outcomes.push(...missingSkippedOutcomes(fixedList, run.outcomes))
      activeRun = null
    }

    /*
     * The terminal step. `run.outcomes` is complete here — the `finally` above
     * ran, so there is one Member_Outcome per fixed-list entry in processing
     * order — and the lock is already released, so a consumer may start the next
     * Redemption_Run the moment the terminal event lands.
     *
     * Nothing between the `INVALID_COUPON` that set `stopped` and the yield
     * below waits on the Upstream_API: at most 99 SKIPPED records were built in
     * the loop and one history record is written, which is what keeps the
     * complete result set inside the 1-second bound of Requirement 5.7.
     */
    const outcomes = [...run.outcomes]
    const completedAt = now().toISOString()
    const warnings: string[] = []

    /*
     * Exactly one record per completed Redemption_Run (Requirement 6.5),
     * carrying the trimmed Coupon_Code, the completion timestamp, the Mock_Mode
     * flag (Requirement 7.9), the early-stop flag, and one denormalized row per
     * fixed-list entry (Requirement 1.5).
     *
     * A run that ended in a server failure appends nothing: it did not complete,
     * so Requirement 6.5 does not apply to it, and the failure this loop is most
     * likely to see is an unusable Mock_Mode fixture, for which Requirements 7.6
     * and 7.10 explicitly forbid a Redemption_History record. Its complete
     * result set still reaches the Web_Client through the `run-failed` event
     * below (Requirement 5.8).
     */
    if (serverFailure === null) {
      const persisted = await appendHistoryRecord(dependencies.history, {
        runId,
        couponCode: coupon,
        completedAt,
        mock,
        stoppedEarly: stopped,
        outcomes: toHistoryOutcomeRows(outcomes),
      })
      if (!persisted) {
        // One warning, no matter how the append failed (Requirement 6.8).
        warnings.push(HISTORY_NOT_PERSISTED_WARNING)
      }
    }

    const result: RedemptionRunResult = {
      runId,
      couponCode: coupon,
      completedAt,
      mock,
      // True for an INVALID_COUPON early stop *and* for a server failure: both
      // leave part of the fixed list unprocessed.
      stoppedEarly: stopped,
      outcomes,
      counts: countOutcomes(outcomes),
      warnings,
    }

    if (serverFailure !== null) {
      yield {
        type: "run-failed",
        runId,
        message: runFailedMessage(serverFailure),
        result,
      }
      return
    }

    yield { type: "run-completed", runId, result }
  }

  return {
    start,

    /**
     * A copy on every call: the caller cannot reach into the outcomes of the
     * run in progress, and the snapshot it holds does not change underneath it.
     */
    snapshot: () =>
      activeRun === null
        ? null
        : {
            runId: activeRun.runId,
            couponCode: activeRun.couponCode,
            startedAt: activeRun.startedAt,
            mock: activeRun.mock,
            total: activeRun.total,
            processed: activeRun.outcomes.length,
            outcomes: [...activeRun.outcomes],
          },
  }
}

let processCoordinator: RunCoordinator | null = null

/**
 * The process-wide coordinator, which is what makes the single-run lock of
 * Requirement 3.9 apply across requests.
 *
 * Unlike `getJsonStore`, this cannot build a default on its own: the
 * {@link UpstreamClient} is selected once at startup from the Mock_Mode state,
 * and this module deliberately does not read configuration. So the first caller
 * passes `create` — the application wiring passes a factory over the registry,
 * the history, and the selected client — and every later caller gets that same
 * coordinator, `create` or not.
 */
export function getRunCoordinator(
  create?: () => RunCoordinator
): RunCoordinator {
  if (processCoordinator === null) {
    if (create === undefined) {
      throw new Error(
        "No RunCoordinator is installed. Call setRunCoordinator() during startup wiring, or pass a factory to getRunCoordinator()."
      )
    }
    processCoordinator = create()
  }
  return processCoordinator
}

/** Installs the process-wide coordinator. Overrides whatever was created before. */
export function setRunCoordinator(coordinator: RunCoordinator): void {
  processCoordinator = coordinator
}

/** Drops the process-wide coordinator, releasing its lock along with it. */
export function resetRunCoordinator(): void {
  processCoordinator = null
}
