/**
 * The one-time Data_Import from the Legacy_Json_Store into the Mongo_Database
 * (Requirements 4.1, 4.2, 4.3, 4.5, 4.6, 4.7, 4.8, 4.9).
 *
 * It runs inside the Mongo_Store bootstrap, as the last step before `ready`
 * resolves, which is what makes Requirement 4.1's "before it answers its first
 * Member_Registry read, Member_Registry write, Redemption_History read, or
 * Redemption_History write" structural rather than a matter of call ordering:
 * `mongo.server.ts` awaits {@link runDataImport} before it hands out its first
 * collection handle.
 *
 * ## Two halves, split on purpose
 *
 * {@link planDataImport} is a **pure** function of a parsed {@link StoreDocument}
 * and a startup timestamp. It does steps 1-5 of the design's write side —
 * accept, skip, cap, order, assign positions and `seq`, and compute the counter
 * ceilings — and touches no database. That is deliberate: the accept / skip /
 * order / count / cap / assignment logic is exactly what Property 10 (task 13.2)
 * and the guard unit tests (task 13.3) need to exercise, and a plan they can
 * build and inspect without a MongoDB is the whole point of keeping it separate.
 *
 * {@link runDataImport} is the **imperative** half: it decides due-ness
 * (Requirement 4.2), reads `DATA_FILE` through {@link parseStoreDocument} under a
 * 5-second bound mapping the three failure modes onto Requirement 4.4's three
 * conditions, calls the planner, inserts the plan under a 30-second overall race
 * (Requirement 4.5) tracking every inserted `_id`, raises the two counters,
 * logs the one summary line (Requirement 4.3) and the discarded-over-cap line
 * (Requirement 4.8), and on failure or timeout rolls back by `_id`
 * (Requirement 4.5) with the failed-rollback case (Requirement 4.6). A store
 * that holds no connection while an import is due inserts nothing
 * (Requirement 4.9).
 *
 * ## The counters are seeded to the highest value assigned, not one past it
 *
 * `counters.server.ts` advances a counter with `$inc: { value: 1 }` and returns
 * the value *after* the increment, so a counter holding `N` makes the next call
 * return `N + 1`. The import therefore seeds `member_position` to the highest
 * position it assigned and `history_seq` to the highest `seq` it assigned (not
 * one past either), so the first post-import add and the first post-import
 * append receive the next value up, and Requirement 3.2's "greater than every
 * value ever assigned" holds across the seam. Seeding one-past would burn a
 * value; seeding the max is exactly right.
 *
 * ## No driver message ever leaves this module
 *
 * Requirement 1.6 keeps the Mongo_Connection_URI and every part of it out of
 * every log entry, and a driver error names the topology it could not reach. So
 * no caught error is interpolated into a warning: every sentence is a constant
 * or a function of the `DATA_FILE` path and the plain counts, none of which
 * carries a host or a credential.
 */

import { readFile } from "node:fs/promises"

import { HIVE_ID_MAX_LENGTH, MEMBER_LABEL_MAX_LENGTH } from "@/domain/schemas"
import { MEMBER_REGISTRY_MAX_ENTRIES } from "@/domain/rosterMessages"
import { HISTORY_RETENTION_LIMIT } from "@/domain/types"
import type {
  MemberRegistryEntry,
  RedemptionHistoryRecord,
} from "@/domain/types"
import { serverConfig } from "@/server/config.server"
import {
  toHistoryDocument,
  toMemberDocument,
} from "@/server/store/documents.server"
import type {
  CounterDocument,
  CounterName,
  HistoryDocumentInput,
  MemberDocumentInput,
} from "@/server/store/documents.server"
import type {
  DataImportContext,
  StoreLogger,
} from "@/server/store/mongo.server"
import { parseStoreDocument } from "@/server/store/jsonStore.server"
import type { StoreDocument } from "@/server/store/jsonStore.server"
import type { Collection, Db, Document, ObjectId } from "mongodb"

/** How long the whole write side is allowed to take (Requirement 4.5). */
export const DATA_IMPORT_TIMEOUT_MS = 30_000

/** How long the read of `DATA_FILE` is allowed to take (Requirements 4.1, 4.4). */
export const DATA_FILE_READ_TIMEOUT_MS = 5_000

