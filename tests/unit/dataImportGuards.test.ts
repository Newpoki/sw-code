/**
 * Unit tests for the imperative guards of the Data_Import runner
 * (`src/server/store/dataImport.server.ts`), covering Requirements 4.2, 4.4,
 * 4.5, 4.6, and 4.9.
 *
 * The pure planner (`planDataImport`) is Property 10's job (task 13.2). These
 * tests exercise the *runner* — {@link runDataImport} — which is the half that
 * decides due-ness, reads the Legacy_Json_Store under a bound, inserts and
 * seeds and logs, and rolls back on failure. So they are about which branch is
 * taken and what is logged and written, not about the accept/skip/cap
 * arithmetic.
 *
 * ## The seams these tests drive
 *
 *   - A hand-built {@link FakeDb}. The runner talks to a raw driver `Db`
 *     (`context.db`), not the {@link MongoStore} seam, so the in-memory store of
 *     `tests/support/inMemoryMongoStore.ts` is the wrong shape here: it models a
 *     `MongoStore`, and the runner never touches one. The fake models exactly
 *     the four operations the runner calls — `countDocuments` (due-ness),
 *     `insertOne` (returning a fresh `ObjectId`, or rejecting to force the
 *     abandon path), `updateOne` (counter seeding), and `deleteMany` (rollback,
 *     which can be made to reject for the failed-rollback case). Every call is
 *     recorded, so a test can assert that a not-due start read nothing and
 *     inserted nothing, or that a rollback deleted exactly the tracked `_id`s.
 *
 *   - A real temporary `DATA_FILE` on disk, created per case and removed in a
 *     `finally`, the discipline `persistenceRoundTrip` and `storeEdgeCases`
 *     already apply to temporary store files. The read cases need a real file
 *     because the runner reads it through `parseStoreDocument` off
 *     `node:fs/promises`: a present valid file, an absent path, and a
 *     present-but-unparseable file. The absent + unparseable conditions of
 *     Requirement 4.4 are asserted thoroughly; the "could not be read within 5
 *     seconds" condition is not deterministically triggerable from a unit test
 *     (it needs a filesystem read that hangs), so it is noted rather than
 *     forced.
 *
 *   - A capturing {@link StoreLogger}. The runner uses `logger.warn(...)` for
 *     both warnings *and* the summary / due / discard lines — there is one
 *     `StoreLogger` seam and it has only `warn` — so every line the runner emits
 *     is asserted against the captured `warn` messages. That is the module's
 *     design; these tests test what it does.
 *
 * ## Requirement 1.6 redaction
 *
 * Every injected driver rejection carries a fake connection string in its own
 * message. No warning the runner logs may contain it: Requirement 1.6 keeps the
 * Mongo_Connection_URI and every part of it out of every log entry, and the
 * runner's abandoned / failed-rollback warnings are constants and functions of
 * the `DATA_FILE` path and the collection name, never of a caught error. The
 * redaction group asserts that structurally.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ObjectId } from "mongodb"
import { describe, expect, it } from "vitest"

import { STORE_VERSION } from "@/server/store/jsonStore.server"
import type {
  DataImportContext,
  StoreLogger,
} from "@/server/store/mongo.server"
import {
  DATA_IMPORT_ABANDONED_WARNING,
  NO_DATA_IMPORT_DUE_LINE,
  dataFileUnreadableWarning,
  dataImportDiscardLine,
  dataImportSummaryLine,
  noConnectionWarning,
  planDataImport,
  rollbackFailedWarning,
  runDataImport,
} from "@/server/store/dataImport.server"

/* -------------------------------------------------------------------------- */
/* Requirement 1.6: the connection string every injected error carries        */
/* -------------------------------------------------------------------------- */

/**
 * The connection string every injected driver rejection quotes, and the
 * fragments of it that may not surface in any logged warning (Requirement 1.6).
 * A driver error names the topology it could not reach; the runner must let
 * none of it through.
 */
const URI = "mongodb+srv://import_writer:s3cr3t-pass@cluster9.abcde.mongodb.net"
const URI_FRAGMENTS = [
  URI,
  "import_writer",
  "s3cr3t-pass",
  "cluster9.abcde.mongodb.net",
  "27017",
] as const

