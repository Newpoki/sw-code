/**
 * Unit tests for the in-memory {@link MongoStore} of
 * `tests/support/inMemoryMongoStore.ts`.
 *
 * A test helper that quietly stops serving something is worse than no helper at
 * all: every suite built over it goes green while asserting nothing. So this
 * file drives the **real** `createMemberRegistryStore` and `createHistoryStore`
 * against the fake and pins the behaviour those two modules depend on:
 *
 *   - roster add, list, listEnabled, setEnabled, and remove, in position order
 *     (Requirements 2.1, 2.2, 2.6, 2.7);
 *   - a duplicate Hive_ID refused — by the pre-read, and by the unique index
 *     underneath it, which is the path that produces `code: 11000`
 *     (Requirements 2.4, 1.7);
 *   - history append, list in Requirement 3.4 order, and
 *     findLatestByCouponCode (Requirements 3.1, 3.4, 3.5);
 *   - the retention trim at {@link HISTORY_RETENTION_LIMIT}, trimming from the
 *     lowest `seq` up (Requirement 3.3);
 *   - the two counters advancing independently and never dropping
 *     (Requirements 2.1, 3.2);
 *   - two stores over one backing store seeing the same documents, which is what
 *     lets the restart clauses of Requirements 2.3 and 3.6 be exercised without a
 *     database;
 *   - the two shapes of injected failure still reaching the store modules, so
 *     the suites that assert on failures have something that fails.
 *
 * These are assertions about the helper, not about MongoDB. What a real
 * deployment does — that the index is created, that a second client reads what
 * the first durably wrote — stays with `tests/support/mongoFixture.ts` and the
 * integration suite that uses it.
 */

import { describe, expect, it } from "vitest"

import { MongoOperationTimeoutError } from "mongodb"

import { historyReadFailedMessage } from "@/domain/storeMessages"
import { toHistoryDocument } from "@/server/store/documents.server"
import type {
  HistoryDocumentInput,
  MemberDocumentInput,
} from "@/server/store/documents.server"
import {
  HISTORY_RETENTION_LIMIT,
  createHistoryStore,
} from "@/server/store/history.server"
import type { AppendHistoryInput } from "@/server/store/history.server"
import { createMemberRegistryStore } from "@/server/store/memberRegistry.server"
import type {
  AddMemberResult,
  MemberRegistryStore,
} from "@/server/store/memberRegistry.server"
import type { RedemptionHistoryRecord } from "@/domain/types"

import {
  createInMemoryBackingStore,
  createInMemoryMongoStore,
} from "../support/inMemoryMongoStore"
import type { InMemoryMongoStoreHandle } from "../support/inMemoryMongoStore"

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** Fixed clock, so every `createdAt` and every assertion is deterministic. */
const NOW = new Date("2025-01-04T18:00:00.000Z")

/** A registry over `handle`, with deterministic ids and a fixed clock. */
function registryOver(handle: InMemoryMongoStoreHandle): MemberRegistryStore {
  let issued = 0
  return createMemberRegistryStore(handle.store, {
    generateId: () => {
      issued += 1
      return `m-${issued}`
    },
    now: () => NOW,
  })
}

/** A Redemption_History over `handle`, with the capturing logger installed. */
function historyOver(handle: InMemoryMongoStoreHandle) {
  return createHistoryStore(handle.store, { logger: handle.logger })
}

/** The `added` entry, or a thrown explanation of what happened instead. */
function expectAdded(result: AddMemberResult, why: string) {
  if (result.kind !== "added") {
    throw new Error(`${why}: the add reported "${result.kind}"`)
  }
  return result.entry
}

/** One outcome row, the same two on every appended record below. */
const OUTCOME_ROWS = [
  {
    hiveId: "hive-ana",
    memberLabel: "Ana",
    outcome: "SUCCESS" as const,
    responseCode: "(100)",
    responseMessage: "Coupon redeemed.",
  },
  {
    hiveId: "hive-bruno",
    memberLabel: "Bruno",
    outcome: "SKIPPED" as const,
    responseCode: "",
    responseMessage: "",
  },
]

/** An append input, distinguished by its Coupon_Code and completion instant. */
function appendInput(
  couponCode: string,
  completedAt: string
): AppendHistoryInput {
  return {
    runId: `run-${couponCode}-${completedAt}`,
    couponCode,
    completedAt,
    mock: false,
    stoppedEarly: false,
    outcomes: OUTCOME_ROWS,
  }
}

/** A stored Store_Document, as a seed for the retention cases. */
function historySeed(seq: number, completedAt: string): HistoryDocumentInput {
  const record: RedemptionHistoryRecord = {
    runId: `run-${seq}`,
    seq,
    couponCode: "SW2025BULK",
    completedAt,
    mock: false,
    stoppedEarly: false,
    outcomes: OUTCOME_ROWS,
  }
  return toHistoryDocument(record)
}

