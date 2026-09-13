/**
 * The MongoDB test fixture: a throwaway database per sample, and a cheap,
 * once-per-file answer to whether there is a MongoDB to run against at all.
 *
 * It is the database-backed counterpart of the `withTempDataFile` helper inside
 * `tests/property/persistenceRoundTrip.property.test.ts`, and it applies the
 * same discipline: every sample gets its own throwaway resource named from the
 * sample index, and that resource is dropped in a `finally`, so a sample that
 * fails mid-way still cleans up after itself. Nothing outside a database whose
 * name starts with {@link FIXTURE_DATABASE_PREFIX} is ever created, written, or
 * dropped.
 *
 * ## Which environment variable supplies the database
 *
 * {@link MONGO_TEST_URI_VARIABLE} (`MONGODB_TEST_URI`) is read first, and
 * {@link MONGO_URI_FALLBACK_VARIABLE} (`MONGODB_URI`) second. The separate test
 * variable exists so a developer can point the suite at a local throwaway
 * deployment without touching the one the application itself uses, and so that
 * pointing the suite at a production connection string has to be a deliberate
 * act. Both values are trimmed; a whitespace-only value counts as absent.
 *
 * Neither value is ever logged, returned in a skip reason, or interpolated into
 * a message — the same rule Requirement 1.6 imposes on the server, applied here
 * because a test log is just as public as a server log.
 *
 * ## Skipping, rather than passing vacuously
 *
 * {@link mongoAvailability} probes once per test file — one connect and one
 * `ping`, cached — and returns a stated reason either way. A suite that needs a
 * database uses that answer with `describe.skipIf` / `it.skipIf` and puts the
 * reason where the report will show it:
 *
 * ```ts
 * const mongo = await mongoAvailability()
 *
 * describe.skipIf(!mongo.available)("Property 5: ...", () => {
 *   afterAll(closeMongoFixture)
 *
 *   it("...", async () => {
 *     await fc.assert(
 *       fc.asyncProperty(operationsArb, async (operations) => {
 *         await withThrowawayDatabase(async (sample) => {
 *           const store = await sample.createStore()
 *           // ... exercise the store ...
 *           const restarted = await sample.createStore()
 *           // ... read the same database through the second store ...
 *         })
 *       }),
 *       { numRuns: 100 }
 *     )
 *   })
 * })
 *
 * it.runIf(!mongo.available)(`skipped: ${mongoSkipReason(mongo)}`, () => {
 *   expect(mongo.available).toBe(false)
 * })
 * ```
 *
 * The second block is the point of {@link mongoSkipReason}: a skipped suite says
 * nothing in the summary, so the reason is stated as a test name that does run.
 * {@link reportMongoSkip} writes the same sentence to the console for a suite
 * that would rather not add a test.
 *
 * Calling {@link withThrowawayDatabase} when no MongoDB is configured throws
 * {@link MongoFixtureUnavailableError} rather than quietly doing nothing: a
 * property that silently exercises no database is worse than one that fails.
 *
 * ## Two stores over one database
 *
 * {@link MongoSample.createStore} can be called more than once for the same
 * sample, and each call builds a fresh {@link MongoStore} — its own client, its
 * own pool, its own bootstrap — over the same throwaway database. That is the
 * restart of Property 5 and the rebuild interleaving of Property 8: the second
 * store reads only what the first one durably wrote. Every store a sample built
 * is closed in the `finally`, before the database is dropped.
 *
 * This module lives under `tests/support/`, which the Vitest config does not
 * collect: only test files under `tests/unit`, `tests/property`, and
 * `tests/integration` are collected.
 */

import { randomBytes } from "node:crypto"

import { MongoClient } from "mongodb"
import type { Db, MongoClientOptions } from "mongodb"

import { createMongoStore } from "@/server/store/mongo.server"
import type {
  MongoStore,
  MongoStoreOptions,
  StoreLogger,
} from "@/server/store/mongo.server"

/** Read first: the connection string dedicated to the test suite. */
export const MONGO_TEST_URI_VARIABLE = "MONGODB_TEST_URI"

/** Read second: the application's own connection string. */
export const MONGO_URI_FALLBACK_VARIABLE = "MONGODB_URI"

