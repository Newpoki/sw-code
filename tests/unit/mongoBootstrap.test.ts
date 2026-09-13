/**
 * Unit tests for the Mongo_Store bootstrap: one client and one pool for the
 * lifetime of the process (Requirement 1.4), a connection indicator that is
 * true only while a pool is open (Requirement 8.3), and an index creation whose
 * failure stops neither the other indexes nor the serving (Requirement 1.8).
 *
 * No MongoDB runs here. The store's own `createClient` seam receives a fake
 * client whose `connect`, `db`, `collection`, `createIndex`, and `close` this
 * file controls, which is what makes "the pool is not open yet" and "this one
 * index failed and that one did not" observable states rather than timing
 * accidents. The deployment-facing half of the bootstrap — that the indexes
 * really exist afterwards, and that the client really carries the Requirement
 * 1.5 options — belongs to the integration test over a throwaway database.
 *
 * Every store below is constructed directly rather than through
 * `getMongoStore`, because the process-wide store passes
 * `logConfigurationWarnings: false`: `config.server.ts` has already logged the
 * Requirement 1.3 and 1.10 warnings once, and both requirements ask for exactly
 * one.
 */

import { describe, expect, it } from "vitest"

import type {
  CreateIndexesOptions,
  Db,
  IndexSpecification,
  MongoClient,
  MongoClientOptions,
} from "mongodb"

import {
  INDEX_PLANS,
  MONGODB_UNREACHABLE_WARNING,
  createMongoStore,
  getMongoStore,
  indexCreationFailedWarning,
  resetMongoStore,
  setMongoStore,
} from "@/server/store/mongo.server"
import type { MongoStore, MongoStoreOptions } from "@/server/store/mongo.server"

/**
 * The connection string the fake is built over, and the fragments of it that
 * may not reach a warning (Requirement 1.6). Every failure the fake raises
 * quotes it, the way a driver error does.
 */
const URI = "mongodb://roster_writer:s3cr3t@cluster0.example.net:27017/live"
const URI_FRAGMENTS = [
  URI,
  "roster_writer",
  "s3cr3t",
  "cluster0.example.net",
  "27017",
] as const

const DATABASE_NAME = "unit-test-db"

/** One index plan, as {@link INDEX_PLANS} holds it. */
type IndexPlan = (typeof INDEX_PLANS)[number]

/** One `createIndex` call the fake received. */
interface IndexAttempt {
  readonly collectionName: string
  readonly keys: IndexSpecification
  readonly options: CreateIndexesOptions
}

/** How the fake's `connect()` behaves. */
type ConnectBehaviour =
  /** Resolves immediately: the pool is open before the bootstrap returns. */
  | "resolved"
  /** Rejects immediately: no pool, and the driver keeps trying. */
  | "rejected"
  /** Stays pending until {@link FakeDeployment.settleConnect} is called. */
  | "pending"

interface FakeDeploymentOptions {
  readonly connect?: ConnectBehaviour
  /** True for an attempt whose `createIndex` must reject. */
  readonly failIndex?: (attempt: IndexAttempt) => boolean
  /** True to make the client construction throw — the unparsable-URI case. */
  readonly clientConstructionThrows?: boolean
}

/** The fake deployment, and everything the store did to it. */
interface FakeDeployment {
  /** The `createClient` seam handed to {@link createMongoStore}. */
  readonly createClient: (
    uri: string,
    options: MongoClientOptions
  ) => MongoClient
  /** One entry per client construction: at most one, for the whole lifetime. */
  readonly constructions: ReadonlyArray<{
    readonly uri: string
    readonly options: MongoClientOptions
  }>
  /** The database names `client.db()` was asked for, in order. */
  readonly databaseNames: readonly string[]
  readonly attempted: readonly IndexAttempt[]
  readonly created: readonly IndexAttempt[]
  readonly connectCalls: () => number
  readonly closeCalls: () => number
  /** Resolves a `pending` connection, the way a deployment coming back does. */
  readonly settleConnect: () => void
}

