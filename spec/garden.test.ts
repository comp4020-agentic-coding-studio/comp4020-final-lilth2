import { expect, inject, it } from "vitest";

// Section 8's watering-limit rules, checked against the running app. This
// file waters only "fern" and "fruit" — spec/tend.test.ts keeps to "tree",
// spec/live.test.ts to "bamboo" and "shrub" — purely so the three files'
// daily-count assertions don't interfere with each other. The limits
// themselves are per-visitor, never a lock on the plant (see garden.ts's
// decideWatering and PROCESS.md's crit 9 ADR) — a plant being thriving,
// wilting, or just watered by somebody else never blocks a different
// visitor. The daily-count and cooldown *math* is covered with synthetic
// clocks in spec/garden-logic.test.ts; this file covers what only a real
// server can show — shared state across visitors, idempotency under real
// concurrency, and that a refusal has zero side effects.
const SPECIES = ["tree", "bamboo", "shrub", "fern", "fruit"] as const;
const baseUrl = inject("baseUrl");

async function freshVisitorCookie(): Promise<string> {
  const res = await fetch(new URL("/api/state", baseUrl));
  const cookie = res.headers.get("set-cookie");
  expect(cookie, "expected a visitor_id cookie on a first visit").toBeTruthy();
  return cookie!.split(";")[0];
}

async function water(cookie: string, plantId: string) {
  const res = await fetch(new URL("/api/water", baseUrl), {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ plantId }),
  });
  return res.json();
}

async function state(cookie: string) {
  return fetch(new URL("/api/state", baseUrl), { headers: { cookie } }).then((r) => r.json());
}

it("reading /api/state is side-effect-free — a refresh or another open tab never changes counts", async () => {
  const cookie = await freshVisitorCookie();
  const first = await state(cookie);
  const second = await state(cookie);
  const third = await state(cookie);
  expect(second.garden.fern.waters).toBe(first.garden.fern.waters);
  expect(third.visitor.waters).toBe(first.visitor.waters);
});

it("a successful watering grows only the plant it targeted", async () => {
  const cookie = await freshVisitorCookie();
  const before = await state(cookie);

  const result = await water(cookie, "fern");

  expect(result.ok).toBe(true);
  expect(result.plant.waters).toBe(before.garden.fern.waters + 1);
  expect(result.plant.growthUnits).toBeGreaterThan(before.garden.fern.growthUnits);
  expect(result.garden.bamboo.waters).toBe(before.garden.bamboo.waters);
  expect(result.garden.tree.waters).toBe(before.garden.tree.waters);
});

it("a plant that's already thriving can still be watered by a different visitor", async () => {
  // fern is thriving right now, from the watering just above — the limits
  // are per-visitor, not a lock on the plant, so a visitor who hasn't used
  // any of their own allowance yet is never blocked by someone else's
  // recent care. This is crit 9's "concurrent waterings compose" answer,
  // carried forward into the garden unchanged.
  const otherVisitor = await freshVisitorCookie();
  const before = await state(otherVisitor);
  const result = await water(otherVisitor, "fern");
  expect(result.ok).toBe(true);
  expect(result.plant.waters).toBe(before.garden.fern.waters + 1);
});

it("a refused watering charges nothing — no resource, no count, no growth", async () => {
  const cookie = await freshVisitorCookie();
  await water(cookie, "fern"); // first watering succeeds
  const before = await state(cookie);

  const repeat = await water(cookie, "fern"); // same visitor, immediately again — inside their own cooldown
  expect(repeat.ok).toBe(false);
  expect(repeat.reason).toBe("cooldown");

  const after = await state(cookie);
  expect(after.limits.remainingToday).toBe(before.limits.remainingToday);
  expect(after.garden.fern.waters).toBe(before.garden.fern.waters);
  expect(after.garden.fern.growthUnits).toBe(before.garden.fern.growthUnits);
});

it("firing the same watering twice at once only ever lets one through (double-click, or two tabs)", async () => {
  const cookie = await freshVisitorCookie();
  const [a, b] = await Promise.all([water(cookie, "fruit"), water(cookie, "fruit")]);
  const successes = [a, b].filter((r) => r.ok);
  const failures = [a, b].filter((r) => !r.ok);

  expect(successes).toHaveLength(1);
  expect(failures).toHaveLength(1);
  expect(failures[0].reason).toBe("cooldown");
  expect(successes[0].plant.waters).toBe(1);
});