/**
 * Prefix of every database this fixture creates, and the only prefix it will
 * drop. A database the fixture did not name is never touched.
 */
export const FIXTURE_DATABASE_PREFIX = "sw-code-test"

/**
 * How long the availability probe waits. Deliberately far below the
 * application's 10-second startup bound: an absent deployment should cost the
 * suite about two seconds, once, not ten.
 */
export const PROBE_TIMEOUT_MS = 2_000

/** Client options for the fixture's own client: fail fast, retry nothing. */
const FIXTURE_CLIENT_OPTIONS: MongoClientOptions = {
  timeoutMS: PROBE_TIMEOUT_MS,
  serverSelectionTimeoutMS: PROBE_TIMEOUT_MS,
  connectTimeoutMS: PROBE_TIMEOUT_MS,
  retryWrites: false,
  retryReads: false,
  maxPoolSize: 4,
}

/** An environment record. Structurally compatible with `process.env`. */
export type EnvironmentRecord = Record<string, string | undefined>

/**
 * The trimmed test connection string, or null when neither variable holds one.
 *
 * Vitest loads `.env` into `process.env`, so a value written there is found the
 * same way a value exported in the shell is.
 */
export function readMongoTestUri(
  env: EnvironmentRecord = process.env
): string | null {
  for (const name of [MONGO_TEST_URI_VARIABLE, MONGO_URI_FALLBACK_VARIABLE]) {
    const trimmed = (env[name] ?? "").trim()
    if (trimmed.length > 0) {
      return trimmed
    }
  }
  return null
}

/** Whether there is a database to run against, and why. */
export interface MongoAvailability {
  readonly available: boolean
  /**
   * A full sentence, always non-empty, naming the variables it consulted and
   * never any part of their values.
   */
  readonly reason: string
}

/** Thrown when the fixture is used without a MongoDB to use it against. */
export class MongoFixtureUnavailableError extends Error {
  constructor(reason: string) {
    super(
      `The MongoDB test fixture has no database to run against. ${reason} ` +
        `Guard the suite with describe.skipIf(!(await mongoAvailability()).available).`
    )
    this.name = "MongoFixtureUnavailableError"
  }
}

const NO_URI_REASON =
  `Neither ${MONGO_TEST_URI_VARIABLE} nor ${MONGO_URI_FALLBACK_VARIABLE} ` +
  `holds a connection string, so every test that needs a real MongoDB is ` +
  `skipped. Set ${MONGO_TEST_URI_VARIABLE} to a throwaway deployment — for ` +
  `example mongodb://127.0.0.1:27017 — to run them.`

function unreachableReason(errorName: string): string {
  return (
    `The deployment named by ${MONGO_TEST_URI_VARIABLE} or ` +
    `${MONGO_URI_FALLBACK_VARIABLE} did not answer a ping within ` +
    `${PROBE_TIMEOUT_MS / 1_000} seconds (${errorName}), so every test that ` +
    `needs a real MongoDB is skipped. The connection string is not shown here ` +
    `because it carries credentials and a host.`
  )
}

function availableReason(): string {
  return (
    `The deployment named by ${MONGO_TEST_URI_VARIABLE} or ` +
    `${MONGO_URI_FALLBACK_VARIABLE} answered a ping, so the tests that need a ` +
    `real MongoDB run against throwaway ${FIXTURE_DATABASE_PREFIX}-* databases.`
  )
}

/* -------------------------------------------------------------------------- */
/* The one probe, and the one client the fixture keeps                        */
/* -------------------------------------------------------------------------- */

/** The cached probe. One connect and one ping per test file, not per sample. */
let probe: Promise<MongoAvailability> | null = null

/** Connected only while the probe succeeded. Used for drops and assertions. */
let fixtureClient: MongoClient | null = null

/** The connection string the probe accepted. Never logged. */
let fixtureUri: string | null = null

/**
 * Whether a MongoDB is available, with a stated reason either way.
 *
 * Cached: properties run 100+ samples and every sample calls into the fixture,
 * so the probe must not be per-sample. Call it once at the top of a test file
 * (top-level `await` is supported in test modules) and hand the answer to
 * `describe.skipIf`.
 */
export function mongoAvailability(): Promise<MongoAvailability> {
  probe ??= runProbe()
  return probe
}

