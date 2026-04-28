from __future__ import annotations

from pydantic import BaseModel, Field


class PeriodScope(BaseModel):
    date_from: str
    date_to: str


class IntentPayload(BaseModel):
    intent: str
    metrics: list[str] = Field(default_factory=list)
    dimensions: dict[str, list[str]] = Field(default_factory=dict)
    period: PeriodScope
    granularity: str = "period"
    presentation_mode: str = "board_ready"
    output: str = "board_ready"
    include_ledger_evidence: bool = False
    ambiguities: list[str] = Field(default_factory=list)
    confidence: float = 0.0


class SourceExecutionRequest(BaseModel):
    source_key: str
    system: str
    purpose: list[str] = Field(default_factory=list)
    params: dict[str, object] = Field(default_factory=dict)


class SourcePlan(BaseModel):
    sources: list[SourceExecutionRequest] = Field(default_factory=list)
    derived_metrics: list[dict[str, object]] = Field(default_factory=list)
    fallbacks: list[dict[str, object]] = Field(default_factory=list)


class NormalizedReportLine(BaseModel):
    code: str
    label: str
    section: str
    value: float | None
    level: int = 1
    parent_code: str | None = None


class NormalizedReport(BaseModel):
    report_key: str
    dimension_scope: dict[str, str] = Field(default_factory=dict)
    period: PeriodScope
    lines: list[NormalizedReportLine] = Field(default_factory=list)
    metadata: dict[str, object] = Field(default_factory=dict)


class MetricRow(BaseModel):
    business_unit: str
    revenue: float | None = None
    cogs: float | None = None
    gross_profit: float | None = None
    gross_margin_pct: float | None = None
    net_profit: float | None = None
    marketing_cost_total: float | None = None
    ad_spend: float | None = None
    roas: float | None = None
    revenue_roas: float | None = None
    gp_roas: float | None = None
    contribution_margin: float | None = None


class MonthlyMetricRow(BaseModel):
    business_unit: str
    month: str
    revenue: float | None = None
    cogs: float | None = None
    gross_profit: float | None = None
    gross_margin_pct: float | None = None
    marketing_cost_total: float | None = None
    change_vs_prior_month: float | None = None
    pct_change_vs_prior_month: float | None = None


class OpexLedgerRow(BaseModel):
    business_unit: str
    month: str
    account: str
    amount: float
    account_class: str | None = None
    include_in_metric: bool = False
    status: str = "active_in_period"


class MetricPack(BaseModel):
    period: str
    dimension: str = "business_unit"
    rows: list[MetricRow] = Field(default_factory=list)
    monthly_rows: list[MonthlyMetricRow] = Field(default_factory=list)
    ledger_rows: list[OpexLedgerRow] = Field(default_factory=list)
    confidence: dict[str, str] = Field(default_factory=dict)
    gaps: list[str] = Field(default_factory=list)


class FinanceReasoningResult(BaseModel):
    headline: str
    findings: list[str] = Field(default_factory=list)
    winner: str | None = None
    efficiency_winner: str | None = None
    gross_margin_winner: str | None = None
    caveats: list[str] = Field(default_factory=list)
    confidence: str = "medium"
