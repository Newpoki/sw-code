/**
 * Property 24 of shared-coupon-redemption: without a valid Session nothing is
 * read and nothing is run (Requirements 8.2, 8.3, 8.4, 8.10).
 *
 * `tests/unit/gateDecision.test.ts` pins the Access_Gate down on hand-picked
 * examples. This file is the generated-input counterpart: every way a request can
 * fail to carry a valid Session — no `Cookie:` header, an empty one, junk, the
 * right cookie name over a garbage value, a token whose payload or signature was
 * altered, a token signed with another key, a token whose `expiresAt` the
 * injected clock has passed, and a Session that was ended — is built from a
 * generated seed and asserted to be refused, while a freshly granted token is
 * asserted to be admitted.
 *
 * Three things are asserted about every refusal, because Requirement 8.3 asks
 * for all three:
 *
 * 1. **Nothing is disclosed.** A real store is built over a seeded roster and a
 *    seeded history, and no stored Member_Label, Hive_ID, member id,
 *    Coupon_Code, run id, or response message appears anywhere in the rejection
 *    or in the response {@link gateRejectionResponse} builds from it. The
 *    rejection's own text is additionally asserted to equal the fixed
 *    {@link SESSION_REQUIRED_MESSAGE} / {@link LOGIN_PATH} constants, which is
 *    the stronger statement and the one that covers stored values too short to
 *    be searched for (see {@link IDENTIFYING_LENGTH}).
 * 2. **Nothing is read.** The Member_Registry and the Redemption_History are
 *    wrapped in counting proxies and the counters are asserted to be zero after
 *    the gate has run. The structural argument is stronger than the counters:
 *    {@link evaluateGate} takes only an {@link Auth}, a pathname, a handler type,
 *    a cookie string, a handshake fact, and an injected authorization resolver,
 *    so it has no store to read of its own. The resolver these properties inject
 *    reports `anonymous` without touching the counting-proxy store, so the
 *    counters stay at zero; a liveness check at the end proves they would have
 *    moved had anything touched the seams.
 * 3. **Nothing is run.** Same shape: a counting {@link RunCoordinator} whose
 *    `start` is asserted never to have been called.
 *
 * The Requirement 8.4 half of the property is the login comparison: an exactly
 * identical value grants a Session that admits every subsequent request, and a
 * near miss — one character changed, appended, prepended, or removed, the case
 * folded, whitespace added, or the value trimmed — grants nothing. Requirement
 * 8.10 rides along on both halves: the generated Shared_Passphrase is searched
 * for in every rejection field, in the granted `Set-Cookie` value, and in the
 * serialized response.
 *
 * Requirement 8.9 appears as the complement: with no Shared_Passphrase
 * configured every request is admitted whatever the cookie header holds.
 *
 * No `process.env` access anywhere: the passphrase and the signing key are
 * injected through {@link createAuth}, and the store writes to a temporary path
 * with the filesystem flush replaced, so nothing is written.
 */

import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
  FAILED_ATTEMPT_LIMIT,
  INCORRECT_PASSPHRASE_MESSAGE,
  LOGIN_PATH,
  SESSION_COOKIE_NAME,
  SESSION_REQUIRED_MESSAGE,
  SESSION_TTL_MS,
  createAuth,
  readSessionCookie,
  signSessionToken,
} from "@/server/auth.server"
import {
  GATE_EXEMPT_PATHS,
  GATE_EXEMPT_PATH_PREFIXES,
  SESSION_REQUIRED_CODE,
  SESSION_REQUIRED_REDIRECT_STATUS,
  SESSION_REQUIRED_STATUS,
  SIGN_IN_PATH,
  evaluateGate,
  gateRejectionResponse,
  isGateExemptPath,
} from "@/server/gate.server"
import { createHistoryStore } from "@/server/store/history.server"
import { createMemberRegistryStore } from "@/server/store/memberRegistry.server"

import type { Auth, SessionPayload } from "@/server/auth.server"
import type { AuthorizationDecision } from "@/server/authorization.server"
import type {
  GateDecision,
  GateHandlerType,
  GateInput,
  GateRejection,
} from "@/server/gate.server"
import type { RunCoordinator } from "@/server/run/coordinator.server"
import type { HistoryStore } from "@/server/store/history.server"
import type { MemberRegistryStore } from "@/server/store/memberRegistry.server"
import type { MemberRegistryEntry, RunEvent } from "@/domain/types"

