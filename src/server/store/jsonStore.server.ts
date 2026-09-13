/**
 * JsonStore: retired as a live store by the mongodb-google-auth-admin feature.
 *
 * This module is no longer wired to any request path. The Mongo_Store
 * (`mongo.server.ts`) is the only store the Redemption_Server serves reads and
 * writes from; `memberRegistry.server.ts` and `history.server.ts` were rewritten
 * over `getMongoStore()` and no longer touch this file. Nothing under `src/`
 * imports it any more.
 *
 * ## What survives, and why
 *
 * {@link parseStoreDocument} (with {@link StoreDocument}, {@link STORE_VERSION},
 * and {@link ParseStoreDocumentResult}) is the definition of "the expected
 * shape" that Requirement 4.1 refers to, and it is the reader the Data_Import
 * (task 13) reuses to read the Legacy_Json_Store. It stays exported and tested
 * for exactly that reason.
 *
 * ## What is now dead code
 *
 * The whole write side — `JsonStore`, its `mutate` / `enqueueFlush` /
 * `atomicFlush` flush path, and the `getJsonStore` / `setJsonStore` /
 * `resetJsonStore` / `createJsonStore` singleton machinery — is retained only so
 * this module still compiles and so `parseStoreDocument`'s neighbours (the
 * corrupt-file reader that `storeEdgeCases.test.ts` exercises directly) keep
 * working. It is wired to nothing. It is not deleted because the
 * shared-coupon-redemption tests still construct `JsonStore` and drive its flush
 * path directly; deleting it would break them for no benefit.
 *
 * The doc comments below describe the historical shared-coupon-redemption
 * behaviour of this code. None of it runs on a request path any more.
 *
 * ### Historical: a rejected flush never rolled back
 *
 * Under shared-coupon-redemption Requirement 1.8 a failed store write left the
 * change visible in memory and surfaced a warning: `mutate` applied the mutator
 * first and reported `persisted: false` second, never reverting the in-memory
 * document. The mongodb-google-auth-admin Requirement 2.8 supersedes this — a
 * failed write is now a rejection, not a success with a warning — but the code
 * is left intact for the tests that still exercise it.
 *
 * ### Historical: atomic flush
 *
 * A flush wrote `<DATA_FILE>.tmp` with mode `0600`, `fsync`ed it, and renamed it
 * over `DATA_FILE`, so a reader saw either the previous document or the new one,
 * never a half-written file. This path is now dead code.
 *
 * ### Corrupt file handling (still exercised by the reader)
 *
 * An absent `DATA_FILE` starts an empty store. A `DATA_FILE` that cannot be
 * parsed — or that parses but does not hold the expected shape — is renamed to
 * `<base>.corrupt-<timestamp>.json` beside it, the store starts empty, and a
 * warning naming the reason is logged. This reader path shares
 * {@link parseStoreDocument} with the Data_Import.
 */

import { basename, dirname, extname, join } from "node:path"
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises"
import { mkdirSync, readFileSync, renameSync } from "node:fs"

import { MEMBER_OUTCOME_VALUES } from "@/domain/types"
import type {
  MemberOutcomeValue,
  MemberRegistryEntry,
  RedemptionHistoryRecord,
} from "@/domain/types"

/** Schema version of the persisted document. */
export const STORE_VERSION = 1

/** Default `DATA_FILE` location, matching the design's environment table. */
export const DEFAULT_DATA_FILE = "./data/store.json"

/** Mode of the written document: readable and writable by the owner only. */
const FILE_MODE = 0o600

/**
 * The persisted document, mutable. Only a mutator passed to
 * {@link JsonStore.mutate} receives this shape.
 */
export interface StoreDocument {
  readonly version: number
  /** Monotonic Redemption_History append counter; never resets. */
  nextHistorySeq: number
  /** Append-ordered Member_Registry entries (Requirement 1.4). */
  members: MemberRegistryEntry[]
  /** Append-ordered Redemption_History records (Requirement 6.5). */
  history: RedemptionHistoryRecord[]
}

/** The read-only view of the in-memory document returned by `read()`. */
export interface StoreDocumentView {
  readonly version: number
  readonly nextHistorySeq: number
  readonly members: readonly MemberRegistryEntry[]
  readonly history: readonly RedemptionHistoryRecord[]
}

