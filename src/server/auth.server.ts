/**
 * The Access_Gate mechanics: session cookie signing and verification, the
 * constant-time Shared_Passphrase comparison, and the per-sender failed-attempt
 * throttle (Requirements 8.4, 8.5, 8.6, 8.7, 8.8, 8.10).
 *
 * This module is deliberately HTTP-shaped only at its edges. Everything it
 * exports is either a pure function over strings or a factory whose clock,
 * secret accessor, throttle, and session registry are injected, so the whole
 * gate can be exercised in the node test project without a server, a socket, or
 * a sleep. Cookies cross the boundary as `Cookie:` / `Set-Cookie:` **strings**:
 * `src/start.ts` (the global request middleware) and the `/login` route attach
 * them to real requests and responses.
 *
 * ## What never leaves this module
 *
 * The Shared_Passphrase is read through {@link ServerSecrets.readSharedPassphrase}
 * at the moment of a comparison and is never stored on an outcome, never
 * embedded in a message, and never logged — this module contains no logging call
 * at all (Requirement 8.10). Every failure message is a module-level constant,
 * so no code path can build a message out of the submitted or expected value.
 *
 * ## Requirement 8.6: why both values are hashed
 *
 * `timingSafeEqual` needs two buffers of equal length, and a raw comparison of
 * the two values would both leak the expected length and (via the length check
 * that would have to precede it) leak whether the lengths match. Hashing BOTH
 * the submitted value and the Shared_Passphrase to a 32-byte HMAC-SHA-256
 * digest, keyed with the session signing key, and comparing the digests solves
 * all of it: the digests are always the same size, the comparison duration does
 * not depend on the number of leading characters the two values share
 * (Requirement 8.6), and nothing in the timing or the response discloses the
 * passphrase length (Requirement 8.5). Keying the digest with a server-side
 * secret also denies an attacker an offline dictionary of digests.
 *
 * ## Requirement 8.7: why sessions are tracked server-side
 *
 * A signed cookie alone cannot be invalidated — clearing it in the browser
 * leaves a captured copy working until it expires, and Requirement 8.7 demands
 * that every subsequent request carrying an ended Session be rejected. So a
 * session id is minted per login and recorded in an in-memory
 * {@link SessionRegistry}; verification requires the id to still be present, and
 * logout removes it. Consequence, by design: the registry lives in process
 * memory, so a restart ends every Session even when `SESSION_SECRET` is
 * supplied. For a single-process, self-hosted app that is the right trade —
 * "restart logs everyone out" is a feature, and it keeps the gate free of a
 * session table.
 *
 * ## `Secure` and localhost
 *
 * The session cookie is issued `HttpOnly`, `SameSite=Strict`, `Secure`, `Path=/`
 * by default. `Secure` means the browser withholds the cookie over plain HTTP,
 * so a deployment served over `http://localhost` or `http://192.168.x.x` cannot
 * hold a Session with the default. That is why {@link SessionCookieOptions.secure}
 * exists: wiring may set it to `false` for an HTTP-only deployment, accepting
 * that the cookie then travels in the clear. The default stays `true`.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto"

import { serverSecrets } from "@/server/config.server"

/** Name of the session cookie. */
export const SESSION_COOKIE_NAME = "scr_session"

/** Path attribute of the session cookie: the gate covers the whole app. */
export const SESSION_COOKIE_PATH = "/"

/** How long an issued Session stays valid. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000

/** Incorrect submissions from one sender that arm the block (Requirement 8.8). */
export const FAILED_ATTEMPT_LIMIT = 10

/** Window the {@link FAILED_ATTEMPT_LIMIT} failures must fall inside. */
export const FAILED_ATTEMPT_WINDOW_MS = 5 * 60 * 1000

/**
 * How long a block lasts (Requirement 8.8 asks for at least 5 minutes). Every
 * submission that arrives while the block is active — correct or not — restarts
 * this timer, so hammering a blocked sender only extends the block. See
 * {@link createAttemptThrottle}.
 */
export const THROTTLE_BLOCK_MS = 5 * 60 * 1000

