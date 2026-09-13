// Feature: mongodb-google-auth-admin, Property 6: A rejected roster submission changes nothing and names its reason
//
// Validates: Requirements 2.4, 2.5, 2.12.
//
// *For any* roster state and *for any* submission that violates a stored rule —
// a Member_Label holding zero or more than 40 characters after trimming, a
// Hive_ID holding zero or more than 64 characters after trimming, a Hive_ID
// character-for-character identical to a stored one, or any submission arriving
// while the collection holds 100 or more documents — the Mongo_Store inserts no
// Store_Document, leaves the collection character-for-character unchanged, and
// returns a message that names the rejected field with its permitted character
// count for a range violation, names the Member_Label of the conflicting entry
// for a duplicate, and states the maximum of 100 entries for a full roster; and
// *for any* Hive_ID differing from a stored one only in letter case, the
// submission is accepted.
//
// ## What "unchanged" is observed as
//
// Every clause snapshots the `members` collection through the fixture's own
// driver handle — not through the store — before and after the submission, and
// deep-compares the two. The snapshot carries the `_id`, the `entryId`, both
// text fields, the enabled state, the creation timestamp, and the `position` of
// every document, so an insert, an overwrite, a renumbering, or a silently
// re-mapped field all show up as a difference. Reading it outside the store is
// deliberate: a store bug that hides a write from `list()` would otherwise hide
// it from this assertion too.
//
// ## Where the roster state comes from
//
// The stored roster is seeded straight into the collection, one `insertMany`
// per sample, rather than built by 1 to 101 calls to `add`. Two reasons: an
// `add` per entry costs five round trips each, which at 100 samples and 100
// entries is a suite nobody will run; and Property 6 is about what a *rejected*
// submission does to a roster, so how that roster came to exist is Property 5's
// subject and not this file's. The `member_position` counter is seeded along
// with the documents, so the store's next `position` is above every seeded one
// exactly as it would be had the entries been added through it.
//
// ## The three rejection reasons are one property, the cap is a second
//
// The range violations and the duplicate share one `fc.assert` because they
// share a sample shape: a small roster plus a submission plus the rejection it
// must produce. The cap needs a roster of 100 or 101 entries, so it gets its
// own assertion — still at the full run count, with a raised per-test timeout,
// because 100 samples each seeding 100 documents is one bulk insert per sample
// rather than the 500 round trips an `add` per entry would cost.
//
// ## No MongoDB, no vacuous pass
//
// Every clause needs a real deployment, so the suite is guarded by
// `mongoAvailability()` and states its skip reason as a test name that runs.

import fc from "fast-check"
import { afterAll, describe, expect, it } from "vitest"

import {
  MEMBER_REGISTRY_MAX_ENTRIES,
  duplicateHiveIdMessage,
  rosterFullMessage,
} from "@/domain/rosterMessages"
import {
  FIELD_NAMES,
  HIVE_ID_MAX_LENGTH,
  MEMBER_LABEL_MAX_LENGTH,
  lengthRangeMessage,
} from "@/domain/schemas"
import { toMemberDocument } from "@/server/store/documents.server"
import { createMemberRegistryStore } from "@/server/store/memberRegistry.server"

import {
  anyHiveIdArb,
  invalidHiveIdArb,
  invalidMemberLabelArb,
  rosterArb,
  trimmedMemberLabelArb,
  validHiveIdArb,
  validMemberLabelArb,
  whitespacePaddingArb,
} from "./generators"

import {
  closeMongoFixture,
  mongoAvailability,
  mongoSkipReason,
  reportMongoSkip,
  withThrowawayDatabase,
} from "../support/mongoFixture"

import type { MemberRegistryEntry } from "@/domain/types"
import type {
  CounterDocument,
  MemberDocumentInput,
} from "@/server/store/documents.server"
import type {
  AddMemberFields,
  MemberField,
} from "@/server/store/memberRegistry.server"
import type { MongoSample } from "../support/mongoFixture"

