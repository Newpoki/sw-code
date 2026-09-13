/**
 * The Mongo_Store bootstrap, end to end (Requirements 1.5, 1.7, 1.11, and
 * Requirement 5.7 which the design declares obsolete).
 *
 * `tests/unit/mongoBootstrap.test.ts` covers the parts of the bootstrap that a
 * stubbed client can show: one pool reused, `connected()` tracking it, and the
 * per-index warning of Requirement 1.8. This file covers the two things that
 * need something outside the module — a real deployment, or a real address that
 * answers nothing.
 *
 * ## Two halves, split by what they need
 *
 * The Requirement 1.7 half needs an actual MongoDB: "the index exists" and "the
 * unique index refuses a duplicate Hive_ID" are claims about a database, and
 * asserting them against a stub would only restate {@link INDEX_PLANS}. That
 * half runs over a throwaway database from `tests/support/mongoFixture.ts` and
 * is guarded by {@link mongoAvailability}: with no deployment configured it
 * **skips with the reason stated as a test name that runs**, rather than passing
 * vacuously.
 *
 * The Requirement 1.5 and 1.11 half needs no deployment at all. The client
 * options are a constant this file asserts against the value the bootstrap hands
 * the constructor, and "unreachable at startup" is best shown by an address that
 * is genuinely unroutable — `127.0.0.1:1`, where nothing listens — with the
 * 10-second startup bound overridden down to milliseconds so the test is fast.
 * {@link CONNECT_TIMEOUT_MS} itself is asserted as the constant it is.
 *
 * ## Requirement 1.6, checked alongside 1.11
 *
 * The unroutable URI carries a distinctive user, password, host, and database
 * name ({@link SECRET_PARTS}), and every warning and every failure message this
 * file collects is searched for all of them. A driver error message names the
 * topology it could not reach, so this is the case where a leak would actually
 * be available to leak.
 */

import { MongoClient } from "mongodb"
import { afterAll, describe, expect, it } from "vitest"

import { unreachableMessage } from "@/domain/storeMessages"
import {
  COLLECTION_NAMES,
  CONNECT_TIMEOUT_MS,
  INDEX_PLANS,
  MONGODB_UNREACHABLE_WARNING,
  MONGO_CLIENT_OPTIONS,
  createMongoStore,
} from "@/server/store/mongo.server"

import {
  closeMongoFixture,
  mongoAvailability,
  mongoSkipReason,
  reportMongoSkip,
  withThrowawayDatabase,
} from "../support/mongoFixture"

import type { Db, IndexSpecification, MongoClientOptions } from "mongodb"
import type {
  CollectionName,
  MongoStore,
  StoreLogger,
} from "@/server/store/mongo.server"

/* -------------------------------------------------------------------------- */
/* Requirement 1.5: the client options                                        */
/* -------------------------------------------------------------------------- */

/**
 * An address on the loopback interface where nothing listens: port 1 is
 * privileged and unused, so a connection attempt is refused immediately rather
 * than hanging. The user, the password, and the database name are distinctive so
 * a leak of any part of the URI is searchable.
 */
const UNROUTABLE_URI =
  "mongodb://probe-user:probe-secret@127.0.0.1:1/leak-canary-db"

/** Every part of {@link UNROUTABLE_URI} that Requirement 1.6 excludes. */
const SECRET_PARTS: ReadonlyArray<string> = [
  UNROUTABLE_URI,
  "probe-user",
  "probe-secret",
  "127.0.0.1",
  "leak-canary-db",
]

/**
 * The startup bound this file overrides {@link CONNECT_TIMEOUT_MS} down to. The
 * requirement is about what happens when the bound expires, not about how long
 * it is, and the length is asserted separately as the constant it is.
 */
const SHORT_CONNECT_TIMEOUT_MS = 150

/** What one bootstrap against the unroutable address produced. */
interface UnreachableStartup {
  readonly store: MongoStore
  /** Every warning that bootstrap logged, in order. */
  readonly warnings: ReadonlyArray<string>
  /** The options the bootstrap handed the `MongoClient` constructor. */
  readonly clientOptions: MongoClientOptions | null
  /** The URI it handed the constructor, to show it is passed through unchanged. */
  readonly constructedUri: string | null
  /** How long `ready()` took, so "startup completes" is a measured claim. */
  readonly readyMs: number
}