// Collectibles are shared and backend-spawned (section 4/5/6), not generated
// on demand per visitor the way the old per-visitor "forage" roll was — so
// these tests wait for the live spawn cycle to produce something claimable,
// the same way a real browser would, instead of assuming one is always
// sitting there. The default spawn delay is 15-30s (see server.ts's
// COLLECTIBLE_SPAWN_TIMING), so this waits well past that rather than
// assuming the app under test has SPAWN_MIN_SECONDS/SPAWN_MAX_SECONDS tuned
// down — it's slower this way, but it passes against the real deployed
// config too, not just a fast local override. Every `it` that calls this
// carries a matching extended timeout (see each call site below).
async function waitForCollectible(
  cookie: string,
  filter: { plantId?: string; kind?: string } = {},
): Promise<{ id: string; kind: string; plantId: string }> {
  for (let attempt = 0; attempt < 350; attempt++) {
    const data = await state(cookie);
    const match = (data.collectibles as Array<{ id: string; kind: string; plantId: string }>).find(
      (c) => (!filter.plantId || c.plantId === filter.plantId) && (!filter.kind || c.kind === filter.kind),
    );
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    "no matching collectible spawned in time — check the running app's SPAWN_MIN_SECONDS/SPAWN_MAX_SECONDS",
  );
}

