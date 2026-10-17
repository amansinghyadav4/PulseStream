# PulseStream — Code Quality Audit & Safe Cleanup

**Date:** 2026-10-17
**Scope:** entire repository (FastAPI backend, React/Vite frontend, demo-store, workers, infra, tests, docs).
**Method:** static inspection of the working tree (including untracked in-progress files), cross-reference
searching, Git history/status review, and execution of the existing test/build tooling.
**Constraint observed:** no commits, pushes, PRs, or destructive Git operations. Frontend kept JavaScript/JSX only.

> The repository was mid-flight when this audit began: a TypeScript → JavaScript migration (frontend and
> demo-store) and a Google OAuth feature were already present as **pre-existing, uncommitted user changes**.
> Those were preserved untouched except where this cleanup explicitly says otherwise.

---

## 0. Baseline (before any edit)

| Check | Command | Result |
|---|---|---|
| Git working tree | `git status --short` | Many pre-existing modifications: `.tsx` deleted / `.jsx` added, Google OAuth backend files added, `node_modules/typescript` removed, several tracked artifacts modified. Preserved as-is. |
| Frontend tests | `npm run test` (frontend) | **9 files, 91 tests passed** |
| Frontend build | `npm run build` (frontend) | **Built successfully** (baseline not separately captured pre-edit; re-verified after) |
| Backend tests | `pytest tests` | **235 collected.** With PostgreSQL **down**: 156 passed, 70 skipped, **9 failed** — all in `tests/test_auth.py` (see TEST-01). |
| Linters | — | No ruff/pyflakes/eslint configuration present in the repo; none run. |

The 9 baseline failures are **pre-existing and environmental**, not caused by this work: `tests/test_auth.py`
has no `database` skip fixture, so with Postgres unreachable it raises `ConnectionRefusedError` instead of
skipping (unlike every other DB-backed suite). With Postgres reachable it passes (confirmed later: 11 passed).

---

## 1. Findings

Status legend: **Fixed** · **Retained** (justified) · **Reported** (not changed).

### A. Dead code (backend)

| ID | File / symbol | Finding & evidence | Reason / impact | Risk | Action | Status |
|---|---|---|---|---|---|---|
| DEAD-01 | `app/kafka/consumer.py` · `KafkaEventConsumer.handle_raw_simple` | Only occurrence in the whole tree (repo-wide grep); docstring self-describes as *"Legacy simple handler … kept for reference"*. | Superseded by `handle_raw` (retry + DLQ). Removes ~25 lines of a second, divergent commit path. | Low (no callers, incl. tests) | Delete | **Fixed** |
| DEAD-02 | `app/kafka/dlq.py` · `KafkaDlqProducer.send_event` | Definition only; no callers anywhere. | Unused convenience wrapper over `send()`. ~18 lines removed. | Low | Delete | **Fixed** |
| DEAD-03 | `app/services/google_oauth.py` · `now_utc` (+ `datetime`/`timezone` import) | Definition only; the import was used **solely** by `now_utc`. | Dead helper. Removing it also removes an otherwise-unused stdlib import. | Low | Delete | **Fixed** |
| DEAD-04 | `app/core/config.py` · `kafka_num_partitions`, `kafka_replication_factor` (+ `.env.example`, `docs/kafka-topics.md`) | No Python code reads either field; compose hardcodes `KAFKA_NUM_PARTITIONS`/`KAFKA_DEFAULT_REPLICATION_FACTOR` directly, so the env vars were inert. | Unused configuration is a silent trap (editing it changes nothing). Removed and corrected the doc that cited `config.py`/`.env.example` as their source. | Low | Delete + doc fix | **Fixed** |
| DEAD-05 | `app/api/ws.py` · `ConnectionManager.disconnect_all` | Definition only; no callers (tests use `reset`). | Unused shutdown helper. | Low | Delete | **Fixed** |
| DEAD-06 | `app/core/metrics.py` · `_noop`; `nonlocal_path`/`nonlocal_scope` | `_noop` is defined and never called (`# pragma: no cover - never called`). The route-path block used two misleading aliases that always point at `scope`. | Behaviour-preserving simplification: `scope["metrics_path"] = route.path`. | Low | Delete / simplify | **Fixed** |
| DEAD-07 | `scripts/worker_healthcheck.py` | Unused `get_settings()` call, an unused `Redis` import, and a `_prime()` coroutine that is **never awaited**; the whole `try/except` is inert. | Removed ~15 lines that suggested worker-priming behaviour that never ran. | Low | Delete | **Fixed** |

