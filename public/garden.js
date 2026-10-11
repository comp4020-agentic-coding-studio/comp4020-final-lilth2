// Garden plant art: one small config object per species, plus generic
// renderers shared across species of the same "kind" (tree-like, bamboo,
// shrub, fern). Nothing here is copy-pasted five times with only a colour
// changed — a stage advances by adding real structure (another branch,
// another culm, another frond), which is what the brief asks for.
//
// Every shape is built from plain SVG primitives (lines, circles, paths) at
// a fixed 0–120 x 0–160 viewBox, trunk/base always at (60, 140). Vitality
// (current care state) reuses the exact four colours and thresholds already
// established for Tend's single plant — this is a direct extension of that
// mapping, not a new one: thriving/thirsty/wilting/dormant keep their
// existing meaning, now expressed as leaf colour, droop, and leaf density
// instead of one blob's scale and colour.

export const VITALITY = {
  thriving: { leaf: "#2f6b3f", droop: 0, density: 1, label: "Fully watered" },
  thirsty: { leaf: "#8a9a3f", droop: 4, density: 0.9, label: "Getting thirsty" },
  wilting: { leaf: "#b98f2c", droop: 10, density: 0.7, label: "Wilting" },
  dormant: { leaf: "#6b5338", droop: 16, density: 0.5, label: "Dormant" },
};

// All five species share one set of growth-stage names (same baseline) —
// what differs between species is the *shape* at each stage, built by the
// per-species stage configs below, never the label. Ancient is the sixth,
// added alongside the much higher growth thresholds: every species gets a
// visibly more elaborate final shape, not just a bigger version of Mature.
export const STAGE_NAMES = ["Seedling", "Young", "Growing", "Large", "Mature", "Ancient"];

const TRUNK_COLOR = "#5b4330";
const BASE_X = 60;
const BASE_Y = 140;

function polar(cx, cy, angleDeg, radius) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + radius * Math.sin(rad), y: cy - radius * Math.cos(rad) };
}

