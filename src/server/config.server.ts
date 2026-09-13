/**
 * Server configuration for shared-coupon-redemption.
 *
 * Every value here is read from the environment **on the server only**. This
 * module is named `.server.ts` so the build keeps it out of the browser bundle,
 * and nothing under `src/domain/` or `src/components/` may import it. The only
 * shape that may cross to the Web_Client is {@link ClientConfig}, produced by
 * {@link toClientConfig} and served by `src/functions/config.functions.ts`.
 *
 * Four secrets live behind a deliberate server-only accessor
 * ({@link ServerSecrets}) rather than on the config object itself: the
 * Shared_Passphrase, the session signing key, the Mongo_Connection_URI, and the
 * Clerk secret key. None of them appears in a returned value, a response body,
 * or a log line (Requirement 8.10 of `shared-coupon-redemption`, Requirements
 * 1.6 and 5.10 of `mongodb-google-auth-admin`). What `ServerConfig` carries
 * about them instead is booleans: `passphraseRequired`, `mongoConfigured`,
 * `mongoUriParsed`, and `clerkConfigured`.
 *
 * The Clerk publishable key is not a secret and is not read for its value here.
 * The `VITE_` prefix publishes it to the browser bundle, which is what a
 * publishable key is for, and the Clerk SDK reads it on both sides through
 * `import.meta.env`. This module tests only whether it is present, so the
 * sign-in control can be withheld when it is not.
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

import { parseAdminAllowlist } from "@/domain/accounts"

/** Default Upstream_API base URL; the app posts to `${base}/useCoupon`. */
export const DEFAULT_UPSTREAM_BASE_URL =
  "https://event.withhive.com/ci/smon/evt_coupon"

/** Default path of the JSON document holding Member_Registry and history. */
export const DEFAULT_DATA_FILE = "./data/store.json"

/** Name of the Mock_Mode environment variable, used in the warning it logs. */
export const MOCK_MODE_ENV_VAR = "MOCK_MODE"

/** Name of the Mongo_Connection_URI variable (Requirement 1.1). */
export const MONGODB_URI_ENV_VAR = "MONGODB_URI"

/** Name of the fallback database-name variable (Requirement 1.2). */
export const MONGODB_DB_NAME_ENV_VAR = "MONGODB_DB_NAME"

/**
 * Database name used when neither the URI path segment nor
 * {@link MONGODB_DB_NAME_ENV_VAR} supplies one (Requirement 1.2).
 */
export const DEFAULT_MONGO_DATABASE_NAME = "sw-code"

/**
 * Name of the Clerk publishable key variable. The `VITE_` prefix publishes it
 * to the browser bundle by design, which is what a publishable key is for, so
 * it is not a secret and its value is never held by this module.
 */
export const CLERK_PUBLISHABLE_KEY_ENV_VAR = "VITE_CLERK_PUBLISHABLE_KEY"

/** Name of the Clerk secret key variable (Requirement 5.10 restated). */
export const CLERK_SECRET_KEY_ENV_VAR = "CLERK_SECRET_KEY"

/** Name of the Admin_Allowlist variable (Requirements 6.1, 6.9). */
export const ADMIN_EMAILS_ENV_VAR = "ADMIN_EMAILS"

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
  /**
   * Whether `MONGODB_URI` held at least one character after trimming
   * (Requirements 1.1, 1.3). The URI itself is reachable only through
   * {@link ServerSecrets.readMongoUri}, so this boolean is what the rest of the
   * server may read: it discloses neither the credentials nor the host.
   *
   * A *usable* Mongo_Database configuration is `mongoConfigured &&
   * mongoUriParsed`; the two flags are kept apart because they select different
   * startup warnings, and because Requirements 1.3 and 1.10 answer store
   * operations with the same `MONGODB_URI`-naming message either way.
   */
  readonly mongoConfigured: boolean
  /**
   * The resolved database name (Requirement 1.2), or null when no URI is
   * configured at all. Resolution order: the URI path segment, then
   * `MONGODB_DB_NAME`, then {@link DEFAULT_MONGO_DATABASE_NAME}.
   */
  readonly mongoDatabaseName: string | null
  /**
   * False exactly when `MONGODB_URI` held at least one character after trimming
   * and did not parse as a MongoDB connection string (Requirement 1.10). True
   * when a URI parsed, and true when none was supplied — an absent variable is
   * the Requirement 1.3 condition, not a parse failure.
   */
  readonly mongoUriParsed: boolean
  /**
   * True exactly when both Clerk keys are present after trimming
   * (Requirement 5.2 restated). While false, the sign-in control is withheld
   * from every page and a request to start a sign-in is answered with a message
   * that names no key value.
   */
  readonly clerkConfigured: boolean
  /**
   * The Admin_Allowlist after the normalization of Requirement 6.1, possibly
   * empty (Requirement 6.2). Not a secret: it is a list of email addresses the
   * operator chose, and the Account_Role decision is made from it on the server
   * during every request (Requirement 6.8).
   */
  readonly adminAllowlist: readonly string[]
}

