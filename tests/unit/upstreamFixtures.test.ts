import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import { parseUpstreamBody } from "@/domain/responseParser"
import { MEMBER_OUTCOME_VALUES } from "@/domain/types"

/**
 * Drift guard between the API_Reference_Document and the Mock_Mode fixtures
 * (Requirements 7.2, 7.3).
 *
 * `docs/upstream-api.md` is the single source of truth for the three documented
 * response bodies. Two things must stay true of it:
 *
 *   1. Each fixture under `fixtures/upstream/` is **byte-identical** to the
 *      fenced example of its section (Requirement 7.3 — Mock_Mode bodies are
 *      character-identical to the documented examples).
 *   2. The Member_Outcome the document states for an example equals what the
 *      Response_Parser actually derives from that example (Requirement 7.2).
 *
 * Both the outcome and the fixture path are read *out of the document*; nothing
 * about the mapping is hardcoded here. Editing a fenced block, a section
 * heading, the summary table, or a fixture without editing its counterpart
 * fails this test.
 *
 * ## Why no `.trim()`
 *
 * The comparison strips exactly one trailing `\r?\n` from the captured fenced
 * text — the newline that terminates the last content line before the closing
 * fence — and compares raw bytes with `Buffer.equals`. Trimming either side
 * would hide real drift: a fixture that gained a trailing newline or leading
 * whitespace would still "match" a fenced block that has neither, and Mock_Mode
 * would then serve bytes the document does not describe.
 */

const DOC_URL = new URL("../../docs/upstream-api.md", import.meta.url)
const doc = readFileSync(DOC_URL, "utf8")

/** A documented example, assembled entirely from the document itself. */
interface DocumentedExample {
  /** Outcome named by the `### ...` heading of the section. */
  readonly outcome: string
  /** Fixture path the section points at, e.g. `fixtures/upstream/success-100.json`. */
  readonly fixturePath: string
  /** Inner text of the fenced ```json block, with one trailing newline removed. */
  readonly exampleBody: string
}

/** One summary-table row: response code, Member_Outcome, fixture path. */
interface SummaryRow {
  readonly responseCode: string
  readonly outcome: string
  readonly fixturePath: string
}

const FENCED_JSON = /```json\r?\n([\s\S]*?)```/g
const FIXTURE_PATH = /fixtures\/upstream\/[A-Za-z0-9._-]+\.json/
const HEADING = /^###\s+(.*?)\s*$/

/** Strips the single newline that terminates the last line before a closing fence. */
function stripFenceTerminator(fenced: string): string {
  return fenced.replace(/\r?\n$/, "")
}

/** Removes surrounding backticks from an inline-code span such as `` `SUCCESS` ``. */
function unquoteInlineCode(value: string): string {
  return value.replace(/^`(.*)`$/, "$1")
}

/** Every `### ...` section of the document, keyed by its unquoted heading text. */
function sections(markdown: string): Map<string, string> {
  const lines = markdown.split("\n")
  const found = new Map<string, string>()
  let heading: string | null = null
  let body: string[] = []

  const flush = () => {
    if (heading !== null) {
      expect(
        found.has(heading),
        `docs/upstream-api.md has one '### ${heading}' section`
      ).toBe(false)
      found.set(heading, body.join("\n"))
    }
  }

  for (const line of lines) {
    const match = HEADING.exec(line)
    if (match) {
      flush()
      heading = unquoteInlineCode(match[1])
      body = []
    } else if (heading !== null) {
      body.push(line)
    }
  }
  flush()

  return found
}

