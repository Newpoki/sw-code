// Feature: mongodb-google-auth-admin, Property 5: A sequence of roster mutations
// preserves order, identity, and durability — for any sequence of Member_Registry
// operations (adds of valid submissions, enabled-state changes, and removals,
// addressed both to present and to absent identifiers) the roster read afterwards
// returns exactly the entries that were accepted and not since removed, ordered
// by their acceptance order; every accepted entry holds its whitespace-trimmed
// Member_Label and Hive_ID and the enabled state its most recent accepted change
// submitted; every field other than the enabled state is unchanged by an
// enabled-state change; every operation addressed to an absent identifier leaves
// the collection unchanged and reports absence; every accepted operation returns
// the affected entry with zero persistence warnings; and reading that roster
// through a second Mongo_Store built over the same database returns the identical
// entries in the identical order.
//
// Validates: Requirements 2.1, 2.2, 2.3, 2.7, 2.9, 2.13.
//
// ## Why this one runs against a real database
//
// The restart clause is the whole point of the property, and it is the one claim
// a stub cannot make: "the same entries in the same order after a restart" means
// a second `MongoStore` — its own client, its own pool, its own bootstrap — reads
// only what the first one durably wrote. `tests/support/mongoFixture.ts` gives
// each sample a throwaway database and lets a sample build that second store over
// it, which is exactly the shape Requirement 2.3 describes.
//
// Order is the other reason. Roster order is the `position` field assigned by the
// `member_position` counter and sorted in the database, so "acceptance order" is a
// claim about a counter and a sort that only a deployment can settle.
//
// ## The model
//
// A plain array kept beside the store, in acceptance order. Every operation is
// applied to both, the expected result is derived from the model, and the whole
// array is compared after every single operation. Order and identity therefore
// need no separate assertions: a store that reordered survivors, mutated a
// Member_Label during an enabled-state change, or resurrected a removed entry
// would stop equalling the model.
//
// Two things are asserted below the domain seam, through the fixture's own driver
// handle, because Requirement 2.7 names a field the domain value does not carry:
// the `position` of a Store_Document is read before and after each enabled-state
// change, so "the position value unchanged" is checked rather than inferred from
// the order of a later read.
//
// ## What is deliberately out of scope
//
// Duplicate Hive_IDs, the 100-entry cap, and over-long or blank fields are
// Property 6's subject (Requirements 2.4, 2.5, 2.12). This property quantifies
// over *valid* submissions, so every generated Hive_ID carries a per-sample
// sequence suffix and is unique by construction, and every add is expected to be
// accepted. A rejection here is a failure, not a branch.
//
// ## Cost, and the run count
//
// Each sample creates a database, bootstraps two stores over it, and drops the
// database in a `finally`. That is why the sequences are short — at most six
// operations — rather than why the run count is low: this file states the
// property at the full 100 runs, and the whole assertion is given its own
// generous timeout instead, since the 30-second default in `vitest.config.ts` is
// sized for properties that touch nothing outside the process.
//
// With no MongoDB configured the suite skips, and the reason is stated as the
// name of a test that does run — the pattern `tests/integration/mongoBootstrap.test.ts`
// established, so a skipped property says why in the report rather than passing
// vacuously.

import fc from "fast-check"
import { afterAll, describe, expect, it } from "vitest"

import { HIVE_ID_MAX_LENGTH, MEMBER_LABEL_MAX_LENGTH } from "@/domain/schemas"
import { createMemberRegistryStore } from "@/server/store/memberRegistry.server"

import {
  closeMongoFixture,
  mongoAvailability,
  mongoSkipReason,
  reportMongoSkip,
  withThrowawayDatabase,
} from "../support/mongoFixture"

import type { MemberRegistryEntry } from "@/domain/types"
import type { MemberDocument } from "@/server/store/documents.server"
import type { MemberRegistryStore } from "@/server/store/memberRegistry.server"
import type { MongoStore } from "@/server/store/mongo.server"
import type { MongoSample } from "../support/mongoFixture"

