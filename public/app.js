import { SPECIES, SPECIES_ORDER, STAGE_NAMES, VITALITY, renderPlant, renderDecoration } from "/garden.js";
import { COLLECTIBLE_INFO, GROUP_LABELS } from "/collection.js";

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const el = {
  hint: document.getElementById("hint"),
  hintDismiss: document.getElementById("hint-dismiss"),
  eventBanner: document.getElementById("event-banner"),
  drought: document.getElementById("drought"),
  sunlightTotal: document.getElementById("sunlight-total"),
  gardenRemaining: document.getElementById("garden-remaining"),
  achievementToast: document.getElementById("achievement-toast"),
  scene: document.getElementById("garden-scene"),
  decorationsLayer: document.getElementById("decorations-layer"),
  weatherLayer: document.getElementById("weather-layer"),
  leafFallLayer: document.getElementById("leaf-fall-layer"),
  modalBackdrop: document.getElementById("modal-backdrop"),
  detailPanel: document.getElementById("detail-panel"),
  detailClose: document.getElementById("detail-close"),
  detailArtWrap: document.getElementById("detail-art-wrap"),
  detailArt: document.getElementById("detail-art"),
  detailName: document.getElementById("detail-name"),
  detailStatus: document.getElementById("detail-status"),
  detailProgress: document.getElementById("detail-progress"),
  detailProgressLabel: document.getElementById("detail-progress-label"),
  detailWater: document.getElementById("detail-water"),
  detailLimit: document.getElementById("detail-limit"),
  forageButton: document.getElementById("forage-button"),
  forageStatus: document.getElementById("forage-status"),
  achievementsList: document.getElementById("achievements-list"),
  detailInsects: document.getElementById("detail-insects"),
  detailInsectsSummary: document.getElementById("detail-insects-summary"),
  collectionButton: document.getElementById("collection-button"),
  collectionBadge: document.getElementById("collection-badge"),
  collectionPanel: document.getElementById("collection-panel"),
  collectionClose: document.getElementById("collection-close"),
  collectionProgress: document.getElementById("collection-progress"),
  collectionEmpty: document.getElementById("collection-empty"),
  collectionGroups: document.getElementById("collection-groups"),
};

const ACHIEVEMENT_LABELS = {
  "three-species": "Milestone: tended three different plants",
  "first-bloom": "Milestone: first bloom or fruit",
  "new-branch": "Milestone: the tree grew a new branch",
};

