import { describe, expect, it } from "vitest"
import {
  ADMIN_EMAILS_ENV_VAR,
  CLERK_PUBLISHABLE_KEY_ENV_VAR,
  CLERK_SECRET_KEY_ENV_VAR,
  DEFAULT_DATA_FILE,
  DEFAULT_UPSTREAM_BASE_URL,
  EMPTY_ADMIN_ALLOWLIST_WARNING,
  MOCK_MODE_ENV_VAR,
  MONGODB_URI_ENV_VAR,
  NO_MONGODB_URI_WARNING,
  NO_PASSPHRASE_WARNING,
  UNPARSABLE_MONGODB_URI_WARNING,
  missingClerkKeysWarning,
  resolveConfig,
  toClientConfig,
} from "@/server/config.server"
import type {
  ConfigLogger,
  EnvRecord,
  ResolvedConfig,
} from "@/server/config.server"

/**
 * Startup warning tests for `config.server.ts`: the Mock_Mode value warning and
 * the unauthenticated-startup warning of `shared-coupon-redemption`
 * (Requirements 7.7, 8.9, 8.10), and the four warnings this feature adds —
 * absent URI, unparsable URI, missing Clerk keys, empty Admin_Allowlist
 * (Requirements 1.3, 1.10, 5.2 restated, 6.9).
 *
 * Every case injects its own environment record and its own logger, so no test
 * touches `process.env` and none spies on the global console: the assertions
 * read the captured lines directly.
 *
 * The flags, the database-name resolution, and the server-only accessors are
 * asserted in `mongoConfig.test.ts` against a silent logger, so the two files
 * do not restate each other. This file asserts only what is logged.
 */

interface CapturingLogger extends ConfigLogger {
  readonly messages: string[]
  /** Only the lines that name `variable`. */
  naming: (variable: string) => string[]
  /** Only the lines that name the Mock_Mode variable. */
  mockModeWarnings: () => string[]
}

function capturingLogger(): CapturingLogger {
  const messages: string[] = []
  const naming = (variable: string) =>
    messages.filter((message) => message.includes(variable))
  return {
    messages,
    warn: (message: string) => {
      messages.push(message)
    },
    naming,
    mockModeWarnings: () => naming(MOCK_MODE_ENV_VAR),
  }
}

/**
 * A fully configured environment: passphrase set, a parsable URI, both Clerk
 * keys, and a non-empty Admin_Allowlist. Startup over this record logs nothing,
 * so a case that overrides one variable sees exactly the warning that variable
 * is responsible for.
 */
const CONFIGURED_ENV: EnvRecord = {
  APP_PASSPHRASE: "correct horse battery staple",
  [MONGODB_URI_ENV_VAR]:
    "mongodb://zzz-user:zzz-password@zzz-host:27017/zzz-db",
  [CLERK_PUBLISHABLE_KEY_ENV_VAR]: "pk_test_zzz_publishable",
  [CLERK_SECRET_KEY_ENV_VAR]: "sk_test_zzz_secret",
  [ADMIN_EMAILS_ENV_VAR]: "owner@example.com",
}

/** The configured environment with `extra` applied on top. */
function configuredEnv(extra: EnvRecord = {}): EnvRecord {
  return { ...CONFIGURED_ENV, ...extra }
}

/**
 * Reads the resolved value the way a later request would — the flags, the
 * allowlist, the secret accessors, the client projection — and returns the lines
 * logged during those reads. Every warning belongs to startup, so this is empty
 * for every case (Requirement 6.9 states it for the allowlist explicitly).
 */
function linesLoggedAfterStartup(
  logger: CapturingLogger,
  resolved: ResolvedConfig
): string[] {
  const alreadyLogged = logger.messages.length

  const { config, secrets } = resolved
  void config.mongoConfigured
  void config.mongoUriParsed
  void config.mongoDatabaseName
  void config.clerkConfigured
  void config.adminAllowlist.length
  void config.passphraseRequired
  secrets.readMongoUri()
  secrets.readClerkSecretKey()
  toClientConfig(config)

  return logger.messages.slice(alreadyLogged)
}

