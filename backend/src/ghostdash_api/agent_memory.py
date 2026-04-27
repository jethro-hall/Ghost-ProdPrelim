from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .collections import ensure_collection_record
from .models import (
    AgentConversationRecord,
    AgentMessageRecord,
    AgentProfileRecord,
    ChatResponseCacheRecord,
    DocxSessionRecord,
    DocumentFrameRecord,
    RuntimeProfileRecord,
)
from .magic_mike import magic_mike_agent_payload
from .runtime_profiles import (
    APRYSE_DOCX_SYSTEM_PROMPT,
    BP_AUDITOR_SYSTEM_PROMPT,
    BP_CASE_FRAMING_SYSTEM_PROMPT,
    BP_LEAD_ARCHITECT_SYSTEM_PROMPT,
    BUSINESS_DOCUMENTER_SYSTEM_PROMPT,
    BUSINESS_STRATEGIST_SYSTEM_PROMPT,
    CASE_FRAMING_AGENT_SYSTEM_PROMPT,
    EVIDENCE_RETRIEVAL_AGENT_SYSTEM_PROMPT,
    REASONING_SYNTHESIS_AGENT_SYSTEM_PROMPT,
    resolve_agent_runtime_profile,
    save_runtime_profile,
    seed_default_runtime_profile,
    specialized_runtime_profile_payload,
)
from .settings import get_settings

settings = get_settings()

# Upstream catalogs rejected staged GPT-5 IDs; repair to the configured app default model.
_GPT5_AGENT_NAMES = frozenset({"GPT-5 Data Collector", "GPT-5 Documenter"})
_DEPRECATED_GPT5_MODEL_IDS = frozenset({"gpt-5.2-pro", "openai/gpt-5.2-pro"})
_GPT5_MODEL_REPLACEMENT_ID = settings.app_default_chat_model
_BP_RUNTIME_MODEL_REPLACEMENT_ID = settings.app_default_chat_model
_BP_RUNTIME_UNSUPPORTED_MODEL_IDS = frozenset(
    {
        "gpt-5.2-pro",
        "openai/gpt-5.2-pro",
        "gpt-5.4",
        "openai/gpt-5.4",
        "gpt-5.4-nano",
        "openai/gpt-5.4-nano",
    }
)
_BP_RUNTIME_AGENT_NAMES = frozenset(
    {
        "Lead Enterprise Technical Business Architect",
        "[SA] Finance Case Framing Agent",
        "[SA] Evidence Retrieval Agent",
        "[SA] Reasoning / Synthesis Agent",
        "[SA] Odoo Specialist",
        "[SA] Documentation / Apryse Document Generator Agent",
    }
)
SUB_AGENT_PREFIX = "[SA] "
RETIRED_LEGACY_ODOO_AGENT_NAMES = frozenset(
    {
        "Odoo Specialist",
        "[SA] Odoo Specialist",
    }
)


def _repair_gpt5_agent_deprecated_models(session: Session) -> bool:
    """One-time-style repair for agents created with a non-existent staging model id."""
    changed = False
    agents = list(
        session.scalars(select(AgentProfileRecord).where(AgentProfileRecord.name.in_(_GPT5_AGENT_NAMES)))
    )
    for agent in agents:
        if not agent.runtime_profile_id:
            continue
        profile = session.get(RuntimeProfileRecord, agent.runtime_profile_id)
        if profile is None:
            continue
        llm = dict(profile.llm_config_json or {})
        mid = str(llm.get("model_id") or "").strip()
        if mid in _DEPRECATED_GPT5_MODEL_IDS:
            llm["model_id"] = _GPT5_MODEL_REPLACEMENT_ID
            profile.llm_config_json = llm
            changed = True
    return changed


def _bp_runtime_primary_needs_repair(canonical: str) -> bool:
    if not canonical:
        return False
    if canonical in _BP_RUNTIME_UNSUPPORTED_MODEL_IDS:
        return True
    return "llama31" in canonical or "llama-3.1" in canonical


def _bp_fallback_needs_clear(fallback_cf: str) -> bool:
    if not fallback_cf:
        return False
    if fallback_cf in _BP_RUNTIME_UNSUPPORTED_MODEL_IDS:
        return True
    return "llama31" in fallback_cf or "llama-3.1" in fallback_cf


