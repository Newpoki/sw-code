// Feature: shared-coupon-redemption, Property 23: For any value of the
// Mock_Mode environment variable, including absent and whitespace-only values,
// Mock_Mode is enabled exactly when the trimmed value equals `true` ignoring
// letter case and is disabled for every other value, and startup completes in
// every case.
//
// Validates: Requirements 7.5, 7.7.
//
// The rule is restated here from the requirements rather than borrowed from the
// implementation: `expectedBranch` decides the branch with its own `trim` and
// `toLowerCase`, so `parseMockMode` never computes its own expectation.
//
// Every case is asserted twice: through `parseMockMode`, the pure rule, and
// through `resolveConfig` with an injected logger, which is where the warning of
// Requirement 7.7 becomes observable. `APP_PASSPHRASE`, `SESSION_SECRET`,
// `MONGODB_URI`, both Clerk keys, and `ADMIN_EMAILS` are supplied on every
// environment record so the only warning `resolveConfig` can
// emit is the Mock_Mode one; the count is nevertheless taken over warnings
// filtered to those naming `MOCK_MODE`, and the unrelated no-passphrase warning
// is asserted absent, so a future warning cannot silently inflate the total.

import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
  MOCK_MODE_ENV_VAR,
  NO_PASSPHRASE_WARNING,
  parseMockMode,
  resolveConfig,
  unrecognizedMockModeWarning,
} from "@/server/config.server"
import type { EnvRecord } from "@/server/config.server"

/** The four outcomes Requirements 7.5 and 7.7 distinguish. */
type Branch = "enabled" | "recognizedFalse" | "blank" | "unrecognized"

/**
 * Requirements 7.5 and 7.7 as a rule over the raw value, `undefined` standing
 * for an absent variable:
 *
 * - trimmed `true`, any letter case ⇒ enabled
 * - trimmed `false`, any letter case ⇒ disabled, recognized, silent
 * - absent or whitespace-only ⇒ disabled, silent
 * - anything else ⇒ disabled, and a warning is due
 */
function expectedBranch(raw: string | undefined): Branch {
  if (raw === undefined) {
    return "blank"
  }
  const trimmed = raw.trim()
  if (trimmed === "") {
    return "blank"
  }
  const normalized = trimmed.toLowerCase()
  if (normalized === "true") {
    return "enabled"
  }
  if (normalized === "false") {
    return "recognizedFalse"
  }
  return "unrecognized"
}

/**
 * Values that keep the Access_Gate configured and the session key supplied, so
 * neither the no-passphrase warning nor a generated key can interfere. Neither
 * value is a secret: the environment record never leaves this file.
 */
const BASE_ENV = {
  APP_PASSPHRASE: "property-test-passphrase",
  SESSION_SECRET: "property-test-session-secret",
  // Supplied so the startup warnings of `mongodb-google-auth-admin`
  // (Requirements 1.3, 5.2, 6.9) stay silent and the Mock_Mode warning remains
  // the only one this environment record can produce. None is a real value.
  MONGODB_URI: "mongodb://localhost:27017/property-test",
  VITE_CLERK_PUBLISHABLE_KEY: "pk_test_property",
  CLERK_SECRET_KEY: "sk_test_property",
  ADMIN_EMAILS: "owner@example.com",
}

/** An environment record carrying `raw`, or omitting the variable entirely. */
function envFor(raw: string | undefined): EnvRecord {
  return raw === undefined
    ? { ...BASE_ENV }
    : { ...BASE_ENV, [MOCK_MODE_ENV_VAR]: raw }
}

/** Whitespace padding `trim` removes, including the empty padding. */
const paddingArb: fc.Arbitrary<string> = fc.constantFrom(
  "",
  " ",
  "   ",
  "\t",
  "\n",
  "\r\n",
  "\u00a0",
  " \t\n "
)

/** Every letter-case variant of `word`, `true` through `TRUE`. */
function caseVariantArb(word: string): fc.Arbitrary<string> {
  return fc
    .array(fc.boolean(), {
      minLength: word.length,
      maxLength: word.length,
      size: "max",
    })
    .map((flips) =>
      Array.from(word, (character, index) =>
        flips[index] ? character.toUpperCase() : character
      ).join("")
    )
}

/** `core` surrounded by whitespace the rule is required to ignore. */
function paddedArb(core: fc.Arbitrary<string>): fc.Arbitrary<string> {
  return fc
    .tuple(paddingArb, core, paddingArb)
    .map(([left, middle, right]) => `${left}${middle}${right}`)
}

/** Padded case variants of `true`: `true`, `TRUE`, `True`, `  true  `, ... */
const enablingArb: fc.Arbitrary<string> = paddedArb(caseVariantArb("true"))

/** Padded case variants of `false`, which disable without a warning. */
const recognizedFalseArb: fc.Arbitrary<string> = paddedArb(
  caseVariantArb("false")
)

/** The empty string and whitespace-only strings, treated as absent. */
const blankArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(" ", "\t", "\n", "\r", "\u00a0", "\f", "\v"), {
    maxLength: 6,
  })
  .map((characters) => characters.join(""))

/**
 * Values matching neither `true` nor `false`, including near misses that share a
 * prefix or an interior space with a recognized value.
 */
