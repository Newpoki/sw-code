/**
 * LiveUpstreamClient: the one place this application talks to the
 * Upstream_API (Requirements 3.3, 3.6, 7.11).
 *
 * `useCoupon` posts the five request fields to `${baseUrl}/useCoupon` — the
 * Fixed_Request_Fields `country=FR`, `lang=en`, `server=europe` plus the
 * per-Redemption_Run `hiveid` and `coupon` (Requirement 3.3) — and returns the
 * response body **unchanged**, as text, together with the HTTP status. The
 * Response_Parser therefore sees exactly the bytes that came off the wire, and
 * sees the same shape of input in Mock_Mode.
 *
 * ## Reads no fixture, ever
 *
 * This module imports nothing from `fixtures/` and touches no filesystem API on
 * any code path, including its failure paths (Requirement 7.11). That is
 * checked by a property test that instruments fixture file reads during a live
 * Redemption_Run and asserts the count is zero.
 *
 * ## One request, never a retry
 *
 * Every call issues exactly one `fetch`. A timeout and a network failure are
 * *returned*, as `transportFailure`, not thrown and not retried
 * (Requirements 3.4, 3.6). A rejection out of `useCoupon` would therefore be a
 * defect in this client rather than an upstream condition, so the two failure
 * modes are converted here and nowhere else.
 *
 * ## Body encoding
 *
 * The official event page submits a form, so the body is
 * `application/x-www-form-urlencoded`, built with `URLSearchParams`. That
 * keeps the payload trivially parseable on both sides: a captured `fetch` can
 * read the fields back with `new URLSearchParams(init.body)`, and a local test
 * server can echo them without a body parser.
 *
 * ## Injection points
 *
 * `baseUrl`, `fetch`, and `timeoutMs` are constructor options. The client reads
 * no configuration and no global state of its own: application wiring passes
 * `serverConfig.upstreamBaseUrl` in, tests pass a capturing `fetch` or a short
 * timeout in. The default timeout stays exactly the 10 seconds of
 * Requirement 3.6 ({@link UPSTREAM_TIMEOUT_MS}).
 */

import type {
  UpstreamClient,
  UpstreamRawResponse,
  UseCouponRequest,
} from "@/server/upstream/client"

/** The `useCoupon` endpoint path segment, appended to the base URL. */
export const USE_COUPON_PATH = "useCoupon"

/**
 * The 10-second limit of Requirement 3.6, applied to the single `useCoupon`
 * request issued for one Group_Member.
 */
export const UPSTREAM_TIMEOUT_MS = 10_000

/** Body encoding of a `useCoupon` request; the official page posts a form. */
export const USE_COUPON_CONTENT_TYPE =
  "application/x-www-form-urlencoded;charset=UTF-8"

/**
 * The Fixed_Request_Fields (Requirement 3.3). Constants of the application: a
 * Group_Member never supplies them, and no caller can vary them.
 */
export const FIXED_REQUEST_FIELDS = {
  country: "FR",
  lang: "en",
  server: "europe",
} as const

/**
 * The subset of `Response` this client uses. Narrow on purpose, so a test can
 * hand in a plain object; a real `Response` satisfies it.
 */
export interface UpstreamFetchResponse {
  readonly status: number
  text: () => Promise<string>
}

/** The request description this client passes to `fetch`. */
export interface UpstreamFetchInit {
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  /** URL-encoded form body; parse with `new URLSearchParams(body)`. */
  readonly body: string
  readonly signal: AbortSignal
}

/**
 * The `fetch` shape this client needs. The global `fetch` satisfies it, and so
 * does a capturing stand-in built by a test.
 */
export type UpstreamFetch = (
  url: string,
  init: UpstreamFetchInit
) => Promise<UpstreamFetchResponse>

export interface LiveUpstreamClientOptions {
  /** Upstream_API base URL, i.e. the resolved `UPSTREAM_BASE_URL`. */
  readonly baseUrl: string
  /** Replaces the global `fetch`. */
  readonly fetch?: UpstreamFetch
  /** Request limit in milliseconds. Defaults to {@link UPSTREAM_TIMEOUT_MS}. */
  readonly timeoutMs?: number
}

/**
 * Builds the endpoint URL, tolerating a base URL with or without a trailing
 * slash so a stray slash in the environment cannot produce `//useCoupon`.
 */
