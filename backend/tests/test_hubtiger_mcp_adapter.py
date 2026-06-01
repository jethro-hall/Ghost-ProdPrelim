from __future__ import annotations

import asyncio
from datetime import date, datetime, timedelta
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from ghostdash_api.hubtiger_mcp import (
    HUBTIGER_PUBLIC_PENDING_BOOKING_MESSAGE,
    _enrich_availability_window,
    build_hubtiger_execute_request,
    build_hubtiger_mcp_post_body,
    call_hubtiger_mcp,
    normalize_hubtiger_tool_call,
    to_public_tool_result,
    _identifier_context,
    _shape_public_hubtiger_data,
    _build_booking_preflight_payload,
    _is_schedule_slot_available,
    HubTigerMcpCallResult,
)


def _future_booking_datetime() -> str:
    candidate = datetime.now() + timedelta(days=2)
    while candidate.weekday() == 6:
        candidate += timedelta(days=1)
    candidate = candidate.replace(hour=10, minute=0, second=0, microsecond=0)
    return candidate.isoformat()


def _valid_booking_create_payload() -> dict:
    return {
        "store": "brisbane",
        "ID": 2186,
        "BikeID": 3566881,
        "ServiceTypes": [19802],
        "ServiceDate": _future_booking_datetime(),
        "TechnicianID": 2730,
    }


def test_enrich_availability_window_sets_deadline_scan() -> None:
    enriched = _enrich_availability_window(
        {
            "store": "brisbane",
            "deadline_date": "2026-06-02",
        }
    )
    assert enriched["end_date"] == "2026-06-02"
    assert enriched["scheduling_goal"] == "before_deadline"
    assert enriched["start_date"] == date.today().isoformat()
    assert 1 <= int(enriched["days"]) <= 14


def test_normalize_booking_availability_with_deadline_only() -> None:
    operation, payload = normalize_hubtiger_tool_call(
        function="booking_availability",
        operation=None,
        cache_mode=None,
        payload={"deadline_date": "2026-06-02", "customer_request": "birthday service by 2 June"},
        store="brisbane",
        date=None,
        start_date=None,
        end_date=None,
        customer=None,
    )
    assert operation == "availability_lookup"
    assert payload["end_date"] == "2026-06-02"
    assert payload["scheduling_goal"] == "before_deadline"


def test_build_execute_request_for_availability_lookup() -> None:
    request = build_hubtiger_execute_request(
        "availability_lookup",
        {
            "store": "brisbane",
            "start_date": "2026-04-29",
            "end_date": "2026-05-02",
            "requiredMinutes": 90,
        },
    )
    assert request is not None
    assert request["method"] == "GET"
    assert request["proxy_path"].startswith("/availability/technicians?")
    assert "store=brisbane" in request["proxy_path"]
    assert "fromDate=2026-04-29" in request["proxy_path"]
    assert "toDate=2026-05-02" in request["proxy_path"]
    assert "requiredMinutes=90" in request["proxy_path"]


def test_mcp_post_body_for_availability_uses_payload_contract() -> None:
    body = build_hubtiger_mcp_post_body(
        "availability_lookup",
        {"store": "brisbane", "start_date": "2026-05-21", "cache_mode": "no_cache"},
    )
    assert body is not None
    assert body["operation"] == "availability_lookup"
    assert body["payload"]["store"] == "brisbane"
    assert body["payload"]["start_date"] == "2026-05-21"
    assert body["cache_mode"] == "bypass"
    assert "proxy_path" not in body


def test_build_execute_request_for_job_lookup_with_phone() -> None:
    request = build_hubtiger_execute_request(
        "job_lookup",
        {"phone": "+61412345678"},
    )
    assert request is not None
    assert request["method"] == "POST"
    assert request["proxy_path"] == "/jobs/search"
    assert request["proxy_body"]["q"] == "0412345678"
    assert request["proxy_body"]["allStores"] is True


def test_build_execute_request_for_job_lookup_with_job_id() -> None:
    request = build_hubtiger_execute_request(
        "job_lookup",
        {"job_id": "12345"},
    )
    assert request is not None
    assert request["method"] == "POST"
    assert request["proxy_path"] == "/jobs/search"
    assert request["proxy_body"]["q"] == "12345"
    assert request["proxy_body"]["allStores"] is True