/**
 * The counter values a completed plan seeds. Each is the highest value the plan
 * assigned to that counter, or 0 when the plan assigned none, so a counter is
 * only ever raised, never lowered.
 */
export interface CounterCeilings {
  /** Highest `position` assigned, or 0 when no entry was accepted. */
  readonly member_position: number
  /** Highest `seq` assigned or preserved, or 0 when no record was accepted. */
  readonly history_seq: number
}

/**
 * The result of the pure planning half: exactly the Store_Documents to insert,
 * the counts the summary lines report, and the counter ceilings.
 *
 * `members` and `history` are `*DocumentInput` — the Store_Document shapes
 * without `_id` — because `_id` is the driver's to assign on insert. They are
 * in insertion order: `members` in the entries' relative document order
 * (Requirement 4.1), `history` in the accepted records' relative document order
 * among the 200 that survived the cap (Requirements 4.1, 4.8).
 */
export interface DataImportPlan {
  /** One document per accepted entry, kept to the first 100, in relative order. */
  readonly members: readonly MemberDocumentInput[]
  /** One document per accepted record, kept to the newest 200, in relative order. */
  readonly history: readonly HistoryDocumentInput[]
  /** Entries skipped for an out-of-range field or a duplicate Hive_ID (Requirement 4.7). */
  readonly skippedEntries: number
  /** Records skipped for a blank Coupon_Code or an absent timestamp (Requirement 4.7). */
  readonly skippedRecords: number
  /** Accepted entries beyond the first 100 (Requirement 4.8). */
  readonly discardedEntries: number
  /** Accepted records beyond the newest 200 (Requirement 4.8). */
  readonly discardedRecords: number
  /** The highest counter values the plan assigned (see {@link CounterCeilings}). */
  readonly counters: CounterCeilings
}

/** A record paired with its original position, so a stable sort can preserve document order. */
interface IndexedRecord {
  readonly index: number
  readonly record: RedemptionHistoryRecord
}

/**
 * Whether a value, after trimming, holds 1 to `max` characters. "Character" is
 * one UTF-16 code unit, the same reading the shared schemas apply, so this and
 * the roster's own validation cannot disagree about an astral-plane label.
 */
function withinRange(value: string, max: number): boolean {
  const trimmed = value.trim()
  return trimmed.length >= 1 && trimmed.length <= max
}

/**
 * Whether a legacy entry is accepted: its Member_Label and Hive_ID are both in
 * range after trimming, and its trimmed Hive_ID is not one an earlier accepted
 * entry already took (Requirement 4.7).
 *
 * `acceptedHiveIds` holds the *trimmed* Hive_IDs accepted so far, because the
 * roster stores the trimmed value and Requirement 2.4 compares trimmed values
 * character for character. Case is distinguished: two Hive_IDs differing only in
 * letter case are two different Hive_IDs.
 */
function acceptsEntry(
  entry: MemberRegistryEntry,
  acceptedHiveIds: ReadonlySet<string>
): boolean {
  if (
    !withinRange(entry.memberLabel, MEMBER_LABEL_MAX_LENGTH) ||
    !withinRange(entry.hiveId, HIVE_ID_MAX_LENGTH)
  ) {
    return false
  }
  return !acceptedHiveIds.has(entry.hiveId.trim())
}

/**
 * Whether a legacy record is accepted: a Coupon_Code holding at least one
 * character and a completion timestamp holding at least one character
 * (Requirement 4.7).
 *
 * "No completion timestamp" is read as an absent or empty `completedAt`. The
 * parsed {@link StoreDocument} types `completedAt` as a string, but the guard
 * treats a non-string defensively as absent, because the Legacy_Json_Store is
 * operator-supplied and the point of the Data_Import is to be forgiving of it.
 */
function acceptsRecord(record: RedemptionHistoryRecord): boolean {
  const couponCode =
    typeof record.couponCode === "string" ? record.couponCode : ""
  const completedAt =
    typeof record.completedAt === "string" ? record.completedAt : ""
  return couponCode.length > 0 && completedAt.length > 0
}

