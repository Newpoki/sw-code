/**
 * An in-memory {@link MongoStore}: the four collections of
 * `src/server/store/mongo.server.ts` served out of arrays, with the operations
 * the store modules actually call, the `hiveId` unique index actually enforced,
 * and a handle for making any one operation fail.
 *
 * It is the shared, reusable form of the two hand-built fakes inside
 * `tests/unit/rosterStoreFailures.test.ts` and
 * `tests/unit/historyStoreFailures.test.ts`. Those two grew a `members` +
 * `counters` collection and a `history` + `counters` collection independently,
 * and every other suite that needs a store now needs the union of the two. So
 * the union lives here, and each of those files keeps its own fake because its
 * fake is part of what it is asserting.
 *
 * ## Why a fake rather than the real fixture
 *
 * `tests/support/mongoFixture.ts` is the honest answer for anything that is a
 * claim *about a database*: that an index refuses a duplicate, that a second
 * client reads what the first one durably wrote, that the bootstrap creates what
 * Requirement 1.7 lists. Those tests skip when no deployment is configured,
 * which is the right trade for a claim only a deployment can settle.
 *
 * Most of the suite is not that. It asserts Member_Registry and
 * Redemption_History *semantics* — position order, the cap of Requirement 2.5,
 * the retention window of Requirement 3.3, which sentence a failure speaks with
 * — and those claims hold against any store that behaves like MongoDB. Making
 * them skip without a deployment would leave roughly 150 assertions unrun in
 * every environment that has none, this one included. So they run over this,
 * and the database-shaped claims stay with the fixture.
 *
 * ## What "behaves like MongoDB" is taken to mean here
 *
 * Only what the three store modules ask for. `find` with a sort document, a
 * `limit`, and a projection; `findOne` with a projection; `countDocuments`;
 * `insertOne`; `insertMany`; `findOneAndUpdate` with `$set`, `$inc`, `upsert`,
 * and `returnDocument`; `deleteOne`; `deleteMany` with `_id: { $in: [...] }`;
 * and `createIndex` as the no-op it is for a store with no query planner. A
 * filter operator or an update operator outside that set **throws** rather than
 * being ignored, because a fake that silently answers a filter it did not
 * understand is a fake that reports a green test for a query nobody ran.
 *
 * Two behaviours are modelled with more care than the rest, because a store
 * module reads a consequence of each:
 *
 *   1. **`$inc` with `upsert` and `returnDocument: "after"`** yields 1 for a
 *      counter document that does not exist yet, which is the value
 *      Requirement 3.2 asks of the first appended record and Requirement 2.1 of
 *      the first position.
 *   2. **The unique indexes of {@link INDEX_PLANS}** are enforced, and a
 *      duplicate is refused with a `MongoServerError` carrying `code: 11000`.
 *      `memberRegistry.server.ts` maps that code back to a `duplicate` result by
 *      re-reading the conflicting Member_Label, so a fake that let a duplicate
 *      `hiveId` through would leave that path unreachable and untested. The
 *      indexes are read off {@link INDEX_PLANS} rather than restated, so an
 *      index that becomes unique in the bootstrap becomes unique here too.
 *
 * `_id` is a real `ObjectId` for the three collections whose driver assigns one,
 * so `deleteMany({ _id: { $in: [...] } })` compares identities the way the
 * retention trim needs it to. A `counters` document keeps the `_id` it is
 * addressed by, which is its own name.
 *
 * ## The backing data is a separate object on purpose
 *
 * {@link createInMemoryBackingStore} holds the documents; a store is a view over
 * one. Two stores built over the same backing store see the same data through
 * two independent `collection()` seams and two independent sets of injected
 * failures — which is the restart of Requirements 2.3 and 3.6 without a
 * database: build a store, write through it, build a second one over the same
 * backing store, and read.
 *
 * That is a weaker claim than the fixture's, and deliberately so: it shows the
 * store modules hold no per-instance state, not that MongoDB persisted
 * anything. The durability half stays with `mongoFixture.ts`.
 *
 * ## Fault injection
 *
 * Two shapes, matching the two shapes of failure the real store can produce:
 *
 *   - `collection(name)` itself answers `{ kind: "failure", failure }` — the
 *     `not-configured` and `unreachable` outcomes the bootstrap settles before
 *     any operation is attempted (Requirements 1.3, 1.10, 1.11).
 *   - one method of one collection rejects with a real driver error, while every
 *     other operation of the same path keeps working — which is what lets a test
 *     say "the insert failed" rather than "the whole collection failed".
 *
 * The `reject` / {@link InMemoryMongoStoreHandle.setRejection} /
 * {@link InMemoryMongoStoreHandle.clearRejection} shape is the one the two
 * existing fakes already use, so a suite moving onto this helper keeps the
 * phrasing it had.
 *
 * This module lives under `tests/support/`, which the Vitest config does not
 * collect: only test files under `tests/unit`, `tests/property`, and
 * `tests/integration` are collected.
 */

import { MongoServerError, ObjectId } from "mongodb"
import type { Collection, Document } from "mongodb"

