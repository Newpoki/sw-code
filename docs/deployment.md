# Deployment

Four constraints of this application are decided by *where and how it is run*, not
by its code. Each one is a real way a working build can misbehave, so each is
stated here with the setting that satisfies it. Read all four before exposing the
process to anything but `localhost`.

The application is one process: a single TanStack Start server that serves the
browser bundle and issues every upstream request. It holds its state in one JSON
document (`DATA_FILE`, default `./data/store.json`), so it is a single-node
deployment by design — do not run two replicas against one data file.

## 1. The session cookie is always `Secure`, so plain HTTP cannot hold a session

`src/server/auth.server.ts` issues the session cookie `HttpOnly`,
`SameSite=Strict`, `Secure`, `Path=/`. `Secure` means the browser withholds the
cookie over plain HTTP. A deployment served over `http://localhost:3000` or
`http://192.168.x.x` therefore accepts the passphrase, sets the cookie, and then
never receives it back — every subsequent request looks unauthenticated and lands
on `/login` again.

**Serve the application over HTTPS.** A reverse proxy terminating TLS in front of
the process is enough; the process itself may listen on plain HTTP behind it,
because the browser only ever sees the HTTPS origin.

`http://localhost` is a
[secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts)
in current browsers, so a purely local `http://localhost` session usually works;
`http://<lan-ip>` does not.

**The override, if HTTPS is genuinely unavailable:** the flag is a constructor
option, not an environment variable. Wiring that calls

```ts
createAuth({ cookie: { secure: false } })
```

issues the cookie without `Secure`, and it then travels in the clear — anyone on
the path can copy it and hold a Session. `getAuth()`, the accessor the running app
uses, passes no options, so the default is `Secure` and nothing reads an
environment variable to weaken it. That is deliberate: an env var would make
"send my session cookie unencrypted" a one-line production accident. Changing it
is a code change, reviewed as one.

## 2. The failed-attempt throttle trusts proxy headers

Requirement 8.8 throttles a sender after 10 incorrect passphrase submissions in 5
minutes. The sender identity comes from the request headers, in this order:

1. the first entry of `X-Forwarded-For`,
2. `X-Real-IP`,
3. otherwise the empty string, which is normalized to a single shared bucket.

Nothing else is available to the handler. So the throttle is only per-client when
a reverse proxy in front of the process:

- **sets** `X-Forwarded-For` (or `X-Real-IP`) from the real peer address, and
- **strips or overwrites** any copy of those headers supplied by the client.

Without that, a client can vary the header and spread its attempts across
buckets, and the throttle degrades to a brake on casual guessing. It was never
the primary defence: the passphrase gate is, and keeping the port off the public
internet is what backs it up.

If no proxy is present, every sender falls into one shared bucket. That is fail-
safe rather than fail-open — attempts still add up — but it means one wrong
guesser can throttle everybody for five minutes.

## 3. The response timeout must exceed ~17 minutes

A Redemption_Run is strictly sequential (Requirement 3.5) with a 10-second
per-request timeout (Requirement 3.6), and the roster holds at most 100 entries
(Requirement 1.11). The progress events and the final result set are streamed on
**one open response** for the whole run, so the worst case is roughly

```
100 members × 10 s = ~1000 s ≈ 17 minutes
```

on a single response that must stay open the entire time.

**Configure every hop to allow a response longer than that.** For nginx that is
`proxy_read_timeout` (and `proxy_send_timeout`); other proxies have equivalents.
Also disable response buffering for the application, or the progress indicator
arrives in one lump at the end (`proxy_buffering off;` in nginx).

**This rules out serverless platforms with a short hard response cap.** A platform
that caps a response at 10, 30, or 60 seconds will cut the stream mid-run. Because
the run is driven by the consumer pulling events, cutting the response ends the
run: the coordinator releases its lock, records `SKIPPED` for every member it had
not reached, and — since the run did not complete — appends no history record. Any
coupon already sent upstream stays spent. A too-short timeout is therefore a
correctness problem, not a cosmetic one.

A realistic deployment is far below the worst case — a typical run of a handful of
members with fast upstream answers finishes in seconds. The cap has to cover the
worst case anyway, because the worst case is a slow upstream, not an unusual
roster.

## 4. An absent `APP_PASSPHRASE` means there is no access gate at all

**If `APP_PASSPHRASE` is absent, empty, or whitespace-only, the application admits
every request without a Session.** No login is required, and anyone who can reach
the port can:

- read every Group_Member's Hive_ID from the roster,
- read the whole Redemption_History, and
- spend any coupon code on behalf of every enabled member — single-use per
  account, so that is irreversible.

Startup logs a prominent warning in that case and continues (Requirement 8.9);
the login page states the gate is off. Startup does **not** fail, because
refusing to boot would push operators toward a weak throwaway value.

**Set `APP_PASSPHRASE` to a long random value for any deployment reachable by
more than one machine.** Set `SESSION_SECRET` as well, or sessions are signed
with a per-process key and everybody is logged out by every restart.

The gate is a safety net, not the perimeter. Bind the process to `127.0.0.1` or a
private network and reach it through a VPN or an authenticating reverse proxy; do
not put it on the public internet.

## Checklist

| Setting | Why |
| --- | --- |
| Serve over HTTPS | The session cookie is `Secure` (§1) |
| Proxy sets `X-Forwarded-For` and strips the client's copy | Per-IP throttle is meaningful (§2) |
| Response timeout > 17 min, response buffering off | A full run streams on one response (§3) |
| `APP_PASSPHRASE` set to a long random value | Otherwise there is no gate (§4) |
| `SESSION_SECRET` set | Sessions survive a restart |
| `MOCK_MODE=false` | Real redemptions; `true` answers from `fixtures/upstream/` |
| `DATA_FILE` on persistent storage, backed up | Roster and history live in that one file |
| One replica only | Single writer to `DATA_FILE` |

`.env.example` documents every variable. Every one of them is read on the server
only and never reaches the browser.
