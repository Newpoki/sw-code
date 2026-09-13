/**
 * The Member_Registry envelope mapping (Requirements 1.1, 1.2, 1.3, 1.4, 1.5,
 * 1.9, 1.11, 1.12 of the shared-coupon-redemption spec; Requirements 2.8, 2.14
 * of the mongodb-google-auth-admin spec).
 *
 * These exercise the four envelope operations of
 * `src/functions/members.functions.ts` and their validators directly, over a
 * Member_Registry built on the in-memory Mongo_Store of
 * `tests/support/inMemoryMongoStore.ts`: no `createServerFn` call site, no HTTP,
 * and no deployment. Every operation is `async` now, reads included, so each
 * envelope is awaited.
 *
 * The persistence warning of the JSON-store era is gone. Requirement 2.8
 * replaced the applied-but-not-saved success with a rejection, so the two cases
 * asserted here are a write that landed with zero warnings and a write that did
 * not land at all — the latter arriving as a `STORE_WRITE_FAILED` envelope
 * carrying the store's own sentence.
 */

import { MongoServerError } from "mongodb"
import { describe, expect, it } from "vitest"

import { lengthRangeMessage } from "@/domain/schemas"
import {
  notConfiguredMessage,
  rosterReadFailedMessage,
  rosterWriteFailedMessage,
} from "@/domain/storeMessages"
import {
  addResultEnvelope,
  addToRoster,
  readRoster,
  removeFromRoster,
  setRosterEntryEnabled,
  validateAddMemberInput,
  validateRemoveMemberInput,
  validateSetMemberEnabledInput,
} from "@/functions/members.functions"
import {
  MEMBER_REGISTRY_MAX_ENTRIES,
  createMemberRegistryStore,
  duplicateHiveIdMessage,
  memberNotFoundMessage,
  rosterFullMessage,
} from "@/server/store/memberRegistry.server"
import type { MemberRegistryStore } from "@/server/store/memberRegistry.server"

import { createInMemoryMongoStore } from "../support/inMemoryMongoStore"
import type { InMemoryMongoStoreHandle } from "../support/inMemoryMongoStore"

/**
 * A deployment that answered, and its answer was no.
 *
 * The `reason` on the {@link StoreFailure} decides the code: a refusal is
 * `rejected`, therefore `STORE_READ_FAILED` or `STORE_WRITE_FAILED`, while a
 * timeout or a lost connection is `unreachable`, therefore `STORE_UNAVAILABLE`.
 * Both are covered below.
 */
function refused(): MongoServerError {
  return new MongoServerError({
    message: "Document failed validation",
    code: 121,
  })
}

/** A registry over a fresh in-memory store, and the handle behind it. */
function registry(): {
  readonly handle: InMemoryMongoStoreHandle
  readonly store: MemberRegistryStore
} {
  const handle = createInMemoryMongoStore()
  return { handle, store: createMemberRegistryStore(handle.store) }
}

describe("a successful write (Requirements 1.1, 1.12, 2.9)", () => {
  it("returns the stored entry with zero warnings", async () => {
    const { store } = registry()

    const envelope = await addToRoster(store, {
      memberLabel: "Alice",
      hiveId: "1001",
    })

    expect(envelope.ok).toBe(true)
    if (!envelope.ok) return
    expect(envelope.data.memberLabel).toBe("Alice")
    expect(envelope.data.hiveId).toBe("1001")
    expect(envelope.data.enabled).toBe(true)
    expect(envelope.warnings).toEqual([])
  })

  it("rejects rather than warning when the insert does not land (Requirement 2.8)", async () => {
    const { handle, store } = registry()
    handle.setRejection("members", "insertOne", refused())

    const envelope = await addToRoster(store, {
      memberLabel: "Alice",
      hiveId: "1001",
    })

    /* Requirement 2.8 supersedes the in-memory-with-warning behaviour of
     * shared-coupon-redemption Requirement 1.8: there is no applied-but-unsaved
     * state left, so a write that failed is a rejection rather than a success
     * carrying a warning. */
    expect(envelope.ok).toBe(false)
    if (envelope.ok) return
    expect(envelope.error.code).toBe("STORE_WRITE_FAILED")
    expect(envelope.error.message).toBe(
      rosterWriteFailedMessage({ operation: "add", memberLabel: "Alice" })
    )

    // And nothing is served from memory either: the collection is unchanged.
    const roster = await readRoster(store)
    expect(roster.ok && roster.data).toEqual([])
  })
})

