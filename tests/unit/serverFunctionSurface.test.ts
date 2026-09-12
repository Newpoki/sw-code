import { readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * Structural guards for the client/server boundary of the Web_Client
 * (Requirements 1.4, 2.9, 3.2, 6.2).
 *
 * Task 16.1 confirmed four properties of the wiring by reading the code. Reading
 * proves them true *today*; this file is what keeps them true. Each assertion
 * below fails on a change that reintroduces the thing it forbids, which is
 * cheaper than discovering it in a browser:
 *
 *   1. Every page reaches the server only through the `createServerFn` surface in
 *      `src/functions/` — no `fetch`, no store or coordinator import, and no
 *      `.server` module import from a client-reachable module. The two documented
 *      exceptions are the `/login` and `/logout` file routes, whose POST handlers
 *      cannot be server functions: a server function's URL carries a
 *      compiler-generated id, which the Access_Gate exemption list cannot name,
 *      so a login server function would be gated and no Session could ever be
 *      obtained (see `src/server/gate.server.ts`).
 *   2. Each roster mutation re-reads the roster only after its envelope came back
 *      `ok`, so a failed write never invalidates (Requirement 1.4).
 *   3. The run state machine is the single source of the submission control's
 *      disabled state: the redemption page passes `isRunInProgress(runState)` and
 *      nothing else (Requirement 2.9).
 *   4. No markup is ever injected into the DOM — `dangerouslySetInnerHTML` and
 *      `innerHTML` assignment appear nowhere in `src/`, which is the mechanism
 *      behind the literal rendering of Requirement 6.2. The `react/no-danger`
 *      ESLint rule covers the JSX form; this also covers the DOM form, which that
 *      rule does not see.
 *
 * These are text assertions over source files, deliberately. The alternative — a
 * rendering test — cannot observe the absence of an import, and a type-level
 * check cannot observe that a `.server` module stayed out of a route.
 */

const SRC = fileURLToPath(new URL("../../src/", import.meta.url))

/** Every `.ts`/`.tsx` file under `dir`, recursively, as repo-relative paths. */
function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(join(SRC, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...sourceFiles(path))
    } else if (/\.tsx?$/.test(entry.name)) {
      found.push(path)
    }
  }
  return found
}

/** Contents of one file under `src/`. */
function read(path: string): string {
  return readFileSync(join(SRC, path), "utf8")
}

/**
 * `text` with every comment removed, so a doc comment that *names* a forbidden
 * construct — several of them explain why the construct is banned — does not read
 * as a use of it.
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}

/** Modules a browser bundle can reach: the pages, the shell, the components. */
const CLIENT_REACHABLE = [
  ...sourceFiles("routes").filter((path) => path !== "routeTree.gen.ts"),
  ...sourceFiles("components"),
  ...sourceFiles("domain"),
]

/**
 * The only two client-reachable modules allowed to import a `.server` module.
 * Both are file routes whose `server.handlers` block — and with it the import —
 * is removed from the client build; `tests/unit/loginRoute.test.ts` covers their
 * behaviour, and the gate's module comment records why they exist.
 */
const SERVER_IMPORT_EXCEPTIONS = ["routes/login.tsx", "routes/logout.ts"]

