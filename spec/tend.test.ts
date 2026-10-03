import { expect, inject, it } from "vitest";

// Tend's own contract, on top of the fixed spec/invariants.test.ts: watering
// grows the shared plant for everyone, and a visitor's own trace survives.
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

it("watering grows the shared plant, visible immediately", async () => {
  const cookie = await freshVisitorCookie();
  const before = await fetch(new URL("/api/state", baseUrl), { headers: { cookie } }).then((r) => r.json());

  const watered = await fetch(new URL("/api/water", baseUrl), { method: "POST", headers: { cookie } }).then((r) =>
    r.json(),
  );

  expect(watered.plant.waters).toBe(before.plant.waters + 1);
  expect(watered.plant.size).toBeGreaterThan(before.plant.size);
  expect(watered.visitor.waters).toBe(1);
});

it("a visitor's own trace is still there on a later visit", async () => {
  const cookie = await freshVisitorCookie();
  await fetch(new URL("/api/water", baseUrl), { method: "POST", headers: { cookie } });
  await fetch(new URL("/api/water", baseUrl), { method: "POST", headers: { cookie } });

  const later = await fetch(new URL("/api/state", baseUrl), { headers: { cookie } }).then((r) => r.json());
  expect(later.visitor.waters).toBe(2);
});

it("a stranger who hasn't watered yet sees a clean slate, not someone else's trace", async () => {
  const cookie = await freshVisitorCookie();
  const state = await fetch(new URL("/api/state", baseUrl), { headers: { cookie } }).then((r) => r.json());
  expect(state.visitor.waters).toBe(0);
  expect(state.visitor.lastWateredAt).toBeNull();
});

it("watering always reads back as thriving immediately, drought or not", async () => {
  // The decay curve itself is covered by spec/stage-logic.test.ts against a
  // synthetic clock; this just checks the live app wires that logic in, by
  // checking the one instant every clock agrees on: right after a water.
  const cookie = await freshVisitorCookie();
  const watered = await fetch(new URL("/api/water", baseUrl), { method: "POST", headers: { cookie } }).then((r) =>
    r.json(),
  );

  expect(watered.plant.stage).toBe("thriving");
  expect(watered.plant.minutesSinceWatered).toBe(0);
  expect(typeof watered.plant.isDrought).toBe("boolean");
  expect(typeof watered.plant.nearDeathSaves).toBe("number");
});
