/**
 * The Admin_Page server function surface (Requirements 6.7, 8.1, 8.3, 8.5, 8.6,
 * 8.9).
 *
 * One guarded read, {@link getAdminOverview}, returning an {@link Envelope}
 * instead of throwing, exactly as `src/functions/members.functions.ts` and
 * `src/functions/history.functions.ts` do. The whole of its logic — the
 * `requireAdmin` boundary, the three concurrent reads, and the partial-page
 * assembly — lives in {@link buildAdminOverview} in
 * `src/server/adminOverview.server.ts`, and is called **only inside the
 * handler body below**, which the client build strips.
 *
 * ## Why the assembly is not exported from this module
 *
 * `src/routes/admin.tsx` imports `getAdminOverview` from this file at module
 * scope, so everything this file imports at module scope enters the client
 * bundle. `buildAdminOverview` reaches the Mongo_Store, the User_Account mirror,
 * and the authorization seam — all `.server` modules the browser must not load —
 * so it lives in a `.server` module and is imported here only for use inside the
 * `createServerFn` handler, whose body is removed from the client build. That is
 * the same discipline `members.functions.ts` follows: the only `.server` value
 * it names (`getMemberRegistryStore`) is referenced solely inside handler
 * bodies, never at module scope. Importing `buildAdminOverview` at module scope
 * is safe for the same reason `getMemberRegistryStore` is: it is used only
 * inside the stripped handler.
 */

import { createServerFn } from "@tanstack/react-start"

import { buildAdminOverview } from "@/server/adminOverview.server"

/**
 * The Admin_Page overview for the signed-in admin (Requirements 6.7, 8.1, 8.3,
 * 8.5, 8.6, 8.9).
 *
 * A `GET`: it writes nothing, and it takes no caller-supplied value. Unlike the
 * roster and history reads, its authorization is *not* the global Access_Gate —
 * it is the per-request Admin_Role check `requireAdminForServerFn` makes inside
 * {@link buildAdminOverview}, so this boundary refuses an anonymous, member, or
 * unknown caller with an envelope rather than a redirect. `buildAdminOverview`
 * is reached only here, inside the handler body the client build strips, so its
 * `.server` dependencies never enter the browser bundle.
 */
export const getAdminOverview = createServerFn().handler(async () =>
  buildAdminOverview()
)
