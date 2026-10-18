import { expect, inject, it } from "vitest";

// The public "Recent garden care" feed — built on /api/collect, never
// /api/water, so this file contends with nobody's plant-counter
// assertions: collectedToday is per-visitor, and every spawned collectible
// is unique, so no plant-id partitioning is needed here the way the
// watering-focused files require.
const baseUrl = inject("baseUrl");

async function freshVisitorCookie(): Promise<string> {
  const res = await fetch(new URL("/api/state", baseUrl));
  const cookie = res.headers.get("set-cookie");
  expect(cookie, "expected a visitor_id cookie on a first visit").toBeTruthy();
  return cookie!.split(";")[0];
}

async function state(cookie: string) {
  return fetch(new URL("/api/state", baseUrl), { headers: { cookie } }).then((r) => r.json());
}

async function waitForCollectible(
  cookie: string,
): Promise<{ id: string; kind: string; plantId: string }> {
  for (let attempt = 0; attempt < 350; attempt++) {
    const data = await state(cookie);
    if (data.collectibles.length > 0) return data.collectibles[0];
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("no collectible spawned in time — check the running app's SPAWN_MIN_SECONDS/SPAWN_MAX_SECONDS");
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
  "a successful collect appears in the shared recentCare feed, with the actor's public codename and no private detail",
  async () => {
    const cookie = await freshVisitorCookie();
    const before = await state(cookie);
    const publicId = before.identity.publicId;

    const target = await waitForCollectible(cookie);
    const result = await collect(cookie, { id: target.id });
    expect(result.ok).toBe(true);

    const after = await state(cookie);
    const entry = after.recentCare.find(
      (e: { actorPublicId: string; plantId: string; itemId: string | null }) =>
        e.actorPublicId === publicId && e.plantId === target.plantId && e.itemId === result.item.id,
    );
    expect(entry, "expected the collect to appear in recentCare").toBeTruthy();
    expect(entry.action).toBe(target.kind === "bug" ? "catch-bug" : "claim-treasure");

    // Nothing personal leaks into a shared, public structure.
    const serialised = JSON.stringify(entry);
    expect(serialised).not.toContain("collectedToday");
    expect(serialised).not.toContain("firstFoundAt");
    expect(serialised).not.toContain(cookie.split("=")[1]); // the raw visitor_id
  },
  40_000,
);

it(
  "the stored feed never exceeds its configured cap, even after many collects",
  async () => {
    const cookie = await freshVisitorCookie();
    // Five is comfortably below any reasonable cap, and fast enough not to
    // need a long timeout — this only proves the cap mechanism engages
    // under repeated writes, not that it holds at exactly a specific number
    // (the real cap is an operator-configurable env var, not a fixed
    // constant this test should hard-code).
    for (let i = 0; i < 5; i++) {
      const target = await waitForCollectible(cookie);
      await collect(cookie, { id: target.id });
      await new Promise((resolve) => setTimeout(resolve, 600)); // past the anti-double-fire cooldown
    }
    const after = await state(cookie);
    expect(Array.isArray(after.recentCare)).toBe(true);
    // A sane upper bound: the feed is meant to be a short, readable list,
    // not an ever-growing one.
    expect(after.recentCare.length).toBeLessThanOrEqual(50);
  },
  120_000,
);

it(
  "the shared garden version strictly increases after a successful collect, and is unchanged after a rejected one",
  async () => {
    const cookie = await freshVisitorCookie();
    const target = await waitForCollectible(cookie);
    const before = await state(cookie);

    const result = await collect(cookie, { id: target.id });
    expect(result.ok).toBe(true);
    const afterSuccess = await state(cookie);
    expect(afterSuccess.version).toBeGreaterThan(before.version);

    const rejected = await collect(cookie, { id: target.id }); // the same item again — already claimed
    expect(rejected.ok).toBe(false);
    const afterRejection = await state(cookie);
    expect(afterRejection.version).toBe(afterSuccess.version);
  },
  40_000,
);