describe("unrecognized MOCK_MODE value (Requirement 7.7)", () => {
  const rejected = ["yes", "1", "TRUEISH", "0", "on", "false ish"]

  it.each(rejected)(
    "logs exactly one warning naming the variable and the value %o",
    (raw) => {
      const logger = capturingLogger()

      const { config } = resolveConfig(
        configuredEnv({ [MOCK_MODE_ENV_VAR]: raw }),
        logger
      )

      const warnings = logger.mockModeWarnings()
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain(MOCK_MODE_ENV_VAR)
      expect(warnings[0]).toContain(JSON.stringify(raw))
      expect(config.mockMode).toBe(false)
    }
  )

  it("completes startup rather than throwing", () => {
    const logger = capturingLogger()

    expect(() =>
      resolveConfig(configuredEnv({ [MOCK_MODE_ENV_VAR]: "yes" }), logger)
    ).not.toThrow()
  })

  it("still resolves every other value, so the rest of startup is unaffected", () => {
    const logger = capturingLogger()

    const { config } = resolveConfig(
      configuredEnv({
        [MOCK_MODE_ENV_VAR]: "TRUEISH",
        UPSTREAM_BASE_URL: "http://localhost:9999/evt",
        DATA_FILE: "./tmp/store.json",
      }),
      logger
    )

    expect(config).toEqual({
      mockMode: false,
      upstreamBaseUrl: "http://localhost:9999/evt",
      dataFile: "./tmp/store.json",
      passphraseRequired: true,
      mongoConfigured: true,
      mongoDatabaseName: "zzz-db",
      mongoUriParsed: true,
      clerkConfigured: true,
      adminAllowlist: ["owner@example.com"],
    })
  })
})

describe("a fully configured environment logs nothing (Requirement 7.5)", () => {
  const cases: ReadonlyArray<readonly [string, string | undefined, boolean]> = [
    ["true", "true", true],
    ["TRUE", "TRUE", true],
    ["padded true", " true ", true],
    ["false", "false", false],
    ["FaLsE", "FaLsE", false],
    ["absent", undefined, false],
    ["empty", "", false],
    ["whitespace-only", "   ", false],
  ]

  it.each(cases)("%s MOCK_MODE", (_label, raw, expected) => {
    const logger = capturingLogger()

    const resolved = resolveConfig(
      configuredEnv({ [MOCK_MODE_ENV_VAR]: raw }),
      logger
    )

    expect(logger.mockModeWarnings()).toEqual([])
    expect(logger.messages).toEqual([])
    expect(resolved.config.mockMode).toBe(expected)
    expect(linesLoggedAfterStartup(logger, resolved)).toEqual([])
  })
})

describe("no Shared_Passphrase configured (Requirement 8.9)", () => {
  const cases: ReadonlyArray<readonly [string, string | undefined]> = [
    ["absent", undefined],
    ["empty", ""],
    ["whitespace-only", "  \t \n "],
  ]

  it.each(cases)(
    "%s APP_PASSPHRASE logs the unauthenticated-startup warning",
    (_label, raw) => {
      const logger = capturingLogger()

      const resolved = resolveConfig(
        configuredEnv({ APP_PASSPHRASE: raw }),
        logger
      )

      expect(logger.messages).toEqual([NO_PASSPHRASE_WARNING])
      expect(resolved.config.passphraseRequired).toBe(false)
      expect(resolved.secrets.readSharedPassphrase()).toBeNull()
      expect(linesLoggedAfterStartup(logger, resolved)).toEqual([])
    }
  )

  it("leaves the app usable: startup returns normally with a full config", () => {
    const logger = capturingLogger()

    const resolve = () => resolveConfig({}, logger)

    expect(resolve).not.toThrow()
    expect(resolve().config).toEqual({
      mockMode: false,
      upstreamBaseUrl: DEFAULT_UPSTREAM_BASE_URL,
      dataFile: DEFAULT_DATA_FILE,
      passphraseRequired: false,
      mongoConfigured: false,
      mongoDatabaseName: null,
      mongoUriParsed: true,
      clerkConfigured: false,
      adminAllowlist: [],
    })
  })
})