export function useCouponEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${USE_COUPON_PATH}`
}

/**
 * Builds the URL-encoded request body: the three Fixed_Request_Fields followed
 * by `hiveid` and `coupon`, in the order the API_Reference_Document lists them
 * (Requirement 3.3). Values are passed through verbatim — the Coupon_Code has
 * already been trimmed by the redemption endpoint and its letter case is
 * preserved.
 */
export function buildUseCouponBody(req: UseCouponRequest): string {
  return new URLSearchParams({
    country: FIXED_REQUEST_FIELDS.country,
    lang: FIXED_REQUEST_FIELDS.lang,
    server: FIXED_REQUEST_FIELDS.server,
    hiveid: req.hiveid,
    coupon: req.coupon,
  }).toString()
}

/** Reads a `name` property off an unknown value, defensively. */
function nameOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("name" in value)) {
    return null
  }
  const name: unknown = value.name
  return typeof name === "string" ? name : null
}

/**
 * Distinguishes the timeout from every other failure.
 *
 * `AbortSignal.timeout` rejects the `fetch` with a `TimeoutError`
 * `DOMException` on Node 22, but the rejection can also surface wrapped — a
 * `TypeError` whose `cause` carries the abort reason. The signal itself is the
 * reliable witness: it is created here and nothing else can abort it, so
 * `signal.aborted` alone already means the limit elapsed. The name checks cover
 * an injected `fetch` that reports an abort without touching the signal.
 */
function isTimeoutFailure(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) {
    return true
  }
  const name = nameOf(error)
  if (name === "TimeoutError" || name === "AbortError") {
    return true
  }
  const cause = error instanceof Error ? error.cause : null
  const causeName = nameOf(cause)
  return causeName === "TimeoutError" || causeName === "AbortError"
}

/**
 * The failure result. `bodyText` and `status` are null because no usable
 * response was received: a request that timed out, that never reached the
 * Upstream_API, or whose body could not be read has no body for the
 * Response_Parser to classify, which reports `TRANSPORT_ERROR` from
 * `transportFailure` alone (Requirement 4.6).
 */
function transportFailure(
  error: unknown,
  signal: AbortSignal
): UpstreamRawResponse {
  return {
    bodyText: null,
    status: null,
    transportFailure: isTimeoutFailure(error, signal) ? "timeout" : "network",
  }
}

/** The live Upstream_API client. Reads no fixture (Requirement 7.11). */
export class LiveUpstreamClient implements UpstreamClient {
  readonly isMock = false

  private readonly baseUrl: string
  private readonly fetchFn: UpstreamFetch
  private readonly timeoutMs: number

  constructor(options: LiveUpstreamClientOptions) {
    this.baseUrl = options.baseUrl
    this.fetchFn = options.fetch ?? ((url, init) => fetch(url, init))
    this.timeoutMs = options.timeoutMs ?? UPSTREAM_TIMEOUT_MS
  }

  /**
   * Issues the single `useCoupon` request for one Group_Member and resolves
   * with the raw outcome. Resolves for a timeout and for a network failure too;
   * it neither rejects nor retries on any path (Requirement 3.6).
   *
   * A non-2xx response is still a response: its body and status are returned
   * with `transportFailure: null`, and the Response_Parser classifies it.
   */
  async useCoupon(req: UseCouponRequest): Promise<UpstreamRawResponse> {
    const signal = AbortSignal.timeout(this.timeoutMs)

    let response: UpstreamFetchResponse
    try {
      response = await this.fetchFn(useCouponEndpoint(this.baseUrl), {
        method: "POST",
        headers: {
          "content-type": USE_COUPON_CONTENT_TYPE,
          accept: "application/json",
        },
        body: buildUseCouponBody(req),
        signal,
      })
    } catch (error) {
      return transportFailure(error, signal)
    }

    /*
     * The body can still fail to arrive after the headers did — the timeout
     * covers the whole exchange, and a connection can drop mid-body. That is
     * the same transport failure, not a response to parse.
     */
    let bodyText: string
    try {
      bodyText = await response.text()
    } catch (error) {
      return transportFailure(error, signal)
    }

    return { bodyText, status: response.status, transportFailure: null }
  }
}

/** Creates a live client. The factory of the wiring layer calls this. */
export function createLiveUpstreamClient(
  options: LiveUpstreamClientOptions
): LiveUpstreamClient {
  return new LiveUpstreamClient(options)
}
