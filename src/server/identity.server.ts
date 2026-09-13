/**
 * The Clerk boundary for mongodb-google-auth-admin.
 *
 * This is the whole of the Clerk surface the application touches, behind one
 * seam. It resolves the current request's identity ({@link RequestIdentity})
 * and, given a Clerk user id, fetches the two fields the User_Account mirror
 * stores — a folded email address and a display name — and nothing else
 * ({@link ClerkProfile}). It knows Clerk and knows nothing about MongoDB: it
 * imports nothing from `@/server/store`, and the module that mirrors what it
 * returns lives elsewhere (task 16).
 *
 * ## What never leaves this module (Requirement 5.10 restated)
 *
 * The Clerk secret key is read by `clerkClient()` from the environment itself;
 * this module never reads it, never logs it, never embeds it in a returned
 * value, and never puts it in a message. There is no logging call here at all.
 * A rejected Clerk call could carry configuration in its message, so every
 * catch maps to a fixed {@link ProfileFailure} whose `reason` is a coarse,
 * Clerk-free token — the error object is discarded, not surfaced.
 *
 * ## The bounded fetch (Requirement 5.14 restated)
 *
 * `profile()` races the Clerk Backend call against a 5-second timer. This is a
 * network call to Clerk, not a Mongo operation, so a `Promise.race` is the
 * right bound here (the store, by contrast, bounds through the driver's own
 * timeouts). A timeout, a rejection, or a user with no primary verified email
 * address all yield a {@link ProfileFailure} rather than a throw, so the
 * authorization layer (task 17) can turn a stalled or failed fetch into
 * Requirement 6.15's "the authorization could not be determined" — and, being a
 * failure rather than a profile, it can never be written into a User_Account
 * (Requirement 5.14 restated: a stalled fetch writes nothing).
 *
 * ## The display-name rule (Requirement 5.4 restated)
 *
 * `firstName` and `lastName` are joined with a single space and trimmed, then
 * truncated to 100 characters (counting UTF-16 code units, as the rest of the
 * codebase counts a "character"), falling back to the email address when the
 * joined result holds zero characters. The rule lives here so that everything
 * downstream stores exactly what Clerk gave, folded once.
 *
 * ## The seams
 *
 * `createIdentity(deps)` takes the Clerk `auth` and `clerkClient` (or thin
 * wrappers over them) as injected dependencies, mirroring the `createAuth` /
 * `getAuth` shape of `auth.server.ts`. {@link getIdentity} binds the real Clerk
 * functions once per process. A test — the bounded-profile-fetch integration
 * test of task 15.4, and the authorization tests of tasks 16/17 — injects a
 * stub through `createIdentity` and never touches Clerk or the network.
 */

import { auth, clerkClient } from "@clerk/tanstack-react-start/server"

import { foldEmail } from "@/domain/accounts"
import { serverConfig } from "@/server/config.server"

/** The 5-second bound on a Clerk Backend profile fetch (Requirement 5.14). */
export const PROFILE_FETCH_TIMEOUT_MS = 5000

/** The longest display name the mirror stores, in UTF-16 code units (Requirement 5.4). */
export const DISPLAY_NAME_MAX_LENGTH = 100

/**
 * The request's Clerk identity, as {@link Identity.current} resolves it. The
 * Clerk user id takes the Google_Subject's place as the User_Account key
 * (Requirement 5.4 restated); the session id lets the mirror notice a new
 * sign-in.
 */
export interface RequestIdentity {
  /** Clerk user id. The key of the mirrored User_Account. */
  readonly userId: string
  /** Clerk session id, used to notice a new sign-in. */
  readonly sessionId: string
}

/**
 * The two fields the User_Account mirror stores, and nothing else. Both are
 * already folded/derived so a caller stores exactly what arrives here.
 */
export interface ClerkProfile {
  /** Lower-cased, trimmed, from the primary verified email address. */
  readonly email: string
  /**
   * `firstName`/`lastName` joined, trimmed, truncated to 100 characters; the
   * email address when the joined result holds zero characters.
   */
  readonly displayName: string
}

/**
 * Why a profile could not be produced. Deliberately a discriminated *result*,
 * not a throw, so a caller branches on it, and deliberately coarse and free of
 * Clerk text, so no configuration or Clerk-side detail rides along.
 */
