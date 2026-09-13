/**
 * Every sentence the Mongo_Store surfaces when an operation cannot be served
 * (Requirements 1.3, 1.5, 1.6, 2.8, 2.14, 3.7, 3.10, 6.15, 8.5).
 *
 * This module exists for the same reason `src/domain/rosterMessages.ts` does:
 * the store is a `.server` module, but the sentences it produces are rendered by
 * the roster page, the history page, and the Admin_Page, all of which are in the
 * browser bundle. Declaring the sentences here lets the store, the server
 * functions, the pages, and the tests all assert one string without pulling the
 * MongoDB driver along.
 *
 * Requirement 1.6 is the reason every sentence is fixed text: no function here
 * interpolates a driver error, a host name, or any part of the
 * Mongo_Connection_URI. {@link rosterWriteFailedMessage} is the only function
 * that interpolates at all, and it interpolates only what its caller supplied —
 * a Member_Label and the operation that was attempted.
 */

/** Environment variable that carries the Mongo_Connection_URI. */
const MONGODB_URI_VARIABLE = "MONGODB_URI"

/**
 * The answer to every store operation while no Mongo_Database is configured,
 * whether because `MONGODB_URI` is absent or blank (Requirement 1.3) or because
 * its value did not parse (Requirement 1.10). It names the variable, which is
 * the one thing the operator needs, and no part of its value.
 */
export function notConfiguredMessage(): string {
  return `No database is configured. Set the ${MONGODB_URI_VARIABLE} environment variable and restart the server.`
}

/**
 * The answer to a store operation that the database did not answer within the
 * 5-second bound (Requirement 1.5) or that arrived before the connection was
 * established (Requirement 1.11). It names neither the Mongo_Connection_URI nor
 * any part of it — not the host, not the credentials (Requirement 1.6).
 */
export function unreachableMessage(): string {
  return "The database is unreachable. Nothing was changed. Try again in a moment."
}

/** The answer to a roster read that did not complete (Requirement 2.14). */
export function rosterReadFailedMessage(): string {
  return "The roster could not be read. Try again in a moment."
}

/** The roster write operations a {@link RosterWriteChange} can describe. */
export type RosterWriteOperation = "add" | "remove" | "enable" | "disable"

/**
 * The attempted change that Requirement 2.8 asks a failed-write message to name.
 * Both fields come from the caller: the operation it was performing and the
 * Member_Label it was performing it on.
 */
export interface RosterWriteChange {
  readonly operation: RosterWriteOperation
  /** The Member_Label of the entry the change addressed. */
  readonly memberLabel: string
}

/**
 * The answer to a Member_Registry write that did not complete (Requirement 2.8).
 * It states that the change was not saved and names the attempted change, so the
 * Group_Member learns both that the roster is unchanged and which change is
 * missing from it.
 */
export function rosterWriteFailedMessage(change: RosterWriteChange): string {
  return `The change was not saved: ${change.operation} "${change.memberLabel}". The roster is unchanged. Try again in a moment.`
}

/** The answer to a Redemption_History read that did not complete (Requirement 3.10). */
export function historyReadFailedMessage(): string {
  return "The Redemption_History could not be read. Try again in a moment."
}

/**
 * The single warning that accompanies the Member_Outcomes of a Redemption_Run
 * whose history append failed (Requirement 3.7). The run's outcomes are still
 * returned, so the sentence speaks only about the record.
 */
export function historyAppendFailedMessage(): string {
  return "The Redemption_History record was not saved. The results above are complete."
}

/**
 * The answer to a request for an Admin_Page value whose Account_Role could not
 * be read (Requirement 6.15) — no User_Account record, or no answer inside the
 * 5-second bound. It says the authorization could not be determined, which is
 * neither "you are not authorized" nor "you are not signed in".
 */
export function authorizationUnknownMessage(): string {
  return "The authorization of the request could not be determined. Try again in a moment."
}

/**
 * The answer to a request for an Admin_Page value from a signed-in account
 * holding the Member_Role (Requirements 6.6, 6.7). Endpoints use it instead of
 * a sign-in redirect, because the caller is already signed in.
 */
export function notAuthorizedMessage(): string {
  return "The signed-in account is not authorized to reach the admin page."
}

/**
 * Stands in the position of an Admin_Page count that the read could not supply
 * (Requirement 8.5). Short, because it renders where an integer would.
 */
export function mongoUnavailableCountMessage(): string {
  return "The database is unreachable."
}
