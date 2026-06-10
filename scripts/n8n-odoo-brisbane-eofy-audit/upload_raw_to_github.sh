#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# upload_raw_to_github.sh
#
# Push raw (untouched) Odoo JSONL export files to:
#   https://github.com/jethro-hall/Claudeopus_Odoo_Audit
#
# Intent: No tampering. Files are copied exactly as extracted from Odoo.
# Large files (>50MB) are split into 95MB parts and optionally gzip-compressed
# so every part stays within GitHub's 100MB per-file hard limit.
#
# Usage:
#   ./upload_raw_to_github.sh [snapshot_id]
#   ./upload_raw_to_github.sh                  # uses latest snapshot
#   COMPRESS=0 ./upload_raw_to_github.sh       # skip gzip (faster, larger files)
#   DRY_RUN=1  ./upload_raw_to_github.sh       # print plan without uploading
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────────────
EXPORT_ROOT="/var/lib/docker/volumes/ghoststack-rag_n8n_data/_data/odoo_forensic_exports"
REPO_URL="https://github.com/jethro-hall/Claudeopus_Odoo_Audit"
REPO_CLONE_DIR="/tmp/ClaudeOpus_Odoo_Audit_push"
COMPRESS="${COMPRESS:-1}"          # 1 = gzip files before push
DRY_RUN="${DRY_RUN:-0}"           # 1 = print plan only
SPLIT_BYTES=$((95 * 1024 * 1024)) # 95MB — safely under GitHub 100MB limit
GIT_BRANCH="main"

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# ── Resolve snapshot ─────────────────────────────────────────────────────────
if [[ -n "${1:-}" ]]; then
  SNAP_ID="$1"
else
  SNAP_ID=$(ls -1t "$EXPORT_ROOT" | grep -v 'audit_csv_bundles' | head -1)
fi

SNAP_DIR="$EXPORT_ROOT/$SNAP_ID"
if [[ ! -d "$SNAP_DIR" ]]; then
  error "Snapshot not found: $SNAP_DIR"
  exit 1
fi
info "Snapshot: $SNAP_ID"
info "Source:   $SNAP_DIR"

# ── Verify gh auth ───────────────────────────────────────────────────────────
if ! gh auth status &>/dev/null; then
  error "GitHub CLI not authenticated. Run: gh auth login"
  exit 1
fi
GH_USER=$(gh api user --jq .login 2>/dev/null)
ok "GitHub CLI authenticated as: $GH_USER"