import { unreachableMessage } from "@/domain/storeMessages"
import type { StoreFailure } from "@/domain/types"
import type {
  CounterDocument,
  CounterName,
  HistoryDocument,
  HistoryDocumentInput,
  MemberDocument,
  MemberDocumentInput,
  UserAccountDocument,
} from "@/server/store/documents.server"
import { COLLECTION_NAMES, INDEX_PLANS } from "@/server/store/mongo.server"
import type {
  CollectionName,
  CollectionOrFailure,
  MongoStore,
  StoreLogger,
} from "@/server/store/mongo.server"

/* -------------------------------------------------------------------------- */
/* The document a collection holds                                            */
/* -------------------------------------------------------------------------- */

/**
 * One stored document, as the fake holds it: the fields it was inserted with,
 * plus the `_id` it is addressed by.
 *
 * Loosely typed on purpose. One implementation serves four collections whose
 * documents share no fields and whose `_id` is an `ObjectId` in three of them
 * and a {@link CounterName} in the fourth, so the collection internals work in
 * `unknown` and the typed accessors on {@link InMemoryBackingStore} cast on the
 * way out. Nothing outside this module handles a `StoredDocument`.
 */
type StoredDocument = Record<string, unknown> & { _id: unknown }

/** A filter, an update, or a projection document, as a caller hands one in. */
type FilterDocument = Record<string, unknown>

/** The cursor options the store modules pass to `find` and `findOne`. */
interface FakeFindOptions {
  readonly sort?: Record<string, number>
  readonly limit?: number
  readonly projection?: Record<string, number>
}

/** The options `findOneAndUpdate` is called with. */
interface FakeUpdateOptions {
  readonly upsert?: boolean
  readonly returnDocument?: "before" | "after"
}

/* -------------------------------------------------------------------------- */
/* Seeding                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Documents a collection starts with. Each may carry its own `_id` or leave it
 * to the fake, exactly as an insert may — so a test can seed from
 * `toMemberDocument(...)` output without inventing an `ObjectId`.
 */
export interface CollectionSeeds {
  readonly members?: readonly (MemberDocumentInput | MemberDocument)[]
  readonly history?: readonly (HistoryDocumentInput | HistoryDocument)[]
  readonly user_accounts?: readonly (
    Omit<UserAccountDocument, "_id"> | UserAccountDocument
  )[]
  /** A counter document is keyed by its own name, so `_id` is required. */
  readonly counters?: readonly CounterDocument[]
}

/* -------------------------------------------------------------------------- */
/* The backing store                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The documents, held apart from any store over them.
 *
 * Hold one of these to build a second store over the same data — the restart
 * clauses of Requirements 2.3 and 3.6 — and to assert what is stored without
 * going through a store. Every accessor returns copies, so an assertion cannot
 * reach in and change what the collections hold.
 */
export interface InMemoryBackingStore {
  /** The `members` documents, in insertion order. */
  readonly members: () => readonly MemberDocument[]
  /** The `history` documents, in insertion order. */
  readonly history: () => readonly HistoryDocument[]
  /** The `user_accounts` documents, in insertion order. */
  readonly userAccounts: () => readonly UserAccountDocument[]
  /** The `counters` documents, in the order they were first written. */
  readonly counters: () => readonly CounterDocument[]
  /** The value one counter holds, or null when it has never been advanced. */
  readonly counterValue: (name: CounterName) => number | null
  /** Any collection's documents, for a caller that does not want the cast. */
  readonly all: (name: CollectionName) => readonly Document[]
  /** Adds documents to the collections named, keeping what is already there. */
  readonly seed: (seeds: CollectionSeeds) => void
  /** Empties every collection, counters included. */
  readonly clear: () => void
  /**
   * The live array one fake collection operates on.
   *
   * The seam between a store and its backing data, and the one accessor that
   * hands out references rather than copies. A test wants
   * {@link InMemoryBackingStore.members} and its siblings instead.
   */
  readonly live: (name: CollectionName) => StoredDocument[]
}

/**
 * A backing store, optionally seeded.
 *
 * Pass it to {@link createInMemoryMongoStore} through
 * {@link InMemoryMongoStoreOptions.backing} — twice, to get two stores over one
 * set of documents.
 */
export function createInMemoryBackingStore(
  seeds: CollectionSeeds = {}
): InMemoryBackingStore {
  const collections = new Map<CollectionName, StoredDocument[]>(
    COLLECTION_NAMES.map((name) => [name, []])
  )

  const live = (name: CollectionName): StoredDocument[] => {
    const documents = collections.get(name)
    if (documents === undefined) {
      /* Unreachable: the map is built from COLLECTION_NAMES, and the parameter
       * type admits nothing else. A guard against a fifth collection arriving
       * in one place and not the other. */
      throw new Error(
        `inMemoryMongoStore: there is no ${name} collection. The collections ` +
          `are ${COLLECTION_NAMES.join(", ")}.`
      )
    }
    return documents
  }

  const seed = (additional: CollectionSeeds): void => {
    for (const name of COLLECTION_NAMES) {
      const incoming = additional[name] ?? []
      for (const document of incoming) {
        live(name).push(withId(document as FilterDocument))
      }
    }
  }

  seed(seeds)

  const copies = (name: CollectionName): Document[] =>
    live(name).map((document) => cloneDocument(document) as Document)

  return {
    members: () => copies("members") as unknown as MemberDocument[],
    history: () => copies("history") as unknown as HistoryDocument[],
    userAccounts: () =>
      copies("user_accounts") as unknown as UserAccountDocument[],
    counters: () => copies("counters") as unknown as CounterDocument[],
    counterValue: (name) => {
      const found = live("counters").find((document) => document._id === name)
      return typeof found?.value === "number" ? found.value : null
    },
    all: copies,
    seed,
    clear: () => {
      for (const name of COLLECTION_NAMES) {
        live(name).length = 0
      }
    },
    live,
  }
}

