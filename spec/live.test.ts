import { expect, inject, it } from "vitest";
import { WebSocket } from "ws";

// Crit 9's two claims, checked against the running app rather than just read
// off the code: the broadcast actually reaches a second connection fast
// enough to count as "live", and concurrent waterings from different
// visitors still compose (nobody's click is dropped because somebody else's
// landed a moment earlier — section 8's per-visitor limits never lock the
// plant itself, only each visitor's own pace). This file waters only
// "bamboo" and "shrub" — spec/tend.test.ts keeps to "tree" and
// spec/garden.test.ts to "fern" and "fruit" — purely so the three files'
// daily-count assertions don't interfere with each other.
const baseUrl = inject("baseUrl");
const wsUrl = new URL(baseUrl);
wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
wsUrl.pathname = "/ws";

interface GardenMessage {
  type: string;
  garden: Record<string, { waters: number }>;
}

async function water(plantId: string): Promise<{ ok: boolean; plant: { waters: number }; garden: Record<string, { waters: number }> }> {
  const res = await fetch(new URL("/api/water", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plantId }),
  });
  return res.json();
}

// The server sends its opening snapshot the instant the upgrade completes,
// which can race a client-side `ws.once("open", ...)` callback that only
// starts listening for messages afterwards — so queue messages from the
// moment the socket exists, and let callers drain that queue instead of
// attaching a listener per message.
function messageQueue(ws: WebSocket): () => Promise<GardenMessage> {
  const queue: GardenMessage[] = [];
  const waiters: Array<(msg: GardenMessage) => void> = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString()) as GardenMessage;
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else queue.push(msg);
  });
  return () =>
    new Promise<GardenMessage>((resolve) => {
      const msg = queue.shift();
      if (msg) resolve(msg);
      else waiters.push(resolve);
    });
}

it("a watering reaches an already-open connection live, well under a second, no reload", async () => {
  const ws = new WebSocket(wsUrl);
  const nextMessage = messageQueue(ws);
  await new Promise((resolve) => ws.once("open", resolve));
  await nextMessage(); // the connection's own opening snapshot, not an event

  const start = Date.now();
  // A different visitor waters it — this connection never asked for anything.
  const watered = await water("bamboo");
  expect(watered.ok).toBe(true);
  const pushed = await nextMessage();
  const elapsedMs = Date.now() - start;

  ws.close();
  expect(pushed.type).toBe("garden");
  expect(pushed.garden.bamboo.waters).toBe(watered.garden.bamboo.waters);
  expect(elapsedMs, `broadcast took ${elapsedMs}ms, which isn't "about a second"`).toBeLessThan(1000);
});

it("two different visitors watering the same plant at the same instant both land", async () => {
  // Each water() call here carries no cookie, so the server treats it as a
  // brand new visitor — this is exactly crit 9's scenario (two people, same
  // plant, same instant), and the answer is still the one in PROCESS.md:
  // watering is a commutative increment, so both land, nothing is lost to a
  // race. Section 8's daily/cooldown limits are per-visitor and never lock
  // the plant itself, so they don't change this outcome.
  const before = await fetch(new URL("/api/state", baseUrl)).then((r) => r.json());

  const [a, b] = await Promise.all([water("shrub"), water("shrub")]);

  expect(a.ok).toBe(true);
  expect(b.ok).toBe(true);
  expect(a.plant.waters).not.toBe(b.plant.waters);
  expect(Math.max(a.plant.waters, b.plant.waters)).toBe(before.garden.shrub.waters + 2);
});