function fakeDeployment(options: FakeDeploymentOptions = {}): FakeDeployment {
  const behaviour = options.connect ?? "resolved"
  const failIndex = options.failIndex ?? (() => false)

  const constructions: Array<{ uri: string; options: MongoClientOptions }> = []
  const databaseNames: Array<string> = []
  const attempted: Array<IndexAttempt> = []
  const created: Array<IndexAttempt> = []
  /* One handle per collection name, so "served through the same pool" is an
   * identity a test can assert rather than a shape it has to trust. */
  const handles = new Map<string, unknown>()
  let connectCalls = 0
  let closeCalls = 0
  let settleConnect: () => void = () => {}

  const collectionHandle = (collectionName: string): unknown => {
    const existing = handles.get(collectionName)
    if (existing !== undefined) {
      return existing
    }
    const handle = {
      collectionName,
      createIndex: (
        keys: IndexSpecification,
        indexOptions?: CreateIndexesOptions
      ): Promise<string> => {
        const attempt: IndexAttempt = {
          collectionName,
          keys,
          options: indexOptions ?? {},
        }
        attempted.push(attempt)
        if (failIndex(attempt)) {
          return Promise.reject(
            new Error(
              `index build failed on ${collectionName} at ${URI} (cluster0.example.net:27017)`
            )
          )
        }
        created.push(attempt)
        return Promise.resolve(indexOptions?.name ?? collectionName)
      },
    }
    handles.set(collectionName, handle)
    return handle
  }

  const client = {
    connect: (): Promise<MongoClient> => {
      connectCalls += 1
      if (behaviour === "resolved") {
        return Promise.resolve(client as unknown as MongoClient)
      }
      if (behaviour === "rejected") {
        return Promise.reject(new Error(`connect ECONNREFUSED for ${URI}`))
      }
      return new Promise<MongoClient>((resolve) => {
        settleConnect = () => resolve(client as unknown as MongoClient)
      })
    },
    db: (name: string): Db => {
      databaseNames.push(name)
      return {
        collection: (collectionName: string) =>
          collectionHandle(collectionName),
      } as unknown as Db
    },
    close: (): Promise<void> => {
      closeCalls += 1
      return Promise.resolve()
    },
  }

  return {
    createClient: (uri, clientOptions) => {
      constructions.push({ uri, options: clientOptions })
      if (options.clientConstructionThrows === true) {
        throw new Error(`Invalid connection string "${uri}"`)
      }
      return client as unknown as MongoClient
    },
    constructions,
    databaseNames,
    attempted,
    created,
    connectCalls: () => connectCalls,
    closeCalls: () => closeCalls,
    settleConnect: () => settleConnect(),
  }
}

/** A store over the fake, with its warnings captured. */
function storeOver(
  deployment: FakeDeployment,
  overrides: Partial<MongoStoreOptions> = {}
): { store: MongoStore; warnings: Array<string> } {
  const warnings: Array<string> = []
  const store = createMongoStore({
    readUri: () => URI,
    databaseName: DATABASE_NAME,
    logger: { warn: (message) => warnings.push(message) },
    createClient: deployment.createClient,
    ...overrides,
  })
  return { store, warnings }
}

/** The plan for one index, looked up rather than restated. */
function planFor(collectionName: string, field: string): IndexPlan {
  const plan = INDEX_PLANS.find(
    (candidate) =>
      candidate.collectionName === collectionName && candidate.field === field
  )
  if (plan === undefined) {
    throw new Error(`no index plan for ${field} of ${collectionName}`)
  }
  return plan
}

/** Whether the attempt is the creation of that plan's index. */
function isPlan(attempt: IndexAttempt, plan: IndexPlan): boolean {
  return (
    attempt.collectionName === plan.collectionName &&
    attempt.options.name === plan.options?.name
  )
}

/** The index names of a list of attempts, in the order they arrived. */
function names(attempts: readonly IndexAttempt[]): Array<string | undefined> {
  return attempts.map((attempt) => attempt.options.name)
}

/** Every index name the bootstrap should attempt, in plan order. */
function everyPlanName(): Array<string | undefined> {
  return INDEX_PLANS.map((plan) => plan.options?.name)
}