/** Sections whose heading names a Member_Outcome, each holding one fenced example. */
function documentedExamples(markdown: string): DocumentedExample[] {
  const outcomeNames = new Set<string>(MEMBER_OUTCOME_VALUES)
  const examples: DocumentedExample[] = []

  for (const [heading, body] of sections(markdown)) {
    if (!outcomeNames.has(heading)) continue

    const fenced = [...body.matchAll(FENCED_JSON)]
    expect(
      fenced,
      `the '### ${heading}' section holds exactly one fenced json block`
    ).toHaveLength(1)

    const fixture = FIXTURE_PATH.exec(body)
    expect(
      fixture,
      `the '### ${heading}' section names the fixture that mirrors its example`
    ).not.toBeNull()

    examples.push({
      outcome: heading,
      fixturePath: fixture![0],
      exampleBody: stripFenceTerminator(fenced[0][1]),
    })
  }

  return examples
}

/** Rows of the `### Summary` table mapping response code → Member_Outcome → fixture. */
function summaryRows(markdown: string): SummaryRow[] {
  const summary = sections(markdown).get("Summary")
  expect(
    summary,
    "docs/upstream-api.md has a '### Summary' section"
  ).toBeDefined()

  return summary!
    .split("\n")
    .filter((line) => line.trimStart().startsWith("|"))
    .map((line) =>
      line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => unquoteInlineCode(cell.trim()))
    )
    .filter((cells) => cells.length === 3 && FIXTURE_PATH.test(cells[2]))
    .map(([responseCode, outcome, fixturePath]) => ({
      responseCode,
      outcome,
      fixturePath,
    }))
}

const examples = documentedExamples(doc)
const rows = summaryRows(doc)

/** Requirement 7.2 names three examples; the doc must document exactly those. */
const EXPECTED_EXAMPLE_COUNT = 3

describe("API_Reference_Document examples and Mock_Mode fixtures stay in sync", () => {
  it("documents exactly three examples, one per fenced json block, each with a distinct fixture", () => {
    expect(examples).toHaveLength(EXPECTED_EXAMPLE_COUNT)
    expect([...doc.matchAll(FENCED_JSON)]).toHaveLength(EXPECTED_EXAMPLE_COUNT)
    expect(new Set(examples.map((example) => example.fixturePath)).size).toBe(
      EXPECTED_EXAMPLE_COUNT
    )
    expect(new Set(examples.map((example) => example.outcome)).size).toBe(
      EXPECTED_EXAMPLE_COUNT
    )
  })

  it.each(examples)(
    "$fixturePath is byte-identical to the fenced $outcome example",
    ({ fixturePath, exampleBody }) => {
      const fixtureBytes = readFileSync(
        new URL(`../../${fixturePath}`, import.meta.url)
      )
      const documentBytes = Buffer.from(exampleBody, "utf8")

      expect(
        fixtureBytes.equals(documentBytes),
        [
          `${fixturePath} is byte-identical to its fenced example in docs/upstream-api.md.`,
          `document: ${JSON.stringify(exampleBody)}`,
          `fixture:  ${JSON.stringify(fixtureBytes.toString("utf8"))}`,
        ].join("\n")
      ).toBe(true)
    }
  )

  it.each(examples)(
    "parseUpstreamBody derives the documented $outcome from $fixturePath",
    ({ outcome, fixturePath }) => {
      const bodyText = readFileSync(
        new URL(`../../${fixturePath}`, import.meta.url),
        "utf8"
      )
      const result = parseUpstreamBody({ bodyText })

      expect(
        result.outcome,
        `docs/upstream-api.md states ${outcome} for ${fixturePath}`
      ).toBe(outcome)
    }
  )

  it("summary table agrees with every documented example on outcome, code, and fixture", () => {
    expect(rows).toHaveLength(EXPECTED_EXAMPLE_COUNT)

    for (const example of examples) {
      const row = rows.find(
        (candidate) => candidate.fixturePath === example.fixturePath
      )
      expect(
        row,
        `the summary table lists ${example.fixturePath}`
      ).toBeDefined()
      expect(
        row!.outcome,
        `the summary table and the '### ${example.outcome}' heading agree`
      ).toBe(example.outcome)

      const result = parseUpstreamBody({ bodyText: example.exampleBody })
      expect(
        row!.responseCode,
        `the summary table states the normalized code of ${example.fixturePath}`
      ).toBe(result.responseCode)
    }
  })
})
