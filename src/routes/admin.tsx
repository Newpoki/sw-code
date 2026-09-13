/**
 * The `/admin` document: the signed-in email, the Member_Registry and
 * Redemption_History counts, the Mock_Mode state, the connection indicator, and
 * the account table (Requirements 8.1, 8.2, 8.3, 8.5, 8.6, 8.7, 8.8), behind the
 * `requireAdmin` document guard (Requirements 6.4, 6.5, 6.6, 6.15).
 *
 * ## Two guards, one page (Requirement 6.7)
 *
 * The `/admin` document is guarded twice, on purpose. The server function
 * {@link getAdminOverview} runs `requireAdminForServerFn` before it reads any
 * Admin_Page value — the *boundary* layer (task 20.1), which a direct `fetch`
 * cannot get around, and which returns a `NOT_AUTHENTICATED`/`NOT_AUTHORIZED`/
 * `AUTHORIZATION_UNKNOWN` envelope rather than a redirect. This route's loader is
 * the *UX* layer that reads that envelope and reacts the way a *browser* should:
 * a `NOT_AUTHENTICATED` request — an `anonymous` decision — is redirected to the
 * sign-in page (Requirement 6.5), and a `NOT_AUTHORIZED`/`AUTHORIZATION_UNKNOWN`
 * request — a `member` or an account whose role could not be read — is shown its
 * message and no Admin_Page value (Requirements 6.6, 6.15).
 *
 * ## Why the guard is not an imported `.server` call
 *
 * `requireAdminForDocument` lives in `src/server/authorization.server.ts`, which
 * the browser bundle must never import — the Web_Client reaches the server only
 * through the `createServerFn` surface in `src/functions/`
 * (`tests/unit/serverFunctionSurface.test.ts` enforces this, and `/login` and
 * `/logout` are its only two exceptions). So the document reaction is derived
 * here from the one thing that *does* cross the boundary safely: the envelope
 * {@link getAdminOverview} already returns. Its three rejection codes map one to
 * one onto the three document reactions the guard would produce —
 * `NOT_AUTHENTICATED` ⇒ redirect, `NOT_AUTHORIZED` ⇒ the not-authorized message,
 * `AUTHORIZATION_UNKNOWN` ⇒ the authorization-unknown message — and both the
 * server function's guard and `requireAdminForDocument` derive them from the same
 * `AuthorizationDecision`, so the mapping cannot drift.
 *
 * ## Prop-driven page, thin route (mirrors `src/routes/roster.tsx`)
 *
 * {@link AdminPage} renders from props alone — no router, no live server — so the
 * partial-page rendering of Requirements 8.1/8.5/8.6/8.7/8.8 is exercisable with
 * `@testing-library/react`. The route component {@link AdminRoute} is the only
 * part that touches loader data.
 *
 * ## Nothing here composes a store sentence
 *
 * Every failure sentence is chosen upstream: a failed count already carries
 * {@link mongoUnavailableCountMessage} from the server function, and the
 * member/unknown refusals already carry their sentences from the guard. This
 * module interpolates none of them; it renders each verbatim in its position.
 */

import { createFileRoute, redirect } from "@tanstack/react-router"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { getAdminOverview } from "@/functions/admin.functions"
import type { AdminOverview, CountRead } from "@/domain/accounts"

/**
 * Path of the sign-in document, where an `anonymous` request to `/admin` is sent
 * (Requirement 6.5). A literal rather than an import of `SIGN_IN_PATH`, because
 * that constant lives in `authorization.server.ts`, which must not reach the
 * browser bundle; `src/routes/sign-in.tsx` declares the same path. This is the
 * same reasoning `src/routes/__root.tsx` records for its own `LOGIN_PATH`.
 */
const SIGN_IN_PATH = "/sign-in"

/**
 * The Requirement 8.7 message: it states that no Google_Account has signed in.
 * Exported so a test asserts this exact sentence rather than a paraphrase. It is
 * a claim only a *successful* read of zero rows is entitled to make, which is why
 * it is rendered only in that branch below.
 */
export const NO_ACCOUNTS_MESSAGE =
  "No Google account has signed in yet. Accounts appear here after their first sign-in."

