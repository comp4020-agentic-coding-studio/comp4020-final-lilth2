import { expect, inject, it } from "vitest";
import { WebSocket } from "ws";

// Crit 9's two claims, checked against the running app rather than just read
// off the code: the broadcast actually reaches a second connection fast
// enough to count as "live", and concurrent waterings don't race each other.
const baseUrl = inject("baseUrl");
const wsUrl = new URL(baseUrl);
wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
wsUrl.pathname = "/ws";

function nextMessage(ws: WebSocket): Promise<{ type: string; plant: { waters: number } }> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
    ws.once("error", reject);
  });
}

it("a watering reaches an already-open connection live, well under a second, no reload", async () => {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve) => ws.once("open", resolve));
  await nextMessage(ws); // the connection's own opening snapshot, not an event

  const start = Date.now();
  // A different visitor waters it — this connection never asked for anything.
  await fetch(new URL("/api/water", baseUrl), { method: "POST" });
  const pushed = await nextMessage(ws);
  const elapsedMs = Date.now() - start;

  ws.close();
  expect(pushed.type).toBe("plant");
  expect(elapsedMs, `broadcast took ${elapsedMs}ms, which isn't "about a second"`).toBeLessThan(1000);
});

it("two people watering at the same instant both land — nothing is lost to a race", async () => {
  const before = await fetch(new URL("/api/state", baseUrl)).then((r) => r.json());

  // Two distinct visitors, fired together, racing the same UPDATE statement.
  const [a, b] = await Promise.all([
    fetch(new URL("/api/water", baseUrl), { method: "POST" }).then((r) => r.json()),
    fetch(new URL("/api/water", baseUrl), { method: "POST" }).then((r) => r.json()),
  ]);

  // Each watering is `size = size + 0.15`, not `size = someValue` — the two
  // concurrent increments compose instead of one clobbering the other, which
  // is the whole point of PROCESS.md's concurrency decision.
  expect(a.plant.waters).not.toBe(b.plant.waters);
  expect(Math.max(a.plant.waters, b.plant.waters)).toBe(before.plant.waters + 2);
});