async function runProbe(): Promise<MongoAvailability> {
  const uri = readMongoTestUri()
  if (uri === null) {
    return { available: false, reason: NO_URI_REASON }
  }

  const client = new MongoClient(uri, FIXTURE_CLIENT_OPTIONS)
  try {
    await client.connect()
    await client.db("admin").command({ ping: 1 })
  } catch (error) {
    /*
     * Only the error's *name* is carried into the reason. A driver error's
     * message quotes the topology it could not reach, credentials included, and
     * a skip reason ends up in CI output.
     */
    const errorName = error instanceof Error ? error.name : "unknown error"
    await client.close().catch(() => undefined)
    return { available: false, reason: unreachableReason(errorName) }
  }

  fixtureClient = client
  fixtureUri = uri
  return { available: true, reason: availableReason() }
}

/** The skip sentence when unavailable, null when there is nothing to skip. */
export function mongoSkipReason(
  availability: MongoAvailability
): string | null {
  return availability.available ? null : availability.reason
}

const reported = new Set<string>()

/**
 * Writes the skip reason once per label, for a suite that reports its skip
 * through the console rather than through a test name.
 */
export function reportMongoSkip(
  label: string,
  availability: MongoAvailability
): void {
  if (availability.available || reported.has(label)) {
    return
  }
  reported.add(label)
  console.warn(`[mongoFixture] ${label} skipped. ${availability.reason}`)
}

/* -------------------------------------------------------------------------- */
/* Throwaway databases                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Per-process token in every database name, so two test files running
 * concurrently cannot land on the same throwaway database for the same sample
 * index.
 */
const RUN_TOKEN = randomBytes(3).toString("hex")

/** 0-based; the next sample gets the next index. */
let nextSampleIndex = 0

/** Names still expected to exist, as a safety net if a sample dies hard. */
const liveDatabases = new Set<string>()

const LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]{0,22}[a-z0-9])?$/

/**
 * The database name for one sample: the prefix, the caller's label, the
 * per-process token, and the sample index. Deterministic given those four, and
 * always well within MongoDB's 63-character limit with none of the characters
 * MongoDB forbids in a database name.
 */
export function throwawayDatabaseName(
  sampleIndex: number,
  label = "sample"
): string {
  if (!LABEL_PATTERN.test(label)) {
    throw new Error(
      `mongoFixture: the label ${JSON.stringify(label)} must be 1 to 24 ` +
        `lower-case letters, digits, and inner hyphens, so the database name ` +
        `stays a legal one.`
    )
  }
  if (!Number.isInteger(sampleIndex) || sampleIndex < 0) {
    throw new Error(
      `mongoFixture: the sample index must be a non-negative integer, not ` +
        `${String(sampleIndex)}.`
    )
  }
  const index = String(sampleIndex).padStart(4, "0")
  return `${FIXTURE_DATABASE_PREFIX}-${label}-${RUN_TOKEN}-${index}`
}

/** One sample's throwaway database and the stores built over it. */
export interface MongoSample {
  /** The index this sample's database is named from. */
  readonly sampleIndex: number
  /** The throwaway database, dropped when the sample ends. */
  readonly databaseName: string
  /** Warnings every store of this sample logged, in order. */
  readonly warnings: ReadonlyArray<string>
  /** The sink those warnings arrive at. Pass it on to anything else under test. */
  readonly logger: StoreLogger
  /** Every store this sample built, in build order. All closed in the `finally`. */
  readonly stores: ReadonlyArray<MongoStore>
  /**
   * A fresh {@link MongoStore} over this sample's database, bootstrapped and
   * ready. Call it twice to read what the first store wrote through a second
   * client and a second bootstrap — the restart of Property 5 and the rebuild
   * interleaving of Property 8.
   */
  readonly createStore: (overrides?: MongoStoreOptions) => Promise<MongoStore>
  /**
   * The same, without awaiting `ready()`, for a test that wants to observe the
   * bootstrap itself. Registered for cleanup all the same.
   */
  readonly buildStore: (overrides?: MongoStoreOptions) => MongoStore
  /**
   * A driver handle on the same database, through the fixture's own client, for
   * seeding a precondition or asserting what is stored without going through a
   * store.
   */
  readonly db: () => Db
}