/* -------------------------------------------------------------------------- */
/* The rule the store is measured against, restated from the requirements      */
/* -------------------------------------------------------------------------- */

/** Requirement 2.12 for a Member_Label: the message names the field and its range. */
const LABEL_RANGE_MESSAGE = lengthRangeMessage(
  FIELD_NAMES.memberLabel,
  1,
  MEMBER_LABEL_MAX_LENGTH
)

/** Requirement 2.12 for a Hive_ID. */
const HIVE_ID_RANGE_MESSAGE = lengthRangeMessage(
  FIELD_NAMES.hiveId,
  1,
  HIVE_ID_MAX_LENGTH
)

/** What `add` must answer a rejected submission with. */
type ExpectedRejection =
  /** Requirement 2.12. */
  | {
      readonly kind: "invalid"
      readonly field: MemberField
      readonly message: string
    }
  /** Requirement 2.4. */
  | { readonly kind: "duplicate"; readonly conflictingLabel: string }

/** One sample of the main property: a roster, a submission, and its rejection. */
interface RejectionSample {
  readonly stored: ReadonlyArray<MemberRegistryEntry>
  readonly submission: AddMemberFields
  readonly expected: ExpectedRejection
}

/* -------------------------------------------------------------------------- */
/* Seeding and observing the collection                                       */
/* -------------------------------------------------------------------------- */

/**
 * One Store_Document as this file compares it: every field, with the two values
 * the driver hands back as objects reduced to text so a deep comparison is over
 * plain data.
 */
interface MemberSnapshot {
  readonly id: string
  readonly entryId: string
  readonly memberLabel: string
  readonly hiveId: string
  readonly enabled: boolean
  readonly createdAt: string
  readonly position: number
}

/**
 * Seeds `entries` as Store_Documents, in the order given, at positions 1..n,
 * and raises the `member_position` counter to n so the store's next `position`
 * is above every seeded one (Requirement 2.1).
 *
 * The mapping is `toMemberDocument`, the same function the store writes
 * through, so a seeded roster is indistinguishable from an added one.
 */
async function seedMembers(
  sample: MongoSample,
  entries: ReadonlyArray<MemberRegistryEntry>
): Promise<void> {
  if (entries.length === 0) {
    return
  }
  const db = sample.db()
  await db
    .collection<MemberDocumentInput>("members")
    .insertMany(entries.map((entry, at) => toMemberDocument(entry, at + 1)))
  await db
    .collection<CounterDocument>("counters")
    .insertOne({ _id: "member_position", value: entries.length })
}

/** Every Store_Document of the `members` collection, in `position` order. */
async function snapshotMembers(
  sample: MongoSample
): Promise<Array<MemberSnapshot>> {
  const documents = await sample
    .db()
    .collection<MemberDocumentInput>("members")
    .find({}, { sort: { position: 1 } })
    .toArray()

  return documents.map((document) => ({
    id: document._id.toHexString(),
    entryId: document.entryId,
    memberLabel: document.memberLabel,
    hiveId: document.hiveId,
    enabled: document.enabled,
    createdAt: document.createdAt.toISOString(),
    position: document.position,
  }))
}

/* -------------------------------------------------------------------------- */
/* Generators                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A roster small enough that a sample is one bulk insert and a handful of round
 * trips. The size of the roster is not what the range and duplicate clauses
 * vary; the cap clause below is where the count matters.
 */
const SMALL_ROSTER_MAX = 4

/** A Member_Label violating Requirement 2.12, with any Hive_ID at all. */
const invalidLabelSampleArb: fc.Arbitrary<RejectionSample> = fc
  .tuple(
    rosterArb({ maxLength: SMALL_ROSTER_MAX }),
    invalidMemberLabelArb,
    anyHiveIdArb
  )
  .map(([stored, memberLabel, hiveId]) => ({
    stored,
    submission: { memberLabel, hiveId },
    /*
     * The Member_Label is checked first, so a submission violating both rules
     * names the first field of the form — which is why the Hive_ID here is
     * drawn from either kind.
     */
    expected: {
      kind: "invalid" as const,
      field: "memberLabel" as const,
      message: LABEL_RANGE_MESSAGE,
    },
  }))

