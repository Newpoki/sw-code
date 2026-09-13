import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * Audit of the property suite, across every feature that owns part of it.
 *
 * Two designs state correctness properties and promise one property-based test
 * for each, tagged with a feature/property comment and run at `numRuns: 100`
 * minimum: `shared-coupon-redemption` states 24 (Requirements 4.1, 5.6, 7.3,
 * 8.2 of that spec) and `mongodb-google-auth-admin` states 20. Counting them by
 * hand proves the promise held on the day of counting; this file is what keeps
 * it held. It reads every test file under `tests/property/` as text once,
 * partitions those files by the feature tag they carry, and asserts per feature:
 *
 *   1. Property numbers and property test files stand in a bijection — each
 *      number is tagged in at most one file, and each file tags exactly one
 *      number.
 *   2. No tag names a number the feature's design does not define, and no tag
 *      lives anywhere outside `tests/property/`.
 *   3. Every `fc.assert` call site passes an explicit `numRuns`, and every one
 *      of them is at least 100 apart from the pinned exceptions recorded below.
 *   4. Every tag carries a non-empty statement after its colon.
 *   5. Every property the feature defines is tagged somewhere in the suite —
 *      the completeness half, switched on per feature by `requireAllPresent`.
 *
 * Completeness is on for both features: `shared-coupon-redemption`, whose 24
 * files all exist, and `mongodb-google-auth-admin`, whose 20 files landed one
 * task at a time until task 22.1 of that plan switched the check on once the
 * twentieth arrived. Everything
 * else applies to both features from the first file onward, so a duplicated
 * tag, an untagged file, a stray number, or a quiet run count fails here
 * immediately rather than at the end of the plan.
 *
 * ## Why "one file per property" and not "one `it` per property"
 *
 * Task 16.3 of `shared-coupon-redemption` asks for "exactly one property-based
 * test" per property. Read literally as one `it` block, that reading is already
 * false and would demand a rewrite of working tests: several properties are
 * single claims with several independently falsifiable halves, and their files
 * say each half in its own `it`. `runSingleLock` states Property 9 across five
 * assertions, `responseParserClassification` states Property 2 across five,
 * `couponSubmission` states Property 18 across four, `resultRendering` states
 * Property 20 across three. Splitting a conjunction into named cases makes the
 * failure report say which half broke; merging them back into one `it` would
 * lose that and prove nothing extra.
 *
 * So the unit of "one property-based test" here is the *file*: one property test
 * file per property, one property per file, one feature per file. That is the
 * invariant worth protecting, because it is the one that breaks by accident — a
 * property silently dropped, a tag copy-pasted into a second file, two
 * properties merged into one file where the second stops being findable.
 *
 * ## Why each tag text is assembled from two pieces
 *
 * The stray-tag assertion scans `src/` and all of `tests/` outside
 * `tests/property/`, and this file is inside that scan. Writing a feature name
 * as one literal would make the audit report itself. Each name is therefore
 * concatenated from two fragments, so no line of this file's source holds a
 * whole tag prefix, and no comment here spells one out either.
 */

const REPO = fileURLToPath(new URL("../../", import.meta.url))

/** Repo-relative directory holding the property suite. */
const PROPERTY_DIR = "tests/property"

/** The floor both plans set for every property assertion. */
const MINIMUM_RUNS = 100

/** `[1, 2, ... count]`, the property numbers a design of `count` defines. */
function propertyNumbers(count: number): Array<number> {
  return Array.from({ length: count }, (_, at) => at + 1)
}

/**
 * One feature owning part of the property suite.
 */
interface Feature {
  /** The feature name as it appears in a tag. */
  readonly name: string
  /** The property numbers the feature's design defines. */
  readonly expected: ReadonlyArray<number>
  /**
   * Whether every one of `expected` must already be tagged. Off while a
   * feature's property files are still landing, which leaves the bijection, the
   * run-count rule, and the stray checks in force over the files that exist.
   */
  readonly requireAllPresent: boolean
}

/**
 * The features this audit knows, each name split across two literals so this
 * file is not a match for its own pattern (see the module comment).
 */
