/**
 * The client-visible configuration projection (Requirements 7.4, 7.8, 8.10).
 *
 * These exercise `appConfigEnvelope` from
 * `src/functions/config.functions.ts` directly, over a configuration produced by
 * `resolveConfig` from an injected environment record: no `createServerFn` call
 * site, no HTTP, and no read of `process.env`. Each case supplies its own
 * logger, so no startup warning reaches the global console.
 */

import { describe, expect, it } from "vitest"

import { appConfigEnvelope, getAppConfig } from "@/functions/config.functions"
import { resolveConfig } from "@/server/config.server"
import type {
  ConfigLogger,
  EnvRecord,
  ServerConfig,
} from "@/server/config.server"

/** A logger that swallows the startup warnings these cases provoke. */
function silentLogger(): ConfigLogger {
  return { warn: () => {} }
}

function configFrom(env: EnvRecord): ServerConfig {
  return resolveConfig(env, silentLogger()).config
}

/** Distinctive values, so a leak into the envelope is unmistakable. */
const PASSPHRASE = "zzz-distinctive-passphrase-9f3a1c-zzz"
const SESSION_SECRET = "zzz-distinctive-session-secret-4b7e-zzz"
const UPSTREAM_BASE_URL = "https://zzz-distinctive-upstream-6d2f-zzz/evt"
const DATA_FILE = "./zzz-distinctive-data-file-1a8b-zzz/store.json"

/** A fully populated server configuration, secrets and all. */
function loadedConfig(mockMode: string): ServerConfig {
  return configFrom({
    APP_PASSPHRASE: PASSPHRASE,
    SESSION_SECRET,
    UPSTREAM_BASE_URL,
    DATA_FILE,
    MOCK_MODE: mockMode,
  })
}

describe("appConfigEnvelope exposes the Mock_Mode flag alone (Requirements 7.4, 7.8)", () => {
  it("carries exactly the mockMode key and nothing else", () => {
    const envelope = appConfigEnvelope(loadedConfig("true"))

    expect(envelope.ok).toBe(true)
    if (!envelope.ok) return
    expect(Object.keys(envelope.data)).toEqual(["mockMode"])
  })

  it("reports Mock_Mode enabled when the environment enables it", () => {
    const envelope = appConfigEnvelope(loadedConfig("true"))

    expect(envelope).toEqual({
      ok: true,
      data: { mockMode: true },
      warnings: [],
    })
  })

  it("reports Mock_Mode disabled when the environment disables it", () => {
    const envelope = appConfigEnvelope(loadedConfig("false"))

    expect(envelope).toEqual({
      ok: true,
      data: { mockMode: false },
      warnings: [],
    })
  })

  it("is a read, so it succeeds with no warning", () => {
    const envelope = appConfigEnvelope(configFrom({}))

    expect(envelope.ok).toBe(true)
    if (!envelope.ok) return
    expect(envelope.warnings).toEqual([])
  })

  it("exposes getAppConfig as the server function for the root route loader", () => {
    expect(typeof getAppConfig).toBe("function")
  })
})

describe("no secret and no other server value reaches the Web_Client (Requirement 8.10)", () => {
  const withheld = [
    PASSPHRASE,
    SESSION_SECRET,
    UPSTREAM_BASE_URL,
    DATA_FILE,
    "passphraseRequired",
  ]

  it.each(withheld)("the serialized envelope contains no %s", (value) => {
    const serialized = JSON.stringify(appConfigEnvelope(loadedConfig("true")))

    expect(serialized).not.toContain(value)
  })

  it("serializes to the Mock_Mode flag and the envelope frame only", () => {
    const serialized = JSON.stringify(appConfigEnvelope(loadedConfig("true")))

    expect(serialized).toBe(
      '{"ok":true,"data":{"mockMode":true},"warnings":[]}'
    )
  })

  it("withholds every field of the server configuration except mockMode", () => {
    const config = loadedConfig("true")
    const envelope = appConfigEnvelope(config)

    expect(envelope.ok).toBe(true)
    if (!envelope.ok) return
    const exposed = Object.keys(envelope.data)
    for (const key of Object.keys(config)) {
      if (key !== "mockMode") {
        expect(exposed).not.toContain(key)
      }
    }
  })
})