/* -------------------------------------------------------------------------- */
/* Fault injection                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A collection method a test can make reject.
 *
 * `retentionFind` is not a driver method: it is the `find` of the
 * Redemption_History retention trim, told apart from the Requirement 3.4 read
 * by the `{ _id: 1 }` projection it carries. Both are `find`, and the two have
 * to fail independently — "the retention read failed while the ordinary read
 * kept working" is Requirement 3.11's case — so the projection decides which of
 * the two names a call answers to.
 */
export type CollectionMethod =
  | "find"
  | "retentionFind"
  | "findOne"
  | "countDocuments"
  | "insertOne"
  | "insertMany"
  | "findOneAndUpdate"
  | "updateOne"
  | "deleteOne"
  | "deleteMany"
  | "createIndex"

/** One call a store made, in the order the calls arrived. */
export interface CollectionCall {
  readonly collection: CollectionName
  readonly method: CollectionMethod
}

/** Rejections to install per collection, per method, before the first call. */
export type RejectionPlan = Partial<
  Record<CollectionName, Partial<Record<CollectionMethod, unknown>>>
>

export interface InMemoryMongoStoreOptions {
  /**
   * Documents the collections start with. Ignored when `backing` is given: the
   * backing store already holds what it holds, and seeding a shared one from a
   * second store would silently duplicate it.
   */
  readonly seed?: CollectionSeeds
  /**
   * The documents this store serves. Defaults to a fresh, seeded backing store.
   * Pass the `backing` of another handle to build a second store over the same
   * data (Requirements 2.3, 3.6).
   */
  readonly backing?: InMemoryBackingStore
  /** Methods that reject instead of serving, and what they reject with. */
  readonly reject?: RejectionPlan
  /**
   * Collections whose `collection(name)` answers a failure and serves nothing —
   * the `not-configured` and `unreachable` outcomes of Requirements 1.3, 1.10,
   * and 1.11.
   */
  readonly failures?: Partial<Record<CollectionName, StoreFailure>>
  /** Where warnings go. Defaults to a capturing sink; see the handle. */
  readonly logger?: StoreLogger
  /**
   * Whether the unique indexes of {@link INDEX_PLANS} are enforced. Defaults to
   * true. Switch it off only to arrange a state the indexes forbid — two
   * documents sharing a `hiveId`, say, to check what a read does with one.
   */
  readonly enforceUniqueIndexes?: boolean
}

/** The store, and everything a test needs to seed, inspect, and break it. */
export interface InMemoryMongoStoreHandle {
  /** The seam under test. Hand it to `createMemberRegistryStore` and friends. */
  readonly store: MongoStore
  /** The documents behind it. Pass it to a second store to model a restart. */
  readonly backing: InMemoryBackingStore
  /** The warning sink. Hand it to anything that takes a {@link StoreLogger}. */
  readonly logger: StoreLogger
  /** Everything that sink was handed, in call order. */
  readonly warnings: readonly string[]
  /** Every call this store served or refused, in call order. */
  readonly calls: readonly CollectionCall[]
  /** The methods called on one collection, in call order. */
  readonly callsTo: (name: CollectionName) => readonly CollectionMethod[]
  /** The stored `members` documents. Passthrough to {@link backing}. */
  readonly members: () => readonly MemberDocument[]
  /** The stored `history` documents. Passthrough to {@link backing}. */
  readonly history: () => readonly HistoryDocument[]
  /** The stored `user_accounts` documents. Passthrough to {@link backing}. */
  readonly userAccounts: () => readonly UserAccountDocument[]
  /** The stored `counters` documents. Passthrough to {@link backing}. */
  readonly counters: () => readonly CounterDocument[]
  /** The value one counter holds, or null. Passthrough to {@link backing}. */
  readonly counterValue: (name: CounterName) => number | null
  /** Makes one method of one collection reject, from the next call onward. */
  readonly setRejection: (
    name: CollectionName,
    method: CollectionMethod,
    error: unknown
  ) => void
  /** Makes it serve again. */
  readonly clearRejection: (
    name: CollectionName,
    method: CollectionMethod
  ) => void
  /** Clears every injected rejection. */
  readonly clearRejections: () => void
  /** Makes `collection(name)` answer this failure and serve nothing. */
  readonly setCollectionFailure: (
    name: CollectionName,
    failure: StoreFailure
  ) => void
  /** Makes it hand out a collection again. */
  readonly clearCollectionFailure: (name: CollectionName) => void
}