export interface ProfileFailure {
  readonly kind: "profile-failed"
  /**
   * - `no-verified-email`: the user holds no primary verified email address, so
   *   there is nothing usable to mirror (Requirement 5.15 restated).
   * - `unreachable`: the 5-second race elapsed, or the Clerk call rejected. The
   *   underlying error, which could name configuration, is discarded here
   *   (Requirement 5.10 restated).
   */
  readonly reason: "no-verified-email" | "unreachable"
}

/** The Clerk boundary seam consumed by the authorization layer. */
export interface Identity {
  /** Requirement 5.2 restated: false when the Clerk keys are missing. */
  readonly configured: () => boolean
  /** null when the request carries no valid Clerk session. */
  readonly current: () => Promise<RequestIdentity | null>
  /** Requirement 5.14 restated: bounded at 5 seconds. */
  readonly profile: (userId: string) => Promise<ClerkProfile | ProfileFailure>
}

/**
 * The shape of a Clerk email-address record this module reads. Structurally a
 * subset of `@clerk/backend`'s `EmailAddress`, narrowed to the two fields the
 * primary-verified test turns on, so a stub need supply only these.
 */
export interface ClerkEmailAddress {
  readonly id: string
  readonly emailAddress: string
  readonly verification: { readonly status: string } | null
}

/**
 * The shape of a Clerk Backend `User` this module reads. Structurally a subset
 * of `@clerk/backend`'s `User`, narrowed to the fields the profile projection
 * uses. The real `clerkClient().users.getUser` returns a value assignable to
 * this.
 */
export interface ClerkUser {
  readonly primaryEmailAddressId: string | null
  readonly emailAddresses: readonly ClerkEmailAddress[]
  readonly firstName: string | null
  readonly lastName: string | null
}

/**
 * The request-identity resolver, matching Clerk's `auth()`: it takes no request
 * and resolves to an object whose `userId` and `sessionId` are strings when a
 * valid session is present and null otherwise.
 */
export type ClerkAuth = () => Promise<{
  readonly userId: string | null
  readonly sessionId: string | null
}>

/** The single Clerk Backend read this module needs. */
export interface ClerkUserReader {
  readonly getUser: (userId: string) => Promise<ClerkUser>
}

/** A factory for a {@link ClerkUserReader}, matching `clerkClient().users`. */
export type ClerkUserReaderFactory = () => ClerkUserReader

/** Injection points of {@link createIdentity}. */
export interface IdentityOptions {
  /** Whether Clerk is configured. Defaults to {@link serverConfig.clerkConfigured}. */
  readonly configured?: () => boolean
  /** The request-identity resolver. Defaults to Clerk's `auth`. */
  readonly auth?: ClerkAuth
  /** The Clerk Backend user reader. Defaults to `clerkClient().users`. */
  readonly users?: ClerkUserReaderFactory
  /** The profile-fetch bound in milliseconds. Defaults to {@link PROFILE_FETCH_TIMEOUT_MS}. */
  readonly timeoutMs?: number
}

/** A {@link ProfileFailure} for a user with no primary verified email address. */
const NO_VERIFIED_EMAIL: ProfileFailure = {
  kind: "profile-failed",
  reason: "no-verified-email",
}

/** A {@link ProfileFailure} for a timed-out or rejected Clerk call. */
const UNREACHABLE: ProfileFailure = {
  kind: "profile-failed",
  reason: "unreachable",
}

/**
 * The primary verified email address of a Clerk user, folded, or null.
 *
 * "Primary" is the address whose id equals `primaryEmailAddressId`; "verified"
 * is that address carrying a `verification.status` of `"verified"`. A user
 * whose primary address is unverified, or who has no primary address at all,
 * yields null — there is no second-choice address, because the mirror stores
 * exactly the address Clerk calls primary. The fold is the same
 * {@link foldEmail} the Admin_Allowlist is folded with, so membership is later
 * decided between identically-normalized values.
 */
export function primaryVerifiedEmail(user: ClerkUser): string | null {
  const primaryId = user.primaryEmailAddressId
  if (primaryId === null) {
    return null
  }
  const primary = user.emailAddresses.find((entry) => entry.id === primaryId)
  if (primary === undefined) {
    return null
  }
  if (primary.verification?.status !== "verified") {
    return null
  }
  const folded = foldEmail(primary.emailAddress)
  return folded.length === 0 ? null : folded
}

