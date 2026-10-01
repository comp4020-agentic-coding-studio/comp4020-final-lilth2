# Process overview

This is a decision record for the final project, in the sense an
[architecture decision record](https://adr.github.io/) is: not a changelog,
but the handful of choices that would be expensive to reverse later, and why
each one went the way it did. It gets rewritten (not appended to) at every
crit, so this version only covers getting from the brief to crit 8's
proof-of-life.

## Decision: the app is "Tend", a single shared plant

The brief asks for multi-user, real-time, persistent, and explicitly warns
against the median answer an agent would produce unprompted — which, left to
its own devices, is a chat room, a shared todo board, or a voting wall.
I picked a shared, persistent plant instead: one piece of state, watered by
anyone, that grows forever and never resets per-visitor. It satisfies the
brief's three words with the least surface area I could find — there's no
content to moderate, no rooms to manage, and "multi-user" is just "the row
in the database doesn't belong to you." That smallness is deliberate: every
later crit (real-time, then server logging) has to add to something, and
adding is easier to keep honest than cutting down an app that started too
big. See [README.md](README.md) for the fuller case.

## Decision: Node + `node:sqlite` + `ws`, no framework

The three live options I weighed:

- **Astro** (the course default from C2) is built around pre-rendered pages
  with islands of interactivity; it's a strong fit for content sites but
  fights a long-running WebSocket connection and a server-held piece of
  mutable state, which is the entire point of this app. Reaching for it here
  would mean immediately reaching past it for a custom server adapter —
  adopting the default would have cost more than it saved.
- **A fuller backend framework** (Express, Fastify, Hono) buys routing
  conveniences I don't need yet for four HTTP routes and one WebSocket
  upgrade handler.
- **Plain `node:http` + `ws`**, what's actually here, keeps the whole server
  in one file I can read top to bottom, with nothing between the request and
  the code that handles it.

For storage, the fixed constraint is the brief's: 256 MB of memory, one Fly
volume at `/data`, no separate database server. `better-sqlite3` was the
obvious first instinct, but it's a native addon that needs a working
node-gyp toolchain at install time — exactly the kind of thing that works
locally and then breaks silently in a slim Alpine Docker build. Node 24
ships `node:sqlite` as a built-in, synchronous, zero-dependency module, which
sidesteps that whole class of failure and needed no entry in
`package.json` at all. The two runtime dependencies that remain, `ws` and
`marked`, are both pure JavaScript for the same reason: nothing to compile
in the image that builds it.

## Decision: a cookie-identified visitor, not an account

"Distinguishable users" doesn't have to mean a login. A `visitor_id` cookie,
set the first time someone shows up, is enough to answer "how many times
have *you* watered this" without ever asking for a name or a password. It's
the minimum that makes "find your trace when you come back" true, and it
costs nothing a stranger would notice.

## What I verified myself before trusting it

The one failure mode that would have silently broken the whole premise is
the database not actually surviving a restart — a developer easily convinces
themselves persistence works because the process never stops during
development. I killed and restarted the server by hand against the same
data directory and confirmed the plant's size and the visitor's count came
back unchanged, before writing the automated check for the same thing.
I also watched `node:sqlite`'s floating-point addition drift
(`1.15 + 0.15` lands on `1.2999999999999998`) show up straight in the
`/api/state` response, and rounded on read rather than leaving it to a test
that would never have exercised it enough times to notice.
