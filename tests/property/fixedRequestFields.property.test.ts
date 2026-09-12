// Feature: shared-coupon-redemption, Property 8: Every upstream request carries
// the Fixed_Request_Fields — for any Coupon_Code of 1 to 64 characters and any
// enabled Group_Member, the request the Redemption_Server issues holds `country`
// equal to `FR`, `lang` equal to `en`, `server` equal to `europe`, `hiveid`
// equal to that Group_Member's Hive_ID, and `coupon` equal to the submitted
// Coupon_Code.
//
// Validates: Requirements 3.3.
//
// The subject is `LiveUpstreamClient.useCoupon`, driven with an injected
// capturing `fetch` so the request is inspected exactly as it would leave the
// process: one call, a POST to `${baseUrl}/useCoupon`, and a URL-encoded body
// read back with `URLSearchParams`. Nothing here reaches the network — the
// global `fetch` is replaced by a counter that fails the test if it is ever
// touched.
//
// The three fixed values are asserted twice: against the exported
// `FIXED_REQUEST_FIELDS` constants, and against the literal strings `"FR"`,
// `"en"`, and `"europe"`. The literals are the requirement; the constant is one
// implementation of it, and editing the constant must not be able to satisfy
// this test on its own.

import fc from "fast-check"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  FIXED_REQUEST_FIELDS,
  USE_COUPON_PATH,
  createLiveUpstreamClient,
} from "@/server/upstream/live.server"
import type {
  UpstreamFetch,
  UpstreamFetchInit,
} from "@/server/upstream/live.server"

import {
  FIXTURE_BODIES,
  validCouponCodeArb,
  validHiveIdArb,
} from "./generators"

/** The five request field names of Requirement 3.3, and nothing else. */
const REQUEST_FIELD_NAMES = [
  "country",
  "lang",
  "server",
  "hiveid",
  "coupon",
] as const

/** The three Fixed_Request_Field names, restated from the requirement. */
const FIXED_FIELD_NAMES = ["country", "lang", "server"] as const

/**
 * The fixed values, restated as literals so the assertion is pinned to
 * Requirement 3.3 rather than to whatever the constant currently holds.
 */
const FIXED_FIELD_LITERALS: Readonly<Record<string, string>> = Object.freeze({
  country: "FR",
  lang: "en",
  server: "europe",
})

/** One captured request. */
interface CapturedCall {
  readonly url: string
  readonly init: UpstreamFetchInit
}

/** A `fetch` stand-in that records every call and never opens a socket. */
function createCapturingFetch(): {
  readonly fetch: UpstreamFetch
  readonly calls: CapturedCall[]
} {
  const calls: CapturedCall[] = []
  const fetchFn: UpstreamFetch = (url, init) => {
    calls.push({ url, init })
    return Promise.resolve({
      status: 200,
      text: () => Promise.resolve(FIXTURE_BODIES["success-100.json"]),
    })
  }
  return { fetch: fetchFn, calls }
}

/**
 * Values built to break a naive body builder: an ampersand or an equals sign
 * would end a field early, a plus sign and a percent sign are decoded on the
 * far side, and a literal `country=US` fragment is an attempt to append a sixth
 * pair that overrides a Fixed_Request_Field. The shared arbitraries already
 * produce every printable ASCII character and non-ASCII text; these add the
 * shapes that matter for encoding, including interior whitespace.
 */
const ADVERSARIAL_VALUES = [
  "a b c",
  "a&b",
  "a+b",
  "100%",
  "a=b",
  "x&country=US",
  "&lang=fr&server=asia",
  "?coupon=other#frag",
  "é ü 日本語 😀",
  "  padded value  ",
  "\n\tmixed\r\n",
  "a/b\\c",
  "\u0000nul",
] as const

/** A Coupon_Code or Hive_ID: the shared arbitrary, plus the tricky literals. */
function fieldValueArb(base: fc.Arbitrary<string>): fc.Arbitrary<string> {
  return fc.oneof(
    { weight: 4, arbitrary: base },
    { weight: 2, arbitrary: fc.constantFrom(...ADVERSARIAL_VALUES) }
  )
}

/** Base URLs, with and without a path segment, none with a trailing slash. */
const baseUrlArb: fc.Arbitrary<string> = fc.constantFrom(
  "https://event.withhive.com/ci/smon/evt_coupon",
  "https://example.test",
  "http://127.0.0.1:8080/upstream"
)

/** Counts any attempt to use the real `fetch`, which no code path may make. */
let globalFetchCalls = 0
let realFetch: typeof globalThis.fetch

beforeEach(() => {
  globalFetchCalls = 0
  realFetch = globalThis.fetch
  globalThis.fetch = () => {
    globalFetchCalls += 1
    return Promise.reject(new Error("the global fetch must not be called"))
  }
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe("Property 8: every upstream request carries the Fixed_Request_Fields", () => {
  it("posts the five fields, with FR / en / europe fixed and hiveid / coupon verbatim", async () => {
    await fc.assert(
      fc.asyncProperty(
        baseUrlArb,
        fieldValueArb(validCouponCodeArb),
        fieldValueArb(validHiveIdArb),
        async (baseUrl, coupon, hiveid) => {
          const captured = createCapturingFetch()
          const client = createLiveUpstreamClient({
            baseUrl,
            fetch: captured.fetch,
          })

          await client.useCoupon({ coupon, hiveid })

          // Requirement 3.4: exactly one request per Group_Member.
          expect(captured.calls).toHaveLength(1)
          const call = captured.calls[0]

          expect(call.url).toBe(`${baseUrl}/${USE_COUPON_PATH}`)
          expect(call.url).toBe(`${baseUrl}/useCoupon`)
          expect(call.init.method).toBe("POST")

          const params = new URLSearchParams(call.init.body)

          // Exactly the five field names, each carrying exactly one value, so
          // no generated input can smuggle a sixth pair in.
          expect([...params.keys()].sort()).toStrictEqual(
            [...REQUEST_FIELD_NAMES].sort()
          )
          for (const name of REQUEST_FIELD_NAMES) {
            expect(params.getAll(name)).toHaveLength(1)
          }

          for (const name of FIXED_FIELD_NAMES) {
            // Against the exported constant...
            expect(params.get(name)).toBe(FIXED_REQUEST_FIELDS[name])
            // ...and against the literal the requirement names.
            expect(params.get(name)).toBe(FIXED_FIELD_LITERALS[name])
          }

          // Byte-for-byte, so the URL encoding round-trips whatever the
          // Group_Member and the Coupon_Code hold.
          expect(params.get("hiveid")).toBe(hiveid)
          expect(params.get("coupon")).toBe(coupon)

          expect(globalFetchCalls).toBe(0)
        }
      ),
      { numRuns: 100 }
    )
  })
})
