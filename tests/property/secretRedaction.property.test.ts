// Feature: mongodb-google-auth-admin, Property 2: No configured secret ever appears in anything the server produces — for any Mongo_Connection_URI carrying arbitrary credentials and an arbitrary host, for any Clerk secret key, and for any failure produced by any Member_Registry operation, Redemption_History operation, Admin_Page read, or identity refresh (including driver errors whose own messages embed the host and the credentials), every message, every returned envelope, and every log line the Redemption_Server emits contains neither the credentials, nor the host, nor the Clerk secret key, nor any substring of the connection string longer than three characters.
//
// Validates: Requirements 1.5, 1.6, 5.10.
//
// ## What this property drives, and why through the real modules
//
// Requirement 1.6 is not a claim about one constant; it is a claim about every
// surface a failure travels through. So this file injects a driver error whose
// own message quotes the whole connection string — credentials, host, and port
// — into every failure path the design lists, and a Clerk error quoting the
// secret key into the identity refresh, and then reads everything those paths
// produce: the `StoreFailure.message` each store returns, the `Envelope` a
// server-function surface hands the Web_Client (serialized with
// `JSON.stringify`, so a leak hiding in a nested field is caught), and every
// line the injected logger captured. The assertion is that none of them holds a
// forbidden fragment.
//
// The failures are driven through the real modules — `createMemberRegistryStore`,
// `createHistoryStore`, `createUserAccountStore`, `storeFailureEnvelope`,
// `readRoster`, `readHistory`, `readLatestRunForCoupon` — over the in-memory
// Mongo_Store fake of `tests/support/inMemoryMongoStore.ts`, whose `setRejection`
// makes one operation reject with a real driver error. That is the same seam the
// two hand-built failure suites use; here it is exercised across every operation
// at once, over arbitrary secrets rather than one fixed URI.
//
// ## The ">3-character substring" check, and why the secrets are distinctive
//
// The design forbids "any substring of the connection string longer than three
// characters" from surfacing. Checked naively against arbitrary generated
// secrets, that is a flaky assertion: a randomly generated four-character run
// could coincidentally occur inside a fixed English sentence — "The database is
// unreachable" contains "The ", "data", "base", and so on — and fail the test
// for a coincidence rather than a leak.
//
// The intent is real redaction, not coincidence, so the generated secrets are
// constrained to be *distinctive*: every credential, host label, and Clerk key
// carries the rare marker `Zx9`, plus digits and mixed case, and holds no run of
// four characters that appears in any of the fixed sentences the server can
// produce (asserted directly, in "the fixed sentences share no four-character
// run with a generated secret"). Given that, the ">3-char substring" check is
// run over the distinctive secret pieces — the credentials, the host, and the
// Clerk key — every four-character window of each of which is asserted absent
// from every produced string. That is the honest form of the design's claim: a
// four-character window of a distinctive secret surfacing anywhere is a leak,
// and cannot be a coincidence, because the fixed sentences were shown to hold no
// such window.

import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
  MongoNetworkError,
  MongoOperationTimeoutError,
  MongoServerError,
} from "mongodb"

import { storeFailureEnvelope } from "@/domain/storeFailures"
import {
  authorizationUnknownMessage,
  historyAppendFailedMessage,
  historyReadFailedMessage,
  mongoUnavailableCountMessage,
  notAuthorizedMessage,
  notConfiguredMessage,
  rosterReadFailedMessage,
  rosterWriteFailedMessage,
  unreachableMessage,
} from "@/domain/storeMessages"
import {
  readHistory,
  readLatestRunForCoupon,
} from "@/functions/history.functions"
import { readRoster } from "@/functions/members.functions"
import { createIdentity } from "@/server/identity.server"
import type { ClerkUser, Identity } from "@/server/identity.server"
import { createHistoryStore } from "@/server/store/history.server"
import type { AppendHistoryInput } from "@/server/store/history.server"
import { createMemberRegistryStore } from "@/server/store/memberRegistry.server"
import { createUserAccountStore } from "@/server/store/userAccounts.server"
import type {
  MemberDocumentInput,
  HistoryDocumentInput,
  UserAccountDocument,
} from "@/server/store/documents.server"
import type {
  CollectionMethod,
  InMemoryMongoStoreHandle,
} from "../support/inMemoryMongoStore"
import { createInMemoryMongoStore } from "../support/inMemoryMongoStore"

