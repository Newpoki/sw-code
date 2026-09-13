/**
 * The User_Account mirror over the `user_accounts` collection of the
 * Mongo_Store (Requirements 5.4 restated, 5.5 restated, 5.13 restated, 5.15
 * restated, 8.2, 8.4).
 *
 * This module owns one document per signed-in identity, keyed on the Clerk user
 * id, and the on-demand rule that keeps it fresh. It reads no environment, opens
 * no `MongoClient`, and composes no HTTP-shaped error: it reports *what the
 * mirror now holds*, or *that authorization could not be determined*, as a
 * discriminated result, and the authorization layer
 * (`src/server/authorization.server.ts`, task 17.1) turns that into a decision.
 *
 * It knows MongoDB and the Account_Role rule, and it knows Clerk only through
 * the injected {@link Identity} seam — it never imports `@clerk/*`. The two
 * indexes it relies on, the unique `clerkUserId` index and the
 * `{ lastSignInAt: -1, emailLower: 1 }` index, are created by the Mongo_Store
 * bootstrap (task 6.1); this module declares neither and simply relies on both.
 *
 * ## On-demand upsert, no webhooks (the four-step rule)
 *
 * Evaluated on any request that needs an Account_Role
 * ({@link UserAccountStore.resolve}):
 *
 * 1. Read the User_Account document for the Clerk user id, bounded at 5 seconds
 *    by the driver's `timeoutMS` (Requirement 6.8). A read failure is not an
 *    empty mirror: it is "the authorization could not be determined", carrying
 *    {@link authorizationUnknownMessage} (Requirement 5.13 restated).
 * 2. Refresh when the document is **absent**, when its `lastSyncedAt` is older
 *    than {@link USER_MIRROR_TTL_MS}, or when its `lastSessionId` differs from
 *    the request's session id. Otherwise use the document as read (step 4).
 * 3. A refresh calls {@link Identity.profile}. A {@link ProfileFailure} — a
 *    stalled or failed Clerk fetch, or a user with no primary verified email
 *    address — is "authorization could not be determined" (Requirements 5.13,
 *    5.15 restated) and writes nothing. Otherwise the Account_Role is derived
 *    from the Admin_Allowlist and the document is upserted on `clerkUserId`:
 *    email, `emailLower`, display name, role, `lastSyncedAt = now`,
 *    `lastSessionId = <current>`, and `lastSignInAt = now` **only** when the
 *    session id changed or the document was absent (Requirement 5.5 restated).
 * 4. Otherwise the document read in step 1 is the answer.
 *
 * ## A failed upsert fails authorization, not the sign-in
 *
 * The person stays signed in with Clerk; only the Admin_Page decision cannot be
 * made. So a failed read *and* a failed upsert both yield the same `unknown`
 * outcome carrying {@link authorizationUnknownMessage} rather than a throw
 * (Requirement 5.13 restated). No sign-in ever fails because the mirror could
 * not be written.
 *
 * ## The key is the key, and it never surfaces on the Admin_Page
 *
 * `clerkUserId` is the upsert key and the unique index guarantees one document
 * per identity — no second document is ever created for one person. But the
 * Admin_Page must exclude it (Requirement 8.4, taking the Google_Subject's
 * place), so {@link UserAccountStore.listForAdminPage} projects it away in the
 * query and returns {@link AdminAccountRow} values that carry no Clerk user id
 * and no Hive_ID.
 *
 * ## No driver text ever leaves this module
 *
 * Every failure this module returns speaks with {@link authorizationUnknownMessage},
 * a fixed sentence from `src/domain/storeMessages.ts`. No driver message, host,
 * or fragment of the Mongo_Connection_URI is read into a returned value
 * (Requirement 1.6).
 */

