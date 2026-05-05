# Technical Debt

Known deferred items that should be addressed before or during Phase 3.

---

## D2L API Gaps

### Discussion board tool not yet implemented
D2L has its own discussion/forum tool (`/d2l/api/le/1.57/{orgUnitId}/discussions/forums/`) separate from Piazza. Many schools use it exclusively. Piazza tools exist but only cover schools using Piazza. See Phase 3 roadmap.

### Grade weighting uses fuzzy name matching — brittle
`priority.ts` and `priorityGlobal.ts` match assignment names to grade objects via string `includes()`. If a D2L course names the grade object differently from the dropbox folder (e.g., "A1" vs "Assignment 1"), the match fails and urgency scoring falls back to `weight=0.1`. A more robust approach would use the grade object's `AssociatedItemId` if D2L exposes it.

### Integration tests have never run against live D2L
All integration tests in `tests/*.integration.test.ts` are skipped because they require a live D2L session. The `D2L_INTEGRATION_TESTS` env var guard is correct but sessions have been expired since initial development. These tests have never been run against a real instance.

### `get_assignment_rubric` returns all course rubrics if assignment-level rubric IDs are not exposed
`rubric.ts` checks for `AssociatedRubrics` and `RubricId` on the dropbox folder response. If D2L does not include these fields (depends on D2L version and course configuration), all rubrics in the course are returned with a note. This can include irrelevant criteria from other assignments.

---

## Storage / Auth

### Legacy unencrypted S3 states will be re-encrypted on next VNC auth — no forced migration script
When `KMS_KEY_ARN` is set, new browser states are encrypted. Existing unencrypted S3 states (from before Security Task 5) are loaded as-is with a warning log but not re-encrypted in place. They will be naturally replaced on the user's next successful VNC auth. There is no forced migration script to re-encrypt them proactively.

---

## Integrations

### Crowdmark integration not implemented
Crowdmark is used by some UW courses for graded feedback. No public API exists (as of research in 2026-04). See `docs/plans/crowdmark-research.md` for details.

### Outline integration hardcoded to UW
`outlineClient.ts` is hardcoded to `outline.uwaterloo.ca`. Non-UW students on D2L get no outline data. A school-to-outline-URL config map has been planned but not yet implemented. See `docs/plans/outline-research.md` and `src/config/outlineHosts.ts` (Phase 2).
