/**
 * Unit tests for the mapping of a caught driver rejection onto a
 * {@link StoreFailure} (Requirements 1.5, 1.6).
 *
 * Two claims are pinned here. The classification is by driver error **type**: a
 * server-selection failure, a network error, and an operation timeout are the
 * deployment giving no answer (`unreachable`, Requirement 1.5), while a server
 * error is the deployment answering no (`rejected`). And the redaction is
 * structural: every driver error below carries a host, a port, and a credential
 * in its own message, and none of that may reach the returned failure
 * (Requirement 1.6).
 *
 * The driver's error classes all document their constructors as internal. They
 * are used anyway, and deliberately: the alternative is a hand-rolled stand-in,
 * and a classifier tested only against stand-ins is a classifier tested against
 * this file's idea of the driver rather than against the driver.
 */

import { describe, expect, it } from "vitest"

import {
  MongoClientClosedError,
  MongoNetworkError,
  MongoNetworkTimeoutError,
  MongoNotConnectedError,
  MongoOperationTimeoutError,
  MongoServerClosedError,
  MongoServerError,
  MongoServerSelectionError,
  MongoTopologyClosedError,
  MongoWriteConcernError,
} from "mongodb"
import type { TopologyDescription } from "mongodb"

import {
  rosterReadFailedMessage,
  rosterWriteFailedMessage,
  unreachableMessage,
} from "@/domain/storeMessages"
import {
  classifyDriverFailure,
  driverStoreFailure,
} from "@/server/store/mongo.server"

/**
 * The connection string every error below quotes, and the fragments of it that
 * may not appear in any returned message (Requirement 1.6).
 */
const URI = "mongodb+srv://roster_writer:s3cr3t-pass@cluster0.7xk1p.mongodb.net"
const URI_FRAGMENTS = [
  URI,
  "roster_writer",
  "s3cr3t-pass",
  "cluster0.7xk1p.mongodb.net",
  "27017",
] as const

/** A server-selection failure, whose own message names every host it tried. */
function serverSelectionError(): MongoServerSelectionError {
  return new MongoServerSelectionError(
    `Server selection timed out after 5000 ms, ${URI}, no primary at cluster0.7xk1p.mongodb.net:27017`,
    /* The topology description is never read by the classifier, so an empty one
     * is enough. The constructor only stores it and reads `reason.error?.code`. */
    {} as TopologyDescription
  )
}

/** The duplicate-key rejection of the unique Hive_ID index. */
function duplicateKeyError(): MongoServerError {
  return new MongoServerError({
    message: `E11000 duplicate key error collection: sw-code.members index: hiveId_unique on ${URI}`,
    code: 11000,
    codeName: "DuplicateKey",
  })
}

/** Every error the classifier must call `unreachable`, with why. */
const unreachableCases: readonly (readonly [string, unknown])[] = [
  ["a server-selection failure", serverSelectionError()],
  [
    "a network error",
    new MongoNetworkError(
      `connection to cluster0.7xk1p.mongodb.net:27017 closed, ${URI}`
    ),
  ],
  [
    "a network timeout",
    new MongoNetworkTimeoutError(
      `connection timed out to cluster0.7xk1p.mongodb.net:27017`
    ),
  ],
  [
    "an operation timeout",
    new MongoOperationTimeoutError(
      `Operation timed out after 5000 ms against ${URI}`
    ),
  ],
  ["a closed topology", new MongoTopologyClosedError()],
  [
    "a client that never connected",
    new MongoNotConnectedError("not connected"),
  ],
  ["a closed client", new MongoClientClosedError()],
  ["a closed server", new MongoServerClosedError("server closed")],
  [
    "a server error whose code is MaxTimeMSExpired",
    new MongoServerError({
      message: `operation exceeded time limit on cluster0.7xk1p.mongodb.net:27017`,
      code: 50,
      codeName: "MaxTimeMSExpired",
    }),
  ],
  [
    "a server error whose code is HostUnreachable",
    new MongoServerError({ message: "host unreachable", code: 6 }),
  ],
]

/** Every error the classifier must call `rejected`, with why. */
const rejectedCases: readonly (readonly [string, unknown])[] = [
  ["a duplicate key", duplicateKeyError()],
  [
    "a write concern the deployment could not satisfy",
    new MongoWriteConcernError({
      writeConcernError: {
        code: 64,
        errmsg: `waiting for replication timed out at cluster0.7xk1p.mongodb.net:27017`,
        codeName: "WriteConcernFailed",
      },
      ok: 0,
    }),
  ],
  [
    "a failed document validation",
    new MongoServerError({
      message: "Document failed validation",
      code: 121,
      codeName: "DocumentValidationFailure",
    }),
  ],
  ["a plain error", new Error(`connect ECONNREFUSED for ${URI}`)],
  ["a thrown string", `ECONNREFUSED ${URI}`],
  ["a thrown null", null],
  ["nothing at all", undefined],
  ["a bare object", { detail: URI }],
]

