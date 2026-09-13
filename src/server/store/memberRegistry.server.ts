/**
 * Member_Registry semantics over the `members` collection of the Mongo_Store
 * (Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.12, 2.13, 2.14).
 *
 * This module owns the roster invariants and nothing else: it does not read the
 * environment, does not construct a `MongoClient`, and does not compose
 * HTTP-shaped errors. It reports *what happened* as a discriminated result, and
 * `src/functions/members.functions.ts` turns that into an {@link
 * import("@/domain/types").Envelope}.
 *
 * ## What changed with MongoDB
 *
 * Every method is `async`, including the two reads: a read is a round trip to a
 * deployment that may not answer, so it can fail, and both reads therefore carry
 * a `failed` variant (Requirement 2.14). No result carries `persisted` any more.
 * A `kind` of `added`, `updated`, or `removed` means the write is in the
 * database, which is what Requirement 2.9 asks for — there is no
 * applied-but-not-saved state left to warn about, and Requirement 2.8
 * supersedes the in-memory-with-warning behaviour the JSON store had.
 *
 * ## Invariants
 *
 * - Roster order is the `position` field, ascending, assigned by the
 *   `member_position` counter (Requirements 2.1, 2.2). Both reads sort in the
 *   database, so nothing here compares positions.
 * - `hiveId` is unique under exact character comparison after trimming, upper
 *   case distinguished from lower case (Requirement 2.4). Enforced twice: see
 *   below.
 * - At most {@link MEMBER_REGISTRY_MAX_ENTRIES} Store_Documents
 *   (Requirement 2.5). Checked, not enforced by the database: see below.
 * - A stored `memberLabel` holds 1 to 40 characters and a stored `hiveId` holds
 *   1 to 64 characters, both already trimmed (Requirements 2.1, 2.12).
 *
 * ## Uniqueness is enforced twice on purpose
 *
 * The pre-read gives Requirement 2.4 the message it needs — the Member_Label of
 * the conflicting entry, which a driver duplicate-key error cannot supply — and
 * the `hiveId_unique` index of Requirement 1.7 gives the invariant teeth under
 * concurrency. An `insertOne` that trips the index after a clean pre-read is
 * mapped back to `duplicate` by re-reading the conflicting entry, and degrades
 * to `failed` when that re-read also fails.
 *
 * ## The cap is checked, not enforced
 *
 * Requirement 2.5 is a `countDocuments` before the insert. Two adds arriving
 * simultaneously at 99 entries can both see 99 and both insert, so the
 * collection can reach 101. That is documented rather than defended: the
 * consequence is bounded and visible — a roster one or two entries over the cap,
 * which the next add rejects — and the alternative is a transaction, therefore a
 * replica set, therefore a deployment requirement nobody asked for.
 *
 * ## Removal renumbers nothing
 *
 * `remove` is one `deleteOne`. There is no renumbering pass, so every remaining
 * `position` keeps its value (Requirement 2.6) and the counter — which only ever
 * goes up — keeps handing out values above all of them. The Redemption_History
 * is not consulted either: its outcome rows carry their own `memberLabel` and
 * `hiveId`, so a deletion cannot alter, renumber, or remove a history record.
 *
 * ## Which sentence a failure speaks with
 *
 * One question decides it: was this failure settled **before** this module
 * attempted anything, or is it the failure of something this module **did**
 * attempt? The two answers get two helpers, so no call site has to restate the
 * reasoning.
 *
 * A failure the Mongo_Store handed back before any attempt keeps its own
 * sentence — an absent or unparsable `MONGODB_URI` (Requirements 1.3, 1.10), or
 * no connection yet (Requirement 1.11) — because each of those requirements asks
 * for exactly the sentence it already carries. `store.collection(...)` performs
 * no driver operation, so those two are the only failures it can report, and its
 * failures go through {@link asOperationFailure}.
 *
 * A failure of an operation this module attempted speaks with the operation's
 * own sentence, whatever went wrong: {@link rosterWriteFailedMessage} naming the
 * attempted change (Requirement 2.8), or {@link rosterReadFailedMessage}
 * (Requirement 2.14). Neither requirement makes an exception for *how* the
 * deployment failed — Requirement 2.8's first clause is a deployment that gave
 * no answer inside its bound, and it still asks for the attempted change by
 * name — so the sentence belongs to the operation and the `reason` on the
 * {@link StoreFailure} is what still tells a timeout from a refusal. Those
 * failures go through {@link asAttemptedOperationFailure}, which is why a
 * counter increment that went unanswered reports as an add that was not saved
 * rather than as a database that cannot be reached: asking the `counters`
 * collection for the next `position` is something this add attempted.
 *
 * No driver message, host name, or fragment of the Mongo_Connection_URI is ever
 * read into a returned value (Requirement 1.6). The one thing this module reads
 * off a caught error is the numeric duplicate-key code.
 *
 * ## Validation lives in two places on purpose
 *
 * The server function layer attaches the zod validator from
 * `src/domain/schemas.ts`, so an HTTP caller is rejected before reaching this
 * module. The same schemas are applied again here, because Requirement 2.12 has
 * to hold for *every* caller — a test, a script, a future job — not just for the
 * ones that arrive through a server function. The duplicated check costs a trim
 * and two length comparisons and uses the identical message text, so the two
 * layers cannot disagree.
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
import {
  rosterReadFailedMessage,
  rosterWriteFailedMessage,
} from "@/domain/storeMessages"
import type { RosterWriteOperation } from "@/domain/storeMessages"
import {
  isCounterFailure,
  nextCounterValue,
} from "@/server/store/counters.server"
import {
  fromMemberDocument,
  toMemberDocument,
} from "@/server/store/documents.server"
import type { MemberDocumentInput } from "@/server/store/documents.server"
import { driverStoreFailure, getMongoStore } from "@/server/store/mongo.server"
import type { MongoStore } from "@/server/store/mongo.server"
import type { MemberRegistryEntry, StoreFailure } from "@/domain/types"
import type { Collection, WithId } from "mongodb"

/**
 * The cap of Requirement 2.5 and the three rejection sentences, declared in
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

/** The field an `invalid` add rejection names (Requirement 2.12). */
export type MemberField = "memberLabel" | "hiveId"

