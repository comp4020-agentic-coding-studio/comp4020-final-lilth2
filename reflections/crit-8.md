# Crit 8 reflection

**The breakthrough** was realising the scope problem and the stack problem
were the same problem. My first instinct for "multi-user, real-time, good"
was something with rooms and messages — which immediately needed accounts,
moderation, and a much bigger surface than one week of proof-of-life could
responsibly ship. Picking a single shared, persistent plant instead of a
request to build something, interactive, collapsed that: one row, one
number, one button, nothing to moderate. The stack followed from the same
instinct toward smallness — `node:sqlite` over a native dependency, plain
`node:http` over a framework, so the whole server stays in one file I can
actually hold in my head.

**What I directed, grounded, and corrected:** I set the shape of the app
(a shared plant, not a chat room) and the stack constraints (no native
dependencies, Node's built-in SQLite) before any code was written, and asked
for a few concrete directions rather than one open brief, specifically to
avoid the median multi-user demo. I grounded the persistence claim myself —
killed the running server and restarted it against the same data directory
and watched the plant's size come back unchanged — rather than trusting that
a database write implies a database read. I corrected one agent mistake
directly: the API was returning un-rounded floating-point sizes
(`1.4499999999999997`) straight to the client, which I caught by actually
calling the endpoint rather than reading the code.

This changed how I think about "done": a persistence claim isn't true until
you've actually killed the process and checked, not just written the code
that should make it true.