describe("classification is by driver error type", () => {
  it("calls a deployment that gave no answer unreachable", () => {
    // Requirement 1.5.
    for (const [why, error] of unreachableCases) {
      expect(classifyDriverFailure(error), why).toBe("unreachable")
    }
  })

  it("calls a deployment that answered no rejected", () => {
    for (const [why, error] of rejectedCases) {
      expect(classifyDriverFailure(error), why).toBe("rejected")
    }
  })

  it("falls back to the class name when instanceof cannot answer", () => {
    /* A second copy of the `mongodb` package in the module graph produces error
     * classes that are not the ones the store imported, so `instanceof` fails on
     * an error that is nonetheless a server-selection failure. The class name
     * still identifies it, and carries nothing about the deployment. */
    const foreign = new Error(`Server selection timed out, ${URI}`)
    foreign.name = "MongoServerSelectionError"
    expect(classifyDriverFailure(foreign)).toBe("unreachable")
  })

  it("prefers rejected for an error it does not recognize", () => {
    /* `unreachable` claims the deployment could not be reached inside its bound.
     * An unrecognized error is no evidence for that claim, so the residue is the
     * weaker reason, which says only that the operation was not served. */
    const unknown = new Error("something went wrong")
    unknown.name = "SomeFutureDriverError"
    expect(classifyDriverFailure(unknown)).toBe("rejected")
  })
})

describe("the failure carries the operation's own sentence", () => {
  it("names the attempted change on a rejected roster write", () => {
    // Requirement 2.8.
    const change = { operation: "add", memberLabel: "Ana" } as const
    const failure = driverStoreFailure(
      duplicateKeyError(),
      rosterWriteFailedMessage(change)
    )
    expect(failure).toEqual({
      reason: "rejected",
      message: rosterWriteFailedMessage(change),
    })
  })

  it("names the attempted change on a timed-out roster write too", () => {
    /* Requirement 2.8 asks a failed write to name its change whatever stopped
     * it. The reason is what tells a timeout from a refusal, not the sentence. */
    const change = { operation: "remove", memberLabel: "Ana" } as const
    const failure = driverStoreFailure(
      serverSelectionError(),
      rosterWriteFailedMessage(change)
    )
    expect(failure).toEqual({
      reason: "unreachable",
      message: rosterWriteFailedMessage(change),
    })
  })

  it("names the roster on a failed roster read", () => {
    // Requirement 2.14.
    expect(
      driverStoreFailure(serverSelectionError(), rosterReadFailedMessage())
    ).toEqual({ reason: "unreachable", message: rosterReadFailedMessage() })
  })

  it("speaks about the database when the operation has no sentence", () => {
    /* A counter increment has no client-visible sentence of its own, so it gets
     * the one sentence that speaks about the database (Requirement 1.5). */
    for (const [why, error] of [...unreachableCases, ...rejectedCases]) {
      expect(driverStoreFailure(error).message, why).toBe(unreachableMessage())
    }
  })
})

describe("no driver text reaches the returned failure", () => {
  /** Every error above, each of which quotes the connection string. */
  const everyError = [...unreachableCases, ...rejectedCases]

  it("carries no host, port, credential, or URI fragment", () => {
    // Requirement 1.6.
    for (const [why, error] of everyError) {
      const messages = [
        driverStoreFailure(error).message,
        driverStoreFailure(error, rosterReadFailedMessage()).message,
      ]
      for (const message of messages) {
        for (const fragment of URI_FRAGMENTS) {
          expect(message, `${why} leaked ${fragment}`).not.toContain(fragment)
        }
      }
    }
  })

  it("carries none of the driver error's own message", () => {
    for (const [why, error] of everyError) {
      const driverMessage =
        error instanceof Error ? error.message : String(error)
      const failure = driverStoreFailure(error, rosterReadFailedMessage())
      expect(failure.message, why).not.toContain(driverMessage)
      /* And nothing of the error survives on the failure beyond the two fields:
       * no `cause`, no wrapped error, nothing a caller could log by accident. */
      expect(Object.keys(failure).sort(), why).toEqual(["message", "reason"])
    }
  })

  it("returns one of exactly two reasons for any input", () => {
    for (const [why, error] of everyError) {
      expect(["unreachable", "rejected"], why).toContain(
        classifyDriverFailure(error)
      )
    }
  })
})
