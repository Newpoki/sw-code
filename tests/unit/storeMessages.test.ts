/**
 * Unit tests for the store failure sentences (Requirements 1.3, 1.5, 1.6, 2.8,
 * 2.14, 3.7, 3.10, 6.15, 8.5).
 *
 * Two things are worth pinning here. Each sentence has to name its own subject,
 * because the whole point of a fixed sentence is that the reader learns which
 * operation failed. And no sentence may carry any part of the
 * Mongo_Connection_URI (Requirement 1.6), which for a module of literals means:
 * only the not-configured sentence mentions `MONGODB_URI` at all, and it names
 * the variable rather than a value.
 */

import { describe, expect, it } from "vitest"

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

/** Every sentence the module can produce, with an argument where one is needed. */
const everyMessage = (): readonly string[] => [
  notConfiguredMessage(),
  unreachableMessage(),
  rosterReadFailedMessage(),
  rosterWriteFailedMessage({ operation: "add", memberLabel: "Ana" }),
  historyReadFailedMessage(),
  historyAppendFailedMessage(),
  authorizationUnknownMessage(),
  notAuthorizedMessage(),
  mongoUnavailableCountMessage(),
]

describe("each sentence names its own subject", () => {
  it("names the MONGODB_URI variable when no database is configured", () => {
    // Requirements 1.3 and 1.10: the operator needs the variable name.
    expect(notConfiguredMessage()).toContain("MONGODB_URI")
  })

  it("states that the database is unreachable", () => {
    // Requirements 1.5 and 1.11.
    expect(unreachableMessage()).toContain("unreachable")
    expect(mongoUnavailableCountMessage()).toContain("unreachable")
  })

  it("distinguishes a roster read from a history read", () => {
    expect(rosterReadFailedMessage()).toContain("roster could not be read")
    expect(historyReadFailedMessage()).toContain(
      "Redemption_History could not be read"
    )
  })

  it("states that the history record was not saved", () => {
    // Requirement 3.7: the outcomes are still returned, so only the record is
    // spoken about.
    expect(historyAppendFailedMessage()).toContain(
      "Redemption_History record was not saved"
    )
  })

  it("separates an undetermined authorization from a refused one", () => {
    // Requirement 6.15 versus 6.6/6.7 — the reader must be able to tell "try
    // again" from "this account will never be admitted".
    expect(authorizationUnknownMessage()).toContain(
      "authorization of the request could not be determined"
    )
    expect(notAuthorizedMessage()).toContain("not authorized")
  })
})

describe("a failed roster write names the attempted change", () => {
  it("names the operation and the Member_Label, and nothing else", () => {
    // Requirement 2.8.
    const message = rosterWriteFailedMessage({
      operation: "add",
      memberLabel: "Ana",
    })
    expect(message).toContain("was not saved")
    expect(message).toContain('add "Ana"')
  })

  it("carries each of the four operations through", () => {
    for (const operation of ["add", "remove", "enable", "disable"] as const) {
      expect(
        rosterWriteFailedMessage({ operation, memberLabel: "Ana" })
      ).toContain(`${operation} "Ana"`)
    }
  })

  it("reproduces a Member_Label the caller supplied verbatim, and no Hive_ID", () => {
    /* The label is caller-supplied and already whitespace-trimmed and length-
     * bounded by validation, so it is interpolated as-is. The Hive_ID is never
     * an argument, so it cannot leak into the sentence. */
    const label = "Ana O'Brien-Smith"
    expect(
      rosterWriteFailedMessage({ operation: "remove", memberLabel: label })
    ).toContain(`remove "${label}"`)
  })
})

describe("no sentence carries any part of a connection string", () => {
  it("mentions no scheme, host, port, credential, or driver vocabulary", () => {
    // Requirement 1.6.
    const forbidden = [
      "mongodb://",
      "mongodb+srv",
      "@",
      "27017",
      "password",
      "MongoServerError",
      "ECONNREFUSED",
    ]
    for (const message of everyMessage()) {
      for (const fragment of forbidden) {
        expect(message).not.toContain(fragment)
      }
    }
  })

  it("mentions MONGODB_URI only where the operator has to act on it", () => {
    const mentioning = everyMessage().filter((message) =>
      message.includes("MONGODB_URI")
    )
    expect(mentioning).toEqual([notConfiguredMessage()])
  })

  it("produces a non-empty sentence for every failure", () => {
    for (const message of everyMessage()) {
      expect(message.trim().length).toBeGreaterThan(0)
    }
  })
})
