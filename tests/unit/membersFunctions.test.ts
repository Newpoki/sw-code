/**
 * The Member_Registry envelope mapping (Requirements 1.1, 1.2, 1.3, 1.4, 1.5,
 * 1.8, 1.9, 1.11, 1.12).
 *
 * These exercise the four envelope operations of
 * `src/functions/members.functions.ts` and their validators directly, over a
 * store built on an injected flush: no `createServerFn` call site, no HTTP, and
 * no filesystem write. The `DATA_FILE` path handed to every store points into a
 * fresh temporary directory that never exists, so the repository's own
 * `data/store.json` is neither read nor written.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { lengthRangeMessage } from "@/domain/schemas"
import {
  PERSISTENCE_WARNING,
  addResultEnvelope,
  addToRoster,
  readRoster,
  removeFromRoster,
  setRosterEntryEnabled,
  validateAddMemberInput,
  validateRemoveMemberInput,
  validateSetMemberEnabledInput,
} from "@/functions/members.functions"
import { createJsonStore } from "@/server/store/jsonStore.server"
import {
  MEMBER_REGISTRY_MAX_ENTRIES,
  createMemberRegistryStore,
  duplicateHiveIdMessage,
  memberNotFoundMessage,
  rosterFullMessage,
} from "@/server/store/memberRegistry.server"
import type { FlushFn } from "@/server/store/jsonStore.server"
import type { MemberRegistryStore } from "@/server/store/memberRegistry.server"

const landing: FlushFn = () => Promise.resolve()
const failing: FlushFn = () => Promise.reject(new Error("disk full"))

const tempDirs: Array<string> = []

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

/** A Member_Registry over a store whose flush behaves as `flush` says. */
async function registryWith(flush: FlushFn): Promise<MemberRegistryStore> {
  const dir = await mkdtemp(join(tmpdir(), "scr-members-fn-"))
  tempDirs.push(dir)
  return createMemberRegistryStore(
    createJsonStore({
      dataFilePath: join(dir, "store.json"),
      flush,
      logger: { warn: () => {} },
    })
  )
}

describe("a successful write (Requirements 1.1, 1.12)", () => {
  it("returns the stored entry with zero warnings when the flush lands", async () => {
    const registry = await registryWith(landing)

    const envelope = await addToRoster(registry, {
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

  it("attaches exactly one persistence warning when the flush fails (Requirement 1.8)", async () => {
    const registry = await registryWith(failing)

    const envelope = await addToRoster(registry, {
      memberLabel: "Alice",
      hiveId: "1001",
    })

    expect(envelope.ok).toBe(true)
    if (!envelope.ok) return
    expect(envelope.warnings).toEqual([PERSISTENCE_WARNING])
    expect(PERSISTENCE_WARNING).toContain("not persisted across a restart")

    // The change is still served from memory.
    const roster = readRoster(registry)
    expect(roster.ok).toBe(true)
    if (!roster.ok) return
    expect(roster.data.map((entry) => entry.hiveId)).toEqual(["1001"])
  })
})

describe("the roster read (Requirement 1.4)", () => {
  it("returns every entry in insertion order with no warning", async () => {
    const registry = await registryWith(landing)
    for (const hiveId of ["c", "a", "b"]) {
      await addToRoster(registry, { memberLabel: `Member ${hiveId}`, hiveId })
    }

    const envelope = readRoster(registry)

    expect(envelope.ok).toBe(true)
    if (!envelope.ok) return
    expect(envelope.data.map((entry) => entry.hiveId)).toEqual(["c", "a", "b"])
    expect(envelope.warnings).toEqual([])
  })
})

describe("rejections carry the store's own message", () => {
  it("names the conflicting Member_Label on a duplicate Hive_ID (Requirement 1.2)", async () => {
    const registry = await registryWith(landing)
    await addToRoster(registry, { memberLabel: "Alice", hiveId: "1001" })

    const envelope = await addToRoster(registry, {
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
    const registry = await registryWith(landing)

    const envelope = await addToRoster(registry, {
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
    const roster = readRoster(registry)
    expect(roster.ok && roster.data).toEqual([])
  })

  it("reports MEMBER_NOT_FOUND for an unknown id (Requirements 1.5, 1.9)", async () => {
    const registry = await registryWith(landing)

    const toggled = await setRosterEntryEnabled(registry, {
      id: "no-such-id",
      enabled: false,
    })
    const removed = await removeFromRoster(registry, { id: "no-such-id" })

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
    const registry = await registryWith(landing)
    const added = await addToRoster(registry, {
      memberLabel: "Alice",
      hiveId: "1001",
    })
    expect(added.ok).toBe(true)
    if (!added.ok) return

    const toggled = await setRosterEntryEnabled(registry, {
      id: added.data.id,
      enabled: false,
    })
    expect(toggled.ok).toBe(true)
    if (!toggled.ok) return
    expect(toggled.data).toEqual({ ...added.data, enabled: false })
    expect(toggled.warnings).toEqual([])

    const removed = await removeFromRoster(registry, { id: added.data.id })
    expect(removed.ok).toBe(true)
    if (!removed.ok) return
    expect(removed.data).toEqual({ id: added.data.id })
    expect(readRoster(registry).ok && registry.list()).toEqual([])
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
