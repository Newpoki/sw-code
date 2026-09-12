/**
 * The client-visible configuration surface (Requirements 7.4, 7.8, 8.10).
 *
 * One `createServerFn` read — {@link getAppConfig} — returning an
 * {@link Envelope} holding the Mock_Mode flag and nothing else. The root route
 * loader calls it once per document, and `MockModeBanner` and the result view
 * render the mock-data indicator from it.
 *
 * ## Why the projection is explicit
 *
 * `src/server/config.server.ts` reads the environment once at startup
 * (Requirements 7.5, 8.1), so this module performs no reading of its own: it
 * projects the already-resolved {@link ServerConfig} down to the single field
 * the Web_Client is allowed to see.
 *
 * That projection names `mockMode` literally rather than spreading or
 * re-exporting the config object. `ServerConfig` also carries
 * `upstreamBaseUrl`, `dataFile`, and `passphraseRequired` — none of which the
 * Mock_Mode indicator needs, and the last of which would tell an unauthorized
 * reader whether the Access_Gate is armed. A literal field list means a field
 * added to `ServerConfig` later cannot start crossing to the browser by
 * accident, which is the mechanical half of Requirement 8.10; the
 * Shared_Passphrase and the session key are the other half, and they never sit
 * on `ServerConfig` at all (they live behind the server-only accessors of
 * `ServerSecrets`).
 *
 * {@link appConfigEnvelope} is exported separately from the server function and
 * takes the configuration as a parameter, so the projection is directly
 * testable without booting the framework.
 */

import { createServerFn } from "@tanstack/react-start"

import { serverConfig } from "@/server/config.server"
import type { Envelope } from "@/domain/types"
import type { ClientConfig, ServerConfig } from "@/server/config.server"

/**
 * Projects the resolved configuration onto the envelope the Web_Client
 * receives: `{ mockMode }`, and nothing else (Requirements 7.4, 7.8, 8.10).
 *
 * A read, so `warnings` is always empty — nothing was written, so there is
 * nothing to warn about — and it cannot fail, so the envelope is always `ok`.
 *
 * The parameter is the `mockMode` field alone by type, so a caller may hand
 * over a whole {@link ServerConfig} while this function is unable to read any
 * other field of it.
 */
export function appConfigEnvelope(
  config: Pick<ServerConfig, "mockMode">
): Envelope<ClientConfig> {
  return { ok: true, data: { mockMode: config.mockMode }, warnings: [] }
}

/**
 * The Mock_Mode state of this process (Requirements 7.4, 7.8).
 *
 * A `GET`: it writes nothing and takes no caller-supplied value. The value was
 * read from the environment once at startup, so repeated calls within a process
 * return the same flag. The Access_Gate and the cross-site check are applied
 * globally in `src/start.ts`, so nothing here re-checks them.
 */
export const getAppConfig = createServerFn().handler(() =>
  appConfigEnvelope(serverConfig)
)
