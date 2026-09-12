/**
 * Unit tests for the redemption page (Requirements 2.1, 2.4, 2.6, 2.7, 2.8, 2.9,
 * 6.4, 6.8, 7.4, 7.8).
 *
 * The subject is `RedemptionPage` from `src/routes/index.tsx` — the prop-driven
 * half of that module, which takes the roster, the Mock_Mode flag, and the three
 * server functions a redemption needs as props. Every case below renders it with
 * stub collaborators and `@testing-library/react` alone: no router, no query
 * client, no live server.
 *
 * `runRedemption`, `getActiveRun`, and `findLatestRunForCoupon` are deliberately
 * never invoked. A `createServerFn(...).handler(...)` needs the TanStack Start
 * plugin, which the test pipeline does not load, so those functions cannot be
 * called from Vitest at all; the end-to-end run over the real ones belongs to
 * task 16.2. What is under test here is the page's own behaviour, which is
 * exactly what the cited acceptance criteria constrain.
 *
 * Every message is imported from the module that owns it — the two Mock_Mode
 * sentences and the interrupted-stream sentence from the page, the field label,
 * hint, submit label, and empty-roster sentence from `CouponForm`, the dismiss
 * label and dialog title from `ConfirmRunDialog`, and the progress sentence from
 * `RunProgress` — so a test asserts the exact text the application renders rather
 * than a paraphrase that could drift.
 *
 * `jest-dom` is not installed, so assertions are plain DOM reads: `value`,
 * `disabled`, `textContent`, `data-slot` lookups, and `queryBy* === null`.
 * `fireEvent` rather than `userEvent`, because Radix sets `pointer-events: none`
 * on the body while the confirmation dialog is open and a pointer-event-checking
 * driver refuses to click through that.
 */

import { describe, expect, it } from "vitest"
import { act, fireEvent, render, screen, within } from "@testing-library/react"

import {
  CONFIRM_RUN_DIALOG_TITLE,
  DISMISS_LABEL,
} from "@/components/ConfirmRunDialog"
import {
  COUPON_CODE_HINT,
  COUPON_CODE_LABEL,
  NO_ENABLED_MEMBER_MESSAGE,
  SUBMIT_LABEL,
} from "@/components/CouponForm"
import { RUN_PROGRESS_TITLE, formatRunProgress } from "@/components/RunProgress"
import { countOutcomes } from "@/domain/outcomes"
import {
  COUPON_CODE_MAX_LENGTH,
  FIELD_NAMES,
  lengthRangeMessage,
} from "@/domain/schemas"
import {
  MOCK_MODE_PAGE_MESSAGE,
  MOCK_MODE_RESULT_MESSAGE,
  RedemptionPage,
  STREAM_INTERRUPTED_MESSAGE,
} from "@/routes/index"
import type { RedemptionPageProps, RedemptionPayload } from "@/routes/index"
import type {
  ActiveRunSnapshot,
  Envelope,
  MemberOutcome,
  MemberRegistryEntry,
  RedemptionHistoryRecord,
  RedemptionRunResult,
  RunEvent,
} from "@/domain/types"

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const COUPON_CODE = "SPRING2024"
const RUN_ID = "run-1"

/** The 1-to-64 message of Requirement 2.3, from the schema both sides parse with. */
const RANGE_MESSAGE = lengthRangeMessage(
  FIELD_NAMES.couponCode,
  1,
  COUPON_CODE_MAX_LENGTH
)

function entry(
  id: string,
  memberLabel: string,
  enabled = true
): MemberRegistryEntry {
  return {
    id,
    memberLabel,
    hiveId: `hive-${id}`,
    enabled,
    createdAt: "2024-01-01T00:00:00.000Z",
  }
}

/** Three enabled Group_Members, so a run has a total of 3. */
const ROSTER: readonly MemberRegistryEntry[] = [
  entry("m1", "Ada"),
  entry("m2", "Grace"),
  entry("m3", "Linus"),
]

/** A roster that holds entries but no enabled one (Requirement 2.4). */
const DISABLED_ROSTER: readonly MemberRegistryEntry[] = ROSTER.map((member) =>
  entry(member.id, member.memberLabel, false)
)

function successOutcome(position: number): MemberOutcome {
  const member = ROSTER[position]
  return {
    hiveId: member.hiveId,
    memberLabel: member.memberLabel,
    position,
    outcome: "SUCCESS",
    upstreamResult: {
      responseCode: "100",
      responseMessage: "The coupon gift has been sent.",
      outcome: "SUCCESS",
    },
  }
}

