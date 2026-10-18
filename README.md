# Tend

Tend is a shared garden of five plants — a tree, bamboo, a flowering shrub, a
fern, and a fruit tree — tended by whoever shows up. There's no sign-up: a
cookie remembers you as an anonymous gardener with your own public codename
("Maple-7K2"), but the garden itself belongs to nobody in particular. Water a
plant and it grows a little, for everyone, forever; the next stranger who
visits finds the same garden, a little taller than you left it, carrying
every visitor's care in between.

## Why this needs more than one person

A garden with one gardener is just a save file. The point of *this* one is
that growth is cumulative across strangers who never coordinate: five plants
means two people watering at once are rarely even looking at the same one,
and the "Recent garden care" feed makes the other person's contribution
visible in real time instead of invisible. A shared whiteboard needs nothing
fancier than this to be worth repeat visits — the garden earns a second
visitor the same way, by already having somewhere for them to leave a trace
that outlasts the tab they leave it in.

## The rules, and why

- **100 waterings a day, garden-wide, with a short cooldown** — not per
  plant. An earlier per-plant cap effectively made most of a generous daily
  allowance unreachable, since watering five plants two at a time hits a
  wall fast; one shared number is both simpler to understand and actually
  spendable. The cooldown exists only to absorb an accidental double-click,
  not as a real pacing mechanic.
- **Insects slow a plant's growth, never destroy it.** Each uncaught bug on
  a plant cuts that watering's contribution by 5%, capped at 50% off, and
  catching one restores the rate immediately — the penalty only ever applies
  going forward, never retroactively. This gives the shared collectible
  system a reason to matter beyond decoration, without ever making neglect
  punishing.
- **Growth never goes down.** Short-term moisture dries out and recovers
  (the same honest "it needs ongoing care" mechanic from earlier weeks), but
  cumulative growth is a one-way ratchet. A newcomer's first watering always
  counts for something real, regardless of how long the garden sat untended.
- **Identity is a cookie, not an account**, deliberately. The brief asks for
  "the app tells them apart," not "the app verifies who they are" — a
  pseudonymous codename is enough to show whose watering is whose without
  asking a stranger for anything beyond the URL. `docs/multi-user.md` has the
  full accounting of what that does and doesn't defend against.

## What's tested vs. what's judged

Automated specs cover what a server can prove mechanically: a watering
composes correctly under real concurrency, a claim on a shared item can only
ever succeed once, a visitor's personal quota and collection are never
touched by another visitor's request (forged identity fields included), the
realtime broadcast lands well under a second, and the audit log records what
it claims to. Whether the garden *feels* worth tending — whether five plants
read as enough variety, whether the care feed reads as companionship rather
than noise — is a judgement call for a person looking at it, not something a
test suite can settle either way.

## What's deferred

Persistent logging and a written account of who may see and change what were
this crit's actual ask; see `PROCESS.md` for the decision record and
`docs/multi-user.md` for the permissions themselves. Still explicitly out of
scope: real accounts, any defence against one person running multiple
browser profiles, and rate limiting beyond the existing daily caps.
