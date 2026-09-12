/**
 * The Member_Registry server function surface (Requirements 1.1, 1.2, 1.3,
 * 1.4, 1.5, 1.8, 1.9, 1.11, 1.12).
 *
 * Four `createServerFn` functions — `listMembers`, `addMember`,
 * `setMemberEnabled`, `removeMember` — each returning an
 * {@link Envelope} instead of throwing. Every rejection the roster
 * requirements name is a *message the Web_Client displays*, so it belongs in
 * the return type rather than in a thrown error; a thrown error stays reserved
 * for a genuine bug.
 *
 * ## Layering
 *
 * This module owns exactly one thing: turning a
 * {@link import("@/server/store/memberRegistry.server").MemberRegistryStore}
 * result into an envelope. It enforces no roster invariant of its own — the
 * store does that — and it composes no message of its own either: `duplicate`,
 * `full`, `invalid`, and `not-found` each carry (or name) a sentence declared in
 * `src/domain/rosterMessages.ts` and re-exported by the store, so a caller that
 * bypasses this layer reads the identical text.
 *
 * The sentences are imported from that domain module rather than from the store
 * because this mapping is reachable from the roster page: an import of a
 * `.server` module at module scope here would drag the filesystem-backed store
 * into the browser bundle, which the build refuses outright. `getMemberRegistryStore`
 * is still imported from the store, but it is called only inside handler bodies,
 * which are stripped from the client build.
 *
 * The four envelope operations are exported separately from the server
 * functions and take the store as a parameter. That keeps the mapping directly
 * testable without booting the framework, and it keeps the store *type* the
 * only thing this module needs from `@/server/` on a client-reachable path.
 *
 * ## Why validation runs inside the handler chain rather than throwing
 *
 * `.validator()` is the framework's rejection point: a standard-schema
 * validator that fails makes `execValidator` throw, which reaches the caller as
 * an exception, not as an envelope. Requirement 1.3 asks for the opposite — a
 * validation error *message* naming the rejected field and its permitted
 * character range, delivered like every other rejection.
 *
 * So the validator attached here is a function validator built from the same
 * `src/domain/schemas.ts` schema, and it never throws: it returns a
 * {@link Validated} verdict, and the handler turns a failed verdict into a
 * `VALIDATION` envelope. Validation therefore still happens once, before the
 * handler body touches the store, still uses the schema the client forms use
 * (so the two messages cannot drift), and still types the call site — while the
 * client sees an envelope for a bad submission instead of an exception.
 *
 * An early draft of the design suggested `zodValidator` from
 * `@tanstack/zod-adapter`. It is not used: it wraps the schema into a throwing
 * validator, which is the behaviour this module has to avoid, and its declared
 * peer range (`zod ^3`) does not cover the `zod 4` this repository depends on.
 * The package was dropped from `package.json` in task 16.1, and the design and
 * the task list were corrected to match. Nothing is lost —
 * TanStack's validator slot accepts a plain function, and a zod 4 schema would
 * be accepted directly as a standard-schema validator if throwing were wanted.
 *
 * ## Warnings
 *
 * A successful write whose flush landed carries zero warnings
 * (Requirement 1.12); a successful write whose flush failed carries exactly one
 * — {@link PERSISTENCE_WARNING} — stating the change is not persisted across a
 * restart (Requirement 1.8). A rejection carries no warning at all, because a
 * rejection writes nothing.
 */

import { createServerFn } from "@tanstack/react-start"

import {
  addMemberInputSchema,
  firstErrorMessage,
  removeMemberInputSchema,
  setMemberEnabledInputSchema,
} from "@/domain/schemas"
import {
  duplicateHiveIdMessage,
  memberNotFoundMessage,
  rosterFullMessage,
} from "@/domain/rosterMessages"
import { getMemberRegistryStore } from "@/server/store/memberRegistry.server"
import type { z } from "zod"
import type {
  AddMemberInput,
  RemoveMemberInput,
  SetMemberEnabledInput,
} from "@/domain/schemas"
import type { Envelope, MemberRegistryEntry } from "@/domain/types"
import type {
  AddMemberResult,
  MemberRegistryStore,
  RemoveMemberResult,
  SetEnabledResult,
} from "@/server/store/memberRegistry.server"

/**
 * The single persistence warning of Requirement 1.8: the change is applied and
 * served from memory, but it will not survive a restart. Exported so the roster
 * page and its tests assert the identical string instead of a paraphrase.
 */
export const PERSISTENCE_WARNING =
  "The change is applied but could not be written to storage, so it is not persisted across a restart."

/** What `removeMember` returns on success: the id that is now gone. */
export interface RemovedMember {
  readonly id: string
}

/* -------------------------------------------------------------------------- */
/* Envelope construction                                                      */
/* -------------------------------------------------------------------------- */

/** A successful envelope, with the persistence warning iff the flush failed. */
function succeeded<T>(data: T, persisted: boolean): Envelope<T> {
  return {
    ok: true,
    data,
    warnings: persisted ? [] : [PERSISTENCE_WARNING],
  }
}

/** A read envelope: nothing was written, so there is nothing to warn about. */
function read<T>(data: T): Envelope<T> {
  return { ok: true, data, warnings: [] }
}

/** A rejection envelope. */
function rejected<T>(
  code: "VALIDATION" | "DUPLICATE_HIVE_ID" | "ROSTER_FULL" | "MEMBER_NOT_FOUND",
  message: string
): Envelope<T> {
  return { ok: false, error: { code, message } }
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

/** The verdict a validator hands the handler. Never thrown, always returned. */
export type Validated<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string }

