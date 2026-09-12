# Requirements Document

## Introduction

Summoners War distributes coupon codes that players redeem individually on the official Hive event page. A group of friends currently shares each new code by hand, and every member repeats the same manual form submission.

This feature replaces that manual sharing with a small self-hosted web application. One member enters a coupon code once, and the application redeems that code for every registered member of the group by calling the official `useCoupon` endpoint directly on their behalf, without the preliminary `checkUser` call that the official page performs. Every member is on the `europe` server, uses `en` as language and `FR` as country, so those three values are fixed by the application and are never entered by a member.

Because the official endpoints reject cross-origin browser requests, all upstream traffic is issued from a TypeScript server layer inside the same repository (TanStack Start), and the browser only talks to that server layer. The application also ships a documented set of real upstream request and response examples so the upstream behaviour can be mocked in tests and local development.

## Glossary

- **Redemption_App**: The complete application, composed of the Web_Client, the Redemption_Server, the Member_Registry, and the Redemption_History.
- **Web_Client**: The browser-side React application (React, Tailwind CSS, shadcn/ui components) through which a Group_Member interacts with the Redemption_App.
- **Redemption_Server**: The TypeScript server-side layer of the TanStack Start application. It is the only component that issues requests to the Upstream_API.
- **Upstream_API**: The official Hive event service at `https://event.withhive.com/ci/smon/evt_coupon`, exposing the `checkUser` and `useCoupon` endpoints. The Redemption_App calls only the `useCoupon` endpoint.
- **Group_Member**: A person registered in the Member_Registry, identified by a Member_Label and a Hive_ID.
- **Hive_ID**: The account identifier a player supplies to the Upstream_API as the `hiveid` request field.
- **Member_Label**: A human-readable name that identifies a Group_Member in the Web_Client.
- **Member_Registry**: The persistent store holding the list of Group_Members.
- **Coupon_Code**: The string a Group_Member enters, sent to the Upstream_API as the `coupon` request field.
- **Fixed_Request_Fields**: The constant Upstream_API request fields `country` with value `FR`, `lang` with value `en`, and `server` with value `europe`.
- **Redemption_Run**: A single execution of the redemption flow for one Coupon_Code across all enabled Group_Members, issuing one `useCoupon` request per enabled Group_Member.
- **Member_Outcome**: The classified result of a Redemption_Run for one Group_Member. Allowed values are `SUCCESS`, `ALREADY_USED`, `INVALID_COUPON`, `SKIPPED`, `UPSTREAM_ERROR`, and `TRANSPORT_ERROR`.
- **Response_Parser**: The Redemption_Server component that converts an Upstream_API JSON response body into a typed Upstream_Result value.
- **Upstream_Result**: The typed value produced by the Response_Parser, holding the response code, the response message, and the derived Member_Outcome.
- **Redemption_History**: The persistent record of completed Redemption_Runs, including each Coupon_Code and each Member_Outcome.
- **Mock_Mode**: A configuration state in which the Redemption_Server answers redemption requests from the documented response fixtures instead of contacting the Upstream_API.
- **API_Reference_Document**: The Markdown file in the repository that documents Upstream_API request payloads and example response bodies.
- **Shared_Passphrase**: The single secret value, common to the whole group, that a person supplies to obtain a Session.
- **Session**: The authenticated state that the Redemption_Server grants after a correct Shared_Passphrase submission and that it requires for every request other than a Shared_Passphrase submission.
- **Access_Gate**: The Redemption_Server component that admits a request only when it carries a valid Session.

## Requirements

### Requirement 1: Manage the group roster

**User Story:** As a group organizer, I want to maintain the list of friends and their Hive IDs, so that a single coupon submission covers the whole group.

#### Acceptance Criteria