/**
 * Epoch milliseconds for a completion timestamp, for the "most recent"
 * selection of Requirement 4.8. An unparsable value sorts as the oldest (0)
 * rather than `NaN`, so the selection is total and deterministic; an accepted
 * record always holds a non-empty `completedAt`, so this is a guard rather than
 * a path a well-formed document takes.
 */
function completionMs(record: RedemptionHistoryRecord): number {
  const ms = new Date(record.completedAt).getTime()
  return Number.isFinite(ms) ? ms : 0
}

/**
 * Steps 1-5 of the design's write side, as a pure function (Requirements 4.1,
 * 4.7, 4.8).
 *
 * 1. Accept entries in document order, skipping any with an out-of-range
 *    Member_Label or Hive_ID or a Hive_ID already accepted in this import
 *    (Requirement 4.7); keep the first 100 (Requirement 4.8).
 * 2. Accept records, skipping any with a zero-character Coupon_Code or no
 *    completion timestamp (Requirement 4.7); keep the 200 with the most recent
 *    completion timestamps (Requirement 4.8).
 * 3. Assign positions 1..N in the kept entries' relative order and preserve each
 *    `createdAt`, using `startupTimestamp` for an entry that holds none
 *    (Requirement 4.1).
 * 4. Preserve each kept record's `seq` where it holds a finite one, and assign
 *    the remaining ones in the kept records' relative order (Requirement 4.1).
 * 5. Report the highest position and the highest `seq` as the counter ceilings.
 *
 * @param document The parsed Legacy_Json_Store.
 * @param startupTimestamp The ISO 8601 startup timestamp, used for an entry that
 * holds no `createdAt` (Requirement 4.1).
 */
export function planDataImport(
  document: StoreDocument,
  startupTimestamp: string
): DataImportPlan {
  const { members, skippedEntries, discardedEntries, maxPosition } =
    planEntries(document.members, startupTimestamp)

  const { history, skippedRecords, discardedRecords, maxSeq } = planRecords(
    document.history
  )

  return {
    members,
    history,
    skippedEntries,
    skippedRecords,
    discardedEntries,
    discardedRecords,
    counters: { member_position: maxPosition, history_seq: maxSeq },
  }
}

/** Steps 1, 3, and the position half of step 5 (Requirements 4.1, 4.7, 4.8). */
function planEntries(
  entries: readonly MemberRegistryEntry[],
  startupTimestamp: string
): {
  readonly members: readonly MemberDocumentInput[]
  readonly skippedEntries: number
  readonly discardedEntries: number
  readonly maxPosition: number
} {
  const acceptedHiveIds = new Set<string>()
  const accepted: MemberRegistryEntry[] = []
  let skippedEntries = 0

  for (const entry of entries) {
    if (!acceptsEntry(entry, acceptedHiveIds)) {
      skippedEntries += 1
      continue
    }
    acceptedHiveIds.add(entry.hiveId.trim())
    accepted.push(entry)
  }

  // Requirement 4.8: keep the first 100 accepted, in document order.
  const kept = accepted.slice(0, MEMBER_REGISTRY_MAX_ENTRIES)
  const discardedEntries = accepted.length - kept.length

  // Requirement 4.1: positions 1..N in relative order; createdAt preserved or startup.
  const members = kept.map((entry, offset) => {
    const position = offset + 1
    const withTimestamp: MemberRegistryEntry = {
      ...entry,
      createdAt:
        typeof entry.createdAt === "string" && entry.createdAt.length > 0
          ? entry.createdAt
          : startupTimestamp,
    }
    return toMemberDocument(withTimestamp, position)
  })

  return {
    members,
    skippedEntries,
    discardedEntries,
    maxPosition: members.length,
  }
}

/** Steps 2, 4, and the `seq` half of step 5 (Requirements 4.1, 4.7, 4.8). */
function planRecords(records: readonly RedemptionHistoryRecord[]): {
  readonly history: readonly HistoryDocumentInput[]
  readonly skippedRecords: number
  readonly discardedRecords: number
  readonly maxSeq: number
} {
  const accepted: IndexedRecord[] = []
  let skippedRecords = 0

  records.forEach((record, index) => {
    if (acceptsRecord(record)) {
      accepted.push({ index, record })
    } else {
      skippedRecords += 1
    }
  })

  // Requirement 4.8: keep the 200 with the most recent completion timestamps.
  const kept = selectNewest(accepted, HISTORY_RETENTION_LIMIT)
  const discardedRecords = accepted.length - kept.length

  // Requirement 4.1: preserve a finite `seq`, assign the rest in relative order.
  const assigned = assignSeqValues(kept.map((indexed) => indexed.record))

  const history = assigned.records.map((record) => toHistoryDocument(record))

  return {
    history,
    skippedRecords,
    discardedRecords,
    maxSeq: assigned.maxSeq,
  }
}

