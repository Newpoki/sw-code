/**
 * Server configuration for shared-coupon-redemption.
 *
 * Every value here is read from the environment **on the server only**. This
 * module is named `.server.ts` so the build keeps it out of the browser bundle,
 * and nothing under `src/domain/` or `src/components/` may import it. The only
 * shape that may cross to the Web_Client is {@link ClientConfig}, produced by
 * {@link toClientConfig} and served by `src/functions/config.functions.ts`.
 *
 * Two secrets live behind a deliberate server-only accessor
 * ({@link ServerSecrets}) rather than on the config object itself: the
 * Shared_Passphrase and the session signing key. The Shared_Passphrase appears
 * in no returned value, no response body, and no log line (Requirement 8.10).
 *
 * Reading happens once per process (Requirements 7.5, 8.1) through the
 * {@link serverConfig} / {@link serverSecrets} singletons.
 * {@link resolveConfig} takes the environment record and the logger as
 * parameters so the same code path is exercised by tests without mutating
 * `process.env` or capturing global console output.
 *
 * Note on `.env`: this module reads whatever the runtime has already placed in
 * the environment. Populating it from a `.env` file is the runtime's job (for
 * example `node --env-file=.env`, the dev server, or the container runtime).
 */

import { randomBytes } from "node:crypto"
import process from "node:process"

/** Default Upstream_API base URL; the app posts to `${base}/useCoupon`. */
export const DEFAULT_UPSTREAM_BASE_URL =
  "https://event.withhive.com/ci/smon/evt_coupon"

/** Default path of the JSON document holding Member_Registry and history. */
export const DEFAULT_DATA_FILE = "./data/store.json"

/** Name of the Mock_Mode environment variable, used in the warning it logs. */
export const MOCK_MODE_ENV_VAR = "MOCK_MODE"

/** Number of random bytes used for a per-process session signing key. */
const GENERATED_SESSION_SECRET_BYTES = 32

/**
 * An environment record. Structurally compatible with `process.env`, and easy
 * for a test to build literally.
 */
export type EnvRecord = Readonly<Record<string, string | undefined>>

/** The sink for startup warnings. Injected so tests can capture them. */
export interface ConfigLogger {
  warn: (message: string) => void
}

/**
 * Configuration that is safe to hold in server-side memory and to pass around
 * the Redemption_Server. It holds **no secret**, so logging or serializing it
 * by accident cannot leak the Shared_Passphrase or the session key.
 */
export interface ServerConfig {
  /** Mock_Mode state, decided once at startup (Requirements 7.5, 7.7). */
  readonly mockMode: boolean
  /** Upstream_API base URL (`UPSTREAM_BASE_URL`). */
  readonly upstreamBaseUrl: string
  /** Path of the persistence document (`DATA_FILE`). */
  readonly dataFile: string
  /**
   * Whether the Access_Gate demands a Session. False when `APP_PASSPHRASE` is
   * absent or whitespace-only, in which case every request is admitted and
   * startup has logged a prominent warning (Requirement 8.9).
   *
   * This boolean is the *only* passphrase-derived value in this object: it
   * discloses neither the passphrase nor its length.
   */
  readonly passphraseRequired: boolean
}

/**
 * The subset of the configuration the Web_Client is allowed to see
 * (Requirements 7.4, 7.8). Deliberately just the Mock_Mode flag.
 */
export interface ClientConfig {
  readonly mockMode: boolean
}

/**
 * Server-only secret accessors.
 *
 * **Never returned to the Web_Client, never logged, never embedded in a
 * response body.** The only intended consumer is `src/server/auth.server.ts`,
 * which needs the Shared_Passphrase to run a constant-time comparison
 * (Requirement 8.6) and the session key to sign the session cookie.
 *
 * These are functions rather than properties on purpose: a secret that is
 * fetched by an explicit, obviously-named call is harder to spread into a
 * response object than one that sits on a field.
 */
export interface ServerSecrets {
  /**
   * The Shared_Passphrase, or null when the Access_Gate is off.
   *
   * SERVER ONLY. Pass the result straight into the constant-time comparison;
   * do not store it, return it, or log it.
   */
  readSharedPassphrase: () => string | null
  /**
   * The session cookie signing key.
   *
   * SERVER ONLY. When `SESSION_SECRET` is absent or whitespace-only this is a
   * fresh random key generated for this process, so existing Sessions stop
   * being valid after a restart.
   */
  readSessionSecret: () => string
}

/** The full result of reading the environment once. */
export interface ResolvedConfig {
  /** Secret-free configuration. */
  readonly config: ServerConfig
  /** Server-only secret accessors. */
  readonly secrets: ServerSecrets
  /** Whether the session key was generated because none was supplied. */
  readonly sessionSecretGenerated: boolean
}

/** The outcome of interpreting one raw `MOCK_MODE` value. */
export interface MockModeParse {
  /** True exactly when the trimmed value equals `true`, ignoring case. */
  readonly enabled: boolean
  /**
   * The raw value when it matched neither `true` nor `false` and was not
   * whitespace-only, otherwise null. A non-null value means Mock_Mode is
   * disabled *and* a warning is due (Requirement 7.7).
   */
  readonly unrecognizedValue: string | null
}