const FEATURES: ReadonlyArray<Feature> = [
  {
    name: "shared-coupon" + "-redemption",
    expected: propertyNumbers(24),
    requireAllPresent: true,
  },
  {
    name: "mongodb-google" + "-auth-admin",
    expected: propertyNumbers(20),
    /* Switched on by task 22.1: all 20 property files now exist, so the
     * completeness check is enforced here alongside the other invariants. */
    requireAllPresent: true,
  },
]

/** The prefix a tag of `feature` starts with. */
function tagPrefix(feature: string): string {
  return `// Feature: ${feature}, Property `
}

/**
 * The `fc.assert` sites allowed below `MINIMUM_RUNS`, pinned by file and value
 * so any *other* low setting fails this audit.
 *
 * `persistenceRoundTrip` used to be the first entry, at `numRuns: 3`: its
 * retention half only becomes observable past `HISTORY_RETENTION_LIMIT` records,
 * and every append was one real atomic write with an `fsync`, measured at ~850ms
 * per sample. Task 11.3 of `mongodb-google-auth-admin` moved that file onto the
 * in-memory Mongo_Store, where 200+ appends cost no round trip and no `fsync`;
 * both of its properties now run at the full count in well under a second, so
 * the entry was deleted rather than raised.
 *
 * `historyAppendSequence` is the one remaining entry, added by task 9.2 of
 * `mongodb-google-auth-admin` for the same reason one window further out: its
 * over-the-retention-window assertion crosses 200 records over a real database,
 * and each of those appends is a counter round trip, an insert, a count, and —
 * past the window — a find and a delete, so one sample is 200+ round trips
 * rather than 200+ writes to a local file. Its generator spans three values.
 * That file states Property 8 itself at the full run count over short
 * sequences, which the last assertion per feature below checks for every file.
 *
 * Raising or removing an entry is meant to fail here: it has to be deleted
 * deliberately, not drift.
 */
const RUNS_BELOW_MINIMUM: ReadonlyArray<{ file: string; numRuns: number }> = [
  {
    file: `${PROPERTY_DIR}/historyAppendSequence.property.test.ts`,
    numRuns: 3,
  },
]

/** Contents of one repo-relative file. */
function read(path: string): string {
  return readFileSync(join(REPO, path), "utf8")
}

