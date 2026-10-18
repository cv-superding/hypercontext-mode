# REQ - AGENTS.md problem discovery & fix reporting clause

- Task ID: `2026-09-06_agents-md-problem-reporting`
- Home Repo: `billion-context`
- Created: 2026-09-06
- Status: InProgress
- Priority: P2
- Owner: ranxianglei (agent)
- References: https://github.com/ranxianglei/billion-context/issues/584

## 1. Background & Problem Statement

- **Context**: Agents frequently discover problems while working, and fixes sometimes land without any issue tracking — the problem, its impact, and the fix rationale exist only in a chat thread or nowhere.
- **Current behavior (symptom)**: AGENTS.md's "Issue Work — Required Deliverables" covers issues an Agent *picks up*, but says nothing about problems discovered or fixed *along the way*; such fixes can be silent.
- **Expected behavior**: A MANDATORY clause requires that every discovered problem is filed as an issue in the owning project, and every fix is followed by an issue recording the problem + fix (or a PR referencing its issue; issue first, then link). The clause references this project's GitHub address.
- **Impact**: Traceability of all agent-driven fixes across the billion-context family.

## 2. Reproduction (if applicable)

N/A — documentation/policy change.

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: none (docs only).
  - Performance requirements: n/a.
  - Resource limits: n/a.
- **Non-Goals** (explicitly out of scope): no code changes; no CI enforcement (policy lives in AGENTS.md); sibling repos get equivalent clauses via their own PRs (billion-context-pi, opencode-acp).

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] AGENTS.md §4 contains a new subsection "Problem Discovery & Fix Reporting (MANDATORY)" covering both cases: discovered-but-unfixed → file issue; fixed → issue after fix, or PR referencing its issue (`Fixes #N`).
  - [x] Clause references https://github.com/ranxianglei/billion-context/issues .
- **Performance / Stability**: n/a.
- **Regression**:
  - [x] No code changes — typecheck/test/build not required (docs-only commit).

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
  - `AGENTS.md` — new subsection under §4 Git Safety Rules, after "Issue Work — Required Deliverables".
- **Risks**: None (documentation).
- **Rollback strategy**: Revert the single docs commit.
