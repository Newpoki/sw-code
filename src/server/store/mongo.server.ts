/**
 * The Mongo_Store: the one `MongoClient` per process, the database handle, the
 * index creation, the bootstrap promise every operation awaits, and the
 * connection indicator (Requirements 1.3, 1.4, 1.5, 1.7, 1.8, 1.10, 1.11, 8.3).
 *
 * Nothing in this module knows what a Member_Registry entry or a
 * Redemption_History record is. It hands out `Collection` handles, or a
 * {@link StoreFailure} explaining why there is none, and the collection modules
 * built on top of it own the semantics.
 *
 * ## The 5-second bound is a driver option, not a `Promise.race`
 *
 * `timeoutMS` is the whole of Requirement 1.5: the driver's client-side
 * operation timeout spans server selection, connection checkout, and
 * server-side execution for one operation, and it raises a timeout error at the
 * end of it. `retryWrites` and `retryReads` are both switched off because the
 * driver's automatic retry would be exactly the "further attempt" the
 * requirement rules out. No `Promise.race` is layered on top of any driver
 * call — a second timer could only disagree with the first.
 *
 * The one race in this module is around `client.connect()`, which is not one
 * operation but the whole of startup, and which Requirement 1.11 bounds at 10
 * seconds with a deliberately different consequence: startup completes, the
 * driver keeps trying, and operations arriving before a connection exists are
 * answered `unreachable`.
 *
 * ## No driver message ever leaves this module
 *
 * Requirement 1.6 excludes the Mongo_Connection_URI and every part of it —
 * credentials and host included — from every response body, log entry, and
 * value delivered to the Web_Client, and a driver error message names the
 * topology it could not reach. So no error this module catches is ever
 * interpolated into a warning or into a returned failure: every sentence comes
 * from `src/domain/storeMessages.ts` or from a constant declared here.
 *
 * ## Two kinds of failure, both built here
 *
 * `collection()` performs no driver operation, so the only failures it can
 * report are the two the bootstrap already established: `not-configured`
 * (Requirements 1.3, 1.10) and `unreachable` (Requirement 1.11).
 *
 * A *per-operation* driver rejection — a server-selection error, a timeout, a
 * write the database refused — happens inside the collection modules, which
 * catch it and hand it to {@link classifyDriverFailure} or
 * {@link driverStoreFailure} below. Those live here rather than in a module of
 * their own so that every {@link StoreFailure} the store can produce is
 * constructed in one place, and so that the MongoDB error classes are imported
 * by exactly one module.
 */

import {
  MongoClient,
  MongoClientClosedError,
  MongoNetworkError,
  MongoNotConnectedError,
  MongoOperationTimeoutError,
  MongoServerClosedError,
  MongoServerError,
  MongoSystemError,
  MongoTopologyClosedError,
} from "mongodb"
import type {
  Collection,
  CreateIndexesOptions,
  Db,
  Document,
  IndexSpecification,
  MongoClientOptions,
} from "mongodb"

import {
  notConfiguredMessage,
  unreachableMessage,
} from "@/domain/storeMessages"
import type { StoreFailure, StoreFailureReason } from "@/domain/types"
import {
  DEFAULT_MONGO_DATABASE_NAME,
  NO_MONGODB_URI_WARNING,
  UNPARSABLE_MONGODB_URI_WARNING,
  serverConfig,
  serverSecrets,
} from "@/server/config.server"

/** Every collection the Mongo_Store serves. */
export const COLLECTION_NAMES = [
  "members",
  "history",
  "user_accounts",
  "counters",
] as const

/**
 * The name of one collection. A closed set, so a typo cannot silently create a
 * fifth collection: the driver happily creates a collection on first write.
 */
export type CollectionName = (typeof COLLECTION_NAMES)[number]

/**
 * The client options of Requirement 1.5, declared as a constant so the
 * integration test of task 6.5 can assert them against the constructed client
 * rather than restating them.
 */
export const MONGO_CLIENT_OPTIONS: MongoClientOptions = {
  /** Requirement 1.5: one bound per operation, covering the whole of it. */
  timeoutMS: 5_000,
  serverSelectionTimeoutMS: 5_000,
  /** Requirement 1.5: no further attempt at a timed-out operation. */
  retryWrites: false,
  retryReads: false,
  maxPoolSize: 10,
}

/** How long startup waits for a connection before it gives up waiting (Requirement 1.11). */
export const CONNECT_TIMEOUT_MS = 10_000

