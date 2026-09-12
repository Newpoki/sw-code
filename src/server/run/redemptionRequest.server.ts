/**
 * The redemption request pipeline: the pre-flight checks of one redemption
 * request, the event stream it produces, and the reconnect read
 * (Requirements 2.10, 3.1, 3.2, 3.7, 3.8, 3.9, 7.6, 7.10).
 *
 * ## Why this is a `.server` module and not part of `redemption.functions.ts`
 *
 * It started there, next to the two `createServerFn` wrappers it feeds. It
 * cannot stay there: {@link runRedemptionEvents} needs two server-only *values*
 * — the {@link RunStartError} class it matches on and {@link checkUpstreamFixtures}
 * — and it is an ordinary exported function rather than a `.handler()` body, so
 * those imports survive into every module that imports it. Task 14.5 made the
 * redemption page import `runRedemption`, which puts `redemption.functions.ts`
 * into the client bundle graph, and the client build denies every `.server.*`
 * import reachable from that graph.
 *
 * Moving the pipeline here restores the convention the design states: a
 * `.functions.ts` module holds `createServerFn` wrappers and is safe to import
 * from a component, while `.server.ts` modules are reached only from inside
 * handler bodies, which the client build strips.
 *
 * ## Every failure is one terminal event, never a thrown error
 *
 * The Web_Client has a single code path for a run that did not deliver
 * Member_Outcomes: a terminal `run-failed` event. That holds for all four
 * pre-flight rejections this module and the coordinator can produce —
 *
 * 1. a Coupon_Code whose trimmed length falls outside 1 to 64 characters
 *    (Requirements 2.10, 3.7),
 * 2. a Mock_Mode fixture that is absent or unparseable (Requirements 7.6, 7.10),
 * 3. a Redemption_Run already in progress (Requirement 3.9),
 * 4. no enabled Group_Member (Requirement 3.8)
 *
 * — and each carries a {@link RedemptionRunResult} with an **empty** outcome
 * list, all six counts at zero, and no warning, because none of them issues a
 * single Upstream_API request and none of them appends a Redemption_History
 * record. The coordinator reports (3) and (4) by rejecting with a
 * {@link RunStartError}; this module converts that rejection into the same
 * terminal event as the two checks it performs itself, so the four are
 * indistinguishable in shape to the caller.
 *
 * ## The order of the pre-flight checks is load-bearing
 *
 * Length first: it is the cheapest check and Requirements 2.10 and 3.7 forbid an
 * Upstream_API request for an out-of-range Coupon_Code, so it must run before
 * anything that could touch the Upstream_API boundary. The Mock_Mode fixture
 * check second, before the coordinator is entered at all, so an unusable fixture
 * ends the request before a run exists — which is what makes "no Member_Outcome
 * is derived and no Redemption_History record is appended" true by construction
 * rather than by cleanup (Requirements 7.6, 7.10). The lock and the empty fixed
 * list are the coordinator's own first two steps and stay there.
 *
 * ## `{ couponCode }` is the whole payload
 *
 * No Hive_ID is ever accepted from the caller (Requirement 3.2): the fixed list
 * comes from `listEnabled()` inside the coordinator, and the Fixed_Request_Fields
 * come from the `UpstreamClient` implementation. This module passes the trimmed
 * Coupon_Code and nothing else.
 *
 * ## Test seam
 *
 * `createServerFn(...).handler(fn)` cannot be invoked outside the framework, so
 * the event-producing logic lives in {@link runRedemptionEvents}, which takes its
 * collaborators as a parameter, and the read logic in {@link readActiveRun}. The
 * two server functions in `src/functions/redemption.functions.ts` are thin
 * wrappers that bind the process-wide collaborators through
 * {@link appRedemptionCollaborators} and {@link appRunCoordinator}.
 */

import {
  COUPON_CODE_MAX_LENGTH,
  FIELD_NAMES,
  firstErrorMessage,
  lengthRangeMessage,
  runRedemptionInputSchema,
} from "@/domain/schemas"
import { emptyOutcomeCounts } from "@/domain/outcomes"
import {
  RunStartError,
  createRunCoordinator,
  getRunCoordinator,
} from "@/server/run/coordinator.server"
import { getHistoryStore } from "@/server/store/history.server"
import { getMemberRegistryStore } from "@/server/store/memberRegistry.server"
import {
  checkUpstreamFixtures,
  getUpstreamClient,
} from "@/server/upstream/factory.server"
import type {
  ActiveRunSnapshot,
  Envelope,
  RedemptionRunResult,
  RunEvent,
} from "@/domain/types"
import type { RunCoordinator } from "@/server/run/coordinator.server"
import type { UpstreamClient } from "@/server/upstream/client"

/**
 * The `runId` of a terminal `run-failed` event produced by a pre-flight
 * rejection. Empty on purpose: no Redemption_Run was created, so there is no
 * identifier to report, and an invented one would appear in the Web_Client as a
 * run that never existed.
 */
export const PREFLIGHT_RUN_ID = ""

/**
 * The rejection message for a Coupon_Code outside 1 to 64 characters
 * (Requirements 2.10, 3.7). Identical to what `couponCodeSchema` produces, and
 * exported so the Coupon_Code form and the tests assert the same sentence
 * instead of a paraphrase of it.
 */
export const COUPON_CODE_RANGE_MESSAGE = lengthRangeMessage(
  FIELD_NAMES.couponCode,
  1,
  COUPON_CODE_MAX_LENGTH
)

