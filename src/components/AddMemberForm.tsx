/**
 * The form that adds a Group_Member to the Member_Registry
 * (Requirements 1.1, 1.2, 1.3, 1.8, 1.11).
 *
 * ## Presentational only
 *
 * The submission is handed to `onSubmit`; this component calls no server
 * function and holds no query. `src/routes/roster.tsx` owns the mutation, and a
 * test renders this form with nothing but `@testing-library/react`.
 *
 * ## Why the client validates with the server's own schemas
 *
 * `memberLabelSchema` and `hiveIdSchema` are the two schemas
 * `addMemberInputSchema` is composed from, and that composed schema is what
 * `addMember` validates with on the server. Parsing the two fields here with the
 * same schemas means the message shown before the request and the message
 * returned by a rejected request are produced by the same code, so the sentence
 * naming the field and its allowed character-count range (Requirement 1.3)
 * cannot drift between the two sides. The parsed output is also the trimmed
 * value, so what is submitted is exactly what the server would store.
 *
 * Client-side validation is a convenience, not the boundary: the server
 * validates every payload again, and a submission that slips past this check is
 * still rejected there with the identical message.
 *
 * ## Why the inputs carry no `maxLength`
 *
 * Capping the fields in the DOM would silently truncate an over-long paste
 * instead of rejecting it, and Requirement 1.3 asks for a *message* that names
 * the field and its range. Letting the over-long value be entered and rejected
 * is what produces that message.
 */

import { useState } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  firstErrorMessage,
  hiveIdSchema,
  memberLabelSchema,
} from "@/domain/schemas"
import type { AddMemberInput } from "@/domain/schemas"
import type { AppErrorCode } from "@/domain/types"

/** Field ids, reused by the labels and by `aria-describedby`. */
const FIELD_IDS = {
  memberLabel: "add-member-label",
  hiveId: "add-member-hive-id",
} as const

/** Ids of the message elements a field points at. */
const MESSAGE_IDS = {
  memberLabel: "add-member-label-error",
  hiveId: "add-member-hive-id-error",
  serverError: "add-member-server-error",
} as const

/** Per-field rejection messages of the last client-side parse. */
interface FieldErrors {
  readonly memberLabel: string | null
  readonly hiveId: string | null
}

const NO_FIELD_ERRORS: FieldErrors = { memberLabel: null, hiveId: null }

export interface AddMemberFormProps {
  /**
   * Submits the trimmed pair. Resolve (or return) `true` when the entry was
   * stored and the form clears both fields; return nothing, or `false`, to keep
   * the entered values so the Group_Member can correct them — which is what a
   * duplicate Hive_ID, a validation rejection, or a full roster needs.
   */
  readonly onSubmit: (
    input: AddMemberInput
  ) => void | boolean | Promise<void | boolean>
  /** True while the submission is in flight; disables the control. */
  readonly pending?: boolean
  /**
   * The rejection the server returned, in the shape the envelope carries, so the
   * page passes `envelope.error` straight through. `DUPLICATE_HIVE_ID` also marks
   * the Hive_ID field invalid (Requirements 1.2, 1.3, 1.11).
   */
  readonly error?: {
    readonly code: AppErrorCode
    readonly message: string
  } | null
  /** Persistence warning of a successful write (Requirement 1.8). */
  readonly warningMessage?: string | null
}

/** The add-a-member form. */
export function AddMemberForm({
  onSubmit,
  pending = false,
  error = null,
  warningMessage = null,
}: AddMemberFormProps) {
  const [memberLabel, setMemberLabel] = useState("")
  const [hiveId, setHiveId] = useState("")
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>(NO_FIELD_ERRORS)

  /* A duplicate Hive_ID is a rejection *of that field*, so the field is marked
   * invalid and points at the server message. Every other code is a form-level
   * rejection: the cap is about the roster, not about a field. */
  const hiveIdRejectedByServer = error?.code === "DUPLICATE_HIVE_ID"

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const label = memberLabelSchema.safeParse(memberLabel)
    const hive = hiveIdSchema.safeParse(hiveId)

    setFieldErrors({
      memberLabel: label.success ? null : firstErrorMessage(label.error),
      hiveId: hive.success ? null : firstErrorMessage(hive.error),
    })

    if (!label.success || !hive.success) {
      /* Requirement 1.3: nothing is sent, and the entered values stay put. */
      return
    }

    /*
     * `onSubmit` may be synchronous or asynchronous, so the result is normalized
     * to a promise and explicitly discarded: the form does not wait on the
     * mutation, it only reacts to the verdict once it arrives.
     */
    void Promise.resolve(
      onSubmit({ memberLabel: label.data, hiveId: hive.data })
    ).then((stored) => {
      if (stored === true) {
        setMemberLabel("")
        setHiveId("")
      }
    })
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3" noValidate>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={FIELD_IDS.memberLabel} className="text-sm font-medium">
          Member label
        </label>
        <Input
          id={FIELD_IDS.memberLabel}
          name="memberLabel"
          value={memberLabel}
          onChange={(event) => setMemberLabel(event.target.value)}
          autoComplete="off"
          aria-invalid={fieldErrors.memberLabel !== null}
          aria-describedby={
            fieldErrors.memberLabel !== null
              ? MESSAGE_IDS.memberLabel
              : undefined
          }
        />
        {fieldErrors.memberLabel !== null ? (
          <p
            id={MESSAGE_IDS.memberLabel}
            className="text-sm text-destructive"
            role="alert"
          >
            {fieldErrors.memberLabel}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={FIELD_IDS.hiveId} className="text-sm font-medium">
          Hive ID
        </label>
        <Input
          id={FIELD_IDS.hiveId}
          name="hiveId"
          value={hiveId}
          onChange={(event) => setHiveId(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={fieldErrors.hiveId !== null || hiveIdRejectedByServer}
          aria-describedby={
            fieldErrors.hiveId !== null
              ? MESSAGE_IDS.hiveId
              : hiveIdRejectedByServer
                ? MESSAGE_IDS.serverError
                : undefined
          }
        />
        {fieldErrors.hiveId !== null ? (
          <p
            id={MESSAGE_IDS.hiveId}
            className="text-sm text-destructive"
            role="alert"
          >
            {fieldErrors.hiveId}
          </p>
        ) : null}
      </div>

      {/*
       * The server's own sentence, rendered as text and never as markup: the
       * duplicate message quotes a Member_Label the Group_Member typed
       * (Requirement 1.2), so it is untrusted content.
       */}
      {error !== null ? (
        <Alert variant="destructive" id={MESSAGE_IDS.serverError}>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : null}

      {warningMessage !== null ? (
        <Alert role="status">
          <AlertDescription>{warningMessage}</AlertDescription>
        </Alert>
      ) : null}

      <Button type="submit" disabled={pending} className="self-start">
        {pending ? "Adding…" : "Add member"}
      </Button>
    </form>
  )
}
