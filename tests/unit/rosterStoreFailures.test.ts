/**
 * Unit tests for a Member_Registry whose store fails under it
 * (Requirements 2.8, 2.14).
 *
 * Four failing paths, one per method of the seam: the three write paths — `add`,
 * `setEnabled`, `remove` — and the read path shared by `list` and `listEnabled`.
 * Every case asserts the same two things, because Requirements 2.8 and 2.14 each
 * ask for both:
 *
 *   1. **The collection is unchanged.** Not "no error was thrown" — the stored
 *      Store_Documents are compared field by field against the snapshot taken
 *      before the call, so an `add` that inserted before failing, a `setEnabled`
 *      that flipped `enabled` before failing, or a `remove` that deleted before
 *      failing would all be caught.
 *   2. **The message names its subject.** For a write, the attempted change:
 *      the operation and the Member_Label, through
 *      {@link rosterWriteFailedMessage}. For a read,
 *      {@link rosterReadFailedMessage} — "the roster could not be read".
 *
 * ## Why these are unit tests
 *
 * A failure is a state, not an input. "The deployment did not answer this
 * `insertOne` inside its bound" cannot be arranged against a running MongoDB
 * without stopping one mid-operation, so the seam is taken one level lower: the
 * {@link MongoStore} handed to `createMemberRegistryStore` is built by hand
 * below, and its `collection()` serves a fake `members` collection whose
 * `find`, `findOne`, `countDocuments`, `insertOne`, `findOneAndUpdate`, and
 * `deleteOne` this file can make reject with a real driver error, one method at
 * a time. `collection()` itself can answer `{ kind: "failure" }` instead, which
 * is the other shape of failure the store can produce.
 *
 * The fake is a real little collection rather than a wall of rejections: it
 * matches filters, sorts by `position`, applies `$set`, inserts, and deletes.
 * The control test at the bottom drives all four methods through it
 * successfully, so a fake that had quietly stopped serving anything could not
 * make the failure assertions above pass vacuously.
 *
 * ## Two sentences, chosen by where the failure came from
 *
 * A failure the store settled **before** this module attempted anything — no
 * `MONGODB_URI` (Requirements 1.3, 1.10), no connection yet (Requirement 1.11) —
 * keeps its own sentence, and each of those requirements asks for exactly that
 * sentence. A failure of an operation the module **did** attempt speaks with the
 * operation's own sentence, for every reason and not only for a refusal: a
 * counter increment that went unanswered is still an add that was not saved, and
 * Requirement 2.8's first clause asks that one to name the attempted change too.
 * Both are pinned here, per path.
 *
 * `setEnabled` and `remove` read the Store_Document before they write it, for
 * the Member_Label their failure sentence names. When that read is itself what
 * failed there is no label, and the sentence falls back to
 * {@link UNKNOWN_MEMBER_LABEL} — which is asserted rather than glossed over,
 * because "the change was not saved: remove" with nothing after it would be a
 * message naming no subject at all.
 *
 * Every driver error below quotes a connection string, and every returned
 * message is checked against its fragments: Requirement 1.6 holds on the failure
 * path or it holds nowhere.
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
  FindOneAndUpdateOptions,
  UpdateFilter,
  WithId,
} from "mongodb"

import {
  rosterReadFailedMessage,
  rosterWriteFailedMessage,
  unreachableMessage,
} from "@/domain/storeMessages"
import type { RosterWriteOperation } from "@/domain/storeMessages"
import type { StoreFailure } from "@/domain/types"
import type {
  CounterDocument,
  MemberDocumentInput,
} from "@/server/store/documents.server"
import {
  UNKNOWN_MEMBER_LABEL,
  createMemberRegistryStore,
} from "@/server/store/memberRegistry.server"
import type {
  AddMemberResult,
  ListMembersResult,
  RemoveMemberResult,
  SetEnabledResult,
} from "@/server/store/memberRegistry.server"
import type {
  CollectionName,
  CollectionOrFailure,
  MongoStore,
} from "@/server/store/mongo.server"

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The connection string every driver error below quotes, the way a real one
 * does, and the fragments of it that may not reach a returned message
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

/** Fixed clock, so `createdAt` is deterministic. */
const SEED_TIME = new Date("2025-01-04T18:00:00.000Z")
const ADD_TIME = new Date("2025-01-04T18:24:55.900Z")

