export type SourceType = "default_report" | "journal_dashboard";
export type QuestionType = "strategic" | "analytical" | "operational";

export interface SelectedSource {
  source_type: SourceType;
  source_name: string;
}

export interface RouterOutput {
  primary_intent: string;
  secondary_intents: string[];
  question_type: QuestionType;
  entities: string[];
  time_range: string | null;
  comparison: boolean;
  primary_source: SelectedSource;
  secondary_sources: SelectedSource[];
  confidence: number;
  reason: string;
}

export interface EvidencePack {
  source: string;
  period: { from: string; to: string };
  currency: string;
  metrics: Record<string, unknown>;
  notes: string[];
  top_positive_drivers?: [string, number][];
  top_negative_drivers?: [string, number][];
}
