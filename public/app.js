const plantEl = document.getElementById("plant");
const statusEl = document.getElementById("status");
const waterButton = document.getElementById("water");
const droughtEl = document.getElementById("drought");
const rescuesEl = document.getElementById("rescues");

const STAGE_LABEL = {
  thriving: "It's thriving.",
  thirsty: "It's getting thirsty.",
  wilting: "It's wilting — it could use some water.",
  dormant: "It's gone dormant, brown and curled. Water it to bring it back.",
};

// What this client knows about its own visitor — never sent to anyone else,
// and never changed by someone else's watering, so a broadcast only ever
// needs to update the plant half of a render.
let lastVisitor = null;

function render(plant, visitor) {
  // A size of 1.0 is a seedling; each watering nudges it up, permanently —
  // that part never goes backwards, even while the plant looks neglected.
  const scale = Math.min(1 + plant.size * 0.18, 6);
  plantEl.style.setProperty("--scale", String(scale));
  plantEl.dataset.stage = plant.stage;

  const lines = [STAGE_LABEL[plant.stage], `Watered ${plant.waters} time${plant.waters === 1 ? "" : "s"} in total.`];
  if (visitor && visitor.waters > 0) {
    lines.push(`You've watered it ${visitor.waters} time${visitor.waters === 1 ? "" : "s"}.`);
  } else {
    lines.push("You haven't watered it yet — go on.");
  }
  statusEl.textContent = lines.join(" ");

  droughtEl.hidden = !plant.isDrought;

  if (plant.nearDeathSaves > 0) {
    rescuesEl.hidden = false;
    rescuesEl.textContent = `Rescued from the brink ${plant.nearDeathSaves} time${
      plant.nearDeathSaves === 1 ? "" : "s"
    } by people who watered it just in time.`;
  } else {
    rescuesEl.hidden = true;
  }
}

async function loadState() {
  const res = await fetch("/api/state");
  const { plant, visitor } = await res.json();
  lastVisitor = visitor;
  render(plant, visitor);
}

async function water() {
  waterButton.disabled = true;
  try {
    const res = await fetch("/api/water", { method: "POST" });
    const { plant, visitor } = await res.json();
    lastVisitor = visitor;
    render(plant, visitor);
  } finally {
    waterButton.disabled = false;
  }
}

waterButton.addEventListener("click", water);
loadState();

// Decay has no event to push when it happens — it's just time passing — so
// a light poll is what keeps a page open and ignored in sync with it
// (and with a drought window starting or ending).
setInterval(loadState, 20_000);

// Real-time layer: everyone watching sees the plant grow the moment anyone,
// anywhere, waters it. The broadcast already carries the full plant state —
// there's no one else's visitor data in it to merge, just this client's own
// (unchanged by someone else's action) — so a message renders directly,
// with no extra round trip back to /api/state.
function connectLive() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "plant") render(msg.plant, lastVisitor);
  });
  ws.addEventListener("close", () => setTimeout(connectLive, 2000));
}
connectLive();
