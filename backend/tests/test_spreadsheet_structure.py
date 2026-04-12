from __future__ import annotations

import tempfile
from pathlib import Path

import openpyxl

from ghostdash_api import ingest


def test_extract_spreadsheet_structure_merges_formula_when_no_cached_value() -> None:
    path = Path(tempfile.mkdtemp()) / "formula.xlsx"
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Filters"
    ws.append(["company", "ride_electric_brisbane"])
    ws.append(["=IF(1=1,\"yes\",\"no\")", 42])
    wb.save(path)

    structure = ingest.extract_spreadsheet_structure(path)
    assert structure is not None
    filters = next(s for s in structure["sheets"] if s["title"] == "Filters")
    assert len(filters["rows"]) == 2
    data_row = filters["rows"][1]
    assert "=IF(1=1" in data_row[0] or data_row[0] == "yes"
    assert data_row[1] == "42"


def test_merge_spreadsheet_cell_display_prefers_cached_value() -> None:
    assert ingest._merge_spreadsheet_cell_display(99, "=A1*2") == "99"
    assert ingest._merge_spreadsheet_cell_display(None, "=SUM(A1:A2)") == "=SUM(A1:A2)"
    assert ingest._merge_spreadsheet_cell_display("  ", "=X+1") == "=X+1"