/** Outcome of {@link MemberRegistryStore.list} and {@link MemberRegistryStore.listEnabled}. */
export type ListMembersResult =
  /** Requirement 2.2: position order. An empty collection is zero entries and no error. */
  | {
      readonly kind: "entries"
      readonly entries: readonly MemberRegistryEntry[]
    }
  /** Requirement 2.14: zero entries, the collection unchanged, one fixed sentence. */
  | { readonly kind: "failed"; readonly failure: StoreFailure }

/** Outcome of {@link MemberRegistryStore.add}. */
export type AddMemberResult =
  /** Requirements 2.1, 2.9: the write is in the database. */
  | { readonly kind: "added"; readonly entry: MemberRegistryEntry }
  /** Requirement 2.4: `conflictingLabel` is the Member_Label already holding that Hive_ID. */
  | { readonly kind: "duplicate"; readonly conflictingLabel: string }
  /** Requirement 2.5: the collection already holds {@link MEMBER_REGISTRY_MAX_ENTRIES}. */
  | { readonly kind: "full" }
  /** Requirement 2.12: a blank or over-long value, the message naming the field and its range. */
  | {
      readonly kind: "invalid"
      readonly field: MemberField
      readonly message: string
    }
  /** Requirement 2.8: nothing was inserted; the collection is unchanged. */
  | { readonly kind: "failed"; readonly failure: StoreFailure }

/** Outcome of {@link MemberRegistryStore.setEnabled} (Requirements 2.7, 2.13). */
export type SetEnabledResult =
  | { readonly kind: "updated"; readonly entry: MemberRegistryEntry }
  | { readonly kind: "not-found" }
  | { readonly kind: "failed"; readonly failure: StoreFailure }

/** Outcome of {@link MemberRegistryStore.remove} (Requirements 2.6, 2.13). */
export type RemoveMemberResult =
  | { readonly kind: "removed" }
  | { readonly kind: "not-found" }
  | { readonly kind: "failed"; readonly failure: StoreFailure }