import {
  deriveAccountRole,
  foldEmail,
  toAdminAccountRow,
} from "@/domain/accounts"
import type {
  AccountRole,
  AccountsRead,
  AdminAccountRow,
  UserAccountView,
} from "@/domain/accounts"
import {
  authorizationUnknownMessage,
  mongoUnavailableCountMessage,
} from "@/domain/storeMessages"
import type { StoreFailure } from "@/domain/types"
import { getIdentity } from "@/server/identity.server"
import type {
  ClerkProfile,
  Identity,
  ProfileFailure,
  RequestIdentity,
} from "@/server/identity.server"
import { serverConfig } from "@/server/config.server"
import type { UserAccountDocument } from "@/server/store/documents.server"
import { driverStoreFailure, getMongoStore } from "@/server/store/mongo.server"
import type { MongoStore } from "@/server/store/mongo.server"
import type { WithId } from "mongodb"

/**
 * How stale a mirrored User_Account may be before a request refreshes it from
 * Clerk: 10 minutes (design "on-demand upsert"). A change on the Clerk side — a
 * renamed account, a changed primary email — is visible to this application
 * within this window, not instantly.
 */
export const USER_MIRROR_TTL_MS = 10 * 60 * 1000

/**
 * At most this many rows leave {@link UserAccountStore.listForAdminPage}
 * (Requirement 8.2). The cap is applied by the query, so a collection larger
 * than this never streams more than this many documents into memory.
 */
export const ADMIN_PAGE_MAX_ROWS = 100

/**
 * The account resolved for the current request, or the reason it could not be.
 *
 * A discriminated result rather than a throw so the authorization layer branches
 * on it: `account` is a {@link UserAccountView} carrying the Clerk user id
 * (because the decision is about a specific mirrored account), and `unknown`
 * carries the {@link StoreFailure} whose message is
 * {@link authorizationUnknownMessage} — the "authorization could not be
 * determined" of Requirements 5.13 and 6.15, which is neither "not signed in"
 * nor "not authorized".
 */
export type ResolveAccountResult =
  | { readonly kind: "account"; readonly account: UserAccountView }
  | { readonly kind: "unknown"; readonly failure: StoreFailure }

/**
 * The User_Account mirror seam. It exposes no MongoDB concept — no `Collection`,
 * no `ObjectId`, no `emailLower` — so the persistence behind it can change
 * without touching the authorization layer.
 */
export interface UserAccountStore {
  /**
   * The four-step on-demand rule: read the mirror for this request's Clerk user
   * id, refresh it from Clerk when it is absent, stale, or from a new session,
   * and answer with the account or with "authorization could not be
   * determined". Reads the document on every call and holds no cache, so a role
   * written after the Clerk session began decides the current request
   * (Requirement 6.8).
   */
  readonly resolve: (identity: RequestIdentity) => Promise<ResolveAccountResult>
  /**
   * The Admin_Page account rows: at most {@link ADMIN_PAGE_MAX_ROWS}, ordered
   * newest sign-in first with the folded email as the tiebreak (Requirement
   * 8.2), projected to email, display name, role, and last sign-in — never the
   * Clerk user id and never a Hive_ID (Requirement 8.4). A read failure is the
   * `ok: false` variant carrying a fixed sentence.
   */
  readonly listForAdminPage: () => Promise<AccountsRead>
}

export interface UserAccountStoreOptions {
  /**
   * The Clerk boundary. Defaults to the process-wide {@link getIdentity}. A test
   * injects a stub and never touches Clerk or the network.
   */
  readonly identity?: Identity
  /**
   * The Admin_Allowlist a refresh derives the Account_Role from. Defaults to
   * {@link serverConfig.adminAllowlist}. Recomputed on every refresh, so an
   * allowlist change takes effect within one TTL for a signed-in person and
   * immediately for the next sign-in.
   */
  readonly allowlist?: readonly string[]
  /** The clock behind `lastSyncedAt`, `lastSignInAt`, and the TTL test. Defaults to the system clock. */
  readonly now?: () => Date
  /** The staleness window. Defaults to {@link USER_MIRROR_TTL_MS}. */
  readonly ttlMs?: number
}

/**
 * A {@link StoreFailure} whose message states that authorization could not be
 * determined. Every failure this module returns carries it, whether the read
 * failed, the Clerk fetch failed, or the upsert failed: from the caller's point
 * of view the Account_Role of the request is what could not be established
 * (Requirements 5.13, 5.15 restated, 6.15).
 *
 * The `reason` is carried through from the underlying {@link StoreFailure} when
 * there is one, so a timeout is still distinguishable from a refusal, and is
 * `unreachable` for a {@link ProfileFailure}, which is the coarse "the identity
 * side did not answer" that a stalled or failed Clerk fetch amounts to.
 */