// Daily quotas reset at a fixed UTC midnight (never the visitor's own local
// time, which would make "today" mean something different for every
// visitor) — shown spelled out so "come back tomorrow" is never the only
// thing a capped-out visitor sees.
function formatUtcReset(iso) {
  const d = new Date(iso);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC`;
}

const REASON_MESSAGE = {
  cooldown: (retryAt) => `Next watering available in ${remainingLabel(new Date(retryAt).getTime() - Date.now())}.`,
  "garden-daily": (retryAt) => `You've used today's watering allowance. It resets at ${formatUtcReset(retryAt)}.`,
};

const COLLECT_REASON_MESSAGE = {
  "collection-daily": (retryAt) => `You've used today's discovery allowance (100). It resets at ${formatUtcReset(retryAt)}.`,
  "collect-too-soon": () => "Just a moment — try again in a second.",
  "already-claimed": () => "Someone else just got that one.",
  "nothing-to-find": () => "Nothing to find right now — check back in a bit.",
};

let state = null;
let selectedPlant = null;
let knownAchievementIds = new Set();

function remainingLabel(ms) {
  if (ms <= 0) return "a moment";
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.ceil(minutes / 60);
  return `about ${hours} hour${hours === 1 ? "" : "s"}`;
}

// --- plant art + per-plant slot rendering ---

function renderSlot(id) {
  const plant = state.garden[id];
  const slot = el.scene.querySelector(`.plant-slot[data-plant="${id}"]`);
  const svg = slot.querySelector(".plant-art");
  const { markup, stageName, anchors } = renderPlant(id, plant.growthStage, plant.stage, plant.progressToNext ?? 0);
  svg.innerHTML = markup;
  slot.dataset.vitality = plant.stage;
  // These are real leaf/branch-tip centres from garden.js's renderer, not
  // arbitrary points — what lets a bug sit convincingly on the plant's own
  // surface instead of empty space. Keeping up to 10 (not just 6) gives a
  // fuller tree enough distinct spots that two bugs rarely have to share one.
  slot.dataset.anchors = JSON.stringify(anchors.slice(0, 10));
  // A glance at the scene, without opening the detail panel, for the two
  // things that used to require it: how close this plant is to its next
  // stage, and whether insects are currently holding its growth back.
  const pct = plant.nextThreshold === null ? 100 : Math.round(plant.progressToNext * 100);
  const miniProgress = slot.querySelector(".plant-mini-progress");
  miniProgress.textContent = plant.insectCount > 0 ? `${pct}% · 🐛${plant.insectCount}` : `${pct}%`;
  let ariaLabel = `${SPECIES[id].label}: ${stageName}, ${VITALITY[plant.stage].label}, ${pct}% to next stage`;
  if (plant.insectCount > 0) ariaLabel += `, ${plant.insectCount} insect${plant.insectCount === 1 ? "" : "s"} reducing growth`;
  slot.setAttribute("aria-label", `${ariaLabel}. Opens a larger view.`);
  return { plant, stageName };
}

function renderResourceBar() {
  el.sunlightTotal.textContent = Math.round(state.resources.totalGrowthUnits).toLocaleString();
  el.gardenRemaining.textContent = `${state.limits.remainingToday} / ${state.limits.dailyLimit}`;
}

function renderEventBanner() {
  const labels = {
    none: null,
    breeze: "🍃 A gentle breeze today — leaves sway a little more than usual.",
    rain: "🌧️ Light rain today — the garden looks a little more lush.",
    butterfly: "🦋 A butterfly is visiting the garden today.",
  };
  const label = labels[state.event];
  el.eventBanner.hidden = !label;
  if (label) el.eventBanner.textContent = label;
  el.scene.classList.toggle("weather-breeze", state.event === "breeze");
  el.scene.classList.toggle("weather-rain", state.event === "rain");
  el.scene.classList.toggle("weather-butterfly", state.event === "butterfly");
}

function renderDecorations() {
  el.decorationsLayer.innerHTML = state.achievements
    .map((a, i) => {
      if (!a.decoration) return "";
      const x = 15 + i * 30;
      return `<svg class="decoration-art" style="left:${x}%" viewBox="0 0 30 20" aria-hidden="true">${renderDecoration(a.decoration, 15, 14)}</svg>`;
    })
    .join("");
}

function renderAchievementsList() {
  if (state.achievements.length === 0) {
    el.achievementsList.textContent = "";
    return;
  }
  el.achievementsList.textContent = state.achievements.map((a) => ACHIEVEMENT_LABELS[a.id] ?? a.id).join(" · ");
}

function announceNewAchievements() {
  const incoming = new Set(state.achievements.map((a) => a.id));
  const fresh = [...incoming].filter((id) => !knownAchievementIds.has(id));
  if (fresh.length > 0 && knownAchievementIds.size > 0) {
    el.achievementToast.hidden = false;
    el.achievementToast.textContent = fresh.map((id) => ACHIEVEMENT_LABELS[id] ?? id).join(", ") + " 🎉";
    setTimeout(() => {
      el.achievementToast.hidden = true;
    }, 4000);
  }
  knownAchievementIds = incoming;
}

// The enlarged view renders its own independent copy of the plant, so
// opening or closing it never touches the background scene's own SVG node —
// that one keeps swaying/falling-leafing on its own timeline throughout.
function renderDetailArt() {
  if (!selectedPlant) return;
  const plant = state.garden[selectedPlant];
  const { markup, anchors } = renderPlant(selectedPlant, plant.growthStage, plant.stage, plant.progressToNext ?? 0);
  el.detailArt.innerHTML = markup;
  // Lets the enlarged view overlay the same real bugs on the same real
  // anchors, scaled to its own (larger) box — see positionCollectibleEl.
  el.detailArt.dataset.anchors = JSON.stringify(anchors.slice(0, 10));
}

function renderDetailPanel() {
  // Visibility is the generic modal helpers' job (openDetail/closeDetail);
  // this only refreshes content, so a background poll or WS push can keep
  // an already-open panel's numbers current without touching whether it's
  // shown — and never shows it on its own either.
  if (!selectedPlant) return;
  const plant = state.garden[selectedPlant];
  const limits = state.limits;
  const species = SPECIES[selectedPlant];
  const stageName = STAGE_NAMES[Math.min(plant.growthStage, STAGE_NAMES.length - 1)];

  el.detailName.textContent = `${species.label} · ${stageName}`;
  let statusText = `Water level: ${VITALITY[plant.stage].label} — watered ${plant.waters} time${plant.waters === 1 ? "" : "s"} in total`;
  if (plant.stage === "thriving" && plant.waters > 0) {
    // Moisture and growth are independent on purpose (section 3): a fully
    // watered plant doesn't stop counting waterings toward community
    // growth, so this explains what a watering still does in that state
    // instead of implying it's wasted.
    statusText += ". Already fully watered — further waterings still count as shared garden care.";
  }
  el.detailStatus.textContent = statusText;

  if (plant.insectCount > 0) {
    const reduction = Math.round((1 - plant.growthMultiplier) * 100);
    el.detailInsects.hidden = false;
    el.detailInsectsSummary.textContent = `${plant.insectCount} insect${plant.insectCount === 1 ? "" : "s"} · Growth reduced by ${reduction}%`;
  } else {
    el.detailInsects.hidden = true;
  }

  const progress = plant.nextThreshold === null ? 1 : plant.progressToNext;
  el.detailProgress.style.width = `${Math.round(progress * 100)}%`;
  // "Growth points" is its own unit, kept separate from the real watering
  // count above — a watering with active insect slowdown earns fewer points
  // than a full one, so the two numbers can legitimately differ, and
  // calling both of them "waterings" was confusing (the table-review
  // feedback this fixes: "growth is still labelled valid waterings, but
  // detail also shows watered 140 times and growth 15002").
  el.detailProgressLabel.textContent =
    plant.nextThreshold === null
      ? `Growth: ${Math.round(plant.growthUnits)} points — fully grown`
      : `Growth: ${Math.round(plant.growthUnits)} / ${plant.nextThreshold} points — ${plant.wateringsUntilNext} more to the next stage`;

  const cooldownMs = limits.cooldownUntil ? new Date(limits.cooldownUntil).getTime() - Date.now() : 0;

  // Deliberately not gated on this plant's own water level — whether it's
  // fully watered, wilting, or someone else just watered it a moment ago
  // never stops *this* visitor; only their own garden-wide allowance below
  // does. That's what keeps concurrent waterings composing, crit 9's
  // decision, now true across every plant instead of just one.
  let limitText = `Watering allowance: ${limits.remainingToday} / ${limits.dailyLimit} remaining today.`;
  let disabled = false;
  if (cooldownMs > 0) {
    limitText = REASON_MESSAGE.cooldown(limits.cooldownUntil);
    disabled = true;
  } else if (limits.remainingToday <= 0) {
    limitText = REASON_MESSAGE["garden-daily"](limits.resetAt);
    disabled = true;
  }
  el.detailLimit.textContent = limitText;
  el.detailWater.disabled = disabled;
}

function renderAll() {
  renderResourceBar();
  renderEventBanner();
  el.drought.hidden = !state.garden.tree.isDrought;
  SPECIES_ORDER.forEach(renderSlot);
  renderDecorations();
  renderCollectibles();
  renderAchievementsList();
  announceNewAchievements();
  renderDetailPanel();
  if (selectedPlant) renderDetailArt();
  renderDetailBugOverlay();
}

// --- networking ---

async function loadState() {
  const res = await fetch("/api/state");
  state = await res.json();
  renderAll();
}

async function waterSelected() {
  if (!selectedPlant) return;
  el.detailWater.disabled = true;
  el.detailLimit.textContent = "Watering…";
  const res = await fetch("/api/water", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plantId: selectedPlant }),
  });
  const result = await res.json();
  const grewAStage = result.ok && result.plant.growthStage > state.garden[selectedPlant].growthStage;
  state.garden = result.garden;
  state.visitor = result.visitor;
  state.limits = result.limits;
  state.resources.totalGrowthUnits =
    Math.round(SPECIES_ORDER.reduce((sum, id) => sum + state.garden[id].growthUnits, 0) * 100) / 100;
  renderAll();
  if (result.ok) {
    playWaterFeedback(selectedPlant, grewAStage);
    // "the growth actually added this time" (section 3) — shown once, right
    // after the allowance text renderAll() just set, rather than a separate
    // permanent field, since it's only meaningful for the watering just done.
    const addedLabel = result.growthAdded < 1 ? result.growthAdded.toFixed(2) : String(result.growthAdded);
    el.detailLimit.textContent = `+${addedLabel} growth added. ${el.detailLimit.textContent}`;
  } else {
    el.detailLimit.textContent = (REASON_MESSAGE[result.reason] ?? (() => "This plant can't be watered right now."))(
      result.retryAt,
    );
  }
}

// --- shared, backend-owned collectibles (bugs + treasures) ---
//
// Nothing here is invented client-side any more: what exists, where it is,
// and who gets it are all decided by the server and pushed to every client
// (see connectLive below). A click only ever asks "may I have this one?" —
// the element is removed from the scene on a *confirmed* success, never
// before, so a rejected or failed request leaves it exactly where it was,
// clickable again (the bug this fixes: it used to vanish on click
// regardless of whether the request actually succeeded).

const collectibleEls = new Map(); // collectible id -> its DOM element in the main scene
const detailBugEls = new Map(); // collectible id -> its DOM element overlaid on the enlarged view

// A plant can host more than one active collectible at once (several bugs,
// or a bug and a treasure together), and a compact plant's branch tips can
// sit only a few pixels apart on screen — closer together than the 44px
// touch target itself — so merely picking a *different* anchor per item
// isn't enough to keep them independently clickable. `index` is this item's
// position within the sorted list of everything currently on this plant
// (see renderCollectibles): item 0 sits exactly on its anchor as before,
// and every later item is additionally pushed out along a golden-angle
// spiral, far enough (>= the touch target's own size, even along the
// worst-case diagonal) that no two buttons' hit areas can overlap — the
// direct fix for "one collectible intercepts the pointer events meant for
// another." Shared by both the small scene slots and the enlarged detail
// view's overlay, which just pass a different frame/container pair.
const PLANT_VIEW_W = 120;
const PLANT_VIEW_H = 160;

function placeOnFrame(button, anchor, index, frameRect, containerRect) {
  if (containerRect.width === 0 || frameRect.width === 0) return; // not laid out yet; next render will retry
  // Every plant SVG uses its default preserveAspectRatio ("xMidYMid meet"):
  // it scales to fit its box without stretching, which almost always
  // leaves empty space on two sides whenever the box's aspect ratio doesn't
  // exactly match the viewBox's (120:160) — true for the small scene slot
  // and emphatically true for the much wider enlarged-view box. Scaling an
  // anchor directly by frameRect.width/height (ignoring that letterboxing)
  // places it off to the side of the actual artwork instead of on it.
  const scale = Math.min(frameRect.width / PLANT_VIEW_W, frameRect.height / PLANT_VIEW_H);
  const renderedW = PLANT_VIEW_W * scale;
  const renderedH = PLANT_VIEW_H * scale;
  const offsetX = frameRect.left - containerRect.left + (frameRect.width - renderedW) / 2;
  const offsetY = frameRect.top - containerRect.top + (frameRect.height - renderedH) / 2;
  let left = ((offsetX + anchor.x * scale) / containerRect.width) * 100;
  let top = ((offsetY + anchor.y * scale) / containerRect.height) * 100;
  if (index > 0) {
    const angle = (index * 137.5 * Math.PI) / 180; // golden angle: spreads any count evenly, never repeats a direction
    const radiusPx = 64 + index * 12; // >= touch-target size / cos(45°), so even a diagonal offset clears it
    left += ((Math.cos(angle) * radiusPx) / containerRect.width) * 100;
    top += ((Math.sin(angle) * radiusPx) / containerRect.height) * 100;
  }
  button.style.left = `${left}%`;
  button.style.top = `${top}%`;
}

function anchorsFor(datasetEl) {
  const anchors = JSON.parse(datasetEl?.dataset.anchors || "[]");
  return anchors.length ? anchors : [{ x: 60, y: 90 }];
}

function positionCollectibleEl(button, item, index = 0) {
  const slot = el.scene.querySelector(`.plant-slot[data-plant="${item.plantId}"]`);
  if (!slot) return;
  const anchors = anchorsFor(slot);
  placeOnFrame(button, anchors[index % anchors.length], index, slot.getBoundingClientRect(), el.scene.getBoundingClientRect());
}

// The ladybug the brief asks for: a real insect shape (red shell, black
// spots, head, antennae), not a glowing abstract marker — so it reads as a
// specific, directly-clickable thing sitting on the plant, not a hint to go
// find something elsewhere.
function ladybugMarkup() {
  return (
    `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">` +
    `<ellipse cx="12" cy="14" rx="7" ry="8.2" fill="#c0392b" stroke="#7a1f14" stroke-width="0.6" />` +
    `<path d="M12 6.4 L12 22" stroke="#241310" stroke-width="1" />` +
    `<circle cx="8.8" cy="11.6" r="1.3" fill="#1b1b1b" />` +
    `<circle cx="15.2" cy="11.6" r="1.3" fill="#1b1b1b" />` +
    `<circle cx="7.9" cy="16.4" r="1.1" fill="#1b1b1b" />` +
    `<circle cx="16.1" cy="16.4" r="1.1" fill="#1b1b1b" />` +
    `<circle cx="12" cy="18.6" r="1.1" fill="#1b1b1b" />` +
    `<circle cx="12" cy="6.4" r="3.3" fill="#1b1b1b" />` +
    `<line x1="10.4" y1="3.8" x2="8.7" y2="1.5" stroke="#1b1b1b" stroke-width="0.8" stroke-linecap="round" />` +
    `<line x1="13.6" y1="3.8" x2="15.3" y2="1.5" stroke="#1b1b1b" stroke-width="0.8" stroke-linecap="round" />` +
    `</svg>`
  );
}