/** The warning sink. Injected so a test can capture warnings. Defaults to `console`. */
export interface StoreLogger {
  warn: (message: string) => void
}

/**
 * The one warning logged when no connection is established inside
 * {@link CONNECT_TIMEOUT_MS} of startup (Requirement 1.11).
 *
 * It names neither the Mongo_Connection_URI nor any part of it, which is why it
 * is a constant rather than a function of the driver error: there is no
 * parameter through which a host name could leak.
 */
export const MONGODB_UNREACHABLE_WARNING =
  "The Mongo_Database is unreachable: no connection was established within " +
  `${CONNECT_TIMEOUT_MS / 1_000} seconds of startup. Startup completes and the ` +
  "driver keeps trying in the background, so every roster and " +
  "Redemption_History operation received before a connection exists is " +
  "answered with an error stating that the Mongo_Database is unreachable."

/**
 * The one warning logged per failed index creation (Requirement 1.8). It names
 * the collection and the field of that index, and nothing of the driver error.
 */
export function indexCreationFailedWarning(
  collectionName: CollectionName,
  field: string
): string {
  return (
    `Could not create the index on ${field} of the ${collectionName} ` +
    `collection. Every other index of this bootstrap is unaffected, startup ` +
    `completes, and every subsequent operation is served without it. Reads ` +
    `stay correct; they may be slower, and a uniqueness index that is missing ` +
    `no longer refuses a duplicate.`
  )
}

/** One index the bootstrap creates. */
interface IndexPlan {
  readonly collectionName: CollectionName
  /** The field, or fields, named by the Requirement 1.8 warning. */
  readonly field: string
  readonly keys: IndexSpecification
  readonly options?: CreateIndexesOptions
}

/**
 * Every index the bootstrap creates: the two pairs of Requirement 1.7 plus the
 * two `user_accounts` indexes, which task 16.1 relies on this bootstrap to
 * create. The `hiveId` and `clerkUserId` indexes are unique, which is what makes
 * "no duplicate Hive_ID" and "no second User_Account for one identity"
 * invariants of the database rather than of a code path.
 */
export const INDEX_PLANS: readonly IndexPlan[] = [
  {
    collectionName: "members",
    field: "hiveId",
    keys: { hiveId: 1 },
    options: { unique: true, name: "hiveId_unique" },
  },
  {
    collectionName: "members",
    field: "position",
    keys: { position: 1 },
    options: { name: "position_asc" },
  },
  {
    collectionName: "history",
    field: "completedAtMs",
    keys: { completedAtMs: -1 },
    options: { name: "completedAtMs_desc" },
  },
  {
    collectionName: "history",
    field: "seq",
    keys: { seq: 1 },
    options: { name: "seq_asc" },
  },
  {
    collectionName: "user_accounts",
    field: "clerkUserId",
    keys: { clerkUserId: 1 },
    options: { unique: true, name: "clerkUserId_unique" },
  },
  {
    collectionName: "user_accounts",
    field: "lastSignInAt and emailLower",
    keys: { lastSignInAt: -1, emailLower: 1 },
    options: { name: "lastSignInAt_desc_emailLower_asc" },
  },
]

/**
 * A collection handle, or the reason there is none. `T` carries the same
 * `extends Document` constraint the driver's `Collection` does.
 */
export type CollectionOrFailure<T extends Document> =
  | { readonly kind: "collection"; readonly collection: Collection<T> }
  | { readonly kind: "failure"; readonly failure: StoreFailure }

/** The Mongo_Store seam. One per process; see {@link getMongoStore}. */
export interface MongoStore {
  /** Resolves when the pool is open, indexes attempted, and any Data_Import finished. */
  readonly ready: () => Promise<void>
  /** The collection handle, or a failure describing why there is none. */
  readonly collection: <T extends Document>(
    name: CollectionName
  ) => Promise<CollectionOrFailure<T>>
  /** Requirement 8.3: true only while a pool is open. */
  readonly connected: () => boolean
  /** Test seam: closes the pool. */
  readonly close: () => Promise<void>
}

/**
 * What the Data_Import slot receives. Task 13.1 fills the slot with
 * `src/server/store/dataImport.server.ts`; this module knows only that
 * something may run at that point in the bootstrap, before the first read or
 * write is answered (Requirement 4.1).
 */
export interface DataImportContext {
  readonly db: Db
  readonly logger: StoreLogger
}