def test_build_execute_request_for_job_search_with_phone() -> None:
    request = build_hubtiger_execute_request(
        "job_search",
        {"phone": "+614135185134"},
    )
    assert request is not None
    assert request["method"] == "POST"
    assert request["proxy_path"] == "/jobs/search"
    assert request["proxy_body"]["q"] == "+614135185134"


def test_build_execute_request_for_job_search_with_cache_bypass() -> None:
    request = build_hubtiger_execute_request(
        "job_search",
        {"phone": "+614135185134", "cache_mode": "no_cache"},
    )
    assert request is not None
    assert request["cache_mode"] == "bypass"
    assert request["proxy_body"]["q"] == "+614135185134"


def test_build_execute_request_for_job_retrieve_uses_job_card_identifier() -> None:
    request = build_hubtiger_execute_request(
        "job_retrieve",
        {"job_card_no": "#35872"},
    )
    assert request is not None
    assert request["method"] == "POST"
    assert request["proxy_path"] == "/jobs/search"
    assert request["proxy_body"]["q"] == "#35872"
    assert request["proxy_body"]["allStores"] is True


def test_build_execute_request_for_quote_preview_missing_data_returns_none() -> None:
    request = build_hubtiger_execute_request(
        "quote_preview",
        {"serviceId": 999},
    )
    assert request is None


def test_build_execute_request_for_booking_create_uses_bookings_route() -> None:
    request = build_hubtiger_execute_request(
        "booking_create",
        {
            "store": "brisbane",
            "firstName": "Alex",
            "lastName": "Rider",
            "mobile": "+61412345678",
            "serviceDate": "2026-04-29T10:00:00",
            "TechnicianID": 22,
            "sendCommunication": False,
        },
    )
    assert request is not None
    assert request["method"] == "POST"
    assert request["proxy_path"] == "/bookings?sendCommunication=false"
    assert request["proxy_body"]["firstName"] == "Alex"
    assert "sendCommunication" not in request["proxy_body"]


def test_build_execute_request_for_booking_update_uses_bookings_update_route() -> None:
    request = build_hubtiger_execute_request(
        "booking_update",
        {
            "id": 4200325,
            "ServiceDate": "2026-05-22T10:00:00",
            "TechnicianID": 2730,
            "send_communication": False,
        },
    )
    assert request is not None
    assert request["method"] == "POST"
    assert request["proxy_path"] == "/bookings/update?sendCommunication=false"
    assert request["proxy_body"] == {
        "id": 4200325,
        "ServiceDate": "2026-05-22T10:00:00",
        "TechnicianID": 2730,
    }


def test_build_execute_request_for_quote_add_line_item_uses_commit_path() -> None:
    request = build_hubtiger_execute_request(
        "quote_add_line_item",
        {
            "serviceId": 444,
            "search": "brake pads",
            "quantity": 2,
        },
    )
    assert request is not None
    assert request["method"] == "POST"
    assert request["proxy_path"] == "/quotes/find-add"
    assert request["proxy_body"] == {
        "serviceId": 444,
        "search": "brake pads",
        "quantity": 2,
        "dryRun": False,
    }


def test_build_booking_preflight_payload_requires_store_date_and_technician() -> None:
    payload, err = _build_booking_preflight_payload({"ServiceDate": "2026-05-07T09:00:00", "TechnicianID": 2730})
    assert payload is None
    assert err and "store" in err

    payload, err = _build_booking_preflight_payload({"store": "brisbane", "TechnicianID": 2730})
    assert payload is None
    assert err and "service date" in err

    payload, err = _build_booking_preflight_payload({"store": "brisbane", "ServiceDate": "2026-05-07T09:00:00"})
    assert payload is None
    assert err and "TechnicianID" in err


def test_build_booking_preflight_payload_normalizes_values() -> None:
    payload, err = _build_booking_preflight_payload(
        {
            "store": "Brisbane Newstead",
            "ServiceDate": "2026-05-07T09:00:00",
            "TechnicianID": 2730,
            "requiredMinutes": 120,
        }
    )
    assert err is None
    assert payload == {
        "store": "brisbane",
        "start_date": "2026-05-07",
        "end_date": "2026-05-07",
        "technicians": "2730",
        "requiredMinutes": 120,
        "cache_mode": "bypass",
    }


