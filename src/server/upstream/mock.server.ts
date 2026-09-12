/**
 * `MockUpstreamClient`: the Mock_Mode implementation of the upstream boundary
 * (Requirements 7.3, 7.6, 7.10).
 *
 * It **never calls `fetch`** — there is no reference to it in this module — and
 * every Member_Outcome it feeds the Response_Parser comes from one of the three
 * response fixtures under `fixtures/upstream/`, whose bodies are byte-identical
 * to the fenced examples of the API_Reference_Document (that identity is guarded
 * by `tests/unit/upstreamFixtures.test.ts`).
 *
 * ## Fixtures are read at request time, not imported
 *
 * The fixture files are read with `fs` **when a request arrives**, through a
 * per-process cache keyed by absolute file path, rather than imported as JSON
 * modules. Importing them would make an absent or corrupt fixture a build-time
 * or startup condition, and Requirement 7.6 needs it to be a reachable runtime
 * condition with a real failure path.
 *
 * Only *usable* fixtures are cached: a read that fails, or text that does not
 * parse as JSON, is never remembered, so repairing a fixture recovers without a
 * restart and corrupting one is observed on the next request.
 *
 * ## Two entry points for the FIXTURE_UNAVAILABLE condition
 *
 * 1. {@link MockUpstreamClient.useCoupon} **rejects** with a
 *    {@link FixtureUnavailableError} when the fixture it selected is absent or
 *    unparseable. {@link UpstreamRawResponse} has no failure channel for this —
 *    `transportFailure` describes the Upstream_API, not a broken install — and a
 *    rejection is what guarantees the abort happens *before* any Member_Outcome
 *    is derived and before any Redemption_History append (Requirements 7.6,
 *    7.10). The run loop turns that rejection into a `run-failed` event carrying
 *    the `FIXTURE_UNAVAILABLE` code.
 * 2. {@link checkMockFixtures} verifies that **all three** fixtures are present
 *    and parseable and reports which one failed and why. This is the pre-flight
 *    check `runRedemption` performs before a Redemption_Run starts (task 10.2),
 *    so an unusable fixture is rejected with zero upstream requests, no derived
 *    outcome, and no history record — rather than being discovered halfway
 *    through a run.
 *
 * ## Fixture directory resolution
 *
 * Fixtures live at `<repo root>/fixtures/upstream/`. Under Vitest the module
 * runs from `src/`, but the built server runs from `dist/`, so a path relative
 * to this module file is not reliable. {@link resolveDefaultFixtureDir} walks up
 * from this module and then falls back to the working directory, looking for a
 * `fixtures/upstream` directory. The directory is also a constructor option, so
 * application wiring can pass an explicit absolute path — that is the wiring
 * concern to settle in task 16.1 if the deployment layout ever separates `dist/`
 * from the fixtures.
 */

import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import process from "node:process"

import type { AppErrorCode } from "@/domain/types"
import type {
  UpstreamClient,
  UpstreamRawResponse,
  UseCouponRequest,
} from "@/server/upstream/client"

/** The three fixture file names, in bucket order. */
export const SUCCESS_FIXTURE = "success-100.json"
export const ALREADY_USED_FIXTURE = "already-used-h304.json"
export const INVALID_COUPON_FIXTURE = "invalid-coupon-h306.json"

/**
 * Every fixture Mock_Mode may serve. The pre-flight check requires all three,
 * because selection can land on any of them for a caller-chosen pair.
 */
export const MOCK_FIXTURE_NAMES = [
  SUCCESS_FIXTURE,
  ALREADY_USED_FIXTURE,
  INVALID_COUPON_FIXTURE,
] as const

export type MockFixtureName = (typeof MOCK_FIXTURE_NAMES)[number]

/** Fixture directory, relative to the repository root. */
export const FIXTURE_DIR_RELATIVE = join("fixtures", "upstream")

/** Number of selection buckets (Requirement 7.3 weighting). */
export const FIXTURE_BUCKET_COUNT = 16

/** HTTP status Mock_Mode reports; the fixtures model 200 responses. */
const MOCK_STATUS = 200

/** FNV-1a 32-bit parameters, per the published specification. */
const FNV_OFFSET_BASIS_32 = 0x811c9dc5
const FNV_PRIME_32 = 0x01000193