/**
 * Builds an in-memory {@link MongoStore}.
 *
 * The store holds no state beyond its injected failures: every read and every
 * write goes to the backing store, so two handles over one backing store see
 * the same documents and each keeps its own view of what is broken.
 */
export function createInMemoryMongoStore(
  options: InMemoryMongoStoreOptions = {}
): InMemoryMongoStoreHandle {
  const backing =
    options.backing ?? createInMemoryBackingStore(options.seed ?? {})
  const enforceUniqueIndexes = options.enforceUniqueIndexes ?? true

  const warnings: string[] = []
  const logger: StoreLogger = options.logger ?? {
    warn: (message) => {
      warnings.push(message)
    },
  }

  const calls: CollectionCall[] = []
  const rejections = new Map<string, unknown>()
  for (const [name, methods] of Object.entries(options.reject ?? {})) {
    for (const [method, error] of Object.entries(methods)) {
      rejections.set(
        rejectionKey(name as CollectionName, method as CollectionMethod),
        error
      )
    }
  }
  const collectionFailures = new Map<CollectionName, StoreFailure>(
    Object.entries(options.failures ?? {}) as [CollectionName, StoreFailure][]
  )

  let closed = false

  /**
   * Records the call, and answers with its injected rejection when there is
   * one. `null` means "serve it": a rejection *of* `null` is not expressible,
   * which is the same trade the two existing fakes make and costs nothing —
   * every rejection a test injects is an `Error`.
   */
  const rejectionFor = (
    name: CollectionName,
    method: CollectionMethod
  ): unknown => {
    calls.push({ collection: name, method })
    const key = rejectionKey(name, method)
    return rejections.has(key) ? rejections.get(key) : null
  }

  const fakes = new Map<CollectionName, unknown>(
    COLLECTION_NAMES.map((name) => [
      name,
      createFakeCollection(name, backing, rejectionFor, enforceUniqueIndexes),
    ])
  )

  const store: MongoStore = {
    ready: () => Promise.resolve(),

    collection: <T extends Document>(
      name: CollectionName
    ): Promise<CollectionOrFailure<T>> => {
      if (closed) {
        /* The real store answers a closed pool the same way it answers one that
         * does not exist yet: the database is unreachable and nothing was
         * changed, which is true of both (Requirement 1.11). */
        return Promise.resolve({
          kind: "failure",
          failure: { reason: "unreachable", message: unreachableMessage() },
        })
      }
      const failure = collectionFailures.get(name)
      if (failure !== undefined) {
        return Promise.resolve({ kind: "failure", failure })
      }
      return Promise.resolve({
        kind: "collection",
        collection: fakes.get(name) as Collection<T>,
      })
    },

    /* Requirement 8.3 restated for a fake: a pool is open while nothing has
     * closed it and no collection is answering a bootstrap failure. */
    connected: () => !closed && collectionFailures.size === 0,

    close: () => {
      closed = true
      return Promise.resolve()
    },
  }

  return {
    store,
    backing,
    logger,
    warnings,
    calls,
    callsTo: (name) =>
      calls
        .filter((call) => call.collection === name)
        .map((call) => call.method),
    members: backing.members,
    history: backing.history,
    userAccounts: backing.userAccounts,
    counters: backing.counters,
    counterValue: backing.counterValue,
    setRejection: (name, method, error) => {
      rejections.set(rejectionKey(name, method), error)
    },
    clearRejection: (name, method) => {
      rejections.delete(rejectionKey(name, method))
    },
    clearRejections: () => {
      rejections.clear()
    },
    setCollectionFailure: (name, failure) => {
      collectionFailures.set(name, failure)
    },
    clearCollectionFailure: (name) => {
      collectionFailures.delete(name)
    },
  }
}

function rejectionKey(name: CollectionName, method: CollectionMethod): string {
  return `${name}.${method}`
}

/* -------------------------------------------------------------------------- */
/* The fake collection                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One collection, over the backing store's live array.
 *
 * Every method consults the injected rejections first, so exactly one operation
 * of one path can be made to fail while the rest of that path keeps working.
 * `find` rejects from `toArray` rather than from `find` itself, because that is
 * where the driver's round trip happens: building a cursor touches no
 * deployment.
 */