const KIND_ICON = { treasure: "✨" };

function collectibleAriaLabel(item) {
  const plantLabel = SPECIES[item.plantId]?.label ?? item.plantId;
  return item.kind === "bug"
    ? `A ladybug on the ${plantLabel} — catch it to restore this plant's growth rate`
    : `Something is hiding on the ${plantLabel} — collect it`;
}

// Shared by both the scene button and the enlarged-view overlay button for
// the very same backend item — clicking either one claims the same id, so
// there's only ever one real record, never a second copy to race against.
function createCollectibleButton(item) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `collectible collectible--${item.kind}`;
  button.dataset.id = item.id;
  if (item.kind === "bug") button.innerHTML = ladybugMarkup();
  else button.textContent = KIND_ICON[item.kind];
  button.setAttribute("aria-label", collectibleAriaLabel(item));
  button.addEventListener("click", (event) => {
    event.stopPropagation(); // never also opens the plant's enlarged view
    claimCollectible({ id: item.id, triggerButton: button, removeOnSuccess: true });
  });
  // Section 4's courtesy: don't let a treasure disappear out from under a
  // pointer or keyboard focus mid-decision. The server's own 90s timer is
  // still the one real limit — this only defers *removing the element*,
  // and a claim attempt after it's genuinely gone fails cleanly (see
  // claimCollectible's "already-claimed" handling) rather than silently.
  button.addEventListener("mouseenter", () => {
    button.dataset.paused = "true";
  });
  button.addEventListener("mouseleave", () => {
    delete button.dataset.paused;
  });
  button.addEventListener("focus", () => {
    button.dataset.paused = "true";
  });
  button.addEventListener("blur", () => {
    delete button.dataset.paused;
  });
  return button;
}

