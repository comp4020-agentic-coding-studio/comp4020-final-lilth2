import { describe, expect, it } from "vitest";
import {
  ACHIEVEMENTS,
  COLLECTIBLES,
  DEFAULT_SPAWN_WEIGHTS,
  collectibleForForageIndex,
  dailyEventFor,
  dateKeyUTC,
  decideCollection,
  decideWatering,
  growthStageIndex,
  insectGrowthMultiplier,
  migrateGrowthUnits,
  moistureStageFor,
  nextSpawnDelaySeconds,
  pickSpawnKind,
  pickWeightedCollectible,
  spawnBatchSize,
  utcMidnightAfter,
  type AchievementGardenView,
  type CollectionLimits,
  type MoistureConfig,
  type WateringLimits,
} from "../garden.ts";

// Pure math, tested against synthetic inputs — no need to spin up the app or
// wait real hours, the same discipline spec/stage-logic.test.ts already uses
// for decay.

describe("growthStageIndex", () => {
  const thresholds = [0, 2, 5, 10, 20];

  it("starts at the first stage with no growth yet", () => {
    expect(growthStageIndex(0, thresholds)).toBe(0);
  });

  it("advances exactly at each threshold, never early", () => {
    expect(growthStageIndex(1.9, thresholds)).toBe(0);
    expect(growthStageIndex(2, thresholds)).toBe(1);
    expect(growthStageIndex(4.9, thresholds)).toBe(1);
    expect(growthStageIndex(5, thresholds)).toBe(2);
  });

  it("caps at the last stage however far growth overshoots it", () => {
    expect(growthStageIndex(1000, thresholds)).toBe(4);
  });
});

