/**
 * The Access_Gate end to end (Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.7, 8.8,
 * 8.9, 8.10).
 *
 * The three pieces of the gate are each covered on their own already:
 * `tests/unit/gateDecision.test.ts` pins the decision on hand-picked examples,
 * `tests/property/accessGate.property.test.ts` pins it over generated input, and
 * `tests/unit/loginRoute.test.ts` exercises the `/login` and `/logout` handlers
 * in isolation. What none of them covers is the **sequence**: submit, obtain a
 * Session, make a gated call that was previously refused, end the Session, and
 * find the same call refused again. That is what this file is for.
 *
 * ## How a "gated call" is simulated
 *
 * {@link gatedCall} is a transcription of the request middleware in
 * `src/start.ts`: it evaluates the gate over a server-function pathname and a
 * raw `Cookie:` header and, only when the decision admits, runs a handler that
 * reads the Member_Registry and the Redemption_History. So `reachedHandler` is a
 * direct reading of Requirement 8.3's "before any store read" claim — a refused
 * call cannot have read anything, because the read is on the other side of the
 * branch.
 *
 * The store behind that handler is real and seeded, and the values it holds are
 * distinctive strings ({@link SEEDED_MEMBER_LABEL}, {@link SEEDED_HIVE_ID}, the
 * generated member id, {@link SEEDED_COUPON_CODE}). A rejection is then searched
 * for every one of them, headers included, so "leaks nothing" is checked against
 * values that demonstrably exist rather than against an empty store.
 *
 * ## No sleeping, no environment mutation, no real store file
 *
 * The clock is injected: {@link advanceClock} is what moves time, so the
 * five-minute throttle block of Requirement 8.8 is exercised in microseconds.
 * The Shared_Passphrase and the signing key are injected too, and the one place
 * that reads an environment record calls {@link resolveConfig} with a literal, so
 * `process.env` is never touched. Every store is built on a path inside a
 * `mkdtemp` directory with a flush that resolves without writing, so
 * `./data/store.json` is neither read nor written.
 *
 * ## Requirement 8.10, checked continuously
 *
 * {@link transcribe} records every response — status line, headers, body — and
 * asserts on the spot that the literal passphrase does not appear in it; every
 * captured log line goes into the same {@link transcript}. The final test asserts
 * over the whole accumulated transcript, so a leak anywhere in any flow above
 * fails twice.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  FAILED_ATTEMPT_LIMIT,
  GATE_DISABLED_MESSAGE,
  INCORRECT_PASSPHRASE_MESSAGE,
  LOGIN_PATH,
  SESSION_COOKIE_NAME,
  THROTTLED_MESSAGE,
  THROTTLE_BLOCK_MS,
  createAuth,
  resetAuth,
  setAuth,
} from "@/server/auth.server"
import { NO_PASSPHRASE_WARNING, resolveConfig } from "@/server/config.server"
import {
  SESSION_REQUIRED_CODE,
  SESSION_REQUIRED_STATUS,
  evaluateGate,
  gateRejectionResponse,
} from "@/server/gate.server"
import { createHistoryStore } from "@/server/store/history.server"
import { createJsonStore } from "@/server/store/jsonStore.server"
import { createMemberRegistryStore } from "@/server/store/memberRegistry.server"
import { Route as LoginRoute } from "@/routes/login"
import { Route as LogoutRoute } from "@/routes/logout"

import type { Auth, ThrottleStatus } from "@/server/auth.server"
import type { GateDecision } from "@/server/gate.server"
import type { HistoryStore } from "@/server/store/history.server"
import type { MemberRegistryStore } from "@/server/store/memberRegistry.server"

/** The configured Shared_Passphrase. Must appear in nothing the gate emits. */
const PASSPHRASE = "correct horse battery staple"

/** The injected session signing key. */
const SESSION_KEY = "session-signing-key-for-integration-tests"

/** The sender most flows submit from, as an `X-Forwarded-For` value. */
const SENDER = "203.0.113.7"

/** A second sender, used to show the throttle is per sender. */
const OTHER_SENDER = "198.51.100.4"

/**
 * A server-function URL. The id is compiler-generated in reality, which is
 * exactly why no server function can ever be on the exemption list.
 */
const SERVER_FN_PATH = "/_serverFn/listHistory"

/** Distinctive seeded values a rejection is searched for. */
const SEEDED_MEMBER_LABEL = "Seeded-Member-Label-9f2c"
const SEEDED_HIVE_ID = "Seeded-Hive-Id-4d81"
const SEEDED_COUPON_CODE = "Seeded-Coupon-Code-7ab3"

