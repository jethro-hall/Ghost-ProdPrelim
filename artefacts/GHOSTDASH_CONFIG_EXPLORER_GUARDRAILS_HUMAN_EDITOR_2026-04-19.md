# Config Explorer: human-readable guardrails editing (2026-04-19)

## Summary

Replaced the single `JSON.stringify` textarea for `namespace === "guardrails"` with:

1. **Structured editor** — one multiline control per `RuntimeProfileGuardrailsConfig` field (real line breaks, no escaped `\n` in the default path).
2. **Markdown preview** — `react-markdown` + `remark-gfm` read-only preview beside long text fields (`GuardrailsConfigEditor.tsx`).
3. **Raw JSON** — toggle to edit the full JSON blob (previous behavior) for copy/paste and power users.

## Files

| File | Role |
|------|------|
| [`ui/package.json`](../ui/package.json) | Added `react-markdown`, `remark-gfm`. |
| [`ui/src/lib/guardrailsNormalize.ts`](../ui/src/lib/guardrailsNormalize.ts) | `normalizeGuardrailsFromValueJson`, `guardrailsConfigToValueJson`. |
| [`ui/src/components/GuardrailsConfigEditor.tsx`](../ui/src/components/GuardrailsConfigEditor.tsx) | Field layout + Edit/Preview split. |
| [`ui/src/pages/ConfigExplorerPage.tsx`](../ui/src/pages/ConfigExplorerPage.tsx) | `ConfigExplorerGuardrailsSection` (keyed by `entry.key`), audits fetch in parent. |

## API contract

Unchanged: `PATCH /api/config/explorer/{key}` with `value_json` object matching `RuntimeProfileGuardrailsConfig`.

## Verify

```bash
pnpm -C ui install
pnpm -C ui run lint
pnpm -C ui run build
```

Manual: `/config-explorer` → select `runtime_profile.*.guardrails` → confirm structured fields, Markdown preview, Raw JSON toggle, Save.