# ── Collect raw source files ──────────────────────────────────────────────────
declare -a SOURCE_FILES=()
for stage_dir in "$SNAP_DIR"/*/raw; do
  [[ -d "$stage_dir" ]] || continue
  while IFS= read -r -d '' f; do
    SOURCE_FILES+=("$f")
  done < <(find "$stage_dir" -name "*.jsonl" -print0 | sort -z)
done

if [[ ${#SOURCE_FILES[@]} -eq 0 ]]; then
  error "No raw .jsonl files found under $SNAP_DIR"
  exit 1
fi

info "Found ${#SOURCE_FILES[@]} raw files to upload"

# ── Dry run: print plan ───────────────────────────────────────────────────────
total_bytes=0
for f in "${SOURCE_FILES[@]}"; do
  bytes=$(stat -c%s "$f")
  total_bytes=$((total_bytes + bytes))
  size_h=$(numfmt --to=iec-i --suffix=B "$bytes" 2>/dev/null || echo "${bytes}B")
  rows=$(wc -l < "$f")
  model=$(basename "$f" .jsonl)
  printf "  %-45s  %8d rows  %s\n" "$model" "$rows" "$size_h"
done
total_h=$(numfmt --to=iec-i --suffix=B "$total_bytes" 2>/dev/null || echo "${total_bytes}B")
info "Total raw size: $total_h"
info "Compress mode: $([ "$COMPRESS" = "1" ] && echo "yes (gzip)" || echo "no")"

if [[ "$DRY_RUN" = "1" ]]; then
  warn "DRY RUN — no files uploaded. Set DRY_RUN=0 to push."
  exit 0
fi

# ── Clone / reset repo ────────────────────────────────────────────────────────
if [[ -d "$REPO_CLONE_DIR" ]]; then
  info "Removing stale clone at $REPO_CLONE_DIR"
  rm -rf "$REPO_CLONE_DIR"
fi

info "Cloning $REPO_URL …"
gh repo clone "jethro-hall/Claudeopus_Odoo_Audit" "$REPO_CLONE_DIR" -- --branch "$GIT_BRANCH" --depth 1
cd "$REPO_CLONE_DIR"

git config user.name  "Jeff Hall"
git config user.email "research@rideelectric.com.au"

# ── Create directory structure ────────────────────────────────────────────────
RAW_DEST="raw_data/$SNAP_ID"
mkdir -p "$RAW_DEST"

# ── Write README for this snapshot ───────────────────────────────────────────
cat > "$RAW_DEST/README.md" <<SNAPREADME
# Odoo Raw Export — $SNAP_ID

## Source
- **Odoo instance**: RE-Staging-2026-01-08 (https://rid002-17-dev.black.wedoo.co.nz)
- **Company**: Ride Electric Brisbane (company_id=4)
- **FY period**: 2024-07-01 → 2025-06-30
- **Extracted**: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
- **Snapshot ID**: $SNAP_ID

## Integrity
Files in this directory are **raw, unmodified JSONL** as extracted from the Odoo
JSON-RPC API. No sanitisation, no PII hashing, no field filtering, no row filtering.

Each .jsonl file contains one JSON object per line, as returned by the Odoo API
\`execute_kw\` method for the corresponding model.

Compressed files (.jsonl.gz) are identical to their uncompressed counterparts —
decompress with: \`gunzip *.gz\`

Large files are split into numbered parts (.part.00, .part.01, …).
Reassemble with: \`cat model.jsonl.gz.part.* > model.jsonl.gz\`

## Models included
SNAPREADME

for f in "${SOURCE_FILES[@]}"; do
  rows=$(wc -l < "$f")
  model=$(basename "$f" .jsonl)
  printf -- "- %-45s  %d rows\n" "$model" "$rows" >> "$RAW_DEST/README.md"
done

# ── Copy files, compress and/or split if needed ───────────────────────────────
info "Copying and preparing files …"

for f in "${SOURCE_FILES[@]}"; do
  model=$(basename "$f" .jsonl)
  bytes=$(stat -c%s "$f")

  if [[ "$COMPRESS" = "1" ]]; then
    dest_name="${model}.jsonl.gz"
    info "  Compressing $model …"
    gzip -c "$f" > "$RAW_DEST/$dest_name"
    final_bytes=$(stat -c%s "$RAW_DEST/$dest_name")
  else
    dest_name="${model}.jsonl"
    cp "$f" "$RAW_DEST/$dest_name"
    final_bytes=$bytes
  fi

  # Split if still too large
  if [[ "$final_bytes" -gt "$SPLIT_BYTES" ]]; then
    warn "  $dest_name is $(numfmt --to=iec-i --suffix=B "$final_bytes") — splitting into 95MB parts"
    split --bytes="$SPLIT_BYTES" --suffix-length=2 --numeric-suffixes \
      "$RAW_DEST/$dest_name" "$RAW_DEST/${dest_name}.part."
    rm "$RAW_DEST/$dest_name"
    ok "  Split: $(ls "$RAW_DEST/${dest_name}.part."* 2>/dev/null | wc -l) parts"
  else
    size_h=$(numfmt --to=iec-i --suffix=B "$final_bytes" 2>/dev/null || echo "${final_bytes}B")
    ok "  $dest_name  ($size_h)"
  fi
done

# ── Copy stage_pack.json files (metadata, no raw rows) ────────────────────────
for stage_dir in "$SNAP_DIR"/*/; do
  stage_name=$(basename "$stage_dir")
  for meta_file in "$stage_dir"/*.json; do
    [[ -f "$meta_file" ]] || continue
    mkdir -p "$RAW_DEST/metadata/$stage_name"
    cp "$meta_file" "$RAW_DEST/metadata/$stage_name/"
    ok "  metadata: $stage_name/$(basename "$meta_file")"
  done
done

# ── Write top-level repo README ───────────────────────────────────────────────
cat > README.md <<'ROOTREADME'
# Claudeopus_Odoo_Audit

Raw Odoo data repository for forensic audit by Claude Opus.

## Structure

```
raw_data/
  <snapshot_id>/
    README.md            — snapshot provenance and model list
    <model>.jsonl.gz     — raw Odoo records, gzip-compressed
    metadata/            — stage packs, metrics, anomaly packs (no raw rows)
```

## Provenance

Data is extracted directly from the Odoo JSON-RPC API with no post-processing.
Files are compressed (gzip) to fit GitHub's file limits but are otherwise byte-
for-byte identical to the Odoo API response.

## Decompression

```bash
gunzip -k raw_data/<snapshot_id>/*.jsonl.gz
```

## Reassembling split files

```bash
cat raw_data/<snapshot_id>/account.partial.reconcile.jsonl.gz.part.* \
  > /tmp/account.partial.reconcile.jsonl.gz
gunzip /tmp/account.partial.reconcile.jsonl.gz
```

## Audit tools

- **MCP endpoint**: https://workflow.rideai.com.au/webhook/odoo-eofy-forensic-mcp-v3
- **Tools**: odoo_audit_init, odoo_query, odoo_aggregate, odoo_schema, odoo_bundle_csv, …
- **Token strategy**: Call `odoo_audit_init` first, then use `odoo_query` with filters for targeted access.

ROOTREADME

# ── Commit and push ───────────────────────────────────────────────────────────
info "Staging files for commit …"
git add -A

changed=$(git status --short | wc -l)
if [[ "$changed" -eq 0 ]]; then
  warn "Nothing changed — repo already up to date."
  exit 0
fi

info "Committing $changed file(s) …"
git commit -m "$(cat <<EOF
feat: upload raw Odoo EOFY export — $SNAP_ID

Source: RE-Staging-2026-01-08 (rid002-17-dev.black.wedoo.co.nz)
Company: Ride Electric Brisbane (company_id=4)
FY: 2024-07-01 → 2025-06-30
Extracted: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
Files: ${#SOURCE_FILES[@]} models, raw JSONL (gzip-compressed)

No sanitisation. No field filtering. No row filtering.
Byte-for-byte Odoo API output, compressed for GitHub storage.
EOF
)"

info "Pushing to $REPO_URL …"
git push origin "$GIT_BRANCH"

ok "Push complete."
echo ""
echo "  Repository: https://github.com/jethro-hall/Claudeopus_Odoo_Audit"
echo "  Snapshot:   raw_data/$SNAP_ID/"
echo ""
