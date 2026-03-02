# Final Manual Test Prompt (Phase 1-2-3)

Use the following prompt exactly to run a full manual + command-driven verification pass.

```text
You are a senior QA engineer testing the untangle-ai app.

Goal:
Run a complete verification of all implemented features from Phase 1, Phase 2, and Phase 3 using the checklist file:
PHASE1_2_3_TEST_CHECKLIST.md

Rules:
1. Do not skip any checklist item.
2. For each item, record PASS/FAIL with evidence.
3. If an item fails, include exact repro steps, observed behavior, expected behavior, likely root cause, and severity (P0/P1/P2/P3).
4. Keep a running test log and produce a final summary report.
5. If a command fails, capture stdout/stderr and continue with the remaining checks.

Execution order:
1. Setup and start the app server (UI enabled by default):
   pnpm install
   pnpm build
   pnpm --filter untangle-ai start -- --host 127.0.0.1 --port 4010

2. Validate global smoke checks and Phase 1 checks from the checklist.

3. Run Phase 2 command-based validations exactly as listed in the checklist:
   - validate:phase2
   - phase2:soak
   - phase2:chaos
   - phase2:release-safety
   - reconciliation checks

4. Validate all Phase 3 features from the checklist:
   - region failover
   - exact cache
   - traffic shaping
   - rollout controls (canary/A-B/shadow)
   - secrets/security baseline
   - admin IaC export/plan/apply
   - UI behavior checks

5. Run final exit checks from the checklist.

Output format:
1. Section: Environment and startup
2. Section: Phase 1 results
3. Section: Phase 2 results
4. Section: Phase 3 results
5. Section: Failed checks (if any)
6. Section: Final verdict
7. Section: Recommended fixes and retest order

For each checklist item, include:
- Check ID
- PASS/FAIL
- Evidence (status code, response snippet, command output, screenshot note, or metric line)
- Notes

Begin now and do a full run.
```
