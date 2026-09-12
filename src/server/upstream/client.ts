/**
 * The Upstream_API client boundary.
 *
 * This module declares types only, so it stays free of server-only imports and
 * can be referenced from tests without pulling in `fetch`, the fixtures, or the
 * configuration. Two implementations satisfy the interface, and exactly one is
 * selected at startup from the Mock_Mode state (Requirement 7.5):
 * `LiveUpstreamClient` (`live.server.ts`), which never reads a fixture
 * (Requirement 7.11), and `MockUpstreamClient` (`mock.server.ts`), which never
 * calls `fetch` (Requirement 7.3).
 *
 * The interface deliberately declares **no `checkUser` method**. The official
 * event page performs `checkUser` before `useCoupon`; this application skips it,
 * so every processed Group_Member costs exactly one upstream request
 * (Requirement 3.4). Because the method does not exist on the boundary, no
 * caller can issue that request by accident.
 */

/**
 * The caller-supplied part of a `useCoupon` request. The Fixed_Request_Fields
 * (`country=FR`, `lang=en`, `server=europe`) are not part of this shape: they
 * are constants owned by the implementation, never values a caller can vary
 * (Requirement 3.3).
 *
 * Field names match the Upstream_API wire names, hence `hiveid` rather than
 * `hiveId`.
 */
export interface UseCouponRequest {
  readonly hiveid: string
  readonly coupon: string
}

/**
 * The raw outcome of one `useCoupon` request.
 *
 * The boundary returns the **unparsed body text** rather than a decoded object,
 * so the Response_Parser observes byte-identical input in Mock_Mode and in live
 * mode. That is what makes Mock_Mode a faithful stand-in for the Upstream_API.
 */
export interface UpstreamRawResponse {
  /** Raw body text, or null when no body was received (timeout, network error). */
  readonly bodyText: string | null
  /** HTTP status code, or null when no response was received at all. */
  readonly status: number | null
  /**
   * Set when the request never produced a usable response. A timeout is the
   * 10-second limit of Requirement 3.6 elapsing; neither failure is ever
   * retried.
   */
  readonly transportFailure: "timeout" | "network" | null
}

/**
 * The single upstream capability the Redemption_Server needs.
 *
 * `isMock` is read once per Redemption_Run to mark the Redemption_History record
 * (Requirement 7.9) and to drive the client-facing Mock_Mode indicator
 * (Requirements 7.4, 7.8).
 *
 * `useCoupon` resolves for every observable upstream behaviour, including a
 * timeout and a network failure, which it reports through
 * {@link UpstreamRawResponse.transportFailure} rather than by rejecting. A
 * rejection therefore signals a defect in the client itself, not an upstream
 * condition.
 */
export interface UpstreamClient {
  readonly isMock: boolean
  /**
   * Declared as a function property rather than a shorthand method so the
   * repository's `method-signature-style` lint rule is satisfied and the
   * parameter is checked contravariantly. A class method satisfies it.
   */
  useCoupon: (req: UseCouponRequest) => Promise<UpstreamRawResponse>
}
