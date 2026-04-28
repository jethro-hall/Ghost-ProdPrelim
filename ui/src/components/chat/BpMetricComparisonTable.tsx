type MetricRow = {
  metric: string;
  burleigh: number | null;
  brisbane: number | null;
  higherIsBetter?: boolean;
};

type Props = {
  rows: MetricRow[];
};

function formatCell(value: number | null): string {
  if (value == null || Number.isNaN(value)) return "n/a";
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export default function BpMetricComparisonTable({ rows }: Props) {
  if (!rows.length) return null;
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200">
      <table className="w-full min-w-[420px] text-left text-[0.75rem]">
        <thead className="bg-slate-50">
          <tr>
            <th className="px-3 py-2 font-semibold text-slate-700">Metric</th>
            <th className="px-3 py-2 font-semibold text-slate-700">Burleigh</th>
            <th className="px-3 py-2 font-semibold text-slate-700">Brisbane</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const higherIsBetter = row.higherIsBetter ?? true;
            const burleighBetter =
              row.burleigh != null &&
              row.brisbane != null &&
              (higherIsBetter ? row.burleigh > row.brisbane : row.burleigh < row.brisbane);
            const brisbaneBetter =
              row.burleigh != null &&
              row.brisbane != null &&
              (higherIsBetter ? row.brisbane > row.burleigh : row.brisbane < row.burleigh);
            return (
              <tr key={row.metric} className="border-t border-slate-100">
                <td className="px-3 py-2 font-medium text-slate-900">{row.metric}</td>
                <td className={`px-3 py-2 ${burleighBetter ? "font-semibold text-emerald-700" : "text-slate-700"}`}>
                  {formatCell(row.burleigh)}
                </td>
                <td className={`px-3 py-2 ${brisbaneBetter ? "font-semibold text-emerald-700" : "text-slate-700"}`}>
                  {formatCell(row.brisbane)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

