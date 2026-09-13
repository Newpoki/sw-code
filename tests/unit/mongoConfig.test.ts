import { describe, expect, it } from "vitest"

import {
  DEFAULT_MONGO_DATABASE_NAME,
  parseMongoConnectionString,
  resolveConfig,
  resolveDatabaseName,
  toClientConfig,
} from "@/server/config.server"
import type { ConfigLogger, EnvRecord } from "@/server/config.server"

/**
 * The Mongo_Database and Clerk half of `config.server.ts`: the connection-string
 * parse, the database-name resolution, the flags they produce, and the
 * server-only accessors (Requirements 1.1, 1.2, 1.6, 1.10, 5.2 restated, 5.10
 * restated).
 *
 * Startup *warnings* are asserted in `configStartupWarnings.test.ts`; every case
 * here injects a silent logger, so the two files do not restate each other's
 * assertions.
 */
function silentLogger(): ConfigLogger {
  return { warn: () => {} }
}

/** A fully configured environment, so a case changes one variable at a time. */
const CONFIGURED_ENV: EnvRecord = {
  APP_PASSPHRASE: "unit-test-passphrase",
  MONGODB_URI: " mongodb://reader:pw@localhost:27017/live?tls=true ",
  VITE_CLERK_PUBLISHABLE_KEY: "pk_test_unit",
  CLERK_SECRET_KEY: "sk_test_unit",
  ADMIN_EMAILS: " Owner@Example.COM , owner@example.com , no-at-sign ",
}

function resolve(env: EnvRecord = CONFIGURED_ENV) {
  return resolveConfig(env, silentLogger())
}

describe("parseMongoConnectionString (Requirement 1.10)", () => {
  it("splits the scheme, the host list, and the database name", () => {
    expect(parseMongoConnectionString("mongodb://a:27017,b:27017/db")).toEqual({
      scheme: "mongodb://",
      hosts: "a:27017,b:27017",
      pathSegment: "db",
    })
  })

  it("drops credentials, including a percent-encoded at sign", () => {
    expect(
      parseMongoConnectionString("mongodb+srv://us%40er:pw@c.example.net/appdb")
    ).toEqual({
      scheme: "mongodb+srv://",
      hosts: "c.example.net",
      pathSegment: "appdb",
    })
  })

  it("reads no database name from a URI that carries only options", () => {
    expect(
      parseMongoConnectionString("mongodb://h:27017?replicaSet=rs0")
        ?.pathSegment
    ).toBe("")
    expect(parseMongoConnectionString("mongodb://h:27017/")?.pathSegment).toBe(
      ""
    )
  })

  it("rejects a wrong scheme and an empty host list", () => {
    expect(parseMongoConnectionString("postgres://h:5432/db")).toBeNull()
    expect(parseMongoConnectionString("localhost:27017")).toBeNull()
    expect(parseMongoConnectionString("mongodb://")).toBeNull()
    expect(parseMongoConnectionString("mongodb://user:pw@/db")).toBeNull()
    expect(parseMongoConnectionString("")).toBeNull()
  })
})

describe("resolveDatabaseName (Requirement 1.2)", () => {
  it("prefers the trimmed path segment of the URI", () => {
    expect(
      resolveDatabaseName("  mongodb://a:1,b:2/prod?tls=true  ", "ignored")
    ).toBe("prod")
  })

  it("falls back to the trimmed MONGODB_DB_NAME value", () => {
    expect(resolveDatabaseName("mongodb://h:27017?tls=true", " envdb ")).toBe(
      "envdb"
    )
    expect(resolveDatabaseName("mongodb://h:27017/", "envdb")).toBe("envdb")
  })

  it("falls back to the default when neither supplies a name", () => {
    for (const envDbName of [undefined, "", "   "]) {
      expect(resolveDatabaseName("mongodb://h:27017/", envDbName)).toBe(
        DEFAULT_MONGO_DATABASE_NAME
      )
    }
  })

  it("is total: a value that does not parse still yields a name", () => {
    expect(resolveDatabaseName("nonsense", undefined)).toBe(
      DEFAULT_MONGO_DATABASE_NAME
    )
    expect(resolveDatabaseName("nonsense", "envdb")).toBe("envdb")
  })
})