/** What a flush is asked to make durable. */
export interface FlushRequest {
  /** Target path, i.e. the resolved `DATA_FILE`. */
  readonly filePath: string
  /** Serialized document text, captured at enqueue time. */
  readonly contents: string
  /** Structured snapshot of the same document. */
  readonly document: StoreDocumentView
}

/**
 * A durable write. Resolving means the document is on disk; rejecting means it
 * is not, and the caller of the mutation is told `persisted: false`.
 * Overridable so tests can force a rejection without touching the filesystem.
 *
 * Dead code: no live path enqueues a flush any more (see the module header).
 */
export type FlushFn = (request: FlushRequest) => Promise<void>

/** The warning sink. Defaults to `console`. */
export interface StoreLogger {
  warn: (message: string) => void
}

/**
 * Outcome of one mutation: the mutator's return value plus durability.
 *
 * Dead code: the live stores return their own result shapes over the Mongo_Store
 * and no longer carry a `persisted` flag (Requirement 2.8).
 */
export interface MutationResult<T> {
  readonly value: T
  /** False when the flush for this mutation rejected (historical Req. 1.8). */
  readonly persisted: boolean
}

export interface JsonStoreOptions {
  /** Resolved `DATA_FILE` path. Defaults to {@link DEFAULT_DATA_FILE}. */
  readonly dataFilePath?: string
  /** Replaces the atomic filesystem write. */
  readonly flush?: FlushFn
  /** Replaces `console` as the warning sink. */
  readonly logger?: StoreLogger
}

/** A fresh, empty document. */
export function emptyStoreDocument(): StoreDocument {
  return {
    version: STORE_VERSION,
    nextHistorySeq: 1,
    members: [],
    history: [],
  }
}

/** Serialized form written to disk: pretty-printed, newline-terminated. */
export function serializeStoreDocument(document: StoreDocumentView): string {
  return `${JSON.stringify(document, null, 2)}\n`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMemberOutcomeValue(value: unknown): value is MemberOutcomeValue {
  return (
    typeof value === "string" &&
    (MEMBER_OUTCOME_VALUES as readonly string[]).includes(value)
  )
}

function isMemberRegistryEntry(value: unknown): value is MemberRegistryEntry {
  if (!isRecord(value)) return false
  return (
    typeof value.id === "string" &&
    typeof value.memberLabel === "string" &&
    typeof value.hiveId === "string" &&
    typeof value.enabled === "boolean" &&
    typeof value.createdAt === "string"
  )
}

function isHistoryOutcomeRow(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    typeof value.hiveId === "string" &&
    typeof value.memberLabel === "string" &&
    isMemberOutcomeValue(value.outcome) &&
    typeof value.responseCode === "string" &&
    typeof value.responseMessage === "string"
  )
}

function isHistoryRecord(value: unknown): value is RedemptionHistoryRecord {
  if (!isRecord(value)) return false
  return (
    typeof value.runId === "string" &&
    typeof value.seq === "number" &&
    Number.isFinite(value.seq) &&
    typeof value.couponCode === "string" &&
    typeof value.completedAt === "string" &&
    typeof value.mock === "boolean" &&
    typeof value.stoppedEarly === "boolean" &&
    Array.isArray(value.outcomes) &&
    value.outcomes.every(isHistoryOutcomeRow)
  )
}

/** Either a usable document or the reason the file has to be set aside. */
export type ParseStoreDocumentResult =
  | { readonly ok: true; readonly document: StoreDocument }
  | { readonly ok: false; readonly reason: string }

/**
 * Parses and validates the persisted document text.
 *
 * Anything the store cannot serve — invalid JSON, a non-object, an unknown
 * `version`, a non-array `members` or `history`, or a malformed row inside
 * either array — is reported as a reason rather than repaired, because a
 * partially understood roster is worse than an empty one that the operator is
 * warned about. `nextHistorySeq` is repaired though: it is raised to one past
 * the highest retained `seq` so the Requirement 6.6 tie-break stays correct
 * even if the counter in the file lagged behind.
 */
