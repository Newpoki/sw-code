# Implementation Plan: mongodb-google-auth-admin

## Overview

The implementation language is TypeScript, as the design document states throughout.

The order below follows the dependency chain the design implies: dependencies and the
Environment_Template, then configuration and allowlist parsing, then the pure document shapes and
mappings, then the Mongo_Store bootstrap, then the counters, then the two rewritten stores, then
the two breaking ripples through every existing caller, then the Data_Import, then Clerk and the
identity seam, then the User_Account mirror, the authorization module, the Access_Gate, the
Admin_Page surface, and finally the shell chrome.

Two documents disagree, and the design wins. Requirement 5 of requirements.md describes a
hand-rolled Google OAuth 2.0 flow; identity is delivered by Clerk. **No task below builds a
Sign_In_State store, an authorization-code exchange, a `user_sessions` collection, or session
cookie handling** — Clerk owns all of it. Criteria 5.3, 5.6, 5.7, 5.8, and 5.9 are obsolete;
5.1, 5.2, 5.4, 5.5, 5.10, 5.12, 5.13, 5.14, and 5.15 are restated onto
`VITE_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` per the design's "Divergences from
requirements.md". Requirements 1, 2, 3, 4, 6, 7, and 8 stand as written.

The design defines exactly 20 correctness properties. Each one becomes exactly one file under
`tests/property/`, tagged

```
// Feature: mongodb-google-auth-admin, Property N: <the property statement>
```

with an explicit `numRuns` of 100 or more at every `fc.assert`. Task 1.4 generalizes the existing
audit in `tests/unit/propertyCoverage.test.ts` to two feature tags **before** the first new
property file lands, because that audit currently asserts exactly 24 files carrying exactly one
feature's tag and would fail on the first addition otherwise.

## Tasks