function createFakeCollection(
  name: CollectionName,
  backing: InMemoryBackingStore,
  rejectionFor: (name: CollectionName, method: CollectionMethod) => unknown,
  enforceUniqueIndexes: boolean
): unknown {
  const documents = () => backing.live(name)
  const uniqueIndexes = enforceUniqueIndexes ? uniqueIndexesOf(name) : []

  /** Throws the duplicate-key error a unique index would (`code: 11000`). */
  const enforceUnique = (
    candidate: StoredDocument,
    ignoreIndex: number
  ): void => {
    for (const index of uniqueIndexes) {
      const clash = documents().findIndex(
        (held, position) =>
          position !== ignoreIndex &&
          index.fields.every((field) =>
            valuesEqual(held[field], candidate[field])
          )
      )
      if (clash !== -1) {
        throw duplicateKeyError(name, index)
      }
    }
  }

  const insert = (document: FilterDocument): StoredDocument => {
    const stored = withId(document)
    enforceUnique(stored, -1)
    documents().push(stored)
    return stored
  }

  return {
    /** The `find` cursor. Only `toArray` is modelled; nothing else is called. */
    find: (filter: FilterDocument = {}, options: FakeFindOptions = {}) => {
      /* The retention trim is the `find` that projects; the Requirement 3.4
       * read asks for whole Store_Documents. */
      const projecting = options.projection !== undefined
      const rejection = rejectionFor(
        name,
        projecting ? "retentionFind" : "find"
      )
      return {
        toArray: (): Promise<Document[]> => {
          if (rejection !== null) {
            return Promise.reject(rejection)
          }
          const selected = documents().filter((document) =>
            matchesFilter(document, filter)
          )
          if (options.sort !== undefined) {
            const sort = options.sort
            /* `Array.prototype.sort` is stable, so documents the sort document
             * cannot separate keep insertion order — which is what the driver
             * does for an unindexed tie too. */
            selected.sort((left, right) => compareBySort(sort, left, right))
          }
          const limited =
            options.limit === undefined
              ? selected
              : selected.slice(0, options.limit)
          return Promise.resolve(
            limited.map(
              (document) => project(document, options.projection) as Document
            )
          )
        },
      }
    },

    findOne: (
      filter: FilterDocument = {},
      options: FakeFindOptions = {}
    ): Promise<Document | null> => {
      const rejection = rejectionFor(name, "findOne")
      if (rejection !== null) {
        return Promise.reject(rejection)
      }
      const found = documents().find((document) =>
        matchesFilter(document, filter)
      )
      return Promise.resolve(
        found === undefined
          ? null
          : (project(found, options.projection) as Document)
      )
    },

    countDocuments: (filter: FilterDocument = {}): Promise<number> => {
      const rejection = rejectionFor(name, "countDocuments")
      if (rejection !== null) {
        return Promise.reject(rejection)
      }
      return Promise.resolve(
        documents().filter((document) => matchesFilter(document, filter)).length
      )
    },

    insertOne: (
      document: FilterDocument
    ): Promise<{ acknowledged: boolean; insertedId: unknown }> => {
      const rejection = rejectionFor(name, "insertOne")
      if (rejection !== null) {
        return Promise.reject(rejection)
      }
      try {
        return Promise.resolve({
          acknowledged: true,
          insertedId: insert(document)._id,
        })
      } catch (error) {
        /* A refused insert is a rejected promise, not a throw: `insertOne` is
         * async, and a store module's `try` wraps an `await`. */
        return Promise.reject(error)
      }
    },

    /**
     * Ordered `insertMany`, as the driver defaults to it: documents are
     * inserted in order and the first refusal stops the batch, leaving the
     * documents before it inserted. A Data_Import that trips a unique index
     * part-way therefore sees the same partial state it would see against a
     * deployment, which is the state Requirement 4 asks it to roll back.
     */
    insertMany: (
      incoming: readonly FilterDocument[]
    ): Promise<{
      acknowledged: boolean
      insertedCount: number
      insertedIds: Record<number, unknown>
    }> => {
      const rejection = rejectionFor(name, "insertMany")
      if (rejection !== null) {
        return Promise.reject(rejection)
      }
      const insertedIds: Record<number, unknown> = {}
      let insertedCount = 0
      for (const [position, document] of incoming.entries()) {
        try {
          insertedIds[position] = insert(document)._id
          insertedCount += 1
        } catch (error) {
          return Promise.reject(error)
        }
      }
      return Promise.resolve({ acknowledged: true, insertedCount, insertedIds })
    },

    /**
     * `$set` and `$inc`, with `upsert` and `returnDocument`.
     *
     * An upsert that matches nothing builds the new document from the filter's
     * equality fields and then applies the update, which is how `$inc` on an
     * absent counter yields 1: the missing field counts as 0. `returnDocument:
     * "before"` on an upsert answers null, because there was no document
     * before.
     */
    findOneAndUpdate: (
      filter: FilterDocument,
      update: FilterDocument,
      options: FakeUpdateOptions = {}
    ): Promise<Document | null> => {
      const rejection = rejectionFor(name, "findOneAndUpdate")
      if (rejection !== null) {
        return Promise.reject(rejection)
      }
      const after = options.returnDocument === "after"
      const index = documents().findIndex((document) =>
        matchesFilter(document, filter)
      )

      if (index === -1) {
        if (options.upsert !== true) {
          return Promise.resolve(null)
        }
        try {
          const upserted = withId(equalityFieldsOf(filter))
          applyUpdate(upserted, update, true)
          enforceUnique(upserted, -1)
          documents().push(upserted)
          return Promise.resolve(
            after ? (cloneDocument(upserted) as Document) : null
          )
        } catch (error) {
          return Promise.reject(error)
        }
      }

      const before = cloneDocument(documents()[index]) as Document
      const updated = cloneDocument(documents()[index])
      try {
        applyUpdate(updated, update, false)
        enforceUnique(updated, index)
      } catch (error) {
        return Promise.reject(error)
      }
      documents()[index] = updated
      return Promise.resolve(
        after ? (cloneDocument(updated) as Document) : before
      )
    },

    /**
     * `$set`, `$inc`, and `$setOnInsert`, with `upsert` — the write the
     * User_Account mirror makes (task 16.1). An upsert that matches nothing
     * builds the new document from the filter's equality fields, applies the
     * update with `$setOnInsert` in force, and enforces the unique indexes; an
     * update of an existing document ignores `$setOnInsert`, which is how
     * `lastSignInAt` is seeded on a first sign-in and left untouched on a
     * same-session refresh (Requirement 5.5 restated). `matchedCount`,
     * `modifiedCount`, `upsertedCount`, and `upsertedId` are reported the way
     * the driver reports them, so a caller reading any of them sees the truth.
     */
    updateOne: (
      filter: FilterDocument,
      update: FilterDocument,
      options: FakeUpdateOptions = {}
    ): Promise<{
      acknowledged: boolean
      matchedCount: number
      modifiedCount: number
      upsertedCount: number
      upsertedId: unknown
    }> => {
      const rejection = rejectionFor(name, "updateOne")
      if (rejection !== null) {
        return Promise.reject(rejection)
      }
      const index = documents().findIndex((document) =>
        matchesFilter(document, filter)
      )

      if (index === -1) {
        if (options.upsert !== true) {
          return Promise.resolve({
            acknowledged: true,
            matchedCount: 0,
            modifiedCount: 0,
            upsertedCount: 0,
            upsertedId: null,
          })
        }
        try {
          const upserted = withId(equalityFieldsOf(filter))
          applyUpdate(upserted, update, true)
          enforceUnique(upserted, -1)
          documents().push(upserted)
          return Promise.resolve({
            acknowledged: true,
            matchedCount: 0,
            modifiedCount: 0,
            upsertedCount: 1,
            upsertedId: upserted._id,
          })
        } catch (error) {
          return Promise.reject(error)
        }
      }

      const updated = cloneDocument(documents()[index])
      try {
        applyUpdate(updated, update, false)
        enforceUnique(updated, index)
      } catch (error) {
        return Promise.reject(error)
      }
      documents()[index] = updated
      return Promise.resolve({
        acknowledged: true,
        matchedCount: 1,
        modifiedCount: 1,
        upsertedCount: 0,
        upsertedId: null,
      })
    },

    deleteOne: (
      filter: FilterDocument
    ): Promise<{ acknowledged: boolean; deletedCount: number }> => {
      const rejection = rejectionFor(name, "deleteOne")
      if (rejection !== null) {
        return Promise.reject(rejection)
      }
      const index = documents().findIndex((document) =>
        matchesFilter(document, filter)
      )
      if (index === -1) {
        return Promise.resolve({ acknowledged: true, deletedCount: 0 })
      }
      documents().splice(index, 1)
      return Promise.resolve({ acknowledged: true, deletedCount: 1 })
    },

    deleteMany: (
      filter: FilterDocument = {}
    ): Promise<{ acknowledged: boolean; deletedCount: number }> => {
      const rejection = rejectionFor(name, "deleteMany")
      if (rejection !== null) {
        return Promise.reject(rejection)
      }
      const held = documents()
      const survivors = held.filter(
        (document) => !matchesFilter(document, filter)
      )
      const deletedCount = held.length - survivors.length
      held.length = 0
      held.push(...survivors)
      return Promise.resolve({ acknowledged: true, deletedCount })
    },

    /**
     * A no-op that answers with an index name, the way the driver does.
     *
     * Nothing here plans a query, and the uniqueness the indexes carry is
     * enforced from {@link INDEX_PLANS} whether or not anyone created them — so
     * a bootstrap running against this store finishes without warning and
     * changes nothing.
     */
    createIndex: (
      keys: unknown,
      options: { name?: string } = {}
    ): Promise<string> => {
      const rejection = rejectionFor(name, "createIndex")
      if (rejection !== null) {
        return Promise.reject(rejection)
      }
      return Promise.resolve(options.name ?? describeKeys(keys))
    },
  }
}