1. WHEN a Group_Member submits a Member_Label of 1 to 40 characters and a Hive_ID of 1 to 64 characters after leading and trailing whitespace characters are removed, and the submitted Hive_ID is absent from the Member_Registry, THE Redemption_Server SHALL store the whitespace-trimmed pair in the Member_Registry with the enabled state set to enabled and SHALL return the stored entry holding its Member_Label, its Hive_ID, and its enabled state.
2. IF a Group_Member submits a Hive_ID that, after leading and trailing whitespace characters are removed, is character-for-character identical to the Hive_ID of an existing Member_Registry entry, THEN THE Redemption_Server SHALL reject the submission, SHALL leave the Member_Registry unchanged, and SHALL return an error message that names the Member_Label of the conflicting entry.
3. IF a Group_Member submits a Member_Label or a Hive_ID that holds zero characters after leading and trailing whitespace characters are removed, or a Member_Label longer than 40 characters, or a Hive_ID longer than 64 characters, THEN THE Redemption_Server SHALL reject the submission, SHALL leave the Member_Registry unchanged, and SHALL return a validation error message that names the rejected field and its allowed character-count range.
4. WHEN a Group_Member requests the roster, THE Web_Client SHALL display every entry of the Member_Registry with its Member_Label, its Hive_ID, and its enabled state, ordered from the earliest stored entry to the most recently stored entry.
5. WHEN a Group_Member confirms removal of a roster entry, THE Redemption_Server SHALL delete that entry from the Member_Registry, SHALL omit that entry from every subsequent roster response, and SHALL retain every Redemption_History record that references the deleted Hive_ID with its Member_Outcome unchanged.
6. WHERE a roster entry holds the enabled state disabled, THE Redemption_Server SHALL exclude that entry from every subsequent Redemption_Run and SHALL exclude it from the count of enabled Group_Members reported for that Redemption_Run.
7. WHEN the Redemption_Server starts, THE Redemption_Server SHALL serve a Member_Registry that holds every entry stored before the preceding shutdown, each with the same Member_Label, the same Hive_ID, and the same enabled state as before that shutdown.
8. IF a write to the Member_Registry store fails, THEN THE Redemption_Server SHALL keep serving the Member_Registry from memory with the requested change applied and SHALL return a warning message that states that the change is not persisted across a restart, whereby that warning message accompanies only a response whose Member_Registry store write failed.
9. WHEN a Group_Member changes the enabled state of an existing roster entry, THE Redemption_Server SHALL store the submitted enabled state for that entry in the Member_Registry and SHALL return the updated entry holding its Member_Label, its Hive_ID, and its new enabled state.
10. IF a Group_Member requests the roster while the Member_Registry holds zero entries, THEN THE Web_Client SHALL display a message that states that the roster is empty and instructs the Group_Member to add a Group_Member.
11. IF a Group_Member submits a new entry while the Member_Registry already holds 100 entries, THEN THE Redemption_Server SHALL reject the submission, SHALL leave the Member_Registry unchanged, and SHALL return an error message that states the maximum of 100 entries.
12. WHEN a write to the Member_Registry store completes without failure, THE Redemption_Server SHALL return the affected Member_Registry entry together with zero persistence warning messages.

### Requirement 2: Submit a coupon code once for the whole group

**User Story:** As a Group_Member who received a new coupon, I want to enter the code one time, so that every friend receives the reward without further action.

#### Acceptance Criteria

1. THE Web_Client SHALL provide, on the redemption page, one Coupon_Code input field that accepts at most 64 characters and one submission control.
2. WHEN a Group_Member activates the submission control, THE Web_Client SHALL remove leading and trailing whitespace characters from the entered value and SHALL preserve the letter case of the remaining characters.
3. IF the submitted Coupon_Code holds fewer than 1 character or more than 64 characters after whitespace removal, THEN THE Web_Client SHALL display a validation message that states the permitted length of 1 to 64 characters, SHALL retain the entered value in the input field, and SHALL withhold the request to the Redemption_Server.
4. IF the Member_Registry contains no enabled entry, THEN THE Web_Client SHALL display a message that instructs the Group_Member to add a Group_Member first, SHALL retain the entered value in the input field, and SHALL withhold the request to the Redemption_Server.
5. WHILE the Member_Registry contains at least one enabled entry, WHEN a Group_Member submits a Coupon_Code that holds 1 to 64 characters after whitespace removal, THE Web_Client SHALL display a confirmation dialog that lists the Member_Label of every enabled Group_Member in Member_Registry order and SHALL send the redemption request to the Redemption_Server only after the Group_Member confirms that dialog.
6. WHEN a Group_Member dismisses the confirmation dialog, THE Web_Client SHALL retain the entered Coupon_Code in the input field and SHALL withhold the request to the Redemption_Server.
7. WHILE a Redemption_Run is in progress, THE Web_Client SHALL disable the submission control and SHALL display a progress indicator that states the number of already processed Group_Members and the total number of enabled Group_Members of that Redemption_Run.
8. WHEN a Redemption_Run completes, THE Web_Client SHALL re-enable the submission control and SHALL retain the submitted Coupon_Code in the input field.
9. IF a Group_Member activates the submission control while a Redemption_Run is in progress, THEN THE Web_Client SHALL withhold the request to the Redemption_Server and SHALL continue to display the progress indicator of that Redemption_Run.
10. IF the Redemption_Server receives a redemption request whose Coupon_Code holds fewer than 1 character or more than 64 characters after whitespace removal, THEN THE Redemption_Server SHALL reject the request with a validation error message that states the permitted length of 1 to 64 characters, SHALL withhold every request to the Upstream_API, and SHALL append no Redemption_History record.

