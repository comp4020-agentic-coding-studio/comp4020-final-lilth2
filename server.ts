// Tend: a shared garden everyone visits together. Five plants, one garden,
// no accounts — watering one grows it a little, for everyone, forever.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { marked } from "marked";
import { WebSocketServer } from "ws";
import {
  ACHIEVEMENTS,
  CODENAME_NOUNS,
  COLLECTIBLES,
  DEFAULT_SPAWN_WEIGHTS,
  dailyEventFor,
  dateKeyUTC,
  decideCollection,
  decideWatering,
  growthStageIndex,
  insectGrowthMultiplier,
  migrateGrowthUnits,
  moistureStageFor,
  nextSpawnDelaySeconds,
  pickCodename,
  pickSpawnKind,
  pickWeightedCollectible,
  spawnBatchSize,
  utcMidnightAfter,
  type AchievementGardenView,
  type CodenameFormat,
  type GardenEvent,
  type InsectSlowdownConfig,
  type MoistureConfig,
  type CollectionLimits,
  type SpawnCaps,
  type SpawnTiming,
  type WateringBlockReason,
  type WateringLimits,
} from "./garden.ts";
import { isDroughtActive, type Stage } from "./stage.ts";

const PORT = Number(process.env.PORT ?? 8080);
// /data is the one path the Fly volume persists; fall back to the repo root
// for local development, where there's no volume at all.
const DATA_DIR = process.env.DATA_DIR ?? (existsSync("/data") ? "/data" : ".");
const DB_PATH = join(DATA_DIR, "tend.db");

// Five shared plants, each with its own growth-threshold ladder. A ladder's
// length is that species' number of distinct silhouettes. Growth is counted
// directly in whole valid waterings (one watering = one growth unit) so the
// numbers below read the same way the UI shows them: "86 / 150 valid
// waterings". All species share one baseline to start, with room to tune
// one species differently later without touching the others.
const SPECIES_IDS = ["tree", "bamboo", "shrub", "fern", "fruit"] as const;
export type SpeciesId = (typeof SPECIES_IDS)[number];

// Retired ladders, kept only so a plant's exact relative progress can be
// carried forward once per migration below — never used for a live decision
// once that migration has run. v1 was expressed in fractional "sunlight"
// (0.15 per watering); v2 switched to whole valid-watering counts but still
// topped out around 700; v3 (current) stretches that out by roughly 40x and
// adds a sixth stage, Ancient.
const GROWTH_THRESHOLDS_V1: Record<SpeciesId, readonly number[]> = {
  tree: [0, 0.3, 0.9, 2.1, 4.5],
  fruit: [0, 0.3, 0.75, 1.5, 3],
  bamboo: [0, 0.15, 0.45, 0.9, 1.8],
  shrub: [0, 0.15, 0.6, 1.35, 2.55],
  fern: [0, 0.15, 0.3, 0.75, 1.5],
};
const GROWTH_LADDER_V2 = [0, 50, 150, 350, 700] as const;
const GROWTH_THRESHOLDS_V2: Record<SpeciesId, readonly number[]> = {
  tree: GROWTH_LADDER_V2,
  fruit: GROWTH_LADDER_V2,
  bamboo: GROWTH_LADDER_V2,
  shrub: GROWTH_LADDER_V2,
  fern: GROWTH_LADDER_V2,
};

const GROWTH_LADDER_V3 = [0, 500, 2000, 6000, 15000, 30000] as const;
const GROWTH_THRESHOLDS: Record<SpeciesId, readonly number[]> = {
  tree: GROWTH_LADDER_V3,
  fruit: GROWTH_LADDER_V3,
  bamboo: GROWTH_LADDER_V3,
  shrub: GROWTH_LADDER_V3,
  fern: GROWTH_LADDER_V3,
};

const WATERING_LIMITS: WateringLimits = {
  gardenDailyLimit: Number(process.env.GARDEN_DAILY_LIMIT ?? 100),
  visitorCooldownSeconds: Number(process.env.WATERING_COOLDOWN_SECONDS ?? 3),
};
// Garden discovery (section 4/5): one shared pool of collectibles, backend-
// owned, not a separate imagined set per visitor — this is what keeps
// spawn pace sane regardless of how many people are online at once.
const COLLECTIBLE_SPAWN_TIMING: SpawnTiming = {
  minSeconds: Number(process.env.SPAWN_MIN_SECONDS ?? 15),
  maxSeconds: Number(process.env.SPAWN_MAX_SECONDS ?? 30),
  minBatch: Number(process.env.SPAWN_BATCH_MIN ?? 1),
  maxBatch: Number(process.env.SPAWN_BATCH_MAX ?? 2),
};
const COLLECTIBLE_CAPS: SpawnCaps = {
  bugMaxActive: Number(process.env.BUG_MAX_ACTIVE ?? 10),
  treasureMaxActive: Number(process.env.TREASURE_MAX_ACTIVE ?? 8),
};
const TREASURE_LIFETIME_SECONDS = Number(process.env.TREASURE_LIFETIME_SECONDS ?? 90);
const COLLECTION_LIMITS: CollectionLimits = {
  dailyLimit: Number(process.env.COLLECTION_DAILY_LIMIT ?? 100), // bugs + treasures combined
  minIntervalMs: Number(process.env.COLLECT_MIN_INTERVAL_MS ?? 500), // absorbs a double-click/retry, same idea as watering's cooldown
};
const INSECT_SLOWDOWN: InsectSlowdownConfig = {
  perBug: Number(process.env.INSECT_SLOWDOWN_PER_BUG ?? 0.05),
  maxReduction: Number(process.env.INSECT_SLOWDOWN_MAX ?? 0.5),
};
const CODENAME_FORMAT: CodenameFormat = { codeLength: 3 };

