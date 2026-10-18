# Process overview

A decision record in the sense an [architecture decision record](https://adr.github.io/)
is: the handful of choices expensive to reverse later, and why each went the
way it did. Rewritten, not appended to, at every crit. What follows: crit 8
and 9's decisions condensed, then this week's identity, permissions, and
logging decisions in full.

## Earlier decisions, condensed

**The app is Tend**, a garden of five plant species shared by anyone who
visits — originally one plant, grown into five this cycle, still one piece
of state nobody owns. **The stack is plain `node:http` + `ws` +
`node:sqlite`**, keeping the whole server one readable file with no
native-addon build step in a 256MB container. **Identity is a cookie, not an
account** — enough to answer "how many times have *you* done this" without a
name. **Neglect is visible but never fatal** — moisture dries out and
recovers; cumulative growth only ever goes up. See earlier crit tags for the
full original accounts.

**Crit 9's decision** — concurrent waterings compose, nothing to merge or
lose — still stands unchanged: watering is a relative increment
(`growth_units = growth_units + ?`), one atomic `UPDATE`, never a
read-then-write. Two concurrent waterings interleave at the SQL statement
boundary, not inside one, so neither's contribution is ever silently
dropped — the same reasoning this week's exclusive-claim logic for
collectibles builds on directly, below.

## Decision (crit 10): identity is a cookie plus a separate public codename

**Status:** accepted.

**Context.** This crit's write-up is behavioural: "what each person may see
and change is checked on the server, and that decision is written down."
`visitor_id` already distinguished visitors correctly — every write handler
derived "who is this" from it, never from a request body. What it lacked
was anything *publicly displayable*: no UI showed who did what, and the
server logged nothing beyond one boot-time line.

Options: show the raw `visitor_id` (rejected — it's the session credential,
and displaying it anywhere lets anyone reading a shared screen or log line
lift and reuse it); a real account system (rejected — solves nothing this
brief asks for, adds exactly the friction, "URL alone, nothing else," the
course setup tests against); or a **separate public codename, generated once
per visitor (chosen)** — `visitor_identity.public_id` (e.g. "Maple-7K2"),
built from a plant-themed noun list plus a random code (`pickCodename` in
`garden.ts`), created lazily on whichever request first needs one rather
than a bulk migration — every visitor gets one on their next request at the
cost of one indexed lookup.

**Decision.** Keep `visitor_id` exactly as the session credential it already
was; add `public_id` as a wholly separate, display-safe value. Never let the
two cross: `visitor_id` never appears in the UI or a log line; `public_id`
carries no session-hijacking value even reused alone.

**Consequences.** This surfaced a real gap while wiring it in: the cookie
never set `Secure`, even over genuine HTTPS — Fly terminates TLS in front of
the app, so the app itself only ever sees plain HTTP, and a naive check
would never have caught it. Fixed by reading `X-Forwarded-Proto`, the header
Fly's proxy sets, verified against both a plain local request and one with
that header forced. **What this doesn't solve:** an anonymous codename
can't tell two browser profiles run by the same person apart from two
different people — disclosed directly in the UI and in `docs/multi-user.md`,
not quietly assumed away.

## Decision (crit 10): a persisted audit table, not just stdout

**Status:** accepted.

**Context.** The spec: "the app logs who did what, server-side, and the
logging outlives the crit." A structured `console.log` line per action is
easy and was the first thing built — but checking it by hand against the
real Fly deploy after a machine auto-stop (the same `auto_stop_machines`
setting that keeps this app cheap) showed `flyctl logs`'s own retention
window had already rolled over. Verified by hand, not assumed — the same
discipline already applied to persistence itself.

**Decision.** One `logEvent()` call site writes both the stdout line
`flyctl logs` tails live and a row in a new `audit_log` table on the same
persistent Fly volume everything else lives on — never two paths that could
drift apart. Wired into every state-changing success and named rejection
reason, identity creation, WS connect/disconnect, both schema migrations,
and boot; never a plain read (`/api/state` is polled every 20s by every open
tab — logging it would drown out everything else). Pruned lazily, no
background timer, the same "checked on a real request" philosophy the app's
collectible spawning already uses — a 30-day cutoff plus a 50,000-row hard
cap, so the table can't grow unbounded.

**Consequences.** A gated, env-var-only diagnostic endpoint
(`/api/_test/audit-log`, 404s unless `ENABLE_TEST_ENDPOINTS=1`, confirmed
off by default) lets the automated suite assert against *real* persisted
rows, not just code read by inspection. **What this doesn't solve:** this is
one machine's local SQLite file, not a managed log aggregator — the right
trade-off for a 256MB, one-volume constraint, not a claim of
enterprise-grade observability.

## Decision (crit 10): reject a forged Origin, but never an absent one

**Status:** accepted.

**Context.** `SameSite=Lax` already defends against the real CSRF vector
here — no evergreen browser attaches it to a cross-site `fetch()` POST. A
second check (`isTrustedOrigin`) was worth adding regardless. The tempting
stricter version — reject any POST with no `Origin` header at all — would
have broken every existing integration test in `spec/`, since Node's
`fetch()` never sets `Origin` for a same-process call. Not a workaround to
route around: a real signal that "absent" isn't what a forged browser
request looks like, so rejecting it buys nothing.

**Decision.** Reject only a *present but mismatched* `Origin`/`Referer`,
logged as its own named event (`security.origin-rejected`), distinct from an
ordinary rejection in the log.

## Verification

Every claim above has a corresponding test, not just a reading of the code:
identity stability and uniqueness (`spec/identity.test.ts`), real persisted
log rows (`spec/audit-log.test.ts`), the care feed excluding personal fields
and its broadcast latency (`spec/care-feed.test.ts`, `spec/live-care.test.ts`),
the Origin policy's both halves (`spec/csrf.test.ts`), and that a forged
identity field already had zero effect, both behaviourally and by a direct
read of `server.ts`'s own body-field accesses (`spec/spoofing.test.ts`).

## Commits

This round's work, in order: pure codename logic and its tests
([`e4efc56`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-lilth2/commit/e4efc56)),
the identity schema, cookie fix, and wiring
([`1b94bfb`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-lilth2/commit/1b94bfb)),
the garden version counter
([`cf732b4`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-lilth2/commit/cf732b4)),
the persisted audit log and its gated test endpoint
([`d7a1cdb`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-lilth2/commit/d7a1cdb)),
the shared care feed and its broadcast
([`d20345f`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-lilth2/commit/d20345f)),
its client-side display
([`29f8b70`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-lilth2/commit/29f8b70)),
the Origin check
([`b42ad65`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-lilth2/commit/b42ad65)),
the spoofing regression proof
([`7d8a2a3`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-lilth2/commit/7d8a2a3)),
and the permissions write-up itself
([`8547691`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-lilth2/commit/8547691)).