/* -------------------------------------------------------------------------- */
/* The Member_Registry over the fake                                          */
/* -------------------------------------------------------------------------- */

describe("the fake serves a Member_Registry", () => {
  it("adds, lists in position order, filters, updates, and removes", async () => {
    const handle = createInMemoryMongoStore()
    const registry = registryOver(handle)

    const ana = expectAdded(
      await registry.add({ memberLabel: "Ana", hiveId: "hive-ana" }),
      "the first add"
    )
    const bruno = expectAdded(
      await registry.add({ memberLabel: "Bruno", hiveId: "hive-bruno" }),
      "the second add"
    )
    expectAdded(
      await registry.add({ memberLabel: "Chidi", hiveId: "hive-chidi" }),
      "the third add"
    )

    /* Requirement 2.1: the entry is stored with what was submitted, trimmed,
     * enabled, and stamped by the injected clock. */
    expect(ana).toEqual({
      id: "m-1",
      memberLabel: "Ana",
      hiveId: "hive-ana",
      enabled: true,
      createdAt: NOW.toISOString(),
    })

    // Requirement 2.2: insertion order, because `position` ascends with it.
    const listed = await registry.list()
    expect(listed.kind).toBe("entries")
    expect(
      listed.kind === "entries"
        ? listed.entries.map((entry) => entry.memberLabel)
        : []
    ).toEqual(["Ana", "Bruno", "Chidi"])

    // Requirement 2.1: every position is above every one already stored.
    expect(handle.members().map((document) => document.position)).toEqual([
      1, 2, 3,
    ])

    /* Requirement 2.7: one field changes, and the read that follows still sorts
     * by position rather than by when the update happened. */
    const disabled = await registry.setEnabled(bruno.id, false)
    expect(disabled.kind).toBe("updated")

    const enabledOnly = await registry.listEnabled()
    expect(
      enabledOnly.kind === "entries"
        ? enabledOnly.entries.map((entry) => entry.memberLabel)
        : []
    ).toEqual(["Ana", "Chidi"])
    expect(
      handle
        .members()
        .map((document) => [document.memberLabel, document.enabled])
    ).toEqual([
      ["Ana", true],
      ["Bruno", false],
      ["Chidi", true],
    ])

    /* Requirement 2.6: exactly one Store_Document goes, and no remaining
     * position is renumbered. */
    expect((await registry.remove(bruno.id)).kind).toBe("removed")
    expect(
      handle
        .members()
        .map((document) => [document.memberLabel, document.position])
    ).toEqual([
      ["Ana", 1],
      ["Chidi", 3],
    ])
    expect((await registry.remove(bruno.id)).kind).toBe("not-found")
  })

  it("refuses a duplicate Hive_ID, and the unique index refuses it underneath", async () => {
    const handle = createInMemoryMongoStore()
    const registry = registryOver(handle)

    expectAdded(
      await registry.add({ memberLabel: "Ana", hiveId: "hive-ana" }),
      "the first add"
    )

    /* Requirement 2.4 through the pre-read: nothing inserted, and the
     * conflicting Member_Label named. */
    const duplicate = await registry.add({
      memberLabel: "Ana again",
      hiveId: "hive-ana",
    })
    expect(duplicate).toEqual({ kind: "duplicate", conflictingLabel: "Ana" })
    expect(handle.members()).toHaveLength(1)

    /*
     * And the index underneath it. The pre-read answers first on this path, so
     * the `code: 11000` branch of `memberRegistry.server.ts` is reachable only
     * under a race — which is exactly why the fake has to enforce the index:
     * a fake that let the duplicate through would make that branch dead code
     * that no suite could ever exercise.
     */
    const collection =
      await handle.store.collection<MemberDocumentInput>("members")
    if (collection.kind !== "collection") {
      throw new Error("the fake refused to hand out the members collection")
    }
    const refused = await collection.collection
      .insertOne({
        entryId: "m-race",
        memberLabel: "Ana under a race",
        hiveId: "hive-ana",
        enabled: true,
        createdAt: NOW,
        position: 99,
      })
      .then(
        () => null,
        (error: unknown) => error
      )

    expect(refused, "the unique index served the duplicate").not.toBeNull()
    expect((refused as { code?: unknown }).code).toBe(11_000)
    expect(handle.members()).toHaveLength(1)
  })
})

/* -------------------------------------------------------------------------- */
/* The Redemption_History over the fake                                       */
/* -------------------------------------------------------------------------- */

