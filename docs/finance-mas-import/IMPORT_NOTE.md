# Finance MAS Import Note

Date: 2026-04-24
Source package: `artefacts/fix-ledger-search-package`

## Source to target mapping

- `skills/finance-semantic-guard/SKILL.md` -> `.cursor/skills/finance-semantic-guard/SKILL.md` (already present; verified unchanged)
- `skills/finance-semantic-guard/references/account-classification.json` -> `.cursor/skills/finance-semantic-guard/references/account-classification.json`
- `skills/finance-semantic-guard/references/metric-request-rules.json` -> `.cursor/skills/finance-semantic-guard/references/metric-request-rules.json`
- `skills/finance-semantic-guard/references/brief.md` -> `.cursor/skills/finance-semantic-guard/references/brief.md`
- `skills/finance-semantic-guard/references/api_reference.md` -> `.cursor/skills/finance-semantic-guard/references/api_reference.md` (adapted to point at live workspace contracts)
- `agents/AGENTS.md` -> `.cursor/agents/finance-mas-agent-contracts.md`
- `prompts/*.md` -> `docs/finance-mas-import/prompts/*.md`
- `schemas/*.schema.json` -> `docs/finance-mas-import/schemas/*.schema.json`
- `examples/GOOD_OUTPUT.md` -> `docs/finance-mas-import/examples/GOOD_OUTPUT.md`

## Duplication controls

- Did not duplicate `SKILL.md` because the live file already matched package content.
- Preserved package artefacts as immutable source material under `artefacts/`.
- Imported only the pieces needed for stable, workspace-level discoverability.
