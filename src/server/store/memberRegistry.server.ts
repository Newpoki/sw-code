/**
 * Member_Registry semantics on top of the {@link JsonStore} document
 * (Requirements 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 1.9, 1.11, 1.12).
 *
 * This module owns the roster invariants and nothing else: it does not read the
 * environment, does not touch the filesystem, and does not compose HTTP-shaped
 * errors. It reports *what happened* as a discriminated result, and
 * `src/functions/members.functions.ts` turns that into an {@link
 * import("@/domain/types").Envelope}.
 *
 * ## Invariants enforced on every mutation
 *
 * - `members` stays append-ordered. `list()` returns it in that order, which is
 *   both the roster order of Requirement 1.4 and the processing order of
 *   Requirement 5.5. Nothing here sorts, and `remove` closes the gap without
 *   reordering the survivors.
 * - `hiveId` is unique across `members` under exact character comparison after
 *   trimming, upper case distinguished from lower case (Requirement 1.2).
 * - `members.length <= 100` (Requirement 1.11).
 * - A stored `memberLabel` holds 1 to 40 characters and a stored `hiveId` holds
 *   1 to 64 characters, both already trimmed (Requirement 1.1).
 *
 * ## Rejections never mutate
 *
 * Every rejection branch — `invalid`, `duplicate`, `full`, `not-found` — returns
 * before {@link JsonStore.mutate} is called, so no document change is applied
 * and no flush is enqueued (Requirements 1.2, 1.3, 1.11). A rejection therefore
 * carries no `persisted` flag: there was nothing to persist.
 *
 * ## Why the mutators return promises
 *
 * The design sketch shows `add`, `setEnabled`, and `remove` returning
 * `persisted` synchronously. A real flush cannot be known synchronously, and
 * the design prose settles it the other way ("Writes are serialized through a
 * single promise chain … resolve the caller with `persisted: true | false` once
 * the flush settles"). So the three mutators are async and `persisted` is the
 * settled truth: true when the write landed (Requirement 1.12), false when it
 * failed (Requirement 1.8). Either way the change is already visible to the
 * next `list()`, because `JsonStore.mutate` applies the mutator synchronously
 * and never rolls it back.
 *
 * `list()` and `listEnabled()` stay synchronous: they are reads of the
 * in-memory document.
 *
 * ## Validation lives in two places on purpose
 *
 * The server function layer attaches the zod validator from
 * `src/domain/schemas.ts`, so an HTTP caller is rejected before reaching this
 * module. The same schemas are applied again here, because the invariant above
 * has to hold for *every* caller — a test, a script, a future job — not just for
 * the ones that arrive through a server function. The duplicated check costs a
 * trim and two length comparisons and uses the identical message text, so the
 * two layers cannot disagree.
 */

import { randomUUID } from "node:crypto"

import {
  MEMBER_REGISTRY_MAX_ENTRIES,
  duplicateHiveIdMessage,
  memberNotFoundMessage,
  rosterFullMessage,
} from "@/domain/rosterMessages"
import {
  firstErrorMessage,
  hiveIdSchema,
  memberLabelSchema,
} from "@/domain/schemas"
import { getJsonStore } from "@/server/store/jsonStore.server"
import type { JsonStore } from "@/server/store/jsonStore.server"
import type { MemberRegistryEntry } from "@/domain/types"

/**
 * The cap of Requirement 1.11 and the three rejection sentences, declared in
 * `src/domain/rosterMessages.ts` because the client-reachable envelope mapping
 * needs the identical text and may not import this module, and re-exported here
 * so this store stays the one import path callers already use.
 */
export {
  MEMBER_REGISTRY_MAX_ENTRIES,
  duplicateHiveIdMessage,
  memberNotFoundMessage,
  rosterFullMessage,
}

/** The field an `invalid` add rejection names. */
export type MemberField = "memberLabel" | "hiveId"