/** Where the injected clock starts. */
const BASE_NOW = Date.parse("2025-01-04T12:00:00.000Z")

/** Current value of the injected clock. */
let nowMs = BASE_NOW

/** Every response and every log line this file produced. Requirement 8.10. */
const transcript: Array<string> = []

/** Temporary directories to remove. */
const tempDirs: Array<string> = []

/** Moves the injected clock forward. Nothing in this file sleeps. */
function advanceClock(byMs: number): void {
  nowMs += byMs
}

/** A logger that records instead of printing, so log lines can be searched. */
function capturingLogger(): {
  warn: (message: string) => void
  lines: Array<string>
} {
  const lines: Array<string> = []
  return {
    warn: (message) => {
      lines.push(message)
      transcript.push(message)
    },
    lines,
  }
}

/** The seeded Member_Registry and Redemption_History a gated call reads. */
interface SeededStore {
  readonly roster: MemberRegistryStore
  readonly history: HistoryStore
  /** Surrogate key of the seeded entry: a third value that must not leak. */
  readonly memberId: string
}

/**
 * A store holding one Member_Registry entry and one Redemption_History record,
 * on a path that does not exist and a flush that writes nothing.
 */
async function seedStore(): Promise<SeededStore> {
  const dir = await mkdtemp(join(tmpdir(), "scr-access-gate-"))
  tempDirs.push(dir)

  const store = createJsonStore({
    dataFilePath: join(dir, "store.json"),
    flush: () => Promise.resolve(),
    logger: capturingLogger(),
  })
  const roster = createMemberRegistryStore(store)
  const history = createHistoryStore(store)

  const added = await roster.add({
    memberLabel: SEEDED_MEMBER_LABEL,
    hiveId: SEEDED_HIVE_ID,
  })
  if (added.kind !== "added") {
    throw new Error(`could not seed the roster: ${added.kind}`)
  }

  await history.append({
    runId: "run-seeded",
    couponCode: SEEDED_COUPON_CODE,
    completedAt: "2025-01-04T11:00:00.000Z",
    mock: true,
    stoppedEarly: false,
    outcomes: [
      {
        hiveId: SEEDED_HIVE_ID,
        memberLabel: SEEDED_MEMBER_LABEL,
        outcome: "SUCCESS",
        responseCode: "0",
        responseMessage: "ok",
      },
    ],
  })

  return { roster, history, memberId: added.entry.id }
}

/** Every seeded value a rejection must withhold (Requirement 8.3). */
function seededValues(seeded: SeededStore): Array<string> {
  return [
    SEEDED_MEMBER_LABEL,
    SEEDED_HIVE_ID,
    SEEDED_COUPON_CODE,
    seeded.memberId,
  ]
}

/** Installs an Access_Gate over the injected clock. `null` turns the gate off. */
function installAuth(passphrase: string | null): Auth {
  const auth = createAuth({
    now: () => nowMs,
    readSharedPassphrase: () => passphrase,
    readSessionSecret: () => SESSION_KEY,
  })
  setAuth(auth)
  return auth
}

/** The shape of one route method handler, as this test calls it. */
type TestHandler = (ctx: {
  request: Request
  next: (options?: { context?: unknown }) => unknown
}) => unknown

/** The per-method record a route's `server.handlers` option resolves to. */
type TestHandlers = Partial<Record<"GET" | "POST", TestHandler>>

/**
 * Resolves a route's handler record the way the Start request pipeline does:
 * call the `handlers` function with an identity `createHandlers`.
 */
function handlersOf(options: {
  server?: { handlers?: unknown }
}): TestHandlers {
  const handlers = options.server?.handlers
  if (typeof handlers === "function") {
    const build = handlers as (opts: {
      createHandlers: (record: TestHandlers) => TestHandlers
    }) => TestHandlers
    return build({ createHandlers: (record) => record })
  }
  return handlers ?? {}
}

/** Calls one route handler, refusing to let it defer. */
async function callHandler(
  handler: TestHandler | undefined,
  request: Request
): Promise<Response> {
  expect(handler).toBeTypeOf("function")
  const response = await (handler as TestHandler)({
    request,
    next: () => {
      throw new Error("this handler must answer, never defer")
    },
  })
  expect(response).toBeInstanceOf(Response)
  return response as Response
}

