# Crit 9 reflection

**The breakthrough** was realising I'd already half-answered this week's
question without noticing. The brief asks for one decision about concurrent
users — what happens when two people change the same thing at once — and my
first instinct was to go looking for something to build: a lock, a version
column, something that looked like "handling concurrency." Rereading
`server.ts`, `waterPlant` was already written as `size = size + 0.15`, never
`size = <value I just computed>`. That's not an accident waiting to be
exploited by two simultaneous clicks; it's already the concurrency decision,
just never named as one. The actual work this week was recognising that,
writing it down as a real ADR with the options I didn't take, and then
proving it rather than asserting it — `spec/live.test.ts` fires two
waterings at once and checks both land, instead of trusting the argument.

**What I directed, grounded, and corrected:** I picked which of the brief's
four concurrency scenarios actually applied to this app, rather than taking
whichever one came up first. I grounded the "about a second" claim myself
with a small WebSocket script against the running server, timing the gap
between a watering and the broadcast landing on an unrelated connection,
before writing the automated version of that check. I corrected a redundant
round trip in the client: the live handler was re-fetching `/api/state` on
every broadcast instead of using the plant data the broadcast already
carried — harmless, but the kind of thing that looks fine until you ask
"does this message already contain what I need?"

What this changed: I used to think "handling concurrency" meant adding
something — a lock, a queue, a retry. This week's lesson was that the
strongest concurrency decision is often choosing an operation that can't
conflict in the first place, and that spotting it requires actually reading
what the code does, not just what it's for.
