// Feature: shared-coupon-redemption, Property 11: The redemption payload carries
// the Coupon_Code alone — for any Member_Registry and any submitted Coupon_Code,
// the payload the Web_Client sends to the Redemption_Server holds the Coupon_Code
// as its only value and contains no Hive_ID of any Member_Registry entry.
//
// Validates: Requirements 3.2.
//
// The subject is the redemption page itself, `RedemptionPage` from
// `src/routes/index.tsx`, driven through its `startRun` prop — the seam shaped
// exactly like the `runRedemption` server function, one `data` object and nothing
// else. Recording that call is what makes this property observe the *real*
// payload: the object literal the page builds is the only place a redemption
// payload is constructed, so nothing here restates the payload shape and then
// asserts its own restatement.
//
// `runRedemption` itself is deliberately not invoked. A `createServerFn` handler
// needs the TanStack Start plugin, which the test pipeline does not load, so the
// server function cannot be called from Vitest at all. The end-to-end run over
// the real function belongs to task 16.2; what is under test here is the payload
// the browser builds, which is precisely what Requirement 3.2 constrains.
//
// ## Why each run drives the dialog twice
//
// Requirement 3.2 is about what the payload holds; Requirements 2.5 and 2.6 are
// about when it is sent at all, and the second is what makes the first
// observable — a payload that is never sent trivially holds no Hive_ID. So every
// run submits twice: once dismissed, which must send nothing, and once confirmed,
// which must send exactly one payload. The recorded call count therefore states
// both that a request happened and that it happened only after a confirmation.
//
// ## Why the Hive_IDs look the way they do
//
// The load-bearing assertion is an absence: no Hive_ID appears anywhere in the
// serialized payload. `sentinelHiveIdArb` exists for that — see its note in
// `generators.ts` for why the ordinary Hive_ID arbitrary would produce both false
// alarms (a one-character Hive_ID is a substring of every payload holding the key
// `couponCode`) and missed leaks (a Hive_ID holding a quotation mark is escaped
// on the way into JSON and no longer matches itself).
//
// jsdom, `jest-dom` not installed, so assertions are plain DOM and value reads.
// `fireEvent` rather than `userEvent`: Radix sets `pointer-events: none` on the
// body while a dialog is open, which a pointer-event-checking driver refuses to
// click through, and 100 runs of two dialog cycles each want the cheap path.

import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"

import { DISMISS_LABEL } from "@/components/ConfirmRunDialog"
import { COUPON_CODE_LABEL, SUBMIT_LABEL } from "@/components/CouponForm"
import { RedemptionPage } from "@/routes/index"
import type { RedemptionPageProps } from "@/routes/index"
import type {
  ActiveRunSnapshot,
  Envelope,
  MemberRegistryEntry,
  RedemptionHistoryRecord,
  RunEvent,
} from "@/domain/types"

import { rosterArb, sentinelHiveIdArb, validCouponCodeArb } from "./generators"

/**
 * A stream that ends immediately. The page reacts by reporting an interrupted
 * run, which is irrelevant here: the payload has already been handed over by the
 * time the first chunk would arrive, and yielding no event keeps every run cheap.
 * Hand-built rather than an empty `async function*`, which would be a generator
 * that never yields.
 */
const NO_RUN_EVENTS: AsyncIterable<RunEvent> = {
  [Symbol.asyncIterator](): AsyncIterator<RunEvent> {
    return {
      next: (): Promise<IteratorResult<RunEvent, undefined>> =>
        Promise.resolve({ done: true, value: undefined }),
    }
  },
}

/** No Redemption_Run in progress, so the mount read leaves the page idle. */
const readActiveRun: RedemptionPageProps["readActiveRun"] = () =>
  Promise.resolve<Envelope<ActiveRunSnapshot | null>>({
    ok: true,
    data: null,
    warnings: [],
  })

/** No matching Redemption_History record, so no previously-used notice renders. */
const findPreviousRun: RedemptionPageProps["findPreviousRun"] = () =>
  Promise.resolve<Envelope<RedemptionHistoryRecord | null>>({
    ok: true,
    data: null,
    warnings: [],
  })

/** Lets the mount effect and the two stub promises settle inside `act`. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

/**
 * Reads the own keys of a recorded value without trusting its declared type.
 * The recorded call is held as `unknown` on purpose: the point of the assertion
 * is what arrived at runtime, not what the prop type promised.
 */
function keysOf(value: unknown): string[] {
  return Object.keys(value as object)
}