/**
 * Interprets a raw `MOCK_MODE` value (Requirements 7.5, 7.7).
 *
 * - trimmed `true`, any letter case ⇒ enabled
 * - trimmed `false`, any letter case ⇒ disabled, recognized, silent
 * - absent or whitespace-only ⇒ disabled, silent
 * - anything else ⇒ disabled, and the value is reported for the warning
 *
 * Exported because it is the whole of the parsing rule: the property test can
 * exercise it directly over arbitrary strings.
 */
export function parseMockMode(raw: string | undefined): MockModeParse {
  if (raw === undefined) {
    return { enabled: false, unrecognizedValue: null }
  }
  const trimmed = raw.trim()
  if (trimmed === "") {
    return { enabled: false, unrecognizedValue: null }
  }
  const normalized = trimmed.toLowerCase()
  if (normalized === "true") {
    return { enabled: true, unrecognizedValue: null }
  }
  if (normalized === "false") {
    return { enabled: false, unrecognizedValue: null }
  }
  return { enabled: false, unrecognizedValue: raw }
}

/**
 * The warning logged for an unrecognized `MOCK_MODE` value. It names the
 * variable and quotes the rejected value, and startup continues with Mock_Mode
 * disabled (Requirement 7.7).
 */
export function unrecognizedMockModeWarning(rawValue: string): string {
  return (
    `${MOCK_MODE_ENV_VAR}: rejected value ${JSON.stringify(rawValue)} ` +
    `— expected "true" or "false" (case-insensitive). ` +
    `Mock_Mode is disabled and startup continues.`
  )
}

/**
 * The prominent warning logged when no Shared_Passphrase is configured
 * (Requirement 8.9). It states the consequence and never mentions a value,
 * because there is none.
 */
export const NO_PASSPHRASE_WARNING =
  "APP_PASSPHRASE is not set: the Redemption_App is reachable WITHOUT a " +
  "Shared_Passphrase. Every request is admitted without a Session, so anyone " +
  "who can reach this port can read the roster and spend coupons. Set " +
  "APP_PASSPHRASE, or keep the process bound to a private network."

/** Reads a variable, trimmed, treating whitespace-only as absent. */
function readTrimmed(env: EnvRecord, name: string): string | null {
  const raw = env[name]
  if (raw === undefined) {
    return null
  }
  const trimmed = raw.trim()
  return trimmed === "" ? null : trimmed
}

/**
 * Reads the whole configuration from `env`, logging any startup warning to
 * `logger`. Pure with respect to the process: it mutates nothing and reads no
 * global state other than generating a session key when none is supplied.
 *
 * Requirements 7.5, 7.7, 8.1, 8.9, 8.10.
 */
export function resolveConfig(
  env: EnvRecord,
  logger: ConfigLogger = console
): ResolvedConfig {
  const mockMode = parseMockMode(env[MOCK_MODE_ENV_VAR])
  if (mockMode.unrecognizedValue !== null) {
    logger.warn(unrecognizedMockModeWarning(mockMode.unrecognizedValue))
  }

  /*
   * Leading and trailing whitespace is removed before the value becomes the
   * Shared_Passphrase, which matches the trimmed emptiness test of
   * Requirements 8.2 and 8.9 and avoids a passphrase that nobody can type
   * because a `.env` line carried a stray space.
   */
  const passphrase = readTrimmed(env, "APP_PASSPHRASE")
  if (passphrase === null) {
    logger.warn(NO_PASSPHRASE_WARNING)
  }

  const suppliedSessionSecret = readTrimmed(env, "SESSION_SECRET")
  const sessionSecret =
    suppliedSessionSecret ??
    randomBytes(GENERATED_SESSION_SECRET_BYTES).toString("hex")

  const config: ServerConfig = {
    mockMode: mockMode.enabled,
    upstreamBaseUrl:
      readTrimmed(env, "UPSTREAM_BASE_URL") ?? DEFAULT_UPSTREAM_BASE_URL,
    dataFile: readTrimmed(env, "DATA_FILE") ?? DEFAULT_DATA_FILE,
    passphraseRequired: passphrase !== null,
  }

  const secrets: ServerSecrets = {
    readSharedPassphrase: () => passphrase,
    readSessionSecret: () => sessionSecret,
  }

  return {
    config,
    secrets,
    sessionSecretGenerated: suppliedSessionSecret === null,
  }
}

/** Projects the server configuration down to what the Web_Client may see. */
export function toClientConfig(config: ServerConfig): ClientConfig {
  return { mockMode: config.mockMode }
}

/** The single read of the environment for this process (startup). */
const resolved = resolveConfig(process.env)

/**
 * The process-wide, secret-free configuration, read once at startup
 * (Requirements 7.5, 8.1).
 */
export const serverConfig: ServerConfig = resolved.config

/**
 * The process-wide secret accessors. Import this **only** from server modules
 * that must compare or sign; never include its values in a response.
 */
export const serverSecrets: ServerSecrets = resolved.secrets

/**
 * True when no `SESSION_SECRET` was supplied and a per-process key was
 * generated, which means Sessions do not survive a restart.
 */
export const sessionSecretGenerated: boolean = resolved.sessionSecretGenerated

/** The Mock_Mode projection served to the Web_Client (Requirements 7.4, 7.8). */
export const clientConfig: ClientConfig = toClientConfig(serverConfig)