describe("a configured Shared_Passphrase logs no warning", () => {
  it("sets passphraseRequired and stays silent", () => {
    const logger = capturingLogger()

    const { config } = resolveConfig(
      configuredEnv({ APP_PASSPHRASE: "  s3cret  " }),
      logger
    )

    expect(logger.messages).toEqual([])
    expect(config.passphraseRequired).toBe(true)
  })

  it("trims the passphrase before it becomes the Shared_Passphrase", () => {
    const { secrets } = resolveConfig(
      configuredEnv({ APP_PASSPHRASE: "  s3cret  " }),
      capturingLogger()
    )

    expect(secrets.readSharedPassphrase()).toBe("s3cret")
  })
})

describe("no Mongo_Connection_URI configured (Requirement 1.3)", () => {
  const cases: ReadonlyArray<readonly [string, string | undefined]> = [
    ["absent", undefined],
    ["empty", ""],
    ["whitespace-only", "  \t "],
  ]

  it.each(cases)("%s MONGODB_URI logs exactly one warning", (_label, raw) => {
    const logger = capturingLogger()

    const resolved = resolveConfig(
      configuredEnv({ [MONGODB_URI_ENV_VAR]: raw }),
      logger
    )

    expect(logger.messages).toEqual([NO_MONGODB_URI_WARNING])
    expect(logger.naming(MONGODB_URI_ENV_VAR)).toHaveLength(1)
    // There is no value to disclose, and the not-parsed warning is not this one.
    expect(logger.messages[0]).not.toBe(UNPARSABLE_MONGODB_URI_WARNING)
    expect(linesLoggedAfterStartup(logger, resolved)).toEqual([])
  })

  it("completes startup rather than throwing", () => {
    expect(() =>
      resolveConfig(
        configuredEnv({ [MONGODB_URI_ENV_VAR]: undefined }),
        capturingLogger()
      )
    ).not.toThrow()
  })
})

describe("unparsable Mongo_Connection_URI (Requirement 1.10)", () => {
  /** Each case pairs a rejected value with the fragments of it that must not be logged. */
  const cases: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    [
      "wrong scheme",
      "mysql://zzz-user:zzz-password@zzz-host.internal:3306/zzz-db",
      ["mysql", "zzz-user", "zzz-password", "zzz-host.internal", "3306"],
    ],
    [
      "no scheme",
      "zzz-host.internal:27017/zzz-db",
      ["zzz-host.internal", "27017", "zzz-db"],
    ],
    [
      "credentials but no host",
      "mongodb://zzz-user:zzz-password@/zzz-db",
      ["zzz-user", "zzz-password", "zzz-db"],
    ],
  ]

  it.each(cases)(
    "%s logs exactly one warning naming MONGODB_URI and no part of the value",
    (_label, raw, fragments) => {
      const logger = capturingLogger()

      const resolved = resolveConfig(
        configuredEnv({ [MONGODB_URI_ENV_VAR]: raw }),
        logger
      )

      expect(logger.messages).toEqual([UNPARSABLE_MONGODB_URI_WARNING])
      const warning = logger.messages[0]
      expect(warning).toContain(MONGODB_URI_ENV_VAR)
      expect(warning).not.toContain(raw)
      for (const fragment of fragments) {
        expect(warning).not.toContain(fragment)
      }
      expect(linesLoggedAfterStartup(logger, resolved)).toEqual([])
    }
  )

  it("logs the not-parsed warning rather than the not-set one", () => {
    const logger = capturingLogger()

    resolveConfig(configuredEnv({ [MONGODB_URI_ENV_VAR]: "not-a-uri" }), logger)

    expect(logger.messages).not.toContain(NO_MONGODB_URI_WARNING)
  })

  it("completes startup rather than throwing", () => {
    expect(() =>
      resolveConfig(
        configuredEnv({ [MONGODB_URI_ENV_VAR]: "not-a-uri" }),
        capturingLogger()
      )
    ).not.toThrow()
  })
})

