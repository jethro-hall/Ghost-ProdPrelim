from __future__ import annotations

from .contracts import NormalizedReport


def build_quality_flags(reports: list[NormalizedReport]) -> list[str]:
    flags: list[str] = []
    for report in reports:
        if not report.lines:
            flags.append(f"{report.report_key}:empty_lines")
            continue
        for line in report.lines:
            if line.value is None:
                flags.append(f"{report.report_key}:{line.code}:missing_value")
        if report.report_key == "profit_and_loss":
            if any(line.code == "roas" and line.value is None for line in report.lines):
                flags.append("roas_unavailable")
    return sorted(set(flags))
