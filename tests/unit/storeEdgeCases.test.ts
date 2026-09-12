/**
 * Store edge cases: the three behaviours that only show up at the boundaries
 * (Requirements 1.8, 1.11, 1.12, 6.5).
 *
 *   1. A flush that rejects. The mutation stays visible in memory and exactly
 *      one persistence warning accompanies that response, while a flush that
 *      resolves reports `persisted: true` with no warning at all. The warning
 *      therefore accompanies only the response whose write failed.
 *   2. A `DATA_FILE` the store cannot use — unparseable, or parseable but the
 *      wrong shape — is renamed aside and the store boots empty with a warning
 *      naming the reason. An absent file boots empty with no warning and no
 *      rename, because "no file yet" is not a fault.
 *   3. The 100-entry roster cap and the 200-record history trim, including that
 *      the trim drops from the front and `nextHistorySeq` never resets.
 *
 * Only the corrupt-file group does real file I/O, and it does it inside a fresh
 * `mkdtemp` directory that is removed afterwards. Everything else injects a
 * `flush`, so the 200-record trim costs no `fsync` at all. The repository's
 * `./data/store.json` is never read for a fixture and never written: every test
 * passes an explicit `dataFilePath`, and an `afterEach` asserts that the
 * repository data file is byte-identical to what it was before the test.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  DEFAULT_DATA_FILE,
  STORE_VERSION,
  corruptFilePath,
  createJsonStore,
  serializeStoreDocument,
} from "@/server/store/jsonStore.server"
import {
  MEMBER_REGISTRY_MAX_ENTRIES,
  createMemberRegistryStore,
  rosterFullMessage,
} from "@/server/store/memberRegistry.server"
import {
  HISTORY_RETENTION_LIMIT,
  createHistoryStore,
  toHistoryOutcomeRows,
} from "@/server/store/history.server"
import type {
  FlushFn,
  JsonStore,
  StoreLogger,
} from "@/server/store/jsonStore.server"
import type { MemberOutcome } from "@/domain/types"

/** Fixed base instant, so generated `completedAt` values are deterministic. */
const BASE_TIME = Date.parse("2025-01-04T18:00:00.000Z")

/** A flush that always lands. Never touches the filesystem. */
const resolvingFlush: FlushFn = () => Promise.resolve()

/** A flush that always fails, the way a full disk would. */
const rejectingFlush: FlushFn = () => Promise.reject(new Error("disk full"))

/** Collects the warnings a store emits, so they can be counted exactly. */
function capturingLogger(): StoreLogger & { readonly warnings: string[] } {
  const warnings: string[] = []
  return {
    warnings,
    warn: (message) => {
      warnings.push(message)
    },
  }
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
  // No test constructs a store over the default path, so nothing here may have
  // created, changed, or removed the repository's own store document.
  expect(repoDataFile(), `${DEFAULT_DATA_FILE} was left untouched`).toBe(
    repoDataFileBefore
  )

  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

/* -------------------------------------------------------------------------- */
/* Requirements 1.8, 1.12: a failed flush warns exactly once                  */
/* -------------------------------------------------------------------------- */

describe("a rejected flush keeps the change and warns once (Requirement 1.8)", () => {
  /** A store whose writes always fail, over a path that does not exist. */
  async function unwritableStore(): Promise<{
    store: JsonStore
    logger: ReturnType<typeof capturingLogger>
  }> {
    const { filePath } = await makeTempDataFile()
    const logger = capturingLogger()
    const store = createJsonStore({
      dataFilePath: filePath,
      flush: rejectingFlush,
      logger,
    })
    // The absent file is not a fault, so the load path stays silent.
    expect(logger.warnings).toEqual([])
    return { store, logger }
  }

  it("reports persisted false, keeps the entry visible, and logs one warning", async () => {
    const { store, logger } = await unwritableStore()
    const registry = createMemberRegistryStore(store)

    const added = await registry.add({ memberLabel: "Alice", hiveId: "1001" })

    expect(added.kind).toBe("added")
    if (added.kind !== "added") return
    expect(added.persisted).toBe(false)

    // Never rolled back: the change is what the roster serves from now on.
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0]).toEqual(added.entry)
    expect(store.read().members).toEqual([added.entry])

    // Exactly one warning for that one mutation, naming the file and the cause.
    expect(logger.warnings).toHaveLength(1)
    expect(logger.warnings[0]).toContain(store.filePath)
    expect(logger.warnings[0]).toContain("disk full")
    expect(logger.warnings[0]).toContain("lost on restart")
  })

  it("survives the rejection, so a second mutation still resolves with its own single warning", async () => {
    const { store, logger } = await unwritableStore()
    const registry = createMemberRegistryStore(store)

    const first = await registry.add({ memberLabel: "Alice", hiveId: "1001" })
    expect(logger.warnings).toHaveLength(1)

    // The flush chain is not poisoned: this resolves rather than hanging or
    // throwing, even though the flush before it rejected.
    const second = await registry.add({ memberLabel: "Bob", hiveId: "1002" })

    expect(first.kind).toBe("added")
    expect(second.kind).toBe("added")
    if (second.kind !== "added") return
    expect(second.persisted).toBe(false)

    // One warning per failed mutation, so the second response carries exactly
    // one of its own rather than inheriting or duplicating the first.
    expect(logger.warnings).toHaveLength(2)

    // Both changes are still there, in insertion order.
    expect(registry.list().map((entry) => entry.hiveId)).toEqual([
      "1001",
      "1002",
    ])

    // A third mutation of a different kind behaves the same way.
    const disabled = await registry.setEnabled(second.entry.id, false)
    expect(disabled.kind).toBe("updated")
    if (disabled.kind !== "updated") return
    expect(disabled.persisted).toBe(false)
    expect(disabled.entry.enabled).toBe(false)
    expect(logger.warnings).toHaveLength(3)

    // The chain drains cleanly; a rejected flush is not an unhandled rejection.
    await expect(store.whenIdle()).resolves.toBeUndefined()
  })

  it("reports persisted true with zero warnings when the flush lands (Requirement 1.12)", async () => {
    const { filePath } = await makeTempDataFile()
    const logger = capturingLogger()
    const flushed: Array<string> = []
    const store = createJsonStore({
      dataFilePath: filePath,
      flush: ({ contents }) => {
        flushed.push(contents)
        return Promise.resolve()
      },
      logger,
    })
    const registry = createMemberRegistryStore(store)

    const added = await registry.add({ memberLabel: "Alice", hiveId: "1001" })

    expect(added.kind).toBe("added")
    if (added.kind !== "added") return
    expect(added.persisted).toBe(true)
    expect(logger.warnings).toEqual([])

    // The flush saw the document as of its own mutation.
    expect(flushed).toHaveLength(1)
    expect(flushed[0]).toBe(serializeStoreDocument(store.read()))
  })

  it("attaches no warning to a rejection, because a rejection writes nothing", async () => {
    const { store, logger } = await unwritableStore()
    const registry = createMemberRegistryStore(store)

    await registry.add({ memberLabel: "Alice", hiveId: "1001" })
    expect(logger.warnings).toHaveLength(1)

    const duplicate = await registry.add({
      memberLabel: "Alice again",
      hiveId: "1001",
    })
    const invalid = await registry.add({ memberLabel: "   ", hiveId: "1002" })
    const missing = await registry.setEnabled("no-such-id", false)

    expect(duplicate.kind).toBe("duplicate")
    expect(invalid.kind).toBe("invalid")
    expect(missing.kind).toBe("not-found")

    // No mutation, no flush, so the warning count is unchanged.
    expect(logger.warnings).toHaveLength(1)
    expect(registry.list()).toHaveLength(1)
  })
})