const OUTCOMES: readonly MemberOutcome[] = [0, 1, 2].map(successOutcome)

function runResult(
  overrides: Partial<RedemptionRunResult> = {}
): RedemptionRunResult {
  const outcomes = overrides.outcomes ?? OUTCOMES
  return {
    runId: RUN_ID,
    couponCode: COUPON_CODE,
    completedAt: "2024-05-02T10:15:30.000Z",
    mock: false,
    stoppedEarly: false,
    counts: countOutcomes(outcomes),
    warnings: [],
    ...overrides,
    outcomes,
  }
}

function runStarted(total: number, mock = false): RunEvent {
  return {
    type: "run-started",
    runId: RUN_ID,
    total,
    memberLabels: ROSTER.map((member) => member.memberLabel),
    mock,
  }
}

function memberOutcomeEvent(processed: number, total: number): RunEvent {
  return {
    type: "member-outcome",
    runId: RUN_ID,
    processed,
    total,
    outcome: successOutcome(processed - 1),
  }
}

/** The events of a run that starts, reports every outcome, and completes. */
function completedRunEvents(result: RedemptionRunResult): readonly RunEvent[] {
  const total = result.outcomes.length
  return [
    runStarted(total, result.mock),
    ...result.outcomes.map((outcome, index): RunEvent => {
      return {
        type: "member-outcome",
        runId: result.runId,
        processed: index + 1,
        total,
        outcome,
      }
    }),
    { type: "run-completed", runId: result.runId, result },
  ]
}

/** No Redemption_Run in progress, so the mount read leaves the page idle. */
const noActiveRun: RedemptionPageProps["readActiveRun"] = () =>
  Promise.resolve<Envelope<ActiveRunSnapshot | null>>({
    ok: true,
    data: null,
    warnings: [],
  })

/** No matching Redemption_History record, so no previously-used notice renders. */
const noPreviousRun: RedemptionPageProps["findPreviousRun"] = () =>
  Promise.resolve<Envelope<RedemptionHistoryRecord | null>>({
    ok: true,
    data: null,
    warnings: [],
  })

/* -------------------------------------------------------------------------- */
/* Streams                                                                    */
/* -------------------------------------------------------------------------- */

type Step = IteratorResult<RunEvent, undefined>

/**
 * A stream that yields the given events and then ends. Hand-built rather than an
 * `async function*`, so nothing but the events themselves is scheduled.
 */
function streamOf(events: readonly RunEvent[]): AsyncIterable<RunEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<RunEvent> {
      let index = 0
      return {
        next: (): Promise<Step> => {
          if (index >= events.length) {
            return Promise.resolve({ done: true, value: undefined })
          }
          const event = events[index]
          index += 1
          return Promise.resolve({ done: false, value: event })
        },
      }
    },
  }
}

interface ManualRunStream {
  /** Handed to the page as the result of `startRun`. */
  readonly iterable: AsyncIterable<RunEvent>
  /** Delivers one event and lets React re-render before returning. */
  readonly emit: (event: RunEvent) => Promise<void>
  /** Ends the stream without a terminal event. */
  readonly close: () => Promise<void>
}

/**
 * A stream whose events are delivered one at a time by the test.
 *
 * This is what makes the progress assertions of Requirement 2.7 load-bearing: the
 * counter and the disabled control are read *between* events rather than after
 * the stream has drained, so a page that only rendered the final numbers would
 * fail. Events pushed before the page asks for one are buffered, so the test does
 * not have to know whether the `for await` loop is already waiting.
 */
function manualRunStream(): ManualRunStream {
  const waiting: ((step: Step) => void)[] = []
  const buffered: Step[] = []

  function deliver(step: Step): void {
    const next = waiting.shift()
    if (next === undefined) {
      buffered.push(step)
      return
    }
    next(step)
  }

  const iterable: AsyncIterable<RunEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<RunEvent> {
      return {
        next: (): Promise<Step> => {
          const ready = buffered.shift()
          if (ready !== undefined) return Promise.resolve(ready)
          return new Promise<Step>((resolve) => {
            waiting.push(resolve)
          })
        },
      }
    },
  }

  return {
    iterable,
    emit: async (event) => {
      deliver({ done: false, value: event })
      await flush()
    },
    close: async () => {
      deliver({ done: true, value: undefined })
      await flush()
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Lets every pending promise settle and React flush. A macrotask rather than a
 * single microtask tick: consuming one stream event takes several microtask hops
 * (`await` on the iterator, the dispatch, the next `next()` call), and a timer
 * callback runs only once the microtask queue is empty.
 */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
  })
}

