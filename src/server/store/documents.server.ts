/**
 * Store_Document shapes and the four mappings between domain values and
 * documents (Requirements 2.10, 3.1, 3.8).
 *
 * This module performs no I/O. It holds the BSON shapes the `members`,
 * `history`, `user_accounts`, and `counters` collections store, plus the pure
 * total functions that translate a Member_Registry entry and a
 * Redemption_History record in and out of them. Keeping the translation here,
 * away from the driver, is what lets the two round-trip properties
 * (Requirements 2.11, 3.9) exercise it directly: a round trip through the
 * driver can hide a mapping bug, and the reverse.
 *
 * It carries `.server` in its name because `ObjectId` comes from the `mongodb`
 * package, which may not enter the browser bundle. Nothing else about it is
 * server-specific.
 *
 * ## The two timestamp decisions
 *
 * A Member_Registry `createdAt` is stored as a BSON `Date`. Nothing sorts or
 * compares it, so a `Date` is the honest type, and the mapping renders it back
 * to the domain's ISO string. The round trip is exact for the values the domain
 * produces, which are always `Date.prototype.toISOString()` output.
 *
 * A Redemption_History `completedAt` is stored as the **string the domain
 * holds**, with the epoch milliseconds beside it in `completedAtMs`.
 * Requirement 3.6 requires the same `completedAt` to come back after a restart,
 * and an ISO string that survives a `Date` round trip is not guaranteed to be
 * character-identical — a UTC offset collapses to `Z` and fractional-second
 * precision changes. Storing the string is the only way the round trip holds
 * character for character. `completedAtMs` exists so the Requirement 3.4 sort
 * and the `{ completedAtMs: -1 }` index of Requirement 1.7 compare instants
 * rather than spellings; it is derived on the way out and never read back into
 * the domain.
 */

import type { ObjectId } from "mongodb"

import type { AccountRole } from "@/domain/accounts"
import type {
  MemberOutcomeValue,
  MemberRegistryEntry,
  RedemptionHistoryRecord,
} from "@/domain/types"

/**
 * Longest response message a Redemption_History outcome row stores
 * (Requirement 3.1). "Character" is one UTF-16 code unit, the same reading
 * `src/domain/responseParser.ts` already applies to the same limit, so
 * truncation is `String.prototype.slice` and `responseMessage.length <= 500`
 * holds for every input.
 */
export const MAX_RESPONSE_MESSAGE_CHARS = 500

/**
 * Largest number of outcome rows a Redemption_History Store_Document is
 * expected to hold (Requirement 3.1). The Member_Registry cap of 100 entries
 * (Requirement 2.5) already guarantees it, so the mapping asserts nothing and
 * drops no row: silently discarding rows would make the round trip of
 * Requirement 3.9 untrue for the record it discarded from.
 */
export const MAX_HISTORY_OUTCOME_ROWS = 100

/** A Member_Registry Store_Document, as the `members` collection holds it. */
export interface MemberDocument {
  _id: ObjectId
  /**
   * The domain `id`, a surrogate key. Kept separate from `_id` so an entry
   * keeps its identity through any future re-insert, and so nothing in the
   * domain has to know about BSON.
   */
  entryId: string
  /** 1..40 characters, whitespace-trimmed. */
  memberLabel: string
  /** 1..64 characters, whitespace-trimmed, unique (Requirement 1.7). */
  hiveId: string
  enabled: boolean
  createdAt: Date
  /**
   * Roster order (Requirement 2.2). Strictly greater than every existing value
   * (Requirement 2.1), and supplied by the counter rather than by the mapping.
   */
  position: number
}

/** A Redemption_History Store_Document, as the `history` collection holds it. */
export interface HistoryDocument {
  _id: ObjectId
  /** 1..64 characters. */
  runId: string
  /** The append counter value (Requirement 3.2). */
  seq: number
  /** 1..64 characters. */
  couponCode: string
  /** ISO 8601, exactly as the domain holds it. Authoritative. */
  completedAt: string
  /** Epoch milliseconds, derived from {@link completedAt} for the sort and the index. */
  completedAtMs: number
  mock: boolean
  stoppedEarly: boolean
  /** One row per enabled Group_Member of the run, in processing order. */
  outcomes: HistoryOutcomeDocument[]
}

/** One denormalized outcome row of a Redemption_History Store_Document. */
export interface HistoryOutcomeDocument {
  hiveId: string
  memberLabel: string
  outcome: MemberOutcomeValue
  responseCode: string
  /** 0..500 characters; a longer value keeps its first 500. */
  responseMessage: string
}

/** A User_Account Store_Document, as the `user_accounts` collection holds it. */
export interface UserAccountDocument {
  _id: ObjectId
  /** Requirement 5.4 restated: the Clerk user id is the key. Uniquely indexed. */
  clerkUserId: string
  /** The email address exactly as the Identity_Provider asserted it. */
  email: string
  /**
   * The same address folded, pre-computed so the Requirement 8.2 tiebreak is a
   * database sort rather than a comparator, and so the index can serve it.
   */
  emailLower: string
  /** <= 100 characters; the email address when the provider asserted no name. */
  displayName: string
  role: AccountRole
  lastSignInAt: Date
  lastSyncedAt: Date
  lastSessionId: string
}

