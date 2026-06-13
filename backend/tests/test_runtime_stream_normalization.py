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


def make_responses_gateway_connection() -> ConnectionRecord:
    return ConnectionRecord(
        provider="openai",
        label="RE-JH-LLM05",
        provider_kind="openai_compatible",
        auth_strategy="bearer",
        auth_header_name=None,
        api_key="test-key",
        base_url="https://one.rideai.com.au/v1/responses",
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


def test_stream_answer_uses_responses_sdk_for_openai_compatible_gateway(monkeypatch) -> None:
    captured: dict[str, object] = {}

    class FakeResponses:
        @staticmethod
        def create(**kwargs):
            captured.update(kwargs)
            return iter(
                [
                    SimpleNamespace(type="response.output_text.delta", delta="Hello "),
                    SimpleNamespace(type="response.output_text.delta", delta="world"),
                    SimpleNamespace(type="response.completed", response=SimpleNamespace(id="resp_123")),
                ]
            )

    class FakeClient:
        responses = FakeResponses()

    monkeypatch.setattr(runtime, "_build_openai_compatible_client", lambda _connection: FakeClient())

    deltas = list(
        runtime.stream_answer(
            "Say hello",
            make_responses_gateway_connection(),
            api_mode="responses",
            trace_id="trace-test",
            service="agent-ingress",
            model_id="RE-JH-LLM05",
        )
    )

    assert deltas == ["Hello ", "world"]
    assert captured["model"] == "re-jh-llm05"
    assert captured["input"] == "Say hello"
