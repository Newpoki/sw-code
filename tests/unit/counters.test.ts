/**
 * Unit tests for the durable counters behind a Member_Registry `position` and a
 * Redemption_History `seq` (Requirements 2.1, 3.2).
 *
 * Three claims are pinned here. The first use of a counter yields 1, which is
 * the `$inc`-on-an-absent-document case Requirement 3.2 asks of the first
 * appended record. Successive uses are strictly increasing, per counter, with
 * the two counters advancing independently of each other. And a driver failure
 * yields a {@link StoreFailure} carrying the one fixed sentence a counter has to
 * speak with — {@link unreachableMessage} — and no fragment of the driver error
 * or of the Mongo_Connection_URI (Requirement 1.6).
 *
 * No MongoDB runs here. `nextCounterValue`'s second parameter is the seam, and
 * the store handed to it below is built by hand: its `collection()` either
 * serves a fake `counters` collection whose `findOneAndUpdate` models `$inc`
 * with `upsert: true` and `returnDocument: "after"`, or answers with a failure,
 * or serves a collection whose `findOneAndUpdate` rejects with a real driver
 * error. That is what makes "the document was absent" and "the deployment gave
 * no answer" states this file chooses rather than states it has to arrange. The
 * atomicity of the real `findOneAndUpdate` is the database's claim, not this
 * module's, and it is exercised by the history and roster property tests over a
 * throwaway database.
 */

import { describe, expect, it } from "vitest"

import {
  MongoNetworkError,
  MongoOperationTimeoutError,
  MongoServerError,
} from "mongodb"
import type {
  Collection,
  Document,
  Filter,
  FindOneAndUpdateOptions,
  UpdateFilter,
  WithId,
} from "mongodb"

import { unreachableMessage } from "@/domain/storeMessages"
import type { StoreFailure } from "@/domain/types"
import {
  isCounterFailure,
  nextCounterValue,
} from "@/server/store/counters.server"
import type { CounterName } from "@/server/store/counters.server"
import type { CounterDocument } from "@/server/store/documents.server"
import type {
  CollectionName,
  CollectionOrFailure,
  MongoStore,
} from "@/server/store/mongo.server"

/** Both counter names, so no test names one and forgets the other. */
const COUNTER_NAMES: readonly CounterName[] = ["history_seq", "member_position"]

/**
 * The connection string every driver error below quotes, the way a real one
 * does, and the fragments of it that may not reach a returned failure
 * (Requirement 1.6).
 */
const URI = "mongodb+srv://roster_writer:s3cr3t-pass@cluster0.7xk1p.mongodb.net"
const URI_FRAGMENTS = [
  URI,
  "roster_writer",
  "s3cr3t-pass",
  "cluster0.7xk1p.mongodb.net",
  "27017",
] as const

/** One `findOneAndUpdate` the fake collection received. */
interface UpdateCall {
  readonly filter: Filter<CounterDocument>
  readonly update: UpdateFilter<CounterDocument>
  readonly options: FindOneAndUpdateOptions
}

/** What the fake `findOneAndUpdate` does instead of updating. */
type UpdateBehaviour =
  /** Models `$inc` over {@link FakeCounters.values}. */
  | { readonly kind: "increment" }
  /** Rejects, the way the driver does when the deployment does not serve it. */
  | { readonly kind: "reject"; readonly error: unknown }
  /** Answers with a document the module cannot use. */
  | { readonly kind: "answer"; readonly document: CounterDocument | null }

interface FakeCountersOptions {
  /** The counter values the collection starts with. Absent means absent. */
  readonly initial?: ReadonlyMap<CounterName, number>
  readonly behaviour?: UpdateBehaviour
  /** When set, `collection()` answers with this failure and serves nothing. */
  readonly collectionFailure?: StoreFailure
}

/** The hand-built store, and everything `nextCounterValue` did through it. */
interface FakeCounters {
  readonly store: MongoStore
  /** The stored counter values, as the fake `$inc` left them. */
  readonly values: ReadonlyMap<CounterName, number>
  /** The collection names asked for, in order. */
  readonly requested: readonly CollectionName[]
  readonly calls: readonly UpdateCall[]
}