def _repair_bp_chain_llama_model_ids(session: Session) -> bool:
    """Rewrite invalid primary model ids and clear bad orchestration fallbacks for BP MAS sub-agents."""
    changed = False
    agents = list(
        session.scalars(select(AgentProfileRecord).where(AgentProfileRecord.name.in_(_BP_RUNTIME_AGENT_NAMES)))
    )
    for agent in agents:
        if not agent.runtime_profile_id:
            continue
        profile = session.get(RuntimeProfileRecord, agent.runtime_profile_id)
        if profile is None:
            continue
        touched = False
        llm = dict(profile.llm_config_json or {})
        llm_orchestration = dict(llm.get("llm_orchestration") or {})
        fallback_cf = str(llm_orchestration.get("fallback_model_id") or "").strip().casefold()
        if _bp_fallback_needs_clear(fallback_cf):
            llm_orchestration["fallback_model_id"] = None
            llm["llm_orchestration"] = llm_orchestration
            touched = True

        model_id = str(llm.get("model_id") or "").strip()
        canonical = model_id.casefold()
        if model_id and _bp_runtime_primary_needs_repair(canonical):
            llm["model_id"] = _BP_RUNTIME_MODEL_REPLACEMENT_ID
            llm_orchestration = dict(llm.get("llm_orchestration") or {})
            if _bp_fallback_needs_clear(str(llm_orchestration.get("fallback_model_id") or "").strip().casefold()):
                llm_orchestration["fallback_model_id"] = None
            llm["llm_orchestration"] = llm_orchestration
            touched = True
        if touched:
            profile.llm_config_json = llm
            changed = True
    return changed


def default_agent_payload(runtime_profile_id: str) -> dict:
    return {
        "name": "GhostDASH Assistant",
        "first_message": "Hello! I am your GhostDASH assistant. How can I help you today?",
        "language": "en-US",
        "voice_id": "alloy",
        "runtime_profile_id": runtime_profile_id,
        "is_default": True,
        "enabled": True,
    }