async function collect(cookie: string, body: Record<string, unknown> = {}) {
  const res = await fetch(new URL("/api/collect", baseUrl), {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

it(
  "successful collects accumulate in this visitor's own daily count, tracked server-side",
  async () => {
    const cookie = await freshVisitorCookie();

    const first = await waitForCollectible(cookie);
    const firstResult = await collect(cookie, { id: first.id });
    expect(firstResult.ok).toBe(true);
    expect(firstResult.collectedToday).toBe(1);
    // The real per-day allowance is large (100, see garden.ts's
    // decideCollection) on purpose, so it isn't practical to exhaust it over
    // real HTTP in a fast test; the exact boundary (Nth allowed, N+1th
    // refused) is covered with a synthetic clock in
    // spec/garden-logic.test.ts's "decideCollection" tests instead.
    expect(firstResult.limit).toBeGreaterThan(1);

    await new Promise((resolve) => setTimeout(resolve, 600)); // past the anti-double-fire guard
    const second = await waitForCollectible(cookie);
    const secondResult = await collect(cookie, { id: second.id });
    expect(secondResult.ok).toBe(true);
    expect(secondResult.collectedToday).toBe(2);
    expect(secondResult.limit).toBe(firstResult.limit);

    // A refused collect (too soon after the one above) never creeps the count.
    const tooSoon = await collect(cookie, { id: second.id });
    expect(tooSoon.ok).toBe(false);
    expect(tooSoon.reason).toBe("collect-too-soon");
    expect(tooSoon.collectedToday).toBe(2);
  },
  70_000, // waits for two real spawns, each up to ~30s under the default spawn timing
);

it("the three-species achievement tracks the shared garden's total, not any one visitor's actions", async () => {
  const cookie = await freshVisitorCookie();
  const current = await state(cookie);
  const touchedSpecies = SPECIES.filter((id) => current.garden[id].waters > 0).length;
  const unlocked = current.achievements.some((a: { id: string }) => a.id === "three-species");
  // This asserts the invariant rather than a fixed count, so it holds
  // whether this file runs alone or alongside spec/tend.test.ts and
  // spec/live.test.ts, which between them usually reach three species first.
  expect(unlocked).toBe(touchedSpecies >= 3);
});

// --- personal collection: separate from the shared garden on purpose, so
// these tests never touch "fern"/"fruit" growth and don't care who else is
// watering what. ---

async function collection(cookie: string) {
  return fetch(new URL("/api/collection", baseUrl), { headers: { cookie } }).then((r) => r.json());
}

it(
  "a successful collect is added to the visitor's own collection, never to shared garden growth",
  async () => {
    const cookie = await freshVisitorCookie();
    const gardenBefore = await state(cookie);

    const target = await waitForCollectible(cookie);
    const result = await collect(cookie, { id: target.id });
    expect(result.ok).toBe(true);
    expect(result.item.count).toBe(1);
    expect(result.item.isNew).toBe(true);

    const found = await collection(cookie);
    const item = found.items.find((i: { id: string }) => i.id === result.item.id);
    expect(item.discovered).toBe(true);
    expect(item.count).toBe(1);
    expect(item.firstFoundAt).toBe(result.item.firstFoundAt);

    const gardenAfter = await state(cookie);
    for (const id of SPECIES) {
      expect(gardenAfter.garden[id].growthUnits).toBe(gardenBefore.garden[id].growthUnits);
      expect(gardenAfter.garden[id].waters).toBe(gardenBefore.garden[id].waters);
    }
    expect(gardenAfter.limits).toEqual(gardenBefore.limits);
  },
  40_000,
);

it("undiscovered items are listed as not-yet-discovered, not omitted", async () => {
  const cookie = await freshVisitorCookie();
  const data = await collection(cookie);
  expect(data.totalCatalog).toBe(12);
  expect(data.totalDiscovered).toBe(0);
  for (const item of data.items) {
    expect(item.discovered).toBe(false);
    expect(item.count).toBe(0);
    expect(item.firstFoundAt).toBeNull();
  }
});

it(
  "collections are personal — a different visitor never sees someone else's discoveries",
  async () => {
    const cookieA = await freshVisitorCookie();
    const target = await waitForCollectible(cookieA);
    const result = await collect(cookieA, { id: target.id });
    expect(result.ok).toBe(true);

    const cookieB = await freshVisitorCookie();
    const collectionB = await collection(cookieB);
    expect(collectionB.totalDiscovered).toBe(0);
  },
  40_000,
);

it(
  "opening the collection (GET) is side-effect-free; only the explicit /seen call clears the new flag",
  async () => {
    const cookie = await freshVisitorCookie();
    const target = await waitForCollectible(cookie);
    const result = await collect(cookie, { id: target.id });
    expect(result.ok).toBe(true);

    const firstRead = await collection(cookie);
    const secondRead = await collection(cookie);
    expect(secondRead.hasUnseen).toBe(firstRead.hasUnseen);
    expect(secondRead.hasUnseen).toBe(true);

    await fetch(new URL("/api/collection/seen", baseUrl), { method: "POST", headers: { cookie } });
    const afterSeen = await collection(cookie);
    expect(afterSeen.hasUnseen).toBe(false);
  },
  40_000,
);

it(
  "firing two collect requests at once only lets one through, so a double-click can't claim two discoveries",
  async () => {
    // Same visitor, same instant: the anti-double-fire cooldown (checked
    // before the claim itself) is what catches this, same reason a
    // double-fired watering is refused.
    const cookie = await freshVisitorCookie();
    const target = await waitForCollectible(cookie);
    const [a, b] = await Promise.all([collect(cookie, { id: target.id }), collect(cookie, { id: target.id })]);
    const successes = [a, b].filter((r) => r.ok);
    const failures = [a, b].filter((r) => !r.ok);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toBe("collect-too-soon");
    expect(successes[0].collectedToday).toBe(1);
  },
  40_000,
);

it(
  "two different visitors racing for the same item never both get rewarded — only one claim wins",
  async () => {
    // Different visitors have independent cooldowns, so this is the test
    // that actually exercises the exclusive-claim UPDATE ... WHERE
    // caught_at IS NULL guarantee, not just the single-visitor double-click
    // guard above.
    const cookieA = await freshVisitorCookie();
    const cookieB = await freshVisitorCookie();
    const target = await waitForCollectible(cookieA);
    const [a, b] = await Promise.all([collect(cookieA, { id: target.id }), collect(cookieB, { id: target.id })]);
    const successes = [a, b].filter((r) => r.ok);
    const failures = [a, b].filter((r) => !r.ok);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toBe("already-claimed");
    expect(successes[0].item.collectibleId).toBe(target.id);
  },
  40_000,
);