function authorizationUnknown(
  reason: StoreFailure["reason"] = "unreachable"
): StoreFailure {
  return { reason, message: authorizationUnknownMessage() }
}

/**
 * A profile fetch that did not yield a usable profile is always `unknown`. Only
 * {@link ProfileFailure} carries a `kind`; a {@link ClerkProfile} does not, so
 * its presence is the whole test.
 */
function isProfileFailure(
  result: ClerkProfile | ProfileFailure
): result is ProfileFailure {
  return "kind" in result
}

/** The domain view of a stored document, carrying the Clerk user id. */
function toUserAccountView(
  document: Pick<
    UserAccountDocument,
    "clerkUserId" | "email" | "displayName" | "role" | "lastSignInAt"
  >
): UserAccountView {
  return {
    clerkUserId: document.clerkUserId,
    email: document.email,
    displayName: document.displayName,
    role: document.role,
    lastSignInAt: document.lastSignInAt.toISOString(),
  }
}

/**
 * Whether a present document read in step 1 must be refreshed from Clerk: its
 * `lastSessionId` differs from the request's session id, or its `lastSyncedAt`
 * is older than the TTL. The absent case is handled by the caller, which is the
 * third refresh trigger.
 */
function needsRefresh(
  document: WithId<UserAccountDocument>,
  sessionId: string,
  now: Date,
  ttlMs: number
): boolean {
  if (document.lastSessionId !== sessionId) {
    return true
  }
  return now.getTime() - document.lastSyncedAt.getTime() >= ttlMs
}

/**
 * Builds a User_Account mirror over `store`.
 *
 * Holds no state of its own beyond the injected seams, so two mirrors built over
 * the same Mongo_Store — or over the same database through two Mongo_Stores —
 * see the same `user_accounts` collection. Mirrors the
 * `createMemberRegistryStore(store, options)` shape.
 */
