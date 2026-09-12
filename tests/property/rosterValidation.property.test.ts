// Feature: shared-coupon-redemption, Property 13: For any submitted
// Member_Label and Hive_ID pair in which either value holds zero characters
// after trimming, or the Member_Label exceeds 40 characters, or the Hive_ID
// exceeds 64 characters, or the trimmed Hive_ID is character-for-character
// identical to an existing entry's Hive_ID, the submission is rejected with a
// message naming the rejected field and its allowed range or naming the
// conflicting Member_Label, and the Member_Registry is unchanged.
//
// Validates: Requirements 1.2, 1.3.
//
// The rule the store is measured against is restated here from the
// requirements, not borrowed from the implementation: trim first, then
// length-check the Member_Label and the Hive_ID against their stated ranges,
// then compare the trimmed Hive_ID character for character against the stored
// ones. `predictAddResult` below is that rule, and the classification test
// asserts the store agrees with it for arbitrary pairs.
//
// Two observations back "the Member_Registry is unchanged": `list()` is
// snapshotted before and after every submission and deep-compared, and the
// flush counter of the injected store must not move, so a rejection neither
// alters the in-memory roster nor enqueues a write. The store is built over a
// temporary `DATA_FILE` with the flush replaced, so `./data/store.json` is
// never touched.

import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"

import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
  FIELD_NAMES,
  HIVE_ID_MAX_LENGTH,
  MEMBER_LABEL_MAX_LENGTH,
  lengthRangeMessage,
} from "@/domain/schemas"
import { createJsonStore } from "@/server/store/jsonStore.server"
import {
  MEMBER_REGISTRY_MAX_ENTRIES,
  createMemberRegistryStore,
  duplicateHiveIdMessage,
} from "@/server/store/memberRegistry.server"
import type {
  AddMemberFields,
  MemberField,
  MemberRegistryStore,
} from "@/server/store/memberRegistry.server"
import type { MemberRegistryEntry } from "@/domain/types"

import {
  anyHiveIdArb,
  anyMemberLabelArb,
  blankTextArb,
  invalidHiveIdArb,
  invalidMemberLabelArb,
  rosterArb,
  validMemberLabelArb,
  whitespacePaddingArb,
} from "./generators"

/* -------------------------------------------------------------------------- */
/* The rule, stated independently of the store                                */
/* -------------------------------------------------------------------------- */

/** What Requirements 1.1 - 1.3 and 1.11 say an add submission produces. */
type PredictedAddResult =
  | { readonly kind: "invalid"; readonly field: MemberField }
  | { readonly kind: "duplicate"; readonly conflictingLabel: string }
  | { readonly kind: "full" }
  | {
      readonly kind: "added"
      readonly memberLabel: string
      readonly hiveId: string
    }

/**
 * Trim, then length-check, then uniqueness, then the cap.
 *
 * The Member_Label is checked before the Hive_ID, so a submission violating
 * both names the first field of the form. Uniqueness is exact character
 * comparison of the trimmed values, upper case distinguished from lower case
 * (Requirement 1.2).
 */
function predictAddResult(
  stored: readonly MemberRegistryEntry[],
  input: AddMemberFields
): PredictedAddResult {
  const memberLabel = input.memberLabel.trim()
  if (memberLabel.length < 1 || memberLabel.length > MEMBER_LABEL_MAX_LENGTH) {
    return { kind: "invalid", field: "memberLabel" }
  }

  const hiveId = input.hiveId.trim()
  if (hiveId.length < 1 || hiveId.length > HIVE_ID_MAX_LENGTH) {
    return { kind: "invalid", field: "hiveId" }
  }

  const conflict = stored.find((entry) => entry.hiveId === hiveId)
  if (conflict !== undefined) {
    return { kind: "duplicate", conflictingLabel: conflict.memberLabel }
  }

  if (stored.length >= MEMBER_REGISTRY_MAX_ENTRIES) {
    return { kind: "full" }
  }

  return { kind: "added", memberLabel, hiveId }
}

/** The message Requirement 1.3 demands for each field, with its range. */
const EXPECTED_LENGTH_MESSAGES: Readonly<Record<MemberField, string>> = {
  memberLabel: lengthRangeMessage(
    FIELD_NAMES.memberLabel,
    1,
    MEMBER_LABEL_MAX_LENGTH
  ),
  hiveId: lengthRangeMessage(FIELD_NAMES.hiveId, 1, HIVE_ID_MAX_LENGTH),
}

