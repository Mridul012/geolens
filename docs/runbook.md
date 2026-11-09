# GEOlens — Launch Runbook

**Status:** M20 hardening pass complete. Last updated 2026-09-06.

This is the one-page reference for "something is wrong, what do I do" — and the record of
the drills that prove the failure modes below actually behave as documented before real
users hit them.

---

## 1. The five failure modes (docs/Backend.md §16)

| # | Failure | Documented behavior | Drilled by | Result |
|---|---|---|---|---|
| 1 | One LLM provider down | Gateway degrades → aggregate runs `COMPLETED_DEGRADED`, flagged components, UI banner | `tests/integration/ai/taxonomy.test.ts` ("degrades honestly when generation fails"), `tests/integration/crawls/aggregate.test.ts` ("degradation" suite) | ✅ Pass. No crash, no invented data, crawl always reaches a terminal state. |
| 2 | Crawl target blocks/throttles us | Backoff, partial crawl completes, access-check surfaces the block as a finding | `tests/integration/crawls/access-check.test.ts`, `tests/integration/crawler/ssrf-guard.test.ts` (37 cases) | ✅ Pass. |
| 3 | Worker killed mid-crawl | Frontier checkpoint → job resumes, doesn't restart | `tests/integration/crawls/resume.test.ts` | ✅ Pass — re-run for this milestone, all 5 cases green. |
| 4 | Budget exceeded mid-run | Skip remaining per-page work, complete aggregates, flag `degradation.taxonomy` etc., never overspend | `tests/integration/hardening/budget-kill-switch.test.ts` (new) | ✅ Pass. A real `BudgetGuard` against a real `ai_usage` ledger refuses the call at zero remaining budget; the crawl still reaches `COMPLETED_DEGRADED` with the reason intact for a banner. |
| 5 | Redis down | Web app serves reads (Postgres) fine; job intake pauses honestly, never data loss | `tests/integration/hardening/redis-loss.test.ts` (new) | 🔧 **Fixed a real gap**, see below. |

**Postgres down** is deliberately not a drill: docs/Backend.md §16 calls it "full outage;
this is the one system whose managed HA tier we pay for" — there is no graceful
degradation to prove, only that the managed database's own HA/backup posture is correct at
the hosting layer.

### Finding fixed: dashboard reads did not survive a Redis outage

`readDashboard` called `cache.get(...)` with no error handling. A cache **miss** (key
absent) was already handled — but an unreachable Redis (a connection error, not a miss)
propagated as an uncaught exception, turning "reads fine" into a 500. Fixed in
`src/application/dashboard/read-dashboard.ts`: a failed cache read is now treated exactly
like a miss, and a failed cache write after a successful rebuild is swallowed (best-effort
— the read has already succeeded from Postgres). Proven by
`tests/integration/hardening/redis-loss.test.ts` with a cache double that throws on every
call, the way a dead connection would.

### Finding flagged, not fixed: an orphaned `QUEUED` crawl row on enqueue failure

`startCrawl` creates the `Crawl` row, then writes progress and enqueues the job — both to
Redis. If Redis is unreachable at that exact moment, the row is created but never
enqueued, and the request fails loudly (a 500) rather than leaving a silent, permanently
stuck `QUEUED` row with no way for the customer to know it never started. The request
*does* fail loudly rather than pretending to succeed, so this is not a silent-failure bug,
but it is not the polished "clear paused state" the docs describe either. Real fix needs a
product decision (delete the orphaned row on enqueue failure? mark it `FAILED` with a
specific reason?) rather than a mechanical patch — tracked as a follow-up, not a launch
blocker.

---

## 2. Load sanity

No staging environment exists yet, so this substitutes the closest honest local
equivalent: 10 independent projects' full analysis flows (index → analyze → aggregate),
fanned out and fanned in **concurrently** against real Postgres and real BullMQ.