def test_is_schedule_slot_available_matches_technician_date_and_minutes() -> None:
    rows = {
        "rows": [
            {"id": 2730, "date": "20260507", "roundedAvailableTime": 180},
            {"id": 2731, "date": "20260507", "roundedAvailableTime": 20},
        ]
    }
    assert _is_schedule_slot_available(rows, technician_id="2730", service_date_iso="2026-05-07", required_minutes=60) is True
    assert _is_schedule_slot_available(rows, technician_id="2730", service_date_iso="2026-05-07", required_minutes=240) is False
    assert _is_schedule_slot_available(rows, technician_id="9999", service_date_iso="2026-05-07", required_minutes=60) is False


def test_is_schedule_slot_available_matches_mcp_ranked_slots() -> None:
    mcp_payload = {
        "recommended_slot": {
            "available_slot": "2026-05-23T09:15:00",
            "technician_id": 2730,
        },
        "backup_slots": [{"available_slot": "2026-05-25T09:00:00", "technician_id": 2730}],
        "slots_by_date": [
            {
                "date": "2026-05-23",
                "slots": [{"available_slot": "2026-05-23T09:15:00", "technician_id": 2730}],
            }
        ],
    }
    assert _is_schedule_slot_available(mcp_payload, technician_id="2730", service_date_iso="2026-05-23", required_minutes=60) is True
    assert _is_schedule_slot_available(mcp_payload, technician_id="9999", service_date_iso="2026-05-23", required_minutes=60) is False


def test_is_schedule_slot_available_unwraps_nested_mcp_execute_data() -> None:
    wrapped = {
        "success": True,
        "operation": "availability_lookup",
        "data": {
            "recommended_slot": {
                "ServiceDate": "2026-05-23T09:15:00",
                "TechnicianID": 2730,
                "available_slot": "2026-05-23T09:15:00",
            }
        },
    }
    assert _is_schedule_slot_available(wrapped, technician_id="2730", service_date_iso="2026-05-23T09:15:00", required_minutes=60) is True


def test_normalize_hubtiger_tool_call_accepts_prefixed_aliases() -> None:
    operation, payload = normalize_hubtiger_tool_call(
        function="hubtiger_quote_preview",
        payload={"serviceId": 99, "search": "chain"},
    )
    assert operation == "quote_preview"
    assert payload["serviceId"] == 99
    assert payload["search"] == "chain"


def test_normalize_hubtiger_tool_call_requires_identifier_for_booking_update() -> None:
    try:
        normalize_hubtiger_tool_call(function="booking_update", payload={"ServiceDate": "2026-05-22T10:00:00"})
    except ValueError as exc:
        assert "identifier" in str(exc).lower()
    else:
        raise AssertionError("booking_update without identifier should fail")


def test_normalize_hubtiger_tool_call_rejects_unsupported_legacy_tools() -> None:
    try:
        normalize_hubtiger_tool_call(function="hubtiger_quote_request_approval_sms", payload={})
    except ValueError as exc:
        assert "unsupported" in str(exc).lower()
    else:
        raise AssertionError("unsupported legacy HubTiger tool should fail closed")


def test_shape_public_job_data_marks_store_mismatch_and_requires_selection() -> None:
    shaped = _shape_public_hubtiger_data(
        {
            "matches": [
                {"id": 1, "jobCardNo": "#35872", "customerName": "Sarah Leema", "statusLabel": "In Progress", "store": "southport"},
                {"id": 2, "jobCardNo": "#35873", "customerName": "Sarah Leema", "statusLabel": "Booked", "store": "southport"},
            ],
            "count": 2,
        },
        operation="job_search",
        max_rows=5,
        max_matches=5,
        max_chars=120,
        requested_store="brisbane",
    )
    case_select = shaped.get("case_select")
    assert isinstance(case_select, dict)
    assert case_select["store_requested"] == "brisbane"
    assert case_select["store_matched"] == "southport"
    assert case_select["store_match"] is False
    assert case_select["selection_required"] is True
    assert "clarify_store" in case_select["allowed_next_actions"]
    assert shaped["store_match"] is False


def test_shape_public_job_data_keeps_store_match_true_for_single_store() -> None:
    shaped = _shape_public_hubtiger_data(
        {
            "matches": [
                {"id": 1, "jobCardNo": "#35872", "customerName": "Chris Brown", "statusLabel": "In Progress", "store": "southport"},
            ],
            "count": 1,
        },
        operation="job_retrieve",
        max_rows=5,
        max_matches=5,
        max_chars=120,
        requested_store="southport",
    )
    case_select = shaped.get("case_select")
    assert isinstance(case_select, dict)
    assert case_select["store_match"] is True
    assert case_select["selection_required"] is False


