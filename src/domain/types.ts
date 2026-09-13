/**
 * Shared domain types for shared-coupon-redemption.
 *
 * This module is client-safe: it declares types and one frozen constant tuple,
 * and imports nothing from `src/server/`.
 */

/** The six allowed Member_Outcome values, in the order the summary renders them. */
export const MEMBER_OUTCOME_VALUES = [
  "SUCCESS",
  "ALREADY_USED",
  "INVALID_COUPON",
  "SKIPPED",
  "UPSTREAM_ERROR",
  "TRANSPORT_ERROR",
] as const

export type MemberOutcomeValue = (typeof MEMBER_OUTCOME_VALUES)[number]

/** A Member_Registry entry as stored and as returned to the Web_Client. */
export interface MemberRegistryEntry {
  /** Stable surrogate key; the Hive_ID is the uniqueness key but is not used as the id. */
  readonly id: string
  /** 1..40 chars, whitespace-trimmed. */
  readonly memberLabel: string
  /** 1..64 chars, whitespace-trimmed, unique. */
  readonly hiveId: string
  readonly enabled: boolean
  /** ISO 8601. Persisted for auditing; roster order is array order, not this field. */
  readonly createdAt: string
}

/** Upstream_Result: the typed output of the Response_Parser. */
export interface UpstreamResult {
  /** Normalized response code: <= 100 chars, '' only for TRANSPORT_ERROR. */
  readonly responseCode: string
  /** Response message: <= 500 chars, '' when retMsg was absent/null/non-string. */
  readonly responseMessage: string
  readonly outcome: MemberOutcomeValue
}

/** Member_Outcome: exactly one per enabled Group_Member of a Redemption_Run. */
export type MemberOutcome =
  | {
      readonly hiveId: string
      readonly memberLabel: string
      /** Position in the fixed list of the Redemption_Run, 0-based. */
      readonly position: number
      readonly outcome: Exclude<MemberOutcomeValue, "SKIPPED">
      /** Present for every outcome derived from (or in place of) an upstream response. */
      readonly upstreamResult: UpstreamResult
    }
  | {
      readonly hiveId: string
      readonly memberLabel: string
      readonly position: number
      readonly outcome: "SKIPPED"
      /** No Upstream_API request was issued for this Group_Member. */
      readonly upstreamResult: null
    }

export type OutcomeCounts = Readonly<Record<MemberOutcomeValue, number>>

/** The complete result set of one Redemption_Run. */
export interface RedemptionRunResult {
  readonly runId: string
  readonly couponCode: string
  /** ISO 8601. */
  readonly completedAt: string
  readonly mock: boolean
  /** True when an INVALID_COUPON outcome or a server failure ended the run early. */
  readonly stoppedEarly: boolean
  /** One entry per enabled Group_Member of the fixed list, in processing order. */
  readonly outcomes: readonly MemberOutcome[]
  /** All six keys always present, including zero counts. */
  readonly counts: OutcomeCounts
  /** Non-fatal notices, e.g. a failed Redemption_History append. */
  readonly warnings: readonly string[]
}

/** Progress snapshot of the Redemption_Run currently in progress, if any. */
export interface ActiveRunSnapshot {
  readonly runId: string
  readonly couponCode: string
  readonly startedAt: string
  readonly mock: boolean
  /** Size of the fixed list. */
  readonly total: number
  /** Outcomes recorded so far. */
  readonly processed: number
  readonly outcomes: readonly MemberOutcome[]
}

/** Events streamed by the redemption server function. */
export type RunEvent =
  | {
      readonly type: "run-started"
      readonly runId: string
      readonly total: number
      readonly memberLabels: readonly string[]
      readonly mock: boolean
    }
  | {
      readonly type: "member-outcome"
      readonly runId: string
      readonly processed: number
      readonly total: number
      readonly outcome: MemberOutcome
    }
  | {
      readonly type: "run-completed"
      readonly runId: string
      readonly result: RedemptionRunResult
    }
  | {
      readonly type: "run-failed"
      readonly runId: string
      readonly message: string
      /** Still complete: SKIPPED for every Group_Member with no request issued. */
      readonly result: RedemptionRunResult
    }