/** The collaborators {@link runRedemptionEvents} needs, all injected. */
export interface RedemptionCollaborators {
  /** Owner of the single-run lock and of the run loop itself. */
  readonly coordinator: RunCoordinator
  /**
   * The selected Upstream_API client. Used for two things only: its `isMock`
   * flag, and the Mock_Mode fixture pre-flight check. No request is issued from
   * this module.
   */
  readonly upstream: UpstreamClient
  /** Clock behind the `completedAt` of a pre-flight rejection. Defaults to the system clock. */
  readonly now?: () => Date
}

/**
 * The Coupon_Code echoed back in a pre-flight rejection's result.
 *
 * Read defensively: `input` is whatever crossed the boundary, and this runs
 * before the schema has vouched for its shape. A non-string (or absent)
 * Coupon_Code yields an empty string, and an over-long one is trimmed and capped
 * at the permitted maximum, so a rejected submission cannot use this field to
 * push unbounded text back into the Web_Client.
 */
function submittedCouponCode(input: unknown): string {
  if (typeof input !== "object" || input === null) return ""
  const { couponCode } = input as { readonly couponCode?: unknown }
  return typeof couponCode === "string"
    ? couponCode.trim().slice(0, COUPON_CODE_MAX_LENGTH)
    : ""
}

/**
 * The single terminal event of a pre-flight rejection.
 *
 * `outcomes` is empty and every count is zero because no Group_Member was ever
 * considered: no Upstream_API request was issued, no Member_Outcome was derived,
 * and no Redemption_History record was appended. `stoppedEarly` is false — a run
 * that never started was not stopped — and `warnings` is empty, since nothing
 * was written for a write to warn about.
 */
function preflightRejection(
  collaborators: RedemptionCollaborators,
  couponCode: string,
  message: string
): RunEvent {
  const now = collaborators.now ?? (() => new Date())
  const result: RedemptionRunResult = {
    runId: PREFLIGHT_RUN_ID,
    couponCode,
    completedAt: now().toISOString(),
    mock: collaborators.upstream.isMock,
    stoppedEarly: false,
    outcomes: [],
    counts: emptyOutcomeCounts(),
    warnings: [],
  }
  return { type: "run-failed", runId: PREFLIGHT_RUN_ID, message, result }
}

/**
 * The event stream of one redemption request: the pre-flight checks, then the
 * coordinator's own events forwarded unchanged.
 *
 * Yields exactly one terminal `run-failed` event and stops for each of the four
 * pre-flight rejections; otherwise it forwards `run-started`, one
 * `member-outcome` per Group_Member, and the coordinator's terminal
 * `run-completed` / `run-failed` event.
 *
 * `yield*` rather than a `for await` loop, so a consumer that abandons the
 * stream propagates its `return()` into the coordinator's generator and the
 * single-run lock is released by the coordinator's own `finally`.
 *
 * A failure that is not a {@link RunStartError} is left to propagate: the
 * coordinator already converts a broken Upstream_API client or a mid-run failure
 * into its own terminal `run-failed` event, so anything still thrown here is a
 * genuine bug rather than a condition the requirements describe.
 */
export async function* runRedemptionEvents(
  collaborators: RedemptionCollaborators,
  input: unknown
): AsyncGenerator<RunEvent, void, void> {
  // 1. Length, first and cheapest: an out-of-range Coupon_Code must cost zero
  //    Upstream_API requests and zero history records (Requirements 2.10, 3.7).
  //    The parse also trims, so a value holding only whitespace — or nothing at
  //    all — is rejected by this same check (Requirement 3.7).
  const parsed = runRedemptionInputSchema.safeParse(input)
  if (!parsed.success) {
    yield preflightRejection(
      collaborators,
      submittedCouponCode(input),
      firstErrorMessage(parsed.error)
    )
    return
  }
  const { couponCode } = parsed.data

  // 2. Mock_Mode fixtures, before the coordinator is entered, so an unusable
  //    fixture ends the request before a run exists (Requirements 7.6, 7.10).
  //    A no-op for a live client, which serves no fixture (Requirement 7.11).
  const fixtures = await checkUpstreamFixtures(collaborators.upstream)
  if (!fixtures.ok) {
    // Already worded for a Group_Member: it names the fixture and states whether
    // it is absent or is not valid JSON.
    yield preflightRejection(collaborators, couponCode, fixtures.message)
    return
  }

  // 3. and 4. The lock (Requirement 3.9) and the empty fixed list
  //    (Requirement 3.8) are the coordinator's first two steps; it reports both
  //    by rejecting, which becomes the same terminal event as the two above.
  try {
    yield* collaborators.coordinator.start(couponCode)
  } catch (error) {
    if (error instanceof RunStartError) {
      yield preflightRejection(collaborators, couponCode, error.message)
      return
    }
    throw error
  }
}

/**
 * The Redemption_Run in progress, or null when the Redemption_Server is idle.
 *
 * A read: it starts nothing, touches no store, and therefore carries no warning.
 */
export function readActiveRun(
  coordinator: RunCoordinator
): Envelope<ActiveRunSnapshot | null> {
  return { ok: true, data: coordinator.snapshot(), warnings: [] }
}

/**
 * The process-wide coordinator, built on first use over the process-wide stores
 * and the Upstream_API client selected at startup.
 *
 * `getRunCoordinator` cannot construct a default on its own — it deliberately
 * reads no configuration — so the factory is passed here, and every later call
 * returns that same instance. One coordinator per process is what makes the
 * single-run lock of Requirement 3.9 hold across requests.
 */
export function appRunCoordinator(): RunCoordinator {
  return getRunCoordinator(() =>
    createRunCoordinator({
      registry: getMemberRegistryStore(),
      history: getHistoryStore(),
      upstream: getUpstreamClient(),
    })
  )
}

/** The collaborators of a redemption request in this process. */
export function appRedemptionCollaborators(): RedemptionCollaborators {
  return { coordinator: appRunCoordinator(), upstream: getUpstreamClient() }
}