def special_agent_payloads() -> list[dict]:
    payloads = [
        magic_mike_agent_payload(),
        {
            "name": "Business Strategist",
            "first_message": "I am your Group CFO Architect. Give me the decision, scope, and period and I will coordinate framing, evidence, ERP truth, synthesis, and board-ready outputs.",
            "language": "en-AU",
            "voice_id": "alloy",
            "runtime_profile_name": "Business Strategist Runtime",
            "runtime_profile_description": "Group CFO architect runtime for finance truth, forecasting, orchestration, and system integrity.",
            "runtime_profile_payload": specialized_runtime_profile_payload(
                name="Business Strategist Runtime",
                description="Group CFO architect runtime for finance truth, forecasting, orchestration, and system integrity.",
                system_prompt=BUSINESS_STRATEGIST_SYSTEM_PROMPT,
                conversation_mode="working_session",
                enable_web=True,
            ),
            "is_default": False,
            "enabled": True,
        },
        {
            "name": "[SA] Finance Case Framing Agent",
            "first_message": "I will convert your request into a precise case frame with objective, scope, period, KPI set, and required evidence.",
            "language": "en-AU",
            "voice_id": "alloy",
            "runtime_profile_name": "Finance Case Framing Agent Runtime",
            "runtime_profile_description": "Sub-agent runtime for deterministic case framing.",
            "runtime_profile_payload": specialized_runtime_profile_payload(
                name="Finance Case Framing Agent Runtime",
                description="Sub-agent runtime for deterministic case framing.",
                system_prompt=CASE_FRAMING_AGENT_SYSTEM_PROMPT,
                conversation_mode="working_session",
                enable_web=False,
            ),
            "agent_role": "sub",
            "parent_agent_name": "Lead Enterprise Technical Business Architect",
            "position": 11,
            "is_default": False,
            "enabled": True,
        },
        {
            "name": "[SA] Evidence Retrieval Agent",
            "first_message": "I gather normalized evidence with attribution, freshness, and contradiction flags.",
            "language": "en-AU",
            "voice_id": "alloy",
            "runtime_profile_name": "Evidence Retrieval Agent Runtime",
            "runtime_profile_description": "Sub-agent runtime for factual evidence extraction and normalization.",
            "runtime_profile_payload": specialized_runtime_profile_payload(
                name="Evidence Retrieval Agent Runtime",
                description="Sub-agent runtime for factual evidence extraction and normalization.",
                system_prompt=EVIDENCE_RETRIEVAL_AGENT_SYSTEM_PROMPT,
                conversation_mode="working_session",
                enable_web=True,
            ),
            "agent_role": "sub",
            "parent_agent_name": "Lead Enterprise Technical Business Architect",
            "position": 12,
            "is_default": False,
            "enabled": True,
        },
        {
            "name": "Business Marketing & Strategy Documenter",
            "first_message": "I am tracking approved material in the background. Call me in when you want structure, draft, refinement, or final document output.",
            "language": "en-AU",
            "voice_id": "alloy",
            "runtime_profile_name": "Business Marketing & Strategy Documenter Runtime",
            "runtime_profile_description": "Passive document compilation runtime for strategic document framing.",
            "runtime_profile_payload": specialized_runtime_profile_payload(
                name="Business Marketing & Strategy Documenter Runtime",
                description="Passive document compilation runtime for strategic document framing.",
                system_prompt=BUSINESS_DOCUMENTER_SYSTEM_PROMPT,
                conversation_mode="board",
                enable_web=True,
            ),
            "is_default": False,
            "enabled": True,
        },
        {
            "name": "Apryse Docs Specialist",
            "first_message": "I can run Apryse doc mode for template preview/finalize cycles. Provide the template context and required fields.",
            "language": "en-AU",
            "voice_id": "alloy",
            "runtime_profile_name": "Apryse Docs Specialist Runtime",
            "runtime_profile_description": "Structured Apryse-driven template workflow runtime.",
            "runtime_profile_payload": specialized_runtime_profile_payload(
                name="Apryse Docs Specialist Runtime",
                description="Structured Apryse-driven template workflow runtime.",
                system_prompt=APRYSE_DOCX_SYSTEM_PROMPT,
                conversation_mode="working_session",
                enable_web=False,
            ),
            "is_default": False,
            "enabled": True,
        },
        {
            "name": "[SA] Reasoning / Synthesis Agent",
            "first_message": "I reconcile evidence, run scenarios, and produce decision-grade synthesis with explicit assumptions.",
            "language": "en-AU",
            "voice_id": "alloy",
            "runtime_profile_name": "Reasoning Synthesis Agent Runtime",
            "runtime_profile_description": "Sub-agent runtime for evidence reconciliation, scenario analysis, and synthesis.",
            "runtime_profile_payload": specialized_runtime_profile_payload(
                name="Reasoning Synthesis Agent Runtime",
                description="Sub-agent runtime for evidence reconciliation, scenario analysis, and synthesis.",
                system_prompt=REASONING_SYNTHESIS_AGENT_SYSTEM_PROMPT,
                conversation_mode="working_session",
                enable_web=False,
            ),
            "agent_role": "sub",
            "parent_agent_name": "Lead Enterprise Technical Business Architect",
            "position": 13,
            "is_default": False,
            "enabled": True,
        },
        {
            "name": "[SA] Documentation / Apryse Document Generator Agent",
            "first_message": "I convert approved synthesis into deterministic board-ready documents and finalize-ready outputs.",
            "language": "en-AU",
            "voice_id": "alloy",
            "runtime_profile_name": "Documentation Apryse Agent Runtime",
            "runtime_profile_description": "Sub-agent runtime for Apryse-backed board-ready document generation.",
            "runtime_profile_payload": specialized_runtime_profile_payload(
                name="Documentation Apryse Agent Runtime",
                description="Sub-agent runtime for Apryse-backed board-ready document generation.",
                system_prompt=APRYSE_DOCX_SYSTEM_PROMPT,
                conversation_mode="working_session",
                enable_web=False,
            ),
            "agent_role": "sub",
            "parent_agent_name": "Lead Enterprise Technical Business Architect",
            "position": 15,
            "is_default": False,
            "enabled": True,
        },
        {
            "name": "Lead Enterprise Technical Business Architect",
            "first_message": "State the objective and constraints; I will coordinate case framing, evidence, and audit to a board-ready outcome.",
            "language": "en-AU",
            "voice_id": "alloy",
            "runtime_profile_name": "BP Lead Architect Runtime",
            "runtime_profile_description": "BP mode lead orchestration runtime.",
            "runtime_profile_payload": specialized_runtime_profile_payload(
                name="BP Lead Architect Runtime",
                description="BP mode lead orchestration runtime.",
                system_prompt=BP_LEAD_ARCHITECT_SYSTEM_PROMPT,
                conversation_mode="working_session",
                enable_web=False,
            ),
            "agent_role": "lead",
            "position": 10,
            "is_default": False,
            "enabled": True,
        },
        {
            "name": "[SA] Case Framing Agent",
            "first_message": "I convert the request into a precise case frame.",
            "language": "en-AU",
            "voice_id": "alloy",
            "runtime_profile_name": "BP Case Framing Runtime",
            "runtime_profile_description": "BP mode case framing runtime.",
            "runtime_profile_payload": specialized_runtime_profile_payload(
                name="BP Case Framing Runtime",
                description="BP mode case framing runtime.",
                system_prompt=BP_CASE_FRAMING_SYSTEM_PROMPT,
                conversation_mode="working_session",
                enable_web=False,
            ),
            "agent_role": "sub",
            "parent_agent_name": "Business Strategist",
            "position": 111,
            "is_default": False,
            "enabled": True,
        },
        {
            "name": "[SA] Auditor Agent",
            "first_message": "I audit whether the plan and output are fit-for-purpose and enterprise quality.",
            "language": "en-AU",
            "voice_id": "alloy",
            "runtime_profile_name": "BP Auditor Runtime",
            "runtime_profile_description": "BP mode auditor runtime.",
            "runtime_profile_payload": specialized_runtime_profile_payload(
                name="BP Auditor Runtime",
                description="BP mode auditor runtime.",
                system_prompt=BP_AUDITOR_SYSTEM_PROMPT,
                conversation_mode="working_session",
                enable_web=False,
            ),
            "agent_role": "sub",
            "parent_agent_name": "Business Strategist",
            "position": 112,
            "is_default": False,
            "enabled": True,
        },
    ]
    payloads.extend(_mas_agent_payloads())
    return payloads


