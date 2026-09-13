/**
 * Accounts, roles, and the Admin_Page view shapes for
 * mongodb-google-auth-admin.
 *
 * This module is client-safe by construction: it holds types, two frozen
 * constants, and three pure functions, and it imports nothing from
 * `src/server/`. The Admin_Page renders `AdminAccountRow` in the browser and
 * the shell decides whether to show the admin navigation link from an
 * `AccountRole`, so neither shape may arrive through a `.server` module — the
 * same reasoning `src/domain/rosterMessages.ts` records for the roster
 * sentences.
 *
 * The allowlist parser lives here rather than in `src/server/config.server.ts`
 * so it can be exercised directly, without a process environment
 * (Requirement 6.1).
 */

/** The two Account_Role values. */
export type AccountRole = "admin" | "member"

/**
 * At most this many elements survive Admin_Allowlist parsing
 * (Requirement 6.1, final step).
 */
export const ADMIN_ALLOWLIST_MAX_ENTRIES = 50

/**
 * The longest element Admin_Allowlist parsing keeps, in characters
 * (Requirement 6.1). 254 is the practical maximum length of an email address.
 */
export const ADMIN_ALLOWLIST_MAX_EMAIL_LENGTH = 254

/**
 * The email fold Requirements 6.3 and 6.14 describe: leading and trailing
 * whitespace removed, then lower case. It is the same fold parsing applies to
 * each allowlist element, so membership is decided between two values that were
 * normalized identically.
 */
export function foldEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * The Admin_Allowlist as read from `ADMIN_EMAILS` (Requirement 6.1), applying
 * each step in the order the requirement states it:
 *
 * 1. split on the comma character,
 * 2. remove leading and trailing whitespace from each element,
 * 3. convert each element to lower case,
 * 4. discard elements holding zero characters or more than 254,
 * 5. discard elements holding no commercial at character,
 * 6. retain one element per distinct value, keeping the first occurrence,
 * 7. retain at most the first 50 survivors.
 *
 * Total: every input yields an array, and an absent, blank, or wholly
 * unusable value yields an empty one rather than a failure
 * (Requirement 6.2).
 */
export function parseAdminAllowlist(
  raw: string | undefined
): readonly string[] {
  if (raw === undefined) return []

  const seen = new Set<string>()
  const allowlist: string[] = []

  for (const element of raw.split(",")) {
    const folded = foldEmail(element)

    if (folded.length === 0 || folded.length > ADMIN_ALLOWLIST_MAX_EMAIL_LENGTH)
      continue
    if (!folded.includes("@")) continue
    if (seen.has(folded)) continue

    seen.add(folded)
    allowlist.push(folded)

    if (allowlist.length === ADMIN_ALLOWLIST_MAX_ENTRIES) break
  }

  return allowlist
}

/**
 * Whether a folded email is an element of the Admin_Allowlist. The argument is
 * folded here so a caller may pass the address exactly as the Identity_Provider
 * asserted it.
 */
export function isAllowlisted(
  email: string,
  allowlist: readonly string[]
): boolean {
  return allowlist.includes(foldEmail(email))
}

/**
 * The Account_Role of a User_Account, decided by the membership of its folded
 * email in the Admin_Allowlist and by nothing else (Requirements 6.3, 6.14).
 *
 * No previously held role is an input: a sign-in by an account that held the
 * Member_Role while its address is listed yields the Admin_Role, and a sign-in
 * by an account that held the Admin_Role while its address is no longer listed
 * yields the Member_Role. An empty allowlist therefore makes every account a
 * member (Requirement 6.10).
 */
export function deriveAccountRole(
  email: string,
  allowlist: readonly string[]
): AccountRole {
  return isAllowlisted(email, allowlist) ? "admin" : "member"
}

/**
 * A User_Account as the Redemption_Server read it for the current request, and
 * as the authorization decision carries it. Holds the Clerk user id because the
 * decision is about a specific mirrored account; `AdminAccountRow` deliberately
 * does not (Requirement 8.4).
 */
export interface UserAccountView {
  /** Requirement 5.4 restated: the Clerk user id is the key of the mirror. */
  readonly clerkUserId: string
  readonly email: string
  /** Possibly empty: an Identity_Provider need not assert a name. */
  readonly displayName: string
  readonly role: AccountRole
  /** ISO 8601. */
  readonly lastSignInAt: string
}

/**
 * One Admin_Page account row (Requirement 8.4): no Hive_ID, because the roster
 * appears there as a count and not as a list, and no Clerk user id.
 */
export interface AdminAccountRow {
  readonly email: string
  readonly displayName: string
  readonly role: AccountRole
  /** ISO 8601. */
  readonly lastSignInAt: string
}

/**
 * One Admin_Page count. A failed read is reported in the position of the count
 * it replaces rather than failing the whole page (Requirement 8.5).
 */
export type CountRead =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly message: string }

/** The Admin_Page account rows, or the sentence explaining their absence. */
export type AccountsRead =
  | { readonly ok: true; readonly rows: readonly AdminAccountRow[] }
  | { readonly ok: false; readonly message: string }

/**
 * Everything the Admin_Page displays. Each read carries its own result, so a
 * partial page is representable: every value that arrived is displayed beside
 * the sentences of those that did not, and the connection indicator is shown
 * either way (Requirements 8.5, 8.6).
 */
export interface AdminOverview {
  /** The signed-in email address (Requirement 8.1). */
  readonly email: string
  readonly memberCount: CountRead
  readonly historyCount: CountRead
  readonly mockMode: boolean
  /** Requirement 8.3: true only while a connection pool is open. */
  readonly connected: boolean
  readonly accounts: AccountsRead
}

/** The Admin_Page projection of an account read for the current request. */
export function toAdminAccountRow(account: UserAccountView): AdminAccountRow {
  return {
    email: account.email,
    displayName: account.displayName,
    role: account.role,
    lastSignInAt: account.lastSignInAt,
  }
}
