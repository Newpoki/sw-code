/**
 * Unit tests for a Redemption_History whose store fails under it
 * (Requirements 3.7, 3.10, 3.11).
 *
 * Three failing paths, and they are reported three different ways, which is the
 * whole point of the file:
 *
 *   1. **A failed append** is `failed`: nothing was written, not even
 *      partially, no retention delete runs, and the caller has exactly one
 *      warning to report (Requirement 3.7).
 *   2. **A failed read** is `failed`: zero records, no partially read record,
 *      the collection unchanged, and one fixed sentence (Requirement 3.10).
 *   3. **A failed retention trim** is *not reported to the Web_Client at all*
 *      (Requirement 3.11). The append it followed succeeded, so the result
 *      carries the record and no warning; one warning naming the collection
 *      goes to the log, the extra Store_Document stays, and the next append
 *      applies the retention rule again.
 *
 * ## Why these are unit tests
 *
 * A failure is a state, not an input. "The deployment did not answer this
 * `insertOne` inside its bound" cannot be arranged against a running MongoDB
 * without stopping one mid-operation, so the seam is taken one level lower: the
 * {@link MongoStore} handed to `createHistoryStore` is built by hand below, and
 * its `collection()` serves a fake `history` collection and a fake `counters`
 * collection whose `find`, `insertOne`, `countDocuments`, `deleteMany`, and
 * counter increment this file can make reject with a real driver error, one
 * method at a time. `collection()` itself can answer `{ kind: "failure" }`
 * instead, which is the other shape of failure the store can produce.
 *
 * The two `find` calls of the module are told apart by their options rather
 * than by their name: the retention read projects to `_id`, the Requirement 3.4
 * read does not. That is what lets a case say "the retention read failed" while
 * the ordinary read keeps working, and the reverse.
 *
 * The fake is a real little collection rather than a wall of rejections: it
 * matches a `couponCode` filter, sorts by the sort document it is handed,
 * applies a `limit` and a projection, inserts, counts, and deletes by `_id`.
 * The control block at the bottom drives append, `list`, and
 * `findLatestByCouponCode` through it successfully — including a trim that
 * lands — so a fake that had quietly stopped serving anything could not make
 * the failure assertions above pass vacuously.
 *
 * ## Which sentence a failure speaks with
 *
 * A failure the store settled **before** this module attempted anything — no
 * `MONGODB_URI` (Requirements 1.3, 1.10), no connection yet
 * (Requirement 1.11) — keeps its own sentence, and each of those requirements
 * asks for exactly that sentence. A driver rejection of an operation the module
 * **did** attempt speaks with the operation's own sentence:
 * {@link historyAppendFailedMessage} for an append,
 * {@link historyReadFailedMessage} for either read. A counter increment has no
 * sentence of its own — a `seq` is never rendered — so a counter failure met
 * during an append speaks with the append's sentence for every reason it can
 * carry, and the `reason` is what still says why.
 *
 * Every driver error below quotes a connection string, and every returned
 * message and logged warning is checked against its fragments: Requirement 1.6
 * holds on the failure path or it holds nowhere.
 */

import { describe, expect, it } from "vitest"

import {
  MongoNetworkError,
  MongoOperationTimeoutError,
  MongoServerError,
  ObjectId,
} from "mongodb"
import type {
  Collection,
  Document,
  Filter,
  UpdateFilter,
  WithId,
} from "mongodb"

import {
  historyAppendFailedMessage,
  historyReadFailedMessage,
  notConfiguredMessage,
  unreachableMessage,
} from "@/domain/storeMessages"
import type { RedemptionHistoryRecord, StoreFailure } from "@/domain/types"
import type {
  CounterDocument,
  HistoryDocumentInput,
} from "@/server/store/documents.server"
import { toHistoryDocument } from "@/server/store/documents.server"
import {
  HISTORY_RETENTION_FAILED_WARNING,
  HISTORY_RETENTION_LIMIT,
  createHistoryStore,
} from "@/server/store/history.server"
import type {
  AppendHistoryInput,
  AppendHistoryResult,
  FindHistoryResult,
  HistoryOutcomeRow,
  ListHistoryResult,
} from "@/server/store/history.server"
import type {
  CollectionName,
  CollectionOrFailure,
  MongoStore,
  StoreLogger,
} from "@/server/store/mongo.server"

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The connection string every driver error below quotes, the way a real one
 * does, and the fragments of it that may not reach a returned message or a
 * logged warning (Requirement 1.6).
 */