/** A driver-shaped rejection whose message quotes the connection string. */
function driverError(operation: string): Error {
  return new Error(
    `${operation} failed: connection to cluster9.abcde.mongodb.net:27017 ` +
      `closed, ${URI}`
  )
}

/* -------------------------------------------------------------------------- */
/* The capturing logger                                                       */
/* -------------------------------------------------------------------------- */

/** A {@link StoreLogger} that keeps every line handed to `warn`, in order. */
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
/* The fake Db                                                                */
/* -------------------------------------------------------------------------- */

/** One recorded call against the fake, in the order the runner made it. */
interface RecordedCall {
  readonly collection: string
  readonly method: string
  readonly argument?: unknown
}

/** How many documents each collection reports for the due-ness check. */
interface CollectionCounts {
  readonly members?: number
  readonly history?: number
  readonly counters?: number
}

/** Methods a test can make reject, keyed `${collection}.${method}`. */
type RejectionPlan = Record<string, Error>

interface FakeDbOptions {
  /** What `countDocuments` answers per collection. Absent ⇒ 0. */
  readonly counts?: CollectionCounts
  /** Methods that reject instead of serving, and what they reject with. */
  readonly reject?: RejectionPlan
}

/**
 * A hand-built driver `Db`, modelling exactly the operations the Data_Import
 * runner calls and nothing else.
 *
 * `insertOne` returns a fresh `ObjectId` so the runner's `_id` tracking is real:
 * a rollback then deletes exactly the ids it recorded, and a test reads those
 * ids off {@link FakeDb.deletedIds}. Any method named in `reject` rejects with
 * the given error from its next call onward, which is how the abandon path
 * (an `insertOne` rejection) and the failed-rollback path (a `deleteMany`
 * rejection) are forced.
 */
class FakeDb {
  readonly calls: RecordedCall[] = []
  /** Every `_id` handed out by `insertOne`, per collection, in insert order. */
  readonly insertedIds: { [collection: string]: ObjectId[] | undefined } = {}
  /** The `$in` id lists each `deleteMany` was asked to delete, per collection. */
  readonly deletedIds: { [collection: string]: ObjectId[][] | undefined } = {}
  /** The counter `updateOne` calls: the `_id` filtered and the `value` set. */
  readonly counterWrites: { name: unknown; value: unknown }[] = []

  private readonly counts: CollectionCounts
  private readonly reject: RejectionPlan

  constructor(options: FakeDbOptions = {}) {
    this.counts = options.counts ?? {}
    this.reject = options.reject ?? {}
  }

  /** The driver seam the runner uses: `db.collection(name)`. */
  collection(name: string): FakeCollection {
    return new FakeCollection(name, this)
  }

  /** The rejection installed for `${name}.${method}`, or null to serve it. */
  rejectionFor(name: string, method: string): Error | null {
    return this.reject[`${name}.${method}`] ?? null
  }

  /** The `countDocuments` answer for a collection; absent counts as empty. */
  countFor(name: string): number {
    const counts = this.counts as Record<string, number | undefined>
    return counts[name] ?? 0
  }

  record(call: RecordedCall): void {
    this.calls.push(call)
  }

  /** Every method called against one collection, in call order. */
  callsTo(name: string): readonly string[] {
    return this.calls
      .filter((call) => call.collection === name)
      .map((call) => call.method)
  }
}

/**
 * One collection over its parent {@link FakeDb}. A new instance per
 * `db.collection(name)` call, exactly as the driver hands out a fresh handle;
 * all state lives on the parent, so two handles to the same name share it.
 */
class FakeCollection {
  constructor(
    private readonly name: string,
    private readonly db: FakeDb
  ) {}

  countDocuments(): Promise<number> {
    this.db.record({ collection: this.name, method: "countDocuments" })
    const rejection = this.db.rejectionFor(this.name, "countDocuments")
    if (rejection !== null) {
      return Promise.reject(rejection)
    }
    return Promise.resolve(this.db.countFor(this.name))
  }