def _mas_agent_payloads() -> list[dict]:
    return [
        {
            "name": "Llama Architect",
            "first_message": "Share the target outcome and constraints. I will route work to programming and testing sub-agents and return an implementation-grade synthesis.",
            "language": "en-AU",
            "voice_id": "alloy",
            "runtime_profile_name": "Llama Architect Runtime",
            "runtime_profile_description": "Head MAS orchestration runtime for architecting and delegating implementation safely.",
            "runtime_profile_payload": specialized_runtime_profile_payload(
                name="Llama Architect Runtime",
                description="Head MAS orchestration runtime for architecting and delegating implementation safely.",
                system_prompt=(
                    "You are the Llama Architect lead agent. Decompose work, assign implementation and test tasks to "
                    "sub-agents, and synthesize final answers grounded in executed evidence."
                ),
                conversation_mode="working_session",
                enable_web=False,
            ),
            "agent_role": "lead",
            "position": 0,
            "is_default": True,
            "enabled": True,
        },
        {
            "name": "[SA] Programming Agent 1",
            "first_message": "I implement backend and integration changes assigned by the Llama Architect.",
            "language": "en-AU",
            "voice_id": "alloy",
            "runtime_profile_name": "Programming Agent 1 Runtime",
            "runtime_profile_description": "Implementation-focused runtime for MAS coding tasks.",
            "runtime_profile_payload": specialized_runtime_profile_payload(
                name="Programming Agent 1 Runtime",
                description="Implementation-focused runtime for MAS coding tasks.",
                system_prompt="You are a programming sub-agent. Implement assigned backend and integration tasks with tests.",
                conversation_mode="working_session",
                enable_web=False,
            ),
            "agent_role": "sub",
            "parent_agent_name": "Llama Architect",
            "position": 1,
            "is_default": False,
            "enabled": True,
        },
        {
            "name": "[SA] Programming Agent 2",
            "first_message": "I implement UI and API contract changes assigned by the Llama Architect.",
            "language": "en-AU",
            "voice_id": "alloy",
            "runtime_profile_name": "Programming Agent 2 Runtime",
            "runtime_profile_description": "Implementation-focused runtime for MAS coding tasks.",
            "runtime_profile_payload": specialized_runtime_profile_payload(
                name="Programming Agent 2 Runtime",
                description="Implementation-focused runtime for MAS coding tasks.",
                system_prompt="You are a programming sub-agent. Implement assigned UI and API contract tasks with tests.",
                conversation_mode="working_session",
                enable_web=False,
            ),
            "agent_role": "sub",
            "parent_agent_name": "Llama Architect",
            "position": 2,
            "is_default": False,
            "enabled": True,
        },
        {
            "name": "[SA] Testing Agent",
            "first_message": "I validate completed work with automated checks and human-style walkthrough scenarios.",
            "language": "en-AU",
            "voice_id": "alloy",
            "runtime_profile_name": "Testing Agent Runtime",
            "runtime_profile_description": "Verification-focused runtime for MAS test execution and QA signoff.",
            "runtime_profile_payload": specialized_runtime_profile_payload(
                name="Testing Agent Runtime",
                description="Verification-focused runtime for MAS test execution and QA signoff.",
                system_prompt=(
                    "You are a testing sub-agent. Validate implementation with tests, human-flow checks, and explicit "
                    "acceptance outcomes."
                ),
                conversation_mode="working_session",
                enable_web=False,
            ),
            "agent_role": "sub",
            "parent_agent_name": "Llama Architect",
            "position": 3,
            "is_default": False,
            "enabled": True,
        },
    ]