const URI =
  "mongodb+srv://history_writer:s3cr3t-pass@cluster0.7xk1p.mongodb.net"
const URI_FRAGMENTS = [
  URI,
  "history_writer",
  "s3cr3t-pass",
  "cluster0.7xk1p.mongodb.net",
  "27017",
] as const

/** The Coupon_Code two of the three seeded records share. */
const SHARED_COUPON = "SW2025NEWYEAR"

/** One denormalized outcome row. Every seeded record carries the same two. */
const OUTCOME_ROWS: readonly HistoryOutcomeRow[] = [
  {
    hiveId: "hive-ana",
    memberLabel: "Ana",
    outcome: "SUCCESS",
    responseCode: "(100)",
    responseMessage: "Coupon redeemed.",
  },
  {
    hiveId: "hive-bruno",
    memberLabel: "Bruno",
    outcome: "SKIPPED",
    responseCode: "",
    responseMessage: "",
  },
]

/** A Redemption_History record, as the seeds and the control block build them. */
function historyRecord(
  seq: number,
  couponCode: string,
  completedAt: string
): RedemptionHistoryRecord {
  return {
    runId: `run-${seq}`,
    seq,
    couponCode,
    completedAt,
    mock: false,
    stoppedEarly: false,
    outcomes: OUTCOME_ROWS,
  }
}

/**
 * The history every ordinary case starts from: three records, two sharing a
 * Coupon_Code so `findLatestByCouponCode` has an ordering to resolve, with
 * ascending `seq` and ascending completion timestamps.
 */
const SEEDED: readonly RedemptionHistoryRecord[] = [
  historyRecord(1, SHARED_COUPON, "2025-01-04T18:00:00.000Z"),
  historyRecord(2, "SW2025SPRING", "2025-01-04T19:00:00.000Z"),
  historyRecord(3, SHARED_COUPON, "2025-01-04T20:00:00.000Z"),
]

/** The append every failing case attempts. Valid, so nothing rejects it early. */
const APPEND_INPUT: AppendHistoryInput = {
  runId: "run-new",
  couponCode: "SW2025SUMMER",
  completedAt: "2025-01-04T21:00:00.000Z",
  mock: false,
  stoppedEarly: false,
  outcomes: OUTCOME_ROWS,
}

/** A full retention window: 200 records, `seq` 1..200, one second apart. */
const FULL_WINDOW: readonly RedemptionHistoryRecord[] = Array.from(
  { length: HISTORY_RETENTION_LIMIT },
  (_unused, index) =>
    historyRecord(
      index + 1,
      "SW2025BULK",
      new Date(
        Date.parse("2025-01-04T00:00:00.000Z") + index * 1_000
      ).toISOString()
    )
)

/**
 * Every driver rejection an operation can meet, with the {@link StoreFailure}
 * reason it classifies to. A timeout and a network error are the deployment
 * giving no answer; a failed document validation is the deployment answering
 * no; a plain error is the conservative residue.
 */
const REJECTIONS: readonly (readonly [
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
    "a refused write",
    new MongoServerError({
      message: `Document failed validation on ${URI}`,
      code: 121,
      codeName: "DocumentValidationFailure",
    }),
    "rejected",
  ],
  ["a plain error", new Error(`connect ECONNREFUSED for ${URI}`), "rejected"],
]

/**
 * The two failures `collection()` itself can answer with. Both are settled by
 * the bootstrap before any operation is attempted, and each keeps its own
 * sentence.
 */
const COLLECTION_FAILURES: readonly (readonly [string, StoreFailure])[] = [
  [
    "no database configured",
    { reason: "not-configured", message: notConfiguredMessage() },
  ],
  [
    "no connection yet",
    { reason: "unreachable", message: unreachableMessage() },
  ],
]

