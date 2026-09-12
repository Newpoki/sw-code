/**
 * A hand-written {@link UpstreamClient} stub for the run-loop tests.
 *
 * It is deliberately not a mocking-library double: it is a small, explicit
 * object that replays a scripted sequence of responses, one entry per
 * `useCoupon` call, and records everything a run-loop assertion needs.
 *
 * What it records, and which design property consumes it:
 *
 * - {@link StubUpstreamClient.requests} — every request received, in call
 *   order, so a test can assert the `hiveid` / `coupon` pair, the processing
 *   order, and the exact request count (Property 7, Property 8, Requirement
 *   3.4: exactly one request per Group_Member, never repeated).
 * - {@link StubUpstreamClient.maxInFlight} — the highest number of `useCoupon`
 *   calls observed overlapping. A sequential loop that awaits each call keeps
 *   this at 1 (Requirement 3.5, Property 7).
 * - A scripted entry may **throw** instead of resolving, so a run that fails
 *   mid-loop can be exercised (Property 5, Requirement 5.8).
 *
 * This module lives under `tests/support/`, which the Vitest config does not
 * collect: only test files under `tests/unit`, `tests/property`, and
 * `tests/integration` are collected.
 *
 * The stub exposes **no `checkUser` method**, mirroring the boundary itself, so
 * a run loop cannot issue that request even by accident (Requirement 3.4).
 */

import type {
  UpstreamClient,
  UpstreamRawResponse,
  UseCouponRequest,
} from "@/server/upstream/client"

/** One scripted step: either a response to resolve with, or a throw. */
export type StubScriptEntry =
  | {
      readonly kind: "respond"
      readonly response: UpstreamRawResponse
      /** Optional real delay, for tests that need overlapping calls to be observable. */
      readonly delayMs?: number
    }
  | {
      readonly kind: "throw"
      /** Defaults to a {@link StubScriptedThrowError} naming the call index. */
      readonly error?: Error
      readonly delayMs?: number
    }

/** Context handed to an optional gate before a scripted entry is applied. */
export interface StubGateContext {
  /** 0-based index of this `useCoupon` call. */
  readonly callIndex: number
  readonly request: UseCouponRequest
  /** Number of `useCoupon` calls in flight right now, including this one. */
  readonly inFlight: number
}

export interface StubUpstreamClientOptions {
  /** Replayed in order, one entry per `useCoupon` call. Defaults to empty. */
  readonly script?: readonly StubScriptEntry[]
  /** Value of {@link UpstreamClient.isMock}. Defaults to false. */
  readonly isMock?: boolean
  /**
   * Awaited after the request is recorded and before the scripted entry is
   * applied. A test can hold a call open here to assert what the run loop does
   * while a request is in flight.
   */
  readonly gate?: (context: StubGateContext) => Promise<void> | void
}

/**
 * Thrown when the run loop issues more `useCoupon` calls than the script
 * describes.
 *
 * Repeating the last entry would silently hide an over-issuing loop, which is
 * exactly the defect Requirement 3.4 forbids, so exhaustion is a loud failure
 * instead. The over-issued request is still recorded in
 * {@link StubUpstreamClient.requests} before this throws, so a failing test can
 * show what was actually sent.
 */
export class StubScriptExhaustedError extends Error {
  constructor(
    readonly callIndex: number,
    readonly scriptLength: number
  ) {
    super(
      `StubUpstreamClient: useCoupon call #${callIndex} has no scripted entry ` +
        `(script holds ${scriptLength} ${
          scriptLength === 1 ? "entry" : "entries"
        }).`
    )
    this.name = "StubScriptExhaustedError"
  }
}

/** Default error thrown by a `{ kind: "throw" }` entry with no explicit error. */
export class StubScriptedThrowError extends Error {
  constructor(readonly callIndex: number) {
    super(`StubUpstreamClient: scripted throw on useCoupon call #${callIndex}.`)
    this.name = "StubScriptedThrowError"
  }
}

/** Script entry resolving with a body, as the Upstream_API would return it. */
export function respondWithBody(
  bodyText: string,
  status = 200,
  delayMs?: number
): StubScriptEntry {
  return {
    kind: "respond",
    response: { bodyText, status, transportFailure: null },
    ...(delayMs === undefined ? {} : { delayMs }),
  }
}

/** Script entry resolving with a transport failure and no body. */
export function respondWithTransportFailure(
  transportFailure: "timeout" | "network",
  delayMs?: number
): StubScriptEntry {
  return {
    kind: "respond",
    response: { bodyText: null, status: null, transportFailure },
    ...(delayMs === undefined ? {} : { delayMs }),
  }
}

/** Script entry rejecting, to exercise a run that fails mid-loop. */
export function throwOnCall(error?: Error, delayMs?: number): StubScriptEntry {
  return {
    kind: "throw",
    ...(error === undefined ? {} : { error }),
    ...(delayMs === undefined ? {} : { delayMs }),
  }
}

export class StubUpstreamClient implements UpstreamClient {
  readonly isMock: boolean

  readonly #script: readonly StubScriptEntry[]
  readonly #gate: StubUpstreamClientOptions["gate"]
  readonly #requests: UseCouponRequest[] = []
  #inFlight = 0
  #maxInFlight = 0

  constructor(options: StubUpstreamClientOptions = {}) {
    this.#script = options.script ?? []
    this.#gate = options.gate
    this.isMock = options.isMock ?? false
  }

  /** Every `useCoupon` request received, in call order. */
  get requests(): readonly UseCouponRequest[] {
    return this.#requests
  }

  /** Number of `useCoupon` calls received, including over-issued ones. */
  get callCount(): number {
    return this.#requests.length
  }

  /** `useCoupon` calls in flight right now. */
  get inFlight(): number {
    return this.#inFlight
  }

  /** Highest number of overlapping `useCoupon` calls observed so far. */
  get maxInFlight(): number {
    return this.#maxInFlight
  }

  /** Scripted entries not yet consumed. */
  get remainingScriptLength(): number {
    return Math.max(0, this.#script.length - this.#requests.length)
  }

  /** Clears the recordings; the script is fixed at construction. */
  reset(): void {
    this.#requests.length = 0
    this.#inFlight = 0
    this.#maxInFlight = 0
  }

  async useCoupon(req: UseCouponRequest): Promise<UpstreamRawResponse> {
    const callIndex = this.#requests.length
    this.#requests.push({ hiveid: req.hiveid, coupon: req.coupon })
    this.#inFlight += 1
    if (this.#inFlight > this.#maxInFlight) {
      this.#maxInFlight = this.#inFlight
    }

    try {
      // `.at` rather than `[]`: the tsconfig does not enable
      // noUncheckedIndexedAccess, so indexing would hide the exhausted case
      // from the type checker.
      const entry = this.#script.at(callIndex)
      if (entry === undefined) {
        throw new StubScriptExhaustedError(callIndex, this.#script.length)
      }

      if (this.#gate !== undefined) {
        await this.#gate({ callIndex, request: req, inFlight: this.#inFlight })
      }

      // Always yield at least once before settling. Without a suspension point
      // a synchronous resolve would return to the caller with `#inFlight` back
      // at 0, and two genuinely concurrent calls would look sequential to the
      // in-flight assertion of Property 7.
      await delay(entry.delayMs)

      if (entry.kind === "throw") {
        throw entry.error ?? new StubScriptedThrowError(callIndex)
      }
      return entry.response
    } finally {
      this.#inFlight -= 1
    }
  }
}

function delay(ms: number | undefined): Promise<void> {
  if (ms === undefined || ms <= 0) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
