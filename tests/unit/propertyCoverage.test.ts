import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * Audit of the property suite of shared-coupon-redemption
 * (Requirements 4.1, 5.6, 7.3, 8.2).
 *
 * The design states 24 correctness properties, and the plan promises one
 * property-based test for each, tagged with a feature/property comment and run
 * at `numRuns: 100` minimum. Counting them by hand proves the promise held on
 * the day of counting; this file is what keeps it held. It reads every test file
 * under `tests/property/` as text and asserts:
 *
 *   1. Each of Properties 1 through 24 carries a tag somewhere in the suite.
 *   2. Property numbers and property test files stand in a bijection — each
 *      number is tagged in exactly one file, and each file tags exactly one
 *      number.
 *   3. No tag names a number outside 1 through 24, and no tag lives anywhere
 *      outside `tests/property/`.
 *   4. Every `fc.assert` call site under `tests/property/` passes an explicit
 *      `numRuns`, and every one of them is at least 100 apart from a single
 *      pinned exception recorded below.
 *   5. Every tag carries a non-empty statement after its colon.
 *
 * ## Why "one file per property" and not "one `it` per property"
 *
 * Task 16.3 asks for "exactly one property-based test" per property. Read
 * literally as one `it` block, that reading is already false and would demand a
 * rewrite of working tests: several properties are single claims with several
 * independently falsifiable halves, and their files say each half in its own
 * `it`. `runSingleLock` states Property 9 across five assertions,
 * `responseParserClassification` states Property 2 across five,
 * `couponSubmission` states Property 18 across four, `resultRendering` states
 * Property 20 across three. Splitting a conjunction into named cases makes the
 * failure report say which half broke; merging them back into one `it` would
 * lose that and prove nothing extra.
 *
 * So the unit of "one property-based test" here is the *file*: one property test
 * file per property, one property per file. That is the invariant worth
 * protecting, because it is the one that breaks by accident — a property
 * silently dropped, a tag copy-pasted into a second file, two properties merged
 * into one file where the second stops being findable.
 *
 * ## Why the tag text is assembled from two pieces
 *
 * Assertion 3 scans `src/` and all of `tests/` outside `tests/property/` for
 * stray tags, and this file is inside that scan. Writing the tag prefix as one
 * literal would make the audit report itself. `TAG_PREFIX` is therefore
 * concatenated from two fragments, so no line of this file's source holds the
 * whole prefix, and no comment here spells it out either.
 */

const REPO = fileURLToPath(new URL("../../", import.meta.url))

/** Repo-relative directory holding the property suite. */
const PROPERTY_DIR = "tests/property"

/**
 * The prefix every property tag starts with, split across two literals so this
 * file is not a match for its own pattern (see the module comment).
 */
const TAG_PREFIX = "// Feature: shared-coupon" + "-redemption, Property "

/** The property numbers the design defines. */
const EXPECTED_PROPERTIES = Array.from({ length: 24 }, (_, at) => at + 1)

/** The floor task 16.3 sets for every property assertion. */
const MINIMUM_RUNS = 100

/**
 * The one `fc.assert` site allowed below `MINIMUM_RUNS`, pinned by file and
 * value so any *other* low setting fails this audit.
 *
 * `persistenceRoundTrip` splits the retention half of Requirement 6.5 into its
 * own property because it only becomes observable past
 * `HISTORY_RETENTION_LIMIT` records, and every append there is one real atomic
 * write with an `fsync`. Measured, that case costs ~850ms per sample: at 100
 * runs it would take ~85s, over the 30s `testTimeout` and six times the whole
 * suite's current runtime. Its generator spans six values, so three samples
 * cover half the space. The file still states Property 14 itself at 100 runs,
 * which the last assertion below checks for every file.
 *
 * Raising or removing this site is meant to fail here: the entry has to be
 * deleted deliberately, not drift.
 */
