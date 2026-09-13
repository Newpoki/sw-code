/**
 * Property 12 of shared-coupon-redemption: the Member_Registry invariants hold
 * under any sequence of roster mutations.
 *
 * The Member_Registry is the input of every Redemption_Run: its order is the
 * processing order (Requirement 5.5), its Hive_IDs are the `hiveid` values sent
 * upstream, and its size bounds the work a single run can do. So the four
 * structural claims of Requirement 1 — append order, Hive_ID uniqueness under
 * exact character comparison after trimming, the 100-entry cap, and the last
 * submitted enabled state per surviving entry — are asserted here against a
 * model rather than against hand-picked sequences.
 *
 * The model is a plain array kept beside the store. Every operation is applied
 * to both, the expected result is derived from the model, and the whole array is
 * compared afterwards. Order, uniqueness, and the cap therefore do not need
 * individual assertions: a store that reordered survivors, admitted a duplicate,
 * or grew past the cap would no longer equal the model.
 *
 * The store is the in-memory Mongo_Store of `tests/support/inMemoryMongoStore.ts`
 * and every operation is `async`, reads included. "Append order" is now the
 * `position` field ascending, assigned by the `member_position` counter, and the
 * database applies it — which is why the model, an array in insertion order, is
 * still the right prediction of it.
 *
 * The Requirement 1.12 half of the property changed shape. Nothing reports
 * `persisted` any more: a `kind` of `added`, `updated`, or `removed` means the
 * write is in the database (Requirement 2.9 of mongodb-google-auth-admin), so
 * what is asserted instead is that every successful mutation reports one of
 * those, that no operation answers `failed`, and that nothing is logged.
 *
 * Requirements 1.1, 1.4, 1.9, 1.11, 1.12.
 */

import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
  MEMBER_REGISTRY_MAX_ENTRIES,
  createMemberRegistryStore,
} from "@/server/store/memberRegistry.server"
import type { MemberRegistryStore } from "@/server/store/memberRegistry.server"
import type { MemberRegistryEntry } from "@/domain/types"

import { createInMemoryMongoStore } from "../support/inMemoryMongoStore"
import {
  validHiveIdArb,
  validMemberLabelArb,
  whitespacePaddingArb,
} from "./generators"

/* -------------------------------------------------------------------------- */
/* Operations                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One roster mutation. The three operations that target an existing entry carry
 * a `pick` rather than an id, because the ids only exist once the run is under
 * way; `pick` is reduced modulo the current roster size at application time.
 */
type RosterOperation =
  /** A submission whose Hive_ID is whatever the generator produced. */
  | {
      readonly kind: "add"
      readonly memberLabel: string
      readonly hiveId: string
    }
  /**
   * A submission reusing the Hive_ID of an existing entry, wrapped in
   * whitespace, so the uniqueness check is exercised after trimming rather than
   * only on the stored form (Requirement 1.2 as the uniqueness half of this
   * property).
   */
  | {
      readonly kind: "add-padded-duplicate"
      readonly memberLabel: string
      readonly pick: number
      readonly leftPad: string
      readonly rightPad: string
    }
  /**
   * A submission reusing an existing Hive_ID with its letter case swapped. The
   * comparison is exact, so this is a distinct Hive_ID whenever the swap changed
   * anything, and the model predicts either outcome without a special case.
   */
  | {
      readonly kind: "add-case-variant"
      readonly memberLabel: string
      readonly pick: number
    }
  | {
      readonly kind: "set-enabled"
      readonly pick: number
      readonly enabled: boolean
    }
  | { readonly kind: "remove"; readonly pick: number }
  | {
      readonly kind: "set-enabled-unknown"
      readonly token: number
      readonly enabled: boolean
    }
  | { readonly kind: "remove-unknown"; readonly token: number }

const addArb: fc.Arbitrary<RosterOperation> = fc
  .tuple(validMemberLabelArb, validHiveIdArb)
  .map(([memberLabel, hiveId]) => ({
    kind: "add" as const,
    memberLabel,
    hiveId,
  }))

