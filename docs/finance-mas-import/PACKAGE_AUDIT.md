# Finance MAS Package Audit

Date: 2026-04-24
Package: `artefacts/fix-ledger-search-package`

Audit policy:
- `import now`: move into live workspace discoverability paths.
- `reference only`: keep in package, point to it from workspace docs.
- `archive only`: retain for provenance; do not wire into active paths.
- `duplicate`: same content exists in two places.
- `canonical`: selected authoritative copy when duplicates exist.

## Root files

- `AGENTS.md` -> `reference only` and `duplicate` with `agents/AGENTS.md`; `canonical` source is `agents/AGENTS.md` because it is directory-scoped and maps cleanly to role contracts.
- `BUILD.md` -> `reference only` and `duplicate` with `docs/BUILD.md`; `canonical` source is root `BUILD.md` for planning.
- `ARCHITECTURE_BRIEF.md` -> `reference only` and `duplicate` with `docs/ARCHITECTURE_BRIEF.md`; `canonical` source is root `ARCHITECTURE_BRIEF.md`.
- `TASKS.md` -> `reference only` and `duplicate` with `docs/TASKS.md`; `canonical` source is root `TASKS.md`.
- `CURSOR_IMPLEMENTATION_BRIEF.md` -> `reference only` and `duplicate` with `docs/CURSOR_IMPLEMENTATION_BRIEF.md`; `canonical` source is root `CURSOR_IMPLEMENTATION_BRIEF.md`.

## docs/

- `docs/BUILD.md` -> `archive only` as duplicate mirror of root canonical build doc.
- `docs/ARCHITECTURE_BRIEF.md` -> `archive only` as duplicate mirror of root canonical architecture brief.
- `docs/TASKS.md` -> `archive only` as duplicate mirror of root canonical tasks.
- `docs/CURSOR_IMPLEMENTATION_BRIEF.md` -> `archive only` as duplicate mirror of root canonical implementation brief.

## agents/

- `agents/AGENTS.md` -> `import now` to `.cursor/agents/finance-mas-agent-contracts.md`.

## prompts/

- `prompts/finance_intent_router.md` -> `import now` to `docs/finance-mas-import/prompts/finance_intent_router.md`.
- `prompts/semantic_source_planner.md` -> `import now` to `docs/finance-mas-import/prompts/semantic_source_planner.md`.
- `prompts/finance_response_composer.md` -> `import now` to `docs/finance-mas-import/prompts/finance_response_composer.md`.

## examples/

- `examples/GOOD_OUTPUT.md` -> `import now` to `docs/finance-mas-import/examples/GOOD_OUTPUT.md` and skill-local reference.

## schemas/

- `schemas/metric_pack.schema.json` -> `import now` to `docs/finance-mas-import/schemas/metric_pack.schema.json`.
- `schemas/source_plan.schema.json` -> `import now` to `docs/finance-mas-import/schemas/source_plan.schema.json`.

## config/

- `config/account_classification.example.json` -> `reference only` because skill already carries equivalent operational reference under `.cursor/skills/finance-semantic-guard/references/account-classification.json`.
- `config/metric_request_rules.example.json` -> `reference only` because skill already carries equivalent operational reference under `.cursor/skills/finance-semantic-guard/references/metric-request-rules.json`.

## skills/finance-semantic-guard/

- `skills/finance-semantic-guard/SKILL.md` -> `reference only`; already live and matching at `.cursor/skills/finance-semantic-guard/SKILL.md` (no duplicate creation).
- `skills/finance-semantic-guard/agents/openai.yaml` -> `archive only`; display metadata only and not required for runtime logic.

### skills/finance-semantic-guard/references/

- `skills/finance-semantic-guard/references/account-classification.json` -> `import now` to `.cursor/skills/finance-semantic-guard/references/account-classification.json`.
- `skills/finance-semantic-guard/references/metric-request-rules.json` -> `import now` to `.cursor/skills/finance-semantic-guard/references/metric-request-rules.json`.
- `skills/finance-semantic-guard/references/brief.md` -> `import now` to `.cursor/skills/finance-semantic-guard/references/brief.md`.
- `skills/finance-semantic-guard/references/api_reference.md` -> `import now` with adaptation to live workspace references at `.cursor/skills/finance-semantic-guard/references/api_reference.md`.

## Audit conclusion

- All 24 files were reviewed and classified.
- Valuable operational assets were imported into stable live paths.
- Duplicate planning docs were retained in archive but root files are canonical for new build planning.