/* -------------------------------------------------------------------------- */
/* Local arbitraries                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Text units a Member_Label is assembled from: ASCII including the internal
 * space a label may hold, the precomposed and decomposed spellings of an
 * accented character, a standalone combining mark, astral-plane characters (a
 * surrogate pair each), and non-Latin scripts including a right-to-left one. A
 * label that survives a round trip through the driver has to survive all of
 * them, and a `position` sort must not care which it holds.
 */
const LABEL_UNITS: ReadonlyArray<string> = [
  "a",
  "Q",
  "7",
  " ",
  "-",
  "'",
  "é",
  "e\u0301",
  "\u0301",
  "🐝",
  "𝔘",
  "漢",
  "ب",
]

/** The characters a Hive_ID is drawn from. */
const HIVE_UNITS: ReadonlyArray<string> = Array.from(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"
)

/**
 * Leading and trailing padding a submission may carry. Every kind of whitespace
 * `String.prototype.trim` removes is here, because Requirements 2.1 and 2.7
 * speak about the value *after* removal of leading and trailing whitespace
 * characters and the store is what has to do the removing.
 */
const paddingArb: fc.Arbitrary<string> = fc.constantFrom(
  "",
  " ",
  "  ",
  "\t",
  "\n",
  " \t ",
  "\r\n "
)

/**
 * `units` joined while the total stays inside `maxUnits` UTF-16 code units, so a
 * sample never lands over a length limit and no surrogate pair is ever cut in
 * half — which slicing a joined string to a length would do.
 */
function joinWithin(
  units: ReadonlyArray<string>,
  maxUnits: number
): string | null {
  let text = ""
  for (const unit of units) {
    if (text.length + unit.length > maxUnits) break
    text += unit
  }
  return text.length === 0 ? null : text
}

/**
 * A Member_Label as it will be stored: 1 to 40 code units, already trimmed, so
 * whatever padding an operation adds is padding the store is expected to strip.
 */
const memberLabelArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...LABEL_UNITS), {
    minLength: 1,
    maxLength: 20,
    size: "max",
  })
  .map((units) => joinWithin(units, MEMBER_LABEL_MAX_LENGTH))
  .filter((label): label is string => label !== null)
  .map((label) => label.trim())
  .filter((label) => label.length >= 1)

/**
 * The Hive_ID core of one add. A per-sample sequence suffix is appended at
 * application time, so the room left here keeps the suffixed value inside
 * {@link HIVE_ID_MAX_LENGTH}.
 */
const HIVE_SUFFIX_UNITS = 4

const hiveCoreArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...HIVE_UNITS), {
    minLength: 1,
    maxLength: HIVE_ID_MAX_LENGTH - HIVE_SUFFIX_UNITS,
    size: "max",
  })
  .map((units) => units.join(""))

/* -------------------------------------------------------------------------- */
/* Operations                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One roster mutation.
 *
 * The three operations that address an existing entry carry a `pick` rather than
 * an identifier, because the identifiers only exist once the sequence is under
 * way; `pick` is reduced modulo the current roster size at application time, and
 * an operation that picks into an empty roster is a no-op.
 */
type RosterOperation =
  | {
      readonly kind: "add"
      readonly memberLabel: string
      readonly hiveCore: string
      readonly labelLeft: string
      readonly labelRight: string
      readonly hiveLeft: string
      readonly hiveRight: string
    }
  | {
      readonly kind: "set-enabled"
      readonly pick: number
      readonly enabled: boolean
    }
  | { readonly kind: "remove"; readonly pick: number }
  | {
      readonly kind: "set-enabled-absent"
      readonly token: number
      readonly enabled: boolean
    }
  | { readonly kind: "remove-absent"; readonly token: number }

const addArb: fc.Arbitrary<RosterOperation> = fc
  .record({
    memberLabel: memberLabelArb,
    hiveCore: hiveCoreArb,
    labelLeft: paddingArb,
    labelRight: paddingArb,
    hiveLeft: paddingArb,
    hiveRight: paddingArb,
  })
  .map((fields) => ({ kind: "add" as const, ...fields }))

