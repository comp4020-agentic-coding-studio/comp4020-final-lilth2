# Working rules for this repo

- **Keep the scope to what the current crit actually asks for.** Crit 9 is
  real-time plus one documented concurrency decision — don't pre-build
  crit 10's server-side logging dashboard now just because it's easy while
  you're in here. Note what's deferred in `PROCESS.md` instead of building it.
- **The spec in `spec/` is fixed; everything else is mine to decide and you
  to implement.** Don't weaken or delete `spec/invariants.test.ts`. New
  checks go in new files.
- **No native/compiled dependencies if a built-in or pure-JS option covers
  it.** This app runs in a 256 MB container; `node:sqlite` over
  `better-sqlite3`, pure-JS libraries over anything with a native build step.
- **Verify persistence by hand, not just by reading the code.** Before
  trusting that something survives a restart or redeploy, actually kill the
  process and bring it back against the same data, and say so in
  `PROCESS.md` if that's how it was checked.
- **`README.md` and `PROCESS.md` are rewritten, not appended to, at each
  crit.** Don't leave stale sections from a prior week sitting alongside new
  ones.
- **Commit as the work happens, in small steps.** Don't batch a week's work
  into one commit — the commit history is part of what's marked.
- **Never commit secrets.** The Fly token lives in `mise.local.toml`
  (gitignored) or CI secrets, never in a tracked file.
