import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

/**
 * Smoke test for the API_Reference_Document (`docs/upstream-api.md`).
 *
 * Requirement 7.1 demands that the document names the `checkUser` endpoint URL,
 * the `useCoupon` endpoint URL, the five request field names, and — for each of
 * those five — whether its value is a Fixed_Request_Field or is supplied per
 * Redemption_Run. This test reads the shipped document and asserts exactly that,
 * so the document cannot lose one of those statements unnoticed.
 */

const DOC_URL = new URL("../../docs/upstream-api.md", import.meta.url)
const doc = readFileSync(DOC_URL, "utf8")

const BASE_URL = "https://event.withhive.com/ci/smon/evt_coupon"

const ENDPOINT_URLS = [
  `${BASE_URL}/checkUser`,
  `${BASE_URL}/useCoupon`,
] as const

/** The five request fields and how the document must classify each one. */
const REQUEST_FIELDS = [
  { name: "country", kind: "fixed" },
  { name: "lang", kind: "fixed" },
  { name: "server", kind: "fixed" },
  { name: "hiveid", kind: "per-run" },
  { name: "coupon", kind: "per-run" },
] as const

/** Text of the `## Request fields` section, up to the next level-2 heading. */
function requestFieldsSection(markdown: string): string {
  const lines = markdown.split("\n")
  const start = lines.findIndex((line) => /^##\s+Request fields\s*$/.test(line))
  expect(
    start,
    "docs/upstream-api.md has a '## Request fields' section"
  ).toBeGreaterThanOrEqual(0)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^##\s/.test(line))
  return (end === -1 ? rest : rest.slice(0, end)).join("\n")
}

/** The table row of the request-fields section that documents `field`. */
function fieldRow(section: string, field: string): string {
  const rows = section
    .split("\n")
    .filter((line) => line.trimStart().startsWith("|"))
    .filter((line) => line.includes(`\`${field}\``))
  expect(
    rows,
    `docs/upstream-api.md documents the '${field}' request field in one table row`
  ).toHaveLength(1)
  return rows[0]
}

describe("API_Reference_Document (docs/upstream-api.md)", () => {
  it("names both endpoint URLs", () => {
    for (const url of ENDPOINT_URLS) {
      expect(
        doc,
        `docs/upstream-api.md names the endpoint URL ${url}`
      ).toContain(url)
    }
  })

  it("names all five request field names", () => {
    const section = requestFieldsSection(doc)
    for (const { name } of REQUEST_FIELDS) {
      expect(
        section,
        `docs/upstream-api.md names the '${name}' request field`
      ).toContain(`\`${name}\``)
    }
  })

  it("states for each request field whether it is fixed or supplied per Redemption_Run", () => {
    const section = requestFieldsSection(doc)
    for (const { name, kind } of REQUEST_FIELDS) {
      const row = fieldRow(section, name)
      const saysFixed = row.includes("Fixed_Request_Field")
      const saysPerRun = /supplied per Redemption_Run/i.test(row)

      expect(
        [saysFixed, saysPerRun],
        `docs/upstream-api.md classifies '${name}' as exactly one of fixed or supplied per Redemption_Run`
      ).toEqual(kind === "fixed" ? [true, false] : [false, true])
    }
  })

  it("gives the constant value of each Fixed_Request_Field", () => {
    const section = requestFieldsSection(doc)
    const fixedValues = { country: "FR", lang: "en", server: "europe" } as const
    for (const [name, value] of Object.entries(fixedValues)) {
      expect(
        fieldRow(section, name),
        `docs/upstream-api.md states that the fixed '${name}' field holds '${value}'`
      ).toContain(`\`${value}\``)
    }
  })
})
