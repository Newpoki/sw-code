# Implementation Plan: shared-coupon-redemption

## Overview

The repository is empty, so the plan scaffolds a TanStack Start + React + Tailwind + shadcn/ui project first, then builds strictly bottom-up so every step is verifiable on its own: the API_Reference_Document and its fixtures, the pure domain layer (types, outcome helpers, zod schemas, Response_Parser), the JSON-backed stores, configuration, the two `UpstreamClient` implementations, the `RunCoordinator`, the `createServerFn` surface, the shared-passphrase gate, and finally the Web_Client pages.

All code is TypeScript. Testing uses Vitest, fast-check for the 24 correctness properties of the design, and @testing-library/react with jsdom for component behaviour. Each of the 24 properties becomes exactly one property-based test, run at `numRuns: 100` minimum, tagged with a comment of the form `// Feature: shared-coupon-redemption, Property N: <statement>`.

## Tasks

- [x] 1. Scaffold the project and the test toolchain
  - [x] 1.1 Scaffold the TanStack Start application with shadcn/ui and install dependencies
    - Run `pnpm dlx shadcn@latest init -t start` in the repository root to produce a TanStack Start + React project with Tailwind CSS and the `@/*` alias configured
    - Add the primitives the design's Web_Client composition needs: `pnpm dlx shadcn@latest add button input card table badge dialog alert switch sonner`
    - Install runtime deps: `pnpm add zod` (no `@tanstack/zod-adapter`: its `zodValidator` throws on a validation failure, which the `Envelope` contract of task 10 forbids — see task 10.1)
    - Install dev deps: `pnpm add -D vitest @vitest/coverage-v8 fast-check @testing-library/react @testing-library/user-event jsdom`
    - Target Node 22 LTS (native `fetch`, `AbortSignal.timeout`); record the engine in `package.json`
    - Documented fallback if the shadcn CLI template is unavailable: `pnpm dlx @tanstack/cli@latest create` (TanStack Start + React, recommended defaults, **without** the `shadcn` add-on) followed by `pnpm dlx shadcn@latest init`, then the same `add` and `pnpm add` commands
    - _Requirements: foundation for all requirements_

  - [x] 1.2 Configure Vitest and the test directory layout
    - Add `vitest.config.ts` reusing the app's Vite config so the `@/*` alias resolves in tests, with the `jsdom` environment for component tests and the node environment for server/domain tests
    - Create `tests/unit/`, `tests/property/`, `tests/integration/` and a `test` script plus a `test:run` (single-run) script in `package.json`
    - _Requirements: foundation for all requirements_

  - [x] 1.3 Create the source skeleton, environment template, and lint guard
    - Create the empty directory layout of the design's project structure: `docs/`, `fixtures/upstream/`, `src/domain/`, `src/server/{store,upstream,run}/`, `src/functions/`, `src/components/`
    - Add `.gitignore` entries for `data/` and `.env`
    - Add `.env.example` documenting `MOCK_MODE`, `UPSTREAM_BASE_URL`, `DATA_FILE`, `APP_PASSPHRASE`, `SESSION_SECRET`
    - Enable the `react/no-danger` ESLint rule so `dangerouslySetInnerHTML` cannot be introduced, which is the enforcement mechanism for literal rendering of upstream messages
    - _Requirements: 6.2_

- [x] 2. Document and mirror the upstream contract
  - [x] 2.1 Write the API_Reference_Document at `docs/upstream-api.md`
    - Document the `checkUser` and `useCoupon` endpoint URLs under `https://event.withhive.com/ci/smon/evt_coupon`, and state that this application calls only `useCoupon`
    - Document the request field names `country`, `lang`, `server`, `hiveid`, `coupon` and, for each, whether it is a Fixed_Request_Field (`FR`, `en`, `europe`) or supplied per Redemption_Run
    - Include the three response body examples as fenced JSON blocks, character-exact: `{"retCode":100,"retMsg":"The coupon gift has been sent."}`, `{"retCode":"(H304)","retMsg":"This coupon code has already been used."}`, `{"retCode":"(H306)","retMsg":"Invalid coupon code.<br/>Please check again."}`, and state the Member_Outcome derived from each (`SUCCESS`, `ALREADY_USED`, `INVALID_COUPON`)
    - _Requirements: 7.1, 7.2_

  - [x] 2.2 Create the three response fixtures
    - `fixtures/upstream/success-100.json`, `fixtures/upstream/already-used-h304.json`, `fixtures/upstream/invalid-coupon-h306.json`, each byte-identical to the corresponding fenced example in `docs/upstream-api.md`
    - _Requirements: 7.3_

  - [x] 2.3 Write a smoke test for the API_Reference_Document
    - Assert `docs/upstream-api.md` names both endpoint URLs, all five request field names, and for each field whether it is fixed or supplied per Redemption_Run
    - _Requirements: 7.1_

  - [x] 2.4 Write a fixture/document byte-identity test
    - Assert each fixture file is byte-identical to the corresponding fenced example in `docs/upstream-api.md`, and that the Member_Outcome the document states for each example equals what `parseUpstreamBody` derives from it, so the document and the mock data cannot drift
    - _Requirements: 7.2, 7.3_

