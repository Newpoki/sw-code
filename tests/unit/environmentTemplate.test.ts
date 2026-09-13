import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

/**
 * Smoke test for the Environment_Template (`.env.example`).
 *
 * Requirements 1.9, 5.12 (restated in the design) and 6.13 demand that the
 * template document `MONGODB_URI`, `MONGODB_DB_NAME`,
 * `VITE_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` and `ADMIN_EMAILS` — each
 * with its purpose, its expected form, its default, and the consequence of
 * leaving it unset — and that it states where Google's OAuth client id and
 * client secret live, which is the Clerk dashboard and not this file.
 *
 * This test reads the shipped template and asserts exactly that, so an entry
 * cannot lose one of those statements unnoticed.
 */

const TEMPLATE_URL = new URL("../../.env.example", import.meta.url)
const template = readFileSync(TEMPLATE_URL, "utf8")

/** The five variables this feature adds to the Environment_Template. */
const VARIABLES = [
  "MONGODB_URI",
  "MONGODB_DB_NAME",
  "VITE_CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
  "ADMIN_EMAILS",
] as const

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/

/**
 * Maps each assigned variable to its documentation block: the run of comment
 * lines immediately above the assignment, with the leading `#` stripped. A
 * blank line ends the block, which is what separates an entry's own
 * documentation from the section banner above it.
 */
function documentationBlocks(text: string): Map<string, string> {
  const lines = text.split("\n")
  const blocks = new Map<string, string>()

  lines.forEach((line, index) => {
    const name = ASSIGNMENT.exec(line)?.[1]
    if (name === undefined) return

    const comments: Array<string> = []
    for (let i = index - 1; i >= 0 && lines[i].startsWith("#"); i -= 1) {
      comments.unshift(lines[i].replace(/^#\s?/, ""))
    }
    blocks.set(name, comments.join("\n"))
  })

  return blocks
}

const blocks = documentationBlocks(template)

/** The documentation block of `name`, failing the test when there is none. */
function entry(name: string): string {
  const block = blocks.get(name)
  expect(
    block,
    `.env.example assigns ${name} and documents it in the comment block above the assignment`
  ).toBeDefined()
  expect(
    block?.trim(),
    `.env.example documents ${name} with a non-empty comment block`
  ).not.toBe("")
  return block as string
}

describe("Environment_Template (.env.example)", () => {
  it("documents all five variables of this feature", () => {
    for (const name of VARIABLES) {
      expect(
        blocks.has(name),
        `.env.example carries an entry for ${name}`
      ).toBe(true)
    }
  })

  it("states the purpose of each variable", () => {
    for (const name of VARIABLES) {
      expect(entry(name), `.env.example states the purpose of ${name}`).toMatch(
        /purpose/i
      )
    }
  })

  it("states the expected form of each variable", () => {
    for (const name of VARIABLES) {
      expect(
        entry(name),
        `.env.example states the expected form of ${name}`
      ).toMatch(/expected form/i)
    }
  })

  it("states the default of each variable", () => {
    for (const name of VARIABLES) {
      expect(entry(name), `.env.example states the default of ${name}`).toMatch(
        /default/i
      )
    }
  })

  it("states the consequence of leaving each variable unset", () => {
    for (const name of VARIABLES) {
      const block = entry(name)
      expect(
        block,
        `.env.example states what happens when ${name} is unset`
      ).toMatch(/^UNSET\b.*$/im)
      expect(
        block.split("\n").find((line) => /^UNSET\b/i.test(line.trim())),
        `.env.example spells out the consequence, not just the word UNSET, for ${name}`
      ).toMatch(/=>/)
    }
  })

  it("states the separator and the case handling of ADMIN_EMAILS", () => {
    const block = entry("ADMIN_EMAILS")
    expect(
      block,
      ".env.example states that ADMIN_EMAILS entries are separated by commas"
    ).toMatch(/comma/i)
    expect(
      block,
      ".env.example states that ADMIN_EMAILS matching is case-insensitive"
    ).toMatch(/case[- ]insensitive/i)
  })

  it("notes that Google's client id and client secret live in the Clerk dashboard, not here", () => {
    const clerkKeyLine = template
      .split("\n")
      .findIndex((line) => line.startsWith("VITE_CLERK_PUBLISHABLE_KEY="))
    expect(
      clerkKeyLine,
      ".env.example assigns VITE_CLERK_PUBLISHABLE_KEY"
    ).toBeGreaterThanOrEqual(0)

    const noteCandidates = template
      .split("\n")
      .slice(0, clerkKeyLine)
      .join("\n")

    const note =
      /client id and (?:the )?client secret[\s\S]{0,200}?clerk dashboard/i
    const inverted =
      /clerk dashboard[\s\S]{0,200}?client id and (?:the )?client secret/i

    expect(
      note.test(noteCandidates) || inverted.test(noteCandidates),
      ".env.example states that Google's OAuth client id and client secret are configured in the Clerk dashboard rather than in this file"
    ).toBe(true)
  })
})
