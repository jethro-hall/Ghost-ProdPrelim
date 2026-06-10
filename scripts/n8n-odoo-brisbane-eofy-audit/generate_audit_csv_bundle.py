#!/usr/bin/env python3
"""
Generate compact audit CSV bundle from sanitised JSONL exports.

Outputs one CSV per model with only forensically critical fields.
Skips pure join tables (account.full.reconcile, account.partial.reconcile).
Produces a zip bundle Claude can receive as a file.

Usage:
  python3 generate_audit_csv_bundle.py [snapshot_id]
  python3 generate_audit_csv_bundle.py  # uses latest snapshot
"""

import csv
import json
import os
import re
import sys
import zipfile
from pathlib import Path
from datetime import datetime

EXPORT_ROOT = Path("/var/lib/docker/volumes/ghoststack-rag_n8n_data/_data/odoo_forensic_exports")
OUT_DIR = Path("/var/lib/docker/volumes/ghoststack-rag_n8n_data/_data/odoo_forensic_exports/audit_csv_bundles")

# ─── FIELD MAPS ───────────────────────────────────────────────────────────────
# For each model: ordered list of CSV columns to include.
# _label fields preferred over _id where they carry meaning.
# Skip redundant duplicates (e.g. partner_id + partner_id_id + partner_id_label → use _id and _label only).

FIELD_MAP = {
    # LEDGER
    "account.move": [
        "id", "name", "move_type", "state", "date", "invoice_date", "invoice_date_due",
        "journal_id_label", "partner_id_label", "currency_id_label",
        "amount_total", "amount_untaxed", "amount_tax", "amount_residual",
        "payment_state", "reversed_entry_id", "reversal_move_id",
        "ref", "invoice_origin",
        "create_uid_id", "write_uid_id", "create_date", "write_date",
    ],
    "account.move.line": [
        "id", "move_id_id", "move_id_label", "parent_state",
        "date", "account_id_id", "account_id_label",
        "journal_id_label", "partner_id_label",
        "debit", "credit", "balance",
        "tax_ids", "tax_line_id", "tax_base_amount",
        "reconciled", "full_reconcile_id_id", "matching_number",
        "payment_id", "statement_line_id",
        "quantity", "price_unit", "discount", "price_subtotal", "price_total",
        "create_uid_id", "write_uid_id", "create_date", "write_date",
    ],
    "account.payment": [
        "id", "name", "payment_type", "partner_type", "state",
        "date", "amount", "currency_id_label",
        "partner_id_label", "journal_id_label",
        "payment_method_id_label", "destination_account_id_label",
        "is_reconciled", "move_id_id",
        "ref",
        "create_uid_id", "write_uid_id", "create_date", "write_date",
    ],
    "account.account": [
        "id", "name", "code", "account_type", "reconcile",
        "create_date", "write_date",
    ],
    "account.journal": [
        "id", "name", "code", "type",
        "create_date", "write_date",
    ],
    "account.tax": [
        "id", "name", "amount", "amount_type", "type_tax_use",
        "create_date", "write_date",
    ],
    "account.bank.statement": [
        "id", "name", "date", "balance_start", "balance_end_real",
        "journal_id_label", "state",
        "create_date", "write_date",
    ],
    "account.bank.statement.line": [
        "id", "statement_id", "date", "payment_ref", "partner_id_label",
        "amount", "journal_id_label",
        "is_reconciled",
        "create_date", "write_date",
    ],
    # POS
    "pos.order": [
        "id", "name", "state",
        "date_order", "session_id_label", "config_id_label",
        "partner_id_label", "user_id_id",
        "amount_total", "amount_tax", "amount_paid", "amount_return",
        "account_move",
        "create_uid_id", "write_uid_id", "create_date", "write_date",
    ],
    "pos.order.line": [
        "id", "order_id_id", "order_id_label",
        "product_id_label",
        "qty", "price_unit", "discount",
        "price_subtotal", "price_subtotal_incl",
        "tax_ids",
        "create_date", "write_date",
    ],
    "pos.payment": [
        "id", "pos_order_id_id",
        "payment_method_id_label", "session_id_label",
        "amount", "payment_date",
        "create_uid_id", "write_uid_id", "create_date", "write_date",
    ],
    "pos.payment.method": [
        "id", "name", "split_transactions", "is_cash_count",
        "create_date", "write_date",
    ],
    "pos.session": [
        "id", "name", "state",
        "config_id_label",
        "start_at", "stop_at",
        "opening_notes", "closing_notes",
        "create_uid_id", "write_uid_id",
    ],
    "pos.config": [
        "id", "name", "active", "currency_id_label",
        "create_date", "write_date",
    ],
    "pos.category": [
        "id", "name", "parent_id",
        "create_date", "write_date",
    ],
}