/** The `entryId` the injected generator hands the one `add` below. */
const NEW_ENTRY_ID = "m-new"

/** The submission every failing `add` makes. Valid, so nothing rejects it early. */
const SUBMISSION = { memberLabel: "Dara", hiveId: "hive-dara" } as const

/** One seeded Store_Document, before the fake gives it an `_id`. */
interface SeedFields {
  readonly entryId: string
  readonly memberLabel: string
  readonly hiveId: string
  readonly enabled: boolean
  readonly position: number
}

/**
 * The roster every case starts from: three entries, one of them disabled, so
 * `listEnabled` has something to filter and `setEnabled` has both an enabled
 * entry to disable and a disabled entry to enable.
 */
const SEEDED: readonly SeedFields[] = [
  {
    entryId: "m-1",
    memberLabel: "Ana",
    hiveId: "hive-ana",
    enabled: true,
    position: 1,
  },
  {
    entryId: "m-2",
    memberLabel: "Bruno",
    hiveId: "hive-bruno",
    enabled: false,
    position: 2,
  },
  {
    entryId: "m-3",
    memberLabel: "Chidi",
    hiveId: "hive-chidi",
    enabled: true,
    position: 3,
  },
]

/**
 * Every driver rejection an operation can meet, with the {@link StoreFailure}
 * reason it classifies to. A timeout and a network error are the deployment
 * giving no answer; a failed document validation is the deployment answering no;
 * a plain error is the conservative residue.
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
    {
      reason: "not-configured",
      message:
        "No database is configured. Set the MONGODB_URI environment variable and restart the server.",
    },
  ],
  [
    "no connection yet",
    { reason: "unreachable", message: unreachableMessage() },
  ],
]

/* -------------------------------------------------------------------------- */
/* The hand-built store                                                       */
/* -------------------------------------------------------------------------- */

/** A method of the fake `members` collection that a case can make reject. */
type MembersMethod =
  | "find"
  | "findOne"
  | "countDocuments"
  | "insertOne"
  | "findOneAndUpdate"
  | "deleteOne"

interface FakeRosterOptions {
  /** The Store_Documents the collection starts with. Defaults to {@link SEEDED}. */
  readonly seeded?: readonly SeedFields[]
  /** Methods that reject instead of serving, and what they reject with. */
  readonly reject?: Partial<Record<MembersMethod, unknown>>
  /** When set, `collection("members")` answers this failure and serves nothing. */
  readonly membersFailure?: StoreFailure
  /** When set, `collection("counters")` answers this failure. */
  readonly countersFailure?: StoreFailure
  /** When set, the counter increment rejects with this error. */
  readonly rejectCounter?: unknown
}

/** A stored Store_Document in a form two snapshots can be compared by. */
interface DocumentSummary {
  readonly entryId: string
  readonly memberLabel: string
  readonly hiveId: string
  readonly enabled: boolean
  readonly position: number
  readonly createdAt: string
}

interface FakeRoster {
  readonly store: MongoStore
  /** The stored Store_Documents, as the fake collection now holds them. */
  readonly summaries: () => readonly DocumentSummary[]
  /** The `members` methods called, in call order. */
  readonly calls: readonly MembersMethod[]
  /** How many times the counter increment was attempted. */
  readonly counterCalls: () => number
}

/** Whether every field of `filter` is held, by exact value, by `document`. */
function matches(
  document: WithId<MemberDocumentInput>,
  filter: Filter<MemberDocumentInput>
): boolean {
  const held = document as unknown as Record<string, unknown>
  return Object.entries(filter as Record<string, unknown>).every(
    ([field, value]) => held[field] === value
  )
}