/** The connection indicator's two states (Requirement 8.3). */
export const CONNECTION_INDICATOR_STATES = {
  /** Shown only while the Mongo_Store holds an open connection pool. */
  connected: "Connected to the database.",
  /** Shown otherwise. */
  disconnected: "No database connection.",
} as const

/** The Mock_Mode state as exactly one of the two Requirement 8.1 words. */
export const MOCK_MODE_STATES = {
  enabled: "enabled",
  disabled: "disabled",
} as const

/**
 * The `member`/`unknown` refusal, or `null` for an authorized request. Carries
 * the guard's own sentence and its code, and never an Admin_Page value
 * (Requirements 6.6, 6.15).
 */
interface AdminRejection {
  readonly code: "NOT_AUTHORIZED" | "AUTHORIZATION_UNKNOWN"
  readonly message: string
}

/** Everything the `/admin` document renders: the overview, or a refusal. */
interface AdminView {
  /** The overview for an authorized request, or `null` when refused. */
  readonly overview: AdminOverview | null
  /** The refusal for a member/unknown request, or `null` when authorized. */
  readonly rejection: AdminRejection | null
}

export const Route = createFileRoute("/admin")({
  /**
   * The one Admin_Page read of a document, and the document `requireAdmin`
   * reaction to it (Requirements 6.4, 6.5, 6.6, 6.15). The server function's
   * boundary guard has already decided the request; this loader turns its verdict
   * into the reaction a browser navigation needs:
   *
   * - `ok` ⇒ render the overview.
   * - `NOT_AUTHENTICATED` (an `anonymous` decision) ⇒ redirect to the sign-in
   *   page (Requirement 6.5). The redirect is thrown, so the loader stops here.
   * - `NOT_AUTHORIZED` / `AUTHORIZATION_UNKNOWN` (a `member`/`unknown` decision)
   *   ⇒ carry the guard's own sentence forward and render no Admin_Page value
   *   (Requirements 6.6, 6.15).
   */
  loader: async (): Promise<AdminView> => {
    const envelope = await getAdminOverview()

    if (envelope.ok) {
      return { overview: envelope.data, rejection: null }
    }

    if (envelope.error.code === "NOT_AUTHENTICATED") {
      /* Requirement 6.5: a browser navigating to /admin is sent to sign in. */
      throw redirect({ to: SIGN_IN_PATH })
    }

    /* Requirements 6.6, 6.15: the guard's sentence, and no Admin_Page value. The
     * envelope's code is one of the two remaining refusals. */
    return {
      overview: null,
      rejection: {
        code:
          envelope.error.code === "AUTHORIZATION_UNKNOWN"
            ? "AUTHORIZATION_UNKNOWN"
            : "NOT_AUTHORIZED",
        message: envelope.error.message,
      },
    }
  },

  component: AdminRoute,
})

/* -------------------------------------------------------------------------- */
/* The page                                                                   */
/* -------------------------------------------------------------------------- */

export interface AdminPageProps {
  /** The overview for an authorized request, or `null` when refused. */
  readonly overview: AdminOverview | null
  /**
   * The `member`/`unknown` refusal, or `null` when authorized. When present the
   * page renders its sentence and no Admin_Page value (Requirements 6.6, 6.15).
   */
  readonly rejection?: AdminRejection | null
}

/**
 * The `/admin` document.
 *
 * Exported and prop-driven so it renders in a test with no router and no live
 * server, the same seam `src/routes/roster.tsx` uses. When `rejection` is
 * present it renders that sentence alone; otherwise it renders the overview, each
 * read's value or its message in that read's own position.
 */