# These are pure join tables — no audit value as standalone rows
SKIP_MODELS = {
    "account.full.reconcile",
    "account.partial.reconcile",
}


def find_latest_snapshot():
    snaps = sorted(
        [d.name for d in EXPORT_ROOT.iterdir()
         if d.is_dir() and d.name.startswith("eofy_") and not d.name.startswith("eofy_.")],
        reverse=True,
    )
    for s in snaps:
        if (EXPORT_ROOT / s / "01_account_ledger" / "raw").exists():
            return s
    return snaps[0] if snaps else None


def find_model_files(snapshot_id: str):
    """Return {model_name: path} preferring sanitised over raw."""
    base = EXPORT_ROOT / snapshot_id
    files = {}
    stages = ["01_account_ledger", "02_pos_retail"]

    for stage in stages:
        # sanitised preferred
        san_dir = base / "03_sanitise_profile" / "sanitised" / stage
        if san_dir.exists():
            for f in san_dir.glob("*.sanitised.jsonl"):
                model = f.name.replace(".sanitised.jsonl", "")
                files[model] = f
            continue
        # raw fallback
        raw_dir = base / stage / "raw"
        if raw_dir.exists():
            for f in raw_dir.glob("*.jsonl"):
                model = f.name.replace(".jsonl", "")
                files[model] = f

    return files


def read_jsonl(path: Path):
    rows = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return rows


def flatten_value(v):
    """Flatten list/dict values to a simple string for CSV."""
    if v is None or v is False:
        return ""
    if v is True:
        return "true"
    if isinstance(v, list):
        return "|".join(str(x) for x in v if x is not None)
    if isinstance(v, dict):
        return json.dumps(v, separators=(",", ":"))
    return str(v)


def rows_to_csv_bytes(rows: list, fields: list) -> bytes:
    import io
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    # Discover all actual fields from the first row
    if not rows:
        writer.writerow(fields)
        return buf.getvalue().encode()

    # Use specified fields, falling back to any that exist in the first row
    actual = [f for f in fields if f in rows[0]]
    if not actual:
        actual = [k for k in rows[0].keys() if not k.startswith("_")]

    writer.writerow(actual)
    for row in rows:
        writer.writerow([flatten_value(row.get(f)) for f in actual])

    return buf.getvalue().encode()


def control_totals(model: str, rows: list) -> dict:
    totals: dict = {"rows": len(rows)}
    numeric_fields = [
        "debit", "credit", "balance", "amount", "amount_total",
        "amount_tax", "amount_paid", "amount_return", "amount_residual",
        "price_subtotal", "price_subtotal_incl", "price_total",
        "qty", "quantity",
    ]
    for f in numeric_fields:
        vals = [r[f] for r in rows if isinstance(r.get(f), (int, float))]
        if vals:
            totals[f"sum_{f}"] = round(sum(vals), 2)
            totals[f"min_{f}"] = round(min(vals), 2)
            totals[f"max_{f}"] = round(max(vals), 2)

    return totals


def generate_bundle(snapshot_id: str, out_dir: Path) -> Path:
    model_files = find_model_files(snapshot_id)
    ts = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    zip_name = f"eofy_audit_bundle_{snapshot_id[:30]}_{ts}.zip"
    zip_path = out_dir / zip_name
    out_dir.mkdir(parents=True, exist_ok=True)

    manifest = {
        "snapshot_id": snapshot_id,
        "generated_at_utc": ts,
        "scope": {
            "company_id": 4,
            "company_name": "Ride Electric Brisbane",
            "fy_start": "2024-07-01",
            "fy_end": "2025-06-30",
        },
        "files": [],
        "skipped_models": list(SKIP_MODELS),
        "skip_reason": "account.full.reconcile and account.partial.reconcile are internal join tables with no standalone audit value.",
    }

    control_summary = {}

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for model, filepath in sorted(model_files.items()):
            if model in SKIP_MODELS:
                print(f"  SKIP  {model}")
                continue

            print(f"  READ  {model} ... ", end="", flush=True)
            rows = read_jsonl(filepath)
            print(f"{len(rows)} rows", end="")

            fields = FIELD_MAP.get(model)
            csv_bytes = rows_to_csv_bytes(rows, fields or [])
            csv_name = f"{model}.csv"
            zf.writestr(csv_name, csv_bytes)

            totals = control_totals(model, rows)
            control_summary[model] = totals

            size_kb = len(csv_bytes) / 1024
            print(f"  → {size_kb:.0f} KB CSV")

            manifest["files"].append({
                "model": model,
                "csv_file": csv_name,
                "rows": len(rows),
                "csv_bytes": len(csv_bytes),
                "fields": fields or "all",
            })

        # Write manifest JSON
        manifest["control_totals"] = control_summary
        manifest_bytes = json.dumps(manifest, indent=2).encode()
        zf.writestr("MANIFEST.json", manifest_bytes)

        # Write README
        readme = generate_readme(snapshot_id, manifest)
        zf.writestr("README.txt", readme.encode())

    zip_size = zip_path.stat().st_size
    print(f"\nBundle: {zip_path}")
    print(f"Size:   {zip_size / 1024 / 1024:.1f} MB compressed")
    return zip_path


