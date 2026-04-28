# Ghost ChatUI Odoo Execution Truth Contract

## Purpose
Make Odoo execution state explicit and trustworthy in Ghost ChatUI.

## User-Visible States

### `Odoo executed`
Show this only when the current turn includes a tool event with:
- `tool_id = odoo_primary`
- `status = executed`

Meaning:
- the backend executed a governed Odoo operation
- the assistant may summarize the returned ERP evidence

### `Odoo blocked`
Show this when the current turn includes a tool event with:
- `tool_id = odoo_primary`
- `status = blocked`

Meaning:
- the backend attempted the handoff but could not run it
- the blocked reason should be shown in plain operator language

### `Odoo failed`
Show this when the current turn includes a tool event with:
- `tool_id = odoo_primary`
- `status = failed`

Meaning:
- execution was attempted but did not complete successfully

### `Odoo planned only`
Show this when the current turn includes:
- `tool_id = odoo_primary`
- `status = preview` or `planned`

Meaning:
- the system identified the intended Odoo operation
- no executed ERP result exists yet

### `No Odoo result returned`
Show this when:
- the assistant prose talks about Odoo execution or data injection
- but the turn contains no Odoo tool result

Meaning:
- the assistant text must not be trusted as evidence of ERP execution
- semantic or document citations must not masquerade as tool proof

## Forbidden Assistant Language
The assistant must not say any of the following unless an executed tool event exists in the same turn:
- `triggering odoo_primary`
- `awaiting data injection`
- `I am querying Odoo now`
- `the data is being injected`
- any phrasing that implies a successful or active ERP handoff

## Operator Expectation
If Odoo is relevant, the user should be able to tell from the UI:
- whether it executed
- whether it was blocked
- whether it failed
- whether the assistant is only describing a plan

The user should never need backend logs to know whether the ERP step actually happened.
