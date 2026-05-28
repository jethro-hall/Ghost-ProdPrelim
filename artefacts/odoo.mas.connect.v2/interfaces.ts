export type IntentPayload = {
  intent: string;
  metrics: string[];
  dimensions: Record<string, string[]>;
  period: { date_from: string; date_to: string };
  presentation_mode: string;
  ambiguities: string[];
  confidence: number;
};

export type SourceExecutionRequest = {
  source_key: string;
  system: "odoo" | "external";
  purpose: string[];
  params: Record<string, unknown>;
};

export type NormalizedReportLine = {
  code: string;
  label: string;
  section: string;
  value: number | null;
  level: number;
  parent_code: string | null;
};

export type NormalizedReport = {
  report_key: string;
  dimension_scope: Record<string, string>;
  period: { date_from: string; date_to: string };
  lines: NormalizedReportLine[];
};

export type MetricRow = {
  business_unit: string;
  revenue?: number | null;
  cogs?: number | null;
  gross_profit?: number | null;
  net_profit?: number | null;
  ad_spend?: number | null;
  roas?: number | null;
};

export type MetricPack = {
  period: string;
  dimension?: string;
  rows: MetricRow[];
  confidence: Record<string, string>;
  gaps: string[];
};
