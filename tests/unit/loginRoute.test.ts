/**
 * Unit tests for the `/login` and `/logout` route handlers
 * (Requirements 8.3, 8.4, 8.5, 8.7, 8.9, 8.10).
 *
 * The handlers are invoked the way the framework invokes them: the `handlers`
 * option is a function taking `createHandlers`, which the Start request pipeline
 * calls with an identity function to get the per-method record. Doing the same
 * here exercises the real submission path — form parsing, the constant-time
 * comparison inside `Auth`, the `Set-Cookie` header, and the redirect — without
 * booting a server.
 *
 * The Access_Gate under test is built with an injected passphrase and signing
 * key and installed with `setAuth`, so no environment variable is touched and
 * each test starts from an empty throttle and an empty session registry.
 */

import { afterEach, describe, expect, it } from "vitest"

import {
  GATE_DISABLED_MESSAGE,
  INCORRECT_PASSPHRASE_MESSAGE,
  SESSION_COOKIE_NAME,
  THROTTLED_MESSAGE,
  createAuth,
  resetAuth,
  setAuth,
} from "@/server/auth.server"
import { Route as LoginRoute } from "@/routes/login"
import { Route as LogoutRoute } from "@/routes/logout"

import type { Auth } from "@/server/auth.server"

const PASSPHRASE = "correct horse battery staple"
const SENDER = "203.0.113.7"

/** The shape of one route method handler, as this test calls it. */
type TestHandler = (ctx: {
  request: Request
  next: (options?: { context?: unknown }) => unknown
}) => unknown

/** The per-method record a route's `server.handlers` option resolves to. */
type TestHandlers = Partial<Record<"GET" | "POST", TestHandler>>

/**
 * Resolves a route's handler record. Mirrors what the request pipeline does:
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

/** Installs an Access_Gate with `passphrase` (null means the gate is off). */
function installAuth(passphrase: string | null): Auth {
  const auth = createAuth({
    readSharedPassphrase: () => passphrase,
    readSessionSecret: () => "session-signing-key-for-tests",
  })
  setAuth(auth)
  return auth
}

/** Submits `submitted` to the `/login` POST handler. */
async function submit(submitted: string): Promise<Response> {
  const handler = handlersOf(LoginRoute.options).POST
  expect(handler).toBeTypeOf("function")

  const request = new Request("http://localhost:3000/login", {
    method: "POST",
    headers: { "x-forwarded-for": SENDER },
    body: new URLSearchParams({ passphrase: submitted }),
  })

  const response = await handler!({
    request,
    next: () => {
      throw new Error("the POST handler must answer, never defer")
    },
  })
  expect(response).toBeInstanceOf(Response)
  return response as Response
}

/** Renders the `/login` document context for `url`. */
async function view(url: string): Promise<{
  passphraseRequired: boolean
  error: string | null
  notice: string | null
  needs: "passphrase" | "passphrase-and-sign-in"
}> {
  const handler = handlersOf(LoginRoute.options).GET
  expect(handler).toBeTypeOf("function")

  const deferred = (await handler!({
    request: new Request(url),
    next: (options) => options,
  })) as { context: { login: Awaited<ReturnType<typeof view>> } }

  return deferred.context.login
}

afterEach(() => {
  resetAuth()
})

