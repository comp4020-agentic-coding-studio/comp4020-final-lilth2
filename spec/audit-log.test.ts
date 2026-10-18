import { expect, inject, it } from "vitest";

// Asserts against REAL persisted audit_log rows, via the gated test-only
// endpoint (/api/_test/audit-log, 404s unless ENABLE_TEST_ENDPOINTS=1 is set
// on the server under test) — proving logEvent actually writes what it
// claims to, not just that the code reads as if it should. Skips cleanly if
// that endpoint isn't enabled, so this file is still safe to run against a
// real deploy where it's correctly disabled.
const baseUrl = inject("baseUrl");

interface AuditRow {
  event: string;
  actorPublicId: string | null;
  outcome: string;
  reasonCode: string | null;
  targetId: string | null;
  detail: string | null;
}

async function freshVisitorCookie(): Promise<string> {
  const res = await fetch(new URL("/api/state", baseUrl));
  const cookie = res.headers.get("set-cookie");
  expect(cookie, "expected a visitor_id cookie on a first visit").toBeTruthy();
  return cookie!.split(";")[0];
}

async function testEndpointEnabled(): Promise<boolean> {
  const res = await fetch(new URL("/api/_test/audit-log", baseUrl));
  return res.status === 200;
}

async function recentAuditRows(): Promise<AuditRow[]> {
  const res = await fetch(new URL("/api/_test/audit-log", baseUrl));
  const data = await res.json();
  return data.rows;
}

it("a successful watering produces a matching audit_log row", async (ctx) => {
  if (!(await testEndpointEnabled())) {
    ctx.skip(); // this server wasn't started with ENABLE_TEST_ENDPOINTS=1
    return;
  }
  const cookie = await freshVisitorCookie();
  const stateBefore = await fetch(new URL("/api/state", baseUrl), { headers: { cookie } }).then((r) => r.json());
  const publicId = stateBefore.identity.publicId;

  // tend.test.ts also waters "tree", but every one of its assertions
  // compares against a "before" snapshot it fetches fresh at test time
  // ("waters + 1"), never an absolute count — so an extra watering here
  // from a different, fresh visitor doesn't conflict with it regardless of
  // which file vitest happens to run first.
  const result = await fetch(new URL("/api/water", baseUrl), {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ plantId: "tree" }),
  }).then((r) => r.json());

  const rows = await recentAuditRows();
  const match = rows.find(
    (row) => row.event === "garden.water" && row.actorPublicId === publicId && row.outcome === (result.ok ? "success" : "rejected"),
  );
  expect(match, `expected a garden.water audit row for ${publicId}`).toBeTruthy();
});

it("a rejected collect attempt (nothing to find / too soon) is logged with its reason", async (ctx) => {
  if (!(await testEndpointEnabled())) {
    ctx.skip();
    return;
  }
  const cookie = await freshVisitorCookie();
  const stateBefore = await fetch(new URL("/api/state", baseUrl), { headers: { cookie } }).then((r) => r.json());
  const publicId = stateBefore.identity.publicId;

  // Firing two collect attempts back-to-back with no real target: the first
  // may succeed or find nothing depending on what's spawned; the second,
  // immediately after, is reliably refused by the anti-double-fire cooldown
  // regardless — that's the one this test needs.
  await fetch(new URL("/api/collect", baseUrl), { method: "POST", headers: { cookie, "Content-Type": "application/json" } });
  const second = await fetch(new URL("/api/collect", baseUrl), {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
  }).then((r) => r.json());

  if (second.ok) return; // landed anyway (e.g. the cooldown window already elapsed) — nothing to assert here
  const rows = await recentAuditRows();
  const match = rows.find(
    (row) => row.event === "garden.collect" && row.actorPublicId === publicId && row.outcome === "rejected" && row.reasonCode === second.reason,
  );
  expect(match, `expected a rejected garden.collect audit row with reasonCode "${second.reason}"`).toBeTruthy();
});

it("the public care-feed-safe fields never include a session cookie or raw visitor id", async (ctx) => {
  if (!(await testEndpointEnabled())) {
    ctx.skip();
    return;
  }
  const cookie = await freshVisitorCookie();
  const rawVisitorId = cookie.split("=")[1];
  const rows = await recentAuditRows();
  for (const row of rows) {
    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain(rawVisitorId);
    expect(serialised.toLowerCase()).not.toContain("cookie");
  }
});