def seed_default_agent_profiles(session: Session) -> None:
    default_runtime_profile = seed_default_runtime_profile(session)
    existing = session.scalar(select(AgentProfileRecord).where(AgentProfileRecord.is_default.is_(True)))
    changed = False
    if existing is None:
        payload = default_agent_payload(default_runtime_profile.id)
        session.add(AgentProfileRecord(**payload))
        changed = True
    elif not existing.runtime_profile_id:
        existing.runtime_profile_id = default_runtime_profile.id
        changed = True

    existing_by_name = {
        agent.name: agent for agent in session.scalars(select(AgentProfileRecord))
    }
    existing_runtime_profiles_by_name = {
        profile.name: profile for profile in session.scalars(select(RuntimeProfileRecord))
    }
    for payload in special_agent_payloads():
        # IMPORTANT: seeding should ensure these agents exist, but must not overwrite operator edits
        # (e.g., model_id changes) on subsequent API calls.
        # Prefer the runtime profile already attached to the agent (if any), even if it was renamed.
        for collection_slug in payload.get("ensure_collections") or []:
            ensure_collection_record(session, slug=str(collection_slug), name=str(collection_slug))
        existing_agent = existing_by_name.get(payload["name"])
        existing_runtime_profile = None
        created_runtime_profile = False
        if existing_agent is not None and existing_agent.runtime_profile_id:
            existing_runtime_profile = session.get(RuntimeProfileRecord, existing_agent.runtime_profile_id)
        if existing_runtime_profile is None:
            existing_runtime_profile = existing_runtime_profiles_by_name.get(payload["runtime_profile_name"])

        if existing_runtime_profile is None:
            runtime_profile = save_runtime_profile(
                session,
                payload["runtime_profile_payload"],
            )
            existing_runtime_profiles_by_name[runtime_profile.name] = runtime_profile
            created_runtime_profile = True
            changed = True
        else:
            runtime_profile = existing_runtime_profile
        if existing_agent is None:
            # Do not resurrect intentionally deleted special agents on restart.
            # If the runtime profile already exists, treat that as prior operator-managed state.
            if not created_runtime_profile and not bool(payload.get("recreate_if_missing", False)):
                continue
            session.add(
                AgentProfileRecord(
                    name=payload["name"],
                    first_message=payload["first_message"],
                    language=payload["language"],
                    voice_id=payload["voice_id"],
                    runtime_profile_id=runtime_profile.id,
                    agent_role=str(payload.get("agent_role") or "lead"),
                    position=int(payload.get("position") or 0),
                    is_default=bool(payload.get("is_default", False)),
                    enabled=payload["enabled"],
                )
            )
            changed = True
            continue
        if existing_agent.runtime_profile_id != runtime_profile.id:
            existing_agent.runtime_profile_id = runtime_profile.id
            changed = True
        desired_role = str(payload.get("agent_role") or existing_agent.agent_role or "lead")
        desired_position = int(payload.get("position") or existing_agent.position or 0)
        if existing_agent.agent_role != desired_role:
            existing_agent.agent_role = desired_role
            changed = True
        if int(existing_agent.position or 0) != desired_position:
            existing_agent.position = desired_position
            changed = True
        if bool(payload.get("is_default", False)) and not existing_agent.is_default:
            existing_agent.is_default = True
            for other in session.scalars(
                select(AgentProfileRecord).where(
                    AgentProfileRecord.id != existing_agent.id,
                    AgentProfileRecord.is_default.is_(True),
                )
            ):
                other.is_default = False
            changed = True

    # Resolve parent relationships after all required agents exist.
    session.flush()
    agent_rows = {agent.name: agent for agent in session.scalars(select(AgentProfileRecord))}
    for payload in special_agent_payloads():
        parent_name = str(payload.get("parent_agent_name") or "").strip()
        if not parent_name:
            continue
        agent = agent_rows.get(payload["name"])
        parent = agent_rows.get(parent_name)
        if agent is None or parent is None:
            continue
        if (agent.parent_agent_id or None) != parent.id:
            agent.parent_agent_id = parent.id
            changed = True
        if agent.agent_role != "sub":
            agent.agent_role = "sub"
            changed = True

    if _repair_gpt5_agent_deprecated_models(session):
        changed = True
    if _repair_bp_chain_llama_model_ids(session):
        changed = True
    for retired_name in RETIRED_LEGACY_ODOO_AGENT_NAMES:
        retired_agent = session.scalar(select(AgentProfileRecord).where(AgentProfileRecord.name == retired_name))
        if retired_agent is not None and retired_agent.enabled:
            retired_agent.enabled = False
            changed = True
    if changed:
        session.commit()


def list_agents(session: Session) -> list[AgentProfileRecord]:
    return list(
        session.scalars(
            select(AgentProfileRecord).order_by(
                AgentProfileRecord.is_default.desc(),
                AgentProfileRecord.agent_role.asc(),
                AgentProfileRecord.parent_agent_id.asc(),
                AgentProfileRecord.position.asc(),
                AgentProfileRecord.updated_at.desc(),
            )
        )
    )


def get_agent(session: Session, agent_id: str | None = None) -> AgentProfileRecord:
    if agent_id:
        agent = session.get(AgentProfileRecord, agent_id)
        if agent is None:
            raise ValueError(f"agent {agent_id} not found")
        return agent
    default = session.scalar(select(AgentProfileRecord).where(AgentProfileRecord.is_default.is_(True)))
    if default is None:
        raise ValueError("default agent profile not found")
    return default