function fakeCounters(options: FakeCountersOptions = {}): FakeCounters {
  const behaviour: UpdateBehaviour = options.behaviour ?? { kind: "increment" }
  const values = new Map<CounterName, number>(options.initial ?? [])
  const requested: Array<CollectionName> = []
  const calls: Array<UpdateCall> = []

  const findOneAndUpdate = (
    filter: Filter<CounterDocument>,
    update: UpdateFilter<CounterDocument>,
    updateOptions?: FindOneAndUpdateOptions
  ): Promise<WithId<CounterDocument> | null> => {
    calls.push({ filter, update, options: updateOptions ?? {} })

    if (behaviour.kind === "reject") {
      return Promise.reject(behaviour.error)
    }
    if (behaviour.kind === "answer") {
      return Promise.resolve(behaviour.document)
    }

    /*
     * `$inc` semantics, as the server applies them: the field of a document that
     * does not exist counts as 0, so the first increment of an absent counter
     * yields 1. Without `upsert` there is no document to apply the update to and
     * the driver answers null, which is the branch `counters.server.ts` refuses
     * to return a value for.
     */
    const name = filter._id
    /* The filter is `{ _id: name }` and nothing else, so anything the fake
     * cannot resolve to one of the two counter names is a defect in the module
     * under test rather than a shape this fake has to serve. */
    if (name !== "history_seq" && name !== "member_position") {
      throw new Error(`the increment named no counter: ${String(name)}`)
    }
    const increment = (update as { $inc?: { value?: number } }).$inc?.value ?? 0
    const present = values.has(name)
    if (!present && updateOptions?.upsert !== true) {
      return Promise.resolve(null)
    }

    const before = values.get(name) ?? 0
    const after = before + increment
    values.set(name, after)

    const returned =
      updateOptions?.returnDocument === "after"
        ? after
        : /* `before` on a document that did not exist is no document at all. */
          present
          ? before
          : null

    return Promise.resolve(
      returned === null ? null : { _id: name, value: returned }
    )
  }

  const collection = { findOneAndUpdate }

  const store: MongoStore = {
    ready: () => Promise.resolve(),
    collection: <T extends Document>(
      name: CollectionName
    ): Promise<CollectionOrFailure<T>> => {
      requested.push(name)
      if (options.collectionFailure !== undefined) {
        return Promise.resolve({
          kind: "failure",
          failure: options.collectionFailure,
        })
      }
      return Promise.resolve({
        kind: "collection",
        collection: collection as unknown as Collection<T>,
      })
    },
    connected: () => options.collectionFailure === undefined,
    close: () => Promise.resolve(),
  }

  return { store, values, requested, calls }
}

/** The value, or a failed assertion naming the failure that arrived instead. */
function expectValue(result: number | StoreFailure, why: string): number {
  if (isCounterFailure(result)) {
    throw new Error(`${why}: the counter failed with "${result.message}"`)
  }
  return result
}

/** The failure, or a failed assertion naming the value that arrived instead. */
function expectFailure(
  result: number | StoreFailure,
  why: string
): StoreFailure {
  if (!isCounterFailure(result)) {
    throw new Error(`${why}: the counter yielded ${result}`)
  }
  return result
}

describe("the first use of a counter yields 1 (Requirement 3.2)", () => {
  it("yields 1 for a counter with no document yet", async () => {
    for (const name of COUNTER_NAMES) {
      const fake = fakeCounters()

      const first = await nextCounterValue(name, fake.store)

      expect(expectValue(first, name)).toBe(1)
      // And the upsert left the document behind, holding that same 1.
      expect(fake.values.get(name)).toBe(1)
    }
  })

  it("advances an existing counter from the value it holds", async () => {
    const fake = fakeCounters({ initial: new Map([["history_seq", 41]]) })

    const next = await nextCounterValue("history_seq", fake.store)

    expect(expectValue(next, "an existing counter")).toBe(42)
  })

  it("asks the counters collection for one upserting increment", async () => {
    const fake = fakeCounters()

    await nextCounterValue("member_position", fake.store)

    expect(fake.requested).toEqual(["counters"])
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]).toEqual({
      filter: { _id: "member_position" },
      update: { $inc: { value: 1 } },
      options: { upsert: true, returnDocument: "after" },
    })
  })
})

describe("successive uses are strictly increasing (Requirements 2.1, 3.2)", () => {
  it("hands out 1, 2, 3, … for one counter", async () => {
    for (const name of COUNTER_NAMES) {
      const fake = fakeCounters()
      const handed: Array<number> = []

      for (let call = 0; call < 6; call += 1) {
        handed.push(expectValue(await nextCounterValue(name, fake.store), name))
      }

      expect(handed).toEqual([1, 2, 3, 4, 5, 6])
      handed.reduce((previous, value) => {
        expect(value, name).toBeGreaterThan(previous)
        return value
      }, 0)
    }
  })

  it("advances the two counters independently", async () => {
    const fake = fakeCounters()

    // Interleaved, so neither counter can be reading the other's value.
    const seqOne = await nextCounterValue("history_seq", fake.store)
    const positionOne = await nextCounterValue("member_position", fake.store)
    const seqTwo = await nextCounterValue("history_seq", fake.store)
    const seqThree = await nextCounterValue("history_seq", fake.store)
    const positionTwo = await nextCounterValue("member_position", fake.store)

    expect(
      [seqOne, seqTwo, seqThree].map((value) => expectValue(value, "seq"))
    ).toEqual([1, 2, 3])
    expect(
      [positionOne, positionTwo].map((value) => expectValue(value, "position"))
    ).toEqual([1, 2])
    expect(fake.values.get("history_seq")).toBe(3)
    expect(fake.values.get("member_position")).toBe(2)
  })

  it("hands no value to two callers at once", async () => {
    /* Every caller reserves the value it was handed: the module holds no cached
     * value and does no read-then-write, so concurrent callers are serialized by
     * the update itself and none of them sees another's number. */
    const fake = fakeCounters()

    const handed = await Promise.all(
      Array.from({ length: 10 }, () =>
        nextCounterValue("history_seq", fake.store)
      )
    )

    const numbers = handed.map((value) => expectValue(value, "a racing caller"))
    expect(new Set(numbers).size).toBe(numbers.length)
    expect([...numbers].sort((left, right) => left - right)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ])
  })
})

