import { expect, inject, it } from "vitest";

// Tend's own contract, on top of the fixed spec/invariants.test.ts: watering
// grows the shared garden for everyone, and a visitor's own trace survives.
// This file waters only "tree" — spec/live.test.ts keeps to "bamboo" and
// "shrub", spec/garden.test.ts to "fern" and "fruit" — since a plant that's
// already thriving can't be watered again by anyone (section 8's rule), so
// two files racing to water the *same* plant would fail each other, not
// just the plant. tree gets exactly one successful watering in this file;
// everything after it only reads state, on purpose.
const baseUrl = inject("baseUrl");

async function freshVisitorCookie(): Promise<string> {
  // A request with no Cookie header is what a genuine stranger sends; the
  // server replies with a fresh visitor_id, which is what this app means by
  // "distinguishable users".
  const res = await fetch(new URL("/api/state", baseUrl));
  const cookie = res.headers.get("set-cookie");
  expect(cookie, "expected a visitor_id cookie on a first visit").toBeTruthy();
  return cookie!.split(";")[0];
}

let waterer: string;

it("watering grows the shared tree, visible immediately, for the visitor who did it", async () => {
  waterer = await freshVisitorCookie();
  const before = await fetch(new URL("/api/state", baseUrl), { headers: { cookie: waterer } }).then((r) => r.json());

  const res = await fetch(new URL("/api/water", baseUrl), {
    method: "POST",
    headers: { cookie: waterer, "Content-Type": "application/json" },
    body: JSON.stringify({ plantId: "tree" }),
  });
  const watered = await res.json();

  expect(watered.ok).toBe(true);
  expect(watered.plant.waters).toBe(before.garden.tree.waters + 1);
  expect(watered.plant.growthUnits).toBeGreaterThan(before.garden.tree.growthUnits);
  expect(watered.visitor.waters).toBe(before.visitor.waters + 1);
  expect(watered.plant.stage).toBe("thriving");
  expect(watered.plant.minutesSinceWatered).toBe(0);
  expect(typeof watered.plant.isDrought).toBe("boolean");
  expect(typeof watered.plant.nearDeathSaves).toBe("number");
});

it("that visitor's own trace is still there on a later visit, with no further watering needed", async () => {
  const state = await fetch(new URL("/api/state", baseUrl), { headers: { cookie: waterer } }).then((r) => r.json());
  expect(state.visitor.waters).toBeGreaterThanOrEqual(1);
  expect(state.visitor.lastWateredAt).not.toBeNull();
});

it("a stranger who hasn't watered yet sees a clean slate, not someone else's trace", async () => {
  const cookie = await freshVisitorCookie();
  const state = await fetch(new URL("/api/state", baseUrl), { headers: { cookie } }).then((r) => r.json());
  expect(state.visitor.waters).toBe(0);
  expect(state.visitor.lastWateredAt).toBeNull();
});

it("the tree a stranger sees is the same shared tree everyone else just grew", async () => {
  const cookie = await freshVisitorCookie();
  const state = await fetch(new URL("/api/state", baseUrl), { headers: { cookie } }).then((r) => r.json());
  expect(state.garden.tree.waters).toBeGreaterThanOrEqual(1);
  // `plant` is the legacy top-level field older clients/tests read; it must
  // always mirror the garden's tree, not some separate copy.
  expect(state.plant.waters).toBe(state.garden.tree.waters);
  expect(state.plant.growthUnits).toBe(state.garden.tree.growthUnits);
});