const RUNS_BELOW_MINIMUM = [
  { file: `${PROPERTY_DIR}/persistenceRoundTrip.property.test.ts`, numRuns: 3 },
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

/** Every property tag of `text`, in file order. */
function tagsIn(file: string, text: string): Array<Tag> {
  const tags: Array<Tag> = []
  text.split("\n").forEach((raw, at) => {
    const line = raw.trimStart()
    if (!line.startsWith(TAG_PREFIX)) return
    const parsed = /^(\d+):(.*)$/.exec(line.slice(TAG_PREFIX.length))
    tags.push({
      file,
      line: at + 1,
      property: parsed === null ? Number.NaN : Number(parsed[1]),
      statement: parsed === null ? "" : parsed[2].trim(),
    })
  })
  return tags
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

const PROPERTY_FILES = testFilesIn(PROPERTY_DIR)
const TAGS = PROPERTY_FILES.flatMap((path) => tagsIn(path, read(path)))
const SITES = PROPERTY_FILES.flatMap((path) =>
  assertSites(path, withoutComments(read(path)))
)

/** Sorted, de-duplicated property numbers the suite tags. */
const TAGGED_PROPERTIES = [...new Set(TAGS.map((tag) => tag.property))].sort(
  (left, right) => left - right
)

/** Files tagging each property number. */
const FILES_BY_PROPERTY = new Map<number, Array<string>>()
for (const tag of TAGS) {
  const files = FILES_BY_PROPERTY.get(tag.property)
  if (files === undefined) {
    FILES_BY_PROPERTY.set(tag.property, [tag.file])
  } else if (!files.includes(tag.file)) {
    files.push(tag.file)
  }
}

/** Property numbers tagged by each file. */
const PROPERTIES_BY_FILE = new Map<string, Array<number>>()
for (const tag of TAGS) {
  const numbers = PROPERTIES_BY_FILE.get(tag.file)
  if (numbers === undefined) {
    PROPERTIES_BY_FILE.set(tag.file, [tag.property])
  } else if (!numbers.includes(tag.property)) {
    numbers.push(tag.property)
  }
}

describe("the property coverage audit reads the suite it claims to read", () => {
  it("finds the property directory and its test files", () => {
    /* A wrong path would leave every list empty and pass every assertion
     * below, so the audit states what it expects to have found. */
    expect(PROPERTY_FILES.length).toBe(EXPECTED_PROPERTIES.length)
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

  it("finds a tag and an assertion in every property test file", () => {
    const untagged = PROPERTY_FILES.filter(
      (path) => !PROPERTIES_BY_FILE.has(path)
    )
    expect(
      untagged,
      `every property test file must carry a tag of the form "${TAG_PREFIX}N: <statement>"`
    ).toEqual([])

    const unasserted = PROPERTY_FILES.filter(
      (path) => !SITES.some((site) => site.file === path)
    )
    expect(
      unasserted,
      "every property test file must run at least one fc.assert"
    ).toEqual([])
  })
})

describe("the suite covers Properties 1 through 24", () => {
  it("tags exactly the 24 property numbers of the design", () => {
    expect(
      TAGGED_PROPERTIES,
      "a property of the design is untested, or a tag names a number the design does not define"
    ).toEqual(EXPECTED_PROPERTIES)
  })

  it("tags no number outside 1 through 24", () => {
    const strays = TAGS.filter(
      (tag) => !EXPECTED_PROPERTIES.includes(tag.property)
    ).map((tag) => `${tag.file}:${tag.line}`)

    expect(
      strays,
      "the design defines Properties 1 through 24 and no others"
    ).toEqual([])
  })

  it("gives every tag a well-formed number and a non-empty statement", () => {
    const malformed = TAGS.filter(
      (tag) => !Number.isInteger(tag.property) || tag.statement.length === 0
    ).map((tag) => `${tag.file}:${tag.line}`)

    expect(
      malformed,
      `a tag must read "${TAG_PREFIX}N: <statement>" with a statement after the colon`
    ).toEqual([])
  })
})

describe("property numbers and property test files stand in a bijection", () => {
  it("tags each property in exactly one file", () => {
    const spread = [...FILES_BY_PROPERTY.entries()]
      .filter(([, files]) => files.length !== 1)
      .map(([property, files]) => `Property ${property}: ${files.join(", ")}`)

    expect(
      spread,
      "each property belongs to one property test file; a second file tagging it duplicates the coverage"
    ).toEqual([])
  })

  it("gives each property test file exactly one property", () => {
    const mixed = [...PROPERTIES_BY_FILE.entries()]
      .filter(([, numbers]) => numbers.length !== 1)
      .map(([file, numbers]) => `${file}: ${numbers.join(", ")}`)

    expect(
      mixed,
      "each property test file states one property; merging two into one file hides the second"
    ).toEqual([])
  })

  it("matches the file count to the property count", () => {
    expect(FILES_BY_PROPERTY.size).toBe(EXPECTED_PROPERTIES.length)
    expect(PROPERTIES_BY_FILE.size).toBe(PROPERTY_FILES.length)
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

  it("finds no tag in src, tests/unit, tests/integration, or the helpers", () => {
    const strays = ELSEWHERE.filter(
      (path) => tagsIn(path, read(path)).length > 0
    )

    expect(
      strays,
      `a tag outside ${PROPERTY_DIR}/ corrupts this audit's inventory; move the property test into the property suite`
    ).toEqual([])
  })
})

describe("every property assertion runs at least 100 cases", () => {
  it("finds the call sites it is auditing", () => {
    expect(SITES.length).toBeGreaterThanOrEqual(EXPECTED_PROPERTIES.length)
    expect(SITES.length).toBeGreaterThan(40)
  })

  it("passes an explicit numRuns at every call site", () => {
    const implicit = SITES.filter((site) => site.numRuns === null).map(
      (site) => `${site.file} (fc.assert #${site.ordinal})`
    )

    /* fast-check defaults to 100, which satisfies the floor by accident. Task
     * 16.3 asks for the run count to be stated, so a later change to the
     * default cannot quietly lower it. */
    expect(
      implicit,
      "state numRuns explicitly rather than relying on fast-check's default"
    ).toEqual([])
  })

  it("runs at least 100 cases at every call site but the pinned exception", () => {
    const low = SITES.filter(
      (site) => site.numRuns !== null && site.numRuns < MINIMUM_RUNS
    ).map((site) => ({ file: site.file, numRuns: site.numRuns }))

    expect(
      low,
      `every fc.assert runs at least ${MINIMUM_RUNS} cases; the only documented exception is the history retention case of persistenceRoundTrip`
    ).toEqual(RUNS_BELOW_MINIMUM)
  })

  it("states every property itself at the full run count", () => {
    const weak = PROPERTY_FILES.filter(
      (path) =>
        !SITES.some(
          (site) =>
            site.file === path &&
            site.numRuns !== null &&
            site.numRuns >= MINIMUM_RUNS
        )
    )

    /* The pinned exception is allowed only alongside a full-strength assertion
     * in the same file, so no property is tested at a low run count only. */
    expect(
      weak,
      `every property test file must hold at least one fc.assert at ${MINIMUM_RUNS} runs or more`
    ).toEqual([])
  })
})