describe("the Mongo_Database flags and accessor (Requirements 1.1, 1.6)", () => {
  it("reads the trimmed URI behind readMongoUri and nowhere else", () => {
    const { config, secrets } = resolve()

    expect(secrets.readMongoUri()).toBe(
      "mongodb://reader:pw@localhost:27017/live?tls=true"
    )
    expect(config.mongoConfigured).toBe(true)
    expect(config.mongoUriParsed).toBe(true)
    expect(config.mongoDatabaseName).toBe("live")

    // Requirement 1.6: no part of the URI is reachable through the config.
    const serialized = JSON.stringify(config)
    for (const fragment of [
      "reader",
      "pw",
      "localhost",
      "27017",
      "mongodb://",
    ]) {
      expect(serialized).not.toContain(fragment)
    }
  })

  it("treats an absent or blank URI as no Mongo_Database configured", () => {
    for (const raw of [undefined, "", "  \t "]) {
      const { config, secrets } = resolve({
        ...CONFIGURED_ENV,
        MONGODB_URI: raw,
      })

      expect(config.mongoConfigured).toBe(false)
      expect(config.mongoDatabaseName).toBeNull()
      expect(secrets.readMongoUri()).toBeNull()
      // Absence is Requirement 1.3, not a parse failure.
      expect(config.mongoUriParsed).toBe(true)
    }
  })

  it("marks a present-but-unparsable URI as unparsed (Requirement 1.10)", () => {
    const { config, secrets } = resolve({
      ...CONFIGURED_ENV,
      MONGODB_URI: "mysql://db.internal/x",
    })

    expect(config.mongoConfigured).toBe(true)
    expect(config.mongoUriParsed).toBe(false)
    // The value is still readable by the store, which opens no pool for it.
    expect(secrets.readMongoUri()).toBe("mysql://db.internal/x")
  })

  it("resolves the database name from MONGODB_DB_NAME when the URI holds none", () => {
    const { config } = resolve({
      ...CONFIGURED_ENV,
      MONGODB_URI: "mongodb://localhost:27017",
      MONGODB_DB_NAME: " group-data ",
    })

    expect(config.mongoDatabaseName).toBe("group-data")
  })
})

describe("the Clerk flag and secret accessor (Requirements 5.2, 5.10 restated)", () => {
  it("is configured when both keys are present", () => {
    const { config, secrets } = resolve()

    expect(config.clerkConfigured).toBe(true)
    expect(secrets.readClerkSecretKey()).toBe("sk_test_unit")
  })

  const missing: ReadonlyArray<readonly [string, EnvRecord]> = [
    ["publishable key absent", { VITE_CLERK_PUBLISHABLE_KEY: undefined }],
    ["publishable key blank", { VITE_CLERK_PUBLISHABLE_KEY: "  " }],
    ["secret key absent", { CLERK_SECRET_KEY: undefined }],
    ["secret key blank", { CLERK_SECRET_KEY: "\t" }],
  ]

  it.each(missing)("is unconfigured when the %s", (_label, override) => {
    const { config } = resolve({ ...CONFIGURED_ENV, ...override })

    expect(config.clerkConfigured).toBe(false)
  })

  it("holds no publishable key value and no secret key value on the config", () => {
    const serialized = JSON.stringify(resolve().config)

    expect(serialized).not.toContain("pk_test_unit")
    expect(serialized).not.toContain("sk_test_unit")
  })
})

describe("the Admin_Allowlist on the config (Requirements 6.1, 6.2)", () => {
  it("carries the normalized, de-duplicated survivors", () => {
    expect(resolve().config.adminAllowlist).toEqual(["owner@example.com"])
  })

  it("is empty rather than absent when the variable yields nothing", () => {
    for (const raw of [undefined, "", " , ,", "no-at-sign"]) {
      expect(
        resolve({ ...CONFIGURED_ENV, ADMIN_EMAILS: raw }).config.adminAllowlist
      ).toEqual([])
    }
  })
})

describe("the client projection gains nothing", () => {
  it("still exposes only the Mock_Mode flag", () => {
    /*
     * `mongoConfigured` is deliberately absent from the browser projection: the
     * connection indicator is an Admin_Page value, served through the guarded
     * admin server function rather than the public config read.
     */
    const { config } = resolve()

    expect(config.mongoConfigured).toBe(true)
    expect(Object.keys(toClientConfig(config))).toEqual(["mockMode"])
  })
})