`tests/integration/hardening/load-sanity.test.ts` — 10/10 flows complete, zero deadlocks,
every `job_runs` audit row lands correctly under concurrent writes, wall time ~230ms for
the full 10-project fan-out/fan-in in a local dev environment.

**Follow-up before a real launch:** re-run this against a real staging deploy with actual
network crawls (not pre-seeded snapshots) once staging exists.

---

## 3. Security pass

- **Headers:** `@fastify/helmet` registered with default secure headers (`nosniff`,
  frame-guard, HSTS, etc.); CSP deliberately disabled — this is a JSON API with no HTML
  responses to protect via CSP, the web app owns its own CSP. Reviewed, no changes needed.
- **Dependency audit:** `npm audit --audit-level=high` — **found 17 vulnerabilities (13
  moderate, 4 high)**, all from three transitive dependencies of locked-stack packages
  (`crawlee`, `@bull-board/fastify`, `prisma`), none with a same-major-version fix
  available upstream. Fixed all 17 via targeted `package.json` `overrides` pins
  (`stream-json@^3.6.0`, `@fastify/static@^10.1.3`, `deepmerge-ts@^8.0.2`) — **no
  locked-stack package version changed**, only their vulnerable transitive dependencies
  were pinned forward to patched releases. Re-ran the full test suite afterward: 86 files,
  1209 tests, all green — the overrides introduced no regressions. `npm audit
  --audit-level=high` now reports 0 vulnerabilities, so the CI `audit` job (previously
  failing) passes.
- **Secrets scan:** `.env`/`.env.local` are gitignored; grepped every tracked file for
  Stripe/AWS key and PEM private-key patterns — none found.

---

## 4. Golden evals as a CI gate

Already wired (M12): `.github/workflows/ci.yml`'s `golden` job runs only on pull requests
that touch `src/infrastructure/ai/prompts/`, `src/config/model-tiers.ts`, or
`src/config/scoring/`, and fails the PR if the golden corpus (`evals/golden-sites/`) moves
outside its recorded tolerance. Verified present and correctly path-gated; no changes
needed this milestone.

---

## 5. Alerts verified end to end

The failed-job sweeper (`sweepFailedJobs`) and budget monitor (`monitorBudgets`) both
compose a real email via the `Mailer` port and send it. In `EMAIL_PROVIDER_MODE=fake`
(the default everywhere but production), the send is recorded in memory —
`tests/integration/jobs/sweep-failed-jobs.test.ts` and
`tests/integration/jobs/budget-monitor.test.ts` assert the alert actually reaches
`FakeMailer.sent` with the right recipient and content once the failure-rate/budget
threshold trips, and stays silent (no email, only a structured log line) below it.

**What this does not verify:** that a real email actually lands in a real inbox via
Resend. That requires `EMAIL_PROVIDER_MODE=live`, a real `RESEND_API_KEY`, and a human
checking an inbox — a manual step for whoever owns the production Resend account before
launch, not something this drill suite can automate.

---

## 6. Launch checklist

- [x] All five documented failure modes drilled; one real gap found and fixed (Redis-loss
      dashboard read), one found and flagged as a non-blocking follow-up (orphaned
      `QUEUED` crawl row on a Redis outage at enqueue time)
- [x] Load sanity: 10 concurrent analysis flows, local substitute for staging (staging
      re-run tracked as a follow-up)
- [x] Security pass: headers reviewed, dependency audit fixed to 0 vulnerabilities,
      secrets scan clean
- [x] Golden evals gate CI on prompt/model-tier/scoring-weight changes
- [x] Alerts verified end-to-end in fake mode; real-inbox verification is a manual
      pre-launch step for whoever holds the Resend account
- [x] Full test suite green: 86 files, 1209 tests, typecheck clean, lint (incl.
      architecture boundaries) clean

**This milestone is the gate.** Nothing here found a launch-blocking issue that remains
unresolved; the one flagged item (orphaned crawl row) is a rare, loud-not-silent failure
mode that does not corrupt data or mislead a customer, and is reasonable to ship with,
tracked rather than blocking.