/** How far up the directory tree the default resolution looks. */
const MAX_ROOT_SEARCH_DEPTH = 8

/**
 * FNV-1a 32-bit over the UTF-8 bytes of `input`, returned as an unsigned
 * 32-bit integer.
 *
 * Implemented inline rather than taken from a dependency: the algorithm is a few
 * lines and fully specified, so the fixture mapping is reproducible across
 * machines, Node versions, and installs. Exported so a test can pin known
 * digests and so Property 21 can reason about selection directly.
 */
export function fnv1a32(input: string): number {
  const bytes = new TextEncoder().encode(input)
  let hash = FNV_OFFSET_BASIS_32
  for (const byte of bytes) {
    hash ^= byte
    // Math.imul keeps the multiply in 32-bit space; float multiplication would
    // lose low bits above 2^53 and break reproducibility.
    hash = Math.imul(hash, FNV_PRIME_32) >>> 0
  }
  return hash >>> 0
}

/**
 * The selection key of a pair: the Coupon_Code and the Hive_ID joined by NUL.
 *
 * NUL is used as the separator because neither value can contain it (both are
 * trimmed, validated strings), so distinct pairs cannot collide by producing the
 * same key.
 */
export function fixtureSelectionKey(
  couponCode: string,
  hiveId: string
): string {
  return `${couponCode}\u0000${hiveId}`
}

/** Bucket of a pair: `fnv1a32(key) % 16`. */
export function fixtureBucket(couponCode: string, hiveId: string): number {
  return fnv1a32(fixtureSelectionKey(couponCode, hiveId)) % FIXTURE_BUCKET_COUNT
}

/**
 * The fixture a pair of Coupon_Code and Hive_ID selects (Requirement 7.3).
 *
 * Buckets 0–9 → `success-100.json`, 10–14 → `already-used-h304.json`, 15 →
 * `invalid-coupon-h306.json`. `INVALID_COUPON` is deliberately rare because it
 * triggers the early stop of Requirement 5; a uniform split would truncate most
 * mock runs after the first Group_Member.
 *
 * A pure function of the pair — no clock, no counter, no randomness — so a
 * repeated pair selects the same fixture across calls, across fresh client
 * instances, and across processes.
 *
 * Note for test authors: because the FNV prime is odd, the lowest bit of the
 * digest is a linear function of the input bytes (basis bit XOR the low bits of
 * every byte), so a generator that holds that parity fixed — for example the
 * pairs `("C1", "H1")`, `("C2", "H2")`, … — reaches only the even buckets and
 * never selects `invalid-coupon-h306.json`. Vary the two values independently
 * when a test needs all three fixtures to appear.
 */
export function selectFixtureName(
  couponCode: string,
  hiveId: string
): MockFixtureName {
  const bucket = fixtureBucket(couponCode, hiveId)
  if (bucket <= 9) return SUCCESS_FIXTURE
  if (bucket <= 14) return ALREADY_USED_FIXTURE
  return INVALID_COUPON_FIXTURE
}

/** Why a fixture cannot be served, in the words of Requirement 7.6. */
export type FixtureUnavailableReason = "absent" | "invalid-json"

/**
 * Raised when the fixture Mock_Mode needs is absent or is not valid JSON.
 *
 * Carries the fixture name, the absolute path, and the reason, so the caller can
 * build the rejection without re-deriving any of it. `code` matches the
 * {@link AppErrorCode} the failure envelope uses.
 */
export class FixtureUnavailableError extends Error {
  readonly code: Extract<AppErrorCode, "FIXTURE_UNAVAILABLE"> =
    "FIXTURE_UNAVAILABLE"

  constructor(
    readonly fixtureName: string,
    readonly fixturePath: string,
    readonly reason: FixtureUnavailableReason,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = "FixtureUnavailableError"
  }
}

/** The message of a FIXTURE_UNAVAILABLE failure: names the fixture and the reason. */
export function fixtureUnavailableMessage(
  fixtureName: string,
  fixturePath: string,
  reason: FixtureUnavailableReason,
  detail?: string
): string {
  const condition = reason === "absent" ? "is absent" : "is not valid JSON"
  const because = detail === undefined ? "" : ` (${detail})`
  return (
    `Mock_Mode response fixture ${fixtureName} ${condition}${because}: ` +
    `${fixturePath}. No Member_Outcome is derived, no request is sent to the ` +
    `Upstream_API, and no Redemption_History record is appended.`
  )
}