describe("the roster read (Requirements 1.4, 2.2, 2.14)", () => {
  it("returns every entry in position order with no warning", async () => {
    const { store } = registry()
    for (const hiveId of ["c", "a", "b"]) {
      await addToRoster(store, { memberLabel: `Member ${hiveId}`, hiveId })
    }

    const envelope = await readRoster(store)

    expect(envelope.ok).toBe(true)
    if (!envelope.ok) return
    expect(envelope.data.map((entry) => entry.hiveId)).toEqual(["c", "a", "b"])
    expect(envelope.warnings).toEqual([])
  })

  it("rejects with zero entries when the read does not complete", async () => {
    const { handle, store } = registry()
    await addToRoster(store, { memberLabel: "Alice", hiveId: "1001" })
    handle.setRejection("members", "find", refused())

    const envelope = await readRoster(store)

    /* Requirement 2.14: a database that could not be read does not render as an
     * empty roster. */
    expect(envelope.ok).toBe(false)
    if (envelope.ok) return
    expect(envelope.error.code).toBe("STORE_READ_FAILED")
    expect(envelope.error.message).toBe(rosterReadFailedMessage())
  })

  it("reports STORE_UNAVAILABLE when nothing was attempted at all", async () => {
    const { handle, store } = registry()
    handle.setCollectionFailure("members", {
      reason: "not-configured",
      message: notConfiguredMessage(),
    })

    const envelope = await readRoster(store)

    expect(envelope.ok).toBe(false)
    if (envelope.ok) return
    expect(envelope.error.code).toBe("STORE_UNAVAILABLE")
    expect(envelope.error.message).toBe(notConfiguredMessage())
  })
})

describe("rejections carry the store's own message", () => {
  it("names the conflicting Member_Label on a duplicate Hive_ID (Requirement 1.2)", async () => {
    const { store } = registry()
    await addToRoster(store, { memberLabel: "Alice", hiveId: "1001" })

    const envelope = await addToRoster(store, {
      memberLabel: "Bob",
      hiveId: " 1001 ",
    })

    expect(envelope.ok).toBe(false)
    if (envelope.ok) return
    expect(envelope.error.code).toBe("DUPLICATE_HIVE_ID")
    expect(envelope.error.message).toBe(duplicateHiveIdMessage("Alice"))
    expect(envelope.error.message).toContain("Alice")
  })

  it("states the maximum of 100 entries on a full roster (Requirement 1.11)", () => {
    const envelope = addResultEnvelope({ kind: "full" })

    expect(envelope.ok).toBe(false)
    if (envelope.ok) return
    expect(envelope.error.code).toBe("ROSTER_FULL")
    expect(envelope.error.message).toBe(rosterFullMessage())
    expect(envelope.error.message).toContain(
      String(MEMBER_REGISTRY_MAX_ENTRIES)
    )
    expect(envelope.error.message).toContain("100")
  })

  it("names the field and its range on an invalid value (Requirement 1.3)", async () => {
    const { store } = registry()

    const envelope = await addToRoster(store, {
      memberLabel: "   ",
      hiveId: "1001",
    })

    expect(envelope.ok).toBe(false)
    if (envelope.ok) return
    expect(envelope.error.code).toBe("VALIDATION")
    expect(envelope.error.message).toBe(
      lengthRangeMessage("Member_Label", 1, 40)
    )

    // Nothing was stored.
    const roster = await readRoster(store)
    expect(roster.ok && roster.data).toEqual([])
  })

  it("reports MEMBER_NOT_FOUND for an unknown id (Requirements 1.5, 1.9)", async () => {
    const { store } = registry()

    const toggled = await setRosterEntryEnabled(store, {
      id: "no-such-id",
      enabled: false,
    })
    const removed = await removeFromRoster(store, { id: "no-such-id" })

    for (const envelope of [toggled, removed]) {
      expect(envelope.ok).toBe(false)
      if (envelope.ok) continue
      expect(envelope.error.code).toBe("MEMBER_NOT_FOUND")
      expect(envelope.error.message).toBe(memberNotFoundMessage())
    }
  })
})

