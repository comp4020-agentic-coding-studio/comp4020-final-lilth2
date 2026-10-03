import { describe, expect, it } from "vitest";
import { isDroughtActive, stageFor } from "../stage.ts";

// Pure math, tested against synthetic clocks — no need to wait real minutes,
// or to spin up the app, to check the decay curve is what PROCESS.md claims.
describe("stageFor", () => {
  it("reads as thriving right after watering", () => {
    expect(stageFor(0, false)).toBe("thriving");
  });

  it("moves through each stage as time passes, outside a drought", () => {
    expect(stageFor(9, false)).toBe("thriving");
    expect(stageFor(10, false)).toBe("thirsty");
    expect(stageFor(29, false)).toBe("thirsty");
    expect(stageFor(30, false)).toBe("wilting");
    expect(stageFor(89, false)).toBe("wilting");
    expect(stageFor(90, false)).toBe("dormant");
    expect(stageFor(10_000, false)).toBe("dormant");
  });

  it("decays roughly three times faster during a drought", () => {
    expect(stageFor(3, true)).toBe("thirsty");
    expect(stageFor(10, true)).toBe("wilting");
    expect(stageFor(30, true)).toBe("dormant");
  });
});

describe("isDroughtActive", () => {
  it("is active in the last quarter of every UTC hour", () => {
    expect(isDroughtActive(new Date("2026-01-01T04:44:59Z"))).toBe(false);
    expect(isDroughtActive(new Date("2026-01-01T04:45:00Z"))).toBe(true);
    expect(isDroughtActive(new Date("2026-01-01T04:59:59Z"))).toBe(true);
  });

  it("is quiet for the rest of the hour, any hour", () => {
    expect(isDroughtActive(new Date("2026-06-15T13:00:00Z"))).toBe(false);
    expect(isDroughtActive(new Date("2026-06-15T13:30:00Z"))).toBe(false);
  });
});