/**
 * The counters the store keeps. Declared here beside {@link CounterDocument}
 * rather than in `counters.server.ts`, so the document shape and the set of
 * legal `_id` values cannot drift apart; `counters.server.ts` re-exports it.
 */
export type CounterName = "history_seq" | "member_position"

/** A counter Store_Document. Keyed by its own name, so there is one per counter. */
export interface CounterDocument {
  _id: CounterName
  value: number
}

/**
 * A Member_Registry Store_Document before insertion. `_id` is the driver's to
 * assign, so the mapping never invents one.
 */
export type MemberDocumentInput = Omit<MemberDocument, "_id">

/** A Redemption_History Store_Document before insertion. */
export type HistoryDocumentInput = Omit<HistoryDocument, "_id">

/**
 * Epoch milliseconds for a completion timestamp.
 *
 * An unparsable timestamp yields 0 rather than `NaN`: a `NaN` double would make
 * the Requirement 3.4 sort and the `completedAtMs` index behave unpredictably,
 * whereas 0 sorts such a record as the oldest, deterministically. The domain
 * never produces an unparsable value — `RedemptionHistoryRecord.completedAt` is
 * always `toISOString()` output — and the Data_Import skips records holding no
 * completion timestamp (Requirement 4.7), so this branch is a guard rather than
 * a code path either of them takes.
 */
function toEpochMs(completedAt: string): number {
  const ms = new Date(completedAt).getTime()
  return Number.isFinite(ms) ? ms : 0
}

/** The response message a Store_Document holds: the first 500 characters. */
function truncateResponseMessage(message: string): string {
  return message.length > MAX_RESPONSE_MESSAGE_CHARS
    ? message.slice(0, MAX_RESPONSE_MESSAGE_CHARS)
    : message
}

/**
 * A Member_Registry entry as a Store_Document (Requirement 2.10).
 *
 * `position` is a parameter rather than a derived value because roster order is
 * the domain's contract and `position` is only how the database keeps it: the
 * counter assigns it (Requirement 2.1), not this function.
 */
export function toMemberDocument(
  entry: MemberRegistryEntry,
  position: number
): MemberDocumentInput {
  return {
    entryId: entry.id,
    memberLabel: entry.memberLabel,
    hiveId: entry.hiveId,
    enabled: entry.enabled,
    createdAt: new Date(entry.createdAt),
    position,
  }
}

/**
 * A Store_Document as a Member_Registry entry (Requirement 2.10). `position`
 * and `_id` are dropped: neither is a domain field.
 *
 * The parameter type omits `_id` so a freshly mapped document round-trips
 * without one (Requirement 2.11); a `MemberDocument` read back from the
 * collection satisfies it just as well.
 */
export function fromMemberDocument(
  document: MemberDocumentInput
): MemberRegistryEntry {
  return {
    id: document.entryId,
    memberLabel: document.memberLabel,
    hiveId: document.hiveId,
    enabled: document.enabled,
    createdAt: document.createdAt.toISOString(),
  }
}

/**
 * A Redemption_History record as a Store_Document (Requirements 3.1, 3.8).
 *
 * Every outcome row is copied into a fresh object, so a caller that keeps a
 * reference to the record it appended cannot reach into what the store now
 * holds. Row order is preserved, and each response message is truncated to its
 * first 500 characters.
 */
export function toHistoryDocument(
  record: RedemptionHistoryRecord
): HistoryDocumentInput {
  return {
    runId: record.runId,
    seq: record.seq,
    couponCode: record.couponCode,
    completedAt: record.completedAt,
    completedAtMs: toEpochMs(record.completedAt),
    mock: record.mock,
    stoppedEarly: record.stoppedEarly,
    outcomes: record.outcomes.map((outcome) => ({
      hiveId: outcome.hiveId,
      memberLabel: outcome.memberLabel,
      outcome: outcome.outcome,
      responseCode: outcome.responseCode,
      responseMessage: truncateResponseMessage(outcome.responseMessage),
    })),
  }
}

/**
 * A Store_Document as a Redemption_History record (Requirement 3.8).
 *
 * `completedAt` comes back as the stored string, character for character;
 * `completedAtMs` is derived data and is never read back into the domain. Each
 * outcome row is copied into a fresh object for the same reason as on the way
 * in: a caller must not be handed a reference into stored history.
 */
export function fromHistoryDocument(
  document: HistoryDocumentInput
): RedemptionHistoryRecord {
  return {
    runId: document.runId,
    seq: document.seq,
    couponCode: document.couponCode,
    completedAt: document.completedAt,
    mock: document.mock,
    stoppedEarly: document.stoppedEarly,
    outcomes: document.outcomes.map((outcome) => ({
      hiveId: outcome.hiveId,
      memberLabel: outcome.memberLabel,
      outcome: outcome.outcome,
      responseCode: outcome.responseCode,
      responseMessage: outcome.responseMessage,
    })),
  }
}