export function parseStoreDocument(text: string): ParseStoreDocumentResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return { ok: false, reason: "the file does not hold valid JSON" }
  }

  if (!isRecord(parsed)) {
    return { ok: false, reason: "the document is not a JSON object" }
  }
  if (parsed.version !== STORE_VERSION) {
    return {
      ok: false,
      reason: `the document version ${JSON.stringify(
        parsed.version
      )} is not the supported version ${STORE_VERSION}`,
    }
  }
  if (
    !Array.isArray(parsed.members) ||
    !parsed.members.every(isMemberRegistryEntry)
  ) {
    return { ok: false, reason: "the members array is missing or malformed" }
  }
  if (
    !Array.isArray(parsed.history) ||
    !parsed.history.every(isHistoryRecord)
  ) {
    return { ok: false, reason: "the history array is missing or malformed" }
  }

  const members = parsed.members
  const history = parsed.history
  const declaredSeq =
    typeof parsed.nextHistorySeq === "number" &&
    Number.isFinite(parsed.nextHistorySeq)
      ? Math.floor(parsed.nextHistorySeq)
      : 1
  const highestSeq = history.reduce(
    (highest, record) => Math.max(highest, record.seq),
    0
  )

  return {
    ok: true,
    document: {
      version: STORE_VERSION,
      nextHistorySeq: Math.max(declaredSeq, highestSeq + 1, 1),
      members: [...members],
      history: [...history],
    },
  }
}

/**
 * Path the corrupt document is moved to: `<base>.corrupt-<timestamp>.json`
 * beside the data file, so `data/store.json` becomes
 * `data/store.corrupt-2025-01-04T18-21-03-123Z.json`. The timestamp is
 * filesystem-safe on every platform, and the suffix is unique enough that two
 * failed startups do not overwrite each other's evidence.
 */
