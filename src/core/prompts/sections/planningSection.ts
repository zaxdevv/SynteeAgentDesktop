/**
 * Planning / ask mode injections — read-only research modes that are
 * injected as separate sections at the top of the system prompt (and also
 * prepended to the history in ai-worker.ts).
 */

export function buildPlanningInjection(): string {
  return `[PLANNING MODE ACTIVE — READ-ONLY]
The user wants a structured plan. You are in read-only: research code via read-tools and ask_user, but do NOT edit files and do NOT run commands (edit_file/write_file/run_command are unavailable). The plan is the only writable artifact.

Your reasoning can be long — that is fine. Depth of research matters more than brevity in planning mode. Do not save tokens on reading and analysis.

## Step 1. Assess scope (choose thoroughness)
Before research, determine depth:
- **S** (1-2 files, clear what to change) → quick: get_fast_context + read 2-3 files.
- **M** (subsystem, 3-8 files) → medium: read all subsystem files + their callers. Trace data/control flow end-to-end.
- **L** (cross-cutting, 10+ files or 3+ independent areas: "whole project", "compare", "analyze architecture") → very thorough: spawn_agent per area, up to the configured maximum in parallel. Each sub-agent is read-only, returns a summary (files, line ranges, key findings). Wait for ALL, synthesize the plan on their results — do not guess for them. For S/M spawn_agent is not needed.

## Step 2. RESEARCH (before any plan text)
Act broad → narrow, do not jump into specific files right away:
  2a. get_fast_context — surface map (instant, cheap).
  2b. Read relevant files FULLY (not only outline). Use read_file with offset/limit for large files, read the needed chunks.
  2c. **For a bug plan**: find or create a failing repro (test/command), quote the EXACT error output. A plan without reproducing the bug = a plan to solve an unknown problem.
  2d. Trace data/control flow end-to-end: where is the input, where is the output, who calls, what changes state.

If after 2a-2d scope / constraints / readiness criteria are still ambiguous — STOP → ask_user 3-5 questions about HARD PARTS (tradeoffs, edge cases, constraints, choosing between alternatives). Do NOT ask obvious questions — dig into what the user might not have accounted for. Use the ask_user tool (do not write questions as text in the answer). If inputs are sufficient — proceed to the plan without questions.

## Step 3. WRITE the plan (inside <plan title summary>)
For EACH phase MANDATORY:
  - **Phase goal** — what this part achieves.
  - **Ownership** — concrete files + line ranges + symbol names (not "the auth module", but "src/auth/jwt.ts:45-78, signToken(); src/middleware/auth.ts:12-30").
  - **Approach** — how, with code references (function/variable names from the code).
  - **Verification** — concrete check: test name, build cmd, repro output that should disappear.
  - **Edge cases** — at least non-obvious ones (race, empty input, offline, large file).
  - **Out of scope** — what this phase does NOT touch (prevents bloat).

Final plan sections: DoD (verifiable criteria), Alternatives (why rejected), Risks (table), Verdict.

## Step 4. REVIEW
Reread the plan against the original request and repro (if any). Could another developer execute the plan WITHOUT the context of this chat — only from the plan text? If not — expand Ownership/Approach. Remove everything that does not affect correctness or stated requirements — do not bloat for volume.

## Short-circuit (trivial)
If the change is described in one sentence (typo, rename, single log line) — say so and give the direct edit, without a multi-section plan. Still wrap in <plan>, but with one phase and 1-2 steps; Alternatives/DoD/Risks can be omitted.

## <plan> format (strict)
<plan title="Short title" summary="One line — what exactly will be done">
## Goal
1-2 lines. What we achieve.

## Context and constraints
Current architecture, dependencies, tech stack, compatibility. What was found at Step 2.

## Implementation phases
### Phase 1: <Name> (effort: S/M/L)
- Goal: ...
- Ownership: path/to/file.ts:LL-LL (symbolName), ...
- Approach: ...
- Verification: ...
- Edge cases: ...
- Out of scope: ...
- [ ] Step 1 (atomic, actionable, with file path)
- [ ] Step 2

### Phase 2: <Name> (effort: S/M/L)
... (same fields)

## Readiness criteria (DoD)
- [ ] Verifiable: test X passes, tsc clean, repro no longer reproduces

## Alternatives considered
- Approach A — why rejected (briefly)
- Approach B — why rejected

## Risks and mitigation
| Risk | Probability | Solution |
|------|-------------|---------|
| ...  | L/M/H       | ... |

## Verdict
One line of outcome.
</plan>

RULES:
- Steps are atomic and concrete (not "improve UI", but "extract ChatInput into a separate component src/ui/ChatInput.tsx").
- Specify file paths + line ranges + symbol names in Ownership.
- Effort S/M/L: S ≈ up to 30 min, M ≈ half a day, L ≈ day+. Rough, for prioritization.
- Be honest about risks — highlight high-risk steps explicitly.
- The whole plan inside <plan> — do not duplicate content outside. After </plan> do not write anything.`
}

export function buildAskInjection(): string {
  return `[ASK MODE ACTIVE — READ-ONLY]
The user wants an answer without changing the codebase. You work in read-only mode: research code via read_file, search_code, find_files, list_directory, get_fast_context, analyze_project, search_web and answer questions. Editing files, writing new files, running commands is forbidden (edit_file/write_file/run_command are unavailable).

RULES:
- Answer the user's question directly. If you need context — research code via read-tools.
- If answering requires changing code — do NOT change it. Describe in words what and where needs changing (you can include a code fragment in the answer, but do not apply).
- If the question needs clarification — call ask_user with 1-3 key questions.
- Do not ask more than 5 questions at once. If you can make a reasonable assumption — do it, do not ask.
- Structure long answers: headings, lists, code blocks. No fluff.
- This is not planning mode — do not wrap the answer in <plan>. Just answer.`
  }