/* -------------------------------------------------------------------------- */
/* The unique indexes, read off the bootstrap's own plans                      */
/* -------------------------------------------------------------------------- */

/** One unique index of {@link INDEX_PLANS}, in the form the fake enforces. */
interface UniqueIndex {
  readonly fields: readonly string[]
  readonly indexName: string
}

/**
 * The `_id` index every MongoDB collection has, whether anyone declared it or
 * not. It is what makes a re-insert of a document that is already stored fail
 * rather than duplicate it, which is a state a Data_Import can reach.
 */
const ID_INDEX: UniqueIndex = { fields: ["_id"], indexName: "_id_" }

/**
 * The unique indexes over one collection: the `_id` index, plus every plan of
 * {@link INDEX_PLANS} that declares `unique: true` over this collection.
 *
 * The declared ones are read rather than restated, so the fake cannot disagree
 * with the bootstrap: an index that gains `unique: true` there gains it here,
 * and one that loses it stops being enforced here too.
 */
function uniqueIndexesOf(name: CollectionName): readonly UniqueIndex[] {
  const declared = INDEX_PLANS.flatMap((plan) => {
    if (plan.collectionName !== name || plan.options?.unique !== true) {
      return []
    }
    const keys: unknown = plan.keys
    if (
      typeof keys !== "object" ||
      keys === null ||
      Array.isArray(keys) ||
      keys instanceof Map
    ) {
      /* Every plan the bootstrap declares uses the `{ field: 1 }` form. A
       * string or a tuple form would need a second reading, so it is skipped
       * rather than guessed at. */
      return []
    }
    return [
      {
        fields: Object.keys(keys),
        indexName: plan.options.name ?? plan.field,
      },
    ]
  })
  return [ID_INDEX, ...declared]
}

