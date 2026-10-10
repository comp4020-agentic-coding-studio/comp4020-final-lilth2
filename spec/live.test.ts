import { expect, inject, it } from "vitest";
import { WebSocket } from "ws";

// Crit 9's two claims, checked against the running app rather than just read
// off the code: the broadcast actually reaches a second connection fast
// enough to count as "live", and concurrent waterings don't race each other.
const baseUrl = inject("baseUrl");
const wsUrl = new URL(baseUrl);
wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
wsUrl.pathname = "/ws";

interface PlantMessage {
  type: string;
  plant: { waters: number };
}

// The server sends its opening snapshot the instant the upgrade completes,
// which can race a client-side `ws.once("open", ...)` callback that only
// starts listening for messages afterwards — so queue messages from the
// moment the socket exists, and let callers drain that queue instead of
// attaching a listener per message.
function messageQueue(ws: WebSocket): () => Promise<PlantMessage> {
  const queue: PlantMessage[] = [];
  const waiters: Array<(msg: PlantMessage) => void> = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString()) as PlantMessage;
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else queue.push(msg);
  });
  return () =>
    new Promise<PlantMessage>((resolve) => {
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
  await fetch(new URL("/api/water", baseUrl), { method: "POST" });
  const pushed = await nextMessage();
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