/** An acceptable Member_Label and a Hive_ID violating Requirement 2.12. */
const invalidHiveIdSampleArb: fc.Arbitrary<RejectionSample> = fc
  .tuple(
    rosterArb({ maxLength: SMALL_ROSTER_MAX }),
    validMemberLabelArb,
    invalidHiveIdArb
  )
  .map(([stored, memberLabel, hiveId]) => ({
    stored,
    submission: { memberLabel, hiveId },
    expected: {
      kind: "invalid" as const,
      field: "hiveId" as const,
      message: HIVE_ID_RANGE_MESSAGE,
    },
  }))

/**
 * A Hive_ID that trims to one already stored, character for character
 * (Requirement 2.4). The padding is what makes the comparison happen after
 * trimming rather than before it.
 */
const duplicateSampleArb: fc.Arbitrary<RejectionSample> = rosterArb({
  minLength: 1,
  maxLength: SMALL_ROSTER_MAX,
}).chain((stored) =>
  fc
    .tuple(
      fc.nat({ max: stored.length - 1 }),
      validMemberLabelArb,
      whitespacePaddingArb,
      whitespacePaddingArb
    )
    .map(([at, memberLabel, left, right]) => ({
      stored,
      submission: {
        memberLabel,
        hiveId: `${left}${stored[at].hiveId}${right}`,
      },
      expected: {
        kind: "duplicate" as const,
        conflictingLabel: stored[at].memberLabel,
      },
    }))
)

/** Every rejection reason of Requirements 2.4 and 2.12, in one sample space. */
const rejectionSampleArb: fc.Arbitrary<RejectionSample> = fc.oneof(
  { weight: 2, arbitrary: invalidLabelSampleArb },
  { weight: 2, arbitrary: invalidHiveIdSampleArb },
  { weight: 3, arbitrary: duplicateSampleArb }
)

/* The cap clause: a roster at or above the maximum, and a fresh submission. */

/** Requirement 2.5 triggers at the maximum and stays triggered above it. */
const fullRosterArb: fc.Arbitrary<Array<MemberRegistryEntry>> = fc
  .integer({
    min: MEMBER_REGISTRY_MAX_ENTRIES,
    max: MEMBER_REGISTRY_MAX_ENTRIES + 1,
  })
  .chain((count) => rosterArb({ minLength: count, maxLength: count }))

/** A submission that violates nothing but the cap. */
const capSubmissionArb: fc.Arbitrary<AddMemberFields> = fc.record({
  memberLabel: validMemberLabelArb,
  hiveId: validHiveIdArb,
})

/* The accepted clause: a Hive_ID differing from a stored one only in case. */

/** Units a case-foldable Hive_ID is built from. */
const FOLDABLE_UNITS = "abcdefghijklmnopqrstuvwxyz0123456789-".split("")

/** The letters one of which every case-foldable Hive_ID holds. */
const LOWER_LETTERS = "abcdefghijklmnopqrstuvwxyz".split("")

/**
 * A lower-case Hive_ID holding at least one ASCII letter, so it has a case
 * variant that differs from it. Every value is its own trimmed form.
 */
const foldableHiveIdArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.string({ unit: fc.constantFrom(...FOLDABLE_UNITS), maxLength: 12 }),
    fc.constantFrom(...LOWER_LETTERS),
    fc.string({ unit: fc.constantFrom(...FOLDABLE_UNITS), maxLength: 12 })
  )
  .map(([before, letter, after]) => `${before}${letter}${after}`)

/**
 * Every spelling of `hiveId` that differs from it only in letter case: the
 * fully upper-cased form, and each single-letter flip. Non-empty for every
 * {@link foldableHiveIdArb} value, because each holds at least one letter.
 */