describe("the enabled state and removal (Requirements 1.5, 1.9)", () => {
  it("returns the updated entry, then removes it by id", async () => {
    const { store } = registry()
    const added = await addToRoster(store, {
      memberLabel: "Alice",
      hiveId: "1001",
    })
    expect(added.ok).toBe(true)
    if (!added.ok) return

    const toggled = await setRosterEntryEnabled(store, {
      id: added.data.id,
      enabled: false,
    })
    expect(toggled.ok).toBe(true)
    if (!toggled.ok) return
    expect(toggled.data).toEqual({ ...added.data, enabled: false })
    expect(toggled.warnings).toEqual([])

    const removed = await removeFromRoster(store, { id: added.data.id })
    expect(removed.ok).toBe(true)
    if (!removed.ok) return
    expect(removed.data).toEqual({ id: added.data.id })

    const roster = await readRoster(store)
    expect(roster.ok && roster.data).toEqual([])
  })

  it("reports a failed change with the operation it attempted (Requirement 2.8)", async () => {
    const { handle, store } = registry()
    const added = await addToRoster(store, {
      memberLabel: "Alice",
      hiveId: "1001",
    })
    expect(added.ok).toBe(true)
    if (!added.ok) return

    handle.setRejection("members", "deleteOne", refused())
    const removed = await removeFromRoster(store, { id: added.data.id })

    expect(removed.ok).toBe(false)
    if (removed.ok) return
    expect(removed.error.code).toBe("STORE_WRITE_FAILED")
    expect(removed.error.message).toBe(
      rosterWriteFailedMessage({ operation: "remove", memberLabel: "Alice" })
    )

    // The entry is still there: nothing was deleted.
    handle.clearRejection("members", "deleteOne")
    const roster = await readRoster(store)
    expect(roster.ok && roster.data.map((entry) => entry.hiveId)).toEqual([
      "1001",
    ])
  })
})

describe("the validators report instead of throwing (Requirement 1.3)", () => {
  it("accepts a well-formed payload and hands back the trimmed value", () => {
    expect(
      validateAddMemberInput({ memberLabel: "  Alice  ", hiveId: " 1001 " })
    ).toEqual({ ok: true, value: { memberLabel: "Alice", hiveId: "1001" } })
    expect(validateRemoveMemberInput({ id: "abc" })).toEqual({
      ok: true,
      value: { id: "abc" },
    })
    expect(
      validateSetMemberEnabledInput({ id: "abc", enabled: false })
    ).toEqual({ ok: true, value: { id: "abc", enabled: false } })
  })

  it("reports a message naming the field and its range for a bad payload", () => {
    expect(validateAddMemberInput({ memberLabel: "", hiveId: "1001" })).toEqual(
      {
        ok: false,
        message: lengthRangeMessage("Member_Label", 1, 40),
      }
    )
    expect(
      validateAddMemberInput({ memberLabel: "Alice", hiveId: "x".repeat(65) })
    ).toEqual({ ok: false, message: lengthRangeMessage("Hive_ID", 1, 64) })
    expect(validateRemoveMemberInput({ id: "  " })).toEqual({
      ok: false,
      message: lengthRangeMessage("Member id", 1, 64),
    })
  })

  it("reports rather than throwing for a payload of the wrong shape", () => {
    // A hostile caller can send anything; the verdict is still a value.
    const verdict = validateAddMemberInput(
      "not an object" as unknown as { memberLabel: string; hiveId: string }
    )
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.message.length).toBeGreaterThan(0)
  })
})
