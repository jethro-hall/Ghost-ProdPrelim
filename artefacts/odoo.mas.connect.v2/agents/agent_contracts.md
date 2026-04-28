# Agent Contracts

## 1. intent-router-agent
### Input
- `user_query: string`
- `today_iso: string`
- `metric_registry`
- `dimension_registry`

### Output
```json
{
  "intent": "comparative_branch_performance",
  "metrics": ["revenue", "cogs", "gross_profit", "net_profit", "roas"],
  "dimensions": {
    "business_unit": ["Ride Electric Burleigh", "Ride Electric Brisbane"]
  },
  "period": {
    "date_from": "2026-03-01",
    "date_to": "2026-03-31"
  },
  "presentation_mode": "board_ready",
  "ambiguities": [],
  "confidence": 0.92
}
```

## 2. source-planner-agent
### Input
- `IntentPayload`
- `metric_registry`
- `dimension_registry`
- `source_registry`

### Output
```json
{
  "sources": [
    {
      "source_key": "profit_and_loss",
      "system": "odoo",
      "purpose": ["revenue", "cogs", "net_profit"],
      "params": {
        "date_from": "2026-03-01",
        "date_to": "2026-03-31",
        "business_unit": "Ride Electric Burleigh",
        "posted_only": true
      }
    }
  ],
  "derived_metrics": [
    {"metric": "gross_profit", "formula": "revenue - cogs"},
    {"metric": "roas", "formula": "revenue / ad_spend"}
  ],
  "fallbacks": []
}
```

## 3. odoo-report-extractor-agent
### Input
- `SourceExecutionRequest`

### Output
```json
{
  "source_key": "profit_and_loss",
  "system": "odoo",
  "requested_at": "2026-04-23T10:00:00Z",
  "params": {},
  "raw_payload": {}
}
```

## 4. report-normalizer-agent
### Input
- raw extractor payload

### Output
```json
{
  "report_key": "profit_and_loss",
  "dimension_scope": {"business_unit": "Ride Electric Burleigh"},
  "period": {"date_from": "2026-03-01", "date_to": "2026-03-31"},
  "lines": []
}
```

## 5. metric-assembler-agent
### Input
- normalized reports
- external source payloads

### Output
```json
{
  "period": "2026-03",
  "rows": [],
  "comparisons": {},
  "gaps": []
}
```

## 6. finance-reasoner-agent
### Input
- `MetricPack`
- user question
- answer mode

### Output
```json
{
  "headline": "",
  "findings": [],
  "winner": "",
  "caveats": [],
  "confidence": "high"
}
```

## 7. board-composer-agent
### Input
- reasoning payload
- metric pack

### Output
Markdown response only.
