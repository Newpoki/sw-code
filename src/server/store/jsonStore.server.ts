/**
 * JsonStore: the one persistent document behind the Member_Registry and the
 * Redemption_History (Requirements 1.7, 1.8, 6.5).
 *
 * The whole dataset — at most 100 roster entries plus the retained history
 * records — is held in memory as a single versioned document. A mutation runs
 * synchronously against that in-memory document, so it is visible to the very
 * next read, and the durable write is enqueued behind it on one promise chain.
 * The caller learns whether the write landed through `persisted`.
 *
 * ## A rejected flush never rolls back
 *
 * Requirement 1.8 requires a failed store write to leave the change visible in
 * memory and to surface a warning instead. That is exactly what happens here:
 * `mutate` applies the mutator first and reports `persisted: false` second. The
 * in-memory document is never reverted, and a rejected flush does not break the
 * chain, so a later mutation can still be written.
 *
 * ## Atomic flush
 *
 * A flush writes `<DATA_FILE>.tmp` with mode `0600`, `fsync`s it, and renames it
 * over `DATA_FILE`. A reader therefore sees either the previous document or the
 * new one, never a half-written file. The parent directory is created on demand.
 *
 * ## Corrupt file handling
 *
 * An absent `DATA_FILE` starts an empty store. A `DATA_FILE` that cannot be
 * parsed — or that parses but does not hold the expected shape — is renamed to
 * `<base>.corrupt-<timestamp>.json` beside it, the store starts empty, and a
 * warning naming the reason is logged. A bad file degrades the app to an empty
 * roster instead of preventing startup.
 *
 * This module owns load, mutate, and flush only. The Member_Registry semantics
 * (`memberRegistry.server.ts`) and the Redemption_History semantics
 * (`history.server.ts`) are built on top of `read()` and `mutate()`.
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
 */
export type FlushFn = (request: FlushRequest) => Promise<void>

/** The warning sink. Defaults to `console`. */
export interface StoreLogger {
  warn: (message: string) => void
}

/** Outcome of one mutation: the mutator's return value plus durability. */
export interface MutationResult<T> {
  readonly value: T
  /** False when the flush for this mutation rejected (Requirement 1.8). */
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

/** Creates a store for an arbitrary `DATA_FILE`. Used by tests and by wiring. */
export function createJsonStore(options: JsonStoreOptions = {}): JsonStore {
  return new JsonStore(options)
}

let defaultStore: JsonStore | null = null

/**
 * The process-wide store, created on first use.
 *
 * The path is read straight from `process.env.DATA_FILE` rather than from
 * `config.server.ts`, so this module stays importable by the store tests
 * without pulling configuration in. Application wiring calls
 * {@link setJsonStore} with a store built from the resolved configuration
 * before anything else touches it.
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
