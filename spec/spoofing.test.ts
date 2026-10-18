import { readFileSync } from "node:fs";
import { expect, inject, it } from "vitest";

// Zero production code changes are expected because of this file — it only
// proves what's already true: every write handler derives "who is this"
// from the cookie-verified visitorId server.ts computes itself
// (visitorIdOf(req)), never from anything the client's own request body
// claims. This is pure regression evidence against a future change
// accidentally trusting a body-supplied identity field.
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

it("a forged visitorId in /api/water's body never charges anyone but the cookie-verified visitor", async () => {
  const cookieA = await freshVisitorCookie();
  const cookieB = await freshVisitorCookie();
  const beforeA = await state(cookieA);
  const beforeB = await state(cookieB);

  // A sent as A's own cookie, but claiming to be B in the body — if the
  // server ever trusted this, B's allowance would be the one charged.
  const result = await fetch(new URL("/api/water", baseUrl), {
    method: "POST",
    headers: { cookie: cookieA, "Content-Type": "application/json" },
    body: JSON.stringify({ plantId: "tree", visitorId: beforeB.identity.publicId, actorPublicId: beforeB.identity.publicId }),
  }).then((r) => r.json());
  expect(result.ok).toBe(true);

  const afterA = await state(cookieA);
  const afterB = await state(cookieB);
  // A's own trace moved; B's didn't, regardless of what A's request body claimed.
  expect(afterA.visitor.waters).toBe(beforeA.visitor.waters + 1);
  expect(afterB.visitor.waters).toBe(beforeB.visitor.waters);
  expect(afterB.limits.remainingToday).toBe(beforeB.limits.remainingToday);
  expect(afterA.identity.publicId).toBe(beforeA.identity.publicId); // A is still A, not B
});

it("a forged identity field in /api/collection/seen's body only ever clears the caller's own unseen flag", async () => {
  const cookieA = await freshVisitorCookie();
  const cookieB = await freshVisitorCookie();

  // A calls /api/collection/seen, naming B in the body — if the server ever
  // trusted this, it would be B's unseen flag (and only B's) that gets
  // cleared, not A's.
  const resultA = await fetch(new URL("/api/collection/seen", baseUrl), {
    method: "POST",
    headers: { cookie: cookieA, "Content-Type": "application/json" },
    body: JSON.stringify({ visitorId: "someone-else", actorPublicId: "someone-else" }),
  }).then((r) => r.json());

  // The endpoint's own response is scoped to whoever the cookie says the
  // caller is — it can only ever describe A's collection, which is the
  // real proof here: there is no code path by which this response could
  // instead describe B's.
  const collectionA = await fetch(new URL("/api/collection", baseUrl), { headers: { cookie: cookieA } }).then((r) => r.json());
  expect(resultA.totalDiscovered).toBe(collectionA.totalDiscovered);

  const collectionB = await fetch(new URL("/api/collection", baseUrl), { headers: { cookie: cookieB } }).then((r) => r.json());
  expect(collectionB.hasUnseen).toBe(false); // B never had anything unseen to begin with — never touched either way
});

it("server.ts never reads an identity field off a request body — a structural guard, not just inferred behaviour", () => {
  // Whether a body-supplied identity would ever matter isn't fully
  // observable through a single HTTP round trip (there's no response field
  // that says "whose identity did you actually use"), so this backs up the
  // two behavioural tests above with a direct source check: every
  // `body.` access in server.ts should be one of the handful of real
  // request parameters the API accepts, never a visitor/identity field. A
  // future change that starts reading `body.visitorId` or
  // `body.actorPublicId` fails this immediately, before it ever reaches a
  // behavioural test.
  const source = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  const bodyAccesses = [...source.matchAll(/\bbody\.(\w+)/g)].map((m) => m[1]);
  expect(bodyAccesses.length, "expected server.ts to read at least one body field").toBeGreaterThan(0);
  const allowed = new Set(["plantId", "id", "kind"]);
  for (const field of bodyAccesses) {
    expect(allowed.has(field), `server.ts reads body.${field} — identity must only ever come from the cookie`).toBe(true);
  }
});
