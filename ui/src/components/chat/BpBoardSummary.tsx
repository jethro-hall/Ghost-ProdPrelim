import BpMetricComparisonTable from "./BpMetricComparisonTable";
import BpMetricCharts from "./BpMetricCharts";

type MetricRow = {
  metric: string;
  burleigh: number | null;
  brisbane: number | null;
  higherIsBetter?: boolean;
};

type Props = {
  rows: MetricRow[];
  explanation?: string;
};

export default function BpBoardSummary({ rows, explanation }: Props) {
  if (!rows.length && !explanation) return null;
  return (
    <section className="mt-2 space-y-2 rounded-xl border border-emerald-200 bg-emerald-50/40 px-3 py-3">
      <div className="text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-emerald-700">
        BP Board Pack
      </div>
      <BpMetricComparisonTable rows={rows} />
      <BpMetricCharts rows={rows} />
      {explanation && <div className="text-[0.75rem] leading-relaxed text-slate-700">{explanation}</div>}
    </section>
  );
}