export function createUserAccountStore(
  store: MongoStore,
  options: UserAccountStoreOptions = {}
): UserAccountStore {
  const identity = options.identity ?? getIdentity()
  const allowlist = options.allowlist ?? serverConfig.adminAllowlist
  const now = options.now ?? (() => new Date())
  const ttlMs = options.ttlMs ?? USER_MIRROR_TTL_MS

  /** The `user_accounts` collection, or the failure explaining why there is none. */
  const accounts = () => store.collection<UserAccountDocument>("user_accounts")

  /**
   * Step 3: fetch the Clerk profile, derive the role, and upsert on the Clerk
   * user id. `lastSignInAt` moves to `now` only when the session id changed or
   * the document was absent — `sessionChanged` folds both, since an absent
   * document has no session id to match (Requirement 5.5 restated).
   *
   * The upsert is a single `updateOne` with `upsert: true` keyed on
   * `clerkUserId`, so the unique index guarantees one document per identity and
   * no second document is ever created. `$set` writes the fields a refresh
   * always overwrites; `$setOnInsert` supplies `lastSignInAt` for a document
   * that did not exist, while a session change writes it through `$set`.
   */
  const refresh = async (
    identityForRequest: RequestIdentity,
    sessionChanged: boolean
  ): Promise<ResolveAccountResult> => {
    const profile = await identity.profile(identityForRequest.userId)
    if (isProfileFailure(profile)) {
      /* A stalled or failed Clerk fetch, or no primary verified email: the
       * decision is "authorization could not be determined", and nothing is
       * written (Requirements 5.13, 5.15 restated). */
      return { kind: "unknown", failure: authorizationUnknown() }
    }

    const handle = await accounts()
    if (handle.kind === "failure") {
      return {
        kind: "unknown",
        failure: authorizationUnknown(handle.failure.reason),
      }
    }

    const timestamp = now()
    const role: AccountRole = deriveAccountRole(profile.email, allowlist)
    const emailLower = foldEmail(profile.email)

    /* `$set` overwrites what a refresh always refreshes; `lastSignInAt` joins it
     * only when the sign-in is new, and otherwise is left untouched — which for
     * a first insert means `$setOnInsert` supplies it. */
    const alwaysSet = {
      email: profile.email,
      emailLower,
      displayName: profile.displayName,
      role,
      lastSyncedAt: timestamp,
      lastSessionId: identityForRequest.sessionId,
    }
    const setFields = sessionChanged
      ? { ...alwaysSet, lastSignInAt: timestamp }
      : alwaysSet

    try {
      await handle.collection.updateOne(
        { clerkUserId: identityForRequest.userId },
        {
          $set: setFields,
          $setOnInsert: sessionChanged
            ? { clerkUserId: identityForRequest.userId }
            : {
                clerkUserId: identityForRequest.userId,
                lastSignInAt: timestamp,
              },
        },
        { upsert: true }
      )
    } catch (error) {
      /* A failed upsert fails the authorization decision, not the sign-in: the
       * person stays signed in with Clerk (Requirement 5.13 restated). */
      return {
        kind: "unknown",
        failure: authorizationUnknown(driverStoreFailure(error).reason),
      }
    }

    return {
      kind: "account",
      account: {
        clerkUserId: identityForRequest.userId,
        email: profile.email,
        displayName: profile.displayName,
        role,
        lastSignInAt: timestamp.toISOString(),
      },
    }
  }

  return {
    resolve: async (identityForRequest) => {
      const handle = await accounts()
      if (handle.kind === "failure") {
        // Step 1: a read failure is "authorization could not be determined".
        return {
          kind: "unknown",
          failure: authorizationUnknown(handle.failure.reason),
        }
      }

      let document: WithId<UserAccountDocument> | null
      try {
        document = await handle.collection.findOne({
          clerkUserId: identityForRequest.userId,
        })
      } catch (error) {
        return {
          kind: "unknown",
          failure: authorizationUnknown(driverStoreFailure(error).reason),
        }
      }

      const current = now()
      if (
        document === null ||
        needsRefresh(document, identityForRequest.sessionId, current, ttlMs)
      ) {
        const sessionChanged =
          document === null ||
          document.lastSessionId !== identityForRequest.sessionId
        return refresh(identityForRequest, sessionChanged)
      }

      // Step 4: the document is fresh and from the same session; use it as read.
      return { kind: "account", account: toUserAccountView(document) }
    },

    listForAdminPage: async () => {
      const handle = await accounts()
      if (handle.kind === "failure") {
        return { ok: false, message: mongoUnavailableCountMessage() }
      }

      try {
        const documents = await handle.collection
          .find(
            {},
            {
              sort: { lastSignInAt: -1, emailLower: 1 },
              limit: ADMIN_PAGE_MAX_ROWS,
              /* Requirement 8.4: no `clerkUserId`, no Hive_ID leaves the query. */
              projection: {
                _id: 0,
                email: 1,
                displayName: 1,
                role: 1,
                lastSignInAt: 1,
              },
            }
          )
          .toArray()

        const rows: AdminAccountRow[] = documents.map((document) =>
          toAdminAccountRow({
            /* The projection dropped `clerkUserId`; a placeholder satisfies the
             * view shape and `toAdminAccountRow` drops it again, so it never
             * leaves the server (Requirement 8.4). */
            clerkUserId: "",
            email: document.email,
            displayName: document.displayName,
            role: document.role,
            lastSignInAt: document.lastSignInAt.toISOString(),
          })
        )
        return { ok: true, rows }
      } catch {
        return { ok: false, message: mongoUnavailableCountMessage() }
      }
    },
  }
}

/**
 * A User_Account mirror over the process-wide Mongo_Store.
 *
 * A fresh, stateless wrapper is returned on every call, so installing another
 * store with `setMongoStore` cannot leave a caller holding a mirror bound to the
 * previous connection pool — the shape {@link getMemberRegistryStore} uses.
 */
export function getUserAccountStore(
  options: UserAccountStoreOptions = {}
): UserAccountStore {
  return createUserAccountStore(getMongoStore(), options)
}
