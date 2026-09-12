# shared-coupon-redemption

A small self-hosted web application that redeems one Summoners War coupon code for
every member of a group. One person enters the code once; the server calls the
official `useCoupon` endpoint once per enabled member, sequentially, and reports a
per-member outcome.

Built with TanStack Start (React, Tailwind CSS, shadcn/ui) and TypeScript. Every
upstream request originates from the server: the browser only ever talks to
same-origin server functions, and no Hive ID is ever part of a redemption payload.

## Getting started

```bash
pnpm install
cp .env.example .env      # then edit it
pnpm dev                  # http://localhost:3000
```

Set `MOCK_MODE=true` in `.env` to answer redemptions from `fixtures/upstream/`
instead of contacting the real service — nothing leaves the machine, and the app
shows a mock-mode banner while it is on.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Dev server on port 3000 |
| `pnpm build` | Production build |
| `pnpm preview` | Serve the build locally |
| `pnpm test` | Vitest in watch mode |
| `pnpm test:run` | Single test run |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint |
| `pnpm format` / `pnpm check` | Prettier write / check |

## Deploying

**Read [`docs/deployment.md`](docs/deployment.md) before exposing the process to
anything but `localhost`.** Four things about a deployment change whether the app
behaves correctly:

- the session cookie is always `Secure`, so a plain-HTTP deployment cannot hold a
  session;
- the per-IP throttle on failed passphrase attempts trusts `X-Forwarded-For` /
  `X-Real-IP`, so it needs a reverse proxy that sets them and strips client
  copies;
- a full redemption run can hold one streaming response open for ~17 minutes, so
  every proxy timeout has to allow that (this rules out short-capped serverless
  platforms);
- **with `APP_PASSPHRASE` unset there is no access gate at all** — anyone who can
  reach the port can read every Hive ID and spend any coupon.

## Documentation

- [`docs/deployment.md`](docs/deployment.md) — operational constraints and a
  configuration checklist
- [`docs/upstream-api.md`](docs/upstream-api.md) — the upstream request fields and
  the documented response bodies the fixtures mirror
- `.env.example` — every environment variable, all server-side only
- `.kiro/specs/shared-coupon-redemption/` — requirements, design, and task list