function caseVariants(hiveId: string): Array<string> {
  const variants: Array<string> = []
  const upper = hiveId.toUpperCase()
  if (upper !== hiveId) {
    variants.push(upper)
  }
  for (let at = 0; at < hiveId.length; at += 1) {
    const flipped =
      hiveId.slice(0, at) + hiveId[at].toUpperCase() + hiveId.slice(at + 1)
    if (flipped !== hiveId) {
      variants.push(flipped)
    }
  }
  return variants
}

/** A roster, one of its Hive_IDs re-cased, and the submission carrying it. */
interface CaseVariantSample {
  readonly stored: ReadonlyArray<MemberRegistryEntry>
  readonly submission: AddMemberFields
  /** The trimmed Hive_ID the accepted entry must hold. */
  readonly expectedHiveId: string
}

/** Fixed base instant, so a seeded `createdAt` is deterministic across runs. */
const SEED_BASE_TIME = Date.parse("2025-02-01T09:00:00.000Z")

/**
 * A roster whose Hive_IDs are distinct case-insensitively, so a case variant of
 * one of them collides with none of the others and the acceptance is genuinely
 * about letter case rather than about an accidental gap in the roster.
 */
const caseVariantSampleArb: fc.Arbitrary<CaseVariantSample> = fc
  .uniqueArray(
    fc.record({
      memberLabel: trimmedMemberLabelArb,
      hiveId: foldableHiveIdArb,
      enabled: fc.boolean(),
    }),
    {
      minLength: 1,
      maxLength: SMALL_ROSTER_MAX,
      selector: (seed) => seed.hiveId,
    }
  )
  .map((seeds) =>
    seeds.map((seed, at): MemberRegistryEntry => ({
      id: `seeded-${at}`,
      memberLabel: seed.memberLabel,
      hiveId: seed.hiveId,
      enabled: seed.enabled,
      createdAt: new Date(SEED_BASE_TIME + at * 1_000).toISOString(),
    }))
  )
  .chain((stored) =>
    fc
      .tuple(
        fc.nat({ max: stored.length - 1 }),
        fc.nat(),
        validMemberLabelArb,
        whitespacePaddingArb,
        whitespacePaddingArb
      )
      .map(([at, variantPick, memberLabel, left, right]) => {
        const variants = caseVariants(stored[at].hiveId)
        const hiveId = variants[variantPick % variants.length]
        return {
          stored,
          submission: { memberLabel, hiveId: `${left}${hiveId}${right}` },
          expectedHiveId: hiveId,
        }
      })
  )

/* -------------------------------------------------------------------------- */
/* The property                                                               */
/* -------------------------------------------------------------------------- */

const mongo = await mongoAvailability()