/** The character-count bounds the message for each field has to name. */
const FIELD_BOUNDS: Readonly<Record<MemberField, number>> = {
  memberLabel: MEMBER_LABEL_MAX_LENGTH,
  hiveId: HIVE_ID_MAX_LENGTH,
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface Harness {
  readonly registry: MemberRegistryStore
  /** Number of flushes enqueued so far. Zero for every rejected submission. */
  readonly flushes: () => number
}

/**
 * A Member_Registry over a store that reads no existing file and writes none:
 * the `DATA_FILE` path is a temporary name that is never created, and `flush`
 * is replaced by a counter, so the real `./data/store.json` stays untouched.
 */
function createHarness(): Harness {
  let flushes = 0
  const store = createJsonStore({
    dataFilePath: join(tmpdir(), `roster-validation-${randomUUID()}.json`),
    flush: () => {
      flushes += 1
      return Promise.resolve()
    },
    logger: { warn: () => undefined },
  })

  return {
    registry: createMemberRegistryStore(store),
    flushes: () => flushes,
  }
}

/** Fills a fresh registry with entries whose values are already trimmed. */
async function seed(
  registry: MemberRegistryStore,
  entries: readonly MemberRegistryEntry[]
): Promise<void> {
  for (const entry of entries) {
    const result = await registry.add({
      memberLabel: entry.memberLabel,
      hiveId: entry.hiveId,
    })
    expect(result.kind).toBe("added")
  }
}

/* -------------------------------------------------------------------------- */
/* Local arbitraries                                                          */
/* -------------------------------------------------------------------------- */

/** Whitespace padding that is guaranteed to change the submitted value. */
const nonEmptyPaddingArb: fc.Arbitrary<string> = whitespacePaddingArb.filter(
  (padding) => padding.length > 0
)

/** Cased ASCII letters, so swapping case always yields a different string. */
const CASED_LETTERS = Array.from(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
)

/** A Hive_ID of 1 to 64 cased letters, holding no whitespace. */
const casedHiveIdArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...CASED_LETTERS), {
    minLength: 1,
    maxLength: HIVE_ID_MAX_LENGTH,
    size: "max",
  })
  .map((letters) => letters.join(""))

function swapCase(value: string): string {
  return Array.from(value, (character) => {
    const lower = character.toLowerCase()
    return character === lower ? character.toUpperCase() : lower
  }).join("")
}

/** A submission violating the length rule, tagged with the field it violates. */
interface InvalidSubmission extends AddMemberFields {
  readonly expectedField: MemberField
}

const invalidSubmissionArb: fc.Arbitrary<InvalidSubmission> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc
      .record({ memberLabel: invalidMemberLabelArb, hiveId: anyHiveIdArb })
      .map((fields) => ({ ...fields, expectedField: "memberLabel" as const })),
  },
  {
    weight: 3,
    arbitrary: fc
      .record({ memberLabel: validMemberLabelArb, hiveId: invalidHiveIdArb })
      .map((fields) => ({ ...fields, expectedField: "hiveId" as const })),
  },
  {
    // Requirement 1.3's blank cases, stated on their own so they cannot be
    // squeezed out by the over-long samples of the two branches above.
    weight: 2,
    arbitrary: fc
      .record({ memberLabel: blankTextArb, hiveId: anyHiveIdArb })
      .map((fields) => ({ ...fields, expectedField: "memberLabel" as const })),
  },
  {
    weight: 2,
    arbitrary: fc
      .record({ memberLabel: validMemberLabelArb, hiveId: blankTextArb })
      .map((fields) => ({ ...fields, expectedField: "hiveId" as const })),
  }
)

/** A roster plus a submission whose Hive_ID trims onto one of its entries. */
const duplicateSubmissionArb = rosterArb({ minLength: 1, maxLength: 5 }).chain(
  (entries) =>
    fc.record({
      entries: fc.constant(entries),
      memberLabel: validMemberLabelArb,
      targetIndex: fc.nat({ max: entries.length - 1 }),
      left: nonEmptyPaddingArb,
      right: whitespacePaddingArb,
    })
)

/**
 * A roster plus an arbitrary submission, biased so every branch of the rule is
 * reachable: arbitrary values cover the length branches, an existing Hive_ID —
 * bare or whitespace-padded — covers the uniqueness branch.
 */
const classificationCaseArb = rosterArb({ maxLength: 6 }).chain((entries) => {
  const storedHiveIds = entries.map((entry) => entry.hiveId)
  const hiveIdArb =
    storedHiveIds.length === 0
      ? anyHiveIdArb
      : fc.oneof(
          { weight: 4, arbitrary: anyHiveIdArb },
          { weight: 2, arbitrary: fc.constantFrom(...storedHiveIds) },
          {
            weight: 2,
            arbitrary: fc
              .tuple(
                whitespacePaddingArb,
                fc.constantFrom(...storedHiveIds),
                whitespacePaddingArb
              )
              .map(([left, hiveId, right]) => `${left}${hiveId}${right}`),
          }
        )

  return fc.record({
    entries: fc.constant(entries),
    memberLabel: anyMemberLabelArb,
    hiveId: hiveIdArb,
  })
})

/* -------------------------------------------------------------------------- */
/* The property                                                               */
/* -------------------------------------------------------------------------- */