/** What {@link MemberRegistryStore.add} accepts. Values may be untrimmed. */
export interface AddMemberFields {
  readonly memberLabel: string
  readonly hiveId: string
}

/**
 * The Member_Registry seam. It exposes no MongoDB concept — no `Collection`, no
 * `ObjectId`, no `position` — so the persistence layer behind it can change
 * again without touching callers.
 */
export interface MemberRegistryStore {
  /** Every entry, lowest `position` first (Requirements 2.2, 2.3, 2.14). */
  list: () => Promise<ListMembersResult>
  /** The enabled entries only, in the same order (Requirements 2.2, 2.14). */
  listEnabled: () => Promise<ListMembersResult>
  /** Requirements 2.1, 2.4, 2.5, 2.8, 2.9, 2.12. */
  add: (input: AddMemberFields) => Promise<AddMemberResult>
  /** Requirements 2.7, 2.8, 2.9, 2.13. */
  setEnabled: (id: string, enabled: boolean) => Promise<SetEnabledResult>
  /** Requirements 2.6, 2.8, 2.13. */
  remove: (id: string) => Promise<RemoveMemberResult>
}

export interface MemberRegistryOptions {
  /**
   * Surrogate key generator. Defaults to `crypto.randomUUID()`. Injected so a
   * test can produce deterministic ids; a generated value that is already in
   * use is disambiguated rather than trusted (see {@link freshEntryId}).
   */
  readonly generateId?: () => string
  /** Clock behind `createdAt`. Defaults to the system clock. */
  readonly now?: () => Date
}

/**
 * Stands in for the Member_Label of an entry whose Store_Document could not be
 * read, so that {@link rosterWriteFailedMessage} still names *a* subject when
 * the read that would have supplied the label is the thing that failed. Every
 * path that reaches the label uses the label.
 */
export const UNKNOWN_MEMBER_LABEL = "the selected entry"

/** The MongoDB duplicate-key error code. */
const DUPLICATE_KEY_CODE = 11_000

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
 * function layer produces (Requirement 2.12). The Member_Label is checked
 * first, so a submission that violates both rules names the first field of the
 * form.
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
 * Re-speaks a {@link StoreFailure} that was settled **before** this module
 * attempted anything — the failure of a `store.collection(...)` call, which
 * performs no driver operation.
 *
 * `not-configured` and `unreachable` keep their own sentence: an absent or
 * unparsable `MONGODB_URI` (Requirements 1.3, 1.10) and a connection that does
 * not exist yet (Requirement 1.11) are the only two failures a handle lookup can
 * report, and each of those requirements asks for exactly the sentence it
 * already carries — naming the variable, or stating that the database is
 * unreachable.
 *
 * `rejected` means the database answered, and its answer was no, to something
 * this operation asked for. That is Requirement 2.8's and Requirement 2.14's
 * case, so the sentence becomes the operation's own and the `reason` is what
 * still says why.
 *
 * For the failure of something this module *did* attempt, use
 * {@link asAttemptedOperationFailure} instead.
 */
function asOperationFailure(
  failure: StoreFailure,
  message: string
): StoreFailure {
  return failure.reason === "rejected"
    ? { reason: "rejected", message }
    : failure
}

/**
 * Re-speaks a {@link StoreFailure} returned by an operation this module **did**
 * attempt — the counter increment behind a `position` — in the sentence of the
 * roster change that asked for it.
 *
 * Every reason is re-spoken, unlike {@link asOperationFailure}. Nothing was
 * settled ahead of this call: the module asked the deployment to advance the
 * `member_position` counter and the deployment did not serve it, which is
 * Requirement 2.8 whether the answer was "no" or no answer at all. Its first
 * clause — no answer inside the 5 seconds of Requirement 1.5 — arrives as
 * `unreachable`, and it asks for a message that states the change was not saved
 * and names the attempted change, so leaving that failure to speak about the
 * database in general would answer a different requirement than the one at hand.
 *
 * The original `reason` is preserved rather than replaced. It is the only thing
 * left that distinguishes a deployment that timed out from one that refused, and
 * inventing one here would make the store claim something it did not observe.
 */
