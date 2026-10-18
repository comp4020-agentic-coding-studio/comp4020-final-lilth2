// Pure garden math, same discipline as stage.ts: no side effects, no clock
// or database reads of its own, so every rule here is unit-testable against
// synthetic inputs instead of waiting on real days or real HTTP round trips.
// server.ts is the only thing that touches the database or the real clock.
import type { Stage } from "./stage.ts";

// The garden's second axis, independent of moisture: how much a plant has
// permanently grown. `growthUnits` only ever goes up (one point per valid
// watering), so a growth stage, once reached, can never be lost to neglect —
// only moisture dips. All species share one threshold ladder by default
// (configurable per-species for future balancing); the index into it is
// what picks which distinct silhouette (trunk/branch/canopy counts, not
// just a scale factor) a plant renders as.
export function growthStageIndex(growthUnits: number, thresholds: readonly number[]): number {
  let index = 0;
  for (let i = 0; i < thresholds.length; i++) {
    if (growthUnits >= thresholds[i]) index = i;
  }
  return index;
}

// One-time conversion when thresholds change: a plant's *relative* position
// within its current stage (how far it had gotten toward the next one) is
// preserved exactly, just re-expressed against the new ladder — so nobody's
// prior contribution is lost or inflated, and a plant already at its final
// stage stays there. `oldValue` and `oldThresholds` describe the plant's
// growth under the ladder being retired; `newThresholds` is what it's
// migrating onto.
export function migrateGrowthUnits(
  oldValue: number,
  oldThresholds: readonly number[],
  newThresholds: readonly number[],
): number {
  const oldStage = growthStageIndex(oldValue, oldThresholds);
  const oldLo = oldThresholds[oldStage];
  const newLo = newThresholds[oldStage];
  const isMaxStage = oldStage + 1 >= oldThresholds.length;
  if (isMaxStage) return newLo;
  const oldHi = oldThresholds[oldStage + 1];
  const newHi = newThresholds[oldStage + 1];
  const span = oldHi - oldLo;
  const fraction = span > 0 ? Math.min(1, Math.max(0, (oldValue - oldLo) / span)) : 0;
  return newLo + fraction * (newHi - newLo);
}

export interface MoistureConfig {
  thrivingMinutes: number;
  thirstyMinutes: number;
  wiltingMinutes: number;
  // How much faster moisture decays during a drought window — 3 means a
  // drought's "thriving" window is a third as long, etc.
  droughtMultiplier: number;
}

// A configurable twin of stage.ts's stageFor, kept separate so the graded,
// already-deployed single-plant app's decay curve (stage.ts) is never
// touched by this garden experiment's tuning. Same shape, parameterised.
export function moistureStageFor(minutesSince: number, isDrought: boolean, config: MoistureConfig): Stage {
  const factor = isDrought ? config.droughtMultiplier : 1;
  if (minutesSince < config.thrivingMinutes / factor) return "thriving";
  if (minutesSince < config.thirstyMinutes / factor) return "thirsty";
  if (minutesSince < config.wiltingMinutes / factor) return "wilting";
  return "dormant";
}