const setEnabledArb: fc.Arbitrary<RosterOperation> = fc
  .tuple(fc.nat({ max: 99 }), fc.boolean())
  .map(([pick, enabled]) => ({ kind: "set-enabled" as const, pick, enabled }))

const removeArb: fc.Arbitrary<RosterOperation> = fc
  .nat({ max: 99 })
  .map((pick) => ({ kind: "remove" as const, pick }))

const setEnabledAbsentArb: fc.Arbitrary<RosterOperation> = fc
  .tuple(fc.nat({ max: 999 }), fc.boolean())
  .map(([token, enabled]) => ({
    kind: "set-enabled-absent" as const,
    token,
    enabled,
  }))

const removeAbsentArb: fc.Arbitrary<RosterOperation> = fc
  .nat({ max: 999 })
  .map((token) => ({ kind: "remove-absent" as const, token }))

/**
 * A mutation sequence. Adds outweigh the rest so the later operations act on a
 * roster with something in it; the two absent-identifier operations stay rare
 * because each is a single branch. At most six operations per sample, because
 * every one of them is a round trip to a real deployment.
 */
const operationsArb: fc.Arbitrary<Array<RosterOperation>> = fc.array(
  fc.oneof(
    { weight: 6, arbitrary: addArb },
    { weight: 3, arbitrary: setEnabledArb },
    { weight: 2, arbitrary: removeArb },
    { weight: 1, arbitrary: setEnabledAbsentArb },
    { weight: 1, arbitrary: removeAbsentArb }
  ),
  { minLength: 1, maxLength: 6 }
)

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface Harness {
  readonly sample: MongoSample
  readonly registry: MemberRegistryStore
  /** The roster as it should be, in acceptance order. */
  readonly model: Array<MemberRegistryEntry>
  /** Adds attempted so far, which is what makes each Hive_ID unique. */
  adds: number
}

/**
 * A Member_Registry over one throwaway database, with both injected seams made
 * deterministic: identifiers are `m-1`, `m-2`, … and the clock advances one
 * second per reading, so every entry carries a distinct creation timestamp and a
 * shrunk counterexample replays the same values.
 */
function createHarness(sample: MongoSample, store: MongoStore): Harness {
  let nextId = 0
  let clock = Date.parse("2025-03-01T09:00:00.000Z")

  const registry = createMemberRegistryStore(store, {
    generateId: () => {
      nextId += 1
      return `m-${nextId}`
    },
    now: () => {
      clock += 1_000
      return new Date(clock)
    },
  })

  return { sample, registry, model: [], adds: 0 }
}

/** The roster, or a thrown failure: a read that fails falsifies this property. */
async function readRoster(
  registry: MemberRegistryStore
): Promise<ReadonlyArray<MemberRegistryEntry>> {
  const result = await registry.list()
  if (result.kind !== "entries") {
    throw new Error(`the roster read failed: ${result.failure.reason}`)
  }
  return result.entries
}

/** The enabled entries, in the same order. */
async function readEnabled(
  registry: MemberRegistryStore
): Promise<ReadonlyArray<MemberRegistryEntry>> {
  const result = await registry.listEnabled()
  if (result.kind !== "entries") {
    throw new Error(`the enabled roster read failed: ${result.failure.reason}`)
  }
  return result.entries
}

/**
 * The Store_Document of one entry, read through the fixture's own client rather
 * than through the store, so `position` — which the domain value does not carry
 * — can be compared before and after an enabled-state change.
 */
async function storedPosition(
  sample: MongoSample,
  entryId: string
): Promise<number> {
  const document = await sample
    .db()
    .collection<MemberDocument>("members")
    .findOne({ entryId })
  if (document === null) {
    throw new Error(`no Store_Document holds the entryId ${entryId}`)
  }
  return document.position
}

/** The entry `pick` selects, or null when the roster is empty. */
function pickIndex(model: ReadonlyArray<unknown>, pick: number): number | null {
  return model.length === 0 ? null : pick % model.length
}