def test_shape_public_job_data_treats_unknown_store_as_non_mismatch_for_exact_identifier() -> None:
    shaped = _shape_public_hubtiger_data(
        {
            "matches": [
                {"id": 1, "jobCardNo": "#35872", "customerName": "Jeff Hall", "statusLabel": "Booked In"},
            ],
            "count": 1,
        },
        operation="job_retrieve",
        max_rows=5,
        max_matches=5,
        max_chars=120,
        requested_store="southport",
        identifier_context={"identifier_type": "job_card_no", "identifier_confidence": "exact", "identifier_value": "#35872"},
    )
    case_select = shaped.get("case_select")
    assert isinstance(case_select, dict)
    assert case_select["store_verification"] == "unknown"
    assert case_select["store_match"] is None
    assert case_select["selection_required"] is False


def test_shape_public_job_data_requires_selection_for_unknown_store_non_exact_identifier() -> None:
    shaped = _shape_public_hubtiger_data(
        {
            "matches": [
                {"id": 1, "jobCardNo": "#11111", "customerName": "Sarah Lee", "statusLabel": "Booked In"},
            ],
            "count": 1,
        },
        operation="job_search",
        max_rows=5,
        max_matches=5,
        max_chars=120,
        requested_store="brisbane",
        identifier_context={"identifier_type": "name_full", "identifier_confidence": "medium", "identifier_value": "Sarah Lee"},
    )
    case_select = shaped.get("case_select")
    assert isinstance(case_select, dict)
    assert case_select["store_verification"] == "unknown"
    assert case_select["selection_required"] is True
    assert "clarify_store" in case_select["allowed_next_actions"]


def test_identifier_context_flags_ambiguous_short_numeric_query() -> None:
    context = _identifier_context({"query": "1234"})
    assert context["identifier_type"] == "ambiguous_numeric"
    assert context["identifier_confidence"] == "weak"
    assert context["ambiguous_identifier"] == "1234"


def test_identifier_context_treats_single_name_query_as_low_confidence() -> None:
    context = _identifier_context({"query": "John"})
    assert context["identifier_type"] == "name_partial"
    assert context["identifier_confidence"] == "low"


def test_normalize_booking_create_requires_hub_fields() -> None:
    with pytest.raises(ValueError, match="ID"):
        normalize_hubtiger_tool_call(
            function="booking_create",
            store="brisbane",
            payload={"BikeID": 1, "ServiceTypes": [1], "ServiceDate": _future_booking_datetime(), "TechnicianID": 1},
        )


def test_normalize_booking_create_accepts_agent_conversational_payload() -> None:
    operation, payload = normalize_hubtiger_tool_call(
        function="booking_create",
        store="brisbane",
        payload={
            "first_name": "Jeff",
            "last_name": "Hall",
            "mobile": "0435185134",
            "vehicle_model": "Fatfish OG",
            "issue_description": "Squeaky brakes",
            "service_type": "service_full",
            "ServiceDate": _future_booking_datetime(),
            "TechnicianID": 2730,
        },
    )
    assert operation == "booking_create"
    assert payload["first_name"] == "Jeff"
    assert payload["vehicle_model"] == "Fatfish OG"


def test_booking_create_preflight_runs_before_queue(monkeypatch, tmp_path) -> None:
    from ghostdash_api import hubtiger_mcp as mod

    monkeypatch.setattr(mod.get_settings(), "app_data_dir", str(tmp_path))
    monkeypatch.setattr(mod.get_settings(), "hubtiger_mcp_url", "http://hubtiger-mcp:8096")
    preflight_body = {
        "ok": True,
        "data": {
            "rows": [{"id": 2730, "date": _future_booking_datetime()[:10].replace("-", ""), "roundedAvailableTime": 120}],
        },
    }
    mock_response = httpx.Response(200, json=preflight_body)

    with patch("ghostdash_api.hubtiger_mcp.httpx.AsyncClient") as mock_client:
        client = mock_client.return_value.__aenter__.return_value
        client.post = AsyncMock(return_value=mock_response)
        result = asyncio.run(
            call_hubtiger_mcp(
                operation="booking_create",
                payload=_valid_booking_create_payload(),
                trace_id="trace-preflight-queue",
            )
        )

    assert result.success is True
    assert result.blocked is True
    assert result.data["review_status"] == "pending_staff_review"
    assert result.data["booking_confirmed"] is False
    assert client.post.call_count == 1
    posted = client.post.call_args.kwargs.get("json") or client.post.call_args.args[1]
    assert posted["operation"] == "availability_lookup"