const unrecognizedArb: fc.Arbitrary<string> = fc
  .oneof(
    { weight: 2, arbitrary: fc.string() },
    {
      weight: 3,
      arbitrary: paddedArb(
        fc.constantFrom(
          "truex",
          "TRUE1",
          "tru e",
          "t rue",
          "falsey",
          "FALSE!",
          "fals",
          "1",
          "0",
          "yes",
          "no",
          "on",
          "off",
          "enabled",
          "true false",
          '"true"',
          "TRUE\u200b"
        )
      ),
    }
  )
  .filter((value) => expectedBranch(value) === "unrecognized")

/** Any raw value, absent included, weighted to reach all four branches. */
const rawValueArb: fc.Arbitrary<string | undefined> = fc.oneof(
  { weight: 3, arbitrary: enablingArb },
  { weight: 3, arbitrary: recognizedFalseArb },
  { weight: 2, arbitrary: blankArb },
  { weight: 4, arbitrary: unrecognizedArb },
  { weight: 1, arbitrary: fc.constant(undefined) },
  { weight: 3, arbitrary: fc.string() }
)

/**
 * Asserts the whole of Property 23 for one raw value, through the pure rule and
 * through `resolveConfig`, and returns the branch the rule selected so a caller
 * can state which branch it meant to exercise.
 */
function assertMockModeRule(raw: string | undefined): Branch {
  const branch = expectedBranch(raw)
  const shouldEnable = branch === "enabled"
  const shouldWarn = branch === "unrecognized"

  // The pure rule (Requirement 7.5), plus the warning it schedules (7.7).
  const parsed = parseMockMode(raw)
  expect(parsed.enabled).toBe(shouldEnable)
  expect(parsed.unrecognizedValue).toBe(shouldWarn ? raw : null)

  // The same value read as part of a whole startup.
  const warnings: Array<string> = []
  const resolved = resolveConfig(envFor(raw), {
    warn: (message) => warnings.push(message),
  })
  expect(resolved.config.mockMode).toBe(shouldEnable)

  const mockModeWarnings = warnings.filter((message) =>
    message.includes(MOCK_MODE_ENV_VAR)
  )
  expect(mockModeWarnings).toHaveLength(shouldWarn ? 1 : 0)
  // No other warning is possible for this environment record, so the filtered
  // count accounts for every warning emitted.
  expect(warnings).not.toContain(NO_PASSPHRASE_WARNING)
  expect(warnings).toHaveLength(mockModeWarnings.length)

  if (shouldWarn && raw !== undefined) {
    const message = mockModeWarnings[0]
    // Requirement 7.7: the warning names the variable and the rejected value.
    expect(message).toContain(MOCK_MODE_ENV_VAR)
    expect(message.includes(raw) || message.includes(JSON.stringify(raw))).toBe(
      true
    )
    expect(message).toBe(unrecognizedMockModeWarning(raw))
  }

  // Requirement 7.7: startup completes in every case. Nothing throws, and the
  // rest of the configuration is resolved whatever `MOCK_MODE` held.
  expect(resolved.config.passphraseRequired).toBe(true)
  expect(resolved.config.upstreamBaseUrl.length).toBeGreaterThan(0)
  expect(resolved.config.dataFile.length).toBeGreaterThan(0)
  expect(resolved.secrets.readSessionSecret()).toBe(BASE_ENV.SESSION_SECRET)
  expect(resolved.sessionSecretGenerated).toBe(false)

  return branch
}

describe("Property 23: Mock_Mode environment parsing", () => {
  it("enables Mock_Mode exactly for a trimmed, case-insensitive true", () => {
    fc.assert(
      fc.property(rawValueArb, (raw) => {
        assertMockModeRule(raw)
      }),
      { numRuns: 300 }
    )
  })

  it("enables Mock_Mode for true in any letter case, padding ignored", () => {
    fc.assert(
      fc.property(enablingArb, (raw) => {
        expect(assertMockModeRule(raw)).toBe("enabled")
        expect(parseMockMode(raw).enabled).toBe(true)
      }),
      { numRuns: 100 }
    )
  })

  it("disables Mock_Mode silently for false in any letter case", () => {
    fc.assert(
      fc.property(recognizedFalseArb, (raw) => {
        expect(assertMockModeRule(raw)).toBe("recognizedFalse")
        expect(parseMockMode(raw).unrecognizedValue).toBeNull()
      }),
      { numRuns: 100 }
    )
  })

  it("disables Mock_Mode silently when absent or whitespace-only", () => {
    fc.assert(
      fc.property(blankArb, (blank) => {
        expect(assertMockModeRule(blank)).toBe("blank")
        expect(assertMockModeRule(undefined)).toBe("blank")
        expect(parseMockMode(blank).unrecognizedValue).toBeNull()
      }),
      { numRuns: 100 }
    )
  })

  it("disables Mock_Mode and warns once for an unrecognized value", () => {
    fc.assert(
      fc.property(unrecognizedArb, (raw) => {
        expect(assertMockModeRule(raw)).toBe("unrecognized")
        expect(parseMockMode(raw)).toEqual({
          enabled: false,
          unrecognizedValue: raw,
        })
      }),
      { numRuns: 100 }
    )
  })
})
