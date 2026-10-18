import { expect, inject, it } from "vitest";

// isTrustedOrigin's one real decision: reject only a PRESENT-but-mismatched
// Origin/Referer, never an absent one. Built on /api/collection/seen, which
// touches no shared counter at all — this file contends with nobody's
// plant-id partitioning or collectedToday assertions.
const baseUrl = inject("baseUrl");

async function freshVisitorCookie(): Promise<string> {
  const res = await fetch(new URL("/api/state", baseUrl));
  const cookie = res.headers.get("set-cookie");
  expect(cookie, "expected a visitor_id cookie on a first visit").toBeTruthy();
  return cookie!.split(";")[0];
}

it("a POST with a mismatched Origin header is rejected, with no state change", async () => {
  const cookie = await freshVisitorCookie();
  const before = await fetch(new URL("/api/collection", baseUrl), { headers: { cookie } }).then((r) => r.json());

  const res = await fetch(new URL("/api/collection/seen", baseUrl), {
    method: "POST",
    headers: { cookie, Origin: "https://evil.example.com" },
  });
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.ok).toBe(false);

  const after = await fetch(new URL("/api/collection", baseUrl), { headers: { cookie } }).then((r) => r.json());
  expect(after.hasUnseen).toBe(before.hasUnseen); // the "seen" write never happened
});

// A non-regression check: every existing integration spec file's fetch()
// calls carry no Origin header at all (Node's global fetch() doesn't set
// one for a same-process call) — if isTrustedOrigin ever started rejecting
// absent Origin too, this would be the first thing to catch it, same as
// every other spec file's own POST calls already silently rely on today.
it("a POST with no Origin header at all still succeeds — what every other spec file's fetch() already sends", async () => {
  const cookie = await freshVisitorCookie();
  const res = await fetch(new URL("/api/collection/seen", baseUrl), {
    method: "POST",
    headers: { cookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.hasUnseen).toBe(false);
});

it("a POST whose Origin matches the request's own host still succeeds", async () => {
  const cookie = await freshVisitorCookie();
  const url = new URL(baseUrl);
  const res = await fetch(new URL("/api/collection/seen", baseUrl), {
    method: "POST",
    headers: { cookie, Origin: url.origin },
  });
  expect(res.status).toBe(200);
});