def save_agent(session: Session, payload: dict) -> AgentProfileRecord:
    normalized_name = str(payload.get("name") or "").strip()
    if not normalized_name:
        raise ValueError("agent name is required")

    normalized_first_message = str(payload.get("first_message") or "").strip()
    if not normalized_first_message:
        raise ValueError("first message is required")

    normalized_role = str(payload.get("agent_role") or "lead").strip().lower() or "lead"
    if normalized_role not in {"lead", "sub"}:
        raise ValueError("agent_role must be lead or sub")
    parent_agent_id = str(payload.get("parent_agent_id") or "").strip() or None
    if normalized_role == "sub":
        if not parent_agent_id:
            raise ValueError("sub agents must provide parent_agent_id")
        if not normalized_name.startswith(SUB_AGENT_PREFIX):
            normalized_name = f"{SUB_AGENT_PREFIX}{normalized_name}"
        while normalized_name.startswith(f"{SUB_AGENT_PREFIX}{SUB_AGENT_PREFIX}"):
            normalized_name = normalized_name[len(SUB_AGENT_PREFIX):]
    else:
        parent_agent_id = None
        if normalized_name.startswith(SUB_AGENT_PREFIX):
            raise ValueError("lead agent names cannot start with [SA]")

    try:
        normalized_position = int(payload.get("position", 0))
    except (TypeError, ValueError) as exc:
        raise ValueError("position must be an integer >= 0") from exc
    if normalized_position < 0:
        raise ValueError("position must be an integer >= 0")

    record = session.get(AgentProfileRecord, payload.get("id")) if payload.get("id") else None
    existing_by_name = session.scalar(select(AgentProfileRecord).where(AgentProfileRecord.name == normalized_name))
    is_new_record = record is None

    if is_new_record and existing_by_name is not None:
        raise ValueError(f"agent '{normalized_name}' already exists")
    if record is not None and existing_by_name is not None and existing_by_name.id != record.id:
        raise ValueError(f"agent '{normalized_name}' already exists")

    pending_insert = False
    if record is None:
        record = AgentProfileRecord(
            name=normalized_name,
            first_message=normalized_first_message,
            language=str(payload.get("language") or "en-US").strip() or "en-US",
            voice_id=str(payload.get("voice_id") or "alloy").strip() or "alloy",
            agent_role=normalized_role,
            parent_agent_id=parent_agent_id,
            position=normalized_position,
            is_default=bool(payload.get("is_default", False)),
            enabled=bool(payload.get("enabled", True)),
        )
        pending_insert = True

    runtime_profile_payload = payload.get("runtime_profile")
    runtime_profile_id = payload.get("runtime_profile_id") or (None if is_new_record else record.runtime_profile_id)
    if is_new_record and runtime_profile_payload is None and not runtime_profile_id:
        raise ValueError(
            "new agents must provide an explicit runtime profile or runtime_profile_id; GhostDASH will not attach a hidden default runtime profile"
        )
    if runtime_profile_payload is not None:
        runtime_profile_record = save_runtime_profile(
            session,
            {
                **runtime_profile_payload,
                "id": runtime_profile_payload.get("id") or runtime_profile_id,
                "is_default": bool(payload.get("is_default", False)),
            },
        )
        record.runtime_profile_id = runtime_profile_record.id
    elif runtime_profile_id:
        record.runtime_profile_id = runtime_profile_id
    elif not record.runtime_profile_id:
        raise ValueError("agent runtime profile is required")

    payload = {
        **payload,
        "name": normalized_name,
        "first_message": normalized_first_message,
        "language": str(payload.get("language") or record.language or "en-US").strip() or "en-US",
        "voice_id": str(payload.get("voice_id") or record.voice_id or "alloy").strip() or "alloy",
        "agent_role": normalized_role,
        "parent_agent_id": parent_agent_id,
        "position": normalized_position,
    }

    for key in ("name", "first_message", "language", "voice_id", "agent_role", "parent_agent_id", "position", "is_default", "enabled"):
        if key in payload:
            setattr(record, key, payload[key])

    if pending_insert:
        session.add(record)
        session.flush()

    if record.parent_agent_id:
        if record.parent_agent_id == record.id:
            raise ValueError("agent cannot be its own parent")
        parent = session.get(AgentProfileRecord, record.parent_agent_id)
        if parent is None:
            raise ValueError(f"parent agent {record.parent_agent_id} not found")
        if (parent.agent_role or "lead") != "lead":
            raise ValueError("sub agents can only attach to lead agents")
    if record.agent_role == "sub" and record.is_default:
        raise ValueError("default agent cannot be a sub agent")

    if record.is_default:
        for other in session.scalars(
            select(AgentProfileRecord).where(AgentProfileRecord.id != record.id, AgentProfileRecord.is_default.is_(True))
        ):
            other.is_default = False
        runtime_profile = resolve_agent_runtime_profile(session, record)
        runtime_profile.is_default = True
        for other_profile in session.scalars(
            select(RuntimeProfileRecord).where(
                RuntimeProfileRecord.id != runtime_profile.id,
                RuntimeProfileRecord.is_default.is_(True),
            )
        ):
            other_profile.is_default = False
    session.commit()
    session.refresh(record)
    return record