/**
 * A validator over `schema` that reports a rejection instead of throwing one.
 * The message is the schema's own first message, which names the rejected field
 * and its permitted character range (Requirement 1.3).
 */
function verdictValidator<TOutput, TInput>(
  schema: z.ZodType<TOutput, TInput>
): (input: TInput) => Validated<TOutput> {
  return (input) => {
    const parsed = schema.safeParse(input)
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, message: firstErrorMessage(parsed.error) }
  }
}

/** Validator of the `addMember` payload (Requirements 1.1, 1.3). */
export const validateAddMemberInput = verdictValidator(addMemberInputSchema)

/** Validator of the `setMemberEnabled` payload (Requirement 1.9). */
export const validateSetMemberEnabledInput = verdictValidator(
  setMemberEnabledInputSchema
)

/** Validator of the `removeMember` payload (Requirement 1.5). */
export const validateRemoveMemberInput = verdictValidator(
  removeMemberInputSchema
)

/* -------------------------------------------------------------------------- */
/* Store result -> envelope                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Maps an {@link AddMemberResult} onto its envelope.
 *
 * - `added` → the stored entry, with one persistence warning only when the
 *   flush failed (Requirements 1.1, 1.8, 1.12)
 * - `duplicate` → `DUPLICATE_HIVE_ID`, the message naming the Member_Label of
 *   the conflicting entry (Requirement 1.2)
 * - `full` → `ROSTER_FULL`, the message stating the maximum of 100 entries
 *   (Requirement 1.11)
 * - `invalid` → `VALIDATION`, carrying the store's message, which names the
 *   field and its range (Requirement 1.3)
 */
export function addResultEnvelope(
  result: AddMemberResult
): Envelope<MemberRegistryEntry> {
  switch (result.kind) {
    case "added":
      return succeeded(result.entry, result.persisted)
    case "duplicate":
      return rejected(
        "DUPLICATE_HIVE_ID",
        duplicateHiveIdMessage(result.conflictingLabel)
      )
    case "full":
      return rejected("ROSTER_FULL", rosterFullMessage())
    case "invalid":
      return rejected("VALIDATION", result.message)
  }
}

/** Maps a {@link SetEnabledResult} onto its envelope (Requirement 1.9). */
export function setEnabledResultEnvelope(
  result: SetEnabledResult
): Envelope<MemberRegistryEntry> {
  return result.kind === "updated"
    ? succeeded(result.entry, result.persisted)
    : rejected("MEMBER_NOT_FOUND", memberNotFoundMessage())
}

/** Maps a {@link RemoveMemberResult} onto its envelope (Requirement 1.5). */
export function removeResultEnvelope(
  id: string,
  result: RemoveMemberResult
): Envelope<RemovedMember> {
  return result.kind === "removed"
    ? succeeded({ id }, result.persisted)
    : rejected("MEMBER_NOT_FOUND", memberNotFoundMessage())
}

/* -------------------------------------------------------------------------- */
/* Envelope operations over a store                                           */
/* -------------------------------------------------------------------------- */

/** The roster in insertion order (Requirement 1.4). Reads nothing else. */
export function readRoster(
  store: MemberRegistryStore
): Envelope<MemberRegistryEntry[]> {
  return read(store.list())
}

/** Requirements 1.1, 1.2, 1.3, 1.8, 1.11, 1.12. */
export async function addToRoster(
  store: MemberRegistryStore,
  input: AddMemberInput
): Promise<Envelope<MemberRegistryEntry>> {
  return addResultEnvelope(await store.add(input))
}

/** Requirement 1.9. */
export async function setRosterEntryEnabled(
  store: MemberRegistryStore,
  input: SetMemberEnabledInput
): Promise<Envelope<MemberRegistryEntry>> {
  return setEnabledResultEnvelope(
    await store.setEnabled(input.id, input.enabled)
  )
}

/** Requirement 1.5. The Redemption_History is not consulted or altered. */
export async function removeFromRoster(
  store: MemberRegistryStore,
  input: RemoveMemberInput
): Promise<Envelope<RemovedMember>> {
  return removeResultEnvelope(input.id, await store.remove(input.id))
}

/* -------------------------------------------------------------------------- */
/* The server functions                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The whole Member_Registry, in insertion order (Requirement 1.4).
 *
 * A `GET`: it writes nothing, and it takes no caller-supplied value. The
 * Access_Gate and the cross-site check are applied globally in `src/start.ts`,
 * so nothing here re-checks them.
 */
export const listMembers = createServerFn().handler(() =>
  readRoster(getMemberRegistryStore())
)

/** Stores a new roster entry (Requirements 1.1, 1.2, 1.3, 1.8, 1.11, 1.12). */
export const addMember = createServerFn({ method: "POST" })
  .validator(validateAddMemberInput)
  .handler(async ({ data }) =>
    data.ok
      ? addToRoster(getMemberRegistryStore(), data.value)
      : rejected<MemberRegistryEntry>("VALIDATION", data.message)
  )

/** Stores the submitted enabled state of an entry (Requirement 1.9). */
export const setMemberEnabled = createServerFn({ method: "POST" })
  .validator(validateSetMemberEnabledInput)
  .handler(async ({ data }) =>
    data.ok
      ? setRosterEntryEnabled(getMemberRegistryStore(), data.value)
      : rejected<MemberRegistryEntry>("VALIDATION", data.message)
  )

/** Deletes an entry, leaving every history record untouched (Requirement 1.5). */
export const removeMember = createServerFn({ method: "POST" })
  .validator(validateRemoveMemberInput)
  .handler(async ({ data }) =>
    data.ok
      ? removeFromRoster(getMemberRegistryStore(), data.value)
      : rejected<RemovedMember>("VALIDATION", data.message)
  )