/* -------------------------------------------------------------------------- */
/* The secret bundle: a distinctive Mongo URI and Clerk key                   */
/* -------------------------------------------------------------------------- */

/**
 * A generated set of secrets: the credentials, host, and port that make up a
 * Mongo_Connection_URI, the connection string itself, and a Clerk secret key.
 *
 * Every piece carries the marker {@link RARE_MARKER}, digits, and mixed case, so
 * no four-character window of any of them coincides with a run of the fixed
 * English sentences the server produces — which is what makes the
 * ">3-character substring" assertion evidence of a leak rather than of a
 * coincidence.
 */
interface SecretBundle {
  readonly username: string
  readonly password: string
  readonly host: string
  readonly port: string
  /** The whole connection string, of which no four-character window may leak. */
  readonly uri: string
  readonly clerkSecretKey: string
  /**
   * The distinctive secret fragments whose every four-character window must be
   * absent from anything the server produces: the credentials, the host, and
   * the Clerk key. The URI is decomposed into these so the check runs over the
   * distinctive parts, not over the fixed `mongodb+srv://` / `@` / `:` scaffolding.
   */
  readonly fragments: readonly string[]
}

/** The rare marker every generated secret carries, so it cannot occur by chance. */
const RARE_MARKER = "Zx9"

/**
 * A distinctive token: the rare marker, then a run of digits and mixed-case
 * letters drawn from an alphabet chosen so that {@link RARE_MARKER} plus the run
 * shares no four-character window with any fixed sentence. The alphabet holds no
 * lower-case vowels and no spaces, so English fragments like "data", "base", or
 * "read" cannot appear inside it.
 */
function distinctiveTokenArb(minLength: number): fc.Arbitrary<string> {
  const alphabet = "BCDFGHJKLMNPQRSTVWXZ0123456789"
  return fc
    .array(
      fc
        .integer({ min: 0, max: alphabet.length - 1 })
        .map((at) => alphabet[at]),
      { minLength, maxLength: minLength + 12 }
    )
    .map((chars) => `${RARE_MARKER}${chars.join("")}`)
}

/** A generated {@link SecretBundle}. */
const secretBundleArb: fc.Arbitrary<SecretBundle> = fc
  .record({
    username: distinctiveTokenArb(4),
    password: distinctiveTokenArb(6),
    hostLabel: distinctiveTokenArb(5),
    port: fc.integer({ min: 10000, max: 65535 }).map((value) => String(value)),
    clerkTail: distinctiveTokenArb(8),
  })
  .map(({ username, password, hostLabel, port, clerkTail }) => {
    const host = `${hostLabel}.mongodb.net`
    const uri = `mongodb+srv://${username}:${password}@${host}:${port}/admin?retryWrites=false`
    const clerkSecretKey = `sk_test_${clerkTail}`
    return {
      username,
      password,
      host,
      port,
      uri,
      clerkSecretKey,
      /* The host is split at the `.` so the check runs over the distinctive
       * label; `mongodb.net` and the port are not secret. The credentials and
       * the Clerk tail are wholly distinctive. */
      fragments: [username, password, hostLabel, clerkTail],
    }
  })

/* -------------------------------------------------------------------------- */
/* Driver errors that embed the secrets                                       */
/* -------------------------------------------------------------------------- */

/**
 * The driver errors a failing operation can reject with, each one quoting the
 * whole connection string in its own message the way a real driver error does —
 * a server-selection failure and a network failure naming the host and port, a
 * timeout naming the URI, and a refused write naming it too. Requirement 1.6
 * holds when none of these messages reaches a returned value or a log line.
 *
 * The server-selection case is a `MongoServerError` carrying a
 * selection-shaped message rather than a `MongoServerSelectionError`: the v6
 * `MongoServerSelectionError` constructor takes a topology reason object, not a
 * string, and cannot be built with an arbitrary message here. The store
 * classifies it the same way, and the message is what the redaction check is
 * about.
 */