function renderCollectibles() {
  if (!state) return;
  const active = new Map(state.collectibles.map((c) => [c.id, c]));
  for (const [id, button] of collectibleEls) {
    if (!active.has(id) && button.dataset.paused !== "true") {
      button.remove();
      collectibleEls.delete(id);
    }
  }
  // Grouped and sorted by id (not spawn order, which can reshuffle as items
  // are claimed) so each item on a given plant keeps a stable index, and so
  // its anchor/ring assignment doesn't jump around between renders.
  const byPlant = new Map();
  for (const item of active.values()) {
    if (!byPlant.has(item.plantId)) byPlant.set(item.plantId, []);
    byPlant.get(item.plantId).push(item);
  }
  for (const items of byPlant.values()) {
    items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    items.forEach((item, index) => {
      let button = collectibleEls.get(item.id);
      if (!button) {
        button = createCollectibleButton(item);
        collectibleEls.set(item.id, button);
        el.decorationsLayer.appendChild(button);
      }
      positionCollectibleEl(button, item, index);
    });
  }
}

// The enlarged plant view shows the same real bugs as the scene (never a
// separate, invented set) so a visitor who opened it to look closer can
// catch one right there — this is the keyboard-reachable, read-named target
// the brief asks for in place of a single generic "catch an insect" button.
function renderDetailBugOverlay() {
  if (!selectedPlant || el.detailPanel.hidden) {
    for (const button of detailBugEls.values()) button.remove();
    detailBugEls.clear();
    return;
  }
  const bugsHere = (state?.collectibles ?? [])
    .filter((c) => c.kind === "bug" && c.plantId === selectedPlant)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const activeIds = new Set(bugsHere.map((c) => c.id));
  for (const [id, button] of detailBugEls) {
    if (!activeIds.has(id) && button.dataset.paused !== "true") {
      button.remove();
      detailBugEls.delete(id);
    }
  }
  const anchors = anchorsFor(el.detailArt);
  const wrapRect = el.detailArtWrap.getBoundingClientRect();
  bugsHere.forEach((item, index) => {
    let button = detailBugEls.get(item.id);
    if (!button) {
      button = createCollectibleButton(item);
      detailBugEls.set(item.id, button);
      el.detailArtWrap.appendChild(button);
    }
    placeOnFrame(button, anchors[index % anchors.length], index, el.detailArt.getBoundingClientRect(), wrapRect);
  });
}