describe("one client and one pool, reused for the process lifetime (Requirement 1.4)", () => {
  it("constructs one client and connects once however many operations arrive", async () => {
    const deployment = fakeDeployment()
    const { store } = storeOver(deployment)

    await Promise.all([
      store.ready(),
      store.collection("members"),
      store.collection("history"),
      store.collection("user_accounts"),
      store.collection("counters"),
    ])
    await store.ready()
    await store.collection("members")
    await store.collection("history")

    expect(deployment.constructions).toHaveLength(1)
    expect(deployment.constructions[0]?.uri).toBe(URI)
    expect(deployment.connectCalls()).toBe(1)
    /* One database handle, taken once, for the whole bootstrap. */
    expect(deployment.databaseNames).toEqual([DATABASE_NAME])
  })

  it("creates the indexes once for the bootstrap, not once per operation", async () => {
    const deployment = fakeDeployment()
    const { store } = storeOver(deployment)

    await store.ready()
    for (const name of ["members", "history", "user_accounts"] as const) {
      await store.collection(name)
      await store.collection(name)
    }

    // Requirement 1.7: attempted before the first operation, and only then.
    expect(names(deployment.attempted)).toEqual(everyPlanName())
    expect(names(deployment.created)).toEqual(everyPlanName())
  })

  it("serves every operation on one collection through the same handle", async () => {
    const deployment = fakeDeployment()
    const { store } = storeOver(deployment)

    const first = await store.collection("members")
    const second = await store.collection("members")
    const other = await store.collection("history")

    expect(first.kind).toBe("collection")
    expect(second.kind).toBe("collection")
    if (first.kind !== "collection" || second.kind !== "collection") {
      throw new Error("the store served no collection")
    }
    expect(first.collection).toBe(second.collection)
    if (other.kind !== "collection") {
      throw new Error("the store served no collection")
    }
    expect(other.collection).not.toBe(first.collection)
  })

  it("hands out the one process-wide store until it is reset", () => {
    const first = storeOver(fakeDeployment()).store
    const second = storeOver(fakeDeployment()).store

    setMongoStore(first)
    expect(getMongoStore()).toBe(first)
    expect(getMongoStore()).toBe(first)

    resetMongoStore()
    setMongoStore(second)
    expect(getMongoStore()).toBe(second)
    expect(getMongoStore()).not.toBe(first)

    /* Leave no store installed for whatever runs next in this file. */
    resetMongoStore()
  })
})

describe("connected() is true only while a pool is open (Requirement 8.3)", () => {
  it("is true after the pool opens and false again after it closes", async () => {
    const deployment = fakeDeployment()
    const { store } = storeOver(deployment)

    await store.ready()
    expect(store.connected()).toBe(true)

    await store.close()

    expect(store.connected()).toBe(false)
    expect(deployment.closeCalls()).toBe(1)
    const served = await store.collection("members")
    expect(served).toEqual({
      kind: "failure",
      failure: { reason: "unreachable", message: expect.any(String) },
    })
  })

  it("is false while the connection is still being established", async () => {
    const deployment = fakeDeployment({ connect: "pending" })
    const { store, warnings } = storeOver(deployment, { connectTimeoutMs: 5 })

    // Before the bootstrap has even reached `connect()`.
    expect(store.connected()).toBe(false)

    await store.ready()

    // Requirement 1.11: startup completed, one warning, no pool, no indexes.
    expect(store.connected()).toBe(false)
    expect(warnings).toEqual([MONGODB_UNREACHABLE_WARNING])
    expect(deployment.attempted).toEqual([])
    const early = await store.collection("members")
    expect(early.kind).toBe("failure")

    // And true once the deployment answers, with the deferred indexes created.
    deployment.settleConnect()
    await store.ready()

    expect(store.connected()).toBe(true)
    expect(names(deployment.created)).toEqual(everyPlanName())
    expect((await store.collection("members")).kind).toBe("collection")
    expect(deployment.constructions).toHaveLength(1)
  })

  it("is false when the connection attempt is refused", async () => {
    const deployment = fakeDeployment({ connect: "rejected" })
    const { store, warnings } = storeOver(deployment)

    await store.ready()

    expect(store.connected()).toBe(false)
    expect(warnings).toEqual([MONGODB_UNREACHABLE_WARNING])
    expect((await store.collection("history")).kind).toBe("failure")
  })

  it("is false when no Mongo_Connection_URI is configured", async () => {
    const deployment = fakeDeployment()
    const { store } = storeOver(deployment, { readUri: () => null })

    await store.ready()

    expect(store.connected()).toBe(false)
    expect(deployment.constructions).toEqual([])
    expect(await store.collection("members")).toEqual({
      kind: "failure",
      failure: { reason: "not-configured", message: expect.any(String) },
    })
  })

  it("is false when the Mongo_Connection_URI does not parse", async () => {
    const deployment = fakeDeployment({ clientConstructionThrows: true })
    const { store } = storeOver(deployment)

    await store.ready()

    expect(store.connected()).toBe(false)
    expect(deployment.connectCalls()).toBe(0)
    expect((await store.collection("members")).kind).toBe("failure")
  })
})