const addPaddedDuplicateArb: fc.Arbitrary<RosterOperation> = fc
  .tuple(
    validMemberLabelArb,
    fc.nat({ max: 199 }),
    whitespacePaddingArb,
    whitespacePaddingArb
  )
  .map(([memberLabel, pick, leftPad, rightPad]) => ({
    kind: "add-padded-duplicate" as const,
    memberLabel,
    pick,
    leftPad,
    rightPad,
  }))

const addCaseVariantArb: fc.Arbitrary<RosterOperation> = fc
  .tuple(validMemberLabelArb, fc.nat({ max: 199 }))
  .map(([memberLabel, pick]) => ({
    kind: "add-case-variant" as const,
    memberLabel,
    pick,
  }))

const setEnabledArb: fc.Arbitrary<RosterOperation> = fc
  .tuple(fc.nat({ max: 199 }), fc.boolean())
  .map(([pick, enabled]) => ({ kind: "set-enabled" as const, pick, enabled }))

const removeArb: fc.Arbitrary<RosterOperation> = fc
  .nat({ max: 199 })
  .map((pick) => ({ kind: "remove" as const, pick }))

const setEnabledUnknownArb: fc.Arbitrary<RosterOperation> = fc
  .tuple(fc.nat({ max: 999 }), fc.boolean())
  .map(([token, enabled]) => ({
    kind: "set-enabled-unknown" as const,
    token,
    enabled,
  }))

const removeUnknownArb: fc.Arbitrary<RosterOperation> = fc
  .nat({ max: 999 })
  .map((token) => ({ kind: "remove-unknown" as const, token }))

/**
 * A mutation sequence. Adds outweigh removals so the roster grows and the later
 * operations act on a non-trivial roster; the two unknown-id operations stay
 * rare because they are a single branch each.
 */
const operationsArb: fc.Arbitrary<Array<RosterOperation>> = fc.array(
  fc.oneof(
    { weight: 6, arbitrary: addArb },
    { weight: 2, arbitrary: addPaddedDuplicateArb },
    { weight: 1, arbitrary: addCaseVariantArb },
    { weight: 4, arbitrary: setEnabledArb },
    { weight: 3, arbitrary: removeArb },
    { weight: 1, arbitrary: setEnabledUnknownArb },
    { weight: 1, arbitrary: removeUnknownArb }
  ),
  { minLength: 1, maxLength: 24 }
)

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface Harness {
  readonly registry: MemberRegistryStore
  /** Everything the store logged. Nothing here fails, so it stays empty. */
  readonly warnings: readonly string[]
}

/**
 * A Member_Registry over an in-memory Mongo_Store: no deployment, no
 * filesystem, and every write served, so a `failed` result anywhere below is a
 * genuine falsification rather than an arranged one.
 */
function createHarness(): Harness {
  const handle = createInMemoryMongoStore()
  let nextId = 0
  let clock = Date.parse("2025-01-04T18:00:00.000Z")

  const registry = createMemberRegistryStore(handle.store, {
    generateId: () => {
      nextId += 1
      return `m-${nextId}`
    },
    now: () => {
      clock += 1000
      return new Date(clock)
    },
  })

  return { registry, warnings: handle.warnings }
}

/** The stored roster in position order, or a thrown explanation. */
async function entriesOf(
  registry: MemberRegistryStore
): Promise<readonly MemberRegistryEntry[]> {
  const listed = await registry.list()
  if (listed.kind !== "entries") {
    throw new Error(`the roster read reported "${listed.kind}"`)
  }
  return listed.entries
}

/** The enabled entries in position order, or a thrown explanation. */
async function enabledEntriesOf(
  registry: MemberRegistryStore
): Promise<readonly MemberRegistryEntry[]> {
  const listed = await registry.listEnabled()
  if (listed.kind !== "entries") {
    throw new Error(`the enabled roster read reported "${listed.kind}"`)
  }
  return listed.entries
}

/**
 * The same string with the letter case of every character swapped, leaving the
 * UTF-16 length unchanged. A character whose case mapping changes length — `ß`
 * uppercases to `SS` — is left alone, so a Hive_ID at the 64-character boundary
 * cannot be pushed over it by this transformation.
 */