def test_booking_create_blocks_queue_when_slot_unavailable(monkeypatch) -> None:
    from ghostdash_api import hubtiger_mcp as mod

    monkeypatch.setattr(mod.get_settings(), "hubtiger_mcp_url", "http://hubtiger-mcp:8096")
    preflight_body = {
        "ok": True,
        "data": {
            "rows": [{"id": 2730, "date": _future_booking_datetime()[:10].replace("-", ""), "roundedAvailableTime": 5}],
        },
    }
    mock_response = httpx.Response(200, json=preflight_body)

    with patch("ghostdash_api.hubtiger_mcp.httpx.AsyncClient") as mock_client:
        client = mock_client.return_value.__aenter__.return_value
        client.post = AsyncMock(return_value=mock_response)
        result = asyncio.run(
            call_hubtiger_mcp(
                operation="booking_create",
                payload=_valid_booking_create_payload(),
                trace_id="trace-slot-unavailable",
            )
        )

    assert result.success is False
    assert result.blocked is True
    assert result.data.get("error_code") == "booking_slot_unavailable"
    assert client.post.call_count == 1


def test_public_tool_result_hides_queue_internals_for_pending_review() -> None:
    raw = HubTigerMcpCallResult(
        success=True,
        blocked=True,
        mode="read_only",
        operation="booking_create",
        message="internal",
        trace_id="trace-1",
        data={
            "review_status": "pending_staff_review",
            "review_queue_file": "/data/hubtiger/write-review-queue/pending.ndjson",
            "queued_execute_request": {"operation": "booking_create"},
        },
    )
    public = to_public_tool_result(raw)
    assert public.message == HUBTIGER_PUBLIC_PENDING_BOOKING_MESSAGE
    assert public.data.get("customer_outcome") == "pending_staff_review"
    assert "review_queue_file" not in public.data
    assert "queued_execute_request" not in public.data


def test_public_tool_result_job_retrieve_business_failure_is_not_success_and_redacts_auth() -> None:
    raw = HubTigerMcpCallResult(
        success=True,
        blocked=False,
        mode="read_write",
        operation="job_retrieve",
        message="Tool succeeded",
        trace_id="trace-business-failure",
        data={
            "business_success": False,
            "user_message": "I could not retrieve the workshop record right now.",
            "retryable": True,
            "X-Ghost-Voice-Key": "must-not-leak",
            "authorization": "Bearer must-not-leak",
            "nested": {"api_key": "must-not-leak"},
        },
    )

    public = to_public_tool_result(raw)

    assert public.success is False
    assert public.message == "I could not retrieve the workshop record right now."
    assert "X-Ghost-Voice-Key" not in public.data
    assert "authorization" not in public.data
    assert "api_key" not in public.data["nested"]


def test_call_hubtiger_mcp_preserves_job_retrieve_business_failure_from_mcp(monkeypatch) -> None:
    from ghostdash_api import hubtiger_mcp as mod

    monkeypatch.setattr(mod.get_settings(), "hubtiger_mcp_url", "http://hubtiger-mcp:8096")
    mock_response = httpx.Response(
        502,
        json={
            "ok": False,
            "data": {
                "business_success": False,
                "user_message": "I could not retrieve the workshop record right now.",
                "retryable": True,
                "error_code": "hubtiger_job_retrieve_business_invalid",
                "cache_reject_reason": "unavailable_placeholder",
                "fresh_reject_reason": "missing_job_details",
            },
        },
    )

    with patch("ghostdash_api.hubtiger_mcp.httpx.AsyncClient") as mock_client:
        client = mock_client.return_value.__aenter__.return_value
        client.post = AsyncMock(return_value=mock_response)
        result = asyncio.run(
            call_hubtiger_mcp(
                operation="job_retrieve",
                payload={"job_card_no": "#35872"},
                trace_id="trace-business-failure",
            )
        )

    assert result.success is False
    assert result.message == "I could not retrieve the workshop record right now."
    assert result.data["business_success"] is False
    assert result.data["cache_reject_reason"] == "unavailable_placeholder"
    assert result.data["fresh_reject_reason"] == "missing_job_details"