describe("Property 13: roster validation rejects invalid submissions without mutating", () => {
  it("rejects a blank or over-long field, naming it and its range, without mutating", async () => {
    await fc.assert(
      fc.asyncProperty(
        rosterArb({ maxLength: 4 }),
        invalidSubmissionArb,
        async (entries, submission) => {
          const harness = createHarness()
          await seed(harness.registry, entries)

          const before = harness.registry.list()
          const flushesBefore = harness.flushes()
          const result = await harness.registry.add(submission)

          // Requirement 1.3: rejected, naming the field and its allowed range.
          expect(result.kind).toBe("invalid")
          if (result.kind !== "invalid") return
          expect(result.field).toBe(submission.expectedField)
          expect(result.message).toBe(
            EXPECTED_LENGTH_MESSAGES[submission.expectedField]
          )
          expect(result.message).toContain(
            FIELD_NAMES[submission.expectedField]
          )
          expect(result.message).toContain("1")
          expect(result.message).toContain(
            String(FIELD_BOUNDS[submission.expectedField])
          )

          // ... the Member_Registry is unchanged, and nothing was written.
          expect(harness.registry.list()).toEqual(before)
          expect(harness.flushes()).toBe(flushesBefore)
          expect("persisted" in result).toBe(false)
        }
      ),
      { numRuns: 100 }
    )
  })

  it("rejects a Hive_ID that trims onto a stored one, naming the conflicting Member_Label", async () => {
    await fc.assert(
      fc.asyncProperty(
        duplicateSubmissionArb,
        async ({ entries, memberLabel, targetIndex, left, right }) => {
          const harness = createHarness()
          await seed(harness.registry, entries)

          const target = entries[targetIndex]
          const submitted = `${left}${target.hiveId}${right}`
          // The submitted text differs from the stored Hive_ID, and only by
          // whitespace, so acceptance would have to come from skipping the trim.
          expect(submitted).not.toBe(target.hiveId)
          expect(submitted.trim()).toBe(target.hiveId)

          const before = harness.registry.list()
          const flushesBefore = harness.flushes()
          const result = await harness.registry.add({
            memberLabel,
            hiveId: submitted,
          })

          // Requirement 1.2: rejected, naming the conflicting Member_Label.
          expect(result.kind).toBe("duplicate")
          if (result.kind !== "duplicate") return
          expect(result.conflictingLabel).toBe(target.memberLabel)
          expect(duplicateHiveIdMessage(result.conflictingLabel)).toContain(
            target.memberLabel
          )

          // ... the Member_Registry is unchanged, and nothing was written.
          expect(harness.registry.list()).toEqual(before)
          expect(harness.flushes()).toBe(flushesBefore)
          expect("persisted" in result).toBe(false)
        }
      ),
      { numRuns: 100 }
    )
  })

  it("accepts a Hive_ID that differs from a stored one only in letter case", async () => {
    await fc.assert(
      fc.asyncProperty(
        validMemberLabelArb,
        validMemberLabelArb,
        casedHiveIdArb,
        async (storedLabel, submittedLabel, hiveId) => {
          const harness = createHarness()
          const stored = await harness.registry.add({
            memberLabel: storedLabel,
            hiveId,
          })
          expect(stored.kind).toBe("added")

          const swapped = swapCase(hiveId)
          expect(swapped).not.toBe(hiveId)
          expect(swapped.toLowerCase()).toBe(hiveId.toLowerCase())

          const result = await harness.registry.add({
            memberLabel: submittedLabel,
            hiveId: swapped,
          })

          // Requirement 1.2 compares character for character, so a case
          // difference is a different Hive_ID and the add goes through.
          expect(result.kind).toBe("added")
          if (result.kind !== "added") return
          expect(result.entry.hiveId).toBe(swapped)
          expect(harness.registry.list().map((entry) => entry.hiveId)).toEqual([
            hiveId,
            swapped,
          ])
        }
      ),
      { numRuns: 100 }
    )
  })

  it("classifies every submission exactly as the trim, length, uniqueness rule predicts", async () => {
    await fc.assert(
      fc.asyncProperty(
        classificationCaseArb,
        async ({ entries, memberLabel, hiveId }) => {
          const harness = createHarness()
          await seed(harness.registry, entries)

          const before = harness.registry.list()
          const flushesBefore = harness.flushes()
          const expected = predictAddResult(before, { memberLabel, hiveId })
          const result = await harness.registry.add({ memberLabel, hiveId })

          expect(result.kind).toBe(expected.kind)

          if (expected.kind === "added") {
            if (result.kind !== "added") return
            expect(result.entry.memberLabel).toBe(expected.memberLabel)
            expect(result.entry.hiveId).toBe(expected.hiveId)
            expect(harness.registry.list()).toEqual([...before, result.entry])
            expect(harness.flushes()).toBe(flushesBefore + 1)
            return
          }

          // Every rejection leaves the roster alone and enqueues no write.
          expect(harness.registry.list()).toEqual(before)
          expect(harness.flushes()).toBe(flushesBefore)
          expect("persisted" in result).toBe(false)

          if (expected.kind === "invalid") {
            if (result.kind !== "invalid") return
            expect(result.field).toBe(expected.field)
            expect(result.message).toBe(
              EXPECTED_LENGTH_MESSAGES[expected.field]
            )
            return
          }

          if (expected.kind === "duplicate") {
            if (result.kind !== "duplicate") return
            expect(result.conflictingLabel).toBe(expected.conflictingLabel)
          }
        }
      ),
      { numRuns: 100 }
    )
  })
})
