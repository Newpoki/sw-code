/**
 * The Redemption_Run server function surface (Requirements 3.1, 3.2).
 *
 * Two functions: `runRedemption`, a POST server function whose handler is an
 * `async function*` streaming `RunEvent`s while the run progresses, and
 * `getActiveRun`, the reconnect read that returns the coordinator's snapshot.
 *
 * ## Thin on purpose
 *
 * The pre-flight checks, the event stream, and the process-wide collaborators
 * all live in `src/server/run/redemptionRequest.server.ts`. This module holds
 * nothing but the two `createServerFn` wrappers and the payload type, which is
 * what makes it safe to import from the redemption page: the two `.server`
 * imports below are referenced only inside `.handler()` bodies, and the client
 * build strips those bodies, so no server-only module reaches the browser
 * bundle. That is the same arrangement `members.functions.ts` uses for the
 * Member_Registry store, and it is the reason the run pipeline was moved out of
 * this file rather than left next to its wrappers.
 *
 * ## The streaming shape is a framework feature, not a hand-rolled protocol
 *
 * A `createServerFn` handler may be an async generator: the yielded chunks stay
 * typed across the boundary and the caller consumes them with
 * `for await (const event of await runRedemption({ data: { couponCode } }))`.
 * The installed `@tanstack/react-start@1.168.52` carries that support in its
 * types as well as at runtime, so nothing here encodes, chunks, or frames
 * anything by hand.
 *
 * ## Validation happens in the pipeline, not in the validator
 *
 * As in `members.functions.ts`, the attached validator never throws: a throwing
 * validator would reach the caller as an exception, and Requirements 2.10 and
 * 3.7 ask for a *message* the Web_Client displays. Here the validator is a plain
 * pass-through that only fixes the payload type, and the length check runs inside
 * `runRedemptionEvents` against the same schema the Coupon_Code form uses, so the
 * two messages cannot drift. Every rejection — a bad length, an unusable
 * Mock_Mode fixture, a run already in progress, an empty enabled roster — is
 * delivered as a single terminal `run-failed` event instead.
 *
 * ## `{ couponCode }` is the whole payload
 *
 * No Hive_ID is ever accepted from the caller (Requirement 3.2). The fixed list
 * of a Redemption_Run is read from the Member_Registry on the server.
 */

import { createServerFn } from "@tanstack/react-start"

import {
  appRedemptionCollaborators,
  appRunCoordinator,
  readActiveRun,
  runRedemptionEvents,
} from "@/server/run/redemptionRequest.server"

/**
 * The payload of `runRedemption`. The Coupon_Code is the only caller-supplied
 * value; no Hive_ID is ever part of it (Requirements 3.1, 3.2).
 */
export interface RunRedemptionPayload {
  readonly couponCode: string
}

/**
 * The validator attached to `runRedemption`: it fixes the payload type for the
 * call site and returns the value untouched.
 *
 * It performs no check, by design. The length rule of Requirements 2.10 and 3.7
 * is enforced inside the handler so its rejection can be delivered as a terminal
 * `run-failed` event; a validator that rejected would throw instead, which is the
 * one thing this surface must not do.
 */
export function acceptRunRedemptionPayload(
  input: RunRedemptionPayload
): RunRedemptionPayload {
  return input
}

/**
 * Runs one Redemption_Run for the submitted Coupon_Code, streaming a
 * `run-started` event, one `member-outcome` event per Group_Member of the fixed
 * list, and one terminal event (Requirements 3.1, 3.2).
 *
 * A POST: it writes — the Redemption_History record and the coordinator's lock.
 * The Access_Gate and the cross-site check are applied globally in
 * `src/start.ts`, so nothing here re-checks them.
 */
export const runRedemption = createServerFn({ method: "POST" })
  .validator(acceptRunRedemptionPayload)
  .handler(async function* ({ data }) {
    yield* runRedemptionEvents(appRedemptionCollaborators(), data)
  })

/**
 * The Redemption_Run in progress, for a Web_Client that reconnects or opens a
 * second tab while a run is under way.
 */
export const getActiveRun = createServerFn().handler(() =>
  readActiveRun(appRunCoordinator())
)