export interface MongoStoreOptions {
  /**
   * Reads the trimmed Mongo_Connection_URI, or null when none is configured.
   * Defaults to {@link serverSecrets.readMongoUri}. **The value is passed
   * straight to the `MongoClient` constructor and is never logged, returned, or
   * interpolated into a message** (Requirement 1.6).
   */
  readonly readUri?: () => string | null
  /** The database name. Defaults to the resolved {@link serverConfig.mongoDatabaseName}. */
  readonly databaseName?: string
  /** Replaces `console` as the warning sink. */
  readonly logger?: StoreLogger
  /** Replaces the `MongoClient` construction. A throw is the unparsable-URI case. */
  readonly createClient?: (
    uri: string,
    options: MongoClientOptions
  ) => MongoClient
  /** How long startup waits for a connection. Defaults to {@link CONNECT_TIMEOUT_MS}. */
  readonly connectTimeoutMs?: number
  /**
   * Whether this store logs the Requirement 1.3 and 1.10 configuration
   * warnings itself. Defaults to true.
   *
   * The process-wide store passes false: `config.server.ts` reads
   * `MONGODB_URI` once at startup and has already logged exactly one warning
   * for an absent or unparsable value, and both requirements ask for exactly
   * one.
   */
  readonly logConfigurationWarnings?: boolean
  /** The Data_Import slot. Task 13.1 supplies it. */
  readonly runDataImport?: (context: DataImportContext) => Promise<void>
}

/** What the bootstrap settled on. */
type BootstrapOutcome =
  /** No usable `MONGODB_URI`: absent, blank, or unparsable (Requirements 1.3, 1.10). */
  | { readonly kind: "not-configured" }
  /** A client exists. Whether a pool is open is answered by `connected()`. */
  | { readonly kind: "client"; readonly client: MongoClient; readonly db: Db }

function notConfiguredFailure(): StoreFailure {
  return { reason: "not-configured", message: notConfiguredMessage() }
}

function unreachableFailure(): StoreFailure {
  return { reason: "unreachable", message: unreachableMessage() }
}

/**
 * The reason a caught driver rejection can carry.
 *
 * `not-configured` is excluded on purpose: it is settled by the bootstrap
 * before any operation is attempted, so no operation can discover it
 * (Requirements 1.3, 1.10).
 */
export type DriverFailureReason = Exclude<StoreFailureReason, "not-configured">

/**
 * Server error codes that describe a deployment that did not answer inside its
 * bound or could not be reached, rather than one that refused the operation.
 *
 * Only the numeric codes are consulted. The `codeName` and the message that
 * come with them are server text, and Requirement 1.6 keeps server and driver
 * text out of every value this store returns, so neither is read.
 */
const UNREACHABLE_SERVER_ERROR_CODES: ReadonlySet<number> = new Set([
  6, // HostUnreachable
  7, // HostNotFound
  50, // MaxTimeMSExpired
  89, // NetworkTimeout
  262, // ExceededTimeLimit
])

/**
 * The driver error class names that mean "unreachable", for the case where
 * `instanceof` cannot answer: a second copy of the `mongodb` package in the
 * module graph produces error classes that are not the ones imported here. The
 * name is the class name, published by each class's own `name` getter, and
 * carries nothing about the deployment.
 */
const UNREACHABLE_ERROR_NAMES: ReadonlySet<string> = new Set([
  "MongoOperationTimeoutError",
  "MongoNetworkError",
  "MongoNetworkTimeoutError",
  "MongoServerSelectionError",
  "MongoSystemError",
  "MongoTopologyClosedError",
  "MongoNotConnectedError",
  "MongoClientClosedError",
  "MongoServerClosedError",
])

/** Whether the error carries a numeric server code that means "unreachable". */
function namesAnUnreachableCode(error: object): boolean {
  const code: unknown = (error as { code?: unknown }).code
  return typeof code === "number" && UNREACHABLE_SERVER_ERROR_CODES.has(code)
}

/**
 * Classifies a caught driver rejection by its **type**, never by its text
 * (Requirements 1.5, 1.6).
 *
 * - A server-selection failure, a network error, an operation timeout, and a
 *   closed or not-yet-connected client are all `unreachable`: the deployment
 *   gave no answer, which is what Requirement 1.5 asks the caller to report.
 * - A server error is `rejected` — a duplicate key, a write concern the
 *   deployment could not satisfy, a failed validation: the database answered,
 *   and its answer was no. Unless it answered with one of
 *   {@link UNREACHABLE_SERVER_ERROR_CODES}, which is a timeout wearing a server
 *   error's clothes.
 * - Anything else is `rejected`, which is the conservative residue rather than
 *   the interesting one: `unreachable` makes the specific claim that the
 *   deployment could not be reached inside its bound, and an error this function
 *   does not recognize is no evidence for that claim. `rejected` says only that
 *   the operation was not served, which is true of every failure here.
 *
 * The error's `message`, its `cause`, and the topology description a
 * server-selection error carries are never read, so no host, port, credential,
 * or fragment of the Mongo_Connection_URI can travel from the error into the
 * return value.
 */