function summarize(document: WithId<MemberDocumentInput>): DocumentSummary {
  return {
    entryId: document.entryId,
    memberLabel: document.memberLabel,
    hiveId: document.hiveId,
    enabled: document.enabled,
    position: document.position,
    createdAt: document.createdAt.toISOString(),
  }
}

/**
 * A {@link MongoStore} serving a fake `members` collection and a fake
 * `counters` collection, either of which can be made to fail.
 *
 * The `members` collection is small but real: it matches filters by exact field
 * value, sorts by `position` when asked to, applies a `$set`, inserts, and
 * deletes. Every method consults `options.reject` first, so exactly one
 * operation of one path can be made to fail while the rest of the path keeps
 * working — which is what lets a case say "the insert failed" rather than "the
 * whole collection failed".
 */
function fakeRoster(options: FakeRosterOptions = {}): FakeRoster {
  const documents: WithId<MemberDocumentInput>[] = (
    options.seeded ?? SEEDED
  ).map((fields) => ({
    _id: new ObjectId(),
    entryId: fields.entryId,
    memberLabel: fields.memberLabel,
    hiveId: fields.hiveId,
    enabled: fields.enabled,
    createdAt: SEED_TIME,
    position: fields.position,
  }))

  const calls: MembersMethod[] = []
  /* Seeded positions are 1..n, so the next value the counter hands out is above
   * every one of them, the way the real `member_position` counter is. */
  const counters = new Map<string, number>([
    ["member_position", documents.length],
  ])
  let counterCalls = 0

  /** The injected rejection for `method`, or null when it should serve. */
  const rejectionFor = (method: MembersMethod): unknown => {
    calls.push(method)
    const rejections = options.reject ?? {}
    return method in rejections ? rejections[method] : null
  }

  const members = {
    find: (
      filter: Filter<MemberDocumentInput>,
      findOptions?: { sort?: Record<string, number> }
    ) => {
      const rejection = rejectionFor("find")
      return {
        toArray: (): Promise<WithId<MemberDocumentInput>[]> => {
          /* The driver's `find` builds a cursor without touching the
           * deployment; the round trip — and therefore the rejection — belongs
           * to `toArray`. */
          if (rejection !== null) {
            return Promise.reject(rejection)
          }
          const selected = documents.filter((document) =>
            matches(document, filter)
          )
          const direction = findOptions?.sort?.position ?? 0
          if (direction !== 0) {
            selected.sort(
              (left, right) => (left.position - right.position) * direction
            )
          }
          return Promise.resolve(selected.map((document) => ({ ...document })))
        },
      }
    },

    findOne: (
      filter: Filter<MemberDocumentInput>
    ): Promise<WithId<MemberDocumentInput> | null> => {
      const rejection = rejectionFor("findOne")
      if (rejection !== null) {
        return Promise.reject(rejection)
      }
      const found = documents.find((document) => matches(document, filter))
      return Promise.resolve(found === undefined ? null : { ...found })
    },

    countDocuments: (): Promise<number> => {
      const rejection = rejectionFor("countDocuments")
      return rejection !== null
        ? Promise.reject(rejection)
        : Promise.resolve(documents.length)
    },

    insertOne: (
      document: MemberDocumentInput
    ): Promise<{ acknowledged: boolean; insertedId: ObjectId }> => {
      const rejection = rejectionFor("insertOne")
      if (rejection !== null) {
        return Promise.reject(rejection)
      }
      const _id = new ObjectId()
      documents.push({ _id, ...document })
      return Promise.resolve({ acknowledged: true, insertedId: _id })
    },

    findOneAndUpdate: (
      filter: Filter<MemberDocumentInput>,
      update: UpdateFilter<MemberDocumentInput>,
      updateOptions?: FindOneAndUpdateOptions
    ): Promise<WithId<MemberDocumentInput> | null> => {
      const rejection = rejectionFor("findOneAndUpdate")
      if (rejection !== null) {
        return Promise.reject(rejection)
      }
      const index = documents.findIndex((document) => matches(document, filter))
      if (index === -1) {
        return Promise.resolve(null)
      }
      const before = documents[index]
      const set = (update as { $set?: Partial<MemberDocumentInput> }).$set ?? {}
      const after = { ...before, ...set }
      documents[index] = after
      return Promise.resolve({
        ...(updateOptions?.returnDocument === "after" ? after : before),
      })
    },

    deleteOne: (
      filter: Filter<MemberDocumentInput>
    ): Promise<{ acknowledged: boolean; deletedCount: number }> => {
      const rejection = rejectionFor("deleteOne")
      if (rejection !== null) {
        return Promise.reject(rejection)
      }
      const index = documents.findIndex((document) => matches(document, filter))
      if (index === -1) {
        return Promise.resolve({ acknowledged: true, deletedCount: 0 })
      }
      documents.splice(index, 1)
      return Promise.resolve({ acknowledged: true, deletedCount: 1 })
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
      return Promise.resolve({
        _id: name as CounterDocument["_id"],
        value,
      })
    },
  }

  const store: MongoStore = {
    ready: () => Promise.resolve(),
    collection: <T extends Document>(
      name: CollectionName
    ): Promise<CollectionOrFailure<T>> => {
      if (name === "members") {
        if (options.membersFailure !== undefined) {
          return Promise.resolve({
            kind: "failure",
            failure: options.membersFailure,
          })
        }
        return Promise.resolve({
          kind: "collection",
          collection: members as unknown as Collection<T>,
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
      throw new Error(`the registry asked for the ${name} collection`)
    },
    connected: () => options.membersFailure === undefined,
    close: () => Promise.resolve(),
  }

  return {
    store,
    summaries: () => documents.map(summarize),
    calls,
    counterCalls: () => counterCalls,
  }
}

/** A registry over `fake`, with the injected id generator and clock. */
function registryOver(fake: FakeRoster) {
  return createMemberRegistryStore(fake.store, {
    generateId: () => NEW_ENTRY_ID,
    now: () => ADD_TIME,
  })
}

/* -------------------------------------------------------------------------- */
/* Assertion helpers                                                          */
/* -------------------------------------------------------------------------- */

/** The seeded roster, as every unchanged-collection assertion expects it. */
const SEEDED_SUMMARIES: readonly DocumentSummary[] = SEEDED.map((fields) => ({
  ...fields,
  createdAt: SEED_TIME.toISOString(),
}))

/** The failure of a result that must be `failed`, with why in the message. */
function expectFailed(
  result:
    AddMemberResult | SetEnabledResult | RemoveMemberResult | ListMembersResult,
  why: string
): StoreFailure {
  if (result.kind !== "failed") {
    throw new Error(`${why}: the operation reported "${result.kind}"`)
  }
  return result.failure
}

/**
 * Asserts the message names the attempted change — the operation and the
 * Member_Label — and carries no driver text (Requirements 2.8, 1.6).
 */
function expectNamesTheChange(
  failure: StoreFailure,
  operation: RosterWriteOperation,
  memberLabel: string,
  error: unknown,
  why: string
): void {
  expect(failure.message, why).toBe(
    rosterWriteFailedMessage({ operation, memberLabel })
  )
  expect(failure.message, why).toContain(operation)
  expect(failure.message, why).toContain(`"${memberLabel}"`)
  expectNoDriverText(failure, error, why)
}

/** Asserts the message names the roster read (Requirements 2.14, 1.6). */
function expectNamesTheRead(
  failure: StoreFailure,
  error: unknown,
  why: string
): void {
  expect(failure.message, why).toBe(rosterReadFailedMessage())
  expect(failure.message, why).toContain("The roster could not be read")
  expectNoDriverText(failure, error, why)
}

/** No fragment of the driver error or the connection string survives. */
function expectNoDriverText(
  failure: StoreFailure,
  error: unknown,
  why: string
): void {
  const driverMessage = error instanceof Error ? error.message : String(error)
  expect(failure.message, why).not.toContain(driverMessage)
  for (const fragment of URI_FRAGMENTS) {
    expect(failure.message, `${why} leaked ${fragment}`).not.toContain(fragment)
  }
  expect(Object.keys(failure).sort(), why).toEqual(["message", "reason"])
}

/* -------------------------------------------------------------------------- */
/* Requirement 2.8 — the add path                                             */
/* -------------------------------------------------------------------------- */

describe("a failed add inserts nothing and names the attempted change (Requirement 2.8)", () => {
  it("reports failed when the insert is rejected", async () => {
    for (const [why, error, reason] of REJECTIONS) {
      const fake = fakeRoster({ reject: { insertOne: error } })

      const result = await registryOver(fake).add(SUBMISSION)

      const failure = expectFailed(result, why)
      expect(failure.reason, why).toBe(reason)
      expectNamesTheChange(failure, "add", SUBMISSION.memberLabel, error, why)
      // Nothing reached the collection: the same three Store_Documents.
      expect(fake.summaries(), why).toEqual(SEEDED_SUMMARIES)
    }
  })

  it("reports failed when the uniqueness pre-read is rejected", async () => {
    for (const [why, error, reason] of REJECTIONS) {
      const fake = fakeRoster({ reject: { findOne: error } })

      const failure = expectFailed(
        await registryOver(fake).add(SUBMISSION),
        why
      )

      expect(failure.reason, why).toBe(reason)
      /* The submitted Member_Label is known before any read, so the sentence
       * names the change even though the read that failed is the first thing
       * the path did. */
      expectNamesTheChange(failure, "add", SUBMISSION.memberLabel, error, why)
      expect(fake.calls, why).toEqual(["findOne"])
      // No position was consumed and no insert was attempted.
      expect(fake.counterCalls(), why).toBe(0)
      expect(fake.summaries(), why).toEqual(SEEDED_SUMMARIES)
    }
  })

  it("reports failed when the cap count is rejected", async () => {
    const [why, error, reason] = REJECTIONS[0]
    const fake = fakeRoster({ reject: { countDocuments: error } })

    const failure = expectFailed(await registryOver(fake).add(SUBMISSION), why)

    expect(failure.reason).toBe(reason)
    expectNamesTheChange(failure, "add", SUBMISSION.memberLabel, error, why)
    expect(fake.calls).toEqual(["findOne", "countDocuments"])
    expect(fake.counterCalls()).toBe(0)
    expect(fake.summaries()).toEqual(SEEDED_SUMMARIES)
  })

  it("reports failed when the counter cannot be advanced", async () => {
    /* `src/server/store/counters.server.ts` is the other module an add depends
     * on, and it has no client-visible sentence of its own: the operation that
     * asked for the value supplies one. A refused increment therefore speaks
     * with the add's own sentence. */
    const [why, error] = REJECTIONS[2]
    const fake = fakeRoster({ rejectCounter: error })

    const failure = expectFailed(await registryOver(fake).add(SUBMISSION), why)

    expect(failure.reason).toBe("rejected")
    expectNamesTheChange(failure, "add", SUBMISSION.memberLabel, error, why)
    // The increment was attempted once, and the insert never was.
    expect(fake.counterCalls()).toBe(1)
    expect(fake.calls).not.toContain("insertOne")
    expect(fake.summaries()).toEqual(SEEDED_SUMMARIES)
  })

  it("inserts nothing when the counter increment goes unanswered", async () => {
    /* The same failing dependency, classified `unreachable` instead of
     * `rejected`: the deployment gave no answer inside its bound rather than
     * answering no. That is Requirement 2.8's *first* clause, and it asks for
     * the same message as the second — the change was not saved, and the
     * attempted change named — so the sentence is the add's own here too, and
     * only the `reason` distinguishes this case from the one above. The
     * increment is an operation the add attempted, which is why it is re-spoken
     * at all: a failure the store settled before the add attempted anything
     * keeps its own sentence, and the case below pins that. */
    const [why, error] = REJECTIONS[0]
    const fake = fakeRoster({ rejectCounter: error })

    const failure = expectFailed(await registryOver(fake).add(SUBMISSION), why)

    expect(failure.reason).toBe("unreachable")
    expect(failure.message).toBe(
      rosterWriteFailedMessage({ operation: "add", memberLabel: "Dara" })
    )
    expectNoDriverText(failure, error, why)
    expect(fake.calls).not.toContain("insertOne")
    expect(fake.summaries()).toEqual(SEEDED_SUMMARIES)
  })

  it("keeps the store's own sentence when there is no collection", async () => {
    /* Both failures were settled by the bootstrap before this add attempted
     * anything — no `MONGODB_URI` (Requirements 1.3, 1.10), no connection yet
     * (Requirement 1.11) — and each requirement asks for exactly the sentence it
     * already carries, so neither is re-spoken as an add. */
    for (const [why, storeFailure] of COLLECTION_FAILURES) {
      const fake = fakeRoster({ membersFailure: storeFailure })

      const failure = expectFailed(
        await registryOver(fake).add(SUBMISSION),
        why
      )

      expect(failure, why).toEqual(storeFailure)
      expect(fake.calls, why).toEqual([])
      expect(fake.counterCalls(), why).toBe(0)
      expect(fake.summaries(), why).toEqual(SEEDED_SUMMARIES)
    }
  })

  it("names the change when the counters collection is unavailable", async () => {
    /* The counter is reached only after `members()` has already been served, so
     * Requirements 1.3, 1.10, and 1.11 have already had their sentence spoken by
     * the case above: an add against a store with no `MONGODB_URI` and an add
     * against a store with no connection never get this far. A `counters` handle
     * that is unavailable *after* the `members` handle was served is a pool that
     * closed part-way through this add — the failure of something the add
     * attempted — so it speaks with the add's sentence, and the store's `reason`
     * is carried through untouched rather than replaced. What Requirement 2.8
     * asks of the collection is what both cases share: nothing inserted. */
    for (const [why, storeFailure] of COLLECTION_FAILURES) {
      const fake = fakeRoster({ countersFailure: storeFailure })

      const failure = expectFailed(
        await registryOver(fake).add(SUBMISSION),
        `counters: ${why}`
      )

      expect(failure.reason, why).toBe(storeFailure.reason)
      expect(failure.message, why).toBe(
        rosterWriteFailedMessage({
          operation: "add",
          memberLabel: SUBMISSION.memberLabel,
        })
      )
      expect(fake.calls, why).not.toContain("insertOne")
      expect(fake.summaries(), why).toEqual(SEEDED_SUMMARIES)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Requirement 2.8 — the setEnabled path                                      */
/* -------------------------------------------------------------------------- */

describe("a failed setEnabled changes nothing and names the attempted change (Requirement 2.8)", () => {
  /** The two directions, each on an entry currently in the other state. */
  const directions: readonly (readonly [
    string,
    boolean,
    RosterWriteOperation,
    string,
  ])[] = [
    ["m-1", false, "disable", "Ana"],
    ["m-2", true, "enable", "Bruno"],
  ]

  it("reports failed when the update is rejected", async () => {
    for (const [entryId, enabled, operation, memberLabel] of directions) {
      for (const [reason, error, expectedReason] of REJECTIONS) {
        const why = `${operation} ${memberLabel} on ${reason}`
        const fake = fakeRoster({ reject: { findOneAndUpdate: error } })

        const failure = expectFailed(
          await registryOver(fake).setEnabled(entryId, enabled),
          why
        )

        expect(failure.reason, why).toBe(expectedReason)
        /* The pre-read succeeded, so the sentence names the Member_Label of the
         * entry rather than the stand-in. */
        expectNamesTheChange(failure, operation, memberLabel, error, why)
        // The enabled state of every Store_Document is exactly as it was.
        expect(fake.summaries(), why).toEqual(SEEDED_SUMMARIES)
      }
    }
  })

  it("names the stand-in subject when the pre-read is rejected", async () => {
    /* The read that would have supplied the Member_Label is the thing that
     * failed, so the sentence names {@link UNKNOWN_MEMBER_LABEL} — some subject
     * rather than none. */
    for (const [entryId, enabled, operation] of directions) {
      const [reason, error] = REJECTIONS[1]
      const why = `${operation} on ${reason}`
      const fake = fakeRoster({ reject: { findOne: error } })

      const failure = expectFailed(
        await registryOver(fake).setEnabled(entryId, enabled),
        why
      )

      expectNamesTheChange(failure, operation, UNKNOWN_MEMBER_LABEL, error, why)
      expect(failure.message, why).toContain("the selected entry")
      // No update was attempted after the read failed.
      expect(fake.calls, why).toEqual(["findOne"])
      expect(fake.summaries(), why).toEqual(SEEDED_SUMMARIES)
    }
  })

  it("keeps the store's own sentence when there is no collection", async () => {
    for (const [why, storeFailure] of COLLECTION_FAILURES) {
      const fake = fakeRoster({ membersFailure: storeFailure })

      const failure = expectFailed(
        await registryOver(fake).setEnabled("m-1", false),
        why
      )

      expect(failure, why).toEqual(storeFailure)
      expect(fake.calls, why).toEqual([])
      expect(fake.summaries(), why).toEqual(SEEDED_SUMMARIES)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Requirement 2.8 — the remove path                                          */
/* -------------------------------------------------------------------------- */

describe("a failed remove deletes nothing and names the attempted change (Requirement 2.8)", () => {
  it("reports failed when the delete is rejected", async () => {
    for (const [why, error, reason] of REJECTIONS) {
      const fake = fakeRoster({ reject: { deleteOne: error } })

      const failure = expectFailed(await registryOver(fake).remove("m-1"), why)

      expect(failure.reason, why).toBe(reason)
      expectNamesTheChange(failure, "remove", "Ana", error, why)
      // All three Store_Documents are still there, positions included.
      expect(fake.summaries(), why).toEqual(SEEDED_SUMMARIES)
    }
  })

  it("names the stand-in subject when the pre-read is rejected", async () => {
    const [why, error] = REJECTIONS[3]
    const fake = fakeRoster({ reject: { findOne: error } })

    const failure = expectFailed(await registryOver(fake).remove("m-1"), why)

    expectNamesTheChange(failure, "remove", UNKNOWN_MEMBER_LABEL, error, why)
    expect(fake.calls).toEqual(["findOne"])
    expect(fake.summaries()).toEqual(SEEDED_SUMMARIES)
  })

  it("keeps the store's own sentence when there is no collection", async () => {
    for (const [why, storeFailure] of COLLECTION_FAILURES) {
      const fake = fakeRoster({ membersFailure: storeFailure })

      const failure = expectFailed(await registryOver(fake).remove("m-1"), why)

      expect(failure, why).toEqual(storeFailure)
      expect(fake.calls, why).toEqual([])
      expect(fake.summaries(), why).toEqual(SEEDED_SUMMARIES)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Requirement 2.14 — the read path                                           */
/* -------------------------------------------------------------------------- */

describe("a failed roster read returns zero entries and says the roster could not be read (Requirement 2.14)", () => {
  /** Both reads share one implementation, so both are exercised. */
  const reads = ["list", "listEnabled"] as const

  it("reports failed when the read is rejected", async () => {
    for (const read of reads) {
      for (const [reason, error, expectedReason] of REJECTIONS) {
        const why = `${read} on ${reason}`
        const fake = fakeRoster({ reject: { find: error } })

        const result = await registryOver(fake)[read]()

        const failure = expectFailed(result, why)
        expect(failure.reason, why).toBe(expectedReason)
        expectNamesTheRead(failure, error, why)
        /* Zero entries: the failed result carries no `entries` field at all, so
         * there is nothing partially read for a caller to render. */
        expect("entries" in result, why).toBe(false)
        expect(fake.summaries(), why).toEqual(SEEDED_SUMMARIES)
      }
    }
  })

  it("keeps the store's own sentence when there is no collection", async () => {
    for (const read of reads) {
      for (const [reason, storeFailure] of COLLECTION_FAILURES) {
        const why = `${read} on ${reason}`
        const fake = fakeRoster({ membersFailure: storeFailure })

        const result = await registryOver(fake)[read]()

        expect(expectFailed(result, why), why).toEqual(storeFailure)
        expect("entries" in result, why).toBe(false)
        expect(fake.calls, why).toEqual([])
        expect(fake.summaries(), why).toEqual(SEEDED_SUMMARIES)
      }
    }
  })
})

/* -------------------------------------------------------------------------- */
/* The control                                                                */
/* -------------------------------------------------------------------------- */

describe("the fake collection serves all four paths when nothing is injected", () => {
  /* Without this, every assertion above could be passing against a harness that
   * had quietly stopped working: a `findOne` that always rejected, a store whose
   * `collection()` never served anything, a registry that reported `failed` for
   * reasons of its own. Each path below succeeds through the same fake. */

  it("reads the roster in position order, and the enabled subset", async () => {
    const fake = fakeRoster()
    const registry = registryOver(fake)

    const all = await registry.list()
    const enabled = await registry.listEnabled()

    if (all.kind !== "entries" || enabled.kind !== "entries") {
      throw new Error("the control read failed")
    }
    expect(all.entries.map((entry) => entry.memberLabel)).toEqual([
      "Ana",
      "Bruno",
      "Chidi",
    ])
    expect(enabled.entries.map((entry) => entry.memberLabel)).toEqual([
      "Ana",
      "Chidi",
    ])
  })

  it("adds, disables, and removes", async () => {
    const added = fakeRoster()
    const addResult = await registryOver(added).add(SUBMISSION)
    expect(addResult.kind).toBe("added")
    expect(added.summaries()).toHaveLength(SEEDED.length + 1)
    expect(added.summaries().at(-1)).toEqual({
      entryId: NEW_ENTRY_ID,
      memberLabel: SUBMISSION.memberLabel,
      hiveId: SUBMISSION.hiveId,
      enabled: true,
      // Above every seeded position, from the counter.
      position: SEEDED.length + 1,
      createdAt: ADD_TIME.toISOString(),
    })

    const disabled = fakeRoster()
    const setResult = await registryOver(disabled).setEnabled("m-1", false)
    expect(setResult.kind).toBe("updated")
    expect(disabled.summaries()[0]).toEqual({
      ...SEEDED_SUMMARIES[0],
      enabled: false,
    })

    const removed = fakeRoster()
    const removeResult = await registryOver(removed).remove("m-1")
    expect(removeResult.kind).toBe("removed")
    expect(removed.summaries()).toEqual(SEEDED_SUMMARIES.slice(1))
  })

  it("reports not-found for an identifier no Store_Document holds", async () => {
    /* The complement of the failure cases: an absent entry is Requirement
     * 2.13's `not-found`, not a store failure, and it leaves the collection
     * alone too. */
    const fake = fakeRoster()
    const registry = registryOver(fake)

    expect((await registry.setEnabled("m-absent", true)).kind).toBe("not-found")
    expect((await registry.remove("m-absent")).kind).toBe("not-found")
    expect(fake.summaries()).toEqual(SEEDED_SUMMARIES)
  })
})
