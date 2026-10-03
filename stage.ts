// Pure decay math, with no side effects, so it can be unit-tested directly
// against synthetic clocks instead of waiting real minutes inside an HTTP
// test. server.ts is the only thing that touches the database or the clock
// for real.
export type Stage = "thriving" | "thirsty" | "wilting" | "dormant";

// Decay is a pure function of wall-clock time, recomputed on every request —
// nothing runs in the background, because the Fly machine stops when idle
// and a timer would just never fire. Thresholds are compressed like a
// digital pet's clock (the README's own reference point) so neglect is
// visible within a single sitting, not over real days.
export const THRESHOLDS: Record<"normal" | "drought", Record<Exclude<Stage, "dormant">, number>> = {
  normal: { thriving: 10, thirsty: 30, wilting: 90 },
  drought: { thriving: 3, thirsty: 10, wilting: 30 },
};

// Deterministic, not stored: the last quarter of every UTC hour is a
// drought, so the state is identical for every visitor and every process
// without a scheduler. Also makes it demoable live — wait at most an hour
// and you'll see one start.
export function isDroughtActive(now: Date): boolean {
  return now.getUTCMinutes() >= 45;
}

export function stageFor(minutesSince: number, isDrought: boolean): Stage {
  const t = isDrought ? THRESHOLDS.drought : THRESHOLDS.normal;
  if (minutesSince < t.thriving) return "thriving";
  if (minutesSince < t.thirsty) return "thirsty";
  if (minutesSince < t.wilting) return "wilting";
  return "dormant";
}