/* -------------------------------------------------------------------------- */
/* The hand-built store                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A method of the fake `history` collection that a case can make reject.
 *
 * `find` and `retentionFind` are the same driver method, told apart by the
 * projection the retention read carries: that is what lets one of the two fail
 * while the other keeps serving.
 */
type HistoryMethod =
  "find" | "retentionFind" | "insertOne" | "countDocuments" | "deleteMany"

interface FakeHistoryOptions {
  /** The records the collection starts with. Defaults to {@link SEEDED}. */
  readonly seeded?: readonly RedemptionHistoryRecord[]
  /** Methods that reject instead of serving, and what they reject with. */
  readonly reject?: Partial<Record<HistoryMethod, unknown>>
  /** When set, `collection("history")` answers this failure and serves nothing. */
  readonly historyFailure?: StoreFailure
  /** When set, `collection("counters")` answers this failure. */
  readonly countersFailure?: StoreFailure
  /** When set, the counter increment rejects with this error. */
  readonly rejectCounter?: unknown
}

/** A cursor option document, as the module hands one to `find`. */
interface FindOptions {
  readonly sort?: Record<string, number>
  readonly limit?: number
  readonly projection?: Record<string, number>
}

interface FakeHistory {
  readonly store: MongoStore
  /** The logger the Redemption_History is built with. */
  readonly logger: StoreLogger
  /** Everything that logger was handed, in call order. */
  readonly warnings: readonly string[]
  /** The stored Store_Documents, `_id` dropped, in insertion order. */
  readonly documents: () => readonly HistoryDocumentInput[]
  /** The `seq` values the collection now holds, in insertion order. */
  readonly seqs: () => readonly number[]
  /** The `history` methods called, in call order. */
  readonly calls: readonly HistoryMethod[]
  /** How many times the counter increment was attempted. */
  readonly counterCalls: () => number
  /** Injects, or clears, the rejection of one method between two calls. */
  readonly setRejection: (method: HistoryMethod, error: unknown) => void
  readonly clearRejection: (method: HistoryMethod) => void
}

/** Whether every field of `filter` is held, by exact value, by `document`. */
function matches(
  document: WithId<HistoryDocumentInput>,
  filter: Filter<HistoryDocumentInput>
): boolean {
  const held = document as unknown as Record<string, unknown>
  return Object.entries(filter as Record<string, unknown>).every(
    ([field, value]) => held[field] === value
  )
}

/** The sort document applied, field by field, in the order it declares them. */
function compareBySort(
  sort: Record<string, number>,
  left: WithId<HistoryDocumentInput>,
  right: WithId<HistoryDocumentInput>
): number {
  const held = (document: WithId<HistoryDocumentInput>, field: string) =>
    (document as unknown as Record<string, unknown>)[field]
  for (const [field, direction] of Object.entries(sort)) {
    const leftValue = held(left, field)
    const rightValue = held(right, field)
    if (leftValue === rightValue) {
      continue
    }
    return ((leftValue as number) < (rightValue as number) ? -1 : 1) * direction
  }
  return 0
}

/** The Store_Document without the `_id` the fake assigned it. */
function withoutId(
  document: WithId<HistoryDocumentInput>
): HistoryDocumentInput {
  const { _id: _ignored, ...fields } = document
  return fields
}

/**
 * A {@link MongoStore} serving a fake `history` collection and a fake
 * `counters` collection, either of which can be made to fail.
 *
 * The `history` collection is small but real: it matches a `couponCode` filter
 * by exact value, sorts by the sort document it is handed, applies the `limit`,
 * projects to `_id` when asked to, inserts, counts, and deletes the `_id`
 * values a `$in` names. Every method consults the injected rejections first, so
 * exactly one operation of one path can be made to fail while the rest of the
 * path keeps working — which is what lets a case say "the insert failed" rather
 * than "the whole collection failed".
 */