import { createInMemoryMongoStore } from "../support/inMemoryMongoStore"
import { rosterArb, trimmedCouponCodeArb } from "./generators"

/* -------------------------------------------------------------------------- */
/* Requests                                                                   */
/* -------------------------------------------------------------------------- */

/** Everything about a request the Access_Gate decision looks at, less the cookie. */
interface RequestFacts {
  readonly pathname: string
  readonly handlerType: GateHandlerType
}

/**
 * Paths no exemption covers, by inspection of {@link GATE_EXEMPT_PATHS} and
 * {@link GATE_EXEMPT_PATH_PREFIXES}: `/loginish` and `/_buildish/` sit just off a
 * prefix boundary, `/@fs/` is the dev server's arbitrary-file route that is
 * deliberately not listed, and `/` is the roster document itself.
 */
const PROTECTED_PATHS = [
  "/",
  "/roster",
  "/history",
  "/loginish",
  "/login/../secret",
  "/_buildish/entry.js",
  "/@fs/etc/passwd",
  "/_serverFn/abc123",
] as const

/** One path segment: lowercase, digits, dash, underscore. */
const pathSegmentArb: fc.Arbitrary<string> = fc
  .array(
    fc.constantFrom(...`abcdefghijklmnopqrstuvwxyz0123456789-_`.split("")),
    {
      minLength: 1,
      maxLength: 12,
    }
  )
  .map((units) => units.join(""))

/**
 * A path that requires a Session. The generated arm is rooted at `/data/`, which
 * is neither an exempt path nor an exempt prefix, so no sample can accidentally
 * be exempt.
 */
const protectedPathArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...PROTECTED_PATHS) },
  {
    weight: 2,
    arbitrary: fc
      .array(pathSegmentArb, { minLength: 1, maxLength: 3 })
      .map((segments) => `/data/${segments.join("/")}`),
  }
)

/** Any pathname at all, exempt ones included. */
const anyPathnameArb: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.constantFrom(
      ...GATE_EXEMPT_PATHS,
      ...GATE_EXEMPT_PATH_PREFIXES.map((prefix) => `${prefix}entry-abc123.js`),
      "/@react-refresh",
      "/login/"
    ),
  },
  { weight: 3, arbitrary: protectedPathArb },
  {
    weight: 1,
    arbitrary: fc.string({ unit: "grapheme" }).map((tail) => `/${tail}`),
  }
)

const handlerTypeArb: fc.Arbitrary<GateHandlerType> = fc.constantFrom(
  "router",
  "serverFn"
)

const requestArb: fc.Arbitrary<RequestFacts> = fc.record({
  pathname: protectedPathArb,
  handlerType: handlerTypeArb,
})

/** The sender the throttle counts against: an address, or one it could not read. */
const senderArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: fc.ipV4() },
  { weight: 1, arbitrary: fc.constantFrom("::1", "", "   ", "unknown") }
)

/* -------------------------------------------------------------------------- */
/* Shared_Passphrases                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Passphrases chosen for their shape: whitespace-wrapped, non-ASCII, astral,
 * control characters, and one long enough to rule out a length-dependent path.
 */
const NAMED_PASSPHRASES = [
  "correct horse battery staple",
  "  whitespace wrapped passphrase  ",
  "パスフレーズ-共有-秘密",
  "🔐 emoji gated passphrase 🔐",
  "Ünïcödé-Pässphräse-42",
  "tab\tand\nnewline passphrase",
  "l".repeat(600),
] as const

/**
 * Length in UTF-16 code units below which a stored value carries no identifying
 * information, so searching a fixed 87-character message for it would report a
 * coincidence rather than a leak. Values shorter than this are covered by
 * {@link assertFixedRejectionContent}, which asserts the rejection text equals
 * the module constants exactly and therefore holds no stored value of any length.
 */
const IDENTIFYING_LENGTH = 8

/**
 * A Shared_Passphrase long enough that finding it inside a response is a leak
 * rather than a coincidence. Used by the properties that search for it.
 */
const distinctivePassphraseArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 2, arbitrary: fc.constantFrom(...NAMED_PASSPHRASES) },
  {
    weight: 3,
    arbitrary: fc.string({
      minLength: IDENTIFYING_LENGTH + 4,
      maxLength: 60,
      unit: "grapheme",
    }),
  }
)

/** Any Shared_Passphrase, short ones included, for the comparison property. */
const passphraseArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 2, arbitrary: fc.constantFrom(...NAMED_PASSPHRASES) },
  {
    weight: 3,
    arbitrary: fc.string({ minLength: 1, maxLength: 60, unit: "grapheme" }),
  }
)