### B. Dead / unused frontend exports

| ID | File / symbol | Finding & evidence | Reason / impact | Risk | Action | Status |
|---|---|---|---|---|---|---|
| FE-01 | `frontend/src/hooks/useHealth.js` · `healthDeps` | Exported, referenced nowhere (src incl. tests). | Dead export. | Low | Delete | **Fixed** |
| FE-02 | `frontend/src/lib/router.js` · `PUBLIC_ROUTES` | Exported, referenced nowhere; `AUTH_REDIRECT_ROUTES` + `isDashboardRoute` are the live guards. | Removes a second, unreferenced source of truth for route visibility (drift risk). | Low | Delete | **Fixed** |
| FE-03 | `frontend/src/components/landing/shared.jsx` · `MagneticButton`; `landing/motion.js` · `useMagnetic` | `MagneticButton` is never imported; `useMagnetic` is used **only** by `MagneticButton`. | ~50 lines of unused landing animation code. | Low | Delete | **Fixed** |
| FE-04 | `frontend/src/ui/Skeleton.jsx` · `Skeleton` | Only `SkeletonLines` is imported anywhere. | Dead component in a shared UI module. | Low | Delete | **Fixed** |
| FE-05 | `frontend/src/components/icons.jsx` · `IconTrash` | No import site (all other icons are used). | Dead icon. | Low | Delete | **Fixed** |
| FE-06 | `frontend/src/components/EventSimulator.jsx` · `export { EVENT_TYPES }` | Re-export claimed "for tests", but no test imports it; canonical symbol is `lib/eventFactory.js`. | Redundant export layer. | Low | Delete | **Fixed** |

> **Note (FE-03):** the CSS class `ls-btn-magnetic` is *not* dead — it is applied directly in
> `landing/Hero.jsx` and `landing/CtaSection.jsx`. Those rules were **retained**; only the unused
> component/hook were removed.

### C. Duplicate logic

| ID | Locations | Finding | Action | Status |
|---|---|---|---|---|
| DUP-01 | `components/ActivityFeed.jsx` `formatMs` vs `lib/format.js` `formatClockMs` | Byte-for-byte identical millisecond clock formatter reimplemented locally. | Replaced with the shared `formatClockMs` import. | **Fixed** |
| DUP-02 | `app/api/routes_auth.py` `_client_ip` vs `app/core/rate_limit.py` `_client_ip` | Same 3-line helper duplicated. | Touch auth/rate-limit internals; not worth the churn. | Reported |
| DUP-03 | `auth_service._now`, `tenant_service._now` | Same `datetime.now(timezone.utc)`. | Trivial; consolidating touches multiple services. | Reported |
| DUP-04 | `worker/persistence_worker.py` vs `worker/analytics_worker.py` | `_heartbeat_loop`/`start`/`stop`/`run` are near-identical; only the handler/group differ. | A shared base class is a plausible win **but** the workers are the highest-value runtime components and the failure-matrix suite is skipped here (no Kafka). Deferred pending integration coverage. | Reported |
| DUP-05 | `ui/CopyButton.jsx` vs `components/CopyButton.jsx` | Two clipboard buttons with different APIs/styles (`copy-btn`/emoji vs `copy-action`/icons+aria-live). | They serve different visual contexts; merging risks UI regressions and a forced abstraction. | Retained |
| DUP-06 | `routes_events.list_recent_events` vs `routes_failures.list_failures` | Same `limit`/`offset` pagination shape. | ~8 lines shared; a helper would not clearly simplify. | Reported |