function fakeHistory(options: FakeHistoryOptions = {}): FakeHistory {
  const seeded = options.seeded ?? SEEDED
  const documents: WithId<HistoryDocumentInput>[] = seeded.map((record) => ({
    _id: new ObjectId(),
    ...toHistoryDocument(record),
  }))

  const calls: HistoryMethod[] = []
  const warnings: string[] = []
  const rejections = new Map<HistoryMethod, unknown>(
    Object.entries(options.reject ?? {}) as (readonly [
      HistoryMethod,
      unknown,
    ])[]
  )
  /* The counter starts at the highest seeded `seq`, the way the real
   * `history_seq` counter does, so the next value it hands out is above every
   * `seq` the collection already holds. */
  const counters = new Map<string, number>([
    [
      "history_seq",
      seeded.reduce((high, record) => Math.max(high, record.seq), 0),
    ],
  ])
  let counterCalls = 0

  /** Records the call, and answers with its injected rejection, if any. */
  const rejectionFor = (method: HistoryMethod): unknown => {
    calls.push(method)
    return rejections.has(method) ? rejections.get(method) : null
  }

  const history = {
    find: (filter: Filter<HistoryDocumentInput>, findOptions?: FindOptions) => {
      /* The retention read is the one that projects to `_id`; the Requirement
       * 3.4 read asks for whole Store_Documents. */
      const projecting = findOptions?.projection !== undefined
      const rejection = rejectionFor(projecting ? "retentionFind" : "find")
      return {
        toArray: (): Promise<WithId<HistoryDocumentInput>[]> => {
          /* The driver's `find` builds a cursor without touching the
           * deployment; the round trip — and therefore the rejection — belongs
           * to `toArray`. */
          if (rejection !== null) {
            return Promise.reject(rejection)
          }
          const selected = documents.filter((document) =>
            matches(document, filter)
          )
          if (findOptions?.sort !== undefined) {
            const sort = findOptions.sort
            selected.sort((left, right) => compareBySort(sort, left, right))
          }
          const limited =
            findOptions?.limit === undefined
              ? selected
              : selected.slice(0, findOptions.limit)
          return Promise.resolve(
            limited.map((document) =>
              projecting
                ? ({ _id: document._id } as WithId<HistoryDocumentInput>)
                : { ...document }
            )
          )
        },
      }
    },

    countDocuments: (): Promise<number> => {
      const rejection = rejectionFor("countDocuments")
      return rejection !== null
        ? Promise.reject(rejection)
        : Promise.resolve(documents.length)
    },

    insertOne: (
      document: HistoryDocumentInput
    ): Promise<{ acknowledged: boolean; insertedId: ObjectId }> => {
      const rejection = rejectionFor("insertOne")
      if (rejection !== null) {
        return Promise.reject(rejection)
      }
      const _id = new ObjectId()
      documents.push({ _id, ...document })
      return Promise.resolve({ acknowledged: true, insertedId: _id })
    },

    deleteMany: (
      filter: Filter<HistoryDocumentInput>
    ): Promise<{ acknowledged: boolean; deletedCount: number }> => {
      const rejection = rejectionFor("deleteMany")
      if (rejection !== null) {
        return Promise.reject(rejection)
      }
      const doomed =
        (filter as { _id?: { $in?: readonly ObjectId[] } })._id?.$in ?? []
      let deletedCount = 0
      for (const id of doomed) {
        const index = documents.findIndex((document) => document._id.equals(id))
        if (index !== -1) {
          documents.splice(index, 1)
          deletedCount += 1
        }
      }
      return Promise.resolve({ acknowledged: true, deletedCount })
    },
  }

  /** `$inc` with `upsert: true` and `returnDocument: "after"`, as the server applies it. */
  const countersCollection = {
    findOneAndUpdate: (
      filter: Filter<CounterDocument>,
      update: UpdateFilter<CounterDocument>
    ): Promise<CounterDocument | null> => {
      counterCalls += 1
      if (options.rejectCounter !== undefined) {
        return Promise.reject(options.rejectCounter)
      }
      const name = String(filter._id)
      const increment =
        (update as { $inc?: { value?: number } }).$inc?.value ?? 0
      const value = (counters.get(name) ?? 0) + increment
      counters.set(name, value)
      return Promise.resolve({ _id: name as CounterDocument["_id"], value })
    },
  }

  const store: MongoStore = {
    ready: () => Promise.resolve(),
    collection: <T extends Document>(
      name: CollectionName
    ): Promise<CollectionOrFailure<T>> => {
      if (name === "history") {
        if (options.historyFailure !== undefined) {
          return Promise.resolve({
            kind: "failure",
            failure: options.historyFailure,
          })
        }
        return Promise.resolve({
          kind: "collection",
          collection: history as unknown as Collection<T>,
        })
      }
      if (name === "counters") {
        if (options.countersFailure !== undefined) {
          return Promise.resolve({
            kind: "failure",
            failure: options.countersFailure,
          })
        }
        return Promise.resolve({
          kind: "collection",
          collection: countersCollection as unknown as Collection<T>,
        })
      }
      throw new Error(`the history asked for the ${name} collection`)
    },
    connected: () => options.historyFailure === undefined,
    close: () => Promise.resolve(),
  }

  return {
    store,
    logger: {
      warn: (message) => {
        warnings.push(message)
      },
    },
    warnings,
    documents: () => documents.map(withoutId),
    seqs: () => documents.map((document) => document.seq),
    calls,
    counterCalls: () => counterCalls,
    setRejection: (method, error) => {
      rejections.set(method, error)
    },
    clearRejection: (method) => {
      rejections.delete(method)
    },
  }
}