/**
 * The error a unique index raises, shaped the way a real one is: `code: 11000`,
 * a `keyPattern`, and a message that starts with `E11000`.
 *
 * `memberRegistry.server.ts` reads the numeric code and nothing else — the
 * message names the value the database refused, and Requirement 1.6 keeps that
 * out of every returned value — so the code is the part that has to be right.
 * The rest is here so a test asserting on a realistic error has one.
 */
function duplicateKeyError(
  collectionName: CollectionName,
  index: UniqueIndex
): MongoServerError {
  const keyPattern = Object.fromEntries(index.fields.map((field) => [field, 1]))
  return new MongoServerError({
    message:
      `E11000 duplicate key error collection: sw-code.${collectionName} ` +
      `index: ${index.indexName}`,
    code: 11_000,
    codeName: "DuplicateKey",
    index: 0,
    keyPattern,
  })
}

/** A readable name for an index the fake was asked to create. */
function describeKeys(keys: unknown): string {
  if (typeof keys === "object" && keys !== null && !Array.isArray(keys)) {
    return Object.entries(keys as Record<string, unknown>)
      .map(([field, direction]) => `${field}_${String(direction)}`)
      .join("_")
  }
  return String(keys)
}

/* -------------------------------------------------------------------------- */
/* Documents, filters, updates, sorts, projections                            */
/* -------------------------------------------------------------------------- */

/**
 * The document as it is stored: its own `_id` when it brought one — a counter
 * name, or a seeded `ObjectId` — and a fresh `ObjectId` when it did not, which
 * is the driver's job on every insert the store modules make.
 */
function withId(document: FilterDocument): StoredDocument {
  const stored = cloneDocument(document as StoredDocument)
  if (stored._id === undefined) {
    stored._id = new ObjectId()
  }
  return stored
}

/**
 * A copy one level deep, with arrays and the objects inside them copied too.
 *
 * Deep enough for the one nested shape the collections hold — the `outcomes`
 * rows of a Redemption_History Store_Document — so a caller that keeps
 * mutating what it inserted cannot reach into stored history, which is the
 * guarantee `documents.server.ts` makes on both sides of the mapping. `Date`
 * and `ObjectId` values are shared: both are treated as immutable everywhere in
 * the store.
 */
function cloneDocument(document: StoredDocument): StoredDocument {
  const copy: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(document)) {
    copy[field] = Array.isArray(value)
      ? value.map(cloneValue)
      : cloneValue(value)
  }
  return copy as StoredDocument
}

function cloneValue(value: unknown): unknown {
  if (
    typeof value !== "object" ||
    value === null ||
    value instanceof Date ||
    value instanceof ObjectId ||
    Array.isArray(value)
  ) {
    return value
  }
  return { ...(value as Record<string, unknown>) }
}

/**
 * Equality as the server compares it, for the value kinds the collections hold:
 * an `ObjectId` by its bytes, a `Date` by its instant, everything else by
 * `===`. That is what makes `deleteMany({ _id: { $in: [...] } })` delete the
 * documents the retention read selected rather than nothing at all.
 */
function valuesEqual(left: unknown, right: unknown): boolean {
  if (left instanceof ObjectId || right instanceof ObjectId) {
    return (
      left instanceof ObjectId &&
      right instanceof ObjectId &&
      left.equals(right)
    )
  }
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime()
  }
  return left === right
}

/**
 * Whether the document satisfies the filter.
 *
 * Field equality, plus the three operators the store modules use or could
 * reasonably use next: `$in` (the retention delete), `$nin`, and `$ne`. Any
 * other operator **throws**, because the alternative is a filter that quietly
 * matches everything and a test that passes for a query nobody ran.
 */
function matchesFilter(
  document: StoredDocument,
  filter: FilterDocument
): boolean {
  return Object.entries(filter).every(([field, condition]) =>
    matchesCondition(document[field], condition)
  )
}

function matchesCondition(held: unknown, condition: unknown): boolean {
  if (!isOperatorDocument(condition)) {
    return valuesEqual(held, condition)
  }
  return Object.entries(condition).every(([operator, operand]) => {
    switch (operator) {
      case "$in":
        return asArray(operand).some((value) => valuesEqual(held, value))
      case "$nin":
        return !asArray(operand).some((value) => valuesEqual(held, value))
      case "$ne":
        return !valuesEqual(held, operand)
      default:
        throw new Error(
          `inMemoryMongoStore: the filter operator ${operator} is not ` +
            `modelled. Model it here rather than letting a test pass over a ` +
            `filter that was never applied.`
        )
    }
  })
}