/**
 * The one message an incorrect submission produces (Requirement 8.5).
 *
 * It states that the passphrase is incorrect and nothing else: not which
 * characters differ, not how many, and not the length of the Shared_Passphrase.
 * Exported so the login route, the client, and the tests assert the same
 * sentence.
 */
export const INCORRECT_PASSPHRASE_MESSAGE = "The passphrase is incorrect."

/**
 * The message a submission from a blocked sender produces (Requirement 8.8).
 *
 * It names the wait, not the passphrase, and it is returned for a correct value
 * as well, so it cannot be used as an oracle for whether the submitted value was
 * right.
 */
export const THROTTLED_MESSAGE =
  "Too many incorrect passphrase attempts. Wait 5 minutes and try again."

/**
 * The message the login route shows when no Shared_Passphrase is configured, in
 * which case the gate is off and there is nothing to submit (Requirement 8.9).
 */
export const GATE_DISABLED_MESSAGE =
  "This deployment is running without a Shared_Passphrase, so no sign-in is needed."

/**
 * The message a request without a valid Session receives, which directs the
 * sender to submit the Shared_Passphrase (Requirement 8.3). It holds no
 * Member_Registry value, no Redemption_History value, and no character of the
 * passphrase.
 */
export const SESSION_REQUIRED_MESSAGE =
  "This application is protected by a shared passphrase. Submit it at /login to continue."

/** Route the {@link SESSION_REQUIRED_MESSAGE} points at. */
export const LOGIN_PATH = "/login"

/** The verified content of a session cookie. */
export interface SessionPayload {
  /** Opaque session id, tracked by the {@link SessionRegistry} for logout. */
  readonly id: string
  /** Epoch milliseconds the Session was issued at. */
  readonly issuedAt: number
  /** Epoch milliseconds the Session stops being valid at. */
  readonly expiresAt: number
}

/** Why {@link verifySessionToken} accepted or refused a token. */
export type TokenVerification =
  | { readonly kind: "valid"; readonly session: SessionPayload }
  /** Not two dot-separated segments, or a payload that is not a session. */
  | { readonly kind: "malformed" }
  /** Signature does not match the payload under the signing key. */
  | { readonly kind: "tampered" }
  /** Signature is good but `expiresAt` has passed. */
  | { readonly kind: "expired" }

/** Why the Access_Gate accepted or refused a `Cookie:` header. */
export type SessionVerification =
  | { readonly kind: "valid"; readonly session: SessionPayload }
  /** No session cookie at all. */
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | { readonly kind: "tampered" }
  | { readonly kind: "expired" }
  /** Signed, unexpired, but the Session was ended (Requirement 8.7). */
  | { readonly kind: "revoked" }

/** State of one sender's failed-attempt record. */
export interface ThrottleStatus {
  /** True while every submission from this sender must be refused. */
  readonly blocked: boolean
  /** Failures inside the {@link FAILED_ATTEMPT_WINDOW_MS} window. */
  readonly failures: number
  /** Milliseconds until the block lifts; 0 when not blocked. */
  readonly retryAfterMs: number
}

/** The per-sender failed-attempt store (Requirement 8.8). */
export interface AttemptThrottle {
  /** Current state of `sender` at `nowMs`, recording nothing. */
  readonly status: (sender: string, nowMs: number) => ThrottleStatus
  /** Counts one refused submission and returns the resulting state. */
  readonly recordFailure: (sender: string, nowMs: number) => ThrottleStatus
  /** Forgets one sender's record, as a successful login does. */
  readonly clear: (sender: string) => void
  /** Forgets every record. */
  readonly reset: () => void
}

/** The server-side record of which Sessions are still live (Requirement 8.7). */
export interface SessionRegistry {
  /** Records `id` as live until `expiresAt`. */
  readonly activate: (id: string, expiresAt: number) => void
  /** True when `id` is live and unexpired at `nowMs`. */
  readonly isActive: (id: string, nowMs: number) => boolean
  /** Ends one Session. True when it was live. */
  readonly revoke: (id: string) => boolean
  /** Ends every Session. */
  readonly revokeAll: () => void
  /** Forgets every Session that had expired by `nowMs`. */
  readonly prune: (nowMs: number) => void
  /** How many Sessions are recorded, expired ones included. */
  readonly size: () => number
}