describe("a failed index creation stops nothing (Requirement 1.8)", () => {
  const hiveId = planFor("members", "hiveId")
  const position = planFor("members", "position")

  it("logs one warning naming the collection and the field, and keeps the rest", async () => {
    const deployment = fakeDeployment({
      failIndex: (attempt) => isPlan(attempt, hiveId),
    })
    const { store, warnings } = storeOver(deployment)

    await store.ready()

    expect(warnings).toEqual([indexCreationFailedWarning("members", "hiveId")])
    // Every other index of the bootstrap was still attempted, and retained.
    expect(names(deployment.attempted)).toEqual(everyPlanName())
    expect(names(deployment.created)).toEqual(
      everyPlanName().filter((name) => name !== hiveId.options?.name)
    )
    // And serving continues.
    expect(store.connected()).toBe(true)
    expect((await store.collection("members")).kind).toBe("collection")
  })

  it("logs one warning per failure when both indexes of a collection fail", async () => {
    const deployment = fakeDeployment({
      failIndex: (attempt) =>
        isPlan(attempt, hiveId) || isPlan(attempt, position),
    })
    const { store, warnings } = storeOver(deployment)

    await store.ready()

    expect(warnings).toEqual([
      indexCreationFailedWarning("members", "hiveId"),
      indexCreationFailedWarning("members", "position"),
    ])
    expect(names(deployment.created)).toEqual(
      everyPlanName().filter(
        (name) =>
          name !== hiveId.options?.name && name !== position.options?.name
      )
    )
    expect((await store.collection("members")).kind).toBe("collection")
    expect((await store.collection("history")).kind).toBe("collection")
  })

  it("serves every operation when every index fails", async () => {
    const deployment = fakeDeployment({ failIndex: () => true })
    const { store, warnings } = storeOver(deployment)

    await store.ready()

    expect(warnings).toEqual(
      INDEX_PLANS.map((plan) =>
        indexCreationFailedWarning(plan.collectionName, plan.field)
      )
    )
    expect(deployment.created).toEqual([])
    expect(store.connected()).toBe(true)
    for (const name of [
      "members",
      "history",
      "user_accounts",
      "counters",
    ] as const) {
      expect((await store.collection(name)).kind).toBe("collection")
    }
  })

  it("logs one warning per failed creation, not one per operation", async () => {
    const deployment = fakeDeployment({
      failIndex: (attempt) => isPlan(attempt, hiveId),
    })
    const { store, warnings } = storeOver(deployment)

    await store.ready()
    const afterBootstrap = warnings.length

    for (let index = 0; index < 5; index += 1) {
      await store.collection("members")
      await store.ready()
    }

    expect(afterBootstrap).toBe(1)
    expect(warnings).toHaveLength(1)
  })

  it("names no part of the Mongo_Connection_URI in any warning", async () => {
    // Requirement 1.6: the raised failures all quote the URI; the warnings may not.
    const deployment = fakeDeployment({ failIndex: () => true })
    const { store, warnings } = storeOver(deployment)

    await store.ready()

    expect(warnings).toHaveLength(INDEX_PLANS.length)
    for (const warning of warnings) {
      for (const fragment of URI_FRAGMENTS) {
        expect(warning, `leaked ${fragment}`).not.toContain(fragment)
      }
    }
  })
})
