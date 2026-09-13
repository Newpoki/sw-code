/**
 * Store edge cases: the behaviours that only show up at the boundaries.
 *
 *   1. A write the deployment did not serve. There is no
 *      applied-but-not-persisted state any more: Requirement 2.8 of the
 *      mongodb-google-auth-admin spec supersedes the in-memory-with-warning
 *      behaviour of shared-coupon-redemption Requirement 1.8, so a failed write
 *      is a `failed` result, the collection is unchanged, and no result carries
 *      `persisted`.
 *   2. A `DATA_FILE` the reader cannot use — unparseable, or parseable but the
 *      wrong shape — is renamed aside and the reader starts empty with a warning
 *      naming the reason. That group still exercises `jsonStore.server.ts`
 *      directly: it is the definition of "the expected shape" the Data_Import
 *      reads through (Requirement 4.1), and it constructs no Member_Registry and
 *      no Redemption_History.
 *   3. The 100-entry roster cap (Requirement 2.5) and the 200-record history
 *      trim (Requirement 3.3), including that the trim drops the lowest `seq`
 *      values and that the `history_seq` counter never resets (Requirement 3.2).
 *
 * Only the `DATA_FILE` group does real file I/O, and it does it inside a fresh
 * `mkdtemp` directory that is removed afterwards. The two store groups run over
 * the in-memory Mongo_Store of `tests/support/inMemoryMongoStore.ts`, so the
 * 200-record trim costs no round trip at all. The repository's
 * `./data/store.json` is never read for a fixture and never written: an
 * `afterEach` asserts that it is byte-identical to what it was before the test.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

import { MongoServerError } from "mongodb"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { rosterWriteFailedMessage } from "@/domain/storeMessages"
import {
  DEFAULT_DATA_FILE,
  STORE_VERSION,
  corruptFilePath,
  createJsonStore,
} from "@/server/store/jsonStore.server"
import {
  MEMBER_REGISTRY_MAX_ENTRIES,
  createMemberRegistryStore,
  rosterFullMessage,
} from "@/server/store/memberRegistry.server"
import type { MemberRegistryEntry, MemberOutcome } from "@/domain/types"
import {
  HISTORY_RETENTION_LIMIT,
  createHistoryStore,
  toHistoryOutcomeRows,
} from "@/server/store/history.server"
import type { StoreLogger } from "@/server/store/jsonStore.server"

import { createInMemoryMongoStore } from "../support/inMemoryMongoStore"

/** Fixed base instant, so generated `completedAt` values are deterministic. */
const BASE_TIME = Date.parse("2025-01-04T18:00:00.000Z")

/** Collects the warnings a reader emits, so they can be counted exactly. */
function capturingLogger(): StoreLogger & { readonly warnings: string[] } {
  const warnings: string[] = []
  return {
    warnings,
    warn: (message) => {
      warnings.push(message)
    },
  }
}

/** A deployment that answered, and its answer was no. */
function refused(): MongoServerError {
  return new MongoServerError({
    message: "Document failed validation",
    code: 121,
  })
}

/* -------------------------------------------------------------------------- */
/* Temporary DATA_FILE handling                                               */
/* -------------------------------------------------------------------------- */

/** Temporary directories created by a test, removed in `afterEach`. */
const tempDirs: Array<string> = []

/** A fresh directory holding nothing, plus the `DATA_FILE` path inside it. */
async function makeTempDataFile(): Promise<{ dir: string; filePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "scr-store-edge-"))
  tempDirs.push(dir)
  return { dir, filePath: join(dir, "store.json") }
}

/**
 * The repository data file as it is right now, or null when it does not exist.
 * Read synchronously so the snapshot cannot race a stray write.
 */
function repoDataFile(): string | null {
  try {
    return readFileSync(DEFAULT_DATA_FILE, "utf8")
  } catch {
    return null
  }
}

let repoDataFileBefore: string | null = null

beforeEach(() => {
  repoDataFileBefore = repoDataFile()
})