describe("missing Clerk keys (Requirement 5.2 restated)", () => {
  const cases: ReadonlyArray<
    readonly [string, EnvRecord, readonly string[], readonly string[]]
  > = [
    [
      "publishable key absent",
      { [CLERK_PUBLISHABLE_KEY_ENV_VAR]: undefined },
      [CLERK_PUBLISHABLE_KEY_ENV_VAR],
      [CLERK_SECRET_KEY_ENV_VAR],
    ],
    [
      "publishable key blank",
      { [CLERK_PUBLISHABLE_KEY_ENV_VAR]: "  " },
      [CLERK_PUBLISHABLE_KEY_ENV_VAR],
      [CLERK_SECRET_KEY_ENV_VAR],
    ],
    [
      "secret key absent",
      { [CLERK_SECRET_KEY_ENV_VAR]: undefined },
      [CLERK_SECRET_KEY_ENV_VAR],
      [CLERK_PUBLISHABLE_KEY_ENV_VAR],
    ],
    [
      "secret key blank",
      { [CLERK_SECRET_KEY_ENV_VAR]: "\t" },
      [CLERK_SECRET_KEY_ENV_VAR],
      [CLERK_PUBLISHABLE_KEY_ENV_VAR],
    ],
    [
      "both absent",
      {
        [CLERK_PUBLISHABLE_KEY_ENV_VAR]: undefined,
        [CLERK_SECRET_KEY_ENV_VAR]: undefined,
      },
      [CLERK_PUBLISHABLE_KEY_ENV_VAR, CLERK_SECRET_KEY_ENV_VAR],
      [],
    ],
  ]

  it.each(cases)(
    "%s logs exactly one warning naming each missing variable",
    (_label, override, missing, present) => {
      const logger = capturingLogger()

      const resolved = resolveConfig(configuredEnv(override), logger)

      expect(logger.messages).toEqual([missingClerkKeysWarning(missing)])
      const warning = logger.messages[0]
      for (const variable of missing) {
        expect(warning).toContain(variable)
      }
      /*
       * A key that is set is not named, and no key *value* is named either —
       * neither the secret key (Requirement 5.10 restated) nor the publishable
       * one, which the message has no reason to quote.
       */
      for (const variable of present) {
        expect(logger.naming(variable)).toEqual([])
      }
      expect(warning).not.toContain("pk_test_zzz_publishable")
      expect(warning).not.toContain("sk_test_zzz_secret")
      expect(linesLoggedAfterStartup(logger, resolved)).toEqual([])
    }
  )

  it("completes startup rather than throwing", () => {
    expect(() =>
      resolveConfig(
        configuredEnv({
          [CLERK_PUBLISHABLE_KEY_ENV_VAR]: undefined,
          [CLERK_SECRET_KEY_ENV_VAR]: undefined,
        }),
        capturingLogger()
      )
    ).not.toThrow()
  })
})

describe("empty Admin_Allowlist (Requirement 6.9)", () => {
  const cases: ReadonlyArray<readonly [string, string | undefined]> = [
    ["absent", undefined],
    ["empty", ""],
    ["whitespace-only", "  \t "],
    ["separators only", " , , "],
    ["no surviving element", "no-at-sign, also-no-at-sign"],
  ]

  it.each(cases)(
    "%s ADMIN_EMAILS logs exactly one startup warning",
    (_label, raw) => {
      const logger = capturingLogger()

      const resolved = resolveConfig(
        configuredEnv({ [ADMIN_EMAILS_ENV_VAR]: raw }),
        logger
      )

      expect(logger.messages).toEqual([EMPTY_ADMIN_ALLOWLIST_WARNING])
      expect(logger.naming(ADMIN_EMAILS_ENV_VAR)).toHaveLength(1)
      // Logged during startup only: reading the allowlist later logs nothing.
      expect(linesLoggedAfterStartup(logger, resolved)).toEqual([])
    }
  )

  it("logs nothing once the allowlist holds one element", () => {
    const logger = capturingLogger()

    resolveConfig(
      configuredEnv({ [ADMIN_EMAILS_ENV_VAR]: " Owner@Example.COM " }),
      logger
    )

    expect(logger.messages).toEqual([])
  })

  it("completes startup rather than throwing", () => {
    expect(() =>
      resolveConfig(
        configuredEnv({ [ADMIN_EMAILS_ENV_VAR]: undefined }),
        capturingLogger()
      )
    ).not.toThrow()
  })
})