/** The visible text of the confirm control, which states the enabled count. */
function confirmLabel(entries: readonly MemberRegistryEntry[]): string {
  const enabled = entries.filter((member) => member.enabled).length
  return `Redeem for ${enabled} group member${enabled === 1 ? "" : "s"}`
}

/** The counter line of the progress indicator (Requirement 2.7). */
function progressText(): string {
  return screen.getByRole("status").textContent
}

async function renderPage(overrides: Partial<RedemptionPageProps> = {}) {
  const entries = overrides.entries ?? ROSTER
  const inner =
    overrides.startRun ??
    ((): Promise<AsyncIterable<RunEvent>> => Promise.resolve(streamOf([])))

  /** Every payload handed to `startRun`, in order. */
  const calls: RedemptionPayload[] = []
  const startRun: RedemptionPageProps["startRun"] = (options) => {
    calls.push(options.data)
    return inner(options)
  }

  const view = render(
    <RedemptionPage
      entries={entries}
      mockMode={overrides.mockMode ?? false}
      loadError={overrides.loadError ?? null}
      startRun={startRun}
      readActiveRun={overrides.readActiveRun ?? noActiveRun}
      findPreviousRun={overrides.findPreviousRun ?? noPreviousRun}
    />
  )

  // The mount read of `getActiveRun` (Requirements 2.7, 2.9) settles here, so
  // every assertion below sees the seeded state rather than a half-mounted page.
  await flush()

  return {
    ...view,
    entries,
    calls,
    input: screen.getByLabelText<HTMLInputElement>(COUPON_CODE_LABEL),
    submit: screen.getByRole<HTMLButtonElement>("button", {
      name: SUBMIT_LABEL,
    }),
  }
}

type Page = Awaited<ReturnType<typeof renderPage>>

/** Enters a Coupon_Code and opens the confirmation dialog. */
async function submit(page: Page, couponCode: string): Promise<void> {
  fireEvent.change(page.input, { target: { value: couponCode } })
  await act(async () => {
    fireEvent.click(page.submit)
  })
}

/** Enters a Coupon_Code, confirms the dialog, and lets the run get under way. */
async function submitAndConfirm(page: Page, couponCode: string): Promise<void> {
  await submit(page, couponCode)
  const dialog = screen.getByRole("dialog", { name: CONFIRM_RUN_DIALOG_TITLE })
  await act(async () => {
    fireEvent.click(
      within(dialog).getByRole("button", { name: confirmLabel(page.entries) })
    )
  })
  await flush()
}

/* -------------------------------------------------------------------------- */
/* Requirement 2.1: one input, one submission control                         */
/* -------------------------------------------------------------------------- */

describe("the coupon code field and the submission control (Requirement 2.1)", () => {
  it("provides exactly one coupon code input and exactly one submission control", async () => {
    const page = await renderPage()

    expect(screen.getAllByLabelText(COUPON_CODE_LABEL)).toHaveLength(1)
    expect(page.container.querySelectorAll("input")).toHaveLength(1)
    // The form is the whole interactive surface of an idle page, so counting
    // every button counts the submission controls.
    expect(screen.getAllByRole("button")).toHaveLength(1)
    expect(page.submit.getAttribute("type")).toBe("submit")
  })

  it("states the permitted length next to the field", async () => {
    const page = await renderPage()
    const hint = screen.getByText(COUPON_CODE_HINT)

    expect(COUPON_CODE_HINT).toContain(String(COUPON_CODE_MAX_LENGTH))
    // The hint describes the field rather than sitting somewhere near it.
    expect(page.input.getAttribute("aria-describedby")).toBe(hint.id)
  })

  it("rejects a 65-character coupon code instead of silently truncating it", async () => {
    const page = await renderPage()
    const tooLong = "C".repeat(COUPON_CODE_MAX_LENGTH + 1)

    fireEvent.change(page.input, { target: { value: tooLong } })
    /* The field carries no DOM `maxLength`, and `CouponForm`'s doc comment says
     * why: a cap of 64 would discard the tail of an over-long paste and make the
     * over-long branch of Requirement 2.3 unreachable. The cap is stated by the
     * hint above and enforced by this rejection, so the whole entered value is
     * still in the field to be corrected. */
    expect(page.input.value).toBe(tooLong)

    await act(async () => {
      fireEvent.click(page.submit)
    })

    expect(screen.getByRole("alert").textContent).toBe(RANGE_MESSAGE)
    expect(page.input.value).toBe(tooLong)
    expect(page.calls).toHaveLength(0)
    expect(screen.queryByRole("dialog")).toBe(null)
  })
})