/** Outcome of {@link MemberRegistryStore.add}. */
export type AddMemberResult =
  | {
      readonly kind: "added"
      readonly entry: MemberRegistryEntry
      /** False when the flush for this add failed (Requirement 1.8). */
      readonly persisted: boolean
    }
  /** Requirement 1.2: `conflictingLabel` is the Member_Label already holding that Hive_ID. */
  | { readonly kind: "duplicate"; readonly conflictingLabel: string }
  /** Requirement 1.11: the roster already holds {@link MEMBER_REGISTRY_MAX_ENTRIES} entries. */
  | { readonly kind: "full" }
  /** Requirement 1.3: a blank or over-long value, with the message naming the field and its range. */
  | {
      readonly kind: "invalid"
      readonly field: MemberField
      readonly message: string
    }

/** Outcome of {@link MemberRegistryStore.setEnabled} (Requirement 1.9). */
export type SetEnabledResult =
  | {
      readonly kind: "updated"
      readonly entry: MemberRegistryEntry
      readonly persisted: boolean
    }
  | { readonly kind: "not-found" }

/** Outcome of {@link MemberRegistryStore.remove} (Requirement 1.5). */
export type RemoveMemberResult =
  | { readonly kind: "removed"; readonly persisted: boolean }
  | { readonly kind: "not-found" }

/** What {@link MemberRegistryStore.add} accepts. Values may be untrimmed. */
export interface AddMemberFields {
  readonly memberLabel: string
  readonly hiveId: string
}

/**
 * The Member_Registry seam. It exposes no JSON-specific concept, so a different
 * persistence layer can be swapped in behind it without touching callers.
 */
export interface MemberRegistryStore {
  /** Every entry in insertion order (Requirement 1.4). */
  list: () => MemberRegistryEntry[]
  /** The enabled entries only, in the same insertion order (Requirement 1.6). */
  listEnabled: () => MemberRegistryEntry[]
  /** Requirements 1.1, 1.2, 1.3, 1.11, 1.12. */
  add: (input: AddMemberFields) => Promise<AddMemberResult>
  /** Requirement 1.9. */
  setEnabled: (id: string, enabled: boolean) => Promise<SetEnabledResult>
  /** Requirement 1.5. */
  remove: (id: string) => Promise<RemoveMemberResult>
}

export interface MemberRegistryOptions {
  /**
   * Surrogate key generator. Defaults to `crypto.randomUUID()`. Injected so a
   * test can produce deterministic ids; a generated value that is already in
   * use is disambiguated rather than trusted (see {@link freshId}).
   */
  readonly generateId?: () => string
  /** Clock behind `createdAt`. Defaults to the system clock. */
  readonly now?: () => Date
}

/** The validated, trimmed form of an add submission, or the first rejection. */
type ValidatedFields =
  | { readonly ok: true; readonly memberLabel: string; readonly hiveId: string }
  | {
      readonly ok: false
      readonly field: MemberField
      readonly message: string
    }

/**
 * Trims and length-checks both values through the shared schemas, so the
 * message a non-HTTP caller sees is character-identical to the one the server
 * function layer produces (Requirement 1.3). The Member_Label is checked first,
 * so a submission that violates both rules names the first field of the form.
 */
function validate(input: AddMemberFields): ValidatedFields {
  const label = memberLabelSchema.safeParse(input.memberLabel)
  if (!label.success) {
    return {
      ok: false,
      field: "memberLabel",
      message: firstErrorMessage(label.error),
    }
  }

  const hiveId = hiveIdSchema.safeParse(input.hiveId)
  if (!hiveId.success) {
    return {
      ok: false,
      field: "hiveId",
      message: firstErrorMessage(hiveId.error),
    }
  }

  return { ok: true, memberLabel: label.data, hiveId: hiveId.data }
}

/**
 * An id no current entry holds.
 *
 * `crypto.randomUUID()` collides with negligible probability, but an injected
 * generator (a counter, a shrunk fast-check value) can repeat, and two entries
 * sharing an id would make `setEnabled` and `remove` ambiguous. A repeat is
 * therefore disambiguated with a numeric suffix instead of being trusted.
 */
function freshId(taken: ReadonlySet<string>, generateId: () => string): string {
  const candidate = generateId()
  if (!taken.has(candidate)) {
    return candidate
  }
  for (let suffix = 2; ; suffix += 1) {
    const disambiguated = `${candidate}-${suffix}`
    if (!taken.has(disambiguated)) {
      return disambiguated
    }
  }
}