  insertOne(
    document: unknown
  ): Promise<{ acknowledged: boolean; insertedId: ObjectId }> {
    this.db.record({
      collection: this.name,
      method: "insertOne",
      argument: document,
    })
    const rejection = this.db.rejectionFor(this.name, "insertOne")
    if (rejection !== null) {
      return Promise.reject(rejection)
    }
    const insertedId = new ObjectId()
    ;(this.db.insertedIds[this.name] ??= []).push(insertedId)
    return Promise.resolve({ acknowledged: true, insertedId })
  }

  updateOne(
    filter: { _id?: unknown },
    update: { $set?: { value?: unknown } }
  ): Promise<{ acknowledged: boolean }> {
    this.db.record({
      collection: this.name,
      method: "updateOne",
      argument: { filter, update },
    })
    const rejection = this.db.rejectionFor(this.name, "updateOne")
    if (rejection !== null) {
      return Promise.reject(rejection)
    }
    this.db.counterWrites.push({
      name: filter._id,
      value: update.$set?.value,
    })
    return Promise.resolve({ acknowledged: true })
  }

  deleteMany(filter: {
    _id?: { $in?: ObjectId[] }
  }): Promise<{ acknowledged: boolean; deletedCount: number }> {
    this.db.record({
      collection: this.name,
      method: "deleteMany",
      argument: filter,
    })
    const ids = filter._id?.$in ?? []
    ;(this.db.deletedIds[this.name] ??= []).push([...ids])
    const rejection = this.db.rejectionFor(this.name, "deleteMany")
    if (rejection !== null) {
      return Promise.reject(rejection)
    }
    return Promise.resolve({ acknowledged: true, deletedCount: ids.length })
  }
}

/** Casts a {@link FakeDb} to the `Db` the runner's context expects. */
function contextOf(db: FakeDb, logger: StoreLogger): DataImportContext {
  return { db: db as unknown as DataImportContext["db"], logger }
}

/* -------------------------------------------------------------------------- */
/* The temporary DATA_FILE                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Runs `body` with a fresh, empty temporary directory, removed in a `finally`
 * whether the body throws or not — the discipline `persistenceRoundTrip`
 * applies to its temporary store files.
 */