function driverErrorsEmbedding(secret: SecretBundle): readonly unknown[] {
  return [
    new MongoServerError({
      message: `Server selection timed out after 5000 ms, ${secret.host}:${secret.port} unreachable, ${secret.uri}`,
      codeName: "HostUnreachable",
    }),
    new MongoNetworkError(
      `connection to ${secret.host}:${secret.port} closed while authenticating ${secret.username}, ${secret.uri}`
    ),
    new MongoOperationTimeoutError(
      `Operation timed out after 5000 ms against ${secret.uri}`
    ),
    new MongoServerError({
      message: `Authentication failed for ${secret.username}:${secret.password} on ${secret.uri}`,
      code: 18,
      codeName: "AuthenticationFailed",
    }),
  ]
}

/** A Clerk error whose own message embeds the Clerk secret key and the config. */
function clerkErrorEmbedding(secret: SecretBundle): Error {
  return new Error(
    `Clerk request failed: Authorization: Bearer ${secret.clerkSecretKey} (key ${secret.clerkSecretKey})`
  )
}

/* -------------------------------------------------------------------------- */
/* Fixtures the failing operations run against                                */
/* -------------------------------------------------------------------------- */

/** A seeded roster entry, so read and write paths have something to act on. */
const SEEDED_MEMBERS: MemberDocumentInput[] = [
  {
    entryId: "m-1",
    memberLabel: "Ana",
    hiveId: "hive-ana",
    enabled: true,
    createdAt: new Date("2025-01-04T18:00:00.000Z"),
    position: 1,
  },
]

/** A seeded history record, so the read and coupon-lookup paths have a row. */
const SEEDED_HISTORY: HistoryDocumentInput[] = [
  {
    runId: "run-1",
    seq: 1,
    couponCode: "SW2025NEWYEAR",
    completedAt: "2025-01-04T18:00:00.000Z",
    completedAtMs: Date.parse("2025-01-04T18:00:00.000Z"),
    mock: false,
    stoppedEarly: false,
    outcomes: [
      {
        hiveId: "hive-ana",
        memberLabel: "Ana",
        outcome: "SUCCESS",
        responseCode: "(100)",
        responseMessage: "Coupon redeemed.",
      },
    ],
  },
]

/** A seeded user account, so `resolve` has a document to read before refreshing. */
const SEEDED_ACCOUNTS: Omit<UserAccountDocument, "_id">[] = [
  {
    clerkUserId: "user_seed",
    email: "seed@example.com",
    emailLower: "seed@example.com",
    displayName: "Seed",
    role: "member" as const,
    lastSyncedAt: new Date("2025-01-04T18:00:00.000Z"),
    lastSessionId: "sess_seed",
    lastSignInAt: new Date("2025-01-04T18:00:00.000Z"),
  },
] as const

/** The append every failing append attempts. Valid, so nothing rejects it early. */
const APPEND_INPUT: AppendHistoryInput = {
  runId: "run-new",
  couponCode: "SW2025SUMMER",
  completedAt: "2025-01-04T21:00:00.000Z",
  mock: false,
  stoppedEarly: false,
  outcomes: [
    {
      hiveId: "hive-ana",
      memberLabel: "Ana",
      outcome: "SUCCESS",
      responseCode: "(100)",
      responseMessage: "Coupon redeemed.",
    },
  ],
}

/** A fresh in-memory store, seeded, with a capturing logger. */
function freshStore(): InMemoryMongoStoreHandle {
  return createInMemoryMongoStore({
    seed: {
      members: SEEDED_MEMBERS,
      history: SEEDED_HISTORY,
      user_accounts: SEEDED_ACCOUNTS,
    },
  })
}

/**
 * An {@link Identity} whose profile fetch rejects with a Clerk error embedding
 * the secret key — the identity-refresh failure the property drives. `getUser`
 * throwing is the shape `createIdentity` catches and maps to a coarse,
 * Clerk-free failure; if any part of the thrown error escaped, it would surface
 * in the User_Account result this file reads.
 */