describe("/login POST", () => {
  it("grants a Session for a character-for-character match", async () => {
    const auth = installAuth(PASSPHRASE)

    const response = await submit(PASSPHRASE)
    const setCookie = response.headers.get("set-cookie")

    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("/")
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`)
    expect(setCookie).toContain("HttpOnly")

    // Requirement 8.4: the cookie admits every subsequent request.
    const cookieValue = setCookie!.split(";")[0]
    expect(auth.hasValidSession(cookieValue)).toBe(true)
  })

  it("keeps the passphrase out of the response (Requirement 8.10)", async () => {
    installAuth(PASSPHRASE)

    const response = await submit(PASSPHRASE)
    const body = await response.text()
    const headers = [...response.headers].map(([n, v]) => `${n}: ${v}`).join()

    expect(body).toBe("")
    expect(headers).not.toContain(PASSPHRASE)
  })

  it("grants nothing and discloses nothing for a wrong value", async () => {
    const auth = installAuth(PASSPHRASE)

    const response = await submit(`${PASSPHRASE}x`)

    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("/login?error=incorrect")
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(auth.throttleStatus(SENDER).failures).toBe(1)

    // Requirement 8.5: one fixed sentence, no character and no length.
    const rendered = await view("http://localhost:3000/login?error=incorrect")
    expect(rendered.error).toBe(INCORRECT_PASSPHRASE_MESSAGE)
    expect(rendered.error).not.toContain(String(PASSPHRASE.length))
  })

  it("reports the throttle rather than the comparison once blocked", async () => {
    installAuth(PASSPHRASE)

    for (let attempt = 0; attempt < 10; attempt++) {
      await submit("wrong")
    }
    const response = await submit(PASSPHRASE)

    expect(response.headers.get("location")).toBe("/login?error=throttled")
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(
      (await view("http://localhost:3000/login?error=throttled")).error
    ).toBe(THROTTLED_MESSAGE)
  })

  it("sends an empty submission back with the same generic message", async () => {
    installAuth(PASSPHRASE)

    const response = await submit("")

    expect(response.headers.get("location")).toBe("/login?error=incorrect")
    expect(response.headers.get("set-cookie")).toBeNull()
  })
})

describe("/login GET", () => {
  it("offers the form and no message by default", async () => {
    installAuth(PASSPHRASE)

    expect(await view("http://localhost:3000/login")).toEqual({
      passphraseRequired: true,
      error: null,
      notice: null,
      needs: "passphrase-and-sign-in",
    })
  })

  it("tailors the sign-in copy to a member's needs", async () => {
    installAuth(PASSPHRASE)

    expect(
      (await view("http://localhost:3000/login?needs=passphrase")).needs
    ).toBe("passphrase")
  })

  it("falls back to the safe superset for an unrecognized needs value", async () => {
    installAuth(PASSPHRASE)

    expect(
      (await view("http://localhost:3000/login?needs=%3Cscript%3E")).needs
    ).toBe("passphrase-and-sign-in")
  })

  it("ignores an unrecognized error code instead of rendering it", async () => {
    installAuth(PASSPHRASE)

    const rendered = await view(
      "http://localhost:3000/login?error=%3Cscript%3Ealert(1)%3C/script%3E"
    )

    expect(rendered.error).toBeNull()
  })

  it("says so when no Shared_Passphrase is configured", async () => {
    installAuth(null)

    expect(await view("http://localhost:3000/login")).toEqual({
      passphraseRequired: false,
      error: null,
      notice: GATE_DISABLED_MESSAGE,
      needs: "passphrase-and-sign-in",
    })
  })
})

describe("/logout", () => {
  it("invalidates the Session so later requests are rejected", async () => {
    const auth = installAuth(PASSPHRASE)
    const granted = (await submit(PASSPHRASE)).headers.get("set-cookie")!
    const cookieValue = granted.split(";")[0]
    expect(auth.hasValidSession(cookieValue)).toBe(true)

    const handler = handlersOf(LogoutRoute.options).POST
    expect(handler).toBeTypeOf("function")
    const response = (await handler!({
      request: new Request("http://localhost:3000/logout", {
        method: "POST",
        headers: { cookie: cookieValue },
      }),
      next: () => {
        throw new Error("the POST handler must answer, never defer")
      },
    })) as Response

    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("/login")
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0")

    // Requirement 8.7: the captured cookie stops working, not just the browser's.
    expect(auth.hasValidSession(cookieValue)).toBe(false)
    expect(auth.verifySessionCookieHeader(cookieValue).kind).toBe("revoked")
  })

  it("ends nothing on a GET", async () => {
    const auth = installAuth(PASSPHRASE)
    const cookieValue = (await submit(PASSPHRASE)).headers
      .get("set-cookie")!
      .split(";")[0]

    const handler = handlersOf(LogoutRoute.options).GET
    const response = (await handler!({
      request: new Request("http://localhost:3000/logout", {
        headers: { cookie: cookieValue },
      }),
      next: () => {
        throw new Error("the GET handler must answer, never defer")
      },
    })) as Response

    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("/")
    expect(auth.hasValidSession(cookieValue)).toBe(true)
  })
})