/* -------------------------------------------------------------------------- */
/* Requirement 2.4: no enabled Group_Member                                   */
/* -------------------------------------------------------------------------- */

describe("the empty-enabled-roster guard (Requirement 2.4)", () => {
  async function assertGuard(
    entries: readonly MemberRegistryEntry[]
  ): Promise<void> {
    const page = await renderPage({ entries })

    await submit(page, COUPON_CODE)

    expect(screen.getByRole("alert").textContent).toBe(
      NO_ENABLED_MEMBER_MESSAGE
    )
    // Nothing was sent, and the dialog that precedes a send never opened.
    expect(page.calls).toHaveLength(0)
    expect(screen.queryByRole("dialog")).toBe(null)
    expect(page.input.value).toBe(COUPON_CODE)
  }

  it("instructs the group member to add a member first when the roster is empty", async () => {
    await assertGuard([])
  })

  it("instructs the group member to add a member first when every entry is disabled", async () => {
    await assertGuard(DISABLED_ROSTER)
  })
})

/* -------------------------------------------------------------------------- */
/* Requirement 2.6: dismissing the confirmation dialog                        */
/* -------------------------------------------------------------------------- */

describe("dismissing the confirmation dialog (Requirement 2.6)", () => {
  it("keeps the entered code and sends nothing when the dismiss control is used", async () => {
    const page = await renderPage()

    await submit(page, COUPON_CODE)
    expect(
      screen.getByRole("dialog", { name: CONFIRM_RUN_DIALOG_TITLE })
    ).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: DISMISS_LABEL }))
    })

    expect(screen.queryByRole("dialog")).toBe(null)
    expect(page.input.value).toBe(COUPON_CODE)
    expect(page.calls).toHaveLength(0)
  })

  it("keeps the entered code and sends nothing when Escape dismisses the dialog", async () => {
    const page = await renderPage()

    await submit(page, COUPON_CODE)

    // Radix listens for Escape on the document, so the key event goes there.
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" })
    })

    expect(screen.queryByRole("dialog")).toBe(null)
    expect(page.input.value).toBe(COUPON_CODE)
    expect(page.calls).toHaveLength(0)
  })
})

/* -------------------------------------------------------------------------- */
/* Requirements 2.7, 2.8, 2.9: progress, disabling, retention                 */
/* -------------------------------------------------------------------------- */