def list_conversations(session: Session, agent_id: str, *, limit: int = 20) -> list[tuple[AgentConversationRecord, int]]:
    rows = session.execute(
        select(AgentConversationRecord, func.count(AgentMessageRecord.id))
        .outerjoin(AgentMessageRecord, AgentMessageRecord.conversation_id == AgentConversationRecord.id)
        .where(AgentConversationRecord.agent_id == agent_id)
        .group_by(AgentConversationRecord.id)
        .order_by(AgentConversationRecord.updated_at.desc())
        .limit(limit)
    )
    return [(conversation, count) for conversation, count in rows]


def list_messages(session: Session, conversation_id: str, *, limit: int = 100) -> list[AgentMessageRecord]:
    rows = list(
        session.scalars(
            select(AgentMessageRecord)
            .where(AgentMessageRecord.conversation_id == conversation_id)
            .order_by(AgentMessageRecord.created_at.asc())
            .limit(limit)
        )
    )
    return rows


def create_document_frame(
    session: Session,
    *,
    title: str = "Strategic document",
    metadata_json: dict | None = None,
) -> DocumentFrameRecord:
    frame = DocumentFrameRecord(
        title=(title.strip() or "Strategic document")[:256],
        status="draft",
        fragments_json=[],
        metadata_json=dict(metadata_json or {}),
    )
    session.add(frame)
    session.flush()
    return frame


def get_document_frame(session: Session, document_frame_id: str) -> DocumentFrameRecord:
    frame = session.get(DocumentFrameRecord, document_frame_id)
    if frame is None:
        raise ValueError(f"document frame {document_frame_id} not found")
    return frame


def create_conversation(
    session: Session,
    *,
    agent_id: str,
    message: str,
    corpora: list[str],
    api_mode: str,
    conversation_mode: str = "quick",
    workflow_mode: str = "standard",
    document_frame_id: str | None = None,
    title: str | None = None,
) -> AgentConversationRecord:
    resolved_title = (title or message.strip()[:80] or "New conversation").strip()
    conversation = AgentConversationRecord(
        agent_id=agent_id,
        title=resolved_title,
        corpora_json=list(corpora),
        api_mode=api_mode,
        conversation_mode=conversation_mode,
        workflow_mode=workflow_mode,
        document_frame_id=document_frame_id,
    )
    session.add(conversation)
    session.flush()
    return conversation


def append_message(
    session: Session,
    *,
    conversation_id: str,
    agent_id: str,
    role: str,
    content: str,
    query_mode: str | None = None,
    citations: list[dict] | None = None,
    tool_events: list[dict] | None = None,
    usage: dict | None = None,
    route_decision: dict | None = None,
    api_mode: str | None = None,
    conversation_mode: str | None = None,
    workflow_mode: str | None = None,
) -> AgentMessageRecord:
    message = AgentMessageRecord(
        conversation_id=conversation_id,
        agent_id=agent_id,
        role=role,
        content=content,
        query_mode=query_mode,
        citations_json=list(citations or []),
        tool_events_json=list(tool_events or []),
        usage_json=dict(usage) if usage is not None else None,
        route_decision_json=dict(route_decision) if route_decision is not None else None,
        api_mode=api_mode,
        conversation_mode=conversation_mode,
        workflow_mode=workflow_mode,
    )
    session.add(message)
    return message


def append_document_frame_fragment(
    session: Session,
    *,
    document_frame_id: str,
    source_conversation_id: str,
    source_message_id: str | None,
    fragment_type: str,
    content: str,
    title: str | None = None,
) -> DocumentFrameRecord:
    frame = get_document_frame(session, document_frame_id)
    fragments = list(frame.fragments_json or [])
    timestamp = datetime.now(UTC).isoformat()
    fragments.append(
        {
            "id": hashlib.sha256(
                f"{document_frame_id}:{source_conversation_id}:{source_message_id or ''}:{fragment_type}:{content}:{timestamp}".encode(
                    "utf-8"
                )
            ).hexdigest()[:16],
            "source_conversation_id": source_conversation_id,
            "source_message_id": source_message_id,
            "fragment_type": fragment_type,
            "title": title,
            "content": content,
            "approved": True,
            "created_at": timestamp,
            "updated_at": timestamp,
        }
    )
    frame.fragments_json = fragments
    return frame