- [x] 3. Build the pure domain layer
  - [x] 3.1 Create `src/domain/types.ts`
    - Declare `MEMBER_OUTCOME_VALUES`, `MemberOutcomeValue`, `MemberRegistryEntry`, `UpstreamResult`, `MemberOutcome` (the `SKIPPED` variant carrying `upstreamResult: null`), `OutcomeCounts`, `RedemptionRunResult`, `ActiveRunSnapshot`, `RunEvent`, `RedemptionHistoryRecord`
    - Declare `AppErrorCode` and the `Envelope<T>` discriminated result envelope with its `warnings` array
    - _Requirements: 3.1, 6.3, 6.5_

  - [x] 3.2 Create `src/domain/outcomes.ts`
    - Implement `countOutcomes` returning all six keys of `OutcomeCounts` including zero counts, in `MEMBER_OUTCOME_VALUES` order
    - Add helpers for building a `SKIPPED` `MemberOutcome` for a roster entry at a position
    - _Requirements: 6.3_

  - [x] 3.3 Create `src/domain/schemas.ts`
    - zod schemas shared by the client forms and the server validators: Member_Label trimmed 1–40, Hive_ID trimmed 1–64, Coupon_Code trimmed 1–64, member id, enabled flag
    - Error messages name the rejected field and its allowed character-count range so client-side and server-side messages cannot drift
    - _Requirements: 1.3, 2.3, 2.10, 3.7_

  - [x] 3.4 Implement the Response_Parser in `src/domain/responseParser.ts`
    - `normalizeRetCode`: string values trimmed with case preserved; number values rendered as a decimal digit string without grouping separators and without trailing fractional zeros (`BigInt(value).toString()` for safe integers to avoid exponential form, non-finite treated as neither number nor string); result truncated to 100 characters
    - `normalizeRetMsg`: `''` when absent, null, or not a string; otherwise truncated to 500 characters, neither trimmed nor unescaped
    - `parseUpstreamBody`: transport-failure flag, absent body, body over 64 KiB, invalid JSON, non-object or missing `retCode`, and non-number/non-string `retCode` each yield `TRANSPORT_ERROR` with an empty code and a message naming which of those conditions occurred; then classify `100` → `SUCCESS`, `(H304)` → `ALREADY_USED`, `(H306)` → `INVALID_COUPON`, empty normalized code → `TRANSPORT_ERROR`, anything else → `UPSTREAM_ERROR`, using exact case-sensitive comparison; never throws
    - `serializeUpstreamResult`: `JSON.stringify({ retCode: responseCode, retMsg: responseMessage })`, `retCode` always a string, message unchanged
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.9, 4.10_

  - [x] 3.5 Create the shared property-test generators in `tests/property/generators.ts`
    - Member_Label and Hive_ID arbitraries including whitespace-padded, empty, boundary lengths (1, 40, 41, 64, 65), and non-ASCII values
    - Response body arbitraries including empty strings, non-JSON, JSON non-objects, bodies over 64 KiB, numeric and string `retCode`, missing and non-string `retMsg`, case variants of the three known codes, and a union with the three fixture bodies read from `fixtures/upstream/`
    - Roster and stubbed-response-sequence arbitraries for the run-loop properties
    - _Requirements: 4.1, 4.6, 4.8, 5.6_

  - [x] 3.6 Write property test for parser totality
    - **Property 1: Response parsing is total and bounded**
    - **Validates: Requirements 4.1, 4.10**
    - `tests/property/responseParser.property.test.ts`, `fc.assert(..., { numRuns: 100 })`, tagged `// Feature: shared-coupon-redemption, Property 1: ...`

  - [x] 3.7 Write property test for code normalization and classification
    - **Property 2: The normalized code determines the Member_Outcome**
    - **Validates: Requirements 4.2, 4.3, 4.4, 4.5, 4.9, 4.10**
    - Tagged `// Feature: shared-coupon-redemption, Property 2: ...`, `numRuns: 100` minimum

  - [x] 3.8 Write property test for malformed response classification
    - **Property 3: Malformed responses classify as TRANSPORT_ERROR with a naming message**
    - **Validates: Requirements 4.6**
    - Tagged `// Feature: shared-coupon-redemption, Property 3: ...`, `numRuns: 100` minimum

  - [x] 3.9 Write property test for the parse/serialize/parse round trip
    - **Property 4: Parse / serialize / parse round trip**
    - **Validates: Requirements 4.7, 4.8**
    - Generator unions arbitrary bodies with the three API_Reference_Document fixtures; the assertion compares the three `UpstreamResult` fields of the first and second parse, not the body text
    - Tagged `// Feature: shared-coupon-redemption, Property 4: ...`, `numRuns: 100` minimum

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement the persistent stores
  - [x] 5.1 Implement `src/server/store/jsonStore.server.ts`
    - Load the versioned document (`version`, `nextHistorySeq`, `members`, `history`) from `DATA_FILE` at startup into memory; absent file starts empty; unparseable file is renamed to `store.corrupt-<timestamp>.json`, the store starts empty, and a warning is logged
    - Mutate in memory synchronously, then enqueue an atomic flush through a single promise chain (write `store.json.tmp`, `fsync`, `rename`, mode `0600`) and resolve callers with `persisted: true | false`; a rejected flush leaves the in-memory mutation in place on purpose
    - _Requirements: 1.7, 1.8, 6.5_

  - [x] 5.2 Implement `src/server/store/memberRegistry.server.ts`
    - `list()` and `listEnabled()` in insertion order; `add()` returning `added` / `duplicate` (with `conflictingLabel`) / `full`; `setEnabled()` returning `updated` / `not-found`; `remove()` returning `removed` / `not-found`
    - Enforce trimmed exact-character Hive_ID uniqueness, the 100-entry cap without mutation on rejection, and `persisted` propagation on every mutation
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 1.9, 1.11, 1.12_

  - [x] 5.3 Implement `src/server/store/history.server.ts`
    - `append()` assigning the monotonic `seq` from `nextHistorySeq`, trimming to the newest 200 records from the front, returning `persisted`
    - `list(limit?)` sorted by `completedAt` descending then `seq` descending; `findLatestByCouponCode()` comparing character-for-character and returning the first match in that order
    - Persist denormalized outcome rows (`hiveId`, `memberLabel`, `outcome`, `responseCode`, `responseMessage`) so roster deletion cannot alter history
    - _Requirements: 6.5, 6.6, 6.7_

  - [x] 5.4 Write property test for roster mutation invariants
    - **Property 12: Roster mutation preserves order, uniqueness, and the cap**
    - **Validates: Requirements 1.1, 1.4, 1.9, 1.11, 1.12**
    - Tagged `// Feature: shared-coupon-redemption, Property 12: ...`, `numRuns: 100` minimum

  - [x] 5.5 Write property test for roster validation
    - **Property 13: Roster validation rejects invalid submissions without mutating**
    - **Validates: Requirements 1.2, 1.3**
    - Tagged `// Feature: shared-coupon-redemption, Property 13: ...`, `numRuns: 100` minimum

  - [x] 5.6 Write property test for the persistence round trip
    - **Property 14: Persistence round trip**
    - **Validates: Requirements 1.7, 6.5**
    - Reload the store from its written file in a temporary `DATA_FILE` and compare entries, order, and retained history records
    - Tagged `// Feature: shared-coupon-redemption, Property 14: ...`, `numRuns: 100` minimum

  - [x] 5.7 Write property test for roster deletion and disabled exclusion
    - **Property 15: Deleting a roster entry preserves history and excludes the entry**
    - **Validates: Requirements 1.5, 1.6**
    - Tagged `// Feature: shared-coupon-redemption, Property 15: ...`, `numRuns: 100` minimum

  - [x] 5.8 Write property test for history ordering
    - **Property 16: History ordering is total and stable**
    - **Validates: Requirements 6.6**
    - Tagged `// Feature: shared-coupon-redemption, Property 16: ...`, `numRuns: 100` minimum

  - [x] 5.9 Write unit tests for the store edge cases
    - Roster mutation with a flush forced to reject: the change stays visible and exactly one persistence warning accompanies the response
    - A corrupt `data/store.json` at startup is renamed aside and the store boots empty
    - The 100-entry cap message and the 200-record history trim keeping the newest records
    - _Requirements: 1.8, 1.11, 6.5_