/** Posts `submitted` to the real `/login` POST handler as `sender`. */
function submitPassphrase(
  submitted: string,
  sender: string = SENDER
): Promise<Response> {
  return callHandler(
    handlersOf(LoginRoute.options).POST,
    new Request("http://localhost:3000/login", {
      method: "POST",
      headers: { "x-forwarded-for": sender },
      body: new URLSearchParams({ passphrase: submitted }),
    })
  )
}

/** Posts to the real `/logout` POST handler carrying `cookieHeader`. */
function submitLogout(cookieHeader: string): Promise<Response> {
  return callHandler(
    handlersOf(LogoutRoute.options).POST,
    new Request("http://localhost:3000/logout", {
      method: "POST",
      headers: { cookie: cookieHeader },
    })
  )
}

/** What the `/login` document reports. */
interface LoginView {
  readonly passphraseRequired: boolean
  readonly error: string | null
  readonly notice: string | null
}

/** Renders the `/login` document context for `url`. */
async function loginView(url: string): Promise<LoginView> {
  const handler = handlersOf(LoginRoute.options).GET
  expect(handler).toBeTypeOf("function")

  const deferred = (await (handler as TestHandler)({
    request: new Request(url),
    next: (options) => options,
  })) as { context: { login: LoginView } }

  return deferred.context.login
}

/** A recorded response, split into the pieces the flows assert on. */
interface Transcribed {
  readonly status: number
  readonly location: string | null
  readonly setCookie: string | null
  /** Every header as `name: value`, so a leak in a header is searchable. */
  readonly headers: string
  readonly body: string
}

/**
 * Records a response and asserts on the spot that it holds no character of the
 * Shared_Passphrase (Requirement 8.10).
 */
async function transcribe(response: Response): Promise<Transcribed> {
  const headers = [...response.headers]
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n")
  const body = await response.clone().text()

  const recorded = `${response.status}\n${headers}\n${body}`
  transcript.push(recorded)
  expect(recorded).not.toContain(PASSPHRASE)

  return {
    status: response.status,
    location: response.headers.get("location"),
    setCookie: response.headers.get("set-cookie"),
    headers,
    body,
  }
}