/** The confirm control's visible text, which states the enabled member count. */
function confirmLabel(entries: readonly MemberRegistryEntry[]): string {
  const enabled = entries.filter((entry) => entry.enabled).length
  return `Redeem for ${enabled} group member${enabled === 1 ? "" : "s"}`
}

describe("Property 11: the redemption payload carries the Coupon_Code alone", () => {
  it("sends { couponCode } and no Hive_ID, once, and only after confirmation", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Small rosters: each run mounts the page and opens the dialog twice, and
        // the payload does not get more constrained by a longer roster.
        rosterArb({
          minLength: 1,
          maxLength: 4,
          atLeastOneEnabled: true,
          hiveIdArb: sentinelHiveIdArb,
        }),
        validCouponCodeArb,
        fc.boolean(),
        async (roster, couponCode, mockMode) => {
          const trimmed = couponCode.trim()

          /* The payload the page is expected to build, derived from the generated
           * Coupon_Code alone. Used for two things: as the exact serialization to
           * compare against, and to discard the vanishingly rare sample whose
           * Coupon_Code happens to spell out one of the generated Hive_IDs, which
           * would make the absence assertion fail without anything having leaked.
           * Note this is computed from the *inputs*, never from the observed
           * payload, so it cannot mask a real leak. */
          const expectedPayload = JSON.stringify({
            data: { couponCode: trimmed },
          })
          for (const entry of roster) {
            fc.pre(!expectedPayload.includes(entry.hiveId))
          }

          /** Every `startRun` call, exactly as it arrived. */
          const calls: unknown[] = []
          const startRun: RedemptionPageProps["startRun"] = (options) => {
            calls.push(options)
            return Promise.resolve(NO_RUN_EVENTS)
          }

          try {
            render(
              <RedemptionPage
                entries={roster}
                mockMode={mockMode}
                startRun={startRun}
                readActiveRun={readActiveRun}
                findPreviousRun={findPreviousRun}
              />
            )
            await flush()

            const input =
              screen.getByLabelText<HTMLInputElement>(COUPON_CODE_LABEL)
            const submit = screen.getByRole("button", { name: SUBMIT_LABEL })

            fireEvent.change(input, { target: { value: couponCode } })

            /* First cycle: submit, then dismiss. Requirement 2.6 — nothing may be
             * sent, which is the half of the property that makes "sent only after
             * confirmation" observable. */
            await act(async () => {
              fireEvent.click(submit)
            })
            /* The dialog is mounted by the dispatch the click above performed, so
             * it is already in the DOM — a `findBy*` would only add polling. Radix
             * renders into a portal on `document.body`, which is exactly what
             * `screen` queries. */
            const dismiss = screen.getByRole("button", { name: DISMISS_LABEL })
            await act(async () => {
              fireEvent.click(dismiss)
            })
            expect(calls).toHaveLength(0)

            /* Second cycle: submit the retained value and confirm. This is the one
             * moment a request may be sent (Requirement 2.5). */
            await act(async () => {
              fireEvent.click(submit)
            })
            const confirm = screen.getByRole("button", {
              name: confirmLabel(roster),
            })
            await act(async () => {
              fireEvent.click(confirm)
            })

            /* Exactly one request per confirmed submission. */
            expect(calls).toHaveLength(1)
            const call = calls[0]

            // The call argument holds the payload and nothing beside it.
            expect(keysOf(call)).toStrictEqual(["data"])
            const payload = (call as { readonly data: unknown }).data

            // The Coupon_Code is the only value in the payload...
            expect(keysOf(payload)).toStrictEqual(["couponCode"])
            // ...and it is the trimmed submission, letter case preserved.
            expect(
              (payload as { readonly couponCode: unknown }).couponCode
            ).toBe(trimmed)

            /* The absence assertion of Requirement 3.2: no key anywhere in what
             * was handed over holds a Hive_ID of any Member_Registry entry —
             * including the disabled ones, and including a Hive_ID nested below
             * `data`, which is why the whole call argument is serialized. */
            const serialized = JSON.stringify(call)
            for (const entry of roster) {
              expect(serialized.includes(entry.hiveId)).toBe(false)
            }

            /* Stronger than the sum of the assertions above: the call argument is
             * character for character the payload built from the Coupon_Code, so
             * no extra value of any kind travelled with it. */
            expect(serialized).toBe(expectedPayload)
          } finally {
            // One `it` performs 100 renders through a portal; the registered
            // `afterEach` cleanup only runs once, after all of them.
            cleanup()
          }
        }
      ),
      { numRuns: 100 }
    )
  })
})
