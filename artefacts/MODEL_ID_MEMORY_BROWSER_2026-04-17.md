# Model id memory & quick pick (Agent Config UI)

## Behavior

- **Storage:** `localStorage` key `ghostdash.agentConfig.modelIds.v1` with `byConnectionId` and `byProviderKind` maps.
- **On provider connection change:** The previous connection’s current model id is saved; the newly selected connection gets `byConnectionId` → else `byProviderKind` → else runtime defaults / per-`ProviderKind` string default.
- **On model id field blur:** Persists the current model for the active connection and provider kind.

## Quick pick (visible options)

- **`PRESET_MODEL_IDS_BY_KIND`** in `ui/src/lib/modelIdMemory.ts` lists common ids per family; **`getAllPresetModelIds()`** flattens all of them into one sorted list.
- **`getModelIdOptionsForPicker(extraIds)`** merges: all presets + every model id saved in this browser (`byConnectionId` + `byProviderKind`) + `extraIds` (runtime default, current value). **No filtering by provider** — any model id in the list can be used with any saved connection (gateways vary).
- **Agent Config UI** (`/agent`): **Quick pick** `<select>` + **datalist** on the text input share that full list.

## Files

- `ui/src/lib/modelIdMemory.ts` — storage, defaults, presets, `getModelIdOptionsForPicker`.
- `ui/src/pages/AgentConfigPage.tsx` — connection select, quick pick, typed input with datalist, blur persistence.

## Human verification

1. Open `/agent` — quick pick should list **all** curated presets (OpenAI, Anthropic, Gemini, etc.) in one dropdown, plus saved ids.
2. Change **Provider connection** — the same model list remains; only the recalled default for the field may change from memory.
3. Type a custom id, blur — it should appear in the merged list after refresh tick (localStorage).
4. Two connections, model A / model B, switch back — prior memory behavior unchanged.

## Verify command

```bash
cd /var/llamaindex/ghoststack-rag/ui && npx tsc --noEmit
```

(If the repo has unrelated TS errors elsewhere, fix or scope checks; Agent Config + `modelIdMemory` should compile.)