/**
 * The `limit` accepted records holding the most recent completion timestamps,
 * back in their relative document order (Requirements 4.1, 4.8).
 *
 * The selection sorts a copy by completion instant descending, breaking ties by
 * the earlier document position so the choice is deterministic, takes the first
 * `limit`, then restores document order among the survivors so the `seq`
 * assignment of step 4 runs over them in the order they held in the file.
 */
function selectNewest(
  accepted: readonly IndexedRecord[],
  limit: number
): readonly IndexedRecord[] {
  if (accepted.length <= limit) {
    return accepted
  }
  const byRecency = [...accepted].sort((left, right) => {
    const delta = completionMs(right.record) - completionMs(left.record)
    return delta !== 0 ? delta : left.index - right.index
  })
  const survivors = byRecency.slice(0, limit)
  return survivors.sort((left, right) => left.index - right.index)
}

/**
 * Preserves each record's `seq` where it holds a finite one and assigns the rest
 * in the records' relative order, so every kept record ends with a `seq` and no
 * two share one (Requirement 4.1). Returns the records with their `seq` set and
 * the highest value present, which becomes the `history_seq` ceiling.
 *
 * A record that holds no `seq`, or a non-finite one, is treated as holding none.
 * Assigned values start one above the highest preserved value and climb in
 * document order, so an assigned value can never collide with a preserved one
 * and the whole set is strictly ordered where it was already, above where it was
 * not.
 */
function assignSeqValues(records: readonly RedemptionHistoryRecord[]): {
  readonly records: readonly RedemptionHistoryRecord[]
  readonly maxSeq: number
} {
  const preservedMax = records.reduce((highest, record) => {
    const seq = record.seq
    return typeof seq === "number" && Number.isFinite(seq)
      ? Math.max(highest, Math.floor(seq))
      : highest
  }, 0)

  let nextAssigned = preservedMax
  let maxSeq = preservedMax

  const withSeq = records.map((record) => {
    const seq = record.seq
    if (typeof seq === "number" && Number.isFinite(seq)) {
      return record
    }
    nextAssigned += 1
    maxSeq = Math.max(maxSeq, nextAssigned)
    return { ...record, seq: nextAssigned }
  })

  return { records: withSeq, maxSeq }
}

/**
 * The one summary line of Requirement 4.3, naming the inserted and skipped
 * counts. It never names the discarded-over-cap counts — those get their own
 * line (Requirement 4.8) — and it carries no part of the Mongo_Connection_URI.
 */
export function dataImportSummaryLine(plan: DataImportPlan): string {
  return (
    `Data_Import complete: inserted ${plan.members.length} Member_Registry ` +
    `entries and ${plan.history.length} Redemption_History records, skipped ` +
    `${plan.skippedEntries} entries and ${plan.skippedRecords} records.`
  )
}

/**
 * The one discarded-over-cap line of Requirement 4.8, logged only when the cap
 * discarded something. Returns null when neither cap discarded anything, so the
 * caller logs exactly one line only when there is something to say.
 */
export function dataImportDiscardLine(plan: DataImportPlan): string | null {
  if (plan.discardedEntries === 0 && plan.discardedRecords === 0) {
    return null
  }
  return (
    `Data_Import capped the import: discarded ${plan.discardedEntries} ` +
    `Member_Registry entries beyond the ${MEMBER_REGISTRY_MAX_ENTRIES}-entry ` +
    `cap and ${plan.discardedRecords} Redemption_History records beyond the ` +
    `${HISTORY_RETENTION_LIMIT}-record cap.`
  )
}

/**
 * The one warning for the "no Data_Import was due" case (Requirement 4.2). It is
 * a plain log line, not a warning about a failure: a second startup after a
 * completed import is the ordinary steady state.
 */