/**
 * Bootstraps a store against {@link UNROUTABLE_URI} and awaits `ready()`,
 * capturing the warnings and the constructor arguments. The client is real —
 * only the address is hopeless — so the driver behaviour under test is the
 * driver's own.
 */
async function startUnreachableStore(): Promise<UnreachableStartup> {
  const warnings: Array<string> = []
  const logger: StoreLogger = {
    warn: (message) => {
      warnings.push(message)
    },
  }

  let clientOptions: MongoClientOptions | null = null
  let constructedUri: string | null = null

  const store = createMongoStore({
    readUri: () => UNROUTABLE_URI,
    databaseName: "leak-canary-db",
    logger,
    connectTimeoutMs: SHORT_CONNECT_TIMEOUT_MS,
    createClient: (uri, options) => {
      constructedUri = uri
      clientOptions = options
      return new MongoClient(uri, options)
    },
  })

  const startedAt = Date.now()
  await store.ready()
  const readyMs = Date.now() - startedAt

  return { store, warnings, clientOptions, constructedUri, readyMs }
}

/** Asserts that no part of the Mongo_Connection_URI appears in `text`. */
function expectNoUriLeak(text: string): void {
  for (const secret of SECRET_PARTS) {
    expect(text).not.toContain(secret)
  }
}

describe("the client options the bootstrap constructs (Requirement 1.5)", () => {
  it("bounds every operation at 5 seconds and starts no retry", () => {
    expect(MONGO_CLIENT_OPTIONS.timeoutMS).toBe(5_000)
    expect(MONGO_CLIENT_OPTIONS.serverSelectionTimeoutMS).toBe(5_000)
    expect(MONGO_CLIENT_OPTIONS.retryWrites).toBe(false)
    expect(MONGO_CLIENT_OPTIONS.retryReads).toBe(false)
  })

  it("hands exactly those options, and the URI unchanged, to the client", async () => {
    const started = await startUnreachableStore()
    try {
      expect(started.constructedUri).toBe(UNROUTABLE_URI)
      expect(started.clientOptions).toEqual(MONGO_CLIENT_OPTIONS)

      /*
       * Read back off the captured value rather than off the constant, so this
       * fails if the bootstrap ever narrows or overrides one of the three.
       */
      const options = started.clientOptions
      expect(options).not.toBeNull()
      expect(options?.timeoutMS).toBe(5_000)
      expect(options?.retryWrites).toBe(false)
      expect(options?.retryReads).toBe(false)
    } finally {
      await started.store.close()
    }
  })
})

