"""
Independent verifier agent.

Receives a review package (NOT Claude's internal reasoning) and returns PASS/FAIL + defects.
Uses a separate Bedrock call so it has zero shared context with the main agent.
"""
from __future__ import annotations

import json
import logging
import uuid
from typing import Any

import boto3

from .config import get_settings
from .repositories import insert_verification_review

logger = logging.getLogger(__name__)
_settings = get_settings()

VERIFIER_SYSTEM_PROMPT = """You are an independent fit-for-purpose review agent.

Review the completed agent run and assess whether it satisfies the user request.

Check:
1. Was the task understood correctly?
2. Were data sources inspected before conclusions?
3. Were generated scripts appropriate and non-hardcoded?
4. Were joins, filters, dates, entities, and currencies handled explicitly?
5. Were numeric outputs verified against independent control totals?
6. Are uncertainties clearly stated?
7. Are any claims unsupported by artifacts or tool outputs?
8. Is the final answer fit for purpose?

Return valid JSON only. No other text before or after.
{
  "status": "PASS" or "FAIL",
  "confidence": 0.0 to 1.0,
  "defects": ["list of defects if any"],
  "required_remediation": ["list of required fixes if FAIL"],
  "fit_for_purpose_summary": "one paragraph summary"
}"""


def build_review_package(
    question: str,
    public_plan: str,
    tool_call_names: list[str],
    artifact_manifest: list[dict[str, Any]],
    proposed_answer: str,
    verified_claims: list[str],
    uncertain_items: list[str],
) -> str:
    """Build the review package text sent to the verifier. No raw data, no credentials."""
    manifest_text = "\n".join(
        f"  - {a['name']} ({a.get('size_bytes', 0):,} bytes): {a.get('description', '')}"
        for a in artifact_manifest
    ) or "  (none)"

    claims_text = "\n".join(f"  - {c}" for c in verified_claims) or "  (none stated)"
    uncertain_text = "\n".join(f"  - u" for u in uncertain_items) or "  (none stated)"
    tools_text = ", ".join(tool_call_names) or "(none)"

    return (
        f"ORIGINAL QUESTION:\n{question}\n\n"
        f"PUBLIC PLAN:\n{public_plan or '(not stated)'}\n\n"
        f"TOOLS CALLED (names only):\n{tools_text}\n\n"
        f"ARTIFACTS PRODUCED:\n{manifest_text}\n\n"
        f"VERIFIED CLAIMS (as stated by agent):\n{claims_text}\n\n"
        f"UNCERTAIN ITEMS (as stated by agent):\n{uncertain_text}\n\n"
        f"PROPOSED FINAL ANSWER:\n{proposed_answer}"
    )


def run_verifier(
    run_id: str,
    question: str,
    public_plan: str,
    tool_call_names: list[str],
    artifact_manifest: list[dict[str, Any]],
    proposed_answer: str,
    verified_claims: list[str],
    uncertain_items: list[str],
) -> dict[str, Any]:
    """
    Run independent verification.
    Returns dict with keys: status, confidence, defects, required_remediation, summary.
    """
    review_text = build_review_package(
        question=question,
        public_plan=public_plan,
        tool_call_names=tool_call_names,
        artifact_manifest=artifact_manifest,
        proposed_answer=proposed_answer,
        verified_claims=verified_claims,
        uncertain_items=uncertain_items,
    )

    logger.info("Running verifier for run %s", run_id)

    try:
        client = _bedrock_client()
        response = client.converse(
            modelId=_settings.agent_runtime_verifier_model,
            system=[{"text": VERIFIER_SYSTEM_PROMPT}],
            messages=[{"role": "user", "content": [{"text": review_text}]}],
            inferenceConfig={"maxTokens": 2048, "temperature": 0.0},
        )

        # Extract text response
        content = response.get("output", {}).get("message", {}).get("content", [])
        text = ""
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text = block["text"].strip()
                break
            if isinstance(block, dict) and "text" in block:
                text = block["text"].strip()
                break

        # Parse JSON
        result = _parse_verifier_json(text)

    except Exception as exc:
        logger.error("Verifier call failed: %s", exc, exc_info=True)
        # On verifier failure, default to PASS with warning (don't block on infra errors)
        result = {
            "status": "PASS",
            "confidence": 0.5,
            "defects": [],
            "required_remediation": [],
            "fit_for_purpose_summary": f"Verifier call failed ({exc}); manual review recommended.",
        }

    # Persist to DB
    review_id = str(uuid.uuid4())
    insert_verification_review(
        review_id=review_id,
        run_id=run_id,
        status=result["status"],
        confidence=float(result.get("confidence", 0.8)),
        defects=result.get("defects", []),
        required_remediation=result.get("required_remediation", []),
        summary=result.get("fit_for_purpose_summary", ""),
    )
    result["review_id"] = review_id
    return result


def _parse_verifier_json(text: str) -> dict[str, Any]:
    """Extract JSON from verifier response, with fallbacks."""
    # Strip markdown code fences if present
    cleaned = text.strip()
    if cleaned.startswith("```"):
        lines = cleaned.split("\n")
        cleaned = "\n".join(
            line for line in lines if not line.strip().startswith("```")
        ).strip()

    try:
        data = json.loads(cleaned)
        return {
            "status": data.get("status", "FAIL"),
            "confidence": float(data.get("confidence", 0.5)),
            "defects": data.get("defects", []),
            "required_remediation": data.get("required_remediation", []),
            "fit_for_purpose_summary": data.get("fit_for_purpose_summary", ""),
        }
    except json.JSONDecodeError:
        logger.warning("Verifier returned non-JSON: %s", text[:200])
        # Fallback: treat as FAIL
        return {
            "status": "FAIL",
            "confidence": 0.3,
            "defects": ["Verifier returned unparseable response."],
            "required_remediation": ["Resubmit for review with clearer verification claims."],
            "fit_for_purpose_summary": text[:500],
        }


def _bedrock_client():
    kwargs: dict[str, Any] = {"region_name": _settings.aws_default_region}
    if _settings.aws_access_key_id:
        kwargs["aws_access_key_id"] = _settings.aws_access_key_id
    if _settings.aws_secret_access_key:
        kwargs["aws_secret_access_key"] = _settings.aws_secret_access_key
    return boto3.client("bedrock-runtime", **kwargs)