describe("dateKeyUTC / utcMidnightAfter", () => {
  it("keys by the UTC calendar date, not local time", () => {
    expect(dateKeyUTC(new Date("2026-03-05T23:59:59Z"))).toBe("2026-03-05");
    expect(dateKeyUTC(new Date("2026-03-06T00:00:00Z"))).toBe("2026-03-06");
  });

  it("the next midnight is always the following UTC day at 00:00", () => {
    expect(utcMidnightAfter(new Date("2026-03-05T14:00:00Z")).toISOString()).toBe("2026-03-06T00:00:00.000Z");
    expect(utcMidnightAfter(new Date("2026-03-05T23:59:59Z")).toISOString()).toBe("2026-03-06T00:00:00.000Z");
    // Crossing a year boundary is just another day, not a special case.
    expect(utcMidnightAfter(new Date("2026-12-31T10:00:00Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("dailyEventFor", () => {
  it("is the same for every moment within one UTC day", () => {
    const morning = dailyEventFor(new Date("2026-03-05T00:00:01Z"));
    const night = dailyEventFor(new Date("2026-03-05T23:59:59Z"));
    expect(morning).toBe(night);
  });

  it("can differ on a different UTC day", () => {
    // Not every pair of days differs (the rotation repeats), but adjacent
    // days in the rotation's non-repeating stretch do.
    expect(dailyEventFor(new Date("2026-01-01T12:00:00Z"))).not.toBe(dailyEventFor(new Date("2026-01-03T12:00:00Z")));
  });

  it("only ever returns one of the known event types", () => {
    for (let day = 1; day <= 14; day++) {
      const event = dailyEventFor(new Date(`2026-01-${String(day).padStart(2, "0")}T12:00:00Z`));
      expect(["none", "breeze", "rain", "butterfly"]).toContain(event);
    }
  });
});

describe("decideWatering", () => {
  const limits: WateringLimits = { gardenDailyLimit: 100, visitorCooldownSeconds: 3 };
  const now = new Date("2026-03-05T12:00:00.000Z");
  const baseline = {
    now,
    visitorLastWateredAt: null,
    visitorGardenCountToday: 0,
  };

  it("allows a visitor's first watering of a plant regardless of the plant's own vitality", () => {
    // Deliberately not plant-state-aware: whether this plant is thriving,
    // wilting, or just watered by someone else entirely is irrelevant here —
    // only this visitor's own history gates them. That's what keeps this
    // compatible with crit 9's "every concurrent watering composes" answer.
    const decision = decideWatering(limits, baseline);
    expect(decision.allowed).toBe(true);
  });

  it("blocks a second watering inside the short anti-double-click cooldown", () => {
    const decision = decideWatering(limits, {
      ...baseline,
      visitorLastWateredAt: new Date("2026-03-05T11:59:58.000Z"), // 2s ago, cooldown is 3s
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("cooldown");
    expect(decision.retryAt?.toISOString()).toBe("2026-03-05T12:00:01.000Z");
  });

  it("allows watering again once the cooldown has fully elapsed", () => {
    const decision = decideWatering(limits, {
      ...baseline,
      visitorLastWateredAt: new Date("2026-03-05T11:59:57.000Z"), // exactly 3s ago
    });
    expect(decision.allowed).toBe(true);
  });

  it("blocks once the garden-wide daily limit of 100 is reached, past the cooldown", () => {
    const decision = decideWatering(limits, {
      ...baseline,
      visitorGardenCountToday: 100,
      visitorLastWateredAt: new Date("2026-03-05T00:00:00.000Z"), // well past cooldown
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("garden-daily");
    expect(decision.retryAt?.toISOString()).toBe("2026-03-06T00:00:00.000Z");
  });

  it("checks reasons in a stable priority: cooldown before the daily cap", () => {
    // Both conditions true at once — cooldown should win, since it's the
    // more immediate fact (seconds away) versus the daily reset (hours away).
    const decision = decideWatering(limits, {
      ...baseline,
      visitorLastWateredAt: new Date("2026-03-05T11:59:59.000Z"),
      visitorGardenCountToday: 100,
    });
    expect(decision.reason).toBe("cooldown");
  });

  it("99 waterings today still allow a 100th; the 100th itself fills the daily allowance", () => {
    const allowed99th = decideWatering(limits, { ...baseline, visitorGardenCountToday: 99 });
    expect(allowed99th.allowed).toBe(true);
    const blocked101st = decideWatering(limits, { ...baseline, visitorGardenCountToday: 100 });
    expect(blocked101st.allowed).toBe(false);
  });
});

describe("decideCollection", () => {
  // Same shape as decideWatering's limits, but the real server-side config
  // for claimCollectible — exercised here with a synthetic clock instead of
  // real HTTP round trips, since driving the real 100/day allowance to its
  // boundary over the network would mean ~50 real seconds and ~100 real
  // spawns for no extra coverage (spec/garden.test.ts covers the wiring with
  // a handful of real collects instead).
  const limits: CollectionLimits = { dailyLimit: 100, minIntervalMs: 500 };
  const now = new Date("2026-03-05T12:00:00.000Z");
  const baseline = {
    now,
    visitorCollectedToday: 0,
    visitorLastCollectAt: null,
  };

  it("allows a visitor's first collect of the day", () => {
    const decision = decideCollection(limits, baseline);
    expect(decision.allowed).toBe(true);
  });

  it("blocks a second collect inside the anti-double-fire interval", () => {
    const decision = decideCollection(limits, {
      ...baseline,
      visitorLastCollectAt: new Date("2026-03-05T11:59:59.700Z"), // 300ms ago, interval is 500ms
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("collect-too-soon");
    expect(decision.retryAt?.toISOString()).toBe("2026-03-05T12:00:00.200Z");
  });

  it("allows collecting again once the interval has fully elapsed", () => {
    const decision = decideCollection(limits, {
      ...baseline,
      visitorLastCollectAt: new Date("2026-03-05T11:59:59.500Z"), // exactly 500ms ago
    });
    expect(decision.allowed).toBe(true);
  });

  it("blocks once the daily cap of 100 is reached, past the interval", () => {
    const decision = decideCollection(limits, {
      ...baseline,
      visitorCollectedToday: 100,
      visitorLastCollectAt: new Date("2026-03-05T00:00:00.000Z"),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("collection-daily");
    expect(decision.retryAt?.toISOString()).toBe("2026-03-06T00:00:00.000Z");
  });

  it("checks reasons in a stable priority: the daily cap before the anti-double-fire interval", () => {
    // The opposite priority from decideWatering on purpose: once the day's
    // allowance is spent, that's the more useful thing to tell someone —
    // "you're out for today" beats "wait half a second", which would be a
    // misleading thing to show someone who's actually capped.
    const decision = decideCollection(limits, {
      ...baseline,
      visitorCollectedToday: 100,
      visitorLastCollectAt: new Date("2026-03-05T11:59:59.700Z"),
    });
    expect(decision.reason).toBe("collection-daily");
  });

  it("99 collects today still allow a 100th; the 100th itself fills the daily allowance", () => {
    const allowed99th = decideCollection(limits, { ...baseline, visitorCollectedToday: 99 });
    expect(allowed99th.allowed).toBe(true);
    const blocked101st = decideCollection(limits, { ...baseline, visitorCollectedToday: 100 });
    expect(blocked101st.allowed).toBe(false);
  });
});

describe("migrateGrowthUnits", () => {
  const oldThresholds = [0, 0.3, 0.9, 2.1, 4.5];
  const newThresholds = [0, 50, 150, 350, 700];

  it("maps a never-watered plant straight to the new ladder's start", () => {
    expect(migrateGrowthUnits(0, oldThresholds, newThresholds)).toBe(0);
  });

  it("preserves exact relative progress within a stage, not just the stage index", () => {
    // Halfway from the old stage 1 threshold (0.3) to stage 2 (0.9) ...
    const halfway = 0.3 + (0.9 - 0.3) / 2;
    // ... lands exactly halfway from the new stage 1 (50) to stage 2 (150).
    // toBeCloseTo rather than toBe: floating-point division/multiplication
    // here can land a hair off 100 (e.g. 100.00000000000001).
    expect(migrateGrowthUnits(halfway, oldThresholds, newThresholds)).toBeCloseTo(100);
  });

  it("keeps a maxed-out plant maxed out, not regressed or overshot", () => {
    expect(migrateGrowthUnits(4.5, oldThresholds, newThresholds)).toBe(700);
    expect(migrateGrowthUnits(999, oldThresholds, newThresholds)).toBe(700);
  });

  it("never regresses a plant that had already reached a later stage", () => {
    // Just past the old stage-3 threshold (2.1) — should land at or above
    // the new stage 3 threshold (350), never back down near stage 0 or 1.
    const migrated = migrateGrowthUnits(2.15, oldThresholds, newThresholds);
    expect(migrated).toBeGreaterThanOrEqual(350);
  });
});

describe("moistureStageFor", () => {
  // Same default numbers as stage.ts, but a single droughtMultiplier applied
  // uniformly rather than stage.ts's own hand-picked {3, 10, 30} drought
  // table (whose thriving cutoff, 3, isn't exactly 10 ÷ 3) — so the normal
  // (non-drought) curve matches exactly, and the drought curve is close by
  // design, not bit-for-bit identical. That trade is what makes the drought
  // multiplier a single configurable number instead of three.
  const config: MoistureConfig = { thrivingMinutes: 10, thirstyMinutes: 30, wiltingMinutes: 90, droughtMultiplier: 3 };

  it("matches the original single-plant app's non-drought decay curve exactly", () => {
    expect(moistureStageFor(0, false, config)).toBe("thriving");
    expect(moistureStageFor(9, false, config)).toBe("thriving");
    expect(moistureStageFor(10, false, config)).toBe("thirsty");
    expect(moistureStageFor(29, false, config)).toBe("thirsty");
    expect(moistureStageFor(30, false, config)).toBe("wilting");
    expect(moistureStageFor(89, false, config)).toBe("wilting");
    expect(moistureStageFor(90, false, config)).toBe("dormant");
  });

  it("decays faster during a drought, by the configured multiplier", () => {
    // Each threshold is simply divided by the multiplier (10/3 ≈ 3.33 here),
    // not hand-picked per stage the way stage.ts's own drought table is —
    // so 4 minutes, not 3, is clearly past the "thriving" cutoff.
    expect(moistureStageFor(4, true, config)).toBe("thirsty");
    expect(moistureStageFor(10, true, config)).toBe("wilting");
    expect(moistureStageFor(30, true, config)).toBe("dormant");
  });

  it("is configurable independently of the default numbers", () => {
    const slow: MoistureConfig = { thrivingMinutes: 60, thirstyMinutes: 120, wiltingMinutes: 240, droughtMultiplier: 2 };
    expect(moistureStageFor(30, false, slow)).toBe("thriving");
    expect(moistureStageFor(90, false, slow)).toBe("thirsty");
  });
});

describe("ACHIEVEMENTS", () => {
  const speciesIds = ["tree", "bamboo", "shrub", "fern", "fruit"];
  const emptyGarden: AchievementGardenView = Object.fromEntries(
    speciesIds.map((id) => [id, { waters: 0, growthStage: 0 }]),
  );
  const find = (id: string) => {
    const def = ACHIEVEMENTS.find((a) => a.id === id);
    if (!def) throw new Error(`no achievement named ${id}`);
    return def;
  };

  it("three-species unlocks once at least three distinct plants have ever been watered, regardless of growth", () => {
    const def = find("three-species");
    expect(def.check(emptyGarden, speciesIds)).toBe(false);
    const two = { ...emptyGarden, tree: { waters: 5, growthStage: 0 }, bamboo: { waters: 1, growthStage: 0 } };
    expect(def.check(two, speciesIds)).toBe(false);
    const three = { ...two, fern: { waters: 1, growthStage: 0 } };
    expect(def.check(three, speciesIds)).toBe(true);
  });

  it("new-branch unlocks once the tree reaches growth stage 1 — synthetic, since that's 50 real waterings", () => {
    const def = find("new-branch");
    expect(def.check({ ...emptyGarden, tree: { waters: 10, growthStage: 0 } }, speciesIds)).toBe(false);
    expect(def.check({ ...emptyGarden, tree: { waters: 50, growthStage: 1 } }, speciesIds)).toBe(true);
  });

  it("first-bloom unlocks from any of three different species reaching their own bloom-worthy stage", () => {
    const def = find("first-bloom");
    expect(def.check(emptyGarden, speciesIds)).toBe(false);
    expect(def.check({ ...emptyGarden, shrub: { waters: 0, growthStage: 3 } }, speciesIds)).toBe(true);
    expect(def.check({ ...emptyGarden, fruit: { waters: 0, growthStage: 2 } }, speciesIds)).toBe(true);
    expect(def.check({ ...emptyGarden, tree: { waters: 0, growthStage: 4 } }, speciesIds)).toBe(true);
    // One short of any of the three thresholds — still locked.
    expect(def.check({ ...emptyGarden, tree: { waters: 0, growthStage: 3 } }, speciesIds)).toBe(false);
  });

  it("every achievement names a decoration, so an unlock always has something to show", () => {
    for (const def of ACHIEVEMENTS) {
      expect(def.decoration.length, `achievement "${def.id}" has no decoration`).toBeGreaterThan(0);
    }
  });
});

describe("collectibleForForageIndex", () => {
  it("a visitor's very first discovery is always the catalog's first entry", () => {
    expect(collectibleForForageIndex(0)).toEqual(COLLECTIBLES[0]);
  });

  it("cycles through every catalog entry exactly once before repeating", () => {
    const seen = new Set();
    for (let i = 0; i < COLLECTIBLES.length; i++) seen.add(collectibleForForageIndex(i).id);
    expect(seen.size).toBe(COLLECTIBLES.length);
    expect(collectibleForForageIndex(COLLECTIBLES.length)).toEqual(COLLECTIBLES[0]);
  });

  it("has six insects and six treasures", () => {
    expect(COLLECTIBLES.filter((c) => c.group === "insect")).toHaveLength(6);
    expect(COLLECTIBLES.filter((c) => c.group === "treasure")).toHaveLength(6);
  });

  it("every catalog id is unique", () => {
    expect(new Set(COLLECTIBLES.map((c) => c.id)).size).toBe(COLLECTIBLES.length);
  });
});

describe("pickWeightedCollectible", () => {
  const pool = COLLECTIBLES.filter((c) => c.group === "insect"); // ladybug(2), butterfly(2), bee(1.5), snail(1), ant(1), beetle(1) — total 8.5

  it("picks the first item for randomValue 0", () => {
    expect(pickWeightedCollectible(pool, DEFAULT_SPAWN_WEIGHTS, 0).id).toBe("ladybug");
  });

  it("picks higher-weighted items over a wider share of the random range", () => {
    // ladybug spans [0, 2/8.5); just past that boundary should land on butterfly.
    const justInsideLadybug = pickWeightedCollectible(pool, DEFAULT_SPAWN_WEIGHTS, 1.9 / 8.5);
    const justPastLadybug = pickWeightedCollectible(pool, DEFAULT_SPAWN_WEIGHTS, 2.1 / 8.5);
    expect(justInsideLadybug.id).toBe("ladybug");
    expect(justPastLadybug.id).toBe("butterfly");
  });

  it("always returns an item from the given pool, never a filtered-out kind", () => {
    const treasures = COLLECTIBLES.filter((c) => c.group === "treasure");
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
      expect(treasures.map((t) => t.id)).toContain(pickWeightedCollectible(treasures, DEFAULT_SPAWN_WEIGHTS, r).id);
    }
  });
});

describe("pickSpawnKind", () => {
  const caps = { bugMaxActive: 10, treasureMaxActive: 8 };

  it("forces treasure once bugs are at their cap", () => {
    expect(pickSpawnKind(caps, 10, 0, 0.1)).toBe("treasure");
    expect(pickSpawnKind(caps, 10, 0, 0.9)).toBe("treasure");
  });

  it("forces bug once treasures are at their cap", () => {
    expect(pickSpawnKind(caps, 0, 8, 0.1)).toBe("bug");
    expect(pickSpawnKind(caps, 0, 8, 0.9)).toBe("bug");
  });

  it("returns null — skip spawning — once both kinds are full", () => {
    expect(pickSpawnKind(caps, 10, 8, 0.5)).toBeNull();
  });

  it("splits roughly evenly between the two kinds when both have room", () => {
    expect(pickSpawnKind(caps, 0, 0, 0.1)).toBe("bug");
    expect(pickSpawnKind(caps, 0, 0, 0.9)).toBe("treasure");
  });
});

describe("spawn timing", () => {
  const timing = { minSeconds: 15, maxSeconds: 30, minBatch: 1, maxBatch: 2 };

  it("the next spawn delay is always within the configured 15-30s window", () => {
    expect(nextSpawnDelaySeconds(timing, 0)).toBe(15);
    expect(nextSpawnDelaySeconds(timing, 1)).toBe(30);
    expect(nextSpawnDelaySeconds(timing, 0.5)).toBe(22.5);
  });

  it("the batch size is always 1 or 2, per the configured range", () => {
    expect(spawnBatchSize(timing, 0)).toBe(1);
    expect(spawnBatchSize(timing, 0.99)).toBe(2);
  });
});

describe("insectGrowthMultiplier", () => {
  const config = { perBug: 0.05, maxReduction: 0.5 };

  it("is 1 (no slowdown) with no bugs", () => {
    expect(insectGrowthMultiplier(0, config)).toBe(1);
  });

  it("drops 5% per bug, with full decimal precision — never silently rounds to 0", () => {
    expect(insectGrowthMultiplier(1, config)).toBeCloseTo(0.95);
    expect(insectGrowthMultiplier(3, config)).toBeCloseTo(0.85);
    expect(insectGrowthMultiplier(3, config) * 1).not.toBe(0); // a watering under 3 bugs still adds something
  });

  it("floors at 50% off, however many bugs pile up", () => {
    expect(insectGrowthMultiplier(10, config)).toBe(0.5);
    expect(insectGrowthMultiplier(1000, config)).toBe(0.5);
  });
});
