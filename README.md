# Tend

Tend is one plant, shared by everyone who ever visits. There's no sign-up,
no rooms, no "your garden" — there is exactly one pot, and whoever shows up
waters the same one. Water it and it grows a little, for everyone, forever.
Come back a week later and it's still there, a little taller than you left
it, carrying every stranger's waterings in between.

## What good means for this app

Good means it feels like **a place that was already going before you got
there, and will keep going after you leave** — not a dashboard you configure,
not a product you onboard into. You should be able to understand the whole
point of it in the time it takes to read one sentence and press one button,
and the only "account" you get is a cookie that remembers how many times
*you* watered it, so a return visit feels like coming back to something
rather than starting over.

Concretely, for me "good" means:

- **Honesty about scale.** One plant, one number, one button. Nothing here
  pretends to be bigger or more serious than it is. A feature I can't
  explain in one sentence doesn't belong in it.
- **Visible shared history.** The whole point is that your watering sits
  next to everyone else's in the same row of the same table. If the plant's
  size were per-visitor, this would just be a slow todo-list; it's the
  sharing that makes the visit worth repeating.
- **Neglect is visible, but never fatal.** If nobody waters it for a while it
  visibly dries out — smaller, yellowing, eventually dormant and brown — the
  same honesty a real plant would give you. But it never dies: one watering,
  from anyone, brings it straight back. The point isn't to punish you for
  being gone; it's that care has to be kept up, and it's never too late to
  start again.
- **Works for a total stranger, immediately.** No README, no tutorial
  overlay — the button says what it does, and the plant visibly responds
  within a second of pressing it.

## Where that definition came from

The brief pointed at "the small web, games for a handful of friends, and
tools built for one workshop" as reference points, and that's genuinely
where this came from. I thought about the small, slightly weird single-serving
sites that used to be more common before every site had to also be a
business — a shared whiteboard someone's friend group kept alive for years,
a page that was just a button and a counter, communal fish tanks and
digital pets that multiple people fed. None of those needed accounts,
analytics, or a growth loop. They needed exactly one piece of shared,
persistent state and a reason to come back to it. A plant that remembers
being watered is that, with almost nothing else added.

It's also deliberately *not* a chat app, a todo board, or a voting wall —
the obvious "multi-user real-time" answers an agent reaches for unprompted.
A plant has no messages to moderate and no votes to tally; the only content
is the act of tending it, which keeps the scope honest at every later crit
instead of growing a content-moderation problem by week 11.

## What crit 8 proves

A stranger can visit, water the plant, and find the same plant — bigger,
remembering them — when they come back. The real-time broadcast (everyone
sees everyone else's waterings live) and any further polish are explicitly
next week's job; this week is the plant surviving a redeploy with its size
intact.

A stranger can also watch it dry out if nobody's tended it for a while, watch
a drought window make that worse, and see it brought back by the next person
to water it — the small, honest version of "this needs ongoing care, not a
one-time fix," which is the whole reason it's a plant and not a counter.