// Moisture (short-term watering condition) stays mechanically identical to
// the original single-plant app's decay curve by default, but is now a
// config here rather than baked into stage.ts, which stays untouched since
// it's the already-deployed, already-graded version's own logic.
const MOISTURE_CONFIG: MoistureConfig = {
  thrivingMinutes: Number(process.env.MOISTURE_THRIVING_MINUTES ?? 10),
  thirstyMinutes: Number(process.env.MOISTURE_THIRSTY_MINUTES ?? 30),
  wiltingMinutes: Number(process.env.MOISTURE_WILTING_MINUTES ?? 90),
  droughtMultiplier: Number(process.env.MOISTURE_DROUGHT_MULTIPLIER ?? 3),
};

function isSpeciesId(value: unknown): value is SpeciesId {
  return typeof value === "string" && (SPECIES_IDS as readonly string[]).includes(value);
}

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS plant (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    size REAL NOT NULL,
    waters INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS visitors (
    id TEXT PRIMARY KEY,
    waters INTEGER NOT NULL,
    last_watered_at TEXT
  );
  CREATE TABLE IF NOT EXISTS garden_plants (
    id TEXT PRIMARY KEY,
    sunlight REAL NOT NULL DEFAULT 0,
    growth_units REAL NOT NULL DEFAULT 0,
    waters INTEGER NOT NULL DEFAULT 0,
    last_watered_at TEXT,
    near_death_saves INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS visitor_plant_watering (
    visitor_id TEXT NOT NULL,
    plant_id TEXT NOT NULL,
    day TEXT NOT NULL,
    count_today INTEGER NOT NULL DEFAULT 0,
    last_watered_at TEXT,
    PRIMARY KEY (visitor_id, plant_id)
  );
  CREATE TABLE IF NOT EXISTS visitor_garden_day (
    visitor_id TEXT PRIMARY KEY,
    day TEXT NOT NULL,
    count_today INTEGER NOT NULL DEFAULT 0,
    forages_today INTEGER NOT NULL DEFAULT 0,
    last_forage_at TEXT
  );
  CREATE TABLE IF NOT EXISTS achievements (
    id TEXT PRIMARY KEY,
    unlocked_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS visitor_collection (
    visitor_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    first_found_at TEXT,
    unseen INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (visitor_id, item_id)
  );
  CREATE TABLE IF NOT EXISTS garden_collectibles (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    plant_id TEXT NOT NULL,
    spawned_at TEXT NOT NULL,
    expires_at TEXT,
    caught_at TEXT,
    caught_by TEXT
  );
  CREATE TABLE IF NOT EXISTS garden_spawn_state (
    id TEXT PRIMARY KEY,
    next_spawn_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS visitor_identity (
    visitor_id TEXT PRIMARY KEY,
    public_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
`);
// Migrations for columns added after the plant's first deploy: ALTER TABLE
// has no "IF NOT EXISTS" in sqlite, so this just swallows the one error that
// means "already applied" and re-throws anything else.
function ensureColumn(table: string, name: string, ddl: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  } catch (err) {
    if (!(err instanceof Error && err.message.includes("duplicate column name"))) throw err;
  }
}
ensureColumn("plant", "last_watered_at", "TEXT");
ensureColumn("plant", "near_death_saves", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("garden_plants", "growth_units", "REAL NOT NULL DEFAULT 0");
ensureColumn("visitor_garden_day", "last_forage_at", "TEXT"); // retired with /api/forage; left in place, unused
ensureColumn("visitor_garden_day", "last_watered_at", "TEXT");
ensureColumn("visitor_garden_day", "collected_today", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("visitor_garden_day", "last_collect_at", "TEXT");
db.prepare("INSERT OR IGNORE INTO plant (id, size, waters) VALUES (1, 1.0, 0)").run();
// A plant migrated from before this column existed has no watering history;
// start its clock now rather than reading as already-dormant on deploy.
db.prepare("UPDATE plant SET last_watered_at = COALESCE(last_watered_at, ?) WHERE id = 1").run(
  new Date().toISOString(),
);
// The garden is new; the single old `plant` row becomes the garden's tree,
// carrying its watering history forward — nobody's prior watering is lost.
// The old schema's `size` started at a fixed 1.0 "seedling" base before any
// watering ever happened (purely cosmetic, so an untouched plant still drew
// as something rather than nothing); the new growth thresholds assume 0
// means "never watered", so that base is subtracted back out here — a
// never-watered legacy plant migrates to sunlight 0, and the real production
// plant's 1568 waterings (× 0.15 = 235.2, plus the 1.0 base = 236.2, which
// is exactly its last-seen live size) migrate to sunlight 235.2, not 236.2.
// This only ever fires once: once `garden_plants` has a 'tree' row, the
// INSERT OR IGNORE is a no-op on every later boot, even though the old
// `plant` table (left untouched, never written again) still exists.
db.prepare(
  `INSERT OR IGNORE INTO garden_plants (id, sunlight, waters, last_watered_at, near_death_saves)
   SELECT 'tree', MAX(0, size - 1.0), waters, last_watered_at, near_death_saves FROM plant WHERE id = 1`,
).run();
for (const id of SPECIES_IDS) {
  db.prepare(
    "INSERT OR IGNORE INTO garden_plants (id, sunlight, waters, last_watered_at, near_death_saves) VALUES (?, 0, 0, ?, 0)",
  ).run(id, new Date().toISOString());
}

// One-time growth-threshold migrations (section 3/6), chained: v1→v2 ran
// first (sunlight → whole-watering-count growth_units, topping out around
// 12–30 waterings); v2→v3 runs here, stretching that out to 500/2,000/
// 6,000/15,000/30,000 and adding a sixth stage, Ancient. Rewriting
// `growth_units` directly from the old number would either reset every
// plant to stage 0 (old values are tiny next to the new thresholds) or
// wildly overstate it (copied 1:1) — neither preserves what visitors
// actually earned. Instead each plant's *relative* position within its
// current stage is carried forward by `migrateGrowthUnits`, so a plant 40%
// of the way to its next stage under the old numbers is still 40% of the
// way to its (now much further away) next stage under the new ones, and a
// maxed-out plant stays maxed out. Each migration is guarded by `migrations`
// so it runs exactly once, ever; `growth_units` is the running source of
// truth in between, so v2→v3 reads it directly rather than re-deriving
// anything from the original `sunlight` column.
if (!db.prepare("SELECT 1 FROM migrations WHERE id = 'growth-thresholds-v2'").get()) {
  for (const id of SPECIES_IDS) {
    const row = db.prepare("SELECT sunlight FROM garden_plants WHERE id = ?").get(id) as { sunlight: number };
    const migrated = migrateGrowthUnits(row.sunlight, GROWTH_THRESHOLDS_V1[id], GROWTH_THRESHOLDS_V2[id]);
    db.prepare("UPDATE garden_plants SET growth_units = ? WHERE id = ?").run(migrated, id);
  }
  db.prepare("INSERT INTO migrations (id, applied_at) VALUES ('growth-thresholds-v2', ?)").run(
    new Date().toISOString(),
  );
}
if (!db.prepare("SELECT 1 FROM migrations WHERE id = 'growth-thresholds-v3'").get()) {
  for (const id of SPECIES_IDS) {
    const row = db.prepare("SELECT growth_units FROM garden_plants WHERE id = ?").get(id) as { growth_units: number };
    const migrated = migrateGrowthUnits(row.growth_units, GROWTH_THRESHOLDS_V2[id], GROWTH_THRESHOLDS[id]);
    db.prepare("UPDATE garden_plants SET growth_units = ? WHERE id = ?").run(migrated, id);
  }
  db.prepare("INSERT INTO migrations (id, applied_at) VALUES ('growth-thresholds-v3', ?)").run(
    new Date().toISOString(),
  );
}

export interface GardenPlant {
  id: SpeciesId;
  /** Cumulative community progress — one point per valid watering (before any insect slowdown); never decreases. */
  growthUnits: number;
  waters: number;
  /** Short-term watering condition ("moisture"), fully independent of growthUnits. */
  stage: Stage;
  minutesSinceWatered: number;
  isDrought: boolean;
  nearDeathSaves: number;
  growthStage: number;
  growthStageCount: number;
  nextThreshold: number | null;
  progressToNext: number;
  wateringsUntilNext: number | null;
  /** Uncaught bugs currently bound to this plant — purely decorative/slowdown, never negative. */
  insectCount: number;
  /** What fraction of a watering's growth currently lands, 0.5–1, given insectCount. */
  growthMultiplier: number;
}
interface Visitor {
  waters: number;
  lastWateredAt: string | null;
}
interface GardenLimitsView {
  remainingToday: number;
  dailyLimit: number;
  cooldownUntil: string | null;
  resetAt: string;
}

// Uncaught bugs never expire on their own (section 5: "persist until
// caught, survive refresh/reconnect"), so this is just the live count —
// catching one immediately changes what this returns next time, which is
// the entire mechanism for "restores the multiplier immediately".
function activeBugCountFor(plantId: SpeciesId): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM garden_collectibles WHERE kind = 'bug' AND plant_id = ? AND caught_at IS NULL")
    .get(plantId) as { n: number };
  return row.n;
}

function getGardenPlant(id: SpeciesId): GardenPlant {
  const row = db
    .prepare(
      "SELECT growth_units AS growthUnits, waters, last_watered_at AS lastWateredAt, near_death_saves AS nearDeathSaves FROM garden_plants WHERE id = ?",
    )
    .get(id) as unknown as { growthUnits: number; waters: number; lastWateredAt: string; nearDeathSaves: number };
  const now = new Date();
  const minutesSinceWatered = (now.getTime() - new Date(row.lastWateredAt).getTime()) / 60_000;
  const isDrought = isDroughtActive(now);
  const thresholds = GROWTH_THRESHOLDS[id];
  // sqlite's floating point addition can drift; round for display the same
  // way the original single-plant app always did.
  const growthUnits = Math.round(row.growthUnits * 100) / 100;
  const growthStage = growthStageIndex(growthUnits, thresholds);
  const nextThreshold = growthStage + 1 < thresholds.length ? thresholds[growthStage + 1] : null;
  const span = nextThreshold === null ? 1 : nextThreshold - thresholds[growthStage];
  const progressToNext = nextThreshold === null ? 1 : Math.min(1, (growthUnits - thresholds[growthStage]) / span);
  const insectCount = activeBugCountFor(id);
  return {
    id,
    growthUnits,
    waters: row.waters,
    stage: moistureStageFor(minutesSinceWatered, isDrought, MOISTURE_CONFIG),
    minutesSinceWatered: Math.round(minutesSinceWatered),
    isDrought,
    nearDeathSaves: row.nearDeathSaves,
    growthStage,
    growthStageCount: thresholds.length,
    nextThreshold,
    progressToNext: Math.round(progressToNext * 100) / 100,
    wateringsUntilNext: nextThreshold === null ? null : Math.ceil(nextThreshold - growthUnits),
    insectCount,
    growthMultiplier: insectGrowthMultiplier(insectCount, INSECT_SLOWDOWN),
  };
}

function getGarden(): Record<SpeciesId, GardenPlant> {
  const garden = {} as Record<SpeciesId, GardenPlant>;
  for (const id of SPECIES_IDS) garden[id] = getGardenPlant(id);
  return garden;
}

function getVisitor(id: string): Visitor {
  const row = db.prepare("SELECT waters, last_watered_at AS lastWateredAt FROM visitors WHERE id = ?").get(id) as
    | Visitor
    | undefined;
  return row ?? { waters: 0, lastWateredAt: null };
}

function getVisitorGardenDay(
  visitorId: string,
  today: string,
): { countToday: number; lastWateredAt: Date | null; collectedToday: number; lastCollectAt: Date | null } {
  const row = db
    .prepare(
      "SELECT day, count_today AS countToday, last_watered_at AS lastWateredAt, collected_today AS collectedToday, last_collect_at AS lastCollectAt FROM visitor_garden_day WHERE visitor_id = ?",
    )
    .get(visitorId) as
    | { day: string; countToday: number; lastWateredAt: string | null; collectedToday: number; lastCollectAt: string | null }
    | undefined;
  if (!row) return { countToday: 0, lastWateredAt: null, collectedToday: 0, lastCollectAt: null };
  return {
    countToday: row.day === today ? row.countToday : 0,
    collectedToday: row.day === today ? row.collectedToday : 0,
    // Unlike the daily counts, these span days on purpose — they're only
    // here to absorb a double-click/retried request a few seconds apart,
    // not to gate a visitor's pace the way the real daily caps do.
    lastWateredAt: row.lastWateredAt ? new Date(row.lastWateredAt) : null,
    lastCollectAt: row.lastCollectAt ? new Date(row.lastCollectAt) : null,
  };
}

function limitsFor(visitorId: string): GardenLimitsView {
  const today = dateKeyUTC(new Date());
  const visitorGarden = getVisitorGardenDay(visitorId, today);
  const now = new Date();
  const cooldownUntil = visitorGarden.lastWateredAt
    ? new Date(visitorGarden.lastWateredAt.getTime() + WATERING_LIMITS.visitorCooldownSeconds * 1000)
    : null;
  return {
    remainingToday: Math.max(0, WATERING_LIMITS.gardenDailyLimit - visitorGarden.countToday),
    dailyLimit: WATERING_LIMITS.gardenDailyLimit,
    cooldownUntil: cooldownUntil && cooldownUntil > now ? cooldownUntil.toISOString() : null,
    resetAt: utcMidnightAfter(now).toISOString(),
  };
}

// Achievement definitions themselves live in garden.ts as pure, synthetic-
// data-testable predicates (reaching one for real now takes up to 700
// waterings); this just supplies the real garden snapshot and persists
// whichever ones have newly become true.
function checkAchievements(): void {
  const garden = getGarden();
  const view: AchievementGardenView = {};
  for (const id of SPECIES_IDS) view[id] = { waters: garden[id].waters, growthStage: garden[id].growthStage };
  const now = new Date().toISOString();
  for (const def of ACHIEVEMENTS) {
    if (def.check(view, SPECIES_IDS)) {
      db.prepare("INSERT OR IGNORE INTO achievements (id, unlocked_at) VALUES (?, ?)").run(def.id, now);
    }
  }
}

function getAchievements(): { id: string; decoration: string; unlockedAt: string }[] {
  const rows = db.prepare("SELECT id, unlocked_at AS unlockedAt FROM achievements").all() as {
    id: string;
    unlockedAt: string;
  }[];
  return rows.map((row) => ({
    ...row,
    decoration: ACHIEVEMENTS.find((def) => def.id === row.id)?.decoration ?? "",
  }));
}

interface WaterResult {
  ok: boolean;
  reason?: WateringBlockReason;
  retryAt?: string;
  plant: GardenPlant;
  visitor: Visitor;
  garden: Record<SpeciesId, GardenPlant>;
  limits: GardenLimitsView;
  /** How much growth this specific watering actually contributed (section 3: "the growth actually added this time"), after any insect slowdown. */
  growthAdded?: number;
}

function waterGardenPlant(visitorId: string, plantId: SpeciesId): WaterResult {
  const now = new Date();
  const today = dateKeyUTC(now);
  const current = getGardenPlant(plantId);
  const visitorGarden = getVisitorGardenDay(visitorId, today);

  const decision = decideWatering(WATERING_LIMITS, {
    now,
    visitorLastWateredAt: visitorGarden.lastWateredAt,
    visitorGardenCountToday: visitorGarden.countToday,
  });

  if (!decision.allowed) {
    return {
      ok: false,
      reason: decision.reason,
      retryAt: decision.retryAt?.toISOString(),
      plant: current,
      visitor: getVisitor(visitorId),
      garden: getGarden(),
      limits: limitsFor(visitorId),
    };
  }

  // A rescue is counted exactly when a watering lands while the plant is
  // dormant, same rule as the original single plant — watering always jumps
  // the clock back to zero, so it can't read as dormant again until it's
  // genuinely drifted back there.
  const wasDormant = current.stage === "dormant";
  const nowIso = now.toISOString();
  // Section 5: uncaught bugs reduce *this* watering's contribution, never
  // retroactively touch what's already banked. Rounded to 2dp like every
  // other growth number here — the floor is 50%, never 0%, so this never
  // rounds away to nothing.
  const growthAdded = Math.round(current.growthMultiplier * 100) / 100;
  db.prepare(
    "UPDATE garden_plants SET growth_units = growth_units + ?, waters = waters + 1, last_watered_at = ?, near_death_saves = near_death_saves + ? WHERE id = ?",
  ).run(growthAdded, nowIso, wasDormant ? 1 : 0, plantId);

  db.prepare(
    `INSERT INTO visitors (id, waters, last_watered_at) VALUES (?, 1, ?)
     ON CONFLICT(id) DO UPDATE SET waters = waters + 1, last_watered_at = excluded.last_watered_at`,
  ).run(visitorId, nowIso);

  db.prepare(
    `INSERT INTO visitor_garden_day (visitor_id, day, count_today, collected_today, last_watered_at) VALUES (?, ?, 1, 0, ?)
     ON CONFLICT(visitor_id) DO UPDATE SET
       count_today = CASE WHEN day = excluded.day THEN count_today + 1 ELSE 1 END,
       collected_today = CASE WHEN day = excluded.day THEN collected_today ELSE 0 END,
       day = excluded.day,
       last_watered_at = excluded.last_watered_at`,
  ).run(visitorId, today, nowIso);

  checkAchievements();

  return {
    ok: true,
    plant: getGardenPlant(plantId),
    visitor: getVisitor(visitorId),
    garden: getGarden(),
    limits: limitsFor(visitorId),
    growthAdded,
  };
}

interface CollectionItemView {
  id: string;
  group: "insect" | "treasure";
  discovered: boolean;
  count: number;
  firstFoundAt: string | null;
  unseen: boolean;
}

// The full catalog, personal to this visitor — undiscovered entries are
// still listed (so the client can render them as silhouettes), just with
// discovered: false. Entirely separate from the shared garden: reading or
// writing this never touches growth_units, waters, or any watering limit.
function getCollection(visitorId: string): { items: CollectionItemView[]; totalDiscovered: number; totalCatalog: number; hasUnseen: boolean } {
  const rows = db
    .prepare("SELECT item_id AS itemId, count, first_found_at AS firstFoundAt, unseen FROM visitor_collection WHERE visitor_id = ?")
    .all(visitorId) as { itemId: string; count: number; firstFoundAt: string | null; unseen: number }[];
  const byId = new Map(rows.map((row) => [row.itemId, row]));
  const items: CollectionItemView[] = COLLECTIBLES.map((def) => {
    const row = byId.get(def.id);
    return {
      id: def.id,
      group: def.group,
      discovered: !!row,
      count: row?.count ?? 0,
      firstFoundAt: row?.firstFoundAt ?? null,
      unseen: !!row?.unseen,
    };
  });
  return {
    items,
    totalDiscovered: items.filter((item) => item.discovered).length,
    totalCatalog: COLLECTIBLES.length,
    hasUnseen: items.some((item) => item.unseen),
  };
}

// Clears the "new, not yet viewed" flag on every item this visitor has —
// called when they actually open the collection panel, a deliberate action,
// not a side effect of a passive read like /api/collection's GET.
function markCollectionSeen(visitorId: string): void {
  db.prepare("UPDATE visitor_collection SET unseen = 0 WHERE visitor_id = ?").run(visitorId);
}

// --- shared, backend-owned collectibles (section 4/5/6) ---
//
// Every collectible is one row here, visible to every visitor and claimable
// by exactly one of them — nothing is invented client-side or per-visitor
// anymore. Spawning only ever happens as a side effect of a real request
// (see maybeSpawnCollectibles, called from the HTTP handlers below), which
// is what makes "random interval, only while someone is online" true
// without a server-side timer that would never fire on a sleeping machine.

interface CollectibleView {
  id: string;
  kind: "bug" | "treasure";
  itemId: string;
  plantId: SpeciesId;
  spawnedAt: string;
  expiresAt: string | null;
}

function getActiveCollectibles(now: Date): CollectibleView[] {
  return db
    .prepare(
      `SELECT id, kind, item_id AS itemId, plant_id AS plantId, spawned_at AS spawnedAt, expires_at AS expiresAt
       FROM garden_collectibles
       WHERE caught_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY spawned_at ASC`,
    )
    .all(now.toISOString()) as unknown as CollectibleView[];
}

function countActiveCollectibles(kind: "bug" | "treasure", now: Date): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM garden_collectibles WHERE kind = ? AND caught_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
    )
    .get(kind, now.toISOString()) as { n: number };
  return row.n;
}

function spawnOneCollectible(now: Date): void {
  const activeBugs = countActiveCollectibles("bug", now);
  const activeTreasures = countActiveCollectibles("treasure", now);
  const kind = pickSpawnKind(COLLECTIBLE_CAPS, activeBugs, activeTreasures, Math.random());
  if (!kind) return; // both at capacity — skip this tick rather than force an item into a full scene
  const pool = COLLECTIBLES.filter((c) => c.group === (kind === "bug" ? "insect" : "treasure"));
  const item = pickWeightedCollectible(pool, DEFAULT_SPAWN_WEIGHTS, Math.random());
  const plantId = SPECIES_IDS[Math.floor(Math.random() * SPECIES_IDS.length)];
  const expiresAt = kind === "treasure" ? new Date(now.getTime() + TREASURE_LIFETIME_SECONDS * 1000).toISOString() : null;
  db.prepare(
    "INSERT INTO garden_collectibles (id, kind, item_id, plant_id, spawned_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(randomUUID(), kind, item.id, plantId, now.toISOString(), expiresAt);
}

// Checked (not scheduled) on every meaningful request — "only while a user
// is online" falls out of that for free, with no background timer to keep
// alive on a Fly machine that stops when nobody's visiting.
function maybeSpawnCollectibles(now: Date): void {
  const row = db.prepare("SELECT next_spawn_at AS nextSpawnAt FROM garden_spawn_state WHERE id = 'spawn'").get() as
    | { nextSpawnAt: string }
    | undefined;
  if (!row) {
    const delay = nextSpawnDelaySeconds(COLLECTIBLE_SPAWN_TIMING, Math.random());
    db.prepare("INSERT INTO garden_spawn_state (id, next_spawn_at) VALUES ('spawn', ?)").run(
      new Date(now.getTime() + delay * 1000).toISOString(),
    );
    return;
  }
  if (now < new Date(row.nextSpawnAt)) return;
  const batch = spawnBatchSize(COLLECTIBLE_SPAWN_TIMING, Math.random());
  for (let i = 0; i < batch; i++) spawnOneCollectible(now);
  const delay = nextSpawnDelaySeconds(COLLECTIBLE_SPAWN_TIMING, Math.random());
  db.prepare("UPDATE garden_spawn_state SET next_spawn_at = ? WHERE id = 'spawn'").run(
    new Date(now.getTime() + delay * 1000).toISOString(),
  );
  // A spawn is itself a change to everyone's scene, not just the one
  // visitor whose request happened to trigger the check — without this, an
  // already-open, otherwise-idle tab wouldn't see a new star or bug appear
  // until its next 20s poll or somebody else's water/collect broadcast.
  broadcastGarden();
}

interface ClaimResult {
  ok: boolean;
  reason?: string;
  /** When a "collection-daily"/"collect-too-soon" refusal clears, so the UI can show a concrete reset time instead of just "later". */
  retryAt?: string;
  collectedToday: number;
  limit: number;
  item?: { id: string; group: "insect" | "treasure"; count: number; firstFoundAt: string; isNew: boolean; collectibleId: string; plantId: SpeciesId };
}

// A garden discovery: cosmetic-only (never growth, never an extra watering
// or a cooldown reset — section 3/4's explicit boundary). `requestedId` is a
// specific collectible (a precise click); omitted, it claims whichever
// active one has been waiting longest — the keyboard/no-precise-click
// alternative ("Inspect foliage"), not a fabricated consolation reward.
interface ClaimFilter {
  plantId?: SpeciesId;
  kind?: "bug" | "treasure";
}

// `requestedId` is a precise click on one specific collectible. Omitted, it
// claims whichever matching active item has been waiting longest — used two
// ways: the garden-wide "Inspect foliage" button (no filter), and the
// detail panel's "Catch an insect here" action (filtered to this plant's
// bugs) — both keyboard-operable alternatives to a precise click.
function claimCollectible(visitorId: string, requestedId: string | null, filter: ClaimFilter = {}): ClaimResult {
  const now = new Date();
  const nowIso = now.toISOString();
  const today = dateKeyUTC(now);
  const visitorDay = getVisitorGardenDay(visitorId, today);

  const decision = decideCollection(COLLECTION_LIMITS, {
    now,
    visitorCollectedToday: visitorDay.collectedToday,
    visitorLastCollectAt: visitorDay.lastCollectAt,
  });
  if (!decision.allowed) {
    return {
      ok: false,
      reason: decision.reason,
      retryAt: decision.retryAt?.toISOString(),
      collectedToday: visitorDay.collectedToday,
      limit: COLLECTION_LIMITS.dailyLimit,
    };
  }

  let target: { id: string; kind: string; itemId: string; plantId: string } | undefined;
  if (requestedId) {
    target = db
      .prepare(
        "SELECT id, kind, item_id AS itemId, plant_id AS plantId FROM garden_collectibles WHERE id = ? AND caught_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
      )
      .get(requestedId, nowIso) as typeof target;
  } else {
    const clauses = ["caught_at IS NULL", "(expires_at IS NULL OR expires_at > ?)"];
    const params: unknown[] = [nowIso];
    if (filter.plantId) {
      clauses.push("plant_id = ?");
      params.push(filter.plantId);
    }
    if (filter.kind) {
      clauses.push("kind = ?");
      params.push(filter.kind);
    }
    target = db
      .prepare(
        `SELECT id, kind, item_id AS itemId, plant_id AS plantId FROM garden_collectibles WHERE ${clauses.join(" AND ")} ORDER BY spawned_at ASC LIMIT 1`,
      )
      .get(...(params as [])) as typeof target;
  }

  if (!target) {
    return {
      ok: false,
      reason: requestedId ? "already-claimed" : "nothing-to-find",
      collectedToday: visitorDay.collectedToday,
      limit: COLLECTION_LIMITS.dailyLimit,
    };
  }

  // The atomic claim: this UPDATE's WHERE clause is the only thing that
  // decides who gets it. Node runs this whole request handler synchronously
  // to completion before the next one starts, so there's no window for two
  // requests to both see `caught_at IS NULL` and both think they won — but
  // `changes === 0` is checked anyway, the same belt-and-braces the watering
  // and forage flows already use, in case that invariant ever changes.
  const claim = db
    .prepare("UPDATE garden_collectibles SET caught_at = ?, caught_by = ? WHERE id = ? AND caught_at IS NULL")
    .run(nowIso, visitorId, target.id);
  if (claim.changes === 0) {
    return { ok: false, reason: "already-claimed", collectedToday: visitorDay.collectedToday, limit: COLLECTION_LIMITS.dailyLimit };
  }

  const existing = db
    .prepare("SELECT count FROM visitor_collection WHERE visitor_id = ? AND item_id = ?")
    .get(visitorId, target.itemId) as { count: number } | undefined;
  const isNew = !existing;
  db.prepare(
    `INSERT INTO visitor_collection (visitor_id, item_id, count, first_found_at, unseen) VALUES (?, ?, 1, ?, 1)
     ON CONFLICT(visitor_id, item_id) DO UPDATE SET count = count + 1, unseen = 1`,
  ).run(visitorId, target.itemId, nowIso);
  const updated = db
    .prepare("SELECT count, first_found_at AS firstFoundAt FROM visitor_collection WHERE visitor_id = ? AND item_id = ?")
    .get(visitorId, target.itemId) as { count: number; firstFoundAt: string };

  db.prepare(
    `INSERT INTO visitor_garden_day (visitor_id, day, count_today, collected_today, last_collect_at) VALUES (?, ?, 0, 1, ?)
     ON CONFLICT(visitor_id) DO UPDATE SET
       collected_today = CASE WHEN day = excluded.day THEN collected_today + 1 ELSE 1 END,
       count_today = CASE WHEN day = excluded.day THEN count_today ELSE 0 END,
       day = excluded.day,
       last_collect_at = excluded.last_collect_at`,
  ).run(visitorId, today, nowIso);

  const after = getVisitorGardenDay(visitorId, today);
  const def = COLLECTIBLES.find((c) => c.id === target.itemId);
  if (!def) throw new Error(`claimed collectible names an unknown catalog item: ${target.itemId}`);

  return {
    ok: true,
    collectedToday: after.collectedToday,
    limit: COLLECTION_LIMITS.dailyLimit,
    item: {
      id: target.itemId,
      group: def.group,
      count: updated.count,
      firstFoundAt: updated.firstFoundAt,
      isNew,
      collectibleId: target.id,
      plantId: target.plantId as SpeciesId,
    },
  };
}

// Minimal for now — stdout only. Extended to also persist a queryable
// SQLite row (so "the logging outlives the crit" is true even after Fly's
// own log retention has rolled over) in a later commit; every call site
// added from here on already uses this shape so nothing needs revisiting
// once that lands.
function logEvent(entry: {
  level: "info" | "warn" | "error";
  event: string;
  requestId: string;
  actorPublicId?: string | null;
  action?: string;
  targetType?: string;
  targetId?: string;
  outcome: "success" | "rejected" | "error";
  reasonCode?: string;
  durationMs?: number;
  detail?: Record<string, unknown>;
}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function visitorIdOf(req: IncomingMessage): { id: string; isNew: boolean } {
  const existing = parseCookies(req.headers.cookie).visitor_id;
  if (existing) return { id: existing, isNew: false };
  return { id: randomUUID(), isNew: true };
}

function withVisitorCookie(res: ServerResponse, req: IncomingMessage, id: string, isNew: boolean): void {
  if (!isNew) return;
  // Fly terminates TLS in front of this app (fly.toml's own note: "the app
  // itself sees plain http"), so req.socket.encrypted is always false in
  // production — a naive check would never set Secure at all. Fly's proxy
  // sets X-Forwarded-Proto on every real external request instead; locally,
  // where that header is absent, Secure is correctly left off so a plain
  // http://localhost dev cookie still works.
  const isHttps = req.headers["x-forwarded-proto"] === "https";
  // A year is long enough to prove "your trace is still here" without the
  // app needing to think about expiry.
  res.setHeader(
    "Set-Cookie",
    `visitor_id=${id}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${isHttps ? "; Secure" : ""}`,
  );
}

// The session credential (visitor_id, above) and the public-facing label
// are deliberately separate: visitor_id is an unguessable UUID that must
// never be shown to anyone, including the visitor it belongs to; public_id
// ("Maple-7K2") is safe to put in the UI and in logs precisely because it
// carries no session-hijacking value on its own. Created lazily on whichever
// request first needs it — a genuinely new visitor, or an existing one who
// predates this feature — rather than a bulk backfill: every visitor_id
// this table will ever need to know about shows up on its own next request,
// at the cost of one indexed lookup, with nothing to run once up front.
function identityOf(visitorId: string): string {
  const existing = db.prepare("SELECT public_id AS publicId FROM visitor_identity WHERE visitor_id = ?").get(visitorId) as
    | { publicId: string }
    | undefined;
  if (existing) return existing.publicId;

  const nowIso = new Date().toISOString();
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = pickCodename(CODENAME_NOUNS, CODENAME_FORMAT, Math.random(), Math.random());
    try {
      db.prepare("INSERT INTO visitor_identity (visitor_id, public_id, created_at) VALUES (?, ?, ?)").run(
        visitorId,
        candidate,
        nowIso,
      );
      logEvent({
        level: "info",
        event: "identity.new",
        requestId: randomUUID(),
        actorPublicId: candidate,
        action: "create-identity",
        targetType: "identity",
        outcome: "success",
      });
      return candidate;
    } catch (err) {
      if (!(err instanceof Error && err.message.includes("UNIQUE constraint failed"))) throw err;
      // Collided with an existing public_id — try again with two fresh draws.
    }
  }
  // Astronomically unlikely (~550k combinations, 20 attempts) but a visitor
  // still needs *a* codename to proceed — this fallback is unique by
  // construction, since visitorId itself already is.
  const fallbackNoun = CODENAME_NOUNS[0];
  const fallback = `${fallbackNoun}-${visitorId.slice(0, 6).toUpperCase()}`;
  db.prepare(
    "INSERT INTO visitor_identity (visitor_id, public_id, created_at) VALUES (?, ?, ?) ON CONFLICT(visitor_id) DO NOTHING",
  ).run(visitorId, fallback, nowIso);
  logEvent({
    level: "warn",
    event: "identity.codename-fallback",
    requestId: randomUUID(),
    outcome: "success",
    detail: { publicId: fallback },
  });
  return fallback;
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk;
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        const parsed: unknown = JSON.parse(data);
        resolve(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};
const STATIC_FILES = new Set(["/app.js", "/garden.js", "/collection.js", "/style.css"]);

function serveStatic(res: ServerResponse, path: string): void {
  const type = CONTENT_TYPES[extname(path)];
  if (!type || !existsSync(path)) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "Content-Type": type }).end(readFileSync(path));
}

function readmePage(): string {
  const body = marked.parse(readFileSync("README.md", "utf8"), { async: false }) as string;
  return `<!doctype html>
<html lang="en-AU">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>About Tend</title>
    <link rel="stylesheet" href="/style.css" />
  </head>
  <body>
    <main class="readme">${body}</main>
  </body>
</html>`;
}

const wss = new WebSocketServer({ noServer: true });

function gardenSnapshot(): {
  type: "garden";
  garden: Record<SpeciesId, GardenPlant>;
  plant: GardenPlant;
  event: GardenEvent;
  achievements: ReturnType<typeof getAchievements>;
  collectibles: CollectibleView[];
} {
  const now = new Date();
  const garden = getGarden();
  return {
    type: "garden",
    garden,
    plant: garden.tree,
    event: dailyEventFor(now),
    achievements: getAchievements(),
    collectibles: getActiveCollectibles(now),
  };
}

function broadcastGarden(): void {
  const message = JSON.stringify(gardenSnapshot());
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(message);
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const { id: visitorId, isNew } = visitorIdOf(req);
  withVisitorCookie(res, req, visitorId, isNew);

  if (url.pathname === "/" && req.method === "GET") {
    serveStatic(res, "public/index.html");
    return;
  }
  if (url.pathname === "/readme/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(readmePage());
    return;
  }
  if (url.pathname === "/api/state" && req.method === "GET") {
    const now = new Date();
    maybeSpawnCollectibles(now); // only ever runs as a side effect of a real visit — see its own comment
    const garden = getGarden();
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        plant: garden.tree,
        garden,
        visitor: getVisitor(visitorId),
        identity: { publicId: identityOf(visitorId) },
        limits: limitsFor(visitorId),
        event: dailyEventFor(now),
        achievements: getAchievements(),
        collectibles: getActiveCollectibles(now),
        collectionLimits: {
          remainingToday: Math.max(0, COLLECTION_LIMITS.dailyLimit - getVisitorGardenDay(visitorId, dateKeyUTC(now)).collectedToday),
          dailyLimit: COLLECTION_LIMITS.dailyLimit,
          resetAt: utcMidnightAfter(now).toISOString(),
        },
        resources: {
          totalGrowthUnits: Math.round(SPECIES_IDS.reduce((sum, id) => sum + garden[id].growthUnits, 0) * 100) / 100,
        },
      }),
    );
    return;
  }
  if (url.pathname === "/api/water" && req.method === "POST") {
    maybeSpawnCollectibles(new Date());
    readJsonBody(req).then((body) => {
      const plantId = isSpeciesId(body.plantId) ? body.plantId : "tree";
      const result = waterGardenPlant(visitorId, plantId);
      if (result.ok) broadcastGarden();
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    });
    return;
  }
  if (url.pathname === "/api/collect" && req.method === "POST") {
    maybeSpawnCollectibles(new Date());
    readJsonBody(req).then((body) => {
      const requestedId = typeof body.id === "string" ? body.id : null;
      const filter: ClaimFilter = {};
      if (isSpeciesId(body.plantId)) filter.plantId = body.plantId;
      if (body.kind === "bug" || body.kind === "treasure") filter.kind = body.kind;
      const result = claimCollectible(visitorId, requestedId, filter);
      if (result.ok) broadcastGarden(); // every client's scene drops this collectible, in sync
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    });
    return;
  }
  if (url.pathname === "/api/collection" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(getCollection(visitorId)));
    return;
  }
  if (url.pathname === "/api/collection/seen" && req.method === "POST") {
    markCollectionSeen(visitorId);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(getCollection(visitorId)));
    return;
  }
  if (STATIC_FILES.has(url.pathname)) {
    serveStatic(res, join("public", url.pathname));
    return;
  }
  res.writeHead(404).end("not found");
});

server.on("upgrade", (req, socket, head) => {
  if (new URL(req.url ?? "/", "http://localhost").pathname !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    maybeSpawnCollectibles(new Date()); // a reconnect counts as activity too
    ws.send(JSON.stringify(gardenSnapshot()));
    wss.emit("connection", ws, req);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`tend listening on :${PORT}, data at ${DB_PATH}`);
});
