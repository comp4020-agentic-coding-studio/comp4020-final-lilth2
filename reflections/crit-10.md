# Crit 10 reflection (prepared ahead of the session)

This crit hasn't happened yet. What follows is preparation, not a finished
reflection — the work done so far, and the questions I expect to actually
answer once the session has happened, not a guessed-at version of feedback
or outcomes nobody's given me yet.

## What's done going into the session

A public, non-identifying codename for every visitor, kept structurally
separate from the session cookie doing the real identity work. A persisted
audit log alongside stdout, built after confirming by hand — not
assuming — that Fly's own log retention doesn't survive a machine auto-stop.
A shared "recent garden care" feed, deliberately a separate table from the
audit log so nothing personal can leak into something public by design. A
narrowed CSRF check on top of the existing `SameSite=Lax` cookie, specifically
shaped so it wouldn't break this repo's own test suite. A regression test
proving identity spoofing already had no effect. `docs/multi-user.md` and
`docs/crit-demo.md` for the write-ups the brief asks for.

## My honest guess at the breakthrough, not yet confirmed

Building the identity system wasn't the hard part — a cookie plus a
codename is not a hard problem. The interesting moment was checking a
load-bearing assumption by hand instead of trusting it: "the logging
outlives the crit" sounds obviously true of a `console.log` line until you
watch `flyctl logs` actually lose its history the moment the machine stops.
The same lesson crit 9's ADR already landed on for persistence — a claim is
only real once you've killed the thing and checked.

## Directed, grounded, corrected — so far

I chose the identity model that fit "any anonymous visitor" rather than
defaulting to accounts. I grounded "outlives the crit" against the live
deploy rather than `fly.toml`'s comments. I corrected my own first CSRF
instinct — rejecting any absent `Origin` — after noticing it would fail
every existing test. I haven't yet corrected anything based on a
classmate's or tutor's actual feedback, because that hasn't happened; this
section gets rewritten honestly once it has.