/* -------------------------------------------------------------------------- */
/* Cookie headers                                                             */
/* -------------------------------------------------------------------------- */

/** Cookie headers that carry no session cookie value the gate could accept. */
const NAMED_JUNK_COOKIE_HEADERS = [
  "  ",
  ";",
  ";;;",
  "=",
  "=value",
  "a=b; c=d",
  "not-a-cookie",
  SESSION_COOKIE_NAME,
  `${SESSION_COOKIE_NAME}=`,
  `${SESSION_COOKIE_NAME}=   `,
  `${SESSION_COOKIE_NAME}=%E0%A4%A`,
  "__proto__=polluted",
] as const

const junkCookieHeaderArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...NAMED_JUNK_COOKIE_HEADERS) },
  {
    weight: 2,
    arbitrary: fc
      .string({ unit: "grapheme" })
      .filter((value) => !value.includes(SESSION_COOKIE_NAME)),
  }
)

/**
 * A non-blank session cookie value that is not a token: base64url characters and
 * dots only, so a sample either holds no separator at all (malformed) or holds
 * one with a signature segment of the wrong length (tampered), and never fails
 * on percent-decoding instead.
 */
const garbageTokenArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...`abcXYZ019._-~`.split("")), {
    minLength: 1,
    maxLength: 48,
  })
  .map((units) => units.join(""))

/** Any cookie header, including the two absent forms. */
const anyCookieHeaderArb: fc.Arbitrary<string | null | undefined> = fc.oneof<
  Array<fc.Arbitrary<string | null | undefined>>
>(
  fc.constant(null),
  fc.constant(undefined),
  junkCookieHeaderArb,
  garbageTokenArb.map((token) => `${SESSION_COOKIE_NAME}=${token}`)
)

/* -------------------------------------------------------------------------- */
/* Access_Gate harness                                                        */
/* -------------------------------------------------------------------------- */

interface GateHarness {
  readonly auth: Auth
  /** The configured Shared_Passphrase; `""` when the gate is off. */
  readonly passphrase: string
  readonly sessionSecret: string
  /** Moves the injected clock forward, so nothing here sleeps. */
  readonly advance: (milliseconds: number) => void
}

/** An Access_Gate over an injected clock, passphrase, and signing key. */
function createHarness(options: {
  readonly passphrase: string | null
}): GateHarness {
  const sessionSecret = "session-signing-key-0123456789ab"
  let clock = Date.parse("2025-01-04T18:00:00.000Z")
  let issued = 0

  const auth = createAuth({
    now: () => clock,
    readSharedPassphrase: () => options.passphrase,
    readSessionSecret: () => sessionSecret,
    generateSessionId: () => {
      issued += 1
      return `session-${issued}`
    },
  })

  return {
    auth,
    passphrase: options.passphrase ?? "",
    sessionSecret,
    advance: (milliseconds) => {
      clock += milliseconds
    },
  }
}

/** A `Cookie:` header carrying `token` under the session cookie name. */
function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}`
}

interface GrantedSession {
  readonly token: string
  readonly session: SessionPayload
  readonly setCookie: string
}

/**
 * Submits the exact Shared_Passphrase and returns the granted Session
 * (Requirement 8.4). Throws rather than asserting, so a failure here reads as a
 * broken harness instead of a failed property.
 */
function grantSession(harness: GateHarness, sender: string): GrantedSession {
  const outcome = harness.auth.submitPassphrase({
    sender,
    submitted: harness.passphrase,
  })
  if (outcome.kind !== "granted") {
    throw new Error(
      `expected the exact Shared_Passphrase to grant a Session, got ${outcome.kind}`
    )
  }

  const token = readSessionCookie(outcome.setCookie.split(";")[0])
  if (token === null) {
    throw new Error("the granted Set-Cookie held no session cookie value")
  }
  return { token, session: outcome.session, setCookie: outcome.setCookie }
}

/** The same string with one character replaced, keeping it base64url. */
function flipCharacter(value: string, seed: number): string {
  const index = seed % value.length
  const replacement = value[index] === "A" ? "B" : "A"
  return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`
}

/** The token with one payload character altered, so the signature no longer fits. */
function tamperPayload(token: string, seed: number): string {
  const separator = token.indexOf(".")
  return `${flipCharacter(token.slice(0, separator), seed)}.${token.slice(
    separator + 1
  )}`
}