export const NO_DATA_IMPORT_DUE_LINE =
  "No Data_Import was due: the members or history collection already holds at " +
  "least one document, so the Legacy_Json_Store was not read and nothing was " +
  "inserted."

/**
 * The warning naming which of Requirement 4.4's three conditions stopped the
 * read, and the `DATA_FILE` path. The condition text carries no part of the
 * Mongo_Connection_URI and no driver error.
 */
export function dataFileUnreadableWarning(
  dataFilePath: string,
  condition: string
): string {
  return (
    `The Legacy_Json_Store at ${dataFilePath} ${condition}. No Data_Import was ` +
    `performed; startup completes with the members and history collections ` +
    `empty, and the import is retried on the next startup.`
  )
}

/** The Requirement 4.9 warning: an import was due but no connection is held. */
export function noConnectionWarning(dataFilePath: string): string {
  return (
    `The Data_Import was not attempted because no Mongo_Database connection is ` +
    `held. The Legacy_Json_Store at ${dataFilePath} was left unchanged and the ` +
    `import is retried on the next startup.`
  )
}

/**
 * The Requirement 4.5 warning: the import failed or ran past its 30-second
 * bound, its inserts were rolled back, and it is retried next startup.
 */
export const DATA_IMPORT_ABANDONED_WARNING =
  "The Data_Import did not complete: it failed or exceeded its 30-second " +
  "bound, so every document it inserted was deleted and the import is retried " +
  "on the next startup with both collections empty."

/**
 * The Requirement 4.6 warning: a rollback delete itself failed, so a collection
 * retains partially imported documents, which makes an import no longer due for
 * it. Names the collection and nothing of the driver error.
 */
export function rollbackFailedWarning(collectionName: string): string {
  return (
    `The Data_Import was abandoned, but deleting the documents it inserted into ` +
    `the ${collectionName} collection failed, so that collection retains them. ` +
    `A Data_Import is no longer due, because a non-empty collection is what ` +
    `makes one not due, and reads are served from the Mongo_Database with no ` +
    `further import attempt.`
  )
}

/** Which of Requirement 4.4's three conditions a parse failure was. */
type ReadFailure =
  | { readonly kind: "read-failed"; readonly condition: string }
  | { readonly kind: "ok"; readonly document: StoreDocument }

/**
 * Reads and parses `DATA_FILE` through {@link parseStoreDocument} under the
 * 5-second bound of Requirements 4.1 and 4.4, mapping the three failure modes
 * onto the requirement's three conditions.
 *
 * - An absent file (`ENOENT`) is "is absent".
 * - A read that does not resolve within 5 seconds is "could not be read within
 *   5 seconds", and any other read error is treated the same way — the operator
 *   sees a file they cannot read, which is the actionable fact.
 * - A file that parses to something other than the expected shape is "does not
 *   hold the expected shape", carrying the reason {@link parseStoreDocument}
 *   gave.
 *
 * The read is bounded with a `Promise.race`, not with a driver option, because
 * it is a filesystem read rather than a Mongo_Database operation.
 */
async function readLegacyStore(dataFilePath: string): Promise<ReadFailure> {
  let text: string
  try {
    text = await raceWithin(
      readFile(dataFilePath, "utf8"),
      DATA_FILE_READ_TIMEOUT_MS
    )
  } catch (error) {
    if (isFileNotFound(error)) {
      return { kind: "read-failed", condition: "is absent" }
    }
    if (isTimeout(error)) {
      return {
        kind: "read-failed",
        condition: `could not be read within ${
          DATA_FILE_READ_TIMEOUT_MS / 1_000
        } seconds`,
      }
    }
    return {
      kind: "read-failed",
      condition: `could not be read within ${
        DATA_FILE_READ_TIMEOUT_MS / 1_000
      } seconds`,
    }
  }

  const parsed = parseStoreDocument(text)
  if (!parsed.ok) {
    return {
      kind: "read-failed",
      condition: `does not hold the expected shape (${parsed.reason})`,
    }
  }
  return { kind: "ok", document: parsed.document }
}