### D. Incorrect / unused CSS

| ID | File | Finding | Reason / impact | Risk | Action | Status |
|---|---|---|---|---|---|---|
| CSS-01 | `components/KpiCards.jsx:169` ↔ `styles.css:718` | JSX emitted `kpi-sub kpi-sub-warn`, but the stylesheet defines `.kpi-sub.sub-warn`. The warn colour never applied; `.sub-warn` was unused. | **Real defect** (silent no-op style). Fixed to `kpi-sub sub-warn`. | Low | Fix | **Fixed** |
| CSS-02 | `styles.css` `.summary-chips`, `.page-intro`, `.dist-total`; `landing.css` `.ls-dev-card` | Defined, never applied in any JSX. | Removes dead CSS. | Low | Delete | **Fixed** |

### E. TypeScript remnants / placeholders

| ID | Locations | Finding | Action | Status |
|---|---|---|---|---|
| TS-01 | `App.test.jsx` (×2), `apiKeys.test.jsx`, `auth.test.jsx`, `landing.test.jsx` | Five `// @ts-ignore` comments left from the `.tsx` → `.jsx` migration (meaningless in plain JS). | Removed. | **Fixed** |
| TS-02 | `components/PipelineGraph.jsx:39` (`// PLACEHOLDER_BODY`), `styles/saas.css:44` (`/* PLACEHOLDER_SAAS */`) | Leftover development markers. | Removed. | **Fixed** |
| TS-03 | Whole repo | No `.ts`/`.tsx` or `tsconfig*.json` remain outside `node_modules`. | Confirmed — frontend restriction satisfied. | **Fixed / verified** |

### F. Orphaned / disconnected files

| ID | Path | Evidence | Reason | Action | Status |
|---|---|---|---|---|---|
| ORPH-01 | `_probe_tmp.py`, `probe_tmp.py`, `probe_data.json`, `probe_tmp.json`, `b5.json` | One-off `urllib`/`curl` scratch probes hitting `localhost:8000`; `probe_tmp.py` reads/writes the JSON siblings; nothing else references them (only `.dockerignore` exclusions). | Throwaway debugging artifacts, superseded by the `tests/` suite. | Delete | **Fixed** |
| ORPH-02 | `.tmp/r1.json … r4.json` | Tracked ad-hoc curl outputs; `.dockerignore` even excluded `.tmp`. | Scratch output. | Delete (+ `.tmp/` to `.gitignore`) | **Fixed** |
| ORPH-03 | `openapi.json` (root) | Generated spec snapshot; no code/test/doc/build reference. | Stale, regenerable (`/openapi.json` at runtime); drifts from code. | Delete | **Fixed** |
| ORPH-04 | `package-lock.json` (root) | `{"name":"pulsestream","packages":{}}` with **no** root `package.json`. | Orphaned empty lockfile. | Delete | **Fixed** |
| ORPH-05 | `app.egg-info/` | Stale build metadata (git-ignored, untracked) listing only a subset of modules. | Local build residue. | Delete | **Fixed** |
| ORPH-06 | `live_*.py` (6 scripts) | Manual live-stack verification tools referenced in `PulseStream_LEARNING.md` and `docs/redis.md`. | Documented tools, not abandoned. | Retain | **Retained** |

### G. Repository hygiene

| ID | Finding | Evidence | Action | Status |
|---|---|---|---|---|
| HYG-01 | `node_modules` is **tracked** in Git | `git ls-files` → **10,950** tracked `node_modules` paths (frontend + demo-store). `.gitignore` had no `node_modules/`. | Added `node_modules/` (and `.tmp/`) to `.gitignore`. **Untracking requires `git rm -r --cached frontend/node_modules demo-store/node_modules`**, which is a Git operation the owner performs. | Partially fixed (gitignore) / Reported |
| HYG-02 | `.dockerignore` referenced removed artifacts (`.claude`, `.tmp`, `b5.json`, `probe_*`, `_probe_tmp.py`) | Dead ignore entries. | Removed; `live_*.py` retained as an exclusion. | **Fixed** |