- [x] 6. Implement server configuration
  - [x] 6.1 Implement `src/server/config.server.ts`
    - Read `MOCK_MODE` once at startup: enabled exactly when the trimmed value equals `true` ignoring case; absent, whitespace-only, or unrecognized means disabled, and an unrecognized value logs a warning naming the variable and the rejected value while startup completes
    - Read `UPSTREAM_BASE_URL` (default `https://event.withhive.com/ci/smon/evt_coupon`), `DATA_FILE` (default `./data/store.json`), `SESSION_SECRET` (generated per process when absent)
    - Read `APP_PASSPHRASE`; when absent or whitespace-only, complete startup, log a prominent warning that the app is reachable without a Shared_Passphrase, and expose the gate as off
    - Never include the passphrase in any returned value or log line
    - _Requirements: 7.5, 7.7, 8.1, 8.9, 8.10_

  - [x] 6.2 Write property test for Mock_Mode environment parsing
    - **Property 23: Mock_Mode environment parsing**
    - **Validates: Requirements 7.5, 7.7**
    - Tagged `// Feature: shared-coupon-redemption, Property 23: ...`, `numRuns: 100` minimum

  - [x] 6.3 Write unit tests for startup warnings
    - An unrecognized `MOCK_MODE` value logs a warning naming the variable and the value, and startup completes with Mock_Mode disabled
    - An absent or whitespace-only `APP_PASSPHRASE` logs the unauthenticated-startup warning and leaves the app usable
    - No log line or returned value contains the passphrase
    - _Requirements: 7.7, 8.9, 8.10_