// Every daily reset (watering limits, the forage cap) and the daily garden
// event share one clock: UTC midnight. UTC rather than a visitor's local
// time means every visitor and the server agree on the same boundary
// without needing a timezone from the client — the same trade this app
// already made for drought windows.
export function dateKeyUTC(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function utcMidnightAfter(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

export type GardenEvent = "none" | "breeze" | "rain" | "butterfly";

// Deterministic from the calendar date alone (like isDroughtActive is
// deterministic from the clock) — every visitor sees the same event on the
// same UTC day, with nothing to schedule or store. A plain day-of-year
// rotation is enough: it only has to feel occasional at a glance, not be
// cryptographically random.
const EVENT_ROTATION: readonly GardenEvent[] = ["none", "none", "breeze", "rain", "none", "butterfly", "none"];

export function dailyEventFor(now: Date): GardenEvent {
  const startOfYear = Date.UTC(now.getUTCFullYear(), 0, 1);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dayOfYear = Math.round((today - startOfYear) / 86_400_000);
  return EVENT_ROTATION[dayOfYear % EVENT_ROTATION.length];
}

export interface WateringLimits {
  /** Total successful waterings one visitor may make across the whole garden, per UTC day. */
  gardenDailyLimit: number;
  /** Minimum gap between one visitor's two successful waterings, of anything — just enough to absorb a double-click or a retried request, not a real pacing mechanic. */
  visitorCooldownSeconds: number;
}

export interface WateringState {
  now: Date;
  /** This visitor's last successful watering of anything, any day. */
  visitorLastWateredAt: Date | null;
  /** This visitor's successful waterings across the whole garden, today (UTC). */
  visitorGardenCountToday: number;
}

export type WateringBlockReason = "cooldown" | "garden-daily";

export interface WateringDecision {
  allowed: boolean;
  reason?: WateringBlockReason;
  /** When this becomes allowed again, for cooldown/daily-limit blocks. */
  retryAt?: Date;
}

export interface AchievementPlantView {
  waters: number;
  growthStage: number;
}
export type AchievementGardenView = Record<string, AchievementPlantView>;

export interface AchievementDef {
  id: string;
  decoration: string;
  check: (garden: AchievementGardenView, speciesIds: readonly string[]) => boolean;
}

// Three small, globally-shared goals — unlocked once, for everyone, the same
// way the garden itself is shared. Each unlock adds one purely decorative
// element to the scene; none of them changes a growth or watering rule.
// Pure and data-driven on purpose: with growth thresholds in the hundreds of
// waterings, reaching one for real inside a test would take forever, so
// these are checked against a fabricated garden snapshot instead.
export const ACHIEVEMENTS: readonly AchievementDef[] = [
  {
    id: "three-species",
    decoration: "stone-path",
    check: (garden, speciesIds) => speciesIds.filter((id) => garden[id].waters > 0).length >= 3,
  },
  {
    id: "first-bloom",
    decoration: "fireflies",
    check: (garden) =>
      garden.shrub.growthStage >= 3 || garden.fruit.growthStage >= 2 || garden.tree.growthStage >= 4,
  },
  {
    id: "new-branch",
    decoration: "stepping-stones",
    check: (garden) => garden.tree.growthStage >= 1,
  },
];

// A personal, per-visitor collection, entirely separate from the shared
// garden's growth — this list is the single source of truth for which item
// IDs exist; public/collection.js mirrors these same IDs with the display
// info (name, description, icon) a server module has no business owning.
// Six insects, six treasures — kept deliberately small so "12 / 12" is a
// realistic thing to actually reach, not a number nobody will ever see.
export interface CollectibleDef {
  id: string;
  group: "insect" | "treasure";
}
export const COLLECTIBLES: readonly CollectibleDef[] = [
  { id: "ladybug", group: "insect" },
  { id: "butterfly", group: "insect" },
  { id: "bee", group: "insect" },
  { id: "snail", group: "insect" },
  { id: "ant", group: "insect" },
  { id: "beetle", group: "insect" },
  { id: "glowing-seed", group: "treasure" },
  { id: "pebble", group: "treasure" },
  { id: "clover", group: "treasure" },
  { id: "acorn", group: "treasure" },
  { id: "feather", group: "treasure" },
  { id: "seashell", group: "treasure" },
];

// Deterministic, not random: a visitor's Nth-ever discovery (lifetimeCount
// is their total finds so far, before this one) always lands on the same
// catalog entry, so the whole catalog is guaranteed to cycle through once
// before anything repeats — testable without needing to stub Math.random.
export function collectibleForForageIndex(lifetimeCount: number): CollectibleDef {
  return COLLECTIBLES[lifetimeCount % COLLECTIBLES.length];
}

// --- shared, backend-owned collectibles (section 4/5/6) ---
//
// Spawning, bug persistence, and the insect growth slowdown all live here as
// pure functions over explicit inputs, the same discipline as everything
// else in this file — server.ts supplies the real randomness, the real
// clock, and the real database rows; this just makes the rules themselves
// independently testable.

export interface SpawnWeights {
  [itemId: string]: number;
}

// Configurable per item, not hardcoded per kind — "raise the odds of stars,
// seeds, and insects" (section 4) becomes: give glowing-seed (the sparkle
// shown in the scene) and the insect group a higher weight than the other
// treasures, all in one place to retune.
export const DEFAULT_SPAWN_WEIGHTS: SpawnWeights = {
  ladybug: 2,
  butterfly: 2,
  bee: 1.5,
  snail: 1,
  ant: 1,
  beetle: 1,
  "glowing-seed": 3,
  pebble: 1,
  clover: 1,
  acorn: 1,
  feather: 1,
  seashell: 1,
};

// Deterministic given `randomValue` (caller supplies Math.random()'s output,
// or a fixed value in a test) — a classic weighted pick by walking a
// cumulative-weight line. Only considers items in `pool` (e.g., just the
// "insect" group when treasures are at their cap), so a maxed-out kind
// naturally stops being pickable without the caller filtering weights by hand.
export function pickWeightedCollectible(
  pool: readonly CollectibleDef[],
  weights: SpawnWeights,
  randomValue: number,
): CollectibleDef {
  const total = pool.reduce((sum, item) => sum + (weights[item.id] ?? 1), 0);
  let target = randomValue * total;
  for (const item of pool) {
    target -= weights[item.id] ?? 1;
    if (target <= 0) return item;
  }
  return pool[pool.length - 1];
}

export interface SpawnCaps {
  bugMaxActive: number;
  treasureMaxActive: number;
}

// Which *kind* to spawn next, given how many of each are already out there
// and a coin flip for when both still have room. Returns null when both
// kinds are already at their cap — the caller should simply skip spawning
// this tick rather than force an item into an already-full scene.
export function pickSpawnKind(
  caps: SpawnCaps,
  activeBugs: number,
  activeTreasures: number,
  randomValue: number,
): "bug" | "treasure" | null {
  const canBug = activeBugs < caps.bugMaxActive;
  const canTreasure = activeTreasures < caps.treasureMaxActive;
  if (!canBug && !canTreasure) return null;
  if (!canBug) return "treasure";
  if (!canTreasure) return "bug";
  return randomValue < 0.5 ? "bug" : "treasure";
}

export interface SpawnTiming {
  minSeconds: number;
  maxSeconds: number;
  minBatch: number;
  maxBatch: number;
}

// The next spawn check is due at a random point 15–30s out (section 4's
// "random interval"), computed fresh each time rather than on a fixed tick —
// and because it's only ever *checked* when a real request comes in (see
// server.ts), it only ever actually fires "while someone is online", with no
// background timer that would never run on a sleeping Fly machine.
export function nextSpawnDelaySeconds(timing: SpawnTiming, randomValue: number): number {
  return timing.minSeconds + randomValue * (timing.maxSeconds - timing.minSeconds);
}

export function spawnBatchSize(timing: SpawnTiming, randomValue: number): number {
  const span = timing.maxBatch - timing.minBatch + 1;
  return timing.minBatch + Math.floor(randomValue * span);
}

export interface InsectSlowdownConfig {
  perBug: number;
  maxReduction: number;
}

// Every uncaught bug on a plant costs that plant 5% of its growth
// contribution per watering, capped at 50% off — applied to *future*
// waterings only (never retroactive, never rounds to 0: the floor is 50%,
// not 0%, so a watering always adds something). Catching a bug restores the
// rate immediately, for the same reason this is computed fresh each time
// rather than stored: there's nothing to "restore", just one fewer bug to
// divide by next time this is read.
export function insectGrowthMultiplier(activeBugCount: number, config: InsectSlowdownConfig): number {
  return Math.max(1 - config.maxReduction, 1 - config.perBug * activeBugCount);
}

// Deliberately not a lock on any plant — a plant being "already thriving"
// never stops anyone from watering it. That's what keeps this compatible
// with crit 9's concurrency decision (every watering composes; nobody's
// click is silently dropped because somebody else's landed a moment
// earlier). The per-plant daily cap and 4-hour cooldown from the original
// design are gone too: with a 100/day garden-wide allowance, a 2-per-plant
// cap would have made most of that allowance impossible to ever spend. What
// remains is the minimum needed to keep "100 real actions" meaningful: a
// short per-visitor cooldown that only exists to absorb a double-click or a
// retried request, and the daily total itself. server.ts just acts on this
// verdict instead of re-deriving it inline, and the rules are tested with
// synthetic clocks the way spec/stage-logic.test.ts already tests decay,
// instead of only through slower, flakier HTTP round trips.
export function decideWatering(limits: WateringLimits, state: WateringState): WateringDecision {
  if (state.visitorLastWateredAt) {
    const cooldownEndsAt = new Date(state.visitorLastWateredAt.getTime() + limits.visitorCooldownSeconds * 1000);
    if (state.now < cooldownEndsAt) {
      return { allowed: false, reason: "cooldown", retryAt: cooldownEndsAt };
    }
  }
  if (state.visitorGardenCountToday >= limits.gardenDailyLimit) {
    return { allowed: false, reason: "garden-daily", retryAt: utcMidnightAfter(state.now) };
  }
  return { allowed: true };
}

export interface CollectionLimits {
  /** Total successful collects (bugs + treasures combined) one visitor may make, per UTC day. */
  dailyLimit: number;
  /** Minimum gap between one visitor's two successful collects — absorbs a double-click or a retried request, not a real pacing mechanic. */
  minIntervalMs: number;
}

export interface CollectionState {
  now: Date;
  visitorCollectedToday: number;
  /** This visitor's last successful collect of anything, any day. */
  visitorLastCollectAt: Date | null;
}

export type CollectionBlockReason = "collection-daily" | "collect-too-soon";

export interface CollectionDecision {
  allowed: boolean;
  reason?: CollectionBlockReason;
  /** When this becomes allowed again, for the daily-cap/cooldown blocks. */
  retryAt?: Date;
}

// Same shape and same reasoning as decideWatering: the daily cap and the
// anti-double-fire cooldown are the only two things that can refuse a
// collect, and neither depends on which item or which plant was involved —
// that lookup stays in server.ts, which is the only place with a database.
export function decideCollection(limits: CollectionLimits, state: CollectionState): CollectionDecision {
  if (state.visitorCollectedToday >= limits.dailyLimit) {
    return { allowed: false, reason: "collection-daily", retryAt: utcMidnightAfter(state.now) };
  }
  if (state.visitorLastCollectAt) {
    const cooldownEndsAt = new Date(state.visitorLastCollectAt.getTime() + limits.minIntervalMs);
    if (state.now < cooldownEndsAt) {
      return { allowed: false, reason: "collect-too-soon", retryAt: cooldownEndsAt };
    }
  }
  return { allowed: true };
}

// A public, non-identifying label for an anonymous visitor — "Maple-7K2" —
// shown in the UI and in server logs instead of the session cookie itself.
// Deliberately excludes every species id and collectible id (a plant-themed
// noun list, picked once up front) so a sentence like "Fern-7K2 watered the
// Fern" or "Ladybug-4Q1 caught a ladybug" never reads as confusing.
export const CODENAME_NOUNS: readonly string[] = [
  "Maple",
  "Willow",
  "Birch",
  "Cedar",
  "Rowan",
  "Hazel",
  "Juniper",
  "Linden",
  "Poplar",
  "Sycamore",
  "Alder",
  "Beech",
  "Larch",
  "Sorrel",
  "Clover",
  "Moss",
  "Thistle",
  "Iris",
  "Poppy",
  "Violet",
  "Heather",
  "Bramble",
  "Meadow",
  "Elm",
] as const;

export interface CodenameFormat {
  /** Length of the base-36, uppercase code appended after the noun — 3 gives 46,656 codes per noun. */
  codeLength: number;
}

// Deterministic given its two random draws (the caller supplies two
// independent Math.random() outputs, or fixed values in a test) — one
// attempt at a noun+code pair. A codename genuinely needs two independent
// choices (which noun, which code), which is why this takes two randomValue
// parameters instead of the usual one; server.ts is responsible for
// retrying with a fresh pair of draws on the rare case this collides with
// an existing codename (see visitor_identity's UNIQUE constraint), the same
// way it already retries ensureColumn's "duplicate column name" error.
export function pickCodename(
  nouns: readonly string[],
  format: CodenameFormat,
  nounRandomValue: number,
  codeRandomValue: number,
): string {
  const noun = nouns[Math.min(nouns.length - 1, Math.floor(nounRandomValue * nouns.length))];
  const space = 36 ** format.codeLength;
  const code = Math.floor(codeRandomValue * space)
    .toString(36)
    .toUpperCase()
    .padStart(format.codeLength, "0");
  return `${noun}-${code}`;
}