/** A Redemption_History over `fake`, with the capturing logger installed. */
function historyOver(fake: FakeHistory) {
  return createHistoryStore(fake.store, { logger: fake.logger })
}

/* -------------------------------------------------------------------------- */
/* Assertion helpers                                                          */
/* -------------------------------------------------------------------------- */

/** The seeded collection, as every unchanged-collection assertion expects it. */
const SEEDED_DOCUMENTS: readonly HistoryDocumentInput[] =
  SEEDED.map(toHistoryDocument)

/** The failure of a result that must be `failed`, with why in the message. */
function expectFailed(
  result: AppendHistoryResult | ListHistoryResult | FindHistoryResult,
  why: string
): StoreFailure {
  if (result.kind !== "failed") {
    throw new Error(`${why}: the operation reported "${result.kind}"`)
  }
  return result.failure
}

/** No fragment of the driver error or the connection string survives. */
function expectNoDriverText(
  message: string,
  error: unknown,
  why: string
): void {
  const driverMessage = error instanceof Error ? error.message : String(error)
  expect(message, why).not.toContain(driverMessage)
  for (const fragment of URI_FRAGMENTS) {
    expect(message, `${why} leaked ${fragment}`).not.toContain(fragment)
  }
}

/** Requirement 3.7: the append's own sentence, and nothing of the driver. */
function expectNamesTheAppend(
  failure: StoreFailure,
  error: unknown,
  why: string
): void {
  expect(failure.message, why).toBe(historyAppendFailedMessage())
  expect(failure.message, why).toContain(
    "The Redemption_History record was not saved"
  )
  expectNoDriverText(failure.message, error, why)
  expect(Object.keys(failure).sort(), why).toEqual(["message", "reason"])
}

/** Requirement 3.10: the read's own sentence, and nothing of the driver. */
function expectNamesTheRead(
  failure: StoreFailure,
  error: unknown,
  why: string
): void {
  expect(failure.message, why).toBe(historyReadFailedMessage())
  expect(failure.message, why).toContain(
    "The Redemption_History could not be read"
  )
  expectNoDriverText(failure.message, error, why)
  expect(Object.keys(failure).sort(), why).toEqual(["message", "reason"])
}

/** The record an `appended` result must carry, or a thrown explanation. */
function expectAppended(
  result: AppendHistoryResult,
  why: string
): RedemptionHistoryRecord {
  if (result.kind !== "appended") {
    throw new Error(
      `${why}: the append reported "${result.kind}" rather than appended`
    )
  }
  /* Requirement 3.11: the result carries the record and nothing else. A
   * `warning` or `warnings` field would be the trim reaching the Web_Client. */
  expect(Object.keys(result).sort(), why).toEqual(["kind", "record"])
  return result.record
}