/**
 * Builds a Member_Registry over `store`.
 *
 * Holds no state of its own: every read and every write goes through the
 * document `store` owns, so two registries built over the same store see the
 * same roster.
 */
export function createMemberRegistryStore(
  store: JsonStore,
  options: MemberRegistryOptions = {}
): MemberRegistryStore {
  const generateId = options.generateId ?? (() => randomUUID())
  const now = options.now ?? (() => new Date())

  /** The current entries. A copy, so a caller cannot splice the document. */
  const members = (): MemberRegistryEntry[] => [...store.read().members]

  const indexOfId = (id: string): number =>
    store.read().members.findIndex((entry) => entry.id === id)

  return {
    list: members,

    listEnabled: () => members().filter((entry) => entry.enabled),

    /**
     * Validation, then the uniqueness check, then the cap — each of the three
     * returning before anything is written.
     *
     * The order matters when more than one rule is violated. A duplicate
     * Hive_ID is reported ahead of a full roster because it is the more
     * specific problem and the more actionable message: the Group_Member is
     * already registered, so there is nothing to add and no entry to prune.
     */
    add: async (input) => {
      const validated = validate(input)
      if (!validated.ok) {
        return {
          kind: "invalid",
          field: validated.field,
          message: validated.message,
        }
      }

      const current = store.read().members
      const conflict = current.find(
        (entry) => entry.hiveId === validated.hiveId
      )
      if (conflict !== undefined) {
        return { kind: "duplicate", conflictingLabel: conflict.memberLabel }
      }

      if (current.length >= MEMBER_REGISTRY_MAX_ENTRIES) {
        return { kind: "full" }
      }

      const entry: MemberRegistryEntry = {
        id: freshId(
          new Set(current.map((existing) => existing.id)),
          generateId
        ),
        memberLabel: validated.memberLabel,
        hiveId: validated.hiveId,
        enabled: true,
        createdAt: now().toISOString(),
      }

      /*
       * The mutator runs synchronously inside `mutate`, so the entry is on the
       * roster before this function suspends. The checks above therefore cannot
       * be raced by a second `add` awaiting its own flush: that caller re-reads
       * the document and sees this entry.
       */
      const { value, persisted } = await store.mutate((document) => {
        document.members.push(entry)
        return entry
      })

      return { kind: "added", entry: value, persisted }
    },

    /**
     * Stores the submitted enabled state (Requirement 1.9). The write happens
     * even when the state already matches, so `persisted` always answers the
     * question the caller asked — whether this change is durable — rather than
     * silently reporting a stale earlier flush.
     */
    setEnabled: async (id, enabled) => {
      const index = indexOfId(id)
      if (index === -1) {
        return { kind: "not-found" }
      }

      const { value, persisted } = await store.mutate((document) => {
        const updated: MemberRegistryEntry = {
          ...document.members[index],
          enabled,
        }
        document.members[index] = updated
        return updated
      })

      return { kind: "updated", entry: value, persisted }
    },

    /**
     * Deletes the entry and closes the gap, leaving the order of the survivors
     * untouched. The Redemption_History is not consulted: its outcome rows
     * carry their own `memberLabel` and `hiveId`, so a deletion cannot alter,
     * renumber, or remove a history record (Requirement 1.5).
     */
    remove: async (id) => {
      const index = indexOfId(id)
      if (index === -1) {
        return { kind: "not-found" }
      }

      const { persisted } = await store.mutate((document) => {
        document.members.splice(index, 1)
      })

      return { kind: "removed", persisted }
    },
  }
}

/**
 * A Member_Registry over the process-wide {@link JsonStore}.
 *
 * A fresh, stateless wrapper is returned on every call, so installing another
 * store with `setJsonStore` cannot leave a caller holding a registry bound to
 * the previous document.
 */
export function getMemberRegistryStore(
  options: MemberRegistryOptions = {}
): MemberRegistryStore {
  return createMemberRegistryStore(getJsonStore(), options)
}