async function claimCollectible({ id = null, triggerButton, removeOnSuccess = false, filter } = {}) {
  if (triggerButton) triggerButton.disabled = true;
  try {
    const res = await fetch("/api/collect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...(id ? { id } : {}), ...(filter ?? {}) }),
    });
    const result = await res.json();
    if (result.ok) {
      if (removeOnSuccess) {
        // A caught bug can have TWO representations at once — the scene
        // button and the enlarged-view overlay button — if its plant's
        // detail panel happens to be open. Removing only whichever one was
        // actually clicked would leave the other as an orphaned element no
        // longer tracked by either map, so both are cleaned up by id here
        // rather than by `triggerButton` alone.
        const sceneBtn = collectibleEls.get(id);
        if (sceneBtn) {
          sceneBtn.remove();
          collectibleEls.delete(id);
        }
        const detailBtn = detailBugEls.get(id);
        if (detailBtn) {
          detailBtn.remove();
          detailBugEls.delete(id);
        }
      } else if (triggerButton) {
        triggerButton.disabled = false; // a permanent control (e.g. "Inspect foliage"), not a collectible itself
      }
      const info = COLLECTIBLE_INFO[result.item.id];
      el.forageStatus.innerHTML = "";
      const text = document.createElement("span");
      text.textContent = `Found ${info.label}! Added to your collection. `;
      const link = document.createElement("button");
      link.type = "button";
      link.className = "link-button";
      link.textContent = "View collection";
      link.addEventListener("click", () => openCollection(link));
      el.forageStatus.append(text, link);
      spawnSparkle();
      refreshCollectionBadge();
      await loadState(); // picks up the new insectCount/growthMultiplier and the updated collectibles list
    } else {
      // Never removed on a refusal or failure — re-enabled so the same
      // control (the collectible itself, or "Inspect foliage") can just be
      // tried again, per section 1's explicit requirement.
      if (triggerButton) triggerButton.disabled = false;
      const reasonMessage = COLLECT_REASON_MESSAGE[result.reason];
      el.forageStatus.textContent = reasonMessage ? reasonMessage(result.retryAt) : "Couldn't collect that — try again.";
      if (result.reason === "already-claimed" || result.reason === "nothing-to-find") await loadState();
    }
  } catch {
    if (triggerButton) triggerButton.disabled = false;
    el.forageStatus.textContent = "Couldn't reach the garden — check your connection and try again.";
  }
}