/** Attributes of a serialized session cookie. */
export interface SessionCookieOptions {
  /** Cookie name. Defaults to {@link SESSION_COOKIE_NAME}. */
  readonly name?: string
  /** Cookie path. Defaults to {@link SESSION_COOKIE_PATH}. */
  readonly path?: string
  /** `Max-Age` in seconds. Omitted from the header when absent. */
  readonly maxAgeSeconds?: number
  /** `Secure` attribute. Defaults to true; see the module note on localhost. */
  readonly secure?: boolean
}

/** One login submission. */
export interface PassphraseSubmission {
  /**
   * Stable identifier of the sender the throttle counts against, normally the
   * client IP. An empty or whitespace-only value falls back to
   * {@link UNKNOWN_SENDER}, so senders whose address the runtime could not
   * determine share one bucket rather than escaping the throttle.
   */
  readonly sender: string
  /** The submitted value, exactly as typed. Never logged, never echoed. */
  readonly submitted: string
}

/** The result of a login submission. */
export type LoginOutcome =
  | {
      readonly kind: "granted"
      readonly session: SessionPayload
      /** Value for a `Set-Cookie:` response header. */
      readonly setCookie: string
    }
  | {
      readonly kind: "rejected"
      /** Always {@link INCORRECT_PASSPHRASE_MESSAGE}. */
      readonly message: string
      /** State of the throttle after this failure was counted. */
      readonly throttle: ThrottleStatus
    }
  | {
      readonly kind: "throttled"
      /** Always {@link THROTTLED_MESSAGE}. */
      readonly message: string
      readonly throttle: ThrottleStatus
    }
  | {
      readonly kind: "gate-disabled"
      /** Always {@link GATE_DISABLED_MESSAGE}. */
      readonly message: string
    }

/** The result of ending a Session. */
export interface LogoutOutcome {
  /** True when a live Session was found and ended. */
  readonly revoked: boolean
  /** Value for a `Set-Cookie:` header that removes the cookie. */
  readonly setCookie: string
}

/** Injection points of {@link createAuth}. All optional. */
export interface AuthOptions {
  /** Epoch-millisecond clock. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Shared_Passphrase accessor. Defaults to the process-wide secrets. */
  readonly readSharedPassphrase?: () => string | null
  /** Session signing key accessor. Defaults to the process-wide secrets. */
  readonly readSessionSecret?: () => string
  /** Failed-attempt store. Defaults to a fresh in-memory throttle. */
  readonly throttle?: AttemptThrottle
  /** Live-session record. Defaults to a fresh in-memory registry. */
  readonly sessions?: SessionRegistry
  /** Session id generator. Defaults to `crypto.randomUUID`. */
  readonly generateSessionId?: () => string
  /** Session lifetime. Defaults to {@link SESSION_TTL_MS}. */
  readonly sessionTtlMs?: number
  /** Cookie attributes applied to every issued and cleared cookie. */
  readonly cookie?: SessionCookieOptions
}

/** The Access_Gate seam consumed by the middleware and the login route. */
export interface Auth {
  /** True when a Shared_Passphrase is configured (Requirements 8.2, 8.9). */
  readonly passphraseRequired: () => boolean
  /** Requirements 8.4, 8.5, 8.6, 8.8. */
  readonly submitPassphrase: (submission: PassphraseSubmission) => LoginOutcome
  /** Verifies a raw `Cookie:` header value (Requirements 8.2, 8.3, 8.7). */
  readonly verifySessionCookieHeader: (
    cookieHeader: string | null | undefined
  ) => SessionVerification
  /** Shorthand for a `valid` verification. */
  readonly hasValidSession: (cookieHeader: string | null | undefined) => boolean
  /** Requirement 8.7. */
  readonly logout: (cookieHeader: string | null | undefined) => LogoutOutcome
  /** Ends one Session by id. True when it was live. */
  readonly revokeSession: (id: string) => boolean
  /** Throttle state of `sender` right now, recording nothing. */
  readonly throttleStatus: (sender: string) => ThrottleStatus
  /** A `Set-Cookie:` value that removes the session cookie. */
  readonly clearedSessionCookie: () => string
  /** Ends every Session and forgets every failed-attempt record. */
  readonly reset: () => void
}