def generate_readme(snapshot_id: str, manifest: dict) -> str:
    lines = [
        "ODOO EOFY FORENSIC AUDIT BUNDLE",
        "================================",
        f"Snapshot:  {snapshot_id}",
        f"Generated: {manifest['generated_at_utc']}",
        f"Company:   Ride Electric Brisbane (company_id=4)",
        f"Period:    2024-07-01 to 2025-06-30 (FY25)",
        "",
        "CONTENTS",
        "--------",
    ]
    for f in manifest["files"]:
        lines.append(f"  {f['csv_file']:50s} {f['rows']:6d} rows")
    lines += [
        "",
        "SKIPPED MODELS",
        "--------------",
        "  account.full.reconcile      — internal join table (links reconciled line IDs)",
        "  account.partial.reconcile   — internal join table (partial match records)",
        "  These models carry no standalone audit value. Reconciliation status is shown",
        "  in account.move.line via the 'reconciled' and 'full_reconcile_id_id' fields.",
        "",
        "AUDIT GUIDANCE",
        "--------------",
        "  This is sanitised source data. Identifiers (names, emails, ABNs) have been",
        "  replaced with stable hashed IDs. Bank details and credentials are redacted.",
        "  All numerical values are preserved exactly.",
        "",
        "  Recommended analysis sequence:",
        "  1. account.move       — all journal entries (invoices, credit notes, payments, manual)",
        "  2. account.move.line  — debit/credit lines; verify debit=credit per move_id_id",
        "  3. account.payment    — payment register",
        "  4. pos.order          — POS transactions; verify amount_total=amount_paid",
        "  5. pos.order.line     — line items per POS order",
        "  6. pos.payment        — payment per POS order; cross-reference to account.move",
        "  7. account.bank.statement.line — bank feed entries",
        "",
        "  Key anomaly signals to look for:",
        "  - account.move.line: rows where write_date > 2025-06-30 (post-FY edits)",
        "  - account.move.line: debit != credit for same move_id_id",
        "  - account.move.line: reconciled=false with non-zero balance (receivable/payable)",
        "  - account.move: payment_state != 'paid' for old invoices",
        "  - account.move: reversed_entry_id or reversal_move_id is set (reversals)",
        "  - pos.order: amount_total != amount_paid (payment shortfall)",
        "  - pos.order: state='done' but account_move is empty (no accounting entry)",
        "  - pos.order.line: discount > 0 (discretionary discounts)",
        "  - account.payment: is_reconciled=false",
        "",
        "  MANIFEST.json contains control totals (sum/min/max of numeric fields)",
        "  for each model computed over ALL rows. Verify your analysis against these.",
        "",
        "  Identifiers prefixed with hash_ are stable anonymised IDs.",
        "  Do not attempt re-identification. Use hashes for grouping only.",
    ]
    return "\n".join(lines)


def main():
    snap = sys.argv[1] if len(sys.argv) > 1 else find_latest_snapshot()
    if not snap:
        print("No snapshots found under", EXPORT_ROOT)
        sys.exit(1)

    print(f"Snapshot: {snap}")
    print(f"Output:   {OUT_DIR}")
    print()

    zip_path = generate_bundle(snap, OUT_DIR)

    # Also symlink to a fixed name for easy access
    latest = OUT_DIR / "latest_audit_bundle.zip"
    if latest.exists() or latest.is_symlink():
        latest.unlink()
    latest.symlink_to(zip_path.name)

    print(f"\nSymlink:  {latest}")
    print()
    print("To give to Claude:")
    print(f"  Upload: {zip_path}")
    print("  Or add to Claude Desktop filesystem MCP:")
    print(f"  Path: {OUT_DIR}")


if __name__ == "__main__":
    main()