export function AdminPage({ overview, rejection = null }: AdminPageProps) {
  if (rejection !== null || overview === null) {
    /* Requirements 6.6, 6.15: the refusal sentence, and no Admin_Page value. */
    return (
      <main className="container mx-auto flex flex-col gap-6 p-4">
        <div>
          <h1 className="text-lg font-medium">Admin</h1>
        </div>
        <p role="alert" className="text-sm text-destructive">
          {rejection?.message ?? CONNECTION_INDICATOR_STATES.disconnected}
        </p>
      </main>
    )
  }

  const mockModeState = overview.mockMode
    ? MOCK_MODE_STATES.enabled
    : MOCK_MODE_STATES.disabled

  const connectionState = overview.connected
    ? CONNECTION_INDICATOR_STATES.connected
    : CONNECTION_INDICATOR_STATES.disconnected

  return (
    <main className="container mx-auto flex flex-col gap-6 p-4">
      <div>
        <h1 className="text-lg font-medium">Admin</h1>
        {/* Requirement 8.1: the signed-in email address. */}
        <p className="text-sm text-muted-foreground" data-slot="admin-email">
          Signed in as {overview.email}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card data-slot="member-count">
          <CardHeader>
            <CardTitle>Members</CardTitle>
            <CardDescription>Entries in the roster.</CardDescription>
          </CardHeader>
          <CardContent>
            <CountValue count={overview.memberCount} />
          </CardContent>
        </Card>

        <Card data-slot="history-count">
          <CardHeader>
            <CardTitle>Redemption history</CardTitle>
            <CardDescription>Retained redemption runs.</CardDescription>
          </CardHeader>
          <CardContent>
            <CountValue count={overview.historyCount} />
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col gap-1 text-sm">
        {/* Requirement 8.1: exactly `enabled` or `disabled`. */}
        <p data-slot="mock-mode">
          Mock mode: <span>{mockModeState}</span>
        </p>
        {/* Requirement 8.3: exactly one of two states; the first only while a
         * connection pool is open. Requirement 8.6: shown even when a read
         * failed. */}
        <p data-slot="connection-indicator" role="status">
          {connectionState}
        </p>
      </div>

      <AccountsTable overview={overview} />
    </main>
  )
}

/**
 * One Admin_Page count in its own position: the integer when the read supplied
 * it, or the store's unreachable sentence when it did not (Requirement 8.5). A
 * failed count never removes the sibling count or the account table — this
 * decides one position and nothing else (Requirement 8.6).
 */
function CountValue({ count }: { readonly count: CountRead }) {
  if (count.ok) {
    return <p className="text-2xl font-semibold tabular-nums">{count.value}</p>
  }

  return (
    <p role="status" className="text-sm text-destructive">
      {count.message}
    </p>
  )
}

/**
 * The account table (Requirement 8.2), the Requirement 8.7 empty-state message
 * when a successful read returned zero rows, or the read's own sentence when it
 * did not complete (Requirement 8.5).
 *
 * The three cases are told apart the same way the data pages tell their three
 * states apart: a failed read is not an empty read, so "no Google account has
 * signed in" is rendered only for a *successful* read of zero rows.
 */
function AccountsTable({ overview }: { readonly overview: AdminOverview }) {
  if (!overview.accounts.ok) {
    /* Requirement 8.5: the read's own sentence, in place of the table. */
    return (
      <p role="status" className="text-sm text-destructive">
        {overview.accounts.message}
      </p>
    )
  }

  const { rows } = overview.accounts

  if (rows.length === 0) {
    /* Requirement 8.7: a claim only a successful read of zero rows may make. */
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {NO_ACCOUNTS_MESSAGE}
      </p>
    )
  }

  return (
    <Table>
      <TableCaption>
        Accounts that have signed in, most recent first.
      </TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Name</TableHead>
          <TableHead scope="col">Email</TableHead>
          <TableHead scope="col">Role</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.email}>
            {/*
             * Requirement 8.8: a display name that trims to zero characters is
             * replaced by the email address in the name position. The decision is
             * made on the trimmed length, but the untrimmed name is shown when it
             * survives — the requirement only replaces the empty case.
             */}
            <TableHead scope="row" className="font-normal">
              {row.displayName.trim().length === 0
                ? row.email
                : row.displayName}
            </TableHead>
            <TableCell>{row.email}</TableCell>
            {/* Requirement 8.2: exactly `admin` or `member`, as stored. */}
            <TableCell>{row.role}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/* -------------------------------------------------------------------------- */
/* The route component                                                        */
/* -------------------------------------------------------------------------- */

function AdminRoute() {
  const { overview, rejection } = Route.useLoaderData()

  return <AdminPage overview={overview} rejection={rejection} />
}
