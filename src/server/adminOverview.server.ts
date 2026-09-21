/**
 * The Admin_Page overview assembly (Requirements 6.7, 8.1, 8.3, 8.5, 8.6, 8.9).
 *
 * This is a `.server` module: it reaches the Mongo_Store, the User_Account
 * mirror, the authorization seam, and the server configuration, so it must
 * never enter the browser bundle. It is imported only from inside the
 * `createServerFn` handler in `src/functions/admin.functions.ts` (whose body the
 * client build strips) and from the server-side tests. The route
 * (`src/routes/admin.tsx`) reaches this logic only through that server function
 * — never by importing this module — which is what keeps the client bundle free
 * of every `.server` import (the import-protection boundary the build enforces).
 *
 * ## `requireAdmin` is the boundary here, not only in the route
 *
 * The `/admin` route guard is UX; {@link buildAdminOverview} is the boundary
 * (Requirement 6.7). It runs {@link requireAdminForServerFn} over a fresh
 * authorization decision **before it reads any Admin_Page value**, so a direct
 * `fetch` from an anonymous caller gets a `NOT_AUTHENTICATED` envelope (never a
 * redirect — the caller cannot follow one into an HTML sign-in document), a
 * member gets `NOT_AUTHORIZED`, and an account whose role could not be read gets
 * `AUTHORIZATION_UNKNOWN`. No rejection carries an Admin_Page value, and no count
 * is read before the guard has authorized the request.
 *
 * ## Per-field results, not one envelope-wide failure
 *
 * The overview is a partial page by construction (Requirements 8.5, 8.6): each
 * count and the account list carries its own {@link CountRead}/{@link AccountsRead}
 * result, so a failed read is replaced by a fixed sentence *in its position*
 * while every value that did arrive is still returned. The three reads —
 * `memberCount`, `historyCount`, `accounts` — therefore run concurrently through
 * `Promise.allSettled`, each under the Mongo_Store's own 5-second bound. That is
 * also how Requirement 8.9 is met: the response carries everything read within 5
 * seconds and the failure sentence of everything that was not.
 *
 * ## The connection indicator is shown either way
 *
 * `connected` comes from {@link MongoStore.connected} and is reported whether or
 * not any read failed (Requirement 8.3). A count can fail while the pool is open
 * — a slow query, a refused operation — and the indicator still says the pool is
 * open; a count can succeed while `connected()` is false only in the narrow
 * window the store documents, and the overview reports each fact as it found it.
 *
 * ## No driver text, no Hive_ID, no Clerk user id
 *
 * A count that could not be read carries {@link mongoUnavailableCountMessage},
 * the one fixed sentence for a failed count — never a driver message, a host, or
 * a fragment of the Mongo_Connection_URI (Requirement 1.6). The account rows come
 * from {@link UserAccountStore.listForAdminPage}, whose projection already drops
 * the Clerk user id and the Hive_ID (Requirement 8.4); this module reintroduces
 * neither.
 */

import { mongoUnavailableCountMessage } from "@/domain/storeMessages"
import {
  getAuthorization,
  requireAdminForServerFn,
} from "@/server/authorization.server"
import type { Authorization } from "@/server/authorization.server"
import { serverConfig } from "@/server/config.server"
import { getMongoStore } from "@/server/store/mongo.server"
import type { CollectionName, MongoStore } from "@/server/store/mongo.server"
import { getUserAccountStore } from "@/server/store/userAccounts.server"
import type { UserAccountStore } from "@/server/store/userAccounts.server"
import type { AccountsRead, AdminOverview, CountRead } from "@/domain/accounts"
import type { Envelope } from "@/domain/types"

/**
 * The seams {@link buildAdminOverview} reads from, defaulted to the process-wide
 * singletons.
 *
 * Injectable so the guard boundary (Requirement 6.7) and the partial-page
 * assembly (Requirements 8.5, 8.6, 8.9) can be exercised without booting the
 * framework, the same way the roster and history surfaces take their store as a
 * parameter.
 */