- [x] 1. Dependencies, the Environment_Template, and the property audit seam
  - [x] 1.1 Add the MongoDB driver as a pinned dependency
    - Add `"mongodb": "6.21.0"` to `dependencies` in `package.json` — an exact version, no range
    - Stay on the 6.x line: the design's `timeoutMS` / CSOT semantics and its
      `retryWrites: false` reasoning are cited from the v6 driver documentation. Bumping to 7.x is
      a deliberate later decision, not a range resolution
    - Install with the repo's package manager (pnpm) and confirm `pnpm typecheck` and
      `pnpm test:run` still pass with nothing importing it yet
    - _Requirements: 1.4, 1.5_

  - [x] 1.2 Add the Clerk SDK as a pinned dependency
    - Add `"@clerk/tanstack-react-start": "1.5.13"` to `dependencies` in `package.json` — an exact
      version, no range
    - Nothing imports it yet; confirm the build and the suite still pass
    - _Requirements: 5.1 (restated), 5.2 (restated)_

  - [x] 1.3 Extend `.env.example` with the five new variables
    - Document `MONGODB_URI` and `MONGODB_DB_NAME`, each with purpose, default, and the
      consequence of leaving it unset
    - Document `VITE_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`, each with purpose, expected
      form, and unset consequence; state that the publishable key is published to the browser by
      design and that the secret key is server-only and never logged
    - Add a note that Google's client id and client secret live in the Clerk dashboard, not in
      this file
    - Document `ADMIN_EMAILS` with its comma separator, its case handling, and the consequence of
      leaving it unset
    - Rewrite the `DATA_FILE` entry: it is now the Data_Import source, read once, never written
    - _Requirements: 1.9, 5.12 (restated), 6.13_

  - [x] 1.4 Generalize `tests/unit/propertyCoverage.test.ts` to audit two feature tags
    - Replace the single `TAG_PREFIX` / `EXPECTED_PROPERTIES` pair with a per-feature inventory
      holding `shared-coupon-redemption` (Properties 1–24) and `mongodb-google-auth-admin`
      (Properties 1–20); keep the prefix fragments split so the audit is not a match for itself
    - Extend, do not duplicate: one audit reading `tests/property/` once and partitioning its
      files by which feature tag they carry
    - Keep every existing assertion for `shared-coupon-redemption` at full strength, including its
      24-file completeness check and its pinned `RUNS_BELOW_MINIMUM` entry
    - For `mongodb-google-auth-admin`, assert the bijection (each tagged number in at most one
      file, each file exactly one number), the explicit-and-≥100 `numRuns` rule, well-formed tags,
      and no tag outside `tests/property/` — over the files that exist so far. The
      all-20-present assertion is switched on by task 22.1, so the suite stays green while the
      property files land one at a time
    - _Requirements: none directly — this is the audit that keeps every property task honest_

  - [x] 1.5 Write the Environment_Template smoke test
    - Assert `.env.example` documents `MONGODB_URI`, `MONGODB_DB_NAME`,
      `VITE_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, and `ADMIN_EMAILS`, each with a purpose, an
      expected form, and an unset consequence, and that it notes where Google's client id and
      secret live
    - _Requirements: 1.9, 5.12 (restated), 6.13_

- [x] 2. Client-safe domain: accounts, roles, and store failure messages
  - [x] 2.1 Create `src/domain/accounts.ts`
    - Define `AccountRole` (`"admin" | "member"`), the Admin_Page view types
      (`AdminAccountRow`, `UserAccountView`), and the Admin_Page read result shapes
    - Implement `parseAdminAllowlist(raw: string | undefined)` applying Requirement 6.1's six
      steps in order: split on `,`, trim, lower-case, drop elements of 0 or more than 254
      characters, drop elements holding no `@`, de-duplicate keeping first occurrence, take the
      first 50 survivors. Total: every input yields an array, possibly empty
    - Implement the role derivation: the folded email's membership of the allowlist decides
      `admin` versus `member`, independently of any role the account already held
    - No I/O, no server imports — this module is client-safe
    - _Requirements: 6.1, 6.2, 6.3, 6.10, 6.14_

  - [x] 2.2 Write property test for Admin_Allowlist parsing
    - **Property 12: Admin_Allowlist parsing is total and normalizing**
    - `tests/property/adminAllowlist.property.test.ts`, tagged, `numRuns: 100` or more
    - **Validates: Requirements 6.1, 6.2**

  - [x] 2.3 Write property test for the Account_Role derivation
    - **Property 13: The Account_Role is the Admin_Allowlist membership of the folded email**
    - `tests/property/accountRole.property.test.ts`, tagged, `numRuns: 100` or more
    - **Validates: Requirements 6.3, 6.10, 6.14**

  - [x] 2.4 Create `src/domain/storeMessages.ts` and extend `src/domain/types.ts`
    - Declare every failure sentence as a module constant or a function returning one, in the
      shape `src/domain/rosterMessages.ts` already uses: `notConfiguredMessage`,
      `unreachableMessage`, `rosterReadFailedMessage`, `rosterWriteFailedMessage(change)`,
      `historyReadFailedMessage`, `historyAppendFailedMessage`, `authorizationUnknownMessage`,
      `notAuthorizedMessage`, `mongoUnavailableCountMessage`
    - No sentence interpolates a driver error, a host name, or any part of the connection string;
      `rosterWriteFailedMessage` interpolates only the caller-supplied Member_Label and operation
    - Add `StoreFailureReason` (`"not-configured" | "unreachable" | "rejected"`) and
      `StoreFailure` to `src/domain/types.ts`
    - Add `STORE_UNAVAILABLE`, `STORE_READ_FAILED`, `STORE_WRITE_FAILED`, `NOT_AUTHENTICATED`,
      `NOT_AUTHORIZED`, and `AUTHORIZATION_UNKNOWN` to `AppErrorCode`, leaving `Envelope<T>`
      unchanged so every existing caller keeps compiling
    - _Requirements: 1.3, 1.5, 1.6, 2.8, 2.14, 3.7, 3.10, 6.15, 8.5_

- [x] 3. Configuration
  - [x] 3.1 Extend `src/server/config.server.ts`
    - Read `MONGODB_URI` exactly once per process, trimmed; expose it only through
      `ServerSecrets.readMongoUri()`
    - Implement and export `resolveDatabaseName(uri, envDbName)`: the trimmed URI path segment,
      else trimmed `MONGODB_DB_NAME`, else `sw-code`
    - Add `mongoConfigured`, `mongoDatabaseName`, `mongoUriParsed`, `clerkConfigured`, and
      `adminAllowlist` to `ServerConfig`; add `readMongoUri` and `readClerkSecretKey` to
      `ServerSecrets`. `ClientConfig` gains nothing — `mongoConfigured` is deliberately absent
      from the client projection because the connection indicator is an Admin_Page value
    - Derive `clerkConfigured` from the presence of both Clerk keys; never read the publishable
      key's value here beyond that check, and never hold the secret key outside its accessor
    - Log at most one startup warning per condition: absent/blank `MONGODB_URI` (naming the
      variable), unparsable `MONGODB_URI` (naming the variable and no part of its value), missing
      Clerk keys (naming each missing variable), empty Admin_Allowlist (naming `ADMIN_EMAILS`)
    - _Requirements: 1.1, 1.2, 1.3, 1.6, 1.10, 5.1 (restated), 5.2 (restated), 5.10 (restated), 6.9_

  - [x] 3.2 Write property test for database-name resolution
    - **Property 1: The database name resolves from the URI, then the variable, then the default**
    - `tests/property/databaseName.property.test.ts`, tagged, `numRuns: 100` or more
    - Needs a connection-string arbitrary assembled from scheme, host, optional path segment, and
      optional query string, with arbitrary surrounding whitespace — add it to
      `tests/property/generators.ts`
    - **Validates: Requirements 1.1, 1.2**

  - [x] 3.3 Extend the startup-warning unit tests
    - In `tests/unit/configStartupWarnings.test.ts`: absent URI, unparsable URI, missing Clerk
      keys, empty allowlist — each asserting exactly one warning naming the right variable, that
      the warning names no part of the URI value, and that no further warning is logged later
    - _Requirements: 1.3, 1.10, 5.2 (restated), 6.9_

- [x] 4. Store_Document shapes and the four mappings
  - [x] 4.1 Create `src/server/store/documents.server.ts`
    - Declare `MemberDocument`, `HistoryDocument`, `HistoryOutcomeDocument`,
      `UserAccountDocument`, and `CounterDocument` exactly as the Data Models section specifies,
      including `entryId` separate from `_id`, `position`, `completedAtMs` beside the authoritative
      `completedAt` string, and the pre-folded `emailLower`
    - Implement `toMemberDocument`, `fromMemberDocument`, `toHistoryDocument`, and
      `fromHistoryDocument`. No I/O. `createdAt` goes out as a BSON `Date` and comes back as the
      domain's ISO string; `completedAt` is stored as the string the domain holds, with the epoch
      milliseconds derived beside it and never read back into the domain
    - Copy each outcome row into a fresh object so a caller cannot reach into stored history;
      truncate response messages to the first 500 characters
    - `position` is supplied by the counter, not by the mapping
    - _Requirements: 2.10, 3.1, 3.8_

  - [x] 4.2 Write property test for the Member_Registry mapping round trip
    - **Property 3: Member_Registry mapping round trip**
    - `tests/property/memberDocumentRoundTrip.property.test.ts`, tagged, `numRuns: 100` or more
    - Generators must reach astral-plane and combining characters in the Member_Label
    - **Validates: Requirements 2.10, 2.11**

  - [x] 4.3 Write property test for the Redemption_History mapping round trip
    - **Property 4: Redemption_History mapping round trip**
    - `tests/property/historyDocumentRoundTrip.property.test.ts`, tagged, `numRuns: 100` or more
    - Generators must reach completion timestamps carrying a UTC offset and fractional seconds,
      and response messages longer than 500 characters
    - **Validates: Requirements 3.8, 3.9**

  - [x] 4.4 Write the mapping-surface smoke test
    - Assert the four mapping functions are exported and callable
    - _Requirements: 2.10, 3.8_

- [x] 5. Checkpoint - the pure layer is complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. The Mongo_Store bootstrap
  - [x] 6.1 Create `src/server/store/mongo.server.ts`
    - One `MongoClient` per process constructed with `timeoutMS: 5_000`,
      `serverSelectionTimeoutMS: 5_000`, `retryWrites: false`, `retryReads: false`,
      `maxPoolSize: 10`. No `Promise.race` around any driver call — `timeoutMS` is the whole of
      the 5-second bound and the driver starts no further attempt
    - Expose `MongoStore` with `ready()`, `collection<T>(name)` returning `CollectionOrFailure<T>`,
      `connected()`, and `close()` as a test seam
    - Bootstrap as a single promise every operation awaits, in the design's order: read the URI
      (absent/blank ⇒ warn once, resolve `ready`, every `collection()` answers `not-configured`);
      construct the client (a constructor throw is the unparsable case ⇒ warn once naming the
      variable and no part of the value, every `collection()` answers `not-configured`);
      `client.connect()` raced against 10 seconds, a loss warning once **without** aborting so the
      driver keeps trying in the background; create the indexes; then the Data_Import slot that
      task 13.1 fills
    - Create `{ hiveId: 1 }` unique and `{ position: 1 }` on `members`, `{ completedAtMs: -1 }`
      and `{ seq: 1 }` on `history`. Await each `createIndex` independently: a rejection logs one
      warning naming the collection and the field and stops neither the other indexes nor the
      bootstrap
    - `connected()` returns true only while a pool is open
    - Follow the existing singleton-with-setter shape (`getMongoStore` / `setMongoStore` /
      `resetMongoStore`, mirroring `setJsonStore` / `resetJsonStore`) so a test can install a store
      over a throwaway database
    - _Requirements: 1.3, 1.4, 1.5, 1.7, 1.8, 1.10, 1.11, 8.3_

  - [x] 6.2 Map driver failures onto `StoreFailure` values
    - Classify by driver error type — server selection, timeout, write rejection — and return the
      matching fixed sentence from `src/domain/storeMessages.ts`
    - Propagate no driver message, no host, and no fragment of the connection string to any
      return value or log line
    - _Requirements: 1.5, 1.6_

  - [x] 6.3 Add the MongoDB test fixture
    - `tests/support/mongoFixture.ts`: a throwaway database per sample, named from the sample
      index, created and dropped in a `finally` — the discipline
      `persistenceRoundTrip.property.test.ts` already applies to temporary `DATA_FILE` directories
    - When the environment supplies no MongoDB, skip with a stated reason rather than passing
      vacuously
    - Properties 5 and 8 and every integration test below depend on this fixture
    - _Requirements: 2.3, 3.6_

  - [x] 6.4 Write unit tests for the bootstrap
    - One client and one pool, reused for the process lifetime (1.4)
    - `connected()` true only while a pool is open (8.3)
    - Index-creation failure: per index and both, asserting one warning per failure naming the
      collection and the field, the surviving index retained, and serving continuing (1.8)
    - _Requirements: 1.4, 1.8, 8.3_

  - [x] 6.5 Write integration tests for the bootstrap
    - Both indexes exist after bootstrap, and the unique index refuses a duplicate Hive_ID (1.7)
    - The constructed client options: `timeoutMS` 5000, `retryWrites` false, `retryReads` false (1.5)
    - An unreachable deployment at startup: startup completes, exactly one warning, operations
      answer unreachable (1.11)
    - No `user_sessions` collection is created (5.7, obsolete)
    - _Requirements: 1.5, 1.7, 1.11_

- [x] 7. Counters
  - [x] 7.1 Create `src/server/store/counters.server.ts`
    - `nextCounterValue(name: CounterName)` as one `findOneAndUpdate` with `$inc: { value: 1 }`,
      `upsert: true`, `returnDocument: "after"`, returning the newly assigned value or a
      `StoreFailure`
    - `CounterName` is `"history_seq" | "member_position"`; an absent document yields 1
    - This is the durable counter Requirement 3.2 needs: it must stay above values on records the
      retention rule deleted and on records a Data_Import inserted, which `max(seq) + 1` over the
      collection forgets
    - _Requirements: 2.1, 3.2_

  - [x] 7.2 Write unit tests for the counter
    - First use of a counter yields 1; successive calls are strictly increasing; a driver failure
      yields a `StoreFailure` carrying the fixed unreachable sentence
    - _Requirements: 3.2_

- [x] 8. Member_Registry over MongoDB
  - [x] 8.1 Rewrite `src/server/store/memberRegistry.server.ts` over the `members` collection
    - Keep the `MemberRegistryStore` name; every method becomes `async` and every read gains a
      `failed` variant. No result carries `persisted` any more
    - `list` / `listEnabled`: sorted by `position` ascending; an empty collection returns zero
      entries and zero error messages
    - `add`: validate (2.12), then uniqueness by pre-read so the message can name the conflicting
      Member_Label (2.4), then the `countDocuments` cap (2.5); take `position` from the counter so
      no insert reads the maximum. An `insertOne` that trips the unique index after a clean
      pre-read is mapped back to `duplicate` by re-reading the conflicting entry, degrading to
      `failed` when that re-read also fails
    - Document, rather than defend, that the cap is checked and not enforced by the database, so
      two simultaneous adds at 99 entries can reach 101; the next add rejects
    - `setEnabled`: write only the enabled state, leaving Member_Label, Hive_ID, creation
      timestamp, and position unchanged; `not-found` for an absent identifier (2.7, 2.13)
    - `remove`: `deleteOne`, no renumbering pass, every remaining position untouched, every
      Redemption_History record left alone (2.6)
    - Every failure path returns `failed` with the matching fixed sentence and leaves the
      collection unchanged (2.8, 2.14)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.12, 2.13, 2.14_

  - [x] 8.2 Write property test for roster mutation sequences
    - **Property 5: A sequence of roster mutations preserves order, identity, and durability**
    - `tests/property/rosterMutationSequence.property.test.ts`, tagged, `numRuns: 100` or more
    - Uses the MongoDB fixture of task 6.3, including the second Mongo_Store built over the same
      database that the property's restart clause requires
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.7, 2.9, 2.13**

  - [x] 8.3 Write property test for rejected roster submissions
    - **Property 6: A rejected roster submission changes nothing and names its reason**
    - `tests/property/rosterSubmissionRejection.property.test.ts`, tagged, `numRuns: 100` or more
    - Includes the clause that a Hive_ID differing only in letter case is accepted
    - **Validates: Requirements 2.4, 2.5, 2.12**

  - [x] 8.4 Write property test for removal preserving history and positions
    - **Property 7: Removing a roster entry preserves the history and every other position**
    - `tests/property/rosterRemovalHistory.property.test.ts`, tagged, `numRuns: 100` or more
    - **Validates: Requirements 2.6**

  - [x] 8.5 Write unit tests for injected roster store failures
    - One per write path (`add`, `setEnabled`, `remove`) and one for the read path, each asserting
      the collection is unchanged and the message names its subject — the attempted change for a
      write, "the roster could not be read" for a read
    - _Requirements: 2.8, 2.14_

- [x] 9. Redemption_History over MongoDB
  - [x] 9.1 Rewrite `src/server/store/history.server.ts` over the `history` collection
    - Keep the `HistoryStore` name; `append`, `list`, and `findLatestByCouponCode` are all async
      and both reads gain a `failed` variant
    - `append` in three steps: take the next `seq` from the counter; `insertOne`; then apply
      retention. An `insertOne` failure is `failed` — the collection unchanged, no partial
      document, no retention delete, and the consumed `seq` simply unused, since 3.2 asks for
      strictly increasing and not gapless
    - Retention: `countDocuments`, and while it exceeds 200 delete the lowest `seq` values until
      exactly 200 remain. A retention failure is **not** reported to the Web_Client: the append
      succeeded, the outcome carries zero warnings, one warning naming the collection is logged,
      and the next append tries the trim again (3.11)
    - `list`: a database sort on `{ completedAtMs: -1, seq: -1 }`, at most 200 records, not a
      comparator in application code; an empty collection returns zero records and zero error
      messages
    - `findLatestByCouponCode`: the same sort with an exact-match filter, limited to one, folding
      nothing — no trim, no case folding. A zero-character code short-circuits to "no record"
      without touching the database
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.10, 3.11, 3.12_

  - [x] 9.2 Write property test for history append sequences
    - **Property 8: A sequence of history appends assigns strictly increasing counters and
      retains the newest 200**
    - `tests/property/historyAppendSequence.property.test.ts`, tagged, using the MongoDB fixture
      of task 6.3 and interleaving rebuilds of the Mongo_Store over the same database
    - State the property itself at `numRuns: 100` or more over small sequences, and put the
      over-the-retention-window case in a **second** `fc.assert` at a low pinned run count in the
      same file — crossing a 200-record window is 200+ round trips per sample. Record that one
      site in `RUNS_BELOW_MINIMUM` in `tests/unit/propertyCoverage.test.ts`, pinned by file and
      value, exactly as the existing `persistenceRoundTrip` exception is pinned
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.6, 3.12**

  - [x] 9.3 Write property test for the history read order and the coupon lookup
    - **Property 9: The history read order is total, and the latest record for a Coupon_Code is
      exact**
    - `tests/property/historyReadOrder.property.test.ts`, tagged, `numRuns: 100` or more
    - Generators must reach records sharing a completion timestamp, timestamps naming the same
      instant in different spellings, and Coupon_Codes differing only in case or whitespace
    - **Validates: Requirements 3.4, 3.5**

  - [x] 9.4 Write unit tests for history store failures
    - Append failure: outcomes returned, exactly one warning, nothing written, no retention
      delete, no URI fragment in the warning (3.7)
    - Read failure: zero records, exactly one error message, no partially read record (3.10)
    - Retention-delete failure: the appended record retained, zero client warnings, one log
      warning naming the collection, and the trim retried at the next append (3.11)
    - _Requirements: 3.7, 3.10, 3.11_

- [x] 10. Checkpoint - both stores answer over MongoDB
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Breaking ripple A — asynchronous stores and the `failed` read case
  - [x] 11.1 Update every store caller in `src/functions/` and `src/server/run/`
    - `list`, `listEnabled`, `findLatestByCouponCode` are now async and can answer `failed`;
      `members.functions.ts`, `history.functions.ts`, `redemption.functions.ts`, and
      `run/coordinator.server.ts` must await them and map `failed` onto `STORE_READ_FAILED`,
      `STORE_WRITE_FAILED`, or `STORE_UNAVAILABLE` envelopes carrying the fixed sentences
    - No caller composes a sentence of its own and none reaches a driver error
    - This is a breaking change to every existing caller; leave the project building and the suite
      passing at the end of it
    - _Requirements: 2.8, 2.14, 3.7, 3.10_

  - [x] 11.2 Update the route loaders in `src/routes/`
    - `/`, `/roster`, and `/history` keep the loader-plus-`router.invalidate()` pattern but must
      now render a store failure: a `failed` read shows the fixed sentence in place of the table,
      so "the database is unreachable" and "the roster is empty" stop looking the same
    - _Requirements: 2.14, 3.10_

  - [x] 11.3 Update the existing test suite to the async seams
    - Every unit, property, and integration test that constructs a store or asserts a synchronous
      read — `storeEdgeCases`, `membersFunctions`, `historyFunctions`, `historyAppendFailure`,
      `redemptionFunctions`, the roster and history page tests, `rosterMutation`,
      `rosterDeletion`, `rosterValidation`, `historyOrdering`, `persistenceRoundTrip`, and the
      redemption integration tests — awaits the new signatures and covers the `failed` case
    - _Requirements: 2.8, 2.14, 3.10_

- [x] 12. Breaking ripple B — deleting `persisted` and `PERSISTENCE_WARNING`
  - [x] 12.1 Delete the flag and the constant
    - Remove `persisted` from every store result and every caller, and delete
      `PERSISTENCE_WARNING` from `src/functions/members.functions.ts` rather than repurposing it.
      A `kind` of `added`, `updated`, or `removed` now means the write is durable
    - A failed write is a rejection, not a success with a warning: Requirement 2.8 supersedes the
      in-memory-with-warning behaviour of the `shared-coupon-redemption` spec
    - The only surviving warning path is the history append of Requirement 3.7, carried by
      `HISTORY_NOT_PERSISTED_WARNING` in `run/coordinator.server.ts`, whose wording is updated to
      the `historyAppendFailedMessage()` sentence
    - Update the comments in `src/routes/roster.tsx` and the store modules that still describe the
      old flush semantics
    - _Requirements: 2.8, 2.9, 3.7, 3.12_

  - [x] 12.2 Retire `jsonStore.server.ts` as the live store
    - Stop wiring `JsonStore` to any request path; the Mongo_Store is the only live store
    - Keep `parseStoreDocument` exported and tested: it is the definition of "the expected shape"
      Requirement 4.1 refers to and the reader the Data_Import uses. Its flush path becomes dead
      code and is wired to nothing
    - _Requirements: 4.1_

- [x] 13. The Data_Import
  - [x] 13.1 Create `src/server/store/dataImport.server.ts` and wire it into the bootstrap
    - Due only while **both** `members` and `history` hold zero documents; otherwise insert
      nothing and log one line stating no Data_Import was due (4.2)
    - Runs inside the Mongo_Store bootstrap before `ready` resolves, which is what makes 4.1's
      "before it answers its first read or write" structural
    - Read through `parseStoreDocument`, whose three failure modes map onto 4.4's three
      conditions: absent file, unreadable within 5 seconds, does not parse. Each logs one warning
      naming the `DATA_FILE` path and which condition occurred, and startup continues with two
      empty collections
    - The write side bounded by a 30-second race: accept entries in document order skipping
      out-of-range labels and Hive_IDs and Hive_IDs duplicating an earlier accepted one, keep the
      first 100; accept records skipping zero-character Coupon_Codes and records with no
      completion timestamp, keep the 200 with the most recent timestamps; assign positions in
      relative order and preserve each `createdAt` or use the startup timestamp; preserve each
      `seq` and assign the remaining ones in relative order; raise both counters above every value
      assigned (4.1, 4.7, 4.8)
    - Log exactly one line with inserted entries, inserted records, skipped entries, skipped
      records, plus one line for discarded-over-cap counts when capping discarded anything. Leave
      `DATA_FILE` byte-identical and in place (4.3, 4.8)
    - Failure or timeout ⇒ abandon, delete every document this import inserted (tracked by
      inserted `_id`), complete startup, log one warning saying it is retried next startup (4.5).
      A rollback delete that itself fails ⇒ complete startup, one warning naming the collection
      that retains documents, no further import attempt — automatic, since a non-empty collection
      is what makes an import not due (4.6)
    - No Mongo connection while an import is due ⇒ insert nothing, one warning, file untouched (4.9)
    - _Requirements: 4.1, 4.2, 4.3, 4.5, 4.6, 4.7, 4.8, 4.9_

  - [x] 13.2 Write property test for the Data_Import plan
    - **Property 10: The Data_Import accepts, orders, counts, and caps deterministically**
    - `tests/property/dataImportPlan.property.test.ts`, tagged, `numRuns: 100` or more
    - Needs a legacy-store-document arbitrary mixing valid elements with out-of-range
      Member_Labels and Hive_IDs, duplicate Hive_IDs, zero-character Coupon_Codes, absent
      completion timestamps, and present and absent creation timestamps and append counter
      values — add it to `tests/property/generators.ts`
    - **Validates: Requirements 4.1, 4.3, 4.7, 4.8**

  - [x] 13.3 Write unit tests for the Data_Import guards
    - The due/not-due truth table (4.2), the three legacy-file conditions (4.4), the rollback and
      the failed rollback (4.5, 4.6), and the no-connection case (4.9)
    - _Requirements: 4.2, 4.4, 4.5, 4.6, 4.9_

- [x] 14. Checkpoint - persistence is complete and the legacy data is imported
  - Ensure all tests pass, ask the user if questions arise.

- [x] 15. Clerk wiring and the identity seam
  - [x] 15.1 Wire Clerk into the application shell
    - Add `clerkMiddleware()` from `@clerk/tanstack-react-start/server` to the `requestMiddleware`
      array in `src/start.ts`, **after** `csrfMiddleware` and **before** the Access_Gate: the gate
      asks who the sender is, and a short-circuit ahead of the handshake would discard its
      `Set-Cookie`
    - Wrap the document body in `<ClerkProvider>` in `src/routes/__root.tsx`
    - Add `src/routes/sign-in.tsx` hosting Clerk's `<SignIn />` — the destination of a
      Requirement 7.8 rejection
    - Build nothing of Clerk's own flow: no Sign_In_State, no code exchange, no session cookie
      handling, no `user_sessions` collection
    - _Requirements: 5.1 (restated), 5.2 (restated), 7.3_

  - [x] 15.2 Create `src/server/identity.server.ts`
    - `Identity` with `configured()`, `current()`, and `profile(userId)`. `current()` is `auth()`
      returning the Clerk `userId` and `sessionId`, or null for a request carrying no valid
      session. `profile()` is `clerkClient().users.getUser(userId)` raced against 5 seconds,
      projected down to the folded email address and the display name and nothing else
    - The display-name rule lives here: `firstName`/`lastName` joined and trimmed, truncated to
      100 characters, falling back to the email address when the result holds zero characters
    - A user with no primary verified email address yields a `ProfileFailure`, which becomes
      "the authorization could not be determined" rather than a sign-in loop
    - The Clerk secret key never leaves this module: nothing here logs it, embeds it, or returns it
    - This module knows Clerk and nothing about MongoDB
    - _Requirements: 5.4 (restated), 5.10 (restated), 5.14 (restated), 5.15 (restated)_

  - [x] 15.3 Write property test for secret redaction
    - **Property 2: No configured secret ever appears in anything the server produces**
    - `tests/property/secretRedaction.property.test.ts`, tagged, `numRuns: 100` or more
    - Drive failures through the store operations, the Admin_Page reads, and the identity refresh,
      including driver errors whose own messages embed the host and the credentials, and assert no
      message, envelope, or log line holds the credentials, the host, the Clerk secret key, or any
      substring of the connection string longer than three characters
    - **Validates: Requirements 1.5, 1.6, 5.10**

  - [x] 15.4 Write the bounded-profile-fetch integration test
    - A stalled Clerk profile fetch answers inside roughly 5 seconds with no User_Account written
    - _Requirements: 5.14 (restated)_

- [x] 16. User_Account mirroring
  - [x] 16.1 Create `src/server/store/userAccounts.server.ts`
    - The `user_accounts` collection with a unique index on `clerkUserId` and a
      `{ lastSignInAt: -1, emailLower: 1 }` index, both created in the bootstrap of task 6.1
    - On-demand upsert, no Clerk webhooks: read the document for the Clerk user id bounded at 5
      seconds; refresh when it is absent, when `lastSyncedAt` is older than `USER_MIRROR_TTL_MS`
      (10 minutes), or when `lastSessionId` differs from the request's session id; otherwise use
      the document as read
    - A refresh calls `Identity.profile()`, derives the Account_Role from the Admin_Allowlist, and
      upserts on `clerkUserId`: email, `emailLower`, display name, role, `lastSyncedAt`,
      `lastSessionId`, and `lastSignInAt` **only** when the session id changed or the document was
      absent. The Clerk user id is the key and never changes; no second document is ever created
      for one identity
    - `listForAdminPage()`: at most 100 rows capped by the query, ordered
      `{ lastSignInAt: -1, emailLower: 1 }`, projected to email, display name, role, and last
      sign-in — no Clerk user id, no Hive_ID
    - A failed upsert fails the authorization decision rather than the sign-in: the person stays
      signed in with Clerk and every Admin_Page request answers "authorization could not be
      determined"
    - _Requirements: 5.4 (restated), 5.5 (restated), 5.13 (restated), 5.15 (restated), 8.2, 8.4_

  - [x] 16.2 Write property test for the User_Account mirror
    - **Property 11: The User_Account mirror is the projection of the most recent Clerk profile**
    - `tests/property/userAccountMirror.property.test.ts`, tagged, `numRuns: 100` or more
    - Needs a Clerk-profile arbitrary reaching zero-character, whitespace-only, and
      over-100-character display names and email addresses in any letter case — add it to
      `tests/property/generators.ts`
    - **Validates: Requirements 5.4, 5.5, 5.15**

- [x] 17. Authorization
  - [x] 17.1 Create `src/server/authorization.server.ts`
    - `createAuthorization({ identity, accounts, allowlist, now })` returning `decide()`, with
      every dependency injected so the whole rule is exercisable without Clerk, without MongoDB,
      and without a server — the pattern `createAuth` already establishes
    - `AuthorizationDecision` is `admin`, `member`, `anonymous`, or `unknown`
    - `decide()` reads the User_Account document on every call and holds no cache, and never takes
      the Account_Role from a Clerk session claim: a role written after the session began must
      decide the current request (6.8)
    - `requireAdmin` at two enforcement points with deliberately different shapes: the `/admin`
      document turns `anonymous` into a redirect to the sign-in page, a server function turns it
      into a `NOT_AUTHENTICATED` envelope, because its caller is `fetch` and would follow a
      redirect into an HTML document. `member` and `unknown` produce `NOT_AUTHORIZED` and
      `AUTHORIZATION_UNKNOWN` in both cases, with no Admin_Page value attached to either
    - This module knows the Account_Role rule and takes persistence and identity as injected seams
    - _Requirements: 5.13 (restated), 6.4, 6.5, 6.6, 6.7, 6.8, 6.15_

  - [x] 17.2 Write property test for Admin_Page authorization
    - **Property 14: No Admin_Page value leaves the server for a non-admin request**
    - `tests/property/adminPageAuthorization.property.test.ts`, tagged, `numRuns: 100` or more
    - Needs an authorization-state arbitrary over request identity, stored account state, and
      endpoint kind — add it to `tests/property/generators.ts`
    - **Validates: Requirements 5.13, 6.4, 6.5, 6.6, 6.7, 6.15**

  - [x] 17.3 Write property test for the per-request role read
    - **Property 15: Every Admin_Page decision reads the Account_Role again**
    - `tests/property/rolePerRequest.property.test.ts`, tagged, `numRuns: 100` or more
    - Asserts each decision performs exactly one read of the User_Account record and uses no value
      stored earlier
    - **Validates: Requirements 6.8**

- [x] 18. The Access_Gate
  - [x] 18.1 Extend `evaluateGate` in `src/server/gate.server.ts`
    - `GateInput` gains `clerkHandshake` and a lazily-invoked `resolveAuthorization()`
    - The decision in order: no Shared_Passphrase configured ⇒ admit and let Requirement 6 govern
      `/admin` (7.5); exempt path or a Clerk handshake ⇒ admit (7.3); valid Passphrase_Session ⇒
      admit **without** calling the resolver, so the common case adds no Mongo read and no Clerk
      call (7.1); otherwise resolve authorization — `admin` admits, `member` rejects directing the
      sender to submit the passphrase and nothing else (7.2), `anonymous` and `unknown` reject
      directing the sender both to submit the passphrase and to sign in (7.8)
    - Add to the exemption list: the `/sign-in` and `/sign-up` prefixes, `/sso-callback`, and any
      path carrying `__clerk_handshake` or `__clerk_db_jwt` — one exemption keyed on a query
      parameter rather than a path, because `clerkMiddleware()` consumes it and a rejection at that
      moment would drop the cookie and loop the browser. Remove nothing. No pathname whatsoever is
      exempt for a server-function request
    - The rejection payload keeps its discipline and gains a second path plus a `needs`
      discriminator; it carries no Member_Registry value, no Redemption_History value, and no
      character of the passphrase. This module keeps importing nothing from `@/server/store`,
      which is how 7.4 stays structural
    - Wire `clerkHandshake` and `resolveAuthorization` from the middleware in `src/start.ts`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.8_

  - [x] 18.2 Write property test for the two-gate admission rule
    - **Property 17: The Access_Gate admits exactly four kinds of request**
    - `tests/property/twoGateAdmission.property.test.ts`, tagged, `numRuns: 100` or more
    - Needs a gate-fact-tuple arbitrary over passphrase configuration, pathname, handler type,
      handshake parameter, Passphrase_Session validity, and authorization state — add it to
      `tests/property/generators.ts`
    - Also asserts the resolver is consulted only for requests that reach the fourth test
    - **Validates: Requirements 7.1, 7.2, 7.3, 7.5, 7.8**

  - [x] 18.3 Write unit tests for the independence of the two mechanisms
    - The gate module's import graph reaches no store module — the only way to test a claim about
      what a module cannot do (7.4)
    - A passphrase alone reaches no Admin_Page value (7.6); signing out of Clerk retains the
      Passphrase_Session (7.7); a wrong passphrase leaves the Clerk session untouched (7.9); an
      expired Passphrase_Session leaves the Clerk session untouched (7.10)
    - The post-sign-in destination, admin and member (5.4 restated)
    - _Requirements: 7.4, 7.6, 7.7, 7.9, 7.10_

  - [x] 18.4 Update `src/routes/login.tsx`
    - Keep the passphrase form and add a sign-in link, with the copy driven by the rejection's
      `needs` discriminator: "submit the passphrase" for a member, "submit the passphrase and sign
      in" for an anonymous or unknown sender
    - _Requirements: 7.2, 7.8_

  - [x] 18.5 Write the middleware-chain integration test
    - A gated request never reaches a store module, and a Clerk handshake request is admitted and
      keeps its `Set-Cookie`
    - _Requirements: 7.1, 7.3, 7.4_

- [x] 19. Checkpoint - identity, authorization, and the gate are wired
  - Ensure all tests pass, ask the user if questions arise.

- [x] 20. The Admin_Page surface
  - [x] 20.1 Create `src/functions/admin.functions.ts`
    - `getAdminOverview` running `requireAdmin` **inside the server function**, not only in the
      route: the route guard is UX, this one is the boundary (6.7)
    - `AdminOverview` with the signed-in email, `memberCount` and `historyCount` as `CountRead`,
      the Mock_Mode state, `connected`, and `accounts` as `AccountsRead` — per-field results, not
      one envelope-wide failure, because a failed count is replaced by a message in its position
      while every value that did arrive is still returned (8.5, 8.6)
    - The three reads run concurrently through `Promise.allSettled`, each under the store's own
      5-second bound, which is also how the response carries everything read within 5 seconds of
      the request (8.9)
    - `connected` comes from `MongoStore.connected()` and is shown whether or not a read failed (8.3)
    - _Requirements: 6.7, 8.1, 8.3, 8.5, 8.6, 8.9_

  - [x] 20.2 Write property test for the Admin_Page account rows
    - **Property 18: The Admin_Page account rows are the newest hundred, ordered and projected**
    - `tests/property/adminAccountRows.property.test.ts`, tagged, `numRuns: 100` or more
    - Generators must reach sets above 100 accounts, colliding sign-in timestamps, emails
      differing only in case, and display names that hold nothing or only whitespace
    - **Validates: Requirements 8.2, 8.7, 8.8**

  - [x] 20.3 Write property test for the Admin_Page projection
    - **Property 19: The Admin_Page response holds no Hive_ID and no identity key**
    - `tests/property/adminPageProjection.property.test.ts`, tagged, `numRuns: 100` or more
    - Asserts over the **serialized** response, so a field added later cannot leak silently
    - **Validates: Requirements 8.4**

  - [x] 20.4 Create `src/routes/admin.tsx`
    - Render the email address, the two counts, the Mock_Mode state as exactly `enabled` or
      `disabled`, the connection indicator in exactly one of its two states, and the account table
    - An empty account list shows the "no Google_Account has signed in" message; a row whose
      display name trims to zero characters shows the email address in the name position
    - Each count a read could not supply is replaced, in its position, by the unreachable message
    - The route guard is `requireAdmin` in its document shape: `anonymous` redirects to the
      sign-in page, `member` and `unknown` show their messages and no Admin_Page value
    - _Requirements: 6.4, 6.5, 6.6, 6.15, 8.1, 8.2, 8.3, 8.5, 8.6, 8.7, 8.8_

  - [x] 20.5 Write property test for partial Admin_Page rendering
    - **Property 20: The Admin_Page displays every value a read supplied and a message for every
      one it did not**
    - `tests/property/adminPagePartialRender.property.test.tsx`, tagged, `numRuns: 100` or more
    - **Validates: Requirements 8.1, 8.5, 8.6**

  - [x] 20.6 Write the bounded Admin_Page integration test
    - An Admin_Page request with one read stalled returns the other two inside roughly 5 seconds
    - _Requirements: 8.9_

- [x] 21. The shell chrome
  - [x] 21.1 Update `src/routes/__root.tsx`
    - The header shows Clerk's `<UserButton>` and the signed-in email address on every page
      rendered for a request carrying a valid Clerk session (5.11)
    - The admin navigation link renders only when the root loader's guarded read reports the
      Admin_Role, and is withheld for `anonymous`, `member`, and `unknown` alike — the same
      "unknown means withhold" reading the Mock_Mode banner already applies (6.11, 6.12)
    - _Requirements: 5.11, 6.11, 6.12_

  - [x] 21.2 Write property test for the shell chrome
    - **Property 16: The shell chrome follows the identity state exactly**
    - `tests/property/shellChrome.property.test.tsx`, tagged, `numRuns: 100` or more
    - **Validates: Requirements 5.11, 6.11, 6.12**

- [x] 22. Close the property audit
  - [x] 22.1 Switch on the completeness assertion for all 20 properties
    - In `tests/unit/propertyCoverage.test.ts`, require every number 1 through 20 of
      `mongodb-google-auth-admin` to be tagged in exactly one file, and the file count to match
    - Confirm the pinned `RUNS_BELOW_MINIMUM` list holds exactly two entries: the existing
      `persistenceRoundTrip` exception and the Property 8 retention case of task 9.2
    - Confirm no tag of either feature lives outside `tests/property/`
    - _Requirements: none directly — this is the audit that keeps the property inventory complete_

- [x] 23. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP, with two exceptions
  worth stating: task 1.4 is **not** optional even though it edits a test file, because the
  existing property audit fails the moment a second feature's tag appears under
  `tests/property/`; and task 6.3's MongoDB fixture is optional only in the sense that Properties
  5 and 8 and every integration test against a real database depend on it, so skipping it skips
  those too.
- The design is authoritative wherever it and requirements.md disagree. Requirement 5's
  hand-rolled OAuth criteria 5.3, 5.6, 5.7, 5.8, and 5.9 are obsolete under Clerk and appear in no
  task; the rest of Requirement 5 is referenced as "(restated)" onto the Clerk keys.
- Nothing here tests Clerk's own behaviour — the anti-forgery state, the code exchange, the
  session token, the cookie and its attributes, session expiry, or the interrupted-sign-in page.
  The seam that is tested is `Identity`; everything downstream of it is ours.
- No task involves user testing, deployment, running the application by hand, or gathering
  performance metrics.
- Every property test file carries exactly one tag of the form
  `// Feature: mongodb-google-auth-admin, Property N: <statement>` and states `numRuns` explicitly
  at every `fc.assert`, at 100 or more apart from the one pinned exception in task 9.2.