### H. Documentation / AI-attribution (Section 3 of the brief)

| ID | Location | Finding | Action | Status |
|---|---|---|---|---|
| DOC-01 | `CLAUDE.md` (tracked) | Assistant-named operating-rules file; not required for the application to run. | Renamed to **`AGENTS.md`** with neutral, professional wording (rules preserved, attribution rule de-branded). | **Fixed** |
| DOC-02 | `PulseStream_PROJECT_SPEC.md` §0 rule 4, §23 "Working Method for Claude", rule 10 | Explicit "Claude" attribution rules and heading. | Rewritten in neutral language ("co-author, generator, or automation attribution tags"; heading "Working Method"). Meaning preserved. | **Fixed** |
| DOC-03 | `PulseStream_LEARNING.md:1721` | Cross-reference to `(CLAUDE.md)`. | Updated to `(AGENTS.md)`. | **Fixed** |
| DOC-04 | `.dockerignore` `.claude` | Reference to a Claude tool directory (defensive ignore). | Removed (the directory is not in the repo). | **Fixed** |

**Legitimate references intentionally retained / flagged:** none. There is no implemented Claude/Anthropic
integration, SDK, or workflow in the project, so no functional reference needed preserving.
`.claude/settings.local.json` exists only in the local working directory and is excluded by a **user-global**
Git ignore (`~/.config/git/ignore`); it is not part of the repository and was left untouched.

### I. Other technical-debt observations (reported, not changed)

| ID | Finding | Why not changed |
|---|---|---|
| TEST-01 | `tests/test_auth.py` has **no** `database` skip fixture; with Postgres down it errors (9 failures) instead of skipping, contradicting the README's "integration tests skip cleanly" claim. | Adding a skip could be read as "skipping tests to obtain a passing result." Reported for the owner; a one-line skip guard mirroring the other suites is the suggested fix. |
| RET-01 | Test-only helpers (`analytics_service.reset_metrics`, `redis.client._reset_for_tests/_set_redis_for_tests`, `rate_limit.reset_rate_limits`, `ConnectionManager.reset`). | Referenced by tests; removing would break the suite. |
| RET-02 | Legacy unprefixed router mounts in `app/main.py:87-94`. | Backend tests and the `Dockerfile`/compose healthcheck (`/health`) depend on them; external clients use `/api/v1`. |
| RET-03 | `demo-store/src/lib/pulsestream.js` · `defaultBaseUrl` + `VITE_PULSESTREAM_API`. | Exported but never called; `PulseStream_LEARNING.md:2044` documents it as deliberate migration work, and it appears intended to be wired into the client constructor. Left in place; **recommended:** wire it into `new PulseStreamClient(defaultBaseUrl())` or delete it. |

---

## 2. Dependencies

No dependency changes were required.

- **Backend** (`requirements.txt`, `requirements-dev.txt`): every listed package is imported somewhere
  (`httpx` is used by the new `app/services/google_oauth.py`). No unused/heavy dependencies found.
- **Frontend** (`frontend/package.json`, `demo-store/package.json`): the `typescript` devDependency had
  **already** been removed by the in-progress user migration. Remaining deps (`react`, `react-dom`,
  `@fontsource-variable/*`, `@vitejs/plugin-react`, `vite`, `vitest`, `jsdom`, `@testing-library/*`) are all
  used. No removals made, so no lockfile changes were necessary.

---

## 3. Verification (after cleanup)