### Requirement 3: Redeem through the server-side proxy

**User Story:** As a developer, I want every upstream request to originate from the server, so that the browser is not blocked by cross-origin restrictions and the Hive IDs stay out of third-party requests made by the browser.

#### Acceptance Criteria

1. THE Redemption_Server SHALL expose a single redemption endpoint that accepts a Coupon_Code of 1 to 64 characters as its only caller-supplied value and returns, for every processed Group_Member, that Group_Member's Member_Label together with exactly one Member_Outcome and the response message held in the corresponding Upstream_Result.
2. THE Web_Client SHALL send redemption requests only to the Redemption_Server endpoint, SHALL include the Coupon_Code as the only value in the request payload, and SHALL exclude every Hive_ID from that payload.
3. WHEN the Redemption_Server issues a request to the Upstream_API, THE Redemption_Server SHALL include the Fixed_Request_Fields, the `hiveid` field set to the Hive_ID of the processed Group_Member, and the `coupon` field set to the submitted Coupon_Code.
4. WHEN the Redemption_Server processes a Group_Member of a Redemption_Run, THE Redemption_Server SHALL issue exactly one Upstream_API request for that Group_Member, addressed to the `useCoupon` endpoint, and SHALL derive the Member_Outcome of that Group_Member from the response to that single request.
5. THE Redemption_Server SHALL process the enabled Group_Members of a Redemption_Run one after another in the order in which the Member_Registry holds them, SHALL keep at most one Upstream_API request in flight at any moment, and SHALL issue the next Upstream_API request only after the Member_Outcome of the preceding request is recorded.
6. IF the `useCoupon` request issued for a Group_Member returns no response within 10 seconds, THEN THE Redemption_Server SHALL abandon that request, SHALL report the Member_Outcome `TRANSPORT_ERROR` for that Group_Member, and SHALL withhold any repeat of that request, whereby the 10-second limit applies to the single `useCoupon` request issued for each processed Group_Member.
7. IF the Coupon_Code received by the redemption endpoint holds zero characters before removal of leading and trailing whitespace characters, holds zero characters after removal of leading and trailing whitespace characters, or exceeds 64 characters, THEN THE Redemption_Server SHALL reject the request as a length violation with an error message that states the violated length limit of 1 to 64 characters, SHALL withhold every Upstream_API request, and SHALL leave the Redemption_History unchanged.
8. IF the redemption endpoint receives a request while the Member_Registry holds no enabled entry, THEN THE Redemption_Server SHALL reject the request with an error message that states that no enabled Group_Member exists and SHALL withhold every Upstream_API request.
9. IF the redemption endpoint receives a request while a Redemption_Run is in progress, THEN THE Redemption_Server SHALL reject the new request with an error message that states that a Redemption_Run is in progress, SHALL withhold every Upstream_API request for the rejected request, and SHALL continue the Redemption_Run in progress without change.

### Requirement 4: Parse and classify upstream responses

**User Story:** As a Group_Member, I want each upstream answer translated into a clear status, so that I can tell success from an already-used code and from a wrong code.

#### Acceptance Criteria

