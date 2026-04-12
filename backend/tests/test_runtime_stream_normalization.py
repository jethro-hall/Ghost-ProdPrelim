from __future__ import annotations

from types import SimpleNamespace

from ghostdash_api import runtime
from ghostdash_api.models import ConnectionRecord


def make_gateway_connection() -> ConnectionRecord:
    return ConnectionRecord(
        provider="openai",
        label="RideAI Gateway",
        provider_kind="openai_compatible",
        auth_strategy="bearer",
        auth_header_name=None,
        api_key="test-key",
        base_url="https://one.rideai.com.au/api/llamaindex/v1",
        enabled=True,
    )


def test_stream_answer_normalizes_structured_gateway_deltas(monkeypatch) -> None:
    chunks = [
        SimpleNamespace(
            choices=[
                SimpleNamespace(
                    delta=SimpleNamespace(
                        content=[
                            {"type": "output_text", "text": "odoo.rpc.search_read"},
                            {"type": "output_text", "text": "\n"},
                            {
                                "type": "output_text",
                                "text": '{"model":"res.company","fields":["id","name"]}',
                            },
                        ]
                    )
                )
            ]
        )
    ]

    class FakeClient:
        class chat:
            class completions:
                @staticmethod
                def create(**_kwargs):
                    return iter(chunks)

    monkeypatch.setattr(runtime, "_build_openai_compatible_client", lambda _connection: FakeClient())

    deltas = list(
        runtime.stream_answer(
            "List companies",
            make_gateway_connection(),
            trace_id="trace-test",
            service="agent-ingress",
        )
    )

    assert deltas == ['odoo.rpc.search_read\n{"model":"res.company","fields":["id","name"]}']
