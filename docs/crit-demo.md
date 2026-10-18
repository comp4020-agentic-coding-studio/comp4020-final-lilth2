# Crit 10 demo: narrate from the logs

This crit is demonstrated "fly by instruments" — the presenter doesn't touch
the app's own UI at all. Two classmates act on the live site from their own
browsers; everything shown to the pod comes from the server's own log
stream.

## The live app

- URL: **https://comp4020-final-lilth2.fly.dev**
- Fly app name: **comp4020-final-lilth2**

## The one command

```sh
mise exec -- flyctl logs -a comp4020-final-lilth2
```

Run this from inside the repo (it needs `mise.local.toml`'s `FLY_API_TOKEN`,
gitignored, never committed). It tails the live container's stdout, which is
exactly where every `logEvent()` call in `server.ts` writes a structured JSON
line — one per state-changing action, its rejections, identity creation, WS
connect/disconnect, migrations, and boot. Nothing here needs a second
terminal or a different tool; this is the whole demo surface.

A line looks like this (a real line a watering actually produces, not an
invented example):

```json
{"ts":"2026-10-18T00:30:07.104Z","level":"info","event":"garden.water","requestId":"…","actorPublicId":"Maple-7K2","action":"water","targetType":"plant","targetId":"tree","outcome":"success","detail":{"growthAdded":0.95,"remainingToday":99}}
```

Reading it aloud is the entire demo: *who* (`actorPublicId`), *did what*
(`event`/`action`), *to what* (`targetType`/`targetId`), *with what result*
(`outcome`, and `reasonCode` when it's a rejection).

## Why there's a second, persisted copy of the same logs

Fly's own log retention is short — the app's machine stops when nobody's
using it (`auto_stop_machines` in `fly.toml`, the same setting that keeps
this app cheap to run), and the live tail's window rolls over with it. This
was confirmed by hand against the real deploy, not assumed: after the
machine auto-stopped once, `flyctl logs` no longer showed events from before
that stop.

That's not good enough for "the logging outlives the crit," so every event
`logEvent()` writes to stdout is also written, in the same call, to
`audit_log` — a real SQLite table on the same persistent Fly volume
everything else in this app lives on (`/data`, the one volume the course
setup provides). If a question comes up after the crit session has ended,
the answer isn't "check `flyctl logs` and hope the window hasn't rolled
over" — it's a real, durable row, reachable by SSHing into the machine and
querying the database directly:

```sh
mise exec -- flyctl ssh console -a comp4020-final-lilth2
# inside the machine:
sqlite3 /data/tend.db "select ts, event, actor_public_id, outcome, reason_code from audit_log order by id desc limit 50;"
```

`audit_log` is pruned lazily (no background timer — checked the same way
collectible spawning already is, as a side effect of a real request) to a
30-day window and a 50,000-row cap, both configurable via
`AUDIT_LOG_RETENTION_DAYS`/`AUDIT_LOG_MAX_ROWS` — generous enough to outlast
a crit by weeks, nowhere near large enough to threaten the course's 256MB
container.

## The 3–5 minute flow

1. **Before the pod arrives**: have `mise exec -- flyctl logs -a
   comp4020-final-lilth2` already tailing in a terminal everyone can see.
   Confirm the app is awake (load the URL once yourself beforehand — Fly's
   machine takes a moment to wake from idle, and that wake-up shouldn't eat
   into the demo).

2. **Hand the URL to two classmates.** Nothing else — no pre-shared cookie,
   no console commands, no login. Each opens it in their own browser (or, for
   the crit's own acceptance check, two separate Chrome profiles / an
   incognito window).

3. **Classmate A waters a plant.** Narrate the resulting `garden.water` line
   as it appears: their public codename, which plant, how much growth it
   added, and that it's a `success`. Point out their codename also now shows
   in the UI's own "Recent garden care" feed and resource-bar badge — the
   same identity, in two different places, because the log and the UI both
   read from the same source.

4. **Classmate B catches a bug or claims a treasure.** Narrate the
   `garden.collect` line — their own distinct codename, a different
   `targetType`, `success`. Point out classmate A's screen updates with B's
   action within about a second, with no reload — that's the realtime
   requirement, visible from the log's own timestamps if you time it.

5. **Provoke one rejection on purpose** — ask A to water again immediately
   (inside their own cooldown) or ask both to try catching the same bug at
   once. Narrate the resulting line: `outcome: "rejected"`, a specific
   `reasonCode` (`cooldown`, `already-claimed`, whichever fires), and that
   it's clearly attributed to one of the two actors, not the other.

6. **Close by pointing at the distinction the brief asks for**: "if you
   can't tell your two classmates apart in the logs, or one of them can
   change what should be the other's, that's the finding" — and the log
   stream you've just narrated already showed two different codenames doing
   two different things, correctly separated, the whole time.

## Honest limits of this demo

- The exact realtime latency isn't claimed from memory — it should be timed
  live (a phone stopwatch between "classmate B clicks" and "classmate A's
  screen visibly updates" is enough) rather than asserted as a round number.
- The course's published brief and crit pages (checked directly, not
  assumed) don't specify exact pixel viewport sizes to test against — if
  asked, say so plainly rather than inventing a figure.