function asAttemptedOperationFailure(
  failure: StoreFailure,
  message: string
): StoreFailure {
  return { reason: failure.reason, message }
}

/**
 * Whether a caught error carries the numeric duplicate-key code.
 *
 * Only the code is consulted. The message a duplicate-key error carries names
 * the index, the collection, and the value it refused, and Requirement 1.6 keeps
 * server text out of every value this store returns — so the text is never read,
 * and the conflicting Member_Label is obtained by re-reading the collection
 * instead.
 */
function namesDuplicateKey(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false
  }
  const code: unknown = (error as { code?: unknown }).code
  return code === DUPLICATE_KEY_CODE
}

/**
 * An `entryId` no current Store_Document holds.
 *
 * `crypto.randomUUID()` collides with negligible probability, but an injected
 * generator — a counter, a shrunk fast-check value, a counter restarted with a
 * second store over the same database — can repeat, and two documents sharing an
 * `entryId` would make `setEnabled` and `remove` address an arbitrary one of
 * them. A repeat is therefore disambiguated with a numeric suffix rather than
 * trusted.
 *
 * The loop terminates: each iteration that continues requires an existing
 * document holding that exact id, and the collection holds at most
 * {@link MEMBER_REGISTRY_MAX_ENTRIES} of them (give or take the race the cap
 * documents), so a free suffix is reached in at most that many steps. A driver
 * rejection propagates to the caller, which reports it as `failed`.
 */
async function freshEntryId(
  collection: Collection<MemberDocumentInput>,
  generateId: () => string
): Promise<string> {
  const candidate = generateId()
  if (!(await holdsEntryId(collection, candidate))) {
    return candidate
  }
  for (let suffix = 2; ; suffix += 1) {
    const disambiguated = `${candidate}-${suffix}`
    if (!(await holdsEntryId(collection, disambiguated))) {
      return disambiguated
    }
  }
}

/** Whether some Store_Document already holds `entryId`. */
async function holdsEntryId(
  collection: Collection<MemberDocumentInput>,
  entryId: string
): Promise<boolean> {
  const existing = await collection.findOne(
    { entryId },
    { projection: { _id: 1 } }
  )
  return existing !== null
}

/** The Store_Document of one entry, or null when the collection holds none. */
function findByEntryId(
  collection: Collection<MemberDocumentInput>,
  entryId: string
): Promise<WithId<MemberDocumentInput> | null> {
  return collection.findOne({ entryId })
}

/**
 * Builds a Member_Registry over `store`.
 *
 * Holds no state of its own beyond the two injected seams: every read and every
 * write goes to the `members` collection, so two registries built over the same
 * Mongo_Store — or over the same database through two Mongo_Stores, which is
 * what the restart clause of Requirement 2.3 exercises — see the same roster.
 */