function leakingIdentity(secret: SecretBundle): Identity {
  return createIdentity({
    configured: () => true,
    auth: async () => ({ userId: "user_seed", sessionId: "sess_new" }),
    users: () => ({
      getUser: (): Promise<ClerkUser> =>
        Promise.reject(clerkErrorEmbedding(secret)),
    }),
    timeoutMs: 5000,
  })
}

/* -------------------------------------------------------------------------- */
/* Collecting everything the server produced                                  */
/* -------------------------------------------------------------------------- */

/**
 * Drives every failure surface the design lists over one secret bundle and one
 * driver error, and returns every string the server produced: store failure
 * messages, the envelopes a Web_Client would receive (as JSON), the
 * User_Account results, and every captured log line.
 */
async function produced(
  secret: SecretBundle,
  driverError: unknown
): Promise<string[]> {
  const output: string[] = []
  const record = (value: unknown): void => {
    output.push(typeof value === "string" ? value : JSON.stringify(value))
  }

  const now = () => new Date("2025-01-05T00:00:00.000Z")

  /* -- Member_Registry: every read and write path -- */
  {
    const handle = freshStore()
    const roster = createMemberRegistryStore(handle.store, {
      generateId: () => "m-new",
      now,
    })
    const methods: readonly CollectionMethod[] = [
      "find",
      "findOne",
      "countDocuments",
      "insertOne",
      "findOneAndUpdate",
      "deleteOne",
    ]
    for (const method of methods) {
      handle.setRejection("members", method, driverError)
      handle.setRejection("counters", "findOneAndUpdate", driverError)
    }

    const list = await roster.list()
    const listEnabled = await roster.listEnabled()
    const add = await roster.add({ memberLabel: "Bruno", hiveId: "hive-bruno" })
    const setEnabled = await roster.setEnabled("m-1", false)
    const remove = await roster.remove("m-1")

    for (const result of [list, listEnabled, add, setEnabled, remove]) {
      record(result)
      /* The envelope surface a Web_Client would receive for the read path. */
      if (result.kind === "failed") {
        record(storeFailureEnvelope(result.failure, "read"))
        record(storeFailureEnvelope(result.failure, "write"))
      }
    }
    /* The server-function surface: `readRoster` maps the failure to an envelope. */
    record(await readRoster(roster))
    for (const warning of handle.warnings) {
      record(warning)
    }
  }

  /* -- Redemption_History: append, both reads, and the retention trim -- */
  {
    const handle = freshStore()
    const history = createHistoryStore(handle.store, { logger: handle.logger })

    /* A failed append and both failed reads. */
    handle.setRejection("history", "insertOne", driverError)
    handle.setRejection("counters", "findOneAndUpdate", driverError)
    handle.setRejection("history", "find", driverError)
    const append = await history.append(APPEND_INPUT)
    const list = await history.list()
    const found = await history.findLatestByCouponCode("SW2025NEWYEAR")
    for (const result of [append, list, found]) {
      record(result)
      if (result.kind === "failed") {
        record(storeFailureEnvelope(result.failure, "read"))
        record(storeFailureEnvelope(result.failure, "write"))
      }
    }
    record(await readHistory(history))
    record(
      await readLatestRunForCoupon(history, { couponCode: "SW2025NEWYEAR" })
    )
    for (const warning of handle.warnings) {
      record(warning)
    }
  }

  /* -- The retention-trim failure: the append succeeds, the trim warns the log -- */
  {
    const handle = freshStore()
    const history = createHistoryStore(handle.store, { logger: handle.logger })
    /* Let the append land, but fail the retention count/find/delete so the trim
     * logs its warning — a log line the Web_Client never sees but the operator
     * does, and which must still hold no driver text. */
    handle.setRejection("history", "countDocuments", driverError)
    handle.setRejection("history", "retentionFind", driverError)
    handle.setRejection("history", "deleteMany", driverError)
    record(await history.append(APPEND_INPUT))
    for (const warning of handle.warnings) {
      record(warning)
    }
  }

  /* -- The Admin_Page reads and the identity refresh -- */
  {
    const handle = freshStore()
    const accounts = createUserAccountStore(handle.store, {
      identity: leakingIdentity(secret),
      allowlist: ["ana@example.com"],
      now,
    })

    /* resolve() forces a refresh (new session id), so `Identity.profile` runs
     * and rejects with the Clerk error embedding the secret key. */
    record(
      await accounts.resolve({ userId: "user_seed", sessionId: "sess_new" })
    )

    /* listForAdminPage() over a store whose read rejects with the driver error. */
    handle.setRejection("user_accounts", "find", driverError)
    record(await accounts.listForAdminPage())

    /* And resolve() again with the read itself rejecting. */
    handle.setRejection("user_accounts", "findOne", driverError)
    record(
      await accounts.resolve({ userId: "user_seed", sessionId: "sess_new" })
    )
    for (const warning of handle.warnings) {
      record(warning)
    }
  }

  return output
}

