/**
 * The Upstream_API client factory: the single place where Mock_Mode decides
 * which implementation the Redemption_Server talks to (Requirements 7.5, 7.11).
 *
 * ## Selected once, not per request
 *
 * `MOCK_MODE` is read exactly once per process by `config.server.ts`
 * (Requirement 7.5), and this module turns that one boolean into one client
 * instance held for the life of the process ({@link getUpstreamClient}). No code
 * path re-reads the environment, and nothing chooses an implementation per
 * request, so a Redemption_Run cannot switch sources halfway through: every
 * Member_Outcome of a run comes from the same source, and the
 * Redemption_History `mock` flag that {@link UpstreamClient.isMock} feeds
 * (Requirement 7.9) describes the whole record truthfully.
 *
 * ## When Mock_Mode is disabled, no fixture is reachable
 *
 * With `mockMode: false` the factory constructs {@link LiveUpstreamClient} and
 * never touches `MockUpstreamClient`, so no fixture path is resolved, no fixture
 * is read, and nothing is added to the fixture cache — on the success path and
 * on the failure paths alike (Requirement 7.11). {@link checkUpstreamFixtures}
 * keeps that true for the pre-flight check as well: it is a no-op for any client
 * that is not a `MockUpstreamClient`.
 *
 * ## Shape of the module
 *
 * Deliberately the same seam the stores use
 * (`getJsonStore` / `setJsonStore` / `resetJsonStore`):
 *
 * - {@link createUpstreamClient} is pure — it reads no global state and takes
 *   the Mock_Mode flag and the base URL as parameters, so a test can build
 *   either implementation without touching `process.env`.
 * - {@link getUpstreamClient} is the lazy process-wide singleton, built from
 *   {@link serverConfig} on first use. Lazy on purpose: importing this module
 *   must not open a socket, resolve a fixture directory, or otherwise act.
 * - {@link setUpstreamClient} installs a client, which is how application
 *   wiring passes explicit options and how an integration test installs a stub.
 * - {@link resetUpstreamClient} drops the singleton so the next call rebuilds
 *   it.
 */

import { createLiveUpstreamClient } from "@/server/upstream/live.server"
import {
  MockUpstreamClient,
  createMockUpstreamClient,
} from "@/server/upstream/mock.server"
import { serverConfig } from "@/server/config.server"

import type {
  LiveUpstreamClient,
  UpstreamFetch,
} from "@/server/upstream/live.server"
import type { MockFixtureCheck } from "@/server/upstream/mock.server"
import type { ServerConfig } from "@/server/config.server"
import type { UpstreamClient } from "@/server/upstream/client"

/**
 * The part of {@link ServerConfig} the selection depends on. Narrowed so a test
 * can pass a two-field literal, and so the factory cannot come to depend on a
 * secret-adjacent field such as `passphraseRequired`.
 */
export type UpstreamClientConfig = Pick<
  ServerConfig,
  "mockMode" | "upstreamBaseUrl"
>

/**
 * The precise result of the selection.
 *
 * Both members declare `isMock` as a literal type, so `client.isMock` narrows
 * this union: a caller that needs a Mock_Mode-only capability can reach it
 * without a cast.
 */
export type SelectedUpstreamClient = MockUpstreamClient | LiveUpstreamClient

export interface UpstreamClientOptions {
  /**
   * Fixture directory for Mock_Mode. Ignored when Mock_Mode is disabled, so it
   * cannot cause a fixture read in live mode (Requirement 7.11).
   */
  readonly fixtureDir?: string
  /** Replaces the global `fetch` in live mode. Ignored in Mock_Mode. */
  readonly fetch?: UpstreamFetch
  /** Live request limit in milliseconds. Defaults to the 10 seconds of Requirement 3.6. */
  readonly timeoutMs?: number
}

/**
 * Builds the client the given Mock_Mode state calls for (Requirement 7.5).
 *
 * Pure: it reads no environment variable and no module-level state, and it
 * performs no I/O — neither implementation touches the network or the
 * filesystem until `useCoupon` is called.
 */
export function createUpstreamClient(
  config: UpstreamClientConfig,
  options: UpstreamClientOptions = {}
): SelectedUpstreamClient {
  if (config.mockMode) {
    return createMockUpstreamClient({ fixtureDir: options.fixtureDir })
  }
  return createLiveUpstreamClient({
    baseUrl: config.upstreamBaseUrl,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
  })
}

let selectedClient: UpstreamClient | null = null

/**
 * The process-wide Upstream_API client, created on first use from the Mock_Mode
 * state that `config.server.ts` read at startup (Requirement 7.5).
 *
 * The first call decides the implementation and every later call returns that
 * same instance, so `isMock` is a fixed property of the process: the
 * Redemption_History flag (Requirement 7.9) and the client-facing indicator
 * (Requirements 7.4, 7.8) cannot disagree with the source a run actually used.
 *
 * Typed as {@link UpstreamClient} rather than {@link SelectedUpstreamClient}
 * because {@link setUpstreamClient} may install a test stub. Call
 * {@link createUpstreamClient} directly when the narrower type is wanted.
 */
export function getUpstreamClient(): UpstreamClient {
  selectedClient ??= createUpstreamClient(serverConfig)
  return selectedClient
}

/**
 * Installs the process-wide client. Overrides whatever was created before.
 *
 * Used by application wiring that needs to pass explicit options (an absolute
 * fixture directory, say) and by integration tests that install a stub.
 */
export function setUpstreamClient(client: UpstreamClient): void {
  selectedClient = client
}

/** Drops the process-wide client so the next `getUpstreamClient()` rebuilds it. */
export function resetUpstreamClient(): void {
  selectedClient = null
}

/**
 * The Mock_Mode pre-flight check, bound to whichever client is in use.
 *
 * For a {@link MockUpstreamClient} this verifies that all three fixtures are
 * present and parseable, so an unusable fixture ends a redemption request before
 * any Member_Outcome exists and before any Redemption_History record is appended
 * (Requirements 7.6, 7.10).
 *
 * For every other client — the live one, or a stub — it reports success without
 * looking at the filesystem, because such a client serves no fixture
 * (Requirement 7.11).
 */
export function checkUpstreamFixtures(
  client: UpstreamClient
): Promise<MockFixtureCheck> {
  return client instanceof MockUpstreamClient
    ? client.checkFixtures()
    : Promise.resolve({ ok: true })
}