/** A Redemption_History record. Outcomes are denormalized so deleting a
 *  Member_Registry entry cannot alter or remove history (Requirement 1.5).
 *  Holds no submitter field: see Decision B. */
export interface RedemptionHistoryRecord {
  readonly runId: string
  /** Monotonic append counter; breaks completedAt ties (Requirement 6.6). */
  readonly seq: number
  readonly couponCode: string
  readonly completedAt: string
  readonly mock: boolean
  readonly stoppedEarly: boolean
  readonly outcomes: readonly {
    readonly hiveId: string
    readonly memberLabel: string
    readonly outcome: MemberOutcomeValue
    readonly responseCode: string
    readonly responseMessage: string
  }[]
}

/**
 * How many Redemption_History records are retained (Requirement 6.5 asks for at
 * least 100).
 *
 * Declared here rather than in `src/server/store/history.server.ts`, which owns
 * the trim, because the client-visible read surface needs the same number: the
 * largest `limit` `listHistory` accepts is the retention window, and the history
 * page is in the browser bundle, which no `.server` module may enter. The store
 * re-exports this constant, so there is still one number.
 */
export const HISTORY_RETENTION_LIMIT = 200

/**
 * Why a store operation could not be served.
 *
 * `not-configured` is the absent, blank, or unparsable `MONGODB_URI`
 * (Requirements 1.3, 1.10); `unreachable` is no answer inside the 5-second bound
 * or no connection yet (Requirements 1.5, 1.11); `rejected` is a database that
 * answered with an error.
 */
export type StoreFailureReason = "not-configured" | "unreachable" | "rejected"

/** A store operation that was not served. The collection is unchanged. */
export interface StoreFailure {
  readonly reason: StoreFailureReason
  /**
   * A fixed sentence from `src/domain/storeMessages.ts`. Never a driver message,
   * and never any part of the Mongo_Connection_URI (Requirement 1.6).
   */
  readonly message: string
}

/** Rejection codes carried by a failed {@link Envelope}. */
export type AppErrorCode =
  | "VALIDATION"
  | "DUPLICATE_HIVE_ID"
  | "ROSTER_FULL"
  | "MEMBER_NOT_FOUND"
  | "NO_ENABLED_MEMBERS"
  | "RUN_IN_PROGRESS"
  | "FIXTURE_UNAVAILABLE"
  /** No Mongo_Database is configured, or none is reachable (Requirements 1.3, 1.5, 1.10, 1.11). */
  | "STORE_UNAVAILABLE"
  /** A roster or Redemption_History read did not complete (Requirements 2.14, 3.10). */
  | "STORE_READ_FAILED"
  /** A Member_Registry write did not complete; the collection is unchanged (Requirement 2.8). */
  | "STORE_WRITE_FAILED"
  /** The request carries no valid User_Session (Requirement 6.5). */
  | "NOT_AUTHENTICATED"
  /** The signed-in account holds the Member_Role (Requirements 6.6, 6.7). */
  | "NOT_AUTHORIZED"
  /** The Account_Role of the bound User_Account could not be read (Requirement 6.15). */
  | "AUTHORIZATION_UNKNOWN"

/**
 * Discriminated result envelope returned by every server function instead of
 * throwing. `warnings` is empty on a successful write whose flush succeeded
 * (Requirement 1.12) and carries exactly one persistence warning when the
 * flush failed (Requirement 1.8).
 */
export type Envelope<T> =
  | {
      readonly ok: true
      readonly data: T
      readonly warnings: readonly string[]
    }
  | {
      readonly ok: false
      readonly error: { readonly code: AppErrorCode; readonly message: string }
    }