/** The token with one signature character altered. */
function tamperSignature(token: string, seed: number): string {
  const separator = token.indexOf(".")
  return `${token.slice(0, separator)}.${flipCharacter(
    token.slice(separator + 1),
    seed
  )}`
}

/* -------------------------------------------------------------------------- */
/* Rejection assertions                                                       */
/* -------------------------------------------------------------------------- */

/** Every reason a Session can fail to be accepted. */
const ALL_REJECT_REASONS: readonly GateRejection["reason"][] = [
  "missing",
  "malformed",
  "tampered",
  "expired",
  "revoked",
]

/**
 * The gate's second dimension, held fixed for this Requirement 8 suite: no Clerk
 * handshake, and an authorization resolver that reports `anonymous` (no Clerk
 * session). Under these facts the gate reduces to the Passphrase_Session rule
 * this suite verifies — a request with no valid Passphrase_Session is rejected,
 * and the injected resolver touches none of the counting-proxy store, so the
 * "no store read" claim is preserved.
 */
const NO_CLERK_SESSION: Pick<
  GateInput,
  "clerkHandshake" | "resolveAuthorization"
> = {
  clerkHandshake: false,
  resolveAuthorization: (): Promise<AuthorizationDecision> =>
    Promise.resolve({ kind: "anonymous" }),
}

/**
 * Evaluates the gate over the passphrase-only facts this suite fixes, awaiting
 * the now-async decision. A thin wrapper so each property reads as it did before
 * the gate gained its second dimension.
 */
function evaluatePassphraseGate(
  facts: Omit<GateInput, "clerkHandshake" | "resolveAuthorization">
): Promise<GateDecision> {
  return evaluateGate({ ...facts, ...NO_CLERK_SESSION })
}

/** One generated way of failing to carry a valid Session. */
interface CookieVariant {
  /** Names the variant in a failure message. */
  readonly label: string
  readonly header: string | null | undefined
  /** The reasons this variant may produce. */
  readonly reasons: readonly GateRejection["reason"][]
}

/**
 * Requirement 8.3: the rejection carries a status, the fixed
 * {@link SESSION_REQUIRED_MESSAGE}, and the fixed {@link LOGIN_PATH}, and nothing
 * else. Asserted as exact equality, which is what rules out a stored value of
 * any length — including one too short to search for.
 */
function assertFixedRejectionContent(
  rejection: GateRejection,
  handlerType: GateHandlerType
): void {
  expect(rejection.message).toBe(SESSION_REQUIRED_MESSAGE)
  expect(rejection.loginPath).toBe(LOGIN_PATH)
  expect(rejection.signInPath).toBe(SIGN_IN_PATH)
  /*
   * Every rejection in this Requirement 8 suite is reached with no Clerk
   * session, so authorization resolves to `anonymous` and the sender is directed
   * to both submit the passphrase and sign in.
   */
  expect(rejection.needs).toBe("passphrase-and-sign-in")

  if (handlerType === "serverFn") {
    expect(rejection.status).toBe(SESSION_REQUIRED_STATUS)
    expect(rejection.location).toBeNull()
    expect(JSON.parse(rejection.body)).toEqual({
      error: SESSION_REQUIRED_CODE,
      message: SESSION_REQUIRED_MESSAGE,
      loginPath: LOGIN_PATH,
      signInPath: SIGN_IN_PATH,
      needs: "passphrase-and-sign-in",
    })
    return
  }

  expect(rejection.status).toBe(SESSION_REQUIRED_REDIRECT_STATUS)
  expect(rejection.location).toBe(LOGIN_PATH)
  expect(rejection.body).toBe(SESSION_REQUIRED_MESSAGE)
}

/**
 * Evaluates the gate for one variant and asserts the refusal
 * (Requirements 8.2, 8.3, 8.10).
 */
async function assertRejected(
  harness: GateHarness,
  request: RequestFacts,
  variant: CookieVariant
): Promise<GateRejection> {
  const decision = await evaluatePassphraseGate({
    auth: harness.auth,
    pathname: request.pathname,
    handlerType: request.handlerType,
    cookieHeader: variant.header,
  })

  if (decision.kind !== "reject") {
    throw new Error(
      `expected ${variant.label} to be refused at ${request.pathname}, the Access_Gate admitted it (${decision.reason})`
    )
  }

  expect(variant.reasons).toContain(decision.reason)
  assertFixedRejectionContent(decision, request.handlerType)

  // Requirement 8.10: no character of the Shared_Passphrase, in any field.
  assertWithholds(
    [decision.message, decision.body, decision.loginPath].join("\n"),
    [harness.passphrase]
  )

  return decision
}