- [x] 7. Implement the UpstreamClient implementations
  - [x] 7.1 Define the client boundary in `src/server/upstream/client.ts`
    - `UseCouponRequest`, `UpstreamRawResponse` (`bodyText`, `status`, `transportFailure`), and `UpstreamClient` with `isMock` and `useCoupon`; no `checkUser` method exists on the interface
    - Add a hand-written `StubUpstreamClient` under `tests/` that replays a scripted response sequence and records every request, for use by the run-loop tests
    - _Requirements: 3.4_

  - [x] 7.2 Implement `src/server/upstream/live.server.ts`
    - POST to `${UPSTREAM_BASE_URL}/useCoupon` with `country=FR`, `lang=en`, `server=europe`, `hiveid`, `coupon`
    - Use `AbortSignal.timeout(10_000)`; an abort maps to `transportFailure: 'timeout'`, a network failure to `transportFailure: 'network'`, and neither is ever retried
    - Return raw body text; read no fixture on any path
    - _Requirements: 3.3, 3.6, 7.11_

  - [x] 7.3 Write property test for the Fixed_Request_Fields
    - **Property 8: Every upstream request carries the Fixed_Request_Fields**
    - **Validates: Requirements 3.3**
    - Assert over generated Coupon_Codes and Hive_IDs against a captured `fetch` that the five fields carry `FR`, `en`, `europe`, the Group_Member's Hive_ID, and the submitted Coupon_Code
    - Tagged `// Feature: shared-coupon-redemption, Property 8: ...`, `numRuns: 100` minimum

  - [x] 7.4 Write an integration test for `LiveUpstreamClient` against a local server
    - Start a local `http` server that echoes the posted fields, and assert all five fields arrive as specified
    - Start a deliberately slow local endpoint and assert the request is abandoned after 10 seconds with `transportFailure: 'timeout'` and no repeat request
    - _Requirements: 3.3, 3.6_

  - [x] 7.5 Implement `src/server/upstream/mock.server.ts`
    - Read the three fixture files from `fixtures/upstream/` at request time with a per-process cache keyed by file path; never call `fetch`
    - Deterministic selection: `key = ${couponCode}\u0000${hiveId}`, `bucket = fnv1a32(utf8Bytes(key)) % 16`, buckets 0–9 → `success-100.json`, 10–14 → `already-used-h304.json`, 15 → `invalid-coupon-h306.json`, with FNV-1a implemented inline so the mapping is reproducible
    - An absent or unparseable fixture aborts the request with a `FIXTURE_UNAVAILABLE` failure naming the fixture and stating whether it is absent or is not valid JSON, before any Member_Outcome is derived
    - _Requirements: 7.3, 7.6, 7.10_

  - [x] 7.6 Write unit tests for mock fixture handling
    - The same Coupon_Code and Hive_ID pair selects the same fixture across repeated calls and across fresh client instances
    - A deleted fixture and a corrupted fixture each produce a failure naming the fixture and the condition, with no `fetch` call and no derived outcome
    - _Requirements: 7.3, 7.6, 7.10_

  - [x] 7.7 Implement the client factory selected once at startup
    - Choose `MockUpstreamClient` or `LiveUpstreamClient` from the Mock_Mode state read by `config.server.ts`, exposing `isMock` for the history record flag and the client-facing config
    - _Requirements: 7.5, 7.11_