1. THE Response_Parser SHALL accept an Upstream_API response body of at most 64 kilobytes in which the `retCode` field is a number or a string, and SHALL produce exactly one Upstream_Result that holds the normalized response code as a string of at most 100 characters, the response message as a string of at most 500 characters, and exactly one derived Member_Outcome.
2. WHEN the normalized response code equals the string `100`, THE Response_Parser SHALL derive the Member_Outcome `SUCCESS` and SHALL retain the normalized response code and the response message in the Upstream_Result.
3. WHEN the normalized response code equals the string `(H304)`, THE Response_Parser SHALL derive the Member_Outcome `ALREADY_USED` and SHALL retain the normalized response code and the response message in the Upstream_Result.
4. WHEN the normalized response code equals the string `(H306)`, THE Response_Parser SHALL derive the Member_Outcome `INVALID_COUPON` and SHALL retain the normalized response code and the response message in the Upstream_Result.
5. IF the normalized response code holds at least one character and equals none of the strings `100`, `(H304)`, and `(H306)` under exact character-by-character comparison that distinguishes upper case from lower case, THEN THE Response_Parser SHALL derive the Member_Outcome `UPSTREAM_ERROR` and SHALL retain the normalized response code and the response message in the Upstream_Result.
6. IF a response body is absent, holds more than 64 kilobytes, is not valid JSON, omits the `retCode` field, or holds a `retCode` field whose value is neither a number nor a string, THEN THE Response_Parser SHALL derive the Member_Outcome `TRANSPORT_ERROR`, SHALL set the response code of the Upstream_Result to the empty string, and SHALL retain a message of at most 500 characters that names which one of these five conditions occurred.
7. THE Redemption_Server SHALL provide a serializer that renders an Upstream_Result as an Upstream_API response body whose `retCode` field holds the response code of that Upstream_Result as a string and whose `retMsg` field holds the response message of that Upstream_Result, without adding or removing characters.
8. FOR ALL Upstream_API response bodies documented in the API_Reference_Document, parsing then serializing then parsing SHALL produce an Upstream_Result whose response code, response message, and Member_Outcome each equal the response code, the response message, and the Member_Outcome of the Upstream_Result of the first parse (round-trip property).
9. THE Response_Parser SHALL derive the normalized response code from the `retCode` field by rendering a number value as its decimal digit string without grouping separators and without trailing fractional zeros, by removing leading and trailing whitespace characters from a string value, by preserving the letter case of the remaining characters, and by keeping only the first 100 characters of the result.
10. IF a response body holds a `retCode` field and its `retMsg` field is absent, is null, or is not a string, THEN THE Response_Parser SHALL set the response message of the Upstream_Result to the empty string and SHALL derive the Member_Outcome from the normalized response code alone.

### Requirement 5: Stop a run early when the coupon code is rejected

**User Story:** As a Group_Member, I want a wrong coupon code to stop the run immediately, so that the remaining Hive IDs are not sent to the Upstream_API for nothing.

#### Acceptance Criteria

1. WHEN the Response_Parser derives the Member_Outcome `INVALID_COUPON` for a Group_Member during a Redemption_Run, THE Redemption_Server SHALL issue no further Upstream_API request for the remainder of that Redemption_Run, including the `useCoupon` request for every Group_Member of the fixed list not yet processed.
2. WHEN the Redemption_Server stops a Redemption_Run early, THE Redemption_Server SHALL report the Member_Outcome `SKIPPED` for every enabled Group_Member of that Redemption_Run for which no Upstream_API request was issued.
3. WHEN the Redemption_Server stops a Redemption_Run early, THE Redemption_Server SHALL report the Member_Outcome `INVALID_COUPON` for the Group_Member whose response triggered the early stop and SHALL report for every Group_Member processed before that Group_Member the Member_Outcome derived during that Redemption_Run, unchanged.
4. WHEN a Redemption_Run yields the Member_Outcome `ALREADY_USED`, `UPSTREAM_ERROR`, or `TRANSPORT_ERROR` for a Group_Member, THE Redemption_Server SHALL continue the Redemption_Run with the next enabled Group_Member of the processing order and SHALL issue no repeated Upstream_API request for the Group_Member that yielded that Member_Outcome.
5. WHEN a Redemption_Run starts, THE Redemption_Server SHALL fix the list of enabled Group_Members of that Redemption_Run in the order in which the Member_Registry returns them for the roster view, and SHALL process that list in that order for the whole Redemption_Run, so that the Group_Members reported as `SKIPPED` are exactly the Group_Members positioned after the Group_Member that triggered the early stop.
6. THE Redemption_Server SHALL report exactly one Member_Outcome per enabled Group_Member of the fixed list of a Redemption_Run, with a total outcome count equal to the number of entries in that fixed list, and SHALL report no Member_Outcome for any Group_Member absent from that list, whereby this count holds for every Redemption_Run, including a Redemption_Run that terminates before any Upstream_API request is issued.
7. WHEN a Redemption_Run stops early, THE Redemption_Server SHALL treat that Redemption_Run as completed and SHALL return the complete result set, holding the reported and the `SKIPPED` Member_Outcomes, to the Web_Client as a successful response within 1 second after deriving the Member_Outcome `INVALID_COUPON`.
8. IF a Redemption_Run ends because of a failure of the Redemption_Server before the first Upstream_API request of that Redemption_Run is issued, THEN THE Redemption_Server SHALL still report one Member_Outcome for every enabled Group_Member of the fixed list, using the Member_Outcome `SKIPPED` for every Group_Member for which no Upstream_API request was issued, so that every enabled Group_Member of that fixed list holds exactly one Member_Outcome.