export interface AdminOverviewDeps {
  /** The authorization seam. Defaults to the process-wide {@link getAuthorization}. */
  readonly authorization?: Authorization
  /** The Mongo_Store the counts are read from. Defaults to {@link getMongoStore}. */
  readonly store?: MongoStore
  /** The User_Account mirror the rows are read from. Defaults to {@link getUserAccountStore}. */
  readonly accounts?: UserAccountStore
  /** The Mock_Mode state. Defaults to {@link serverConfig.mockMode}. */
  readonly mockMode?: boolean
}

/**
 * A read envelope: this function writes nothing, so there is nothing to warn
 * about. Mirrors the `read`/`succeeded` helpers of the sibling surfaces.
 */
function overview(data: AdminOverview): Envelope<AdminOverview> {
  return { ok: true, data, warnings: [] }
}

/**
 * The document count of one collection as a {@link CountRead}.
 *
 * Any reason there is no count — the handle lookup reported `not-configured` or
 * `unreachable`, or `countDocuments` itself threw — becomes the single fixed
 * sentence {@link mongoUnavailableCountMessage} in the count's position
 * (Requirement 8.5). The caught error is never read: a driver message names the
 * topology it could not reach, and Requirement 1.6 keeps every part of the
 * Mongo_Connection_URI out of every returned value.
 */
async function countCollection(
  store: MongoStore,
  name: CollectionName
): Promise<CountRead> {
  const handle = await store.collection(name)
  if (handle.kind === "failure") {
    return { ok: false, message: mongoUnavailableCountMessage() }
  }

  try {
    return { ok: true, value: await handle.collection.countDocuments() }
  } catch {
    return { ok: false, message: mongoUnavailableCountMessage() }
  }
}

/** A settled {@link CountRead} promise, folding a rejection to its fixed sentence. */
function settledCount(settled: PromiseSettledResult<CountRead>): CountRead {
  return settled.status === "fulfilled"
    ? settled.value
    : { ok: false, message: mongoUnavailableCountMessage() }
}

/** A settled {@link AccountsRead} promise, folding a rejection to its fixed sentence. */
function settledAccounts(
  settled: PromiseSettledResult<AccountsRead>
): AccountsRead {
  return settled.status === "fulfilled"
    ? settled.value
    : { ok: false, message: mongoUnavailableCountMessage() }
}

/**
 * Assembles the {@link AdminOverview} for an authorized request, or returns the
 * guard's verbatim rejection envelope.
 *
 * The order is deliberate: the authorization decision is read and enforced
 * **first**, and only an `authorized` outcome reaches the reads. A rejection
 * returns before any count is attempted — the boundary refuses before touching
 * an Admin_Page value. The authorized account's `email` becomes the overview
 * email (Requirement 8.1).
 *
 * The three reads then run concurrently through `Promise.allSettled`, each
 * bounded by the Mongo_Store's own 5-second operation timeout, so a stalled read
 * cannot delay the others and the response carries everything served within that
 * bound (Requirement 8.9). `connected` and `mockMode` are read regardless of any
 * read's outcome (Requirement 8.3).
 */
export async function buildAdminOverview(
  deps: AdminOverviewDeps = {}
): Promise<Envelope<AdminOverview>> {
  const authorization = deps.authorization ?? getAuthorization()
  const store = deps.store ?? getMongoStore()
  const accounts = deps.accounts ?? getUserAccountStore()
  const mockMode = deps.mockMode ?? serverConfig.mockMode

  const guard = requireAdminForServerFn(await authorization.decide())
  if (guard.kind === "rejected") {
    /* The boundary refuses before reading any Admin_Page value (Requirement
     * 6.7). The guard's envelope carries no data, so it is the overview
     * envelope's rejection verbatim. */
    return guard.envelope
  }

  const [memberCount, historyCount, accountsRead] = await Promise.allSettled([
    countCollection(store, "members"),
    countCollection(store, "history"),
    accounts.listForAdminPage(),
  ])

  return overview({
    email: guard.account.email,
    memberCount: settledCount(memberCount),
    historyCount: settledCount(historyCount),
    mockMode,
    /* Requirement 8.3: shown whether or not a read above failed. */
    connected: store.connected(),
    accounts: settledAccounts(accountsRead),
  })
}