/**
 * The subset of the configuration the Web_Client is allowed to see
 * (Requirements 7.4, 7.8). Deliberately just the Mock_Mode flag.
 *
 * `mongoConfigured` is deliberately **not** projected here. The connection
 * indicator is an Admin_Page value, so it is served through the guarded admin
 * server function that reads the live pool state, not through the public config
 * read that any sender can call.
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
  /**
   * The trimmed Mongo_Connection_URI, or null when `MONGODB_URI` is absent or
   * blank.
   *
   * SERVER ONLY. Requirement 1.6: the URI and every part of it — credentials
   * and host included — appears in no response body, no log entry, and no value
   * delivered to the Web_Client. The only intended consumer is
   * `src/server/store/mongo.server.ts`, which passes the result straight into
   * the `MongoClient` constructor. Never log it, never interpolate it into a
   * message, never return it.
   */
  readMongoUri: () => string | null
  /**
   * The trimmed Clerk secret key, or null when `CLERK_SECRET_KEY` is absent or
   * blank.
   *
   * SERVER ONLY. Requirement 5.10 restated: excluded from every response body,
   * every log entry, and every value delivered to the Web_Client. The
   * publishable key is deliberately not here — it is published to the browser
   * by design and this module holds only {@link ServerConfig.clerkConfigured}
   * about it.
   */
  readClerkSecretKey: () => string | null
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

/**
 * The two schemes a MongoDB connection string may carry. Matched exactly, in
 * lower case, as the driver matches them.
 */
export const MONGODB_URI_SCHEMES = ["mongodb://", "mongodb+srv://"] as const

/** The parts of a connection string this module needs (Requirements 1.2, 1.10). */
export interface MongoConnectionStringParts {
  /** The matched scheme, including `://`. */
  readonly scheme: string
  /** The host list, credentials removed. Always at least one character. */
  readonly hosts: string
  /** The path segment after the host list, trimmed. Possibly empty. */
  readonly pathSegment: string
}

/** Index of the first occurrence of any of `characters`, or -1. */
function firstIndexOfAny(value: string, characters: readonly string[]): number {
  let found = -1
  for (const character of characters) {
    const index = value.indexOf(character)
    if (index !== -1 && (found === -1 || index < found)) {
      found = index
    }
  }
  return found
}

/**
 * Splits a Mongo_Connection_URI into the parts Requirements 1.2 and 1.10 turn
 * on, or returns null when the value does not parse as a connection string.
 *
 * Parsing is done by hand rather than with `new URL`, because `URL` rejects the
 * comma-separated multi-host form (`mongodb://a:27017,b:27017/db`) that a
 * replica-set URI carries: the second host reads as part of the port. It is
 * also done here rather than by constructing a `MongoClient`, so that startup
 * configuration stays free of the driver and Requirement 1.10's warning can be
 * decided before any pool is opened.
 *
 * A value parses when it carries one of {@link MONGODB_URI_SCHEMES} and at least
 * one host character after any credentials. Everything past that — options,
 * percent-encoding, `authSource` — is the driver's business; this module reads
 * only the database name and never rewrites the value it passes on.
 */