### Requirement 6: Report the result of a run

**User Story:** As a Group_Member, I want a per-friend result summary, so that I know who received the reward and who needs attention.

#### Acceptance Criteria

1. WHEN a Redemption_Run completes, THE Web_Client SHALL display one result row for every enabled Group_Member of that Redemption_Run, including every Group_Member whose Member_Outcome is `SKIPPED`, each row holding the Member_Label and the Member_Outcome, and SHALL order the rows by the processing order of that Redemption_Run.
2. WHEN a result row holds the Member_Outcome `UPSTREAM_ERROR` or `TRANSPORT_ERROR`, THE Web_Client SHALL display the response message of the Upstream_Result in that row as literal text, SHALL render every markup character of that message as a visible character without interpreting it as markup, and SHALL limit the displayed message to its first 500 characters.
3. WHEN a Redemption_Run completes, THE Web_Client SHALL display a summary that states the count of Member_Outcomes for each of the six Member_Outcome values, including every outcome value whose count equals zero, where the sum of the six counts equals the number of enabled Group_Members of that Redemption_Run.
4. IF the Redemption_Server returns an error response for a redemption request, THEN THE Web_Client SHALL display an error notification that holds the returned error message, SHALL retain the entered Coupon_Code, and SHALL re-enable the submission control within 1 second of receiving that response.
5. WHEN a Redemption_Run completes, THE Redemption_Server SHALL append exactly one Redemption_History record holding the submitted Coupon_Code, the completion timestamp, and one Member_Outcome per enabled Group_Member of that Redemption_Run, and SHALL retain at least the 100 most recent Redemption_History records across application restarts.
6. WHEN a Group_Member opens the history view, THE Web_Client SHALL display the retained Redemption_History records ordered from the most recent completion timestamp to the oldest completion timestamp, and SHALL order records that hold the same completion timestamp from the most recently appended record to the least recently appended record.
7. WHEN a Group_Member submits a Coupon_Code that matches character for character the Coupon_Code of at least one Redemption_History record, THE Web_Client SHALL display inside the confirmation dialog a notice that states the completion timestamp of the most recent matching Redemption_History record.
8. IF appending a Redemption_History record fails, THEN THE Redemption_Server SHALL return the Member_Outcomes of the completed Redemption_Run together with a warning message that states that the Redemption_History record is not persisted.
9. IF the Redemption_History holds no record when a Group_Member opens the history view, THEN THE Web_Client SHALL display a message that states that no Redemption_Run has been recorded.

### Requirement 7: Document and mock the upstream contract

**User Story:** As a developer, I want the upstream request and response shapes documented in the repository, so that tests and local development run without contacting the Upstream_API.

#### Acceptance Criteria