/**
 * Requirement 2.9: an accepted write returns the affected entry and nothing
 * resembling a persistence warning. The MongoDB store has no `persisted` field
 * at all — a `kind` of `added`, `updated`, or `removed` *means* the write is in
 * the database — so the absence of the field is part of the claim.
 */
function expectNoPersistenceWarning(harness: Harness, result: unknown): void {
  expect(result).not.toHaveProperty("persisted")
  expect(result).not.toHaveProperty("warning")
  expect(harness.sample.warnings).toEqual([])
}

/* -------------------------------------------------------------------------- */
/* Applying one operation to the store and to the model                       */
/* -------------------------------------------------------------------------- */

async function applyAdd(
  harness: Harness,
  operation: Extract<RosterOperation, { kind: "add" }>
): Promise<void> {
  harness.adds += 1
  /* The suffix is what makes every Hive_ID of a sample distinct, so an add is
   * always a valid submission and `duplicate` is a failure rather than a
   * branch. */
  const hiveId = `${operation.hiveCore}-${harness.adds}`
  const submittedLabel = `${operation.labelLeft}${operation.memberLabel}${operation.labelRight}`
  const submittedHiveId = `${operation.hiveLeft}${hiveId}${operation.hiveRight}`

  const result = await harness.registry.add({
    memberLabel: submittedLabel,
    hiveId: submittedHiveId,
  })

  if (result.kind !== "added") {
    throw new Error(
      `expected the submission of ${JSON.stringify(hiveId)} to be added, got ${result.kind}`
    )
  }

  // Requirement 2.1: the stored pair is the trimmed submission, letter case
  // preserved, and the new entry is enabled.
  expect(result.entry.memberLabel).toBe(operation.memberLabel)
  expect(result.entry.hiveId).toBe(hiveId)
  expect(result.entry.enabled).toBe(true)
  expect(Number.isNaN(Date.parse(result.entry.createdAt))).toBe(false)
  expectNoPersistenceWarning(harness, result)

  // Requirement 2.1: a position above every position already stored.
  const positions = await Promise.all(
    harness.model.map((entry) => storedPosition(harness.sample, entry.id))
  )
  const assigned = await storedPosition(harness.sample, result.entry.id)
  for (const position of positions) {
    expect(assigned).toBeGreaterThan(position)
  }

  harness.model.push(result.entry)
}

async function applySetEnabled(
  harness: Harness,
  operation: Extract<RosterOperation, { kind: "set-enabled" }>
): Promise<void> {
  const index = pickIndex(harness.model, operation.pick)
  if (index === null) return
  const target = harness.model[index]
  const positionBefore = await storedPosition(harness.sample, target.id)

  const result = await harness.registry.setEnabled(target.id, operation.enabled)

  if (result.kind !== "updated") {
    throw new Error(
      `expected the enabled state of ${target.id} to be written, got ${result.kind}`
    )
  }

  // Requirement 2.7: the submitted state, and every other field left alone.
  expect(result.entry).toEqual({ ...target, enabled: operation.enabled })
  expect(await storedPosition(harness.sample, target.id)).toBe(positionBefore)
  expectNoPersistenceWarning(harness, result)

  harness.model[index] = result.entry
}

async function applyRemove(
  harness: Harness,
  operation: Extract<RosterOperation, { kind: "remove" }>
): Promise<void> {
  const index = pickIndex(harness.model, operation.pick)
  if (index === null) return
  const target = harness.model[index]

  const result = await harness.registry.remove(target.id)

  if (result.kind !== "removed") {
    throw new Error(`expected ${target.id} to be removed, got ${result.kind}`)
  }
  expectNoPersistenceWarning(harness, result)

  harness.model.splice(index, 1)
}

/**
 * Requirement 2.13: an operation addressed to an identifier the collection does
 * not hold reports absence and changes nothing. The roster is read before and
 * after, so "changes nothing" is observed rather than assumed.
 */