/** Whether both collections hold zero documents, i.e. an import is due (Requirement 4.2). */
async function importIsDue(db: Db): Promise<boolean> {
  const members = await db.collection("members").countDocuments()
  if (members > 0) {
    return false
  }
  const history = await db.collection("history").countDocuments()
  return history === 0
}

/** Every `_id` this import inserted, per collection, so a rollback can delete exactly them. */
interface InsertedIds {
  readonly members: ObjectId[]
  readonly history: ObjectId[]
}

/**
 * Runs the Data_Import if it is due (Requirement 4.2), reading the
 * Legacy_Json_Store, planning it, inserting the plan, seeding the counters, and
 * logging the summary — all inside the Mongo_Store bootstrap, before the store
 * answers its first read or write (Requirement 4.1).
 *
 * Every failure completes startup rather than aborting it: a failed or timed-out
 * import is rolled back and retried next startup (Requirement 4.5), a failed
 * rollback leaves one collection non-empty and thereby ends the import for good
 * (Requirement 4.6), an unreadable file leaves both collections empty
 * (Requirement 4.4), and a store with no connection inserts nothing
 * (Requirement 4.9). None of these throws, so the bootstrap continues in every
 * case; `mongo.server.ts` swallows a throw as a last resort only.
 *
 * @param context The `db` handle and the warning sink, supplied by the
 * Mongo_Store bootstrap.
 * @param options Injected seams for testing: the `DATA_FILE` path, the startup
 * timestamp, and whether a connection is held.
 */
export async function runDataImport(
  context: DataImportContext,
  options: RunDataImportOptions = {}
): Promise<void> {
  const { db, logger } = context
  const dataFilePath = options.dataFilePath ?? serverConfig.dataFile
  const startupTimestamp = options.startupTimestamp ?? new Date().toISOString()
  const connectionHeld = options.connectionHeld ?? true

  // Requirement 4.9: no connection while an import is due ⇒ insert nothing.
  if (!connectionHeld) {
    logger.warn(noConnectionWarning(dataFilePath))
    return
  }

  // Requirement 4.2: due only while both collections hold zero documents.
  if (!(await importIsDue(db))) {
    logger.warn(NO_DATA_IMPORT_DUE_LINE)
    return
  }

  // Requirements 4.1, 4.4: read within 5 seconds, mapping the three conditions.
  const read = await readLegacyStore(dataFilePath)
  if (read.kind === "read-failed") {
    logger.warn(dataFileUnreadableWarning(dataFilePath, read.condition))
    return
  }

  const plan = planDataImport(read.document, startupTimestamp)

  /*
   * The tracker lives here, not inside `insertPlan`, so a 30-second timeout —
   * which interrupts the insert from the outside — can roll back exactly what
   * landed before the bound expired, just as a driver failure can
   * (Requirement 4.5).
   */
  const inserted: InsertedIds = { members: [], history: [] }

  // Requirement 4.5: the whole write side is bounded at 30 seconds.
  try {
    await raceWithin(
      insertPlan(db, plan, inserted, logger),
      DATA_IMPORT_TIMEOUT_MS
    )
  } catch {
    /*
     * Requirement 4.5: a failure or a timeout abandons the import. Either way
     * the inserts made so far are deleted by their tracked `_id`, and the
     * abandoned warning is logged once — a failed rollback adds its own warning
     * naming the retaining collection (Requirement 4.6).
     */
    await rollback(db, inserted, logger)
    logger.warn(DATA_IMPORT_ABANDONED_WARNING)
  }
}

/**
 * Inserts the plan and seeds the counters, recording every inserted `_id` on the
 * caller's tracker as it lands (Requirement 4.5). It does **not** handle its own
 * failure: a rejection propagates to {@link runDataImport}, which owns the
 * rollback and the abandoned warning so that a driver failure and a 30-second
 * timeout — which interrupts this from the outside — take exactly the same path.
 *
 * On the happy path it logs the summary line and, when a cap discarded anything,
 * the discard line (Requirements 4.3, 4.8).
 */
