// Feature: mongodb-google-auth-admin, Property 1: The database name resolves
// from the URI, then the variable, then the default — for any MongoDB
// connection string built from a scheme, a host, an optional path segment, and
// an optional query string, surrounded by arbitrary leading and trailing
// whitespace, and for any `MONGODB_DB_NAME` value, the resolved database name
// equals the trimmed path segment when that segment holds at least one
// character, equals the trimmed `MONGODB_DB_NAME` value when the segment holds
// none, equals `sw-code` when both hold none, and never contains a `/` or a `?`
// character.
//
// Validates: Requirements 1.1, 1.2.
//
// `resolveDatabaseName` is a pure function of two arguments, which is why this
// property reads no environment and opens no connection: Requirement 1.1's
// "removing leading and trailing whitespace characters" is exercised by padding
// the generated URI and the generated variable value, not by writing to
// `process.env`.
//
// The expectation is stated from the *generated parts* rather than from a second
// parser. `mongoConnectionStringSampleArb` assembles each URI from a scheme, a
// host list, an optional path segment, and an optional query string, and reports
// alongside it the database name that URI supplies. So the assertions below
// compare the implementation against the pieces the sample was built out of,
// which is evidence rather than a restatement of the same parsing code.
//
// One scope note on the last clause. Requirement 1.2 takes the `MONGODB_DB_NAME`
// value verbatim after trimming, so a variable holding `a/b` would resolve to
// `a/b`; the "never contains a `/` or a `?`" claim is about names a MongoDB
// deployment will accept, and the variable arbitrary below therefore generates
// plausible names rather than arbitrary text. The URI half of the claim is
// unconditional: a path segment is cut at the first `/` or `?`, whatever it
// holds.

import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
  DEFAULT_MONGO_DATABASE_NAME,
  MONGODB_URI_SCHEMES,
  resolveDatabaseName,
} from "@/server/config.server"

import {
  blankTextArb,
  MONGO_URI_SCHEMES,
  mongoConnectionStringSampleArb,
  mongoDatabaseNameArb,
  whitespacePaddingArb,
} from "./generators"

/* -------------------------------------------------------------------------- */
/* Arbitraries local to this property                                         */
/* -------------------------------------------------------------------------- */

/**
 * A `MONGODB_DB_NAME` value that supplies a name: the name itself, or the name
 * wrapped in whitespace `trim` removes.
 */
const namingEnvValueArb: fc.Arbitrary<{ raw: string; supplied: string }> = fc
  .tuple(whitespacePaddingArb, mongoDatabaseNameArb, whitespacePaddingArb)
  .map(([left, name, right]) => ({
    raw: `${left}${name}${right}`,
    supplied: name,
  }))

/** A `MONGODB_DB_NAME` value that supplies nothing: absent, empty, or blank. */
const silentEnvValueArb: fc.Arbitrary<string | undefined> = fc.oneof(
  { weight: 2, arbitrary: fc.constant<string | undefined>(undefined) },
  { weight: 3, arbitrary: blankTextArb }
)

/** Either kind of variable value, tagged with the name it supplies. */
const anyEnvValueArb: fc.Arbitrary<{
  raw: string | undefined
  supplied: string
}> = fc.oneof(
  { weight: 3, arbitrary: namingEnvValueArb },
  {
    weight: 2,
    arbitrary: silentEnvValueArb.map((raw) => ({ raw, supplied: "" })),
  }
)

/* -------------------------------------------------------------------------- */
/* The property                                                               */
/* -------------------------------------------------------------------------- */

describe("Property 1: the database name resolves from the URI, then the variable, then the default", () => {
  it("generates connection strings carrying the schemes the parser accepts", () => {
    /* The generator restates the scheme pair so it can stay free of server-only
     * imports; if the two ever diverge, every assertion below would be about a
     * value the parser rejects. */
    expect([...MONGO_URI_SCHEMES]).toEqual([...MONGODB_URI_SCHEMES])
  })

  it("takes the trimmed path segment whenever the URI supplies one", () => {
    fc.assert(
      fc.property(
        mongoConnectionStringSampleArb.filter(
          (sample) => sample.suppliedDatabaseName.length > 0
        ),
        anyEnvValueArb,
        (sample, env) => {
          /* The URI wins outright: the variable is ignored even when it names
           * something else (Requirement 1.2). */
          expect(resolveDatabaseName(sample.uri, env.raw)).toBe(
            sample.suppliedDatabaseName
          )
        }
      ),
      { numRuns: 300 }
    )
  })

  it("falls back to the trimmed variable when the URI supplies no segment", () => {
    fc.assert(
      fc.property(
        mongoConnectionStringSampleArb.filter(
          (sample) => sample.suppliedDatabaseName.length === 0
        ),
        namingEnvValueArb,
        (sample, env) => {
          expect(resolveDatabaseName(sample.uri, env.raw)).toBe(env.supplied)
        }
      ),
      { numRuns: 300 }
    )
  })

  it("falls back to sw-code when neither the URI nor the variable supplies a name", () => {
    fc.assert(
      fc.property(
        mongoConnectionStringSampleArb.filter(
          (sample) => sample.suppliedDatabaseName.length === 0
        ),
        silentEnvValueArb,
        (sample, raw) => {
          expect(resolveDatabaseName(sample.uri, raw)).toBe(
            DEFAULT_MONGO_DATABASE_NAME
          )
          expect(DEFAULT_MONGO_DATABASE_NAME).toBe("sw-code")
        }
      ),
      { numRuns: 300 }
    )
  })

  it("resolves to a non-empty name holding neither a slash nor a question mark", () => {
    fc.assert(
      fc.property(
        mongoConnectionStringSampleArb,
        anyEnvValueArb,
        (sample, env) => {
          const resolved = resolveDatabaseName(sample.uri, env.raw)

          /* The resolution is total — every pair of inputs yields a usable name
           * — and a name never carries the two characters that would make it a
           * path or an option string. */
          expect(resolved.length).toBeGreaterThan(0)
          expect(resolved).toBe(resolved.trim())
          expect(resolved).not.toContain("/")
          expect(resolved).not.toContain("?")
        }
      ),
      { numRuns: 300 }
    )
  })

  it("is unchanged by whitespace around the URI or around the variable", () => {
    fc.assert(
      fc.property(
        mongoConnectionStringSampleArb,
        anyEnvValueArb,
        whitespacePaddingArb,
        whitespacePaddingArb,
        (sample, env, left, right) => {
          const padded = `${left}${sample.uri}${right}`
          const paddedEnv =
            env.raw === undefined ? undefined : `${left}${env.raw}${right}`

          /* Requirement 1.1: the value is read after removal of leading and
           * trailing whitespace characters, so padding either input cannot move
           * the answer. */
          expect(resolveDatabaseName(padded, paddedEnv)).toBe(
            resolveDatabaseName(sample.uri, env.raw)
          )
        }
      ),
      { numRuns: 200 }
    )
  })
})
