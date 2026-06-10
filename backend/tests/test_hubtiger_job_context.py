"""Tests for HubTiger job LLM context (SMS + mechanic messages)."""

from __future__ import annotations

from ghostdash_api.hubtiger_job_context import (
    build_job_llm_context,
    normalize_sms_message,
    sort_job_rows_for_llm,
    speakable_vehicle_label,
)
from ghostdash_api.hubtiger_mcp import _augment_job_lookup_data, _shape_public_hubtiger_data


def test_sms_quote_awaiting_approval_importance() -> None:
    item = normalize_sms_message(
        {
            "id": "1",
            "direction": "outbound",
            "created_at": "2026-05-20T10:00:00+00:00",
            "text": "Your quote is ready. Please approve to proceed.",
        },
        max_chars=500,
    )
    assert item["importance"] == "critical"
    assert item["importance_reason"] == "quote_or_approval"


def test_job_context_quote_awaiting_from_sms() -> None:
    shaped = {
        "matches": [
            {
                "id": 99,
                "jobCardNo": "#40001",
                "customerName": "Alex Kim",
                "bike": "VSETT Apex 10 Plus",
                "statusCode": 40,
                "statusLabel": "Waiting - Client",
                "scheduledDate": "2026-05-18T09:00:00+00:00",
            }
        ],
        "messages": [
            {
                "id": "sms-1",
                "direction": "outbound",
                "channel": "sms",
                "created_at": "2026-05-19T11:00:00+00:00",
                "text": "Quote sent. Please approve the estimate by reply.",
            }
        ],
    }
    ctx = build_job_llm_context(shaped, max_chars=500)
    assert ctx["quote_state"]["customer_action_required"] is True
    assert ctx["quote_state"]["quote_status"] in {"sent", "awaiting_customer"}
    assert ctx["llm_context"]["important_sms_summary"]
    assert "Vee-set" in (ctx["job_card"]["vehicle_label"] or "")


def test_inbound_customer_sms_unanswered_summary() -> None:
    shaped = {
        "matches": [{"id": 1, "jobCardNo": "#40002", "statusCode": 80, "statusLabel": "Working On", "bike": "Zero 10X"}],
        "messages": [
            {
                "id": "sms-in",
                "direction": "inbound",
                "created_at": "2026-05-21T08:00:00+00:00",
                "text": "Can you tell me if the brake pads arrived yet?",
            }
        ],
    }
    ctx = build_job_llm_context(shaped, max_chars=500)
    assert ctx["sms_chain"][-1]["direction"] == "inbound"
    assert ctx["sms_chain"][-1]["sender"] == "customer"
    assert ctx["llm_context"]["important_sms_summary"]


def test_mechanic_waiting_on_parts_from_detail_memory() -> None:
    shaped = {
        "matches": [{"id": 2, "jobCardNo": "#40003", "statusCode": 50, "statusLabel": "Waiting - Parts", "bike": "Smartmotion"}],
        "messages": [],
    }
    detail = {
        "ID": 2,
        "memory": {
            "job": {"id": 2, "statusCode": 50, "statusLabel": "Waiting - Parts"},
            "notes": {"external": ["Waiting on brake pads from supplier."], "internal": ["Do not mention cost to customer."]},
        }
    }
    ctx = build_job_llm_context(shaped, raw_detail=detail, max_chars=500)
    safe = [m for m in ctx["mechanic_messages"] if m["is_customer_safe"]]
    internal = [m for m in ctx["mechanic_messages"] if not m["is_customer_safe"]]
    assert safe and "brake pads" in safe[0]["body"].lower()
    assert internal
    assert ctx["llm_context"]["next_workshop_action"]


def test_ready_for_pickup_status_and_sms() -> None:
    shaped = {
        "matches": [{"id": 3, "jobCardNo": "#40004", "statusCode": 90, "statusLabel": "Bike Ready", "bike": "Fatfish OG"}],
        "messages": [
            {
                "id": "sms-pickup",
                "direction": "outbound",
                "created_at": "2026-05-22T14:00:00+00:00",
                "text": "Your bike is ready for pickup today.",
            }
        ],
    }
    ctx = build_job_llm_context(shaped, max_chars=500)
    assert ctx["job_card"]["is_open"] is True
    assert ctx["quote_state"]["customer_action"] == "collect vehicle"
    assert "pickup" in (ctx["llm_context"]["customer_safe_summary"] or "").lower()


def test_missing_status_mapping_warning() -> None:
    shaped = {
        "matches": [{"id": 4, "jobCardNo": "#40005", "statusCode": 999, "bike": "Unknown"}],
        "messages": [],
    }
    ctx = build_job_llm_context(shaped, max_chars=500)
    assert ctx["job_card"]["status_label"] == "Active - exact status unclear"
    assert ctx["job_card"].get("status_mapping_warning")


def test_sort_open_jobs_newest_booked_in_first() -> None:
    rows = sort_job_rows_for_llm(
        [
            {"id": 1, "statusCode": 100, "statusLabel": "Collected", "scheduledDate": "2026-05-25T10:00:00+00:00"},
            {"id": 2, "statusCode": 80, "statusLabel": "Working On", "scheduledDate": "2026-05-10T10:00:00+00:00"},
            {"id": 3, "statusCode": 20, "statusLabel": "Booked In", "scheduledDate": "2026-05-24T10:00:00+00:00"},
        ]
    )
    assert rows[0]["id"] == 3
    assert rows[1]["id"] == 2
    assert rows[-1]["id"] == 1


def test_vsett_speakable_label() -> None:
    assert speakable_vehicle_label("VSETT Apex 10 Plus") == "Vee-set Apex 10 Plus"


def test_augment_job_lookup_sorts_matches_open_first() -> None:
    shaped = _shape_public_hubtiger_data(
        {
            "matches": [
                {"id": 1, "jobCardNo": "#1", "statusCode": 100, "statusLabel": "Collected", "scheduledDate": "2026-05-25"},
                {"id": 2, "jobCardNo": "#2", "statusCode": 20, "statusLabel": "Booked In", "scheduledDate": "2026-05-24"},
            ],
            "count": 2,
        },
        operation="job_search",
        max_rows=5,
        max_matches=5,
        max_chars=120,
    )
    options = shaped.get("case_select", {}).get("options", [])
    assert options[0]["job_card_no"] == "#2"