function connectLive() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (!state) return;
    if (msg.type === "garden") {
      // A defensive guard, not a real ordering mechanism: messages normally
      // arrive in order on one open connection, but if one ever doesn't
      // (a flaky connection re-delivering, or a message queued before a
      // reconnect's own fresh snapshot lands), this stops an older message
      // from regressing already-newer state rather than trying to replay
      // or merge anything.
      if (typeof msg.version === "number" && typeof state.version === "number" && msg.version < state.version) return;
      state.version = msg.version;
      state.garden = msg.garden;
      state.achievements = msg.achievements;
      state.event = msg.event;
      state.collectibles = msg.collectibles; // every client's scene stays in sync: a catch anywhere removes it everywhere
      state.recentCare = msg.recentCare ?? state.recentCare;
      state.resources.totalGrowthUnits =
        Math.round(SPECIES_ORDER.reduce((sum, id) => sum + state.garden[id].growthUnits, 0) * 100) / 100;
      renderAll();
    } else if (msg.type === "care") {
      // A snappier single-entry delta for "this just happened" — the
      // feed's actual contents always come from the "garden" message's own
      // recentCare array above, so this is just a nicer-feeling nudge, not
      // a second source of truth that could ever disagree with it for long.
      // No UI consumes this yet; rendering lands in a later commit.
    }
  });
  ws.addEventListener("close", () => setTimeout(connectLive, 2000));
}

// --- generic modal: open/close, Escape, focus trap, focus return. Both the
// plant detail view and the collection panel share this, one at a time
// (opening one closes the other, rather than stacking). ---

let activeModal = null; // { panel, trigger }
// Set while openCollection's fetch is in flight, cleared by a successful
// open or by a cancellation. Without this, pressing Escape during that
// fetch did nothing (activeModal was still null, so the Escape handler's
// own guard bailed out) and the panel opened anyway once the fetch resolved
// — this is what a cancelled token prevents.
let pendingCollectionOpen = null;

function openModal(panel, triggerEl, focusEl) {
  if (activeModal && activeModal.panel !== panel) closeActiveModal();
  activeModal = { panel, trigger: triggerEl ?? null };
  panel.hidden = false;
  el.modalBackdrop.hidden = false;
  (focusEl ?? panel.querySelector("button")).focus();
}

function closeActiveModal() {
  if (!activeModal) return;
  const { panel, trigger } = activeModal;
  panel.hidden = true;
  el.modalBackdrop.hidden = true;
  if (trigger) trigger.focus();
  activeModal = null;
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    // Cancels an in-flight openCollection() even though activeModal isn't
    // set yet at that point — otherwise Escape here was a no-op and the
    // panel opened anyway once the fetch resolved a moment later.
    pendingCollectionOpen = null;
  }
  if (!activeModal) return;
  if (event.key === "Escape") {
    event.preventDefault();
    if (activeModal.panel === el.detailPanel) selectedPlant = null;
    closeActiveModal();
    return;
  }
  if (event.key === "Tab") {
    // A minimal focus trap: Tab/Shift+Tab cycle only within the open modal.
    const focusable = [...activeModal.panel.querySelectorAll("button:not([disabled])")];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});