async function insertPlan(
  db: Db,
  plan: DataImportPlan,
  inserted: InsertedIds,
  logger: StoreLogger
): Promise<void> {
  const membersCollection = db.collection<MemberDocumentInput>("members")
  const historyCollection = db.collection<HistoryDocumentInput>("history")

  for (const document of plan.members) {
    const result = await membersCollection.insertOne({ ...document })
    inserted.members.push(result.insertedId)
  }
  for (const document of plan.history) {
    const result = await historyCollection.insertOne({ ...document })
    inserted.history.push(result.insertedId)
  }

  await seedCounters(db, plan.counters)

  logger.warn(dataImportSummaryLine(plan))
  const discardLine = dataImportDiscardLine(plan)
  if (discardLine !== null) {
    logger.warn(discardLine)
  }
}

/**
 * Seeds `member_position` and `history_seq` to the highest values the plan
 * assigned (Requirement 4.1, and Requirement 3.2 for the first post-import
 * append).
 *
 * The counter is set with `$set` rather than `$inc`, and to the highest value
 * assigned rather than one past it, because `nextCounterValue` does the `+1` on
 * the next read: a counter holding `N` makes the next append receive `N + 1`. A
 * ceiling of 0 — the plan accepted nothing for that counter — sets the counter
 * to 0, so the first value handed out is 1, exactly as an absent counter would
 * yield.
 */
async function seedCounters(db: Db, ceilings: CounterCeilings): Promise<void> {
  const counters = db.collection<CounterDocument>("counters")
  const entries: readonly [CounterName, number][] = [
    ["member_position", ceilings.member_position],
    ["history_seq", ceilings.history_seq],
  ]
  for (const [name, value] of entries) {
    await counters.updateOne(
      { _id: name },
      { $set: { value } },
      { upsert: true }
    )
  }
}

/**
 * Deletes exactly the documents this import inserted, by `_id` (Requirement
 * 4.5). A delete that itself fails is Requirement 4.6: startup still completes,
 * a warning names the collection that retains its documents, and the non-empty
 * collection is what makes an import no longer due for it.
 */
async function rollback(
  db: Db,
  inserted: InsertedIds,
  logger: StoreLogger
): Promise<void> {
  await rollbackCollection(db, "members", inserted.members, logger)
  await rollbackCollection(db, "history", inserted.history, logger)
}

/** Deletes the tracked `_id`s of one collection, warning on a failed delete (Requirement 4.6). */
async function rollbackCollection(
  db: Db,
  collectionName: "members" | "history",
  ids: readonly ObjectId[],
  logger: StoreLogger
): Promise<void> {
  if (ids.length === 0) {
    return
  }
  try {
    await deleteByIds(db.collection(collectionName), ids)
  } catch {
    logger.warn(rollbackFailedWarning(collectionName))
  }
}

/** Deletes the given `_id`s in one `deleteMany`. */
function deleteByIds(
  collection: Collection<Document>,
  ids: readonly ObjectId[]
): Promise<unknown> {
  return collection.deleteMany({ _id: { $in: [...ids] } })
}

/** Options that let the guard tests drive {@link runDataImport} without process state. */
export interface RunDataImportOptions {
  /** The `DATA_FILE` path. Defaults to {@link serverConfig.dataFile}. */
  readonly dataFilePath?: string
  /** The ISO 8601 startup timestamp for entries holding no `createdAt`. */
  readonly startupTimestamp?: string
  /** Whether a Mongo_Database connection is held (Requirement 4.9). Defaults to true. */
  readonly connectionHeld?: boolean
}

/** A timeout rejection carrying a recognizable marker, so {@link isTimeout} can spot it. */
class TimeoutError extends Error {
  readonly isDataImportTimeout = true
  constructor() {
    super("The operation exceeded its bound.")
    this.name = "TimeoutError"
  }
}

/** Whether a caught error is a {@link TimeoutError} from {@link raceWithin}. */
function isTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { isDataImportTimeout?: unknown }).isDataImportTimeout === true
  )
}

/** Whether a caught error is a filesystem `ENOENT` (an absent file). */
function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  )
}

/**
 * Resolves `work` if it settles within `timeoutMs`, otherwise rejects with a
 * {@link TimeoutError}. The timer is cleared on either outcome so a resolved
 * promise does not keep the process alive on a pending timer.
 */
function raceWithin<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiring = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError()), timeoutMs)
  })
  return Promise.race([work, expiring]).finally(() => {
    clearTimeout(timer)
  })
}
