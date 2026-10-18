# Working rules for this repo

- **Keep the scope to what the current crit actually asks for.** Note what's
  deferred in `PROCESS.md` instead of building it early.
- **The spec in `spec/` is fixed; everything else is mine to decide and you
  to implement.** Don't weaken or delete `spec/invariants.test.ts`. New
  checks go in new files.
- **No native/compiled dependencies if a built-in or pure-JS option covers
  it.** This app runs in a 256 MB container; `node:sqlite` over
  `better-sqlite3`, pure-JS libraries over anything with a native build step.
- **Verify persistence by hand, not just by reading the code.** Before
  trusting that something survives a restart or redeploy, actually kill the
  process and bring it back against the same data, and say so in
  `PROCESS.md` if that's how it was checked. The same applies to log
  retention: a claim that logging "outlives the crit" needs to be checked
  against the real Fly deploy after a real machine auto-stop, not assumed
  from reading `fly.toml`.
- **`README.md` and `PROCESS.md` are rewritten, not appended to, at each
  crit.** Don't leave stale sections from a prior week sitting alongside new
  ones.
- **Commit as the work happens, in small steps.** Don't batch a week's work
  into one commit — the commit history is part of what's marked.
- **Never commit secrets.** The Fly token lives in `mise.local.toml`
  (gitignored) or CI secrets, never in a tracked file.

## Identity and permissions (added crit 10)

- **Never trust an identity field from a request body.** Every write handler
  derives "who is this" from `visitorIdOf(req)`'s cookie-verified value,
  full stop — not from `body.visitorId`, `body.actorPublicId`, or anything
  else a client could claim. `spec/spoofing.test.ts` exists specifically to
  catch a future regression here, both behaviourally and by a direct source
  check of which `body.` fields `server.ts` reads; if you ever need a new
  body field, check it isn't one of these before adding it, and widen that
  test's allowlist deliberately if it genuinely is a new non-identity
  parameter.
- **`visitor_id` (the session cookie) and `public_id` (the display codename)
  never cross.** `visitor_id` must never appear in a log line, a broadcast
  payload, or anywhere in the UI. If you're tempted to log "who did this" for
  debugging, use `identityOf(visitorId)`'s return value, never the raw id.
- **A log line that says "success" must only be written after its database
  write has actually committed.** Never log a success speculatively, before
  the write that makes it true. This matters because `logEvent()` is also
  the thing a crit presenter narrates from — a line that doesn't match what
  actually persisted is worse than no line at all.
- **The public care feed (`care_feed`) and the protected audit log
  (`audit_log`) are two separate tables for a reason.** Never add a field to
  `care_feed` that isn't already categorically public-shared data (which
  plant, how much growth, which catalog item) — if it's anything about a
  specific visitor's quota, session, or full collection, it belongs in
  `audit_log` only, which is never reachable over HTTP outside a gated test
  endpoint.
- **One call site per event.** `logEvent()` is the only thing that writes to
  `audit_log`; `recordCareFeed()` is the only thing that writes to
  `care_feed`. Don't add a second place that writes either table directly —
  if a new action needs logging, call the existing function from the new
  code path, don't duplicate its insert.
- **Found a regression? Add a rule or a test, not just a retry.** If an
  identity check, a permissions boundary, or a logging guarantee turns out
  to be weaker than this file claims, the fix isn't "try again until it
  passes" — it's a new line here (if it's a rule worth stating) and/or a new
  assertion in `spec/` (if it's a behaviour worth locking in), so the same
  gap can't quietly reopen later.