/**
 * `text` with block comments and whole-line `//` comments removed, so prose that
 * *mentions* `fc.assert` or `numRuns` — several property files explain their run
 * counts at length — does not read as a call site.
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}

/** Every `.ts`/`.tsx` file under `dir`, recursively, as repo-relative paths. */
function sourceFilesUnder(dir: string): Array<string> {
  const found: Array<string> = []
  for (const entry of readdirSync(join(REPO, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      found.push(...sourceFilesUnder(path))
    } else if (/\.tsx?$/.test(entry.name)) {
      found.push(path)
    }
  }
  return found
}

/**
 * The test files of `dir`, which excludes `generators.ts` and `.gitkeep`: the
 * shared generators module carries no property and runs no assertion.
 */
function testFilesIn(dir: string): Array<string> {
  return readdirSync(join(REPO, dir))
    .filter((name) => /\.test\.tsx?$/.test(name))
    .map((name) => `${dir}/${name}`)
    .sort()
}

interface Tag {
  readonly file: string
  readonly line: number
  /** `NaN` when the text after the prefix is not `<digits>:`. */
  readonly property: number
  readonly statement: string
}

/** Every tag of `feature` in `text`, in file order. */
function tagsIn(file: string, text: string, feature: string): Array<Tag> {
  const prefix = tagPrefix(feature)
  const tags: Array<Tag> = []
  text.split("\n").forEach((raw, at) => {
    const line = raw.trimStart()
    if (!line.startsWith(prefix)) return
    const parsed = /^(\d+):(.*)$/.exec(line.slice(prefix.length))
    tags.push({
      file,
      line: at + 1,
      property: parsed === null ? Number.NaN : Number(parsed[1]),
      statement: parsed === null ? "" : parsed[2].trim(),
    })
  })
  return tags
}

/** Every tag of any known feature in `text`. */
function anyTagsIn(file: string, text: string): Array<Tag> {
  return FEATURES.flatMap((feature) => tagsIn(file, text, feature.name))
}

interface AssertSite {
  readonly file: string
  /** 1-based position of the call site within its file. */
  readonly ordinal: number
  /** `null` when the call passes no `numRuns` option. */
  readonly numRuns: number | null
}

/**
 * Every `fc.assert` call site of `source`, with the `numRuns` it configures.
 *
 * The option is found by looking between one call site and the next rather than
 * by matching parentheses: a `numRuns` always belongs to the nearest `fc.assert`
 * before it, and paren balancing would have to understand string literals to be
 * correct. A site whose window holds no option reads as `null`, which is a
 * failure below.
 */
function assertSites(file: string, source: string): Array<AssertSite> {
  const starts: Array<number> = []
  for (
    let at = source.indexOf("fc.assert(");
    at !== -1;
    at = source.indexOf("fc.assert(", at + 1)
  ) {
    starts.push(at)
  }

  return starts.map((start, at) => {
    const end = at + 1 < starts.length ? starts[at + 1] : source.length
    const option = /numRuns:\s*(\d+)/.exec(source.slice(start, end))
    return {
      file,
      ordinal: at + 1,
      numRuns: option === null ? null : Number(option[1]),
    }
  })
}

/* The suite is read once here; every assertion below works off these three. */
const PROPERTY_FILES = testFilesIn(PROPERTY_DIR)
const SOURCE = new Map(PROPERTY_FILES.map((path) => [path, read(path)]))
const SITES = PROPERTY_FILES.flatMap((path) =>
  assertSites(path, withoutComments(SOURCE.get(path) ?? ""))
)

/** The share of the suite one feature owns. */
interface Partition {
  readonly feature: Feature
  readonly tags: ReadonlyArray<Tag>
  /** The feature's property test files, sorted. */
  readonly files: ReadonlyArray<string>
  readonly sites: ReadonlyArray<AssertSite>
  /** Sorted, de-duplicated property numbers the feature tags. */
  readonly tagged: ReadonlyArray<number>
  /** Files tagging each property number of the feature. */
  readonly filesByProperty: ReadonlyMap<number, ReadonlyArray<string>>
  /** Property numbers of the feature tagged by each file. */
  readonly propertiesByFile: ReadonlyMap<string, ReadonlyArray<number>>
  /** The pinned low-run sites belonging to the feature's files. */
  readonly pinnedLowRuns: ReadonlyArray<{ file: string; numRuns: number }>
}

/** Partitions the already-read suite by the tag `feature` carries. */
function partition(feature: Feature): Partition {
  const tags = PROPERTY_FILES.flatMap((path) =>
    tagsIn(path, SOURCE.get(path) ?? "", feature.name)
  )
  const files = [...new Set(tags.map((tag) => tag.file))].sort()

  const filesByProperty = new Map<number, Array<string>>()
  const propertiesByFile = new Map<string, Array<number>>()
  for (const tag of tags) {
    const tagging = filesByProperty.get(tag.property)
    if (tagging === undefined) {
      filesByProperty.set(tag.property, [tag.file])
    } else if (!tagging.includes(tag.file)) {
      tagging.push(tag.file)
    }

    const numbers = propertiesByFile.get(tag.file)
    if (numbers === undefined) {
      propertiesByFile.set(tag.file, [tag.property])
    } else if (!numbers.includes(tag.property)) {
      numbers.push(tag.property)
    }
  }

  return {
    feature,
    tags,
    files,
    sites: SITES.filter((site) => files.includes(site.file)),
    tagged: [...new Set(tags.map((tag) => tag.property))].sort(
      (left, right) => left - right
    ),
    filesByProperty,
    propertiesByFile,
    pinnedLowRuns: RUNS_BELOW_MINIMUM.filter((pinned) =>
      files.includes(pinned.file)
    ),
  }
}

const PARTITIONS = FEATURES.map(partition)

/** `entries` in a stable order, so a pinned comparison is order-free. */
function byFile(
  entries: ReadonlyArray<{ file: string; numRuns: number | null }>
): Array<{ file: string; numRuns: number | null }> {
  return [...entries].sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      (left.numRuns ?? 0) - (right.numRuns ?? 0)
  )
}