describe("several unset variables each log their own single warning", () => {
  it("logs one line per condition and nothing afterwards", () => {
    const logger = capturingLogger()

    const resolved = resolveConfig({}, logger)

    expect(logger.messages).toEqual([
      NO_PASSPHRASE_WARNING,
      NO_MONGODB_URI_WARNING,
      missingClerkKeysWarning([
        CLERK_PUBLISHABLE_KEY_ENV_VAR,
        CLERK_SECRET_KEY_ENV_VAR,
      ]),
      EMPTY_ADMIN_ALLOWLIST_WARNING,
    ])
    expect(linesLoggedAfterStartup(logger, resolved)).toEqual([])
  })
})

describe("secrets leak nowhere (Requirement 8.10)", () => {
  const PASSPHRASE = "zzz-distinctive-passphrase-9f3a1c-zzz"
  const SESSION_SECRET = "zzz-distinctive-session-secret-4b7e-zzz"

  function resolveWithSecrets() {
    const logger = capturingLogger()
    const resolved = resolveConfig(
      configuredEnv({
        APP_PASSPHRASE: PASSPHRASE,
        SESSION_SECRET,
        [MOCK_MODE_ENV_VAR]: "TRUEISH",
      }),
      logger
    )
    return { logger, resolved }
  }

  it("appears in no captured log line, not even the rejected-value warning", () => {
    const { logger } = resolveWithSecrets()

    expect(logger.messages).not.toHaveLength(0)
    for (const message of logger.messages) {
      expect(message).not.toContain(PASSPHRASE)
      expect(message).not.toContain(SESSION_SECRET)
    }
  })

  it("appears nowhere in the serialized config, client config, or resolved value", () => {
    const { resolved } = resolveWithSecrets()

    const serialized = [
      JSON.stringify(resolved.config),
      JSON.stringify(toClientConfig(resolved.config)),
      JSON.stringify(resolved),
    ]

    for (const form of serialized) {
      expect(form).not.toContain(PASSPHRASE)
      expect(form).not.toContain(SESSION_SECRET)
    }
  })

  it("serializes the secret accessors to an empty object", () => {
    const { resolved } = resolveWithSecrets()

    expect(JSON.stringify(resolved)).toContain('"secrets":{}')
  })

  it("keeps the secrets reachable through the server-only accessors", () => {
    const { resolved } = resolveWithSecrets()

    expect(resolved.secrets.readSharedPassphrase()).toBe(PASSPHRASE)
    expect(resolved.secrets.readSessionSecret()).toBe(SESSION_SECRET)
  })

  it("exposes only the Mock_Mode flag to the Web_Client", () => {
    const { resolved } = resolveWithSecrets()

    expect(Object.keys(toClientConfig(resolved.config))).toEqual(["mockMode"])
  })
})

describe("defaults and the generated session key", () => {
  it("falls back to the documented defaults when the variables are absent", () => {
    const { config } = resolveConfig({}, capturingLogger())

    expect(config.upstreamBaseUrl).toBe(DEFAULT_UPSTREAM_BASE_URL)
    expect(config.dataFile).toBe(DEFAULT_DATA_FILE)
  })

  it("treats a whitespace-only value as absent", () => {
    const { config } = resolveConfig(
      { UPSTREAM_BASE_URL: "   ", DATA_FILE: "\t" },
      capturingLogger()
    )

    expect(config.upstreamBaseUrl).toBe(DEFAULT_UPSTREAM_BASE_URL)
    expect(config.dataFile).toBe(DEFAULT_DATA_FILE)
  })

  it("generates a non-empty session key when SESSION_SECRET is absent", () => {
    const resolved = resolveConfig({}, capturingLogger())

    expect(resolved.sessionSecretGenerated).toBe(true)
    expect(resolved.secrets.readSessionSecret().length).toBeGreaterThan(0)
  })

  it("generates a different key per resolution, so Sessions die on restart", () => {
    const first = resolveConfig({}, capturingLogger())
    const second = resolveConfig({}, capturingLogger())

    expect(first.secrets.readSessionSecret()).not.toBe(
      second.secrets.readSessionSecret()
    )
  })

  it("uses the supplied SESSION_SECRET when one is set", () => {
    const resolved = resolveConfig(
      { SESSION_SECRET: " signing-key " },
      capturingLogger()
    )

    expect(resolved.sessionSecretGenerated).toBe(false)
    expect(resolved.secrets.readSessionSecret()).toBe("signing-key")
  })
})
