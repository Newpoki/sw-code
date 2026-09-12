/**
 * The Mock_Mode indicator: a banner stating that redemption results come from
 * mock data (Requirement 7.4).
 *
 * ## Why this component does not check Mock_Mode itself
 *
 * The shell reads the flag once per document in the root loader and renders this
 * component only while Mock_Mode is enabled, which is what satisfies
 * Requirement 7.8 — while Mock_Mode is disabled nothing is rendered at all.
 * Re-checking here would mean a second read of the same server state, and a
 * component that returns `null` for the disabled case still leaves an empty
 * wrapper in the tree that the shell has to reason about. So the rule is: this
 * component always renders the indicator, and the single call site in
 * `src/routes/__root.tsx` decides whether it appears.
 *
 * Because the banner sits in the shell above the `<Outlet />`, it covers both
 * places Requirement 7.4 names — the redemption page and the result view, which
 * is rendered inside that page — without either page mounting it again.
 *
 * Prop-free on purpose: there is nothing about the mock state to configure, and
 * a `className` escape hatch would invite each page to reposition a banner that
 * belongs to the shell.
 */

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

/**
 * The sentence Requirement 7.4 asks for. Exported so a test asserts the exact
 * text rather than a paraphrase of it.
 */
export const MOCK_MODE_MESSAGE =
  "Redemption results come from mock data. No request reaches the coupon service."

/** The mock-data indicator (Requirement 7.4). */
export function MockModeBanner() {
  return (
    <Alert>
      <AlertTitle>Mock mode</AlertTitle>
      <AlertDescription>{MOCK_MODE_MESSAGE}</AlertDescription>
    </Alert>
  )
}
