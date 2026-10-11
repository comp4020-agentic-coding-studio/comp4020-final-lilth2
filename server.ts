// Tend: a plant shared by everyone who visits. Watering it grows it a little,
// for everyone, forever — the whole app is one row in a database.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { marked } from "marked";
import { WebSocketServer } from "ws";
import { isDroughtActive, stageFor, type Stage } from "./stage.ts";

const PORT = Number(process.env.PORT ?? 8080);
// /data is the one path the Fly volume persists; fall back to the repo root
// for local development, where there's no volume at all.
const DATA_DIR = process.env.DATA_DIR ?? (existsSync("/data") ? "/data" : ".");
const DB_PATH = join(DATA_DIR, "tend.db");

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS plant (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    size REAL NOT NULL,
    waters INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS visitors (
    id TEXT PRIMARY KEY,
    waters INTEGER NOT NULL,
    last_watered_at TEXT
  );
`);
// Migrations for columns added after the plant's first deploy: ALTER TABLE
// has no "IF NOT EXISTS" in sqlite, so this just swallows the one error that
// means "already applied" and re-throws anything else.
function ensureColumn(table: string, name: string, ddl: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  } catch (err) {
    if (!(err instanceof Error && err.message.includes("duplicate column name"))) throw err;
  }
}
ensureColumn("plant", "last_watered_at", "TEXT");
ensureColumn("plant", "near_death_saves", "INTEGER NOT NULL DEFAULT 0");
db.prepare("INSERT OR IGNORE INTO plant (id, size, waters) VALUES (1, 1.0, 0)").run();
// A plant migrated from before this column existed has no watering history;
// start its clock now rather than reading as already-dormant on deploy.
db.prepare("UPDATE plant SET last_watered_at = COALESCE(last_watered_at, ?) WHERE id = 1").run(
  new Date().toISOString(),
);

interface Plant {
  size: number;
  waters: number;
  stage: Stage;
  minutesSinceWatered: number;
  isDrought: boolean;
  nearDeathSaves: number;
}
interface Visitor {
  waters: number;
  lastWateredAt: string | null;
}

function getPlant(): Plant {
  const row = db
    .prepare("SELECT size, waters, last_watered_at AS lastWateredAt, near_death_saves AS nearDeathSaves FROM plant WHERE id = 1")
    .get() as unknown as { size: number; waters: number; lastWateredAt: string; nearDeathSaves: number };
  const now = new Date();
  const minutesSinceWatered = (now.getTime() - new Date(row.lastWateredAt).getTime()) / 60_000;
  const isDrought = isDroughtActive(now);
  return {
    // sqlite's floating point addition drifts (1.15 + 0.15 = 1.2999999999999998);
    // round for display since nothing downstream needs more than cm precision.
    size: Math.round(row.size * 100) / 100,
    waters: row.waters,
    stage: stageFor(minutesSinceWatered, isDrought),
    minutesSinceWatered: Math.round(minutesSinceWatered),
    isDrought,
    nearDeathSaves: row.nearDeathSaves,
  };
}

function getVisitor(id: string): Visitor {
  const row = db.prepare("SELECT waters, last_watered_at AS lastWateredAt FROM visitors WHERE id = ?").get(id) as
    | Visitor
    | undefined;
  return row ?? { waters: 0, lastWateredAt: null };
}

function waterPlant(visitorId: string): { plant: Plant; visitor: Visitor } {
  // A rescue is counted exactly when a watering lands while the plant is
  // dormant: watering always jumps the clock back to zero, so the stage
  // can't read as dormant again until it's genuinely drifted back there —
  // nothing extra to track to avoid double-counting one dip.
  const wasDormant = getPlant().stage === "dormant";
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE plant SET size = size + 0.15, waters = waters + 1, last_watered_at = ?, near_death_saves = near_death_saves + ? WHERE id = 1",
  ).run(now, wasDormant ? 1 : 0);
  db.prepare(
    `INSERT INTO visitors (id, waters, last_watered_at) VALUES (?, 1, ?)
     ON CONFLICT(id) DO UPDATE SET waters = waters + 1, last_watered_at = excluded.last_watered_at`,
  ).run(visitorId, now);
  return { plant: getPlant(), visitor: getVisitor(visitorId) };
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function visitorIdOf(req: IncomingMessage): { id: string; isNew: boolean } {
  const existing = parseCookies(req.headers.cookie).visitor_id;
  if (existing) return { id: existing, isNew: false };
  return { id: randomUUID(), isNew: true };
}

function withVisitorCookie(res: ServerResponse, id: string, isNew: boolean): void {
  if (!isNew) return;
  // A year is long enough to prove "your trace is still here" without the
  // app needing to think about expiry for crit 8.
  res.setHeader("Set-Cookie", `visitor_id=${id}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function serveStatic(res: ServerResponse, path: string): void {
  const type = CONTENT_TYPES[extname(path)];
  if (!type || !existsSync(path)) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "Content-Type": type }).end(readFileSync(path));
}

function readmePage(): string {
  const body = marked.parse(readFileSync("README.md", "utf8"), { async: false }) as string;
  return `<!doctype html>
<html lang="en-AU">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>About Tend</title>
    <link rel="stylesheet" href="/style.css" />
  </head>
  <body>
    <main class="readme">${body}</main>
  </body>
</html>`;
}

const wss = new WebSocketServer({ noServer: true });

function broadcast(plant: Plant): void {
  const message = JSON.stringify({ type: "plant", plant });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(message);
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const { id: visitorId, isNew } = visitorIdOf(req);
  withVisitorCookie(res, visitorId, isNew);

  if (url.pathname === "/" && req.method === "GET") {
    serveStatic(res, "public/index.html");
    return;
  }
  if (url.pathname === "/readme/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(readmePage());
    return;
  }
  if (url.pathname === "/api/state" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({ plant: getPlant(), visitor: getVisitor(visitorId) }),
    );
    return;
  }
  if (url.pathname === "/api/water" && req.method === "POST") {
    const result = waterPlant(visitorId);
    broadcast(result.plant);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    return;
  }
  if (url.pathname === "/app.js" || url.pathname === "/style.css") {
    serveStatic(res, join("public", url.pathname));
    return;
  }
  res.writeHead(404).end("not found");
});

server.on("upgrade", (req, socket, head) => {
  if (new URL(req.url ?? "/", "http://localhost").pathname !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.send(JSON.stringify({ type: "plant", plant: getPlant() }));
    wss.emit("connection", ws, req);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`tend listening on :${PORT}, data at ${DB_PATH}`);
});