export function classifyDriverFailure(error: unknown): DriverFailureReason {
  if (typeof error !== "object" || error === null) {
    return "rejected"
  }

  if (
    error instanceof MongoOperationTimeoutError ||
    error instanceof MongoNetworkError ||
    /* MongoServerSelectionError extends MongoSystemError. */
    error instanceof MongoSystemError ||
    error instanceof MongoTopologyClosedError ||
    error instanceof MongoNotConnectedError ||
    error instanceof MongoClientClosedError ||
    error instanceof MongoServerClosedError
  ) {
    return "unreachable"
  }

  if (error instanceof MongoServerError) {
    /* MongoWriteConcernError and both bulk-write errors arrive here too. */
    return namesAnUnreachableCode(error) ? "unreachable" : "rejected"
  }

  if (UNREACHABLE_ERROR_NAMES.has(errorName(error))) {
    return "unreachable"
  }

  return namesAnUnreachableCode(error) ? "unreachable" : "rejected"
}

/** The class name the error publishes, or the empty string when it has none. */
function errorName(error: object): string {
  const name: unknown = (error as { name?: unknown }).name
  return typeof name === "string" ? name : ""
}

/**
 * The {@link StoreFailure} for a caught driver rejection: the reason
 * {@link classifyDriverFailure} settled on, and the fixed sentence the failed
 * operation speaks with.
 *
 * The sentence belongs to the operation and not to the reason, which is what
 * Requirements 2.8, 2.14, 3.7, and 3.10 ask for: a roster write that was not
 * saved names the attempted change whether the deployment timed out or refused
 * the write, and the `reason` is what tells the two apart. Callers pass their own
 * sentence from `src/domain/storeMessages.ts` — `rosterWriteFailedMessage`,
 * `rosterReadFailedMessage`, `historyReadFailedMessage` — and an operation with
 * no sentence of its own, such as a counter increment, gets
 * {@link unreachableMessage}, the one sentence that speaks about the database
 * rather than about an operation.
 *
 * `message` is a plain string on purpose: it is only ever a call of a
 * `storeMessages` function, which is what Requirement 1.6 requires and what a
 * driver message can never be.
 */
export function driverStoreFailure(
  error: unknown,
  message: string = unreachableMessage()
): StoreFailure {
  return { reason: classifyDriverFailure(error), message }
}

/**
 * The Mongo_Store implementation.
 *
 * One instance holds at most one `MongoClient`, therefore at most one
 * connection pool, and reuses it for its whole lifetime (Requirement 1.4). The
 * bootstrap runs once, on construction, as a single promise that never rejects
 * and that every `collection()` call awaits (Requirement 4.1).
 */
class MongoStoreImpl implements MongoStore {
  private readonly readUri: () => string | null
  private readonly databaseName: string
  private readonly logger: StoreLogger
  private readonly createClient: (
    uri: string,
    options: MongoClientOptions
  ) => MongoClient
  private readonly connectTimeoutMs: number
  private readonly logConfigurationWarnings: boolean
  private readonly runDataImport:
    ((context: DataImportContext) => Promise<void>) | null

  /** The single bootstrap promise. Never rejects: a failure degrades the store. */
  private readonly bootstrap: Promise<BootstrapOutcome>

  /**
   * Index creation and the Data_Import for a connection that arrived after
   * startup stopped waiting for it (Requirement 1.11). Null when the bootstrap
   * already did that work, or when there is no client to do it for.
   */
  private lateSetup: Promise<void> | null = null

  /** Requirement 8.3: true only while a pool is open. */
  private poolOpen = false

  /** True once {@link close} has run, so a later `collection()` cannot hand out a dead handle. */
  private closed = false

  constructor(options: MongoStoreOptions = {}) {
    this.readUri = options.readUri ?? (() => serverSecrets.readMongoUri())
    this.databaseName =
      options.databaseName ??
      serverConfig.mongoDatabaseName ??
      DEFAULT_MONGO_DATABASE_NAME
    this.logger = options.logger ?? console
    this.createClient =
      options.createClient ??
      ((uri, clientOptions) => new MongoClient(uri, clientOptions))
    this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS
    this.logConfigurationWarnings = options.logConfigurationWarnings ?? true
    this.runDataImport = options.runDataImport ?? null
    this.bootstrap = this.runBootstrap()
  }

