# Tool Policy And Admin Specification

## Purpose

Magic Mike must not inherit internal business/finance tools. Tools must be explicitly enabled per agent.

## Hard rule for Magic Mike

```text
Magic Mike is a Consumer Customer agent.
Magic Mike must not have Odoo tools available in production mode.
Magic Mike must not mention Odoo.
Magic Mike must not inherit Odoo tool errors.
```

## Agent tool categories

```text
business_finance
consumer_customer
personal_assistant
retrieval
handoff
system
```

Rules:

```text
Consumer Customer agents can use consumer_customer, retrieval, handoff.
Business agents can use business_finance, retrieval, system.
Personal Assistant agents can use personal_assistant, retrieval, system, handoff.
```

Odoo tools:

```text
category: business_finance
```

HubTiger tools:

```text
category: consumer_customer
```

## Magic Mike allowed tools

```text
hubtiger_booking_availability
hubtiger_booking_create
hubtiger_job_search
hubtiger_job_get
hubtiger_job_note_add
hubtiger_products_search
hubtiger_quote_preview_price
hubtiger_quote_add_line_item
hubtiger_quote_request_approval_sms
approved product retrieval
approved warranty retrieval
approved legal/compliance retrieval
human handoff
```

## Magic Mike forbidden tools

```text
Odoo
Odoo MAS
Odoo finance
account.move
account.payment
odoo.finance.*
odoo.mas.*
raw ERP accounting tools
```

## Per-agent tool admin

Add under:

```text
Agent Config → Tools
```

Required table:

```text
Tool Name
Provider
Category
Enabled for this agent
Read only / Read write
Environment status
Last test result
Test button
```

No implicit global tools for production agents.

## HubTiger admin

Add:

```text
Tool Settings → HubTiger
```

Required sections:

```text
Connection
Permissions
Tool Bindings
Test Console
Recent Tool Traces
```

Connection fields:

```text
HUBTIGER_AUTH_MODE
HUBTIGER_TOOL_ACCESS
HUBTIGER_USERNAME status only, not value
HUBTIGER_PASSWORD status only, not value
HUBTIGER_API_CODE status only, not value
HUBTIGER_PARTNER_ID
HUBTIGER_CREATED_BY_USER_ID
Store technician map
First service type IDs
Default service type IDs
```

Secrets must never be displayed.

## HubTiger read-only mode

During testing:

```env
HUBTIGER_TOOL_ACCESS=read_only
```

Write tools may be visible but must be blocked safely.

Blocked write response:

```text
Read-only mode is enabled, so I can check details but cannot create or change records yet.
```

## HubTiger test console

### Availability test

Inputs:

```text
store
start date
end date
service type IDs optional
```

Calls:

```text
hubtiger_booking_availability
```

### Job search test

Inputs:

```text
customer name / phone / job number
```

Calls:

```text
hubtiger_job_search
hubtiger_job_get
```

### Product / quote preview test

Inputs:

```text
product query
quantity
```

Calls:

```text
hubtiger_products_search
hubtiger_quote_preview_price
```

### Write tests

Only enabled if:

```env
HUBTIGER_TOOL_ACCESS=read_write
```

Otherwise show:

```text
Read-only mode: write tests are disabled.
```