/* -------------------------------------------------------------------------- */
/* Requirement 1.7: an unusable DATA_FILE is set aside                        */
/* -------------------------------------------------------------------------- */

describe("an unusable DATA_FILE is renamed aside and the store boots empty", () => {
  /** The `store.corrupt-<timestamp>.json` name `corruptFilePath` produces. */
  const corruptNamePattern =
    /^store\.corrupt-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/

  /**
   * Writes `contents` to a temporary `DATA_FILE`, boots a store over it, and
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

    // The store booted empty rather than refusing to start.
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

    // Nothing is salvaged from a document the store only half understands, not
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
    // logged, and nothing is created until the first flush.
    expect(logger.warnings).toEqual([])
    expect(await readdir(dir)).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/* Requirement 1.11: the 100-entry cap                                        */
/* -------------------------------------------------------------------------- */

describe("the roster cap rejects the 101st entry (Requirement 1.11)", () => {
  it("keeps the roster at 100 unchanged and states the maximum of 100", async () => {
    const { filePath } = await makeTempDataFile()
    const logger = capturingLogger()
    let flushes = 0
    const store = createJsonStore({
      dataFilePath: filePath,
      flush: () => {
        flushes += 1
        return Promise.resolve()
      },
      logger,
    })
    const registry = createMemberRegistryStore(store)

    for (let index = 0; index < MEMBER_REGISTRY_MAX_ENTRIES; index += 1) {
      const added = await registry.add({
        memberLabel: `Member ${index}`,
        hiveId: `hive-${index}`,
      })
      expect(added.kind).toBe("added")
    }

    expect(registry.list()).toHaveLength(MEMBER_REGISTRY_MAX_ENTRIES)
    const before = registry.list()
    expect(flushes).toBe(MEMBER_REGISTRY_MAX_ENTRIES)

    const rejected = await registry.add({
      memberLabel: "One too many",
      hiveId: "hive-overflow",
    })

    expect(rejected).toEqual({ kind: "full" })

    // Rejected without mutating: same length, same entries, same order, and no
    // flush was enqueued for it.
    expect(registry.list()).toHaveLength(MEMBER_REGISTRY_MAX_ENTRIES)
    expect(registry.list()).toEqual(before)
    expect(flushes).toBe(MEMBER_REGISTRY_MAX_ENTRIES)
    expect(
      registry.list().some((entry) => entry.hiveId === "hive-overflow")
    ).toBe(false)

    // The message states the maximum the requirement names.
    expect(rosterFullMessage()).toContain(String(MEMBER_REGISTRY_MAX_ENTRIES))
    expect(rosterFullMessage()).toContain("100")
    expect(MEMBER_REGISTRY_MAX_ENTRIES).toBe(100)

    // Removing one entry makes room again, so the cap is a limit, not a wall.
    const removed = await registry.remove(before[0].id)
    expect(removed.kind).toBe("removed")
    const readmitted = await registry.add({
      memberLabel: "One too many",
      hiveId: "hive-overflow",
    })
    expect(readmitted.kind).toBe("added")
    expect(registry.list()).toHaveLength(MEMBER_REGISTRY_MAX_ENTRIES)
    expect(logger.warnings).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/* Requirement 6.5: the 200-record history trim                               */
/* -------------------------------------------------------------------------- */

describe("the history trim keeps the newest records (Requirement 6.5)", () => {
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

  it("retains exactly the newest 200 records, dropping from the front", async () => {
    const overflow = 5
    const total = HISTORY_RETENTION_LIMIT + overflow

    const { filePath } = await makeTempDataFile()
    const logger = capturingLogger()
    const store = createJsonStore({
      dataFilePath: filePath,
      flush: resolvingFlush,
      logger,
    })
    const history = createHistoryStore(store)

    for (let index = 0; index < total; index += 1) {
      const appended = await history.append({
        runId: `run-${index}`,
        couponCode: `COUPON-${index}`,
        completedAt: new Date(BASE_TIME + index * 1000).toISOString(),
        mock: false,
        stoppedEarly: false,
        outcomes: toHistoryOutcomeRows(outcomesFor(index)),
      })
      expect(appended.persisted).toBe(true)
      // `seq` starts at 1 and tracks the append count, trim or no trim.
      expect(appended.record.seq).toBe(index + 1)
    }

    // Snapshotted, because `read()` hands back the live document: the append
    // at the end of this test would otherwise show up inside the very array the
    // new `seq` is compared against.
    const retained = [...store.read().history]

    // Exactly the limit is kept, no more and no fewer.
    expect(retained).toHaveLength(HISTORY_RETENTION_LIMIT)

    // The survivors are the newest ones, still in append order.
    expect(retained.map((record) => record.seq)).toEqual(
      Array.from(
        { length: HISTORY_RETENTION_LIMIT },
        (_unused, offset) => overflow + 1 + offset
      )
    )
    expect(retained.map((record) => record.couponCode)).toEqual(
      Array.from(
        { length: HISTORY_RETENTION_LIMIT },
        (_unused, offset) => `COUPON-${overflow + offset}`
      )
    )

    // The trim dropped from the front: the five oldest are gone entirely.
    const codes = new Set(retained.map((record) => record.couponCode))
    for (let index = 0; index < overflow; index += 1) {
      expect(codes.has(`COUPON-${index}`)).toBe(false)
      expect(history.findLatestByCouponCode(`COUPON-${index}`)).toBeNull()
    }

    // The newest record survived with its fields and its denormalized rows.
    const newest = retained[retained.length - 1]
    expect(newest.couponCode).toBe(`COUPON-${total - 1}`)
    expect(newest.seq).toBe(total)
    expect(newest.completedAt).toBe(
      new Date(BASE_TIME + (total - 1) * 1000).toISOString()
    )
    expect(newest.outcomes).toEqual([
      {
        hiveId: `hive-${total - 1}`,
        memberLabel: `Member ${total - 1}`,
        outcome: "SUCCESS",
        responseCode: "100",
        responseMessage: "The coupon gift has been sent.",
      },
    ])

    // Requirement 6.6 order over the retained window: newest first.
    expect(history.list()[0].seq).toBe(total)
    expect(history.list()).toHaveLength(HISTORY_RETENTION_LIMIT)

    // The counter never resets, even though the trim removed the front.
    const ceiling = Math.max(...retained.map((record) => record.seq))
    expect(store.read().nextHistorySeq).toBe(total + 1)
    const afterTrim = await history.append({
      runId: "run-after-trim",
      couponCode: "COUPON-AFTER-TRIM",
      completedAt: new Date(BASE_TIME + total * 1000).toISOString(),
      mock: true,
      stoppedEarly: false,
      outcomes: [],
    })
    expect(afterTrim.record.seq).toBeGreaterThan(ceiling)
    for (const record of retained) {
      expect(afterTrim.record.seq).toBeGreaterThan(record.seq)
    }
    expect(store.read().history).toHaveLength(HISTORY_RETENTION_LIMIT)
    expect(logger.warnings).toEqual([])
  })

  it("keeps every record while the history is at or below the limit", async () => {
    const { filePath } = await makeTempDataFile()
    const store = createJsonStore({
      dataFilePath: filePath,
      flush: resolvingFlush,
      logger: capturingLogger(),
    })
    const history = createHistoryStore(store)

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

    expect(store.read().history).toHaveLength(HISTORY_RETENTION_LIMIT)
    expect(store.read().history[0].couponCode).toBe("COUPON-0")
    expect(HISTORY_RETENTION_LIMIT).toBeGreaterThanOrEqual(100)
  })
})