/**
 * The display name for a Clerk user (Requirement 5.4 restated).
 *
 * `firstName` and `lastName` are joined with a single space and trimmed, then
 * truncated to {@link DISPLAY_NAME_MAX_LENGTH} UTF-16 code units. When the
 * joined, trimmed result holds zero characters — Clerk asserted no name — the
 * folded email address stands in, so the stored display name is never empty.
 *
 * Exported because it is the whole of the rule and deserves direct testing.
 */
export function deriveDisplayName(user: ClerkUser, email: string): string {
  const joined = [user.firstName ?? "", user.lastName ?? ""].join(" ").trim()
  if (joined.length === 0) {
    return email
  }
  return joined.slice(0, DISPLAY_NAME_MAX_LENGTH)
}

/**
 * Projects a Clerk Backend user down to the two fields the mirror stores, or a
 * {@link ProfileFailure} when it holds no primary verified email address
 * (Requirement 5.15 restated). Pure: the network and the timeout live in
 * {@link createIdentity}.
 */
export function projectProfile(user: ClerkUser): ClerkProfile | ProfileFailure {
  const email = primaryVerifiedEmail(user)
  if (email === null) {
    return NO_VERIFIED_EMAIL
  }
  return { email, displayName: deriveDisplayName(user, email) }
}

/** A sentinel a timed-out race resolves to, distinct from any Clerk user. */
const TIMED_OUT = Symbol("clerk-profile-timeout")

/**
 * Builds a Clerk boundary over the injected resolver, reader, and clock.
 *
 * Holds no environment access of its own beyond the `configured` default:
 * {@link getIdentity} is what binds the real Clerk `auth` and `clerkClient`.
 * Built with the defaults it talks to Clerk; built with stubs it talks to
 * neither Clerk nor the network, which is what a test wants.
 */
export function createIdentity(options: IdentityOptions = {}): Identity {
  const isConfigured =
    options.configured ?? (() => serverConfig.clerkConfigured)
  const resolveAuth = options.auth ?? auth
  const usersFactory = options.users ?? (() => clerkClient().users)
  const timeoutMs = options.timeoutMs ?? PROFILE_FETCH_TIMEOUT_MS

  const current = async (): Promise<RequestIdentity | null> => {
    /*
     * A rejected `auth()` (misconfiguration, a malformed token) is a request
     * with no usable identity, not a crash: it resolves to null, exactly as a
     * request carrying no session does. The error is discarded rather than
     * surfaced, so nothing Clerk put in it can escape (Requirement 5.10).
     */
    let resolved: Awaited<ReturnType<ClerkAuth>>
    try {
      resolved = await resolveAuth()
    } catch {
      return null
    }
    if (resolved.userId === null || resolved.sessionId === null) {
      return null
    }
    return { userId: resolved.userId, sessionId: resolved.sessionId }
  }

  const profile = async (
    userId: string
  ): Promise<ClerkProfile | ProfileFailure> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs)
    })

    try {
      /*
       * The Clerk Backend call is raced against the timer (Requirement 5.14).
       * Either outcome that is not a resolved user — the timer winning, or the
       * call rejecting — becomes the same coarse `unreachable` failure, so a
       * stalled or failed fetch writes no User_Account and leaks no Clerk text.
       */
      const outcome = await Promise.race([
        usersFactory().getUser(userId),
        timeout,
      ])
      if (outcome === TIMED_OUT) {
        return UNREACHABLE
      }
      return projectProfile(outcome)
    } catch {
      return UNREACHABLE
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
    }
  }

  return {
    configured: () => isConfigured(),
    current,
    profile,
  }
}

let processIdentity: Identity | null = null

/**
 * The process-wide Clerk boundary, created on first use over the real Clerk
 * `auth` and `clerkClient`.
 *
 * One instance per process is enough: this seam holds no mutable state, so a
 * second instance would behave identically. The singleton exists to match the
 * `getAuth` shape and to give tasks 16/17 one point to override.
 */
export function getIdentity(): Identity {
  processIdentity ??= createIdentity()
  return processIdentity
}

/** Installs the process-wide Clerk boundary. Used by wiring and by tests. */
export function setIdentity(identity: Identity): void {
  processIdentity = identity
}

/** Drops the process-wide boundary so the next {@link getIdentity} rebuilds it. */
export function resetIdentity(): void {
  processIdentity = null
}