describe("the property coverage audit reads the suite it claims to read", () => {
  it("finds the property directory and its test files", () => {
    /* A wrong path would leave every list empty and pass every assertion
     * below, so the audit states what it expects to have found. */
    expect(PROPERTY_FILES.length).toBeGreaterThanOrEqual(24)
    expect(PROPERTY_FILES).toContain(
      `${PROPERTY_DIR}/responseParser.property.test.ts`
    )
    expect(PROPERTY_FILES).toContain(
      `${PROPERTY_DIR}/resultRendering.property.test.tsx`
    )
    expect(PROPERTY_FILES).toContain(
      `${PROPERTY_DIR}/accessGate.property.test.ts`
    )
  })

  it("excludes the shared generators module", () => {
    expect(PROPERTY_FILES).not.toContain(`${PROPERTY_DIR}/generators.ts`)
  })

  it("finds a tag of exactly one known feature in every property test file", () => {
    const claims = PROPERTY_FILES.map((path) => ({
      file: path,
      features: PARTITIONS.filter((share) => share.files.includes(path)).map(
        (share) => share.feature.name
      ),
    }))

    const untagged = claims
      .filter((claim) => claim.features.length === 0)
      .map((claim) => claim.file)
    expect(
      untagged,
      "every property test file must carry a tag naming one of the audited features and its property number"
    ).toEqual([])

    const shared = claims
      .filter((claim) => claim.features.length > 1)
      .map((claim) => `${claim.file}: ${claim.features.join(", ")}`)
    expect(
      shared,
      "a property test file belongs to one feature; two feature tags in one file make it count twice"
    ).toEqual([])
  })

  it("finds an assertion in every property test file", () => {
    const unasserted = PROPERTY_FILES.filter(
      (path) => !SITES.some((site) => site.file === path)
    )
    expect(
      unasserted,
      "every property test file must run at least one fc.assert"
    ).toEqual([])
  })

  it("partitions the suite without loss", () => {
    const partitioned = PARTITIONS.reduce(
      (total, share) => total + share.files.length,
      0
    )
    expect(partitioned).toBe(PROPERTY_FILES.length)
  })

  it("pins only exceptions that still exist", () => {
    const stale = RUNS_BELOW_MINIMUM.filter(
      (pinned) => !PROPERTY_FILES.includes(pinned.file)
    ).map((pinned) => pinned.file)

    expect(
      stale,
      "a pinned run-count exception names a file that is gone; delete the entry"
    ).toEqual([])
  })
})