el.modalBackdrop.addEventListener("click", () => {
  pendingCollectionOpen = null; // same cancellation as Escape, see above
  if (activeModal?.panel === el.detailPanel) selectedPlant = null;
  closeActiveModal();
});

function openDetail(plantId, triggerEl) {
  selectedPlant = plantId;
  renderDetailPanel();
  renderDetailArt();
  openModal(el.detailPanel, triggerEl, el.detailClose);
  // After openModal clears `hidden`, so renderDetailBugOverlay's own guard
  // (which checks the panel is actually visible) doesn't bail out.
  renderDetailBugOverlay();
}

function closeDetail() {
  if (!selectedPlant) return;
  selectedPlant = null;
  closeActiveModal();
}

el.detailClose.addEventListener("click", closeDetail);
el.detailWater.addEventListener("click", waterSelected);

// --- personal collection panel ---

function renderCollectionCard(item) {
  if (!item.discovered) {
    return `<li class="collection-card collection-card--undiscovered">
      <span class="collection-icon" aria-hidden="true">❔</span>
      <span class="collection-name">???</span>
      <span class="collection-desc">Not discovered yet</span>
    </li>`;
  }
  const info = COLLECTIBLE_INFO[item.id];
  const found = new Date(item.firstFoundAt);
  const dateLabel = found.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  return `<li class="collection-card${item.unseen ? " collection-card--new" : ""}">
    ${item.unseen ? '<span class="collection-new-flag">New</span>' : ""}
    <span class="collection-icon" aria-hidden="true">${info.icon}</span>
    <span class="collection-name">${info.label}</span>
    <span class="collection-desc">${info.description}</span>
    <span class="collection-meta">First found ${dateLabel} · Found ${item.count} time${item.count === 1 ? "" : "s"}</span>
  </li>`;
}

function renderCollectionPanel(data) {
  el.collectionProgress.textContent = `${data.totalDiscovered} / ${data.totalCatalog} discovered`;
  el.collectionEmpty.hidden = data.totalDiscovered > 0;
  const groups = { insect: [], treasure: [] };
  for (const item of data.items) groups[item.group].push(item);
  el.collectionGroups.innerHTML = Object.entries(groups)
    .map(
      ([group, items]) =>
        `<h3>${GROUP_LABELS[group]}</h3><ul class="collection-grid">${items.map(renderCollectionCard).join("")}</ul>`,
    )
    .join("");
}

async function refreshCollectionBadge() {
  const res = await fetch("/api/collection");
  const data = await res.json();
  el.collectionBadge.hidden = !data.hasUnseen;
  return data;
}

async function openCollection(triggerEl) {
  const token = {};
  pendingCollectionOpen = token;
  el.collectionButton.disabled = true; // a visible loading state for the fetch below
  try {
    const data = await refreshCollectionBadge();
    // Cancelled (Escape or backdrop click) while the fetch was in flight —
    // don't open a panel the visitor already tried to dismiss.
    if (pendingCollectionOpen !== token) return;
    renderCollectionPanel(data);
    openModal(el.collectionPanel, triggerEl ?? el.collectionButton, el.collectionClose);
    // Clears the "new" flag server-side for next time; this viewing still
    // shows the highlight, since renderCollectionPanel already ran above.
    fetch("/api/collection/seen", { method: "POST" }).then(() => {
      el.collectionBadge.hidden = true;
    });
  } finally {
    el.collectionButton.disabled = false;
    if (pendingCollectionOpen === token) pendingCollectionOpen = null;
  }
}

el.collectionButton.addEventListener("click", () => openCollection(el.collectionButton));
el.collectionClose.addEventListener("click", closeActiveModal);

// --- interaction ---

el.scene.addEventListener("click", (event) => {
  // A collectible sits visually among a plant's leaves but must never also
  // open the enlarged view — it stops the click from reaching the plant
  // button underneath it.
  if (event.target.closest(".collectible")) return;
  const slot = event.target.closest(".plant-slot");
  if (!slot) return;
  slot.classList.add("just-clicked");
  setTimeout(() => slot.classList.remove("just-clicked"), 400);
  openDetail(slot.dataset.plant, slot);
});

// Treasures only — a bug is now a real, directly-clickable thing sitting on
// its plant (see createCollectibleButton/renderDetailBugOverlay), so the
// generic "random catch" button no longer claims one on a visitor's behalf.
el.forageButton.addEventListener("click", () => claimCollectible({ triggerButton: el.forageButton, filter: { kind: "treasure" } }));