/** Throttle bucket used when the sender could not be identified. */
export const UNKNOWN_SENDER = "unknown"

/** A record with no failures and no block. */
const CLEAR_STATUS: ThrottleStatus = {
  blocked: false,
  failures: 0,
  retryAfterMs: 0,
}

/** One sender's failed-attempt record. */
interface AttemptRecord {
  /** Epoch milliseconds of the failures still inside the window. */
  timestamps: number[]
  /** Epoch milliseconds the block lifts at; 0 when not blocked. */
  blockedUntil: number
}

/**
 * Normalizes a sender key, so a blank address cannot open an unthrottled lane.
 */
function senderKey(sender: string): string {
  const trimmed = sender.trim()
  return trimmed === "" ? UNKNOWN_SENDER : trimmed
}

/**
 * An in-memory per-sender throttle (Requirement 8.8).
 *
 * Rules, all driven by the `nowMs` the caller passes, so tests never sleep:
 *
 * - a failure is remembered for {@link FAILED_ATTEMPT_WINDOW_MS};
 * - reaching {@link FAILED_ATTEMPT_LIMIT} remembered failures blocks the sender
 *   for {@link THROTTLE_BLOCK_MS};
 * - a submission recorded while the block is active restarts the block from
 *   that moment. Requirement 8.8 asks for "at least 5 minutes", and refusing to
 *   restart would let a sender keep guessing at one attempt per five minutes
 *   with no further cost. The documented consequence is that a blocked sender
 *   must stop submitting for five minutes, not merely wait five minutes;
 * - a successful login {@link AttemptThrottle.clear}s the record, so an honest
 *   typist who gets it right on the ninth try starts over.
 *
 * Records for senders that have neither a remembered failure nor an active
 * block are swept on write, which bounds the map without a timer.
 */
export function createAttemptThrottle(): AttemptThrottle {
  const records = new Map<string, AttemptRecord>()

  /** Drops failures that fell out of the window. */
  const prune = (record: AttemptRecord, nowMs: number): void => {
    const cutoff = nowMs - FAILED_ATTEMPT_WINDOW_MS
    record.timestamps = record.timestamps.filter(
      (timestamp) => timestamp > cutoff
    )
  }

  /** Drops records that hold neither a live failure nor an active block. */
  const sweep = (nowMs: number): void => {
    for (const [key, record] of records) {
      prune(record, nowMs)
      if (record.timestamps.length === 0 && record.blockedUntil <= nowMs) {
        records.delete(key)
      }
    }
  }

  const describe = (record: AttemptRecord, nowMs: number): ThrottleStatus => ({
    blocked: record.blockedUntil > nowMs,
    failures: record.timestamps.length,
    retryAfterMs: Math.max(0, record.blockedUntil - nowMs),
  })

  return {
    status: (sender, nowMs) => {
      const record = records.get(senderKey(sender))
      if (record === undefined) {
        return CLEAR_STATUS
      }
      prune(record, nowMs)
      return describe(record, nowMs)
    },

    recordFailure: (sender, nowMs) => {
      sweep(nowMs)
      const key = senderKey(sender)
      const record = records.get(key) ?? { timestamps: [], blockedUntil: 0 }
      records.set(key, record)

      prune(record, nowMs)
      record.timestamps.push(nowMs)

      if (
        record.blockedUntil > nowMs ||
        record.timestamps.length >= FAILED_ATTEMPT_LIMIT
      ) {
        record.blockedUntil = nowMs + THROTTLE_BLOCK_MS
      }

      return describe(record, nowMs)
    },

    clear: (sender) => {
      records.delete(senderKey(sender))
    },

    reset: () => {
      records.clear()
    },
  }
}

/**
 * An in-memory registry of live Sessions (Requirement 8.7).
 *
 * An expired id is dropped when it is looked up, and {@link Auth} sweeps the
 * whole map on every login, so the map holds roughly as many entries as there
 * have been logins inside one {@link SESSION_TTL_MS} window. Nothing is
 * persisted: a restart empties it and therefore ends every Session.
 */