/* -------------------------------------------------------------------------- */
/* The forbidden fragments and the assertion                                  */
/* -------------------------------------------------------------------------- */

/** Every four-character window of `value`. */
function fourCharWindows(value: string): string[] {
  const windows: string[] = []
  for (let at = 0; at + 4 <= value.length; at += 1) {
    windows.push(value.slice(at, at + 4))
  }
  return windows
}

/**
 * Every fixed sentence the server can produce. Used to prove that no
 * four-character window of a generated secret coincides with the redaction
 * text, so the substring check below cannot fail on a coincidence.
 */
function fixedSentences(): string[] {
  return [
    notConfiguredMessage(),
    unreachableMessage(),
    rosterReadFailedMessage(),
    rosterWriteFailedMessage({ operation: "add", memberLabel: "Ana" }),
    rosterWriteFailedMessage({
      operation: "remove",
      memberLabel: "the selected entry",
    }),
    historyReadFailedMessage(),
    historyAppendFailedMessage(),
    authorizationUnknownMessage(),
    notAuthorizedMessage(),
    mongoUnavailableCountMessage(),
  ]
}

/**
 * Asserts that no produced string holds a forbidden fragment: the credentials,
 * the host label, or the Clerk key verbatim, nor any four-character window of
 * any distinctive secret piece.
 */
function expectNoLeak(secret: SecretBundle, output: readonly string[]): void {
  const windows = new Set(secret.fragments.flatMap(fourCharWindows))
  for (const line of output) {
    for (const fragment of secret.fragments) {
      expect(line, `leaked the secret "${fragment}"`).not.toContain(fragment)
    }
    for (const window of windows) {
      expect(
        line,
        `leaked the four-character window "${window}" of a secret`
      ).not.toContain(window)
    }
  }
}

/* -------------------------------------------------------------------------- */
/* The property                                                               */
/* -------------------------------------------------------------------------- */

describe("Property 2: no configured secret ever appears in anything the server produces", () => {
  it("the fixed sentences share no four-character run with a generated secret", () => {
    /* The premise of the substring check: the distinctive-token alphabet was
     * chosen so no four-character window of a generated secret occurs in any
     * fixed sentence, so a window surfacing anywhere is a leak and not a
     * coincidence. */
    const sentenceWindows = new Set(fixedSentences().flatMap(fourCharWindows))
    fc.assert(
      fc.property(secretBundleArb, (secret) => {
        for (const fragment of secret.fragments) {
          for (const window of fourCharWindows(fragment)) {
            expect(sentenceWindows.has(window)).toBe(false)
          }
        }
      }),
      { numRuns: 200 }
    )
  })

  it("emits no store failure message, envelope, or log line holding a secret, across every failure surface", async () => {
    await fc.assert(
      fc.asyncProperty(
        secretBundleArb,
        fc.integer({ min: 0, max: 3 }),
        async (secret, errorIndex) => {
          const driverError = driverErrorsEmbedding(secret)[errorIndex]
          const output = await produced(secret, driverError)
          /* The paths ran and produced something to check, so a silent no-op
           * cannot pass this vacuously. */
          expect(output.length).toBeGreaterThan(0)
          expectNoLeak(secret, output)
        }
      ),
      { numRuns: 100 }
    )
  })
})
