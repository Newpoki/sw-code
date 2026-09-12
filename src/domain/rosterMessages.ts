/**
 * The Member_Registry cap and the three roster rejection sentences
 * (Requirements 1.2, 1.11).
 *
 * These belong to the store — `src/server/store/memberRegistry.server.ts` is
 * what enforces the cap and detects the duplicate — but they are declared here,
 * next to the schemas, for the same reason `HISTORY_RETENTION_LIMIT` lives in
 * `src/domain/types.ts`: the client-visible surface needs the identical text.
 *
 * `src/functions/members.functions.ts` maps a store result onto an
 * {@link import("@/domain/types").Envelope}, and that mapping is reachable from
 * the roster page, so every module it imports at module scope ends up in the
 * browser bundle. A `.server` module may not, and must not: it reaches for
 * `node:crypto` and the filesystem. Keeping the sentences here lets the mapping
 * render them without pulling the store along, while the store re-exports all
 * four bindings so there is still exactly one definition of each and every
 * existing import path keeps working.
 */

/** Maximum number of Member_Registry entries (Requirement 1.11). */
export const MEMBER_REGISTRY_MAX_ENTRIES = 100

/**
 * The rejection message for a full roster (Requirement 1.11). It states the
 * maximum, so the Group_Member learns the limit and not merely that they hit it.
 */
export function rosterFullMessage(): string {
  return `The roster already holds the maximum of ${MEMBER_REGISTRY_MAX_ENTRIES} entries. Remove an entry before adding another.`
}

/**
 * The rejection message for a duplicate Hive_ID. It names the Member_Label of
 * the conflicting entry, which is exactly what Requirement 1.2 demands, and
 * says nothing about the Hive_ID itself beyond the fact that it is taken.
 */
export function duplicateHiveIdMessage(conflictingLabel: string): string {
  return `That Hive_ID is already registered for ${conflictingLabel}.`
}

/** The rejection message for an id that matches no entry. */
export function memberNotFoundMessage(): string {
  return "That roster entry no longer exists. Reload the roster and try again."
}
