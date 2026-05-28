# GhostDASH Config Explorer Phase 2 (Safe Edit)

## Goal
Implement an in-app (phase-2) safe-edit workflow for runtime configuration, with:
1. JSON edit + validation
2. Optimistic locking via `updated_at`
3. Audit trail (leveraging runtime policy audit persistence)
4. Rollback (restoring guardrails to the `before_json` snapshot from an audit record)

## Scope (intentional safety boundary)
Phase-2 safe editing is implemented for:
* `namespace = "guardrails"` entries only

All other namespaces in the Config Explorer remain read-only in this phase to avoid accidental drift in unknown config shapes.

## Backend changes
### Endpoints
* `PATCH /api/config/explorer/{key}`
  * `key` format: `runtime_profile.{runtime_profile_id}.guardrails`
  * Request body: `ConfigExplorerEditRequest`
    * `expected_updated_at` (datetime)
    * `value_json` (object)
    * `policy_actor`, `policy_approval_token`, `policy_approval_reason`
  * Behavior:
    * Validates the target is `guardrails`
    * Compares `profile.updated_at` against `expected_updated_at` (exact match)
    * Merges edits into existing `guardrails_config_json`
    * Validates merged guardrails via `RuntimeProfileGuardrailsConfig`
    * Saves using `save_runtime_profile()` (policy-mode governed)
    * Returns `ConfigExplorerEntryView`
    * Converts `ValueError` into HTTP `409` so the UI can show actionable operator feedback

* `GET /api/runtime-profiles/{runtime_profile_id}/policy-audits?limit=...`
  * Returns `PolicyChangeAuditView[]` for the selected runtime profile.

* `POST /api/config/explorer/rollback/{audit_id}`
  * Rolls back guardrails to the audit record’s `payload_json.before.guardrails_config` snapshot.
  * Uses `save_runtime_profile()` for policy-mode governance and writes the resulting audit trail automatically.

## Frontend changes
### Config Explorer UI (phase-2 edit mode)
`ui/src/pages/ConfigExplorerPage.tsx`
* When the selected entry is `namespace === "guardrails"`:
  * Shows editable JSON textarea
  * Shows “Policy actor”, “Approval token”, “Approval reason” inputs
  * Save button calls the backend PATCH endpoint with `expected_updated_at`
  * Rollback latest button calls the rollback endpoint for the latest audit row
* For non-guardrails namespaces:
  * UI stays read-only (existing JSON `<pre>` view)

### API client wiring
`ui/src/api.ts`
* Added client functions for:
  * `patchConfigExplorer()`
  * `fetchRuntimeProfilePolicyAudits()`
  * `rollbackConfigExplorerAudit()`

## Human operator acceptance criteria (what “done” means)
1. Selecting a `guardrails` entry allows editing JSON and saving.
2. Save requires:
   * correct `updated_at` (optimistic locking)
   * and (if the runtime policy mode demands it) a non-empty admin approval token.
3. Invalid JSON fails fast in the UI (client-side JSON.parse).
4. Invalid schema edits fail with a clear `409` error from backend.
5. Rollback using the latest audit restores the guardrails JSON to the `before_json` snapshot.

## Human testing performed (E2E smoke)
1. Verified endpoints reachable:
   * `curl -s -o /dev/null -w '%{http_code}\n' http://localhost/api/config/explorer` -> `200`
2. PATCH smoke:
   * No-op edit using current `updated_at` succeeded when providing a dummy admin token.
   * Confirmed response contained a new `updated_at`.
3. Rollback smoke:
   * Fetched latest `policy-audits` row for the selected runtime profile.
   * Rolled back via `POST /api/config/explorer/rollback/{audit_id}` successfully.

## Exact verify commands (repeatable)
Backend reachability:
```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost/api/config/explorer
```

Fetch a guardrails entry:
```bash
curl -s http://localhost/api/config/explorer?namespace=guardrails
```

List latest audits for the runtime profile (replace `RUNTIME_PROFILE_ID` from the key):
```bash
curl -s "http://localhost/api/runtime-profiles/RUNTIME_PROFILE_ID/policy-audits?limit=5"
```

Rollback (replace `AUDIT_ID`):
```bash
curl -s -X POST "http://localhost/api/config/explorer/rollback/AUDIT_ID" \
  -H "Content-Type: application/json" \
  -d '{"policy_actor":"operator","policy_approval_token":"dummy-admin-token","policy_approval_reason":"rollback smoke test"}'
```

## Notes / Safety Considerations
* Editing is intentionally limited to `guardrails` namespace in this phase.
* Optimistic locking is exact-match to prevent “quiet overwrites”.
* Rollback restores to the `before_json` snapshot stored by the existing runtime policy audit machinery.