- [x] 8. Implement the RunCoordinator
  - [x] 8.1 Implement the run loop in `src/server/run/coordinator.server.ts`
    - `start(couponCode)` as an async generator: acquire the single-run lock before snapshotting `listEnabled()` as the fixed list, yield `run-started` with `runId`, `total`, `memberLabels`, `mock`
    - Iterate the fixed list sequentially with `await`, at most one request in flight, exactly one `useCoupon` request per Group_Member, parsing each raw body with `parseUpstreamBody` and yielding `member-outcome` with `processed` and `total`
    - Set the `stopped` flag on `INVALID_COUPON` so no further request is issued and remaining Group_Members are recorded as `SKIPPED`; `ALREADY_USED`, `UPSTREAM_ERROR`, and `TRANSPORT_ERROR` fall through with no retry
    - In `finally`, backfill `SKIPPED` for every fixed-list entry without an outcome and release the lock, so the outcome count always equals the fixed-list size even when the run fails before the first request
    - Maintain and expose `snapshot()` returning the `ActiveRunSnapshot` of the run in progress, or null
    - Reject with `NO_ENABLED_MEMBERS` when the fixed list is empty, releasing the lock
    - _Requirements: 3.1, 3.4, 3.5, 3.8, 3.9, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.8_

  - [x] 8.2 Wire the terminal event, counts, and history append
    - Build `RedemptionRunResult` with `stoppedEarly`, the outcomes in processing order, the six `counts` from `countOutcomes`, and `warnings`
    - Append exactly one Redemption_History record holding the submitted Coupon_Code, the completion timestamp, the `mock` flag, and one outcome per fixed-list entry; on a failed append add one warning stating the record is not persisted
    - Yield `run-completed` immediately after, and `run-failed` with the same complete result set when a server failure ended the run
    - _Requirements: 5.7, 6.5, 6.8, 7.9_

  - [x] 8.3 Write property test for the outcome-count invariant
    - **Property 5: Every enabled Group_Member gets exactly one Member_Outcome**
    - **Validates: Requirements 3.1, 5.6, 5.8, 6.3**
    - Generate rosters of 0–100 entries with arbitrary enabled flags plus stubbed response sequences, including `INVALID_COUPON` at any position and a stub that throws mid-run; assert `outcomes.length` equals the fixed-list length, the outcome `hiveId` multiset equals the fixed-list `hiveId` multiset with no duplicates, and the six counts sum to that length
    - Tagged `// Feature: shared-coupon-redemption, Property 5: ...`, `numRuns: 100` minimum

  - [x] 8.4 Write property test for the early stop
    - **Property 6: An invalid coupon stops the run and skips exactly the remainder**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.5**
    - Include cases that mutate the Member_Registry while the run is in progress
    - Tagged `// Feature: shared-coupon-redemption, Property 6: ...`, `numRuns: 100` minimum

  - [x] 8.5 Write property test for non-fatal outcomes
    - **Property 7: Non-fatal outcomes never stop the run and never retry**
    - **Validates: Requirements 3.4, 3.5, 5.4**
    - Assert one `useCoupon` request per enabled Group_Member, no `checkUser` request, Member_Registry order, at most one request in flight, and no `SKIPPED` outcome
    - Tagged `// Feature: shared-coupon-redemption, Property 7: ...`, `numRuns: 100` minimum

  - [x] 8.6 Write property test for the single-run lock
    - **Property 9: At most one Redemption_Run ever executes**
    - **Validates: Requirements 3.9**
    - Tagged `// Feature: shared-coupon-redemption, Property 9: ...`, `numRuns: 100` minimum

  - [x] 8.7 Write property test for Mock_Mode determinism
    - **Property 21: Mock_Mode is deterministic, documented, and offline**
    - **Validates: Requirements 7.3, 7.9**
    - Run the coordinator with `MockUpstreamClient` and assert repeated pairs select the same fixture, every fixture body matches an API_Reference_Document example character for character, `fetch` is never called, and the appended history record is marked as mock
    - Tagged `// Feature: shared-coupon-redemption, Property 21: ...`, `numRuns: 100` minimum

  - [x] 8.8 Write property test for live mode reading no fixture
    - **Property 22: Live mode reads no fixture**
    - **Validates: Requirements 7.11**
    - Instrument fixture file reads and assert the count is zero across generated runs with Mock_Mode disabled
    - Tagged `// Feature: shared-coupon-redemption, Property 22: ...`, `numRuns: 100` minimum

  - [x] 8.9 Write a timed test for the early-stop response bound
    - With a 100-entry roster and a stub yielding `INVALID_COUPON` at the first position, assert the complete result set is returned as a success within 1 second of that outcome being derived
    - _Requirements: 5.7_

  - [x] 8.10 Write a unit test for the history-append failure warning
    - With a store whose flush is forced to reject, assert the Member_Outcomes are still returned together with a warning stating the Redemption_History record is not persisted
    - _Requirements: 6.8_