describe("a run in progress (Requirements 2.7, 2.8, 2.9)", () => {
  it("advances the progress indicator as events arrive and keeps the control disabled throughout", async () => {
    const stream = manualRunStream()
    const page = await renderPage({
      startRun: () => Promise.resolve(stream.iterable),
    })

    await submitAndConfirm(page, COUPON_CODE)

    /* The request is in flight and `run-started` has not arrived, so the size of
     * the fixed list is not known yet. The indicator is already displayed and the
     * control is already disabled. */
    expect(screen.getByText(RUN_PROGRESS_TITLE)).toBeTruthy()
    expect(progressText()).toBe(formatRunProgress(0, 0))
    expect(page.submit.disabled).toBe(true)

    await stream.emit(runStarted(3))
    expect(progressText()).toBe(formatRunProgress(0, 3))
    expect(page.submit.disabled).toBe(true)

    for (const processed of [1, 2, 3]) {
      await stream.emit(memberOutcomeEvent(processed, 3))
      expect(progressText()).toBe(formatRunProgress(processed, 3))
      expect(page.submit.disabled).toBe(true)
    }

    const result = runResult()
    await stream.emit({ type: "run-completed", runId: RUN_ID, result })

    // Requirement 2.8: the control is re-enabled and the submitted Coupon_Code
    // is still in the field.
    expect(page.submit.disabled).toBe(false)
    expect(page.input.value).toBe(COUPON_CODE)
    expect(screen.queryByText(RUN_PROGRESS_TITLE)).toBe(null)

    // The result view rendered, with one row per Member_Outcome.
    const view = page.container.querySelector('[data-slot="run-result"]')
    expect(view).not.toBe(null)
    expect(page.container.querySelectorAll("tbody tr")).toHaveLength(
      OUTCOMES.length
    )
    expect(page.calls).toEqual([{ couponCode: COUPON_CODE }])

    // The stream closing after its terminal event changes nothing.
    await stream.close()
    expect(page.submit.disabled).toBe(false)
    expect(page.container.querySelector('[data-slot="run-result"]')).not.toBe(
      null
    )
  })

  it("shows a live progress indicator and a disabled control for a run already in progress", async () => {
    const snapshot: ActiveRunSnapshot = {
      runId: RUN_ID,
      couponCode: "RELOADED2024",
      startedAt: "2024-05-02T10:15:00.000Z",
      mock: false,
      total: 3,
      processed: 2,
      outcomes: [successOutcome(0), successOutcome(1)],
    }

    const page = await renderPage({
      readActiveRun: () =>
        Promise.resolve<Envelope<ActiveRunSnapshot | null>>({
          ok: true,
          data: snapshot,
          warnings: [],
        }),
    })

    // The reload-or-second-tab case: this tab typed nothing, so the run's own
    // Coupon_Code is what the indicator states.
    expect(progressText()).toBe(formatRunProgress(2, 3))
    expect(page.submit.disabled).toBe(true)
    expect(page.input.value).toBe("")
    expect(screen.getByText(snapshot.couponCode)).toBeTruthy()
  })

  it("withholds a submission made while the run is in progress", async () => {
    const stream = manualRunStream()
    const page = await renderPage({
      startRun: () => Promise.resolve(stream.iterable),
    })

    await submitAndConfirm(page, COUPON_CODE)
    await stream.emit(runStarted(3))
    await stream.emit(memberOutcomeEvent(1, 3))

    const form = page.container.querySelector("form")
    if (form === null) throw new Error("expected the coupon form")
    /* Requirement 2.9's second path: the disabled button blocks a click, but a
     * form submission still reaches the handler. jsdom performs no implicit
     * submission for the `Enter` key, so the submit event is dispatched directly. */
    await act(async () => {
      fireEvent.submit(form)
    })

    expect(page.calls).toHaveLength(1)
    expect(progressText()).toBe(formatRunProgress(1, 3))
    expect(screen.queryByRole("dialog")).toBe(null)
  })
})

/* -------------------------------------------------------------------------- */
/* Requirements 6.4, 6.8: the error notification and the run warnings         */
/* -------------------------------------------------------------------------- */

