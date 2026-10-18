import { expect, inject, it } from "vitest";
import { WebSocket } from "ws";

// The "care" broadcast — a snappier single-entry delta sent alongside the
// full "garden" broadcast on a successful collect. Built on /api/collect,
// not /api/water, so this file needs no plant-id partitioning against the
// other three watering-focused integration files.
const baseUrl = inject("baseUrl");
const wsUrl = new URL(baseUrl);
wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
wsUrl.pathname = "/ws";

interface AnyMessage {
  type: string;
  [key: string]: unknown;
}

// Same race this file's sibling (live.test.ts) already protects against:
// queue messages from the moment the socket exists, not from a listener
// added after `open`, since the server's opening snapshot can otherwise
// arrive first.
function messageQueue(ws: WebSocket): () => Promise<AnyMessage> {
  const queue: AnyMessage[] = [];
  const waiters: Array<(msg: AnyMessage) => void> = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString()) as AnyMessage;
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else queue.push(msg);
  });
  return () =>
    new Promise<AnyMessage>((resolve) => {
      const msg = queue.shift();
      if (msg) resolve(msg);
      else waiters.push(resolve);
    });
}

async function freshVisitorCookie(): Promise<string> {
  const res = await fetch(new URL("/api/state", baseUrl));
  const cookie = res.headers.get("set-cookie");
  expect(cookie, "expected a visitor_id cookie on a first visit").toBeTruthy();
  return cookie!.split(";")[0];
}

async function state(cookie: string) {
  return fetch(new URL("/api/state", baseUrl), { headers: { cookie } }).then((r) => r.json());
}

async function waitForCollectible(cookie: string): Promise<{ id: string }> {
  for (let attempt = 0; attempt < 350; attempt++) {
    const data = await state(cookie);
    if (data.collectibles.length > 0) return data.collectibles[0];
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("no collectible spawned in time — check the running app's SPAWN_MIN_SECONDS/SPAWN_MAX_SECONDS");
}

it(
  "a 'care' broadcast reaches an open connection within about a second of a successful collect",
  async () => {
    const cookie = await freshVisitorCookie();
    const target = await waitForCollectible(cookie);

    const ws = new WebSocket(wsUrl);
    const nextMessage = messageQueue(ws);
    await new Promise((resolve) => ws.once("open", resolve));
    await nextMessage(); // the connection's own opening "garden" snapshot

    const start = Date.now();
    const collected = await fetch(new URL("/api/collect", baseUrl), {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ id: target.id }),
    }).then((r) => r.json());
    expect(collected.ok).toBe(true);

    // Two messages arrive per successful collect — the full "garden"
    // broadcast and the single-entry "care" delta — in no guaranteed
    // order, so drain until the "care" one shows up.
    let care: AnyMessage | undefined;
    for (let i = 0; i < 4 && !care; i++) {
      const msg = await nextMessage();
      if (msg.type === "care") care = msg;
    }
    const elapsedMs = Date.now() - start;
    ws.close();

    expect(care, "expected a 'care' message within a few broadcasts of the collect").toBeTruthy();
    expect(elapsedMs, `broadcast took ${elapsedMs}ms, which isn't "about a second"`).toBeLessThan(1000);
  },
  40_000,
);

it(
  "a 'care' message never carries personal fields — only what the UI's public feed is allowed to show",
  async () => {
    const cookie = await freshVisitorCookie();
    const target = await waitForCollectible(cookie);

    const ws = new WebSocket(wsUrl);
    const nextMessage = messageQueue(ws);
    await new Promise((resolve) => ws.once("open", resolve));
    await nextMessage();

    const collected = await fetch(new URL("/api/collect", baseUrl), {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ id: target.id }),
    }).then((r) => r.json());
    expect(collected.ok).toBe(true);

    let care: AnyMessage | undefined;
    for (let i = 0; i < 4 && !care; i++) {
      const msg = await nextMessage();
      if (msg.type === "care") care = msg;
    }
    ws.close();

    expect(care).toBeTruthy();
    const serialised = JSON.stringify(care);
    expect(serialised).not.toContain(cookie.split("=")[1]); // the raw visitor_id
    expect(serialised).not.toContain("collectedToday");
    expect(serialised).not.toContain("limit");
  },
  40_000,
);