export function createSessionRegistry(): SessionRegistry {
  const expiries = new Map<string, number>()

  return {
    activate: (id, expiresAt) => {
      expiries.set(id, expiresAt)
    },

    isActive: (id, nowMs) => {
      const expiresAt = expiries.get(id)
      if (expiresAt === undefined) {
        return false
      }
      if (expiresAt <= nowMs) {
        expiries.delete(id)
        return false
      }
      return true
    },

    revoke: (id) => expiries.delete(id),

    revokeAll: () => {
      expiries.clear()
    },

    prune: (nowMs) => {
      for (const [id, expiresAt] of expiries) {
        if (expiresAt <= nowMs) {
          expiries.delete(id)
        }
      }
    },

    size: () => expiries.size,
  }
}

/** base64url of a UTF-8 string, without padding. */
function encodeSegment(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url")
}

/** Inverse of {@link encodeSegment}, or null when the input is not base64url. */
function decodeSegment(segment: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    return null
  }
  return Buffer.from(segment, "base64url").toString("utf8")
}

/**
 * The digest a value is compared through (Requirement 8.6).
 *
 * The input is encoded as UTF-16 code units rather than UTF-8, because UTF-8
 * conversion in Node replaces an unpaired surrogate with U+FFFD: two different
 * strings would then produce one digest. `utf16le` round-trips every JavaScript
 * string faithfully, so digest equality means the strings are
 * character-for-character identical (Requirement 8.4), short of a SHA-256
 * collision.
 *
 * Keyed with the session signing key so the digests cannot be precomputed
 * offline.
 */
function comparisonDigest(value: string, key: string): Buffer {
  return createHmac("sha256", key)
    .update(Buffer.from(value, "utf16le"))
    .digest()
}

/**
 * True exactly when `submitted` and `expected` are the same string, decided in a
 * duration that does not depend on the number of leading characters they share
 * and that discloses neither length (Requirements 8.5, 8.6).
 *
 * Exported because it is the whole of the comparison rule and deserves to be
 * tested directly.
 */
export function constantTimeStringEquals(
  submitted: string,
  expected: string,
  key: string
): boolean {
  return timingSafeEqual(
    comparisonDigest(submitted, key),
    comparisonDigest(expected, key)
  )
}

/** The signature over a payload segment. */
function sign(payloadSegment: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadSegment).digest("base64url")
}

/**
 * Serializes and signs a session payload as `<payload>.<signature>`.
 *
 * Both segments are base64url, so the value needs no cookie escaping. The
 * payload is readable by anyone holding the cookie — it carries only an opaque
 * id and two timestamps — but it cannot be altered without the signing key.
 */
export function signSessionToken(
  session: SessionPayload,
  secret: string
): string {
  const payloadSegment = encodeSegment(
    JSON.stringify({
      id: session.id,
      iat: session.issuedAt,
      exp: session.expiresAt,
    })
  )
  return `${payloadSegment}.${sign(payloadSegment, secret)}`
}

/** Reads a session payload out of a decoded payload segment. */
function parsePayload(json: string): SessionPayload | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null
  }
  const { id, iat, exp } = parsed as Record<string, unknown>
  if (typeof id !== "string" || id === "") {
    return null
  }
  if (typeof iat !== "number" || !Number.isFinite(iat)) {
    return null
  }
  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    return null
  }
  return { id, issuedAt: iat, expiresAt: exp }
}

/**
 * Verifies a session token's signature and expiry (Requirement 8.4).
 *
 * A tampered payload, a tampered signature, a token signed with another key, and
 * a token whose `expiresAt` has passed are all refused. Session revocation is
 * *not* checked here — that is the registry's job, and {@link Auth} composes the
 * two.
 *
 * The signature comparison itself is constant-time, though the signature is not
 * a secret: it keeps a forger from learning how far a guess got.
 */
export function verifySessionToken(
  token: string,
  secret: string,
  nowMs: number
): TokenVerification {
  const separator = token.indexOf(".")
  if (separator <= 0 || separator === token.length - 1) {
    return { kind: "malformed" }
  }

  const payloadSegment = token.slice(0, separator)
  const signatureSegment = token.slice(separator + 1)
  const expected = sign(payloadSegment, secret)

  if (
    signatureSegment.length !== expected.length ||
    !timingSafeEqual(
      Buffer.from(signatureSegment, "utf8"),
      Buffer.from(expected, "utf8")
    )
  ) {
    return { kind: "tampered" }
  }

  const json = decodeSegment(payloadSegment)
  if (json === null) {
    return { kind: "malformed" }
  }
  const session = parsePayload(json)
  if (session === null) {
    return { kind: "malformed" }
  }
  if (session.expiresAt <= nowMs) {
    return { kind: "expired" }
  }
  return { kind: "valid", session }
}