/** The `Cookie:` header a browser would send back for a granted Session. */
function cookieFrom(setCookie: string | null): string {
  expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`)
  return (setCookie as string).split(";")[0]
}

/** The result of one gated server-function-style call. */
interface GatedCall {
  readonly decision: GateDecision
  readonly response: Response
  /** True only when the gate admitted and the store was therefore read. */
  readonly reachedHandler: boolean
}

/**
 * One gated call, wired exactly as `src/start.ts` wires the middleware: evaluate
 * the gate, and reach the handler — which reads the roster and the history —
 * only when the decision admits.
 */
function gatedCall(
  auth: Auth,
  seeded: SeededStore,
  cookieHeader: string | null
): GatedCall {
  const decision = evaluateGate({
    auth,
    pathname: SERVER_FN_PATH,
    handlerType: "serverFn",
    cookieHeader,
  })

  if (decision.kind === "reject") {
    return {
      decision,
      response: gateRejectionResponse(decision),
      reachedHandler: false,
    }
  }

  const payload = JSON.stringify({
    members: seeded.roster.list(),
    history: seeded.history.list(),
  })
  return {
    decision,
    response: new Response(payload, {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    }),
    reachedHandler: true,
  }
}

beforeEach(() => {
  nowMs = BASE_NOW
})

afterEach(async () => {
  resetAuth()
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe("a gated call carrying no Session (Requirements 8.2, 8.3, 8.10)", () => {
  it("is rejected before any store read and leaks no roster or history value", async () => {
    const auth = installAuth(PASSPHRASE)
    const seeded = await seedStore()

    // The values searched for below really are in the store.
    expect(seeded.roster.list()).toHaveLength(1)
    expect(seeded.history.list()).toHaveLength(1)

    const call = gatedCall(auth, seeded, null)
    const recorded = await transcribe(call.response)

    expect(call.reachedHandler).toBe(false)
    expect(call.decision.kind).toBe("reject")
    if (call.decision.kind !== "reject") return
    expect(call.decision.reason).toBe("missing")
    expect(recorded.status).toBe(SESSION_REQUIRED_STATUS)

    // It directs the sender to submit the Shared_Passphrase, and nothing else.
    expect(recorded.body).toContain(SESSION_REQUIRED_CODE)
    expect(recorded.body).toContain(LOGIN_PATH)
    expect(recorded.setCookie).toBeNull()

    for (const secret of [...seededValues(seeded), PASSPHRASE]) {
      expect(recorded.body).not.toContain(secret)
      expect(recorded.headers).not.toContain(secret)
    }
  })
})

describe("submit, use, end (Requirements 8.4, 8.7)", () => {
  it("admits the call a Session was needed for, then refuses it once the Session ends", async () => {
    const auth = installAuth(PASSPHRASE)
    const seeded = await seedStore()

    // Before: refused.
    expect(gatedCall(auth, seeded, null).reachedHandler).toBe(false)

    const granted = await transcribe(await submitPassphrase(PASSPHRASE))
    expect(granted.status).toBe(303)
    expect(granted.location).toBe("/")
    const cookieHeader = cookieFrom(granted.setCookie)

    // After: the very same call is admitted and reads the seeded store.
    const admitted = gatedCall(auth, seeded, cookieHeader)
    const served = await transcribe(admitted.response)
    expect(admitted.reachedHandler).toBe(true)
    expect(admitted.decision).toEqual({
      kind: "admit",
      reason: "valid-session",
    })
    expect(served.status).toBe(200)
    expect(served.body).toContain(SEEDED_HIVE_ID)
    expect(served.body).toContain(SEEDED_COUPON_CODE)

    const loggedOut = await transcribe(await submitLogout(cookieHeader))
    expect(loggedOut.status).toBe(303)
    expect(loggedOut.location).toBe(LOGIN_PATH)
    expect(loggedOut.setCookie).toContain("Max-Age=0")

    /*
     * Requirement 8.7: the captured copy of the cookie stops working, not just
     * the browser's — the rejection reason is `revoked`, which only the
     * server-side registry removal can produce.
     */
    const refused = gatedCall(auth, seeded, cookieHeader)
    const rejection = await transcribe(refused.response)
    expect(refused.reachedHandler).toBe(false)
    expect(refused.decision.kind).toBe("reject")
    if (refused.decision.kind !== "reject") return
    expect(refused.decision.reason).toBe("revoked")
    expect(rejection.status).toBe(SESSION_REQUIRED_STATUS)
    for (const secret of seededValues(seeded)) {
      expect(rejection.body).not.toContain(secret)
    }
  })
})

describe("a wrong value and the throttle (Requirements 8.5, 8.8)", () => {
  it("grants nothing, says only that the passphrase is incorrect, and counts the failure", async () => {
    const auth = installAuth(PASSPHRASE)
    const seeded = await seedStore()

    const rejected = await transcribe(await submitPassphrase(`${PASSPHRASE}x`))

    expect(rejected.status).toBe(303)
    expect(rejected.location).toBe(`${LOGIN_PATH}?error=incorrect`)
    expect(rejected.setCookie).toBeNull()
    expect(gatedCall(auth, seeded, null).reachedHandler).toBe(false)

    // Requirement 8.8: the failure is counted against this sender.
    const status: ThrottleStatus = auth.throttleStatus(SENDER)
    expect(status.failures).toBe(1)
    expect(status.blocked).toBe(false)

    // Requirement 8.5: one fixed sentence, no character and no length.
    const rendered = await loginView(
      `http://localhost:3000${LOGIN_PATH}?error=incorrect`
    )
    expect(rendered.error).toBe(INCORRECT_PASSPHRASE_MESSAGE)
    expect(rendered.error).not.toContain(String(PASSPHRASE.length))
    expect(rendered.error).not.toContain(PASSPHRASE)
  })

  it("refuses even the correct value once blocked, and admits it again after the block lifts", async () => {
    const auth = installAuth(PASSPHRASE)
    const seeded = await seedStore()

    for (let attempt = 0; attempt < FAILED_ATTEMPT_LIMIT; attempt += 1) {
      const response = await transcribe(await submitPassphrase("not-it"))
      expect(response.setCookie).toBeNull()
      // A minute of guessing, still inside the five-minute window.
      advanceClock(1_000)
    }
    expect(auth.throttleStatus(SENDER).blocked).toBe(true)

    const blocked = await transcribe(await submitPassphrase(PASSPHRASE))
    expect(blocked.location).toBe(`${LOGIN_PATH}?error=throttled`)
    expect(blocked.setCookie).toBeNull()
    expect(gatedCall(auth, seeded, null).reachedHandler).toBe(false)
    expect(
      (await loginView(`http://localhost:3000${LOGIN_PATH}?error=throttled`))
        .error
    ).toBe(THROTTLED_MESSAGE)

    /*
     * The blocked submission above restarted the block from that moment, so the
     * wait is measured from now. Requirement 8.8 asks for at least five minutes,
     * and this is the earliest the correct value can work again.
     */
    expect(auth.throttleStatus(SENDER).retryAfterMs).toBe(THROTTLE_BLOCK_MS)
    advanceClock(THROTTLE_BLOCK_MS + 1)
    expect(auth.throttleStatus(SENDER).blocked).toBe(false)

    const granted = await transcribe(await submitPassphrase(PASSPHRASE))
    expect(granted.location).toBe("/")
    const cookieHeader = cookieFrom(granted.setCookie)
    expect(gatedCall(auth, seeded, cookieHeader).reachedHandler).toBe(true)
  })
})