afterEach(async () => {
  // No test constructs a reader over the default path, so nothing here may have
  // created, changed, or removed the repository's own store document.
  expect(repoDataFile(), `${DEFAULT_DATA_FILE} was left untouched`).toBe(
    repoDataFileBefore
  )

  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

/* -------------------------------------------------------------------------- */
/* Requirement 2.8: a write that was not served changes nothing              */
/* -------------------------------------------------------------------------- */

describe("a write the deployment refused leaves the collection unchanged (Requirement 2.8)", () => {
  /** The entries the collection holds, or a thrown explanation. */
  async function entriesOf(
    registry: ReturnType<typeof createMemberRegistryStore>
  ): Promise<readonly MemberRegistryEntry[]> {
    const listed = await registry.list()
    if (listed.kind !== "entries") {
      throw new Error(`the roster read reported "${listed.kind}"`)
    }
    return listed.entries
  }

  it("reports failed rather than applying the change in memory", async () => {
    const handle = createInMemoryMongoStore()
    const registry = createMemberRegistryStore(handle.store)
    handle.setRejection("members", "insertOne", refused())

    const added = await registry.add({ memberLabel: "Alice", hiveId: "1001" })

    /* No `persisted` flag exists to be false: the write either landed or is a
     * `failed` result naming the change that is missing. */
    expect(added.kind).toBe("failed")
    if (added.kind !== "failed") return
    expect(added.failure).toEqual({
      reason: "rejected",
      message: rosterWriteFailedMessage({
        operation: "add",
        memberLabel: "Alice",
      }),
    })

    // Nothing is served from memory afterwards, because nothing was applied.
    expect(await entriesOf(registry)).toEqual([])
    expect(handle.members()).toEqual([])
  })

  it("keeps serving the path after a refusal, one failure per attempt", async () => {
    const handle = createInMemoryMongoStore()
    const registry = createMemberRegistryStore(handle.store)

    handle.setRejection("members", "insertOne", refused())
    const first = await registry.add({ memberLabel: "Alice", hiveId: "1001" })
    const second = await registry.add({ memberLabel: "Bob", hiveId: "1002" })
    expect([first.kind, second.kind]).toEqual(["failed", "failed"])

    /* The seam is not poisoned by a rejection: clearing it puts the path back,
     * and the two refused adds left nothing behind for the third to trip on. */
    handle.clearRejection("members", "insertOne")
    const third = await registry.add({ memberLabel: "Alice", hiveId: "1001" })
    expect(third.kind).toBe("added")
    expect((await entriesOf(registry)).map((entry) => entry.hiveId)).toEqual([
      "1001",
    ])

    // A failed `setEnabled` is the same shape, and names its own operation.
    if (third.kind !== "added") return
    handle.setRejection("members", "findOneAndUpdate", refused())
    const disabled = await registry.setEnabled(third.entry.id, false)
    expect(disabled.kind).toBe("failed")
    if (disabled.kind !== "failed") return
    expect(disabled.failure.message).toBe(
      rosterWriteFailedMessage({ operation: "disable", memberLabel: "Alice" })
    )
    // The stored document still carries the value it had.
    expect(handle.members().map((document) => document.enabled)).toEqual([true])
  })

  it("writes nothing for a rejection, so the collection is untouched", async () => {
    const handle = createInMemoryMongoStore()
    const registry = createMemberRegistryStore(handle.store)
    await registry.add({ memberLabel: "Alice", hiveId: "1001" })

    const duplicate = await registry.add({
      memberLabel: "Alice again",
      hiveId: "1001",
    })
    const invalid = await registry.add({ memberLabel: "   ", hiveId: "1002" })
    const missing = await registry.setEnabled("no-such-id", false)

    expect(duplicate.kind).toBe("duplicate")
    expect(invalid.kind).toBe("invalid")
    expect(missing.kind).toBe("not-found")

    expect(await entriesOf(registry)).toHaveLength(1)
    // A rejection is settled before any write, so no counter value is consumed.
    expect(handle.counterValue("member_position")).toBe(1)
  })
})

/* -------------------------------------------------------------------------- */
/* Requirement 4.1: an unusable DATA_FILE is set aside                        */
/* -------------------------------------------------------------------------- */

describe("an unusable DATA_FILE is renamed aside and the reader starts empty", () => {
  /** The `store.corrupt-<timestamp>.json` name `corruptFilePath` produces. */
  const corruptNamePattern =
    /^store\.corrupt-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/

  /**
   * Writes `contents` to a temporary `DATA_FILE`, boots a reader over it, and
   * returns everything the assertions need.
   */
  async function bootOver(contents: string) {
    const { dir, filePath } = await makeTempDataFile()
    await writeFile(filePath, contents, "utf8")

    const logger = capturingLogger()
    const store = createJsonStore({ dataFilePath: filePath, logger })
    const entries = await readdir(dir)

    return { dir, filePath, logger, store, entries }
  }

  it("renames invalid JSON aside, keeps its bytes, and starts empty with a warning", async () => {
    const garbage = "}{ this is not JSON at all \u0000\n"
    const { dir, filePath, logger, store, entries } = await bootOver(garbage)

    // The original path is gone and exactly one file took its place.
    expect(entries).toHaveLength(1)
    const [movedName] = entries
    expect(movedName).not.toBe(basename(filePath))
    expect(movedName).toMatch(corruptNamePattern)

    // The name is the one `corruptFilePath` builds for the same instant.
    const timestamp = movedName.slice("store.corrupt-".length, -".json".length)
    const instant = new Date(
      timestamp.replace(
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
        "$1-$2-$3T$4:$5:$6.$7Z"
      )
    )
    expect(corruptFilePath(filePath, instant)).toBe(join(dir, movedName))

    // The evidence is preserved byte for byte.
    expect(await readFile(join(dir, movedName), "utf8")).toBe(garbage)

    // The reader started empty rather than refusing to start.
    expect(store.read().members).toEqual([])
    expect(store.read().history).toEqual([])
    expect(store.read().version).toBe(STORE_VERSION)
    expect(store.read().nextHistorySeq).toBe(1)

    // One warning, naming the reason and both paths.
    expect(logger.warnings).toHaveLength(1)
    expect(logger.warnings[0]).toContain(filePath)
    expect(logger.warnings[0]).toContain(join(dir, movedName))
    expect(logger.warnings[0]).toContain("does not hold valid JSON")
    expect(logger.warnings[0]).toContain("starts empty")
  })

  it("sets aside valid JSON of an unsupported version", async () => {
    const contents = `${JSON.stringify({ version: 999 })}\n`
    const { dir, logger, store, entries } = await bootOver(contents)

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatch(corruptNamePattern)
    expect(await readFile(join(dir, entries[0]), "utf8")).toBe(contents)

    expect(store.read().members).toEqual([])
    expect(store.read().history).toEqual([])
    expect(logger.warnings).toHaveLength(1)
    expect(logger.warnings[0]).toContain("999")
    expect(logger.warnings[0]).toContain(String(STORE_VERSION))
  })

  it("sets aside valid JSON whose members array holds the wrong type", async () => {
    const contents = `${JSON.stringify({
      version: STORE_VERSION,
      nextHistorySeq: 7,
      members: "nope",
      history: [],
    })}\n`
    const { dir, filePath, logger, store, entries } = await bootOver(contents)

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatch(corruptNamePattern)
    expect(await readFile(join(dir, entries[0]), "utf8")).toBe(contents)

    // Nothing is salvaged from a document the reader only half understands, not
    // even the sequence counter.
    expect(store.read().members).toEqual([])
    expect(store.read().history).toEqual([])
    expect(store.read().nextHistorySeq).toBe(1)
    expect(store.filePath).toBe(filePath)
    expect(logger.warnings).toHaveLength(1)
    expect(logger.warnings[0]).toContain("members array")
  })

  it("starts empty with no warning and no rename when the file is absent", async () => {
    const { dir, filePath } = await makeTempDataFile()
    const logger = capturingLogger()

    const store = createJsonStore({ dataFilePath: filePath, logger })

    expect(store.read().members).toEqual([])
    expect(store.read().history).toEqual([])
    expect(store.read().nextHistorySeq).toBe(1)

    // An absent DATA_FILE is the first-run case, not a fault: nothing is
    // logged, and nothing is created until something writes.
    expect(logger.warnings).toEqual([])
    expect(await readdir(dir)).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/* Requirement 2.5: the 100-entry cap                                         */
/* -------------------------------------------------------------------------- */

describe("the roster cap rejects the 101st entry (Requirement 2.5)", () => {
  it("keeps the roster at 100 unchanged and states the maximum of 100", async () => {
    const handle = createInMemoryMongoStore()
    const registry = createMemberRegistryStore(handle.store)

    for (let index = 0; index < MEMBER_REGISTRY_MAX_ENTRIES; index += 1) {
      const added = await registry.add({
        memberLabel: `Member ${index}`,
        hiveId: `hive-${index}`,
      })
      expect(added.kind).toBe("added")
    }

    const listed = await registry.list()
    expect(listed.kind).toBe("entries")
    if (listed.kind !== "entries") return
    expect(listed.entries).toHaveLength(MEMBER_REGISTRY_MAX_ENTRIES)
    const before = listed.entries

    const rejected = await registry.add({
      memberLabel: "One too many",
      hiveId: "hive-overflow",
    })

    expect(rejected).toEqual({ kind: "full" })

    // Rejected without writing: same length, same entries, same order, and no
    // counter value consumed for it.
    const after = await registry.list()
    expect(after.kind === "entries" ? after.entries : []).toEqual(before)
    expect(handle.counterValue("member_position")).toBe(
      MEMBER_REGISTRY_MAX_ENTRIES
    )
    expect(
      handle.members().some((document) => document.hiveId === "hive-overflow")
    ).toBe(false)

    // The message states the maximum the requirement names.
    expect(rosterFullMessage()).toContain(String(MEMBER_REGISTRY_MAX_ENTRIES))
    expect(rosterFullMessage()).toContain("100")
    expect(MEMBER_REGISTRY_MAX_ENTRIES).toBe(100)

    // Removing one entry makes room again, so the cap is a limit, not a wall.
    expect((await registry.remove(before[0].id)).kind).toBe("removed")
    const readmitted = await registry.add({
      memberLabel: "One too many",
      hiveId: "hive-overflow",
    })
    expect(readmitted.kind).toBe("added")
    expect(handle.members()).toHaveLength(MEMBER_REGISTRY_MAX_ENTRIES)

    /* Requirement 2.6: the readmitted entry takes a position above every
     * existing one rather than reusing the removed entry's. */
    expect(handle.counterValue("member_position")).toBe(
      MEMBER_REGISTRY_MAX_ENTRIES + 1
    )
    expect(handle.warnings).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/* Requirement 3.3: the 200-record history trim                               */
/* -------------------------------------------------------------------------- */

describe("the history trim keeps the newest records (Requirement 3.3)", () => {
  /** One SUCCESS outcome, so the stored rows go through the real mapping. */
  function outcomesFor(index: number): Array<MemberOutcome> {
    return [
      {
        hiveId: `hive-${index}`,
        memberLabel: `Member ${index}`,
        position: 0,
        outcome: "SUCCESS",
        upstreamResult: {
          responseCode: "100",
          responseMessage: "The coupon gift has been sent.",
          outcome: "SUCCESS",
        },
      },
    ]
  }

  it("retains exactly the newest 200 records, dropping the lowest seq values", async () => {
    const overflow = 5
    const total = HISTORY_RETENTION_LIMIT + overflow

    const handle = createInMemoryMongoStore()
    const history = createHistoryStore(handle.store, { logger: handle.logger })

    for (let index = 0; index < total; index += 1) {
      const appended = await history.append({
        runId: `run-${index}`,
        couponCode: `COUPON-${index}`,
        completedAt: new Date(BASE_TIME + index * 1000).toISOString(),
        mock: false,
        stoppedEarly: false,
        outcomes: toHistoryOutcomeRows(outcomesFor(index)),
      })
      expect(appended.kind).toBe("appended")
      if (appended.kind !== "appended") return
      // `seq` starts at 1 and tracks the append count, trim or no trim.
      expect(appended.record.seq).toBe(index + 1)
    }

    const retained = handle.history()

    // Exactly the limit is kept, no more and no fewer.
    expect(retained).toHaveLength(HISTORY_RETENTION_LIMIT)

    // The survivors are the newest ones, still in insertion order.
    expect(retained.map((document) => document.seq)).toEqual(
      Array.from(
        { length: HISTORY_RETENTION_LIMIT },
        (_unused, offset) => overflow + 1 + offset
      )
    )
    expect(retained.map((document) => document.couponCode)).toEqual(
      Array.from(
        { length: HISTORY_RETENTION_LIMIT },
        (_unused, offset) => `COUPON-${overflow + offset}`
      )
    )

    // The trim dropped the lowest `seq` values: the five oldest are gone.
    const codes = new Set(retained.map((document) => document.couponCode))
    for (let index = 0; index < overflow; index += 1) {
      expect(codes.has(`COUPON-${index}`)).toBe(false)
      expect(
        (await history.findLatestByCouponCode(`COUPON-${index}`)).kind
      ).toBe("not-found")
    }

    // The newest record survived with its fields and its denormalized rows.
    const found = await history.findLatestByCouponCode(`COUPON-${total - 1}`)
    expect(found.kind).toBe("record")
    if (found.kind !== "record") return
    expect(found.record.seq).toBe(total)
    expect(found.record.completedAt).toBe(
      new Date(BASE_TIME + (total - 1) * 1000).toISOString()
    )
    expect(found.record.outcomes).toEqual([
      {
        hiveId: `hive-${total - 1}`,
        memberLabel: `Member ${total - 1}`,
        outcome: "SUCCESS",
        responseCode: "100",
        responseMessage: "The coupon gift has been sent.",
      },
    ])

    // Requirement 3.4 order over the retained window: newest first.
    const listed = await history.list()
    expect(listed.kind).toBe("records")
    if (listed.kind !== "records") return
    expect(listed.records).toHaveLength(HISTORY_RETENTION_LIMIT)
    expect(listed.records[0].seq).toBe(total)

    /* Requirement 3.2: the counter never resets, even though the trim removed
     * the records holding the lowest values, and it is not rebuilt from the
     * survivors either. */
    const ceiling = Math.max(...retained.map((document) => document.seq))
    expect(handle.counterValue("history_seq")).toBe(total)
    const afterTrim = await history.append({
      runId: "run-after-trim",
      couponCode: "COUPON-AFTER-TRIM",
      completedAt: new Date(BASE_TIME + total * 1000).toISOString(),
      mock: true,
      stoppedEarly: false,
      outcomes: [],
    })
    expect(afterTrim.kind).toBe("appended")
    if (afterTrim.kind !== "appended") return
    expect(afterTrim.record.seq).toBeGreaterThan(ceiling)
    expect(handle.history()).toHaveLength(HISTORY_RETENTION_LIMIT)
    // Requirement 3.11: every trim landed, so nothing was logged.
    expect(handle.warnings).toEqual([])
  })

  it("keeps every record while the history is at or below the limit", async () => {
    const handle = createInMemoryMongoStore()
    const history = createHistoryStore(handle.store, { logger: handle.logger })

    for (let index = 0; index < HISTORY_RETENTION_LIMIT; index += 1) {
      await history.append({
        runId: `run-${index}`,
        couponCode: `COUPON-${index}`,
        completedAt: new Date(BASE_TIME + index * 1000).toISOString(),
        mock: false,
        stoppedEarly: false,
        outcomes: toHistoryOutcomeRows(outcomesFor(index)),
      })
    }

    expect(handle.history()).toHaveLength(HISTORY_RETENTION_LIMIT)
    expect(handle.history()[0].couponCode).toBe("COUPON-0")
    expect(HISTORY_RETENTION_LIMIT).toBeGreaterThanOrEqual(100)
  })
})