describe("the Web_Client reaches the server only through server functions", () => {
  it("finds the modules it is meant to be guarding", () => {
    /* A refactor that renames or moves these would otherwise silently empty the
     * assertions below. */
    expect(CLIENT_REACHABLE).toContain("routes/index.tsx")
    expect(CLIENT_REACHABLE).toContain("routes/roster.tsx")
    expect(CLIENT_REACHABLE).toContain("routes/history.tsx")
    expect(CLIENT_REACHABLE).toContain("routes/login.tsx")
    expect(CLIENT_REACHABLE).toContain("routes/__root.tsx")
    expect(CLIENT_REACHABLE).toContain("components/LogoutButton.tsx")
  })

  it("imports no .server module outside the two documented file routes", () => {
    const offenders = CLIENT_REACHABLE.filter(
      (path) =>
        !SERVER_IMPORT_EXCEPTIONS.includes(path) &&
        /from\s+["'][^"']*\.server["']/.test(withoutComments(read(path)))
    )

    expect(
      offenders,
      "a client-reachable module imports a .server module; call a server function in src/functions/ instead"
    ).toEqual([])
  })

  it("keeps each exception's server import inside its route handlers block", () => {
    for (const path of SERVER_IMPORT_EXCEPTIONS) {
      const source = withoutComments(read(path))
      expect(
        source,
        `${path} imports a .server module, so it must keep it inside a server handlers block`
      ).toContain("handlers:")
    }
  })

  it("calls fetch from no page and no component", () => {
    const offenders = CLIENT_REACHABLE.filter((path) =>
      /\bfetch\s*\(/.test(withoutComments(read(path)))
    )

    expect(
      offenders,
      "a page or component calls fetch directly; the server-function surface is the only transport"
    ).toEqual([])
  })

  it("imports no store, coordinator, or upstream client from a page", () => {
    const offenders = sourceFiles("routes").filter((path) =>
      /from\s+["']@\/server\/(store|run|upstream)\//.test(
        withoutComments(read(path))
      )
    )

    expect(
      offenders,
      "a page imports a server collaborator directly; it must go through src/functions/"
    ).toEqual([])
  })
})

describe("the roster re-reads only after a successful mutation", () => {
  const roster = read("routes/roster.tsx")

  /** Body of one `async function <name>(...)` declaration of the module. */
  function handlerBody(name: string): string {
    const start = roster.indexOf(`async function ${name}(`)
    expect(start, `roster.tsx declares ${name}`).toBeGreaterThanOrEqual(0)
    /* Handlers are top-level in the component, so their closing brace is the
     * first one at two-space indentation. */
    const end = roster.indexOf("\n  }\n", start)
    return roster.slice(start, end)
  }

  for (const name of ["handleAdd", "handleSetEnabled", "handleRemove"]) {
    it(`${name} invalidates the roster read, and only on success`, () => {
      const body = handlerBody(name)

      const invalidate = body.indexOf("router.invalidate()")
      expect(
        invalidate,
        `${name} must re-read the roster after the write lands (Requirement 1.4)`
      ).toBeGreaterThanOrEqual(0)

      const rejection = body.indexOf("if (!envelope.ok)")
      expect(
        rejection,
        `${name} must branch on the envelope before re-reading`
      ).toBeGreaterThanOrEqual(0)

      const rejectionReturn = body.indexOf("return", rejection)
      expect(
        rejectionReturn,
        `${name} must return on a rejected envelope instead of re-reading`
      ).toBeLessThan(invalidate)
    })
  }
})

describe("the run state machine is the only source of the disabled state", () => {
  const page = read("routes/index.tsx")
  const body = withoutComments(page)

  it("derives the submission control's disabled state from the machine alone", () => {
    expect(body).toContain("const runInProgress = isRunInProgress(runState)")

    const assignments = [...body.matchAll(/disabled=\{([^}]*)\}/g)].map(
      (match) => match[1]
    )
    expect(
      assignments,
      "the redemption page passes exactly one disabled prop, and it is the machine's verdict"
    ).toEqual(["runInProgress"])
  })

  it("reads the in-progress verdict from no other expression", () => {
    /* A second `isRunInProgress` call, or a boolean OR-ed into the prop, would
     * make the disabled state a function of two things again. */
    expect(body.match(/isRunInProgress\(/g)).toHaveLength(1)
  })
})

describe("no markup from upstream can reach the DOM as markup", () => {
  const everySource = sourceFiles(".").filter(
    (path) => path !== "routeTree.gen.ts"
  )

  it("uses dangerouslySetInnerHTML nowhere", () => {
    const offenders = everySource.filter((path) =>
      withoutComments(read(path)).includes("dangerouslySetInnerHTML")
    )

    expect(
      offenders,
      "dangerouslySetInnerHTML is banned: upstream messages render as text (Requirement 6.2)"
    ).toEqual([])
  })

  it("assigns innerHTML nowhere", () => {
    const offenders = everySource.filter((path) =>
      /\.(inner|outer)HTML\s*=/.test(withoutComments(read(path)))
    )

    expect(
      offenders,
      "assigning innerHTML bypasses React's escaping (Requirement 6.2)"
    ).toEqual([])
  })

  it("covers the files it claims to cover", () => {
    /* `sourceFiles(".")` walking the wrong directory would make the two
     * assertions above pass over an empty list. */
    expect(everySource.length).toBeGreaterThan(30)
    expect(everySource).toContain("components/RunResultTable.tsx")
    expect(everySource).toContain(relative(SRC, join(SRC, "router.tsx")))
  })
})
