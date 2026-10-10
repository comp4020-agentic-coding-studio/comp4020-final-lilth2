# Crit 9 reflection

**The breakthrough** was realising I'd already half-answered this week's
question without noticing. The brief asks for one decision about concurrent
users — what happens when two people change the same thing at once — and my
first instinct was to go looking for something to build: a lock, a version
column. Rereading `server.ts`, `waterPlant` was already written as
`size = size + 0.15`, never `size = <value I just computed>` — already the
concurrency decision, just never named as one. The real work was recognising
that, writing it up as a real ADR with the options I didn't take, and proving
it rather than asserting it.

**What I directed, grounded, and corrected:** I picked which of the brief's
four concurrency scenarios actually applied to this app, rather than taking
whichever one came up first. I grounded the "about a second" claim myself
with a small WebSocket script against the running server, timing the gap
between a watering and the broadcast landing on an unrelated connection,
before writing the automated version of that check. I corrected a redundant
round trip in the client: the live handler was re-fetching `/api/state` on
every broadcast instead of using the plant data the broadcast already
carried — harmless, but the kind of thing that looks fine until you ask
"does this message already contain what I need?" More substantially, I
caught a real bug in the new test itself: it hung forever the first time I
ran it alone, because `ws.once("open", ...)` followed by a separate
`ws.once("message", ...)` has a gap where the server's opening message can
arrive before the client starts listening for it. It passed once inside the
full suite by luck of timing, which is exactly why "it passed once" isn't
evidence — I only trusted it after running it against five fresh server
instances in a row.

What this changed: I used to think "handling concurrency" meant adding
something. The lesson this week was that the strongest decision is often
choosing an operation that can't conflict in the first place — and that
spotting it, like spotting a hanging test, requires actually reading and
running the thing, not just trusting what it's supposed to do.