async function applyAbsent(
  harness: Harness,
  operation: Extract<
    RosterOperation,
    { kind: "set-enabled-absent" } | { kind: "remove-absent" }
  >
): Promise<void> {
  const id = `absent-${operation.token}`
  const before = await readRoster(harness.registry)

  const result =
    operation.kind === "set-enabled-absent"
      ? await harness.registry.setEnabled(id, operation.enabled)
      : await harness.registry.remove(id)

  expect(result).toEqual({ kind: "not-found" })
  expect(await readRoster(harness.registry)).toEqual(before)
}

async function applyOperation(
  harness: Harness,
  operation: RosterOperation
): Promise<void> {
  switch (operation.kind) {
    case "add":
      return applyAdd(harness, operation)
    case "set-enabled":
      return applySetEnabled(harness, operation)
    case "remove":
      return applyRemove(harness, operation)
    case "set-enabled-absent":
    case "remove-absent":
      return applyAbsent(harness, operation)
  }
}

/** The invariants that hold after every single operation. */
async function assertInvariants(harness: Harness): Promise<void> {
  const roster = await readRoster(harness.registry)

  // Requirements 2.1, 2.2: acceptance order for an add, in-place replacement
  // for an enabled-state change, the gap closed without reordering for a
  // removal — and the identity fields of every survivor untouched.
  expect(roster).toEqual(harness.model)

  // Requirement 2.2: the enabled subset, in the same order.
  expect(await readEnabled(harness.registry)).toEqual(
    harness.model.filter((entry) => entry.enabled)
  )

  // Identity: no two entries share a Hive_ID or an identifier, so every
  // `pick` above addressed exactly one Store_Document.
  expect(new Set(roster.map((entry) => entry.hiveId)).size).toBe(roster.length)
  expect(new Set(roster.map((entry) => entry.id)).size).toBe(roster.length)

  // Requirement 2.9: every write above was accepted, so nothing was warned
  // about.
  expect(harness.sample.warnings).toEqual([])
}

/* -------------------------------------------------------------------------- */
/* The property                                                               */
/* -------------------------------------------------------------------------- */

const mongo = await mongoAvailability()

/** Ten minutes: 100 samples, each a database created, written, read, dropped. */
const PROPERTY_TIMEOUT_MS = 600_000

describe.skipIf(!mongo.available)(
  "Property 5: a sequence of roster mutations preserves order, identity, and durability",
  () => {
    afterAll(closeMongoFixture)

    it(
      "serves the accepted entries in acceptance order, before and after a restart",
      async () => {
        await fc.assert(
          fc.asyncProperty(operationsArb, async (operations) => {
            await withThrowawayDatabase(
              async (sample) => {
                const harness = createHarness(
                  sample,
                  await sample.createStore()
                )

                // Requirement 2.2: zero entries and zero errors to begin with.
                expect(await readRoster(harness.registry)).toEqual([])

                for (const operation of operations) {
                  await applyOperation(harness, operation)
                  await assertInvariants(harness)
                }

                /*
                 * Requirement 2.3, the restart: a second Mongo_Store over the
                 * same database — its own client, its own pool, its own
                 * bootstrap — reads only what the first one durably wrote. The
                 * registry over it is fresh too, so nothing is carried across
                 * in process memory.
                 */
                const restarted = createMemberRegistryStore(
                  await sample.createStore()
                )

                expect(await readRoster(restarted)).toEqual(harness.model)
                expect(await readEnabled(restarted)).toEqual(
                  harness.model.filter((entry) => entry.enabled)
                )
                expect(sample.warnings).toEqual([])
              },
              { label: "roster-seq" }
            )
          }),
          { numRuns: 100 }
        )
      },
      PROPERTY_TIMEOUT_MS
    )
  }
)

it.runIf(!mongo.available)(
  `skipped, no MongoDB: ${mongoSkipReason(mongo) ?? ""}`,
  () => {
    reportMongoSkip("Property 5 roster mutation sequences", mongo)
    expect(mongo.available).toBe(false)
    expect(mongoSkipReason(mongo)).not.toBeNull()
  }
)
