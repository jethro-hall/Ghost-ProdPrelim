-- Migration 002: add trace_id to agent_runs for observability correlation
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS trace_id VARCHAR(64);
CREATE INDEX IF NOT EXISTS ix_agent_runs_trace_id ON agent_runs (trace_id);