export function parseMongoConnectionString(
  raw: string
): MongoConnectionStringParts | null {
  const value = raw.trim()
  const scheme = MONGODB_URI_SCHEMES.find((candidate) =>
    value.startsWith(candidate)
  )
  if (scheme === undefined) {
    return null
  }

  const afterScheme = value.slice(scheme.length)
  /*
   * The authority runs to the first `/` (which starts the database name) or the
   * first `?` (which starts the options, for a URI carrying no database name).
   */
  const authorityEnd = firstIndexOfAny(afterScheme, ["/", "?"])
  const authority =
    authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd)

  /*
   * Credentials may themselves contain a percent-encoded `@`, so the host list
   * starts after the *last* `@` of the authority.
   */
  const credentialsEnd = authority.lastIndexOf("@")
  const hosts =
    credentialsEnd === -1 ? authority : authority.slice(credentialsEnd + 1)
  if (hosts.trim().length === 0) {
    return null
  }

  let pathSegment = ""
  if (authorityEnd !== -1 && afterScheme[authorityEnd] === "/") {
    const afterSlash = afterScheme.slice(authorityEnd + 1)
    const segmentEnd = firstIndexOfAny(afterSlash, ["/", "?"])
    pathSegment =
      segmentEnd === -1 ? afterSlash : afterSlash.slice(0, segmentEnd)
  }

  return { scheme, hosts, pathSegment: pathSegment.trim() }
}

/**
 * The database name for a Mongo_Connection_URI (Requirement 1.2), resolved in
 * the order the requirement states: the trimmed path segment of the URI, else
 * the trimmed `MONGODB_DB_NAME` value, else {@link DEFAULT_MONGO_DATABASE_NAME}.
 *
 * Total: a URI that does not parse simply supplies no path segment, so the
 * resolution falls through to the variable and then to the default rather than
 * failing. Exported because it is the whole of the rule, so the property test
 * can exercise it directly over generated connection strings.
 */
export function resolveDatabaseName(
  uri: string,
  envDbName: string | undefined
): string {
  const fromUri = parseMongoConnectionString(uri)?.pathSegment ?? ""
  if (fromUri.length > 0) {
    return fromUri
  }

  const fromEnv = (envDbName ?? "").trim()
  if (fromEnv.length > 0) {
    return fromEnv
  }

  return DEFAULT_MONGO_DATABASE_NAME
}

/**
 * The one warning logged when no Mongo_Connection_URI is configured
 * (Requirement 1.3). It names the variable and states the consequence; there is
 * no value to disclose.
 */
export const NO_MONGODB_URI_WARNING =
  `${MONGODB_URI_ENV_VAR} is not set: no Mongo_Database is configured. ` +
  `Startup completes, but every roster read, roster write, ` +
  `Redemption_History read, and Redemption_History write answers with an ` +
  `error naming ${MONGODB_URI_ENV_VAR}. Set ${MONGODB_URI_ENV_VAR} to a ` +
  `MongoDB connection string.`

/**
 * The one warning logged when `MONGODB_URI` held characters that did not parse
 * as a connection string (Requirement 1.10).
 *
 * It names the variable and **no part of the value**: the value carries the
 * credentials and the host, which Requirement 1.6 excludes from every log
 * entry. That is why this is a constant rather than a function of the value —
 * there is no parameter to leak.
 */
export const UNPARSABLE_MONGODB_URI_WARNING =
  `${MONGODB_URI_ENV_VAR} did not parse as a MongoDB connection string. ` +
  `Startup completes and no connection pool is opened, so every roster read, ` +
  `roster write, Redemption_History read, and Redemption_History write ` +
  `answers with an error naming ${MONGODB_URI_ENV_VAR}. Expected a value ` +
  `starting with ${MONGODB_URI_SCHEMES.join(" or ")} and naming at least one ` +
  `host. The rejected value is not logged, because it carries credentials.`

/**
 * The one warning logged when a Clerk key is missing (Requirement 5.2
 * restated). It names each missing variable and no value of either.
 */
