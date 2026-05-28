type MetricRow = {
  metric: string;
  burleigh: number | null;
  brisbane: number | null;
};

type Props = {
  rows: MetricRow[];
};

export default function BpMetricCharts({ rows }: Props) {
  const usable = rows.filter((row) => row.burleigh != null || row.brisbane != null).slice(0, 6);
  if (!usable.length) return null;
  const maxValue = Math.max(
    1,
    ...usable.flatMap((row) => [Math.abs(row.burleigh ?? 0), Math.abs(row.brisbane ?? 0)])
  );

  return (
    <div className="space-y-2 rounded-xl border border-slate-200 bg-white px-3 py-3">
      <div className="text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-slate-500">Metric Graphs</div>
      {usable.map((row) => {
        const burleighWidth = Math.round((Math.abs(row.burleigh ?? 0) / maxValue) * 100);
        const brisbaneWidth = Math.round((Math.abs(row.brisbane ?? 0) / maxValue) * 100);
        return (
          <div key={row.metric} className="space-y-1">
            <div className="text-[0.72rem] font-semibold text-slate-800">{row.metric}</div>
            <div className="flex items-center gap-2 text-[0.68rem]">
              <span className="w-[62px] text-slate-600">Burleigh</span>
              <div className="h-2 flex-1 rounded bg-slate-100">
                <div className="h-2 rounded bg-blue-500" style={{ width: `${burleighWidth}%` }} />
              </div>
            </div>
            <div className="flex items-center gap-2 text-[0.68rem]">
              <span className="w-[62px] text-slate-600">Brisbane</span>
              <div className="h-2 flex-1 rounded bg-slate-100">
                <div className="h-2 rounded bg-emerald-500" style={{ width: `${brisbaneWidth}%` }} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

