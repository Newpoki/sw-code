import { describe, expect, it } from "vitest"
import {
  DEFAULT_DATA_FILE,
  DEFAULT_UPSTREAM_BASE_URL,
  MOCK_MODE_ENV_VAR,
  NO_PASSPHRASE_WARNING,
  resolveConfig,
  toClientConfig,
} from "@/server/config.server"
import type { ConfigLogger, EnvRecord } from "@/server/config.server"

/**
 * Startup warning tests for `config.server.ts` (Requirements 7.7, 8.9, 8.10).
 *
 * Every case injects its own environment record and its own logger, so no test
 * touches `process.env` and none spies on the global console: the assertions
 * read the captured lines directly.
 */

interface CapturingLogger extends ConfigLogger {
  readonly messages: string[]
  /** Only the lines that name the Mock_Mode variable. */
  mockModeWarnings: () => string[]
}

function capturingLogger(): CapturingLogger {
  const messages: string[] = []
  return {
    messages,
    warn: (message: string) => {
      messages.push(message)
    },
    mockModeWarnings: () =>
      messages.filter((message) => message.includes(MOCK_MODE_ENV_VAR)),
  }
}

/** An environment whose passphrase is set, so only Mock_Mode warnings appear. */
function envWithPassphrase(extra: EnvRecord = {}): EnvRecord {
  return { APP_PASSPHRASE: "correct horse battery staple", ...extra }
}

describe("unrecognized MOCK_MODE value (Requirement 7.7)", () => {
  const rejected = ["yes", "1", "TRUEISH", "0", "on", "false ish"]

  it.each(rejected)(
    "logs exactly one warning naming the variable and the value %o",
    (raw) => {
      const logger = capturingLogger()

      const { config } = resolveConfig(
        envWithPassphrase({ [MOCK_MODE_ENV_VAR]: raw }),
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
      resolveConfig(envWithPassphrase({ [MOCK_MODE_ENV_VAR]: "yes" }), logger)
    ).not.toThrow()
  })

  it("still resolves every other value, so the rest of startup is unaffected", () => {
    const logger = capturingLogger()

    const { config } = resolveConfig(
      envWithPassphrase({
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
    })
  })
})

describe("recognized MOCK_MODE values log no warning (Requirement 7.5)", () => {
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

  it.each(cases)("%s", (_label, raw, expected) => {
    const logger = capturingLogger()

    const { config } = resolveConfig(
      envWithPassphrase({ [MOCK_MODE_ENV_VAR]: raw }),
      logger
    )

    expect(logger.mockModeWarnings()).toEqual([])
    expect(logger.messages).toEqual([])
    expect(config.mockMode).toBe(expected)
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

      const { config, secrets } = resolveConfig({ APP_PASSPHRASE: raw }, logger)

      expect(logger.messages).toContain(NO_PASSPHRASE_WARNING)
      expect(config.passphraseRequired).toBe(false)
      expect(secrets.readSharedPassphrase()).toBeNull()
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
    })
  })
})

describe("a configured Shared_Passphrase logs no warning", () => {
  it("sets passphraseRequired and stays silent", () => {
    const logger = capturingLogger()

    const { config } = resolveConfig({ APP_PASSPHRASE: "  s3cret  " }, logger)

    expect(logger.messages).toEqual([])
    expect(config.passphraseRequired).toBe(true)
  })

  it("trims the passphrase before it becomes the Shared_Passphrase", () => {
    const { secrets } = resolveConfig(
      { APP_PASSPHRASE: "  s3cret  " },
      capturingLogger()
    )

    expect(secrets.readSharedPassphrase()).toBe("s3cret")
  })
})

describe("secrets leak nowhere (Requirement 8.10)", () => {
  const PASSPHRASE = "zzz-distinctive-passphrase-9f3a1c-zzz"
  const SESSION_SECRET = "zzz-distinctive-session-secret-4b7e-zzz"

  function resolveWithSecrets() {
    const logger = capturingLogger()
    const resolved = resolveConfig(
      {
        APP_PASSPHRASE: PASSPHRASE,
        SESSION_SECRET,
        [MOCK_MODE_ENV_VAR]: "TRUEISH",
      },
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