export interface ThrowawayDatabaseOptions {
  /** Appears in the database name. Defaults to `sample`. */
  readonly label?: string
  /** Overrides the fixture's own counter, for a deterministic name. */
  readonly sampleIndex?: number
  /** Applied to every store this sample builds, before per-call overrides. */
  readonly storeOptions?: MongoStoreOptions
}

/**
 * Runs `body` against a throwaway database of its own, then closes every store
 * the body built and drops that database — in a `finally`, so a failing sample
 * leaves nothing behind.
 *
 * Overrides given through `storeOptions` or `createStore` win over the fixture's
 * defaults, `readUri` and `databaseName` included. A test that redirects a store
 * at some other database therefore owns that database's cleanup: the drop here
 * only ever names this sample's own.
 */
export async function withThrowawayDatabase<T>(
  body: (sample: MongoSample) => Promise<T>,
  options: ThrowawayDatabaseOptions = {}
): Promise<T> {
  const availability = await mongoAvailability()
  if (!availability.available) {
    throw new MongoFixtureUnavailableError(availability.reason)
  }
  const uri = fixtureUri
  const client = fixtureClient
  if (uri === null || client === null) {
    /* Only reachable if `closeMongoFixture` ran between the two awaits above. */
    throw new MongoFixtureUnavailableError(
      "The fixture was closed while this sample was starting."
    )
  }

  const sampleIndex = options.sampleIndex ?? nextSampleIndex++
  const databaseName = throwawayDatabaseName(sampleIndex, options.label)

  const warnings: Array<string> = []
  const logger: StoreLogger = {
    warn: (message) => {
      warnings.push(message)
    },
  }
  const stores: Array<MongoStore> = []

  const buildStore = (overrides: MongoStoreOptions = {}): MongoStore => {
    const store = createMongoStore({
      readUri: () => uri,
      databaseName,
      logger,
      /* The fixture's own warnings are the ones under test, not startup's. */
      logConfigurationWarnings: false,
      ...options.storeOptions,
      ...overrides,
    })
    stores.push(store)
    return store
  }

  const sample: MongoSample = {
    sampleIndex,
    databaseName,
    warnings,
    logger,
    stores,
    buildStore,
    createStore: async (overrides) => {
      const store = buildStore(overrides)
      await store.ready()
      return store
    },
    db: () => client.db(databaseName),
  }

  liveDatabases.add(databaseName)
  try {
    return await body(sample)
  } finally {
    /*
     * Closing first, dropping second: a pool still open against a database
     * being dropped is how a suite ends up with a stray connection error after
     * the assertion that mattered has already passed.
     */
    await closeStores(stores)
    await dropThrowawayDatabase(client, databaseName)
    liveDatabases.delete(databaseName)
  }
}

async function closeStores(stores: ReadonlyArray<MongoStore>): Promise<void> {
  /* A close failure must not mask the sample's own failure. */
  await Promise.all(stores.map((store) => store.close().catch(() => undefined)))
}

async function dropThrowawayDatabase(
  client: MongoClient,
  databaseName: string
): Promise<void> {
  if (!databaseName.startsWith(`${FIXTURE_DATABASE_PREFIX}-`)) {
    /* Unreachable through `throwawayDatabaseName`; a guard against a future edit. */
    throw new Error(
      `mongoFixture refuses to drop ${databaseName}: it drops only databases ` +
        `named ${FIXTURE_DATABASE_PREFIX}-*.`
    )
  }
  await client.db(databaseName).dropDatabase()
}

/**
 * Drops anything a sample left behind and closes the fixture's client. Call it
 * from `afterAll` in every file that uses the fixture; it is safe to call when
 * the fixture was never used, and safe to call twice.
 *
 * The next {@link mongoAvailability} probes again, so a file that closes the
 * fixture mid-way still works.
 */
export async function closeMongoFixture(): Promise<void> {
  const client = fixtureClient
  if (client !== null) {
    for (const databaseName of [...liveDatabases]) {
      await dropThrowawayDatabase(client, databaseName).catch(() => undefined)
    }
    await client.close().catch(() => undefined)
  }
  liveDatabases.clear()
  fixtureClient = null
  fixtureUri = null
  probe = null
}
