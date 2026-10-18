import { expect, inject, it } from "vitest";

// A visitor's public identity — the thing shown in the UI and (eventually)
// in server logs instead of their session cookie. Neither watering nor
// collecting touches a shared counter here (identity lookups are per-visitor
// and side-effect-free past the first lazy creation), so this file needs no
// plant-id partitioning against the other integration files.
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

it("a first visit gets a public gardener codename, in the Noun-CODE shape", async () => {
  const cookie = await freshVisitorCookie();
  const data = await state(cookie);
  expect(data.identity.publicId).toMatch(/^[A-Za-z]+-[A-Z0-9]{3}$/);
});

it("the same visitor keeps the same codename across repeated requests", async () => {
  const cookie = await freshVisitorCookie();
  const first = await state(cookie);
  const second = await state(cookie);
  const third = await state(cookie);
  expect(second.identity.publicId).toBe(first.identity.publicId);
  expect(third.identity.publicId).toBe(first.identity.publicId);
});

it("two different visitors get two different codenames", async () => {
  const cookieA = await freshVisitorCookie();
  const cookieB = await freshVisitorCookie();
  const [a, b] = await Promise.all([state(cookieA), state(cookieB)]);
  expect(a.identity.publicId).not.toBe(b.identity.publicId);
});

it("never exposes the raw session cookie value as the public identity", async () => {
  const cookie = await freshVisitorCookie();
  const rawVisitorId = cookie.split("=")[1];
  const data = await state(cookie);
  expect(data.identity.publicId).not.toBe(rawVisitorId);
  expect(data.identity.publicId).not.toContain(rawVisitorId);
});