describe("an unreachable deployment at startup (Requirements 1.11, 1.6)", () => {
  it("completes startup, warns exactly once, and answers every operation unreachable", async () => {
    const started = await startUnreachableStore()
    try {
      // Startup completed, and it did so inside its own bound.
      expect(started.readyMs).toBeLessThan(CONNECT_TIMEOUT_MS)
      expect(CONNECT_TIMEOUT_MS).toBe(10_000)

      // Exactly one warning, and it is the one this case has to log.
      expect(started.warnings).toEqual([MONGODB_UNREACHABLE_WARNING])
      expect(started.store.connected()).toBe(false)

      // Every collection answers `unreachable`, with the fixed sentence.
      for (const name of COLLECTION_NAMES) {
        const result = await started.store.collection(name)
        expect(result.kind).toBe("failure")
        if (result.kind !== "failure") continue
        expect(result.failure.reason).toBe("unreachable")
        expect(result.failure.message).toBe(unreachableMessage())
        expectNoUriLeak(result.failure.message)
      }

      // Those operations added no second warning: "exactly one" is per startup.
      expect(started.warnings).toEqual([MONGODB_UNREACHABLE_WARNING])
      for (const warning of started.warnings) {
        expectNoUriLeak(warning)
      }
    } finally {
      await started.store.close()
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Requirement 1.7: the indexes, against a real deployment                    */
/* -------------------------------------------------------------------------- */

/** One index as the deployment reports it. */
interface ReportedIndex {
  readonly name?: string
  readonly key: Record<string, unknown>
  readonly unique?: boolean
}

/** Every index the deployment holds for `collectionName`. */
async function reportedIndexes(
  db: Db,
  collectionName: CollectionName
): Promise<Array<ReportedIndex>> {
  const described = await db.collection(collectionName).indexes()
  return described.map((index) => {
    const record: Record<string, unknown> = index
    const name = record.name
    return {
      name: typeof name === "string" ? name : undefined,
      key: (record.key ?? {}) as Record<string, unknown>,
      unique: record.unique === true,
    }
  })
}

/**
 * The key document of one {@link INDEX_PLANS} entry. Every plan of this store
 * spells its keys as a document, so this is a narrowing rather than a
 * conversion.
 */
function planKey(keys: IndexSpecification): Record<string, number> {
  const record = keys as Record<string, unknown>
  const numbered = Object.entries(record).filter(
    ([, direction]) => typeof direction === "number"
  )
  return Object.fromEntries(numbered) as Record<string, number>
}

/** The reported index whose key equals `key`, or undefined. */
function indexOn(
  indexes: ReadonlyArray<ReportedIndex>,
  key: Record<string, number>
): ReportedIndex | undefined {
  return indexes.find((index) => {
    const entries = Object.entries(index.key)
    const expected = Object.entries(key)
    return (
      entries.length === expected.length &&
      expected.every(([field, direction]) => index.key[field] === direction)
    )
  })
}

const mongo = await mongoAvailability()

describe.skipIf(!mongo.available)(
  "the indexes the bootstrap creates (Requirements 1.7, 5.7 obsolete)",
  () => {
    afterAll(closeMongoFixture)

    it("creates the unique Hive_ID index and the completion-timestamp index before serving", async () => {
      await withThrowawayDatabase(
        async (sample) => {
          const store = await sample.createStore()
          expect(store.connected()).toBe(true)

          const db = sample.db()
          const members = await reportedIndexes(db, "members")
          const history = await reportedIndexes(db, "history")

          // The pair Requirement 1.7 names, plus the two the design adds.
          const hiveId = indexOn(members, { hiveId: 1 })
          expect(hiveId).toBeDefined()
          expect(hiveId?.unique).toBe(true)
          expect(indexOn(members, { position: 1 })).toBeDefined()
          expect(indexOn(history, { completedAtMs: -1 })).toBeDefined()
          expect(indexOn(history, { seq: 1 })).toBeDefined()

          /*
           * Every plan is expected, the `user_accounts` pair included: task 16.1
           * relies on this bootstrap to create them, so their presence is the
           * contract rather than a violation of Requirement 1.7.
           */
          for (const plan of INDEX_PLANS) {
            const indexes = await reportedIndexes(db, plan.collectionName)
            const created = indexOn(indexes, planKey(plan.keys))
            expect(
              created,
              `no index on ${plan.field} of ${plan.collectionName}`
            ).toBeDefined()
            if (plan.options?.unique === true) {
              expect(created?.unique).toBe(true)
            }
          }

          expect(sample.warnings).toEqual([])
        },
        { label: "indexes" }
      )
    })

    it("refuses a second Store_Document carrying the same Hive_ID", async () => {
      await withThrowawayDatabase(
        async (sample) => {
          const store = await sample.createStore()
          const result = await store.collection<{ hiveId: string }>("members")
          expect(result.kind).toBe("collection")
          if (result.kind !== "collection") return

          const hiveId = "Duplicate-Hive-Id-7c41"
          await result.collection.insertOne({ hiveId })

          /*
           * The refusal comes from the database, not from a code path: this
           * insert goes straight through the collection handle.
           */
          await expect(
            result.collection.insertOne({ hiveId })
          ).rejects.toMatchObject({ code: 11000 })

          expect(await result.collection.countDocuments({ hiveId })).toBe(1)
        },
        { label: "duplicate-hive" }
      )
    })

    it("creates no user_sessions collection", async () => {
      await withThrowawayDatabase(
        async (sample) => {
          await sample.createStore()

          const described = await sample
            .db()
            .listCollections({}, { nameOnly: true })
            .toArray()
          const names = described.map((collection) => collection.name)

          // Requirement 5.7 is obsolete: Clerk holds sessions.
          expect(names).not.toContain("user_sessions")
          // And nothing outside the closed set of collections was created.
          for (const name of names) {
            expect(COLLECTION_NAMES).toContain(name)
          }
        },
        { label: "collections" }
      )
    })
  }
)

it.runIf(!mongo.available)(
  `skipped, no MongoDB: ${mongoSkipReason(mongo) ?? ""}`,
  () => {
    reportMongoSkip("mongoBootstrap integration (Requirement 1.7)", mongo)
    expect(mongo.available).toBe(false)
    expect(mongoSkipReason(mongo)).not.toBeNull()
  }
)
