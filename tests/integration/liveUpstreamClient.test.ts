import { afterEach, describe, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import type { Server, ServerResponse } from "node:http"
import {
  FIXED_REQUEST_FIELDS,
  LiveUpstreamClient,
  UPSTREAM_TIMEOUT_MS,
  USE_COUPON_CONTENT_TYPE,
  USE_COUPON_PATH,
  createLiveUpstreamClient,
} from "@/server/upstream/live.server"

/**
 * Integration tests for `LiveUpstreamClient` against a real local HTTP server
 * (Requirements 3.3, 3.6).
 *
 * Nothing is mocked on the transport path: every request below travels over a
 * loopback TCP connection to a `node:http` server bound to an ephemeral port,
 * so the URL-encoded body is genuinely serialized by the client and genuinely
 * parsed by the server. That is what makes the round trip evidence rather than
 * a restatement of the client's own code.
 *
 * Every server started here is registered in `openServers` and closed in
 * `afterEach`, connections included, so no socket keeps the test process alive.
 */

/** What the local server saw for one request. */
interface ObservedRequest {
  readonly method: string
  readonly url: string
  readonly contentType: string | undefined
  /** URL-encoded body exactly as it arrived. */
  readonly rawBody: string
}

interface TestServer {
  readonly baseUrl: string
  readonly requests: ReadonlyArray<ObservedRequest>
}

/** Decides what the local server does with a fully received request. */
type Responder = (res: ServerResponse, observed: ObservedRequest) => void

const openServers: Array<Server> = []

/** Swallows the socket error that a client-side abort raises server-side. */
function ignore(): void {
  // An abandoned request is expected in the timeout test; nothing to do.
}

/** Starts a loopback server on an ephemeral port and records every request. */
async function startServer(respond: Responder): Promise<TestServer> {
  const requests: Array<ObservedRequest> = []

  const server = createServer((req, res) => {
    req.on("error", ignore)
    res.on("error", ignore)

    const chunks: Array<Buffer> = []
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk)
    })
    req.on("end", () => {
      const observed: ObservedRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        contentType: req.headers["content-type"],
        rawBody: Buffer.concat(chunks).toString("utf8"),
      }
      requests.push(observed)
      respond(res, observed)
    })
  })

  openServers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })

  return { baseUrl: `http://127.0.0.1:${portOf(server)}`, requests }
}

/** Reads the bound TCP port, rejecting the pipe/absent-address cases. */
function portOf(server: Server): number {
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("the test server did not bind to a TCP port")
  }
  return address.port
}

/** A port that was bound and then released, so nothing listens on it. */
async function unreachablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  const port = portOf(server)
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
  return port
}

/**
 * Returns the single observed request, and fails when the count is anything
 * other than one — which is how "no repeat request" is asserted.
 */
function onlyRequest(server: TestServer): ObservedRequest {
  if (server.requests.length !== 1) {
    throw new Error(
      `expected exactly one upstream request, observed ${server.requests.length}`
    )
  }
  return server.requests[0]
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

afterEach(async () => {
  vi.restoreAllMocks()
  const servers = openServers.splice(0, openServers.length)
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        })
    )
  )
})

describe("the five request fields reach the endpoint (Requirement 3.3)", () => {
  const SUCCESS_BODY =
    '{"retCode":100,"retMsg":"The coupon gift has been sent."}'

  /*
   * Both values carry a space, `&`, `+`, `%`, `=` and non-ASCII characters, so
   * a missing or double encoding on either side changes what the server reads
   * back and the round trip is real evidence rather than a coincidence.
   */
  const HIVE_ID = "hive id+plus&amp=eq%25pct café 日本"
  const COUPON = "GIFT A&B+C%20D=E ünïcode 🎁"

  async function echoServer(): Promise<TestServer> {
    return startServer((res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(SUCCESS_BODY)
    })
  }

  it("posts country, lang, server, hiveid, and coupon to /useCoupon", async () => {
    const server = await echoServer()
    const client = new LiveUpstreamClient({ baseUrl: server.baseUrl })

    await client.useCoupon({ hiveid: HIVE_ID, coupon: COUPON })

    const observed = onlyRequest(server)
    expect(observed.method).toBe("POST")
    expect(observed.url.endsWith(`/${USE_COUPON_PATH}`)).toBe(true)
    expect(observed.contentType).toBe(USE_COUPON_CONTENT_TYPE)

    const fields = new URLSearchParams(observed.rawBody)
    expect([...fields.keys()]).toEqual([
      "country",
      "lang",
      "server",
      "hiveid",
      "coupon",
    ])
    expect(fields.get("country")).toBe(FIXED_REQUEST_FIELDS.country)
    expect(fields.get("lang")).toBe(FIXED_REQUEST_FIELDS.lang)
    expect(fields.get("server")).toBe(FIXED_REQUEST_FIELDS.server)
    expect(fields.get("hiveid")).toBe(HIVE_ID)
    expect(fields.get("coupon")).toBe(COUPON)
  })

  it("returns the raw body text unchanged with its status and no failure", async () => {
    const server = await echoServer()
    const client = createLiveUpstreamClient({ baseUrl: server.baseUrl })

    const result = await client.useCoupon({ hiveid: HIVE_ID, coupon: COUPON })

    expect(result).toEqual({
      bodyText: SUCCESS_BODY,
      status: 200,
      transportFailure: null,
    })
  })

  it("appends the path to a base URL that already carries one", async () => {
    const server = await echoServer()
    const client = new LiveUpstreamClient({
      baseUrl: `${server.baseUrl}/ci/smon/evt_coupon/`,
    })

    await client.useCoupon({ hiveid: HIVE_ID, coupon: COUPON })

    expect(onlyRequest(server).url).toBe(
      `/ci/smon/evt_coupon/${USE_COUPON_PATH}`
    )
  })

  it("returns a non-2xx response as a response, not as a failure", async () => {
    const server = await startServer((res) => {
      res.writeHead(503, { "content-type": "text/plain" })
      res.end("upstream is busy")
    })
    const client = new LiveUpstreamClient({ baseUrl: server.baseUrl })

    const result = await client.useCoupon({
      hiveid: HIVE_ID,
      coupon: COUPON,
    })

    expect(result).toEqual({
      bodyText: "upstream is busy",
      status: 503,
      transportFailure: null,
    })
    onlyRequest(server)
  })
})

