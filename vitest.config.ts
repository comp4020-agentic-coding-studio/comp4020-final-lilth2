import { defineConfig } from "vitest/config";

// Every test in spec/ runs against the running app, which spec/global-setup.ts
// finds. Only spec/ runs: a test anywhere else needs adding to `include`.
//
// Every spec file shares that one running app, and the plant it holds is one
// global row — exactly the thing this app is for. Vitest's default is to run
// test *files* in parallel, which is fine for isolated unit tests but races
// any two files that both touch /api/water and check the shared counter's
// exact value, not just their own visitor's. `fileParallelism: false` runs
// files one at a time instead, which matches the live app's actual shape.
export default defineConfig({
  test: {
    include: ["spec/**/*.test.ts"],
    globalSetup: ["./spec/global-setup.ts"],
    fileParallelism: false,
  },
});