/**
 * Splits a raw `Cookie:` header into name/value pairs.
 *
 * Tolerant on purpose: a pair without `=`, an empty name, or a value that is not
 * valid percent-encoding is skipped rather than throwing, because this parses
 * attacker-controlled input on every request. The last occurrence of a name
 * wins, matching how browsers and most server frameworks resolve duplicates.
 *
 * A `Map` rather than an object, so a cookie literally named `__proto__` sets a
 * key instead of an object prototype.
 */
export function parseCookieHeader(
  cookieHeader: string | null | undefined
): Map<string, string> {
  const cookies = new Map<string, string>()
  if (cookieHeader === null || cookieHeader === undefined) {
    return cookies
  }

  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=")
    if (separator <= 0) {
      continue
    }
    const name = part.slice(0, separator).trim()
    if (name === "") {
      continue
    }
    const raw = part.slice(separator + 1).trim()
    try {
      cookies.set(name, decodeURIComponent(raw))
    } catch {
      cookies.set(name, raw)
    }
  }

  return cookies
}

/** The session cookie value in a raw `Cookie:` header, or null. */
export function readSessionCookie(
  cookieHeader: string | null | undefined,
  name: string = SESSION_COOKIE_NAME
): string | null {
  const value = parseCookieHeader(cookieHeader).get(name)
  return value === undefined || value === "" ? null : value
}