- [x] 9. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Expose the server function surface
  - [x] 10.1 Implement `src/functions/members.functions.ts`
    - `listMembers`, `addMember`, `setMemberEnabled`, `removeMember` as `createServerFn` functions returning `Envelope<T>` instead of throwing, each attaching a plain non-throwing `.validator(...)` over the schemas in `src/domain/schemas.ts` (not `zodValidator` from `@tanstack/zod-adapter`, which throws and would turn a specified rejection into an exception)
    - Map store results to envelopes: duplicate names the conflicting Member_Label, full states the 100-entry maximum, validation names the field and its range, and a failed flush attaches exactly one persistence warning while a successful flush attaches none
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.8, 1.9, 1.11, 1.12_

  - [x] 10.2 Implement `src/functions/redemption.functions.ts`
    - `runRedemption` as a POST `createServerFn` with an `async function*` handler accepting `{ couponCode }` as its only caller-supplied value and streaming `RunEvent`s
    - Pre-flight rejections delivered as a single terminal `run-failed` event with an empty outcome list: length outside 1–64 after trimming, Mock_Mode fixtures unusable, a Redemption_Run already in progress, and no enabled Group_Member, each issuing zero Upstream_API requests and appending no history record
    - `getActiveRun` returning `Envelope<ActiveRunSnapshot | null>` from `RunCoordinator.snapshot()`
    - _Requirements: 2.10, 3.1, 3.2, 3.7, 3.8, 3.9, 7.6, 7.10_

  - [x] 10.3 Implement `src/functions/history.functions.ts`
    - `listHistory` applying the Requirement 6.6 ordering server-side, with an optional limit
    - `findLatestRunForCoupon` over `HistoryStore.findLatestByCouponCode`, so the character-for-character Coupon_Code comparison of Requirement 6.7 stays on the server and the confirmation dialog receives one record or `null`
    - _Requirements: 6.6, 6.7_

  - [x] 10.4 Implement `src/functions/config.functions.ts`
    - `getAppConfig` returning `{ mockMode }` only, read once in the root route loader; never expose the passphrase or any other secret
    - _Requirements: 7.4, 7.8, 8.10_

  - [x] 10.5 Write property test for out-of-range Coupon_Code rejection
    - **Property 10: The server rejects out-of-range Coupon_Codes without side effects**
    - **Validates: Requirements 2.10, 3.7**
    - Tagged `// Feature: shared-coupon-redemption, Property 10: ...`, `numRuns: 100` minimum

  - [x] 10.6 Write integration tests for the pre-flight rejections
    - No enabled Group_Member: rejection states that no enabled Group_Member exists and issues no upstream request
    - Mock_Mode with a deleted fixture and with a corrupted fixture: rejection names the fixture and the condition, derives no outcome, issues no upstream request, appends no history record
    - A second redemption request during an active run: rejection states a Redemption_Run is in progress and the active run continues unchanged
    - _Requirements: 3.8, 3.9, 7.6, 7.10_

- [x] 11. Implement the shared passphrase gate
  - [x] 11.1 Implement `src/server/auth.server.ts`
    - Signed session cookie issue and verify using `SESSION_SECRET`, set `HttpOnly`, `SameSite=Strict`, `Secure`
    - Constant-time comparison of the submitted value against `APP_PASSPHRASE` via `crypto.timingSafeEqual` over equal-length digests, so the duration does not depend on shared leading characters
    - Generic "the passphrase is incorrect" failure that discloses neither differing characters nor the passphrase length
    - Per-IP failed-attempt throttle: 10 incorrect submissions from the same sender within 5 minutes blocks every further submission from that sender for at least 5 minutes, including a correct value
    - Session invalidation on logout; the passphrase never appears in a response body or a log entry
    - _Requirements: 8.4, 8.5, 8.6, 8.7, 8.8, 8.10_

  - [x] 11.2 Create `src/start.ts` with the global request middleware
    - `createStart(() => ({ requestMiddleware: [csrfMiddleware, passphraseMiddleware] }))`
    - `createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === 'serverFn' })`, registered explicitly because a custom `src/start.ts` disables the automatic installation
    - `passphraseMiddleware` built with `createMiddleware().server(...)`: when a Shared_Passphrase is configured, reject any request without a valid Session before any store read and before `RunCoordinator.start`, returning a response that directs the sender to submit the Shared_Passphrase and holding no Member_Registry or Redemption_History value; when no Shared_Passphrase is configured, admit every request
    - _Requirements: 8.2, 8.3, 8.9_

  - [x] 11.3 Add the `/login` route and the logout control
    - `src/routes/login.tsx` with a passphrase form posting to a login server function that grants a Session on an exact match and shows the generic error otherwise
    - A logout control that invalidates the Session, after which subsequent requests are rejected
    - _Requirements: 8.3, 8.4, 8.5, 8.7_

  - [x] 11.4 Write property test for the Access_Gate
    - **Property 24: Without a valid Session nothing is read and nothing is run**
    - **Validates: Requirements 8.2, 8.3, 8.4, 8.10**
    - Tagged `// Feature: shared-coupon-redemption, Property 24: ...`, `numRuns: 100` minimum

  - [x] 11.5 Write integration tests for the gate behaviours
    - A server function call without a Session is rejected and leaks no roster or history value
    - The correct passphrase issues a Session that admits later calls; logout invalidates it
    - A wrong passphrase returns the generic message and counts toward the per-IP throttle; the active throttle blocks even a correct passphrase
    - An absent `APP_PASSPHRASE` logs the unauthenticated-startup warning and leaves the app usable
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.7, 8.8, 8.9, 8.10_