export function createMemberRegistryStore(
  store: MongoStore,
  options: MemberRegistryOptions = {}
): MemberRegistryStore {
  const generateId = options.generateId ?? (() => randomUUID())
  const now = options.now ?? (() => new Date())

  /**
   * The `members` collection, or the failure explaining why there is none.
   *
   * Typed by {@link MemberDocumentInput} — the Store_Document without its `_id`
   * — because that is the shape this module writes: `_id` is the driver's to
   * assign, so nothing here invents one, and a read still comes back as
   * `WithId<MemberDocumentInput>`, which is the full
   * {@link import("@/server/store/documents.server").MemberDocument}.
   */
  const members = () => store.collection<MemberDocumentInput>("members")

  /**
   * One read of the collection, sorted by `position` ascending in the database
   * (Requirement 2.2). `filter` is empty for `list` and `{ enabled: true }` for
   * `listEnabled`, so the enabled subset is selected by the deployment rather
   * than by a pass over the whole roster.
   */
  const read = async (
    filter: Partial<Pick<MemberDocumentInput, "enabled">>
  ): Promise<ListMembersResult> => {
    const handle = await members()
    if (handle.kind === "failure") {
      return {
        kind: "failed",
        failure: asOperationFailure(handle.failure, rosterReadFailedMessage()),
      }
    }

    try {
      const documents = await handle.collection
        .find(filter, { sort: { position: 1 } })
        .toArray()
      return { kind: "entries", entries: documents.map(fromMemberDocument) }
    } catch (error) {
      /*
       * Requirement 2.14: zero entries and one fixed sentence. Nothing
       * partially read is returned — `toArray` either yields the whole cursor
       * or throws — and a read changes nothing either way.
       */
      return {
        kind: "failed",
        failure: driverStoreFailure(error, rosterReadFailedMessage()),
      }
    }
  }

  /**
   * The write failure for an operation on a known Member_Label, and the
   * sentence Requirement 2.8 asks it to speak with.
   */
  const writeFailure = (
    error: unknown,
    operation: RosterWriteOperation,
    memberLabel: string
  ): StoreFailure =>
    driverStoreFailure(
      error,
      rosterWriteFailedMessage({ operation, memberLabel })
    )

  return {
    list: () => read({}),

    listEnabled: () => read({ enabled: true }),

    /**
     * Validation, then the uniqueness pre-read, then the cap — each of the
     * three returning before anything is written (Requirements 2.4, 2.5, 2.12).
     *
     * The order matters when more than one rule is violated. A duplicate
     * Hive_ID is reported ahead of a full roster because it is the more
     * specific problem and the more actionable message: the Group_Member is
     * already registered, so there is nothing to add and no entry to prune.
     *
     * `position` comes from the `member_position` counter, taken after the cap
     * check so a rejected submission consumes no value, and the insert never
     * reads the maximum. A counter value that is consumed and then not used —
     * because the insert failed — leaves a gap, which is fine: Requirement 2.1
     * asks for a position above every existing one, not for a gapless sequence.
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

      const { memberLabel, hiveId } = validated
      const failedSentence = rosterWriteFailedMessage({
        operation: "add",
        memberLabel,
      })

      const handle = await members()
      if (handle.kind === "failure") {
        return {
          kind: "failed",
          failure: asOperationFailure(handle.failure, failedSentence),
        }
      }
      const collection = handle.collection

      let entryId: string
      try {
        const conflict = await collection.findOne({ hiveId })
        if (conflict !== null) {
          // Requirement 2.4: nothing inserted, and the conflicting label named.
          return { kind: "duplicate", conflictingLabel: conflict.memberLabel }
        }

        if (
          (await collection.countDocuments()) >= MEMBER_REGISTRY_MAX_ENTRIES
        ) {
          // Requirement 2.5: nothing inserted, and the maximum stated.
          return { kind: "full" }
        }

        entryId = await freshEntryId(collection, generateId)
      } catch (error) {
        return {
          kind: "failed",
          failure: writeFailure(error, "add", memberLabel),
        }
      }

      const counter = await nextCounterValue("member_position", store)
      if (isCounterFailure(counter)) {
        /* An operation this add attempted, so every reason is re-spoken as the
         * add: a counter increment that timed out is still an add that was not
         * saved (Requirement 2.8). */
        return {
          kind: "failed",
          failure: asAttemptedOperationFailure(counter, failedSentence),
        }
      }
      const position = counter

      /* Requirement 2.1: the creation timestamp is taken at the insertion. */
      const entry: MemberRegistryEntry = {
        id: entryId,
        memberLabel,
        hiveId,
        enabled: true,
        createdAt: now().toISOString(),
      }

      try {
        await collection.insertOne(toMemberDocument(entry, position))
      } catch (error) {
        if (namesDuplicateKey(error)) {
          /*
           * The `hiveId_unique` index refused the insert after a clean
           * pre-read, so a concurrent add took this Hive_ID in between. The
           * conflicting Member_Label is re-read rather than parsed out of the
           * driver's message (Requirement 1.6), which turns the race back into
           * the ordinary Requirement 2.4 rejection.
           */
          try {
            const conflict = await collection.findOne({ hiveId })
            if (conflict !== null) {
              return {
                kind: "duplicate",
                conflictingLabel: conflict.memberLabel,
              }
            }
          } catch {
            /* The re-read failed too: degrade to `failed` below. */
          }
        }
        return {
          kind: "failed",
          failure: writeFailure(error, "add", memberLabel),
        }
      }

      // Requirement 2.9: the entry, and nothing to warn about.
      return { kind: "added", entry }
    },

    /**
     * Writes the submitted enabled state and nothing else (Requirement 2.7):
     * one `$set` on `enabled`, so the Member_Label, the Hive_ID, the creation
     * timestamp, and the position of that Store_Document are left exactly as
     * they were.
     *
     * The Store_Document is read first, for two reasons: an absent identifier
     * is Requirement 2.13's `not-found`, and the Member_Label the read supplies
     * is what lets a failed write name its attempted change (Requirement 2.8).
     * When the read itself is what failed there is no label to name, and the
     * sentence falls back to {@link UNKNOWN_MEMBER_LABEL}.
     */
    setEnabled: async (id, enabled) => {
      const operation: RosterWriteOperation = enabled ? "enable" : "disable"

      const handle = await members()
      if (handle.kind === "failure") {
        return {
          kind: "failed",
          failure: asOperationFailure(
            handle.failure,
            rosterWriteFailedMessage({
              operation,
              memberLabel: UNKNOWN_MEMBER_LABEL,
            })
          ),
        }
      }
      const collection = handle.collection

      let memberLabel = UNKNOWN_MEMBER_LABEL
      try {
        const existing = await findByEntryId(collection, id)
        if (existing === null) {
          return { kind: "not-found" }
        }
        memberLabel = existing.memberLabel

        const updated = await collection.findOneAndUpdate(
          { entryId: id },
          { $set: { enabled } },
          { returnDocument: "after" }
        )
        if (updated === null) {
          /* Removed between the read and the update: still Requirement 2.13. */
          return { kind: "not-found" }
        }

        return { kind: "updated", entry: fromMemberDocument(updated) }
      } catch (error) {
        return {
          kind: "failed",
          failure: writeFailure(error, operation, memberLabel),
        }
      }
    },

    /**
     * Deletes exactly one Store_Document (Requirement 2.6).
     *
     * No renumbering pass exists, so every remaining `position` keeps its
     * value, and the Redemption_History is neither read nor written: its
     * outcome rows carry their own `memberLabel` and `hiveId`, so a deletion
     * cannot alter or remove a history record.
     *
     * The pre-read is here for the same two reasons as in `setEnabled`:
     * `not-found` for an absent identifier (Requirement 2.13), and a
     * Member_Label for the failure sentence (Requirement 2.8).
     */
    remove: async (id) => {
      const handle = await members()
      if (handle.kind === "failure") {
        return {
          kind: "failed",
          failure: asOperationFailure(
            handle.failure,
            rosterWriteFailedMessage({
              operation: "remove",
              memberLabel: UNKNOWN_MEMBER_LABEL,
            })
          ),
        }
      }
      const collection = handle.collection

      let memberLabel = UNKNOWN_MEMBER_LABEL
      try {
        const existing = await findByEntryId(collection, id)
        if (existing === null) {
          return { kind: "not-found" }
        }
        memberLabel = existing.memberLabel

        const outcome = await collection.deleteOne({ entryId: id })
        if (outcome.deletedCount === 0) {
          /* Removed between the read and the delete: already absent. */
          return { kind: "not-found" }
        }

        return { kind: "removed" }
      } catch (error) {
        return {
          kind: "failed",
          failure: writeFailure(error, "remove", memberLabel),
        }
      }
    },
  }
}

/**
 * A Member_Registry over the process-wide Mongo_Store.
 *
 * A fresh, stateless wrapper is returned on every call, so installing another
 * store with `setMongoStore` cannot leave a caller holding a registry bound to
 * the previous connection pool.
 */
export function getMemberRegistryStore(
  options: MemberRegistryOptions = {}
): MemberRegistryStore {
  return createMemberRegistryStore(getMongoStore(), options)
}
