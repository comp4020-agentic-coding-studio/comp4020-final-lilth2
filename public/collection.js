// Display info for the personal collection — purely presentational (name,
// description, icon). The IDs here must exactly match garden.ts's
// COLLECTIBLES on the server; that file is the source of truth for which
// IDs exist and which group each belongs to, since the server also needs
// to validate/pick them. This file only adds what a server module has no
// business owning: how each one reads to a person looking at it.
export const COLLECTIBLE_INFO = {
  ladybug: { label: "Ladybug", icon: "🐞", description: "A lucky little visitor with spotted wings." },
  butterfly: { label: "Butterfly", icon: "🦋", description: "Drifts between blossoms on quiet afternoons." },
  bee: { label: "Bee", icon: "🐝", description: "Busy, humming, never far from a flower." },
  snail: { label: "Snail", icon: "🐌", description: "Takes its time, and gets there anyway." },
  ant: { label: "Ant", icon: "🐜", description: "Small, steady, and never alone for long." },
  beetle: { label: "Beetle", icon: "🪲", description: "Armoured and unhurried among the roots." },
  "glowing-seed": { label: "Glowing Seed", icon: "✨", description: "Warm to the touch, for reasons nobody's explained." },
  pebble: { label: "Pretty Pebble", icon: "🪨", description: "Smooth, striped, worth a second look." },
  clover: { label: "Four-Leaf Clover", icon: "🍀", description: "The rare one, hiding in plain sight." },
  acorn: { label: "Acorn", icon: "🌰", description: "A whole tree's worth of patience in one small shell." },
  feather: { label: "Feather", icon: "🪶", description: "Dropped by something that flew over this morning." },
  seashell: { label: "Seashell", icon: "🐚", description: "An odd thing to find in a garden — and yet." },
};

export const GROUP_LABELS = { insect: "Insects", treasure: "Treasures" };