function swapCase(value: string): string {
  return [...value]
    .map((character) => {
      const upper = character.toUpperCase()
      const lower = character.toLowerCase()
      if (character === lower && upper.length === character.length) {
        return upper
      }
      if (character === upper && lower.length === character.length) {
        return lower
      }
      return character
    })
    .join("")
}

/** The entry `pick` selects, or null when the roster is empty. */
function pickIndex(model: ReadonlyArray<unknown>, pick: number): number | null {
  return model.length === 0 ? null : pick % model.length
}

/**
 * Submits `memberLabel` / `hiveId` and asserts the outcome the model predicts.
 *
 * The three branches mirror the store's own precedence — duplicate before full —
 * and both rejections additionally assert that the roster is byte-identical to
 * what it was before the call (Requirements 1.2, 1.11).
 */
async function applyAdd(
  harness: Harness,
  model: Array<MemberRegistryEntry>,
  memberLabel: string,
  hiveId: string
): Promise<void> {
  const before = await entriesOf(harness.registry)
  const trimmedHiveId = hiveId.trim()
  const conflict = model.find((entry) => entry.hiveId === trimmedHiveId)

  const result = await harness.registry.add({ memberLabel, hiveId })

  if (conflict !== undefined) {
    expect(result).toEqual({
      kind: "duplicate",
      conflictingLabel: conflict.memberLabel,
    })
    expect(await entriesOf(harness.registry)).toEqual(before)
    return
  }

  if (model.length >= MEMBER_REGISTRY_MAX_ENTRIES) {
    expect(result).toEqual({ kind: "full" })
    expect(before).toHaveLength(MEMBER_REGISTRY_MAX_ENTRIES)
    expect(await entriesOf(harness.registry)).toEqual(before)
    return
  }

  if (result.kind !== "added") {
    throw new Error(
      `expected the submission of ${JSON.stringify(hiveId)} to be added, got ${
        result.kind
      }`
    )
  }

  // Requirement 1.1: the stored pair is the trimmed submission with letter case
  // preserved, and the new entry is enabled.
  expect(result.entry.memberLabel).toBe(memberLabel.trim())
  expect(result.entry.hiveId).toBe(trimmedHiveId)
  expect(result.entry.enabled).toBe(true)

  model.push(result.entry)
}

/** Applies one operation to the store and to the model. */
async function applyOperation(
  harness: Harness,
  model: Array<MemberRegistryEntry>,
  operation: RosterOperation
): Promise<void> {
  switch (operation.kind) {
    case "add": {
      await applyAdd(harness, model, operation.memberLabel, operation.hiveId)
      return
    }

    case "add-padded-duplicate": {
      const index = pickIndex(model, operation.pick)
      if (index === null) return
      const hiveId = `${operation.leftPad}${model[index].hiveId}${operation.rightPad}`
      await applyAdd(harness, model, operation.memberLabel, hiveId)
      return
    }

    case "add-case-variant": {
      const index = pickIndex(model, operation.pick)
      if (index === null) return
      await applyAdd(
        harness,
        model,
        operation.memberLabel,
        swapCase(model[index].hiveId)
      )
      return
    }

    case "set-enabled": {
      const index = pickIndex(model, operation.pick)
      if (index === null) return
      const target = model[index]

      const result = await harness.registry.setEnabled(
        target.id,
        operation.enabled
      )

      if (result.kind !== "updated") {
        throw new Error(
          `expected the enabled state of ${target.id} to be stored, got ${result.kind}`
        )
      }
      // Requirement 1.9: the submitted state is stored and the updated entry is
      // returned with its Member_Label and Hive_ID untouched.
      expect(result.entry).toEqual({ ...target, enabled: operation.enabled })

      model[index] = result.entry
      return
    }

    case "remove": {
      const index = pickIndex(model, operation.pick)
      if (index === null) return
      const target = model[index]

      const result = await harness.registry.remove(target.id)

      if (result.kind !== "removed") {
        throw new Error(
          `expected ${target.id} to be removed, got ${result.kind}`
        )
      }

      model.splice(index, 1)
      return
    }

    case "set-enabled-unknown": {
      const before = await entriesOf(harness.registry)
      const result = await harness.registry.setEnabled(
        `unknown-${operation.token}`,
        operation.enabled
      )
      expect(result).toEqual({ kind: "not-found" })
      expect(await entriesOf(harness.registry)).toEqual(before)
      return
    }

    case "remove-unknown": {
      const before = await entriesOf(harness.registry)
      const result = await harness.registry.remove(`unknown-${operation.token}`)
      expect(result).toEqual({ kind: "not-found" })
      expect(await entriesOf(harness.registry)).toEqual(before)
      return
    }
  }
}