/* -------------------------------------------------------------------------- */
/* Requirement 3.7 — the append path                                          */
/* -------------------------------------------------------------------------- */

describe("a failed append writes nothing, deletes nothing, and carries one warning (Requirement 3.7)", () => {
  it("reports failed when the insert is rejected, and runs no retention delete", async () => {
    for (const [why, error, reason] of REJECTIONS) {
      const fake = fakeHistory({ reject: { insertOne: error } })

      const result = await historyOver(fake).append(APPEND_INPUT)

      const failure = expectFailed(result, why)
      expect(failure.reason, why).toBe(reason)
      /* Exactly one warning for the caller to report: the failure carries one
       * sentence, and the result carries no second channel for a second one. */
      expectNamesTheAppend(failure, error, why)
      expect(Object.keys(result).sort(), why).toEqual(["failure", "kind"])

      /* Nothing reached the collection: the same three Store_Documents, field
       * for field, so a partial document would be caught rather than glossed
       * over by a length check. */
      expect(fake.documents(), why).toEqual(SEEDED_DOCUMENTS)

      /* No retention delete: the trim is not reached at all, so no retained
       * record is counted, selected, or deleted. */
      expect(fake.calls, why).toEqual(["insertOne"])
      expect(fake.calls, why).not.toContain("countDocuments")
      expect(fake.calls, why).not.toContain("retentionFind")
      expect(fake.calls, why).not.toContain("deleteMany")

      // The `seq` was consumed and then never used, which Requirement 3.2 allows.
      expect(fake.counterCalls(), why).toBe(1)
      expect(fake.warnings, why).toEqual([])
    }
  })

  it("speaks with the append's sentence when the counter cannot be advanced", async () => {
    /* `src/server/store/counters.server.ts` is the other module an append
     * depends on, and a `seq` is never rendered, so it has no client-visible
     * sentence of its own: the operation that asked for the value supplies one,
     * for every reason the counter failure can carry. The `reason` is what still
     * tells a refused increment from an unanswered one. */
    for (const [why, error, reason] of REJECTIONS) {
      const fake = fakeHistory({ rejectCounter: error })

      const failure = expectFailed(
        await historyOver(fake).append(APPEND_INPUT),
        why
      )

      expect(failure.reason, why).toBe(reason)
      expectNamesTheAppend(failure, error, why)
      // The increment was attempted once, and the insert never was.
      expect(fake.counterCalls(), why).toBe(1)
      expect(fake.calls, why).toEqual([])
      expect(fake.documents(), why).toEqual(SEEDED_DOCUMENTS)
      expect(fake.warnings, why).toEqual([])
    }
  })

  it("keeps the store's own sentence when there is no collection", async () => {
    /* Both failures were settled by the bootstrap before this append attempted
     * anything — no `MONGODB_URI` (Requirements 1.3, 1.10), no connection yet
     * (Requirement 1.11) — and each requirement asks for exactly the sentence it
     * already carries, so neither is re-spoken as an append. */
    for (const [why, storeFailure] of COLLECTION_FAILURES) {
      const fake = fakeHistory({ historyFailure: storeFailure })

      const failure = expectFailed(
        await historyOver(fake).append(APPEND_INPUT),
        why
      )

      expect(failure, why).toEqual(storeFailure)
      for (const fragment of URI_FRAGMENTS) {
        expect(failure.message, `${why} leaked ${fragment}`).not.toContain(
          fragment
        )
      }
      // No counter value consumed, nothing inserted, nothing trimmed.
      expect(fake.counterCalls(), why).toBe(0)
      expect(fake.calls, why).toEqual([])
      expect(fake.documents(), why).toEqual(SEEDED_DOCUMENTS)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Requirement 3.10 — the read path                                           */
/* -------------------------------------------------------------------------- */

describe("a failed read returns zero records and says the history could not be read (Requirement 3.10)", () => {
  it("reports failed from list when the read is rejected", async () => {
    for (const [why, error, reason] of REJECTIONS) {
      const fake = fakeHistory({ reject: { find: error } })

      const result = await historyOver(fake).list()

      const failure = expectFailed(result, why)
      expect(failure.reason, why).toBe(reason)
      expectNamesTheRead(failure, error, why)
      /* Zero records: the failed result carries no `records` field at all, so
       * there is nothing partially read for a caller to render. */
      expect("records" in result, why).toBe(false)
      expect(fake.documents(), why).toEqual(SEEDED_DOCUMENTS)
    }
  })

  it("reports failed from findLatestByCouponCode when the read is rejected", async () => {
    for (const [why, error, reason] of REJECTIONS) {
      const fake = fakeHistory({ reject: { find: error } })

      const result =
        await historyOver(fake).findLatestByCouponCode(SHARED_COUPON)

      const failure = expectFailed(result, why)
      expect(failure.reason, why).toBe(reason)
      expectNamesTheRead(failure, error, why)
      /* Not `not-found` — which would be a claim about the Coupon_Code — and no
       * `record` field either. */
      expect("record" in result, why).toBe(false)
      expect(fake.documents(), why).toEqual(SEEDED_DOCUMENTS)
    }
  })

  it("keeps the store's own sentence when there is no collection", async () => {
    for (const [why, storeFailure] of COLLECTION_FAILURES) {
      const fake = fakeHistory({ historyFailure: storeFailure })
      const history = historyOver(fake)

      const listed = await history.list()
      const found = await history.findLatestByCouponCode(SHARED_COUPON)

      expect(expectFailed(listed, why), why).toEqual(storeFailure)
      expect(expectFailed(found, why), why).toEqual(storeFailure)
      expect("records" in listed, why).toBe(false)
      expect("record" in found, why).toBe(false)
      expect(fake.calls, why).toEqual([])
      expect(fake.documents(), why).toEqual(SEEDED_DOCUMENTS)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Requirement 3.11 — the retention trim                                      */
/* -------------------------------------------------------------------------- */

describe("a failed retention trim keeps the appended record, warns only the log, and retries next append (Requirement 3.11)", () => {
  /**
   * The three operations the trim is made of. Each is failed in turn, because
   * "the trim did not complete" has three shapes and Requirement 3.11 asks for
   * the same behaviour from all of them.
   */
  const trimSteps: readonly (readonly [string, HistoryMethod])[] = [
    ["the count", "countDocuments"],
    ["the selection of the oldest records", "retentionFind"],
    ["the delete", "deleteMany"],
  ]

  for (const [label, method] of trimSteps) {
    it(`appends, retains, and logs one warning when ${label} is rejected`, async () => {
      for (const [reason, error] of REJECTIONS) {
        const why = `${label} on ${reason}`
        const fake = fakeHistory({
          seeded: FULL_WINDOW,
          reject: { [method]: error },
        })
        const history = historyOver(fake)

        // A full window, and a 201st append over it.
        expect(fake.seqs(), why).toHaveLength(HISTORY_RETENTION_LIMIT)
        const record = expectAppended(await history.append(APPEND_INPUT), why)

        // The append succeeded: the record is the one that was stored.
        expect(record.seq, why).toBe(HISTORY_RETENTION_LIMIT + 1)
        expect(record.runId, why).toBe(APPEND_INPUT.runId)
        expect(record.couponCode, why).toBe(APPEND_INPUT.couponCode)
        expect(record.completedAt, why).toBe(APPEND_INPUT.completedAt)

        /* The appended Store_Document is retained, and so is every one the trim
         * would have deleted: the collection is briefly one over the window. */
        expect(fake.documents(), why).toHaveLength(HISTORY_RETENTION_LIMIT + 1)
        expect(fake.documents().at(-1), why).toEqual(
          toHistoryDocument({
            ...APPEND_INPUT,
            seq: HISTORY_RETENTION_LIMIT + 1,
          })
        )
        expect(fake.seqs()[0], why).toBe(1)

        /* Exactly one warning, and it went to the log rather than to the
         * Web_Client: `expectAppended` already pinned that the result carries no
         * warning field of any kind. */
        expect(fake.warnings, why).toEqual([HISTORY_RETENTION_FAILED_WARNING])
        expect(fake.warnings[0], why).toContain("the history collection")
        expectNoDriverText(fake.warnings[0], error, why)

        /* The retry clause: the next append applies the retention rule again,
         * and with the step working it trims the collection back to the window
         * — deleting the two lowest `seq` values, since two appends have since
         * landed over a full window. */
        fake.clearRejection(method)
        const second = expectAppended(await history.append(APPEND_INPUT), why)

        expect(second.seq, why).toBe(HISTORY_RETENTION_LIMIT + 2)
        expect(fake.documents(), why).toHaveLength(HISTORY_RETENTION_LIMIT)
        expect(fake.seqs()[0], why).toBe(3)
        expect(fake.seqs().at(-1), why).toBe(HISTORY_RETENTION_LIMIT + 2)
        // Still one warning: the second trim did not fail.
        expect(fake.warnings, why).toHaveLength(1)
      }
    })
  }
})

/* -------------------------------------------------------------------------- */
/* The control                                                                */
/* -------------------------------------------------------------------------- */

describe("the fake collection serves append, both reads, and a landing trim when nothing is injected", () => {
  /* Without this, every assertion above could be passing against a harness that
   * had quietly stopped working: an `insertOne` that always rejected, a store
   * whose `collection()` never served anything, a history that reported `failed`
   * for reasons of its own. Each path below succeeds through the same fake. */

  it("appends the record and leaves a short collection untrimmed", async () => {
    const fake = fakeHistory()

    const record = expectAppended(
      await historyOver(fake).append(APPEND_INPUT),
      "the control append"
    )

    expect(record).toEqual({ ...APPEND_INPUT, seq: SEEDED.length + 1 })
    expect(fake.documents()).toHaveLength(SEEDED.length + 1)
    expect(fake.documents().at(-1)).toEqual(
      toHistoryDocument({ ...APPEND_INPUT, seq: SEEDED.length + 1 })
    )
    /* The retention rule ran and had nothing to do: counted, and no selection
     * and no delete below the window. */
    expect(fake.calls).toEqual(["insertOne", "countDocuments"])
    expect(fake.warnings).toEqual([])
  })

  it("reads the records newest completion first, and caps them at the limit", async () => {
    const fake = fakeHistory()
    const history = historyOver(fake)

    const all = await history.list()
    const capped = await history.list(2)

    if (all.kind !== "records" || capped.kind !== "records") {
      throw new Error("the control read failed")
    }
    expect(all.records.map((record) => record.runId)).toEqual([
      "run-3",
      "run-2",
      "run-1",
    ])
    expect(capped.records.map((record) => record.runId)).toEqual([
      "run-3",
      "run-2",
    ])
  })

  it("finds the newest record of a Coupon_Code, and reports not-found otherwise", async () => {
    const fake = fakeHistory()
    const history = historyOver(fake)

    const found = await history.findLatestByCouponCode(SHARED_COUPON)
    const absent = await history.findLatestByCouponCode("SW2025NEVER")

    if (found.kind !== "record") {
      throw new Error("the control find failed")
    }
    // The newer of the two records sharing the Coupon_Code.
    expect(found.record.runId).toBe("run-3")
    expect(absent.kind).toBe("not-found")
    expect(fake.documents()).toEqual(SEEDED_DOCUMENTS)
  })

  it("trims a full window back to the limit when the delete lands", async () => {
    const fake = fakeHistory({ seeded: FULL_WINDOW })

    expectAppended(
      await historyOver(fake).append(APPEND_INPUT),
      "the control trim"
    )

    // 201 became 200 again, by deleting the lowest `seq`.
    expect(fake.documents()).toHaveLength(HISTORY_RETENTION_LIMIT)
    expect(fake.seqs()[0]).toBe(2)
    expect(fake.seqs().at(-1)).toBe(HISTORY_RETENTION_LIMIT + 1)
    expect(fake.calls).toEqual([
      "insertOne",
      "countDocuments",
      "retentionFind",
      "deleteMany",
    ])
    // A trim that lands logs nothing at all.
    expect(fake.warnings).toEqual([])
  })
})