export function missingClerkKeysWarning(
  missingVariables: readonly string[]
): string {
  return (
    `${missingVariables.join(" and ")} ` +
    `${missingVariables.length === 1 ? "is" : "are"} not set: Google sign-in ` +
    `is unavailable. Startup completes, the sign-in control is withheld from ` +
    `every page, and an attempt to sign in is answered with a message that ` +
    `names no key value.`
  )
}

/**
 * The one startup warning logged when the Admin_Allowlist is empty
 * (Requirement 6.9). Logged during startup only, never per request.
 */
export const EMPTY_ADMIN_ALLOWLIST_WARNING =
  `${ADMIN_EMAILS_ENV_VAR} yields an empty Admin_Allowlist: the Admin_Page is ` +
  `reachable by no account. Every signed-in account is stored with the ` +
  `Member_Role. Set ${ADMIN_EMAILS_ENV_VAR} to a comma-separated list of ` +
  `email addresses.`

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

  /*
   * Requirement 1.1: `MONGODB_URI` is read here, once per process, and this
   * local is the only binding of its value. It reaches `ServerConfig` as two
   * booleans and a database name, and callers that genuinely need the string
   * take it from `readMongoUri()` (Requirement 1.6).
   */
  const mongoUri = readTrimmed(env, MONGODB_URI_ENV_VAR)
  const mongoUriParsed =
    mongoUri === null || parseMongoConnectionString(mongoUri) !== null
  if (mongoUri === null) {
    logger.warn(NO_MONGODB_URI_WARNING)
  } else if (!mongoUriParsed) {
    logger.warn(UNPARSABLE_MONGODB_URI_WARNING)
  }

  /*
   * Requirement 5.2 restated. The publishable key is tested for presence and
   * the value is discarded in the same expression: `clerkConfigured` is the only
   * thing this module holds about it, because the `VITE_` prefix already
   * publishes it to the browser and nothing on the server needs to read it.
   */
  const clerkPublishableKeyPresent =
    readTrimmed(env, CLERK_PUBLISHABLE_KEY_ENV_VAR) !== null
  const clerkSecretKey = readTrimmed(env, CLERK_SECRET_KEY_ENV_VAR)
  const missingClerkKeys = [
    ...(clerkPublishableKeyPresent ? [] : [CLERK_PUBLISHABLE_KEY_ENV_VAR]),
    ...(clerkSecretKey === null ? [CLERK_SECRET_KEY_ENV_VAR] : []),
  ]
  if (missingClerkKeys.length > 0) {
    logger.warn(missingClerkKeysWarning(missingClerkKeys))
  }

  /*
   * Requirement 6.1's normalization lives in `src/domain/accounts.ts` so it can
   * be exercised without a process environment; this module only reads the
   * variable and warns about an empty result (Requirement 6.9).
   */
  const adminAllowlist = parseAdminAllowlist(env[ADMIN_EMAILS_ENV_VAR])
  if (adminAllowlist.length === 0) {
    logger.warn(EMPTY_ADMIN_ALLOWLIST_WARNING)
  }

  const config: ServerConfig = {
    mockMode: mockMode.enabled,
    upstreamBaseUrl:
      readTrimmed(env, "UPSTREAM_BASE_URL") ?? DEFAULT_UPSTREAM_BASE_URL,
    dataFile: readTrimmed(env, "DATA_FILE") ?? DEFAULT_DATA_FILE,
    passphraseRequired: passphrase !== null,
    mongoConfigured: mongoUri !== null,
    mongoDatabaseName:
      mongoUri === null
        ? null
        : resolveDatabaseName(mongoUri, env[MONGODB_DB_NAME_ENV_VAR]),
    mongoUriParsed,
    clerkConfigured: clerkPublishableKeyPresent && clerkSecretKey !== null,
    adminAllowlist,
  }

  const secrets: ServerSecrets = {
    readSharedPassphrase: () => passphrase,
    readSessionSecret: () => sessionSecret,
    readMongoUri: () => mongoUri,
    readClerkSecretKey: () => clerkSecretKey,
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