describe("the throttle counts per sender (Requirement 8.8)", () => {
  it("leaves a second sender able to sign in while the first is blocked", async () => {
    const auth = installAuth(PASSPHRASE)
    const seeded = await seedStore()

    for (let attempt = 0; attempt < FAILED_ATTEMPT_LIMIT; attempt += 1) {
      await transcribe(await submitPassphrase("not-it", SENDER))
    }
    expect(auth.throttleStatus(SENDER).blocked).toBe(true)
    expect(auth.throttleStatus(OTHER_SENDER).blocked).toBe(false)

    // The second sender's own wrong value is answered as a wrong value.
    const wrong = await transcribe(await submitPassphrase("nope", OTHER_SENDER))
    expect(wrong.location).toBe(`${LOGIN_PATH}?error=incorrect`)
    expect(auth.throttleStatus(OTHER_SENDER).failures).toBe(1)

    const granted = await transcribe(
      await submitPassphrase(PASSPHRASE, OTHER_SENDER)
    )
    expect(granted.location).toBe("/")
    expect(
      gatedCall(auth, seeded, cookieFrom(granted.setCookie)).reachedHandler
    ).toBe(true)

    // The first sender is still blocked: one success does not clear another.
    const stillBlocked = await transcribe(
      await submitPassphrase(PASSPHRASE, SENDER)
    )
    expect(stillBlocked.location).toBe(`${LOGIN_PATH}?error=throttled`)
    expect(stillBlocked.setCookie).toBeNull()
  })
})

describe("no Shared_Passphrase configured (Requirements 8.1, 8.9)", () => {
  it("warns at startup and leaves the whole app usable without a Session", async () => {
    const logger = capturingLogger()
    const resolved = resolveConfig({}, logger)

    // Requirements 8.1, 8.9: read at startup, absent, warned about prominently.
    expect(resolved.config.passphraseRequired).toBe(false)
    expect(logger.lines).toContain(NO_PASSPHRASE_WARNING)
    expect(NO_PASSPHRASE_WARNING).toContain("WITHOUT")

    const auth = createAuth({
      now: () => nowMs,
      readSharedPassphrase: resolved.secrets.readSharedPassphrase,
      readSessionSecret: resolved.secrets.readSessionSecret,
    })
    setAuth(auth)
    expect(auth.passphraseRequired()).toBe(false)

    // Every request is admitted, with or without a cookie.
    const seeded = await seedStore()
    for (const cookieHeader of [null, `${SESSION_COOKIE_NAME}=junk`]) {
      const call = gatedCall(auth, seeded, cookieHeader)
      expect(call.decision).toEqual({ kind: "admit", reason: "gate-disabled" })
      expect(call.reachedHandler).toBe(true)
      expect((await transcribe(call.response)).body).toContain(SEEDED_HIVE_ID)
    }

    // And the login page says there is nothing to submit.
    expect(await loginView(`http://localhost:3000${LOGIN_PATH}`)).toEqual({
      passphraseRequired: false,
      error: null,
      notice: GATE_DISABLED_MESSAGE,
    })
  })
})

describe("the Shared_Passphrase never leaves the server (Requirement 8.10)", () => {
  it("appears in no response of any flow above and in no logged line", () => {
    /*
     * Populated by every `transcribe` and every captured warning in this file.
     * The individual assertions already ran; this is the whole transcript at
     * once, so a leak in a flow whose own assertion was loosened still fails.
     */
    expect(transcript.length).toBeGreaterThan(0)
    for (const recorded of transcript) {
      expect(recorded).not.toContain(PASSPHRASE)
    }
  })
})