/** Whether the condition is `{ $operator: ... }` rather than a plain value. */
function isOperatorDocument(
  condition: unknown
): condition is Record<string, unknown> {
  if (
    typeof condition !== "object" ||
    condition === null ||
    Array.isArray(condition) ||
    condition instanceof Date ||
    condition instanceof ObjectId
  ) {
    return false
  }
  const keys = Object.keys(condition)
  return keys.length > 0 && keys.every((key) => key.startsWith("$"))
}

function asArray(operand: unknown): readonly unknown[] {
  return Array.isArray(operand) ? operand : []
}

/**
 * The filter's plain-equality fields, which are the fields an upsert seeds the
 * new document with — `{ _id: "history_seq" }` becoming the `_id` of the
 * counter document that did not exist yet. Operator conditions contribute
 * nothing, the way they do not on the server.
 */
function equalityFieldsOf(filter: FilterDocument): FilterDocument {
  return Object.fromEntries(
    Object.entries(filter).filter(
      ([, condition]) => !isOperatorDocument(condition)
    )
  )
}

/**
 * Applies `$set`, `$inc`, and `$setOnInsert` in place. `$inc` treats an absent
 * field as 0, which is what makes the first advance of a counter yield 1
 * (Requirements 2.1, 3.2). `$setOnInsert` is applied only when the operation
 * inserts a new document — `isInsert` says which case this is — and is ignored
 * on an update of an existing document, exactly as the driver does: it is how
 * the User_Account upsert seeds `lastSignInAt` for a first sign-in without
 * touching it on a same-session refresh (Requirement 5.5 restated). Any other
 * operator throws, for the same reason an unmodelled filter operator does.
 */
function applyUpdate(
  document: StoredDocument,
  update: FilterDocument,
  isInsert: boolean
): void {
  for (const [operator, operand] of Object.entries(update)) {
    const fields = (operand ?? {}) as Record<string, unknown>
    switch (operator) {
      case "$set":
        for (const [field, value] of Object.entries(fields)) {
          document[field] = value
        }
        break
      case "$setOnInsert":
        if (isInsert) {
          for (const [field, value] of Object.entries(fields)) {
            document[field] = value
          }
        }
        break
      case "$inc":
        for (const [field, delta] of Object.entries(fields)) {
          const current = document[field]
          document[field] =
            (typeof current === "number" ? current : 0) +
            (typeof delta === "number" ? delta : 0)
        }
        break
      default:
        throw new Error(
          `inMemoryMongoStore: the update operator ${operator} is not ` +
            `modelled. Model it here rather than letting a write silently do ` +
            `nothing.`
        )
    }
  }
}

/**
 * The sort document applied field by field, in the order it declares them, with
 * `1` ascending and `-1` descending — the `{ completedAtMs: -1, seq: -1 }` of
 * Requirement 3.4 and the `{ position: 1 }` of Requirement 2.2.
 */
function compareBySort(
  sort: Record<string, number>,
  left: StoredDocument,
  right: StoredDocument
): number {
  for (const [field, direction] of Object.entries(sort)) {
    const ordered = compareValues(left[field], right[field])
    if (ordered !== 0) {
      return ordered * direction
    }
  }
  return 0
}

/** Orders the value kinds the collections sort by: numbers, strings, dates. */
function compareValues(left: unknown, right: unknown): number {
  const ordinal = (value: unknown): number | string =>
    value instanceof Date ? value.getTime() : (value as number | string)
  const leftValue = ordinal(left)
  const rightValue = ordinal(right)
  if (leftValue === rightValue) {
    return 0
  }
  return leftValue < rightValue ? -1 : 1
}

/**
 * The document a projection asks for: an inclusion projection keeps the named
 * fields and `_id` unless `_id: 0` drops it, and an exclusion projection keeps
 * everything else. Only the inclusion form is used by the store modules — the
 * `{ _id: 1 }` of the retention read — and the exclusion form is here because
 * the two cannot be told apart by anything other than their values.
 */
function project(
  document: StoredDocument,
  projection: Record<string, number> | undefined
): StoredDocument {
  const copy = cloneDocument(document)
  if (projection === undefined) {
    return copy
  }

  const included = Object.entries(projection)
    .filter(([field, value]) => value !== 0 && field !== "_id")
    .map(([field]) => field)
  const keepId = projection._id !== 0

  if (
    included.length === 0 &&
    Object.keys(projection).some((f) => f !== "_id")
  ) {
    /* Every named field carries 0: an exclusion projection. */
    const excluded = new Set(Object.keys(projection))
    return Object.fromEntries(
      Object.entries(copy).filter(([field]) => !excluded.has(field))
    ) as StoredDocument
  }

  const kept: Record<string, unknown> = {}
  if (keepId) {
    kept._id = copy._id
  }
  for (const field of included) {
    if (field in copy) {
      kept[field] = copy[field]
    }
  }
  return kept as StoredDocument
}