/**
 * Result of the pre-flight fixture check. On failure it carries everything the
 * `run-failed` event needs, already worded (Requirements 7.6, 7.10).
 */
export type MockFixtureCheck =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly code: Extract<AppErrorCode, "FIXTURE_UNAVAILABLE">
      readonly fixtureName: string
      readonly fixturePath: string
      readonly reason: FixtureUnavailableReason
      readonly message: string
    }

export interface MockUpstreamClientOptions {
  /**
   * Directory holding the three fixtures. Defaults to
   * {@link resolveDefaultFixtureDir}. Application wiring may pass an absolute
   * path; tests pass a temporary directory so a fixture can be deleted or
   * corrupted between calls.
   */
  readonly fixtureDir?: string
}

/**
 * Per-process cache of usable fixture bodies, keyed by absolute file path
 * (Requirement 7.3). Module-level, so two client instances built for the same
 * directory share it, which is what makes a repeated pair cheap.
 */
const fixtureCache = new Map<string, string>()

/** Memoized default fixture directory; see {@link resolveDefaultFixtureDir}. */
let defaultFixtureDir: string | null = null

function moduleAncestorDirs(): string[] {
  const dirs: string[] = []
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < MAX_ROOT_SEARCH_DEPTH; depth += 1) {
    dirs.push(dir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dirs
}

/**
 * Finds `fixtures/upstream` by walking up from this module and then trying the
 * working directory. Handles both layouts that matter: running from `src/` under
 * Vitest, and running from `dist/` in the built server. The result is memoized;
 * {@link clearFixtureCache} resets it.
 *
 * Falls back to `<cwd>/fixtures/upstream` when nothing is found, so the failure
 * surfaces as a FIXTURE_UNAVAILABLE naming a concrete path rather than as an
 * unrelated resolution error.
 */
export function resolveDefaultFixtureDir(): string {
  if (defaultFixtureDir !== null) {
    return defaultFixtureDir
  }
  const roots = [...moduleAncestorDirs(), process.cwd()]
  const found = roots
    .map((root) => join(root, FIXTURE_DIR_RELATIVE))
    .find((candidate) => existsSync(candidate))

  defaultFixtureDir = found ?? resolve(process.cwd(), FIXTURE_DIR_RELATIVE)
  return defaultFixtureDir
}

/**
 * Test seam: drops cached fixture bodies so the next read hits the filesystem.
 *
 * Called with a path, it forgets that one file; called with no argument, it
 * forgets every file *and* the memoized default directory. Unit tests use it to
 * delete or corrupt a fixture between calls and observe the failure
 * (task 7.6).
 */
export function clearFixtureCache(filePath?: string): void {
  if (filePath === undefined) {
    fixtureCache.clear()
    defaultFixtureDir = null
    return
  }
  fixtureCache.delete(filePath)
}

/** Paths currently cached. Exposed for assertions about the cache seam. */
export function cachedFixturePaths(): readonly string[] {
  return [...fixtureCache.keys()]
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  )
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Reads one fixture, validating that it parses as JSON, and returns its **raw
 * text unchanged**.
 *
 * The text is returned verbatim rather than re-serialized from the parsed value,
 * so the Response_Parser sees byte-identical input in Mock_Mode and in live
 * mode. `JSON.parse` runs only as the validity check Requirement 7.6 demands;
 * its result is discarded.
 */
async function readFixture(
  fixtureName: string,
  fixturePath: string
): Promise<string> {
  const cached = fixtureCache.get(fixturePath)
  if (cached !== undefined) {
    return cached
  }

  let text: string
  try {
    text = await readFile(fixturePath, "utf8")
  } catch (error) {
    /*
     * ENOENT is plainly "absent". Any other read failure — a permission denial,
     * a directory where a file belongs — is reported as absent too, with the OS
     * error quoted in the message: Requirement 7.6 names two conditions, and an
     * unreadable fixture is indistinguishable from a missing one as far as
     * Mock_Mode is concerned.
     */
    const detail = isErrnoCode(error, "ENOENT")
      ? undefined
      : `unreadable: ${errorDetail(error)}`
    throw new FixtureUnavailableError(
      fixtureName,
      fixturePath,
      "absent",
      fixtureUnavailableMessage(fixtureName, fixturePath, "absent", detail),
      { cause: error }
    )
  }

  try {
    JSON.parse(text)
  } catch (error) {
    throw new FixtureUnavailableError(
      fixtureName,
      fixturePath,
      "invalid-json",
      fixtureUnavailableMessage(
        fixtureName,
        fixturePath,
        "invalid-json",
        errorDetail(error)
      ),
      { cause: error }
    )
  }

  // Only a usable fixture is remembered, so a corrupt one stays a failure and a
  // repaired one recovers without a restart.
  fixtureCache.set(fixturePath, text)
  return text
}

/**
 * Verifies that all three fixtures are present and parseable, reporting the
 * first failure with the fixture name and whether it is absent or invalid JSON.
 *
 * This is the Mock_Mode pre-flight of task 10.2: `runRedemption` calls it before
 * acquiring the run lock, so an unusable fixture ends the request with a single
 * `run-failed` event, zero Upstream_API requests, no derived Member_Outcome, and
 * no Redemption_History record (Requirements 7.6, 7.10).
 *
 * It shares the cache with {@link MockUpstreamClient.useCoupon}, so a passing
 * pre-flight also warms every fixture the run will need.
 */
export async function checkMockFixtures(
  options: MockUpstreamClientOptions = {}
): Promise<MockFixtureCheck> {
  const fixtureDir = options.fixtureDir ?? resolveDefaultFixtureDir()

  for (const fixtureName of MOCK_FIXTURE_NAMES) {
    try {
      await readFixture(fixtureName, join(fixtureDir, fixtureName))
    } catch (error) {
      if (error instanceof FixtureUnavailableError) {
        return {
          ok: false,
          code: error.code,
          fixtureName: error.fixtureName,
          fixturePath: error.fixturePath,
          reason: error.reason,
          message: error.message,
        }
      }
      throw error
    }
  }

  return { ok: true }
}

/**
 * The Mock_Mode {@link UpstreamClient}. Serves fixture bytes; issues no network
 * request of any kind (Requirement 7.3).
 */
export class MockUpstreamClient implements UpstreamClient {
  readonly isMock = true

  /** Absolute or relative directory the three fixtures are read from. */
  readonly fixtureDir: string

  constructor(options: MockUpstreamClientOptions = {}) {
    this.fixtureDir = options.fixtureDir ?? resolveDefaultFixtureDir()
  }

  /** Absolute path this client reads `fixtureName` from. */
  fixturePath(fixtureName: string): string {
    return join(this.fixtureDir, fixtureName)
  }

  /** The fixture this client selects for a pair, without reading it. */
  selectFixture(req: UseCouponRequest): MockFixtureName {
    return selectFixtureName(req.coupon, req.hiveid)
  }

  /** {@link checkMockFixtures} bound to this client's fixture directory. */
  checkFixtures(): Promise<MockFixtureCheck> {
    return checkMockFixtures({ fixtureDir: this.fixtureDir })
  }

  /**
   * Serves the fixture selected by the pair.
   *
   * Resolves with the fixture's raw bytes as `bodyText`, `status: 200`, and no
   * `transportFailure`, so the Response_Parser is handed exactly what live mode
   * would hand it.
   *
   * **Rejects** with a {@link FixtureUnavailableError} when the selected fixture
   * is absent or unparseable. Nothing else in this method can reject, and the
   * rejection happens before any Member_Outcome exists (Requirements 7.6, 7.10).
   */
  async useCoupon(req: UseCouponRequest): Promise<UpstreamRawResponse> {
    const fixtureName = this.selectFixture(req)
    const bodyText = await readFixture(
      fixtureName,
      this.fixturePath(fixtureName)
    )

    return { bodyText, status: MOCK_STATUS, transportFailure: null }
  }
}

/** Creates a Mock_Mode client. Used by the client factory of task 7.7. */
export function createMockUpstreamClient(
  options: MockUpstreamClientOptions = {}
): MockUpstreamClient {
  return new MockUpstreamClient(options)
}