/** Every part of the response a rejection produces, as raw text. */
async function serializeRejection(rejection: GateRejection): Promise<string> {
  const response = gateRejectionResponse(rejection)
  const headerText = [...response.headers]
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n")

  return [
    rejection.reason,
    String(rejection.status),
    rejection.message,
    rejection.loginPath,
    rejection.location ?? "",
    rejection.contentType,
    rejection.body,
    String(response.status),
    headerText,
    await response.text(),
  ].join("\n")
}

/** Fails naming the value, so a leak is legible rather than a `false !== true`. */
function assertWithholds(haystack: string, needles: readonly string[]): void {
  for (const needle of needles) {
    if (needle !== "" && haystack.includes(needle)) {
      throw new Error(`the rejection disclosed ${JSON.stringify(needle)}`)
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Seeded store, wrapped in counting proxies                                  */
/* -------------------------------------------------------------------------- */

interface StoreCounters {
  registryReads: number
  historyReads: number
  runStarts: number
}

interface SeededStore {
  readonly registry: MemberRegistryStore
  readonly history: HistoryStore
  readonly coordinator: RunCoordinator
  readonly counters: StoreCounters
  /** Stored values a rejection must withhold, long enough to identify. */
  readonly needles: readonly string[]
}

function countingRegistry(
  inner: MemberRegistryStore,
  counters: StoreCounters
): MemberRegistryStore {
  return {
    list: () => {
      counters.registryReads += 1
      return inner.list()
    },
    listEnabled: () => {
      counters.registryReads += 1
      return inner.listEnabled()
    },
    add: (input) => {
      counters.registryReads += 1
      return inner.add(input)
    },
    setEnabled: (id, enabled) => {
      counters.registryReads += 1
      return inner.setEnabled(id, enabled)
    },
    remove: (id) => {
      counters.registryReads += 1
      return inner.remove(id)
    },
  }
}

function countingHistory(
  inner: HistoryStore,
  counters: StoreCounters
): HistoryStore {
  return {
    append: (record) => {
      counters.historyReads += 1
      return inner.append(record)
    },
    list: (limit) => {
      counters.historyReads += 1
      return inner.list(limit)
    },
    findLatestByCouponCode: (couponCode) => {
      counters.historyReads += 1
      return inner.findLatestByCouponCode(couponCode)
    },
  }
}

/**
 * A Redemption_Run that yields only the `run-started` event a real coordinator
 * opens with and then stops. Nothing consumes it: the counter on `start` is what
 * this stub exists for.
 */
async function* stubRun(): AsyncGenerator<RunEvent, void, void> {
  yield {
    type: "run-started",
    runId: "stub-run",
    total: 0,
    memberLabels: [],
    mock: true,
  }
}

function countingCoordinator(counters: StoreCounters): RunCoordinator {
  return {
    start: () => {
      counters.runStarts += 1
      return stubRun()
    },
    snapshot: () => null,
  }
}

/** A roster submission. */
interface RosterSeed {
  readonly memberLabel: string
  readonly hiveId: string
}

/**
 * A real Member_Registry and Redemption_History over a store whose flush is
 * replaced, seeded with `seeds` plus one deliberately distinctive entry so the
 * leak search is never vacuous.
 */
async function seedStore(
  seeds: readonly RosterSeed[],
  couponCode: string
): Promise<SeededStore> {
  const warnings: Array<string> = []
  const handle = createInMemoryMongoStore({
    logger: {
      warn: (message) => {
        warnings.push(message)
      },
    },
  })

  let memberNumber = 0
  let clock = Date.parse("2025-01-05T09:00:00.000Z")
  const registry = createMemberRegistryStore(handle.store, {
    generateId: () => {
      memberNumber += 1
      return `leak-canary-member-id-${memberNumber}`
    },
    now: () => {
      clock += 1000
      return new Date(clock)
    },
  })
  const history = createHistoryStore(handle.store)

  const stored: Array<MemberRegistryEntry> = []
  const submissions: Array<RosterSeed> = [
    { memberLabel: "Leak canary member label", hiveId: "leak-canary-hive-id" },
    ...seeds,
  ]
  for (const submission of submissions) {
    const result = await registry.add(submission)
    if (result.kind === "added") {
      stored.push(result.entry)
    }
  }

  const appended = await history.append({
    runId: "leak-canary-run-id",
    couponCode,
    completedAt: new Date(clock).toISOString(),
    mock: false,
    stoppedEarly: false,
    outcomes: stored.map((entry) => ({
      hiveId: entry.hiveId,
      memberLabel: entry.memberLabel,
      outcome: "SUCCESS",
      responseCode: "100",
      responseMessage: "leak-canary-response-message",
    })),
  })
  if (appended.kind !== "appended") {
    throw new Error(`could not seed the history: ${appended.kind}`)
  }

  expect(warnings).toEqual([])

  const counters: StoreCounters = {
    registryReads: 0,
    historyReads: 0,
    runStarts: 0,
  }

  const needles = [
    ...stored.flatMap((entry) => [
      entry.id,
      entry.memberLabel,
      entry.hiveId,
      entry.createdAt,
    ]),
    appended.record.runId,
    appended.record.couponCode,
    "leak-canary-response-message",
  ].filter((value) => value.length >= IDENTIFYING_LENGTH)

  // The distinctive entry survived the length filter, so the leak search below
  // is never vacuous however short the generated values turned out to be.
  expect(needles).toContain("leak-canary-hive-id")
  expect(needles).toContain("leak-canary-member-id-1")
  expect(needles).toContain("leak-canary-run-id")

  return {
    registry: countingRegistry(registry, counters),
    history: countingHistory(history, counters),
    coordinator: countingCoordinator(counters),
    counters,
    needles,
  }
}

/* -------------------------------------------------------------------------- */
/* Requirement 8.4: near misses                                               */
/* -------------------------------------------------------------------------- */

interface NearMiss {
  readonly label: string
  readonly value: string
}

/**
 * Values that differ from `passphrase` in exactly one way each. `seed` picks the
 * position the single-character edits act on, which may land between the halves
 * of a surrogate pair — the comparison is over UTF-16 code units, so a lone
 * surrogate is still a value distinct from the passphrase.
 */
function nearMisses(passphrase: string, seed: number): Array<NearMiss> {
  const index = seed % passphrase.length
  const replacement = passphrase[index] === "x" ? "y" : "x"

  return [
    {
      label: "one character changed",
      value: `${passphrase.slice(0, index)}${replacement}${passphrase.slice(
        index + 1
      )}`,
    },
    { label: "one character appended", value: `${passphrase}z` },
    { label: "one character prepended", value: `z${passphrase}` },
    {
      label: "one character removed",
      value: `${passphrase.slice(0, index)}${passphrase.slice(index + 1)}`,
    },
    { label: "uppercased", value: passphrase.toUpperCase() },
    { label: "lowercased", value: passphrase.toLowerCase() },
    { label: "trailing whitespace added", value: `${passphrase} ` },
    { label: "leading whitespace added", value: ` ${passphrase}` },
    { label: "trimmed", value: passphrase.trim() },
    { label: "the empty submission", value: "" },
  ].filter((candidate) => candidate.value !== passphrase)
}

/* -------------------------------------------------------------------------- */
/* Properties                                                                 */
/* -------------------------------------------------------------------------- */

describe("Access_Gate without a valid Session", () => {
  // Feature: shared-coupon-redemption, Property 24: For any request that carries
  // no valid Session while a Shared_Passphrase is configured, the Access_Gate
  // rejects it, the response holds no Member_Registry value and no
  // Redemption_History value, no Redemption_Run starts, and the response holds no
  // character of the Shared_Passphrase; and for any submitted value, a Session is
  // granted exactly when that value is character-for-character identical to the
  // Shared_Passphrase and the sender is not throttled.
  // Validates: Requirements 8.2, 8.3, 8.4, 8.10
  it("admits a request only when it carries a valid Session", async () => {
    await fc.assert(
      fc.asyncProperty(
        distinctivePassphraseArb,
        senderArb,
        requestArb,
        junkCookieHeaderArb,
        garbageTokenArb,
        fc.nat(),
        fc.nat(),
        async (
          passphrase,
          sender,
          request,
          junk,
          garbage,
          payloadSeed,
          signatureSeed
        ) => {
          const harness = createHarness({ passphrase })
          const granted = grantSession(harness, sender)

          // Requirement 8.2: the granted Session is admitted.
          expect(
            await evaluatePassphraseGate({
              auth: harness.auth,
              pathname: request.pathname,
              handlerType: request.handlerType,
              cookieHeader: sessionCookieHeader(granted.token),
            })
          ).toEqual({ kind: "admit", reason: "valid-session" })

          // Requirement 8.10: the cookie the grant issued holds no character of
          // the Shared_Passphrase.
          assertWithholds(granted.setCookie, [passphrase])

          const variants: readonly CookieVariant[] = [
            { label: "no Cookie header", header: null, reasons: ["missing"] },
            {
              label: "an undefined Cookie header",
              header: undefined,
              reasons: ["missing"],
            },
            {
              label: "an empty Cookie header",
              header: "",
              reasons: ["missing"],
            },
            {
              label: "a junk Cookie header",
              header: junk,
              reasons: ALL_REJECT_REASONS,
            },
            {
              label: "the token under another cookie name",
              header: `other_session=${granted.token}`,
              reasons: ["missing"],
            },
            {
              label: "a garbage session cookie value",
              header: sessionCookieHeader(garbage),
              reasons: ["malformed", "tampered"],
            },
            {
              label: "a token with an altered payload",
              header: sessionCookieHeader(
                tamperPayload(granted.token, payloadSeed)
              ),
              reasons: ["tampered"],
            },
            {
              label: "a token with an altered signature",
              header: sessionCookieHeader(
                tamperSignature(granted.token, signatureSeed)
              ),
              reasons: ["tampered"],
            },
            {
              label: "a token signed with another key",
              header: sessionCookieHeader(
                signSessionToken(
                  granted.session,
                  `${harness.sessionSecret}-other`
                )
              ),
              reasons: ["tampered"],
            },
          ]

          for (const variant of variants) {
            await assertRejected(harness, request, variant)
          }

          // Requirement 8.7 read through this property: an ended Session is no
          // longer a valid Session, so the gate refuses it too.
          const ended = grantSession(harness, `${sender}-ended`)
          harness.auth.logout(sessionCookieHeader(ended.token))
          await assertRejected(harness, request, {
            label: "an ended Session",
            header: sessionCookieHeader(ended.token),
            reasons: ["revoked"],
          })

          // An expired token: the injected clock moves past `expiresAt`.
          const expiring = grantSession(harness, `${sender}-expiring`)
          harness.advance(SESSION_TTL_MS + 1)
          await assertRejected(harness, request, {
            label: "an expired Session",
            header: sessionCookieHeader(expiring.token),
            reasons: ["expired"],
          })

          // The clock moved, so the token that was admitted above is now refused
          // as well: admission tracked the Session, not the request.
          await assertRejected(harness, request, {
            label: "the first Session after it expired",
            header: sessionCookieHeader(granted.token),
            reasons: ["expired"],
          })
        }
      ),
      { numRuns: 100 }
    )
  })

  // Property 24, the "nothing is read and nothing is run" half.
  // Validates: Requirements 8.3, 8.10
  it("withholds every stored value, reads no store, and starts no run", async () => {
    await fc.assert(
      fc.asyncProperty(
        distinctivePassphraseArb,
        senderArb,
        requestArb,
        rosterArb({ minLength: 1, maxLength: 5 }),
        trimmedCouponCodeArb,
        junkCookieHeaderArb,
        fc.nat(),
        async (
          passphrase,
          sender,
          request,
          roster,
          couponCode,
          junk,
          signatureSeed
        ) => {
          const seeded = await seedStore(
            roster.map(({ memberLabel, hiveId }) => ({ memberLabel, hiveId })),
            couponCode
          )
          const harness = createHarness({ passphrase })
          const granted = grantSession(harness, sender)

          const headers: ReadonlyArray<string | null> = [
            null,
            "",
            junk,
            sessionCookieHeader(tamperSignature(granted.token, signatureSeed)),
          ]

          for (const header of headers) {
            const rejection = await assertRejected(harness, request, {
              label: `the cookie header ${JSON.stringify(header)}`,
              header,
              reasons: ALL_REJECT_REASONS,
            })
            const serialized = await serializeRejection(rejection)

            // Requirement 8.3: no Member_Registry value and no
            // Redemption_History value, in the rejection or in the response.
            assertWithholds(serialized, seeded.needles)
            // Requirement 8.10: and no character of the Shared_Passphrase.
            assertWithholds(serialized, [passphrase])
          }

          // Requirement 8.3: nothing was read and nothing was started. The
          // structural argument is stronger — `evaluateGate` receives only the
          // Access_Gate seam, a pathname, a handler type, a cookie string, and an
          // injected resolver that here reports `anonymous` without touching the
          // store, so it holds no store and no coordinator to reach for — and
          // these counters are what back it up.
          expect(seeded.counters).toEqual({
            registryReads: 0,
            historyReads: 0,
            runStarts: 0,
          })

          // The counters are live: the same seams do report a read and a run
          // start when something actually touches them, so the zeroes above are
          // an observation rather than a dead assertion.
          const liveRoster = await seeded.registry.list()
          const liveHistory = await seeded.history.list()
          expect(
            liveRoster.kind === "entries" && liveRoster.entries.length
          ).toBeGreaterThan(0)
          expect(
            liveHistory.kind === "records" && liveHistory.records.length
          ).toBeGreaterThan(0)
          void seeded.coordinator.start(couponCode)
          expect(seeded.counters).toEqual({
            registryReads: 1,
            historyReads: 1,
            runStarts: 1,
          })
        }
      ),
      { numRuns: 100 }
    )
  })

  // Property 24, the login-comparison half.
  // Validates: Requirements 8.4, 8.10
  it("grants a Session for the exact Shared_Passphrase and for no near miss", async () => {
    await fc.assert(
      fc.asyncProperty(
        passphraseArb,
        senderArb,
        requestArb,
        requestArb,
        fc.nat(),
        async (passphrase, sender, first, second, seed) => {
          const harness = createHarness({ passphrase })
          const granted = grantSession(harness, sender)
          const header = sessionCookieHeader(granted.token)

          // Requirement 8.4: the granted Session admits every subsequent request.
          for (const request of [first, second]) {
            expect(
              await evaluatePassphraseGate({
                auth: harness.auth,
                pathname: request.pathname,
                handlerType: request.handlerType,
                cookieHeader: header,
              })
            ).toEqual({ kind: "admit", reason: "valid-session" })
          }

          for (const nearMiss of nearMisses(passphrase, seed)) {
            /*
             * A distinct sender per submission, so the Requirement 8.8 throttle
             * cannot turn a `rejected` outcome into a `throttled` one partway
             * through the list. The throttle is asserted on its own below.
             */
            const outcome = harness.auth.submitPassphrase({
              sender: `${sender}-${nearMiss.label}`,
              submitted: nearMiss.value,
            })

            if (outcome.kind !== "rejected") {
              throw new Error(
                `expected the submission with ${nearMiss.label} to be refused, got ${outcome.kind}`
              )
            }
            // Requirement 8.10 read through the login path: the message is the
            // fixed sentence, so it cannot hold the submitted or expected value.
            expect(outcome.message).toBe(INCORRECT_PASSPHRASE_MESSAGE)
          }

          // No near miss granted a Session, and none invalidated the one the
          // exact value granted.
          expect(
            await evaluatePassphraseGate({
              auth: harness.auth,
              pathname: first.pathname,
              handlerType: first.handlerType,
              cookieHeader: header,
            })
          ).toEqual({ kind: "admit", reason: "valid-session" })

          // "and the sender is not throttled": once a sender is blocked, even the
          // exact Shared_Passphrase grants nothing.
          const blockedSender = `${sender}-blocked`
          for (let attempt = 0; attempt < FAILED_ATTEMPT_LIMIT; attempt += 1) {
            harness.auth.submitPassphrase({
              sender: blockedSender,
              submitted: `${passphrase}-not-it`,
            })
          }
          expect(
            harness.auth.submitPassphrase({
              sender: blockedSender,
              submitted: passphrase,
            }).kind
          ).toBe("throttled")
        }
      ),
      { numRuns: 100 }
    )
  })

  // Property 24's complement: the gate is off when nothing is configured.
  // Validates: Requirement 8.9
  it("admits every request when no Shared_Passphrase is configured", async () => {
    await fc.assert(
      fc.asyncProperty(
        anyPathnameArb,
        handlerTypeArb,
        anyCookieHeaderArb,
        async (pathname, handlerType, cookieHeader) => {
          const harness = createHarness({ passphrase: null })

          expect(
            await evaluatePassphraseGate({
              auth: harness.auth,
              pathname,
              handlerType,
              cookieHeader,
            })
          ).toEqual({ kind: "admit", reason: "gate-disabled" })
        }
      ),
      { numRuns: 100 }
    )
  })

  // Property 24 rests on the exemption list never opening the data boundary.
  // Validates: Requirement 8.2
  it("exempts no server function, whatever the path looks like", () => {
    fc.assert(
      fc.property(anyPathnameArb, (pathname) => {
        expect(isGateExemptPath(pathname, "serverFn")).toBe(false)
      }),
      { numRuns: 100 }
    )
  })
})