describe("the error notification (Requirement 6.4)", () => {
  it("holds the message of a terminal run-failed event and re-enables the control", async () => {
    const message =
      "The coupon service rejected the request: the daily redemption quota is exhausted."
    const result = runResult({ stoppedEarly: true })
    const page = await renderPage({
      startRun: () =>
        Promise.resolve(
          streamOf([
            runStarted(3),
            memberOutcomeEvent(1, 3),
            { type: "run-failed", runId: RUN_ID, message, result },
          ])
        ),
    })

    await submitAndConfirm(page, COUPON_CODE)

    expect(screen.getByText(message)).toBeTruthy()
    expect(page.submit.disabled).toBe(false)
    expect(page.input.value).toBe(COUPON_CODE)
    // The result set the server built alongside the failure is still shown.
    expect(page.container.querySelector('[data-slot="run-result"]')).not.toBe(
      null
    )
  })

  it("renders every markup character of the returned message as a character", async () => {
    const message = "Invalid coupon code.<br/>Please check again."
    const page = await renderPage({
      startRun: () =>
        Promise.resolve(
          streamOf([
            runStarted(3),
            {
              type: "run-failed",
              runId: RUN_ID,
              message,
              result: runResult({ outcomes: [] }),
            },
          ])
        ),
    })

    await submitAndConfirm(page, COUPON_CODE)

    expect(screen.getByText(message)).toBeTruthy()
    // No `dangerouslySetInnerHTML` anywhere on the path, so `<br/>` stayed six
    // characters instead of becoming a line break.
    expect(page.container.querySelector("br")).toBe(null)
    // A pre-flight rejection carries no Member_Outcome, so there is nothing to
    // report in a result view.
    expect(page.container.querySelector('[data-slot="run-result"]')).toBe(null)
  })

  it("holds the message of a rejected request and re-enables the control", async () => {
    const message = "The redemption endpoint could not be reached."
    const page = await renderPage({
      startRun: () => Promise.reject(new Error(message)),
    })

    await submitAndConfirm(page, COUPON_CODE)

    expect(screen.getByText(message)).toBeTruthy()
    expect(page.submit.disabled).toBe(false)
    expect(page.input.value).toBe(COUPON_CODE)
  })

  it("states that the run stopped reporting when the stream ends without a terminal event", async () => {
    const page = await renderPage({
      startRun: () =>
        Promise.resolve(streamOf([runStarted(3), memberOutcomeEvent(1, 3)])),
    })

    await submitAndConfirm(page, COUPON_CODE)

    expect(screen.getByText(STREAM_INTERRUPTED_MESSAGE)).toBeTruthy()
    expect(page.submit.disabled).toBe(false)
    expect(page.input.value).toBe(COUPON_CODE)
  })

  it("displays the persistence warning of the completed run (Requirement 6.8)", async () => {
    const warning =
      "The redemption history record is not persisted. The outcomes below are complete."
    const result = runResult({ warnings: [warning] })
    const page = await renderPage({
      startRun: () => Promise.resolve(streamOf(completedRunEvents(result))),
    })

    await submitAndConfirm(page, COUPON_CODE)

    const warnings = page.container.querySelectorAll(
      '[data-slot="run-warning"]'
    )
    expect(warnings).toHaveLength(1)
    expect(screen.getByText(warning)).toBeTruthy()
  })
})

/* -------------------------------------------------------------------------- */
/* Requirements 7.4, 7.8: the Mock_Mode indicators                            */
/* -------------------------------------------------------------------------- */

describe("the Mock_Mode indicators (Requirements 7.4, 7.8)", () => {
  const pageIndicator = '[data-slot="mock-mode-page-indicator"]'
  const resultIndicator = '[data-slot="mock-mode-result-indicator"]'

  it("states on the page that results come from mock data while Mock_Mode is enabled", async () => {
    const page = await renderPage({ mockMode: true })

    expect(page.container.querySelector(pageIndicator)?.textContent).toBe(
      MOCK_MODE_PAGE_MESSAGE
    )
  })

  it("shows no page indicator while Mock_Mode is disabled", async () => {
    const page = await renderPage({ mockMode: false })

    expect(page.container.querySelector(pageIndicator)).toBe(null)
    expect(screen.queryByText(MOCK_MODE_PAGE_MESSAGE)).toBe(null)
  })

  it("states in the result view that the displayed outcomes come from mock data", async () => {
    const result = runResult({ mock: true })
    const page = await renderPage({
      mockMode: true,
      startRun: () => Promise.resolve(streamOf(completedRunEvents(result))),
    })

    await submitAndConfirm(page, COUPON_CODE)

    expect(page.container.querySelector(resultIndicator)?.textContent).toBe(
      MOCK_MODE_RESULT_MESSAGE
    )
  })

  it("shows no result indicator for a result the server did not mark as mock", async () => {
    const result = runResult({ mock: false })
    const page = await renderPage({
      mockMode: false,
      startRun: () => Promise.resolve(streamOf(completedRunEvents(result))),
    })

    await submitAndConfirm(page, COUPON_CODE)

    // The result view is there; the indicator is not.
    expect(page.container.querySelector('[data-slot="run-result"]')).not.toBe(
      null
    )
    expect(page.container.querySelector(resultIndicator)).toBe(null)
    expect(screen.queryByText(MOCK_MODE_RESULT_MESSAGE)).toBe(null)
  })
})

/* -------------------------------------------------------------------------- */
/* A failed roster read                                                       */
/* -------------------------------------------------------------------------- */

describe("a failed roster read", () => {
  it("states that the roster is unavailable, holding the returned message", async () => {
    const message = "The member registry could not be read."
    const page = await renderPage({ entries: [], loadError: message })

    expect(screen.getByText("Roster unavailable")).toBeTruthy()
    expect(screen.getByText(message)).toBeTruthy()
    // The form is still rendered, so the failure is stated rather than replacing
    // the page.
    expect(page.input.value).toBe("")
  })
})
