import {
  copyFile,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { parseUpstreamBody } from "@/domain/responseParser"
import {
  ALREADY_USED_FIXTURE,
  FIXTURE_BUCKET_COUNT,
  FixtureUnavailableError,
  INVALID_COUPON_FIXTURE,
  MOCK_FIXTURE_NAMES,
  MockUpstreamClient,
  SUCCESS_FIXTURE,
  cachedFixturePaths,
  checkMockFixtures,
  clearFixtureCache,
  createMockUpstreamClient,
  fixtureBucket,
  resolveDefaultFixtureDir,
  selectFixtureName,
} from "@/server/upstream/mock.server"
import type { MockFixtureName } from "@/server/upstream/mock.server"
import type { UpstreamResult } from "@/domain/types"
import type { UseCouponRequest } from "@/server/upstream/client"

/**
 * Mock_Mode fixture handling (Requirements 7.3, 7.6, 7.10).
 *
 * Three things are established here:
 *
 *   1. Selection is a pure function of the pair, so a repeated Coupon_Code and
 *      Hive_ID picks the same fixture across calls and across fresh client
 *      instances, and the documented bucket ranges hold (Requirement 7.3).
 *   2. Fixture bytes reach the Response_Parser unchanged — the client returns
 *      the raw file text, never a re-serialization of the parsed value.
 *   3. A deleted fixture and a corrupted fixture each abort the request with a
 *      failure that names the fixture and states the condition, with no `fetch`
 *      call and no Member_Outcome derived (Requirements 7.6, 7.10).
 *
 * Every test that touches an unusable fixture works on a **copy** of the three
 * real fixtures inside a temporary directory: `fixtures/upstream/*.json` is
 * byte-compared against `docs/upstream-api.md` by
 * `tests/unit/upstreamFixtures.test.ts` and is never modified here.
 *
 * The fixture cache lives at module scope inside `mock.server.ts`, shared by
 * every client instance in this process, so `clearFixtureCache()` runs before
 * and after each test to keep tests from leaking into one another.
 */

/** The repository's real fixture directory; read from, never written to. */
const realFixtureDir = resolveDefaultFixtureDir()

/** Temporary directories created by a test, removed in `afterEach`. */
const tempDirs: string[] = []

/**
 * A throwaway copy of the three real fixtures, so a test can delete or corrupt
 * one without touching the repository.
 */
async function makeFixtureDirCopy(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mock-fixtures-"))
  tempDirs.push(dir)
  for (const fixtureName of MOCK_FIXTURE_NAMES) {
    await copyFile(join(realFixtureDir, fixtureName), join(dir, fixtureName))
  }
  return dir
}

function pair(coupon: string, hiveid: string): UseCouponRequest {
  return { coupon, hiveid }
}

/**
 * A pair whose bucket satisfies `predicate`, found by search rather than
 * assumed. The two values vary independently: holding the byte parity of the
 * key fixed reaches only even buckets, and would never select
 * `invalid-coupon-h306.json`.
 */
function findPair(predicate: (bucket: number) => boolean): UseCouponRequest {
  const span = 64
  for (let c = 0; c < span; c += 1) {
    for (let h = 0; h < span; h += 1) {
      const candidate = pair(`SPRING-${c}`, `hive-${h}`)
      if (predicate(fixtureBucket(candidate.coupon, candidate.hiveid))) {
        return candidate
      }
    }
  }
  throw new Error("no pair in the search space satisfies the predicate")
}

/** One pair per bucket, so the documented ranges can be checked directly. */
const pairByBucket: readonly UseCouponRequest[] = Array.from(
  { length: FIXTURE_BUCKET_COUNT },
  (_unused, bucket) => findPair((candidate) => candidate === bucket)
)

/** The documented bucket ranges of Requirement 7.3, restated independently. */
function documentedFixtureForBucket(bucket: number): MockFixtureName {
  if (bucket <= 9) return SUCCESS_FIXTURE
  if (bucket <= 14) return ALREADY_USED_FIXTURE
  return INVALID_COUPON_FIXTURE
}

/** One pair per fixture, so all three fixtures are exercised. */
const pairByFixture: Record<MockFixtureName, UseCouponRequest> = {
  [SUCCESS_FIXTURE]: findPair((bucket) => bucket <= 9),
  [ALREADY_USED_FIXTURE]: findPair((bucket) => bucket >= 10 && bucket <= 14),
  [INVALID_COUPON_FIXTURE]: findPair((bucket) => bucket === 15),
}

/**
 * Runs the Mock_Mode leg of the run loop: one `useCoupon` request, then the
 * Response_Parser. `derived` stays empty when the request aborts, which is what
 * "no Member_Outcome is derived" means for Requirements 7.6 and 7.10.
 */
function outcomeDeriver(client: MockUpstreamClient) {
  const derived: UpstreamResult[] = []
  return {
    derived,
    async run(req: UseCouponRequest): Promise<UpstreamResult> {
      const raw = await client.useCoupon(req)
      const result = parseUpstreamBody({
        bodyText: raw.bodyText,
        transportFailure: raw.transportFailure,
      })
      derived.push(result)
      return result
    },
  }
}

function spyOnFetch() {
  return vi.spyOn(globalThis, "fetch")
}

let fetchSpy: ReturnType<typeof spyOnFetch>

beforeEach(() => {
  clearFixtureCache()
  fetchSpy = spyOnFetch().mockImplementation(() => {
    throw new Error("Mock_Mode must never call fetch")
  })
})

afterEach(async () => {
  // Holds on every path, including the two failure paths (Requirements 7.3, 7.6).
  expect(fetchSpy, "Mock_Mode issued no fetch call").not.toHaveBeenCalled()
  vi.restoreAllMocks()
  clearFixtureCache()
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe("fixture selection is deterministic (Requirement 7.3)", () => {
  it("selects the same fixture for a repeated pair across repeated calls", () => {
    for (const req of pairByBucket) {
      const first = selectFixtureName(req.coupon, req.hiveid)
      const bucket = fixtureBucket(req.coupon, req.hiveid)
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect(selectFixtureName(req.coupon, req.hiveid)).toBe(first)
        expect(fixtureBucket(req.coupon, req.hiveid)).toBe(bucket)
      }
    }
  })

  it("maps buckets 0-9 to success, 10-14 to already-used, and 15 to invalid-coupon", () => {
    const buckets = pairByBucket.map((req) =>
      fixtureBucket(req.coupon, req.hiveid)
    )
    expect(buckets).toEqual([...Array(FIXTURE_BUCKET_COUNT).keys()])

    for (const req of pairByBucket) {
      const bucket = fixtureBucket(req.coupon, req.hiveid)
      const expected = documentedFixtureForBucket(bucket)

      expect(
        selectFixtureName(req.coupon, req.hiveid),
        `bucket ${bucket} selects ${expected}`
      ).toBe(expected)
    }
  })

  it("has a reachable pair for each of the three fixtures", () => {
    for (const fixtureName of MOCK_FIXTURE_NAMES) {
      const req = pairByFixture[fixtureName]
      expect(selectFixtureName(req.coupon, req.hiveid)).toBe(fixtureName)
    }
    expect(new Set(Object.values(pairByFixture)).size).toBe(
      MOCK_FIXTURE_NAMES.length
    )
  })

  it("selectFixture agrees with selectFixtureName for every pair", () => {
    const client = createMockUpstreamClient()
    for (const req of pairByBucket) {
      expect(client.selectFixture(req)).toBe(
        selectFixtureName(req.coupon, req.hiveid)
      )
    }
  })
})

describe("MockUpstreamClient serves fixture bytes unchanged", () => {
  it.each(MOCK_FIXTURE_NAMES)(
    "returns %s byte-identical to the file on disk, with status 200 and no transport failure",
    async (fixtureName) => {
      const client = new MockUpstreamClient()
      const raw = await client.useCoupon(pairByFixture[fixtureName])
      const onDisk = await readFile(join(realFixtureDir, fixtureName))

      expect(raw.status).toBe(200)
      expect(raw.transportFailure).toBeNull()
      expect(raw.bodyText).not.toBeNull()
      expect(
        Buffer.from(raw.bodyText!, "utf8").equals(onDisk),
        `${fixtureName} is served without re-serialization`
      ).toBe(true)
      // A re-serialized body would drop the exact spacing of the fixture.
      expect(raw.bodyText).toBe(onDisk.toString("utf8"))
    }
  )

  it("returns the same bodyText across repeated calls and across a fresh client instance", async () => {
    const client = new MockUpstreamClient()

    for (const fixtureName of MOCK_FIXTURE_NAMES) {
      const req = pairByFixture[fixtureName]
      const first = await client.useCoupon(req)
      const second = await client.useCoupon(req)

      // A fresh instance with a cold cache reads the file again.
      clearFixtureCache()
      const fresh = new MockUpstreamClient()
      const third = await fresh.useCoupon(req)

      expect(second.bodyText).toBe(first.bodyText)
      expect(third.bodyText).toBe(first.bodyText)
      expect(third.status).toBe(first.status)
      expect(third.transportFailure).toBe(first.transportFailure)
    }
  })

  it("derives the same Member_Outcome for a repeated pair", async () => {
    const client = new MockUpstreamClient()
    const deriver = outcomeDeriver(client)

    for (const fixtureName of MOCK_FIXTURE_NAMES) {
      await deriver.run(pairByFixture[fixtureName])
      await deriver.run(pairByFixture[fixtureName])
    }

    expect(deriver.derived.map((result) => result.outcome)).toEqual([
      "SUCCESS",
      "SUCCESS",
      "ALREADY_USED",
      "ALREADY_USED",
      "INVALID_COUPON",
      "INVALID_COUPON",
    ])
  })

  it("reports itself as mock and never calls fetch", async () => {
    const client = new MockUpstreamClient()

    expect(client.isMock).toBe(true)
    await client.useCoupon(pairByFixture[SUCCESS_FIXTURE])
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe("a deleted fixture aborts the request (Requirements 7.6, 7.10)", () => {
  it("rejects with an absent-fixture failure that names the fixture, deriving no outcome", async () => {
    const fixtureDir = await makeFixtureDirCopy()
    const client = createMockUpstreamClient({ fixtureDir })
    const req = pairByFixture[INVALID_COUPON_FIXTURE]
    const fixtureName = client.selectFixture(req)

    // Warm the cache first, so the failure cannot be a cold-start artefact.
    await client.useCoupon(req)
    await unlink(join(fixtureDir, fixtureName))
    clearFixtureCache()

    const deriver = outcomeDeriver(client)
    const error = await deriver.run(req).then(
      () => null,
      (thrown: unknown) => thrown
    )

    expect(error).toBeInstanceOf(FixtureUnavailableError)
    const failure = error as FixtureUnavailableError
    expect(failure.code).toBe("FIXTURE_UNAVAILABLE")
    expect(failure.reason).toBe("absent")
    expect(failure.fixtureName).toBe(fixtureName)
    expect(failure.fixturePath).toBe(client.fixturePath(fixtureName))
    expect(failure.message).toContain(fixtureName)
    expect(failure.message).toContain("is absent")

    expect(deriver.derived, "no Member_Outcome was derived").toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("checkMockFixtures reports the absent fixture in the pre-flight", async () => {
    const fixtureDir = await makeFixtureDirCopy()
    await unlink(join(fixtureDir, ALREADY_USED_FIXTURE))
    clearFixtureCache()

    const check = await checkMockFixtures({ fixtureDir })

    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.code).toBe("FIXTURE_UNAVAILABLE")
    expect(check.fixtureName).toBe(ALREADY_USED_FIXTURE)
    expect(check.fixturePath).toBe(join(fixtureDir, ALREADY_USED_FIXTURE))
    expect(check.reason).toBe("absent")
    expect(check.message).toContain(ALREADY_USED_FIXTURE)
    expect(check.message).toContain("is absent")
  })
})

describe("a corrupted fixture aborts the request (Requirements 7.6, 7.10)", () => {
  it("rejects with an invalid-JSON failure that names the fixture, deriving no outcome", async () => {
    const fixtureDir = await makeFixtureDirCopy()
    const client = createMockUpstreamClient({ fixtureDir })
    const req = pairByFixture[SUCCESS_FIXTURE]
    const fixtureName = client.selectFixture(req)

    await writeFile(join(fixtureDir, fixtureName), '{"retCode":100,', "utf8")
    clearFixtureCache()

    const deriver = outcomeDeriver(client)
    const error = await deriver.run(req).then(
      () => null,
      (thrown: unknown) => thrown
    )

    expect(error).toBeInstanceOf(FixtureUnavailableError)
    const failure = error as FixtureUnavailableError
    expect(failure.code).toBe("FIXTURE_UNAVAILABLE")
    expect(failure.reason).toBe("invalid-json")
    expect(failure.fixtureName).toBe(fixtureName)
    expect(failure.fixturePath).toBe(join(fixtureDir, fixtureName))
    expect(failure.message).toContain(fixtureName)
    expect(failure.message).toContain("is not valid JSON")

    expect(deriver.derived, "no Member_Outcome was derived").toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("checkMockFixtures reports the corrupted fixture in the pre-flight", async () => {
    const fixtureDir = await makeFixtureDirCopy()
    await writeFile(
      join(fixtureDir, INVALID_COUPON_FIXTURE),
      "not json",
      "utf8"
    )
    clearFixtureCache()

    const check = await checkMockFixtures({ fixtureDir })

    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.fixtureName).toBe(INVALID_COUPON_FIXTURE)
    expect(check.reason).toBe("invalid-json")
    expect(check.message).toContain(INVALID_COUPON_FIXTURE)
    expect(check.message).toContain("is not valid JSON")
  })
})

describe("the fixture cache remembers only usable fixtures", () => {
  it("caches a fixture it served", async () => {
    const fixtureDir = await makeFixtureDirCopy()
    const client = createMockUpstreamClient({ fixtureDir })
    const req = pairByFixture[SUCCESS_FIXTURE]

    expect(cachedFixturePaths()).toEqual([])
    await client.useCoupon(req)

    expect(cachedFixturePaths()).toContain(
      client.fixturePath(client.selectFixture(req))
    )
  })

  it("does not cache a corrupt fixture, so repairing it recovers without a restart", async () => {
    const fixtureDir = await makeFixtureDirCopy()
    const client = createMockUpstreamClient({ fixtureDir })
    const req = pairByFixture[ALREADY_USED_FIXTURE]
    const fixtureName = client.selectFixture(req)
    const fixturePath = join(fixtureDir, fixtureName)
    const goodBody = await readFile(join(realFixtureDir, fixtureName), "utf8")

    await writeFile(fixturePath, "]not json[", "utf8")
    clearFixtureCache()

    await expect(client.useCoupon(req)).rejects.toBeInstanceOf(
      FixtureUnavailableError
    )
    expect(cachedFixturePaths()).not.toContain(fixturePath)

    // No cache clearing between the repair and the next request.
    await writeFile(fixturePath, goodBody, "utf8")
    const raw = await client.useCoupon(req)

    expect(raw.bodyText).toBe(goodBody)
    expect(cachedFixturePaths()).toContain(fixturePath)
  })

  it("checkMockFixtures reports ok for an intact fixture directory", async () => {
    const fixtureDir = await makeFixtureDirCopy()

    expect(await checkMockFixtures({ fixtureDir })).toEqual({ ok: true })
    expect(
      await createMockUpstreamClient({ fixtureDir }).checkFixtures()
    ).toEqual({ ok: true })
  })
})