  async ready(): Promise<void> {
    await this.bootstrap
    /*
     * A connection that arrived late brings its own index creation with it, and
     * `ready()` means "indexes attempted", so waiting for it here is the honest
     * reading. `lateSetup` resolves only once the connection exists, so this
     * awaits nothing while the deployment is still unreachable.
     */
    if (this.poolOpen && this.lateSetup !== null) {
      await this.lateSetup
    }
  }

  async collection<T extends Document>(
    name: CollectionName
  ): Promise<CollectionOrFailure<T>> {
    const outcome = await this.bootstrap

    if (outcome.kind === "not-configured") {
      return { kind: "failure", failure: notConfiguredFailure() }
    }
    if (this.closed || !this.poolOpen) {
      /*
       * Requirement 1.11: an operation arriving before the connection exists is
       * answered `unreachable` rather than made to wait for it. A closed pool
       * answers the same way — the sentence says the database is unreachable and
       * nothing was changed, which is exactly true of both.
       */
      return { kind: "failure", failure: unreachableFailure() }
    }
    if (this.lateSetup !== null) {
      // Requirement 1.7: the indexes are attempted before the first operation.
      await this.lateSetup
    }

    return { kind: "collection", collection: outcome.db.collection<T>(name) }
  }

  connected(): boolean {
    return this.poolOpen && !this.closed
  }

  async close(): Promise<void> {
    this.closed = true
    this.poolOpen = false
    const outcome = await this.bootstrap
    if (outcome.kind === "client") {
      await outcome.client.close()
    }
  }

  /**
   * The bootstrap, in the order Requirement 4.1 and Requirement 1.7 impose:
   * read the URI, construct the client, connect within the 10-second bound,
   * create the indexes, run the Data_Import. Every failure along the way
   * degrades the store and completes startup; none of them rejects.
   */
  private async runBootstrap(): Promise<BootstrapOutcome> {
    // 1. Read the URI (Requirement 1.3).
    const uri = this.readUri()
    if (uri === null) {
      if (this.logConfigurationWarnings) {
        this.logger.warn(NO_MONGODB_URI_WARNING)
      }
      return { kind: "not-configured" }
    }

    // 2. Construct the client. A throw is the unparsable case (Requirement 1.10).
    let client: MongoClient
    try {
      client = this.createClient(uri, MONGO_CLIENT_OPTIONS)
    } catch {
      /*
       * The caught error is dropped on the floor deliberately: the driver's
       * parse error quotes the value it rejected, and Requirement 1.10 forbids
       * any part of that value reaching a log entry. The constant names the
       * variable and says why.
       */
      if (this.logConfigurationWarnings) {
        this.logger.warn(UNPARSABLE_MONGODB_URI_WARNING)
      }
      return { kind: "not-configured" }
    }

    const db = client.db(this.databaseName)
    const outcome: BootstrapOutcome = { kind: "client", client, db }

    // 3. Connect, bounded at 10 seconds, without aborting on a loss.
    const connected = await this.connectWithinBound(client)
    if (!connected) {
      this.logger.warn(MONGODB_UNREACHABLE_WARNING)
      return outcome
    }

    // 4. Create the indexes (Requirements 1.7, 1.8). 5. Run the Data_Import.
    await this.createIndexes(db)
    await this.runDataImportSlot(db)
    return outcome
  }