describe("the fake serves a Redemption_History", () => {
  it("appends, lists newest first, and finds the latest by Coupon_Code", async () => {
    const handle = createInMemoryMongoStore()
    const history = historyOver(handle)

    const first = await history.append(
      appendInput("SW2025NEWYEAR", "2025-01-04T18:00:00.000Z")
    )
    const second = await history.append(
      appendInput("SW2025SPRING", "2025-01-04T19:00:00.000Z")
    )
    const third = await history.append(
      appendInput("SW2025NEWYEAR", "2025-01-04T20:00:00.000Z")
    )

    // Requirement 3.2: 1, then strictly increasing.
    expect([first, second, third].map((result) => result.kind)).toEqual([
      "appended",
      "appended",
      "appended",
    ])
    expect(handle.history().map((document) => document.seq)).toEqual([1, 2, 3])
    /* Requirement 3.1: `completedAtMs` is derived beside the authoritative
     * string, so the sort compares instants. */
    expect(handle.history()[0].completedAtMs).toBe(
      Date.parse("2025-01-04T18:00:00.000Z")
    )

    // Requirement 3.4: newest completion timestamp first.
    const listed = await history.list()
    expect(
      listed.kind === "records"
        ? listed.records.map((record) => record.seq)
        : []
    ).toEqual([3, 2, 1])

    // A limit is applied by the read rather than by the caller.
    const limited = await history.list(2)
    expect(
      limited.kind === "records"
        ? limited.records.map((record) => record.seq)
        : []
    ).toEqual([3, 2])

    /* Requirement 3.5: the most recent of the two records sharing the
     * Coupon_Code, matched character for character. */
    const found = await history.findLatestByCouponCode("SW2025NEWYEAR")
    expect(found.kind === "record" ? found.record.seq : null).toBe(3)
    expect(found.kind === "record" ? found.record.outcomes : []).toEqual(
      OUTCOME_ROWS
    )
    expect((await history.findLatestByCouponCode("sw2025newyear")).kind).toBe(
      "not-found"
    )
  })

  it(`trims to ${HISTORY_RETENTION_LIMIT} records from the lowest seq up`, async () => {
    /* A full retention window, seeded straight into the collection so the
     * counter starts where the seeds end. */
    const handle = createInMemoryMongoStore({
      seed: {
        history: Array.from(
          { length: HISTORY_RETENTION_LIMIT },
          (_row, index) =>
            historySeed(
              index + 1,
              new Date(
                Date.parse("2025-01-04T00:00:00.000Z") + index * 1_000
              ).toISOString()
            )
        ),
        counters: [{ _id: "history_seq", value: HISTORY_RETENTION_LIMIT }],
      },
    })
    const history = historyOver(handle)

    expect(handle.history()).toHaveLength(HISTORY_RETENTION_LIMIT)

    const appended = await history.append(
      appendInput("SW2025SUMMER", "2025-01-05T00:00:00.000Z")
    )

    // Requirement 3.3: the window holds, and the oldest `seq` is the one that went.
    expect(appended.kind).toBe("appended")
    expect(handle.history()).toHaveLength(HISTORY_RETENTION_LIMIT)
    const seqs = handle.history().map((document) => document.seq)
    expect(Math.min(...seqs)).toBe(2)
    expect(Math.max(...seqs)).toBe(HISTORY_RETENTION_LIMIT + 1)
    // Requirement 3.11: a trim that lands logs nothing.
    expect(handle.warnings).toEqual([])
    /* The trim's own `find` — the one carrying the `{ _id: 1 }` projection — is
     * recorded under its own name, so a test can fail it while the
     * Requirement 3.4 read keeps working. */
    expect(handle.callsTo("history")).toEqual([
      "insertOne",
      "countDocuments",
      "retentionFind",
      "deleteMany",
    ])
  })
})

/* -------------------------------------------------------------------------- */
/* The counters                                                               */
/* -------------------------------------------------------------------------- */

describe("the fake keeps one counter per name", () => {
  it("advances member_position and history_seq independently, from 1", async () => {
    const handle = createInMemoryMongoStore()
    const registry = registryOver(handle)
    const history = historyOver(handle)

    /* `$inc` on an absent counter document yields 1, which is the value
     * Requirements 2.1 and 3.2 ask of the first write. */
    expect(handle.counterValue("member_position")).toBeNull()
    expect(handle.counterValue("history_seq")).toBeNull()

    expectAdded(
      await registry.add({ memberLabel: "Ana", hiveId: "hive-ana" }),
      "the add"
    )
    expect(handle.counterValue("member_position")).toBe(1)
    expect(handle.counterValue("history_seq")).toBeNull()

    await history.append(appendInput("SW2025A", "2025-01-04T18:00:00.000Z"))
    await history.append(appendInput("SW2025B", "2025-01-04T19:00:00.000Z"))
    expect(handle.counterValue("history_seq")).toBe(2)
    // The roster counter did not move with it.
    expect(handle.counterValue("member_position")).toBe(1)

    /* Requirement 3.2: the counter does not drop when the record holding the
     * highest `seq` is deleted, because it is not derived from the survivors. */
    handle.backing.live("history").length = 0
    await history.append(appendInput("SW2025C", "2025-01-04T20:00:00.000Z"))
    expect(handle.counterValue("history_seq")).toBe(3)
    expect(handle.history().map((document) => document.seq)).toEqual([3])
  })
})