// A small deterministic jitter so leaf clusters don't look like a perfect
// grid, without needing real randomness (keeps renders stable/testable).
function jitter(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function leafDot(x, y, r, color, seed) {
  const dx = (jitter(seed) - 0.5) * r * 0.6;
  const dy = (jitter(seed + 7) - 0.5) * r * 0.6;
  return { markup: `<circle class="leaf" cx="${x + dx}" cy="${y + dy}" r="${r * (0.6 + jitter(seed + 3) * 0.5)}" fill="${color}" />`, x: x + dx, y: y + dy };
}

// A pointed-oval/teardrop leaf outline, centred on its own origin so it can
// be positioned and rotated with a `transform` — used by the tree's leaf
// clusters below instead of plain circles, with a thin vein on the larger
// ones for a bit of texture.
function leafOutline(size) {
  return (
    `M 0,${(-size).toFixed(2)} ` +
    `C ${(size * 0.62).toFixed(2)},${(-size * 0.42).toFixed(2)} ${(size * 0.6).toFixed(2)},${(size * 0.5).toFixed(2)} 0,${size.toFixed(2)} ` +
    `C ${(-size * 0.6).toFixed(2)},${(size * 0.5).toFixed(2)} ${(-size * 0.62).toFixed(2)},${(-size * 0.42).toFixed(2)} 0,${(-size).toFixed(2)} Z`
  );
}

// Shifts a hex colour toward white (amt > 0) or black (amt < 0) — just
// enough per-leaf variance for the canopy to read as layered rather than
// one flat tint, without needing real image assets.
function shadeColor(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const mix = (c) => Math.max(0, Math.min(255, Math.round(amt >= 0 ? c + (255 - c) * amt : c + c * amt)));
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

// A handful of leaves clustered around one point — what a branch tip
// actually looks like, instead of a single dot. Returns both the markup and
// the cluster's own centre, which is what the caller uses as a collectible
// anchor (a real surface to sit a bug on, not empty space).
function leafCluster(cx, cy, count, color, seed) {
  let markup = "";
  for (let i = 0; i < count; i++) {
    const angleDeg = jitter(seed + i * 2) * 360;
    const dist = jitter(seed + i * 2 + 1) * 3.4;
    const px = cx + Math.cos((angleDeg * Math.PI) / 180) * dist;
    const py = cy + Math.sin((angleDeg * Math.PI) / 180) * dist;
    const size = 2.6 + jitter(seed + i + 40) * 1.8;
    const rot = jitter(seed + i + 80) * 360;
    const shade = (jitter(seed + i + 120) - 0.5) * 0.3;
    const fill = shadeColor(color, shade);
    markup += `<path class="leaf" d="${leafOutline(size)}" fill="${fill}" transform="translate(${px.toFixed(2)}, ${py.toFixed(2)}) rotate(${rot.toFixed(1)})" />`;
    if (size > 3.2) {
      markup += `<line class="leaf-vein" x1="0" y1="${(-size * 0.7).toFixed(2)}" x2="0" y2="${(size * 0.7).toFixed(2)}" stroke="${shadeColor(color, -0.35)}" stroke-width="0.35" transform="translate(${px.toFixed(2)}, ${py.toFixed(2)}) rotate(${rot.toFixed(1)})" />`;
    }
  }
  return markup;
}

// --- Tree-like (main tree, fruit tree): a tapered trunk with real branches
// and sub-branches, each ending in a leaf cluster rather than loose dots —
// the branch tips are placed on a dome-shaped curve (shorter near the
// outside, taller near the centre) so the clusters read as one continuous
// crown instead of a fan of equal spokes. `bearsFruit` is the only
// difference between the Tree and the Fruit Tree: blossoms/fruit accent the
// same leaf clusters on whichever species asks for them — the Tree itself
// never grows any, so the two stay visually distinct.
function renderNaturalTree(stage, vitality, { bearsFruit = false } = {}) {
  const top = BASE_Y - stage.trunkHeight;
  const parts = [];
  const anchors = [];

  parts.push(
    `<path class="trunk" d="M ${BASE_X - stage.trunkWidth / 2} ${BASE_Y} ` +
      `L ${BASE_X - stage.trunkWidth / 3} ${top} ` +
      `L ${BASE_X + stage.trunkWidth / 3} ${top} ` +
      `L ${BASE_X + stage.trunkWidth / 2} ${BASE_Y} Z" fill="${TRUNK_COLOR}" />`,
  );
  // A little bark texture once there's enough trunk width for it to read as
  // texture rather than clutter.
  if (stage.trunkWidth >= 6) {
    for (let i = 0; i < 3; i++) {
      const y0 = BASE_Y - stage.trunkHeight * (0.2 + i * 0.22);
      const y1 = y0 - stage.trunkHeight * 0.12;
      parts.push(`<line class="bark" x1="${BASE_X - 1}" y1="${y0}" x2="${BASE_X - 0.6}" y2="${y1}" stroke="#3f2f22" stroke-width="0.6" opacity="0.5" />`);
    }
  }

  const branchCount = stage.branchAngles.length;

  // A seedling has no branches yet, but still shows a few clear leaves at
  // its tip rather than looking bare.
  if (branchCount === 0 && stage.canopyDots > 0) {
    const cluster = leafCluster(BASE_X, top, Math.round(stage.canopyDots * vitality.density), vitality.leaf, 5);
    parts.push(cluster);
    anchors.push({ x: BASE_X, y: top });
  }

  const perBranchLeaves = branchCount > 0 ? Math.max(1, Math.round(stage.canopyDots / branchCount)) : 0;

  stage.branchAngles.forEach((angle, i) => {
    const t = (i + 1) / (branchCount + 1);
    const originY = BASE_Y - stage.trunkHeight * (0.3 + 0.6 * t);
    // Dome silhouette: branches closer to vertical (small |angle|) reach
    // further than the outer ones.
    const angleFrac = Math.min(1, Math.abs(angle) / 70);
    const len = stage.canopyRadius * (0.6 + 0.35 * (1 - angleFrac)) + 5;
    const droopedAngle = angle + (angle >= 0 ? vitality.droop : -vitality.droop) * 0.5;
    const end = polar(BASE_X, originY, droopedAngle, len);
    const branchWidth = Math.max(1, 2.4 - i * 0.1);

    let branchMarkup = `<line class="branch" x1="${BASE_X}" y1="${originY}" x2="${end.x.toFixed(2)}" y2="${end.y.toFixed(2)}" stroke="${TRUNK_COLOR}" stroke-width="${branchWidth.toFixed(2)}" stroke-linecap="round" />`;

    // Sub-branches only once the tree has enough structure to need them —
    // a slightly asymmetric split partway along every other main branch,
    // never a mirrored pair.
    const clusterPoints = [end];
    if (stage.subBranches && i % 2 === 0) {
      const mid = polar(BASE_X, originY, droopedAngle, len * 0.58);
      const subAngle = droopedAngle + (i % 4 === 0 ? 24 : -20);
      const subEnd = polar(mid.x, mid.y, subAngle, len * 0.48);
      branchMarkup += `<line class="branch" x1="${mid.x.toFixed(2)}" y1="${mid.y.toFixed(2)}" x2="${subEnd.x.toFixed(2)}" y2="${subEnd.y.toFixed(2)}" stroke="${TRUNK_COLOR}" stroke-width="${Math.max(1, branchWidth - 0.7).toFixed(2)}" stroke-linecap="round" />`;
      clusterPoints.push(subEnd);
    }

    const leavesPerPoint = Math.max(1, Math.round((perBranchLeaves * vitality.density) / clusterPoints.length));
    clusterPoints.forEach((pt, ci) => {
      branchMarkup += leafCluster(pt.x, pt.y, leavesPerPoint, vitality.leaf, i * 17 + ci * 23 + 1);
      anchors.push(pt);
    });

    parts.push(`<g class="sway-branch sway-delay-${i % 4}" style="transform-origin:${BASE_X}px ${originY.toFixed(2)}px">${branchMarkup}</g>`);
  });

  if (bearsFruit) {
    for (let i = 0; i < Math.round(stage.blossoms * vitality.density); i++) {
      const target = anchors[i % Math.max(1, anchors.length)] ?? { x: BASE_X, y: top };
      const p = polar(target.x, target.y, (360 / Math.max(1, stage.blossoms)) * i, 3.2);
      parts.push(`<circle class="blossom" cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="2.2" fill="#f4c6d9" />`);
    }
    for (let i = 0; i < Math.round(stage.fruits * vitality.density); i++) {
      const target = anchors[i % Math.max(1, anchors.length)] ?? { x: BASE_X, y: top };
      const p = polar(target.x, target.y, (360 / Math.max(1, stage.fruits)) * i + 40, 3.6);
      parts.push(`<circle class="fruit" cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="2.6" fill="#c0482f" />`);
    }
  }

  return { markup: parts.join(""), anchors: anchors.length ? anchors : [{ x: BASE_X, y: top }] };
}

const renderTreeLike = (stage, vitality) => renderNaturalTree(stage, vitality, { bearsFruit: false });
const renderFruitTree = (stage, vitality) => renderNaturalTree(stage, vitality, { bearsFruit: true });

// --- Bamboo: segmented culms, leaf clusters sprouting near the top of each ---
function renderBamboo(stage, vitality) {
  const parts = [];
  const anchors = [];
  const spread = stage.culms > 1 ? 10 : 0;
  for (let c = 0; c < stage.culms; c++) {
    const x = BASE_X + (c - (stage.culms - 1) / 2) * spread;
    const segH = stage.height / stage.segments;
    const groupClass = `sway-branch sway-delay-${c % 4}`;
    let culmMarkup = "";
    for (let s = 0; s < stage.segments; s++) {
      const y0 = BASE_Y - s * segH;
      const y1 = BASE_Y - (s + 1) * segH;
      culmMarkup += `<line class="culm" x1="${x}" y1="${y0}" x2="${x}" y2="${y1}" stroke="#5a8a4f" stroke-width="3" />`;
      culmMarkup += `<line class="culm-node" x1="${x - 2.5}" y1="${y1}" x2="${x + 2.5}" y2="${y1}" stroke="#3f6b3a" stroke-width="1.4" />`;
    }
    const top = BASE_Y - stage.height;
    parts.push(`<g class="${groupClass}" style="transform-origin:${x}px ${BASE_Y}px">${culmMarkup}</g>`);
    anchors.push({ x, y: top });
  }

  for (let i = 0; i < stage.leafClusters; i++) {
    const c = i % stage.culms;
    const x = BASE_X + (c - (stage.culms - 1) / 2) * spread;
    const yFrac = 0.3 + (i / stage.leafClusters) * 0.6;
    const y = BASE_Y - stage.height * yFrac;
    const side = i % 2 === 0 ? 1 : -1;
    const droop = vitality.droop * 0.4;
    for (let k = 0; k < 3; k++) {
      const tipX = x + side * (10 + k * 2);
      const tipY = y - 4 + k * 3 + droop;
      parts.push(
        `<path class="leaf-blade" d="M ${x} ${y} Q ${x + side * 6} ${y - 6} ${tipX} ${tipY}" stroke="${vitality.leaf}" stroke-width="2.4" fill="none" stroke-linecap="round" />`,
      );
    }
    anchors.push({ x, y });
  }
  return { markup: parts.join(""), anchors };
}

// --- Flowering shrub: branches fanning from one base point, buds then blooms ---
function renderShrub(stage, vitality) {
  const parts = [];
  const anchors = [];
  for (let i = 0; i < stage.branches; i++) {
    const angle = -80 + (160 / Math.max(1, stage.branches - 1)) * i;
    const droopedAngle = angle + (angle >= 0 ? vitality.droop : -vitality.droop) * 0.6;
    const end = polar(BASE_X, BASE_Y, droopedAngle, stage.branchLen);
    parts.push(
      `<g class="sway-branch sway-delay-${i % 4}" style="transform-origin:${BASE_X}px ${BASE_Y}px">` +
        `<line class="branch" x1="${BASE_X}" y1="${BASE_Y}" x2="${end.x}" y2="${end.y}" stroke="${TRUNK_COLOR}" stroke-width="1.8" stroke-linecap="round" />` +
        leafDot(end.x, end.y, 3.6, vitality.leaf, i).markup +
        `</g>`,
    );
    anchors.push(end);
  }
  for (let i = 0; i < Math.round(stage.buds * vitality.density); i++) {
    const angle = -70 + (140 / Math.max(1, stage.buds)) * i;
    const p = polar(BASE_X, BASE_Y, angle, stage.branchLen * 0.7);
    parts.push(`<circle class="bud" cx="${p.x}" cy="${p.y}" r="2" fill="#d98fb0" />`);
  }
  for (let i = 0; i < Math.round(stage.blooms * vitality.density); i++) {
    const angle = -75 + (150 / Math.max(1, stage.blooms)) * i;
    const p = polar(BASE_X, BASE_Y, angle, stage.branchLen * 0.9);
    parts.push(
      `<g class="bloom"><circle cx="${p.x}" cy="${p.y}" r="3.4" fill="#f2a9c7" />` +
        `<circle cx="${p.x}" cy="${p.y}" r="1.2" fill="#fff0bb" /></g>`,
    );
  }
  return { markup: parts.join(""), anchors: anchors.length ? anchors : [{ x: BASE_X, y: BASE_Y - 10 }] };
}

// --- Fern: fronds unfurling from a base crown, more fronds each stage ---
function renderFern(stage, vitality) {
  const parts = [];
  const anchors = [];
  for (let i = 0; i < stage.fronds; i++) {
    const angle = -85 + (170 / Math.max(1, stage.fronds - 1)) * i;
    const droopedAngle = angle + (angle >= 0 ? vitality.droop : -vitality.droop) * 0.5;
    const mid = polar(BASE_X, BASE_Y, droopedAngle, stage.length * 0.55);
    const curlAngle = droopedAngle + (angle >= 0 ? 35 : -35) * stage.curl;
    const tip = polar(mid.x, mid.y, curlAngle, stage.length * 0.5);
    const frondColor = vitality.leaf;
    parts.push(
      `<g class="sway-branch sway-delay-${i % 4}" style="transform-origin:${BASE_X}px ${BASE_Y}px">` +
        `<path class="frond" d="M ${BASE_X} ${BASE_Y} Q ${mid.x} ${mid.y} ${tip.x} ${tip.y}" stroke="${frondColor}" stroke-width="2" fill="none" stroke-linecap="round" />`,
    );
    const legletCount = Math.round(4 * vitality.density);
    for (let l = 1; l <= legletCount; l++) {
      const f = l / (legletCount + 1);
      const px = BASE_X + (tip.x - BASE_X) * f;
      const py = BASE_Y + (tip.y - BASE_Y) * f;
      const legSide = i % 2 === 0 ? 1 : -1;
      const leg = polar(px, py, droopedAngle + legSide * 90, 4);
      parts.push(`<line x1="${px}" y1="${py}" x2="${leg.x}" y2="${leg.y}" stroke="${frondColor}" stroke-width="1.2" />`);
    }
    parts.push(`</g>`);
    anchors.push(tip);
  }
  return { markup: parts.join(""), anchors };
}

const RENDERERS = { tree: renderTreeLike, fruit: renderFruitTree, bamboo: renderBamboo, shrub: renderShrub, fern: renderFern };

export const SPECIES = {
  tree: {
    label: "Tree",
    kind: "tree",
    // Never bears blossoms/fruit at any stage — that's reserved for Fruit
    // Tree, so the two species stay visually distinct instead of looking
    // like the same tree twice.
    stages: [
      { trunkHeight: 18, trunkWidth: 3.5, branchAngles: [], canopyRadius: 0, canopyDots: 3, blossoms: 0, fruits: 0, subBranches: false },
      { trunkHeight: 32, trunkWidth: 5.5, branchAngles: [-35, 35], canopyRadius: 10, canopyDots: 8, blossoms: 0, fruits: 0, subBranches: false },
      { trunkHeight: 48, trunkWidth: 7.5, branchAngles: [-48, -16, 18, 48], canopyRadius: 17, canopyDots: 16, blossoms: 0, fruits: 0, subBranches: false },
      { trunkHeight: 62, trunkWidth: 10.5, branchAngles: [-58, -32, -9, 14, 36, 60], canopyRadius: 23, canopyDots: 26, blossoms: 0, fruits: 0, subBranches: true },
      { trunkHeight: 72, trunkWidth: 14, branchAngles: [-62, -42, -22, -6, 9, 26, 44, 64], canopyRadius: 28, canopyDots: 34, blossoms: 0, fruits: 0, subBranches: true },
      { trunkHeight: 80, trunkWidth: 18, branchAngles: [-66, -50, -32, -17, -5, 7, 19, 34, 50, 67], canopyRadius: 34, canopyDots: 46, blossoms: 0, fruits: 0, subBranches: true },
    ],
  },
  fruit: {
    label: "Fruit Tree",
    kind: "fruit",
    stages: [
      { trunkHeight: 11, trunkWidth: 2.5, branchAngles: [], canopyRadius: 0, canopyDots: 3, blossoms: 0, fruits: 0, subBranches: false },
      { trunkHeight: 19, trunkWidth: 3.5, branchAngles: [-30, 30], canopyRadius: 8, canopyDots: 6, blossoms: 0, fruits: 0, subBranches: false },
      { trunkHeight: 27, trunkWidth: 4.5, branchAngles: [-40, 0, 40], canopyRadius: 12, canopyDots: 10, blossoms: 6, fruits: 0, subBranches: false },
      { trunkHeight: 33, trunkWidth: 5.5, branchAngles: [-45, -15, 15, 45], canopyRadius: 15, canopyDots: 15, blossoms: 5, fruits: 5, subBranches: true },
      { trunkHeight: 37, trunkWidth: 6.5, branchAngles: [-50, -25, 0, 25, 50], canopyRadius: 17, canopyDots: 19, blossoms: 6, fruits: 9, subBranches: true },
      { trunkHeight: 42, trunkWidth: 8.5, branchAngles: [-55, -32, -12, 8, 30, 52], canopyRadius: 21, canopyDots: 24, blossoms: 8, fruits: 15, subBranches: true },
    ],
  },
  bamboo: {
    label: "Bamboo",
    kind: "bamboo",
    stages: [
      { culms: 1, segments: 2, leafClusters: 1, height: 18 },
      { culms: 1, segments: 4, leafClusters: 2, height: 32 },
      { culms: 2, segments: 5, leafClusters: 3, height: 46 },
      { culms: 3, segments: 6, leafClusters: 5, height: 60 },
      { culms: 4, segments: 7, leafClusters: 7, height: 72 },
      { culms: 6, segments: 8, leafClusters: 10, height: 86 },
    ],
  },
  shrub: {
    label: "Flowering Shrub",
    kind: "shrub",
    stages: [
      { branches: 3, branchLen: 9, buds: 0, blooms: 0 },
      { branches: 5, branchLen: 13, buds: 3, blooms: 0 },
      { branches: 8, branchLen: 17, buds: 5, blooms: 2 },
      { branches: 11, branchLen: 20, buds: 4, blooms: 6 },
      { branches: 14, branchLen: 23, buds: 2, blooms: 12 },
      { branches: 18, branchLen: 27, buds: 1, blooms: 18 },
    ],
  },
  fern: {
    label: "Fern",
    kind: "fern",
    stages: [
      { fronds: 2, curl: 0.9, length: 12 },
      { fronds: 3, curl: 0.6, length: 18 },
      { fronds: 5, curl: 0.35, length: 24 },
      { fronds: 7, curl: 0.15, length: 29 },
      { fronds: 9, curl: 0, length: 33 },
      { fronds: 12, curl: 0, length: 37 },
    ],
  },
};

export const SPECIES_ORDER = ["tree", "bamboo", "shrub", "fern", "fruit"];

// Growth stages are otherwise a step function — all-or-nothing at each
// threshold — which is fine for structure (a new branch is a real event),
// but left every watering in between looking identical. This nudges the
// *numeric* fields (leaf/bud/bloom counts, trunk size — never array fields
// like branchAngles, which stay the current stage's actual structure) partway
// toward next stage's fuller values as `progress` (0-1 within the current
// stage) advances, capped under 1 so crossing the real threshold still reads
// as a visible step up rather than already being there.
function interpolateStage(current, next, progress) {
  const t = Math.max(0, Math.min(1, progress)) * 0.6;
  if (t === 0) return current;
  const blended = { ...current };
  for (const key of Object.keys(current)) {
    if (typeof current[key] === "number" && typeof next[key] === "number") {
      blended[key] = current[key] + (next[key] - current[key]) * t;
    }
  }
  return blended;
}

export function renderPlant(speciesId, stageIndex, stageVitality, progressToNext = 0) {
  const species = SPECIES[speciesId];
  const clampedIndex = Math.min(stageIndex, species.stages.length - 1);
  const isFinalStage = clampedIndex >= species.stages.length - 1;
  const stage = species.stages[clampedIndex];
  const nextStage = species.stages[Math.min(clampedIndex + 1, species.stages.length - 1)];
  const blendedStage = isFinalStage ? stage : interpolateStage(stage, nextStage, progressToNext);
  const vitality = VITALITY[stageVitality] ?? VITALITY.thriving;
  const renderer = RENDERERS[species.kind];
  return { ...renderer(blendedStage, vitality), stageName: STAGE_NAMES[clampedIndex] };
}

// Small, purely decorative extras unlocked by achievements. Never affects
// growth or watering — just adds something to look at.
export function renderDecoration(id, x, y) {
  if (id === "stone-path") {
    return `<g class="decoration"><ellipse cx="${x}" cy="${y}" rx="5" ry="2.4" fill="#9a9488"/><ellipse cx="${x + 9}" cy="${y + 2}" rx="4" ry="2" fill="#8d8779"/></g>`;
  }
  if (id === "stepping-stones") {
    return `<g class="decoration"><ellipse cx="${x}" cy="${y}" rx="4.5" ry="2.2" fill="#a3a28f"/></g>`;
  }
  if (id === "fireflies") {
    return `<g class="decoration firefly-group">${[0, 1, 2]
      .map((i) => `<circle class="firefly firefly-${i}" cx="${x + i * 7 - 7}" cy="${y - 10 - i * 4}" r="1.6" fill="#f5e37a" />`)
      .join("")}</g>`;
  }
  return "";
}