  /**
   * Starts `client.connect()` and waits at most {@link connectTimeoutMs} for it
   * (Requirement 1.11). Returns whether a pool is open by the end of that wait.
   *
   * Losing the race does **not** abort the attempt. The client is retained, the
   * driver's topology monitoring keeps trying, and a connection that arrives
   * later marks the pool open and brings the skipped index creation with it —
   * which is what lets an operation arriving after it be served while the
   * operations that arrived sooner were answered `unreachable`.
   */
  private connectWithinBound(client: MongoClient): Promise<boolean> {
    const connecting = client.connect().then(
      () => {
        this.poolOpen = !this.closed
        return true
      },
      () => {
        /*
         * A rejected `connect()` is not the end of the client: every later
         * operation selects a server again, so the deployment coming back is
         * still served. The error itself is dropped — it names the host.
         */
        return false
      }
    )

    let timer: ReturnType<typeof setTimeout> | undefined
    const expiring = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), this.connectTimeoutMs)
    })

    return Promise.race([connecting, expiring]).then((won) => {
      clearTimeout(timer)
      if (!won) {
        this.scheduleLateSetup(client, connecting)
      }
      return won
    })
  }

  /**
   * Arranges the index creation and the Data_Import that step 3 skipped to run
   * if and when the connection is established, so that Requirement 1.7's
   * "before the first operation" still holds for the first operation that is
   * actually served.
   */
  private scheduleLateSetup(
    client: MongoClient,
    connecting: Promise<boolean>
  ): void {
    this.lateSetup = connecting.then(async (established) => {
      if (!established || this.closed) {
        return
      }
      const db = client.db(this.databaseName)
      await this.createIndexes(db)
      await this.runDataImportSlot(db)
    })
    /*
     * Nothing awaits `lateSetup` until an operation arrives, and it never
     * rejects — `createIndexes` and the Data_Import slot both swallow their own
     * failures — so there is no unhandled rejection to guard against.
     */
  }

  /**
   * Creates every index of {@link INDEX_PLANS} (Requirement 1.7).
   *
   * Each creation is awaited independently: a rejection logs exactly one
   * warning naming the collection and the field, and stops neither the
   * remaining indexes nor the bootstrap (Requirement 1.8). `createIndex` is
   * idempotent, so a restart against an existing database is a no-op per index
   * rather than an error.
   */
  private async createIndexes(db: Db): Promise<void> {
    for (const plan of INDEX_PLANS) {
      try {
        await db.collection(plan.collectionName).createIndex(plan.keys, {
          ...plan.options,
        })
      } catch {
        this.logger.warn(
          indexCreationFailedWarning(plan.collectionName, plan.field)
        )
      }
    }
  }

  /**
   * The Data_Import slot (Requirement 4.1): the last step of the bootstrap, so
   * that every insertion it makes is complete before the first read or write is
   * answered. Task 13.1 fills it with `dataImport.server.ts`, which owns its own
   * 30-second bound, its rollback, and every warning Requirement 4 asks for.
   *
   * A throw from the slot would be a defect in the import module rather than an
   * expected outcome, and it must not stop startup (Requirements 4.5, 4.9), so
   * it is swallowed here after the module has had its chance to log.
   */
  private async runDataImportSlot(db: Db): Promise<void> {
    if (this.runDataImport === null) {
      return
    }
    try {
      await this.runDataImport({ db, logger: this.logger })
    } catch {
      /* The import module logs its own warning; startup completes regardless. */
    }
  }
}

/** Creates a store. Used by the wiring below and by tests over a throwaway database. */
export function createMongoStore(options: MongoStoreOptions = {}): MongoStore {
  return new MongoStoreImpl(options)
}

let defaultStore: MongoStore | null = null

/**
 * The process-wide Mongo_Store, created on first use and reused for the
 * lifetime of the process, so there is at most one connection pool and every
 * operation is served through it (Requirement 1.4).
 *
 * It does not log the Requirement 1.3 and 1.10 configuration warnings:
 * `config.server.ts` read `MONGODB_URI` once at startup and has already logged
 * exactly one, which is what both requirements ask for.
 *
 * The Data_Import slot is filled with `runDataImport` from
 * `dataImport.server.ts`, so the one-time transfer from the Legacy_Json_Store
 * runs inside this store's bootstrap, before it answers its first read or write
 * (Requirement 4.1). The import is imported lazily, inside the slot, so this
 * module keeps knowing nothing about what an entry or a record is and so the
 * `dataImport` module can go on importing `mongo.server.ts` for its context
 * types without a cycle at module-evaluation time.
 */
export function getMongoStore(): MongoStore {
  defaultStore ??= createMongoStore({
    logConfigurationWarnings: false,
    runDataImport: async (context) => {
      const { runDataImport } = await import("@/server/store/dataImport.server")
      await runDataImport(context)
    },
  })
  return defaultStore
}

/** Installs the process-wide store. Overrides whatever was created before. */
export function setMongoStore(store: MongoStore): void {
  defaultStore = store
}

/**
 * Drops the process-wide store so the next {@link getMongoStore} rebuilds it.
 *
 * It does **not** close the pool of the store it drops, because it mirrors
 * `resetJsonStore` and is synchronous. A test that installed a store over a
 * throwaway database closes it through {@link MongoStore.close} first.
 */
export function resetMongoStore(): void {
  defaultStore = null
}
