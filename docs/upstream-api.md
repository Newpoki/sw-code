# Upstream API Reference

This is the API_Reference_Document of the Redemption_App (Requirements 7.1, 7.2). It documents the
contract of the Upstream_API, the official Hive event coupon service. The response body examples
below are mirrored character for character by the fixtures under `fixtures/upstream/`, which
Mock_Mode reads instead of contacting the Upstream_API.

## Endpoints

Base URL: `https://event.withhive.com/ci/smon/evt_coupon`

| Endpoint | URL | Called by this application |
| --- | --- | --- |
| `checkUser` | `https://event.withhive.com/ci/smon/evt_coupon/checkUser` | No |
| `useCoupon` | `https://event.withhive.com/ci/smon/evt_coupon/useCoupon` | Yes |

The official event page calls `checkUser` before `useCoupon`. **This application calls only
`useCoupon`**, exactly once per Group_Member of a Redemption_Run. `checkUser` is documented here
because this document describes the upstream contract, not this application's call graph.

The base URL is overridable through the `UPSTREAM_BASE_URL` environment variable; the endpoint path
segments (`checkUser`, `useCoupon`) are appended to it.

## Request fields

Both endpoints take the same five fields, sent as a `POST` body. `country`, `lang`, and `server` are
the Fixed_Request_Fields: the application sets them to constants and a Group_Member never enters
them. `hiveid` and `coupon` are supplied per Redemption_Run.

| Field | Fixed or supplied per Redemption_Run | Value |
| --- | --- | --- |
| `country` | Fixed_Request_Field | `FR` |
| `lang` | Fixed_Request_Field | `en` |
| `server` | Fixed_Request_Field | `europe` |
| `hiveid` | Supplied per Redemption_Run | The Hive_ID of the Group_Member currently being processed |
| `coupon` | Supplied per Redemption_Run | The submitted Coupon_Code, whitespace-trimmed, letter case preserved |

Every group member plays on the `europe` server with `en` as language and `FR` as country, which is
why those three values are constants of the application rather than inputs.

### Required request headers

Two headers are **mandatory**, enforced by the edge CDN in front of the Upstream_API rather than by
the coupon service itself:

| Header | Value |
| --- | --- |
| `referer` | The event page, i.e. the base URL above |
| `x-requested-with` | `XMLHttpRequest` |

Each is necessary and together they are sufficient; `user-agent` and `origin` make no difference and
are not sent. Omitting either one produces **HTTP 403 with an HTML error page**, which the
Response_Parser correctly reports as `TRANSPORT_ERROR` / "response body is not valid JSON" — so a
blocked request looks exactly like a malformed one. Measured against the live endpoint:

| Headers sent | Result |
| --- | --- |
| `content-type` only | 403, HTML |
| `+ user-agent` | 403, HTML |
| `+ user-agent`, `origin` | 403, HTML |
| `+ origin`, `x-requested-with` | 403, HTML |
| `referer` + `x-requested-with` | 200, JSON |

Note that a successful response is served with `content-type: text/html` despite carrying a JSON
body. The Response_Parser ignores the response content type and parses the body, so this is
harmless — but a future rewrite must not start trusting that header.

`hiveid` changes for each Group_Member within one Redemption_Run; `coupon` holds the same value for
the whole Redemption_Run.

## Response bodies

The Upstream_API answers with a JSON object holding a `retCode` field and a `retMsg` field. `retCode`
is a number in the success case and a string in the observed error cases, which is why the
Response_Parser normalizes it to a string before classifying it (Requirement 4.9).

The three observed response bodies, character-exact, and the Member_Outcome the Response_Parser
derives from each:

### `SUCCESS`

Normalized response code `100`. Mirrored by `fixtures/upstream/success-100.json`.

```json
{"retCode":100,"retMsg":"The coupon gift has been sent."}
```

### `ALREADY_USED`

Normalized response code `(H304)`. Mirrored by `fixtures/upstream/already-used-h304.json`.

```json
{"retCode":"(H304)","retMsg":"This coupon code has already been used."}
```

### `INVALID_COUPON`

Normalized response code `(H306)`. Mirrored by `fixtures/upstream/invalid-coupon-h306.json`.
An `INVALID_COUPON` outcome stops the Redemption_Run and every remaining Group_Member is reported as
`SKIPPED` (Requirements 5.1, 5.2). Note that `retMsg` carries the literal markup `<br/>`; the
Web_Client renders such a message as visible text and never as markup (Requirement 6.2).

```json
{"retCode":"(H306)","retMsg":"Invalid coupon code.<br/>Please check again."}
```

### Summary

| Response code | Member_Outcome | Fixture |
| --- | --- | --- |
| `100` | `SUCCESS` | `fixtures/upstream/success-100.json` |
| `(H304)` | `ALREADY_USED` | `fixtures/upstream/already-used-h304.json` |
| `(H306)` | `INVALID_COUPON` | `fixtures/upstream/invalid-coupon-h306.json` |

Any other non-empty normalized response code yields `UPSTREAM_ERROR`, and such codes do occur: a
Hive_ID the service does not recognize is answered with `retCode` `503` and `retMsg`
`Invalid Hive ID.<br/>Please check again.`, which the Response_Parser classifies as `UPSTREAM_ERROR`
and the Web_Client displays verbatim. It is not mirrored by a fixture because Mock_Mode only needs
the three outcomes above. A response that is absent,
larger than 64 KiB, not valid JSON, without a `retCode` field, or with a `retCode` that is neither a
number nor a string yields `TRANSPORT_ERROR` (Requirements 4.5, 4.6).

The comparison against `100`, `(H304)`, and `(H306)` is exact and case-sensitive, so `(h304)` is an
`UPSTREAM_ERROR`, not an `ALREADY_USED`.

## Keeping this document and the fixtures in sync

The three fenced JSON blocks above are the single source of truth for the mock data. Automated tests
assert that each fixture file is byte-identical to its fenced example here, and that the
Member_Outcome stated for each example equals what the Response_Parser derives from it. Editing a
fenced block without editing its fixture, or the reverse, fails those tests.