| Check | Result |
|---|---|
| `pytest tests` (Postgres **up**, run in batches to avoid environment aborts) | **220 passed, 15 skipped, 0 failed** — all 235 collected accounted for. Includes previously-failing `tests/test_auth.py` → **11 passed**. |
| Backend imports / syntax | `import app.main` + changed modules OK; `py_compile` of all changed Python files OK. |
| `npm run test` (frontend) | **9 files, 91 tests passed** (identical to baseline). |
| `npm run build` (frontend) | **Built successfully** (`dist/assets/index-*.js` 302.40 kB / gzip 89.75 kB; `index-*.css` 94.26 kB / gzip 17.97 kB). |
| AI/Claude reference sweep (filesystem, excluding `node_modules`/`.git`/`.venv`/`dist`) | **0 matches.** |
| TypeScript file sweep (excluding `node_modules`) | **0** `.ts`/`.tsx`/`tsconfig*` files. |

Per-batch backend results (Postgres up): 101+7 skipped; 51; 24; 4; 13; 16; 8 skipped; 11.
The monolithic `pytest tests` invocation repeatedly aborted this sandbox's shell, so the identical suite was
executed in smaller batches. No test was modified, skipped, or weakened.

Backend failures introduced by this cleanup: **none**.

---

## 4. Files & symbols removed

**Deleted files**
`CLAUDE.md` (→ renamed `AGENTS.md`), `_probe_tmp.py`, `probe_tmp.py`, `probe_data.json`, `probe_tmp.json`,
`b5.json`, `openapi.json`, root `package-lock.json`, `.tmp/r1.json`…`r4.json`, `app.egg-info/` (untracked).

**Deleted symbols**
`KafkaEventConsumer.handle_raw_simple`, `KafkaDlqProducer.send_event`, `google_oauth.now_utc`,
`Settings.kafka_num_partitions`, `Settings.kafka_replication_factor`, `ConnectionManager.disconnect_all`,
`metrics._noop`, `healthDeps`, `PUBLIC_ROUTES`, `MagneticButton`, `useMagnetic`, `Skeleton`, `IconTrash`,
`formatMs` (local), the `EVENT_TYPES` re-export, 4 unused CSS rules, 5 `@ts-ignore`, 2 placeholder markers.

**Simplified (behaviour-preserving)**
`app/core/metrics.py` route-path handling; `scripts/worker_healthcheck.py`; `KpiCards` warn class.

---

## 5. Git diff summary

`git diff --stat` (excluding `node_modules`): **116 files changed, 504 insertions(+), 11,193 deletions(−)**.
Most deletions are the pre-existing TypeScript → JavaScript migration. This cleanup's own tracked edits are:
`.dockerignore`, `.env.example`, `.gitignore`, `docs/kafka-topics.md`, `PulseStream_PROJECT_SPEC.md`,
`PulseStream_LEARNING.md`, `AGENTS.md` (new), the six backend files, the root-artifact deletions, and the
untracked frontend `.jsx`/CSS edits.

---

## 6. Not completed / remaining risks

1. **`node_modules` is still tracked** (~10.9k files). Only `.gitignore` was updated. Untracking
   (`git rm -r --cached frontend/node_modules demo-store/node_modules`) is left to the owner.
2. **`tests/test_auth.py` skip guard** (TEST-01) — intentionally not changed.
3. **Backend duplication** (worker base class, `_client_ip`, `_now`, pagination) — deferred; the Kafka/worker
   failure-matrix suite is skipped without a running broker, so refactors there cannot be fully regression-tested here.
4. **`demo-store` `defaultBaseUrl`** (RET-03) — retained pending a decision to wire it up or remove it.
5. The full backend suite had to be run in batches because the sandbox shell aborted long single runs; results
   are complete and consistent, but were not captured in one process.

## 7. Recommended next steps

- Untrack `node_modules` and commit the `.gitignore` change so future installs stay out of Git.
- Add a `database` skip fixture to `tests/test_auth.py` for consistency with the other DB suites.
- Decide on `defaultBaseUrl` (wire into the client constructor vs. delete).
- If worker/Kafka integration coverage is available, extract the shared worker lifecycle into a small base class.