def upsert_docx_session(
    session: Session,
    *,
    conversation_id: str,
    agent_id: str,
    template_id: str | None,
    operation: str,
    status: str,
    binding_json: dict | None = None,
    artifacts_json: list[dict] | None = None,
    diagnostics_json: list[dict] | None = None,
) -> DocxSessionRecord:
    record = session.scalar(
        select(DocxSessionRecord).where(
            DocxSessionRecord.conversation_id == conversation_id,
            DocxSessionRecord.agent_id == agent_id,
        )
    )
    if record is None:
        record = DocxSessionRecord(
            conversation_id=conversation_id,
            agent_id=agent_id,
            template_id=template_id,
            operation=operation,
            status=status,
            binding_json=dict(binding_json or {}),
            artifacts_json=list(artifacts_json or []),
            diagnostics_json=list(diagnostics_json or []),
        )
        session.add(record)
        session.flush()
        return record
    record.template_id = template_id
    record.operation = operation
    record.status = status
    record.binding_json = dict(binding_json or {})
    record.artifacts_json = list(artifacts_json or [])
    record.diagnostics_json = list(diagnostics_json or [])
    session.flush()
    return record


def build_history_context(messages: list[AgentMessageRecord], *, window_messages: int) -> str:
    recent = messages[-window_messages:]
    if not recent:
        return ""
    lines = []
    for message in recent:
        prefix = "User" if message.role == "user" else "Assistant"
        lines.append(f"{prefix}: {message.content}")
    return "\n".join(lines)


def _cache_cutoff() -> datetime | None:
    ttl_seconds = settings.app_chat_response_cache_ttl_seconds
    if ttl_seconds <= 0:
        return None
    return datetime.now(UTC) - timedelta(seconds=ttl_seconds)


def build_response_cache_key(
    *,
    agent: AgentProfileRecord,
    runtime_profile,
    conversation_id: str,
    history_context: str,
    message: str,
    corpora: list[str],
    api_mode: str,
    llm_model_id_override: str | None = None,
    tool_state: dict | None = None,
) -> str:
    llm_config = dict(runtime_profile.llm_config_json or {})
    guardrails_config = dict(runtime_profile.guardrails_config_json or {})
    kb_config = dict(runtime_profile.kb_config_json or {})
    retrieval_config = dict(runtime_profile.retrieval_config_json or {})
    tool_policy = dict(runtime_profile.tool_policy_config_json or {})
    payload = {
        "agent_id": agent.id,
        "agent_name": agent.name,
        "runtime_profile_id": runtime_profile.id,
        "conversation_id": conversation_id,
        "llm_config": llm_config,
        "guardrails_config": guardrails_config,
        "kb_config": kb_config,
        "retrieval_config": retrieval_config,
        "tool_policy_config": tool_policy,
        "history_context": history_context,
        "message": message,
        "corpora": list(corpora),
        "api_mode": api_mode,
        "tool_state": dict(tool_state or {}),
    }
    stripped = (llm_model_id_override or "").strip()
    if stripped:
        payload["llm_model_id_override"] = stripped
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def lookup_cached_response(session: Session, *, agent_id: str, request_hash: str) -> ChatResponseCacheRecord | None:
    if not settings.app_chat_response_cache_enabled:
        return None
    row = session.scalar(
        select(ChatResponseCacheRecord).where(
            ChatResponseCacheRecord.agent_id == agent_id,
            ChatResponseCacheRecord.request_hash == request_hash,
        )
    )
    if row is None:
        return None
    cutoff = _cache_cutoff()
    if cutoff is not None and row.updated_at < cutoff:
        session.delete(row)
        session.commit()
        return None
    row.hit_count += 1
    session.commit()
    session.refresh(row)
    return row


def store_cached_response(
    session: Session,
    *,
    agent_id: str,
    request_hash: str,
    answer_text: str,
    query_mode: str,
    citations: list[dict],
) -> ChatResponseCacheRecord | None:
    if not settings.app_chat_response_cache_enabled:
        return None
    row = session.scalar(
        select(ChatResponseCacheRecord).where(
            ChatResponseCacheRecord.agent_id == agent_id,
            ChatResponseCacheRecord.request_hash == request_hash,
        )
    )
    if row is None:
        row = ChatResponseCacheRecord(
            agent_id=agent_id,
            request_hash=request_hash,
            answer_text=answer_text,
            query_mode=query_mode,
            citations_json=list(citations),
        )
        session.add(row)
    else:
        row.answer_text = answer_text
        row.query_mode = query_mode
        row.citations_json = list(citations)
    session.commit()
    session.refresh(row)
    return row