async function withTempDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "scr-data-import-guard-"))
  try {
    return await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** A valid Legacy_Json_Store holding one entry and one record, on disk. */
async function writeValidStore(filePath: string): Promise<string> {
  const document = {
    version: STORE_VERSION,
    nextHistorySeq: 3,
    members: [
      {
        id: "entry-1",
        memberLabel: "Ana",
        hiveId: "hive-ana",
        enabled: true,
        createdAt: "2025-01-04T18:00:00.000Z",
      },
      {
        id: "entry-2",
        memberLabel: "Ben",
        hiveId: "hive-ben",
        enabled: false,
        createdAt: "2025-01-04T18:05:00.000Z",
      },
    ],
    history: [
      {
        runId: "run-1",
        seq: 2,
        couponCode: "SAVE10",
        completedAt: "2025-01-04T18:10:00.000Z",
        mock: false,
        stoppedEarly: false,
        outcomes: [
          {
            hiveId: "hive-ana",
            memberLabel: "Ana",
            outcome: "SUCCESS",
            responseCode: "OK",
            responseMessage: "done",
          },
        ],
      },
    ],
  }
  const contents = `${JSON.stringify(document, null, 2)}\n`
  await writeFile(filePath, contents, "utf8")
  return contents
}

/* -------------------------------------------------------------------------- */
/* Requirement 4.2: the due / not-due truth table                            */
/* -------------------------------------------------------------------------- */

describe("the due / not-due truth table (Requirement 4.2)", () => {
  /**
   * Each row of the truth table: the two collection counts, and whether an
   * import is due. Due only while **both** collections hold zero documents.
   */
  const notDueRows: readonly {
    readonly why: string
    readonly members: number
    readonly history: number
  }[] = [
    { why: "members hold documents, history is empty", members: 1, history: 0 },
    {
      why: "members is empty, history holds documents",
      members: 0,
      history: 5,
    },
    { why: "both collections hold documents", members: 3, history: 7 },
  ]

  for (const row of notDueRows) {
    it(`is not due when ${row.why}, and reads no file and inserts nothing`, async () => {
      const db = new FakeDb({
        counts: { members: row.members, history: row.history },
      })
      const logger = capturingLogger()

      await withTempDir(async (dir) => {
        const filePath = join(dir, "store.json")
        const contents = await writeValidStore(filePath)

        await runDataImport(contextOf(db, logger), {
          dataFilePath: filePath,
          startupTimestamp: "2025-02-01T00:00:00.000Z",
        })

        // Exactly the "no import due" line, and nothing else.
        expect(logger.warnings).toEqual([NO_DATA_IMPORT_DUE_LINE])
        // No file was read: the summary line, which only a completed import
        // logs, is absent, and no insert happened.
        expect(db.callsTo("members")).not.toContain("insertOne")
        expect(db.callsTo("history")).not.toContain("insertOne")
        expect(db.counterWrites).toEqual([])
        // The DATA_FILE is left byte-identical.
        expect(readFileSync(filePath, "utf8")).toBe(contents)
      })
    })
  }

  it("is due only when both collections hold zero documents", async () => {
    const db = new FakeDb({ counts: { members: 0, history: 0 } })
    const logger = capturingLogger()

    await withTempDir(async (dir) => {
      const filePath = join(dir, "store.json")
      await writeValidStore(filePath)

      await runDataImport(contextOf(db, logger), {
        dataFilePath: filePath,
        startupTimestamp: "2025-02-01T00:00:00.000Z",
      })

      // A due import reads the file and inserts, so the "no import due" line is
      // never logged; the summary line is.
      expect(logger.warnings).not.toContain(NO_DATA_IMPORT_DUE_LINE)
      expect(db.callsTo("members")).toContain("insertOne")
    })
  })

  it("checks history only after members counts zero (short-circuit)", async () => {
    // Requirement 4.2: members > 0 already settles not-due, so history need not
    // be counted. The runner records that it never asked history to count.
    const db = new FakeDb({ counts: { members: 2, history: 0 } })
    const logger = capturingLogger()

    await runDataImport(contextOf(db, logger), {
      dataFilePath: join(tmpdir(), "does-not-matter.json"),
      startupTimestamp: "2025-02-01T00:00:00.000Z",
    })

    expect(db.callsTo("members")).toEqual(["countDocuments"])
    expect(db.callsTo("history")).toEqual([])
    expect(logger.warnings).toEqual([NO_DATA_IMPORT_DUE_LINE])
  })
})

/* -------------------------------------------------------------------------- */
/* Requirement 4.4: the three legacy-file conditions                         */
/* -------------------------------------------------------------------------- */

describe("the three legacy-file conditions (Requirement 4.4)", () => {
  it("warns exactly once that the file is absent, and inserts nothing", async () => {
    const db = new FakeDb({ counts: { members: 0, history: 0 } })
    const logger = capturingLogger()

    await withTempDir(async (dir) => {
      // A path inside the temp dir that was never written: absent.
      const filePath = join(dir, "absent-store.json")

      await runDataImport(contextOf(db, logger), {
        dataFilePath: filePath,
        startupTimestamp: "2025-02-01T00:00:00.000Z",
      })

      expect(logger.warnings).toEqual([
        dataFileUnreadableWarning(filePath, "is absent"),
      ])
      // Exactly one warning, naming the path and the condition.
      expect(logger.warnings[0]).toContain(filePath)
      expect(logger.warnings[0]).toContain("is absent")
      // Nothing inserted, both collections left empty.
      expect(db.callsTo("members")).not.toContain("insertOne")
      expect(db.callsTo("history")).not.toContain("insertOne")
      expect(db.counterWrites).toEqual([])
    })
  })

  it("warns exactly once that the file does not hold the expected shape, and leaves it byte-identical", async () => {
    const db = new FakeDb({ counts: { members: 0, history: 0 } })
    const logger = capturingLogger()

    await withTempDir(async (dir) => {
      const filePath = join(dir, "store.json")
      // Valid JSON, wrong shape: an unsupported version and no members array.
      const contents = `${JSON.stringify({ version: 999, junk: true }, null, 2)}\n`
      await writeFile(filePath, contents, "utf8")

      await runDataImport(contextOf(db, logger), {
        dataFilePath: filePath,
        startupTimestamp: "2025-02-01T00:00:00.000Z",
      })

      expect(logger.warnings).toHaveLength(1)
      expect(logger.warnings[0]).toContain(filePath)
      expect(logger.warnings[0]).toContain("does not hold the expected shape")
      // Nothing inserted; the DATA_FILE is left exactly as written.
      expect(db.callsTo("members")).not.toContain("insertOne")
      expect(db.callsTo("history")).not.toContain("insertOne")
      expect(readFileSync(filePath, "utf8")).toBe(contents)
    })
  })

  it("treats invalid JSON as not holding the expected shape", async () => {
    const db = new FakeDb({ counts: { members: 0, history: 0 } })
    const logger = capturingLogger()

    await withTempDir(async (dir) => {
      const filePath = join(dir, "store.json")
      const contents = "{ this is not json"
      await writeFile(filePath, contents, "utf8")

      await runDataImport(contextOf(db, logger), {
        dataFilePath: filePath,
        startupTimestamp: "2025-02-01T00:00:00.000Z",
      })

      expect(logger.warnings).toHaveLength(1)
      expect(logger.warnings[0]).toContain("does not hold the expected shape")
      expect(readFileSync(filePath, "utf8")).toBe(contents)
    })
  })

  // The "could not be read within 5 seconds" condition (the third of
  // Requirement 4.4) needs a filesystem read that hangs past the 5-second
  // bound, which is not deterministically triggerable from a unit test without
  // stubbing `node:fs/promises`. The absent and unparseable conditions are
  // asserted thoroughly above; the timeout branch is exercised by the runner's
  // `raceWithin` and shares the same `dataFileUnreadableWarning` sink.
})

/* -------------------------------------------------------------------------- */
/* The happy path: insert, seed, and log the summary                         */
/* -------------------------------------------------------------------------- */

describe("a due import over a valid file inserts, seeds counters, and logs the summary", () => {
  it("inserts every entry and record, seeds both counters, and logs the summary without a discard line", async () => {
    const db = new FakeDb({ counts: { members: 0, history: 0 } })
    const logger = capturingLogger()

    await withTempDir(async (dir) => {
      const filePath = join(dir, "store.json")
      const contents = await writeValidStore(filePath)

      await runDataImport(contextOf(db, logger), {
        dataFilePath: filePath,
        startupTimestamp: "2025-02-01T00:00:00.000Z",
      })

      // Two entries and one record inserted.
      expect(db.insertedIds.members ?? []).toHaveLength(2)
      expect(db.insertedIds.history ?? []).toHaveLength(1)

      // Both counters seeded, to the highest values the plan assigned.
      const plan = planDataImport(
        {
          version: STORE_VERSION,
          nextHistorySeq: 3,
          members: [
            {
              id: "entry-1",
              memberLabel: "Ana",
              hiveId: "hive-ana",
              enabled: true,
              createdAt: "2025-01-04T18:00:00.000Z",
            },
            {
              id: "entry-2",
              memberLabel: "Ben",
              hiveId: "hive-ben",
              enabled: false,
              createdAt: "2025-01-04T18:05:00.000Z",
            },
          ],
          history: [
            {
              runId: "run-1",
              seq: 2,
              couponCode: "SAVE10",
              completedAt: "2025-01-04T18:10:00.000Z",
              mock: false,
              stoppedEarly: false,
              outcomes: [
                {
                  hiveId: "hive-ana",
                  memberLabel: "Ana",
                  outcome: "SUCCESS",
                  responseCode: "OK",
                  responseMessage: "done",
                },
              ],
            },
          ],
        },
        "2025-02-01T00:00:00.000Z"
      )
      expect(db.counterWrites).toEqual([
        { name: "member_position", value: plan.counters.member_position },
        { name: "history_seq", value: plan.counters.history_seq },
      ])

      // The one summary line is logged; no discard line, since nothing capped.
      expect(logger.warnings).toEqual([dataImportSummaryLine(plan)])
      expect(dataImportDiscardLine(plan)).toBeNull()

      // The DATA_FILE is left byte-identical.
      expect(readFileSync(filePath, "utf8")).toBe(contents)
    })
  })

  it("logs the discard line only when a cap discarded something", async () => {
    const db = new FakeDb({ counts: { members: 0, history: 0 } })
    const logger = capturingLogger()

    await withTempDir(async (dir) => {
      const filePath = join(dir, "store.json")

      // 101 entries: one beyond the 100-entry cap, so the discard line appears.
      const members = Array.from({ length: 101 }, (_unused, index) => ({
        id: `entry-${index}`,
        memberLabel: `Member ${index}`,
        hiveId: `hive-${index}`,
        enabled: true,
        createdAt: "2025-01-04T18:00:00.000Z",
      }))
      const document = {
        version: STORE_VERSION,
        nextHistorySeq: 1,
        members,
        history: [],
      }
      await writeFile(
        filePath,
        `${JSON.stringify(document, null, 2)}\n`,
        "utf8"
      )

      await runDataImport(contextOf(db, logger), {
        dataFilePath: filePath,
        startupTimestamp: "2025-02-01T00:00:00.000Z",
      })

      // 100 inserted (the cap), and the summary plus one discard line logged.
      expect(db.insertedIds.members ?? []).toHaveLength(100)
      expect(logger.warnings).toHaveLength(2)
      expect(logger.warnings[1]).toContain("capped the import")
      expect(logger.warnings[1]).toContain("discarded 1")
    })
  })
})

/* -------------------------------------------------------------------------- */
/* Requirement 4.5: rollback on a failed insertion                           */
/* -------------------------------------------------------------------------- */

describe("a failed insertion is rolled back by _id and abandoned (Requirement 4.5)", () => {
  it("deletes every already-inserted _id, warns once, and resolves without throwing", async () => {
    // The history insert rejects after the two member inserts have landed, so
    // the rollback must delete the two member `_id`s it tracked.
    const db = new FakeDb({
      counts: { members: 0, history: 0 },
      reject: { "history.insertOne": driverError("insertOne") },
    })
    const logger = capturingLogger()

    await withTempDir(async (dir) => {
      const filePath = join(dir, "store.json")
      await writeValidStore(filePath)

      // Resolves rather than throws: startup completes in every failure case.
      await expect(
        runDataImport(contextOf(db, logger), {
          dataFilePath: filePath,
          startupTimestamp: "2025-02-01T00:00:00.000Z",
        })
      ).resolves.toBeUndefined()

      // The two member inserts landed before the history insert rejected.
      const memberIds = db.insertedIds.members ?? []
      expect(memberIds).toHaveLength(2)

      // Rollback deleted exactly those two ids from the members collection.
      expect(db.deletedIds.members).toEqual([memberIds])
      // No history document landed, so no history deleteMany was issued.
      expect(db.deletedIds.history ?? []).toEqual([])

      // Exactly one abandoned warning.
      expect(logger.warnings).toEqual([DATA_IMPORT_ABANDONED_WARNING])
    })
  })

  it("does not seed counters when the insertion failed", async () => {
    const db = new FakeDb({
      counts: { members: 0, history: 0 },
      reject: { "members.insertOne": driverError("insertOne") },
    })
    const logger = capturingLogger()

    await withTempDir(async (dir) => {
      const filePath = join(dir, "store.json")
      await writeValidStore(filePath)

      await runDataImport(contextOf(db, logger), {
        dataFilePath: filePath,
        startupTimestamp: "2025-02-01T00:00:00.000Z",
      })

      // The very first member insert rejected, so nothing landed and no
      // deleteMany was needed for an empty tracker.
      expect(db.insertedIds.members ?? []).toEqual([])
      expect(db.counterWrites).toEqual([])
      expect(db.deletedIds.members ?? []).toEqual([])
      expect(logger.warnings).toEqual([DATA_IMPORT_ABANDONED_WARNING])
    })
  })
})

/* -------------------------------------------------------------------------- */
/* Requirement 4.6: a rollback delete that itself fails                      */
/* -------------------------------------------------------------------------- */

describe("a rollback delete that itself fails names the retaining collection (Requirement 4.6)", () => {
  it("logs the failed-rollback warning for the collection and still resolves", async () => {
    // The history insert rejects (forcing rollback), and the members
    // deleteMany rejects too (the rollback of the landed member inserts fails).
    const db = new FakeDb({
      counts: { members: 0, history: 0 },
      reject: {
        "history.insertOne": driverError("insertOne"),
        "members.deleteMany": driverError("deleteMany"),
      },
    })
    const logger = capturingLogger()

    await withTempDir(async (dir) => {
      const filePath = join(dir, "store.json")
      await writeValidStore(filePath)

      await expect(
        runDataImport(contextOf(db, logger), {
          dataFilePath: filePath,
          startupTimestamp: "2025-02-01T00:00:00.000Z",
        })
      ).resolves.toBeUndefined()

      // The failed-rollback warning names the members collection, followed by
      // the abandoned warning. Both are logged; startup completes.
      expect(logger.warnings).toEqual([
        rollbackFailedWarning("members"),
        DATA_IMPORT_ABANDONED_WARNING,
      ])
    })
  })
})

/* -------------------------------------------------------------------------- */
/* Requirement 4.9: no connection while an import is due                     */
/* -------------------------------------------------------------------------- */

describe("no connection while an import is due inserts nothing (Requirement 4.9)", () => {
  it("logs one no-connection warning, reads nothing, inserts nothing, and leaves the file untouched", async () => {
    const db = new FakeDb({ counts: { members: 0, history: 0 } })
    const logger = capturingLogger()

    await withTempDir(async (dir) => {
      const filePath = join(dir, "store.json")
      const contents = await writeValidStore(filePath)

      await runDataImport(contextOf(db, logger), {
        dataFilePath: filePath,
        startupTimestamp: "2025-02-01T00:00:00.000Z",
        connectionHeld: false,
      })

      // Exactly one no-connection warning naming the path.
      expect(logger.warnings).toEqual([noConnectionWarning(filePath)])
      expect(logger.warnings[0]).toContain(filePath)

      // No due-ness check, no read, no insert: the runner returned before any
      // of it.
      expect(db.calls).toEqual([])
      // The DATA_FILE is left byte-identical.
      expect(readFileSync(filePath, "utf8")).toBe(contents)
    })
  })
})

/* -------------------------------------------------------------------------- */
/* Requirement 1.6: no warning carries any part of the connection string     */
/* -------------------------------------------------------------------------- */

describe("no logged warning carries any part of the connection string (Requirement 1.6)", () => {
  it("redacts the URI from the abandoned and failed-rollback warnings", async () => {
    // Both failure paths inject a driver error whose message quotes the URI;
    // no warning the runner logs may contain any fragment of it.
    const db = new FakeDb({
      counts: { members: 0, history: 0 },
      reject: {
        "history.insertOne": driverError("insertOne"),
        "members.deleteMany": driverError("deleteMany"),
      },
    })
    const logger = capturingLogger()

    await withTempDir(async (dir) => {
      const filePath = join(dir, "store.json")
      await writeValidStore(filePath)

      await runDataImport(contextOf(db, logger), {
        dataFilePath: filePath,
        startupTimestamp: "2025-02-01T00:00:00.000Z",
      })

      expect(logger.warnings.length).toBeGreaterThan(0)
      for (const warning of logger.warnings) {
        for (const fragment of URI_FRAGMENTS) {
          expect(warning, `leaked ${fragment}`).not.toContain(fragment)
        }
      }
    })
  })

  it("redacts the URI even when the counter seeding fails", async () => {
    // A counter `updateOne` rejection is also a driver error carrying the URI;
    // it drives the abandon path, and its warning must stay clean too.
    const db = new FakeDb({
      counts: { members: 0, history: 0 },
      reject: { "counters.updateOne": driverError("updateOne") },
    })
    const logger = capturingLogger()

    await withTempDir(async (dir) => {
      const filePath = join(dir, "store.json")
      await writeValidStore(filePath)

      await runDataImport(contextOf(db, logger), {
        dataFilePath: filePath,
        startupTimestamp: "2025-02-01T00:00:00.000Z",
      })

      // The seeding failed after the inserts landed, so the import is abandoned
      // and both collections rolled back.
      expect(logger.warnings).toContain(DATA_IMPORT_ABANDONED_WARNING)
      for (const warning of logger.warnings) {
        for (const fragment of URI_FRAGMENTS) {
          expect(warning, `leaked ${fragment}`).not.toContain(fragment)
        }
      }
    })
  })
})