- Shared arbitraries go into the existing `tests/property/generators.ts` rather than into
  per-file helpers: connection strings assembled from parts, Clerk profiles, Admin_Allowlists,
  authorization states, gate fact tuples, and legacy store documents mixing valid and invalid
  elements.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.3"] },
    { "id": 1, "tasks": ["1.2", "1.4", "1.5"] },
    { "id": 2, "tasks": ["2.1", "2.4"] },
    { "id": 3, "tasks": ["2.2", "2.3", "3.1", "4.1"] },
    { "id": 4, "tasks": ["3.2", "3.3", "4.2", "4.3", "4.4", "6.1"] },
    { "id": 5, "tasks": ["6.2", "6.3"] },
    { "id": 6, "tasks": ["6.4", "6.5", "7.1"] },
    { "id": 7, "tasks": ["7.2", "8.1"] },
    { "id": 8, "tasks": ["8.2", "8.3", "8.4", "8.5", "9.1"] },
    { "id": 9, "tasks": ["9.2", "9.3", "9.4", "11.1"] },
    { "id": 10, "tasks": ["11.2", "11.3"] },
    { "id": 11, "tasks": ["12.1"] },
    { "id": 12, "tasks": ["12.2"] },
    { "id": 13, "tasks": ["13.1"] },
    { "id": 14, "tasks": ["13.2", "13.3", "15.1", "15.2"] },
    { "id": 15, "tasks": ["15.3", "15.4", "16.1"] },
    { "id": 16, "tasks": ["16.2", "17.1"] },
    { "id": 17, "tasks": ["17.2", "17.3", "18.1"] },
    { "id": 18, "tasks": ["18.2", "18.3", "18.4", "18.5", "20.1"] },
    { "id": 19, "tasks": ["20.2", "20.3", "20.4"] },
    { "id": 20, "tasks": ["20.5", "20.6", "21.1"] },
    { "id": 21, "tasks": ["21.2"] },
    { "id": 22, "tasks": ["22.1"] }
  ]
}
```
