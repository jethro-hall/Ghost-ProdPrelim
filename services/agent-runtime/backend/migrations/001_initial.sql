-- Migration 001: agent runtime tables
-- Apply once against the ghostdash Postgres database.
-- All tables are namespaced to avoid collision with ghoststack-rag tables.

CREATE TABLE IF NOT EXISTS agent_runs (
    id              VARCHAR(64) PRIMARY KEY,
    conversation_id VARCHAR(64),
    mode            VARCHAR(16) NOT NULL DEFAULT 'agent',
    model           VARCHAR(256),
    question        TEXT,
    status          VARCHAR(16) NOT NULL DEFAULT 'queued',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    summary         TEXT,
    error           TEXT
);

-- Append-only event log. Never UPDATE or DELETE rows.
CREATE TABLE IF NOT EXISTS agent_run_events (
    id              VARCHAR(64) PRIMARY KEY,
    run_id          VARCHAR(64) NOT NULL,
    seq             BIGINT NOT NULL,
    parent_event_id VARCHAR(64),
    type            VARCHAR(64) NOT NULL,
    status          VARCHAR(16),
    title           TEXT,
    payload         JSONB,
    visible         BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_agent_run_events_run_seq
    ON agent_run_events (run_id, seq);

CREATE INDEX IF NOT EXISTS ix_agent_run_events_run_id
    ON agent_run_events (run_id);

CREATE TABLE IF NOT EXISTS agent_tool_calls (
    id              VARCHAR(64) PRIMARY KEY,
    run_id          VARCHAR(64) NOT NULL,
    call_id         VARCHAR(128),
    tool_name       VARCHAR(64),
    args            JSONB,
    status          VARCHAR(16),
    approval_status VARCHAR(16),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    output_ref      TEXT,
    exit_code       INTEGER,
    error           TEXT
);

CREATE INDEX IF NOT EXISTS ix_agent_tool_calls_run_id
    ON agent_tool_calls (run_id);

CREATE TABLE IF NOT EXISTS agent_artifacts (
    id          VARCHAR(64) PRIMARY KEY,
    run_id      VARCHAR(64) NOT NULL,
    path        TEXT,
    name        TEXT,
    mime_type   VARCHAR(128),
    sha256      VARCHAR(64),
    size_bytes  BIGINT,
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_agent_artifacts_run_id
    ON agent_artifacts (run_id);

CREATE TABLE IF NOT EXISTS agent_approvals (
    id           VARCHAR(64) PRIMARY KEY,
    run_id       VARCHAR(64) NOT NULL,
    tool_call_id VARCHAR(64),
    risk_level   VARCHAR(16),
    request      JSONB,
    decision     VARCHAR(16),
    decided_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS agent_verification_reviews (
    id                   VARCHAR(64) PRIMARY KEY,
    run_id               VARCHAR(64) NOT NULL,
    status               VARCHAR(16) NOT NULL,
    confidence           NUMERIC(4,2),
    defects              JSONB,
    required_remediation JSONB,
    summary              TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_agent_verification_reviews_run_id
    ON agent_verification_reviews (run_id);