- [x] 12. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. Build the app shell and the roster page
  - [x] 13.1 Implement `src/routes/__root.tsx`
    - Shell with navigation to `/`, `/roster`, `/history`, the `<Toaster />` for notifications, the `getAppConfig` loader, and `MockModeBanner` rendered only while Mock_Mode is enabled
    - _Requirements: 7.4, 7.8_

  - [x] 13.2 Implement `RosterTable`, `AddMemberForm`, and `MockModeBanner`
    - `RosterTable` renders every Member_Registry entry with its Member_Label, Hive_ID, and enabled state in insertion order, an enable/disable switch, a confirmed removal control, and an empty state instructing the Group_Member to add a Group_Member
    - `AddMemberForm` validates with the shared zod schemas and surfaces duplicate, validation, cap, and persistence-warning messages returned by the server
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.8, 1.9, 1.10, 1.11, 7.4, 7.8_

  - [x] 13.3 Implement `src/routes/roster.tsx`
    - Compose the roster page on the member server functions through a route `loader`, calling `router.invalidate()` after every successful mutation (TanStack Query is not a dependency of this application — see the data-page read mechanism in the design)
    - _Requirements: 1.1, 1.4, 1.5, 1.9_

  - [x] 13.4 Write unit tests for the roster page
    - The empty-roster message, insertion-order rendering, the validation and duplicate messages, the cap message, and the persistence warning being displayed
    - _Requirements: 1.2, 1.3, 1.4, 1.8, 1.10, 1.11_

- [x] 14. Build the redemption page
  - [x] 14.1 Implement `CouponForm` and the run state machine
    - One Coupon_Code input with `maxLength` 64 and one submission control; trim on submit with the letter case of the remainder preserved
    - Client-side length guard showing the 1–64 message, keeping the entered value, and sending nothing; enabled-roster guard showing "add a Group_Member first" and sending nothing
    - `useReducer` machine `idle → confirming → running → completed | failed` that disables the submission control for the whole `running` state, re-enables it and retains the Coupon_Code on completion, and shows an error notification holding the returned message on `run-failed`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.8, 2.9, 6.4_

  - [x] 14.2 Implement `ConfirmRunDialog`
    - Lists the Member_Label of every enabled Group_Member in Member_Registry order, shows the completion timestamp of the most recent Redemption_History record whose Coupon_Code matches character for character, and on dismissal retains the entered value and sends nothing
    - _Requirements: 2.5, 2.6, 6.7_

  - [x] 14.3 Implement `RunProgress`
    - Displays the number of already processed Group_Members and the total of the run, driven by `run-started` and `member-outcome` events
    - _Requirements: 2.7_

  - [x] 14.4 Implement `RunResultTable` and `OutcomeSummary`
    - One row per Member_Outcome of the fixed list in processing order, including `SKIPPED` rows, each holding the Member_Label and the Member_Outcome
    - `UPSTREAM_ERROR` and `TRANSPORT_ERROR` rows render the response message as a React text child truncated with `{message.slice(0, 500)}`, with every markup character visible as a character and no `dangerouslySetInnerHTML`
    - `OutcomeSummary` renders all six counts over `MEMBER_OUTCOME_VALUES`, including counts equal to zero
    - _Requirements: 6.1, 6.2, 6.3_

  - [x] 14.5 Implement `src/routes/index.tsx`
    - Consume the `runRedemption` stream with `for await`, feeding the state machine, and seed the machine from `getActiveRun` on mount so a reload or a second tab shows a correct progress indicator and a disabled submission control
    - Send `{ couponCode }` as the only payload value, and show the Mock_Mode indicator on the page and in the result view while Mock_Mode is enabled
    - _Requirements: 2.7, 2.9, 3.2, 7.4, 7.8_

  - [x] 14.6 Write property test for coupon submission handling
    - **Property 18: Coupon submission trims, preserves case, and blocks invalid lengths**
    - **Validates: Requirements 2.2, 2.3**
    - Tagged `// Feature: shared-coupon-redemption, Property 18: ...`, `numRuns: 100` minimum

  - [x] 14.7 Write property test for the confirmation dialog roster listing
    - **Property 19: The confirmation dialog lists exactly the enabled Group_Members**
    - **Validates: Requirements 2.5**
    - Tagged `// Feature: shared-coupon-redemption, Property 19: ...`, `numRuns: 100` minimum

  - [x] 14.8 Write property test for the previously-used-coupon notice
    - **Property 17: A previously used Coupon_Code is announced with its latest timestamp**
    - **Validates: Requirements 6.7**
    - Tagged `// Feature: shared-coupon-redemption, Property 17: ...`, `numRuns: 100` minimum

  - [x] 14.9 Write property test for result rendering
    - **Property 20: Result rendering is literal and complete**
    - **Validates: Requirements 6.1, 6.2, 6.3**
    - Generate hostile messages containing markup and assert every markup character renders as a visible character, the message is truncated at 500 characters, and all six counts render
    - Tagged `// Feature: shared-coupon-redemption, Property 20: ...`, `numRuns: 100` minimum

  - [x] 14.10 Write property test for the redemption payload
    - **Property 11: The redemption payload carries the Coupon_Code alone**
    - **Validates: Requirements 3.2**
    - Tagged `// Feature: shared-coupon-redemption, Property 11: ...`, `numRuns: 100` minimum

  - [x] 14.11 Write unit tests for the redemption page
    - One coupon input capped at 64 characters and one submission control
    - The empty-enabled-roster guard showing "add a Group_Member first" with no request sent
    - Dialog dismissal retaining the value and sending nothing
    - The progress indicator advancing as `RunEvent`s arrive, the control disabled throughout and re-enabled after, and the Coupon_Code retained
    - The error notification holding a returned error message with the control re-enabled
    - The Mock_Mode indicator present on the page and in the result view when enabled and absent when disabled
    - _Requirements: 2.1, 2.4, 2.6, 2.7, 2.8, 6.4, 7.4, 7.8_