el.hintDismiss.addEventListener("click", () => {
  el.hint.hidden = true;
  try {
    localStorage.setItem("tend-hint-dismissed", "1");
  } catch {
    // private browsing / blocked storage — the hint just won't remember; no feedback depends on it.
  }
});
try {
  if (!localStorage.getItem("tend-hint-dismissed")) el.hint.hidden = false;
} catch {
  el.hint.hidden = false;
}

// --- lightweight ambient animation (skipped entirely under reduced motion,
// aside from state feedback which stays in text/colour regardless) ---

function spawnLeaf(anchor, color) {
  if (reduceMotion) return;
  const leaf = document.createElement("div");
  leaf.className = "falling-leaf";
  leaf.style.left = `${(anchor.x / 120) * 100}%`;
  leaf.style.top = `${(anchor.y / 160) * 100}%`;
  leaf.style.setProperty("--leaf-color", color);
  leaf.style.setProperty("--drift", `${(Math.random() - 0.5) * 40}px`);
  el.leafFallLayer.appendChild(leaf);
  leaf.addEventListener("animationend", () => leaf.remove());
}

function leafFallTick() {
  if (!state || reduceMotion) return;
  for (const id of SPECIES_ORDER) {
    const plant = state.garden[id];
    // Healthy plants rarely drop a leaf; neglected ones a bit more — never a
    // flood, since this only ever considers one candidate leaf per tick.
    const chance = { thriving: 0.01, thirsty: 0.03, wilting: 0.07, dormant: 0.12 }[plant.stage] ?? 0;
    if (Math.random() > chance) continue;
    const slot = el.scene.querySelector(`.plant-slot[data-plant="${id}"]`);
    const anchors = JSON.parse(slot.dataset.anchors || "[]");
    if (anchors.length === 0) continue;
    const anchor = anchors[Math.floor(Math.random() * anchors.length)];
    const rect = slot.getBoundingClientRect();
    const sceneRect = el.scene.getBoundingClientRect();
    const originX = rect.left - sceneRect.left + (anchor.x / 120) * rect.width;
    const originY = rect.top - sceneRect.top + (anchor.y / 160) * rect.height;
    spawnLeaf({ x: (originX / sceneRect.width) * 120, y: (originY / sceneRect.height) * 160 }, VITALITY[plant.stage].leaf);
  }
}

function spawnRipple(slot) {
  if (reduceMotion) return;
  const ripple = document.createElement("div");
  ripple.className = "water-ripple";
  slot.appendChild(ripple);
  ripple.addEventListener("animationend", () => ripple.remove());
}

function spawnSparkle() {
  if (reduceMotion) return;
  const sparkle = document.createElement("div");
  sparkle.className = "forage-sparkle";
  sparkle.style.left = `${40 + Math.random() * 20}%`;
  el.scene.appendChild(sparkle);
  sparkle.addEventListener("animationend", () => sparkle.remove());
}

function playWaterFeedback(plantId, grewAStage) {
  const slot = el.scene.querySelector(`.plant-slot[data-plant="${plantId}"]`);
  spawnRipple(slot);
  slot.classList.add("just-watered");
  setTimeout(() => slot.classList.remove("just-watered"), 1200);
  if (grewAStage) {
    slot.classList.add("new-stage");
    setTimeout(() => slot.classList.remove("new-stage"), 1600);
  }
}

function spawnRaindrop() {
  if (reduceMotion || !state || state.event !== "rain") return;
  const drop = document.createElement("div");
  drop.className = "raindrop";
  drop.style.left = `${Math.random() * 100}%`;
  el.weatherLayer.appendChild(drop);
  drop.addEventListener("animationend", () => drop.remove());
}

function spawnButterfly() {
  if (reduceMotion || !state || state.event !== "butterfly") return;
  if (el.weatherLayer.querySelector(".butterfly")) return; // one at a time
  const butterfly = document.createElement("div");
  butterfly.className = "butterfly";
  butterfly.textContent = "🦋";
  el.weatherLayer.appendChild(butterfly);
  butterfly.addEventListener("animationend", () => butterfly.remove());
}

// --- boot ---

loadState();
connectLive();
refreshCollectionBadge();
setInterval(loadState, 20_000); // keeps decay-driven water level in sync without a push event for it
if (!reduceMotion) {
  setInterval(leafFallTick, 4000);
  setInterval(spawnRaindrop, 600);
  setInterval(spawnButterfly, 7000);
}
// Collectibles themselves are no longer spawned client-side at all — the
// server decides when (see maybeSpawnCollectibles), and loadState/the WS
// push are what bring new ones (and removed ones) into view here.
// A 3-second cooldown needs a finer tick than the old 4-hour one did to
// actually count down live in the open panel, rather than visibly sticking.
setInterval(() => {
  if (selectedPlant) renderDetailPanel();
}, 1000);
window.addEventListener("resize", () => renderCollectibles());
