import { describe, expect, it } from "vitest"
import {
  StubScriptExhaustedError,
  StubScriptedThrowError,
  StubUpstreamClient,
  respondWithBody,
  respondWithTransportFailure,
  throwOnCall,
} from "../support/stubUpstreamClient"

/**
 * The stub is test infrastructure the run-loop properties depend on, so its own
 * recording behaviour is pinned here: replay order, request recording, the
 * scripted throw, script exhaustion, and the in-flight counter.
 */
describe("StubUpstreamClient", () => {
  it("replays the script in order and records every request", async () => {
    const client = new StubUpstreamClient({
      script: [
        respondWithBody('{"retCode":100}'),
        respondWithTransportFailure("timeout"),
      ],
    })

    const first = await client.useCoupon({ hiveid: "a", coupon: "C1" })
    const second = await client.useCoupon({ hiveid: "b", coupon: "C1" })

    expect(first).toEqual({
      bodyText: '{"retCode":100}',
      status: 200,
      transportFailure: null,
    })
    expect(second).toEqual({
      bodyText: null,
      status: null,
      transportFailure: "timeout",
    })
    expect(client.requests).toEqual([
      { hiveid: "a", coupon: "C1" },
      { hiveid: "b", coupon: "C1" },
    ])
    expect(client.callCount).toBe(2)
    expect(client.maxInFlight).toBe(1)
    expect(client.isMock).toBe(false)
  })

  it("throws on a scripted throw entry, after recording the request", async () => {
    const client = new StubUpstreamClient({ script: [throwOnCall()] })

    await expect(
      client.useCoupon({ hiveid: "a", coupon: "C1" })
    ).rejects.toBeInstanceOf(StubScriptedThrowError)
    expect(client.requests).toEqual([{ hiveid: "a", coupon: "C1" }])
    expect(client.inFlight).toBe(0)
  })

  it("fails loudly when the run issues more calls than the script holds", async () => {
    const client = new StubUpstreamClient({
      script: [respondWithBody('{"retCode":100}')],
    })

    await client.useCoupon({ hiveid: "a", coupon: "C1" })
    expect(client.remainingScriptLength).toBe(0)

    await expect(
      client.useCoupon({ hiveid: "b", coupon: "C1" })
    ).rejects.toBeInstanceOf(StubScriptExhaustedError)
    expect(client.callCount).toBe(2)
  })

  it("observes overlapping calls in maxInFlight", async () => {
    const client = new StubUpstreamClient({
      isMock: true,
      script: [respondWithBody("{}"), respondWithBody("{}")],
    })

    await Promise.all([
      client.useCoupon({ hiveid: "a", coupon: "C1" }),
      client.useCoupon({ hiveid: "b", coupon: "C1" }),
    ])

    expect(client.maxInFlight).toBe(2)
    expect(client.inFlight).toBe(0)
    expect(client.isMock).toBe(true)
  })
})