for (const share of PARTITIONS) {
  const { feature } = share
  const last = feature.expected[feature.expected.length - 1]
  const prefix = tagPrefix(feature.name)

  describe(`${feature.name} covers Properties 1 through ${last}`, () => {
    it(`tags no number outside 1 through ${last}`, () => {
      const strays = share.tags
        .filter((tag) => !feature.expected.includes(tag.property))
        .map((tag) => `${tag.file}:${tag.line}`)

      expect(
        strays,
        `the design of ${feature.name} defines Properties 1 through ${last} and no others`
      ).toEqual([])
    })

    it("gives every tag a well-formed number and a non-empty statement", () => {
      const malformed = share.tags
        .filter(
          (tag) => !Number.isInteger(tag.property) || tag.statement.length === 0
        )
        .map((tag) => `${tag.file}:${tag.line}`)

      expect(
        malformed,
        `a tag must read "${prefix}N: <statement>" with a statement after the colon`
      ).toEqual([])
    })

    it.runIf(feature.requireAllPresent)(
      `tags all ${feature.expected.length} property numbers of the design`,
      () => {
        expect(
          share.tagged,
          "a property of the design is untested, or a tag names a number the design does not define"
        ).toEqual([...feature.expected])
        expect(share.files.length).toBe(feature.expected.length)
      }
    )
  })

  describe(`${feature.name} property numbers and files stand in a bijection`, () => {
    it("tags each property in at most one file", () => {
      const spread = [...share.filesByProperty.entries()]
        .filter(([, files]) => files.length !== 1)
        .map(([property, files]) => `Property ${property}: ${files.join(", ")}`)

      expect(
        spread,
        "each property belongs to one property test file; a second file tagging it duplicates the coverage"
      ).toEqual([])
    })

    it("gives each property test file exactly one property", () => {
      const mixed = [...share.propertiesByFile.entries()]
        .filter(([, numbers]) => numbers.length !== 1)
        .map(([file, numbers]) => `${file}: ${numbers.join(", ")}`)

      expect(
        mixed,
        "each property test file states one property; merging two into one file hides the second"
      ).toEqual([])
    })

    it("matches the file count to the count of tagged properties", () => {
      expect(share.filesByProperty.size).toBe(share.files.length)
      expect(share.propertiesByFile.size).toBe(share.files.length)
    })
  })

  describe(`every ${feature.name} property assertion runs at least ${MINIMUM_RUNS} cases`, () => {
    it("finds the call sites it is auditing", () => {
      expect(share.sites.length).toBeGreaterThanOrEqual(share.files.length)
    })

    it("passes an explicit numRuns at every call site", () => {
      const implicit = share.sites
        .filter((site) => site.numRuns === null)
        .map((site) => `${site.file} (fc.assert #${site.ordinal})`)

      /* fast-check defaults to 100, which satisfies the floor by accident. Both
       * plans ask for the run count to be stated, so a later change to the
       * default cannot quietly lower it. */
      expect(
        implicit,
        "state numRuns explicitly rather than relying on fast-check's default"
      ).toEqual([])
    })

    it("runs at least the floor at every call site but the pinned exceptions", () => {
      const low = share.sites
        .filter((site) => site.numRuns !== null && site.numRuns < MINIMUM_RUNS)
        .map((site) => ({ file: site.file, numRuns: site.numRuns }))

      expect(
        byFile(low),
        `every fc.assert runs at least ${MINIMUM_RUNS} cases; the only exceptions are the pinned ones documented in RUNS_BELOW_MINIMUM`
      ).toEqual(byFile(share.pinnedLowRuns))
    })

    it("states every property itself at the full run count", () => {
      const weak = share.files.filter(
        (path) =>
          !share.sites.some(
            (site) =>
              site.file === path &&
              site.numRuns !== null &&
              site.numRuns >= MINIMUM_RUNS
          )
      )

      /* A pinned exception is allowed only alongside a full-strength assertion
       * in the same file, so no property is tested at a low run count only. */
      expect(
        weak,
        `every property test file must hold at least one fc.assert at ${MINIMUM_RUNS} runs or more`
      ).toEqual([])
    })
  })
}

describe("shared-coupon" + "-redemption keeps its pinned inventory", () => {
  const share = PARTITIONS[0]

  it("still owns 24 files, one per property", () => {
    expect(share.feature.expected.length).toBe(24)
    expect(share.feature.requireAllPresent).toBe(true)
    expect(share.files.length).toBe(24)
  })

  it("still runs more than 40 assertions", () => {
    expect(share.sites.length).toBeGreaterThan(40)
  })

  it("allows no run-count exception at all", () => {
    /* The retention case of persistenceRoundTrip was the one exception. Task
     * 11.3 moved that file onto the in-memory store, which made its 200+ appends
     * cheap enough for the full run count, so this feature now runs every
     * assertion at the floor. */
    expect(
      share.pinnedLowRuns,
      "this feature has no documented run-count exception left"
    ).toEqual([])
  })
})

describe("no property tag lives outside the property suite", () => {
  const ELSEWHERE = [
    ...sourceFilesUnder("src").filter(
      (path) => path !== "src/routeTree.gen.ts"
    ),
    ...sourceFilesUnder("tests").filter(
      (path) => !path.startsWith(`${PROPERTY_DIR}/`)
    ),
  ]

  it("covers the files it claims to cover", () => {
    expect(ELSEWHERE.length).toBeGreaterThan(50)
    expect(ELSEWHERE).toContain("tests/unit/propertyCoverage.test.ts")
    expect(ELSEWHERE).toContain("tests/integration/accessGate.test.ts")
    expect(ELSEWHERE).toContain("src/domain/responseParser.ts")
  })

  it("finds no tag of either feature in src, tests/unit, tests/integration, or the helpers", () => {
    const strays = ELSEWHERE.filter(
      (path) => anyTagsIn(path, read(path)).length > 0
    )

    expect(
      strays,
      `a tag outside ${PROPERTY_DIR}/ corrupts this audit's inventory; move the property test into the property suite`
    ).toEqual([])
  })
})
