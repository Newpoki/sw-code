import { afterEach, describe, expect, it } from "vitest"
import {
  checkUpstreamFixtures,
  createUpstreamClient,
  getUpstreamClient,
  resetUpstreamClient,
  setUpstreamClient,
} from "@/server/upstream/factory.server"
import { LiveUpstreamClient } from "@/server/upstream/live.server"
import { MockUpstreamClient } from "@/server/upstream/mock.server"
import { serverConfig } from "@/server/config.server"
import { StubUpstreamClient } from "../support/stubUpstreamClient"

import type { UpstreamClientConfig } from "@/server/upstream/factory.server"

/**
 * Unit tests for the Upstream_API client factory (Requirements 7.5, 7.11).
 *
 * The selection is exercised through the pure {@link createUpstreamClient},
 * which takes the Mock_Mode flag as a parameter, so no test mutates
 * `process.env`. The singleton tests only assert identity and the seam
 * behaviour, which holds whatever `MOCK_MODE` the runtime happens to carry.
 */

/** A config literal with Mock_Mode set as the case needs it. */
function config(mockMode: boolean): UpstreamClientConfig {
  return { mockMode, upstreamBaseUrl: "https://upstream.invalid/evt_coupon" }
}

afterEach(() => {
  resetUpstreamClient()
})

describe("createUpstreamClient selects from the Mock_Mode state (Requirement 7.5)", () => {
  it("builds a MockUpstreamClient reporting isMock true when Mock_Mode is enabled", () => {
    const client = createUpstreamClient(config(true))

    expect(client).toBeInstanceOf(MockUpstreamClient)
    expect(client.isMock).toBe(true)
  })

  it("builds a LiveUpstreamClient reporting isMock false when Mock_Mode is disabled", () => {
    const client = createUpstreamClient(config(false))

    expect(client).toBeInstanceOf(LiveUpstreamClient)
    expect(client.isMock).toBe(false)
  })

  it("ignores the fixture directory when Mock_Mode is disabled (Requirement 7.11)", () => {
    const client = createUpstreamClient(config(false), {
      fixtureDir: "/nonexistent/fixtures/upstream",
    })

    expect(client).toBeInstanceOf(LiveUpstreamClient)
  })

  it("passes the fixture directory through in Mock_Mode", () => {
    const fixtureDir = "/tmp/fixtures/upstream"

    const client = createUpstreamClient(config(true), { fixtureDir })

    expect(client).toBeInstanceOf(MockUpstreamClient)
    if (client instanceof MockUpstreamClient) {
      expect(client.fixtureDir).toBe(fixtureDir)
    }
  })
})

describe("the process-wide client is created once", () => {
  it("returns the same instance from repeated calls", () => {
    const first = getUpstreamClient()
    const second = getUpstreamClient()

    expect(second).toBe(first)
  })

  it("matches the Mock_Mode state read at startup", () => {
    expect(getUpstreamClient().isMock).toBe(serverConfig.mockMode)
  })

  it("returns the installed client after setUpstreamClient", () => {
    const stub = new StubUpstreamClient({ isMock: true })

    setUpstreamClient(stub)

    expect(getUpstreamClient()).toBe(stub)
    expect(getUpstreamClient().isMock).toBe(true)
  })

  it("rebuilds after resetUpstreamClient", () => {
    const stub = new StubUpstreamClient()
    setUpstreamClient(stub)

    resetUpstreamClient()
    const rebuilt = getUpstreamClient()

    expect(rebuilt).not.toBe(stub)
    expect(getUpstreamClient()).toBe(rebuilt)
  })
})

describe("checkUpstreamFixtures reads no fixture outside Mock_Mode (Requirement 7.11)", () => {
  it("reports success for the live client without touching the filesystem", async () => {
    const client = createUpstreamClient(config(false), {
      fixtureDir: "/nonexistent/fixtures/upstream",
    })

    await expect(checkUpstreamFixtures(client)).resolves.toEqual({ ok: true })
  })

  it("reports the absent fixture for a Mock_Mode client (Requirement 7.6)", async () => {
    const client = createUpstreamClient(config(true), {
      fixtureDir: "/nonexistent/fixtures/upstream",
    })

    const check = await checkUpstreamFixtures(client)

    expect(check.ok).toBe(false)
    if (!check.ok) {
      expect(check.code).toBe("FIXTURE_UNAVAILABLE")
      expect(check.reason).toBe("absent")
    }
  })
})
