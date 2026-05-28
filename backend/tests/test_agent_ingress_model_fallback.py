from __future__ import annotations

from ghostdash_api import agent_ingress


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


class _FakeError(Exception):
    def __init__(self, response=None, message: str = "boom"):
        super().__init__(message)
        self.response = response


def test_model_not_found_error_detected_from_response_payload() -> None:
    exc = _FakeError(response=_FakeResponse({"error": {"code": "model_not_found"}}))
    assert agent_ingress._is_model_not_found_error(exc) is True


def test_model_not_found_error_detected_from_exception_text() -> None:
    exc = Exception("BadRequestError: requested model does not exist")
    assert agent_ingress._is_model_not_found_error(exc) is True


def test_resolve_fallback_model_id_uses_app_default_when_primary_matches_configured() -> None:
    primary = "openai/gpt-5.4"
    fallback = agent_ingress._resolve_fallback_model_id(
        {"fallback_model_id": "gpt-5.4"},
        primary_model_id=primary,
    )
    assert fallback == agent_ingress.settings.app_default_chat_model


def test_llm_orchestration_second_pass_triggers_on_model_not_found() -> None:
    should_run, reason = agent_ingress._llm_orchestration_should_second_pass(
        {"enabled": True, "trigger_mode": "on_prompt_overflow"},
        primary_prompt="hello",
        primary_error=Exception("model_not_found"),
    )
    assert should_run is True
    assert reason == "primary_model_not_found"
