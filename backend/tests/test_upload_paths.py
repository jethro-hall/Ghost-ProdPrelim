from pathlib import Path

from ghostdash_api.control_api import _safe_relative_upload_path


def test_safe_relative_upload_path_preserves_nested_structure() -> None:
    assert _safe_relative_upload_path("reports/fy25/ledger.pdf") == Path("reports/fy25/ledger.pdf")


def test_safe_relative_upload_path_normalizes_windows_separators() -> None:
    assert _safe_relative_upload_path("reports\\fy25\\ledger.pdf") == Path("reports/fy25/ledger.pdf")


def test_safe_relative_upload_path_blocks_traversal() -> None:
    assert _safe_relative_upload_path("../../etc/passwd") == Path("etc/passwd")


def test_safe_relative_upload_path_falls_back_for_empty() -> None:
    assert _safe_relative_upload_path("") == Path("upload")