export function corruptFilePath(filePath: string, now: Date): string {
  const extension = extname(filePath)
  const base = basename(filePath, extension)
  const stamp = now.toISOString().replace(/[^0-9A-Za-z]/g, "-")
  return join(dirname(filePath), `${base}.corrupt-${stamp}.json`)
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string"
    ? error.code
    : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The atomic filesystem flush: create the parent directory, write the
 * temporary file with mode `0600`, `fsync` it, then rename it over the target.
 * The temporary file is removed on failure so a partial write is never left
 * behind next to the real document.
 *
 * Dead code: no live path calls this any more (see the module header). It is
 * retained as the default flush for the tests that still drive `JsonStore`.
 */
export const atomicFlush: FlushFn = async ({ filePath, contents }) => {
  const tmpPath = `${filePath}.tmp`
  await mkdir(dirname(filePath), { recursive: true })

  try {
    const handle = await open(tmpPath, "w", FILE_MODE)
    try {
      await handle.writeFile(contents, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    // `open` leaves the mode of a pre-existing temporary file untouched.
    await chmod(tmpPath, FILE_MODE)
    await rename(tmpPath, filePath)
  } catch (error) {
    await unlink(tmpPath).catch(() => undefined)
    throw error
  }
}

/**
 * The JSON-document store. Construct one per `DATA_FILE`; the load happens in
 * the constructor, synchronously, because it runs once at startup and every
 * later read is expected to be synchronous.
 *
 * Dead code as a live store: nothing under `src/` constructs this any more. The
 * class and its write side survive only for the shared-coupon-redemption tests
 * that still exercise them, and for the corrupt-file reader path that shares
 * {@link parseStoreDocument} with the Data_Import. The whole `mutate` /
 * `enqueueFlush` write side below is wired to no request path.
 */
export class JsonStore {
  readonly filePath: string

  private readonly document: StoreDocument
  private readonly flushFn: FlushFn
  private readonly logger: StoreLogger

  /** Tail of the single flush chain; keeps flushes strictly ordered. */
  private queue: Promise<void> = Promise.resolve()

  constructor(options: JsonStoreOptions = {}) {
    this.filePath = options.dataFilePath ?? DEFAULT_DATA_FILE
    this.flushFn = options.flush ?? atomicFlush
    this.logger = options.logger ?? console
    this.document = this.load()
  }

  /** The in-memory document. Mutate it only through {@link mutate}. */
  read(): StoreDocumentView {
    return this.document
  }

  /**
   * Applies `mutator` to the in-memory document synchronously — before this
   * method returns, so the change is visible to the next `read()` — then
   * enqueues a flush and resolves with `persisted` once that flush settles.
   *
   * A throwing mutator propagates synchronously and enqueues nothing.
   *
   * Dead code: the live stores mutate MongoDB, not this document.
   */
  mutate<T>(
    mutator: (document: StoreDocument) => T
  ): Promise<MutationResult<T>> {
    const value = mutator(this.document)
    return this.enqueueFlush().then((persisted) => ({ value, persisted }))
  }

  /** Resolves once every flush enqueued so far has settled. */
  whenIdle(): Promise<void> {
    return this.queue
  }

  /**
   * Enqueues one flush behind every earlier one. The document is serialized
   * here, synchronously, so the text a flush writes is the state as of its own
   * mutation. A rejection is swallowed into `false` so the chain survives it.
   *
   * Dead code: reached only through {@link mutate}, which no live path calls.
   */
  private enqueueFlush(): Promise<boolean> {
    const request: FlushRequest = {
      filePath: this.filePath,
      contents: serializeStoreDocument(this.document),
      document: {
        version: this.document.version,
        nextHistorySeq: this.document.nextHistorySeq,
        members: [...this.document.members],
        history: [...this.document.history],
      },
    }

    const flushed = this.queue.then(() =>
      this.flushFn(request).then(
        () => true,
        (error: unknown) => {
          this.logger.warn(
            `Could not write the store document at ${this.filePath}: ${errorMessage(
              error
            )}. The change stays in memory and is lost on restart.`
          )
          return false
        }
      )
    )
    this.queue = flushed.then(() => undefined)
    return flushed
  }

  /**
   * Reads `DATA_FILE` once. An absent file is an empty store; an unreadable or
   * unusable file logs a warning and, when it exists, is renamed aside.
   */
  private load(): StoreDocument {
    let text: string
    try {
      text = readFileSync(this.filePath, "utf8")
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        this.logger.warn(
          `Could not read the store document at ${this.filePath}: ${errorMessage(
            error
          )}. Starting with an empty store.`
        )
      }
      return emptyStoreDocument()
    }

    const parsed = parseStoreDocument(text)
    if (parsed.ok) {
      return parsed.document
    }

    this.setCorruptFileAside(parsed.reason)
    return emptyStoreDocument()
  }

  private setCorruptFileAside(reason: string): void {
    const target = corruptFilePath(this.filePath, new Date())
    try {
      mkdirSync(dirname(target), { recursive: true })
      renameSync(this.filePath, target)
      this.logger.warn(
        `The store document at ${this.filePath} is unusable (${reason}). It was renamed to ${target} and the store starts empty.`
      )
    } catch (error) {
      this.logger.warn(
        `The store document at ${this.filePath} is unusable (${reason}) and could not be renamed aside: ${errorMessage(
          error
        )}. The store starts empty and the next write replaces the file.`
      )
    }
  }
}

/**
 * Creates a store for an arbitrary `DATA_FILE`. Used by tests only now; no
 * application wiring constructs a `JsonStore` any more.
 */
export function createJsonStore(options: JsonStoreOptions = {}): JsonStore {
  return new JsonStore(options)
}

let defaultStore: JsonStore | null = null

/**
 * The process-wide store, created on first use.
 *
 * Dead code: no live path calls this. It once was the store application wiring
 * installed over {@link setJsonStore}; the Mongo_Store now fills that role and
 * nothing invokes this accessor on a request path. Retained for the tests only.
 */
export function getJsonStore(): JsonStore {
  defaultStore ??= createJsonStore({
    dataFilePath: process.env.DATA_FILE ?? DEFAULT_DATA_FILE,
  })
  return defaultStore
}

/** Installs the process-wide store. Overrides whatever was created before. */
export function setJsonStore(store: JsonStore): void {
  defaultStore = store
}

/** Drops the process-wide store so the next `getJsonStore()` rebuilds it. */
export function resetJsonStore(): void {
  defaultStore = null
}
