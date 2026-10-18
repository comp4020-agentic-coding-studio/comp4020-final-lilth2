# Multi-user identity and permissions

This records the decisions behind "how does Tend tell two gardeners apart,
and what is each of them actually allowed to do" — the brief's one required
write-up for this crit. It's a companion to `PROCESS.md`'s own account of
*why* these choices were made; this file is the reference for *what* the
rules actually are, route by route, so a reviewer can check the code against
a concrete claim instead of prose alone.

## What counts as "a person" here

One browser profile is one anonymous gardener. There is no sign-up, no
account, no password — the only thing that distinguishes two visitors is a
`visitor_id` cookie the server sets the first time a browser shows up with
none. This is the same identity model the app has used since crit 8; nothing
about *how* a visitor is recognised changes this week, only what's built on
top of it.

- **The session credential** (`visitor_id`) is an unguessable, server-generated
  UUID, set `HttpOnly` (never readable by the page's own JavaScript),
  `SameSite=Lax`, with a one-year `Max-Age`, and — as of this week — `Secure`
  whenever the request actually arrived over HTTPS (detected via
  `X-Forwarded-Proto`, since Fly terminates TLS in front of the app and the
  app itself only ever sees plain HTTP; see `withVisitorCookie` in
  `server.ts`). It is never shown anywhere in the UI and never accepted from
  a request body — every write handler derives "who is this" by calling
  `visitorIdOf(req)` against the cookie, full stop.
- **The public identity** is a second, separate thing: a codename like
  `Maple-7K2`, generated once per visitor (`identityOf` in `server.ts`,
  built on `pickCodename` in `garden.ts`) and shown as "You are Gardener
  Maple-7K2" in the resource bar. It's safe to display and safe to log
  precisely because it carries none of the session cookie's power — knowing
  someone's codename doesn't let you act as them.
- **Why not an IP address**: an IP identifies a network connection, not a
  person or even a browser — two gardeners behind the same NAT (a shared
  office, a university wifi) would be merged into one, and the same gardener
  moving between networks would fracture into several. A cookie survives
  exactly the cases that matter here (refresh, reopening the tab, leaving and
  coming back) and fails exactly the cases an anonymous site should be honest
  about failing: clear your cookies, or switch devices, and you're a new
  gardener. The UI says this directly, right under the identity badge.
- **What this doesn't claim**: an anonymous browser identity is not a
  defence against one real person running two browsers, two profiles, or an
  incognito window to appear as two gardeners. Nothing here pretends
  otherwise — the promise is only "the app can tell two *sessions* apart,"
  not "the app can tell two *people* apart."

## Shared vs. personal state

| State | Who can see it | Who can change it |
|---|---|---|
| Five plants' growth, moisture, insect counts, stage | Everyone | Anyone, via their own watering allowance |
| Active shared bugs/treasures | Everyone | Anyone, by claiming one (first valid claim wins) |
| Shared achievements | Everyone | Nobody directly — unlocked automatically when the shared garden meets a condition |
| Recent garden care feed (last ~15 public actions) | Everyone | Nobody directly — written automatically by the server on a successful water/catch/claim |
| A visitor's watering allowance, cooldown, and daily counts | Only that visitor | Only that visitor, and only by watering within their own limits |
| A visitor's personal collection (discovered items, counts, unseen flags) | Only that visitor | Only that visitor, and only by catching/claiming |
| A visitor's public codename | Everyone (it's public by design) | Nobody — assigned once, never changed |
| The full audit log | Nobody, over HTTP (see below) | Nobody, except the server itself |

## Route-by-route enforcement

Every row below was checked against the running code, not assumed from the
table above.