/* -------------------------------------------------------------------------- */
/* Two stores, one backing store                                              */
/* -------------------------------------------------------------------------- */

describe("two stores over one backing store see the same documents", () => {
  it("reads through the second store what the first one wrote", async () => {
    const backing = createInMemoryBackingStore()
    const first = createInMemoryMongoStore({ backing })
    const second = createInMemoryMongoStore({ backing })

    const written = registryOver(first)
    expectAdded(
      await written.add({ memberLabel: "Ana", hiveId: "hive-ana" }),
      "the add through the first store"
    )
    expectAdded(
      await written.add({ memberLabel: "Bruno", hiveId: "hive-bruno" }),
      "the second add through the first store"
    )
    await historyOver(first).append(
      appendInput("SW2025NEWYEAR", "2025-01-04T18:00:00.000Z")
    )

    /* The restart clauses of Requirements 2.3 and 3.6, minus the durability
     * half: the second store holds no state of the first one's, so what it reads
     * came out of the shared collections. */
    const restarted = await registryOver(second).list()
    expect(
      restarted.kind === "entries"
        ? restarted.entries.map((entry) => entry.memberLabel)
        : []
    ).toEqual(["Ana", "Bruno"])

    const records = await historyOver(second).list()
    expect(
      records.kind === "records"
        ? records.records.map((record) => record.couponCode)
        : []
    ).toEqual(["SW2025NEWYEAR"])

    // And the counters are shared too, so the second store hands out 3, not 1.
    expectAdded(
      await registryOver(second).add({
        memberLabel: "Chidi",
        hiveId: "hive-chidi",
      }),
      "the add through the second store"
    )
    expect(second.members().map((document) => document.position)).toEqual([
      1, 2, 3,
    ])

    /* A failure injected into one store is that store's own: the second one
     * keeps serving, which is what makes a two-store test able to fail exactly
     * one side. */
    first.setCollectionFailure("members", {
      reason: "unreachable",
      message: "the first store lost its pool",
    })
    expect((await registryOver(first).list()).kind).toBe("failed")
    expect((await registryOver(second).list()).kind).toBe("entries")
  })
})

/* -------------------------------------------------------------------------- */
/* Fault injection                                                            */
/* -------------------------------------------------------------------------- */

describe("the fake can fail one operation of one path", () => {
  it("rejects the injected method and serves everything else", async () => {
    const timeout = new MongoOperationTimeoutError(
      "Operation timed out after 5000 ms"
    )
    const handle = createInMemoryMongoStore({
      seed: { history: [historySeed(1, "2025-01-04T18:00:00.000Z")] },
      reject: { history: { find: timeout } },
    })
    const history = historyOver(handle)

    /* The read fails and speaks with the read's own sentence
     * (Requirements 3.10, 1.5). */
    const failed = await history.list()
    expect(failed.kind).toBe("failed")
    expect(failed.kind === "failed" ? failed.failure : null).toEqual({
      reason: "unreachable",
      message: historyReadFailedMessage(),
    })

    // The append path is untouched by it.
    expect(
      (await history.append(appendInput("SW2025A", "2025-01-05T00:00:00.000Z")))
        .kind
    ).toBe("appended")
    expect(handle.history()).toHaveLength(2)

    // And clearing it puts the read back.
    handle.clearRejection("history", "find")
    expect((await history.list()).kind).toBe("records")

    /* The calls are recorded per collection. The trim counted and stopped
     * there — two records is under the window — so no retention read happened. */
    expect(handle.callsTo("history")).toContain("insertOne")
    expect(handle.callsTo("history")).toContain("countDocuments")
    expect(handle.callsTo("history")).not.toContain("retentionFind")
    expect(handle.callsTo("counters")).toEqual(["findOneAndUpdate"])
  })

  it("answers a closed store the way the real one does", async () => {
    const handle = createInMemoryMongoStore()
    expect(handle.store.connected()).toBe(true)

    await handle.store.close()

    expect(handle.store.connected()).toBe(false)
    const closed = await registryOver(handle).list()
    expect(closed.kind).toBe("failed")
    expect(closed.kind === "failed" ? closed.failure.reason : null).toBe(
      "unreachable"
    )
  })
})