- [x] 15. Build the history page
  - [x] 15.1 Implement `src/routes/history.tsx`
    - Table of retained Redemption_History records in the order the server returns them, each showing the Coupon_Code, the completion timestamp, the mock flag, and its Member_Outcomes, with an empty state stating that no Redemption_Run has been recorded
    - _Requirements: 6.6, 6.9_

  - [x] 15.2 Write unit tests for the history page
    - The empty-history message, and records rendered in the server-provided order including the same-timestamp tie-break
    - _Requirements: 6.6, 6.9_

- [x] 16. Final integration and verification
  - [x] 16.1 Wire the application end to end
    - Confirm every page reaches the server only through the `createServerFn` surface, the roster and history queries invalidate after each successful mutation, the run state machine is the single source of the submission-control disabled state, and the `react/no-danger` rule reports no violation
    - _Requirements: 1.4, 2.8, 2.9, 3.2, 6.4_

  - [x] 16.2 Write an end-to-end integration test of a full Redemption_Run
    - Drive `runRedemption` through the server function with a stubbed `UpstreamClient` over a multi-entry roster including disabled entries, and assert the streamed events, the complete result set, the six counts, and the appended history record
    - _Requirements: 3.1, 5.6, 6.1, 6.3, 6.5_

  - [x] 16.3 Audit property coverage
    - Assert the suite holds exactly one property-based test for each of Properties 1 through 24, each tagged `// Feature: shared-coupon-redemption, Property N: <statement>` and configured with `numRuns` of at least 100
    - _Requirements: 4.1, 5.6, 7.3, 8.2_

- [x] 17. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP; every one of them is a test task
- All 24 correctness properties of the design are covered exactly once: Properties 1–4 in task 3, Property 8 in task 7, Properties 5–7, 9, 21, 22 in task 8, Property 10 in task 10, Properties 12–16 in task 5, Property 23 in task 6, Property 24 in task 11, and Properties 11, 17–20 in task 14
- Each property test lives in `tests/property/`, uses fast-check at `numRuns: 100` minimum, and carries the tag comment `// Feature: shared-coupon-redemption, Property N: <statement>`
- Example, integration, and smoke tests cover what properties cannot: empty states, the 1-second early-stop bound, the 10-second timeout against a local `http` server, the two persistence-warning paths, the fixture-unavailable paths, the Mock_Mode indicator, the document/fixture byte-identity check, and the passphrase gate behaviours
- The build order is bottom-up so each task is verifiable on its own: domain layer, stores, configuration, upstream clients, coordinator, server functions, gate, then UI

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "3.1"] },
    { "id": 3, "tasks": ["3.2", "3.3", "3.4"] },
    { "id": 4, "tasks": ["3.5", "5.1", "6.1", "7.1"] },
    { "id": 5, "tasks": ["2.4", "3.6", "3.7", "3.8", "3.9", "5.2", "5.3", "6.2", "6.3", "7.2", "7.5", "11.1"] },
    { "id": 6, "tasks": ["5.4", "5.5", "5.6", "5.7", "5.8", "5.9", "7.3", "7.4", "7.6", "7.7", "8.1", "11.2"] },
    { "id": 7, "tasks": ["8.2", "11.3"] },
    { "id": 8, "tasks": ["8.3", "8.4", "8.5", "8.6", "8.7", "8.8", "8.9", "8.10", "10.1", "10.2", "10.3", "10.4", "11.4", "11.5"] },
    { "id": 9, "tasks": ["10.5", "10.6", "13.1", "13.2", "15.1"] },
    { "id": 10, "tasks": ["13.3", "14.1", "14.2", "14.3", "14.4"] },
    { "id": 11, "tasks": ["13.4", "14.5", "15.2"] },
    { "id": 12, "tasks": ["14.6", "14.7", "14.8", "14.9", "14.10", "14.11", "16.1"] },
    { "id": 13, "tasks": ["16.2", "16.3"] }
  ]
}
```