/**
 * Fills the roster to exactly {@link MEMBER_REGISTRY_MAX_ENTRIES} entries, so a
 * generated sequence can reach the cap without spending a hundred generated
 * operations on getting there (Requirement 1.11).
 */
async function fillToCap(
  harness: Harness,
  model: Array<MemberRegistryEntry>
): Promise<void> {
  for (
    let position = model.length;
    position < MEMBER_REGISTRY_MAX_ENTRIES;
    position += 1
  ) {
    const result = await harness.registry.add({
      memberLabel: `Seeded member ${position}`,
      hiveId: `seed-hive-${position}`,
    })
    if (result.kind !== "added") {
      throw new Error(`could not seed entry ${position}: ${result.kind}`)
    }
    model.push(result.entry)
  }
}

/** The invariants that hold after every single operation. */
async function assertInvariants(
  harness: Harness,
  model: ReadonlyArray<MemberRegistryEntry>
): Promise<void> {
  const list = await entriesOf(harness.registry)

  // Order and content: position order for an add, in-place replacement for
  // `setEnabled`, gap closed without renumbering for a `remove`
  // (Requirements 1.4, 1.9).
  expect(list).toEqual(model)

  // Requirement 1.11: the cap is never exceeded.
  expect(list.length).toBeLessThanOrEqual(MEMBER_REGISTRY_MAX_ENTRIES)

  // Hive_ID uniqueness under exact character comparison, and unambiguous ids.
  const hiveIds = new Set(list.map((entry) => entry.hiveId))
  expect(hiveIds.size).toBe(list.length)
  const ids = new Set(list.map((entry) => entry.id))
  expect(ids.size).toBe(list.length)

  // Requirement 1.6 read of the same order: the fixed list of a Redemption_Run
  // is the enabled entries in roster order.
  expect(await enabledEntriesOf(harness.registry)).toEqual(
    model.filter((entry) => entry.enabled)
  )

  // Every operation above was served, so nothing was warned about.
  expect(harness.warnings).toEqual([])
}

describe("Member_Registry mutation invariants", () => {
  // Feature: shared-coupon-redemption, Property 12: For any sequence of add,
  // enable/disable, and remove operations applied to a Member_Registry, the
  // roster the Redemption_Server serves holds its entries ordered from the
  // earliest stored to the most recently stored, holds no two entries with the
  // same Hive_ID, holds at most 100 entries, reflects for each surviving entry
  // the last enabled state submitted for it, and accompanies every successful
  // mutation whose store write succeeded with zero persistence warning messages.
  // Validates: Requirements 1.1, 1.4, 1.9, 1.11, 1.12
  it("preserves order, uniqueness, and the cap across any mutation sequence", async () => {
    await fc.assert(
      fc.asyncProperty(
        operationsArb,
        // A quarter of the samples start at the cap, so the `full` branch and
        // the operations that follow it are exercised too.
        fc.oneof(
          { weight: 3, arbitrary: fc.constant(false) },
          { weight: 1, arbitrary: fc.constant(true) }
        ),
        async (operations, startAtCap) => {
          const harness = createHarness()
          const model: Array<MemberRegistryEntry> = []

          if (startAtCap) {
            await fillToCap(harness, model)
            await assertInvariants(harness, model)
          }

          for (const operation of operations) {
            await applyOperation(harness, model, operation)
            await assertInvariants(harness, model)
          }
        }
      ),
      { numRuns: 100 }
    )
  })
})