| Route | Identity source | Enforcement |
|---|---|---|
| `GET /` | none needed | static page |
| `GET /readme/` | none needed | static page |
| `GET /api/state` | `visitor_id` cookie, via `visitorIdOf` | returns this visitor's own `identity`, `visitor`, `limits`, `collectionLimits`; shared fields (`garden`, `collectibles`, `recentCare`, `achievements`, `version`) are the same for everyone by design |
| `POST /api/water` | `visitor_id` cookie | `plantId` is the only client-chosen input, whitelisted against the five real species (`isSpeciesId`); growth amount, cooldown, and the daily cap are computed server-side from `decideWatering`, never accepted from the client |
| `POST /api/collect` | `visitor_id` cookie | `id`/`plantId`/`kind` only ever *select* an existing shared item to attempt to claim; the claim itself is an atomic `UPDATE ... WHERE caught_at IS NULL`, so it can't be forced to succeed by the client, and reward/quota accounting is entirely server-computed |
| `GET /api/collection` | `visitor_id` cookie | always this visitor's own collection; there is no parameter that can select a different visitor's |
| `POST /api/collection/seen` | `visitor_id` cookie | clears only this visitor's own unseen flags |
| `GET /api/_test/audit-log` | none (gated separately) | 404s unless `ENABLE_TEST_ENDPOINTS=1`, which is never set on the real Fly deploy — exists purely so the automated suite can assert against real log rows; this is the one place the full audit log is reachable over HTTP at all, and it's disabled in production |
| `/ws` (WebSocket upgrade) | best-effort `visitor_id` cookie, read-only | used only to tag the connection's `ws.open`/`ws.close` log lines with an actor codename when one already exists; never mints a new identity, and the broadcast payload itself (`gardenSnapshot()`) contains only shared data, never anyone's personal state |

**No endpoint accepts a client-supplied identity field of any kind.** This
was true before this week's work and is now backed by a regression test
(`spec/spoofing.test.ts`) that checks both behaviourally (forging another
visitor's identity in a request body has zero effect on whose quota is
charged or whose collection changes) and structurally (`server.ts` never
reads `body.visitorId` or `body.actorPublicId` — the only body fields it
reads at all are `plantId`, `id`, and `kind`, all of which name a *target*,
never an *actor*).

## CSRF

`SameSite=Lax` on the session cookie is the first and strongest layer: no
modern evergreen browser attaches a `Lax` cookie to a cross-site `fetch()`
POST, which is the entire vector a JSON API like this one is exposed to.

The second, narrower layer added this week (`isTrustedOrigin` in
`server.ts`) rejects a state-changing POST (`/api/water`, `/api/collect`,
`/api/collection/seen`) only when its `Origin` (or, failing that, `Referer`)
header is **present and names a different host** than the request's own.

A request with **no** `Origin` header at all is allowed through. This is
deliberate, not an oversight: a real browser's same-origin `fetch()` always
sends `Origin`, so an absent header is never what a forged cross-site
request from a browser looks like — rejecting on "absent" would only ever
catch non-browser clients (including every integration test in this repo's
own `spec/` directory, since Node's global `fetch()` doesn't set `Origin`
for a same-process call), for no real security benefit. The mismatched case
is the only unambiguous forgery signal actually available here, and it's the
only one this check rejects. `spec/csrf.test.ts` asserts both halves of that
decision directly, including the non-regression case.

A rejected request is logged as its own named audit event
(`security.origin-rejected`) rather than folded into whichever route it hit,
so "someone tried to forge a request" is visible as a distinct line in the
log, not just absorbed into a generic rejection count.

## What this doesn't solve

- **One person, many browsers**: already covered above — this is a known,
  disclosed limitation of anonymous-browser identity, not something this
  week's work claims to fix.
- **A compromised cookie**: if a `visitor_id` cookie is stolen (XSS, a
  shared machine, a leaked log — which is exactly why it's never logged),
  whoever has it can act as that visitor. `HttpOnly` closes the most common
  theft vector (script-readable cookies); it doesn't make theft impossible
  by some other means, and this app makes no stronger claim than that.
- **Rate limiting beyond the existing daily caps and cooldowns**: the
  watering and collection limits (`WATERING_LIMITS`, `COLLECTION_LIMITS`)
  exist to keep the shared garden's pace sane, not as a defence against
  abuse at the HTTP layer — there's no IP-based or connection-based
  throttling here, consistent with the deliberate choice above not to use
  IP for anything identity-related.
