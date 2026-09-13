/**
 * The Member_Registry server function surface (Requirements 1.1, 1.2, 1.3,
 * 1.4, 1.5, 1.9, 1.11, 2.8, 2.9, 2.14).
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
 * There are none left on this surface. A store result of `added`, `updated`, or
 * `removed` means the write is in the database (Requirement 2.9), so there is no
 * applied-but-not-saved state to warn about, and a rejection writes nothing.
 * Every envelope this module builds therefore carries zero warnings.
 *
 * ## A store failure is a rejection, not a success
 *
 * Each store result now carries a `failed` variant, and each is mapped through
 * {@link storeFailureEnvelope}: `STORE_UNAVAILABLE` when no operation was served
 * at all, `STORE_READ_FAILED` for the roster read (Requirement 2.14), and
 * `STORE_WRITE_FAILED` for a change that was not saved (Requirement 2.8). The
 * sentence is the store's own — it already names the attempted change — so this
 * module composes nothing and never sees a driver error.
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
import { storeFailureEnvelope } from "@/domain/storeFailures"
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

/** What `removeMember` returns on success: the id that is now gone. */
export interface RemovedMember {
  readonly id: string
}

/* -------------------------------------------------------------------------- */
/* Envelope construction                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A successful envelope. Always zero warnings: a store result that reports a
 * write reports one that is in the database (Requirement 2.9), and a read writes
 * nothing.
 */
function succeeded<T>(data: T): Envelope<T> {
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
 * - `added` → the stored entry, and zero warnings: the insert is in the database
 *   (Requirements 1.1, 2.9)
 * - `duplicate` → `DUPLICATE_HIVE_ID`, the message naming the Member_Label of
 *   the conflicting entry (Requirement 1.2)
 * - `full` → `ROSTER_FULL`, the message stating the maximum of 100 entries
 *   (Requirement 1.11)
 * - `invalid` → `VALIDATION`, carrying the store's message, which names the
 *   field and its range (Requirement 1.3)
 * - `failed` → a store rejection carrying the store's own sentence, which already
 *   states that the change was not saved and names it (Requirement 2.8)
 */
export function addResultEnvelope(
  result: AddMemberResult
): Envelope<MemberRegistryEntry> {
  switch (result.kind) {
    case "added":
      return succeeded(result.entry)
    case "duplicate":
      return rejected(
        "DUPLICATE_HIVE_ID",
        duplicateHiveIdMessage(result.conflictingLabel)
      )
    case "full":
      return rejected("ROSTER_FULL", rosterFullMessage())
    case "invalid":
      return rejected("VALIDATION", result.message)
    case "failed":
      return storeFailureEnvelope(result.failure, "write")
  }
}

/** Maps a {@link SetEnabledResult} onto its envelope (Requirements 1.9, 2.8). */
export function setEnabledResultEnvelope(
  result: SetEnabledResult
): Envelope<MemberRegistryEntry> {
  switch (result.kind) {
    case "updated":
      return succeeded(result.entry)
    case "not-found":
      return rejected("MEMBER_NOT_FOUND", memberNotFoundMessage())
    case "failed":
      return storeFailureEnvelope(result.failure, "write")
  }
}

/** Maps a {@link RemoveMemberResult} onto its envelope (Requirements 1.5, 2.8). */
export function removeResultEnvelope(
  id: string,
  result: RemoveMemberResult
): Envelope<RemovedMember> {
  switch (result.kind) {
    case "removed":
      return succeeded({ id })
    case "not-found":
      return rejected("MEMBER_NOT_FOUND", memberNotFoundMessage())
    case "failed":
      return storeFailureEnvelope(result.failure, "write")
  }
}

/* -------------------------------------------------------------------------- */
/* Envelope operations over a store                                           */
/* -------------------------------------------------------------------------- */

/**
 * The roster in position order (Requirements 1.4, 2.2). Reads nothing else.
 *
 * A read is a round trip to a deployment that may not answer, so it can fail: a
 * `failed` result becomes a rejection carrying the store's own sentence and no
 * entries at all, which is what keeps "the database is unreachable" from
 * rendering as "the roster is empty" (Requirement 2.14).
 *
 * The entries are copied out of the read-only result so the envelope carries a
 * mutable array, matching what every caller already holds.
 */
export async function readRoster(
  store: MemberRegistryStore
): Promise<Envelope<MemberRegistryEntry[]>> {
  const result = await store.list()
  return result.kind === "entries"
    ? succeeded([...result.entries])
    : storeFailureEnvelope(result.failure, "read")
}

/** Requirements 1.1, 1.2, 1.3, 1.11, 2.8, 2.9. */
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
export const listMembers = createServerFn().handler(async () =>
  readRoster(getMemberRegistryStore())
)

/** Stores a new roster entry (Requirements 1.1, 1.2, 1.3, 1.11, 2.8, 2.9). */
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