describe.skipIf(!mongo.available)(
  "Property 6: a rejected roster submission changes nothing and names its reason",
  () => {
    afterAll(closeMongoFixture)

    it("inserts nothing and names the reason for a range violation or a duplicate", async () => {
      await fc.assert(
        fc.asyncProperty(rejectionSampleArb, async (sample) => {
          await withThrowawayDatabase(
            async (throwaway) => {
              await seedMembers(throwaway, sample.stored)
              const before = await snapshotMembers(throwaway)
              expect(before.length).toBe(sample.stored.length)

              const registry = createMemberRegistryStore(
                await throwaway.createStore()
              )
              const result = await registry.add(sample.submission)

              // The reason, and the message that names its subject.
              expect(result.kind).toBe(sample.expected.kind)
              if (
                result.kind === "invalid" &&
                sample.expected.kind === "invalid"
              ) {
                expect(result.field).toBe(sample.expected.field)
                expect(result.message).toBe(sample.expected.message)
              } else if (
                result.kind === "duplicate" &&
                sample.expected.kind === "duplicate"
              ) {
                expect(result.conflictingLabel).toBe(
                  sample.expected.conflictingLabel
                )
                expect(
                  duplicateHiveIdMessage(result.conflictingLabel)
                ).toContain(sample.expected.conflictingLabel)
              }

              // No Store_Document inserted, and the collection unchanged.
              expect(await snapshotMembers(throwaway)).toEqual(before)
            },
            { label: "rejection" }
          )
        }),
        { numRuns: 100 }
      )
    })

    it("rejects every submission arriving at the maximum and states that maximum", async () => {
      await fc.assert(
        fc.asyncProperty(
          fullRosterArb,
          capSubmissionArb,
          async (stored, submission) => {
            /*
             * A candidate Hive_ID that happens to equal a stored one is
             * Requirement 2.4's case, reported ahead of the cap, so it is not
             * a sample of this clause. The space of Hive_IDs makes this
             * essentially unreachable; the guard is here so a shrink cannot
             * land on it and read as a failure.
             */
            fc.pre(
              !stored.some((entry) => entry.hiveId === submission.hiveId.trim())
            )

            await withThrowawayDatabase(
              async (throwaway) => {
                await seedMembers(throwaway, stored)
                const before = await snapshotMembers(throwaway)
                expect(before.length).toBeGreaterThanOrEqual(
                  MEMBER_REGISTRY_MAX_ENTRIES
                )

                const registry = createMemberRegistryStore(
                  await throwaway.createStore()
                )
                const result = await registry.add(submission)

                expect(result.kind).toBe("full")
                /* The sentence a `full` result renders states the maximum. */
                expect(rosterFullMessage()).toContain(
                  String(MEMBER_REGISTRY_MAX_ENTRIES)
                )

                expect(await snapshotMembers(throwaway)).toEqual(before)
              },
              { label: "cap" }
            )
          }
        ),
        { numRuns: 100 }
      )
    } /*
     * Each sample seeds 100 or 101 documents in one bulk insert over its own
     * throwaway database. That is cheap per sample and still 100 databases,
     * so the bound is raised above the 30s default rather than the run count
     * lowered below the floor the property suite is audited against.
     */, 120_000)

    it("accepts a Hive_ID differing from a stored one only in letter case", async () => {
      await fc.assert(
        fc.asyncProperty(caseVariantSampleArb, async (sample) => {
          await withThrowawayDatabase(
            async (throwaway) => {
              await seedMembers(throwaway, sample.stored)
              const before = await snapshotMembers(throwaway)

              const registry = createMemberRegistryStore(
                await throwaway.createStore()
              )
              const result = await registry.add(sample.submission)

              expect(result.kind).toBe("added")
              if (result.kind !== "added") return

              expect(result.entry.hiveId).toBe(sample.expectedHiveId)
              expect(result.entry.memberLabel).toBe(
                sample.submission.memberLabel.trim()
              )
              expect(result.entry.enabled).toBe(true)

              /*
               * Exactly one Store_Document added, every seeded one untouched,
               * and the new `position` above all of them: the case variant is a
               * distinct Hive_ID, not an overwrite of the one it folds onto.
               */
              const after = await snapshotMembers(throwaway)
              expect(after.length).toBe(before.length + 1)
              expect(
                after.filter((document) => document.position <= before.length)
              ).toEqual(before)
              const added = after.find(
                (document) => document.entryId === result.entry.id
              )
              expect(added?.hiveId).toBe(sample.expectedHiveId)
              expect(added?.position).toBeGreaterThan(before.length)
            },
            { label: "case-variant" }
          )
        }),
        { numRuns: 100 }
      )
    })
  }
)

it.runIf(!mongo.available)(
  `skipped, no MongoDB: ${mongoSkipReason(mongo) ?? ""}`,
  () => {
    reportMongoSkip(
      "rosterSubmissionRejection property (Property 6, Requirements 2.4, 2.5, 2.12)",
      mongo
    )
    expect(mongo.available).toBe(false)
    expect(mongoSkipReason(mongo)).not.toBeNull()
  }
)