/** Builds a `Set-Cookie:` value. */
function serializeCookie(
  name: string,
  value: string,
  options: SessionCookieOptions
): string {
  const attributes = [
    `${name}=${value}`,
    `Path=${options.path ?? SESSION_COOKIE_PATH}`,
    "HttpOnly",
    "SameSite=Strict",
  ]
  if (options.secure !== false) {
    attributes.push("Secure")
  }
  if (options.maxAgeSeconds !== undefined) {
    attributes.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`)
  }
  return attributes.join("; ")
}

/**
 * The `Set-Cookie:` value that grants a Session: `HttpOnly`, `SameSite=Strict`,
 * `Secure` by default, scoped to the whole app, and expiring with the Session.
 */
export function serializeSessionCookie(
  token: string,
  options: SessionCookieOptions = {}
): string {
  return serializeCookie(options.name ?? SESSION_COOKIE_NAME, token, options)
}

/**
 * The `Set-Cookie:` value that removes the session cookie. `Max-Age=0` with an
 * empty value, and the same attributes the cookie was issued with, which is what
 * makes a browser drop it.
 */
export function serializeClearedSessionCookie(
  options: SessionCookieOptions = {}
): string {
  return serializeCookie(options.name ?? SESSION_COOKIE_NAME, "", {
    ...options,
    maxAgeSeconds: 0,
  })
}

/**
 * Builds an Access_Gate over the injected clock, secrets, throttle, and session
 * registry.
 *
 * Holds no environment access of its own: {@link getAuth} is what binds the
 * process-wide secrets. Two instances built with the same `throttle` and
 * `sessions` share that state; built with the defaults they are independent,
 * which is what a test wants.
 */
export function createAuth(options: AuthOptions = {}): Auth {
  const now = options.now ?? (() => Date.now())
  const readSharedPassphrase =
    options.readSharedPassphrase ?? serverSecrets.readSharedPassphrase
  const readSessionSecret =
    options.readSessionSecret ?? serverSecrets.readSessionSecret
  const throttle = options.throttle ?? createAttemptThrottle()
  const sessions = options.sessions ?? createSessionRegistry()
  const generateSessionId = options.generateSessionId ?? (() => randomUUID())
  const sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS
  const cookie = options.cookie ?? {}

  const cookieName = cookie.name ?? SESSION_COOKIE_NAME

  const verify = (
    cookieHeader: string | null | undefined
  ): SessionVerification => {
    const token = readSessionCookie(cookieHeader, cookieName)
    if (token === null) {
      return { kind: "missing" }
    }

    const nowMs = now()
    const verified = verifySessionToken(token, readSessionSecret(), nowMs)
    if (verified.kind !== "valid") {
      return verified
    }
    if (!sessions.isActive(verified.session.id, nowMs)) {
      return { kind: "revoked" }
    }
    return verified
  }

  return {
    passphraseRequired: () => readSharedPassphrase() !== null,

    /**
     * The full login decision, in the order the requirements demand: an active
     * block wins over a correct value (Requirement 8.8), and only then is the
     * value compared in constant time (Requirement 8.6). The submitted value
     * appears in no returned field (Requirement 8.10).
     */
    submitPassphrase: ({ sender, submitted }) => {
      const passphrase = readSharedPassphrase()
      if (passphrase === null) {
        return { kind: "gate-disabled", message: GATE_DISABLED_MESSAGE }
      }

      const nowMs = now()
      if (throttle.status(sender, nowMs).blocked) {
        /*
         * Counted as a failure whether or not the value was right: the
         * comparison is not even run, so a blocked sender learns nothing, and
         * the block restarts from this attempt.
         */
        return {
          kind: "throttled",
          message: THROTTLED_MESSAGE,
          throttle: throttle.recordFailure(sender, nowMs),
        }
      }

      const secret = readSessionSecret()
      if (!constantTimeStringEquals(submitted, passphrase, secret)) {
        const status = throttle.recordFailure(sender, nowMs)
        return {
          kind: "rejected",
          message: INCORRECT_PASSPHRASE_MESSAGE,
          throttle: status,
        }
      }

      throttle.clear(sender)

      const session: SessionPayload = {
        id: generateSessionId(),
        issuedAt: nowMs,
        expiresAt: nowMs + sessionTtlMs,
      }
      sessions.prune(nowMs)
      sessions.activate(session.id, session.expiresAt)

      return {
        kind: "granted",
        session,
        setCookie: serializeSessionCookie(signSessionToken(session, secret), {
          maxAgeSeconds: Math.floor(sessionTtlMs / 1000),
          ...cookie,
        }),
      }
    },

    verifySessionCookieHeader: verify,

    hasValidSession: (cookieHeader) => verify(cookieHeader).kind === "valid",

    /**
     * Ends the Session the cookie names (Requirement 8.7).
     *
     * The id is taken from a signature-checked payload, so one sender cannot log
     * another out by inventing a cookie. An expired token still gets its id
     * revoked — that is idempotent and keeps the registry tidy. The returned
     * `Set-Cookie` clears the browser copy; the registry removal is what makes a
     * captured copy stop working.
     */
    logout: (cookieHeader) => {
      const clearedCookie = serializeClearedSessionCookie(cookie)
      const token = readSessionCookie(cookieHeader, cookieName)
      if (token === null) {
        return { revoked: false, setCookie: clearedCookie }
      }

      const verified = verifySessionToken(token, readSessionSecret(), now())
      if (verified.kind === "valid") {
        return {
          revoked: sessions.revoke(verified.session.id),
          setCookie: clearedCookie,
        }
      }
      return { revoked: false, setCookie: clearedCookie }
    },

    revokeSession: (id) => sessions.revoke(id),

    throttleStatus: (sender) => throttle.status(sender, now()),

    clearedSessionCookie: () => serializeClearedSessionCookie(cookie),

    reset: () => {
      throttle.reset()
      sessions.revokeAll()
    },
  }
}

let processAuth: Auth | null = null

/**
 * The process-wide Access_Gate, created on first use over the secrets
 * `config.server.ts` read at startup.
 *
 * One instance per process, because the throttle and the live-session registry
 * are its state: a second instance would let a blocked sender start over and
 * would honour Sessions the first had ended.
 */
export function getAuth(): Auth {
  processAuth ??= createAuth()
  return processAuth
}

/** Installs the process-wide Access_Gate. Used by wiring and by tests. */
export function setAuth(auth: Auth): void {
  processAuth = auth
}

/** Drops the process-wide Access_Gate so the next {@link getAuth} rebuilds it. */
export function resetAuth(): void {
  processAuth = null
}
