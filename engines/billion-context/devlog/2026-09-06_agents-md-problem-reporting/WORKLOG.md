# WORKLOG - AGENTS.md problem discovery & fix reporting clause

- Task ID: `2026-09-06_agents-md-problem-reporting`
- Home Repo: `billion-context`
- Status: Done
- Updated: 2026-09-06 22:10

## 1. Summary

- **What was done**: Added a MANDATORY subsection "Problem Discovery & Fix Reporting" to AGENTS.md §4 requiring issue tracking for every discovered problem and for every fix (issue first, PR references it via `Fixes #N`).
- **Why** (issue #584): fixes discovered/made by agents were not required to leave a trace in the project's issue tracker; the clause makes that mandatory and points at this project's GitHub address.
- **Behavior / compatibility changes**: No (documentation only).
- **Risk level**: Low.

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| head of this branch | docs: AGENTS.md — require issue tracking for discovered/fixed problems (#584) |

### Key Files

- `AGENTS.md` — new subsection under §4 Git Safety Rules, between "Issue Work — Required Deliverables" and "npm Publish — Absolute Prohibition".
- `devlog/2026-09-06_agents-md-problem-reporting/REQ.md`, `WORKLOG.md` — this entry.

## 3. Design & Implementation Notes

- Clause covers both directions requested in #584: (a) problem discovered (in this project or a sibling) → file an issue in the owning project; (b) problem fixed → after the fix, submit an issue recording problem + fix, or ship the PR referencing its issue (`Fixes #N`) — a bare PR without an issue is not acceptable; an existing PR counts but should carry an accompanying issue.
- References https://github.com/ranxianglei/billion-context/issues per "agents.md 引用对应的项目地址".

## 4. Testing & Verification

### Build & Test Commands

Docs-only change — no build/test required.

### Results

- **PASS/FAIL**: PASS (markdown edit; verified by re-read).

## 5. Risk Assessment & Rollback

- **Risk points**: none.
- **Rollback method**: revert the single docs commit.
- **Compatibility notes**: No.