1. THE Redemption_App SHALL contain an API_Reference_Document that documents the `checkUser` endpoint URL, the `useCoupon` endpoint URL, the request field names `country`, `lang`, `server`, `hiveid`, and `coupon`, and, for each of those five field names, whether its value is one of the Fixed_Request_Fields or is supplied per Redemption_Run.
2. THE API_Reference_Document SHALL contain the response body examples `{"retCode":100,"retMsg":"The coupon gift has been sent."}`, `{"retCode":"(H304)","retMsg":"This coupon code has already been used."}`, and `{"retCode":"(H306)","retMsg":"Invalid coupon code.<br/>Please check again."}`, and SHALL state for each of those three examples the Member_Outcome that the Response_Parser derives from it.
3. WHERE Mock_Mode is enabled, THE Redemption_Server SHALL derive every Member_Outcome from response fixtures whose bodies are character-identical to the response body examples of the API_Reference_Document, SHALL select the same fixture for a repeated pair of Coupon_Code and Hive_ID so that two Redemption_Runs with identical input produce identical Member_Outcomes, and SHALL withhold every request to the Upstream_API.
4. WHILE Mock_Mode is enabled, THE Web_Client SHALL display an indicator on the redemption page and in the result view that states that redemption results come from mock data.
5. THE Redemption_Server SHALL read the Mock_Mode state at startup from an environment variable that accepts the value `true` to enable Mock_Mode and the value `false` to disable Mock_Mode, compared without letter case sensitivity, and SHALL treat Mock_Mode as disabled when that environment variable is absent or contains only whitespace characters.
6. IF Mock_Mode is enabled and a required response fixture is absent or is not valid JSON, THEN THE Redemption_Server SHALL reject the redemption request with an error message that names the fixture and states whether that fixture is absent or is not valid JSON, SHALL withhold every request to the Upstream_API, and SHALL append no Redemption_History record.
7. IF the Mock_Mode environment variable holds a value that matches neither `true` nor `false`, THEN THE Redemption_Server SHALL treat Mock_Mode as disabled, SHALL log a warning that names the environment variable and the rejected value, and SHALL complete startup.
8. WHILE Mock_Mode is disabled, THE Web_Client SHALL display no indicator that states that redemption results come from mock data.
9. WHERE Mock_Mode is enabled, WHEN a Redemption_Run completes, THE Redemption_Server SHALL append the Redemption_History record of that Redemption_Run marked as derived from mock data.
10. IF Mock_Mode is enabled and the Redemption_Server cannot satisfy every condition of acceptance criterion 3 for a redemption request, THEN THE Redemption_Server SHALL reject that redemption request with an error message that names the unsatisfied condition, SHALL derive no Member_Outcome for that request, SHALL withhold every request to the Upstream_API, and SHALL append no Redemption_History record.
11. WHILE Mock_Mode is disabled, THE Redemption_Server SHALL derive every Member_Outcome from an Upstream_API response and SHALL read no response fixture.

### Requirement 8: Gate access behind a shared passphrase

**User Story:** As a group organizer, I want the application to ask for a shared passphrase, so that a stranger who reaches the port can neither read our Hive IDs nor spend our coupons.

#### Acceptance Criteria

1. THE Redemption_Server SHALL read the Shared_Passphrase at startup from an environment variable.
2. WHERE the Shared_Passphrase environment variable holds at least one character after removal of leading and trailing whitespace characters, THE Access_Gate SHALL admit a request only when that request carries a valid Session.
3. IF a request that carries no valid Session reaches the Access_Gate, THEN THE Access_Gate SHALL reject that request, SHALL withhold every Member_Registry value and every Redemption_History value from the response, SHALL start no Redemption_Run, and SHALL return a response that directs the sender to submit the Shared_Passphrase.
4. WHEN a person submits a value that is character-for-character identical to the Shared_Passphrase, THE Redemption_Server SHALL grant a Session and SHALL admit every subsequent request that carries that Session.
5. IF a person submits a value that is not character-for-character identical to the Shared_Passphrase, THEN THE Redemption_Server SHALL grant no Session and SHALL return an error message that states that the passphrase is incorrect, without stating which characters differ and without stating the length of the Shared_Passphrase.
6. THE Redemption_Server SHALL compare a submitted value against the Shared_Passphrase in a duration that does not depend on the number of leading characters the two values share.
7. WHEN a person ends a Session, THE Redemption_Server SHALL invalidate that Session and SHALL reject every subsequent request that carries it.
8. IF at least 10 submissions of an incorrect value arrive from the same sender within 5 minutes, THEN THE Redemption_Server SHALL reject every further submission from that sender for at least 5 minutes and SHALL grant no Session during that period, even for a value identical to the Shared_Passphrase.
9. IF the Shared_Passphrase environment variable is absent or holds zero characters after removal of leading and trailing whitespace characters, THEN THE Redemption_Server SHALL complete startup, SHALL log a warning that states that the Redemption_App is reachable without a Shared_Passphrase, and SHALL admit every request without requiring a Session.
10. THE Redemption_Server SHALL exclude the Shared_Passphrase from every response body, from every log entry, and from every value delivered to the Web_Client.