/*
 * Requirement 3.6 fixes the limit at 10 seconds. Driving a real ten-second wait
 * would make this file the slowest thing in the suite, so the requirement is
 * pinned in two halves that together cover it:
 *
 *   - the *behaviour* half points the client at a server that never responds
 *     and injects a short `timeoutMs`, proving the request is abandoned with
 *     `transportFailure: 'timeout'` and never repeated;
 *   - the *duration* half asserts that the exported default is exactly
 *     10_000 ms and that a client constructed without `timeoutMs` arms its
 *     abort with that value.
 *
 * Neither half alone pins the requirement; both together do, in milliseconds.
 */
describe("a request that gets no response is abandoned (Requirement 3.6)", () => {
  const SHORT_TIMEOUT_MS = 150

  /** A fetch that resolves at once, for the timeout-wiring assertions. */
  const instantFetch = async () => ({ status: 200, text: async () => "{}" })

  it("reports a timeout and issues no repeat request", async () => {
    const server = await startServer((res) => {
      // Hold the request open: the header is set, the response never ends.
      res.setHeader("x-held-open", "true")
    })
    const client = new LiveUpstreamClient({
      baseUrl: server.baseUrl,
      timeoutMs: SHORT_TIMEOUT_MS,
    })

    const result = await client.useCoupon({ hiveid: "hive-1", coupon: "GIFT" })

    expect(result).toEqual({
      bodyText: null,
      status: null,
      transportFailure: "timeout",
    })

    // Leave a retry, if one existed, ample time to reach the server.
    await delay(SHORT_TIMEOUT_MS * 3)
    expect(onlyRequest(server).method).toBe("POST")
  })

  it("keeps the default limit at the 10 seconds of the requirement", () => {
    expect(UPSTREAM_TIMEOUT_MS).toBe(10_000)
  })

  it("arms the default limit when no timeoutMs is supplied", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout")
    const client = new LiveUpstreamClient({
      baseUrl: "http://127.0.0.1:1",
      fetch: instantFetch,
    })

    await client.useCoupon({ hiveid: "hive-1", coupon: "GIFT" })

    expect(timeoutSpy.mock.calls).toEqual([[10_000]])
  })

  it("arms the injected limit when timeoutMs is supplied", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout")
    const client = new LiveUpstreamClient({
      baseUrl: "http://127.0.0.1:1",
      fetch: instantFetch,
      timeoutMs: SHORT_TIMEOUT_MS,
    })

    await client.useCoupon({ hiveid: "hive-1", coupon: "GIFT" })

    expect(timeoutSpy.mock.calls).toEqual([[SHORT_TIMEOUT_MS]])
  })
})

describe("an unreachable endpoint", () => {
  it("reports a network failure after exactly one attempt", async () => {
    const port = await unreachablePort()
    let attempts = 0
    const client = new LiveUpstreamClient({
      baseUrl: `http://127.0.0.1:${port}`,
      fetch: (url, init) => {
        attempts += 1
        return fetch(url, init)
      },
    })

    const result = await client.useCoupon({ hiveid: "hive-1", coupon: "GIFT" })

    expect(result).toEqual({
      bodyText: null,
      status: null,
      transportFailure: "network",
    })
    expect(attempts).toBe(1)
  })
})