describe("a failure carries the fixed unreachable sentence (Requirements 1.5, 1.6)", () => {
  /** Every driver rejection the increment can meet, with the reason it maps to. */
  const rejections: readonly (readonly [
    string,
    unknown,
    StoreFailure["reason"],
  ])[] = [
    [
      "an operation timeout",
      new MongoOperationTimeoutError(
        `Operation timed out after 5000 ms against ${URI}`
      ),
      "unreachable",
    ],
    [
      "a network error",
      new MongoNetworkError(
        `connection to cluster0.7xk1p.mongodb.net:27017 closed, ${URI}`
      ),
      "unreachable",
    ],
    [
      "a server error",
      new MongoServerError({
        message: `Document failed validation on ${URI}`,
        code: 121,
        codeName: "DocumentValidationFailure",
      }),
      "rejected",
    ],
    ["a plain error", new Error(`connect ECONNREFUSED for ${URI}`), "rejected"],
  ]

  it("returns a StoreFailure when the increment is rejected", async () => {
    for (const [why, error, reason] of rejections) {
      const fake = fakeCounters({ behaviour: { kind: "reject", error } })

      const result = await nextCounterValue("history_seq", fake.store)

      /* The sentence is fixed: a counter value is never rendered, so the failure
       * speaks about the database and the operation that asked for the value
       * supplies its own sentence to the Web_Client. */
      expect(expectFailure(result, why)).toEqual({
        reason,
        message: unreachableMessage(),
      })
    }
  })

  it("names no part of the driver error or the connection string", async () => {
    for (const [why, error] of rejections) {
      const fake = fakeCounters({ behaviour: { kind: "reject", error } })

      const failure = expectFailure(
        await nextCounterValue("member_position", fake.store),
        why
      )

      const driverMessage =
        error instanceof Error ? error.message : String(error)
      expect(failure.message, why).not.toContain(driverMessage)
      for (const fragment of URI_FRAGMENTS) {
        expect(failure.message, `${why} leaked ${fragment}`).not.toContain(
          fragment
        )
      }
      // Nothing of the error survives beyond the two fields of a StoreFailure.
      expect(Object.keys(failure).sort(), why).toEqual(["message", "reason"])
    }
  })

  it("returns the store's own failure when there is no collection", async () => {
    /* `collection()` performs no driver operation, so its failures are the two
     * the bootstrap already settled: no Mongo_Database configured (Requirements
     * 1.3, 1.10) and no connection yet (Requirement 1.11). Both are returned
     * unchanged — the counter has nothing to add to either. */
    const configured: StoreFailure = {
      reason: "not-configured",
      message: "No database is configured.",
    }
    const unreachable: StoreFailure = {
      reason: "unreachable",
      message: unreachableMessage(),
    }

    for (const failure of [configured, unreachable]) {
      const fake = fakeCounters({ collectionFailure: failure })

      const result = await nextCounterValue("history_seq", fake.store)

      expect(expectFailure(result, failure.reason)).toEqual(failure)
      // And no increment was attempted, so no counter was consumed.
      expect(fake.calls).toEqual([])
    }
  })

  it("refuses a value the ordering could not rest on", async () => {
    /* Neither answer is a path the driver takes with `upsert: true` and
     * `returnDocument: "after"`. The module refuses both anyway, because the
     * alternative is a `position` or a `seq` of null or NaN, which is exactly
     * the ordering Requirements 2.1 and 3.2 are about. */
    const answers: readonly (readonly [string, CounterDocument | null])[] = [
      ["no document at all", null],
      ["a NaN value", { _id: "history_seq", value: Number.NaN }],
      ["an infinite value", { _id: "history_seq", value: Infinity }],
    ]

    for (const [why, document] of answers) {
      const fake = fakeCounters({ behaviour: { kind: "answer", document } })

      const result = await nextCounterValue("history_seq", fake.store)

      expect(expectFailure(result, why)).toEqual({
        reason: "rejected",
        message: unreachableMessage(),
      })
    }
  })
})

describe("isCounterFailure discriminates the two cases", () => {
  it("is false for a value and true for a failure", async () => {
    const served = fakeCounters()
    const failing = fakeCounters({
      collectionFailure: {
        reason: "unreachable",
        message: unreachableMessage(),
      },
    })

    expect(
      isCounterFailure(await nextCounterValue("history_seq", served.store))
    ).toBe(false)
    expect(
      isCounterFailure(await nextCounterValue("history_seq", failing.store))
    ).toBe(true)
  })
})
