import express from 'express';
import crypto from 'crypto';
import { execFileSync, spawn } from 'child_process';
import dotenv from 'dotenv';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import path from 'path';
import { Pool } from 'pg';
import http from 'http';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import multer from 'multer';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import ExcelJS from 'exceljs';
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.CONTROL_PLANE_PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET || '';
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const S3_BUCKET = String(process.env.S3_BUCKET || '').trim();
const S3_REGION = String(process.env.AWS_REGION || process.env.S3_REGION || '').trim();
const S3_PREFIX = String(process.env.S3_PREFIX || 'ghostdash-ingestion').trim().replace(/^\/+|\/+$/g, '');
const LLAMAINDEX_URL = String(process.env.LLAMAINDEX_URL || '').trim().replace(/\/$/, '');
const LLAMAINDEX_INTERNAL_KEY = String(process.env.LLAMAINDEX_INTERNAL_KEY || '').trim();
const SHOPIFY_MCP_URL = String(process.env.SHOPIFY_MCP_URL || '').trim().replace(/\/$/, '');
const SHOPIFY_MCP_INTERNAL_KEY = String(process.env.SHOPIFY_MCP_INTERNAL_KEY || '').trim();
const ODOO_RPC_URL = String(process.env.ODOO_RPC_URL || '').trim().replace(/\/$/, '');
const ODOO_RPC_INTERNAL_KEY = String(process.env.ODOO_RPC_INTERNAL_KEY || '').trim();
const DOCLING_PROCESSOR_URL = String(process.env.DOCLING_PROCESSOR_URL || 'http://docling-processor:8088').trim().replace(/\/$/, '');
const DOCLING_PROCESSOR_INTERNAL_KEY = String(process.env.DOCLING_PROCESSOR_INTERNAL_KEY || '').trim();
const VLLM_INTERNAL_BASE_URL = (process.env.VLLM_INTERNAL_BASE_URL || process.env.VLLM_OPENAI_BASE_URL || '').replace(/\/$/, '');
const VLLM_OPENAI_API_KEY = process.env.VLLM_OPENAI_API_KEY || '';
const VLLM_MODEL = process.env.VLLM_MODEL || 'gpt-4o-mini';
const DEFAULT_VLLM_PROVIDER_SLUG = 'default-vllm';
const LEGACY_DEFAULT_VLLM_MODEL_ALIASES = ['/model', 'mitstral 3.2', 'mistral 3.2', 'onestd'];
const LEGACY_CONTEXT_TOKENS = 32000;
const LEGACY_REQUEST_TOKENS = 27000;
const LEGACY_CONTEXT_THRESHOLD = 40000;
const LEGACY_REQUEST_THRESHOLD = 36000;
const UPGRADED_CONTEXT_TOKENS = 262000;
const UPGRADED_REQUEST_TOKENS = 220000;
const STREAM_CHUNK_SIZE = Math.max(8, Number(process.env.STREAM_CHUNK_SIZE || 24));
const STREAM_CHUNK_DELAY_MS = Math.max(0, Number(process.env.STREAM_CHUNK_DELAY_MS || 18));
if (!DATABASE_URL) {
    console.error(JSON.stringify({ level: 'error', msg: 'DATABASE_URL missing' }));
    process.exit(1);
}
if (!JWT_SECRET) {
    console.error(JSON.stringify({ level: 'error', msg: 'JWT_SECRET missing' }));
    process.exit(1);
}
const pool = new Pool({ connectionString: DATABASE_URL });

function readDashboardPackageVersion() {
    try {
        const raw = readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');
        const parsed = JSON.parse(raw);
        const version = String(parsed?.version || '').trim();
        return version || 'unknown';
    }
    catch {
        return 'unknown';
    }
}
function readGitValue(args) {
    try {
        return String(execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' })).trim();
    }
    catch {
        return '';
    }
}
function normalizeGithubUrl(remote) {
    const value = String(remote || '').trim();
    if (!value) return '';
    if (/^git@github\.com:/i.test(value)) {
        return `https://github.com/${value.replace(/^git@github\.com:/i, '').replace(/\.git$/i, '')}`;
    }
    if (/^https?:\/\/github\.com\//i.test(value)) {
        return value.replace(/\.git$/i, '');
    }
    return '';
}
function getDashboardVersionInfo() {
    const packageVersion = readDashboardPackageVersion();
    const commit = readGitValue(['rev-parse', 'HEAD']);
    const shortCommit = readGitValue(['rev-parse', '--short', 'HEAD']);
    const branch = readGitValue(['rev-parse', '--abbrev-ref', 'HEAD']);
    const tag = readGitValue(['describe', '--tags', '--exact-match']);
    const remote = readGitValue(['remote', 'get-url', 'origin']);
    const githubUrl = normalizeGithubUrl(remote);
    return {
        ok: true,
        dashboard_version: tag || `${packageVersion}${shortCommit ? `+${shortCommit}` : ''}`,
        package_version: packageVersion,
        git_commit: commit || null,
        git_commit_short: shortCommit || null,
        git_branch: branch || null,
        git_tag: tag || null,
        git_remote: remote || null,
        github_url: githubUrl || null,
        github_commit_url: githubUrl && commit ? `${githubUrl}/commit/${commit}` : null,
        source: githubUrl ? 'git+github' : 'git',
        generated_at: new Date().toISOString(),
    };
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function parseTraceId(header) {
    const v = (header || '').trim();
    return v && UUID_REGEX.test(v) ? v : crypto.randomUUID();
}
function normalizeAgentUuid(candidate) {
    const v = (candidate || '').trim();
    return v && UUID_REGEX.test(v) ? v : crypto.randomUUID();
}
function parseBearerToken(authHeader) {
    const raw = String(authHeader || '').trim();
    if (!raw) return '';
    const match = raw.match(/^Bearer\s+(.+)$/i);
    return match ? String(match[1] || '').trim() : '';
}
function normalizeOpenAiMessageContent(content) {
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (typeof part === 'string') return part.trim();
                if (part && typeof part === 'object' && String(part.type || '').trim() === 'text') {
                    return String(part.text || '').trim();
                }
                return '';
            })
            .filter(Boolean)
            .join('\n');
    }
    return '';
}
function extractOpenAiInput(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return '';
    const userMessages = messages
        .filter((m) => String(m?.role || '').trim().toLowerCase() === 'user')
        .map((m) => normalizeOpenAiMessageContent(m?.content))
        .filter(Boolean);
    if (userMessages.length > 0) return userMessages.join('\n\n');
    for (let i = messages.length - 1; i >= 0; i--) {
        const text = normalizeOpenAiMessageContent(messages[i]?.content);
        if (text) return text;
    }
    return '';
}
function extractResponsesInput(input) {
    if (!input) return '';
    if (typeof input === 'string') return input.trim();
    if (!Array.isArray(input)) return '';
    const chunks = [];
    for (const item of input) {
        if (!item) continue;
        if (typeof item === 'string') {
            const text = item.trim();
            if (text) chunks.push(text);
            continue;
        }
        if (typeof item !== 'object') continue;
        const role = String(item.role || '').trim().toLowerCase();
        if (role && role !== 'user') continue;
        if (typeof item.content === 'string') {
            const text = item.content.trim();
            if (text) chunks.push(text);
            continue;
        }
        const contentParts = Array.isArray(item.content) ? item.content : [];
        const merged = contentParts
            .map((part) => {
                if (typeof part === 'string') return part.trim();
                if (!part || typeof part !== 'object') return '';
                const type = String(part.type || '').trim().toLowerCase();
                if (type === 'input_text' || type === 'text') {
                    return String(part.text || '').trim();
                }
                return '';
            })
            .filter(Boolean)
            .join('\n');
        if (merged) chunks.push(merged);
    }
    return chunks.join('\n\n').trim();
}
function formatOpenAiError({ message, type, code, trace_id }) {
    return {
        error: {
            message: String(message || 'request_failed'),
            type: String(type || 'api_error'),
            code: String(code || 'request_failed'),
            trace_id: String(trace_id || ''),
        },
    };
}
function normalizeOpenAiUsage(usage) {
    if (!usage || typeof usage !== 'object') return undefined;
    const promptTokens = Number(usage.prompt_tokens);
    const completionTokens = Number(usage.completion_tokens);
    const totalTokens = Number(usage.total_tokens);
    if (!Number.isFinite(promptTokens) && !Number.isFinite(completionTokens) && !Number.isFinite(totalTokens)) {
        return undefined;
    }
    const out = {};
    if (Number.isFinite(promptTokens)) out.prompt_tokens = Math.max(0, Math.trunc(promptTokens));
    if (Number.isFinite(completionTokens)) out.completion_tokens = Math.max(0, Math.trunc(completionTokens));
    if (Number.isFinite(totalTokens)) out.total_tokens = Math.max(0, Math.trunc(totalTokens));
    return out;
}

function isLegacyDefaultVllmModelAlias(value) {
    const clean = String(value || '').trim().toLowerCase();
    return clean ? LEGACY_DEFAULT_VLLM_MODEL_ALIASES.includes(clean) : false;
}

function resolveConfiguredOpenAiBaseUrl(baseUrl) {
    const clean = String(baseUrl || '').trim();
    if (!clean) return '';
    try {
        const url = new URL(clean);
        const pathname = url.pathname.replace(/\/+$/, '');
        
        // Google Gemini OpenAI shim explicitly ends in /openai and should NOT have /v1 added
        if (url.hostname === 'generativelanguage.googleapis.com' && pathname.endsWith('/openai')) {
            url.pathname = pathname;
        }
        else if (!pathname || pathname === '/') {
            url.pathname = '/v1';
        }
        else if (/\/(v1|openai)$/i.test(pathname)) {
            url.pathname = pathname;
        }
        else {
            url.pathname = `${pathname}/v1`;
        }
        return url.toString().replace(/\/$/, '');
    }
    catch (_) {
        const stripped = clean.replace(/\/+$/, '');
        if (stripped.includes('generativelanguage.googleapis.com') && stripped.endsWith('/openai')) {
            return stripped;
        }
        return /\/(v1|openai)$/i.test(stripped) ? stripped : `${stripped}/v1`;
    }
}

function resolveOpenAiChatCompletionsUrl(baseUrl) {
    const normalizedBaseUrl = resolveConfiguredOpenAiBaseUrl(baseUrl);
    return normalizedBaseUrl ? `${normalizedBaseUrl}/chat/completions` : '';
}
function resolveOpenAiResponsesUrl(baseUrl) {
    const normalizedBaseUrl = resolveConfiguredOpenAiBaseUrl(baseUrl);
    return normalizedBaseUrl ? `${normalizedBaseUrl}/responses` : '';
}

function resolveOpenAiEmbeddingsUrl(baseUrl) {
    const normalizedBaseUrl = resolveConfiguredOpenAiBaseUrl(baseUrl);
    return normalizedBaseUrl ? `${normalizedBaseUrl}/embeddings` : '';
}
function supportsToolLoopForBaseUrl(baseUrl) {
    const normalizedBaseUrl = String(resolveConfiguredOpenAiBaseUrl(baseUrl || '') || '').trim().toLowerCase();
    if (!normalizedBaseUrl) return false;
    if (/api\.openai\.com\/v1$/i.test(normalizedBaseUrl)) return true;
    // Gemini OpenAI compatibility endpoint: .../v1beta/openai
    if (normalizedBaseUrl.includes('generativelanguage.googleapis.com') && /\/openai$/i.test(normalizedBaseUrl)) return true;
    return false;
}
function resolveLlmApiMode({ apiModeRaw, baseUrl, modelId }) {
    const explicitMode = String(apiModeRaw || '').trim().toLowerCase();
    if (explicitMode === 'responses') return 'responses';
    if (explicitMode === 'chat_completions') return 'chat_completions';
    const normalizedBaseUrl = String(resolveConfiguredOpenAiBaseUrl(baseUrl || '') || '').trim();
    const cleanModelId = String(modelId || '').trim();
    const autoDetectResponses = /api\.openai\.com\/v1$/i.test(normalizedBaseUrl) && /^gpt-5/i.test(cleanModelId);
    return autoDetectResponses ? 'responses' : 'chat_completions';
}

function resolveRuntimeModelId({ modelOverride, providerSlug, configuredModelId }) {
    const override = String(modelOverride || '').trim();
    if (override) return override;
    const configured = String(configuredModelId || '').trim();
    if (String(providerSlug || '').trim() === DEFAULT_VLLM_PROVIDER_SLUG && isLegacyDefaultVllmModelAlias(configured)) {
        return VLLM_MODEL;
    }
    return configured || VLLM_MODEL;
}

function resolveSessionId(sessionId) {
    const clean = String(sessionId || '').trim();
    return clean || crypto.randomUUID();
}
function parseBooleanRuntimeControl(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    const text = String(value || '').trim().toLowerCase();
    if (!text) return fallback;
    if (['1', 'true', 'yes', 'on'].includes(text)) return true;
    if (['0', 'false', 'no', 'off'].includes(text)) return false;
    return fallback;
}
function normalizeRetrievalMode(value) {
    const mode = String(value || '').trim().toLowerCase();
    if (['vector', 'hybrid', 'graph'].includes(mode)) return mode;
    return '';
}
function isMaskedSecretPlaceholder(raw = '') {
    const value = String(raw || '').trim();
    if (!value) return false;
    const lowered = value.toLowerCase();
    if (lowered === '[redacted]' || lowered === '<redacted>' || lowered === '[masked]' || lowered === '<masked>') return true;
    if (value === '••••••') return true;
    const maskOnly = value.replace(/\*/g, '').trim() === '' && value.length >= 6;
    return maskOnly;
}
function readRuntimeControlValue(controls = {}, paths = []) {
    for (const path of paths) {
        if (!Array.isArray(path) || path.length === 0) continue;
        let cursor = controls;
        let matched = true;
        for (const segment of path) {
            if (!cursor || typeof cursor !== 'object' || !(segment in cursor)) {
                matched = false;
                break;
            }
            cursor = cursor[segment];
        }
        if (matched && cursor !== undefined && cursor !== null && String(cursor).trim() !== '') {
            return cursor;
        }
    }
    return undefined;
}
function resolveAgentRuntimeSettings(controls = {}) {
    const runtimeCollectionName = String(readRuntimeControlValue(controls, [
        ['strategy_runtime', 'collection_name'],
        ['retrieval', 'collection_name'],
        ['collection_name'],
        ['index_id'],
    ]) || '').trim();
    const topP = Number(readRuntimeControlValue(controls, [['top_p'], ['generation', 'top_p']]));
    const temperature = Number(readRuntimeControlValue(controls, [['temperature'], ['generation', 'temperature']]));
    const maxTokens = Number(readRuntimeControlValue(controls, [['max_tokens'], ['generation', 'max_tokens']]));
    const presencePenalty = Number(readRuntimeControlValue(controls, [['presence_penalty'], ['generation', 'presence_penalty']]));
    const frequencyPenalty = Number(readRuntimeControlValue(controls, [['frequency_penalty'], ['generation', 'frequency_penalty']]));
    const maxInputChars = parsePositiveInt(readRuntimeControlValue(controls, [['guardrails', 'max_input_chars'], ['max_input_chars']]), null);
    const maxOutputChars = parsePositiveInt(readRuntimeControlValue(controls, [['guardrails', 'max_output_chars'], ['max_output_chars']]), null);
    const retrievalMode = normalizeRetrievalMode(readRuntimeControlValue(controls, [
        ['strategy_runtime', 'retrieval_mode'],
        ['retrieval', 'mode'],
        ['retrieval_mode'],
    ]));
    const strictEvidence = parseBooleanRuntimeControl(readRuntimeControlValue(controls, [
        ['strategy_runtime', 'strict_evidence'],
        ['strict_evidence'],
    ]), false);
    const collectionOnly = parseBooleanRuntimeControl(readRuntimeControlValue(controls, [
        ['retrieval', 'collection_only'],
        ['collection_only'],
        ['strategy_runtime', 'collection_only'],
    ]), false);
    const knowledgeOrchestration = String(readRuntimeControlValue(controls, [
        ['strategy_runtime', 'knowledge_orchestration'],
    ]) || '').trim().toLowerCase();
    const skipLlamaByFlag = parseBooleanRuntimeControl(readRuntimeControlValue(controls, [
        ['strategy_runtime', 'skip_llamaindex_retrieval'],
    ]), false);
    const skipLlamaByMode = knowledgeOrchestration === 'control_plane_only' || knowledgeOrchestration === 'direct';
    const skip_llamaindex_retrieval = skipLlamaByFlag === true || skipLlamaByMode === true;
    const completionUuidRaw = String(readRuntimeControlValue(controls, [
        ['strategy_runtime', 'completion_model_uuid'],
        ['direct_llm', 'completion_model_uuid'],
    ]) || '').trim();
    const completion_model_uuid = UUID_REGEX.test(completionUuidRaw) ? completionUuidRaw : '';
    const stopRaw = readRuntimeControlValue(controls, [['stop'], ['generation', 'stop']]);
    const stop = Array.isArray(stopRaw)
        ? stopRaw.map((entry) => String(entry || '').trim()).filter(Boolean).slice(0, 8)
        : String(stopRaw || '').trim()
            ? [String(stopRaw || '').trim()]
            : [];
    return {
        runtimeCollectionName,
        temperature: Number.isFinite(temperature) ? Math.max(0, Math.min(2, temperature)) : null,
        max_tokens: Number.isFinite(maxTokens) ? Math.max(1, Math.round(maxTokens)) : null,
        top_p: Number.isFinite(topP) ? Math.max(0.01, Math.min(1, topP)) : null,
        presence_penalty: Number.isFinite(presencePenalty) ? Math.max(-2, Math.min(2, presencePenalty)) : null,
        frequency_penalty: Number.isFinite(frequencyPenalty) ? Math.max(-2, Math.min(2, frequencyPenalty)) : null,
        max_input_chars: Number.isFinite(Number(maxInputChars)) ? Number(maxInputChars) : null,
        max_output_chars: Number.isFinite(Number(maxOutputChars)) ? Number(maxOutputChars) : null,
        retrieval_mode: retrievalMode,
        strict_evidence: strictEvidence,
        collection_only: collectionOnly,
        stop,
        skip_llamaindex_retrieval,
        completion_model_uuid,
        knowledge_orchestration: knowledgeOrchestration || null,
    };
}

function buildDecisionSnapshot(snapshot) {
    return {
        knowledge_phase2: {
            weighted_retrieval_ready: true,
            selected_sources: [],
            source_weights: [],
        },
        ...(snapshot && typeof snapshot === 'object' ? snapshot : {}),
    };
}

async function ensureSchema() {
    await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text NOT NULL UNIQUE,
      role text NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','operator','viewer')),
      password_hash text,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS agents (
      id text PRIMARY KEY,
      name text NOT NULL,
      voice_id text,
      system_prompt text,
      tools jsonb NOT NULL DEFAULT '[]'::jsonb,
      model_uuid uuid,
      endpoint_key uuid NOT NULL DEFAULT gen_random_uuid(),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS model_uuid uuid;
    ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS endpoint_key uuid DEFAULT gen_random_uuid();

    CREATE TABLE IF NOT EXISTS request_logs (
      id bigserial PRIMARY KEY,
      trace_id uuid NOT NULL,
      span_id uuid NOT NULL,
      service text NOT NULL,
      route text NOT NULL,
      start_ts timestamptz NOT NULL,
      end_ts timestamptz NOT NULL,
      latency_ms integer NOT NULL,
      status integer NOT NULL,
      error text,
      severity text NOT NULL DEFAULT 'info',
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    ALTER TABLE request_logs
      ADD COLUMN IF NOT EXISTS severity text NOT NULL DEFAULT 'info';
    CREATE INDEX IF NOT EXISTS idx_request_logs_severity_start_ts
      ON request_logs (severity, start_ts DESC);

    CREATE TABLE IF NOT EXISTS agent_sessions (
      session_id text NOT NULL,
      agent_id text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      last_trace_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (session_id, agent_id)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent_updated
      ON agent_sessions (agent_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS agent_turns (
      id bigserial PRIMARY KEY,
      session_id text NOT NULL,
      agent_id text NOT NULL,
      turn_no integer NOT NULL CHECK (turn_no > 0),
      role text NOT NULL CHECK (role IN ('user', 'assistant')),
      trace_id uuid NOT NULL,
      span_id uuid NOT NULL,
      status integer NOT NULL DEFAULT 200,
      latency_ms integer,
      model text,
      input text,
      output text,
      error text,
      usage jsonb NOT NULL DEFAULT '{}'::jsonb,
      decision_snapshot jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT agent_turns_session_agent_turn_role_uq UNIQUE (session_id, agent_id, turn_no, role)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_turns_session_turn
      ON agent_turns (session_id, turn_no);

    CREATE INDEX IF NOT EXISTS idx_agent_turns_agent_created
      ON agent_turns (agent_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS tools (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      kind text NOT NULL,
      config jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'error')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT tools_name_kind_uq UNIQUE (name, kind)
    );

    CREATE TABLE IF NOT EXISTS agent_runtime_controls (
      agent_id text PRIMARY KEY,
      controls jsonb NOT NULL DEFAULT '{}'::jsonb,
      style_overlay jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS guardrail_profiles (
      name text PRIMARY KEY,
      max_input_chars integer NOT NULL,
      max_output_chars integer NOT NULL,
      blocklist_csv text NOT NULL DEFAULT '',
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS agent_guardrail_bindings (
      agent_id text PRIMARY KEY,
      profile_name text NOT NULL REFERENCES guardrail_profiles(name) ON DELETE CASCADE,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS tool_guardrail_overrides (
      agent_id text NOT NULL,
      tool_id text NOT NULL,
      profile_name text REFERENCES guardrail_profiles(name) ON DELETE SET NULL,
      max_input_chars integer,
      max_output_chars integer,
      blocklist_csv text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (agent_id, tool_id)
    );

    CREATE TABLE IF NOT EXISTS cache_policies (
      endpoint text NOT NULL,
      agent_id text NOT NULL,
      tool_id text NOT NULL,
      cache_ttl_sec integer,
      provider text,
      model text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (endpoint, agent_id, tool_id)
    );

    CREATE TABLE IF NOT EXISTS agent_injections (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id text NOT NULL,
      trigger_type text NOT NULL DEFAULT 'next_turn',
      mode text NOT NULL DEFAULT 'prepend',
      payload text NOT NULL,
      priority integer NOT NULL DEFAULT 100,
      one_shot boolean NOT NULL DEFAULT true,
      active boolean NOT NULL DEFAULT true,
      expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_agent_injections_agent_active
      ON agent_injections (agent_id, active, priority, created_at DESC);

    CREATE TABLE IF NOT EXISTS llm_debug_logs (
      id bigserial PRIMARY KEY,
      trace_id uuid NOT NULL,
      span_id uuid NOT NULL,
      agent_id text,
      session_id text,
      level text NOT NULL DEFAULT 'debug',
      event text NOT NULL,
      detail jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_llm_debug_logs_created_at ON llm_debug_logs (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_llm_debug_logs_trace_id ON llm_debug_logs (trace_id);
    CREATE INDEX IF NOT EXISTS idx_llm_debug_logs_agent_id ON llm_debug_logs (agent_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS llm_registry (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      record_type text NOT NULL CHECK (record_type IN ('provider','model','dashboard')),
      scope text CHECK (scope IN ('site','user')),
      user_id uuid REFERENCES users(id) ON DELETE CASCADE,
      provider_id uuid REFERENCES llm_registry(id) ON DELETE CASCADE,
      model_uuid uuid REFERENCES llm_registry(id) ON DELETE SET NULL,
      name text,
      slug text,
      kind text,
      base_url text,
      api_key_env text,
      provider text,
      label text,
      model_id text,
      status text,
      system_prompt text NOT NULL DEFAULT '',
      enabled_tool_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
      enabled boolean NOT NULL DEFAULT true,
      last_test_status text NOT NULL DEFAULT 'untested' CHECK (last_test_status IN ('untested','passed','failed')),
      last_test_trace_id uuid,
      last_test_latency_ms integer,
      last_test_message text NOT NULL DEFAULT '',
      config jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT llm_registry_dashboard_scope_user_ck CHECK (
        record_type <> 'dashboard'
        OR (
          (scope = 'site' AND user_id IS NULL)
          OR (scope = 'user' AND user_id IS NOT NULL)
        )
      )
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_registry_provider_slug_uq
      ON llm_registry (slug)
      WHERE record_type = 'provider';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_registry_provider_name_uq
      ON llm_registry (name)
      WHERE record_type = 'provider';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_registry_model_provider_model_uq
      ON llm_registry (provider_id, model_id)
      WHERE record_type = 'model';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_registry_dashboard_site_uq
      ON llm_registry (scope)
      WHERE record_type = 'dashboard' AND scope = 'site';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_registry_dashboard_user_uq
      ON llm_registry (user_id)
      WHERE record_type = 'dashboard' AND user_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_llm_registry_record_type_updated
      ON llm_registry (record_type, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_llm_registry_dashboard_model
      ON llm_registry (model_uuid, updated_at DESC)
      WHERE record_type = 'dashboard';

    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'llm_providers' AND c.relkind = 'r'
      ) THEN
        INSERT INTO llm_registry (
          id, record_type, name, slug, kind, base_url, api_key_env, enabled, created_at, updated_at
        )
        SELECT
          id,
          'provider',
          name,
          slug,
          kind,
          base_url,
          api_key_env,
          COALESCE(enabled, true),
          COALESCE(created_at, now()),
          COALESCE(updated_at, now())
        FROM llm_providers
        ON CONFLICT (id) DO UPDATE
        SET name = EXCLUDED.name,
            slug = EXCLUDED.slug,
            kind = EXCLUDED.kind,
            base_url = EXCLUDED.base_url,
            api_key_env = EXCLUDED.api_key_env,
            enabled = EXCLUDED.enabled,
            updated_at = EXCLUDED.updated_at;
      END IF;

      IF EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'llm_models' AND c.relkind = 'r'
      ) THEN
        INSERT INTO llm_registry (
          id, record_type, provider_id, name, provider, base_url, model_id, config, status,
          created_at, updated_at, label, enabled
        )
        SELECT
          id,
          'model',
          provider_id,
          NULLIF(name, ''),
          NULLIF(provider, ''),
          NULLIF(base_url, ''),
          model_id,
          COALESCE(config, '{}'::jsonb),
          COALESCE(NULLIF(status, ''), CASE WHEN COALESCE(enabled, true) THEN 'active' ELSE 'disabled' END),
          COALESCE(created_at, now()),
          COALESCE(updated_at, now()),
          COALESCE(NULLIF(label, ''), NULLIF(name, ''), NULLIF(model_id, ''), 'Model'),
          COALESCE(enabled, CASE WHEN COALESCE(status, 'active') = 'disabled' THEN false ELSE true END)
        FROM llm_models
        ON CONFLICT (id) DO UPDATE
        SET provider_id = EXCLUDED.provider_id,
            name = EXCLUDED.name,
            provider = EXCLUDED.provider,
            base_url = EXCLUDED.base_url,
            model_id = EXCLUDED.model_id,
            config = EXCLUDED.config,
            status = EXCLUDED.status,
            label = EXCLUDED.label,
            enabled = EXCLUDED.enabled,
            updated_at = EXCLUDED.updated_at;
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS engine_settings (
      id integer PRIMARY KEY CHECK (id = 1),
      config jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS engine_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      trigger text NOT NULL DEFAULT 'manual',
      status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
      trace_id uuid NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz,
      latency_ms integer,
      summary jsonb NOT NULL DEFAULT '{}'::jsonb,
      error text
    );

    CREATE TABLE IF NOT EXISTS engine_run_steps (
      id bigserial PRIMARY KEY,
      run_id uuid NOT NULL REFERENCES engine_runs(id) ON DELETE CASCADE,
      step_key text NOT NULL,
      status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
      started_at timestamptz,
      ended_at timestamptz,
      latency_ms integer,
      detail jsonb NOT NULL DEFAULT '{}'::jsonb,
      error text
    );

    CREATE TABLE IF NOT EXISTS knowledge_entries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      source_type text NOT NULL DEFAULT 'rd_engine',
      title text,
      content text NOT NULL,
      tags jsonb NOT NULL DEFAULT '[]'::jsonb,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_by_run_id uuid REFERENCES engine_runs(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS docling_jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      filename text NOT NULL,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
      result_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS metric_sources (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slug text NOT NULL UNIQUE,
      label text NOT NULL,
      source_kind text NOT NULL DEFAULT 'glances',
      config jsonb NOT NULL DEFAULT '{}'::jsonb,
      last_seen_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS metric_samples (
      id bigserial PRIMARY KEY,
      source_id uuid NOT NULL REFERENCES metric_sources(id) ON DELETE CASCADE,
      metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
      sampled_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS service_health_checks (
      id bigserial PRIMARY KEY,
      service_key text NOT NULL,
      status text NOT NULL CHECK (status IN ('healthy','degraded','offline')),
      latency_ms integer,
      detail jsonb NOT NULL DEFAULT '{}'::jsonb,
      checked_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS ingestion_documents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      original_filename text NOT NULL,
      relative_path text,
      mime_type text,
      size_bytes bigint NOT NULL DEFAULT 0,
      storage_provider text NOT NULL DEFAULT 's3',
      storage_bucket text,
      storage_key text,
      status text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','queued','processing','completed','failed','cancelled')),
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS ingestion_jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      document_id uuid NOT NULL REFERENCES ingestion_documents(id) ON DELETE CASCADE,
      queue_job_id text,
      status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','completed','failed','cancelled')),
      stage text NOT NULL DEFAULT 'queued' CHECK (stage IN ('uploaded','queued','extracting','ocr','chunking','embedding','upserting','qa','completed','failed','cancelled')),
      progress_percent numeric(5,2) NOT NULL DEFAULT 0,
      estimated_completion_at timestamptz,
      started_at timestamptz,
      completed_at timestamptz,
      operator_message text,
      options jsonb NOT NULL DEFAULT '{}'::jsonb,
      result_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS ingestion_job_events (
      id bigserial PRIMARY KEY,
      job_id uuid NOT NULL REFERENCES ingestion_jobs(id) ON DELETE CASCADE,
      stage text NOT NULL,
      status text NOT NULL,
      message text,
      detail jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS ingestion_operator_messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id uuid NOT NULL REFERENCES ingestion_jobs(id) ON DELETE CASCADE,
      role text NOT NULL DEFAULT 'operator',
      message text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS document_chunks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id uuid NOT NULL REFERENCES ingestion_jobs(id) ON DELETE CASCADE,
      document_id uuid NOT NULL REFERENCES ingestion_documents(id) ON DELETE CASCADE,
      chunk_index integer NOT NULL,
      content text NOT NULL,
      token_estimate integer NOT NULL DEFAULT 0,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (job_id, chunk_index)
    );

    CREATE TABLE IF NOT EXISTS vector_sync_records (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id uuid NOT NULL REFERENCES ingestion_jobs(id) ON DELETE CASCADE,
      document_id uuid NOT NULL REFERENCES ingestion_documents(id) ON DELETE CASCADE,
      collection_name text NOT NULL,
      point_id text NOT NULL,
      embedding_provider text,
      vector_size integer,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS qdrant_collections_meta (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      collection_name text NOT NULL UNIQUE,
      config jsonb NOT NULL DEFAULT '{}'::jsonb,
      latest_quality_status text,
      latest_quality_summary text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS vector_quality_checks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id uuid REFERENCES ingestion_jobs(id) ON DELETE SET NULL,
      collection_name text NOT NULL,
      status text NOT NULL CHECK (status IN ('ready','warning','failed')),
      score numeric(5,2),
      summary text,
      detail jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS knowledge_entities (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_key text NOT NULL UNIQUE,
      label text NOT NULL,
      entity_type text NOT NULL DEFAULT 'concept',
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS knowledge_relationships (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      source_entity_id uuid NOT NULL REFERENCES knowledge_entities(id) ON DELETE CASCADE,
      target_entity_id uuid NOT NULL REFERENCES knowledge_entities(id) ON DELETE CASCADE,
      relation_type text NOT NULL,
      weight numeric(8,4) NOT NULL DEFAULT 1.0,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (source_entity_id, target_entity_id, relation_type)
    );

    CREATE TABLE IF NOT EXISTS knowledge_chunk_entities (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      chunk_id uuid NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
      entity_id uuid NOT NULL REFERENCES knowledge_entities(id) ON DELETE CASCADE,
      confidence numeric(8,4) NOT NULL DEFAULT 0.7,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (chunk_id, entity_id)
    );

    CREATE TABLE IF NOT EXISTS knowledge_graph_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id uuid REFERENCES ingestion_jobs(id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'completed' CHECK (status IN ('running','completed','failed')),
      summary jsonb NOT NULL DEFAULT '{}'::jsonb,
      error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS knowledge_eval_suites (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      description text,
      config jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS knowledge_eval_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      suite_id uuid REFERENCES knowledge_eval_suites(id) ON DELETE SET NULL,
      query_text text NOT NULL,
      expected_answer text,
      retrieval_mode text NOT NULL DEFAULT 'hybrid',
      inhouse_model_uuid uuid,
      external_model_uuid uuid,
      weights jsonb NOT NULL DEFAULT '{}'::jsonb,
      scorecard jsonb NOT NULL DEFAULT '{}'::jsonb,
      result jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL DEFAULT 'completed' CHECK (status IN ('running','completed','failed')),
      latency_ms integer,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS elevenlabs_conversations (
      conversation_id text PRIMARY KEY,
      agent_id text,
      agent_name text,
      user_id text,
      customer_number text,
      call_status text,
      call_successful boolean,
      direction text,
      started_at timestamptz,
      ended_at timestamptz,
      call_duration_secs integer,
      message_count integer,
      overview_summary text,
      transcript_summary text,
      call_summary_title text,
      latest_input text,
      audio_url text,
      recording_url text,
      call_cost numeric(12,4),
      tokens_prompt integer,
      tokens_completion integer,
      tokens_total integer,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      imported_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE elevenlabs_conversations ADD COLUMN IF NOT EXISTS agent_name text;
    ALTER TABLE elevenlabs_conversations ADD COLUMN IF NOT EXISTS user_id text;
    ALTER TABLE elevenlabs_conversations ADD COLUMN IF NOT EXISTS call_status text;
    ALTER TABLE elevenlabs_conversations ADD COLUMN IF NOT EXISTS call_successful boolean;
    ALTER TABLE elevenlabs_conversations ADD COLUMN IF NOT EXISTS started_at timestamptz;
    ALTER TABLE elevenlabs_conversations ADD COLUMN IF NOT EXISTS ended_at timestamptz;
    ALTER TABLE elevenlabs_conversations ADD COLUMN IF NOT EXISTS overview_summary text;
    ALTER TABLE elevenlabs_conversations ADD COLUMN IF NOT EXISTS latest_input text;
    ALTER TABLE elevenlabs_conversations ADD COLUMN IF NOT EXISTS audio_url text;
    ALTER TABLE elevenlabs_conversations ADD COLUMN IF NOT EXISTS recording_url text;
    ALTER TABLE elevenlabs_conversations ADD COLUMN IF NOT EXISTS call_cost numeric(12,4);
    ALTER TABLE elevenlabs_conversations ADD COLUMN IF NOT EXISTS tokens_prompt integer;
    ALTER TABLE elevenlabs_conversations ADD COLUMN IF NOT EXISTS tokens_completion integer;
    ALTER TABLE elevenlabs_conversations ADD COLUMN IF NOT EXISTS tokens_total integer;
    ALTER TABLE elevenlabs_conversations ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE elevenlabs_conversations ADD COLUMN IF NOT EXISTS raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE elevenlabs_conversations ADD COLUMN IF NOT EXISTS imported_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE elevenlabs_conversations ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE elevenlabs_conversations ALTER COLUMN agent_id DROP NOT NULL;
    UPDATE elevenlabs_conversations
       SET call_status = COALESCE(call_status, status)
     WHERE call_status IS NULL;
    UPDATE elevenlabs_conversations
       SET started_at = to_timestamp(start_time_unix_secs)
     WHERE started_at IS NULL
       AND start_time_unix_secs IS NOT NULL;
    UPDATE elevenlabs_conversations
       SET raw_payload = raw
     WHERE (raw_payload = '{}'::jsonb OR raw_payload IS NULL)
       AND raw IS NOT NULL;

    CREATE TABLE IF NOT EXISTS elevenlabs_conversation_messages (
      conversation_id text NOT NULL REFERENCES elevenlabs_conversations(conversation_id) ON DELETE CASCADE,
      message_id text NOT NULL,
      role text,
      message text,
      time_value text,
      raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (conversation_id, message_id)
    );

    CREATE TABLE IF NOT EXISTS elevenlabs_sync_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      trace_id uuid NOT NULL,
      agent_id text,
      started_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz,
      duration_ms integer,
      status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
      fetched_total integer NOT NULL DEFAULT 0,
      inserted_total integer NOT NULL DEFAULT 0,
      updated_total integer NOT NULL DEFAULT 0,
      page_count integer NOT NULL DEFAULT 0,
      error text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE TABLE IF NOT EXISTS elevenlabs_search_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      scope_key text NOT NULL,
      query_text text NOT NULL,
      comparison_mode boolean NOT NULL DEFAULT false,
      result_count integer NOT NULL DEFAULT 0,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS elevenlabs_saved_searches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      scope_key text NOT NULL,
      name text NOT NULL,
      query_text text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_engine_runs_started_at ON engine_runs (started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_engine_run_steps_run_id ON engine_run_steps (run_id, id);
    CREATE INDEX IF NOT EXISTS idx_knowledge_entries_created_at ON knowledge_entries (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_docling_jobs_created_at ON docling_jobs (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_docling_jobs_status ON docling_jobs (status);
    CREATE INDEX IF NOT EXISTS idx_metric_sources_last_seen ON metric_sources (last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_metric_samples_source_sampled ON metric_samples (source_id, sampled_at DESC);
    CREATE INDEX IF NOT EXISTS idx_service_health_checks_service_checked ON service_health_checks (service_key, checked_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ingestion_documents_created ON ingestion_documents (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ingestion_documents_status ON ingestion_documents (status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_document_created ON ingestion_jobs (document_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_status_stage ON ingestion_jobs (status, stage, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ingestion_job_events_job_created ON ingestion_job_events (job_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ingestion_operator_messages_job_created ON ingestion_operator_messages (job_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_eval_runs_created ON knowledge_eval_runs (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_document_chunks_job_index ON document_chunks (job_id, chunk_index);
    CREATE INDEX IF NOT EXISTS idx_vector_sync_records_job ON vector_sync_records (job_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_vector_sync_records_collection ON vector_sync_records (collection_name, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_qdrant_collections_meta_name ON qdrant_collections_meta (collection_name);
    CREATE INDEX IF NOT EXISTS idx_vector_quality_checks_collection ON vector_quality_checks (collection_name, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_entities_label ON knowledge_entities (label);
    CREATE INDEX IF NOT EXISTS idx_knowledge_relationships_source ON knowledge_relationships (source_entity_id, relation_type);
    CREATE INDEX IF NOT EXISTS idx_knowledge_relationships_target ON knowledge_relationships (target_entity_id, relation_type);
    CREATE INDEX IF NOT EXISTS idx_knowledge_chunk_entities_chunk ON knowledge_chunk_entities (chunk_id);
    CREATE INDEX IF NOT EXISTS idx_knowledge_chunk_entities_entity ON knowledge_chunk_entities (entity_id);
    CREATE INDEX IF NOT EXISTS idx_knowledge_graph_runs_job_created ON knowledge_graph_runs (job_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_elevenlabs_conversations_agent_started ON elevenlabs_conversations (agent_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_elevenlabs_conversations_imported ON elevenlabs_conversations (imported_at DESC);
    CREATE INDEX IF NOT EXISTS idx_elevenlabs_sync_runs_started ON elevenlabs_sync_runs (started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_elevenlabs_search_history_scope_created ON elevenlabs_search_history (scope_key, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_elevenlabs_saved_searches_scope_updated ON elevenlabs_saved_searches (scope_key, updated_at DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_endpoint_key_uq ON agents (endpoint_key);

    CREATE TABLE IF NOT EXISTS mcp_servers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      url text NOT NULL,
      auth_type text NOT NULL DEFAULT 'none',
      auth_key_env text,
      enabled boolean NOT NULL DEFAULT true,
      config jsonb NOT NULL DEFAULT '{}'::jsonb,
      last_health_status text,
      last_health_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT mcp_servers_name_uq UNIQUE (name)
    );

    CREATE TABLE IF NOT EXISTS orchestration_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id text REFERENCES agents(id),
      workflow_type text NOT NULL DEFAULT 'agent_workflow',
      state text NOT NULL DEFAULT 'active',
      context_snapshot_key text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_activity_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_mcp_servers_name ON mcp_servers (name);
    CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled ON mcp_servers (enabled, name);
    CREATE INDEX IF NOT EXISTS idx_orchestration_sessions_agent_state ON orchestration_sessions (agent_id, state, last_activity_at DESC);
  `);
    await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'dashboard_llm_settings' AND c.relkind = 'r'
      ) THEN
        INSERT INTO llm_registry (
          id, record_type, scope, user_id, model_uuid, system_prompt, enabled_tool_ids, enabled,
          last_test_status, last_test_trace_id, last_test_latency_ms, last_test_message, config,
          created_at, updated_at
        )
        SELECT
          id,
          'dashboard',
          scope,
          user_id,
          model_uuid,
          COALESCE(system_prompt, ''),
          COALESCE(enabled_tool_ids, '[]'::jsonb),
          COALESCE(enabled, true),
          COALESCE(last_test_status, 'untested'),
          last_test_trace_id,
          last_test_latency_ms,
          COALESCE(last_test_message, ''),
          COALESCE(config, '{}'::jsonb),
          COALESCE(created_at, now()),
          COALESCE(updated_at, now())
        FROM dashboard_llm_settings
        ON CONFLICT (id) DO UPDATE
        SET scope = EXCLUDED.scope,
            user_id = EXCLUDED.user_id,
            model_uuid = EXCLUDED.model_uuid,
            system_prompt = EXCLUDED.system_prompt,
            enabled_tool_ids = EXCLUDED.enabled_tool_ids,
            enabled = EXCLUDED.enabled,
            last_test_status = EXCLUDED.last_test_status,
            last_test_trace_id = EXCLUDED.last_test_trace_id,
            last_test_latency_ms = EXCLUDED.last_test_latency_ms,
            last_test_message = EXCLUDED.last_test_message,
            config = EXCLUDED.config,
            updated_at = EXCLUDED.updated_at;
      END IF;
    END $$;

    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'dashboard_llm_settings' AND c.relkind = 'v'
      ) THEN
        EXECUTE 'DROP VIEW dashboard_llm_settings CASCADE';
      ELSIF EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'dashboard_llm_settings' AND c.relkind = 'r'
      ) THEN
        EXECUTE 'DROP TABLE dashboard_llm_settings';
      END IF;
      IF EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'llm_models' AND c.relkind = 'v'
      ) THEN
        EXECUTE 'DROP VIEW llm_models CASCADE';
      ELSIF EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'llm_models' AND c.relkind = 'r'
      ) THEN
        EXECUTE 'DROP TABLE llm_models';
      END IF;
      IF EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'llm_providers' AND c.relkind = 'v'
      ) THEN
        EXECUTE 'DROP VIEW llm_providers CASCADE';
      ELSIF EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'llm_providers' AND c.relkind = 'r'
      ) THEN
        EXECUTE 'DROP TABLE llm_providers';
      END IF;
    END $$;

  `);
    await pool.query(`
    INSERT INTO tools (name, kind, config, status)
    VALUES ('Hubtiger API', 'hubtiger', '{"version":"v1"}', 'active')
    ON CONFLICT (name, kind) DO NOTHING
  `);
    await pool.query(`
    INSERT INTO tools (name, kind, config, status)
    VALUES ('Shopify MCP', 'shopify_mcp', '{"version":"v1","test_path":"/health","execute_path":"/tool"}', 'active')
    ON CONFLICT (name, kind) DO NOTHING
  `);
    await pool.query(`
    INSERT INTO tools (name, kind, config, status)
    VALUES ('Odoo ERP Gateway', 'odoo_rpc', '{"version":"v1","test_path":"/health","execute_path":"/tool"}', 'active')
    ON CONFLICT (name, kind) DO NOTHING
  `);
    await pool.query(
        `UPDATE agents SET endpoint_key = gen_random_uuid() WHERE endpoint_key IS NULL`
    );
    for (const seed of METRIC_SOURCE_SEEDS) {
        await pool.query(
            `INSERT INTO metric_sources (slug, label, source_kind, config, updated_at)
             VALUES ($1,$2,$3,$4::jsonb, now())
             ON CONFLICT (slug) DO UPDATE
             SET label = EXCLUDED.label,
                 source_kind = EXCLUDED.source_kind,
                 config = CASE
                  WHEN COALESCE(metric_sources.config->>'url', '') IN ('', 'http://127.0.0.1:61208/api/4/all') THEN EXCLUDED.config
                   ELSE metric_sources.config
                 END,
                 updated_at = now()`,
            [seed.slug, seed.label, seed.source_kind, JSON.stringify(seed.config)]
        );
    }

    const providerSlug = DEFAULT_VLLM_PROVIDER_SLUG;
    const providerBaseUrl = String(process.env.VLLM_INTERNAL_BASE_URL || process.env.VLLM_OPENAI_BASE_URL || '').trim().replace(/\/$/, '');
    if (providerBaseUrl) {
        const defaultProviderRow = await upsertLlmProviderRow({
            name: 'Default vLLM',
            slug: providerSlug,
            kind: 'openai_compatible',
            base_url: providerBaseUrl,
            api_key_env: 'LLAMAINDEX_INTERNAL_KEY',
            enabled: true,
        });
        if (defaultProviderRow?.id) {
            await upsertLlmModelRow({
                provider_id: defaultProviderRow.id,
                label: VLLM_MODEL,
                model_id: VLLM_MODEL,
                enabled: true,
            });
        }
        await pool.query(
            `UPDATE llm_registry m
       SET provider_id = p.id
       FROM llm_registry p
       WHERE m.provider_id IS NULL
         AND m.record_type = 'model'
         AND p.record_type = 'provider'
         AND p.slug = $1`,
            [providerSlug]
        );
        await pool.query(
            `UPDATE agents a
       SET model_uuid = m.id
       FROM llm_registry m
       JOIN llm_registry p ON p.id = m.provider_id
       WHERE a.model_uuid IS NULL
         AND m.record_type = 'model'
         AND p.record_type = 'provider'
         AND p.slug = $1
         AND m.model_id = $2`,
            [providerSlug, VLLM_MODEL]
        );
        await pool.query(
            `WITH canonical AS (
         SELECT m.id, m.provider_id
         FROM llm_registry m
         JOIN llm_registry p ON p.id = m.provider_id
         WHERE p.slug = $1
           AND m.record_type = 'model'
           AND p.record_type = 'provider'
           AND m.model_id = $2
         ORDER BY m.created_at ASC, m.id ASC
         LIMIT 1
       )
       UPDATE agents a
       SET model_uuid = c.id
       FROM canonical c
       WHERE a.model_uuid IN (
         SELECT m.id
         FROM llm_registry m
         WHERE m.provider_id = c.provider_id
           AND m.record_type = 'model'
           AND (
             lower(btrim(coalesce(m.model_id, ''))) = ANY($3::text[])
             OR lower(btrim(coalesce(m.label, ''))) = ANY($3::text[])
           )
       )
         AND a.model_uuid <> c.id`,
            [providerSlug, VLLM_MODEL, LEGACY_DEFAULT_VLLM_MODEL_ALIASES]
        );
        await pool.query(
            `WITH canonical AS (
         SELECT m.id, m.provider_id
         FROM llm_registry m
         JOIN llm_registry p ON p.id = m.provider_id
         WHERE p.slug = $1
           AND m.record_type = 'model'
           AND p.record_type = 'provider'
           AND m.model_id = $2
         ORDER BY m.created_at ASC, m.id ASC
         LIMIT 1
       )
       UPDATE llm_registry m
       SET enabled = false,
           status = 'disabled',
           updated_at = now()
       FROM canonical c
       WHERE m.record_type = 'model'
         AND m.provider_id = c.provider_id
         AND m.id <> c.id
         AND (
           lower(btrim(coalesce(m.model_id, ''))) = ANY($3::text[])
           OR lower(btrim(coalesce(m.label, ''))) = ANY($3::text[])
         )`,
            [providerSlug, VLLM_MODEL, LEGACY_DEFAULT_VLLM_MODEL_ALIASES]
        );
    }
    await pool.query(
        `INSERT INTO engine_settings (id, config, updated_at)
     VALUES (1, $1::jsonb, now())
     ON CONFLICT (id) DO NOTHING`,
        [JSON.stringify(DEFAULT_ENGINE_SETTINGS)]
    );
    const canonicalDefaultModelRow = providerBaseUrl
        ? await pool.query(
            `SELECT m.id
               FROM llm_registry m
               JOIN llm_registry p ON p.id = m.provider_id
              WHERE p.slug = $1
                AND m.record_type = 'model'
                AND p.record_type = 'provider'
                AND m.model_id = $2
              ORDER BY m.created_at ASC, m.id ASC
              LIMIT 1`,
            [providerSlug, VLLM_MODEL]
        ).catch(() => ({ rowCount: 0, rows: [] }))
        : { rowCount: 0, rows: [] };
    const canonicalDefaultModelId = String(canonicalDefaultModelRow.rows?.[0]?.id || '').trim() || null;
    const existingSiteSetting = await pool.query(
        `SELECT id
           FROM llm_registry
          WHERE record_type = 'dashboard'
            AND scope = 'site'
          LIMIT 1`
    ).catch(() => ({ rowCount: 0, rows: [] }));
    if (existingSiteSetting.rowCount === 0) {
        await upsertDashboardLlmSettingRow({
            scope: 'site',
            model_uuid: canonicalDefaultModelId,
            system_prompt: DEFAULT_ENGINE_SETTINGS.dashboard_llm.system_prompt,
            enabled_tool_ids: [],
            enabled: true,
            last_test_status: canonicalDefaultModelId ? 'passed' : 'untested',
            last_test_message: canonicalDefaultModelId ? 'Seeded from verified canonical LLM defaults.' : '',
            config: {},
        });
    }
    await consolidateLegacyDashboardLlmState({
        default_provider_slug: providerSlug,
        default_model_id: VLLM_MODEL,
    });
    await pool.query(`
    CREATE TABLE IF NOT EXISTS ingestion_upload_batches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      trace_id uuid,
      status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'failed')),
      precheck_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_ingestion_upload_batches_created
      ON ingestion_upload_batches (created_at DESC);
    ALTER TABLE ingestion_documents
      ADD COLUMN IF NOT EXISTS upload_batch_id uuid REFERENCES ingestion_upload_batches(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_ingestion_documents_upload_batch
      ON ingestion_documents (upload_batch_id, created_at DESC);
  `);
}
async function getEngineSettings() {
    const row = await pool.query(
        `SELECT config, updated_at
     FROM engine_settings
     WHERE id = 1
     LIMIT 1`
    );
    const stored = row.rowCount > 0 ? (row.rows[0].config || {}) : {};
    const merged = deepMerge(DEFAULT_ENGINE_SETTINGS, stored);
    return { config: merged, updated_at: row.rowCount > 0 ? row.rows[0].updated_at : null };
}
async function saveEngineSettingsPatch(patch) {
    const current = await getEngineSettings();
    const merged = deepMerge(current.config, patch || {});
    const updated = await pool.query(
        `INSERT INTO engine_settings (id, config, updated_at)
     VALUES (1, $1::jsonb, now())
     ON CONFLICT (id) DO UPDATE
     SET config = EXCLUDED.config,
         updated_at = now()
     RETURNING config, updated_at`,
        [JSON.stringify(merged)]
    );
    return updated.rows[0];
}
async function insertRequestLogRow({
    trace_id,
    span_id,
    route,
    start_ts,
    end_ts,
    latency_ms,
    status,
    error = null,
    metadata = {},
}) {
    try {
        const severity = deriveRequestSeverity({ route, status, latency_ms, error, metadata });
        await pool.query(
            `INSERT INTO request_logs (trace_id, span_id, service, route, start_ts, end_ts, latency_ms, status, error, severity, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
            [trace_id, span_id, 'control-plane-api', route, start_ts, end_ts, latency_ms, status, error, severity, JSON.stringify(metadata)]
        );
    }
    catch (_) {
        // best-effort only
    }
}
function deriveRequestSeverity({ route = '', status = 200, latency_ms = 0, error = '', metadata = {} }) {
    const routeLower = String(route || '').toLowerCase();
    const errorLower = String(error || '').toLowerCase();
    const metadataText = JSON.stringify(metadata || {}).toLowerCase();
    const isCritical =
        Number(status) >= 500
        || errorLower.includes('no upstreams available')
        || errorLower.includes('connection refused')
        || errorLower.includes('orchestrator')
        || metadataText.includes('llamaindex_not_configured')
        || metadataText.includes('knowledge_query_failed');
    if (isCritical) return 'critical';
    if (Number(status) >= 400 || errorLower) return 'error';
    if (Number(latency_ms) >= 1500 || routeLower.includes('/api/metrics/overview')) return 'warning';
    return 'info';
}
let engineLoopTimer = null;
let engineRunInFlight = false;
async function executeRdEngineRun({ trigger = 'manual', force = false } = {}) {
    if (engineRunInFlight) {
        return { ok: false, skipped: true, reason: 'engine_run_in_flight' };
    }
    const settingsState = await getEngineSettings();
    const cfg = settingsState.config || DEFAULT_ENGINE_SETTINGS;
    if (cfg.enabled !== true && !force) {
        return { ok: false, skipped: true, reason: 'engine_disabled' };
    }
    engineRunInFlight = true;
    const trace_id = crypto.randomUUID();
    const runSpanId = crypto.randomUUID();
    const runStart = Date.now();
    const started_at = nowIso();
    let runId = null;
    const summary = {
        trigger,
        synthesizer: {},
        fetch: {},
        evaluation: {},
        injector: {},
    };
    const createStep = async (step_key) => {
        const row = await pool.query(
            `INSERT INTO engine_run_steps (run_id, step_key, status, started_at)
       VALUES ($1,$2,'running', now())
       RETURNING id`,
            [runId, step_key]
        );
        return row.rows[0].id;
    };
    const finishStep = async (stepId, ok, detail = {}, error = null, startedMs = Date.now()) => {
        const latency_ms = Math.max(1, Date.now() - startedMs);
        await pool.query(
            `UPDATE engine_run_steps
       SET status = $2,
           ended_at = now(),
           latency_ms = $3,
           detail = $4::jsonb,
           error = $5
       WHERE id = $1`,
            [stepId, ok ? 'completed' : 'failed', latency_ms, JSON.stringify(detail || {}), error ? String(error) : null]
        );
    };
    try {
        const runRow = await pool.query(
            `INSERT INTO engine_runs (trigger, status, trace_id, started_at, summary)
       VALUES ($1,'running',$2, now(), '{}'::jsonb)
       RETURNING id`,
            [trigger, trace_id]
        );
        runId = runRow.rows[0].id;

        // 1) Synthesizer
        const synthStart = Date.now();
        const synthStepId = await createStep('synthesizer');
        const lookbackHours = parsePositiveInt(cfg.schedule_hours, 6);
        const synthRows = await pool.query(
            `SELECT event, level, created_at, detail
       FROM llm_debug_logs
       WHERE created_at >= now() - ($1::text || ' hours')::interval
       ORDER BY created_at DESC
       LIMIT 200`,
            [lookbackHours]
        );
        const unresolved = synthRows.rows
            .filter((r) => String(r.level || '').toLowerCase() === 'error')
            .slice(0, 20)
            .map((r) => ({
            event: r.event,
            created_at: r.created_at,
            message: r.detail?.error || r.detail?.message || r.detail?.upstream_body?.message || null,
        }));
        const topicHints = Array.from(new Set(unresolved.map((u) => String(u.event || '').trim()).filter(Boolean))).slice(0, 10);
        summary.synthesizer = {
            llm_events_scanned: synthRows.rowCount,
            unresolved_count: unresolved.length,
            topic_hints: topicHints,
        };
        await finishStep(synthStepId, true, summary.synthesizer, null, synthStart);

        // 2) Fetch Agent (query planner for external fetch workers)
        const fetchStart = Date.now();
        const fetchStepId = await createStep('fetch');
        const maxSources = parsePositiveInt(cfg.max_sources_per_cycle, 12);
        const plannedQueries = topicHints
            .slice(0, maxSources)
            .map((hint) => `latest best practices for ${hint}`)
            .concat(unresolved.slice(0, Math.max(0, maxSources - topicHints.length)).map((u) => `resolve ${u.event} ${u.message || ''}`))
            .slice(0, maxSources);
        summary.fetch = {
            planned_query_count: plannedQueries.length,
            planned_queries: plannedQueries,
            note: 'Planner-only in this build; web fetch workers can consume these queries asynchronously.',
        };
        await finishStep(fetchStepId, true, summary.fetch, null, fetchStart);

        // 3) Evaluation & Scoring Agent
        const evalStart = Date.now();
        const evalStepId = await createStep('evaluation');
        const threshold = Number(cfg?.sub_agent_matrix?.evaluation?.criticism_threshold ?? 0.6);
        const correctionMatrix = unresolved.map((u) => ({
            event: u.event,
            message: u.message,
            severity: u.message ? 'high' : 'medium',
            confidence: Math.min(1, Math.max(0.1, threshold + 0.2)),
            correction_required: true,
        }));
        summary.evaluation = {
            criticism_threshold: threshold,
            corrections_flagged: correctionMatrix.length,
            correction_matrix_preview: correctionMatrix.slice(0, 8),
        };
        await finishStep(evalStepId, true, summary.evaluation, null, evalStart);

        // 4) Knowledge Injector
        const injectStart = Date.now();
        const injectStepId = await createStep('injector');
        const injectLimit = parsePositiveInt(cfg.max_knowledge_injections_per_cycle, 8);
        const injectRows = correctionMatrix.slice(0, injectLimit).map((c) => ({
            title: `R&D correction: ${c.event}`,
            content: `Event: ${c.event}\nMessage: ${c.message || 'n/a'}\nSeverity: ${c.severity}\nConfidence: ${c.confidence}`,
            tags: ['rd_engine', 'correction', c.event],
            metadata: { source: 'evaluation_matrix', trigger },
        }));
        for (const entry of injectRows) {
            await pool.query(
                `INSERT INTO knowledge_entries (source_type, title, content, tags, metadata, created_by_run_id)
           VALUES ('rd_engine', $1, $2, $3::jsonb, $4::jsonb, $5)`,
                [entry.title, entry.content, JSON.stringify(entry.tags), JSON.stringify(entry.metadata), runId]
            );
        }
        summary.injector = {
            injected_count: injectRows.length,
            source: 'correction_matrix',
        };
        await finishStep(injectStepId, true, summary.injector, null, injectStart);

        const latency_ms = Math.max(1, Date.now() - runStart);
        await pool.query(
            `UPDATE engine_runs
       SET status = 'completed',
           ended_at = now(),
           latency_ms = $2,
           summary = $3::jsonb
       WHERE id = $1`,
            [runId, latency_ms, JSON.stringify(summary)]
        );
        await insertLlmDebugLog({
            trace_id,
            span_id: runSpanId,
            level: 'debug',
            event: 'rd_engine.run.completed',
            detail: { run_id: runId, trigger, latency_ms, summary },
        });
        await insertRequestLogRow({
            trace_id,
            span_id: runSpanId,
            route: `POST /api/engine/run`,
            start_ts: started_at,
            end_ts: nowIso(),
            latency_ms,
            status: 200,
            metadata: { run_id: runId, trigger, mode: 'orchestrated' },
        });
        return { ok: true, run_id: runId, trace_id, latency_ms, summary };
    }
    catch (err) {
        const latency_ms = Math.max(1, Date.now() - runStart);
        if (runId) {
            await pool.query(
                `UPDATE engine_runs
         SET status = 'failed',
             ended_at = now(),
             latency_ms = $2,
             summary = $3::jsonb,
             error = $4
         WHERE id = $1`,
                [runId, latency_ms, JSON.stringify(summary), String(err && err.message || err)]
            ).catch(() => {});
        }
        await insertLlmDebugLog({
            trace_id,
            span_id: runSpanId,
            level: 'error',
            event: 'rd_engine.run.failed',
            detail: { run_id: runId, trigger, error: String(err && err.message || err) },
        });
        await insertRequestLogRow({
            trace_id,
            span_id: runSpanId,
            route: `POST /api/engine/run`,
            start_ts: started_at,
            end_ts: nowIso(),
            latency_ms,
            status: 500,
            error: String(err && err.message || err),
            metadata: { run_id: runId, trigger, mode: 'orchestrated' },
        });
        return { ok: false, run_id: runId, trace_id, latency_ms, error: 'rd_engine_run_failed' };
    }
    finally {
        engineRunInFlight = false;
    }
}
async function startEngineScheduler() {
    if (engineLoopTimer) clearInterval(engineLoopTimer);
    const settings = await getEngineSettings();
    const runtimeState = resolveKnowledgeRuntimeState(settings.config || {});
    if (!runtimeState.orchestrator_enabled) {
        engineLoopTimer = null;
        return;
    }
    const hours = parsePositiveInt(settings.config?.schedule_hours, 6);
    const intervalMs = Math.max(1, hours) * 60 * 60 * 1000;
    engineLoopTimer = setInterval(() => {
        executeRdEngineRun({ trigger: 'scheduled' }).catch(() => {});
    }, intervalMs);
}
function resolveKnowledgeRuntimeState(config) {
    const stored = config?.knowledge_runtime && typeof config.knowledge_runtime === 'object'
        ? config.knowledge_runtime
        : {};
    return {
        queue_paused: stored.queue_paused === true,
        orchestrator_enabled: typeof stored.orchestrator_enabled === 'boolean'
            ? stored.orchestrator_enabled === true
            : config?.enabled === true,
    };
}
function jsonLog(obj) {
    console.log(JSON.stringify(obj));
}
function nowIso() {
    return new Date().toISOString();
}
async function insertLlmDebugLog({
    trace_id,
    span_id,
    agent_id = null,
    session_id = null,
    level = 'debug',
    event,
    detail = {},
}) {
    try {
        const safeDetail = sanitizeForLogs(detail);
        jsonLog({
            level,
            service: 'control-plane-api',
            trace_id: trace_id || null,
            span_id: span_id || null,
            route: `LLM ${event}`,
            msg: 'llm_debug_event',
            metadata: {
                source: 'llm_debug_logs',
                agent_id: agent_id || null,
                session_id: session_id || null,
                detail: safeDetail,
            },
        });
        await pool.query(
            `INSERT INTO llm_debug_logs (trace_id, span_id, agent_id, session_id, level, event, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
            [trace_id, span_id, agent_id, session_id, level, event, JSON.stringify(safeDetail)]
        );
    }
    catch (_) {
        // best-effort debug log sink
    }
}

async function beginAgentTurnPersistence({
    agent_id,
    session_id,
    trace_id,
    span_id,
    input,
    route,
    transport,
}) {
    const resolvedSessionId = resolveSessionId(session_id);
    await pool.query(
        `INSERT INTO agent_sessions (session_id, agent_id, metadata, last_trace_id, updated_at)
     VALUES ($1,$2,$3::jsonb,$4,now())
     ON CONFLICT (session_id, agent_id) DO UPDATE
     SET metadata = agent_sessions.metadata || EXCLUDED.metadata,
         last_trace_id = EXCLUDED.last_trace_id,
         updated_at = now()`,
        [
            resolvedSessionId,
            agent_id,
            JSON.stringify(sanitizeForLogs({ route, transport })),
            trace_id,
        ]
    );
    const turnNoResult = await pool.query(
        `SELECT COALESCE(MAX(turn_no), 0) + 1 AS turn_no
     FROM agent_turns
     WHERE session_id = $1 AND agent_id = $2`,
        [resolvedSessionId, agent_id]
    );
    const turn_no = Number(turnNoResult.rows?.[0]?.turn_no || 1);
    await pool.query(
        `INSERT INTO agent_turns (session_id, agent_id, turn_no, role, trace_id, span_id, status, input)
     VALUES ($1,$2,$3,'user',$4,$5,$6,$7)`,
        [resolvedSessionId, agent_id, turn_no, trace_id, span_id, 200, String(input || '')]
    );
    return { session_id: resolvedSessionId, turn_no };
}

async function finalizeAssistantTurnPersistence({
    agent_id,
    session_id,
    turn_no,
    trace_id,
    span_id,
    status,
    latency_ms,
    model,
    output,
    error,
    usage,
    decision_snapshot,
}) {
    await pool.query(
        `UPDATE agent_sessions
     SET updated_at = now(),
         last_trace_id = $3
     WHERE session_id = $1 AND agent_id = $2`,
        [session_id, agent_id, trace_id]
    );
    await pool.query(
        `INSERT INTO agent_turns (session_id, agent_id, turn_no, role, trace_id, span_id, status, latency_ms, model, output, error, usage, decision_snapshot)
     VALUES ($1,$2,$3,'assistant',$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb)`,
        [
            session_id,
            agent_id,
            turn_no,
            trace_id,
            span_id,
            Number(status) || 500,
            Number.isFinite(Number(latency_ms)) ? Math.max(0, Math.trunc(Number(latency_ms))) : null,
            model ? String(model) : null,
            output ? String(output) : null,
            error ? String(error) : null,
            JSON.stringify(usage && typeof usage === 'object' ? usage : {}),
            decision_snapshot && typeof decision_snapshot === 'object'
                ? JSON.stringify(sanitizeForLogs(decision_snapshot))
                : null,
        ]
    );
}
async function loadAgentPromptState(agentId) {
    const agentRow = await pool.query(
        `SELECT id, name, voice_id, system_prompt, tools, model_uuid, endpoint_key
     FROM agents
     WHERE id = $1`,
        [agentId]
    );
    if (agentRow.rowCount === 0) return null;
    const agent = agentRow.rows[0];

    const controlRow = await pool.query(
        `SELECT controls, style_overlay
     FROM agent_runtime_controls
     WHERE agent_id = $1`,
        [agentId]
    );
    const controls = controlRow.rowCount > 0 ? (controlRow.rows[0].controls || {}) : {};
    const styleOverlay = controlRow.rowCount > 0 ? (controlRow.rows[0].style_overlay || {}) : {};

    const activeInjections = await pool.query(
        `SELECT id, payload, mode, one_shot
     FROM agent_injections
     WHERE agent_id = $1
       AND active = true
       AND (expires_at IS NULL OR expires_at > now())
     ORDER BY priority ASC, created_at DESC
     LIMIT 20`,
        [agentId]
    );

    const prepend = activeInjections.rows
        .filter((i) => String(i.mode || 'prepend') === 'prepend')
        .map((i) => String(i.payload || '').trim())
        .filter(Boolean)
        .join('\n');
    const append = activeInjections.rows
        .filter((i) => String(i.mode || '') === 'append')
        .map((i) => String(i.payload || '').trim())
        .filter(Boolean)
        .join('\n');

    const styleHint = Object.keys(styleOverlay || {}).length > 0
        ? `\nSTYLE_OVERLAY_JSON:\n${JSON.stringify(styleOverlay)}`
        : '';
    const controlHint = Object.keys(controls || {}).length > 0
        ? `\nRUNTIME_CONTROLS_JSON:\n${JSON.stringify(controls)}`
        : '';

    let model = null;
    if (agent.model_uuid) {
        const modelRow = await pool.query(
            `SELECT m.id, m.label, m.model_id, m.config, m.enabled, p.id AS provider_id, p.name AS provider_name,
              p.slug AS provider_slug, p.kind AS provider_kind, p.base_url, p.api_key_env, p.enabled AS provider_enabled
       FROM llm_registry m
       JOIN llm_registry p ON p.id = m.provider_id
       WHERE m.id = $1
         AND m.record_type = 'model'
         AND p.record_type = 'provider'
       LIMIT 1`,
            [agent.model_uuid]
        );
        if (modelRow.rowCount > 0) {
            const settings = await getEngineSettings().catch(() => ({ config: {} }));
            model = buildModelPublicView(modelRow.rows[0], settings.config || {});
        }
    }

    return {
        agent,
        model,
        controls,
        styleOverlay,
        activeInjections: activeInjections.rows,
        prepend,
        append,
        styleHint,
        controlHint,
    };
}
async function loadLlmRegistryModelView(modelUuid) {
    const id = String(modelUuid || '').trim();
    if (!id || !UUID_REGEX.test(id)) return null;
    const modelRow = await pool.query(
        `SELECT m.id, m.label, m.model_id, m.config, m.enabled, p.id AS provider_id, p.name AS provider_name,
              p.slug AS provider_slug, p.kind AS provider_kind, p.base_url, p.api_key_env, p.enabled AS provider_enabled
       FROM llm_registry m
       JOIN llm_registry p ON p.id = m.provider_id
       WHERE m.id = $1::uuid
         AND m.record_type = 'model'
         AND p.record_type = 'provider'
       LIMIT 1`,
        [id]
    );
    if (modelRow.rowCount === 0) return null;
    const settings = await getEngineSettings().catch(() => ({ config: {} }));
    return buildModelPublicView(modelRow.rows[0], settings.config || {});
}
async function resolveAgentCompletionModelView(baseModel, completionModelUuid) {
    const uuid = String(completionModelUuid || '').trim();
    if (!uuid) return { model: baseModel, error: null };
    if (!UUID_REGEX.test(uuid)) return { model: baseModel, error: 'invalid_completion_model_uuid' };
    const override = await loadLlmRegistryModelView(uuid);
    if (!override) return { model: baseModel, error: 'completion_model_uuid_not_found' };
    if (override.enabled === false || override.provider_enabled === false) {
        return { model: baseModel, error: 'completion_model_disabled' };
    }
    return { model: override, error: null };
}
async function resolveAgentIdByEndpointKey(endpointKey) {
    const key = String(endpointKey || '').trim();
    if (!key || !UUID_REGEX.test(key)) return '';
    const endpointRow = await pool.query(
        `SELECT id FROM agents WHERE endpoint_key = $1::uuid LIMIT 1`,
        [key]
    ).catch(() => ({ rowCount: 0, rows: [] }));
    if (endpointRow.rowCount === 0) return '';
    return String(endpointRow.rows[0]?.id || '').trim();
}

function extractStreamDeltaText(parsed) {
    const chatDelta = parsed?.choices?.[0]?.delta?.content;
    if (typeof chatDelta === 'string' && chatDelta) return chatDelta;
    if (Array.isArray(chatDelta)) {
        const joined = chatDelta
            .map((part) => {
                if (typeof part === 'string') return part;
                if (part && typeof part.text === 'string') return part.text;
                return '';
            })
            .join('');
        if (joined) return joined;
    }
    if (typeof parsed?.choices?.[0]?.message?.content === 'string') {
        return String(parsed.choices[0].message.content);
    }
    const eventType = String(parsed?.type || '').toLowerCase();
    if (typeof parsed?.delta === 'string' && eventType.includes('output_text')) {
        return parsed.delta;
    }
    if (typeof parsed?.text === 'string' && eventType.includes('output_text')) {
        return parsed.text;
    }
    if (typeof parsed?.item?.text === 'string' && eventType.includes('output_text')) {
        return parsed.item.text;
    }
    if (typeof parsed?.item?.delta === 'string' && eventType.includes('output_text')) {
        return parsed.item.delta;
    }
    return '';
}
function extractStreamThinkingEntries(parsed) {
    const entries = [];
    const eventType = String(parsed?.type || '').toLowerCase();
    if (eventType.includes('reasoning')) {
        if (typeof parsed?.delta === 'string' && parsed.delta.trim()) entries.push(parsed.delta.trim());
        if (typeof parsed?.summary === 'string' && parsed.summary.trim()) entries.push(parsed.summary.trim());
        if (typeof parsed?.text === 'string' && parsed.text.trim()) entries.push(parsed.text.trim());
    }
    const chatReasoning = parsed?.choices?.[0]?.delta?.reasoning ?? parsed?.choices?.[0]?.message?.reasoning;
    if (typeof chatReasoning === 'string' && chatReasoning.trim()) entries.push(chatReasoning.trim());
    if (Array.isArray(chatReasoning)) {
        for (const item of chatReasoning) {
            if (typeof item === 'string' && item.trim()) entries.push(item.trim());
            if (item && typeof item === 'object') {
                const snippet = firstNonEmptyString(item.text, item.summary, item.content);
                if (snippet) entries.push(snippet);
            }
        }
    }
    return entries.filter(Boolean);
}
function extractStreamToolEvents(parsed) {
    const events = [];
    const pushEvent = (raw, source = null) => {
        if (!raw || typeof raw !== 'object') return;
        const functionObj = raw.function && typeof raw.function === 'object' ? raw.function : null;
        const name = firstNonEmptyString(raw.name, functionObj?.name, raw.tool_name, raw.function_name);
        const argsRaw = firstNonEmptyString(raw.arguments, functionObj?.arguments, raw.delta, raw.text);
        events.push({
            id: firstNonEmptyString(raw.id, raw.call_id, raw.tool_call_id),
            type: firstNonEmptyString(raw.type, raw.event, source, 'tool_call'),
            name: name || 'unknown_tool',
            arguments: argsRaw || '',
            status: firstNonEmptyString(raw.status, raw.state) || null,
            source_event: source,
        });
    };
    const chatToolCalls = parsed?.choices?.[0]?.delta?.tool_calls;
    if (Array.isArray(chatToolCalls)) {
        for (const call of chatToolCalls) pushEvent(call, 'chat_delta_tool_call');
    }
    const eventType = String(parsed?.type || '').toLowerCase();
    if (eventType.includes('tool_call') || eventType.includes('function_call')) {
        pushEvent(parsed?.item && typeof parsed.item === 'object' ? parsed.item : parsed, eventType || 'responses_tool_call');
    }
    if (parsed?.item && typeof parsed.item === 'object') {
        const itemType = String(parsed.item.type || '').toLowerCase();
        if (itemType.includes('tool_call') || itemType.includes('function_call')) {
            pushEvent(parsed.item, itemType || eventType || 'responses_tool_call');
        }
    }
    return events.filter((event) => event.name);
}
function createVllmStreamParser(onDelta, onDone, onEvent = null) {
    let buffer = '';
    return (chunk) => {
        buffer += chunk;
        let idx = buffer.indexOf('\n');
        while (idx >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (line.startsWith('data:')) {
                const data = line.slice(5).trim();
                if (data === '[DONE]') {
                    onDone();
                }
                else if (data) {
                    try {
                        const parsed = JSON.parse(data);
                        if (typeof onEvent === 'function') onEvent(parsed);
                        const delta = extractStreamDeltaText(parsed);
                        if (delta) onDelta(String(delta));
                    }
                    catch (_) {
                        // Ignore malformed stream fragments.
                    }
                }
            }
            idx = buffer.indexOf('\n');
        }
    };
}
function splitTextForStreaming(text = '', targetChars = 28) {
    const clean = String(text || '');
    if (!clean.trim()) return [];
    const words = clean.match(/\S+\s*/g) || [clean];
    const chunks = [];
    let current = '';
    for (const word of words) {
        if (current && (current.length + word.length) > targetChars) {
            chunks.push(current);
            current = word;
            continue;
        }
        current += word;
    }
    if (current) chunks.push(current);
    return chunks.length > 0 ? chunks : [clean];
}
function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function sanitizeForLogs(value, maxChars = 12000) {
    if (value === null || value === undefined) return value;
    const secretKey = /(pass|password|authorization|api[_-]?key|secret|legacytoken)/i;
    const walk = (v) => {
        if (v === null || v === undefined) return v;
        if (Array.isArray(v)) return v.map(walk);
        if (typeof v === 'object') {
            const out = {};
            for (const [k, inner] of Object.entries(v)) {
                out[k] = secretKey.test(k) ? '[REDACTED]' : walk(inner);
            }
            return out;
        }
        if (typeof v === 'string') return v.length > 4000 ? `${v.slice(0, 4000)}...` : v;
        return v;
    };
    const cleaned = walk(value);
    try {
        const str = JSON.stringify(cleaned);
        if (!str || str.length <= maxChars) return cleaned;
        return { _truncated: true, preview: `${str.slice(0, maxChars)}...` };
    }
    catch {
        const raw = String(cleaned);
        return raw.length <= maxChars ? raw : `${raw.slice(0, maxChars)}...`;
    }
}
function stripUnsupportedJsonUnicode(value) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
        let out = '';
        for (let i = 0; i < value.length; i++) {
            const code = value.charCodeAt(i);
            if (code === 0) continue;
            if (code >= 0xd800 && code <= 0xdbff) {
                const next = value.charCodeAt(i + 1);
                if (next >= 0xdc00 && next <= 0xdfff) {
                    out += value[i] + value[i + 1];
                    i += 1;
                }
                continue;
            }
            if (code >= 0xdc00 && code <= 0xdfff) continue;
            out += value[i];
        }
        return out;
    }
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map((item) => stripUnsupportedJsonUnicode(item));
    if (typeof value === 'object') {
        const out = {};
        for (const [key, inner] of Object.entries(value)) {
            out[key] = stripUnsupportedJsonUnicode(inner);
        }
        return out;
    }
    return value;
}
function parsePositiveInt(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
const DEFAULT_ENGINE_SETTINGS = {
    enabled: false,
    schedule_hours: 6,
    max_sources_per_cycle: 12,
    max_knowledge_injections_per_cycle: 8,
    llm_provider_secrets: {},
    llm_token_policy: {
        default_max_context_tokens: 32000,
        default_max_request_tokens: 27000,
        default_max_output_tokens: 1024,
        safety_margin_tokens: 512,
    },
    dashboard_llm: {
        default_model_uuid: '',
        system_prompt: 'You are a concise Ghost dashboard AI assistant. Prefer factual summaries grounded in live logs and stored data. You are configuration-aware: guide operators through LlamaIndex orchestrator settings (URL, auth key, retrieval mode, context/chat TTLs, checkpointing, model bindings), MCP server registry changes (add/test/enable/disable/remove servers and tool discovery), and Phoenix observability settings (URL, OTel endpoint, sampling, retention, trace drilldown). Always prioritize safe, reversible changes, call out dependencies (edge -> control-plane -> llamaindex -> mcp/vllm), and include verification steps with trace_id-oriented validation.',
        enabled_tool_ids: [],
        last_test_status: 'untested',
        last_test_trace_id: null,
        last_test_latency_ms: null,
        last_test_message: '',
    },
    knowledge_storage: {
        s3_bucket: '',
        s3_region: '',
        s3_prefix: 'ghostdash-ingestion',
        s3_api_key: '',
        s3_api_token: '',
        cohere_rerank_api_key: '',
        rerank_model: 'rerank-v3.5',
        rerank_enabled: true,
        llamaindex_url: '',
        llamaindex_internal_key: '',
        shopify_mcp_url: '',
        shopify_mcp_internal_key: '',
    },
    knowledge_runtime: {
        queue_paused: false,
        orchestrator_enabled: false,
    },
    core_interaction_layer: {
        intent_router_enabled: true,
        delivery_sub_agent_enabled: true,
    },
    sub_agent_matrix: {
        synthesizer: {
            execution_weight: 0.9,
            history_aggressiveness: 'high',
            scrub_radius: 2,
            criticism_threshold: 0.3,
        },
        fetch: {
            execution_weight: 0.8,
            history_aggressiveness: 'medium',
            scrub_radius: 3,
            criticism_threshold: 0.2,
        },
        evaluation: {
            execution_weight: 1.0,
            history_aggressiveness: 'high',
            scrub_radius: 2,
            criticism_threshold: 0.6,
        },
        injector: {
            execution_weight: 0.95,
            history_aggressiveness: 'low',
            scrub_radius: 1,
            criticism_threshold: 0.4,
        },
    },
    llamaindex: {
        orchestrator_url: '',
        internal_key: '',
        default_llm_model: '',
        default_embed_model: '',
        qdrant_collection: '',
        context_ttl_seconds: 3600,
        chat_memory_ttl_seconds: 86400,
        checkpointing_enabled: true,
        max_context_tokens: 32000,
        retrieval_mode: 'hybrid',
    },
    mcp_servers: [],
    phoenix: {
        url: '',
        otel_endpoint: '',
        sampling_rate: 100,
        retention_days: 30,
    },
};
const ENGINE_SETTINGS_SECRET_PATHS = [
    ['knowledge_storage', 's3_api_key'],
    ['knowledge_storage', 's3_api_token'],
    ['knowledge_storage', 'cohere_rerank_api_key'],
    ['knowledge_storage', 'llamaindex_internal_key'],
    ['knowledge_storage', 'shopify_mcp_internal_key'],
    ['llamaindex', 'internal_key'],
];
function isObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}
function deepMerge(base, patch) {
    if (!isObject(base) || !isObject(patch)) return patch;
    const out = { ...base };
    for (const [k, v] of Object.entries(patch)) {
        if (isObject(v) && isObject(out[k])) out[k] = deepMerge(out[k], v);
        else out[k] = v;
    }
    return out;
}
function deepCloneJson(value) {
    try {
        return JSON.parse(JSON.stringify(value ?? {}));
    }
    catch {
        return {};
    }
}
function resolveLlmTokenPolicyDefaults(config) {
    const stored = config?.llm_token_policy && typeof config.llm_token_policy === 'object'
        ? config.llm_token_policy
        : {};
    const storedContextTokens = Math.max(2048, parsePositiveInt(stored.default_max_context_tokens, LEGACY_CONTEXT_TOKENS));
    const storedRequestTokens = Math.max(512, parsePositiveInt(stored.default_max_request_tokens, LEGACY_REQUEST_TOKENS));
    const looksLegacyDefault = storedContextTokens <= LEGACY_CONTEXT_THRESHOLD && storedRequestTokens <= LEGACY_REQUEST_THRESHOLD;
    const maxContextTokens = looksLegacyDefault
        ? Math.max(storedContextTokens, UPGRADED_CONTEXT_TOKENS)
        : storedContextTokens;
    const maxRequestTokens = Math.min(
        maxContextTokens,
        looksLegacyDefault
            ? Math.max(storedRequestTokens, UPGRADED_REQUEST_TOKENS)
            : storedRequestTokens
    );
    const maxOutputTokens = Math.max(64, parsePositiveInt(stored.default_max_output_tokens, 1024));
    return {
        default_max_context_tokens: maxContextTokens,
        default_max_request_tokens: maxRequestTokens,
        default_max_output_tokens: Math.min(maxOutputTokens, Math.max(64, maxRequestTokens - 1)),
        safety_margin_tokens: Math.max(128, parsePositiveInt(stored.safety_margin_tokens, 512)),
    };
}
function normalizeModelTokenPolicy(rawPolicy, defaults) {
    const stored = rawPolicy && typeof rawPolicy === 'object' ? rawPolicy : {};
    const storedContextTokens = Math.max(2048, parsePositiveInt(stored.max_context_tokens, defaults.default_max_context_tokens));
    const storedRequestTokens = Math.max(512, parsePositiveInt(stored.max_request_tokens, defaults.default_max_request_tokens));
    const looksLegacyModelPolicy = storedContextTokens <= LEGACY_CONTEXT_THRESHOLD && storedRequestTokens <= LEGACY_REQUEST_THRESHOLD;
    const maxContextTokens = looksLegacyModelPolicy
        ? Math.max(storedContextTokens, UPGRADED_CONTEXT_TOKENS)
        : storedContextTokens;
    const maxRequestTokens = Math.min(
        maxContextTokens,
        looksLegacyModelPolicy
            ? Math.max(storedRequestTokens, UPGRADED_REQUEST_TOKENS)
            : storedRequestTokens
    );
    const maxOutputTokens = Math.max(64, parsePositiveInt(stored.max_output_tokens, defaults.default_max_output_tokens));
    return {
        max_context_tokens: maxContextTokens,
        max_request_tokens: maxRequestTokens,
        max_output_tokens: Math.min(maxOutputTokens, Math.max(64, maxRequestTokens - 1)),
        safety_margin_tokens: defaults.safety_margin_tokens,
    };
}
function normalizeModelConfig(rawConfig, engineConfig = {}) {
    const clean = rawConfig && typeof rawConfig === 'object' ? deepCloneJson(rawConfig) : {};
    clean.token_policy = normalizeModelTokenPolicy(clean.token_policy, resolveLlmTokenPolicyDefaults(engineConfig || {}));
    return clean;
}
function buildModelPublicView(row, engineConfig = {}) {
    const config = normalizeModelConfig(row?.config, engineConfig);
    const providerKind = String(row?.provider_kind || row?.kind || 'openai_compatible').trim() || 'openai_compatible';
    const rawBaseUrl = String(row?.base_url || '').trim();
    const normalizedBaseUrl = rawBaseUrl
        ? normalizeDashboardProviderBaseUrl(providerKind, rawBaseUrl)
        : '';
    return {
        id: row?.id || null,
        provider_id: row?.provider_id || null,
        label: row?.label || null,
        model_id: row?.model_id || null,
        enabled: row?.enabled !== false,
        created_at: row?.created_at || null,
        updated_at: row?.updated_at || null,
        provider_enabled: row?.provider_enabled !== false,
        provider_slug: row?.provider_slug || null,
        provider_name: row?.provider_name || null,
        provider_kind: row?.provider_kind || row?.kind || null,
        api_key_env: row?.api_key_env || null,
        base_url: normalizedBaseUrl || null,
        config,
        token_policy: config.token_policy,
    };
}
function truncateTextToTokenBudget(text, tokenBudget, marker = 'trimmed by token policy') {
    const input = String(text || '');
    const charBudget = Math.max(48, Number(tokenBudget || 0) * 4);
    if (input.length <= charBudget) return input;
    const markerText = `\n\n[... ${marker} ...]\n\n`;
    const headChars = Math.max(24, Math.floor(charBudget * 0.72));
    const tailChars = Math.max(0, charBudget - headChars - markerText.length);
    return `${input.slice(0, headChars)}${markerText}${tailChars > 0 ? input.slice(-tailChars) : ''}`.trim();
}
function fitChatMessagesToBudget(messages, inputBudget) {
    const normalized = Array.isArray(messages)
        ? messages.map((message) => ({
            ...message,
            role: String(message?.role || 'user'),
            content: typeof message?.content === 'string'
                ? message.content
                : JSON.stringify(message?.content ?? ''),
        }))
        : [];
    const originalInputTokens = normalized.reduce((sum, message) => sum + estimateTokenCount(message.content), 0);
    if (originalInputTokens <= inputBudget) {
        return {
            messages: normalized,
            original_input_tokens: originalInputTokens,
            estimated_input_tokens: originalInputTokens,
            trimmed: false,
            truncated_messages: 0,
            dropped_messages: 0,
        };
    }
    const work = normalized.map((message) => ({ ...message }));
    let droppedMessages = 0;
    while (work.length > 2) {
        const estimate = work.reduce((sum, message) => sum + estimateTokenCount(message.content), 0);
        if (estimate <= inputBudget) break;
        work.splice(1, 1);
        droppedMessages += 1;
    }
    let truncatedMessages = 0;
    for (let guard = 0; guard < 12; guard += 1) {
        const estimate = work.reduce((sum, message) => sum + estimateTokenCount(message.content), 0);
        if (estimate <= inputBudget) break;
        let targetIndex = 0;
        let targetTokens = 0;
        work.forEach((message, index) => {
            const tokens = estimateTokenCount(message.content);
            if (tokens >= targetTokens) {
                targetIndex = index;
                targetTokens = tokens;
            }
        });
        const overflow = Math.max(1, estimate - inputBudget + 16);
        const minimumBudget = targetIndex === 0 ? 96 : 160;
        const nextBudget = Math.max(minimumBudget, targetTokens - overflow);
        if (nextBudget >= targetTokens) break;
        work[targetIndex] = {
            ...work[targetIndex],
            content: truncateTextToTokenBudget(
                work[targetIndex].content,
                nextBudget,
                work[targetIndex].role === 'system' ? 'system prompt trimmed' : 'context trimmed'
            ),
        };
        truncatedMessages += 1;
    }
    const estimatedInputTokens = work.reduce((sum, message) => sum + estimateTokenCount(message.content), 0);
    return {
        messages: work,
        original_input_tokens: originalInputTokens,
        estimated_input_tokens: estimatedInputTokens,
        trimmed: estimatedInputTokens < originalInputTokens || droppedMessages > 0,
        truncated_messages: truncatedMessages,
        dropped_messages: droppedMessages,
    };
}
function prepareLlmChatRequest({ llm, body, route = '' }) {
    const providerKind = String(llm?.provider_kind || '').trim().toLowerCase();
    const providerSlug = String(llm?.provider_slug || '').trim().toLowerCase();
    const modelId = String(llm?.model_id || '').trim().toLowerCase();
    const isGemini = providerKind === 'google_gemini' || 
                     providerSlug === 'google-gemini' || 
                     modelId.includes('gemini') ||
                     String(llm?.chat_url || '').includes('generativelanguage.googleapis.com');

    const tokenPolicy = llm?.token_policy && typeof llm.token_policy === 'object'
        ? llm.token_policy
        : normalizeModelTokenPolicy({}, resolveLlmTokenPolicyDefaults({}));
    const maxRequestTokens = Math.min(
        Number(tokenPolicy.max_request_tokens || 27000),
        Number(tokenPolicy.max_context_tokens || 32000)
    );
    const requestedOutputTokens = Math.max(16, parsePositiveInt(body?.max_tokens, Number(tokenPolicy.max_output_tokens || 1024)));
    const maxOutputTokens = Math.max(16, Math.min(requestedOutputTokens, Math.max(64, maxRequestTokens - 1)));
    const inputBudget = Math.max(256, maxRequestTokens - maxOutputTokens - Number(tokenPolicy.safety_margin_tokens || 512));
    const fitted = fitChatMessagesToBudget(body?.messages || [], inputBudget);

    if (fitted.trimmed || fitted.original_input_tokens > 20000) {
        jsonLog({
            level: 'info',
            service: 'control-plane-api',
            msg: 'large_request_token_breakdown',
            metadata: {
                route,
                original_tokens: fitted.original_input_tokens,
                budget: inputBudget,
                trimmed: fitted.trimmed,
                model: llm?.model_id,
                provider: providerKind
            }
        });
    }

    const tokenPolicyState = {
        route,
        max_context_tokens: tokenPolicy.max_context_tokens,
        max_request_tokens: maxRequestTokens,
        max_output_tokens: maxOutputTokens,
        safety_margin_tokens: tokenPolicy.safety_margin_tokens,
        input_budget_tokens: inputBudget,
        original_input_tokens: fitted.original_input_tokens,
        estimated_input_tokens: fitted.estimated_input_tokens,
        trimmed: fitted.trimmed,
        truncated_messages: fitted.truncated_messages,
        dropped_messages: fitted.dropped_messages,
    };
    if (fitted.estimated_input_tokens > inputBudget) {
        return {
            ok: false,
            status: 400,
            error: 'context_too_large_for_model',
            message: `This request would exceed the configured ${maxRequestTokens.toLocaleString()}-token limit for ${llm?.model_id || 'this model'}. Adjust Models -> Token policy or narrow the query.`,
            token_policy: tokenPolicyState,
        };
    }

    const cleanedBody = isGemini ? {
        model: body.model,
        messages: fitted.messages,
        max_tokens: maxOutputTokens,
        temperature: body.temperature,
        top_p: body.top_p,
        stop: body.stop,
        stream: body.stream,
        // specifically omit penalties
    } : {
        ...body,
        max_tokens: maxOutputTokens,
        messages: fitted.messages,
    };
    
    // Additional cleaning for isGemini to be absolutely sure
    if (isGemini) {
        delete (cleanedBody).presence_penalty;
        delete (cleanedBody).frequency_penalty;
        
        jsonLog({
            level: 'debug',
            service: 'control-plane-api',
            msg: 'gemini_body_cleaned',
            metadata: { 
                route, 
                modelId,
                keys: Object.keys(cleanedBody),
                has_freq: 'frequency_penalty' in cleanedBody,
                has_pres: 'presence_penalty' in cleanedBody
            }
        });
    }

    return {
        ok: true,
        body: cleanedBody,
        isGemini,
        token_policy: tokenPolicyState,
        notice: fitted.trimmed
            ? `Token safeguard applied: request kept under ${maxRequestTokens.toLocaleString()} tokens. Some lower-priority context was trimmed.`
            : null,
    };
}
function toResponsesInput(messages = []) {
    return (Array.isArray(messages) ? messages : []).map((message) => ({
        role: ['assistant', 'system'].includes(String(message?.role || '').toLowerCase())
            ? String(message.role).toLowerCase()
            : 'user',
        content: [{ type: 'input_text', text: String(message?.content || '') }],
    }));
}
function extractLlmTextFromUpstreamBody(upstreamBody) {
    const chatText = firstNonEmptyString(
        upstreamBody?.choices?.[0]?.message?.content,
        upstreamBody?.choices?.[0]?.text
    );
    if (chatText) return chatText;
    const outputText = firstNonEmptyString(upstreamBody?.output_text);
    if (outputText) return outputText;
    const output = Array.isArray(upstreamBody?.output) ? upstreamBody.output : [];
    for (const item of output) {
        const content = Array.isArray(item?.content) ? item.content : [];
        for (const part of content) {
            const text = firstNonEmptyString(part?.text, part?.output_text, part?.content);
            if (text) return text;
        }
    }
    return null;
}
function extractLlmReasoningFromUpstreamBody(upstreamBody) {
    const reasoning = firstNonEmptyString(
        upstreamBody?.choices?.[0]?.message?.reasoning_content,
        upstreamBody?.choices?.[0]?.message?.reasoning
    );
    if (reasoning) return reasoning;
    const output = Array.isArray(upstreamBody?.output) ? upstreamBody.output : [];
    for (const item of output) {
        const content = Array.isArray(item?.content) ? item.content : [];
        for (const part of content) {
            const text = firstNonEmptyString(part?.reasoning_content, part?.reasoning);
            if (text) return text;
        }
    }
    return null;
}
function extractUpstreamErrorText(upstreamBody) {
    return firstNonEmptyString(
        upstreamBody?.error?.message,
        typeof upstreamBody?.error === 'string' ? upstreamBody.error : '',
        upstreamBody?.message,
        upstreamBody?.detail,
        upstreamBody?._raw
    ) || '';
}
function deriveLlmCompatibilityRetryPayload(payload = {}, upstreamErrorText = '') {
    const next = payload && typeof payload === 'object' ? { ...payload } : {};
    const text = String(upstreamErrorText || '');
    let changed = false;
    const reasons = [];

    if (/top_p\s+must\s+be\s+in\s*\(0,\s*1\]/i.test(text)) {
        next.top_p = 1;
        changed = true;
        reasons.push('normalized_top_p');
    }

    const contextMatch = text.match(/maximum context length is\s+(\d+)\s+tokens\.\s+However,\s+you requested\s+\d+\s+tokens\s+\((\d+)\s+in the messages,\s+(\d+)\s+in the completion\)/i);
    if (contextMatch) {
        const modelLimit = Number(contextMatch[1]);
        const promptTokens = Number(contextMatch[2]);
        const requestedCompletion = Number(contextMatch[3]);
        if (Number.isFinite(modelLimit) && Number.isFinite(promptTokens) && Number.isFinite(requestedCompletion)) {
            const budget = Math.max(64, modelLimit - promptTokens - 128);
            if (Object.prototype.hasOwnProperty.call(next, 'max_tokens')) {
                const current = Number(next.max_tokens);
                if (!Number.isFinite(current) || current > budget) {
                    next.max_tokens = budget;
                    changed = true;
                    reasons.push('reduced_max_tokens_to_model_budget');
                }
            }
            if (Object.prototype.hasOwnProperty.call(next, 'max_output_tokens')) {
                const current = Number(next.max_output_tokens);
                if (!Number.isFinite(current) || current > budget) {
                    next.max_output_tokens = budget;
                    changed = true;
                    reasons.push('reduced_max_output_tokens_to_model_budget');
                }
            }
        }
    }

    return changed ? { payload: next, reasons } : null;
}
async function callConfiguredLlm({ llm, trace_id = '', route = '', body }) {
    const prepared = prepareLlmChatRequest({
        llm: {
            model_uuid: llm?.model_uuid,
            model_id: llm?.model_id,
            chat_url: llm?.chat_url,
            api_key: llm?.api_key,
            token_policy: llm?.token_policy,
            provider_kind: llm?.provider_kind,
            provider_slug: llm?.provider_slug,
        },
        body,
        route,
    });
    if (!prepared.ok) {
        return {
            ok: false,
            status: prepared.status,
            error: prepared.error,
            message: prepared.message,
            token_policy: prepared.token_policy,
            token_policy_notice: null,
            upstream: null,
            upstream_body: null,
            prepared_body: null,
        };
    }
    let upstream;
    let upstreamBody = {};
    const controller = new AbortController();
    const timeoutMs = 120000;
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const mode = resolveLlmApiMode({
            apiModeRaw: llm?.api_mode,
            baseUrl: llm?.base_url,
            modelId: llm?.model_id,
        });
        const targetUrl = mode === 'responses'
            ? firstNonEmptyString(llm?.responses_url, resolveOpenAiResponsesUrl(llm?.base_url))
            : llm.chat_url;
        const payload = mode === 'responses'
            ? (() => {
                const responsePayload = {
                model: llm.model_id,
                input: toResponsesInput(prepared.body.messages),
                max_output_tokens: prepared.body.max_tokens,
                };
                const configuredReasoningEffort = String(llm?.config?.reasoning_effort || '').trim().toLowerCase();
                if (['minimal', 'low', 'medium', 'high'].includes(configuredReasoningEffort)) {
                    responsePayload.reasoning = { effort: configuredReasoningEffort };
                }
                const configuredVerbosity = String(llm?.config?.verbosity || '').trim().toLowerCase();
                if (['low', 'medium', 'high'].includes(configuredVerbosity)) {
                    responsePayload.text = { verbosity: configuredVerbosity };
                }
                if (Number.isFinite(Number(prepared.body.temperature))) responsePayload.temperature = Number(prepared.body.temperature);
                if (Number.isFinite(Number(prepared.body.top_p))) responsePayload.top_p = Number(prepared.body.top_p);
                if (Array.isArray(prepared.body.stop) && prepared.body.stop.length > 0) responsePayload.stop = prepared.body.stop;
                return responsePayload;
            })()
            : prepared.body;

        if (prepared.isGemini || String(llm?.provider_kind).includes('gemini')) {
            jsonLog({
                level: 'debug',
                service: 'control-plane-api',
                msg: 'google_gemini_outbound_preflight',
                metadata: { 
                    trace_id, 
                    targetUrl, 
                    keys: Object.keys(payload),
                    has_freq: 'frequency_penalty' in payload,
                    has_pres: 'presence_penalty' in payload
                }
            });
        }

        const requestHeaders = {
            'Content-Type': 'application/json',
            ...buildApiKeyHeaders(llm.api_key, llm.auth_header_name || 'Authorization'),
            ...(trace_id ? { 'x-trace-id': trace_id } : {}),
        };
        const postUpstream = async (requestPayload) => {
            const response = await fetch(targetUrl, {
                method: 'POST',
                headers: requestHeaders,
                body: JSON.stringify(requestPayload),
                signal: controller.signal,
            });
            const parsed = await response.json().catch(() => ({}));
            return { response, parsed };
        };

        const firstAttempt = await postUpstream(payload);
        upstream = firstAttempt.response;
        upstreamBody = firstAttempt.parsed;

        if (!upstream.ok) {
            const upstreamErrorText = extractUpstreamErrorText(upstreamBody);
            const retry = deriveLlmCompatibilityRetryPayload(payload, upstreamErrorText);
            if (retry) {
                jsonLog({
                    level: 'info',
                    service: 'control-plane-api',
                    msg: 'llm_compat_retry_applied',
                    metadata: {
                        trace_id,
                        route,
                        model_id: llm?.model_id || null,
                        target_url: targetUrl,
                        reasons: retry.reasons,
                    },
                });
                const secondAttempt = await postUpstream(retry.payload);
                upstream = secondAttempt.response;
                upstreamBody = secondAttempt.parsed;
            }
        }
    }
    catch (error) {
        const timedOut = String(error?.name || '').toLowerCase().includes('abort');
        return {
            ok: false,
            status: timedOut ? 504 : 502,
            error: timedOut ? 'llm_request_timed_out' : 'llm_upstream_failed',
            message: timedOut
                ? `The model did not respond within ${Math.round(timeoutMs / 1000)} seconds while staying inside the configured token budget. Try a narrower query or choose a faster model in Models -> Token policy.`
                : String(error?.message || error),
            token_policy: prepared.token_policy,
            token_policy_notice: prepared.notice,
            upstream: null,
            upstream_body: null,
            prepared_body: prepared.body,
        };
    }
    finally {
        clearTimeout(timeoutHandle);
    }
    return {
        ok: upstream.ok,
        status: upstream.status,
        error: upstream.ok ? null : 'llm_upstream_failed',
        message: upstream.ok
            ? null
            : firstNonEmptyString(upstreamBody?.error?.message, upstreamBody?.error, upstreamBody?.message) || `upstream_${upstream.status}`,
        token_policy: prepared.token_policy,
        token_policy_notice: prepared.notice,
        upstream,
        upstream_body: upstreamBody,
        prepared_body: prepared.body,
    };
}
function toLlmToolFunctionName(toolId = '') {
    return `tool_exec_${String(toolId || '').toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
}
function buildLlmToolDefinitions(toolRows = []) {
    const defs = [];
    const nameToToolId = {};
    for (const row of (Array.isArray(toolRows) ? toolRows : [])) {
        const id = String(row?.id || '').trim();
        const kind = String(row?.kind || '').trim();
        const name = String(row?.name || kind || id || 'tool').trim();
        if (!id || !kind) continue;
        const functionName = toLlmToolFunctionName(id);
        nameToToolId[functionName] = id;
        defs.push({
            type: 'function',
            function: {
                name: functionName,
                description: `Execute ${name} (${kind}) using operation and payload.`,
                parameters: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        operation: { type: 'string', description: 'Operation name to execute on the tool module.' },
                        payload: { type: 'object', description: 'JSON payload for the selected operation.' },
                    },
                    required: ['operation'],
                },
            },
        });
    }
    return { defs, nameToToolId };
}
async function executeToolViaApi({ toolId, operation, payload, trace_id = '', agent_id = null }) {
    const spanId = crypto.randomUUID();
    const response = await fetch(`http://127.0.0.1:${PORT}/api/tools/${toolId}/execute`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(trace_id ? { 'x-trace-id': trace_id } : {}),
            'x-span-id': spanId,
        },
        body: JSON.stringify({
            operation: String(operation || '').trim(),
            payload: payload && typeof payload === 'object' ? payload : {},
            agent_id: agent_id || null,
        }),
    });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, body };
}
async function runOpenAiToolLoop({
    llm,
    trace_id = '',
    route = '',
    headers = {},
    systemMessage = '',
    userMessage = '',
    toolRows = [],
    generation = {},
    agent_id = null,
}) {
    const chatUrl = resolveOpenAiChatCompletionsUrl(llm?.base_url || '');
    if (!chatUrl) {
        return { ok: false, status: 503, error: 'model_provider_base_url_missing', message: 'Chat completions URL is not configured.' };
    }
    const { defs, nameToToolId } = buildLlmToolDefinitions(toolRows);
    if (!defs.length) {
        return { ok: false, status: 400, error: 'no_enabled_tools', message: 'No enabled tools are available for tool loop.' };
    }
    const messages = [
        { role: 'system', content: String(systemMessage || '').trim() },
        { role: 'user', content: String(userMessage || '').trim() },
    ];
    const maxTurns = 4;
    let lastUsage = null;
    let lastUpstream = null;
    const defaultModelId = String(llm?.model_id || '').trim();
    const isGpt5Family = defaultModelId.toLowerCase().startsWith('gpt-5');
    const fallbackToolLoopModel = isGpt5Family ? 'gpt-4o-mini' : '';
    for (let turn = 0; turn < maxTurns; turn += 1) {
        const requestBody = {
            model: defaultModelId,
            messages,
            tools: defs,
            tool_choice: 'auto',
        };
        if (Number.isFinite(Number(generation.temperature))) requestBody.temperature = Number(generation.temperature);
        if (Number.isFinite(Number(generation.max_tokens))) requestBody.max_tokens = Number(generation.max_tokens);
        if (Number.isFinite(Number(generation.top_p))) requestBody.top_p = Number(generation.top_p);
        if (Array.isArray(generation.stop) && generation.stop.length > 0) requestBody.stop = generation.stop;
        const prepared = prepareLlmChatRequest({ llm, body: requestBody, route: `${route}#tool_loop` });
        if (!prepared.ok) {
            return {
                ok: false,
                status: prepared.status || 400,
                error: prepared.error || 'tool_loop_prepare_failed',
                message: prepared.message || 'Unable to prepare tool loop request.',
                token_policy: prepared.token_policy || null,
            };
        }
        const outboundBody = prepared.body && typeof prepared.body === 'object'
            ? { ...prepared.body }
            : {};
        const outboundModelId = String(outboundBody.model || llm?.model_id || '').trim().toLowerCase();
        // GPT-5 chat-completions variants reject max_tokens; they require max_completion_tokens.
        if (outboundModelId.startsWith('gpt-5') && Object.prototype.hasOwnProperty.call(outboundBody, 'max_tokens')) {
            const tokenCap = Number(outboundBody.max_tokens);
            if (Number.isFinite(tokenCap) && tokenCap > 0) {
                outboundBody.max_completion_tokens = Math.max(1, Math.round(tokenCap));
            }
            delete outboundBody.max_tokens;
        }
        let upstream = await fetch(chatUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(outboundBody),
        });
        let upstreamBody = await upstream.json().catch(() => ({}));
        if (!upstream.ok && upstream.status >= 500 && fallbackToolLoopModel) {
            const retryBody = { ...outboundBody, model: fallbackToolLoopModel };
            if (Object.prototype.hasOwnProperty.call(retryBody, 'max_tokens')) {
                const retryCap = Number(retryBody.max_tokens);
                if (Number.isFinite(retryCap) && retryCap > 0) {
                    retryBody.max_completion_tokens = Math.max(1, Math.round(retryCap));
                }
                delete retryBody.max_tokens;
            }
            upstream = await fetch(chatUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify(retryBody),
            });
            upstreamBody = await upstream.json().catch(() => ({}));
        }
        lastUpstream = upstreamBody;
        lastUsage = upstreamBody?.usage || null;
        if (!upstream.ok) {
            return {
                ok: false,
                status: upstream.status || 502,
                error: 'llm_upstream_failed',
                message: firstNonEmptyString(upstreamBody?.error?.message, upstreamBody?.error, upstreamBody?.message) || `upstream_${upstream.status}`,
                upstream_body: upstreamBody,
            };
        }
        const assistantMessage = upstreamBody?.choices?.[0]?.message && typeof upstreamBody.choices[0].message === 'object'
            ? upstreamBody.choices[0].message
            : {};
        const assistantText = normalizeOpenAiMessageContent(assistantMessage.content);
        const toolCalls = Array.isArray(assistantMessage.tool_calls) ? assistantMessage.tool_calls : [];
        if (!toolCalls.length) {
            return {
                ok: true,
                status: 200,
                output: assistantText || '',
                usage: lastUsage,
                upstream_body: upstreamBody,
            };
        }
        messages.push({
            role: 'assistant',
            content: assistantText || '',
            tool_calls: toolCalls.map((call) => ({
                id: String(call?.id || ''),
                type: 'function',
                function: {
                    name: String(call?.function?.name || ''),
                    arguments: String(call?.function?.arguments || '{}'),
                },
            })),
        });
        for (const call of toolCalls) {
            const callId = String(call?.id || crypto.randomUUID()).trim();
            const functionName = String(call?.function?.name || '').trim();
            const operationArgsRaw = String(call?.function?.arguments || '{}');
            let operationArgs = {};
            try {
                const parsed = JSON.parse(operationArgsRaw || '{}');
                if (parsed && typeof parsed === 'object') operationArgs = parsed;
            }
            catch (_) {}
            const resolvedToolId = nameToToolId[functionName] || '';
            if (!resolvedToolId) {
                messages.push({
                    role: 'tool',
                    tool_call_id: callId,
                    content: JSON.stringify({ ok: false, error: 'unknown_tool_call', function_name: functionName }),
                });
                continue;
            }
            const operation = String(operationArgs.operation || '').trim();
            const payload = operationArgs.payload && typeof operationArgs.payload === 'object'
                ? operationArgs.payload
                : {};
            if (!operation) {
                messages.push({
                    role: 'tool',
                    tool_call_id: callId,
                    content: JSON.stringify({ ok: false, error: 'missing_operation' }),
                });
                continue;
            }
            const executed = await executeToolViaApi({
                toolId: resolvedToolId,
                operation,
                payload,
                trace_id,
                agent_id,
            }).catch((err) => ({ ok: false, status: 502, body: { error: 'tool_execute_failed', message: String(err?.message || err) } }));
            messages.push({
                role: 'tool',
                tool_call_id: callId,
                content: JSON.stringify(sanitizeForLogs({
                    ok: executed.ok,
                    status: executed.status,
                    data: executed.body,
                    tool_id: resolvedToolId,
                    operation,
                })),
            });
        }
    }
    return {
        ok: true,
        status: 200,
        output: String(extractLlmTextFromUpstreamBody(lastUpstream || {}) || '').trim(),
        usage: lastUsage,
        upstream_body: lastUpstream,
        tool_loop_capped: true,
    };
}
function maskEngineSettingsSecrets(config) {
    const cloned = deepCloneJson(config || {});
    for (const [root, field] of ENGINE_SETTINGS_SECRET_PATHS) {
        if (cloned?.[root] && typeof cloned[root] === 'object') {
            const raw = String(cloned[root][field] || '').trim();
            if (raw) cloned[root][field] = '[REDACTED]';
        }
    }
    if (cloned?.llm_provider_secrets && typeof cloned.llm_provider_secrets === 'object') {
        for (const key of Object.keys(cloned.llm_provider_secrets)) {
            const raw = String(cloned.llm_provider_secrets[key] || '').trim();
            if (raw) cloned.llm_provider_secrets[key] = '[REDACTED]';
        }
    }
    return cloned;
}
function normalizeDashboardToolIds(rawValue) {
    if (!Array.isArray(rawValue)) return [];
    return [...new Set(rawValue.map((value) => String(value || '').trim()).filter(Boolean))];
}
function normalizeDashboardSystemPrompt(rawValue, fallback) {
    const text = String(rawValue || '').trim();
    return text || String(fallback || '').trim();
}
function resolveStoredProviderSecretFromMap(config, provider, mapKey = 'llm_provider_secrets') {
    const secretMap = config?.[mapKey] && typeof config[mapKey] === 'object'
        ? config[mapKey]
        : {};
    const candidateKeys = [
        provider?.id,
        provider?.slug,
        provider?.api_key_env,
    ].map((value) => String(value || '').trim()).filter(Boolean);
    for (const key of candidateKeys) {
        const storedSecret = String(secretMap[key] || '').trim();
        if (storedSecret) return storedSecret;
    }
    const envSecret = provider?.api_key_env ? String(process.env[String(provider.api_key_env)] || '').trim() : '';
    return envSecret || '';
}
function resolveStoredProviderSecret(config, provider) {
    return resolveStoredProviderSecretFromMap(config, provider, 'llm_provider_secrets');
}
function resolveStoredAssistantProviderSecret(config, provider) {
    return resolveStoredProviderSecret(config, provider);
}
function resolveAssistantApiKeyHeaderName(providerLike = {}) {
    const baseUrl = String(providerLike?.base_url || '').trim().toLowerCase();
    const slug = String(providerLike?.slug || providerLike?.provider_slug || '').trim().toLowerCase();
    const apiKeyEnv = String(providerLike?.api_key_env || providerLike?.provider_api_key_env || '').trim().toLowerCase();
    const name = String(providerLike?.name || providerLike?.provider_name || '').trim().toLowerCase();
    if (baseUrl.includes('/api/llamaindex') || slug.includes('llamaindex') || apiKeyEnv.includes('llamaindex_internal_key') || name.includes('llamaindex')) {
        return 'X-Internal-Key';
    }
    return 'Authorization';
}
function buildApiKeyHeaders(apiKey = '', headerName = 'Authorization') {
    const cleanKey = String(apiKey || '').trim();
    if (!cleanKey) return {};
    if (String(headerName || '').trim().toLowerCase() === 'authorization') {
        return { Authorization: `Bearer ${cleanKey}` };
    }
    return { [headerName]: cleanKey };
}
function toProviderPublicView(row, engineConfig = {}) {
    return {
        ...row,
        api_key_set: !!resolveStoredProviderSecret(engineConfig || {}, row),
    };
}
function toProviderRuntimeView(row, engineConfig = {}) {
    return {
        id: row?.id || null,
        enabled: row?.enabled !== false,
        api_key_set: !!resolveStoredProviderSecret(engineConfig || {}, row),
        api_key_placeholder: isPlaceholderApiKey(resolveStoredProviderSecret(engineConfig || {}, row)),
    };
}
function toAssistantProviderPublicView(row, engineConfig = {}) {
    return toProviderPublicView(row, engineConfig);
}
function buildAssistantModelPublicView(row, engineConfig = {}) {
    return buildModelPublicView(row, engineConfig);
}
async function upsertLlmProviderRow({
    name = '',
    slug = '',
    kind = 'openai_compatible',
    base_url = '',
    api_key_env = '',
    enabled = true,
} = {}) {
    const cleanName = String(name || '').trim();
    const cleanSlug = String(slug || '').trim().toLowerCase();
    const cleanKind = String(kind || 'openai_compatible').trim();
    const cleanBaseUrl = normalizeDashboardProviderBaseUrl(cleanKind, base_url || '');
    const cleanApiKeyEnv = String(api_key_env || '').trim();
    if (!cleanName || !cleanSlug || !cleanBaseUrl) return null;
    const result = await pool.query(
        `INSERT INTO llm_registry (
            record_type, name, slug, kind, base_url, api_key_env, enabled, updated_at
        )
        VALUES ('provider', $1, $2, $3, $4, $5, $6, now())
        ON CONFLICT (slug) WHERE record_type = 'provider' DO UPDATE
        SET name = EXCLUDED.name,
            kind = EXCLUDED.kind,
            base_url = EXCLUDED.base_url,
            api_key_env = EXCLUDED.api_key_env,
            enabled = EXCLUDED.enabled,
            updated_at = now()
        RETURNING id, name, slug, kind, base_url, api_key_env, enabled, created_at, updated_at`,
        [cleanName, cleanSlug, cleanKind, cleanBaseUrl, cleanApiKeyEnv, enabled !== false]
    );
    return result.rows?.[0] || null;
}
async function upsertLlmModelRow({
    provider_id = '',
    label = '',
    model_id = '',
    config = {},
    enabled = true,
    name = '',
    provider = '',
    base_url = '',
    status = '',
} = {}) {
    const cleanProviderId = String(provider_id || '').trim();
    const cleanLabel = String(label || model_id || '').trim();
    const cleanModelId = String(model_id || '').trim();
    if (!cleanProviderId || !cleanLabel || !cleanModelId) return null;
    const normalizedEnabled = enabled !== false;
    const normalizedStatus = String(status || (normalizedEnabled ? 'active' : 'disabled')).trim() || (normalizedEnabled ? 'active' : 'disabled');
    const result = await pool.query(
        `INSERT INTO llm_registry (
            record_type, provider_id, label, model_id, config, enabled, name, provider, base_url, status, updated_at
        )
        VALUES ('model', $1::uuid, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, now())
        ON CONFLICT (provider_id, model_id) WHERE record_type = 'model' DO UPDATE
        SET label = EXCLUDED.label,
            config = EXCLUDED.config,
            enabled = EXCLUDED.enabled,
            name = EXCLUDED.name,
            provider = EXCLUDED.provider,
            base_url = EXCLUDED.base_url,
            status = EXCLUDED.status,
            updated_at = now()
        RETURNING id, provider_id, label, model_id, config, enabled, created_at, updated_at`,
        [
            cleanProviderId,
            cleanLabel,
            cleanModelId,
            JSON.stringify(config && typeof config === 'object' ? config : {}),
            normalizedEnabled,
            String(name || '').trim() || null,
            String(provider || '').trim() || null,
            String(base_url || '').trim() || null,
            normalizedStatus,
        ]
    );
    return result.rows?.[0] || null;
}
async function ensureCanonicalProviderRow(providerLike = {}) {
    const name = String(providerLike?.name || providerLike?.provider_name || '').trim();
    const slug = String(providerLike?.slug || providerLike?.provider_slug || '').trim().toLowerCase();
    const kind = String(providerLike?.kind || providerLike?.provider_kind || 'openai_compatible').trim();
    const baseUrl = normalizeDashboardProviderBaseUrl(kind, providerLike?.base_url || providerLike?.provider_base_url || '');
    const apiKeyEnv = String(providerLike?.api_key_env || providerLike?.provider_api_key_env || '').trim();
    const enabled = providerLike?.enabled !== false && providerLike?.provider_enabled !== false;
    if (!name || !slug || !baseUrl) return null;
    return upsertLlmProviderRow({
        name,
        slug,
        kind,
        base_url: baseUrl,
        api_key_env: apiKeyEnv,
        enabled,
    });
}
async function ensureCanonicalModelRow(modelLike = {}, engineConfig = {}) {
    const providerRow = await ensureCanonicalProviderRow(modelLike);
    if (!providerRow?.id) return null;
    const label = String(modelLike?.label || modelLike?.model_id || '').trim();
    const modelId = String(modelLike?.model_id || '').trim();
    if (!label || !modelId) return null;
    const config = normalizeModelConfig(modelLike?.config, engineConfig || {});
    const enabled = modelLike?.enabled !== false;
    return upsertLlmModelRow({
        provider_id: providerRow.id,
        label,
        model_id: modelId,
        config,
        enabled,
        name: modelLike?.name,
        provider: modelLike?.provider,
        base_url: modelLike?.base_url || modelLike?.provider_base_url,
        status: modelLike?.status,
    });
}
async function resolveCanonicalDashboardModelUuid(modelUuid, engineConfig = {}) {
    const cleanModelUuid = String(modelUuid || '').trim();
    if (!cleanModelUuid) return null;
    const canonicalModel = await pool.query(
        `SELECT id
           FROM llm_registry
          WHERE id = $1::uuid
            AND record_type = 'model'
          LIMIT 1`,
        [cleanModelUuid]
    ).catch(() => ({ rowCount: 0, rows: [] }));
    if (canonicalModel.rowCount > 0) return cleanModelUuid;
    const error = new Error('dashboard_model_uuid_not_found');
    error.code = 'dashboard_model_uuid_not_found';
    throw error;
}
async function upsertDashboardLlmSettingRow({
    scope = 'site',
    user_id = null,
    model_uuid = null,
    system_prompt = '',
    enabled_tool_ids = [],
    enabled = true,
    last_test_status = 'untested',
    last_test_trace_id = null,
    last_test_latency_ms = null,
    last_test_message = '',
    config = {},
} = {}) {
    const cleanScope = String(scope || 'site').trim() === 'user' ? 'user' : 'site';
    const cleanUserId = cleanScope === 'user' ? String(user_id || '').trim() : '';
    const values = [
        model_uuid ? String(model_uuid).trim() : null,
        normalizeDashboardSystemPrompt(system_prompt, DEFAULT_ENGINE_SETTINGS.dashboard_llm.system_prompt),
        JSON.stringify(normalizeDashboardToolIds(enabled_tool_ids)),
        enabled !== false,
        String(last_test_status || 'untested').trim() || 'untested',
        last_test_trace_id ? String(last_test_trace_id).trim() : null,
        Number.isFinite(Number(last_test_latency_ms)) ? Number(last_test_latency_ms) : null,
        String(last_test_message || '').trim(),
        JSON.stringify(config && typeof config === 'object' ? config : {}),
    ];
    if (cleanScope === 'site') {
        const updated = await pool.query(
            `UPDATE llm_registry
                SET model_uuid = $1::uuid,
                    system_prompt = $2,
                    enabled_tool_ids = $3::jsonb,
                    enabled = $4,
                    last_test_status = $5,
                    last_test_trace_id = $6::uuid,
                    last_test_latency_ms = $7,
                    last_test_message = $8,
                    config = $9::jsonb,
                    updated_at = now()
              WHERE record_type = 'dashboard'
                AND scope = 'site'
          RETURNING *`,
            values
        );
        if (updated.rowCount > 0) return updated.rows[0];
        const inserted = await pool.query(
            `INSERT INTO llm_registry (
                record_type, scope, user_id, model_uuid, system_prompt, enabled_tool_ids, enabled,
                last_test_status, last_test_trace_id, last_test_latency_ms, last_test_message, config, updated_at
            )
            VALUES ('dashboard', 'site', NULL, $1::uuid, $2, $3::jsonb, $4, $5, $6::uuid, $7, $8, $9::jsonb, now())
            RETURNING *`,
            values
        );
        return inserted.rows?.[0] || null;
    }
    if (!cleanUserId) throw new Error('missing_user_id');
    const updated = await pool.query(
        `UPDATE llm_registry
            SET model_uuid = $2::uuid,
                system_prompt = $3,
                enabled_tool_ids = $4::jsonb,
                enabled = $5,
                last_test_status = $6,
                last_test_trace_id = $7::uuid,
                last_test_latency_ms = $8,
                last_test_message = $9,
                config = $10::jsonb,
                updated_at = now()
          WHERE record_type = 'dashboard'
            AND scope = 'user'
            AND user_id = $1::uuid
      RETURNING *`,
        [cleanUserId, ...values]
    );
    if (updated.rowCount > 0) return updated.rows[0];
    const inserted = await pool.query(
        `INSERT INTO llm_registry (
            record_type, scope, user_id, model_uuid, system_prompt, enabled_tool_ids, enabled,
            last_test_status, last_test_trace_id, last_test_latency_ms, last_test_message, config, updated_at
        )
        VALUES ('dashboard', 'user', $1::uuid, $2::uuid, $3, $4::jsonb, $5, $6, $7::uuid, $8, $9, $10::jsonb, now())
        RETURNING *`,
        [cleanUserId, ...values]
    );
    return inserted.rows?.[0] || null;
}
async function consolidateLegacyDashboardLlmState({ default_provider_slug = '', default_model_id = '' } = {}) {
    const settingsState = await getEngineSettings().catch(() => ({ config: {} }));
    const engineConfig = settingsState?.config || {};
    const mergedSecrets = { ...(engineConfig.llm_provider_secrets || {}) };
    const assistantProviders = await pool.query(
        `SELECT id, name, slug, kind, base_url, api_key_env, enabled, created_at, updated_at
           FROM assistant_llm_providers
          ORDER BY created_at ASC, updated_at ASC`
    ).catch(() => ({ rows: [] }));
    for (const row of assistantProviders.rows || []) {
        const canonicalProvider = await ensureCanonicalProviderRow(row);
        if (!canonicalProvider?.id) continue;
        const secret = resolveStoredProviderSecretFromMap(engineConfig, row, 'assistant_llm_provider_secrets');
        if (secret && !String(mergedSecrets[String(canonicalProvider.id)] || '').trim()) {
            mergedSecrets[String(canonicalProvider.id)] = secret;
        }
    }
    const defaultCanonicalModel = (String(default_provider_slug || '').trim() && String(default_model_id || '').trim())
        ? await pool.query(
            `SELECT m.id
               FROM llm_registry m
               JOIN llm_registry p ON p.id = m.provider_id
              WHERE p.slug = $1
                AND m.record_type = 'model'
                AND p.record_type = 'provider'
                AND m.model_id = $2
              ORDER BY m.created_at ASC, m.id ASC
              LIMIT 1`,
            [String(default_provider_slug).trim(), String(default_model_id).trim()]
        ).catch(() => ({ rowCount: 0, rows: [] }))
        : { rowCount: 0, rows: [] };
    const defaultCanonicalModelId = String(defaultCanonicalModel.rows?.[0]?.id || '').trim() || null;
    const siteRow = await pool.query(
        `SELECT id, model_uuid, system_prompt, enabled_tool_ids, true AS enabled,
                last_test_status, last_test_trace_id, last_test_latency_ms, last_test_message, config
           FROM dashboard_assistant_site_settings
          WHERE id = 1
          LIMIT 1`
    ).catch(() => ({ rowCount: 0, rows: [] }));
    if (siteRow.rowCount > 0) {
        let canonicalModelUuid = null;
        try {
            canonicalModelUuid = await resolveCanonicalDashboardModelUuid(siteRow.rows[0].model_uuid, engineConfig);
        } catch (_) {}
        await upsertDashboardLlmSettingRow({
            scope: 'site',
            model_uuid: canonicalModelUuid || defaultCanonicalModelId,
            system_prompt: siteRow.rows[0].system_prompt || DEFAULT_ENGINE_SETTINGS.dashboard_llm.system_prompt,
            enabled_tool_ids: siteRow.rows[0].enabled_tool_ids || [],
            enabled: true,
            last_test_status: siteRow.rows[0].last_test_status || (canonicalModelUuid || defaultCanonicalModelId ? 'passed' : 'untested'),
            last_test_trace_id: siteRow.rows[0].last_test_trace_id || null,
            last_test_latency_ms: siteRow.rows[0].last_test_latency_ms,
            last_test_message: siteRow.rows[0].last_test_message || '',
            config: siteRow.rows[0].config || {},
        });
    }
    const assistantUserRows = await pool.query(
        `SELECT id, user_id, model_uuid, system_prompt, enabled_tool_ids, enabled,
                last_test_status, last_test_trace_id, last_test_latency_ms, last_test_message, config
           FROM dashboard_assistant_user_settings`
    ).catch(() => ({ rows: [] }));
    const legacyUserRows = await pool.query(
        `SELECT id, user_id, model_uuid, system_prompt, enabled_tool_ids, enabled,
                last_test_status, last_test_trace_id, last_test_latency_ms, last_test_message, config
           FROM dashboard_user_llm_settings`
    ).catch(() => ({ rows: [] }));
    const mergedUserRows = new Map();
    for (const row of legacyUserRows.rows || []) mergedUserRows.set(String(row.user_id || '').trim(), row);
    for (const row of assistantUserRows.rows || []) mergedUserRows.set(String(row.user_id || '').trim(), row);
    for (const row of mergedUserRows.values()) {
        if (!String(row?.user_id || '').trim()) continue;
        let canonicalModelUuid = null;
        try {
            canonicalModelUuid = await resolveCanonicalDashboardModelUuid(row.model_uuid, engineConfig);
        } catch (_) {}
        await upsertDashboardLlmSettingRow({
            scope: 'user',
            user_id: row.user_id,
            model_uuid: canonicalModelUuid,
            system_prompt: row.system_prompt || DEFAULT_ENGINE_SETTINGS.dashboard_llm.system_prompt,
            enabled_tool_ids: row.enabled_tool_ids || [],
            enabled: row.enabled !== false,
            last_test_status: row.last_test_status || 'untested',
            last_test_trace_id: row.last_test_trace_id || null,
            last_test_latency_ms: row.last_test_latency_ms,
            last_test_message: row.last_test_message || '',
            config: row.config || {},
        });
    }
    const nextConfig = deepCloneJson(engineConfig || {});
    nextConfig.llm_provider_secrets = mergedSecrets;
    delete nextConfig.assistant_llm_provider_secrets;
    await pool.query(
        `UPDATE engine_settings
            SET config = $1::jsonb,
                updated_at = now()
          WHERE id = 1`,
        [JSON.stringify(nextConfig)]
    ).catch(() => {});
    await pool.query(`DROP TABLE IF EXISTS dashboard_assistant_user_settings`).catch(() => {});
    await pool.query(`DROP TABLE IF EXISTS dashboard_assistant_site_settings`).catch(() => {});
    await pool.query(`DROP TABLE IF EXISTS dashboard_user_llm_settings`).catch(() => {});
    await pool.query(`DROP TABLE IF EXISTS assistant_llm_models`).catch(() => {});
    await pool.query(`DROP TABLE IF EXISTS assistant_llm_providers`).catch(() => {});
}
function normalizeDashboardProviderBaseUrl(kind, rawBaseUrl) {
    const clean = String(rawBaseUrl || '').trim().replace(/\/$/, '');
    if (String(kind || '').trim().toLowerCase() === 'google_gemini') {
        if (!clean) return 'https://generativelanguage.googleapis.com/v1beta/openai';
        if (/\/openai$/i.test(clean)) return clean;
        return `${clean.replace(/\/v1$/i, '')}/openai`;
    }
    return clean;
}
function normalizeDiscoveryProviderBaseUrl(kind, rawBaseUrl) {
    const clean = String(rawBaseUrl || '').trim().replace(/\/$/, '');
    if (String(kind || '').trim().toLowerCase() === 'google_gemini') {
        if (!clean) return 'https://generativelanguage.googleapis.com/v1beta';
        return clean.replace(/\/openai$/i, '');
    }
    return clean;
}
function normalizeDashboardAssistantRow(row) {
    if (!row) return null;
    return {
        id: String(row.id || '').trim(),
        user_id: String(row.user_id || '').trim(),
        model_uuid: String(row.model_uuid || '').trim(),
        system_prompt: String(row.system_prompt || '').trim(),
        enabled_tool_ids: normalizeDashboardToolIds(row.enabled_tool_ids),
        enabled: row.enabled !== false,
        last_test_status: String(row.last_test_status || 'untested').trim() || 'untested',
        last_test_trace_id: row.last_test_trace_id ? String(row.last_test_trace_id) : null,
        last_test_latency_ms: Number.isFinite(Number(row.last_test_latency_ms)) ? Number(row.last_test_latency_ms) : null,
        last_test_message: String(row.last_test_message || '').trim(),
        config: row.config && typeof row.config === 'object' ? row.config : {},
        created_at: row.created_at || null,
        updated_at: row.updated_at || null,
        model_label: row.model_label ? String(row.model_label) : null,
        model_id: row.model_id ? String(row.model_id) : null,
    };
}
async function getDashboardAssistantUserRow(userId = '') {
    const cleanUserId = String(userId || '').trim();
    if (!cleanUserId) return null;
    const result = await pool.query(
        `SELECT s.id,
                s.scope,
                s.user_id,
                s.model_uuid,
                s.system_prompt,
                s.enabled_tool_ids,
                s.enabled,
                s.last_test_status,
                s.last_test_trace_id,
                s.last_test_latency_ms,
                s.last_test_message,
                s.config,
                s.created_at,
                s.updated_at,
                m.label AS model_label,
                m.model_id,
                p.name AS provider_name,
                p.slug AS provider_slug,
                p.kind AS provider_kind,
                p.base_url AS provider_base_url,
                p.api_key_env AS provider_api_key_env
           FROM llm_registry s
      LEFT JOIN llm_registry m
             ON m.id = s.model_uuid
            AND m.record_type = 'model'
      LEFT JOIN llm_registry p
             ON p.id = m.provider_id
            AND p.record_type = 'provider'
          WHERE s.record_type = 'dashboard'
            AND s.scope = 'user'
            AND s.user_id = $1::uuid
          LIMIT 1`,
        [cleanUserId]
    ).catch(() => ({ rowCount: 0, rows: [] }));
    if (result.rowCount === 0) return null;
    return normalizeDashboardAssistantRow(result.rows[0]);
}
async function getDashboardAssistantSiteRow() {
    const settingsState = await getEngineSettings().catch(() => ({ config: {} }));
    const dashboardCfg = settingsState?.config?.dashboard_llm && typeof settingsState.config.dashboard_llm === 'object'
        ? settingsState.config.dashboard_llm
        : {};
    const fallbackModelUuid = String(dashboardCfg.default_model_uuid || '').trim();
    const fallbackSystemPrompt = normalizeDashboardSystemPrompt(
        dashboardCfg.system_prompt,
        DEFAULT_ENGINE_SETTINGS.dashboard_llm.system_prompt
    );
    const result = await pool.query(
        `SELECT s.id,
                s.scope,
                s.model_uuid,
                s.system_prompt,
                s.enabled_tool_ids,
                s.enabled,
                s.last_test_status,
                s.last_test_trace_id,
                s.last_test_latency_ms,
                s.last_test_message,
                s.config,
                s.created_at,
                s.updated_at,
                m.label AS model_label,
                m.model_id,
                p.name AS provider_name,
                p.slug AS provider_slug,
                p.kind AS provider_kind,
                p.base_url AS provider_base_url,
                p.api_key_env AS provider_api_key_env
           FROM llm_registry s
      LEFT JOIN llm_registry m
             ON m.id = s.model_uuid
            AND m.record_type = 'model'
      LEFT JOIN llm_registry p
             ON p.id = m.provider_id
            AND p.record_type = 'provider'
          WHERE s.record_type = 'dashboard'
            AND s.scope = 'site'
          LIMIT 1`
    ).catch(() => ({ rowCount: 0, rows: [] }));
    if (result.rowCount === 0) {
        return {
            id: '1',
            scope: 'site',
            model_uuid: fallbackModelUuid,
            system_prompt: fallbackSystemPrompt,
            enabled_tool_ids: [],
            enabled: true,
            last_test_status: 'untested',
            last_test_trace_id: null,
            last_test_latency_ms: null,
            last_test_message: '',
            config: {},
            created_at: null,
            updated_at: null,
            model_label: null,
            model_id: null,
            provider_name: null,
            provider_slug: null,
            provider_kind: null,
            provider_base_url: null,
            provider_api_key_env: null,
        };
    }
    const normalized = normalizeDashboardAssistantRow(result.rows[0]);
    if (!String(normalized.model_uuid || '').trim() && fallbackModelUuid) {
        normalized.model_uuid = fallbackModelUuid;
    }
    if (!String(normalized.system_prompt || '').trim()) {
        normalized.system_prompt = fallbackSystemPrompt;
    }
    return normalized;
}
function buildDashboardAssistantEffectiveSettings({ siteRow = null, userRow = null }) {
    const defaults = siteRow && typeof siteRow === 'object' ? siteRow : {};
    const globalDefaultModelUuid = String(defaults.model_uuid || '').trim();
    const globalSystemPrompt = normalizeDashboardSystemPrompt(
        defaults.system_prompt,
        DEFAULT_ENGINE_SETTINGS.dashboard_llm.system_prompt
    );
    const globalToolIds = normalizeDashboardToolIds(defaults.enabled_tool_ids);
    const userModelUuid = String(userRow?.model_uuid || '').trim();
    const userHasOverride = userRow?.enabled === true && !!userModelUuid;
    return {
        site_default: {
            model_uuid: globalDefaultModelUuid,
            system_prompt: globalSystemPrompt,
            enabled_tool_ids: globalToolIds,
            last_test_status: String(defaults.last_test_status || 'untested'),
            last_test_trace_id: defaults.last_test_trace_id || null,
            last_test_latency_ms: Number.isFinite(Number(defaults.last_test_latency_ms)) ? Number(defaults.last_test_latency_ms) : null,
            last_test_message: String(defaults.last_test_message || '').trim(),
        },
        user_override: userRow ? {
            enabled: userRow.enabled === true,
            model_uuid: userModelUuid,
            system_prompt: normalizeDashboardSystemPrompt(userRow.system_prompt, globalSystemPrompt),
            enabled_tool_ids: normalizeDashboardToolIds(
                Array.isArray(userRow.enabled_tool_ids) && userRow.enabled_tool_ids.length > 0
                    ? userRow.enabled_tool_ids
                    : globalToolIds
            ),
            last_test_status: String(userRow.last_test_status || 'untested'),
            last_test_trace_id: userRow.last_test_trace_id || null,
            last_test_latency_ms: userRow.last_test_latency_ms ?? null,
            last_test_message: String(userRow.last_test_message || '').trim(),
        } : null,
        effective: {
            source: userHasOverride ? 'user_override' : 'site_default',
            model_uuid: userHasOverride ? userModelUuid : globalDefaultModelUuid,
            system_prompt: userHasOverride
                ? normalizeDashboardSystemPrompt(userRow?.system_prompt, globalSystemPrompt)
                : globalSystemPrompt,
            enabled_tool_ids: userHasOverride
                ? normalizeDashboardToolIds(
                    Array.isArray(userRow?.enabled_tool_ids) && userRow.enabled_tool_ids.length > 0
                        ? userRow.enabled_tool_ids
                        : globalToolIds
                )
                : globalToolIds,
            last_test_status: userHasOverride
                ? String(userRow?.last_test_status || 'untested')
                : String(defaults.last_test_status || 'untested'),
            last_test_trace_id: userHasOverride
                ? userRow?.last_test_trace_id || null
                : defaults.last_test_trace_id || null,
            last_test_latency_ms: userHasOverride
                ? userRow?.last_test_latency_ms ?? null
                : (Number.isFinite(Number(defaults.last_test_latency_ms)) ? Number(defaults.last_test_latency_ms) : null),
            last_test_message: userHasOverride
                ? String(userRow?.last_test_message || '').trim()
                : String(defaults.last_test_message || '').trim(),
        },
    };
}
function buildDashboardAssistantStatusPayload({ siteRow = null, userRow = null }) {
    const effectiveState = buildDashboardAssistantEffectiveSettings({ siteRow, userRow });
    const effectiveModelUuid = String(effectiveState.effective.model_uuid || '').trim();
    const lastTestStatus = String(effectiveState.effective.last_test_status || 'untested').trim() || 'untested';
    const configured = !!effectiveModelUuid;
    return {
        configured,
        required: !configured,
        source: effectiveState.effective.source,
        effective_model_uuid: effectiveModelUuid || null,
        last_test_status: lastTestStatus,
        last_test_trace_id: effectiveState.effective.last_test_trace_id || null,
        last_test_latency_ms: effectiveState.effective.last_test_latency_ms ?? null,
        last_test_message: effectiveState.effective.last_test_message || '',
        site_default: effectiveState.site_default,
        user_override: effectiveState.user_override,
    };
}
async function resolveDashboardAssistantRuntime({
    model_uuid = '',
    user_id = '',
    engine_settings = null,
    site_row = undefined,
    user_row = undefined,
} = {}) {
    const settingsState = engine_settings || await getEngineSettings().catch(() => ({ config: {} }));
    const engineConfig = settingsState?.config || {};
    const siteRow = site_row === undefined ? await getDashboardAssistantSiteRow() : site_row;
    const userRow = user_row === undefined ? await getDashboardAssistantUserRow(user_id) : user_row;
    const effectiveState = buildDashboardAssistantEffectiveSettings({ siteRow, userRow });
    const engineDefaultModelUuid = String(engineConfig?.dashboard_llm?.default_model_uuid || '').trim();
    const preferredModelUuid = String(model_uuid || effectiveState.effective.model_uuid || engineDefaultModelUuid || '').trim();
    if (!preferredModelUuid) {
        return {
            llm: null,
            engine_settings: settingsState,
            site_row: siteRow,
            user_row: userRow,
            assistant_state: effectiveState,
        };
    }

    const canonicalModelUuid = await resolveCanonicalDashboardModelUuid(preferredModelUuid, engineConfig)
        .catch(() => preferredModelUuid);
    const canonicalRows = await pool.query(
        `SELECT m.id,
                m.provider_id,
                m.label,
                m.model_id,
                m.config,
                m.enabled,
                p.name AS provider_name,
                p.slug AS provider_slug,
                p.kind AS provider_kind,
                p.base_url,
                p.api_key_env,
                p.enabled AS provider_enabled
           FROM llm_registry m
           JOIN llm_registry p ON p.id = m.provider_id
          WHERE m.id = $1::uuid
            AND m.record_type = 'model'
            AND p.record_type = 'provider'
          LIMIT 1`,
        [canonicalModelUuid]
    ).catch(() => ({ rowCount: 0, rows: [] }));
    const row = canonicalRows.rowCount > 0 ? canonicalRows.rows[0] : null;

    if (!row || row.enabled === false || row.provider_enabled === false) {
        return {
            llm: null,
            engine_settings: settingsState,
            site_row: siteRow,
            user_row: userRow,
            assistant_state: effectiveState,
        };
    }

    const apiKey = resolveStoredProviderSecret(engineConfig, row);
    const baseUrl = normalizeDashboardProviderBaseUrl(row.provider_kind, row.base_url || '');
    const chatUrl = resolveOpenAiChatCompletionsUrl(baseUrl);
    if (!apiKey || !chatUrl) {
        return {
            llm: null,
            engine_settings: settingsState,
            site_row: siteRow,
            user_row: userRow,
            assistant_state: effectiveState,
        };
    }
    const config = normalizeModelConfig(row.config, engineConfig);
    const apiMode = resolveLlmApiMode({
        apiModeRaw: config.api_mode || row.config?.api_mode,
        baseUrl,
        modelId: row.model_id,
    });
    return {
        llm: {
            model_uuid: row.id,
            model_id: row.model_id,
            label: row.label,
            provider_id: row.provider_id,
            provider_name: row.provider_name,
            provider_slug: row.provider_slug,
            provider_kind: row.provider_kind,
            base_url: baseUrl,
            chat_url: chatUrl,
            responses_url: resolveOpenAiResponsesUrl(baseUrl),
            api_key: apiKey,
            auth_header_name: resolveAssistantApiKeyHeaderName(row),
            api_mode: apiMode,
            config,
            token_policy: config.token_policy,
        },
        engine_settings: settingsState,
        site_row: siteRow,
        user_row: userRow,
        assistant_state: effectiveState,
    };
}
async function resolveAssistantModelUuidForDashboard(modelUuid, engineConfig = {}) {
    return resolveCanonicalDashboardModelUuid(modelUuid, engineConfig);
}
const DOCLING_HELPER_PROVIDER_SLUG = 'gpt-5.4';
const DOCLING_HELPER_MODEL_ID = 'gpt-5.4';
async function loadDoclingHelperLlmConfig() {
    const settingsState = await getEngineSettings().catch(() => ({ config: {} }));
    const engineConfig = settingsState?.config || {};
    const rowRes = await pool.query(
        `SELECT m.id,
                m.provider_id,
                m.label,
                m.model_id,
                m.config,
                m.enabled,
                p.name AS provider_name,
                p.slug AS provider_slug,
                p.kind AS provider_kind,
                p.base_url,
                p.api_key_env,
                p.enabled AS provider_enabled
           FROM llm_registry m
           JOIN llm_registry p ON p.id = m.provider_id
          WHERE m.record_type = 'model'
            AND p.record_type = 'provider'
            AND p.slug = $1
            AND m.model_id = $2
          ORDER BY m.updated_at DESC
          LIMIT 1`,
        [DOCLING_HELPER_PROVIDER_SLUG, DOCLING_HELPER_MODEL_ID]
    ).catch(() => ({ rowCount: 0, rows: [] }));
    const row = rowRes.rowCount > 0 ? rowRes.rows[0] : null;
    if (!row || row.enabled === false || row.provider_enabled === false) {
        return null;
    }
    const apiKey = resolveStoredProviderSecret(engineConfig, row);
    const baseUrl = normalizeDashboardProviderBaseUrl(row.provider_kind, row.base_url || '');
    const chatUrl = resolveOpenAiChatCompletionsUrl(baseUrl);
    if (!apiKey || !chatUrl) {
        return null;
    }
    const config = normalizeModelConfig(row.config, engineConfig);
    const apiMode = resolveLlmApiMode({
        apiModeRaw: config.api_mode || row.config?.api_mode,
        baseUrl,
        modelId: row.model_id,
    });
    return {
        model_uuid: row.id,
        model_id: row.model_id,
        label: row.label,
        provider_id: row.provider_id,
        provider_name: row.provider_name,
        provider_slug: row.provider_slug,
        provider_kind: row.provider_kind,
        base_url: baseUrl,
        chat_url: chatUrl,
        responses_url: resolveOpenAiResponsesUrl(baseUrl),
        api_key: apiKey,
        auth_header_name: resolveAssistantApiKeyHeaderName(row),
        api_mode: apiMode,
        config,
        token_policy: config.token_policy,
    };
}
async function upsertDashboardAssistantUserSettings(userId, patch = {}) {
    const cleanUserId = String(userId || '').trim();
    if (!cleanUserId) throw new Error('missing_user_id');
    const current = await getDashboardAssistantUserRow(cleanUserId);
    const siteDefaults = await getDashboardAssistantSiteRow();
    const nextModelUuidInput = patch.model_uuid === null
        ? null
        : (
            patch.model_uuid !== undefined
                ? String(patch.model_uuid || '').trim() || null
                : (String(current?.model_uuid || '').trim() || null)
        );
    const settingsState = await getEngineSettings().catch(() => ({ config: {} }));
    const nextModelUuid = nextModelUuidInput
        ? await resolveAssistantModelUuidForDashboard(nextModelUuidInput, settingsState.config || {})
        : null;
    const fallbackSystemPrompt = normalizeDashboardSystemPrompt(
        siteDefaults?.system_prompt,
        DEFAULT_ENGINE_SETTINGS.dashboard_llm.system_prompt
    );
    const nextSystemPrompt = patch.system_prompt !== undefined
        ? normalizeDashboardSystemPrompt(patch.system_prompt, fallbackSystemPrompt)
        : normalizeDashboardSystemPrompt(current?.system_prompt, fallbackSystemPrompt);
    const nextToolIds = patch.enabled_tool_ids !== undefined
        ? normalizeDashboardToolIds(patch.enabled_tool_ids)
        : normalizeDashboardToolIds(current?.enabled_tool_ids);
    const nextEnabled = patch.enabled !== undefined ? patch.enabled !== false : current?.enabled !== false;
    const nextLastTestStatus = patch.last_test_status !== undefined
        ? String(patch.last_test_status || 'untested').trim() || 'untested'
        : String(current?.last_test_status || 'untested').trim() || 'untested';
    const nextLastTestTraceId = patch.last_test_trace_id !== undefined
        ? (patch.last_test_trace_id ? String(patch.last_test_trace_id).trim() : null)
        : current?.last_test_trace_id || null;
    const nextLastTestLatencyMs = patch.last_test_latency_ms !== undefined
        ? (Number.isFinite(Number(patch.last_test_latency_ms)) ? Number(patch.last_test_latency_ms) : null)
        : (Number.isFinite(Number(current?.last_test_latency_ms)) ? Number(current.last_test_latency_ms) : null);
    const nextLastTestMessage = patch.last_test_message !== undefined
        ? String(patch.last_test_message || '').trim()
        : String(current?.last_test_message || '').trim();
    const nextConfig = patch.config && typeof patch.config === 'object'
        ? patch.config
        : (current?.config && typeof current.config === 'object' ? current.config : {});
    await upsertDashboardLlmSettingRow({
        scope: 'user',
        user_id: cleanUserId,
        model_uuid: nextModelUuid,
        system_prompt: nextSystemPrompt,
        enabled_tool_ids: nextToolIds,
        enabled: nextEnabled,
        last_test_status: nextLastTestStatus,
        last_test_trace_id: nextLastTestTraceId,
        last_test_latency_ms: nextLastTestLatencyMs,
        last_test_message: nextLastTestMessage,
        config: nextConfig,
    });
    return getDashboardAssistantUserRow(cleanUserId);
}
async function persistDashboardAssistantSiteDefaults(patch = {}) {
    const current = await getDashboardAssistantSiteRow();
    const nextModelUuidInput = patch.default_model_uuid !== undefined
        ? String(patch.default_model_uuid || '').trim() || null
        : (String(current?.model_uuid || '').trim() || null);
    const settingsState = await getEngineSettings().catch(() => ({ config: {} }));
    const nextModelUuid = nextModelUuidInput
        ? await resolveAssistantModelUuidForDashboard(nextModelUuidInput, settingsState.config || {})
        : null;
    const nextSystemPrompt = patch.system_prompt !== undefined
        ? normalizeDashboardSystemPrompt(patch.system_prompt, DEFAULT_ENGINE_SETTINGS.dashboard_llm.system_prompt)
        : normalizeDashboardSystemPrompt(current?.system_prompt, DEFAULT_ENGINE_SETTINGS.dashboard_llm.system_prompt);
    const nextToolIds = patch.enabled_tool_ids !== undefined
        ? normalizeDashboardToolIds(patch.enabled_tool_ids)
        : normalizeDashboardToolIds(current?.enabled_tool_ids);
    const nextLastTestStatus = patch.last_test_status !== undefined
        ? String(patch.last_test_status || 'untested').trim() || 'untested'
        : String(current?.last_test_status || 'untested').trim() || 'untested';
    const nextLastTestTraceId = patch.last_test_trace_id !== undefined
        ? (patch.last_test_trace_id ? String(patch.last_test_trace_id).trim() : null)
        : current?.last_test_trace_id || null;
    const nextLastTestLatencyMs = patch.last_test_latency_ms !== undefined
        ? (Number.isFinite(Number(patch.last_test_latency_ms)) ? Number(patch.last_test_latency_ms) : null)
        : (Number.isFinite(Number(current?.last_test_latency_ms)) ? Number(current.last_test_latency_ms) : null);
    const nextLastTestMessage = patch.last_test_message !== undefined
        ? String(patch.last_test_message || '').trim()
        : String(current?.last_test_message || '').trim();
    const nextConfig = patch.config && typeof patch.config === 'object'
        ? patch.config
        : (current?.config && typeof current.config === 'object' ? current.config : {});
    await upsertDashboardLlmSettingRow({
        scope: 'site',
        model_uuid: nextModelUuid,
        system_prompt: nextSystemPrompt,
        enabled_tool_ids: nextToolIds,
        enabled: true,
        last_test_status: nextLastTestStatus,
        last_test_trace_id: nextLastTestTraceId,
        last_test_latency_ms: nextLastTestLatencyMs,
        last_test_message: nextLastTestMessage,
        config: nextConfig,
    });
    return getDashboardAssistantSiteRow();
}
function buildProviderCheckRequest(provider, apiKey) {
    const kind = String(provider?.kind || 'openai_compatible').trim().toLowerCase();
    if (kind === 'google_gemini') {
        const baseUrl = normalizeDiscoveryProviderBaseUrl(kind, provider?.base_url || '');
        return {
            url: `${baseUrl}/models?key=${encodeURIComponent(String(apiKey || '').trim())}`,
            headers: {
                'Content-Type': 'application/json',
            },
        };
    }
    const normalizedBaseUrl = resolveConfiguredOpenAiBaseUrl(normalizeDashboardProviderBaseUrl(kind, provider?.base_url || ''));
    const modelListUrl = `${normalizedBaseUrl}/models`;
    return {
        url: modelListUrl,
        headers: {
            'Content-Type': 'application/json',
            ...buildApiKeyHeaders(apiKey, resolveAssistantApiKeyHeaderName(provider)),
        },
    };
}
function normalizeDiscoveredModels(kind, payload) {
    const normalizedKind = String(kind || 'openai_compatible').trim().toLowerCase();
    const rows = Array.isArray(payload?.data)
        ? payload.data
        : (Array.isArray(payload?.models) ? payload.models : []);
    return rows.map((row) => {
        if (normalizedKind === 'google_gemini') {
            const rawName = String(row?.name || '').trim();
            const modelId = rawName.replace(/^models\//i, '') || String(row?.displayName || '').trim();
            return {
                model_id: modelId,
                label: String(row?.displayName || modelId || rawName).trim() || modelId,
                raw: row,
            };
        }
        const modelId = String(row?.id || row?.model || '').trim();
        return {
            model_id: modelId,
            label: String(row?.label || row?.owned_by || modelId).trim() || modelId,
            raw: row,
        };
    }).filter((row) => row.model_id);
}
async function runProviderCatalogDiscovery({
    provider,
    api_key = '',
    trace_id = '',
    route = 'POST /api/llm/providers/check',
} = {}) {
    const cleanKey = String(api_key || '').trim();
    const logs = [];
    if (!provider || typeof provider !== 'object') {
        return { ok: false, status: 400, error: 'provider_missing', logs, models: [], raw: null };
    }
    if (!cleanKey) {
        return { ok: false, status: 400, error: 'provider_api_key_missing', logs, models: [], raw: null };
    }
    const request = buildProviderCheckRequest(provider, cleanKey);
    logs.push({
        phase: 'catalog_request_prepared',
        message: 'Prepared provider catalog discovery request.',
        detail: sanitizeForLogs({
            kind: provider.kind,
            base_url: provider.base_url,
            url: request.url,
        }),
    });
    const start = Date.now();
    let response;
    let payload = {};
    try {
        response = await fetch(request.url, {
            method: 'GET',
            headers: {
                ...request.headers,
                ...(trace_id ? { 'x-trace-id': trace_id } : {}),
            },
        });
        payload = await response.json().catch(() => ({}));
    } catch (error) {
        logs.push({
            phase: 'catalog_request_failed',
            message: 'Provider catalog request failed before an HTTP response was received.',
            detail: { error: String(error?.message || error) },
        });
        return {
            ok: false,
            status: 502,
            error: 'provider_catalog_fetch_failed',
            logs,
            models: [],
            raw: null,
            latency_ms: Date.now() - start,
        };
    }
    const models = normalizeDiscoveredModels(provider.kind, payload);
    logs.push({
        phase: response.ok ? 'catalog_response_ok' : 'catalog_response_error',
        message: response.ok
            ? `Provider catalog request completed with ${models.length} discovered models.`
            : `Provider catalog request returned HTTP ${response.status}.`,
        detail: sanitizeForLogs({
            status: response.status,
            model_count: models.length,
            payload,
        }),
    });
    return {
        ok: response.ok,
        status: response.status,
        error: response.ok ? null : firstNonEmptyString(payload?.error?.message, payload?.error, payload?.message) || 'provider_catalog_fetch_failed',
        logs,
        models,
        raw: sanitizeForLogs(payload),
        latency_ms: Date.now() - start,
    };
}
function buildAdHocDashboardLlmRuntime({
    provider = {},
    model_id = '',
    api_key = '',
    engine_config = {},
} = {}) {
    const cleanModelId = String(model_id || '').trim();
    const cleanApiKey = String(api_key || '').trim();
    const providerKind = String(provider?.kind || 'openai_compatible').trim().toLowerCase();
    const baseUrl = normalizeDashboardProviderBaseUrl(providerKind, provider?.base_url || '');
    const chatUrl = resolveOpenAiChatCompletionsUrl(baseUrl);
    if (!cleanModelId || !cleanApiKey || !chatUrl) return null;
    return {
        model_uuid: null,
        model_id: cleanModelId,
        provider_id: provider?.id ? String(provider.id) : null,
        provider_name: provider?.name ? String(provider.name) : null,
        provider_slug: provider?.slug ? String(provider.slug) : null,
        provider_kind: providerKind,
        base_url: baseUrl,
        chat_url: chatUrl,
        responses_url: resolveOpenAiResponsesUrl(baseUrl),
        api_key: cleanApiKey,
        auth_header_name: resolveAssistantApiKeyHeaderName(provider),
        api_mode: 'chat_completions',
        config: normalizeModelConfig({}, engine_config || {}),
        token_policy: normalizeModelTokenPolicy({}, resolveLlmTokenPolicyDefaults(engine_config || {})),
    };
}
async function runDashboardAssistantConnectivityTest({
    llm,
    trace_id = '',
    route = 'POST /api/settings/llm/test',
} = {}) {
    const upstreamStart = Date.now();
    const result = await callConfiguredLlm({
        llm,
        trace_id,
        route,
        body: {
            model: llm.model_id,
            temperature: 0,
            max_tokens: 64,
            messages: [
                { role: 'system', content: 'Connectivity test. Reply with OK.' },
                { role: 'user', content: 'health_check' },
            ],
        },
    });
    const upstreamBody = result.upstream_body || {};
    const replyPreview = extractLlmText(upstreamBody) || null;
    return {
        ok: result.ok && !!replyPreview,
        llm_result: result,
        upstream_latency_ms: Date.now() - upstreamStart,
        reply_preview: replyPreview,
    };
}
async function resolveProviderInput(body = {}, engineConfig = {}) {
    const providerId = String(body?.provider_id || '').trim();
    if (providerId) {
        const result = await pool.query(
            `SELECT id, name, slug, kind, base_url, api_key_env, enabled, created_at, updated_at
               FROM llm_registry
              WHERE id = $1::uuid
                AND record_type = 'provider'
              LIMIT 1`,
            [providerId]
        );
        if (result.rowCount === 0) throw new Error('provider_not_found');
        const provider = result.rows[0];
        return {
            provider: {
                ...provider,
                base_url: normalizeDashboardProviderBaseUrl(provider.kind, provider.base_url || ''),
            },
            api_key: String(body?.api_key || '').trim() || resolveStoredProviderSecret(engineConfig || {}, provider),
        };
    }
    const provider = {
        id: null,
        name: String(body?.name || '').trim(),
        slug: String(body?.slug || '').trim().toLowerCase(),
        kind: String(body?.kind || 'openai_compatible').trim(),
        base_url: normalizeDashboardProviderBaseUrl(body?.kind || 'openai_compatible', body?.base_url || ''),
        api_key_env: String(body?.api_key_env || '').trim(),
        enabled: body?.enabled !== false,
    };
    return {
        provider,
        api_key: String(body?.api_key || '').trim(),
    };
}
function resolveKnowledgeStorageSettings(config) {
    const stored = config?.knowledge_storage && typeof config.knowledge_storage === 'object'
        ? config.knowledge_storage
        : {};
    const llamaindex = config?.llamaindex && typeof config.llamaindex === 'object'
        ? config.llamaindex
        : {};
    const preferStoredOrFallback = (storedValue, fallbackValue) => {
        const storedText = String(storedValue ?? '').trim();
        if (storedText) return storedText;
        return String(fallbackValue ?? '').trim();
    };
    const parsed = normalizeS3LocationInput({
        s3_bucket: preferStoredOrFallback(stored.s3_bucket, S3_BUCKET || ''),
        s3_region: preferStoredOrFallback(stored.s3_region, S3_REGION || ''),
        s3_prefix: preferStoredOrFallback(stored.s3_prefix, S3_PREFIX || 'ghostdash-ingestion'),
    });
    return {
        s3_bucket: parsed.s3_bucket,
        s3_region: parsed.s3_region,
        s3_prefix: parsed.s3_prefix,
        s3_api_key: preferStoredOrFallback(stored.s3_api_key, process.env.AWS_ACCESS_KEY_ID || ''),
        s3_api_token: preferStoredOrFallback(stored.s3_api_token, process.env.AWS_SECRET_ACCESS_KEY || ''),
        cohere_rerank_api_key: preferStoredOrFallback(stored.cohere_rerank_api_key, process.env.COHERE_API_KEY || ''),
        rerank_model: preferStoredOrFallback(stored.rerank_model, 'rerank-v3.5') || 'rerank-v3.5',
        rerank_enabled: stored.rerank_enabled !== false,
        // Keep one effective LlamaIndex source of truth for retrieval by resolving
        // knowledge_storage first, then legacy llamaindex subtree, then env fallback.
        llamaindex_url: preferStoredOrFallback(
            stored.llamaindex_url,
            preferStoredOrFallback(llamaindex.orchestrator_url, LLAMAINDEX_URL)
        ).replace(/\/$/, ''),
        llamaindex_internal_key: preferStoredOrFallback(
            stored.llamaindex_internal_key,
            preferStoredOrFallback(llamaindex.internal_key, LLAMAINDEX_INTERNAL_KEY)
        ),
        shopify_mcp_url: preferStoredOrFallback(stored.shopify_mcp_url, SHOPIFY_MCP_URL).replace(/\/$/, ''),
        shopify_mcp_internal_key: preferStoredOrFallback(stored.shopify_mcp_internal_key, SHOPIFY_MCP_INTERNAL_KEY),
    };
}
function toKnowledgeStoragePublicView(config) {
    const resolved = resolveKnowledgeStorageSettings(config || {});
    return {
        s3_bucket: resolved.s3_bucket,
        s3_region: resolved.s3_region,
        s3_prefix: resolved.s3_prefix,
        rerank_model: resolved.rerank_model,
        rerank_enabled: resolved.rerank_enabled,
        llamaindex_url: resolved.llamaindex_url,
        shopify_mcp_url: resolved.shopify_mcp_url,
        s3_api_key_set: !!resolved.s3_api_key,
        s3_api_token_set: !!resolved.s3_api_token,
        cohere_rerank_api_key_set: !!resolved.cohere_rerank_api_key,
        llamaindex_internal_key_set: !!resolved.llamaindex_internal_key,
        shopify_mcp_internal_key_set: !!resolved.shopify_mcp_internal_key,
    };
}
function normalizeS3LocationInput({ s3_bucket, s3_region, s3_prefix }) {
    let bucket = String(s3_bucket || '').trim();
    let region = String(s3_region || '').trim();
    let prefix = String(s3_prefix || '').trim().replace(/^\/+|\/+$/g, '');

    const looksLikeUrl = /^https?:\/\//i.test(bucket);
    if (!looksLikeUrl) {
        return {
            s3_bucket: bucket,
            s3_region: region,
            s3_prefix: prefix || 'ghostdash-ingestion',
        };
    }

    try {
        const parsedUrl = new URL(bucket);
        const hostname = parsedUrl.hostname.toLowerCase();
        const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
        const regionFromQuery = String(parsedUrl.searchParams.get('region') || '').trim();
        const prefixFromQuery = String(parsedUrl.searchParams.get('prefix') || '').trim().replace(/^\/+|\/+$/g, '');
        if (!region && regionFromQuery) region = regionFromQuery;
        if (!prefix && prefixFromQuery) prefix = prefixFromQuery;

        if (hostname.includes('console.aws.amazon.com')) {
            // Example: /s3/buckets/my-bucket
            const bucketIdx = pathParts.findIndex((part) => part === 'buckets');
            if (bucketIdx >= 0 && pathParts[bucketIdx + 1]) {
                bucket = String(pathParts[bucketIdx + 1]).trim();
            }
        } else {
            const virtualHosted = hostname.match(/^([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\.s3[.-]([a-z0-9-]+)\.amazonaws\.com$/i);
            const regionalPath = hostname.match(/^s3[.-]([a-z0-9-]+)\.amazonaws\.com$/i);
            if (virtualHosted) {
                if (!bucket) bucket = virtualHosted[1];
                if (!region) region = virtualHosted[2];
            } else if (regionalPath) {
                if (!region) region = regionalPath[1];
                if (!bucket && pathParts[0]) bucket = pathParts[0];
                if (!prefix && pathParts.length > 1) {
                    prefix = pathParts.slice(1).join('/').replace(/^\/+|\/+$/g, '');
                }
            }
        }
    } catch {
        // Keep original values if URL parsing fails.
    }

    return {
        s3_bucket: bucket,
        s3_region: region,
        s3_prefix: prefix || 'ghostdash-ingestion',
    };
}
function buildDeterministicPointUuid(jobId, chunkIndex) {
    const hash = crypto.createHash('sha256').update(`${jobId}:${chunkIndex}`).digest('hex');
    const hex = hash.slice(0, 32);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
function toDateOnlyIso(input) {
    const d = new Date(input);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
}
function addDays(dateIso, days) {
    const d = new Date(`${dateIso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}
function buildQuery(params) {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
        if (v === undefined || v === null || v === '') continue;
        usp.set(k, String(v));
    }
    const out = usp.toString();
    return out ? `?${out}` : '';
}
function firstNonEmptyString(...values) {
    for (const v of values) {
        if (typeof v === 'string' && v.trim()) return v.trim();
        if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    }
    return null;
}
function extractLlmText(upstreamBody) {
    if (!upstreamBody || typeof upstreamBody !== 'object') return '';
    return extractLlmTextFromUpstreamBody(upstreamBody) || '';
}
function resolveAssistantGenerationDefaults(config) {
    const generationDefaults = config && typeof config === 'object' && config.generation_defaults && typeof config.generation_defaults === 'object'
        ? config.generation_defaults
        : {};
    const temperature = Number(generationDefaults.temperature);
    const topP = Number(generationDefaults.top_p);
    const maxTokens = Number(generationDefaults.max_tokens);
    return {
        temperature: Number.isFinite(temperature) ? temperature : 0.2,
        top_p: Number.isFinite(topP) ? topP : 1,
        max_tokens: Number.isFinite(maxTokens) ? maxTokens : 1024,
    };
}
function toDateValue(value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}
function formatDateAu(value) {
    const date = toDateValue(value);
    if (!date) return '—';
    return date.toLocaleDateString('en-AU', {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
    });
}
function formatTimeAu(value) {
    const date = toDateValue(value);
    if (!date) return '—';
    return date.toLocaleTimeString('en-AU', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
}
function sanitizeSpreadsheetCell(value) {
    const text = value == null ? '' : String(value);
    const trimmed = text.trimStart();
    if (!trimmed) return text;
    const firstChar = trimmed[0];
    return firstChar === '=' || firstChar === '+' || firstChar === '-' || firstChar === '@' ? `'${text}` : text;
}
function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function sanitizeFilenameSegment(value, fallback = 'all') {
    const clean = String(value || '')
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    return clean || fallback;
}
function firstFiniteNumber(...values) {
    for (const v of values) {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
    }
    return null;
}
function firstBoolean(...values) {
    for (const v of values) {
        if (typeof v === 'boolean') return v;
    }
    return null;
}
function pickFromPaths(obj, paths) {
    if (!obj || typeof obj !== 'object') return null;
    for (const path of paths) {
        let cur = obj;
        let ok = true;
        for (const key of path) {
            if (!cur || typeof cur !== 'object' || !(key in cur)) {
                ok = false;
                break;
            }
            cur = cur[key];
        }
        if (ok) return cur;
    }
    return null;
}
function safeJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    return fallback;
}
function toIsoOrNull(value) {
    if (!value) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
}
function normalizeConversationMessages(payload) {
    const messages =
        pickFromPaths(payload, [['transcript'], ['conversation', 'transcript'], ['messages'], ['conversation', 'messages']]) || [];
    if (!Array.isArray(messages)) return [];
    return messages.map((entry, idx) => {
        const item = safeJson(entry, {});
        const messageId =
            firstNonEmptyString(
                item.id,
                item.message_id,
                item.uuid,
                item.turn_id,
                `${idx}:${String(item.role || item.speaker || '')}:${String(item.time || item.timestamp || '')}`
            ) || `${idx}`;
        return {
            conversation_id: '',
            message_id: messageId,
            role: firstNonEmptyString(item.role, item.speaker, item.source) || null,
            message: firstNonEmptyString(item.message, item.text, item.content, item.transcript) || null,
            time_value: firstNonEmptyString(item.time, item.timestamp, item.created_at) || null,
            raw_payload: item,
        };
    });
}
function normalizeConversationRow(payload, agentIdFallback = null) {
    const p = safeJson(payload, {});
    const usage = safeJson(pickFromPaths(p, [['usage'], ['token_usage'], ['conversation', 'usage']]), {});
    const meta = safeJson(pickFromPaths(p, [['metadata'], ['meta']]), {});
    const startedAt = toIsoOrNull(
        firstNonEmptyString(
            p.date,
            p.started_at,
            p.start_time_unix_secs ? new Date(Number(p.start_time_unix_secs) * 1000).toISOString() : null,
            pickFromPaths(p, [['conversation', 'started_at']])
        )
    );
    const endedAt = toIsoOrNull(
        firstNonEmptyString(
            p.ended_at,
            p.end_time_unix_secs ? new Date(Number(p.end_time_unix_secs) * 1000).toISOString() : null,
            pickFromPaths(p, [['conversation', 'ended_at']])
        )
    );
    return {
        conversation_id: firstNonEmptyString(p.conversation_id, p.id, pickFromPaths(p, [['conversation', 'id']])),
        agent_id: firstNonEmptyString(p.agent_id, pickFromPaths(p, [['agent', 'id']]), agentIdFallback),
        agent_name: firstNonEmptyString(p.agent_name, pickFromPaths(p, [['agent', 'name']])),
        user_id: firstNonEmptyString(p.user_id, p.userId, pickFromPaths(p, [['user', 'id']]), pickFromPaths(p, [['customer', 'id']])),
        customer_number: firstNonEmptyString(
            p.customer_number,
            p.customer_phone_number,
            pickFromPaths(p, [['customer', 'phone']]),
            pickFromPaths(p, [['caller', 'phone_number']])
        ),
        call_status: firstNonEmptyString(p.call_status, p.status, pickFromPaths(p, [['conversation', 'status']])),
        call_successful: firstBoolean(p.call_successful, p.success),
        direction: firstNonEmptyString(p.direction, pickFromPaths(p, [['conversation', 'direction']])),
        started_at: startedAt,
        ended_at: endedAt,
        call_duration_secs: firstFiniteNumber(p.call_duration_secs, p.call_duration_seconds, pickFromPaths(p, [['conversation', 'duration_secs']])),
        message_count: firstFiniteNumber(
            p.message_count,
            Array.isArray(p.transcript) ? p.transcript.length : null,
            Array.isArray(p.messages) ? p.messages.length : null
        ),
        overview_summary: firstNonEmptyString(p.overview_summary, p.summary),
        transcript_summary: firstNonEmptyString(p.transcript_summary, pickFromPaths(p, [['analysis', 'summary']])),
        call_summary_title: firstNonEmptyString(p.call_summary_title, p.title, pickFromPaths(p, [['analysis', 'title']])),
        latest_input: firstNonEmptyString(
            p.latest_input,
            pickFromPaths(p, [['latest_transcript', 'message']]),
            pickFromPaths(p, [['last_message', 'content']])
        ),
        audio_url: firstNonEmptyString(p.audio_url, p.audioUrl, pickFromPaths(p, [['audio', 'url']]), pickFromPaths(p, [['media', 'audio_url']])),
        recording_url: firstNonEmptyString(
            p.recording_url,
            p.recordingUrl,
            pickFromPaths(p, [['recording', 'url']]),
            pickFromPaths(p, [['media', 'recording_url']])
        ),
        call_cost: firstFiniteNumber(
            p.call_cost,
            p.cost,
            pickFromPaths(p, [['analysis', 'call_cost']]),
            pickFromPaths(p, [['metrics', 'cost']]),
            pickFromPaths(p, [['billing', 'cost']])
        ),
        tokens_prompt: firstFiniteNumber(usage.prompt_tokens, usage.input_tokens, p.tokens_prompt),
        tokens_completion: firstFiniteNumber(usage.completion_tokens, usage.output_tokens, p.tokens_completion),
        tokens_total: firstFiniteNumber(usage.total_tokens, p.tokens_total),
        metadata: meta,
        raw_payload: p,
    };
}
function normalizePhoneE164(input, defaultCountry = 'AU') {
    const raw = String(input ?? '').trim();
    if (!raw) return null;
    const normalizedPlus = raw.replace(/[^\d+]/g, '');
    if (normalizedPlus.startsWith('+')) {
        const compact = `+${normalizedPlus.slice(1).replace(/\D/g, '')}`;
        return /^\+\d{8,15}$/.test(compact) ? compact : null;
    }
    const digits = raw.replace(/\D/g, '');
    if (!digits) return null;
    if (digits.startsWith('00') && digits.length > 4) {
        const intl = `+${digits.slice(2)}`;
        return /^\+\d{8,15}$/.test(intl) ? intl : null;
    }
    const country = String(defaultCountry || 'AU').toUpperCase();
    if (country === 'AU') {
        if (digits.startsWith('0') && digits.length === 10) return `+61${digits.slice(1)}`;
        if (digits.startsWith('61') && digits.length >= 9) return `+${digits}`;
    }
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
}
function normalizeHubtigerOperation(opRaw) {
    const op = String(opRaw || '').trim();
    if (!op) return '';
    const map = {
        hubtiger_jobs_search: 'jobs_search',
        hubtiger_jobsearch: 'jobs_search',
        hubtiger_job_get: 'job_get',
        hubtiger_job_messages: 'job_messages',
        hubtiger_messages_unread: 'messages_unread',
        hubtiger_customer_search: 'customer_search',
        hubtiger_customer_create: 'customer_create',
        hubtiger_bookings_week_samples: 'bookings_week_samples',
        hubtiger_products_search: 'products_search',
        hubtiger_bike_create: 'bike_create',
        hubtiger_availability_search: 'availability_search',
        hubtiger_booking_find_earliest: 'booking_find_earliest',
        hubtiger_booking_find_earliest_auto: 'booking_find_earliest',
        booking_find_earliest_auto: 'booking_find_earliest',
        hubtiger_booking_create: 'booking_create',
        hubtiger_booking_amend_slot: 'booking_amend_slot',
        hubtiger_booking_amend: 'booking_amend',
        hubtiger_job_note_add: 'job_note_add',
        hubtiger_quote_add_line_item: 'quote_add_line_item',
        hubtiger_quote_find_add: 'quote_find_add',
        hubtiger_quote_find_add_and_request_approval: 'quote_find_add_and_request_approval',
        hubtiger_quote_request_approval: 'quote_request_approval',
        hubtiger_portal_call: 'portal_call',
        hubtiger_portal_mutation: 'portal_mutation',
    };
    return map[op] || op;
}
function parseTechnicianIds(raw) {
    if (Array.isArray(raw)) {
        return raw
            .map((v) => String(v ?? '').trim())
            .filter((v) => /^\d+$/.test(v));
    }
    if (raw && typeof raw === 'object') {
        if (Array.isArray(raw.ids)) return parseTechnicianIds(raw.ids);
        if (Array.isArray(raw.technicians)) return parseTechnicianIds(raw.technicians);
        if (Array.isArray(raw.defaultTechnicians)) return parseTechnicianIds(raw.defaultTechnicians);
    }
    const text = String(raw ?? '').trim();
    if (!text) return [];
    return text
        .split(',')
        .map((v) => v.trim())
        .filter((v) => /^\d+$/.test(v));
}
function resolveTechniciansCsv(payload, toolConfig) {
    const fromPayload = parseTechnicianIds(
        payload?.technicians
        ?? payload?.technicianIds
        ?? payload?.technician_ids
        ?? payload?.technicianId
    );
    if (fromPayload.length > 0) return fromPayload.join(',');

    const fromConfig = parseTechnicianIds(
        toolConfig?.defaultTechnicians
        ?? toolConfig?.technicians
        ?? toolConfig?.availability?.technicians
        ?? process.env.HUBTIGER_DEFAULT_TECHNICIANS
    );
    if (fromConfig.length > 0) return fromConfig.join(',');
    return '';
}
function extractTechniciansFromWeekSamplesPayload(data) {
    const samples = Array.isArray(data?.samples) ? data.samples : [];
    const unique = [];
    const seen = new Set();
    for (const row of samples) {
        const id = String(row?.technicianID ?? row?.technicianId ?? '').trim();
        if (!/^\d+$/.test(id) || seen.has(id)) continue;
        seen.add(id);
        unique.push(id);
    }
    return unique;
}
function signToken(user) {
    return jwt.sign({ sub: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
}
function parseAuthedUserFromRequest(req) {
    const token = parseBearerToken(req.headers?.authorization || '');
    if (!token) return null;
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const sub = String(decoded?.sub || '').trim();
        const email = String(decoded?.email || '').trim().toLowerCase();
        const role = String(decoded?.role || '').trim().toLowerCase();
        if (!sub || !email) return null;
        return { id: sub, email, role };
    } catch {
        return null;
    }
}
function buildSearchScope(req) {
    const auth = parseAuthedUserFromRequest(req);
    if (auth?.id) return { user_id: auth.id, scope_key: `user:${auth.id}` };
    const ip = String(req.headers['x-forwarded-for'] || req.ip || 'unknown').split(',')[0].trim();
    const ua = String(req.headers['user-agent'] || 'unknown').trim();
    const hash = crypto.createHash('sha256').update(`${ip}|${ua}`).digest('hex').slice(0, 24);
    return { user_id: null, scope_key: `anon:${hash}` };
}
function detectComparisonQuery(query) {
    return /\b(vs|versus)\b/i.test(String(query || ''));
}
function parseDateNaturalToken(raw) {
    const clean = String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/(\d+)(st|nd|rd|th)/g, '$1')
        .replace(/,/g, ' ');
    if (!clean) return null;
    const dt = new Date(clean);
    if (Number.isNaN(dt.getTime())) return null;
    return dt;
}
function extractDateRangeFromQuery(query) {
    const text = String(query || '');
    const range = text.match(/from\s+([0-9]{1,2}(?:st|nd|rd|th)?\s+[a-z]{3,9}\s+[0-9]{4})\s+(?:to|-)\s+([0-9]{1,2}(?:st|nd|rd|th)?\s+[a-z]{3,9}\s+[0-9]{4})/i);
    if (!range) return { fromIso: null, toIso: null };
    const from = parseDateNaturalToken(range[1]);
    const to = parseDateNaturalToken(range[2]);
    if (!from || !to) return { fromIso: null, toIso: null };
    const fromIso = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 0, 0, 0, 0)).toISOString();
    const toIso = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate(), 23, 59, 59, 999)).toISOString();
    return { fromIso, toIso };
}
function parseJsonFromLlmText(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {}
    const fenced = raw.match(/```json\s*([\s\S]*?)\s*```/i) || raw.match(/```\s*([\s\S]*?)\s*```/i);
    if (fenced && fenced[1]) {
        try {
            return JSON.parse(fenced[1].trim());
        } catch {}
    }
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        try {
            return JSON.parse(raw.slice(firstBrace, lastBrace + 1));
        } catch {}
    }
    return null;
}
const DOCKERED_SERVICE_KEYS = [
    'edge-gateway',
    'web-ui',
    'control-plane-api',
    'open-webui',
    'agent-ingress',
    'tool-proxy',
    'hubtiger-proxy',
    'hubtiger',
    'postgres',
    'qdrant',
    'redis',
    'glances',
    'n8n',
];
const REQUEST_LOG_SERVICE_BY_DOCKER_KEY = {
    'edge-gateway': ['edge-gateway'],
    'web-ui': ['web-ui'],
    'control-plane-api': ['control-plane-api'],
    'open-webui': ['open-webui'],
    'agent-ingress': ['agent-ingress'],
    'tool-proxy': ['tool-proxy'],
    'hubtiger-proxy': ['hubtiger-proxy'],
    'hubtiger': ['hubtiger'],
    'postgres': ['postgres'],
    'qdrant': ['qdrant'],
    'redis': ['redis'],
    'glances': ['glances'],
    'n8n': ['n8n'],
};
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        files: 200,
        fileSize: 50 * 1024 * 1024,
    },
});
const MAX_UPLOAD_FILE_BYTES = 50 * 1024 * 1024;
function formatByteSize(bytes) {
    const value = Number(bytes || 0);
    if (!Number.isFinite(value) || value <= 0) return '0 B';
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
function mapMulterUploadError(error) {
    const code = String(error?.code || '').trim();
    const field = String(error?.field || '').trim();
    if (code === 'LIMIT_FILE_SIZE') {
        return {
            status: 413,
            error: 'upload_file_too_large',
            hint: `One or more files exceed the ${formatByteSize(MAX_UPLOAD_FILE_BYTES)} per-file upload limit.`,
            code,
            field,
        };
    }
    if (code === 'LIMIT_FILE_COUNT') {
        return {
            status: 400,
            error: 'upload_too_many_files',
            hint: 'Too many files selected for one upload batch.',
            code,
            field,
        };
    }
    if (code === 'LIMIT_PART_COUNT' || code === 'LIMIT_FIELD_COUNT' || code === 'LIMIT_FIELD_KEY' || code === 'LIMIT_FIELD_VALUE') {
        return {
            status: 400,
            error: 'upload_payload_invalid',
            hint: 'Upload payload is malformed or exceeds multipart form limits.',
            code,
            field,
        };
    }
    if (error instanceof multer.MulterError) {
        return {
            status: 400,
            error: 'upload_multipart_error',
            hint: 'Upload request could not be parsed. Retry with fewer files or smaller payload.',
            code,
            field,
        };
    }
    return {
        status: 500,
        error: 'upload_multipart_error',
        hint: 'Upload request failed before ingestion processing started.',
        code,
        field,
    };
}
function runUploadMiddleware(req, res) {
    return new Promise((resolve, reject) => {
        upload.array('files', 200)(req, res, (error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}
function mapIngestionStorageError(error) {
    const rawMessage = String(error?.message || error || '').trim();
    const message = rawMessage || 'Upload failed while writing to storage.';
    if (
        /could not load credentials from any providers/i.test(message) ||
        /unable to locate credentials/i.test(message) ||
        /missing credentials/i.test(message) ||
        /credential/i.test(message)
    ) {
        return {
            status: 503,
            error: 's3_credentials_missing',
            hint: 'S3 credentials are missing. Configure access key and secret in Settings -> Knowledge Storage.',
            message,
        };
    }
    if (
        /access key id.*does not exist/i.test(message) ||
        /invalidaccesskeyid/i.test(message) ||
        /signaturedoesnotmatch/i.test(message) ||
        /security token included in the request is invalid/i.test(message)
    ) {
        return {
            status: 503,
            error: 's3_credentials_invalid',
            hint: 'S3 credentials were rejected by AWS. Rotate and update access key + secret in Settings -> Knowledge Storage.',
            message,
        };
    }
    if (/nosuchbucket/i.test(message) || /specified bucket does not exist/i.test(message)) {
        return {
            status: 503,
            error: 's3_bucket_not_found',
            hint: 'Configured S3 bucket was not found. Verify bucket name and region in Settings -> Knowledge Storage.',
            message,
        };
    }
    return {
        status: 500,
        error: 'ingestion_upload_failed',
        hint: 'Upload failed while writing to storage.',
        message,
    };
}
function buildS3Client(knowledgeSettings = {}) {
    const region = String(knowledgeSettings.s3_region || '').trim();
    if (!region) return null;
    const apiKey = String(knowledgeSettings.s3_api_key || '').trim();
    const apiToken = String(knowledgeSettings.s3_api_token || '').trim();
    if (apiKey && apiToken) {
        return new S3Client({
            region,
            credentials: {
                accessKeyId: apiKey,
                secretAccessKey: apiToken,
            },
        });
    }
    return new S3Client({ region });
}
const DEFAULT_GLANCES_LOCAL_URL = 'http://172.18.0.1:61208/api/4/all';
const METRIC_SOURCE_SEEDS = [
    {
        slug: 'ghost',
        label: 'Ghost',
        source_kind: 'glances',
        config: {
            url: String(process.env.GLANCES_GHOST_URL || DEFAULT_GLANCES_LOCAL_URL).trim(),
        },
    },
    {
        slug: 'one',
        label: 'One',
        source_kind: 'glances',
        config: {
            url: String(process.env.GLANCES_ONE_URL || '').trim(),
        },
    },
];
const INGESTION_STAGE_PROGRESS = {
    uploaded: 5,
    queued: 10,
    extracting: 25,
    ocr: 40,
    chunking: 60,
    embedding: 78,
    upserting: 90,
    qa: 96,
    completed: 100,
    failed: 100,
    cancelled: 0,
};
function normalizeMetricPayload(payload) {
    const source = payload && typeof payload === 'object' ? payload : {};
    return {
        cpu: source.cpu || null,
        mem: source.mem || null,
        fs: Array.isArray(source.fs) ? source.fs.slice(0, 12) : [],
        gpu: Array.isArray(source.gpu) ? source.gpu.slice(0, 4) : [],
        network: Array.isArray(source.network) ? source.network.slice(0, 8) : [],
        system: source.system || null,
        uptime: source.uptime || null,
        now: source.now || null,
    };
}
function normalizeUploadPath(raw) {
    return String(raw || '')
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/\.\.(\/|\\)/g, '')
        .trim();
}
function buildS3ObjectKey(relativePath, filename, prefix = '') {
    const parts = [
        String(prefix || '').trim().replace(/^\/+|\/+$/g, '') || 'ghostdash-ingestion',
        new Date().toISOString().slice(0, 10),
        normalizeUploadPath(relativePath),
        String(filename || 'upload.bin').trim(),
    ].filter(Boolean);
    return parts.join('/').replace(/\/+/g, '/');
}
function buildKnowledgeTestS3Prefix(basePrefix = '') {
    const normalized = String(basePrefix || '').trim().replace(/^\/+|\/+$/g, '') || 'ghostdash-ingestion';
    return `${normalized}/knowledge-test`;
}
function estimateCompletionAt(stage) {
    const msByStage = {
        uploaded: 8 * 60 * 1000,
        queued: 7 * 60 * 1000,
        extracting: 6 * 60 * 1000,
        ocr: 5 * 60 * 1000,
        chunking: 4 * 60 * 1000,
        embedding: 3 * 60 * 1000,
        upserting: 2 * 60 * 1000,
        qa: 60 * 1000,
        completed: 0,
        failed: 0,
        cancelled: 0,
    };
    const ms = msByStage[String(stage || 'queued')] ?? 5 * 60 * 1000;
    return ms > 0 ? new Date(Date.now() + ms).toISOString() : null;
}
function estimateTokenCount(text) {
    return Math.max(1, Math.ceil(String(text || '').length / 4));
}
function normalizeExtractedTextForEmbedding(text) {
    const raw = String(text || '').replace(/\u0000/g, '');
    if (!raw.trim()) return '';
    return raw
        .replace(/\r\n/g, '\n')
        .replace(/([A-Za-z])-\n([a-z])/g, '$1$2')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
        .replace(/[^\S\n]+/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
function measureEnglishLegibility(text) {
    const sample = String(text || '').slice(0, 12000);
    const sampleLength = sample.length;
    if (sampleLength === 0) {
        return {
            score: 0,
            sample_length: 0,
            alpha_ratio: 0,
            stopword_ratio: 0,
            symbol_ratio: 1,
            long_token_ratio: 1,
            stopword_hits: 0,
            token_count: 0,
        };
    }
    const alphaChars = (sample.match(/[A-Za-z]/g) || []).length;
    const symbolChars = (sample.match(/[^A-Za-z0-9\s.,;:!?'"()\-/%$&\n]/g) || []).length;
    const tokens = sample.toLowerCase().match(/[a-z]{2,}/g) || [];
    const stopwords = new Set([
        'the', 'and', 'for', 'that', 'with', 'from', 'this', 'your', 'you', 'are',
        'was', 'were', 'has', 'have', 'had', 'not', 'can', 'will', 'all', 'any',
        'our', 'their', 'his', 'her', 'its', 'who', 'what', 'when', 'where', 'why',
        'how', 'into', 'onto', 'about', 'there', 'which', 'would', 'should', 'could',
        'also', 'than', 'then', 'they', 'them', 'been', 'more', 'most', 'some', 'each',
        'use', 'used', 'using', 'per', 'page', 'document', 'section',
    ]);
    const stopwordHits = tokens.reduce((sum, token) => sum + (stopwords.has(token) ? 1 : 0), 0);
    const longTokenCount = tokens.reduce((sum, token) => sum + (token.length >= 24 ? 1 : 0), 0);
    const alphaRatio = alphaChars / Math.max(1, sampleLength);
    const stopwordRatio = stopwordHits / Math.max(1, tokens.length);
    const symbolRatio = symbolChars / Math.max(1, sampleLength);
    const longTokenRatio = longTokenCount / Math.max(1, tokens.length);

    let score = 1;
    if (alphaRatio < 0.55) score -= 0.35;
    else if (alphaRatio < 0.65) score -= 0.15;
    if (stopwordRatio < 0.015) score -= 0.28;
    else if (stopwordRatio < 0.03) score -= 0.12;
    if (symbolRatio > 0.12) score -= 0.3;
    else if (symbolRatio > 0.08) score -= 0.15;
    if (longTokenRatio > 0.25) score -= 0.18;
    else if (longTokenRatio > 0.12) score -= 0.1;
    score = Math.max(0, Math.min(1, Number(score.toFixed(4))));

    return {
        score,
        sample_length: sampleLength,
        alpha_ratio: Number(alphaRatio.toFixed(4)),
        stopword_ratio: Number(stopwordRatio.toFixed(4)),
        symbol_ratio: Number(symbolRatio.toFixed(4)),
        long_token_ratio: Number(longTokenRatio.toFixed(4)),
        stopword_hits: stopwordHits,
        token_count: tokens.length,
    };
}
function evaluateOcrLegibility(text, options = {}) {
    const cleanedText = normalizeExtractedTextForEmbedding(text);
    const minChars = Math.max(120, Math.min(5000, parsePositiveInt(options.ocr_legibility_min_chars, 220)));
    const parsedScore = Number(options.ocr_legibility_min_score);
    const minScore = Number.isFinite(parsedScore)
        ? Math.max(0.2, Math.min(0.95, parsedScore))
        : 0.55;
    const enforceEnglish = options.enforce_english_ocr === undefined ? true : options.enforce_english_ocr !== false;
    const metrics = measureEnglishLegibility(cleanedText);
    const reasons = [];

    if (cleanedText.length < minChars) reasons.push(`text_too_short:${cleanedText.length}<${minChars}`);
    if (metrics.score < minScore) reasons.push(`legibility_score_low:${metrics.score}<${minScore}`);
    if (metrics.alpha_ratio < 0.5) reasons.push(`alpha_ratio_low:${metrics.alpha_ratio}`);
    if (metrics.stopword_ratio < 0.01) reasons.push(`stopword_ratio_low:${metrics.stopword_ratio}`);
    if (metrics.symbol_ratio > 0.14) reasons.push(`symbol_ratio_high:${metrics.symbol_ratio}`);

    const compactLegibleOverride = cleanedText.length >= 40
        && metrics.token_count >= 4
        && metrics.score >= Math.max(0.5, minScore - 0.08)
        && metrics.alpha_ratio >= 0.55
        && metrics.symbol_ratio <= 0.08
        && reasons.every((reason) => reason.startsWith('text_too_short:') || reason.startsWith('stopword_ratio_low:'));

    return {
        passed: !enforceEnglish || reasons.length === 0 || compactLegibleOverride,
        cleaned_text: cleanedText,
        metrics,
        reasons,
        thresholds: {
            min_chars: minChars,
            min_score: minScore,
        },
        enforce_english_ocr: enforceEnglish,
        compact_legible_override: compactLegibleOverride,
        chars_removed: Math.max(0, String(text || '').length - cleanedText.length),
    };
}
async function recoverOcrLegibilityWithLlm({
    text,
    legibility,
    options = {},
    traceId = '',
    filename = '',
    mimeType = '',
}) {
    const recoveryEnabled = options.ocr_legibility_llm_recovery === undefined
        ? true
        : options.ocr_legibility_llm_recovery !== false;
    if (!recoveryEnabled) {
        return { attempted: false, reason: 'llm_recovery_disabled' };
    }
    const source = String(text || '');
    if (!source.trim()) {
        return { attempted: false, reason: 'empty_source_text' };
    }
    const llm = await loadDoclingHelperLlmConfig();
    if (!llm) {
        return { attempted: false, reason: 'llm_not_configured' };
    }
    const cappedSource = source.slice(0, 50000);
    const llmResult = await callConfiguredLlm({
        llm,
        trace_id: traceId,
        route: 'POST /internal/ocr-legibility-recovery',
        body: {
            model: llm.model_id,
            temperature: 0,
            max_tokens: 1800,
            response_format: { type: 'json_object' },
            messages: [
                {
                    role: 'system',
                    content: [
                        'You repair OCR text for embeddings.',
                        'Return strict JSON only: {"cleaned_text":"string","action":"trimmed_prefix|trimmed_noise|none","notes":[string]}.',
                        'Keep original order and wording for legible English text.',
                        'Remove OCR garbage/noise, especially garbage at the start, repeated header/footer clutter, broken symbols, and non-readable fragments.',
                        'Do not summarize. Do not invent facts. Do not add markdown.',
                    ].join(' '),
                },
                {
                    role: 'user',
                    content: JSON.stringify({
                        filename: String(filename || '').slice(0, 200),
                        mime_type: String(mimeType || '').slice(0, 120),
                        current_legibility: legibility,
                        ocr_text: cappedSource,
                    }),
                },
            ],
        },
    });
    if (!llmResult?.ok) {
        return {
            attempted: true,
            recovered: false,
            reason: firstNonEmptyString(llmResult?.message, llmResult?.error, 'llm_recovery_failed'),
        };
    }
    const rawText = String(extractLlmTextFromUpstreamBody(llmResult?.upstream_body || {}) || '').trim();
    const parsed = parseJsonFromLlmText(rawText) || {};
    const candidate = firstNonEmptyString(parsed?.cleaned_text, rawText);
    const recoveredText = normalizeExtractedTextForEmbedding(candidate || '');
    if (!recoveredText) {
        return { attempted: true, recovered: false, reason: 'llm_recovery_empty_output' };
    }
    return {
        attempted: true,
        recovered: true,
        recovered_text: recoveredText,
        action: firstNonEmptyString(parsed?.action, 'none'),
        notes: Array.isArray(parsed?.notes) ? parsed.notes.slice(0, 8).map((item) => String(item || '')) : [],
    };
}
function splitTextIntoChunks(text, maxChars = 1800, overlapChars = 180) {
    const input = String(text || '').trim();
    if (!input) return [];
    const words = input.split(/\s+/).filter(Boolean);
    const chunks = [];
    let current = '';
    for (const word of words) {
        const next = current ? `${current} ${word}` : word;
        if (next.length > maxChars && current) {
            chunks.push(current);
            const overlap = overlapChars > 0 ? current.slice(Math.max(0, current.length - overlapChars)).trim() : '';
            current = overlap ? `${overlap} ${word}` : word;
        } else {
            current = next;
        }
    }
    if (current) chunks.push(current);
    return chunks;
}
function normalizeEntityKey(label) {
    return String(label || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 180);
}
function extractCandidateEntities(text, maxEntities = 18) {
    const raw = String(text || '');
    if (!raw.trim()) return [];
    const out = [];
    const seen = new Set();
    const properNounMatches = raw.match(/\b[A-Z][A-Za-z0-9_-]{2,}(?:\s+[A-Z][A-Za-z0-9_-]{2,}){0,2}\b/g) || [];
    for (const label of properNounMatches) {
        const clean = String(label || '').trim();
        const key = normalizeEntityKey(clean);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push({ label: clean, entity_type: 'entity', confidence: 0.8 });
        if (out.length >= maxEntities) break;
    }
    const lowered = raw.toLowerCase();
    const domainTerms = ['policy', 'employee', 'employees', 'branch', 'location', 'warranty', 'customer', 'agent'];
    for (const term of domainTerms) {
        if (!lowered.includes(term)) continue;
        const key = normalizeEntityKey(term);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push({ label: term, entity_type: 'concept', confidence: 0.65 });
        if (out.length >= maxEntities) break;
    }
    return out;
}
function inferRelationType(sentence) {
    const s = String(sentence || '').toLowerCase();
    if (/\b(affect|impact|influence)\b/.test(s)) return 'affects';
    if (/\b(in|within|located|branch)\b/.test(s)) return 'located_in';
    if (/\b(require|needs|must)\b/.test(s)) return 'requires';
    return 'co_occurs_with';
}
function extractCandidateRelationships(text, entityLabels = []) {
    const labels = Array.from(new Set(entityLabels.map((x) => String(x || '').trim()).filter(Boolean)));
    if (labels.length < 2) return [];
    const sentences = String(text || '')
        .split(/[\n.!?]/)
        .map((s) => s.trim())
        .filter(Boolean);
    const edges = [];
    const seen = new Set();
    for (const sentence of sentences.slice(0, 24)) {
        const present = labels.filter((label) => sentence.toLowerCase().includes(label.toLowerCase())).slice(0, 6);
        if (present.length < 2) continue;
        const relation_type = inferRelationType(sentence);
        for (let i = 0; i < present.length - 1; i++) {
            for (let j = i + 1; j < present.length; j++) {
                const source = present[i];
                const target = present[j];
                const key = `${normalizeEntityKey(source)}|${normalizeEntityKey(target)}|${relation_type}`;
                if (seen.has(key)) continue;
                seen.add(key);
                edges.push({ source, target, relation_type, weight: 0.7 });
            }
        }
    }
    return edges;
}
async function upsertKnowledgeEntity({ label, entity_type = 'concept', metadata = {} }) {
    const entityKey = normalizeEntityKey(label);
    if (!entityKey) return null;
    const q = await pool.query(
        `INSERT INTO knowledge_entities (entity_key, label, entity_type, metadata, updated_at)
         VALUES ($1,$2,$3,$4::jsonb, now())
         ON CONFLICT (entity_key) DO UPDATE
         SET label = EXCLUDED.label,
             entity_type = EXCLUDED.entity_type,
             metadata = knowledge_entities.metadata || EXCLUDED.metadata,
             updated_at = now()
         RETURNING id, label, entity_type`,
        [entityKey, String(label || '').trim(), String(entity_type || 'concept'), JSON.stringify(metadata || {})]
    );
    return q.rows[0] || null;
}
async function buildKnowledgeGraphForChunks({ jobId, chunkRecords = [], traceId = '' }) {
    if (!jobId || !Array.isArray(chunkRecords) || chunkRecords.length === 0) {
        return { entities: 0, relationships: 0, links: 0 };
    }
    const runStart = await pool.query(
        `INSERT INTO knowledge_graph_runs (job_id, status, summary, updated_at)
         VALUES ($1::uuid, 'running', '{}'::jsonb, now())
         RETURNING id`,
        [jobId]
    );
    const runId = runStart.rows?.[0]?.id || null;
    let entitiesCount = 0;
    let linksCount = 0;
    let relationshipCount = 0;
    try {
        for (const chunk of chunkRecords) {
            const chunkId = String(chunk?.id || '').trim();
            const content = String(chunk?.content || '').trim();
            if (!chunkId || !content) continue;
            const entities = extractCandidateEntities(content);
            const entityRows = [];
            for (const entity of entities) {
                const row = await upsertKnowledgeEntity({
                    label: entity.label,
                    entity_type: entity.entity_type,
                    metadata: { source: 'ingestion', confidence: entity.confidence, trace_id: traceId || null },
                });
                if (!row?.id) continue;
                entityRows.push(row);
                entitiesCount += 1;
                await pool.query(
                    `INSERT INTO knowledge_chunk_entities (chunk_id, entity_id, confidence, metadata)
                     VALUES ($1::uuid,$2::uuid,$3,$4::jsonb)
                     ON CONFLICT (chunk_id, entity_id) DO UPDATE
                     SET confidence = GREATEST(knowledge_chunk_entities.confidence, EXCLUDED.confidence),
                         metadata = knowledge_chunk_entities.metadata || EXCLUDED.metadata`,
                    [chunkId, row.id, Number(entity.confidence || 0.7), JSON.stringify({ chunk_index: chunk.chunk_index ?? null })]
                );
                linksCount += 1;
            }
            const rels = extractCandidateRelationships(content, entityRows.map((e) => e.label));
            const byLabel = new Map(entityRows.map((e) => [String(e.label || '').toLowerCase(), e.id]));
            for (const rel of rels) {
                const sourceId = byLabel.get(String(rel.source || '').toLowerCase());
                const targetId = byLabel.get(String(rel.target || '').toLowerCase());
                if (!sourceId || !targetId || sourceId === targetId) continue;
                await pool.query(
                    `INSERT INTO knowledge_relationships (source_entity_id, target_entity_id, relation_type, weight, metadata, updated_at)
                     VALUES ($1::uuid,$2::uuid,$3,$4,$5::jsonb, now())
                     ON CONFLICT (source_entity_id, target_entity_id, relation_type) DO UPDATE
                     SET weight = GREATEST(knowledge_relationships.weight, EXCLUDED.weight),
                         metadata = knowledge_relationships.metadata || EXCLUDED.metadata,
                         updated_at = now()`,
                    [sourceId, targetId, String(rel.relation_type || 'co_occurs_with'), Number(rel.weight || 0.7), JSON.stringify({ chunk_id: chunkId })]
                );
                relationshipCount += 1;
            }
        }
        if (runId) {
            await pool.query(
                `UPDATE knowledge_graph_runs
                 SET status = 'completed',
                     summary = $2::jsonb,
                     updated_at = now()
                 WHERE id = $1::uuid`,
                [runId, JSON.stringify({ entities: entitiesCount, relationships: relationshipCount, links: linksCount })]
            );
        }
        return { entities: entitiesCount, relationships: relationshipCount, links: linksCount };
    }
    catch (error) {
        if (runId) {
            await pool.query(
                `UPDATE knowledge_graph_runs
                 SET status = 'failed',
                     error = $2,
                     updated_at = now()
                 WHERE id = $1::uuid`,
                [runId, String(error?.message || error)]
            );
        }
        throw error;
    }
}
function deterministicVector(text, size) {
    const cleanSize = Math.max(8, Math.min(4096, Number(size) || 1536));
    const input = String(text || '');
    const out = new Array(cleanSize).fill(0);
    for (let i = 0; i < input.length; i++) {
        const code = input.charCodeAt(i);
        const idx = i % cleanSize;
        out[idx] += ((code % 31) - 15) / 15;
    }
    const magnitude = Math.sqrt(out.reduce((sum, v) => sum + v * v, 0)) || 1;
    return out.map((v) => Number((v / magnitude).toFixed(6)));
}
async function readStreamToBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}
async function getS3ObjectBuffer(storageKey, storageBucket, knowledgeSettings = {}) {
    const bucket = String(storageBucket || knowledgeSettings.s3_bucket || '').trim();
    const client = buildS3Client(knowledgeSettings);
    if (!client || !bucket) {
        throw new Error('s3_not_configured');
    }
    const response = await client.send(new GetObjectCommand({
        Bucket: bucket,
        Key: storageKey,
    }));
    if (response.Body?.transformToByteArray) {
        const bytes = await response.Body.transformToByteArray();
        return Buffer.from(bytes);
    }
    return readStreamToBuffer(response.Body);
}
async function putS3ObjectBuffer(storageKey, buffer, contentType, metadata = {}, knowledgeSettings = {}) {
    const bucket = String(knowledgeSettings.s3_bucket || '').trim();
    const client = buildS3Client(knowledgeSettings);
    if (!client || !bucket) {
        throw new Error('s3_not_configured');
    }
    await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: storageKey,
        Body: buffer,
        ContentType: contentType || 'application/octet-stream',
        Metadata: Object.fromEntries(
            Object.entries(metadata || {})
                .filter(([, value]) => value !== undefined && value !== null)
                .map(([key, value]) => [String(key).toLowerCase(), String(value)])
        ),
    }));
}
function normalizeOcrLanguages(value) {
    const raw = Array.isArray(value)
        ? value.map((v) => String(v || '').trim())
        : String(value || '')
            .split(',')
            .map((v) => v.trim());
    const out = [];
    for (const item of raw) {
        if (!item) continue;
        if (out.includes(item)) continue;
        out.push(item);
    }
    return out.slice(0, 8);
}

function isTextLikeDocument(mimeType, filename) {
    const safeMime = String(mimeType || '').toLowerCase();
    const lowerName = String(filename || '').toLowerCase();
    return (
        safeMime.startsWith('text/')
        || safeMime.includes('json')
        || safeMime.includes('xml')
        || safeMime.includes('javascript')
        || safeMime.includes('csv')
        || safeMime.includes('markdown')
        || /\.(txt|md|json|csv|xml|html?|ts|tsx|js|jsx|sql|log)$/i.test(lowerName)
    );
}
function isSpreadsheetDocument(mimeType, filename) {
    const safeMime = String(mimeType || '').toLowerCase();
    const lowerName = String(filename || '').toLowerCase();
    return (
        safeMime.includes('spreadsheetml.sheet')
        || safeMime.includes('ms-excel')
        || safeMime.includes('excel.sheet.binary')
        || safeMime.includes('application/vnd.ms-excel.sheet.macroenabled')
        || safeMime.includes('opendocument.spreadsheet')
        || /\.(xlsx|xlsm|xls|xlsb|ods)$/i.test(lowerName)
    );
}

const PREINGEST_PREVIEW_MAX_LINES = 20;
const PREINGEST_PREVIEW_MAX_CHARS = 12000;

function preIngestPrintableAsciiRatio(text) {
    const s = String(text || '');
    if (!s) return 1;
    let good = 0;
    for (let i = 0; i < s.length; i += 1) {
        const c = s.charCodeAt(i);
        if (c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 0x10ffff)) good += 1;
    }
    return good / s.length;
}

/** Best-effort first ~20 lines for pre-ingest LLM gate. */
async function extractPreIngestPreviewLinesBestEffort(buffer, mimeType, filename) {
    const meta = { method: 'utf8_lines', line_count: 0, truncated: false };
    if (!buffer || buffer.length === 0) {
        return { preview_text: '', ...meta, method: 'empty' };
    }
    if (isSpreadsheetDocument(mimeType, filename)) {
        try {
            const extracted = await extractSpreadsheetDocumentTextWithFallback(buffer, mimeType, filename);
            const text = String(extracted?.text || '').replace(/\0/g, '');
            const lines = text.split(/\r?\n/);
            meta.line_count = Math.min(lines.length, PREINGEST_PREVIEW_MAX_LINES);
            let out = lines.slice(0, PREINGEST_PREVIEW_MAX_LINES).join('\n');
            if (out.length > PREINGEST_PREVIEW_MAX_CHARS) {
                out = out.slice(0, PREINGEST_PREVIEW_MAX_CHARS);
                meta.truncated = true;
            }
            return {
                preview_text: out,
                ...meta,
                method: String(extracted?.mode || extracted?.processor || 'spreadsheet_extract'),
            };
        } catch (error) {
            const detail = String(error?.message || error);
            if (detail.startsWith('spreadsheet_encrypted_not_supported:')) {
                return { preview_text: '', ...meta, method: 'spreadsheet_encrypted', line_count: 0 };
            }
            // Fall back to generic binary-safe preview path below.
        }
    }
    if (isTextLikeDocument(mimeType, filename)) {
        const text = buffer.toString('utf8').replace(/\0/g, '');
        const lines = text.split(/\r?\n/);
        meta.line_count = Math.min(lines.length, PREINGEST_PREVIEW_MAX_LINES);
        let out = lines.slice(0, PREINGEST_PREVIEW_MAX_LINES).join('\n');
        if (out.length > PREINGEST_PREVIEW_MAX_CHARS) {
            out = out.slice(0, PREINGEST_PREVIEW_MAX_CHARS);
            meta.truncated = true;
        }
        return { preview_text: out, ...meta };
    }
    const pdfLike = String(mimeType || '').toLowerCase() === 'application/pdf'
        || String(filename || '').toLowerCase().endsWith('.pdf');
    if (pdfLike) {
        try {
            const extracted = await extractTextFromBuffer(
                buffer,
                mimeType,
                filename,
                {
                    ocr_engine: 'docling',
                    ocr_mode: 'balanced',
                    ocr_extract_tables: false,
                    ocr_extract_layout: false,
                    ocr_fallback_to_text: true,
                    ocr_languages: ['en'],
                    ocr_dpi: 200,
                },
                '',
                crypto.randomUUID()
            );
            const text = String(extracted?.text || '').replace(/\0/g, '');
            if (text.trim()) {
                const lines = text.split(/\r?\n/);
                meta.line_count = Math.min(lines.length, PREINGEST_PREVIEW_MAX_LINES);
                let out = lines.slice(0, PREINGEST_PREVIEW_MAX_LINES).join('\n');
                if (out.length > PREINGEST_PREVIEW_MAX_CHARS) {
                    out = out.slice(0, PREINGEST_PREVIEW_MAX_CHARS);
                    meta.truncated = true;
                }
                return {
                    preview_text: out,
                    ...meta,
                    method: String(extracted?.mode || extracted?.processor || 'pdf_extract'),
                };
            }
        } catch {
            // Fall back to generic binary-safe preview path below.
        }
    }
    const maxSlice = Math.min(buffer.length, 65536);
    const utf8Try = buffer.subarray(0, maxSlice).toString('utf8').replace(/\0/g, ' ');
    const ratio = preIngestPrintableAsciiRatio(utf8Try);
    if (ratio >= 0.82) {
        const lines = utf8Try.split(/\r?\n/);
        meta.line_count = Math.min(lines.length, PREINGEST_PREVIEW_MAX_LINES);
        let out = lines.slice(0, PREINGEST_PREVIEW_MAX_LINES).join('\n');
        if (out.length > PREINGEST_PREVIEW_MAX_CHARS) {
            out = out.slice(0, PREINGEST_PREVIEW_MAX_CHARS);
            meta.truncated = true;
        }
        meta.method = 'utf8_snippet_binary';
        return { preview_text: out, ...meta };
    }
    const slice = buffer.subarray(0, 320);
    const hex = Buffer.from(slice).toString('hex');
    const pseudoLines = hex.match(/.{1,64}/g) || [hex];
    const lineCount = Math.min(pseudoLines.length, PREINGEST_PREVIEW_MAX_LINES);
    meta.method = 'hex_pseudo_lines';
    meta.line_count = lineCount;
    return { preview_text: pseudoLines.slice(0, lineCount).join('\n'), ...meta };
}
function shouldBypassPdfBinaryPrecheck({ mimeType, filename, previewText = '', previewMethod = '' }) {
    const pdfLike = String(mimeType || '').toLowerCase() === 'application/pdf'
        || String(filename || '').toLowerCase().endsWith('.pdf');
    if (!pdfLike) return false;
    const method = String(previewMethod || '').toLowerCase();
    if (!['hex_pseudo_lines', 'utf8_snippet_binary', 'binary_docling'].includes(method)) return false;
    const sample = String(previewText || '').slice(0, 1000);
    // Typical PDF structure tokens that appear when text extraction fails and raw bytes are shown.
    return /(%PDF-|\/Type\s*\/Page|\/Contents|\/Filter|stream|endstream|xref|trailer|obj|endobj)/i.test(sample);
}
function shouldBypassPdfLegitimacyVerdict({ mimeType, filename, verdictReason = '' }) {
    const pdfLike = String(mimeType || '').toLowerCase() === 'application/pdf'
        || String(filename || '').toLowerCase().endsWith('.pdf');
    if (!pdfLike) return false;
    const reason = String(verdictReason || '').toLowerCase();
    return (
        reason.includes('raw pdf binary')
        || reason.includes('binary/object')
        || reason.includes('binary/structure')
        || reason.includes('compressed stream')
        || reason.includes('pdf extraction noise')
    );
}

/** Heuristic encrypted Office / PDF (no password cracking; metadata-only signal). */
function detectLikelyEncryptedOfficeBuffer(buffer, mimeType, filename) {
    if (!buffer || buffer.length < 4) return { encrypted: false, signal: 'none' };
    const lowerMime = String(mimeType || '').toLowerCase();
    const lowerName = String(filename || '').toLowerCase();
    const officeLike = /\.(xlsx|xlsm|docx|pptx|xls|doc|ppt|ods|odt|odp)$/i.test(lowerName)
        || lowerMime.includes('officedocument')
        || lowerMime.includes('ms-excel')
        || lowerMime.includes('msword')
        || lowerMime.includes('powerpoint')
        || lowerMime.includes('opendocument');
    const pdfLike = lowerMime === 'application/pdf' || lowerName.endsWith('.pdf');
    if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
        const scan = Math.min(buffer.length, 524288);
        const s = buffer.subarray(0, scan).toString('latin1');
        if (s.includes('EncryptionInfo') || s.includes('EncryptedPackage')) {
            return { encrypted: true, signal: 'zip_encryption_marker' };
        }
    }
    if (buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0) {
        const scan = Math.min(buffer.length, 262144);
        if (buffer.subarray(0, scan).toString('latin1').includes('EncryptionInfo')) {
            return { encrypted: true, signal: 'ole_encryption_marker' };
        }
    }
    if (pdfLike) {
        const head = buffer.subarray(0, Math.min(16384, buffer.length)).toString('latin1');
        if (/\/Encrypt[\s<]/i.test(head)) {
            // PDFs can carry an /Encrypt dictionary for permissions/security metadata
            // while still being readable without a user password. Do not hard-reject
            // them here; let the actual extractor determine readability.
            return { encrypted: false, signal: 'pdf_encrypt_dictionary_present' };
        }
    }
    if (officeLike && buffer[0] === 0x50 && buffer[1] === 0x4b) {
        return { encrypted: false, signal: 'zip_office_unencrypted_heuristic' };
    }
    return { encrypted: false, signal: 'none' };
}

function classifyIngestionFileGroup(mimeType, filename) {
    if (isSpreadsheetDocument(mimeType, filename)) return 'group_2';
    if (isTextLikeDocument(mimeType, filename)) return 'group_1';
    return 'group_2';
}
function applyPerFileIngestionRoutePolicy(options, mimeType, filename) {
    const base = options && typeof options === 'object' ? { ...options } : {};
    const ingestGroup = classifyIngestionFileGroup(mimeType, filename);
    const explicitGroup1Override = base.allow_group_1_ocr_override === true;
    if (ingestGroup === 'group_1') {
        const effectiveOptions = explicitGroup1Override
            ? {
                ...base,
                ingest_route_group: ingestGroup,
                ingest_route_policy: 'group_1_explicit_override',
            }
            : {
                ...base,
                ocr_engine: 'native_text',
                ocr_mode: 'text_direct',
                ocr_extract_tables: false,
                ocr_extract_layout: false,
                ingest_route_group: ingestGroup,
                ingest_route_policy: 'group_1_text_direct',
            };
        return {
            ingest_group: ingestGroup,
            ingest_route_policy: String(effectiveOptions.ingest_route_policy),
            explicit_override_used: explicitGroup1Override,
            effective_options: effectiveOptions,
        };
    }
    if (isSpreadsheetDocument(mimeType, filename)) {
        const effectiveOptions = {
            ...base,
            ocr_engine: 'spreadsheet_parser',
            ocr_mode: 'structured_extract',
            ocr_extract_tables: true,
            ocr_extract_layout: false,
            chunk_chars: Math.max(900, Math.min(1400, parsePositiveInt(base.chunk_chars, 1400))),
            overlap_chars: Math.max(180, Math.min(400, parsePositiveInt(base.overlap_chars, 280))),
            ingest_route_group: ingestGroup,
            ingest_route_policy: 'group_2_spreadsheet_parser',
        };
        return {
            ingest_group: ingestGroup,
            ingest_route_policy: String(effectiveOptions.ingest_route_policy),
            explicit_override_used: false,
            effective_options: effectiveOptions,
        };
    }
    const effectiveOptions = {
        ...base,
        ocr_engine: 'docling',
        ocr_mode: ['balanced', 'high_accuracy'].includes(String(base.ocr_mode || '').trim().toLowerCase()) ? String(base.ocr_mode).trim().toLowerCase() : 'balanced',
        ocr_extract_tables: true,
        ocr_extract_layout: true,
        chunk_chars: Math.max(900, Math.min(1400, parsePositiveInt(base.chunk_chars, 1300))),
        overlap_chars: Math.max(180, Math.min(420, parsePositiveInt(base.overlap_chars, 240))),
        ingest_route_group: ingestGroup,
        ingest_route_policy: 'group_2_parser_ocr',
    };
    return {
        ingest_group: ingestGroup,
        ingest_route_policy: String(effectiveOptions.ingest_route_policy),
        explicit_override_used: false,
        effective_options: effectiveOptions,
    };
}

const INGEST_EXT_CHUNK_PROFILES = {
    '.md': { chunk_chars: 2200, overlap_chars: 220 },
    '.txt': { chunk_chars: 2000, overlap_chars: 200 },
    '.csv': { chunk_chars: 1800, overlap_chars: 180 },
    '.json': { chunk_chars: 2000, overlap_chars: 200 },
    '.html': { chunk_chars: 1600, overlap_chars: 200 },
    '.htm': { chunk_chars: 1600, overlap_chars: 200 },
    '.xml': { chunk_chars: 1800, overlap_chars: 200 },
    '.pdf': { chunk_chars: 1200, overlap_chars: 240 },
    '.docx': { chunk_chars: 1300, overlap_chars: 240 },
    '.pptx': { chunk_chars: 1300, overlap_chars: 240 },
    '.xlsx': { chunk_chars: 1400, overlap_chars: 280 },
    '.xls': { chunk_chars: 1400, overlap_chars: 280 },
    '.png': { chunk_chars: 1000, overlap_chars: 200 },
    '.jpg': { chunk_chars: 1000, overlap_chars: 200 },
    '.jpeg': { chunk_chars: 1000, overlap_chars: 200 },
};

function applyFilenameChunkProfile(options, filename) {
    const ext = path.extname(String(filename || '')).toLowerCase();
    const profile = INGEST_EXT_CHUNK_PROFILES[ext];
    if (!profile) return { ...options };
    return { ...options, ...profile };
}

function deterministicPreIngestLegitimacyFallback(previewText, mimeType, filename) {
    const t = String(previewText || '').trim();
    const printableRatio = preIngestPrintableAsciiRatio(t);
    const alphaChars = (t.match(/[A-Za-z]/g) || []).length;
    const totalChars = Math.max(1, t.length);
    const alphaRatio = alphaChars / totalChars;
    const rounded = (value) => Math.round(Math.max(0, Math.min(1, Number(value || 0))) * 1000) / 1000;
    const baseEnglishScore = rounded((printableRatio * 0.35) + (Math.min(1, alphaRatio * 8) * 0.65));
    const baseLegitimacyScore = rounded((printableRatio * 0.55) + (Math.min(1, alphaRatio * 6) * 0.30) + (t ? 0.15 : 0));
    const withScores = (payload = {}) => ({
        suitable: payload.suitable === true,
        reason: String(payload.reason || '').trim() || (payload.suitable === true ? 'heuristic_ok' : 'heuristic_reject'),
        source: String(payload.source || 'deterministic_fallback').trim() || 'deterministic_fallback',
        english_score: rounded(payload.english_score ?? baseEnglishScore),
        legitimacy_score: rounded(payload.legitimacy_score ?? baseLegitimacyScore),
    });
    if (!t) {
        return withScores({ suitable: false, reason: 'empty_preview', english_score: 0, legitimacy_score: 0 });
    }
    if (t.length < 12 && !isTextLikeDocument(mimeType, filename)) {
        return withScores({ suitable: true, reason: 'short_binary_preview_allowed', english_score: 0.4, legitimacy_score: 0.72 });
    }
    if (printableRatio < 0.55) {
        return withScores({ suitable: false, reason: 'low_printable_ratio_suspected_binary', english_score: 0.08, legitimacy_score: 0.12 });
    }
    if (isSpreadsheetDocument(mimeType, filename)) {
        if (alphaRatio < 0.03) {
            return withScores({ suitable: false, reason: 'spreadsheet_low_language_signal', english_score: 0.14, legitimacy_score: 0.24 });
        }
    }
    return withScores({
        suitable: true,
        reason: 'heuristic_ok',
        english_score: Math.max(baseEnglishScore, 0.58),
        legitimacy_score: Math.max(baseLegitimacyScore, 0.68),
    });
}

/** Placeholder hook: uses dashboard LLM when configured; else deterministic_fallback. */
async function runPreIngestLegitimacyVerdict({ previewText, mimeType, filename, traceId }) {
    const fallback = () => deterministicPreIngestLegitimacyFallback(previewText, mimeType, filename);
    try {
        const llm = await loadDoclingHelperLlmConfig();
        if (!llm) {
            const f = fallback();
            return { ...f, marked_fallback: true };
        }
        const userPrompt = [
            'You are a document intake gatekeeper.',
            'Return strict JSON only: {"suitable":true|false,"reason":"short text","english_score":0.0-1.0,"legitimacy_score":0.0-1.0}',
            'suitable=true only if the excerpt looks like legitimate business/technical/plain content suitable for a knowledge base.',
            'suitable=false for obvious spam, malware markers, huge non-text gibberish, or empty useless content.',
            'For spreadsheets, reject if the first lines are clearly non-English/noise-only or illegitimate synthetic junk.',
            'english_score must estimate whether the excerpt looks readable and meaningfully English-like on a 0..1 scale.',
            'legitimacy_score must estimate whether the excerpt looks like legitimate ingest-worthy business/technical content on a 0..1 scale.',
            `filename: ${filename}`,
            `mime: ${mimeType}`,
            '--- excerpt (first lines) ---',
            String(previewText || '').slice(0, 6000),
        ].join('\n');
        const llmResult = await callConfiguredLlm({
            llm,
            trace_id: traceId || '',
            route: 'pre_ingest_legitimacy_gate',
            body: {
                model: llm.model_id,
                temperature: 0,
                max_tokens: 200,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: 'Return only JSON with keys suitable (boolean), reason (string), english_score (0..1 number), legitimacy_score (0..1 number).' },
                    { role: 'user', content: userPrompt },
                ],
            },
        });
        if (!llmResult.ok) {
            const f = fallback();
            return { ...f, marked_fallback: true, llm_error: llmResult.error || 'llm_call_failed' };
        }
        const body = llmResult.upstream_body || {};
        const text = extractLlmTextFromUpstreamBody(body) || '';
        const parsed = parseJsonFromLlmText(text);
        if (parsed && typeof parsed.suitable === 'boolean') {
            const fallbackScores = fallback();
            return {
                suitable: parsed.suitable,
                reason: String(parsed.reason || '').slice(0, 500) || (parsed.suitable ? 'llm_ok' : 'llm_rejected'),
                source: 'llm',
                english_score: Number.isFinite(Number(parsed.english_score))
                    ? Math.round(Math.max(0, Math.min(1, Number(parsed.english_score))) * 1000) / 1000
                    : fallbackScores.english_score,
                legitimacy_score: Number.isFinite(Number(parsed.legitimacy_score))
                    ? Math.round(Math.max(0, Math.min(1, Number(parsed.legitimacy_score))) * 1000) / 1000
                    : fallbackScores.legitimacy_score,
            };
        }
        const f = fallback();
        return { ...f, marked_fallback: true, llm_parse_failed: true };
    } catch (e) {
        const f = fallback();
        return { ...f, marked_fallback: true, exception: String(e?.message || e) };
    }
}

async function createIngestionUploadBatchRow(traceId) {
    const r = await pool.query(
        `INSERT INTO ingestion_upload_batches (trace_id, status, precheck_summary)
         VALUES ($1::uuid, 'open', '{}'::jsonb)
         RETURNING id`,
        [traceId || null]
    );
    return r.rows[0]?.id || null;
}

async function finalizeIngestionUploadBatchSummary(batchId, summaryPatch) {
    if (!batchId) return;
    const safe = stripUnsupportedJsonUnicode(summaryPatch || {});
    await pool.query(
        `UPDATE ingestion_upload_batches
         SET precheck_summary = precheck_summary || $2::jsonb,
             status = 'closed',
             updated_at = now()
         WHERE id = $1::uuid`,
        [batchId, JSON.stringify(safe)]
    );
}

function normalizeSpreadsheetCellText(value) {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value && typeof value === 'object') {
        if (Array.isArray(value.richText)) {
            return value.richText.map((part) => String(part?.text || '')).join('');
        }
        if (Object.prototype.hasOwnProperty.call(value, 'text') && typeof value.text === 'string') {
            return value.text;
        }
        if (Object.prototype.hasOwnProperty.call(value, 'result')) {
            return normalizeSpreadsheetCellText(value.result);
        }
    }
    return String(value);
}
function isSpreadsheetEncryptedError(detail) {
    return /password|encrypted|crypt|unsupported encryption|protected/i.test(String(detail || ''));
}
function runDockerSandboxCommand(args, { containerName, timeoutMs }) {
    return new Promise((resolve, reject) => {
        const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let timedOut = false;

        const timeout = setTimeout(() => {
            timedOut = true;
            try {
                execFileSync('docker', ['stop', '-t', '2', containerName], { stdio: 'ignore' });
            } catch {
                // Best-effort stop. Continue to kill attempt.
            }
            setTimeout(() => {
                try {
                    execFileSync('docker', ['kill', containerName], { stdio: 'ignore' });
                } catch {
                    // Best-effort kill.
                }
            }, 1200);
        }, timeoutMs);

        child.stdout.on('data', (chunk) => {
            stdout += String(chunk);
        });
        child.stderr.on('data', (chunk) => {
            stderr += String(chunk);
        });
        child.on('error', (error) => {
            clearTimeout(timeout);
            reject(error);
        });
        child.on('close', (code) => {
            clearTimeout(timeout);
            if (code === 0 && !timedOut) {
                resolve({ stdout, stderr });
                return;
            }
            const label = timedOut ? 'spreadsheet_sandbox_timeout' : 'spreadsheet_sandbox_failed';
            reject(new Error(`${label}:${stderr || stdout || `exit_${code}`}`));
        });
    });
}
async function extractTextFromSpreadsheetViaSandboxCsv(buffer, filename = 'spreadsheet.xlsx') {
    const image = String(process.env.SPREADSHEET_SANDBOX_IMAGE || 'ghost-ai-dashboard-control-plane-api').trim() || 'ghost-ai-dashboard-control-plane-api';
    const timeoutMs = Math.max(5000, Math.min(45000, parsePositiveInt(process.env.SPREADSHEET_SANDBOX_TIMEOUT_MS, 15000)));
    const cpuLimit = String(process.env.SPREADSHEET_SANDBOX_CPUS || '0.5').trim() || '0.5';
    const memoryLimit = String(process.env.SPREADSHEET_SANDBOX_MEMORY || '256m').trim() || '256m';
    const pidsLimit = String(process.env.SPREADSHEET_SANDBOX_PIDS || '64').trim() || '64';
    const sandboxRoot = mkdtempSync(path.join(tmpdir(), 'ghostdash-xlsx-'));
    const inputDir = path.join(sandboxRoot, 'input');
    const outputDir = path.join(sandboxRoot, 'output');
    const inputPath = path.join(inputDir, 'source.xlsx');
    const runnerPath = path.join(inputDir, 'runner.cjs');
    const outputPath = path.join(outputDir, 'result.json');
    const errorPath = path.join(outputDir, 'error.txt');
    const containerName = `ghostdash-xlsx-${crypto.randomUUID().slice(0, 10)}`;

    try {
        mkdirSync(inputDir, { recursive: true });
        mkdirSync(outputDir, { recursive: true });
        chmodSync(outputDir, 0o777);
        writeFileSync(inputPath, buffer);
        writeFileSync(
            runnerPath,
            [
                "const fs = require('fs');",
                "const XLSX = require('xlsx');",
                'try {',
                "  const workbook = XLSX.readFile('/input/source.xlsx', {",
                '    cellFormula: false,',
                '    cellHTML: false,',
                '    cellNF: false,',
                '    cellText: true,',
                '    dense: true,',
                '  });',
                '  const out = { sheets: [] };',
                "  const names = Array.isArray(workbook.SheetNames) ? workbook.SheetNames : [];",
                '  for (const sheetName of names) {',
                '    const ws = workbook.Sheets && workbook.Sheets[sheetName];',
                '    if (!ws) continue;',
                "    const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false }).trim();",
                '    if (csv) out.sheets.push({ name: sheetName, csv });',
                '  }',
                "  fs.writeFileSync('/output/result.json', JSON.stringify(out));",
                '} catch (error) {',
                "  const detail = (error && error.message) ? error.message : String(error || 'unknown_error');",
                "  fs.writeFileSync('/output/error.txt', detail);",
                '  process.exit(1);',
                '}',
                '',
            ].join('\n'),
            'utf8'
        );

        await runDockerSandboxCommand(
            [
                'run',
                '--rm',
                '--name', containerName,
                '--network', 'none',
                '--read-only',
                '--cpus', cpuLimit,
                '--memory', memoryLimit,
                '--pids-limit', pidsLimit,
                '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges',
                '--user', '1000:1000',
                '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m',
                '--mount', `type=bind,src=${inputDir},dst=/input,readonly`,
                '--mount', `type=bind,src=${outputDir},dst=/output`,
                image,
                'node',
                '/input/runner.cjs',
            ],
            { containerName, timeoutMs }
        );

        if (!existsSync(outputPath)) {
            const detail = existsSync(errorPath) ? readFileSync(errorPath, 'utf8') : 'spreadsheet_sandbox_no_output';
            if (isSpreadsheetEncryptedError(detail)) {
                throw new Error(`spreadsheet_encrypted_not_supported:${filename}`);
            }
            throw new Error(`spreadsheet_sandbox_output_missing:${detail}`);
        }

        const parsed = JSON.parse(readFileSync(outputPath, 'utf8'));
        const sheets = Array.isArray(parsed?.sheets) ? parsed.sheets : [];
        const sections = [];
        for (const sheet of sheets) {
            const sheetName = String(sheet?.name || 'Sheet');
            const csv = String(stripUnsupportedJsonUnicode(String(sheet?.csv || '')) || '').trim();
            if (!csv) continue;
            const rows = csv
                .split(/\r?\n/)
                .map((line) => line.replace(/\s+/g, ' ').trim())
                .filter(Boolean)
                .map((line, index) => `R${index + 1}: ${line}`);
            if (rows.length > 0) {
                sections.push(`Sheet: ${sheetName}\n${rows.join('\n')}`);
            }
        }
        const output = sections.join('\n\n').trim();
        if (!output) {
            throw new Error(`spreadsheet_extract_empty:${filename}`);
        }
        return output;
    } catch (error) {
        const detail = firstNonEmptyString(error?.message, 'spreadsheet_sandbox_failed');
        if (isSpreadsheetEncryptedError(detail)) {
            throw new Error(`spreadsheet_encrypted_not_supported:${filename}`);
        }
        throw error;
    } finally {
        rmSync(sandboxRoot, { recursive: true, force: true });
    }
}
async function extractTextFromSpreadsheetBuffer(buffer, filename = 'spreadsheet.xlsx') {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sections = [];
    workbook.eachSheet((worksheet) => {
        const rows = [];
        worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            const cells = row.values
                .slice(1)
                .map((cell) => normalizeSpreadsheetCellText(cell).replace(/\s+/g, ' ').trim())
                .filter(Boolean);
            if (cells.length > 0) {
                rows.push(`R${rowNumber}: ${cells.join(' | ')}`);
            }
        });
        if (rows.length > 0) {
            sections.push(`Sheet: ${worksheet.name}\n${rows.join('\n')}`);
        }
    });
    const output = sections.join('\n\n').trim();
    if (!output) {
        throw new Error(`spreadsheet_extract_empty:${filename}`);
    }
    return output;
}
async function extractTextFromSpreadsheetBufferXlsxFallback(buffer, filename = 'spreadsheet.xlsx') {
    const xlsxModule = await import('xlsx');
    const XLSX = xlsxModule.default || xlsxModule;
    const workbook = XLSX.read(buffer, {
        type: 'buffer',
        cellFormula: false,
        cellHTML: false,
        cellNF: false,
        cellText: true,
        dense: true,
    });
    const sections = [];
    const sheetNames = Array.isArray(workbook?.SheetNames) ? workbook.SheetNames : [];
    for (const sheetName of sheetNames) {
        const worksheet = workbook?.Sheets?.[sheetName];
        if (!worksheet) continue;
        const rowsRaw = XLSX.utils.sheet_to_json(worksheet, {
            header: 1,
            raw: false,
            defval: '',
        });
        const rows = [];
        for (let rowIndex = 0; rowIndex < rowsRaw.length; rowIndex += 1) {
            const row = rowsRaw[rowIndex];
            if (!Array.isArray(row)) continue;
            const cells = row
                .map((cell) => normalizeSpreadsheetCellText(cell).replace(/\s+/g, ' ').trim())
                .filter(Boolean);
            if (cells.length > 0) {
                rows.push(`R${rowIndex + 1}: ${cells.join(' | ')}`);
            }
        }
        if (rows.length > 0) {
            sections.push(`Sheet: ${sheetName}\n${rows.join('\n')}`);
        }
    }
    const output = sections.join('\n\n').trim();
    if (!output) {
        throw new Error(`spreadsheet_extract_empty:${filename}`);
    }
    return output;
}
async function extractSpreadsheetDocumentTextWithFallback(buffer, mimeType, filename) {
    try {
        const text = await extractTextFromSpreadsheetViaSandboxCsv(buffer, filename);
        return {
            text,
            mode: 'spreadsheet_sandbox_csv',
            processor: 'xlsx_docker_sandbox',
        };
    } catch (primaryError) {
        const detail = firstNonEmptyString(primaryError?.message, 'spreadsheet_extract_failed');
        if (detail.startsWith('spreadsheet_encrypted_not_supported:')) {
            throw new Error(detail);
        }
        try {
            const text = await extractTextFromSpreadsheetBufferXlsxFallback(buffer, filename);
            return {
                text,
                mode: 'spreadsheet_native',
                processor: 'xlsx_inprocess',
            };
        } catch (secondaryError) {
            const secondaryDetail = firstNonEmptyString(secondaryError?.message, 'spreadsheet_inprocess_extract_failed');
            if (secondaryDetail.startsWith('spreadsheet_encrypted_not_supported:')) {
                throw new Error(secondaryDetail);
            }
            try {
                const text = await extractTextFromSpreadsheetBuffer(buffer, filename);
                return {
                    text,
                    mode: 'spreadsheet_native',
                    processor: 'exceljs',
                };
            } catch (tertiaryError) {
                const tertiaryDetail = firstNonEmptyString(tertiaryError?.message, 'spreadsheet_exceljs_extract_failed');
                return {
                    text: [
                        `Spreadsheet document: ${filename || 'spreadsheet'}`,
                        `Mime type: ${mimeType || 'unknown'}`,
                        `Extraction fallback: ${detail}`,
                        `In-process fallback: ${secondaryDetail}`,
                        `ExcelJS fallback: ${tertiaryDetail}`,
                        'The file was ingested with metadata fallback to avoid blocking ingestion.',
                    ].join('\n'),
                    mode: 'spreadsheet_metadata_fallback',
                    processor: 'spreadsheet_fallback_stub',
                };
            }
        }
    }
}
async function callDoclingProcessorExtract({
    buffer,
    mimeType,
    filename,
    options,
    traceId,
    spanId,
}) {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), filename || 'document');
    form.append('engine', String(options.ocr_engine || 'docling'));
    form.append('mode', String(options.ocr_mode || 'balanced'));
    form.append('languages', normalizeOcrLanguages(options.ocr_languages).join(',') || 'en');
    form.append('extract_tables', String(options.ocr_extract_tables !== false));
    form.append('extract_layout', String(options.ocr_extract_layout !== false));
    form.append('dpi', String(options.ocr_dpi || 300));
    form.append('page_range', String(options.ocr_page_range || 'all'));
    form.append('fallback_to_text', String(options.ocr_fallback_to_text !== false));

    const startedAt = Date.now();
    const startTs = nowIso();
    const controller = new AbortController();
    // Large PDFs can legitimately take far longer than stale client-side
    // settings stored on old jobs; enforce the PDF floor server-side.
    const requestedTimeoutMs = parsePositiveInt(options.ocr_timeout_ms, 1800000);
    const minTimeoutMs = String(mimeType || '').toLowerCase() === 'application/pdf' ? 1800000 : 300000;
    const timeoutMs = Math.max(minTimeoutMs, Math.min(3600000, requestedTimeoutMs));
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response = null;
    let payload = null;
    try {
        response = await fetch(`${DOCLING_PROCESSOR_URL}/extract`, {
            method: 'POST',
            headers: DOCLING_PROCESSOR_INTERNAL_KEY ? { 'x-internal-key': DOCLING_PROCESSOR_INTERNAL_KEY } : {},
            body: form,
            signal: controller.signal,
        });
        payload = await response.json().catch(() => ({}));
        const statusCode = response.status;
        const detail = response.ok
            ? null
            : firstNonEmptyString(payload?.error?.code, payload?.error, payload?.detail, 'docling_extract_failed');
        await insertRequestLogRow({
            trace_id: traceId,
            span_id: spanId,
            service: 'docling-ingestion',
            route: 'POST /extract',
            start_ts: startTs,
            end_ts: nowIso(),
            latency_ms: Date.now() - startedAt,
            status: statusCode,
            error: response.ok ? null : detail,
            metadata: {
                filename: filename || null,
                mime_type: mimeType || null,
                processor_url: DOCLING_PROCESSOR_URL,
                timeout_ms: timeoutMs,
            },
        });
        if (!response.ok) {
            throw new Error(firstNonEmptyString(payload?.error?.message, payload?.error?.code, payload?.detail, `docling_extract_${statusCode}`));
        }
        const text = String(payload?.text || '').trim();
        if (!text) {
            throw new Error('docling_empty_text');
        }
        return {
            text,
            mode: 'binary_docling',
            processor: payload?.meta?.engine || String(options.ocr_engine || 'docling'),
        };
    } finally {
        clearTimeout(timeout);
    }
}
async function extractTextFromBuffer(buffer, mimeType, filename, options = {}, traceId = '', spanId = '') {
    if (isTextLikeDocument(mimeType, filename)) {
        return {
            text: buffer.toString('utf8'),
            mode: 'text_direct',
            processor: 'native_text',
        };
    }
    if (isSpreadsheetDocument(mimeType, filename)) {
        return extractSpreadsheetDocumentTextWithFallback(buffer, mimeType, filename);
    }
    const processorResult = await callDoclingProcessorExtract({
        buffer,
        mimeType,
        filename,
        options,
        traceId,
        spanId,
    });
    return processorResult;
}
function fallbackBinaryMetadataText(mimeType, filename, options = {}) {
    return [
        `Binary document: ${filename || 'document'}`,
        `Mime type: ${mimeType || 'unknown'}`,
        `OCR engine: ${String(options.ocr_engine || 'docling_stub')}`,
        `OCR languages: ${normalizeOcrLanguages(options.ocr_languages).join(', ') || 'en'}`,
        `OCR mode: ${String(options.ocr_mode || 'balanced')}`,
        'This build stores the file and tracks the ingestion pipeline server-side,',
        'and could not extract text from Docling. Metadata fallback was used.',
    ].join('\n');
}
function buildIngestionOptions(input = {}) {
    const options = input && typeof input === 'object' ? input : {};
    const ocrLanguages = normalizeOcrLanguages(options.ocr_languages || 'en');
    const ocrTimeoutMs = Math.max(30000, Math.min(3600000, parsePositiveInt(options.ocr_timeout_ms, 1800000)));
    const ocrDpi = Math.max(72, Math.min(600, parsePositiveInt(options.ocr_dpi, 200)));
    const ocrPageRange = String(options.ocr_page_range || 'all').trim().slice(0, 120) || 'all';
    const ocrEngine = String(options.ocr_engine || 'docling_stub').trim().toLowerCase() || 'docling_stub';
    const ocrMode = String(options.ocr_mode || 'fast').trim().toLowerCase() || 'fast';
    const collectionMode = String(options.collection_mode || 'existing').trim().toLowerCase();
    const ocrExtractTables = options.ocr_extract_tables === undefined ? false : options.ocr_extract_tables !== false;
    const ocrExtractLayout = options.ocr_extract_layout === undefined ? false : options.ocr_extract_layout !== false;
    const ocrFallbackToText = options.ocr_fallback_to_text === undefined ? true : options.ocr_fallback_to_text !== false;
    const enforceEnglishOcr = options.enforce_english_ocr === undefined ? true : options.enforce_english_ocr !== false;
    const ocrLegibilityLlmRecovery = options.ocr_legibility_llm_recovery === undefined ? true : options.ocr_legibility_llm_recovery !== false;
    const ocrLegibilityMinChars = Math.max(120, Math.min(5000, parsePositiveInt(options.ocr_legibility_min_chars, 220)));
    const ocrLegibilityMinScoreRaw = Number(options.ocr_legibility_min_score);
    const ocrLegibilityMinScore = Number.isFinite(ocrLegibilityMinScoreRaw)
        ? Math.max(0.2, Math.min(0.95, ocrLegibilityMinScoreRaw))
        : 0.55;
    const testMode = options.test_mode === true;
    const embedPreviewOnly = options.embed_preview_only === true;
    const skipGraph = options.skip_graph === true;
    const skipVectorUpsert = options.skip_vector_upsert === true;
    return {
        collection_name: String(options.collection_name || '').trim(),
        collection_mode: collectionMode === 'create_new' ? 'create_new' : 'existing',
        create_collection_if_missing: collectionMode === 'create_new' || options.create_collection_if_missing === true,
        chunk_chars: Math.max(600, Math.min(6000, parsePositiveInt(options.chunk_chars, 1800))),
        overlap_chars: Math.max(0, Math.min(1200, parsePositiveInt(options.overlap_chars, 180))),
        distance: String(options.distance || 'Cosine').trim() || 'Cosine',
        desired_vector_size: Math.max(64, Math.min(4096, parsePositiveInt(options.desired_vector_size, 1536))),
        qa_sample_size: Math.max(1, Math.min(12, parsePositiveInt(options.qa_sample_size, 3))),
        use_llm_for_qa: options.use_llm_for_qa !== false,
        ocr_engine: ocrEngine,
        ocr_mode: ['fast', 'balanced', 'high_accuracy'].includes(ocrMode) ? ocrMode : 'fast',
        ocr_languages: ocrLanguages.length > 0 ? ocrLanguages : ['en'],
        ocr_extract_tables: ocrExtractTables,
        ocr_extract_layout: ocrExtractLayout,
        ocr_timeout_ms: ocrTimeoutMs,
        ocr_dpi: ocrDpi,
        ocr_page_range: ocrPageRange,
        ocr_fallback_to_text: ocrFallbackToText,
        enforce_english_ocr: enforceEnglishOcr,
        ocr_legibility_llm_recovery: ocrLegibilityLlmRecovery,
        ocr_legibility_min_chars: ocrLegibilityMinChars,
        ocr_legibility_min_score: ocrLegibilityMinScore,
        test_mode: testMode,
        embed_preview_only: embedPreviewOnly,
        skip_graph: skipGraph,
        skip_vector_upsert: skipVectorUpsert,
        allow_group_1_ocr_override: options.allow_group_1_ocr_override === true,
    };
}
async function logIngestionEvent(jobId, stage, status, message, detail = {}) {
    const safeDetail = stripUnsupportedJsonUnicode(detail || {});
    await pool.query(
        `INSERT INTO ingestion_job_events (job_id, stage, status, message, detail)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [jobId, stage, status, message ? String(message).replace(/\0/g, '') : null, JSON.stringify(safeDetail)]
    );
}
async function syncLegacyDoclingJob({ id, filename, status, resultMetadata = {}, error = null }) {
    const rawStatus = String(status || '').trim().toLowerCase();
    const safeResultMetadata = stripUnsupportedJsonUnicode(resultMetadata || {});
    const safeError = error ? String(error).replace(/\0/g, '') : null;
    const candidates = [
        rawStatus || 'pending',
        rawStatus === 'pending' ? 'queued' : null,
        rawStatus === 'queued' ? 'pending' : null,
        rawStatus === 'processing' ? 'running' : null,
        rawStatus === 'running' ? 'processing' : null,
        rawStatus === 'cancelled' ? 'failed' : null,
    ].filter(Boolean);

    const uniqueStatuses = [...new Set(candidates)];
    let lastError = null;
    for (const candidate of uniqueStatuses) {
        try {
            await pool.query(
                `INSERT INTO docling_jobs (id, filename, status, result_metadata, error, created_at, updated_at)
                 VALUES ($1,$2,$3,$4::jsonb,$5, now(), now())
                 ON CONFLICT (id) DO UPDATE
                 SET filename = EXCLUDED.filename,
                     status = EXCLUDED.status,
                     result_metadata = EXCLUDED.result_metadata,
                     error = EXCLUDED.error,
                     updated_at = now()`,
                [id, filename, candidate, JSON.stringify(safeResultMetadata), safeError]
            );
            return;
        } catch (insertError) {
            lastError = insertError;
            const isConstraintMismatch = String(insertError?.message || '').includes('docling_jobs_status_check');
            if (!isConstraintMismatch) break;
        }
    }
    throw lastError || new Error('docling_jobs_sync_failed');
}
async function setIngestionJobStage(jobId, {
    status,
    stage,
    progressPercent,
    resultMetadata,
    error,
    queueJobId,
    started = false,
    completed = false,
    message,
    detail = {},
}) {
    const safeResultMetadata = resultMetadata ? stripUnsupportedJsonUnicode(resultMetadata) : null;
    const safeError = error ? String(error).replace(/\0/g, '') : null;
    const safeDetail = stripUnsupportedJsonUnicode(detail || {});
    const currentRow = await pool.query(
        `SELECT j.id, j.document_id, j.created_at, d.original_filename
         FROM ingestion_jobs j
         JOIN ingestion_documents d ON d.id = j.document_id
         WHERE j.id = $1::uuid
         LIMIT 1`,
        [jobId]
    );
    if (currentRow.rowCount === 0) {
        throw new Error('ingestion_job_not_found');
    }
    const current = currentRow.rows[0];
    const nextStatus = String(status || (stage === 'completed' ? 'completed' : stage === 'failed' ? 'failed' : 'processing'));
    const nextStage = String(stage || 'processing');
    const nextProgress = Number.isFinite(Number(progressPercent))
        ? Number(progressPercent)
        : (INGESTION_STAGE_PROGRESS[nextStage] ?? 0);
    const estimatedCompletionAt = nextStatus === 'completed' || nextStatus === 'failed' || nextStatus === 'cancelled'
        ? null
        : estimateCompletionAt(nextStage);
    await pool.query(
        `UPDATE ingestion_jobs
         SET status = $2,
             stage = $3,
             progress_percent = $4,
             estimated_completion_at = $5::timestamptz,
             started_at = CASE WHEN $6 THEN COALESCE(started_at, now()) ELSE started_at END,
             completed_at = CASE WHEN $7 THEN now() ELSE completed_at END,
             queue_job_id = COALESCE($8, queue_job_id),
             result_metadata = CASE WHEN $9::jsonb IS NULL THEN result_metadata ELSE result_metadata || $9::jsonb END,
             error = $10,
             updated_at = now()
         WHERE id = $1::uuid`,
        [
            jobId,
            nextStatus,
            nextStage,
            nextProgress,
            estimatedCompletionAt,
            started,
            completed,
            queueJobId || null,
            safeResultMetadata ? JSON.stringify(safeResultMetadata) : null,
            safeError,
        ]
    );
    await pool.query(
        `UPDATE ingestion_documents
         SET status = $2,
             updated_at = now()
         WHERE id = $1::uuid`,
        [current.document_id, nextStatus]
    );
    await syncLegacyDoclingJob({
        id: current.document_id,
        filename: current.original_filename,
        status: nextStatus === 'cancelled' ? 'failed' : nextStatus,
        resultMetadata: safeResultMetadata || {},
        error: safeError,
    });
    await logIngestionEvent(jobId, nextStage, nextStatus, message || nextStage, safeDetail);
}
async function qdrantRequest(path, method = 'GET', body) {
    const safeBody = body === undefined ? undefined : stripUnsupportedJsonUnicode(body);
    const response = await fetch(`${QDRANT_URL}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: safeBody === undefined ? undefined : JSON.stringify(safeBody),
    });
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json')
        ? await response.json().catch(() => ({}))
        : await response.text().catch(() => '');
    if (!response.ok) {
        const error = new Error(
            typeof data === 'string'
                ? data
                : firstNonEmptyString(data?.status?.error, data?.error, data?.message) || `qdrant_${response.status}`
        );
        error.status = response.status;
        error.qdrant_body = data;
        throw error;
    }
    return data;
}
function buildDefaultIntakeSuggestedOptions(dataType = 'mixed') {
    const normalizedDataType = ['text', 'images', 'mixed'].includes(String(dataType || '').trim().toLowerCase())
        ? String(dataType || '').trim().toLowerCase()
        : 'mixed';
    return {
        desired_vector_size: 1536,
        chunk_chars: normalizedDataType === 'text' ? 2000 : 1200,
        overlap_chars: normalizedDataType === 'images' ? 300 : 250,
        qa_sample_size: 4,
        distance: 'Cosine',
        use_llm_for_qa: true,
        ocr_engine: 'docling',
        ocr_mode: normalizedDataType === 'images' ? 'balanced' : 'fast',
        ocr_languages: 'en',
        ocr_extract_tables: false,
        ocr_extract_layout: false,
        ocr_timeout_ms: normalizedDataType === 'text' ? 180000 : 1800000,
        ocr_fallback_to_text: true,
    };
}
function normalizeIntakeAssistantPlan(parsed, {
    normalizedDataType = 'mixed',
    purpose = '',
    cappedUseCase = '',
}) {
    const recommendedCollectionName = `${String(purpose || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 36) || 'knowledge'}_${normalizedDataType}`;
    const defaults = buildDefaultIntakeSuggestedOptions(normalizedDataType);
    const payload = parsed && typeof parsed === 'object' ? parsed : {};
    const opts = payload.suggested_options && typeof payload.suggested_options === 'object'
        ? payload.suggested_options
        : {};
    return {
        assistant_message: String(payload.assistant_message || 'Plan generated. Review the proposed settings before upload.'),
        intake_summary: String(payload.intake_summary || `Purpose: ${purpose}. Data type: ${normalizedDataType}. Use case: ${cappedUseCase}.`),
        recommended_collection_name: String(payload.recommended_collection_name || recommendedCollectionName),
        suggested_options: {
            desired_vector_size: Math.max(64, Math.min(4096, parsePositiveInt(opts.desired_vector_size, defaults.desired_vector_size))),
            chunk_chars: Math.max(600, Math.min(8000, parsePositiveInt(opts.chunk_chars, defaults.chunk_chars))),
            overlap_chars: Math.max(0, Math.min(1200, parsePositiveInt(opts.overlap_chars, defaults.overlap_chars))),
            qa_sample_size: Math.max(1, Math.min(12, parsePositiveInt(opts.qa_sample_size, defaults.qa_sample_size))),
            distance: String(opts.distance || defaults.distance),
            use_llm_for_qa: opts.use_llm_for_qa !== false,
            ocr_engine: String(opts.ocr_engine || defaults.ocr_engine),
            ocr_mode: String(opts.ocr_mode || defaults.ocr_mode),
            ocr_languages: String(opts.ocr_languages || defaults.ocr_languages),
            ocr_extract_tables: opts.ocr_extract_tables === undefined ? defaults.ocr_extract_tables : opts.ocr_extract_tables !== false,
            ocr_extract_layout: opts.ocr_extract_layout === undefined ? defaults.ocr_extract_layout : opts.ocr_extract_layout !== false,
            ocr_timeout_ms: Math.max(30000, Math.min(3600000, parsePositiveInt(opts.ocr_timeout_ms, defaults.ocr_timeout_ms))),
            ocr_fallback_to_text: opts.ocr_fallback_to_text === undefined ? defaults.ocr_fallback_to_text : opts.ocr_fallback_to_text !== false,
        },
        operator_guidance: String(
            payload.operator_guidance
            || [
                '### DATA INTAKE PROTOCOL ###',
                '1. TABLE NORMALIZATION: Convert detected tables into valid Markdown tables; preserve headers.',
                '2. OCR CORRECTION: Correct common OCR artifacts but never alter financial facts.',
                '3. DATA FORMATTING: Standardize dates and currency formatting without rounding.',
                '4. METADATA TAGGING: Prefix each chunk with Document, Section, and Page context where available.',
                '5. REMOVAL OF NOISE: Remove footer/header clutter and repeated boilerplate.',
                '6. HIERARCHY PRESERVATION: Keep parent-child bullet/heading structure intact.',
            ].join('\n')
        ),
        system_prompt_template: String(
            payload.system_prompt_template
            || [
                'Role: Docling Data Ingestion Agent.',
                'Objectives: Preserve factual fidelity, enforce structure, retain source metadata, and flag OCR failures as [OCR_FAILURE].',
                'Constraint: Do not summarize for end users; only clean/normalize text for embedding.',
            ].join('\n')
        ),
        alignment_summary: firstNonEmptyString(payload.alignment_summary) || null,
        settings_rationale: Array.isArray(payload.settings_rationale) ? payload.settings_rationale : [],
    };
}
function writeSseEvent(res, event, payload = {}) {
    if (!res || res.writableEnded) return;
    const safePayload = sanitizeForLogs(payload || {});
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(safePayload)}\n\n`);
}
async function ensureMetricSourceSeeds() {
    for (const seed of METRIC_SOURCE_SEEDS) {
        await pool.query(
            `INSERT INTO metric_sources (slug, label, source_kind, config, updated_at)
             VALUES ($1,$2,$3,$4::jsonb, now())
             ON CONFLICT (slug) DO UPDATE
             SET label = EXCLUDED.label,
                 source_kind = EXCLUDED.source_kind,
                 config = CASE
                  WHEN COALESCE(metric_sources.config->>'url', '') IN ('', 'http://127.0.0.1:61208/api/4/all') THEN EXCLUDED.config
                   ELSE metric_sources.config
                 END,
                 updated_at = now()`,
            [seed.slug, seed.label, seed.source_kind, JSON.stringify(seed.config)]
        );
    }
}
async function recordMetricSample({ slug, label, sourceKind = 'glances', config = {}, metrics = {}, checkedAt = new Date() }) {
    const upserted = await pool.query(
        `INSERT INTO metric_sources (slug, label, source_kind, config, last_seen_at, updated_at)
         VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz, now())
         ON CONFLICT (slug) DO UPDATE
         SET label = EXCLUDED.label,
             source_kind = EXCLUDED.source_kind,
             config = EXCLUDED.config,
             last_seen_at = EXCLUDED.last_seen_at,
             updated_at = now()
         RETURNING id, slug, label, last_seen_at`,
        [slug, label, sourceKind, JSON.stringify(config || {}), checkedAt.toISOString()]
    );
    const source = upserted.rows[0];
    await pool.query(
        `INSERT INTO metric_samples (source_id, metrics, sampled_at)
         VALUES ($1,$2::jsonb,$3::timestamptz)`,
        [source.id, JSON.stringify(normalizeMetricPayload(metrics)), checkedAt.toISOString()]
    );
    return source;
}
async function recordServiceHealth(serviceKey, status, latencyMs, detail = {}) {
    await pool.query(
        `INSERT INTO service_health_checks (service_key, status, latency_ms, detail, checked_at)
         VALUES ($1,$2,$3,$4::jsonb, now())`,
        [serviceKey, status, Number.isFinite(Number(latencyMs)) ? Number(latencyMs) : null, JSON.stringify(detail || {})]
    );
}
async function refreshMetricSource(sourceRow) {
    const config = sourceRow?.config && typeof sourceRow.config === 'object' ? sourceRow.config : {};
    const url = String(config.url || '').trim();
    if (!url) {
        await recordServiceHealth(sourceRow.slug, 'offline', null, { reason: 'missing_url' });
        return null;
    }
    const start = Date.now();
    try {
        const response = await fetch(url);
        const data = await response.json().catch(() => ({}));
        const latencyMs = Date.now() - start;
        const status = response.ok ? 'healthy' : 'offline';
        await recordServiceHealth(sourceRow.slug, status, latencyMs, {
            source_kind: sourceRow.source_kind,
            url,
            http_status: response.status,
        });
        if (!response.ok) {
            return null;
        }
        await recordMetricSample({
            slug: sourceRow.slug,
            label: sourceRow.label,
            sourceKind: sourceRow.source_kind,
            config,
            metrics: data,
            checkedAt: new Date(),
        });
        return normalizeMetricPayload(data);
    } catch (error) {
        await recordServiceHealth(sourceRow.slug, 'offline', Date.now() - start, {
            source_kind: sourceRow.source_kind,
            url,
            error: String(error?.message || error),
        });
        return null;
    }
}
async function buildMetricsOverview({ refresh = false } = {}) {
    await ensureMetricSourceSeeds();
    const sourcesRes = await pool.query(
        `SELECT id, slug, label, source_kind, config, last_seen_at
         FROM metric_sources
         ORDER BY slug ASC`
    );
    const sources = sourcesRes.rows || [];
    const staleMs = 12 * 1000;
    if (refresh) {
        for (const source of sources) {
            await refreshMetricSource(source);
        }
    } else {
        for (const source of sources) {
            const lastSeen = source.last_seen_at ? new Date(source.last_seen_at).getTime() : 0;
            if (!lastSeen || (Date.now() - lastSeen) > staleMs) {
                await refreshMetricSource(source);
            }
        }
    }
    const metricsRes = await pool.query(
        `SELECT s.slug, s.label, s.last_seen_at, ms.metrics,
                hc.status AS health_status, hc.latency_ms AS health_latency_ms, hc.detail AS health_detail
         FROM metric_sources s
         LEFT JOIN LATERAL (
           SELECT metrics, sampled_at
           FROM metric_samples
           WHERE source_id = s.id
           ORDER BY sampled_at DESC
           LIMIT 1
         ) ms ON true
         LEFT JOIN LATERAL (
           SELECT status, latency_ms, detail
           FROM service_health_checks
           WHERE service_key = s.slug
           ORDER BY checked_at DESC
           LIMIT 1
         ) hc ON true
         ORDER BY s.slug ASC`
    );
    const rows = metricsRes.rows || [];
    const legacy = { ghost: null, one: null, lastUpdated: { ghost: null, one: null } };
    for (const row of rows) {
        if (row.slug === 'ghost' || row.slug === 'one') {
            legacy[row.slug] = row.metrics || null;
            legacy.lastUpdated[row.slug] = row.last_seen_at ? new Date(row.last_seen_at).getTime() : null;
        }
    }
    return {
        sources: rows.map((row) => ({
            slug: row.slug,
            label: row.label,
            metrics: row.metrics || null,
            last_seen_at: row.last_seen_at,
            health_status: row.health_status || 'offline',
            health_latency_ms: row.health_latency_ms ?? null,
            health_detail: row.health_detail || {},
        })),
        legacy,
    };
}
function normalizeVectorLength(vector, size) {
    const cleanSize = Math.max(8, Math.min(4096, Number(size) || 1536));
    const values = Array.isArray(vector) ? vector.map((item) => Number(item) || 0) : [];
    if (values.length === cleanSize) return values;
    if (values.length > cleanSize) return values.slice(0, cleanSize);
    const padded = values.slice();
    while (padded.length < cleanSize) padded.push(0);
    return padded;
}
async function createEmbeddingVector(text, size) {
    const fallback = {
        vector: deterministicVector(text, size),
        provider: 'deterministic_hash',
        model: null,
        note: 'Fell back to deterministic vectors because no embeddings endpoint is configured.',
    };
    try {
        const llm = await loadDashboardLlmConfig('');
        const embeddingBaseUrl = String(
            process.env.VLLM_EMBEDDINGS_BASE_URL
            || process.env.VLLM_INTERNAL_BASE_URL
            || process.env.VLLM_OPENAI_BASE_URL
            || ''
        ).trim();
        const embeddingUrl = resolveOpenAiEmbeddingsUrl(embeddingBaseUrl);
        const modelId = String(process.env.VLLM_EMBEDDINGS_MODEL || llm?.model_id || '').trim();
        const apiKey = String(process.env.VLLM_EMBEDDINGS_API_KEY || process.env.VLLM_OPENAI_API_KEY || llm?.api_key || '').trim();
        if (!embeddingUrl || !modelId) {
            return fallback;
        }
        const headers = {
            'Content-Type': 'application/json',
        };
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
        const response = await fetch(embeddingUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: modelId,
                input: String(text || '').slice(0, 12000),
            }),
        });
        const body = await response.json().catch(() => ({}));
        const embedding = body?.data?.[0]?.embedding;
        if (!response.ok || !Array.isArray(embedding) || embedding.length === 0) {
            return fallback;
        }
        return {
            vector: normalizeVectorLength(embedding, size),
            provider: 'openai_compatible',
            model: modelId,
            note: null,
        };
    } catch {
        return fallback;
    }
}
async function ensureQdrantCollectionMeta(collectionName, patch = {}) {
    await pool.query(
        `INSERT INTO qdrant_collections_meta (collection_name, config, latest_quality_status, latest_quality_summary, metadata, updated_at)
         VALUES ($1,$2::jsonb,$3,$4,$5::jsonb, now())
         ON CONFLICT (collection_name) DO UPDATE
         SET config = COALESCE(qdrant_collections_meta.config, '{}'::jsonb) || EXCLUDED.config,
             latest_quality_status = COALESCE(EXCLUDED.latest_quality_status, qdrant_collections_meta.latest_quality_status),
             latest_quality_summary = COALESCE(EXCLUDED.latest_quality_summary, qdrant_collections_meta.latest_quality_summary),
             metadata = COALESCE(qdrant_collections_meta.metadata, '{}'::jsonb) || EXCLUDED.metadata,
             updated_at = now()`,
        [
            collectionName,
            JSON.stringify(patch.config || {}),
            patch.latest_quality_status || null,
            patch.latest_quality_summary || null,
            JSON.stringify(patch.metadata || {}),
        ]
    );
}
async function ensureQdrantCollection(collectionName, options = {}) {
    const safeName = String(collectionName || '').trim();
    if (!safeName) throw new Error('missing_collection_name');
    const desiredSize = Math.max(8, Math.min(4096, Number(options.desired_vector_size) || 1536));
    try {
        const existing = await qdrantRequest(`/collections/${safeName}`, 'GET');
        const configuredSize = Number(existing?.result?.config?.params?.vectors?.size || desiredSize) || desiredSize;
        await ensureQdrantCollectionMeta(safeName, {
            config: existing?.result?.config || {},
            metadata: { vector_size: configuredSize },
        });
        return { collection: existing, vectorSize: configuredSize };
    } catch {
        const payload = {
            vectors: {
                size: desiredSize,
                distance: String(options.distance || 'Cosine'),
            },
        };
        const created = await qdrantRequest(`/collections/${safeName}`, 'PUT', payload);
        await ensureQdrantCollectionMeta(safeName, {
            config: payload,
            metadata: { created_via: 'control-plane', vector_size: desiredSize },
        });
        return { collection: created, vectorSize: desiredSize };
    }
}
async function qdrantCollectionExists(collectionName) {
    const safeName = String(collectionName || '').trim();
    if (!safeName) return false;
    const data = await qdrantRequest('/collections', 'GET');
    const rows = Array.isArray(data?.result?.collections) ? data.result.collections : [];
    return rows.some((row) => String(row?.name || '').trim() === safeName);
}
async function getQdrantPoints(collectionName, limit = 12, offset = null, withVector = false) {
    return qdrantRequest(`/collections/${collectionName}/points/scroll`, 'POST', {
        limit,
        offset,
        with_payload: true,
        with_vector: withVector,
    });
}
async function runVectorQualityCheck({ collectionName, jobId = null, options = {} }) {
    const countsRes = await pool.query(
        `SELECT COUNT(*)::int AS chunk_count
         FROM document_chunks
         WHERE ($1::uuid IS NULL OR job_id = $1::uuid)`,
        [jobId || null]
    );
    const vectorRes = await pool.query(
        `SELECT COUNT(*)::int AS vector_count,
                COUNT(*) FILTER (WHERE embedding_provider = 'deterministic_hash')::int AS fallback_vector_count
         FROM vector_sync_records
         WHERE collection_name = $1
           AND ($2::uuid IS NULL OR job_id = $2::uuid)`,
        [collectionName, jobId || null]
    );
    let collectionInfo = null;
    let samplePoints = [];
    try {
        collectionInfo = await qdrantRequest(`/collections/${collectionName}`, 'GET');
        const sample = await getQdrantPoints(collectionName, Math.max(1, Math.min(10, parsePositiveInt(options.qa_sample_size, 3))), null, false);
        samplePoints = Array.isArray(sample?.result?.points) ? sample.result.points : [];
    } catch {}
    const chunkCount = countsRes.rows[0]?.chunk_count || 0;
    const vectorCount = vectorRes.rows[0]?.vector_count || 0;
    const fallbackVectorCount = vectorRes.rows[0]?.fallback_vector_count || 0;
    const warnings = [];
    if (chunkCount === 0) warnings.push('No chunks were created for this job.');
    if (vectorCount === 0) warnings.push('No vectors were written to Qdrant.');
    if (fallbackVectorCount > 0) warnings.push('Deterministic fallback vectors were used for some or all chunks.');
    if (samplePoints.length === 0) warnings.push('Qdrant scroll returned no sample points.');
    const score = Math.max(0, 100 - warnings.length * 22);
    let status = 'ready';
    if (warnings.length >= 3) status = 'failed';
    else if (warnings.length > 0) status = 'warning';
    const detail = {
        chunk_count: chunkCount,
        vector_count: vectorCount,
        fallback_vector_count: fallbackVectorCount,
        warnings,
        collection_config: collectionInfo?.result?.config || null,
        sample_points: samplePoints.slice(0, 3),
    };
    let summary = warnings.length === 0
        ? 'Collection looks ready for retrieval and QA.'
        : warnings.join(' ');
    if (options.use_llm_for_qa !== false) {
        try {
            const llm = await loadDoclingHelperLlmConfig();
            if (llm) {
                const llmResult = await callConfiguredLlm({
                    llm,
                    route: 'POST /internal/vector-quality-llm',
                    body: {
                        model: llm.model_id,
                        temperature: 0.1,
                        response_format: { type: 'json_object' },
                        messages: [
                            {
                                role: 'system',
                                content: 'You audit vector collections. Return strict JSON: {"status":"ready|warning|failed","score":number,"summary":string,"findings":[string]}.',
                            },
                            {
                                role: 'user',
                                content: JSON.stringify({
                                    collection_name: collectionName,
                                    detail,
                                }),
                            },
                        ],
                    },
                });
                const body = llmResult.upstream_body || {};
                const parsed = parseJsonFromLlmText(firstNonEmptyString(body?.choices?.[0]?.message?.content, body?.choices?.[0]?.text) || '') || {};
                if (llmResult.ok && parsed && typeof parsed === 'object') {
                    if (['ready', 'warning', 'failed'].includes(String(parsed.status || ''))) status = String(parsed.status);
                    if (Number.isFinite(Number(parsed.score))) {
                        summary = String(parsed.summary || summary);
                    }
                    detail.llm_findings = Array.isArray(parsed.findings) ? parsed.findings : [];
                    if (parsed.summary) summary = String(parsed.summary);
                    if (llmResult.token_policy_notice) detail.token_policy_notice = llmResult.token_policy_notice;
                    detail.token_policy = llmResult.token_policy;
                }
            }
        } catch {}
    }
    await pool.query(
        `INSERT INTO vector_quality_checks (job_id, collection_name, status, score, summary, detail)
         VALUES ($1::uuid,$2,$3,$4,$5,$6::jsonb)`,
        [jobId || null, collectionName, status, score, summary, JSON.stringify(detail)]
    );
    await ensureQdrantCollectionMeta(collectionName, {
        latest_quality_status: status,
        latest_quality_summary: summary,
        metadata: { latest_vector_count: vectorCount, latest_chunk_count: chunkCount },
    });
    return { status, score, summary, detail };
}
async function buildIngestionAssistantSummary({
    objective = '',
    filename = '',
    collection_name = '',
    chunk_count = 0,
    point_count = 0,
    quality = null,
    stage = '',
    error = '',
}) {
    const fallback = error
        ? `Ingestion failed at ${stage || 'unknown stage'} for ${filename || 'document'}: ${error}.`
        : `Ingestion processed ${filename || 'document'} into ${chunk_count} chunk(s), upserted ${point_count} vector point(s) in ${collection_name || 'knowledge_base'}, quality status: ${quality?.status || 'unknown'}.`;
    try {
        const llm = await loadDoclingHelperLlmConfig();
        if (!llm) return fallback;
        const llmResult = await callConfiguredLlm({
            llm,
            route: 'POST /internal/ingestion-summary',
            body: {
                model: llm.model_id,
                temperature: 0.1,
                max_tokens: 300,
                messages: [
                    {
                        role: 'system',
                        content: 'You are Docling ingestion assistant. Return exactly one concise sentence summarizing what was processed, what quality checks occurred, and the result. No markdown.',
                    },
                    {
                        role: 'user',
                        content: JSON.stringify({
                            objective: String(objective || '').slice(0, 500),
                            filename,
                            collection_name,
                            chunk_count,
                            point_count,
                            quality,
                            stage,
                            error,
                        }),
                    },
                ],
            },
        });
        if (!llmResult.ok) return fallback;
        const body = llmResult.upstream_body || {};
        const raw = firstString(
            body?.choices?.[0]?.message?.content,
            body?.choices?.[0]?.message?.reasoning,
            body?.output_text
        );
        const text = String(raw || '').trim().replace(/\s+/g, ' ');
        if (!text) return fallback;
        return text.slice(0, 600);
    } catch {
        return fallback;
    }
}
async function processIngestionQueueJob(job) {
    const ingestionJobId = String(job?.data?.ingestionJobId || '').trim();
    const traceId = String(job?.data?.trace_id || crypto.randomUUID()).trim();
    const spanId = crypto.randomUUID();
    const startedAt = Date.now();
    const startTs = nowIso();
    let stage = 'queued';
    let current = null;
    let options = buildIngestionOptions({});
    let operatorMessages = [];
    let extractedText = '';
    let chunks = [];
    let points = [];
    let testMode = false;
    let skipGraph = false;
    let skipVectorUpsert = false;
    const stageLatencyMs = {};
    try {
        const row = await pool.query(
            `SELECT j.*, d.original_filename, d.relative_path, d.mime_type, d.storage_key, d.storage_bucket, d.size_bytes
             FROM ingestion_jobs j
             JOIN ingestion_documents d ON d.id = j.document_id
             WHERE j.id = $1::uuid
             LIMIT 1`,
            [ingestionJobId]
        );
        if (row.rowCount === 0) {
            throw new Error('ingestion_job_not_found');
        }
        current = row.rows[0];
        options = buildIngestionOptions(current.options || {});
        testMode = options.test_mode === true;
        skipGraph = options.skip_graph === true || testMode;
        skipVectorUpsert = options.skip_vector_upsert === true || testMode;
        const operatorMessagesRes = await pool.query(
            `SELECT role, message, metadata, created_at
             FROM ingestion_operator_messages
             WHERE job_id = $1::uuid
             ORDER BY created_at ASC`,
            [ingestionJobId]
        );
        operatorMessages = operatorMessagesRes.rows || [];
        stage = 'extracting';
        await setIngestionJobStage(ingestionJobId, {
            status: 'processing',
            stage,
            started: true,
            queueJobId: String(job.id || ''),
            message: 'Downloading source file from storage.',
            detail: { trace_id: traceId, effective_settings: options },
            resultMetadata: { effective_settings: options },
        });
        const downloadStartedAt = Date.now();
        const settingsState = await getEngineSettings();
        const knowledgeSettings = resolveKnowledgeStorageSettings(settingsState.config || {});
        const buffer = current.storage_key
            ? await getS3ObjectBuffer(current.storage_key, current.storage_bucket, knowledgeSettings)
            : Buffer.from(current.original_filename || '', 'utf8');
        stageLatencyMs.storage_download = Date.now() - downloadStartedAt;
        const extractStartedAt = Date.now();
        let extractedResult;
        const spreadsheetLike = isSpreadsheetDocument(current.mime_type, current.original_filename);
        if (spreadsheetLike) {
            extractedResult = await extractSpreadsheetDocumentTextWithFallback(
                buffer,
                current.mime_type,
                current.original_filename
            );
        } else {
            try {
                extractedResult = await extractTextFromBuffer(
                    buffer,
                    current.mime_type,
                    current.original_filename,
                    options,
                    traceId,
                    crypto.randomUUID()
                );
            } catch (error) {
                if (options.ocr_fallback_to_text === false) throw error;
                extractedResult = {
                    text: fallbackBinaryMetadataText(current.mime_type, current.original_filename, options),
                    mode: 'binary_fallback_stub',
                    processor: String(options.ocr_engine || 'docling'),
                };
            }
        }
        extractedText = String(stripUnsupportedJsonUnicode(String(extractedResult.text || '')) || '');
        const spreadsheetStructuredExtraction = spreadsheetLike
            && String(extractedResult.mode || '').trim() !== 'spreadsheet_metadata_fallback'
            && extractedText.trim().length > 0;
        const ocrLegibilityStartedAt = Date.now();
        const ocrLegibilityInitial = evaluateOcrLegibility(
            extractedText,
            spreadsheetStructuredExtraction
                ? { ...options, enforce_english_ocr: false }
                : options
        );
        let ocrLegibility = spreadsheetStructuredExtraction
            ? {
                ...ocrLegibilityInitial,
                passed: true,
                reasons: [],
                spreadsheet_structured_override: true,
            }
            : ocrLegibilityInitial;
        let ocrRecovery = { attempted: false };
        extractedText = ocrLegibilityInitial.cleaned_text;
        if (!ocrLegibilityInitial.passed && !spreadsheetStructuredExtraction) {
            const ocrRecoveryStartedAt = Date.now();
            ocrRecovery = await recoverOcrLegibilityWithLlm({
                text: extractedText,
                legibility: ocrLegibilityInitial,
                options,
                traceId,
                filename: current.original_filename,
                mimeType: current.mime_type,
            }).catch((error) => ({
                attempted: true,
                recovered: false,
                reason: firstNonEmptyString(error?.message, 'llm_recovery_exception'),
            }));
            stageLatencyMs.ocr_legibility_recovery = Date.now() - ocrRecoveryStartedAt;
            if (ocrRecovery?.recovered && ocrRecovery?.recovered_text) {
                const recoveredLegibility = evaluateOcrLegibility(ocrRecovery.recovered_text, options);
                if (recoveredLegibility.metrics.score > ocrLegibilityInitial.metrics.score || recoveredLegibility.passed) {
                    ocrLegibility = recoveredLegibility;
                    extractedText = recoveredLegibility.cleaned_text;
                }
            }
        }
        stageLatencyMs.ocr_legibility = Date.now() - ocrLegibilityStartedAt;
        stageLatencyMs.extract_text = Date.now() - extractStartedAt;
        stage = 'ocr';
        await setIngestionJobStage(ingestionJobId, {
            status: 'processing',
            stage,
            message: 'Preparing extracted text and OCR guidance.',
            resultMetadata: {
                extraction_preview: extractedText.slice(0, 1200),
                extraction_mode: extractedResult.mode,
                extraction_processor: extractedResult.processor,
                ocr_legibility: {
                    initial: ocrLegibilityInitial,
                    final: ocrLegibility,
                    llm_recovery: ocrRecovery,
                },
                stage_latency_ms: stageLatencyMs,
                operator_messages: operatorMessages.map((item) => ({
                    role: item.role,
                    message: item.message,
                    created_at: item.created_at,
                })),
            },
        });
        if (!ocrLegibility.passed) {
            throw new Error(`ocr_legibility_gate_failed: ${ocrLegibility.reasons.join(', ') || 'text_not_legible_english'}`);
        }
        const chunkStartedAt = Date.now();
        chunks = splitTextIntoChunks(extractedText, options.chunk_chars, options.overlap_chars);
        stageLatencyMs.chunking = Date.now() - chunkStartedAt;
        await pool.query(`DELETE FROM document_chunks WHERE job_id = $1::uuid`, [ingestionJobId]);
        stage = 'chunking';
        await setIngestionJobStage(ingestionJobId, {
            status: 'processing',
            stage,
            message: `Chunking extracted content into ${chunks.length} chunk(s).`,
            resultMetadata: { chunk_count: chunks.length, stage_latency_ms: stageLatencyMs },
        });
        const chunkRecords = [];
        for (let i = 0; i < chunks.length; i++) {
            const inserted = await pool.query(
                `INSERT INTO document_chunks (job_id, document_id, chunk_index, content, token_estimate, metadata)
                 VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb)
                 RETURNING id, chunk_index, content`,
                [
                    ingestionJobId,
                    current.document_id,
                    i,
                    chunks[i],
                    estimateTokenCount(chunks[i]),
                    JSON.stringify({ source: current.original_filename, relative_path: current.relative_path || null }),
                ]
            );
            if (inserted.rows?.[0]) chunkRecords.push(inserted.rows[0]);
        }
        let graphSummary = {
            status: 'skipped',
            reason: skipGraph ? 'graph_disabled_for_test_mode' : 'graph_disabled_by_option',
        };
        if (!skipGraph) {
            graphSummary = await buildKnowledgeGraphForChunks({
                jobId: ingestionJobId,
                chunkRecords,
                traceId,
            });
            await insertLlmDebugLog({
                trace_id: traceId,
                span_id: crypto.randomUUID(),
                level: 'debug',
                event: 'knowledge.graph.build',
                detail: {
                    job_id: ingestionJobId,
                    summary: graphSummary,
                    chunk_count: chunks.length,
                },
            });
            await setIngestionJobStage(ingestionJobId, {
                status: 'processing',
                stage: 'chunking',
                message: 'Knowledge graph extraction completed.',
                resultMetadata: { knowledge_graph: graphSummary },
            });
        }
        if (skipVectorUpsert) {
            await setIngestionJobStage(ingestionJobId, {
                status: 'completed',
                stage: 'completed',
                completed: true,
                message: 'Chunking complete. Audit artifacts ready for manual embed/ingest.',
                resultMetadata: {
                    test_mode: testMode,
                    ready_to_ingest: true,
                    chunk_count: chunks.length,
                    point_count: 0,
                    collection_name: options.collection_name,
                    graph_skipped: skipGraph,
                    vector_upsert_skipped: true,
                    knowledge_graph: graphSummary,
                    extraction_preview: extractedText.slice(0, 1200),
                    stage_latency_ms: stageLatencyMs,
                    effective_settings: options,
                    storage_lineage: {
                        storage_bucket: current.storage_bucket || null,
                        storage_key: current.storage_key || null,
                        relative_path: current.relative_path || null,
                        mime_type: current.mime_type || null,
                    },
                },
                error: null,
            });
            await insertRequestLogRow({
                trace_id: traceId,
                span_id: spanId,
                route: 'QUEUE process_document',
                start_ts: startTs,
                end_ts: nowIso(),
                latency_ms: Date.now() - startedAt,
                status: 200,
                error: null,
                metadata: {
                    queue: 'docling_jobs',
                    job_id: ingestionJobId,
                    stage: 'completed',
                    chunk_count: chunks.length,
                    point_count: 0,
                    test_mode: testMode,
                    ready_to_ingest: true,
                    stage_latency_ms: stageLatencyMs,
                },
            });
            return {
                ok: true,
                chunk_count: chunks.length,
                point_count: 0,
                quality: null,
                ready_to_ingest: true,
                test_mode: testMode,
            };
        }
        let vectorSize = Number(options.desired_vector_size || 1536) || 1536;
        if (options.collection_mode === 'existing') {
            const existing = await qdrantRequest(`/collections/${options.collection_name}`, 'GET');
            vectorSize = Number(existing?.result?.config?.params?.vectors?.size || vectorSize) || vectorSize;
        } else {
            const ensured = await ensureQdrantCollection(options.collection_name, options);
            vectorSize = ensured.vectorSize;
        }
        stage = 'embedding';
        await setIngestionJobStage(ingestionJobId, {
            status: 'processing',
            stage,
            message: 'Generating vectors for document chunks.',
            resultMetadata: { collection_name: options.collection_name, vector_size: vectorSize, stage_latency_ms: stageLatencyMs },
        });
        await pool.query(`DELETE FROM vector_sync_records WHERE job_id = $1::uuid`, [ingestionJobId]);
        points = [];
        const embeddingStartedAt = Date.now();
        for (let i = 0; i < chunks.length; i++) {
            const embedding = await createEmbeddingVector(chunks[i], vectorSize);
            const pointId = buildDeterministicPointUuid(ingestionJobId, i);
            points.push({
                id: pointId,
                vector: embedding.vector,
                payload: {
                    job_id: ingestionJobId,
                    document_id: current.document_id,
                    chunk_index: i,
                    filename: current.original_filename,
                    relative_path: current.relative_path || null,
                    source_uri: current.storage_key || current.relative_path || current.original_filename || null,
                    content: chunks[i].slice(0, 4000),
                    operator_guidance: operatorMessages.map((item) => item.message).slice(-4),
                },
            });
            await pool.query(
                `INSERT INTO vector_sync_records (job_id, document_id, collection_name, point_id, embedding_provider, vector_size, metadata)
                 VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7::jsonb)`,
                [
                    ingestionJobId,
                    current.document_id,
                    options.collection_name,
                    pointId,
                    embedding.provider,
                    vectorSize,
                    JSON.stringify({
                        model: embedding.model,
                        note: embedding.note,
                        source_uri: current.storage_key || current.relative_path || current.original_filename || null,
                        doc_id: current.document_id,
                        chunk_id: i,
                    }),
                ]
            );
        }
        stageLatencyMs.embedding = Date.now() - embeddingStartedAt;
        stage = 'upserting';
        await setIngestionJobStage(ingestionJobId, {
            status: 'processing',
            stage,
            message: 'Writing chunk vectors to Qdrant.',
            resultMetadata: { point_count: points.length, stage_latency_ms: stageLatencyMs },
        });
        const upsertStartedAt = Date.now();
        await qdrantRequest(`/collections/${options.collection_name}/points`, 'PUT', { points });
        stageLatencyMs.upserting = Date.now() - upsertStartedAt;
        stage = 'qa';
        await setIngestionJobStage(ingestionJobId, {
            status: 'processing',
            stage,
            message: 'Running vector quality checks.',
            resultMetadata: { stage_latency_ms: stageLatencyMs },
        });
        const qaStartedAt = Date.now();
        const quality = await runVectorQualityCheck({
            collectionName: options.collection_name,
            jobId: ingestionJobId,
            options,
        });
        stageLatencyMs.qa = Date.now() - qaStartedAt;
        const assistantSummary = await buildIngestionAssistantSummary({
            objective: operatorMessages.map((item) => item.message).join('\n').slice(0, 1200),
            filename: current.original_filename,
            collection_name: options.collection_name,
            chunk_count: chunks.length,
            point_count: points.length,
            quality,
        });
        await insertLlmDebugLog({
            trace_id: traceId,
            span_id: crypto.randomUUID(),
            level: quality.status === 'failed' ? 'error' : 'debug',
            event: quality.status === 'failed' ? 'ingestion.assistant.failed' : 'ingestion.assistant.summary',
            detail: {
                job_id: ingestionJobId,
                stage: quality.status === 'failed' ? 'failed' : 'completed',
                summary: assistantSummary,
                quality,
            },
        });
        await setIngestionJobStage(ingestionJobId, {
            status: quality.status === 'failed' ? 'failed' : 'completed',
            stage: quality.status === 'failed' ? 'failed' : 'completed',
            completed: true,
            message: quality.summary,
            resultMetadata: {
                chunk_count: chunks.length,
                point_count: points.length,
                collection_name: options.collection_name,
                quality,
                extraction_preview: extractedText.slice(0, 1200),
                assistant_summary: assistantSummary,
                stage_latency_ms: stageLatencyMs,
                effective_settings: options,
                storage_lineage: {
                    storage_bucket: current.storage_bucket || null,
                    storage_key: current.storage_key || null,
                    relative_path: current.relative_path || null,
                    mime_type: current.mime_type || null,
                },
            },
            error: quality.status === 'failed' ? quality.summary : null,
        });
        await insertRequestLogRow({
            trace_id: traceId,
            span_id: spanId,
            route: 'QUEUE process_document',
            start_ts: startTs,
            end_ts: nowIso(),
            latency_ms: Date.now() - startedAt,
            status: quality.status === 'failed' ? 500 : 200,
            error: quality.status === 'failed' ? quality.summary : null,
            metadata: {
                queue: 'docling_jobs',
                job_id: ingestionJobId,
                stage: quality.status === 'failed' ? 'failed' : 'completed',
                chunk_count: chunks.length,
                point_count: points.length,
                stage_latency_ms: stageLatencyMs,
            },
        });
        return {
            ok: quality.status !== 'failed',
            chunk_count: chunks.length,
            point_count: points.length,
            quality,
        };
    } catch (error) {
        const errorText = String(error?.message || error);
        const filename = String(current?.original_filename || '');
        const collectionName = String(options?.collection_name || 'knowledge_base');
        const assistantSummary = await buildIngestionAssistantSummary({
            objective: operatorMessages.map((item) => item.message).join('\n').slice(0, 1200),
            filename,
            collection_name: collectionName,
            chunk_count: chunks.length,
            point_count: points.length,
            quality: null,
            stage,
            error: errorText,
        });
        if (ingestionJobId) {
            await setIngestionJobStage(ingestionJobId, {
                status: 'failed',
                stage: stage || 'failed',
                completed: true,
                message: `Ingestion failed during ${stage || 'processing'}`,
                resultMetadata: {
                    chunk_count: chunks.length,
                    point_count: points.length,
                    collection_name: collectionName,
                    assistant_summary: assistantSummary,
                    stage_latency_ms: stageLatencyMs,
                    effective_settings: options,
                },
                error: errorText,
                detail: {
                    trace_id: traceId,
                    failed_stage: stage || 'unknown',
                },
            }).catch(() => {});
        }
        await insertLlmDebugLog({
            trace_id: traceId,
            span_id: crypto.randomUUID(),
            level: 'error',
            event: 'ingestion.assistant.failed',
            detail: {
                job_id: ingestionJobId || null,
                stage: stage || 'unknown',
                summary: assistantSummary,
                error: errorText,
            },
        }).catch(() => {});
        await insertRequestLogRow({
            trace_id: traceId,
            span_id: spanId,
            route: 'QUEUE process_document',
            start_ts: startTs,
            end_ts: nowIso(),
            latency_ms: Date.now() - startedAt,
            status: 500,
            error: 'docling_queue_job_failed',
            metadata: {
                queue: 'docling_jobs',
                job_id: ingestionJobId || null,
                stage: stage || 'unknown',
                message: errorText,
            },
        }).catch(() => {});
        throw error;
    }
}
const app = express();
app.use(express.json({ limit: '1mb' }));

const server = http.createServer(app);
const wsAgentRespond = new WebSocketServer({ server, path: '/ws/agents/respond' });
// Observability middleware: use incoming x-trace-id if present, else generate; propagate for logs
app.use((req, res, next) => {
    const trace_id = parseTraceId(req.headers['x-trace-id']);
    const span_id = crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    req.trace_id = trace_id;
    req.span_id = span_id;
    res.setHeader('x-trace-id', trace_id);
    res.setHeader('x-span-id', span_id);
    res.on('finish', async () => {
        const end_ts = nowIso();
        const latency_ms = Date.now() - start;
        const status = res.statusCode;
        const route = `${req.method} ${req.path}`;
        const error = status >= 400 ? String(res.getHeader('x-error') || '') : null;
        jsonLog({
            level: 'info',
            trace_id,
            span_id,
            service: 'control-plane-api',
            route,
            start_ts,
            end_ts,
            latency_ms,
            status,
            error,
        });
        try {
            const severity = deriveRequestSeverity({ route, status, latency_ms, error, metadata: { ip: req.ip, ua: req.headers['user-agent'] || '' } });
            await pool.query(`INSERT INTO request_logs (trace_id, span_id, service, route, start_ts, end_ts, latency_ms, status, error, severity, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [
                trace_id,
                span_id,
                'control-plane-api',
                route,
                start_ts,
                end_ts,
                latency_ms,
                status,
                error,
                severity,
                JSON.stringify({ ip: req.ip, ua: req.headers['user-agent'] || '' }),
            ]);
        }
        catch {
            // best-effort
        }
    });
    next();
});
app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/docling/health', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    const route = 'GET /api/docling/health';
    const upstreamUrl = `${DOCLING_PROCESSOR_URL}/health`;
    const headers = DOCLING_PROCESSOR_INTERNAL_KEY ? { 'x-internal-key': DOCLING_PROCESSOR_INTERNAL_KEY } : {};
    try {
        const upstreamStart = Date.now();
        const upstream = await fetch(upstreamUrl, { headers });
        const upstreamLatencyMs = Date.now() - upstreamStart;
        const upstreamBody = await upstream.json().catch(() => ({}));
        const status = upstream.ok ? 200 : upstream.status;
        const error = upstream.ok ? null : 'docling_health_probe_failed';
        await insertRequestLogRow({
            trace_id,
            span_id,
            route,
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status,
            error,
            metadata: {
                upstream_url: upstreamUrl,
                upstream_status: upstream.status,
                upstream_latency_ms: upstreamLatencyMs,
            },
        });
        if (!upstream.ok) {
            res.setHeader('x-error', 'docling_health_probe_failed');
            return res.status(upstream.status).json({
                ok: false,
                error: 'docling_health_probe_failed',
                trace_id,
                span_id,
                upstream_url: upstreamUrl,
                upstream_status: upstream.status,
                upstream_latency_ms: upstreamLatencyMs,
                docling: upstreamBody,
            });
        }
        return res.json({
            ok: true,
            trace_id,
            span_id,
            upstream_url: upstreamUrl,
            upstream_status: upstream.status,
            upstream_latency_ms: upstreamLatencyMs,
            docling: upstreamBody,
        });
    } catch (error) {
        const message = String(error?.message || error);
        await insertRequestLogRow({
            trace_id,
            span_id,
            route,
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: 502,
            error: 'docling_health_probe_failed',
            metadata: {
                upstream_url: upstreamUrl,
                message,
            },
        });
        res.setHeader('x-error', 'docling_health_probe_failed');
        return res.status(502).json({
            ok: false,
            error: 'docling_health_probe_failed',
            message,
            trace_id,
            span_id,
            upstream_url: upstreamUrl,
        });
    }
});

app.get('/api/test', (_req, res) => res.json({ ok: true, service: 'control-plane-api' }));

app.get('/api/version', (_req, res) => {
    res.json(getDashboardVersionInfo());
});

const QDRANT_URL = process.env.QDRANT_URL || 'http://qdrant:6333';
const redisConnection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
const doclingQueue = new Queue('docling_jobs', { connection: redisConnection });
const doclingWorker = new Worker('docling_jobs', async job => processIngestionQueueJob(job), { connection: redisConnection });
async function enqueueDoclingProcessJob(ingestionJobId, traceId = '') {
    const safeJobId = String(ingestionJobId || '').trim();
    if (!safeJobId) throw new Error('missing_ingestion_job_id');
    return doclingQueue.add('process_document', {
        ingestionJobId: safeJobId,
        trace_id: firstNonEmptyString(traceId, crypto.randomUUID()),
    });
}
async function applyKnowledgeRuntimeSettings() {
    const settings = await getEngineSettings();
    const runtimeState = resolveKnowledgeRuntimeState(settings.config || {});
    if (runtimeState.queue_paused) await doclingQueue.pause();
    else await doclingQueue.resume();
    return runtimeState;
}

async function createIngestionJobRecord({
    filename,
    relativePath = '',
    mimeType = 'application/octet-stream',
    sizeBytes = 0,
    storageBucket = null,
    storageKey = null,
    storageProvider = 's3',
    metadata = {},
    options = {},
    operatorMessage = '',
    traceId = '',
    uploadBatchId = null,
    queueDocumentProcessing = true,
    jobStartMetadata = {},
    precheckErrorMessage = '',
}) {
    const documentStatus = queueDocumentProcessing ? 'uploaded' : 'failed';
    const initialJobStatus = queueDocumentProcessing ? 'queued' : 'failed';
    const initialJobStage = queueDocumentProcessing ? 'queued' : 'failed';
    const initialProgress = queueDocumentProcessing ? 10 : 100;
    const jobError = queueDocumentProcessing
        ? null
        : String(
            precheckErrorMessage
            || jobStartMetadata?.precheck_reject_reason
            || jobStartMetadata?.error
            || 'precheck_failed'
        ).slice(0, 4000);
    const documentResult = await pool.query(
        `INSERT INTO ingestion_documents (
            original_filename,
            relative_path,
            mime_type,
            size_bytes,
            storage_provider,
            storage_bucket,
            storage_key,
            status,
            metadata,
            upload_batch_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::uuid)
         RETURNING id, original_filename`,
        [
            filename,
            relativePath || null,
            mimeType || null,
            Number(sizeBytes) || 0,
            storageProvider,
            storageBucket,
            storageKey,
            documentStatus,
            JSON.stringify(metadata || {}),
            uploadBatchId || null,
        ]
    );
    const document = documentResult.rows[0];
    const normalizedOptions = buildIngestionOptions(options);
    const baseResultMeta = stripUnsupportedJsonUnicode({
        trace_id: traceId || null,
        size_bytes: Number(sizeBytes) || 0,
        mime_type: mimeType || null,
        test_mode: normalizedOptions.test_mode === true,
        effective_settings: normalizedOptions,
        upload_batch_id: uploadBatchId || null,
        storage_lineage: {
            storage_provider: storageProvider || null,
            storage_bucket: storageBucket || null,
            storage_key: storageKey || null,
            relative_path: relativePath || null,
        },
        ...jobStartMetadata,
    });
    const nowTs = new Date();
    const jobResult = await pool.query(
        `INSERT INTO ingestion_jobs (
            document_id,
            status,
            stage,
            progress_percent,
            estimated_completion_at,
            started_at,
            completed_at,
            operator_message,
            options,
            result_metadata,
            error
         ) VALUES ($1::uuid,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::timestamptz,$8,$9::jsonb,$10::jsonb,$11)
         RETURNING id, created_at`,
        [
            document.id,
            initialJobStatus,
            initialJobStage,
            initialProgress,
            queueDocumentProcessing ? estimateCompletionAt('queued') : null,
            queueDocumentProcessing ? null : nowTs,
            queueDocumentProcessing ? null : nowTs,
            operatorMessage || null,
            JSON.stringify(normalizedOptions),
            JSON.stringify(baseResultMeta),
            jobError,
        ]
    );
    const ingestionJob = jobResult.rows[0];
    if (operatorMessage) {
        await pool.query(
            `INSERT INTO ingestion_operator_messages (job_id, role, message, metadata)
             VALUES ($1::uuid,'operator',$2,$3::jsonb)`,
            [ingestionJob.id, operatorMessage, JSON.stringify({ source: 'upload_form' })]
        );
    }
    if (!queueDocumentProcessing) {
        await syncLegacyDoclingJob({
            id: document.id,
            filename,
            status: 'failed',
            resultMetadata: stripUnsupportedJsonUnicode({
                stage: 'failed',
                upload_batch_id: uploadBatchId || null,
                ...jobStartMetadata,
            }),
            error: jobError,
        });
        await logIngestionEvent(
            ingestionJob.id,
            'failed',
            'failed',
            jobError || 'Precheck rejected; document not queued for ingestion.',
            stripUnsupportedJsonUnicode({
                trace_id: traceId || null,
                upload_batch_id: uploadBatchId || null,
                ...jobStartMetadata,
            })
        );
        return {
            document_id: document.id,
            job_id: ingestionJob.id,
            queue_job_id: '',
            filename,
            precheck_blocked: true,
            estimated_completion_at: null,
        };
    }
    await syncLegacyDoclingJob({
        id: document.id,
        filename,
        status: 'pending',
        resultMetadata: {
            stage: 'queued',
            estimated_completion_at: estimateCompletionAt('queued'),
            upload_batch_id: uploadBatchId || null,
        },
    });
    await logIngestionEvent(ingestionJob.id, 'queued', 'queued', 'Job created and waiting in queue.', {
        trace_id: traceId || null,
        upload_batch_id: uploadBatchId || null,
    });
    const queueJob = await enqueueDoclingProcessJob(ingestionJob.id, traceId);
    await setIngestionJobStage(ingestionJob.id, {
        status: 'queued',
        stage: 'queued',
        queueJobId: String(queueJob.id || ''),
        message: 'Job queued for document processing.',
        detail: { queue_job_id: String(queueJob.id || ''), upload_batch_id: uploadBatchId || null },
    });
    return {
        document_id: document.id,
        job_id: ingestionJob.id,
        queue_job_id: String(queueJob.id || ''),
        filename,
        estimated_completion_at: estimateCompletionAt('queued'),
        precheck_blocked: false,
    };
}
async function getIngestionJobs(limit = 100) {
    const out = await pool.query(
        `SELECT j.id,
                j.document_id,
                j.queue_job_id,
                j.status,
                j.stage,
                j.progress_percent,
                j.estimated_completion_at,
                j.started_at,
                j.completed_at,
                j.operator_message,
                j.options,
                j.result_metadata,
                j.error,
                j.created_at,
                j.updated_at,
                d.original_filename,
                d.relative_path,
                d.mime_type,
                d.size_bytes,
                d.storage_bucket,
                d.storage_key,
                d.upload_batch_id,
                d.status AS document_status,
                q.status AS latest_quality_status,
                q.summary AS latest_quality_summary
         FROM ingestion_jobs j
         JOIN ingestion_documents d ON d.id = j.document_id
         LEFT JOIN LATERAL (
            SELECT status, summary
            FROM vector_quality_checks
            WHERE job_id = j.id
            ORDER BY created_at DESC
            LIMIT 1
         ) q ON true
         ORDER BY j.created_at DESC
         LIMIT $1`,
        [limit]
    );
    return out.rows || [];
}
async function getIngestionUploadBatchReport(batchId) {
    const batchRes = await pool.query(
        `SELECT id, trace_id, status, precheck_summary, created_at, updated_at
         FROM ingestion_upload_batches
         WHERE id = $1::uuid
         LIMIT 1`,
        [batchId]
    );
    if (batchRes.rowCount === 0) return null;
    const jobsRes = await pool.query(
        `SELECT j.id,
                j.document_id,
                j.queue_job_id,
                j.status,
                j.stage,
                j.progress_percent,
                j.estimated_completion_at,
                j.started_at,
                j.completed_at,
                j.operator_message,
                j.options,
                j.result_metadata,
                j.error,
                j.created_at,
                j.updated_at,
                d.original_filename,
                d.relative_path,
                d.mime_type,
                d.size_bytes,
                d.storage_bucket,
                d.storage_key,
                d.upload_batch_id,
                d.status AS document_status
         FROM ingestion_jobs j
         JOIN ingestion_documents d ON d.id = j.document_id
         WHERE d.upload_batch_id = $1::uuid
         ORDER BY j.created_at ASC`,
        [batchId]
    );
    const batch = batchRes.rows[0];
    return {
        batch: {
            id: batch.id,
            trace_id: batch.trace_id || null,
            status: batch.status || 'open',
            precheck_summary: batch.precheck_summary && typeof batch.precheck_summary === 'object' ? batch.precheck_summary : {},
            created_at: batch.created_at || null,
            updated_at: batch.updated_at || null,
        },
        jobs: jobsRes.rows || [],
    };
}
app.post('/api/metrics/push', async (req, res) => {
    const slug = String(req.query.server || req.body?.slug || 'ghost').trim().toLowerCase();
    const label = firstNonEmptyString(req.body?.label, slug) || slug;
    try {
        const source = await recordMetricSample({
            slug,
            label,
            sourceKind: String(req.body?.source_kind || 'push').trim() || 'push',
            config: req.body?.config || {},
            metrics: req.body || {},
            checkedAt: new Date(),
        });
        await recordServiceHealth(slug, 'healthy', 0, { source: 'push' });
        res.json({ ok: true, slug: source.slug, last_seen_at: source.last_seen_at });
    } catch (error) {
        res.setHeader('x-error', 'metrics_push_failed');
        res.status(500).json({ error: 'metrics_push_failed', message: String(error?.message || error) });
    }
});
app.post('/api/metrics/refresh', async (_req, res) => {
    try {
        const overview = await buildMetricsOverview({ refresh: true });
        res.json({ ok: true, ...overview });
    } catch (error) {
        res.setHeader('x-error', 'metrics_refresh_failed');
        res.status(500).json({ error: 'metrics_refresh_failed', message: String(error?.message || error) });
    }
});
app.get('/api/metrics/latest', async (_req, res) => {
    try {
        const overview = await buildMetricsOverview();
        res.json(overview.legacy);
    } catch (error) {
        res.setHeader('x-error', 'metrics_latest_failed');
        res.status(500).json({ error: 'metrics_latest_failed', message: String(error?.message || error) });
    }
});
app.get('/api/metrics/overview', async (_req, res) => {
    try {
        const overview = await buildMetricsOverview();
        const serviceHealth = await pool.query(
            `SELECT DISTINCT ON (service_key) service_key, status, latency_ms, detail, checked_at
             FROM service_health_checks
             ORDER BY service_key ASC, checked_at DESC`
        );
        const queueStats = await pool.query(
            `SELECT
               COUNT(*) FILTER (WHERE status = 'queued')::int AS queued_jobs,
               COUNT(*) FILTER (WHERE status = 'processing')::int AS processing_jobs,
               COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_jobs,
               COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_jobs
             FROM ingestion_jobs`
        );
        res.json({
            ok: true,
            ...overview,
            services: serviceHealth.rows || [],
            queue: queueStats.rows[0] || {
                queued_jobs: 0,
                processing_jobs: 0,
                completed_jobs: 0,
                failed_jobs: 0,
            },
        });
    } catch (error) {
        res.setHeader('x-error', 'metrics_overview_failed');
        res.status(500).json({ error: 'metrics_overview_failed', message: String(error?.message || error) });
    }
});
async function qdrantProxy(req, res, path, method, body) {
    try {
        const data = await qdrantRequest(path, method, body);
        res.json(data);
    } catch (error) {
        res.setHeader('x-error', 'qdrant_request_failed');
        res.status(500).json({ error: 'qdrant_request_failed', message: String(error?.message || error) });
    }
}
app.get('/api/qdrant/collections', (req, res) => qdrantProxy(req, res, '/collections', 'GET'));
app.get('/api/qdrant/aliases', (req, res) => qdrantProxy(req, res, '/aliases', 'GET'));
app.get('/api/qdrant/collections/:name', (req, res) => qdrantProxy(req, res, `/collections/${req.params.name}`, 'GET'));
app.post('/api/qdrant/collections', async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'missing_collection_name' });
    try {
        const config = req.body?.vectors ? req.body : buildIngestionOptions(req.body || {});
        const payload = config.vectors ? config : {
            vectors: {
                size: config.desired_vector_size,
                distance: config.distance,
            },
        };
        const data = await qdrantRequest(`/collections/${name}`, 'PUT', payload);
        await ensureQdrantCollectionMeta(name, { config: payload, metadata: { created_via: 'api' } });
        res.json(data);
    } catch (error) {
        res.setHeader('x-error', 'qdrant_create_failed');
        res.status(500).json({ error: 'qdrant_create_failed', message: String(error?.message || error) });
    }
});
app.delete('/api/qdrant/collections/:name', (req, res) => qdrantProxy(req, res, `/collections/${req.params.name}`, 'DELETE'));
app.post('/api/qdrant/collections/:name/points/search', (req, res) => qdrantProxy(req, res, `/collections/${req.params.name}/points/search`, 'POST', req.body));
app.post('/api/qdrant/collections/:name/points/count', (req, res) => qdrantProxy(req, res, `/collections/${req.params.name}/points/count`, 'POST', req.body));
app.post('/api/qdrant/collections/:name/points', (req, res) => qdrantProxy(req, res, `/collections/${req.params.name}/points`, 'PUT', req.body));
app.get('/api/qdrant/collections/:name/points', async (req, res) => {
    try {
        const limit = Math.max(1, Math.min(50, parsePositiveInt(req.query.limit, 12)));
        const offset = firstNonEmptyString(req.query.offset) || null;
        const withVector = String(req.query.with_vector || '').trim() === '1';
        const data = await getQdrantPoints(String(req.params.name || ''), limit, offset, withVector);
        res.json(data);
    } catch (error) {
        const message = String(error?.message || error);
        const statusCode = Number(error?.status || 500);
        const normalizedMessage = message.toLowerCase();
        const collectionName = String(req.params.name || '').trim();
        const expectedMiss = statusCode === 404
            || normalizedMessage.includes('not found')
            || normalizedMessage.includes('does not exist')
            || normalizedMessage.includes('collection not found')
            || normalizedMessage.includes('wrong input');
        await insertLlmDebugLog({
            trace_id: req.trace_id ?? parseTraceId(req.headers['x-trace-id']),
            span_id: req.span_id ?? crypto.randomUUID(),
            level: expectedMiss ? 'debug' : 'error',
            event: expectedMiss ? 'qdrant.points.preview_miss' : 'qdrant.points.fetch_failed',
            detail: {
                collection_name: collectionName || null,
                status: statusCode,
                message,
            },
        });
        if (expectedMiss) {
            res.setHeader('x-error', 'qdrant_collection_points_unavailable');
            return res.status(statusCode === 404 ? 404 : 200).json({
                ok: true,
                result: { points: [] },
                error: statusCode === 404 ? 'qdrant_collection_not_found' : 'qdrant_collection_points_unavailable',
                message,
            });
        }
        res.setHeader('x-error', 'qdrant_points_fetch_failed');
        res.status(500).json({ error: 'qdrant_points_fetch_failed', message });
    }
});
app.post('/api/qdrant/test-llm', async (req, res) => {
    const prompt = String(req.body?.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'missing_prompt' });
    try {
        const llm = await loadDashboardLlmConfig(String(req.body?.model_uuid || '').trim());
        if (!llm) {
            return res.status(503).json({
                error: 'dashboard_llm_not_configured',
                result: JSON.stringify({
                    collection: 'knowledge_base',
                    payload: { source: 'fallback', content: prompt.slice(0, 300) },
                }, null, 2),
            });
        }
        const llmResult = await callConfiguredLlm({
            llm,
            route: 'POST /api/qdrant/test-llm',
            body: {
                model: llm.model_id,
                temperature: 0.1,
                messages: [
                    {
                        role: 'system',
                        content: 'You produce Qdrant-friendly JSON. Return strict JSON only with keys: collection, payload, chunking, notes.',
                    },
                    { role: 'user', content: prompt },
                ],
            },
        });
        if (!llmResult.ok) {
            return res.status(llmResult.status || 502).json({
                error: llmResult.error || 'qdrant_llm_failed',
                message: llmResult.message || 'LLM request failed',
                token_policy: llmResult.token_policy,
            });
        }
        const body = llmResult.upstream_body || {};
        const text = firstNonEmptyString(body?.choices?.[0]?.message?.content, body?.choices?.[0]?.text) || '';
        const parsed = parseJsonFromLlmText(text);
        res.json({
            ok: true,
            result: JSON.stringify(parsed || { raw: text }, null, 2),
            token_policy: llmResult.token_policy,
            token_policy_notice: llmResult.token_policy_notice,
        });
    } catch (error) {
        res.setHeader('x-error', 'qdrant_llm_failed');
        res.status(500).json({ error: 'qdrant_llm_failed', message: String(error?.message || error) });
    }
});
app.get('/api/qdrant/collections/:name/quality-check', async (req, res) => {
    try {
        const refresh = String(req.query.refresh || '').trim() === '1';
        const collectionName = String(req.params.name || '').trim();
        if (!collectionName) return res.status(400).json({ error: 'missing_collection_name' });
        if (refresh) {
            const result = await runVectorQualityCheck({
                collectionName,
                jobId: firstNonEmptyString(req.query.job_id) || null,
                options: { use_llm_for_qa: true },
            });
            return res.json({ ok: true, ...result });
        }
        const latest = await pool.query(
            `SELECT id, status, score, summary, detail, created_at
             FROM vector_quality_checks
             WHERE collection_name = $1
             ORDER BY created_at DESC
             LIMIT 1`,
            [collectionName]
        );
        if (latest.rowCount === 0) {
            const result = await runVectorQualityCheck({ collectionName, options: { use_llm_for_qa: true } });
            return res.json({ ok: true, ...result });
        }
        res.json({ ok: true, ...latest.rows[0] });
    } catch (error) {
        res.setHeader('x-error', 'qdrant_quality_check_failed');
        res.status(500).json({ error: 'qdrant_quality_check_failed', message: String(error?.message || error) });
    }
});
app.post('/api/qdrant/collections/:name/check-vector', async (req, res) => {
    try {
        const collectionName = String(req.params.name || '').trim();
        const sampleText = String(req.body?.text || req.body?.sample_text || '').trim();
        if (!collectionName || !sampleText) {
            return res.status(400).json({ error: 'missing_fields', hint: 'collection name and sample text required' });
        }
        const collection = await qdrantRequest(`/collections/${collectionName}`, 'GET');
        const vectorSize = Number(collection?.result?.config?.params?.vectors?.size || 1536) || 1536;
        const embedding = await createEmbeddingVector(sampleText, vectorSize);
        res.json({
            ok: true,
            collection_name: collectionName,
            vector_size: vectorSize,
            embedding_provider: embedding.provider,
            model: embedding.model,
            note: embedding.note,
            preview: embedding.vector.slice(0, 12),
        });
    } catch (error) {
        res.setHeader('x-error', 'qdrant_vector_check_failed');
        res.status(500).json({ error: 'qdrant_vector_check_failed', message: String(error?.message || error) });
    }
});
app.post('/api/ingestion/uploads', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const route = 'POST /api/ingestion/uploads';
    const startedAt = Date.now();
    const startTs = nowIso();
    const writeUploadLog = async ({ status, error = null, metadata = {} }) => {
        await insertRequestLogRow({
            trace_id,
            span_id,
            route,
            start_ts: startTs,
            end_ts: nowIso(),
            latency_ms: Date.now() - startedAt,
            status,
            error,
            metadata,
        });
    };
    try {
        await runUploadMiddleware(req, res);
    } catch (error) {
        const mapped = mapMulterUploadError(error);
        await writeUploadLog({
            status: mapped.status,
            error: mapped.error,
            metadata: {
                multer_code: mapped.code || null,
                multer_field: mapped.field || null,
                trace_id,
            },
        });
        res.setHeader('x-error', mapped.error);
        return res.status(mapped.status).json({
            error: mapped.error,
            hint: mapped.hint,
            trace_id,
        });
    }
    const files = Array.isArray(req.files) ? req.files : [];
    const totalBytes = files.reduce((sum, file) => sum + Number(file?.size || 0), 0);
    const operatorMessage = String(req.body?.operator_message || '').trim();
    let rawOptions = {};
    try {
        rawOptions = req.body?.options ? JSON.parse(String(req.body.options || '{}')) : {};
    } catch {
        rawOptions = {};
    }
    const normalizedOptions = buildIngestionOptions(rawOptions);
    const testModeUpload = normalizedOptions.test_mode === true;
    const relativePathsRaw = Array.isArray(req.body?.relative_paths)
        ? req.body.relative_paths
        : req.body?.relative_paths ? [req.body.relative_paths] : [];
    const settingsState = await getEngineSettings();
    const knowledgeSettings = resolveKnowledgeStorageSettings(settingsState.config || {});
    if (!knowledgeSettings.s3_bucket || !knowledgeSettings.s3_region) {
        await writeUploadLog({
            status: 503,
            error: 's3_not_configured',
            metadata: { file_count: files.length, total_bytes: totalBytes },
        });
        res.setHeader('x-error', 's3_not_configured');
        return res.status(503).json({
            error: 's3_not_configured',
            hint: 'Provide S3 bucket, region, and AWS credentials to enable uploads.',
            trace_id,
        });
    }
    if (files.length === 0) {
        await writeUploadLog({
            status: 400,
            error: 'no_files_uploaded',
            metadata: { total_bytes: totalBytes },
        });
        return res.status(400).json({
            error: 'no_files_uploaded',
            hint: 'Choose at least one file before uploading.',
            trace_id,
        });
    }
    if (!normalizedOptions.collection_name) {
        await writeUploadLog({
            status: 400,
            error: 'missing_collection_target',
            metadata: { file_count: files.length, collection_mode: normalizedOptions.collection_mode },
        });
        return res.status(400).json({
            error: 'missing_collection_target',
            hint: 'Select an existing collection or choose create-new via intake settings.',
            trace_id,
        });
    }
    const collectionExists = testModeUpload
        ? true
        : await qdrantCollectionExists(normalizedOptions.collection_name).catch(() => false);
    if (!testModeUpload && normalizedOptions.collection_mode !== 'create_new' && !collectionExists) {
        await writeUploadLog({
            status: 400,
            error: 'collection_not_found',
            metadata: {
                collection_name: normalizedOptions.collection_name,
                collection_mode: normalizedOptions.collection_mode,
            },
        });
        return res.status(400).json({
            error: 'collection_not_found',
            hint: `Collection "${normalizedOptions.collection_name}" does not exist. Choose an existing collection or switch to create-new mode.`,
            trace_id,
        });
    }
    try {
        const effectiveS3Prefix = testModeUpload
            ? buildKnowledgeTestS3Prefix(knowledgeSettings.s3_prefix)
            : knowledgeSettings.s3_prefix;
        const uploadBatchId = await createIngestionUploadBatchRow(trace_id);
        const precheckLlmDisabled = String(process.env.PRE_INGEST_LLM_GATE || '').trim() === '0';
        const created = [];
        const precheckReport = {
            upload_batch_id: uploadBatchId,
            totals: {
                files: files.length,
                queued_for_ingestion: 0,
                rejected: 0,
                encrypted_reject: 0,
                precheck_failed: 0,
                group_1: 0,
                group_2: 0,
            },
            route_policy_totals: {},
            file_results: [],
        };
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const relativePath = normalizeUploadPath(relativePathsRaw[i] || file.originalname || '');
            const storageKey = buildS3ObjectKey(relativePath, file.originalname, effectiveS3Prefix);
            const routePolicy = applyPerFileIngestionRoutePolicy(
                applyFilenameChunkProfile(normalizedOptions, file.originalname),
                file.mimetype,
                file.originalname
            );
            const ingestGroup = routePolicy.ingest_group;
            const perFileOptions = routePolicy.effective_options;
            precheckReport.route_policy_totals[routePolicy.ingest_route_policy] = Number(precheckReport.route_policy_totals[routePolicy.ingest_route_policy] || 0) + 1;
            if (ingestGroup === 'group_1') {
                precheckReport.totals.group_1 += 1;
            }
            else {
                precheckReport.totals.group_2 += 1;
            }
            const enc = detectLikelyEncryptedOfficeBuffer(file.buffer, file.mimetype, file.originalname);
            const preview = await extractPreIngestPreviewLinesBestEffort(file.buffer, file.mimetype, file.originalname);
            const bypassPdfBinaryPrecheck = shouldBypassPdfBinaryPrecheck({
                mimeType: file.mimetype,
                filename: file.originalname,
                previewText: preview.preview_text,
                previewMethod: preview.method,
            });
            const basePrecheckMeta = {
                pre_ingest_gate: {
                    ingest_route_group: ingestGroup,
                    ingest_route_policy: routePolicy.ingest_route_policy,
                    explicit_override_used: routePolicy.explicit_override_used,
                    encrypted_signal: enc,
                    preview_meta: {
                        method: preview.method,
                        line_count: preview.line_count,
                        truncated: preview.truncated,
                    },
                },
            };
            const commonMeta = {
                uploaded_via: 'multipart',
                trace_id,
                test_mode: testModeUpload,
                s3_prefix: effectiveS3Prefix,
                upload_batch_id: uploadBatchId,
                ingest_route_group: ingestGroup,
                ingest_route_policy: routePolicy.ingest_route_policy,
            };
            if (enc.encrypted) {
                const row = await createIngestionJobRecord({
                    filename: file.originalname,
                    relativePath,
                    mimeType: file.mimetype,
                    sizeBytes: file.size,
                    storageBucket: null,
                    storageKey: null,
                    storageProvider: 's3',
                    metadata: {
                        ...commonMeta,
                        encrypted_file_reject: true,
                        encryption_signal: enc.signal,
                        storage_skipped_reason: 'encrypted_reject',
                        pre_ingest: basePrecheckMeta.pre_ingest_gate,
                    },
                    options: perFileOptions,
                    operatorMessage,
                    traceId: trace_id,
                    uploadBatchId,
                    queueDocumentProcessing: false,
                    precheckErrorMessage: 'encrypted_file_rejected',
                    jobStartMetadata: {
                        ...basePrecheckMeta,
                        pre_ingest_gate_outcome: 'encrypted_reject',
                        encrypted: true,
                    },
                });
                precheckReport.totals.rejected += 1;
                precheckReport.totals.encrypted_reject += 1;
                precheckReport.file_results.push({
                    filename: file.originalname,
                    outcome: 'encrypted_reject',
                    ingest_route_group: ingestGroup,
                    ingest_route_policy: routePolicy.ingest_route_policy,
                    job_id: row.job_id,
                    document_id: row.document_id,
                    reason: 'encrypted_file_rejected',
                    source: null,
                    legitimacy_source: null,
                    english_score: null,
                    legitimacy_score: null,
                });
                created.push(row);
                continue;
            }
            const verdict = precheckLlmDisabled
                ? deterministicPreIngestLegitimacyFallback(preview.preview_text, file.mimetype, file.originalname)
                : await runPreIngestLegitimacyVerdict({
                    previewText: preview.preview_text,
                    mimeType: file.mimetype,
                    filename: file.originalname,
                    traceId: trace_id,
                });
            const bypassPdfReasonHeuristic = shouldBypassPdfLegitimacyVerdict({
                mimeType: file.mimetype,
                filename: file.originalname,
                verdictReason: verdict?.reason,
            });
            const normalizedVerdict = (bypassPdfBinaryPrecheck || bypassPdfReasonHeuristic)
                ? {
                    suitable: true,
                    reason: 'pdf_binary_preview_deferred_to_ingestion',
                    source: 'pdf_binary_bypass',
                    english_score: Math.max(0.4, Number(verdict?.english_score || 0)),
                    legitimacy_score: Math.max(0.62, Number(verdict?.legitimacy_score || 0)),
                    bypassed_precheck: true,
                }
                : verdict;
            if (!normalizedVerdict.suitable) {
                const row = await createIngestionJobRecord({
                    filename: file.originalname,
                    relativePath,
                    mimeType: file.mimetype,
                    sizeBytes: file.size,
                    storageBucket: null,
                    storageKey: null,
                    storageProvider: 's3',
                    metadata: {
                        ...commonMeta,
                        pre_ingest_failed: true,
                        legitimacy_verdict: normalizedVerdict,
                        storage_skipped_reason: 'precheck_failed',
                        pre_ingest: { ...basePrecheckMeta.pre_ingest_gate, legitimacy: normalizedVerdict },
                    },
                    options: perFileOptions,
                    operatorMessage,
                    traceId: trace_id,
                    uploadBatchId,
                    queueDocumentProcessing: false,
                    precheckErrorMessage: `precheck_failed:${normalizedVerdict.reason || 'unsuitable'}`,
                    jobStartMetadata: {
                        ...basePrecheckMeta,
                        pre_ingest_gate_outcome: 'precheck_failed',
                        legitimacy: normalizedVerdict,
                    },
                });
                precheckReport.totals.rejected += 1;
                precheckReport.totals.precheck_failed += 1;
                precheckReport.file_results.push({
                    filename: file.originalname,
                    outcome: 'precheck_failed',
                    ingest_route_group: ingestGroup,
                    ingest_route_policy: routePolicy.ingest_route_policy,
                    job_id: row.job_id,
                    document_id: row.document_id,
                    reason: normalizedVerdict.reason || null,
                    source: normalizedVerdict.source || null,
                    legitimacy_source: normalizedVerdict.source || null,
                    english_score: normalizedVerdict.english_score ?? null,
                    legitimacy_score: normalizedVerdict.legitimacy_score ?? null,
                });
                created.push(row);
                continue;
            }
            await putS3ObjectBuffer(storageKey, file.buffer, file.mimetype, {
                original_filename: file.originalname,
                relative_path: relativePath,
            }, knowledgeSettings);
            const row = await createIngestionJobRecord({
                filename: file.originalname,
                relativePath,
                mimeType: file.mimetype,
                sizeBytes: file.size,
                storageBucket: knowledgeSettings.s3_bucket,
                storageKey,
                storageProvider: 's3',
                metadata: {
                    ...commonMeta,
                    legitimacy_verdict: normalizedVerdict,
                    pre_ingest: { ...basePrecheckMeta.pre_ingest_gate, legitimacy: normalizedVerdict },
                },
                options: perFileOptions,
                operatorMessage,
                traceId: trace_id,
                uploadBatchId,
                queueDocumentProcessing: true,
                jobStartMetadata: {
                    ...basePrecheckMeta,
                    pre_ingest_gate_outcome: 'passed',
                    legitimacy: normalizedVerdict,
                },
            });
            precheckReport.totals.queued_for_ingestion += 1;
            precheckReport.file_results.push({
                filename: file.originalname,
                outcome: 'queued',
                ingest_route_group: ingestGroup,
                ingest_route_policy: routePolicy.ingest_route_policy,
                job_id: row.job_id,
                document_id: row.document_id,
                reason: null,
                source: normalizedVerdict.source || null,
                legitimacy_source: normalizedVerdict.source || null,
                english_score: normalizedVerdict.english_score ?? null,
                legitimacy_score: normalizedVerdict.legitimacy_score ?? null,
            });
            created.push(row);
        }
        await finalizeIngestionUploadBatchSummary(uploadBatchId, {
            version: 1,
            precheck_llm_disabled: precheckLlmDisabled,
            totals: precheckReport.totals,
            route_policy_totals: precheckReport.route_policy_totals,
            file_results: precheckReport.file_results,
        });
        await writeUploadLog({
            status: 201,
            metadata: {
                file_count: files.length,
                total_bytes: totalBytes,
                created_jobs: created.length,
                upload_batch_id: uploadBatchId,
                precheck_totals: precheckReport.totals,
                test_mode: testModeUpload,
                s3_prefix: effectiveS3Prefix,
            },
        });
        return res.status(201).json({
            ok: true,
            uploads: created,
            upload_batch_id: uploadBatchId,
            precheck_report: precheckReport,
            trace_id,
            test_mode: testModeUpload,
            s3_prefix: effectiveS3Prefix,
            workflow_phases: [
                { phase: 'upload_started', status: 'completed' },
                { phase: 'queued', status: 'completed' },
                { phase: 'docling_processing', status: 'processing' },
                {
                    phase: 'chunk_vector_index',
                    status: testModeUpload ? 'paused_for_manual_ingest' : 'processing',
                },
            ],
            continuation: {
                mode: 'server_queue',
                browser_close_safe: true,
                queue: 'bull_redis_docling',
            },
        });
    } catch (error) {
        const mappedStorageError = mapIngestionStorageError(error);
        await writeUploadLog({
            status: mappedStorageError.status,
            error: mappedStorageError.error,
            metadata: {
                message: mappedStorageError.message,
                file_count: files.length,
                total_bytes: totalBytes,
            },
        });
        res.setHeader('x-error', mappedStorageError.error);
        return res.status(mappedStorageError.status).json({
            error: mappedStorageError.error,
            hint: mappedStorageError.hint,
            message: mappedStorageError.message,
            trace_id,
        });
    }
});
app.get('/api/ingestion/jobs', async (req, res) => {
    try {
        const limit = Math.max(1, Math.min(200, parsePositiveInt(req.query.limit, 100)));
        const jobs = await getIngestionJobs(limit);
        res.json({ jobs });
    } catch (error) {
        res.setHeader('x-error', 'ingestion_jobs_fetch_failed');
        res.status(500).json({ error: 'ingestion_jobs_fetch_failed', message: String(error?.message || error) });
    }
});
app.get('/api/ingestion/upload-batches/:id', async (req, res) => {
    try {
        const batchId = String(req.params.id || '').trim();
        if (!batchId) return res.status(400).json({ error: 'missing_upload_batch_id' });
        const report = await getIngestionUploadBatchReport(batchId);
        if (!report) return res.status(404).json({ error: 'ingestion_upload_batch_not_found' });
        return res.json(report);
    } catch (error) {
        res.setHeader('x-error', 'ingestion_upload_batch_fetch_failed');
        return res.status(500).json({ error: 'ingestion_upload_batch_fetch_failed', message: String(error?.message || error) });
    }
});
app.get('/api/ingestion/queue/status', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    try {
        const [settings, queueCounts, jobCounts] = await Promise.all([
            getEngineSettings(),
            doclingQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused'),
            pool.query(
                `SELECT
                   COUNT(*) FILTER (WHERE status = 'queued')::int AS queued_jobs,
                   COUNT(*) FILTER (WHERE status = 'processing')::int AS processing_jobs,
                   COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_jobs,
                   COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_jobs,
                   COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_jobs
                 FROM ingestion_jobs`
            ),
        ]);
        const runtime = resolveKnowledgeRuntimeState(settings.config || {});
        const isPaused = await doclingQueue.isPaused();
        const payload = {
            ok: true,
            queue: {
                paused: isPaused || runtime.queue_paused,
                counts: queueCounts,
            },
            jobs: jobCounts.rows?.[0] || {},
        };
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'GET /api/ingestion/queue/status',
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: 200,
            metadata: { paused: payload.queue.paused, queue_counts: queueCounts },
        });
        return res.json(payload);
    } catch (error) {
        const message = String(error?.message || error);
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'GET /api/ingestion/queue/status',
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: 500,
            error: 'ingestion_queue_status_failed',
            metadata: { message },
        });
        res.setHeader('x-error', 'ingestion_queue_status_failed');
        return res.status(500).json({ error: 'ingestion_queue_status_failed', message });
    }
});
app.post('/api/ingestion/queue/pause', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    try {
        await doclingQueue.pause();
        await saveEngineSettingsPatch({ knowledge_runtime: { queue_paused: true } });
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/ingestion/queue/pause',
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: 200,
            metadata: { action: 'pause' },
        });
        return res.json({ ok: true, queue_paused: true });
    } catch (error) {
        const message = String(error?.message || error);
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/ingestion/queue/pause',
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: 500,
            error: 'ingestion_queue_pause_failed',
            metadata: { message },
        });
        res.setHeader('x-error', 'ingestion_queue_pause_failed');
        return res.status(500).json({ error: 'ingestion_queue_pause_failed', message });
    }
});
app.post('/api/ingestion/queue/resume', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    try {
        await doclingQueue.resume();
        await saveEngineSettingsPatch({ knowledge_runtime: { queue_paused: false } });
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/ingestion/queue/resume',
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: 200,
            metadata: { action: 'resume' },
        });
        return res.json({ ok: true, queue_paused: false });
    } catch (error) {
        const message = String(error?.message || error);
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/ingestion/queue/resume',
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: 500,
            error: 'ingestion_queue_resume_failed',
            metadata: { message },
        });
        res.setHeader('x-error', 'ingestion_queue_resume_failed');
        return res.status(500).json({ error: 'ingestion_queue_resume_failed', message });
    }
});
app.get('/api/ingestion/jobs/:id', async (req, res) => {
    try {
        const jobId = String(req.params.id || '').trim();
        const chunkLimit = Math.max(1, Math.min(200, parsePositiveInt(req.query.chunk_limit, 25)));
        const chunkOffset = Math.max(0, parsePositiveInt(req.query.chunk_offset, 0));
        const vectorLimit = Math.max(1, Math.min(200, parsePositiveInt(req.query.vector_limit, 25)));
        const vectorOffset = Math.max(0, parsePositiveInt(req.query.vector_offset, 0));
        const jobRes = await pool.query(
            `SELECT j.*, d.original_filename, d.relative_path, d.mime_type, d.size_bytes, d.storage_bucket, d.storage_key, d.upload_batch_id
             FROM ingestion_jobs j
             JOIN ingestion_documents d ON d.id = j.document_id
             WHERE j.id = $1::uuid
             LIMIT 1`,
            [jobId]
        );
        if (jobRes.rowCount === 0) {
            return res.status(404).json({ error: 'ingestion_job_not_found' });
        }
        const [events, messages, chunks, vectors, quality, chunkCountRes, vectorCountRes] = await Promise.all([
            pool.query(`SELECT * FROM ingestion_job_events WHERE job_id = $1::uuid ORDER BY created_at DESC LIMIT 50`, [jobId]),
            pool.query(`SELECT * FROM ingestion_operator_messages WHERE job_id = $1::uuid ORDER BY created_at ASC`, [jobId]),
            pool.query(
                `SELECT chunk_index, content, token_estimate, metadata, created_at
                 FROM document_chunks
                 WHERE job_id = $1::uuid
                 ORDER BY chunk_index ASC
                 LIMIT $2 OFFSET $3`,
                [jobId, chunkLimit, chunkOffset]
            ),
            pool.query(
                `SELECT collection_name, point_id, embedding_provider, vector_size, metadata, created_at
                 FROM vector_sync_records
                 WHERE job_id = $1::uuid
                 ORDER BY created_at DESC
                 LIMIT $2 OFFSET $3`,
                [jobId, vectorLimit, vectorOffset]
            ),
            pool.query(`SELECT status, score, summary, detail, created_at FROM vector_quality_checks WHERE job_id = $1::uuid ORDER BY created_at DESC LIMIT 10`, [jobId]),
            pool.query(`SELECT COUNT(*)::int AS count FROM document_chunks WHERE job_id = $1::uuid`, [jobId]),
            pool.query(`SELECT COUNT(*)::int AS count FROM vector_sync_records WHERE job_id = $1::uuid`, [jobId]),
        ]);
        const eventRows = events.rows || [];
        const stageTimeline = [];
        for (let i = 0; i < eventRows.length; i++) {
            const current = eventRows[i];
            const next = eventRows[i + 1] || null;
            const currentTs = new Date(current.created_at).getTime();
            const nextTs = next ? new Date(next.created_at).getTime() : null;
            stageTimeline.push({
                stage: current.stage,
                status: current.status,
                started_at: current.created_at,
                approx_latency_ms: Number.isFinite(currentTs) && Number.isFinite(nextTs) && nextTs != null ? Math.max(0, currentTs - nextTs) : null,
            });
        }
        res.json({
            job: jobRes.rows[0],
            events: eventRows,
            operator_messages: messages.rows || [],
            chunks: chunks.rows || [],
            vectors: vectors.rows || [],
            quality_checks: quality.rows || [],
            stage_timeline: stageTimeline,
            pagination: {
                chunks: {
                    limit: chunkLimit,
                    offset: chunkOffset,
                    total: Number(chunkCountRes.rows?.[0]?.count || 0),
                },
                vectors: {
                    limit: vectorLimit,
                    offset: vectorOffset,
                    total: Number(vectorCountRes.rows?.[0]?.count || 0),
                },
            },
        });
    } catch (error) {
        res.setHeader('x-error', 'ingestion_job_detail_failed');
        res.status(500).json({ error: 'ingestion_job_detail_failed', message: String(error?.message || error) });
    }
});
app.get('/api/ingestion/jobs/:id/chunks', async (req, res) => {
    try {
        const jobId = String(req.params.id || '').trim();
        const limit = Math.max(1, Math.min(500, parsePositiveInt(req.query.limit, 100)));
        const offset = Math.max(0, parsePositiveInt(req.query.offset, 0));
        const rows = await pool.query(
            `SELECT chunk_index, content, token_estimate, metadata, created_at
             FROM document_chunks
             WHERE job_id = $1::uuid
             ORDER BY chunk_index ASC
             LIMIT $2 OFFSET $3`,
            [jobId, limit, offset]
        );
        const total = await pool.query(`SELECT COUNT(*)::int AS count FROM document_chunks WHERE job_id = $1::uuid`, [jobId]);
        return res.json({
            ok: true,
            rows: rows.rows || [],
            total: Number(total.rows?.[0]?.count || 0),
            limit,
            offset,
        });
    } catch (error) {
        res.setHeader('x-error', 'ingestion_job_chunks_fetch_failed');
        return res.status(500).json({ error: 'ingestion_job_chunks_fetch_failed', message: String(error?.message || error) });
    }
});
app.get('/api/ingestion/jobs/:id/vectors', async (req, res) => {
    try {
        const jobId = String(req.params.id || '').trim();
        const limit = Math.max(1, Math.min(500, parsePositiveInt(req.query.limit, 100)));
        const offset = Math.max(0, parsePositiveInt(req.query.offset, 0));
        const rows = await pool.query(
            `SELECT collection_name, point_id, embedding_provider, vector_size, metadata, created_at
             FROM vector_sync_records
             WHERE job_id = $1::uuid
             ORDER BY created_at DESC
             LIMIT $2 OFFSET $3`,
            [jobId, limit, offset]
        );
        const total = await pool.query(`SELECT COUNT(*)::int AS count FROM vector_sync_records WHERE job_id = $1::uuid`, [jobId]);
        return res.json({
            ok: true,
            rows: rows.rows || [],
            total: Number(total.rows?.[0]?.count || 0),
            limit,
            offset,
        });
    } catch (error) {
        res.setHeader('x-error', 'ingestion_job_vectors_fetch_failed');
        return res.status(500).json({ error: 'ingestion_job_vectors_fetch_failed', message: String(error?.message || error) });
    }
});
app.post('/api/ingestion/jobs/:id/embed-preview', async (req, res) => {
    const traceId = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const spanId = req.span_id ?? crypto.randomUUID();
    const route = 'POST /api/ingestion/jobs/:id/embed-preview';
    const startedAt = Date.now();
    const startTs = nowIso();
    try {
        const jobId = String(req.params.id || '').trim();
        const jobRes = await pool.query(
            `SELECT j.id, j.document_id, j.options, d.original_filename
             FROM ingestion_jobs j
             JOIN ingestion_documents d ON d.id = j.document_id
             WHERE j.id = $1::uuid
             LIMIT 1`,
            [jobId]
        );
        if (jobRes.rowCount === 0) return res.status(404).json({ error: 'ingestion_job_not_found' });
        const jobRow = jobRes.rows[0];
        const options = buildIngestionOptions(jobRow.options || {});
        if (!options.test_mode) {
            return res.status(409).json({
                error: 'embed_preview_only_for_test_mode',
                hint: 'Embed preview is only supported for jobs uploaded in test mode.',
            });
        }
        const chunksRes = await pool.query(
            `SELECT chunk_index, content
             FROM document_chunks
             WHERE job_id = $1::uuid
             ORDER BY chunk_index ASC`,
            [jobId]
        );
        const chunkRows = chunksRes.rows || [];
        if (chunkRows.length === 0) {
            return res.status(409).json({
                error: 'embed_preview_requires_chunks',
                hint: 'No chunk records found yet. Wait for OCR/chunking to complete.',
            });
        }
        const vectorSize = Number(options.desired_vector_size || 1536) || 1536;
        const startedAt = Date.now();
        const sample = [];
        const providers = {};
        for (let i = 0; i < chunkRows.length; i++) {
            const row = chunkRows[i];
            const embedding = await createEmbeddingVector(String(row.content || ''), vectorSize);
            const providerKey = String(embedding.provider || 'unknown');
            providers[providerKey] = (Number(providers[providerKey]) || 0) + 1;
            if (sample.length < 3) {
                sample.push({
                    chunk_index: Number(row.chunk_index || i),
                    provider: embedding.provider,
                    model: embedding.model,
                    vector_size: Number(Array.isArray(embedding.vector) ? embedding.vector.length : vectorSize),
                    preview: Array.isArray(embedding.vector) ? embedding.vector.slice(0, 12) : [],
                });
            }
        }
        const previewSummary = {
            generated_at: nowIso(),
            chunk_count: chunkRows.length,
            vector_size: vectorSize,
            latency_ms: Date.now() - startedAt,
            provider_counts: providers,
            sample,
        };
        await setIngestionJobStage(jobId, {
            status: 'completed',
            stage: 'completed',
            completed: true,
            message: 'Embed preview generated (no vector upsert).',
            resultMetadata: {
                test_mode: true,
                embed_preview_only: true,
                ready_to_ingest: true,
                embed_preview: previewSummary,
            },
        });
        await logIngestionEvent(jobId, 'embedding', 'completed', 'Embed preview generated without vector upsert.', {
            trace_id: traceId,
            test_mode: true,
            chunk_count: chunkRows.length,
            vector_size: vectorSize,
        });
        await insertRequestLogRow({
            trace_id: traceId,
            span_id: spanId,
            route,
            start_ts: startTs,
            end_ts: nowIso(),
            latency_ms: Date.now() - startedAt,
            status: 200,
            metadata: {
                job_id: jobId,
                test_mode: true,
                chunk_count: chunkRows.length,
                vector_size: vectorSize,
            },
        });
        return res.json({
            ok: true,
            test_mode: true,
            embed_preview: previewSummary,
        });
    } catch (error) {
        await insertRequestLogRow({
            trace_id: traceId,
            span_id: spanId,
            route,
            start_ts: startTs,
            end_ts: nowIso(),
            latency_ms: Date.now() - startedAt,
            status: 500,
            error: 'ingestion_embed_preview_failed',
            metadata: { message: String(error?.message || error) },
        });
        res.setHeader('x-error', 'ingestion_embed_preview_failed');
        return res.status(500).json({ error: 'ingestion_embed_preview_failed', message: String(error?.message || error) });
    }
});
app.post('/api/ingestion/jobs/:id/ingest', async (req, res) => {
    const traceId = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const spanId = req.span_id ?? crypto.randomUUID();
    const route = 'POST /api/ingestion/jobs/:id/ingest';
    const startedAt = Date.now();
    const startTs = nowIso();
    try {
        const jobId = String(req.params.id || '').trim();
        const jobRes = await pool.query(
            `SELECT j.id, j.document_id, j.options, d.original_filename, d.relative_path, d.storage_key
             FROM ingestion_jobs j
             JOIN ingestion_documents d ON d.id = j.document_id
             WHERE j.id = $1::uuid
             LIMIT 1`,
            [jobId]
        );
        if (jobRes.rowCount === 0) return res.status(404).json({ error: 'ingestion_job_not_found' });
        const row = jobRes.rows[0];
        const options = buildIngestionOptions(row.options || {});
        if (!options.test_mode) {
            return res.status(409).json({
                error: 'manual_ingest_only_for_test_mode',
                hint: 'Manual ingest is only available for test-mode jobs.',
            });
        }
        const chunkRes = await pool.query(
            `SELECT chunk_index, content
             FROM document_chunks
             WHERE job_id = $1::uuid
             ORDER BY chunk_index ASC`,
            [jobId]
        );
        const chunks = chunkRes.rows || [];
        if (chunks.length === 0) {
            return res.status(409).json({
                error: 'manual_ingest_requires_chunks',
                hint: 'Chunks are required before manual ingest.',
            });
        }
        await setIngestionJobStage(jobId, {
            status: 'processing',
            stage: 'embedding',
            message: 'Manual ingest started: generating chunk vectors.',
            resultMetadata: {
                test_mode: true,
                manual_ingest_started_at: nowIso(),
            },
        });
        let vectorSize = Number(options.desired_vector_size || 1536) || 1536;
        if (options.collection_mode === 'existing') {
            const existing = await qdrantRequest(`/collections/${options.collection_name}`, 'GET');
            vectorSize = Number(existing?.result?.config?.params?.vectors?.size || vectorSize) || vectorSize;
        } else {
            const ensured = await ensureQdrantCollection(options.collection_name, options);
            vectorSize = ensured.vectorSize;
        }
        await pool.query(`DELETE FROM vector_sync_records WHERE job_id = $1::uuid`, [jobId]);
        const points = [];
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const content = String(chunk.content || '');
            const embedding = await createEmbeddingVector(content, vectorSize);
            const pointId = buildDeterministicPointUuid(jobId, Number(chunk.chunk_index || i));
            points.push({
                id: pointId,
                vector: embedding.vector,
                payload: {
                    job_id: jobId,
                    document_id: row.document_id,
                    chunk_index: Number(chunk.chunk_index || i),
                    filename: row.original_filename,
                    relative_path: row.relative_path || null,
                    source_uri: row.storage_key || row.relative_path || row.original_filename || null,
                    content: content.slice(0, 4000),
                },
            });
            await pool.query(
                `INSERT INTO vector_sync_records (job_id, document_id, collection_name, point_id, embedding_provider, vector_size, metadata)
                 VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7::jsonb)`,
                [
                    jobId,
                    row.document_id,
                    options.collection_name,
                    pointId,
                    embedding.provider,
                    vectorSize,
                    JSON.stringify({
                        model: embedding.model,
                        note: 'manual_ingest_from_test_mode',
                        doc_id: row.document_id,
                        chunk_id: Number(chunk.chunk_index || i),
                    }),
                ]
            );
        }
        await setIngestionJobStage(jobId, {
            status: 'processing',
            stage: 'upserting',
            message: 'Manual ingest: writing vectors to Qdrant.',
            resultMetadata: {
                test_mode: true,
                manual_ingest_started_at: nowIso(),
                point_count: points.length,
                collection_name: options.collection_name,
            },
        });
        await qdrantRequest(`/collections/${options.collection_name}/points`, 'PUT', { points });
        await setIngestionJobStage(jobId, {
            status: 'processing',
            stage: 'qa',
            message: 'Manual ingest: running vector quality checks.',
            resultMetadata: { test_mode: true, point_count: points.length },
        });
        const quality = await runVectorQualityCheck({
            collectionName: options.collection_name,
            jobId,
            options,
        });
        await setIngestionJobStage(jobId, {
            status: quality.status === 'failed' ? 'failed' : 'completed',
            stage: quality.status === 'failed' ? 'failed' : 'completed',
            completed: true,
            message: quality.summary,
            resultMetadata: {
                test_mode: true,
                ready_to_ingest: false,
                manual_ingest_completed_at: nowIso(),
                point_count: points.length,
                collection_name: options.collection_name,
                quality,
            },
            error: quality.status === 'failed' ? quality.summary : null,
        });
        await logIngestionEvent(jobId, quality.status === 'failed' ? 'failed' : 'completed', quality.status === 'failed' ? 'failed' : 'completed', 'Manual ingest completed from test mode.', {
            trace_id: traceId,
            test_mode: true,
            point_count: points.length,
            collection_name: options.collection_name,
        });
        await insertRequestLogRow({
            trace_id: traceId,
            span_id: spanId,
            route,
            start_ts: startTs,
            end_ts: nowIso(),
            latency_ms: Date.now() - startedAt,
            status: quality.status === 'failed' ? 500 : 200,
            error: quality.status === 'failed' ? 'ingestion_manual_ingest_failed' : null,
            metadata: {
                job_id: jobId,
                test_mode: true,
                point_count: points.length,
                collection_name: options.collection_name,
                quality_status: quality.status,
            },
        });
        return res.json({
            ok: quality.status !== 'failed',
            test_mode: true,
            manual_ingest: true,
            point_count: points.length,
            quality,
        });
    } catch (error) {
        await insertRequestLogRow({
            trace_id: traceId,
            span_id: spanId,
            route,
            start_ts: startTs,
            end_ts: nowIso(),
            latency_ms: Date.now() - startedAt,
            status: 500,
            error: 'ingestion_manual_ingest_failed',
            metadata: { message: String(error?.message || error) },
        });
        res.setHeader('x-error', 'ingestion_manual_ingest_failed');
        return res.status(500).json({ error: 'ingestion_manual_ingest_failed', message: String(error?.message || error) });
    }
});
app.post('/api/ingestion/jobs/:id/pause', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    const route = 'POST /api/ingestion/jobs/:id/pause';
    try {
        const jobId = String(req.params.id || '').trim();
        const current = await pool.query(
            `SELECT id, status, stage, queue_job_id
             FROM ingestion_jobs
             WHERE id = $1::uuid
             LIMIT 1`,
            [jobId]
        );
        if (current.rowCount === 0) {
            await insertRequestLogRow({
                trace_id,
                span_id,
                route,
                start_ts,
                end_ts: nowIso(),
                latency_ms: Date.now() - start,
                status: 404,
                error: 'ingestion_job_not_found',
                metadata: { job_id: jobId },
            });
            return res.status(404).json({ error: 'ingestion_job_not_found' });
        }
        const row = current.rows[0];
        if (String(row.status) === 'processing') {
            await insertRequestLogRow({
                trace_id,
                span_id,
                route,
                start_ts,
                end_ts: nowIso(),
                latency_ms: Date.now() - start,
                status: 409,
                error: 'ingestion_job_pause_unsafe',
                metadata: { job_id: jobId, status: row.status },
            });
            return res.status(409).json({
                error: 'ingestion_job_pause_unsafe',
                hint: 'Job is already processing. Use cancel then retry for safe recovery.',
            });
        }
        if (String(row.status) === 'completed' || String(row.status) === 'failed' || String(row.status) === 'cancelled') {
            await insertRequestLogRow({
                trace_id,
                span_id,
                route,
                start_ts,
                end_ts: nowIso(),
                latency_ms: Date.now() - start,
                status: 409,
                error: 'ingestion_job_not_pauseable',
                metadata: { job_id: jobId, status: row.status },
            });
            return res.status(409).json({
                error: 'ingestion_job_not_pauseable',
                hint: 'Only queued jobs can be paused.',
            });
        }
        const queueJobId = firstNonEmptyString(row.queue_job_id);
        if (queueJobId) {
            const queueJob = await doclingQueue.getJob(queueJobId);
            if (queueJob) {
                try { await queueJob.remove(); } catch {}
            }
        }
        await setIngestionJobStage(jobId, {
            status: 'queued',
            stage: 'queued',
            queueJobId: '',
            resultMetadata: { paused_by_operator: true, paused_at: nowIso() },
            message: 'Job paused by operator before processing.',
        });
        await insertRequestLogRow({
            trace_id,
            span_id,
            route,
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: 200,
            metadata: { job_id: jobId, action: 'pause', queue_job_id: queueJobId || null },
        });
        res.json({ ok: true, paused: true });
    } catch (error) {
        await insertRequestLogRow({
            trace_id,
            span_id,
            route,
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: 500,
            error: 'ingestion_job_pause_failed',
            metadata: {
                job_id: String(req.params.id || '').trim() || null,
                message: String(error?.message || error),
            },
        });
        res.setHeader('x-error', 'ingestion_job_pause_failed');
        res.status(500).json({ error: 'ingestion_job_pause_failed', message: String(error?.message || error) });
    }
});
app.post('/api/ingestion/jobs/:id/resume', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    const route = 'POST /api/ingestion/jobs/:id/resume';
    try {
        const jobId = String(req.params.id || '').trim();
        const current = await pool.query(
            `SELECT id, status, result_metadata, queue_job_id
             FROM ingestion_jobs
             WHERE id = $1::uuid
             LIMIT 1`,
            [jobId]
        );
        if (current.rowCount === 0) {
            await insertRequestLogRow({
                trace_id,
                span_id,
                route,
                start_ts,
                end_ts: nowIso(),
                latency_ms: Date.now() - start,
                status: 404,
                error: 'ingestion_job_not_found',
                metadata: { job_id: jobId },
            });
            return res.status(404).json({ error: 'ingestion_job_not_found' });
        }
        const row = current.rows[0];
        if (String(row.status) !== 'queued') {
            await insertRequestLogRow({
                trace_id,
                span_id,
                route,
                start_ts,
                end_ts: nowIso(),
                latency_ms: Date.now() - start,
                status: 409,
                error: 'ingestion_job_not_resumable',
                metadata: { job_id: jobId, status: row.status },
            });
            return res.status(409).json({ error: 'ingestion_job_not_resumable', hint: 'Only queued jobs can be resumed.' });
        }
        const existingQueueJobId = firstNonEmptyString(row.queue_job_id);
        if (existingQueueJobId) {
            const existingQueueJob = await doclingQueue.getJob(existingQueueJobId);
            if (existingQueueJob) {
                const state = await existingQueueJob.getState().catch(() => 'unknown');
                if (state === 'waiting' || state === 'delayed' || state === 'active') {
                    await insertRequestLogRow({
                        trace_id,
                        span_id,
                        route,
                        start_ts,
                        end_ts: nowIso(),
                        latency_ms: Date.now() - start,
                        status: 200,
                        metadata: {
                            job_id: jobId,
                            action: 'resume',
                            queue_job_id: existingQueueJobId,
                            already_queued: true,
                            queue_state: state,
                        },
                    });
                    return res.json({
                        ok: true,
                        queue_job_id: existingQueueJobId,
                        already_queued: true,
                        queue_state: state,
                    });
                }
            }
        }
        const queueJob = await enqueueDoclingProcessJob(jobId, req.trace_id);
        await setIngestionJobStage(jobId, {
            status: 'queued',
            stage: 'queued',
            progressPercent: 10,
            queueJobId: String(queueJob.id || ''),
            error: null,
            resultMetadata: {
                ...(row.result_metadata && typeof row.result_metadata === 'object' ? row.result_metadata : {}),
                paused_by_operator: false,
                resumed_at: nowIso(),
            },
            message: 'Paused job resumed and re-queued.',
        });
        await insertRequestLogRow({
            trace_id,
            span_id,
            route,
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: 200,
            metadata: {
                job_id: jobId,
                action: 'resume',
                queue_job_id: String(queueJob.id || ''),
                already_queued: false,
            },
        });
        res.json({ ok: true, queue_job_id: String(queueJob.id || '') });
    } catch (error) {
        await insertRequestLogRow({
            trace_id,
            span_id,
            route,
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: 500,
            error: 'ingestion_job_resume_failed',
            metadata: {
                job_id: String(req.params.id || '').trim() || null,
                message: String(error?.message || error),
            },
        });
        res.setHeader('x-error', 'ingestion_job_resume_failed');
        res.status(500).json({ error: 'ingestion_job_resume_failed', message: String(error?.message || error) });
    }
});
app.post('/api/ingestion/jobs/:id/retry', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    const route = 'POST /api/ingestion/jobs/:id/retry';
    try {
        const jobId = String(req.params.id || '').trim();
        const jobRes = await pool.query(
            `SELECT j.id, j.status, j.queue_job_id, d.original_filename
             FROM ingestion_jobs j
             JOIN ingestion_documents d ON d.id = j.document_id
             WHERE j.id = $1::uuid
             LIMIT 1`,
            [jobId]
        );
        if (jobRes.rowCount === 0) {
            await insertRequestLogRow({
                trace_id,
                span_id,
                route,
                start_ts,
                end_ts: nowIso(),
                latency_ms: Date.now() - start,
                status: 404,
                error: 'ingestion_job_not_found',
                metadata: { job_id: jobId },
            });
            return res.status(404).json({ error: 'ingestion_job_not_found' });
        }
        const row = jobRes.rows[0];
        const currentStatus = String(row.status || '').toLowerCase();
        if (currentStatus !== 'failed' && currentStatus !== 'cancelled') {
            await insertRequestLogRow({
                trace_id,
                span_id,
                route,
                start_ts,
                end_ts: nowIso(),
                latency_ms: Date.now() - start,
                status: 409,
                error: 'ingestion_job_retry_not_allowed',
                metadata: { job_id: jobId, status: currentStatus },
            });
            return res.status(409).json({
                error: 'ingestion_job_retry_not_allowed',
                hint: 'Only failed or cancelled jobs can be retried.',
            });
        }
        const existingQueueJobId = firstNonEmptyString(row.queue_job_id);
        if (existingQueueJobId) {
            const existingQueueJob = await doclingQueue.getJob(existingQueueJobId);
            if (existingQueueJob) {
                const state = await existingQueueJob.getState().catch(() => 'unknown');
                if (state === 'waiting' || state === 'delayed' || state === 'active') {
                    await insertRequestLogRow({
                        trace_id,
                        span_id,
                        route,
                        start_ts,
                        end_ts: nowIso(),
                        latency_ms: Date.now() - start,
                        status: 200,
                        metadata: {
                            job_id: jobId,
                            action: 'retry',
                            queue_job_id: existingQueueJobId,
                            already_queued: true,
                            queue_state: state,
                        },
                    });
                    return res.json({
                        ok: true,
                        queue_job_id: existingQueueJobId,
                        already_queued: true,
                        queue_state: state,
                    });
                }
            }
        }
        await pool.query(`DELETE FROM document_chunks WHERE job_id = $1::uuid`, [jobId]);
        await pool.query(`DELETE FROM vector_sync_records WHERE job_id = $1::uuid`, [jobId]);
        const queueJob = await enqueueDoclingProcessJob(jobId, req.trace_id);
        await setIngestionJobStage(jobId, {
            status: 'queued',
            stage: 'queued',
            progressPercent: 10,
            queueJobId: String(queueJob.id || ''),
            error: null,
            resultMetadata: { retry_requested_at: nowIso() },
            message: 'Retry requested and job re-queued.',
        });
        await insertRequestLogRow({
            trace_id,
            span_id,
            route,
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: 200,
            metadata: {
                job_id: jobId,
                action: 'retry',
                queue_job_id: String(queueJob.id || ''),
                previous_status: currentStatus,
            },
        });
        res.json({ ok: true, queue_job_id: String(queueJob.id || '') });
    } catch (error) {
        await insertRequestLogRow({
            trace_id,
            span_id,
            route,
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: 500,
            error: 'ingestion_job_retry_failed',
            metadata: {
                job_id: String(req.params.id || '').trim() || null,
                message: String(error?.message || error),
            },
        });
        res.setHeader('x-error', 'ingestion_job_retry_failed');
        res.status(500).json({ error: 'ingestion_job_retry_failed', message: String(error?.message || error) });
    }
});
app.post('/api/ingestion/jobs/:id/cancel', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    const route = 'POST /api/ingestion/jobs/:id/cancel';
    try {
        const jobId = String(req.params.id || '').trim();
        const current = await pool.query(`SELECT status, queue_job_id FROM ingestion_jobs WHERE id = $1::uuid LIMIT 1`, [jobId]);
        if (current.rowCount === 0) {
            await insertRequestLogRow({
                trace_id,
                span_id,
                route,
                start_ts,
                end_ts: nowIso(),
                latency_ms: Date.now() - start,
                status: 404,
                error: 'ingestion_job_not_found',
                metadata: { job_id: jobId },
            });
            return res.status(404).json({ error: 'ingestion_job_not_found' });
        }
        const status = String(current.rows[0]?.status || '').toLowerCase();
        if (status === 'cancelled') {
            await insertRequestLogRow({
                trace_id,
                span_id,
                route,
                start_ts,
                end_ts: nowIso(),
                latency_ms: Date.now() - start,
                status: 200,
                metadata: { job_id: jobId, action: 'cancel', already_cancelled: true },
            });
            return res.json({ ok: true, already_cancelled: true });
        }
        if (status === 'completed' || status === 'failed') {
            await insertRequestLogRow({
                trace_id,
                span_id,
                route,
                start_ts,
                end_ts: nowIso(),
                latency_ms: Date.now() - start,
                status: 409,
                error: 'ingestion_job_not_cancellable',
                metadata: { job_id: jobId, status },
            });
            return res.status(409).json({
                error: 'ingestion_job_not_cancellable',
                hint: 'Only queued jobs can be cancelled.',
            });
        }
        if (status === 'processing') {
            await insertRequestLogRow({
                trace_id,
                span_id,
                route,
                start_ts,
                end_ts: nowIso(),
                latency_ms: Date.now() - start,
                status: 409,
                error: 'ingestion_job_cancel_unsafe',
                metadata: { job_id: jobId, status },
            });
            return res.status(409).json({
                error: 'ingestion_job_cancel_unsafe',
                hint: 'Job is already processing. Pause or wait until it reaches a safe state.',
            });
        }
        const queueJobId = firstNonEmptyString(current.rows[0]?.queue_job_id);
        if (queueJobId) {
            const queueJob = await doclingQueue.getJob(queueJobId);
            if (queueJob) {
                try { await queueJob.remove(); } catch {}
            }
        }
        await setIngestionJobStage(jobId, {
            status: 'cancelled',
            stage: 'cancelled',
            completed: true,
            message: 'Job cancelled by operator.',
        });
        await insertRequestLogRow({
            trace_id,
            span_id,
            route,
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: 200,
            metadata: { job_id: jobId, action: 'cancel', queue_job_id: queueJobId || null },
        });
        res.json({ ok: true });
    } catch (error) {
        await insertRequestLogRow({
            trace_id,
            span_id,
            route,
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: 500,
            error: 'ingestion_job_cancel_failed',
            metadata: {
                job_id: String(req.params.id || '').trim() || null,
                message: String(error?.message || error),
            },
        });
        res.setHeader('x-error', 'ingestion_job_cancel_failed');
        res.status(500).json({ error: 'ingestion_job_cancel_failed', message: String(error?.message || error) });
    }
});
app.delete('/api/ingestion/jobs/:id', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    const route = 'DELETE /api/ingestion/jobs/:id';
    try {
        const jobId = String(req.params.id || '').trim();
        const current = await pool.query(
            `SELECT j.id, j.document_id, j.queue_job_id, j.status
             FROM ingestion_jobs j
             WHERE j.id = $1::uuid
             LIMIT 1`,
            [jobId]
        );
        if (current.rowCount === 0) {
            await insertRequestLogRow({
                trace_id,
                span_id,
                route,
                start_ts,
                end_ts: nowIso(),
                latency_ms: Date.now() - start,
                status: 404,
                error: 'ingestion_job_not_found',
                metadata: { job_id: jobId },
            });
            return res.status(404).json({ error: 'ingestion_job_not_found' });
        }
        const row = current.rows[0] || {};
        const status = String(row.status || '').toLowerCase();
        if (status === 'processing') {
            await insertRequestLogRow({
                trace_id,
                span_id,
                route,
                start_ts,
                end_ts: nowIso(),
                latency_ms: Date.now() - start,
                status: 409,
                error: 'ingestion_job_delete_unsafe',
                metadata: { job_id: jobId, status },
            });
            return res.status(409).json({
                error: 'ingestion_job_delete_unsafe',
                hint: 'Cannot delete a processing job. Cancel or wait for completion first.',
            });
        }
        const queueJobId = firstNonEmptyString(row.queue_job_id);
        if (queueJobId) {
            const queueJob = await doclingQueue.getJob(queueJobId);
            if (queueJob) {
                try { await queueJob.remove(); } catch {}
            }
        }
        await pool.query(`DELETE FROM ingestion_documents WHERE id = $1::uuid`, [row.document_id]);
        await insertRequestLogRow({
            trace_id,
            span_id,
            route,
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: 200,
            metadata: {
                job_id: jobId,
                action: 'delete',
                deleted_document_id: row.document_id || null,
            },
        });
        res.json({ ok: true, deleted_job_id: jobId, deleted_document_id: row.document_id });
    } catch (error) {
        await insertRequestLogRow({
            trace_id,
            span_id,
            route,
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: 500,
            error: 'ingestion_job_delete_failed',
            metadata: {
                job_id: String(req.params.id || '').trim() || null,
                message: String(error?.message || error),
            },
        });
        res.setHeader('x-error', 'ingestion_job_delete_failed');
        res.status(500).json({ error: 'ingestion_job_delete_failed', message: String(error?.message || error) });
    }
});
app.get('/api/docling/jobs', async (_req, res) => {
    try {
        const jobs = await getIngestionJobs(100);
        res.json({
            jobs: jobs.map((job) => ({
                id: job.document_id,
                ingestion_job_id: job.id,
                upload_batch_id: job.upload_batch_id || null,
                filename: job.original_filename,
                status: job.status === 'queued' ? 'pending' : job.status,
                stage: job.stage,
                progress_percent: job.progress_percent,
                estimated_completion_at: job.estimated_completion_at,
                queue_job_id: job.queue_job_id,
                result_metadata: job.result_metadata || {},
                error: job.error,
                created_at: job.created_at,
                updated_at: job.updated_at,
            })),
        });
    } catch (error) {
        res.setHeader('x-error', 'docling_jobs_fetch_failed');
        res.status(500).json({ error: 'docling_jobs_fetch_failed', message: String(error?.message || error) });
    }
});
app.post('/api/docling/jobs', async (req, res) => {
    try {
        const filename = String(req.body?.filename || '').trim() || 'uploaded_document.txt';
        const created = await createIngestionJobRecord({
            filename,
            relativePath: String(req.body?.relative_path || '').trim(),
            mimeType: String(req.body?.mime_type || 'text/plain').trim(),
            sizeBytes: Number(req.body?.size_bytes || filename.length),
            storageProvider: 'manual',
            metadata: { created_via: 'legacy_docling_route' },
            options: req.body?.options || {},
            operatorMessage: String(req.body?.operator_message || '').trim(),
            traceId: req.trace_id,
        });
        res.json({ ok: true, id: created.document_id, queueJobId: created.queue_job_id, ingestion_job_id: created.job_id });
    } catch (error) {
        res.setHeader('x-error', 'docling_job_create_failed');
        res.status(500).json({ error: 'docling_job_create_failed', message: String(error?.message || error) });
    }
});
app.delete('/api/docling/jobs/:id', async (req, res) => {
    try {
        const id = String(req.params.id || '').trim();
        const doc = await pool.query(`SELECT id FROM ingestion_documents WHERE id = $1::uuid LIMIT 1`, [id]);
        if (doc.rowCount > 0) {
            await pool.query(`DELETE FROM ingestion_documents WHERE id = $1::uuid`, [id]);
        }
        await pool.query(`DELETE FROM docling_jobs WHERE id = $1::uuid`, [id]);
        res.json({ ok: true });
    } catch (error) {
        res.setHeader('x-error', 'docling_job_delete_failed');
        res.status(500).json({ error: 'docling_job_delete_failed', message: String(error?.message || error) });
    }
});

function sanitizeToolForPublicView(tool) {
    const out = { ...tool };
    const config = out.config && typeof out.config === 'object' ? { ...out.config } : {};
    if (String(out.kind || '') === 'shopify_mcp') {
        const internalKeyRaw = String(process.env.SHOPIFY_MCP_INTERNAL_KEY || '').trim();
        const apiTokenRaw = String(process.env.SHOPIFY_MCP_API_TOKEN || '').trim();
        delete config.internal_key;
        delete config.api_token;
        config.internal_key_set = !!internalKeyRaw;
        config.api_token_set = !!apiTokenRaw;
    }
    if (String(out.kind || '') === 'odoo_rpc') {
        const gatewayUrlRaw = String(config.module_url || process.env.ODOO_RPC_URL || config.base_url || '').trim().replace(/\/$/, '');
        const odooDbRaw = String(process.env.ODOO_DB || '').trim();
        const odooUsernameRaw = String(process.env.ODOO_USERNAME || '').trim();
        const odooSecretRaw = String(process.env.ODOO_API_KEY || process.env.ODOO_PASSWORD || '').trim();
        const internalKeyRaw = String(process.env.ODOO_RPC_INTERNAL_KEY || '').trim();
        const apiTokenRaw = String(process.env.ODOO_RPC_API_TOKEN || '').trim();
        delete config.internal_key;
        delete config.api_token;
        config.module_url = gatewayUrlRaw;
        config.base_url = gatewayUrlRaw;
        config.database = String(config.database || '').trim() || (odooDbRaw ? '[env]' : '');
        config.username = String(config.username || '').trim() || (odooUsernameRaw ? '[env]' : '');
        config.api_key_set = !!odooSecretRaw;
        config.internal_key_set = !!internalKeyRaw;
        config.api_token_set = !!apiTokenRaw;
    }
    out.config = config;
    return out;
}

app.get('/api/tools', async (_req, res) => {
    try {
        const r = await pool.query(`SELECT id, name, kind, config, status FROM tools ORDER BY name`);
        res.json((r.rows || []).map((row) => sanitizeToolForPublicView(row)));
    }
    catch (e) {
        res.setHeader('x-error', 'tools_fetch_failed');
        res.status(500).json({ error: 'tools_fetch_failed' });
    }
});

app.post('/api/llm/assistant-providers', async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const slug = String(req.body?.slug || '').trim().toLowerCase();
    const kind = String(req.body?.kind || 'openai_compatible').trim();
    const baseUrl = normalizeDashboardProviderBaseUrl(kind, req.body?.base_url || '');
    const apiKeyEnv = String(req.body?.api_key_env || '').trim();
    const enabled = req.body?.enabled !== false;
    const inlineApiKey = String(req.body?.api_key || '').trim();
    if (!name || !slug || !baseUrl || (!apiKeyEnv && !inlineApiKey)) {
        return res.status(400).json({ error: 'missing_fields', hint: 'name, slug, base_url, and api_key_env or api_key required' });
    }
    try {
        const settings = await getEngineSettings();
        const row = await upsertLlmProviderRow({
            name,
            slug,
            kind,
            base_url: baseUrl,
            api_key_env: apiKeyEnv,
            enabled,
        });
        const r = { rows: row ? [row] : [] };
        let nextSettings = settings;
        if (inlineApiKey) {
            nextSettings = await saveEngineSettingsPatch({
                llm_provider_secrets: {
                    [String(r.rows[0].id)]: inlineApiKey,
                },
            });
        }
        res.status(201).json(toProviderPublicView(r.rows[0], nextSettings.config || settings.config || {}));
    }
    catch {
        res.setHeader('x-error', 'assistant_provider_upsert_failed');
        res.status(500).json({ error: 'assistant_provider_upsert_failed' });
    }
});

app.post('/api/llm/assistant-models', async (req, res) => {
    const providerId = String(req.body?.provider_id || '').trim();
    const label = String(req.body?.label || '').trim();
    const modelId = String(req.body?.model_id || '').trim();
    const enabled = req.body?.enabled !== false;
    if (!providerId || !label || !modelId) {
        return res.status(400).json({ error: 'missing_fields', hint: 'provider_id, label, model_id required' });
    }
    try {
        const settings = await getEngineSettings();
        const config = normalizeModelConfig(req.body?.config, settings.config || {});
        const row = await upsertLlmModelRow({
            provider_id: providerId,
            label,
            model_id: modelId,
            config,
            enabled,
        });
        const r = { rows: row ? [row] : [] };
        res.status(201).json(buildModelPublicView(r.rows[0], settings.config || {}));
    }
    catch {
        res.setHeader('x-error', 'assistant_model_upsert_failed');
        res.status(500).json({ error: 'assistant_model_upsert_failed' });
    }
});

app.get('/api/llm/assistant-providers', async (_req, res) => {
    try {
        const settings = await getEngineSettings();
        const r = await pool.query(
            `SELECT id, name, slug, kind, base_url, api_key_env, enabled, created_at, updated_at
       FROM llm_registry
       WHERE record_type = 'provider'
       ORDER BY name ASC`
        );
        res.json((r.rows || []).map((row) => toProviderPublicView(row, settings.config || {})));
    }
    catch {
        res.setHeader('x-error', 'assistant_providers_fetch_failed');
        res.status(500).json({ error: 'assistant_providers_fetch_failed' });
    }
});

app.get('/api/llm/assistant-models', async (_req, res) => {
    try {
        const settings = await getEngineSettings();
        const r = await pool.query(
            `SELECT m.id, m.provider_id, m.label, m.model_id, m.config, m.enabled, m.created_at, m.updated_at,
              p.name AS provider_name, p.slug AS provider_slug, p.kind AS provider_kind, p.base_url, p.api_key_env, p.enabled AS provider_enabled
       FROM llm_registry m
       JOIN llm_registry p ON p.id = m.provider_id
       WHERE m.record_type = 'model'
         AND p.record_type = 'provider'
       ORDER BY p.name ASC, m.label ASC`
        );
        res.json((r.rows || []).map((row) => buildModelPublicView(row, settings.config || {})));
    }
    catch {
        res.setHeader('x-error', 'assistant_models_fetch_failed');
        res.status(500).json({ error: 'assistant_models_fetch_failed' });
    }
});

app.get('/api/providers', async (_req, res) => {
    try {
        const settings = await getEngineSettings();
        const r = await pool.query(
            `SELECT id, name, slug, kind, base_url, api_key_env, enabled, created_at, updated_at
       FROM llm_registry
       WHERE record_type = 'provider'
       ORDER BY name ASC`
        );
        res.json((r.rows || []).map((row) => toProviderPublicView(row, settings.config || {})));
    }
    catch {
        res.setHeader('x-error', 'providers_fetch_failed');
        res.status(500).json({ error: 'providers_fetch_failed' });
    }
});

app.post('/api/providers', async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const slug = String(req.body?.slug || '').trim().toLowerCase();
    const kind = String(req.body?.kind || 'openai_compatible').trim();
    const baseUrl = normalizeDashboardProviderBaseUrl(kind, req.body?.base_url || '');
    const apiKeyEnv = String(req.body?.api_key_env || '').trim();
    const enabled = req.body?.enabled !== false;
    const inlineApiKey = String(req.body?.api_key || '').trim();
    if (!name || !slug || !baseUrl || (!apiKeyEnv && !inlineApiKey)) {
        return res.status(400).json({ error: 'missing_fields', hint: 'name, slug, base_url, and api_key_env or api_key required' });
    }
    try {
        const settings = await getEngineSettings();
        const row = await upsertLlmProviderRow({
            name,
            slug,
            kind,
            base_url: baseUrl,
            api_key_env: apiKeyEnv,
            enabled,
        });
        const r = { rows: row ? [row] : [] };
        let nextSettings = settings;
        if (inlineApiKey) {
            nextSettings = await saveEngineSettingsPatch({
                llm_provider_secrets: {
                    [String(r.rows[0].id)]: inlineApiKey,
                },
            });
        }
        res.status(201).json(toProviderPublicView(r.rows[0], nextSettings.config || settings.config || {}));
    }
    catch {
        res.setHeader('x-error', 'provider_upsert_failed');
        res.status(500).json({ error: 'provider_upsert_failed' });
    }
});

app.patch('/api/providers/:id', async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'missing_provider_id' });
    const updates = [];
    const values = [];
    let i = 1;
    const setIf = (field, value) => {
        updates.push(`${field} = $${i++}`);
        values.push(value);
    };
    if (req.body?.name !== undefined) setIf('name', String(req.body.name || '').trim());
    if (req.body?.slug !== undefined) setIf('slug', String(req.body.slug || '').trim().toLowerCase());
    if (req.body?.kind !== undefined) setIf('kind', String(req.body.kind || 'openai_compatible').trim());
    if (req.body?.base_url !== undefined) {
        const nextKind = req.body?.kind !== undefined ? String(req.body.kind || 'openai_compatible').trim() : null;
        setIf('base_url', normalizeDashboardProviderBaseUrl(nextKind || req.body?.provider_kind || 'openai_compatible', req.body.base_url || ''));
    }
    if (req.body?.api_key_env !== undefined) setIf('api_key_env', String(req.body.api_key_env || '').trim());
    if (req.body?.enabled !== undefined) setIf('enabled', req.body.enabled === true);
    const inlineApiKey = String(req.body?.api_key || '').trim();
    if (updates.length === 0 && req.body?.api_key === undefined) return res.status(400).json({ error: 'no_updates' });
    updates.push('updated_at = now()');
    values.push(id);
    try {
        const settings = await getEngineSettings();
        const r = await pool.query(
            `UPDATE llm_registry SET ${updates.join(', ')}
       WHERE id = $${i}
         AND record_type = 'provider'
       RETURNING id, name, slug, kind, base_url, api_key_env, enabled, created_at, updated_at`,
            values
        );
        if (r.rowCount === 0) return res.status(404).json({ error: 'provider_not_found' });
        let nextSettings = settings;
        if (req.body?.api_key !== undefined) {
            nextSettings = await saveEngineSettingsPatch({
                llm_provider_secrets: {
                    [String(id)]: inlineApiKey,
                },
            });
        }
        res.json(toProviderPublicView(r.rows[0], nextSettings.config || settings.config || {}));
    }
    catch {
        res.setHeader('x-error', 'provider_patch_failed');
        res.status(500).json({ error: 'provider_patch_failed' });
    }
});

app.get('/api/models', async (_req, res) => {
    try {
        const settings = await getEngineSettings();
        const r = await pool.query(
            `SELECT m.id, m.provider_id, m.label, m.model_id, m.config, m.enabled, m.created_at, m.updated_at,
              p.name AS provider_name, p.slug AS provider_slug, p.kind AS provider_kind, p.base_url, p.api_key_env, p.enabled AS provider_enabled
       FROM llm_registry m
       JOIN llm_registry p ON p.id = m.provider_id
       WHERE m.record_type = 'model'
         AND p.record_type = 'provider'
       ORDER BY p.name ASC, m.label ASC`
        );
        res.json((r.rows || []).map((row) => buildModelPublicView(row, settings.config || {})));
    }
    catch {
        res.setHeader('x-error', 'models_fetch_failed');
        res.status(500).json({ error: 'models_fetch_failed' });
    }
});

app.post('/api/models', async (req, res) => {
    const providerId = String(req.body?.provider_id || '').trim();
    const label = String(req.body?.label || '').trim();
    const modelId = String(req.body?.model_id || '').trim();
    const enabled = req.body?.enabled !== false;
    if (!providerId || !label || !modelId) {
        return res.status(400).json({ error: 'missing_fields', hint: 'provider_id, label, model_id required' });
    }
    try {
        const settings = await getEngineSettings();
        const config = normalizeModelConfig(req.body?.config, settings.config || {});
        const row = await upsertLlmModelRow({
            provider_id: providerId,
            label,
            model_id: modelId,
            config,
            enabled,
        });
        const r = { rows: row ? [row] : [] };
        res.status(201).json(buildModelPublicView(r.rows[0], settings.config || {}));
    }
    catch {
        res.setHeader('x-error', 'model_upsert_failed');
        res.status(500).json({ error: 'model_upsert_failed' });
    }
});

app.patch('/api/models/:id', async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'missing_model_id' });
    const updates = [];
    const values = [];
    let i = 1;
    const setIf = (field, value) => {
        updates.push(`${field} = $${i++}`);
        values.push(value);
    };
    if (req.body?.provider_id !== undefined) setIf('provider_id', String(req.body.provider_id || '').trim());
    if (req.body?.label !== undefined) setIf('label', String(req.body.label || '').trim());
    if (req.body?.model_id !== undefined) setIf('model_id', String(req.body.model_id || '').trim());
    if (req.body?.enabled !== undefined) setIf('enabled', req.body.enabled === true);
    try {
        const settings = await getEngineSettings();
        if (req.body?.config !== undefined) {
            setIf('config', JSON.stringify(normalizeModelConfig(req.body.config, settings.config || {})));
            updates[updates.length - 1] += '::jsonb';
        }
        if (updates.length === 0) return res.status(400).json({ error: 'no_updates' });
        updates.push('updated_at = now()');
        values.push(id);
        const r = await pool.query(
            `UPDATE llm_registry SET ${updates.join(', ')}
       WHERE id = $${i}
         AND record_type = 'model'
       RETURNING id, provider_id, label, model_id, config, enabled, created_at, updated_at`,
            values
        );
        if (r.rowCount === 0) return res.status(404).json({ error: 'model_not_found' });
        res.json(buildModelPublicView(r.rows[0], settings.config || {}));
    }
    catch {
        res.setHeader('x-error', 'model_patch_failed');
        res.status(500).json({ error: 'model_patch_failed' });
    }
});

app.delete('/api/models/:id', async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'missing_model_id' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query(
            `SELECT id, label, model_id FROM llm_registry WHERE id = $1::uuid AND record_type = 'model' LIMIT 1`,
            [id]
        );
        if (existing.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'model_not_found' });
        }

        const settings = await getEngineSettings().catch(() => ({ config: {} }));
        const dashboardCfg = settings?.config?.dashboard_llm && typeof settings.config.dashboard_llm === 'object'
            ? settings.config.dashboard_llm
            : {};
        const defaultAgentId = String(dashboardCfg.default_agent_id || dashboardCfg.active_agent_id || '').trim();

        let fallbackModelUuid = '';
        if (defaultAgentId) {
            const defaultAgentRow = await client.query(
                `SELECT model_uuid FROM agents WHERE id = $1 LIMIT 1`,
                [defaultAgentId]
            );
            const candidate = String(defaultAgentRow.rows?.[0]?.model_uuid || '').trim();
            if (candidate && candidate !== id) fallbackModelUuid = candidate;
        }
        if (!fallbackModelUuid) {
            const fallbackRow = await client.query(
                `SELECT m.id
                 FROM llm_registry m
                 JOIN llm_registry p ON p.id = m.provider_id
                 WHERE m.enabled = true
                   AND p.enabled = true
                   AND m.record_type = 'model'
                   AND p.record_type = 'provider'
                   AND m.id <> $1::uuid
                 ORDER BY m.updated_at DESC, m.created_at DESC
                 LIMIT 1`,
                [id]
            );
            fallbackModelUuid = String(fallbackRow.rows?.[0]?.id || '').trim();
        }

        const refs = await client.query(
            `SELECT COUNT(*)::int AS count FROM agents WHERE model_uuid::text = $1::text`,
            [id]
        );
        const referencedByAgents = Number(refs.rows?.[0]?.count || 0);
        if (referencedByAgents > 0 && !fallbackModelUuid) {
            await client.query('ROLLBACK');
            return res.status(409).json({
                error: 'model_delete_no_fallback',
                message: 'This model is assigned to one or more agents and no enabled fallback model is available.',
            });
        }
        if (referencedByAgents > 0 && fallbackModelUuid) {
            const modelUuidTypeRow = await client.query(
                `SELECT data_type
                 FROM information_schema.columns
                 WHERE table_schema = 'public'
                   AND table_name = 'agents'
                   AND column_name = 'model_uuid'
                 LIMIT 1`
            );
            const modelUuidType = String(modelUuidTypeRow.rows?.[0]?.data_type || '').trim().toLowerCase();
            if (modelUuidType === 'uuid') {
                await client.query(
                    `UPDATE agents
                     SET model_uuid = $2::uuid
                     WHERE model_uuid::text = $1::text`,
                    [id, fallbackModelUuid]
                );
            } else {
                await client.query(
                    `UPDATE agents
                     SET model_uuid = $2::text
                     WHERE model_uuid::text = $1::text`,
                    [id, fallbackModelUuid]
                );
            }
        }

        await client.query(`DELETE FROM llm_registry WHERE id = $1::uuid AND record_type = 'model'`, [id]);
        await client.query('COMMIT');
        return res.json({
            ok: true,
            deleted_model_id: id,
            deleted_label: existing.rows[0]?.label || existing.rows[0]?.model_id || id,
            reassigned_agents: referencedByAgents,
            fallback_model_uuid: fallbackModelUuid || null,
        });
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        res.setHeader('x-error', 'model_delete_failed');
        return res.status(500).json({ error: 'model_delete_failed', message: String(error?.message || error) });
    } finally {
        client.release();
    }
});

app.get('/api/engine/settings', async (_req, res) => {
    try {
        const settings = await getEngineSettings();
        res.json({ ok: true, ...settings, config: maskEngineSettingsSecrets(settings.config || {}) });
    }
    catch {
        res.setHeader('x-error', 'engine_settings_fetch_failed');
        res.status(500).json({ error: 'engine_settings_fetch_failed' });
    }
});

app.patch('/api/engine/settings', async (req, res) => {
    try {
        const patch = req.body && typeof req.body === 'object' ? req.body : {};
        const updated = await saveEngineSettingsPatch(patch);
        await startEngineScheduler();
        res.json({ ok: true, ...updated });
    }
    catch {
        res.setHeader('x-error', 'engine_settings_update_failed');
        res.status(500).json({ error: 'engine_settings_update_failed' });
    }
});
app.get('/api/llm/setup/status', async (req, res) => {
    const auth = parseAuthedUserFromRequest(req);
    if (!auth?.id) {
        res.setHeader('x-error', 'unauthorized');
        return res.status(401).json({ error: 'unauthorized' });
    }
    try {
        const settings = await getEngineSettings();
        const [siteRow, userRow] = await Promise.all([
            getDashboardAssistantSiteRow(),
            getDashboardAssistantUserRow(auth.id),
        ]);
        const status = buildDashboardAssistantStatusPayload({
            siteRow,
            userRow,
        });
        const runtime = await resolveDashboardAssistantRuntime({
            user_id: auth.id,
            engine_settings: settings,
            site_row: siteRow,
            user_row: userRow,
        });
        return res.json({
            ok: true,
            ...status,
            effective_model: runtime?.llm ? {
                model_uuid: runtime.llm.model_uuid,
                model_id: runtime.llm.label || runtime.llm.model_id,
                label: runtime.llm.label || runtime.llm.model_id,
            } : null,
        });
    } catch (error) {
        res.setHeader('x-error', 'llm_setup_status_failed');
        return res.status(500).json({ error: 'llm_setup_status_failed', message: String(error?.message || error) });
    }
});
app.get('/api/llm/control/state', async (req, res) => {
    const auth = parseAuthedUserFromRequest(req);
    if (!auth?.id) {
        res.setHeader('x-error', 'unauthorized');
        return res.status(401).json({ error: 'unauthorized' });
    }
    try {
        const settings = await getEngineSettings();
        const [agentProvidersResult, agentModelsResult, toolsResult, siteRow, userRow] = await Promise.all([
            pool.query(
                `SELECT id, name, slug, kind, base_url, api_key_env, enabled, created_at, updated_at
                   FROM llm_registry
                  WHERE record_type = 'provider'
                  ORDER BY name ASC`
            ),
            pool.query(
                `SELECT m.id, m.provider_id, m.label, m.model_id, m.config, m.enabled, m.created_at, m.updated_at,
                        p.name AS provider_name, p.slug AS provider_slug, p.kind AS provider_kind, p.base_url, p.api_key_env, p.enabled AS provider_enabled
                   FROM llm_registry m
                   JOIN llm_registry p ON p.id = m.provider_id
                  WHERE m.record_type = 'model'
                    AND p.record_type = 'provider'
                  ORDER BY p.name ASC, m.label ASC`
            ),
            pool.query(`SELECT id, name, kind, status FROM tools ORDER BY name ASC`).catch(() => ({ rows: [] })),
            getDashboardAssistantSiteRow(),
            getDashboardAssistantUserRow(auth.id),
        ]);
        const status = buildDashboardAssistantStatusPayload({
            siteRow,
            userRow,
        });
        const canonicalProviders = (agentProvidersResult.rows || []).map((row) => toProviderRuntimeView(row, settings.config || {}));
        const canonicalModels = (agentModelsResult.rows || []).map((row) => buildModelPublicView(row, settings.config || {}));
        return res.json({
            ok: true,
            assistant_status: status,
            assistant_site: siteRow,
            assistant_providers: canonicalProviders,
            assistant_models: canonicalModels,
            agent_providers: canonicalProviders,
            agent_models: canonicalModels,
            tools: toolsResult.rows || [],
            user_override: userRow,
        });
    } catch (error) {
        res.setHeader('x-error', 'llm_control_state_failed');
        return res.status(500).json({ error: 'llm_control_state_failed', message: String(error?.message || error) });
    }
});
app.patch('/api/llm/control/state', async (req, res) => {
    const auth = parseAuthedUserFromRequest(req);
    if (!auth?.id) {
        res.setHeader('x-error', 'unauthorized');
        return res.status(401).json({ error: 'unauthorized' });
    }
    try {
        const settings = await getEngineSettings();
        let siteRow = await getDashboardAssistantSiteRow();
        if (req.body?.site_default && typeof req.body.site_default === 'object') {
            siteRow = await persistDashboardAssistantSiteDefaults(req.body.site_default);
        }
        if (req.body?.user_override && typeof req.body.user_override === 'object') {
            await upsertDashboardAssistantUserSettings(auth.id, req.body.user_override);
        }
        const userRow = await getDashboardAssistantUserRow(auth.id);
        const status = buildDashboardAssistantStatusPayload({
            siteRow,
            userRow,
        });
        return res.json({
            ok: true,
            assistant_status: status,
            assistant_site: siteRow,
            user_override: userRow,
        });
    } catch (error) {
        const errorCode = String(error?.code || error?.message || '').trim();
        if (errorCode === 'dashboard_model_uuid_not_found') {
            res.setHeader('x-error', 'dashboard_model_uuid_not_found');
            return res.status(400).json({
                error: 'dashboard_model_uuid_not_found',
                message: 'Selected dashboard model no longer exists. Refresh and choose a valid model.',
            });
        }
        res.setHeader('x-error', 'llm_control_state_update_failed');
        return res.status(500).json({ error: 'llm_control_state_update_failed', message: String(error?.message || error) });
    }
});
app.post('/api/llm/providers/check', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    try {
        const settings = await getEngineSettings();
        const { provider, api_key } = await resolveProviderInput(req.body || {}, settings.config || {});
        const result = await runProviderCatalogDiscovery({
            provider,
            api_key,
            trace_id,
            route: 'POST /api/llm/providers/check',
        });
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/llm/providers/check',
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: result.ok ? 200 : (result.status || 502),
            error: result.ok ? null : (result.error || 'provider_check_failed'),
            metadata: {
                provider: sanitizeForLogs(provider),
                log_count: result.logs.length,
                model_count: result.models.length,
            },
        });
        return res.status(result.ok ? 200 : (result.status || 502)).json({
            ok: result.ok,
            trace_id,
            latency_ms: result.latency_ms ?? Date.now() - start,
            provider: sanitizeForLogs(provider),
            models: result.models,
            logs: result.logs,
            raw: result.raw,
            error: result.error,
        });
    } catch (error) {
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/llm/providers/check',
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: 500,
            error: 'provider_check_failed',
            metadata: { error: String(error?.message || error) },
        });
        res.setHeader('x-error', 'provider_check_failed');
        return res.status(500).json({ error: 'provider_check_failed', message: String(error?.message || error) });
    }
});
app.post('/api/llm/providers/discover-models', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    try {
        const settings = await getEngineSettings();
        const { provider, api_key } = await resolveProviderInput(req.body || {}, settings.config || {});
        const result = await runProviderCatalogDiscovery({
            provider,
            api_key,
            trace_id,
            route: 'POST /api/llm/providers/discover-models',
        });
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/llm/providers/discover-models',
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: result.ok ? 200 : (result.status || 502),
            error: result.ok ? null : (result.error || 'provider_model_discovery_failed'),
            metadata: {
                provider: sanitizeForLogs(provider),
                model_count: result.models.length,
            },
        });
        return res.status(result.ok ? 200 : (result.status || 502)).json({
            ok: result.ok,
            trace_id,
            latency_ms: result.latency_ms ?? Date.now() - start,
            provider: sanitizeForLogs(provider),
            models: result.models,
            logs: result.logs,
            raw: result.raw,
            error: result.error,
        });
    } catch (error) {
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/llm/providers/discover-models',
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: 500,
            error: 'provider_model_discovery_failed',
            metadata: { error: String(error?.message || error) },
        });
        res.setHeader('x-error', 'provider_model_discovery_failed');
        return res.status(500).json({ error: 'provider_model_discovery_failed', message: String(error?.message || error) });
    }
});
app.post('/api/llm/dashboard/test', async (req, res) => {
    const auth = parseAuthedUserFromRequest(req);
    if (!auth?.id) {
        res.setHeader('x-error', 'unauthorized');
        return res.status(401).json({ error: 'unauthorized' });
    }
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    try {
        const settings = await getEngineSettings();
        let llm = null;
        if (req.body?.provider_id || req.body?.base_url || req.body?.kind || req.body?.api_key) {
            const { provider, api_key } = await resolveProviderInput(req.body || {}, settings.config || {});
            llm = buildAdHocDashboardLlmRuntime({
                provider,
                model_id: String(req.body?.model_id || '').trim(),
                api_key,
                engine_config: settings.config || {},
            });
        } else {
            const runtime = await resolveDashboardAssistantRuntime({
                model_uuid: String(req.body?.model_uuid || '').trim(),
                user_id: auth.id,
                engine_settings: settings,
            });
            llm = runtime.llm;
        }
        if (!llm) {
            res.setHeader('x-error', 'dashboard_llm_not_configured');
            return res.status(503).json({ error: 'dashboard_llm_not_configured' });
        }
        const testResult = await runDashboardAssistantConnectivityTest({
            llm,
            trace_id,
            route: 'POST /api/llm/dashboard/test',
        });
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/llm/dashboard/test',
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: testResult.ok ? 200 : (testResult.llm_result?.status || 502),
            error: testResult.ok ? null : 'dashboard_llm_test_failed',
            metadata: {
                model_id: llm.model_id,
                model_uuid: llm.model_uuid,
                upstream_status: testResult.llm_result?.status || null,
                upstream_latency_ms: testResult.upstream_latency_ms,
            },
        });
        return res.status(testResult.ok ? 200 : (testResult.llm_result?.status || 502)).json({
            ok: testResult.ok,
            trace_id,
            model_uuid: llm.model_uuid,
            model_id: llm.model_id,
            label: llm.label || llm.model_id,
            upstream_status: testResult.llm_result?.status || null,
            upstream_latency_ms: testResult.upstream_latency_ms,
            reply_preview: testResult.reply_preview,
            token_policy: testResult.llm_result?.token_policy || null,
            token_policy_notice: testResult.llm_result?.token_policy_notice || null,
            error: testResult.ok ? null : (testResult.llm_result?.message || 'dashboard_llm_test_failed'),
        });
    } catch (error) {
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/llm/dashboard/test',
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: 500,
            error: 'dashboard_llm_test_failed',
            metadata: { error: String(error?.message || error) },
        });
        res.setHeader('x-error', 'dashboard_llm_test_failed');
        return res.status(500).json({ error: 'dashboard_llm_test_failed', message: String(error?.message || error) });
    }
});
app.post('/api/llm/onboarding/assistant', async (req, res) => {
    const auth = parseAuthedUserFromRequest(req);
    if (!auth?.id) {
        res.setHeader('x-error', 'unauthorized');
        return res.status(401).json({ error: 'unauthorized' });
    }
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']) ?? crypto.randomUUID();
    const message = String(req.body?.message || '').trim();
    const confirmSave = req.body?.confirm_save === true;
    const draft = req.body?.draft && typeof req.body.draft === 'object' ? req.body.draft : {};
    if (!message) {
        res.setHeader('x-error', 'missing_message');
        return res.status(400).json({ error: 'missing_message' });
    }
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    try {
        const settings = await getEngineSettings();
        const inferredKind = /gemini|google/i.test(`${message} ${draft.kind || ''}`)
            ? 'google_gemini'
            : String(draft.kind || 'openai_compatible').trim();
        const inferredProviderName = String(
            draft.name
            || (/gemini|google/i.test(message) ? 'Google Gemini' : '')
            || 'New Provider'
        ).trim();
        const inferredSlug = String(
            draft.slug
            || inferredProviderName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
        ).trim();
        const inferredBaseUrl = normalizeDashboardProviderBaseUrl(
            inferredKind,
            draft.base_url
            || (/gemini|google/i.test(message) ? 'https://generativelanguage.googleapis.com/v1beta/openai' : '')
        );
        const inferredModelId = String(
            draft.model_id
            || (message.match(/\b(gemini-[a-z0-9.\-]+|gpt-[a-z0-9.\-]+|llama[0-9.\-a-z]+)\b/i)?.[1] || '')
        ).trim();
        const makeDefault = draft.make_default === true || /default|website assistant|dashboard assistant/i.test(message);
        const providerInput = {
            name: inferredProviderName,
            slug: inferredSlug,
            kind: inferredKind,
            base_url: inferredBaseUrl,
            api_key_env: String(draft.api_key_env || '').trim(),
            api_key: String(draft.api_key || '').trim(),
        };
        const missing = [];
        if (!providerInput.name) missing.push('provider name');
        if (!providerInput.slug) missing.push('provider slug');
        if (!providerInput.base_url) missing.push('provider base URL');
        if (!providerInput.api_key) missing.push('provider API key');
        writeSseEvent(res, 'accepted', {
            trace_id,
            summary: 'LLM onboarding assistant accepted the request.',
        });
        writeSseEvent(res, 'intent_parsed', {
            trace_id,
            provider: sanitizeForLogs(providerInput),
            model_id: inferredModelId || null,
            make_default: makeDefault,
        });
        if (missing.length > 0) {
            writeSseEvent(res, 'missing_inputs', {
                trace_id,
                missing,
                guidance: 'Provide the missing fields and rerun the setup assistant. Nothing has been saved.',
            });
            writeSseEvent(res, 'done', {
                trace_id,
                saved: false,
                verified: false,
            });
            return res.end();
        }
        const discovery = await runProviderCatalogDiscovery({
            provider: providerInput,
            api_key: providerInput.api_key,
            trace_id,
            route: 'POST /api/llm/onboarding/assistant',
        });
        writeSseEvent(res, 'provider_check', {
            trace_id,
            ok: discovery.ok,
            logs: discovery.logs,
            model_count: discovery.models.length,
            error: discovery.error,
        });
        if (!discovery.ok) {
            writeSseEvent(res, 'error', {
                trace_id,
                error: discovery.error || 'provider_check_failed',
                raw: discovery.raw,
            });
            writeSseEvent(res, 'done', {
                trace_id,
                saved: false,
                verified: false,
            });
            return res.end();
        }
        const discoveredModel = discovery.models.find((row) => row.model_id === inferredModelId)
            || discovery.models.find((row) => String(row.model_id || '').toLowerCase() === String(inferredModelId || '').toLowerCase())
            || discovery.models[0]
            || null;
        const selectedModelId = String(inferredModelId || discoveredModel?.model_id || '').trim();
        if (!selectedModelId) {
            writeSseEvent(res, 'missing_inputs', {
                trace_id,
                missing: ['model_id'],
                guidance: 'No provider model was selected. Pick a model and rerun.',
                models: discovery.models,
            });
            writeSseEvent(res, 'done', {
                trace_id,
                saved: false,
                verified: false,
            });
            return res.end();
        }
        const candidateLlm = buildAdHocDashboardLlmRuntime({
            provider: providerInput,
            model_id: selectedModelId,
            api_key: providerInput.api_key,
            engine_config: settings.config || {},
        });
        if (!candidateLlm) {
            writeSseEvent(res, 'error', {
                trace_id,
                error: 'candidate_runtime_invalid',
            });
            writeSseEvent(res, 'done', {
                trace_id,
                saved: false,
                verified: false,
            });
            return res.end();
        }
        const systemPrompt = normalizeDashboardSystemPrompt(
            draft.system_prompt,
            'You are the Ghost Dashboard website assistant for the signed-in operator. Use only server-side evidence, be explicit about uncertainty, keep guidance operational, and always separate dashboard-assistant runtime decisions from the Agents feature.'
        );
        const enabledToolIds = normalizeDashboardToolIds(draft.enabled_tool_ids);
        writeSseEvent(res, 'config_preview', {
            trace_id,
            provider: sanitizeForLogs(providerInput),
            selected_model_id: selectedModelId,
            make_default: makeDefault,
            system_prompt: systemPrompt,
            enabled_tool_ids: enabledToolIds,
            available_models: discovery.models,
        });
        const candidateTest = await runDashboardAssistantConnectivityTest({
            llm: candidateLlm,
            trace_id,
            route: 'POST /api/llm/onboarding/assistant',
        });
        writeSseEvent(res, 'candidate_test', {
            trace_id,
            ok: candidateTest.ok,
            upstream_status: candidateTest.llm_result?.status || null,
            upstream_latency_ms: candidateTest.upstream_latency_ms,
            reply_preview: candidateTest.reply_preview,
            error: candidateTest.ok ? null : (candidateTest.llm_result?.message || 'dashboard_llm_test_failed'),
        });
        if (!candidateTest.ok) {
            writeSseEvent(res, 'done', {
                trace_id,
                saved: false,
                verified: false,
            });
            return res.end();
        }
        if (!confirmSave) {
            writeSseEvent(res, 'confirmation_required', {
                trace_id,
                message: 'Validation passed. Confirm save to register the provider/model and activate the website assistant runtime.',
            });
            writeSseEvent(res, 'done', {
                trace_id,
                saved: false,
                verified: true,
            });
            return res.end();
        }
        const providerRow = await upsertLlmProviderRow({
            name: providerInput.name,
            slug: providerInput.slug,
            kind: providerInput.kind,
            base_url: providerInput.base_url,
            api_key_env: providerInput.api_key_env || `${providerInput.slug.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`,
            enabled: true,
        });
        await saveEngineSettingsPatch({
            llm_provider_secrets: {
                [String(providerRow.id)]: providerInput.api_key,
            },
        });
        const modelRow = await upsertLlmModelRow({
            provider_id: providerRow.id,
            label: discoveredModel?.label || selectedModelId,
            model_id: selectedModelId,
            config: normalizeModelConfig({}, settings.config || {}),
            enabled: true,
        });
        if (makeDefault) {
            await persistDashboardAssistantSiteDefaults({
                default_model_uuid: modelRow.id,
                system_prompt: systemPrompt,
                enabled_tool_ids: enabledToolIds,
                last_test_status: 'passed',
                last_test_trace_id: trace_id,
                last_test_latency_ms: candidateTest.upstream_latency_ms,
                last_test_message: 'Validated during onboarding assistant setup.',
            });
        }
        await upsertDashboardAssistantUserSettings(auth.id, {
            model_uuid: modelRow.id,
            system_prompt: systemPrompt,
            enabled_tool_ids: enabledToolIds,
            enabled: true,
            last_test_status: 'passed',
            last_test_trace_id: trace_id,
            last_test_latency_ms: candidateTest.upstream_latency_ms,
            last_test_message: 'Validated during onboarding assistant setup.',
        });
        writeSseEvent(res, 'saved', {
            trace_id,
            provider_id: providerRow.id,
            model_uuid: modelRow.id,
            model_id: modelRow.model_id,
            site_default_updated: makeDefault,
        });
        writeSseEvent(res, 'done', {
            trace_id,
            saved: true,
            verified: true,
            model_uuid: modelRow.id,
            model_id: modelRow.model_id,
        });
        return res.end();
    } catch (error) {
        writeSseEvent(res, 'error', {
            trace_id,
            error: String(error?.message || error),
        });
        writeSseEvent(res, 'done', {
            trace_id,
            saved: false,
            verified: false,
        });
        return res.end();
    }
});
app.get('/api/knowledge/orchestrator/status', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    try {
        const settings = await getEngineSettings();
        const knowledge = resolveKnowledgeStorageSettings(settings.config || {});
        const runtime = resolveKnowledgeRuntimeState(settings.config || {});
        const payload = {
            ok: true,
            orchestrator_enabled: runtime.orchestrator_enabled,
            scheduler_active: !!engineLoopTimer,
            run_in_flight: engineRunInFlight,
            llamaindex: {
                configured: !!knowledge.llamaindex_url,
                auth_set: !!knowledge.llamaindex_internal_key,
                url: knowledge.llamaindex_url || null,
            },
        };
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'GET /api/knowledge/orchestrator/status',
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: 200,
            metadata: payload,
        });
        return res.json(payload);
    } catch (error) {
        const message = String(error?.message || error);
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'GET /api/knowledge/orchestrator/status',
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: 500,
            error: 'knowledge_orchestrator_status_failed',
            metadata: { message },
        });
        res.setHeader('x-error', 'knowledge_orchestrator_status_failed');
        return res.status(500).json({ error: 'knowledge_orchestrator_status_failed', message });
    }
});
app.post('/api/knowledge/orchestrator/enable', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    try {
        await saveEngineSettingsPatch({ knowledge_runtime: { orchestrator_enabled: true } });
        await startEngineScheduler();
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/knowledge/orchestrator/enable',
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: 200,
            metadata: { action: 'enable' },
        });
        return res.json({ ok: true, orchestrator_enabled: true });
    } catch (error) {
        const message = String(error?.message || error);
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/knowledge/orchestrator/enable',
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: 500,
            error: 'knowledge_orchestrator_enable_failed',
            metadata: { message },
        });
        res.setHeader('x-error', 'knowledge_orchestrator_enable_failed');
        return res.status(500).json({ error: 'knowledge_orchestrator_enable_failed', message });
    }
});
app.post('/api/knowledge/orchestrator/disable', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    try {
        await saveEngineSettingsPatch({ knowledge_runtime: { orchestrator_enabled: false } });
        await startEngineScheduler();
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/knowledge/orchestrator/disable',
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: 200,
            metadata: { action: 'disable' },
        });
        return res.json({ ok: true, orchestrator_enabled: false });
    } catch (error) {
        const message = String(error?.message || error);
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/knowledge/orchestrator/disable',
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: 500,
            error: 'knowledge_orchestrator_disable_failed',
            metadata: { message },
        });
        res.setHeader('x-error', 'knowledge_orchestrator_disable_failed');
        return res.status(500).json({ error: 'knowledge_orchestrator_disable_failed', message });
    }
});
app.post('/api/knowledge/orchestrator/restart', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    try {
        await startEngineScheduler();
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/knowledge/orchestrator/restart',
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: 200,
            metadata: { action: 'restart' },
        });
        return res.json({ ok: true, scheduler_active: !!engineLoopTimer });
    } catch (error) {
        const message = String(error?.message || error);
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/knowledge/orchestrator/restart',
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: 500,
            error: 'knowledge_orchestrator_restart_failed',
            metadata: { message },
        });
        res.setHeader('x-error', 'knowledge_orchestrator_restart_failed');
        return res.status(500).json({ error: 'knowledge_orchestrator_restart_failed', message });
    }
});
app.get('/api/knowledge/readiness', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    try {
        const [settings, queueCounts, ingestionCounts, graphStatus, collections] = await Promise.all([
            getEngineSettings(),
            doclingQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused'),
            pool.query(
                `SELECT
                   COUNT(*) FILTER (WHERE status = 'queued')::int AS queued_jobs,
                   COUNT(*) FILTER (WHERE status = 'processing')::int AS processing_jobs,
                   COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_jobs,
                   COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_jobs
                 FROM ingestion_jobs`
            ),
            pool.query(
                `SELECT
                   COALESCE(SUM(entity_count), 0)::int AS entities,
                   COALESCE(SUM(relationship_count), 0)::int AS relationships
                 FROM knowledge_graph_runs
                 WHERE status = 'completed'`
            ).catch(() => ({ rows: [{ entities: 0, relationships: 0 }] })),
            resolveKnowledgeVectorCollections(6),
        ]);
        const knowledge = resolveKnowledgeStorageSettings(settings.config || {});
        const runtime = resolveKnowledgeRuntimeState(settings.config || {});
        const queuePaused = await doclingQueue.isPaused();
        const backlog = Number(queueCounts.waiting || 0) + Number(queueCounts.delayed || 0);
        const degradedReasons = [];
        const nextSteps = [];
        if (!knowledge.llamaindex_url) {
            degradedReasons.push('llamaindex_not_configured');
            nextSteps.push('Set LLAMAINDEX_URL in Knowledge settings.');
        }
        if (!knowledge.llamaindex_internal_key) {
            degradedReasons.push('llamaindex_auth_missing');
            nextSteps.push('Set LLAMAINDEX_INTERNAL_KEY for orchestrator auth.');
        }
        if (collections.length === 0 || (collections.length === 1 && collections[0] === 'knowledge_base' && Number(graphStatus.rows?.[0]?.entities || 0) === 0)) {
            degradedReasons.push('knowledge_corpus_empty');
            nextSteps.push('Ingest source documents and verify Qdrant points are present.');
        }
        if (Number(ingestionCounts.rows?.[0]?.failed_jobs || 0) > 0) {
            degradedReasons.push('ingestion_failures_present');
            nextSteps.push('Open Queue tab and retry or cancel failed jobs.');
        }
        if (queuePaused || runtime.queue_paused) {
            degradedReasons.push('queue_paused');
            nextSteps.push('Resume ingestion queue when safe to continue processing.');
        }
        if (!runtime.orchestrator_enabled) {
            degradedReasons.push('orchestrator_disabled');
            nextSteps.push('Enable orchestrator from Knowledge controls.');
        }
        const payload = {
            ok: degradedReasons.length === 0,
            ingestion_queue: {
                paused: queuePaused || runtime.queue_paused,
                backlog,
                counts: queueCounts,
                jobs: ingestionCounts.rows?.[0] || {},
            },
            orchestrator: {
                enabled: runtime.orchestrator_enabled,
                scheduler_active: !!engineLoopTimer,
                run_in_flight: engineRunInFlight,
                llamaindex_configured: !!knowledge.llamaindex_url,
                llamaindex_auth_set: !!knowledge.llamaindex_internal_key,
            },
            retrieval: {
                collections,
                graph_entities: Number(graphStatus.rows?.[0]?.entities || 0),
                graph_relationships: Number(graphStatus.rows?.[0]?.relationships || 0),
            },
            diagnostics: {
                degraded: degradedReasons.length > 0,
                degraded_reasons: degradedReasons,
                next_steps: [...new Set(nextSteps)],
            },
            next_steps: [...new Set(nextSteps)],
        };
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'GET /api/knowledge/readiness',
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: 200,
            metadata: payload.diagnostics,
        });
        return res.json(payload);
    } catch (error) {
        const message = String(error?.message || error);
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'GET /api/knowledge/readiness',
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: 500,
            error: 'knowledge_readiness_failed',
            metadata: { message },
        });
        res.setHeader('x-error', 'knowledge_readiness_failed');
        return res.status(500).json({ error: 'knowledge_readiness_failed', message });
    }
});

function isUuidLike(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim());
}

async function getKnowledgeTransparencySnapshot() {
    const [settings, queueCounts, ingestionCounts, graphTotals, chunkVectorTotals, collectionStats, coverageRows] = await Promise.all([
        getEngineSettings(),
        doclingQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused'),
        pool.query(
            `SELECT
               COUNT(*)::int AS jobs_total,
               COUNT(*) FILTER (WHERE status = 'queued')::int AS queued_jobs,
               COUNT(*) FILTER (WHERE status = 'processing')::int AS processing_jobs,
               COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_jobs,
               COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_jobs
             FROM ingestion_jobs`
        ),
        pool.query(
            `SELECT
               (SELECT COUNT(*)::int FROM knowledge_entities) AS entities,
               (SELECT COUNT(*)::int FROM knowledge_relationships) AS relationships`
        ).catch(() => ({ rows: [{ entities: 0, relationships: 0 }] })),
        pool.query(
            `SELECT
               (SELECT COUNT(*)::int FROM document_chunks) AS chunks_total,
               (SELECT COUNT(*)::int FROM vector_sync_records) AS vectors_total`
        ),
        pool.query(
            `SELECT collection_name,
                    COUNT(*)::int AS vectors,
                    COUNT(DISTINCT job_id)::int AS jobs
             FROM vector_sync_records
             GROUP BY collection_name
             ORDER BY vectors DESC, collection_name ASC
             LIMIT 25`
        ),
        pool.query(
            `SELECT
               j.id AS job_id,
               j.status,
               j.stage,
               j.updated_at,
               COALESCE(d.original_filename, '') AS filename,
               COALESCE(j.options->>'collection_name', '') AS collection_name,
               COALESCE(ch.chunk_count, 0)::int AS chunk_count,
               COALESCE(vs.vector_count, 0)::int AS vector_count,
               COALESCE(gl.graph_link_count, 0)::int AS graph_link_count
             FROM ingestion_jobs j
             INNER JOIN ingestion_documents d ON d.id = j.document_id
             LEFT JOIN (
               SELECT job_id, COUNT(*)::int AS chunk_count
               FROM document_chunks
               GROUP BY job_id
             ) ch ON ch.job_id = j.id
             LEFT JOIN (
               SELECT job_id, COUNT(*)::int AS vector_count
               FROM vector_sync_records
               GROUP BY job_id
             ) vs ON vs.job_id = j.id
             LEFT JOIN (
               SELECT dc.job_id, COUNT(*)::int AS graph_link_count
               FROM knowledge_chunk_entities kce
               INNER JOIN document_chunks dc ON dc.id = kce.chunk_id
               GROUP BY dc.job_id
             ) gl ON gl.job_id = j.id
             ORDER BY j.updated_at DESC NULLS LAST, j.created_at DESC
             LIMIT 80`
        ),
    ]);
    const knowledge = resolveKnowledgeStorageSettings(settings.config || {});
    const runtime = resolveKnowledgeRuntimeState(settings.config || {});
    const queuePaused = await doclingQueue.isPaused();
    const backlog = Number(queueCounts.waiting || 0) + Number(queueCounts.delayed || 0);
    const ingestion = ingestionCounts.rows?.[0] || {};
    const chunkVector = chunkVectorTotals.rows?.[0] || {};
    const graph = graphTotals.rows?.[0] || {};
    const rows = Array.isArray(coverageRows.rows) ? coverageRows.rows : [];
    const completedRows = rows.filter((row) => String(row.status || '') === 'completed');
    const missingVectors = completedRows.filter((row) => Number(row.vector_count || 0) <= 0);
    const missingChunks = completedRows.filter((row) => Number(row.chunk_count || 0) <= 0);
    const missingGraph = completedRows.filter((row) => Number(row.graph_link_count || 0) <= 0);
    const nextActions = [];
    if (!knowledge.llamaindex_url) nextActions.push('Configure LLAMAINDEX_URL for orchestrated retrieval.');
    if (!knowledge.llamaindex_internal_key) nextActions.push('Configure LLAMAINDEX_INTERNAL_KEY so upstream retrieval can authenticate.');
    if (!runtime.orchestrator_enabled) nextActions.push('Enable orchestrator to keep retrieval pipelines healthy.');
    if (missingVectors.length > 0) nextActions.push('Run "Reindex vectors" for completed jobs with vector gaps.');
    if (missingGraph.length > 0) nextActions.push('Run "Rebuild graph" for completed jobs with missing graph links.');
    return {
        ok: true,
        generated_at: nowIso(),
        truth_mode: {
            true_data_only: true,
            synthesis_policy: 'answer_uses_ranked_evidence_only',
        },
        pipeline: {
            queue_paused: queuePaused || runtime.queue_paused,
            queue_backlog: backlog,
            orchestrator_enabled: runtime.orchestrator_enabled,
            scheduler_active: !!engineLoopTimer,
            run_in_flight: engineRunInFlight,
            llamaindex_configured: !!knowledge.llamaindex_url,
            llamaindex_auth_set: !!knowledge.llamaindex_internal_key,
        },
        totals: {
            jobs_total: Number(ingestion.jobs_total || 0),
            completed_jobs: Number(ingestion.completed_jobs || 0),
            failed_jobs: Number(ingestion.failed_jobs || 0),
            chunks_total: Number(chunkVector.chunks_total || 0),
            vectors_total: Number(chunkVector.vectors_total || 0),
            graph_entities: Number(graph.entities || 0),
            graph_relationships: Number(graph.relationships || 0),
        },
        collections: (collectionStats.rows || []).map((row) => ({
            collection_name: row.collection_name,
            vectors: Number(row.vectors || 0),
            jobs: Number(row.jobs || 0),
        })),
        integrity: {
            missing_chunks: missingChunks.map((row) => ({
                job_id: row.job_id,
                filename: row.filename,
                collection_name: row.collection_name,
            })),
            missing_vectors: missingVectors.map((row) => ({
                job_id: row.job_id,
                filename: row.filename,
                collection_name: row.collection_name,
            })),
            missing_graph_links: missingGraph.map((row) => ({
                job_id: row.job_id,
                filename: row.filename,
                collection_name: row.collection_name,
            })),
        },
        job_coverage: rows.slice(0, 50).map((row) => ({
            job_id: row.job_id,
            status: row.status,
            stage: row.stage,
            filename: row.filename,
            collection_name: row.collection_name || null,
            chunk_count: Number(row.chunk_count || 0),
            vector_count: Number(row.vector_count || 0),
            graph_link_count: Number(row.graph_link_count || 0),
            updated_at: row.updated_at,
        })),
        next_actions: [...new Set(nextActions)],
    };
}

async function rebuildKnowledgeGraphForJob(jobId, traceId = '') {
    const chunks = await pool.query(
        `SELECT id, chunk_index, content
         FROM document_chunks
         WHERE job_id = $1::uuid
         ORDER BY chunk_index ASC`,
        [jobId]
    );
    if (chunks.rowCount === 0) {
        throw new Error('no_chunks_for_job');
    }
    return buildKnowledgeGraphForChunks({
        jobId,
        chunkRecords: chunks.rows || [],
        traceId,
    });
}

async function reindexKnowledgeVectorsForJob(jobId) {
    const jobRes = await pool.query(
        `SELECT j.id, j.document_id, j.options, d.original_filename, d.relative_path, d.storage_key
         FROM ingestion_jobs j
         INNER JOIN ingestion_documents d ON d.id = j.document_id
         WHERE j.id = $1::uuid
         LIMIT 1`,
        [jobId]
    );
    if (jobRes.rowCount === 0) {
        throw new Error('ingestion_job_not_found');
    }
    const job = jobRes.rows[0] || {};
    const options = job.options && typeof job.options === 'object' ? job.options : {};
    const collectionName = String(options.collection_name || '').trim();
    if (!collectionName) {
        throw new Error('job_collection_not_configured');
    }
    const chunkRes = await pool.query(
        `SELECT chunk_index, content
         FROM document_chunks
         WHERE job_id = $1::uuid
         ORDER BY chunk_index ASC`,
        [jobId]
    );
    if (chunkRes.rowCount === 0) {
        throw new Error('no_chunks_for_job');
    }
    let vectorSize = Number(options.desired_vector_size || 1536) || 1536;
    try {
        const existing = await qdrantRequest(`/collections/${collectionName}`, 'GET');
        vectorSize = Number(existing?.result?.config?.params?.vectors?.size || vectorSize) || vectorSize;
    } catch {
        throw new Error('qdrant_collection_not_found_for_job');
    }
    try {
        await qdrantRequest(`/collections/${collectionName}/points/delete`, 'POST', {
            filter: {
                must: [{ key: 'job_id', match: { value: jobId } }],
            },
        });
    } catch {}
    await pool.query(`DELETE FROM vector_sync_records WHERE job_id = $1::uuid`, [jobId]);
    const points = [];
    for (const row of chunkRes.rows || []) {
        const chunkIndex = Number(row.chunk_index || 0);
        const content = String(row.content || '');
        const embedding = await createEmbeddingVector(content, vectorSize);
        const pointId = buildDeterministicPointUuid(jobId, chunkIndex);
        points.push({
            id: pointId,
            vector: embedding.vector,
            payload: {
                job_id: jobId,
                document_id: job.document_id,
                chunk_index: chunkIndex,
                filename: job.original_filename || null,
                relative_path: job.relative_path || null,
                source_uri: job.storage_key || job.relative_path || job.original_filename || null,
                content: content.slice(0, 4000),
            },
        });
        await pool.query(
            `INSERT INTO vector_sync_records (job_id, document_id, collection_name, point_id, embedding_provider, vector_size, metadata)
             VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7::jsonb)`,
            [
                jobId,
                job.document_id,
                collectionName,
                pointId,
                embedding.provider,
                vectorSize,
                JSON.stringify({
                    model: embedding.model,
                    note: embedding.note,
                    source_uri: job.storage_key || job.relative_path || job.original_filename || null,
                    doc_id: job.document_id,
                    chunk_id: chunkIndex,
                    repair: true,
                }),
            ]
        );
    }
    if (points.length > 0) {
        await qdrantRequest(`/collections/${collectionName}/points`, 'PUT', { points });
    }
    const quality = await runVectorQualityCheck({
        collectionName,
        jobId,
        options,
    });
    return {
        collection_name: collectionName,
        vector_size: vectorSize,
        point_count: points.length,
        quality,
    };
}

app.get('/api/knowledge/transparency', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    try {
        const payload = await getKnowledgeTransparencySnapshot();
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'GET /api/knowledge/transparency',
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: 200,
            metadata: {
                totals: payload.totals,
                queue_backlog: payload.pipeline.queue_backlog,
                missing_vectors: payload.integrity.missing_vectors.length,
                missing_graph_links: payload.integrity.missing_graph_links.length,
            },
        });
        return res.json(payload);
    } catch (error) {
        const message = String(error?.message || error);
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'GET /api/knowledge/transparency',
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: 500,
            error: 'knowledge_transparency_failed',
            metadata: { message },
        });
        res.setHeader('x-error', 'knowledge_transparency_failed');
        return res.status(500).json({ error: 'knowledge_transparency_failed', message });
    }
});

app.post('/api/knowledge/repair', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    const action = String(req.body?.action || '').trim().toLowerCase();
    const jobId = String(req.body?.job_id || '').trim();
    if (!['reindex_vectors', 'rebuild_graph', 'repair_all'].includes(action)) {
        return res.status(400).json({ error: 'invalid_action', hint: 'Use reindex_vectors, rebuild_graph, or repair_all.' });
    }
    if (!isUuidLike(jobId)) {
        return res.status(400).json({ error: 'invalid_job_id', hint: 'Provide a valid ingestion job UUID.' });
    }
    try {
        const result = {
            action,
            job_id: jobId,
            vector_repair: null,
            graph_repair: null,
        };
        if (action === 'reindex_vectors' || action === 'repair_all') {
            result.vector_repair = await reindexKnowledgeVectorsForJob(jobId);
        }
        if (action === 'rebuild_graph' || action === 'repair_all') {
            result.graph_repair = await rebuildKnowledgeGraphForJob(jobId, trace_id || '');
        }
        const transparency = await getKnowledgeTransparencySnapshot();
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/knowledge/repair',
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: 200,
            metadata: {
                action,
                job_id: jobId,
                point_count: result.vector_repair?.point_count || 0,
                graph_entities: result.graph_repair?.entities || 0,
                graph_relationships: result.graph_repair?.relationships || 0,
            },
        });
        return res.json({
            ok: true,
            trace_id,
            result,
            transparency,
        });
    } catch (error) {
        const message = String(error?.message || error);
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/knowledge/repair',
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - start,
            status: 500,
            error: 'knowledge_repair_failed',
            metadata: { action, job_id: jobId, message },
        });
        res.setHeader('x-error', 'knowledge_repair_failed');
        return res.status(500).json({ error: 'knowledge_repair_failed', message });
    }
});



app.get('/api/settings/infrastructure', async (_req, res) => {
    try {
        const settings = await getEngineSettings();
        const knowledge = resolveKnowledgeStorageSettings(settings.config || {});
        const dbUrl = String(DATABASE_URL || '').trim();
        let postgresHost = '';
        let postgresDatabase = '';
        let postgresUser = '';
        let postgresPort = 5432;
        if (dbUrl) {
            try {
                const parsed = new URL(dbUrl);
                postgresHost = String(parsed.hostname || '').trim();
                postgresDatabase = String(parsed.pathname || '').replace(/^\//, '').trim();
                postgresUser = decodeURIComponent(String(parsed.username || '').trim());
                const parsedPort = Number(parsed.port || 5432);
                postgresPort = Number.isFinite(parsedPort) ? parsedPort : 5432;
            } catch {
                // Keep defaults if DATABASE_URL is not URL-parsable.
            }
        }
        return res.json({
            s3: {
                s3_bucket: knowledge.s3_bucket || '',
                s3_region: knowledge.s3_region || '',
                s3_prefix: knowledge.s3_prefix || 'ghostdash-ingestion',
                s3_api_key_set: !!knowledge.s3_api_key,
                s3_api_token_set: !!knowledge.s3_api_token,
            },
            qdrant: {
                url: String(QDRANT_URL || '').trim(),
            },
            postgres: {
                host: postgresHost,
                database: postgresDatabase,
                user: postgresUser,
                port: postgresPort,
            },
        });
    } catch {
        res.setHeader('x-error', 'infrastructure_settings_fetch_failed');
        return res.status(500).json({ error: 'infrastructure_settings_fetch_failed' });
    }
});

app.post('/api/settings/infrastructure/test', async (req, res) => {
    const startedAt = Date.now();
    const targetRaw = String(req.body?.target || '').trim().toLowerCase();
    const target = ['s3', 'qdrant', 'postgres'].includes(targetRaw) ? targetRaw : '';
    if (!target) {
        res.setHeader('x-error', 'invalid_target');
        return res.status(400).json({ ok: false, error: 'invalid_target', hint: 'Use one of: s3, qdrant, postgres' });
    }
    try {
        if (target === 's3') {
            const settings = await getEngineSettings();
            const knowledge = resolveKnowledgeStorageSettings(settings.config || {});
            const configured = !!knowledge.s3_bucket && !!knowledge.s3_region && !!knowledge.s3_api_key && !!knowledge.s3_api_token;
            if (!configured) {
                return res.status(503).json({
                    ok: false,
                    target,
                    error: 's3_not_configured',
                    latency_ms: Date.now() - startedAt,
                });
            }
            return res.json({ ok: true, target, latency_ms: Date.now() - startedAt });
        }
        if (target === 'qdrant') {
            await qdrantRequest('/collections', 'GET');
            return res.json({ ok: true, target, latency_ms: Date.now() - startedAt });
        }
        await pool.query('SELECT 1');
        return res.json({ ok: true, target, latency_ms: Date.now() - startedAt });
    } catch (error) {
        const message = String(error?.message || error);
        res.setHeader('x-error', 'infrastructure_test_failed');
        return res.status(503).json({
            ok: false,
            target,
            error: 'infrastructure_test_failed',
            message,
            latency_ms: Date.now() - startedAt,
        });
    }
});

app.get('/api/settings/knowledge', async (_req, res) => {
    try {
        const settings = await getEngineSettings();
        res.json({ ok: true, knowledge_storage: toKnowledgeStoragePublicView(settings.config || {}) });
    }
    catch {
        res.setHeader('x-error', 'knowledge_settings_fetch_failed');
        res.status(500).json({ error: 'knowledge_settings_fetch_failed' });
    }
});

app.patch('/api/settings/knowledge', async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const patch = {};
        const next = {};
        const mapField = (field) => {
            if (Object.prototype.hasOwnProperty.call(body, field)) {
                next[field] = String(body[field] || '').trim();
            }
        };
        mapField('s3_bucket');
        mapField('s3_region');
        mapField('s3_prefix');
        mapField('s3_api_key');
        mapField('s3_api_token');
        mapField('cohere_rerank_api_key');
        mapField('rerank_model');
        mapField('llamaindex_url');
        mapField('llamaindex_internal_key');
        mapField('shopify_mcp_url');
        mapField('shopify_mcp_internal_key');
        if (Object.prototype.hasOwnProperty.call(next, 'llamaindex_internal_key')
            && isMaskedSecretPlaceholder(next.llamaindex_internal_key)) {
            return res.status(400).json({ error: 'invalid_llamaindex_internal_key', hint: 'Provide a real key value, not a masked placeholder.' });
        }
        if (Object.prototype.hasOwnProperty.call(next, 'cohere_rerank_api_key')
            && isMaskedSecretPlaceholder(next.cohere_rerank_api_key)) {
            return res.status(400).json({ error: 'invalid_cohere_rerank_api_key', hint: 'Provide a real key value, not a masked placeholder.' });
        }
        if (Object.prototype.hasOwnProperty.call(next, 'shopify_mcp_internal_key')
            && isMaskedSecretPlaceholder(next.shopify_mcp_internal_key)) {
            return res.status(400).json({ error: 'invalid_shopify_mcp_internal_key', hint: 'Provide a real key value, not a masked placeholder.' });
        }
        if (Object.prototype.hasOwnProperty.call(body, 'rerank_enabled')) {
            next.rerank_enabled = body.rerank_enabled === true;
        }
        const normalizedLocation = normalizeS3LocationInput({
            s3_bucket: next.s3_bucket,
            s3_region: next.s3_region,
            s3_prefix: next.s3_prefix,
        });
        if (next.s3_bucket !== undefined) next.s3_bucket = normalizedLocation.s3_bucket;
        if (next.s3_region !== undefined) next.s3_region = normalizedLocation.s3_region;
        if (next.s3_prefix !== undefined) next.s3_prefix = normalizedLocation.s3_prefix;
        if (Object.keys(next).length === 0) {
            return res.status(400).json({ error: 'no_updates' });
        }
        patch.knowledge_storage = next;
        const updated = await saveEngineSettingsPatch(patch);
        res.json({
            ok: true,
            updated_at: updated.updated_at,
            knowledge_storage: toKnowledgeStoragePublicView(updated.config || {}),
        });
    }
    catch {
        res.setHeader('x-error', 'knowledge_settings_update_failed');
        res.status(500).json({ error: 'knowledge_settings_update_failed' });
    }
});

app.post('/api/settings/knowledge/test', async (req, res) => {
    const trace_id = crypto.randomUUID();
    const span_id = crypto.randomUUID();
    const started = Date.now();
    const start_ts = nowIso();
    try {
        const settings = await getEngineSettings();
        const persistedKnowledge = resolveKnowledgeStorageSettings(settings.config || {});
        const targetRaw = String(req.body?.target || 'all').trim().toLowerCase();
        const target = ['all', 's3', 'cohere', 'llamaindex', 'shopify_mcp'].includes(targetRaw) ? targetRaw : 'all';
        const overridesInput = req.body?.overrides && typeof req.body.overrides === 'object' ? req.body.overrides : {};
        const allowedOverrideKeys = new Set([
            's3_bucket',
            's3_region',
            's3_prefix',
            's3_api_key',
            's3_api_token',
            'cohere_rerank_api_key',
            'llamaindex_url',
            'llamaindex_internal_key',
            'shopify_mcp_url',
            'shopify_mcp_internal_key',
        ]);
        const overrideKnowledge = {};
        for (const [key, value] of Object.entries(overridesInput)) {
            if (!allowedOverrideKeys.has(key)) continue;
            overrideKnowledge[key] = String(value || '').trim();
        }
        const knowledge = resolveKnowledgeStorageSettings({
            ...(settings.config || {}),
            knowledge_storage: {
                ...((settings.config || {}).knowledge_storage || {}),
                ...overrideKnowledge,
            },
        });
        const s3_ok = !!knowledge.s3_bucket && !!knowledge.s3_region && !!knowledge.s3_api_key && !!knowledge.s3_api_token;
        let cohere_ok = false;
        let cohere_status = 0;
        let cohere_latency_ms = 0;
        let cohere_error = null;
        if (knowledge.cohere_rerank_api_key) {
            try {
                const cohereStart = Date.now();
                const upstream = await fetch('https://api.cohere.com/v1/models', {
                    headers: {
                        Authorization: `Bearer ${knowledge.cohere_rerank_api_key}`,
                        'Content-Type': 'application/json',
                    },
                });
                cohere_latency_ms = Date.now() - cohereStart;
                cohere_status = upstream.status;
                cohere_ok = upstream.ok;
                if (!upstream.ok) {
                    const body = await upstream.text().catch(() => '');
                    cohere_error = body.slice(0, 240) || `status_${upstream.status}`;
                }
            }
            catch (err) {
                cohere_error = String(err?.message || err);
                cohere_ok = false;
            }
        } else {
            cohere_error = 'cohere_key_missing';
        }
        let llamaindex_ok = false;
        let llamaindex_status = 0;
        let llamaindex_latency_ms = 0;
        let llamaindex_error = null;
        if (knowledge.llamaindex_url) {
            try {
                const llamaStart = Date.now();
                const upstream = await fetch(`${knowledge.llamaindex_url}/health`, {
                    method: 'GET',
                    headers: {
                        'x-trace-id': trace_id,
                        'x-span-id': span_id,
                        ...(knowledge.llamaindex_internal_key ? { 'x-internal-key': knowledge.llamaindex_internal_key } : {}),
                    },
                    signal: AbortSignal.timeout(8000),
                });
                llamaindex_latency_ms = Date.now() - llamaStart;
                llamaindex_status = upstream.status;
                llamaindex_ok = upstream.ok;
                if (!upstream.ok) {
                    const body = await upstream.text().catch(() => '');
                    llamaindex_error = body.slice(0, 240) || `status_${upstream.status}`;
                }
            }
            catch (err) {
                llamaindex_error = String(err?.message || err);
                llamaindex_ok = false;
            }
        }
        let shopify_mcp_ok = false;
        let shopify_mcp_status = 0;
        let shopify_mcp_latency_ms = 0;
        let shopify_mcp_error = null;
        if (knowledge.shopify_mcp_url) {
            try {
                const shopifyStart = Date.now();
                const upstream = await fetch(`${knowledge.shopify_mcp_url}/health`, {
                    method: 'GET',
                    headers: {
                        'x-trace-id': trace_id,
                        'x-span-id': span_id,
                        ...(knowledge.shopify_mcp_internal_key ? { 'x-internal-key': knowledge.shopify_mcp_internal_key } : {}),
                    },
                    signal: AbortSignal.timeout(8000),
                });
                shopify_mcp_latency_ms = Date.now() - shopifyStart;
                shopify_mcp_status = upstream.status;
                shopify_mcp_ok = upstream.ok;
                if (!upstream.ok) {
                    const body = await upstream.text().catch(() => '');
                    shopify_mcp_error = body.slice(0, 240) || `status_${upstream.status}`;
                }
            }
            catch (err) {
                shopify_mcp_error = String(err?.message || err);
                shopify_mcp_ok = false;
            }
        }
        const overallOk = s3_ok && cohere_ok && llamaindex_ok && shopify_mcp_ok;
        const targetOk = target === 'all'
            ? overallOk
            : target === 's3'
                ? s3_ok
                : target === 'cohere'
                    ? cohere_ok
                    : target === 'llamaindex'
                        ? llamaindex_ok
                        : shopify_mcp_ok;
        const payload = {
            ok: targetOk,
            target,
            overall_ok: overallOk,
            s3: { configured: s3_ok, bucket: knowledge.s3_bucket || null, region: knowledge.s3_region || null },
            cohere: {
                configured: !!knowledge.cohere_rerank_api_key,
                ok: cohere_ok,
                status: cohere_status || null,
                latency_ms: cohere_latency_ms || null,
                error: cohere_error,
            },
            llamaindex: {
                configured: !!knowledge.llamaindex_url,
                url: knowledge.llamaindex_url || null,
                auth_set: !!knowledge.llamaindex_internal_key,
                ok: llamaindex_ok,
                status: llamaindex_status || null,
                latency_ms: llamaindex_latency_ms || null,
                error: llamaindex_error,
            },
            shopify_mcp: {
                configured: !!knowledge.shopify_mcp_url,
                url: knowledge.shopify_mcp_url || null,
                auth_set: !!knowledge.shopify_mcp_internal_key,
                ok: shopify_mcp_ok,
                status: shopify_mcp_status || null,
                latency_ms: shopify_mcp_latency_ms || null,
                error: shopify_mcp_error,
            },
        };
        const end_ts = nowIso();
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/settings/knowledge/test',
            start_ts,
            end_ts,
            latency_ms: Date.now() - started,
            status: payload.ok ? 200 : 503,
            error: payload.ok ? null : 'knowledge_settings_test_failed',
            metadata: {
                target,
                target_ok: targetOk,
                overall_ok: overallOk,
                s3_ok,
                cohere_ok,
                cohere_status: cohere_status || null,
                cohere_latency_ms: cohere_latency_ms || null,
                llamaindex_ok,
                llamaindex_status: llamaindex_status || null,
                llamaindex_latency_ms: llamaindex_latency_ms || null,
                shopify_mcp_ok,
                shopify_mcp_status: shopify_mcp_status || null,
                shopify_mcp_latency_ms: shopify_mcp_latency_ms || null,
            },
        });
        return res.status(payload.ok ? 200 : 503).json(payload);
    }
    catch {
        const end_ts = nowIso();
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/settings/knowledge/test',
            start_ts,
            end_ts,
            latency_ms: Date.now() - started,
            status: 500,
            error: 'knowledge_settings_test_failed',
            metadata: {},
        });
        res.setHeader('x-error', 'knowledge_settings_test_failed');
        return res.status(500).json({ ok: false, error: 'knowledge_settings_test_failed' });
    }
});

app.get('/api/settings/ops-status', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    try {
        const [llm, engineRunningQ, syncRunningQ, latestSyncQ, summaryQ] = await Promise.all([
            loadDashboardLlmConfig(),
            pool.query(`SELECT COUNT(*)::int AS count FROM engine_runs WHERE status = 'running'`),
            pool.query(`SELECT COUNT(*)::int AS count FROM elevenlabs_sync_runs WHERE status = 'running'`),
            pool.query(
                `SELECT id, trace_id, agent_id, status, started_at, ended_at, duration_ms,
                        fetched_total, inserted_total, updated_total, page_count, error
                 FROM elevenlabs_sync_runs
                 ORDER BY started_at DESC
                 LIMIT 10`
            ),
            pool.query(
                `SELECT
                   COUNT(*)::int AS total_calls,
                   COUNT(*) FILTER (WHERE COALESCE(btrim(transcript_summary), '') <> '')::int AS summarized_calls,
                   COUNT(*) FILTER (WHERE COALESCE(btrim(transcript_summary), '') = '')::int AS missing_summary_calls,
                   COUNT(*) FILTER (
                     WHERE COALESCE(btrim(transcript_summary), '') = ''
                       AND EXISTS (
                         SELECT 1 FROM elevenlabs_conversation_messages m
                         WHERE m.conversation_id = c.conversation_id
                       )
                   )::int AS missing_with_transcript,
                   COUNT(*) FILTER (
                     WHERE COALESCE(btrim(transcript_summary), '') = ''
                       AND NOT EXISTS (
                         SELECT 1 FROM elevenlabs_conversation_messages m
                         WHERE m.conversation_id = c.conversation_id
                       )
                   )::int AS missing_without_transcript
                 FROM elevenlabs_conversations c`
            ),
        ]);
        const summary = summaryQ.rows?.[0] || {};
        const end_ts = nowIso();
        const latency_ms = Date.now() - start;
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'GET /api/settings/ops-status',
            start_ts,
            end_ts,
            latency_ms,
            status: 200,
            metadata: {
                llm_configured: !!llm,
                engine_running: engineRunningQ.rows?.[0]?.count || 0,
                sync_running: syncRunningQ.rows?.[0]?.count || 0,
            },
        });
        return res.json({
            ok: true,
            llm: llm
                ? {
                    configured: true,
                    model_uuid: llm.model_uuid,
                    model_id: llm.label || llm.model_id,
                    chat_url: null,
                }
                : {
                    configured: false,
                    model_uuid: null,
                    model_id: null,
                    chat_url: null,
                },
            jobs: {
                engine_running: Number(engineRunningQ.rows?.[0]?.count || 0),
                elevenlabs_sync_running: Number(syncRunningQ.rows?.[0]?.count || 0),
                elevenlabs_latest_sync_runs: latestSyncQ.rows || [],
            },
            elevenlabs_summary_backlog: {
                total_calls: Number(summary.total_calls || 0),
                summarized_calls: Number(summary.summarized_calls || 0),
                missing_summary_calls: Number(summary.missing_summary_calls || 0),
                missing_with_transcript: Number(summary.missing_with_transcript || 0),
                missing_without_transcript: Number(summary.missing_without_transcript || 0),
            },
        });
    } catch (e) {
        const end_ts = nowIso();
        const latency_ms = Date.now() - start;
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'GET /api/settings/ops-status',
            start_ts,
            end_ts,
            latency_ms,
            status: 500,
            error: 'ops_status_fetch_failed',
            metadata: { error: String(e?.message || e) },
        });
        res.setHeader('x-error', 'ops_status_fetch_failed');
        return res.status(500).json({ error: 'ops_status_fetch_failed' });
    }
});

app.post('/api/settings/llm/test', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    try {
        const auth = parseAuthedUserFromRequest(req);
        const runtime = await resolveDashboardAssistantRuntime({
            model_uuid: String(req.body?.model_uuid || '').trim(),
            user_id: auth?.id || '',
        });
        const llm = runtime.llm;
        if (!llm) {
            res.setHeader('x-error', 'dashboard_llm_not_configured');
            return res.status(503).json({ error: 'dashboard_llm_not_configured' });
        }
        const testResult = await runDashboardAssistantConnectivityTest({
            llm,
            trace_id,
            route: 'POST /api/settings/llm/test',
        });
        const end_ts = nowIso();
        const latency_ms = Date.now() - start;
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/settings/llm/test',
            start_ts,
            end_ts,
            latency_ms,
            status: testResult.ok ? 200 : 502,
            error: testResult.ok ? null : 'llm_connectivity_failed',
            metadata: {
                model_id: llm.model_id,
                upstream_status: testResult.llm_result?.status,
                upstream_latency_ms: testResult.upstream_latency_ms,
                token_policy: testResult.llm_result?.token_policy,
            },
        });
        return res.status(testResult.ok ? 200 : 502).json({
            ok: testResult.ok,
            model_uuid: llm.model_uuid,
            model_id: llm.model_id,
            chat_url: llm.chat_url,
            upstream_status: testResult.llm_result?.status,
            upstream_latency_ms: testResult.upstream_latency_ms,
            reply_preview: testResult.reply_preview,
            error: testResult.ok ? null : testResult.llm_result?.message || 'llm_connectivity_failed',
            token_policy: testResult.llm_result?.token_policy,
            token_policy_notice: testResult.llm_result?.token_policy_notice,
        });
    } catch (e) {
        const end_ts = nowIso();
        const latency_ms = Date.now() - start;
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/settings/llm/test',
            start_ts,
            end_ts,
            latency_ms,
            status: 500,
            error: 'llm_connectivity_test_failed',
            metadata: { error: String(e?.message || e) },
        });
        res.setHeader('x-error', 'llm_connectivity_test_failed');
        return res.status(500).json({ error: 'llm_connectivity_test_failed', message: String(e?.message || e) });
    }
});

app.get('/api/engine/runs', async (req, res) => {
    const limit = parsePositiveInt(req.query.limit, 30);
    try {
        const runs = await pool.query(
            `SELECT id, trigger, status, trace_id, started_at, ended_at, latency_ms, summary, error
       FROM engine_runs
       ORDER BY started_at DESC
       LIMIT $1`,
            [limit]
        );
        res.json(runs.rows);
    }
    catch {
        res.setHeader('x-error', 'engine_runs_fetch_failed');
        res.status(500).json({ error: 'engine_runs_fetch_failed' });
    }
});

app.get('/api/engine/runs/:id', async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'missing_run_id' });
    try {
        const run = await pool.query(
            `SELECT id, trigger, status, trace_id, started_at, ended_at, latency_ms, summary, error
       FROM engine_runs
       WHERE id = $1
       LIMIT 1`,
            [id]
        );
        if (run.rowCount === 0) return res.status(404).json({ error: 'run_not_found' });
        const steps = await pool.query(
            `SELECT id, step_key, status, started_at, ended_at, latency_ms, detail, error
       FROM engine_run_steps
       WHERE run_id = $1
       ORDER BY id ASC`,
            [id]
        );
        res.json({ ...run.rows[0], steps: steps.rows });
    }
    catch {
        res.setHeader('x-error', 'engine_run_fetch_failed');
        res.status(500).json({ error: 'engine_run_fetch_failed' });
    }
});

app.post('/api/engine/run', async (req, res) => {
    const force = req.body?.force === true;
    const out = await executeRdEngineRun({ trigger: 'manual', force });
    if (out.ok) return res.json(out);
    if (out.skipped) return res.status(409).json(out);
    return res.status(500).json(out);
});

app.get('/api/knowledge/entries', async (req, res) => {
    const limit = parsePositiveInt(req.query.limit, 100);
    const q = String(req.query.q || '').trim();
    try {
        const rows = await pool.query(
            `SELECT id, source_type, title, content, tags, metadata, created_by_run_id, created_at
       FROM knowledge_entries
       WHERE ($1::text = '' OR title ILIKE '%' || $1 || '%' OR content ILIKE '%' || $1 || '%')
       ORDER BY created_at DESC
       LIMIT $2`,
            [q, limit]
        );
        res.json(rows.rows);
    }
    catch {
        res.setHeader('x-error', 'knowledge_entries_fetch_failed');
        res.status(500).json({ error: 'knowledge_entries_fetch_failed' });
    }
});

app.post('/api/knowledge/assistant/intake', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const route = 'POST /api/knowledge/assistant/intake';
    const startTs = nowIso();
    const startedAt = Date.now();
    const objectiveText = String(req.body?.objective || '').trim();
    const purpose = String(req.body?.purpose || objectiveText || '').trim();
    const requestedModelUuid = String(req.body?.model_uuid || '').trim();
    const rawDataType = String(req.body?.data_type || '').trim().toLowerCase();
    const useCase = String(req.body?.use_case || '').trim();
    const collectionTargetIntent = String(req.body?.collection_target_intent || '').trim().slice(0, 180);
    const selectedFiles = (Array.isArray(req.body?.selected_files) ? req.body.selected_files : [])
        .map((entry) => {
            if (!entry || typeof entry !== 'object') return null;
            const rawName = String(entry.name || '').trim();
            const name = rawName.slice(0, 220);
            const extension = String(entry.extension || '').trim().toLowerCase().replace(/[^a-z0-9.+-]/g, '').slice(0, 20);
            const mime_type = String(entry.mime_type || '').trim().slice(0, 120);
            const relative_path = String(entry.relative_path || '').trim().slice(0, 240);
            const size_bytes = Number(entry.size_bytes || 0);
            if (!name) return null;
            return {
                name,
                extension: extension || null,
                mime_type: mime_type || null,
                relative_path: relative_path || null,
                size_bytes: Number.isFinite(size_bytes) && size_bytes >= 0 ? size_bytes : null,
            };
        })
        .filter(Boolean)
        .slice(0, 60);
    const inferSelectedFileSuitability = (files = []) => {
        const categories = {
            text_documents: 0,
            scanned_or_image: 0,
            tabular: 0,
            code_or_markup: 0,
            archive_or_binary: 0,
            unknown: 0,
        };
        const extensionHistogram = {};
        for (const file of files) {
            const ext = String(file?.extension || '').toLowerCase();
            if (ext) {
                extensionHistogram[ext] = Number(extensionHistogram[ext] || 0) + 1;
            }
            if (['pdf', 'doc', 'docx', 'txt', 'md', 'rtf'].includes(ext)) {
                categories.text_documents += 1;
            } else if (['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'bmp', 'heic'].includes(ext)) {
                categories.scanned_or_image += 1;
            } else if (['csv', 'xlsx', 'xls', 'tsv', 'jsonl'].includes(ext)) {
                categories.tabular += 1;
            } else if (['json', 'xml', 'html', 'htm', 'js', 'ts', 'tsx', 'py', 'sql'].includes(ext)) {
                categories.code_or_markup += 1;
            } else if (['zip', 'gz', 'rar', '7z', 'exe', 'bin'].includes(ext)) {
                categories.archive_or_binary += 1;
            } else {
                categories.unknown += 1;
            }
        }
        const warnings = [];
        if (categories.archive_or_binary > 0) warnings.push('archive_or_binary_detected');
        if (categories.unknown > 0) warnings.push('unknown_file_extensions_present');
        if (categories.scanned_or_image > 0 && categories.text_documents === 0) warnings.push('ocr_heavy_intake_expected');
        return {
            total_files: files.length,
            categories,
            extension_histogram: extensionHistogram,
            warnings,
        };
    };
    const selectedFileSuitability = inferSelectedFileSuitability(selectedFiles);
    const inferDataType = (text) => {
        const lower = String(text || '').toLowerCase();
        const hasImage = /(image|scan|ocr|photo|png|jpg|jpeg|screenshot)/.test(lower);
        const hasText = /(text|pdf|document|manual|unstructured|docx|html|markdown|knowledge base)/.test(lower);
        if (hasImage && hasText) return 'mixed';
        if (hasImage) return 'images';
        if (hasText) return 'text';
        return 'mixed';
    };
    const normalizedDataType = (() => {
        if (['text', 'images', 'mixed'].includes(rawDataType)) return rawDataType;
        if (['image', 'img', 'scan', 'scans', 'ocr'].includes(rawDataType)) return 'images';
        if (['pdf', 'document', 'documents', 'docs', 'unstructured'].includes(rawDataType)) return 'text';
        return inferDataType(`${purpose}\n${objectiveText}`);
    })();
    const normalizedUseCase = String(useCase || purpose || objectiveText).trim();
    let requestLogged = false;
    const writeRequestLog = async ({ status, error = null, metadata = {} }) => {
        if (requestLogged) return;
        requestLogged = true;
        await insertRequestLogRow({
            trace_id,
            span_id,
            route,
            start_ts: startTs,
            end_ts: nowIso(),
            latency_ms: Date.now() - startedAt,
            status,
            error,
            metadata,
        });
    };
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write(': intake-assistant-stream\n\n');
    if (!purpose || !normalizedUseCase || !['text', 'images', 'mixed'].includes(normalizedDataType)) {
        await writeRequestLog({
            status: 400,
            error: 'missing_intake_fields',
            metadata: { data_type: normalizedDataType || null },
        });
        writeSseEvent(res, 'error', {
            trace_id,
            error: 'missing_intake_fields',
            status: 400,
            hint: 'Provide purpose, data_type (text|images|mixed), and use_case.',
        });
        return res.end();
    }
    const cappedUseCase = normalizedUseCase.slice(0, 600);
    let resolvedLlmModelId = null;
    const finalizeWithError = async ({ status = 500, error = 'knowledge_intake_failed', message = '', metadata = {} }) => {
        await insertLlmDebugLog({
            trace_id,
            span_id,
            level: 'error',
            event: 'ingestion.assistant.plan_failed',
            detail: {
                purpose,
                data_type: normalizedDataType,
                use_case: cappedUseCase,
                error,
                message,
                ...metadata,
            },
        });
        await writeRequestLog({
            status,
            error,
            metadata: {
                purpose_chars: purpose.length,
                data_type: normalizedDataType,
                use_case_chars: cappedUseCase.length,
                requested_model_uuid: requestedModelUuid || null,
                resolved_model_id: resolvedLlmModelId,
                message,
                ...metadata,
            },
        });
        writeSseEvent(res, 'error', {
            trace_id,
            status,
            error,
            message,
        });
        res.end();
    };
    try {
        writeSseEvent(res, 'accepted', {
            trace_id,
            purpose,
            data_type: normalizedDataType,
            use_case: cappedUseCase,
            selected_file_count: selectedFiles.length,
        });
        const auth = parseAuthedUserFromRequest(req);
        const runtime = await resolveDashboardAssistantRuntime({
            model_uuid: requestedModelUuid,
            user_id: auth?.id || '',
        });
        let llm = runtime?.llm || null;
        let llmSource = 'assistant_runtime';
        if (!llm && requestedModelUuid) {
            const legacyRows = await pool.query(
                `SELECT m.id,
                        m.provider_id,
                        m.label,
                        m.model_id,
                        m.config,
                        m.enabled,
                        p.name AS provider_name,
                        p.slug AS provider_slug,
                        p.kind AS provider_kind,
                        p.base_url,
                        p.api_key_env,
                        p.enabled AS provider_enabled
                   FROM llm_registry m
                   JOIN llm_registry p ON p.id = m.provider_id
                  WHERE m.id = $1::uuid
                    AND m.record_type = 'model'
                    AND p.record_type = 'provider'
                  LIMIT 1`,
                [requestedModelUuid]
            );
            if (legacyRows.rowCount > 0) {
                const row = legacyRows.rows[0];
                if (row.enabled !== false && row.provider_enabled !== false) {
                    const runtimeSettings = runtime?.engine_settings || await getEngineSettings().catch(() => ({ config: {} }));
                    const runtimeConfig = runtimeSettings?.config || {};
                    const baseUrl = normalizeDashboardProviderBaseUrl(row.provider_kind, row.base_url || '');
                    const chatUrl = resolveOpenAiChatCompletionsUrl(baseUrl);
                    const apiKey = resolveStoredProviderSecret(runtimeConfig, row);
                    if (chatUrl && apiKey) {
                        const config = normalizeModelConfig(row.config, runtimeConfig);
                        llm = {
                            model_uuid: row.id,
                            model_id: row.model_id,
                            label: row.label,
                            provider_id: row.provider_id,
                            provider_name: row.provider_name,
                            provider_slug: row.provider_slug,
                            provider_kind: row.provider_kind,
                            base_url: baseUrl,
                            chat_url: chatUrl,
                            responses_url: resolveOpenAiResponsesUrl(baseUrl),
                            api_key: apiKey,
                            auth_header_name: resolveAssistantApiKeyHeaderName(row),
                            api_mode: resolveLlmApiMode({
                                apiModeRaw: config.api_mode,
                                baseUrl,
                                modelId: row.model_id,
                            }),
                            config,
                            token_policy: config.token_policy,
                        };
                        llmSource = 'legacy_model_override';
                    }
                }
            }
        }
        if (!llm) {
            return finalizeWithError({
                status: 503,
                error: 'knowledge_intake_llm_not_configured',
                message: 'No eligible intake planner model is configured. Set website assistant runtime, or pass a valid enabled model override.',
            });
        }
        resolvedLlmModelId = llm.model_id;
        const llmMode = String(llm?.api_mode || 'chat_completions').toLowerCase() === 'responses'
            ? 'responses'
            : 'chat_completions';
        writeSseEvent(res, 'provider_selected', {
            trace_id,
            model_uuid: llm.model_uuid || null,
            model_id: resolvedLlmModelId,
            provider: llm.provider_slug || null,
            mode: llmMode,
            runtime_source: llmSource,
        });
        writeSseEvent(res, 'thinking', {
            trace_id,
            phase: 'file_suitability_confirmation',
            selected_file_count: selectedFiles.length,
            file_suitability: selectedFileSuitability,
        });
        const requestBody = {
            model: llm.model_id,
            temperature: 0.1,
            max_tokens: 900,
            messages: [
                {
                    role: 'system',
                    content: 'You are a Docling intake specialist. Return strict JSON with keys assistant_message, intake_summary, recommended_collection_name, suggested_options, operator_guidance, system_prompt_template, alignment_summary, settings_rationale. Ask no follow-up questions. suggested_options must include desired_vector_size, chunk_chars, overlap_chars, qa_sample_size, distance, use_llm_for_qa, ocr_engine, ocr_mode, ocr_languages, ocr_timeout_ms.',
                },
                {
                    role: 'user',
                    content: JSON.stringify({
                        purpose,
                        data_type: normalizedDataType,
                        use_case: cappedUseCase,
                        collection_target_intent: collectionTargetIntent || null,
                        selected_files: selectedFiles,
                        file_suitability: selectedFileSuitability,
                    }),
                },
            ],
        };
        let llmText = '';
        let tokenPolicyNotice = null;
        let tokenCount = 0;
        if (llmMode === 'responses') {
            writeSseEvent(res, 'thinking', {
                trace_id,
                phase: 'provider_request_started',
                provider_streaming: false,
                reason: 'responses_mode_non_streaming_bridge',
            });
            const llmResult = await callConfiguredLlm({
                llm,
                trace_id,
                route,
                body: requestBody,
            });
            tokenPolicyNotice = llmResult.token_policy_notice || null;
            if (!llmResult.ok) {
                return finalizeWithError({
                    status: llmResult.status || 502,
                    error: llmResult.error || 'llm_upstream_failed',
                    message: llmResult.message || 'LLM request failed.',
                    metadata: { mode: llmMode },
                });
            }
            llmText = String(extractLlmTextFromUpstreamBody(llmResult.upstream_body || {}) || '').trim();
        } else {
            const preparedRequest = prepareLlmChatRequest({ llm, body: requestBody, route });
            if (!preparedRequest.ok) {
                return finalizeWithError({
                    status: preparedRequest.status || 400,
                    error: preparedRequest.error || 'context_too_large_for_model',
                    message: preparedRequest.message || 'The intake request exceeds the configured token budget.',
                    metadata: { token_policy: preparedRequest.token_policy },
                });
            }
            tokenPolicyNotice = preparedRequest.notice || null;
            const providerApiKey = String(llm.api_key || '').trim();
            const headers = {
                'Content-Type': 'application/json',
                ...buildApiKeyHeaders(providerApiKey, llm.auth_header_name || 'Authorization'),
                ...(trace_id ? { 'x-trace-id': trace_id } : {}),
            };
            const upstreamRes = await fetch(llm.chat_url, {
                method: 'POST',
                headers,
                body: JSON.stringify({ ...preparedRequest.body, stream: true }),
            });
            if (!upstreamRes.ok || !upstreamRes.body) {
                const failBody = await upstreamRes.text().catch(() => '');
                const streamUnsupported = upstreamRes.status === 400 && /stream\s*=\s*true\s+is\s+not\s+supported/i.test(failBody);
                if (streamUnsupported) {
                    writeSseEvent(res, 'thinking', {
                        trace_id,
                        phase: 'provider_stream_unsupported_fallback',
                        provider_streaming: false,
                    });
                    const fallbackRes = await fetch(llm.chat_url, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify(preparedRequest.body),
                    });
                    const fallbackBody = await fallbackRes.json().catch(() => ({}));
                    if (!fallbackRes.ok) {
                        return finalizeWithError({
                            status: fallbackRes.status || 502,
                            error: 'llm_upstream_failed',
                            message: firstNonEmptyString(
                                fallbackBody?.error?.message,
                                fallbackBody?.error,
                                fallbackBody?.message
                            ) || `upstream_${fallbackRes.status || 502}`,
                            metadata: {
                                mode: llmMode,
                                upstream_status: fallbackRes.status || null,
                                fallback_mode: 'non_streaming',
                            },
                        });
                    }
                    llmText = String(extractLlmTextFromUpstreamBody(fallbackBody) || '').trim();
                    if (llmText) {
                        const chunks = splitTextForStreaming(llmText, 28);
                        for (let idx = 0; idx < chunks.length; idx += 1) {
                            tokenCount += 1;
                            writeSseEvent(res, 'token', { trace_id, index: tokenCount, text: chunks[idx] });
                            if (idx < chunks.length - 1) {
                                await wait(30);
                            }
                        }
                    }
                } else {
                return finalizeWithError({
                    status: upstreamRes.status || 502,
                    error: 'llm_upstream_failed',
                    message: failBody.slice(0, 1000) || `upstream_${upstreamRes.status || 502}`,
                    metadata: {
                        mode: llmMode,
                        upstream_status: upstreamRes.status || null,
                    },
                });
                }
            }
            if (upstreamRes.ok && upstreamRes.body) {
                writeSseEvent(res, 'thinking', {
                    trace_id,
                    phase: 'provider_stream_open',
                    provider_streaming: true,
                });
                const decoder = new TextDecoder();
                const parser = createVllmStreamParser(
                    (delta) => {
                        llmText += delta;
                        tokenCount += 1;
                        writeSseEvent(res, 'token', { trace_id, index: tokenCount, text: delta });
                    },
                    () => {
                        writeSseEvent(res, 'thinking', { trace_id, phase: 'provider_stream_complete' });
                    }
                );
                for await (const chunk of upstreamRes.body) {
                    parser(decoder.decode(chunk, { stream: true }));
                }
                parser('\n');
            }
        }
        const parsed = parseJsonFromLlmText(llmText);
        const usedJsonFallback = !parsed || typeof parsed !== 'object';
        if (usedJsonFallback) {
            writeSseEvent(res, 'thinking', {
                trace_id,
                phase: 'planner_json_fallback',
                reason: 'llm_output_not_valid_json',
            });
            await insertLlmDebugLog({
                trace_id,
                span_id,
                level: 'warn',
                event: 'ingestion.assistant.plan_json_fallback',
                detail: {
                    purpose,
                    data_type: normalizedDataType,
                    use_case: cappedUseCase,
                    model_id: resolvedLlmModelId,
                    mode: llmMode,
                    llm_output_preview: llmText.slice(0, 2000),
                },
            });
        }
        const plan = normalizeIntakeAssistantPlan(usedJsonFallback ? {} : parsed, {
            normalizedDataType,
            purpose,
            cappedUseCase,
        });
        if (usedJsonFallback) {
            plan.alignment_summary = firstNonEmptyString(
                plan.alignment_summary,
                'Planner output was malformed JSON; applied safe default intake configuration.'
            );
            const fallbackNote = 'JSON fallback applied: defaults used because planner output was not valid JSON.';
            if (!Array.isArray(plan.settings_rationale)) {
                plan.settings_rationale = [fallbackNote];
            } else if (!plan.settings_rationale.includes(fallbackNote)) {
                plan.settings_rationale.push(fallbackNote);
            }
        }
        if (tokenPolicyNotice) {
            plan.token_policy_notice = tokenPolicyNotice;
        }
        await insertLlmDebugLog({
            trace_id,
            span_id,
            level: 'debug',
            event: 'ingestion.assistant.plan',
            detail: {
                purpose,
                data_type: normalizedDataType,
                use_case: cappedUseCase,
                model_id: resolvedLlmModelId,
                mode: llmMode,
                plan_preview: {
                    assistant_message: plan.assistant_message,
                    suggested_options: plan.suggested_options,
                },
            },
        });
        await writeRequestLog({
            status: 200,
            error: null,
            metadata: {
                purpose_chars: purpose.length,
                data_type: normalizedDataType,
                use_case_chars: cappedUseCase.length,
                requested_model_uuid: requestedModelUuid || null,
                resolved_model_id: resolvedLlmModelId,
                mode: llmMode,
                used_json_fallback: usedJsonFallback,
                streamed_token_count: tokenCount,
                token_policy_notice: tokenPolicyNotice,
                selected_file_count: selectedFiles.length,
                collection_target_intent: collectionTargetIntent || null,
                llm_source: llmSource,
            },
        });
        writeSseEvent(res, 'settings_ready', { trace_id, resolved_model_id: resolvedLlmModelId, plan });
        writeSseEvent(res, 'done', {
            trace_id,
            resolved_model_id: resolvedLlmModelId,
            latency_ms: Date.now() - startedAt,
        });
        return res.end();
    } catch (error) {
        const message = String(error?.message || error);
        return finalizeWithError({
            status: 500,
            error: 'knowledge_intake_failed',
            message,
        });
    }
});

app.get('/api/knowledge/graph/status', async (req, res) => {
    const jobId = String(req.query.job_id || '').trim();
    try {
        const rows = jobId
            ? await pool.query(
                `SELECT id, job_id, status, summary, error, created_at, updated_at
                 FROM knowledge_graph_runs
                 WHERE job_id = $1::uuid
                 ORDER BY created_at DESC
                 LIMIT 20`,
                [jobId]
            )
            : await pool.query(
                `SELECT id, job_id, status, summary, error, created_at, updated_at
                 FROM knowledge_graph_runs
                 ORDER BY created_at DESC
                 LIMIT 50`
            );
        const entityCount = await pool.query(`SELECT COUNT(*)::int AS count FROM knowledge_entities`);
        const relationCount = await pool.query(`SELECT COUNT(*)::int AS count FROM knowledge_relationships`);
        res.json({
            ok: true,
            totals: {
                entities: Number(entityCount.rows?.[0]?.count || 0),
                relationships: Number(relationCount.rows?.[0]?.count || 0),
            },
            runs: rows.rows || [],
        });
    }
    catch {
        res.setHeader('x-error', 'knowledge_graph_status_failed');
        res.status(500).json({ error: 'knowledge_graph_status_failed' });
    }
});

app.post('/api/knowledge/query', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const query_id = crypto.randomUUID();
    const started = Date.now();
    const start_ts = nowIso();
    const query = String(req.body?.query || '').trim();
    const mode = String(req.body?.mode || '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(25, parsePositiveInt(req.body?.limit, 12)));
    const wantsStream = req.body?.stream === true || String(req.headers?.accept || '').toLowerCase().includes('text/event-stream');
    const metadata = req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {};
    const index_id = firstNonEmptyString(
        metadata?.index_id,
        req.body?.index_id,
        req.body?.collection_name,
        req.body?.collection
    ) || null;
    const config_version = firstNonEmptyString(
        metadata?.config_version,
        req.body?.config_version
    ) || `${mode || 'hybrid'}:${String(req.body?.model_uuid || 'auto').trim() || 'auto'}`;
    if (!query) {
        return res.status(400).json({ error: 'missing_query' });
    }
    let streamOpened = false;
    let finished = false;
    const upstreamController = new AbortController();
    const abortUpstream = () => {
        if (!finished) upstreamController.abort();
    };
    if (wantsStream) {
        req.on('aborted', abortUpstream);
        res.on('close', abortUpstream);
    }
    try {
        if (wantsStream) {
            res.status(200);
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders?.();
            streamOpened = true;
            res.write(': knowledge-query-stream\n\n');
            writeSseEvent(res, 'accepted', {
                trace_id,
                query_id,
                mode: mode || 'hybrid',
                index_id,
                config_version,
            });
            writeSseEvent(res, 'thinking', {
                trace_id,
                phase: 'retrieval_started',
                message: 'Retrieving ranked evidence.',
            });
        }
        const ambiguity = detectAmbiguousKnowledgeQuery(query, {
            collection_name: req.body?.collection_name,
            index_id,
            agent_id: firstNonEmptyString(metadata?.agent_id, req.body?.agent_id),
            document_id: firstNonEmptyString(metadata?.document_id, req.body?.document_id),
            query_scope: firstNonEmptyString(metadata?.query_scope, req.body?.query_scope),
            skip_clarification: req.body?.skip_clarification === true
                || metadata?.skip_clarification === true
                || metadata?.allow_broad_scope === true,
        });
        if (ambiguity.ambiguous) {
            const clarifying = [
                'Which collection, document set, or business area should be prioritised?',
                'What time period, entity, or segment should the answer focus on?',
                'Do you want a factual summary, strategic diagnosis, or specific recommendation?',
            ];
            await insertLlmDebugLog({
                trace_id,
                span_id,
                level: 'debug',
                event: 'knowledge.query.clarify',
                detail: { query, clarifying, ambiguity },
            });
            if (wantsStream) {
                writeSseEvent(res, 'clarification_required', {
                    trace_id,
                    query_id,
                    clarification_reason: ambiguity.reason,
                    matched_token: ambiguity.matched_token || null,
                    clarifying_questions: clarifying,
                });
                writeSseEvent(res, 'done', {
                    trace_id,
                    query_id,
                    ok: false,
                    requires_clarification: true,
                });
                await insertRequestLogRow({
                    trace_id,
                    span_id,
                    route: 'POST /api/knowledge/query',
                    start_ts,
                    end_ts: nowIso(),
                    latency_ms: Date.now() - started,
                    status: 202,
                    error: null,
                    metadata: {
                        query_id,
                        index_id,
                        config_version,
                        stream: true,
                        clarification_reason: ambiguity.reason,
                        matched_token: ambiguity.matched_token || null,
                    },
                });
                finished = true;
                return res.end();
            }
            return res.status(202).json({
                ok: false,
                requires_clarification: true,
                clarification_reason: ambiguity.reason,
                matched_token: ambiguity.matched_token || null,
                clarifying_questions: clarifying,
            });
        }
        const retrieval = await runKnowledgeRetrieval({
            query,
            limit,
            mode,
            trace_id,
            span_id,
            upstream_context: {
                retrieval_context: req.body?.retrieval_context,
                graphrag_results: req.body?.graphrag_results,
                qdrant_hits: req.body?.qdrant_hits,
                db_rows: req.body?.db_rows,
                response_style: req.body?.response_style,
                metadata: req.body?.metadata,
            },
        });
        await insertLlmDebugLog({
            trace_id,
            span_id,
            level: 'debug',
            event: 'knowledge.query.retrieval',
            detail: {
                query,
                retrieval_mode: retrieval.mode,
                candidate_count: retrieval.diagnostics?.candidate_count ?? 0,
                rerank_provider: retrieval.diagnostics?.rerank_provider || null,
                rerank_latency_ms: retrieval.diagnostics?.rerank_latency_ms || 0,
                graph_hops: retrieval.diagnostics?.graph_hops || 0,
            },
        });
        if (wantsStream) {
            writeSseEvent(res, 'retrieval_complete', {
                trace_id,
                query_id,
                retrieval_mode: retrieval.mode,
                candidate_count: retrieval.diagnostics?.candidate_count ?? 0,
                graph_hops: retrieval.diagnostics?.graph_hops || 0,
                citations_preview: (Array.isArray(retrieval.rows) ? retrieval.rows : []).slice(0, 5).map((row) => ({
                    source: String(row.source || 'unknown'),
                    ref_id: String(row.ref_id || ''),
                    title: String(row.title || ''),
                    score: Number(row.score || 0),
                })),
            });
            writeSseEvent(res, 'thinking', {
                trace_id,
                phase: 'answer_synthesis_started',
                message: 'Synthesizing response from retrieved evidence.',
            });
        }
        const synthesized = wantsStream
            ? await synthesizeKnowledgeAnswerStream({
                query,
                retrieval,
                trace_id,
                model_uuid: String(req.body?.model_uuid || '').trim(),
                res,
                signal: upstreamController.signal,
            })
            : await synthesizeKnowledgeAnswer({
                query,
                retrieval,
                trace_id,
                model_uuid: String(req.body?.model_uuid || '').trim(),
            });
        const end_ts = nowIso();
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/knowledge/query',
            start_ts,
            end_ts,
            latency_ms: Date.now() - started,
            status: 200,
            error: null,
            metadata: {
                retrieval_mode: retrieval.mode,
                candidate_count: retrieval.diagnostics?.candidate_count ?? 0,
                rerank_provider: retrieval.diagnostics?.rerank_provider || null,
                rerank_latency_ms: retrieval.diagnostics?.rerank_latency_ms || 0,
                graph_hops: retrieval.diagnostics?.graph_hops || 0,
                orchestration_provider: retrieval.diagnostics?.orchestration_provider || null,
                degraded_mode: retrieval.diagnostics?.degraded_mode ?? null,
                answer_model: synthesized.model || null,
                token_policy: synthesized.token_policy || null,
                query_id,
                index_id,
                config_version,
                document_id: firstNonEmptyString(metadata?.document_id, req.body?.document_id) || null,
                chunk_size: parsePositiveInt(metadata?.chunk_size || req.body?.chunk_size, null),
                chunk_overlap: parsePositiveInt(metadata?.chunk_overlap || req.body?.chunk_overlap, null),
                top_k: parsePositiveInt(metadata?.top_k || req.body?.top_k, limit),
                reranker_enabled: metadata?.reranker_enabled ?? req.body?.reranker_enabled ?? null,
                retrieved_nodes: retrieval.diagnostics?.candidate_count ?? (Array.isArray(retrieval.rows) ? retrieval.rows.length : 0),
                context_tokens: parsePositiveInt(metadata?.context_tokens || req.body?.context_tokens, null),
                answer_tokens: parsePositiveInt(metadata?.answer_tokens || synthesized?.usage?.answer_tokens, null),
                cache_hit: metadata?.cache_hit ?? req.body?.cache_hit ?? null,
                stream: wantsStream,
                streamed_token_count: parsePositiveInt(synthesized?.streamed_token_count, null),
            },
        });
        if (wantsStream) {
            writeSseEvent(res, 'result', {
                ok: true,
                query_id,
                query,
                retrieval_mode: retrieval.mode,
                citations: synthesized.citations,
                answer_model: synthesized.model,
                index_id,
                config_version,
                graphrag_explainer: buildGraphRagExplainText(retrieval.mode, retrieval.diagnostics || {}),
                injected_context_preview: buildKnowledgeInjectionBlock(retrieval, Math.min(6, limit)),
                token_policy: synthesized.token_policy || null,
                token_policy_notice: synthesized.token_policy_notice || null,
            });
            writeSseEvent(res, 'done', {
                trace_id,
                query_id,
                ok: true,
                answer: synthesized.answer,
                answer_model: synthesized.model,
                streamed_token_count: synthesized.streamed_token_count || 0,
                latency_ms: Date.now() - started,
            });
            finished = true;
            return res.end();
        }
        return res.json({
            ok: true,
            query_id,
            query,
            retrieval_mode: retrieval.mode,
            candidates: retrieval.rows,
            diagnostics: retrieval.diagnostics,
            answer: synthesized.answer,
            citations: synthesized.citations,
            answer_model: synthesized.model,
            index_id,
            config_version,
            graphrag_explainer: buildGraphRagExplainText(retrieval.mode, retrieval.diagnostics || {}),
            injected_context_preview: buildKnowledgeInjectionBlock(retrieval, Math.min(6, limit)),
            token_policy: synthesized.token_policy || null,
            token_policy_notice: synthesized.token_policy_notice || null,
        });
    }
    catch (error) {
        const end_ts = nowIso();
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/knowledge/query',
            start_ts,
            end_ts,
            latency_ms: Date.now() - started,
            status: 500,
            error: 'knowledge_query_failed',
            metadata: {
                message: String(error?.message || error),
                query_id,
                index_id,
                config_version,
                stream: wantsStream,
            },
        });
        if (wantsStream && streamOpened) {
            writeSseEvent(res, 'error', {
                trace_id,
                query_id,
                error: 'knowledge_query_failed',
                message: String(error?.message || error),
            });
            writeSseEvent(res, 'done', {
                trace_id,
                query_id,
                ok: false,
            });
            finished = true;
            return res.end();
        }
        res.setHeader('x-error', 'knowledge_query_failed');
        return res.status(500).json({ error: 'knowledge_query_failed', message: String(error?.message || error) });
    }
});

function normalizeEvalWeights(raw = {}) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const defaults = {
        correctness: 0.45,
        grounding: 0.25,
        completeness: 0.2,
        latency: 0.1,
    };
    const out = {
        correctness: Number.isFinite(Number(input.correctness)) ? Number(input.correctness) : defaults.correctness,
        grounding: Number.isFinite(Number(input.grounding)) ? Number(input.grounding) : defaults.grounding,
        completeness: Number.isFinite(Number(input.completeness)) ? Number(input.completeness) : defaults.completeness,
        latency: Number.isFinite(Number(input.latency)) ? Number(input.latency) : defaults.latency,
    };
    const total = out.correctness + out.grounding + out.completeness + out.latency;
    if (total <= 0) return defaults;
    return {
        correctness: out.correctness / total,
        grounding: out.grounding / total,
        completeness: out.completeness / total,
        latency: out.latency / total,
    };
}

function evalNormalizeText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function evalTokenSet(text) {
    return new Set(evalNormalizeText(text).split(' ').filter((t) => t.length >= 3).slice(0, 180));
}

function jaccardScore(a, b) {
    const sa = evalTokenSet(a);
    const sb = evalTokenSet(b);
    if (sa.size === 0 || sb.size === 0) return 0;
    let intersection = 0;
    for (const token of sa) {
        if (sb.has(token)) intersection += 1;
    }
    const union = new Set([...sa, ...sb]).size || 1;
    return intersection / union;
}

function clamp01(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    if (n <= 0) return 0;
    if (n >= 1) return 1;
    return n;
}

app.post('/api/knowledge/eval/run', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const query_id = crypto.randomUUID();
    const started = Date.now();
    const start_ts = nowIso();
    const query = String(req.body?.query || '').trim();
    const expectedAnswer = String(req.body?.expected_answer || '').trim();
    const retrievalMode = String(req.body?.retrieval_mode || 'hybrid').trim().toLowerCase() || 'hybrid';
    const inhouseModelUuid = String(req.body?.inhouse_model_uuid || '').trim();
    const externalModelUuid = String(req.body?.external_model_uuid || '').trim();
    const configVersion = firstNonEmptyString(req.body?.config_version) || `${retrievalMode}:${inhouseModelUuid || 'auto'}->${externalModelUuid || 'auto'}`;
    const weights = normalizeEvalWeights(req.body?.weights || {});
    if (!query) return res.status(400).json({ error: 'missing_query' });
    try {
        const retrieval = await runKnowledgeRetrieval({ query, limit: 12, mode: retrievalMode, trace_id, span_id });
        const [inhouse, external] = await Promise.all([
            synthesizeKnowledgeAnswer({ query, retrieval, trace_id, model_uuid: inhouseModelUuid }),
            synthesizeKnowledgeAnswer({ query, retrieval, trace_id, model_uuid: externalModelUuid || inhouseModelUuid }),
        ]);
        const inhouseCorrectness = expectedAnswer ? jaccardScore(expectedAnswer, inhouse.answer) : 0;
        const externalCorrectness = expectedAnswer ? jaccardScore(expectedAnswer, external.answer) : 0;
        const grounding = clamp01((Array.isArray(retrieval.rows) ? retrieval.rows.length : 0) / 8);
        const inhouseCompleteness = clamp01(String(inhouse.answer || '').length / 900);
        const externalCompleteness = clamp01(String(external.answer || '').length / 900);
        const elapsedMs = Date.now() - started;
        const latencyScore = clamp01(1 - (elapsedMs / 12000));
        const inhouseScore =
            (weights.correctness * inhouseCorrectness)
            + (weights.grounding * grounding)
            + (weights.completeness * inhouseCompleteness)
            + (weights.latency * latencyScore);
        const externalScore =
            (weights.correctness * externalCorrectness)
            + (weights.grounding * grounding)
            + (weights.completeness * externalCompleteness)
            + (weights.latency * latencyScore);
        const winner = inhouseScore >= externalScore ? 'inhouse' : 'external';
        const scorecard = {
            weights,
            metrics: {
                correctness: {
                    inhouse: inhouseCorrectness,
                    external: externalCorrectness,
                },
                grounding: {
                    shared: grounding,
                },
                completeness: {
                    inhouse: inhouseCompleteness,
                    external: externalCompleteness,
                },
                latency: {
                    shared: latencyScore,
                    elapsed_ms: elapsedMs,
                },
            },
            totals: {
                inhouse: inhouseScore,
                external: externalScore,
                winner,
            },
        };
        const runRow = await pool.query(
            `INSERT INTO knowledge_eval_runs (
                query_text, expected_answer, retrieval_mode, inhouse_model_uuid, external_model_uuid,
                weights, scorecard, result, status, latency_ms
             ) VALUES ($1,$2,$3,$4::uuid,$5::uuid,$6::jsonb,$7::jsonb,$8::jsonb,'completed',$9)
             RETURNING id, created_at`,
            [
                query,
                expectedAnswer || null,
                retrievalMode,
                inhouseModelUuid || null,
                externalModelUuid || null,
                JSON.stringify(weights),
                JSON.stringify(scorecard),
                JSON.stringify({
                    query_id,
                    config_version: configVersion,
                    retrieval_mode: retrieval.mode,
                    diagnostics: retrieval.diagnostics || {},
                    inhouse,
                    external,
                }),
                elapsedMs,
            ]
        );
        const end_ts = nowIso();
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/knowledge/eval/run',
            start_ts,
            end_ts,
            latency_ms: elapsedMs,
            status: 200,
            metadata: {
                retrieval_mode: retrieval.mode,
                winner,
                inhouse_score: inhouseScore,
                external_score: externalScore,
                query_id,
                config_version: configVersion,
                candidate_count: retrieval.diagnostics?.candidate_count ?? 0,
                retrieved_nodes: Array.isArray(retrieval.rows) ? retrieval.rows.length : 0,
                top_k: parsePositiveInt(req.body?.top_k, 12),
                cache_hit: req.body?.cache_hit ?? null,
            },
        });
        return res.json({
            ok: true,
            run_id: runRow.rows?.[0]?.id || null,
            query_id,
            config_version: configVersion,
            created_at: runRow.rows?.[0]?.created_at || null,
            retrieval_mode: retrieval.mode,
            diagnostics: retrieval.diagnostics || {},
            inhouse,
            external,
            scorecard,
        });
    } catch (error) {
        const end_ts = nowIso();
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/knowledge/eval/run',
            start_ts,
            end_ts,
            latency_ms: Date.now() - started,
            status: 500,
            error: 'knowledge_eval_run_failed',
            metadata: { message: String(error?.message || error), query_id, config_version: configVersion },
        });
        res.setHeader('x-error', 'knowledge_eval_run_failed');
        return res.status(500).json({ error: 'knowledge_eval_run_failed', message: String(error?.message || error) });
    }
});

app.get('/api/knowledge/eval/runs', async (req, res) => {
    try {
        const limit = Math.max(1, Math.min(100, parsePositiveInt(req.query.limit, 25)));
        const rows = await pool.query(
            `SELECT id, query_text, expected_answer, retrieval_mode, inhouse_model_uuid, external_model_uuid, scorecard, status, latency_ms, created_at
             FROM knowledge_eval_runs
             ORDER BY created_at DESC
             LIMIT $1`,
            [limit]
        );
        return res.json({ ok: true, rows: rows.rows || [] });
    } catch (error) {
        res.setHeader('x-error', 'knowledge_eval_runs_fetch_failed');
        return res.status(500).json({ error: 'knowledge_eval_runs_fetch_failed', message: String(error?.message || error) });
    }
});

async function resolveKnowledgeLlamaindexConfig() {
    const settings = await getEngineSettings();
    const knowledge = resolveKnowledgeStorageSettings(settings.config || {});
    const url = String(knowledge.llamaindex_url || LLAMAINDEX_URL || '').trim().replace(/\/$/, '');
    const internalKey = String(knowledge.llamaindex_internal_key || LLAMAINDEX_INTERNAL_KEY || '').trim();
    return { url, internalKey };
}

function parseBlocklistCsv(raw) {
    return String(raw || '')
        .split(',')
        .map((item) => String(item || '').trim())
        .filter(Boolean);
}

function normalizeGuardrailsPayload(raw = {}) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const blocklistFromCsv = parseBlocklistCsv(source.blocklist_csv || source.blocklistCsv || '');
    const blocklistFromArray = Array.isArray(source.blocklist) ? source.blocklist.map((item) => String(item || '').trim()).filter(Boolean) : [];
    const blocklist = [...new Set([...blocklistFromCsv, ...blocklistFromArray])];
    const maxInputChars = parsePositiveInt(source.max_input_chars ?? source.maxInputChars, 0) || null;
    const maxOutputChars = parsePositiveInt(source.max_output_chars ?? source.maxOutputChars, 0) || null;
    const profileName = String(source.profile_name || source.profileName || '').trim();
    return {
        profile_name: profileName,
        max_input_chars: maxInputChars,
        max_output_chars: maxOutputChars,
        require_citations: source.require_citations === true || source.requireCitations === true,
        blocklist,
        blocklist_csv: blocklist.join(','),
    };
}

function mergeGuardrailsSettings(base = {}, override = {}) {
    const left = normalizeGuardrailsPayload(base);
    const right = normalizeGuardrailsPayload(override);
    return {
        profile_name: right.profile_name || left.profile_name || 'default',
        max_input_chars: right.max_input_chars || left.max_input_chars || null,
        max_output_chars: right.max_output_chars || left.max_output_chars || null,
        require_citations: right.require_citations === true || left.require_citations === true,
        blocklist: [...new Set([...(left.blocklist || []), ...(right.blocklist || [])])],
        blocklist_csv: [...new Set([...(left.blocklist || []), ...(right.blocklist || [])])].join(','),
    };
}

function hasCitationLikeMarker(text = '') {
    const value = String(text || '');
    return /\[[0-9]+\]/.test(value) || /\(source[:\s]/i.test(value) || /sources?:/i.test(value);
}

function evaluateGuardrailChecks({ guardrails = {}, input_text = '', output_text = '' }) {
    const cfg = normalizeGuardrailsPayload(guardrails);
    const checks = [];
    const input = String(input_text || '');
    const output = String(output_text || '');
    if (cfg.max_input_chars) {
        checks.push({
            id: 'max_input_chars',
            ok: input.length <= cfg.max_input_chars,
            detail: `input_chars=${input.length}, limit=${cfg.max_input_chars}`,
        });
    }
    if (cfg.max_output_chars && output) {
        checks.push({
            id: 'max_output_chars',
            ok: output.length <= cfg.max_output_chars,
            detail: `output_chars=${output.length}, limit=${cfg.max_output_chars}`,
        });
    }
    if (cfg.blocklist.length > 0) {
        const haystack = `${input}\n${output}`.toLowerCase();
        const hits = cfg.blocklist.filter((entry) => haystack.includes(String(entry || '').toLowerCase())).slice(0, 20);
        checks.push({
            id: 'blocklist',
            ok: hits.length === 0,
            detail: hits.length > 0 ? `blocked_terms=${hits.join(', ')}` : 'no_blocked_terms',
        });
    }
    if (cfg.require_citations && output) {
        checks.push({
            id: 'require_citations',
            ok: hasCitationLikeMarker(output),
            detail: hasCitationLikeMarker(output) ? 'citation_marker_present' : 'citation_marker_missing',
        });
    }
    return {
        guardrails: cfg,
        checks,
        passed: checks.every((item) => item.ok),
    };
}

async function resolveEffectivePolicy({ endpoint = '*', agent_id = 'default', tool_id = 'none' }) {
    const guardrailDefaults = {
        profile_name: 'default',
        max_input_chars: null,
        max_output_chars: null,
        blocklist_csv: '',
    };
    const profileRows = await pool.query(
        `SELECT name, max_input_chars, max_output_chars, blocklist_csv, updated_at
         FROM guardrail_profiles
         WHERE name = COALESCE((SELECT profile_name FROM agent_guardrail_bindings WHERE agent_id = $1), 'default')
         LIMIT 1`,
        [agent_id]
    );
    const baseProfile = profileRows.rowCount > 0 ? profileRows.rows[0] : guardrailDefaults;
    const toolOverride = await pool.query(
        `SELECT profile_name, max_input_chars, max_output_chars, blocklist_csv, updated_at
         FROM tool_guardrail_overrides
         WHERE agent_id = $1 AND tool_id = $2
         LIMIT 1`,
        [agent_id, tool_id]
    );
    let guardrails = { ...baseProfile };
    if (toolOverride.rowCount > 0) {
        const override = toolOverride.rows[0];
        if (override.profile_name) {
            const profile = await pool.query(
                `SELECT name, max_input_chars, max_output_chars, blocklist_csv
                 FROM guardrail_profiles WHERE name = $1 LIMIT 1`,
                [override.profile_name]
            );
            if (profile.rowCount > 0) guardrails = { ...guardrails, ...profile.rows[0] };
        }
        if (override.max_input_chars !== null) guardrails.max_input_chars = override.max_input_chars;
        if (override.max_output_chars !== null) guardrails.max_output_chars = override.max_output_chars;
        if (override.blocklist_csv !== null && override.blocklist_csv !== undefined) guardrails.blocklist_csv = override.blocklist_csv;
    }

    const cacheRows = await pool.query(
        `SELECT endpoint, agent_id, tool_id, cache_ttl_sec, provider, model, updated_at
         FROM cache_policies
         WHERE (endpoint = '*' OR endpoint = $1)
           AND (agent_id = '*' OR agent_id = $2)
           AND (tool_id = '*' OR tool_id = $3)
         ORDER BY
           CASE WHEN endpoint = '*' THEN 0 ELSE 1 END,
           CASE WHEN agent_id = '*' THEN 0 ELSE 1 END,
           CASE WHEN tool_id = '*' THEN 0 ELSE 1 END
         LIMIT 1`,
        [endpoint, agent_id, tool_id]
    );
    const cache_policy = cacheRows.rowCount > 0 ? cacheRows.rows[0] : null;
    return {
        endpoint,
        agent_id,
        tool_id,
        guardrails: {
            profile_name: String(guardrails.name || guardrails.profile_name || 'default'),
            max_input_chars: guardrails.max_input_chars,
            max_output_chars: guardrails.max_output_chars,
            blocklist: parseBlocklistCsv(guardrails.blocklist_csv),
        },
        cache_policy,
    };
}

app.get('/api/policies/guardrails/profiles', async (_req, res) => {
    try {
        const rows = await pool.query(
            `SELECT name, max_input_chars, max_output_chars, blocklist_csv, updated_at
             FROM guardrail_profiles
             ORDER BY name ASC`
        );
        return res.json({ ok: true, items: rows.rows || [] });
    } catch (error) {
        res.setHeader('x-error', 'guardrail_profiles_fetch_failed');
        return res.status(500).json({ error: 'guardrail_profiles_fetch_failed', message: String(error?.message || error) });
    }
});

app.post('/api/policies/guardrails/profiles', async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const maxInput = parsePositiveInt(req.body?.max_input_chars, 0);
    const maxOutput = parsePositiveInt(req.body?.max_output_chars, 0);
    const blocklistCsv = String(req.body?.blocklist_csv || '').trim();
    if (!name || !maxInput || !maxOutput) {
        return res.status(400).json({ error: 'invalid_guardrail_profile_payload' });
    }
    try {
        await pool.query(
            `INSERT INTO guardrail_profiles (name, max_input_chars, max_output_chars, blocklist_csv, updated_at)
             VALUES ($1,$2,$3,$4, now())
             ON CONFLICT (name) DO UPDATE SET
               max_input_chars = EXCLUDED.max_input_chars,
               max_output_chars = EXCLUDED.max_output_chars,
               blocklist_csv = EXCLUDED.blocklist_csv,
               updated_at = now()`,
            [name, maxInput, maxOutput, blocklistCsv]
        );
        return res.json({ ok: true });
    } catch (error) {
        res.setHeader('x-error', 'guardrail_profile_upsert_failed');
        return res.status(500).json({ error: 'guardrail_profile_upsert_failed', message: String(error?.message || error) });
    }
});

app.post('/api/policies/guardrails/agents', async (req, res) => {
    const agentId = String(req.body?.agent_id || '').trim();
    const profileName = String(req.body?.profile_name || '').trim();
    if (!agentId || !profileName) return res.status(400).json({ error: 'invalid_agent_guardrail_binding_payload' });
    try {
        await pool.query(
            `INSERT INTO agent_guardrail_bindings (agent_id, profile_name, updated_at)
             VALUES ($1,$2, now())
             ON CONFLICT (agent_id) DO UPDATE SET
               profile_name = EXCLUDED.profile_name,
               updated_at = now()`,
            [agentId, profileName]
        );
        return res.json({ ok: true });
    } catch (error) {
        res.setHeader('x-error', 'agent_guardrail_binding_upsert_failed');
        return res.status(500).json({ error: 'agent_guardrail_binding_upsert_failed', message: String(error?.message || error) });
    }
});

app.post('/api/policies/guardrails/tools', async (req, res) => {
    const agentId = String(req.body?.agent_id || '').trim();
    const toolId = String(req.body?.tool_id || '').trim();
    if (!agentId || !toolId) return res.status(400).json({ error: 'invalid_tool_guardrail_override_payload' });
    const profileName = req.body?.profile_name ? String(req.body?.profile_name).trim() : null;
    const maxInput = req.body?.max_input_chars !== undefined ? parsePositiveInt(req.body?.max_input_chars, 0) : null;
    const maxOutput = req.body?.max_output_chars !== undefined ? parsePositiveInt(req.body?.max_output_chars, 0) : null;
    const blocklistCsv = req.body?.blocklist_csv !== undefined ? String(req.body?.blocklist_csv || '').trim() : null;
    try {
        await pool.query(
            `INSERT INTO tool_guardrail_overrides (agent_id, tool_id, profile_name, max_input_chars, max_output_chars, blocklist_csv, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6, now())
             ON CONFLICT (agent_id, tool_id) DO UPDATE SET
               profile_name = EXCLUDED.profile_name,
               max_input_chars = EXCLUDED.max_input_chars,
               max_output_chars = EXCLUDED.max_output_chars,
               blocklist_csv = EXCLUDED.blocklist_csv,
               updated_at = now()`,
            [agentId, toolId, profileName, maxInput || null, maxOutput || null, blocklistCsv]
        );
        return res.json({ ok: true });
    } catch (error) {
        res.setHeader('x-error', 'tool_guardrail_override_upsert_failed');
        return res.status(500).json({ error: 'tool_guardrail_override_upsert_failed', message: String(error?.message || error) });
    }
});

app.post('/api/policies/cache', async (req, res) => {
    const endpoint = String(req.body?.endpoint || '*').trim();
    const agentId = String(req.body?.agent_id || '*').trim();
    const toolId = String(req.body?.tool_id || '*').trim();
    if (!endpoint || !agentId || !toolId) return res.status(400).json({ error: 'invalid_cache_policy_payload' });
    const cacheTtlSec = req.body?.cache_ttl_sec !== undefined ? parsePositiveInt(req.body?.cache_ttl_sec, 0) : null;
    const provider = req.body?.provider ? String(req.body?.provider).trim() : null;
    const model = req.body?.model ? String(req.body?.model).trim() : null;
    try {
        await pool.query(
            `INSERT INTO cache_policies (endpoint, agent_id, tool_id, cache_ttl_sec, provider, model, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6, now())
             ON CONFLICT (endpoint, agent_id, tool_id) DO UPDATE SET
               cache_ttl_sec = EXCLUDED.cache_ttl_sec,
               provider = EXCLUDED.provider,
               model = EXCLUDED.model,
               updated_at = now()`,
            [endpoint, agentId, toolId, cacheTtlSec || null, provider, model]
        );
        return res.json({ ok: true });
    } catch (error) {
        res.setHeader('x-error', 'cache_policy_upsert_failed');
        return res.status(500).json({ error: 'cache_policy_upsert_failed', message: String(error?.message || error) });
    }
});

app.get('/api/policies/resolve', async (req, res) => {
    const endpoint = String(req.query.endpoint || '*').trim();
    const agent_id = String(req.query.agent_id || 'default').trim();
    const tool_id = String(req.query.tool_id || 'none').trim();
    try {
        const runtime = await resolveEffectivePolicy({ endpoint, agent_id, tool_id });
        return res.json({ ok: true, runtime });
    } catch (error) {
        res.setHeader('x-error', 'policy_resolve_failed');
        return res.status(500).json({ error: 'policy_resolve_failed', message: String(error?.message || error) });
    }
});

app.post('/api/policies/guardrails/test', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const startedAt = Date.now();
    const start_ts = nowIso();
    const agentId = String(req.body?.agent_id || '').trim();
    const modelUuid = String(req.body?.model_uuid || '').trim();
    const inputText = firstNonEmptyString(req.body?.input_text, req.body?.prompt, req.body?.input, '');
    const candidateOutput = firstNonEmptyString(req.body?.candidate_output, req.body?.output, '');
    const overrideGuardrails = req.body?.guardrails && typeof req.body.guardrails === 'object' ? req.body.guardrails : {};
    try {
        let agentSystemPrompt = '';
        let runtimeGuardrails = {};
        if (agentId) {
            const joined = await pool.query(
                `SELECT a.system_prompt, arc.controls
                 FROM agents a
                 LEFT JOIN agent_runtime_controls arc ON arc.agent_id = a.id
                 WHERE a.id = $1
                 LIMIT 1`,
                [agentId]
            );
            if (joined.rowCount === 0) return res.status(404).json({ error: 'agent_not_found' });
            agentSystemPrompt = String(joined.rows[0]?.system_prompt || '').trim();
            const controls = joined.rows[0]?.controls && typeof joined.rows[0].controls === 'object' ? joined.rows[0].controls : {};
            runtimeGuardrails = controls.guardrails && typeof controls.guardrails === 'object'
                ? controls.guardrails
                : {
                    max_input_chars: controls.max_input_chars || null,
                    max_output_chars: controls.max_output_chars || null,
                    require_citations: controls.require_citations === true,
                };
            const legacy = await resolveEffectivePolicy({
                endpoint: '/v1/chat/completions',
                agent_id: agentId,
                tool_id: 'strategy',
            }).catch(() => null);
            if (legacy?.guardrails && typeof legacy.guardrails === 'object') {
                runtimeGuardrails = mergeGuardrailsSettings(runtimeGuardrails, legacy.guardrails);
            }
        }
        const mergedGuardrails = mergeGuardrailsSettings(runtimeGuardrails, overrideGuardrails);
        let evaluatedOutput = String(candidateOutput || '');
        let llmMeta = null;
        if (!evaluatedOutput.trim() && modelUuid && String(inputText || '').trim()) {
            const llm = await loadDashboardLlmConfig(modelUuid);
            if (!llm) return res.status(400).json({ error: 'selected_model_not_configured' });
            const guardrailSystemNote = [
                `Guardrails profile: ${mergedGuardrails.profile_name}`,
                mergedGuardrails.max_input_chars ? `Max input chars: ${mergedGuardrails.max_input_chars}` : null,
                mergedGuardrails.max_output_chars ? `Max output chars: ${mergedGuardrails.max_output_chars}` : null,
                mergedGuardrails.require_citations ? 'Citations required in answer.' : null,
                mergedGuardrails.blocklist.length > 0 ? `Do not output blocked terms: ${mergedGuardrails.blocklist.join(', ')}` : null,
            ].filter(Boolean).join('\n');
            const llmResult = await callConfiguredLlm({
                llm,
                trace_id,
                route: 'POST /internal/guardrails/test',
                body: {
                    model: llm.model_id,
                    temperature: 0.1,
                    max_tokens: mergedGuardrails.max_output_chars
                        ? Math.max(120, Math.min(1200, Math.ceil(mergedGuardrails.max_output_chars / 4)))
                        : 500,
                    messages: [
                        {
                            role: 'system',
                            content: [agentSystemPrompt, guardrailSystemNote].filter(Boolean).join('\n\n') || 'Respond safely and concisely.',
                        },
                        { role: 'user', content: String(inputText || '').trim() },
                    ],
                },
            });
            if (!llmResult.ok) {
                return res.status(502).json({
                    error: 'guardrail_test_llm_call_failed',
                    message: llmResult.message || 'Upstream model call failed.',
                });
            }
            const text = String(extractLlmTextFromUpstreamBody(llmResult.upstream_body || {}) || '').trim();
            evaluatedOutput = text;
            llmMeta = {
                model_uuid: modelUuid,
                model_id: String(llm.model_id || ''),
                provider: String(llm.provider_slug || ''),
            };
        }
        const result = evaluateGuardrailChecks({
            guardrails: mergedGuardrails,
            input_text: String(inputText || ''),
            output_text: evaluatedOutput,
        });
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/policies/guardrails/test',
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - startedAt,
            status: 200,
            metadata: {
                agent_id: agentId || null,
                model_uuid: modelUuid || null,
                checks: result.checks,
                passed: result.passed,
            },
        });
        return res.json({
            ok: true,
            trace_id,
            guardrails: result.guardrails,
            checks: result.checks,
            passed: result.passed,
            generated_output: evaluatedOutput || null,
            llm: llmMeta,
        });
    } catch (error) {
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/policies/guardrails/test',
            start_ts,
            end_ts: nowIso(),
            latency_ms: Date.now() - startedAt,
            status: 500,
            error: 'guardrail_test_failed',
            metadata: { message: String(error?.message || error), agent_id: agentId || null },
        });
        res.setHeader('x-error', 'guardrail_test_failed');
        return res.status(500).json({ error: 'guardrail_test_failed', message: String(error?.message || error) });
    }
});

app.post('/api/strategy/run', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const prompt = String(req.body?.query || req.body?.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'missing_query' });
    try {
        const { url, internalKey } = await resolveKnowledgeLlamaindexConfig();
        if (!url) return res.status(503).json({ error: 'llamaindex_not_configured' });
        const headers = { 'content-type': 'application/json', 'x-trace-id': trace_id };
        if (internalKey) headers['x-internal-key'] = internalKey;
        const upstream = await fetch(`${url}/strategy/run`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                query: prompt,
                metadata: req.body?.metadata || {},
                include_board_pack: req.body?.include_board_pack !== false,
                resume_run_id: req.body?.resume_run_id || null,
            }),
            signal: AbortSignal.timeout(120000),
        });
        const payload = await upstream.json().catch(() => ({}));
        return res.status(upstream.status).json(payload);
    } catch (error) {
        res.setHeader('x-error', 'strategy_run_failed');
        return res.status(500).json({ error: 'strategy_run_failed', message: String(error?.message || error) });
    }
});

app.get('/api/strategy/run/:runId', async (req, res) => {
    const runId = String(req.params.runId || '').trim();
    if (!runId) return res.status(400).json({ error: 'missing_run_id' });
    try {
        const { url, internalKey } = await resolveKnowledgeLlamaindexConfig();
        if (!url) return res.status(503).json({ error: 'llamaindex_not_configured' });
        const headers = { 'x-trace-id': req.trace_id ?? parseTraceId(req.headers['x-trace-id']) };
        if (internalKey) headers['x-internal-key'] = internalKey;
        const upstream = await fetch(`${url}/strategy/run/${encodeURIComponent(runId)}`, {
            method: 'GET',
            headers,
            signal: AbortSignal.timeout(30000),
        });
        const payload = await upstream.json().catch(() => ({}));
        return res.status(upstream.status).json(payload);
    } catch (error) {
        res.setHeader('x-error', 'strategy_run_fetch_failed');
        return res.status(500).json({ error: 'strategy_run_fetch_failed', message: String(error?.message || error) });
    }
});

app.get('/api/strategy/run/:runId/events', async (req, res) => {
    const runId = String(req.params.runId || '').trim();
    if (!runId) return res.status(400).json({ error: 'missing_run_id' });
    try {
        const { url, internalKey } = await resolveKnowledgeLlamaindexConfig();
        if (!url) return res.status(503).json({ error: 'llamaindex_not_configured' });
        const headers = { 'x-trace-id': req.trace_id ?? parseTraceId(req.headers['x-trace-id']), accept: 'text/event-stream' };
        if (internalKey) headers['x-internal-key'] = internalKey;
        const upstream = await fetch(`${url}/strategy/run/${encodeURIComponent(runId)}/events`, {
            method: 'GET',
            headers,
            signal: AbortSignal.timeout(70000),
        });
        if (!upstream.ok || !upstream.body) {
            const text = await upstream.text().catch(() => '');
            return res.status(upstream.status || 502).json({ error: 'strategy_events_upstream_failed', detail: text });
        }
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(decoder.decode(value, { stream: true }));
        }
        res.end();
    } catch (error) {
        if (!res.headersSent) {
            res.setHeader('x-error', 'strategy_events_stream_failed');
            return res.status(500).json({ error: 'strategy_events_stream_failed', message: String(error?.message || error) });
        }
        res.end();
    }
});

// Agents registry: used by dashboard /agents page
app.get('/api/agents', async (_req, res) => {
    try {
        const r = await pool.query(`
       SELECT a.id, a.name, a.voice_id, a.system_prompt, a.tools, a.model_uuid, a.endpoint_key, a.created_at,
              m.label AS model_label, m.model_id AS model_name,
              p.name AS provider_name, p.slug AS provider_slug
       FROM agents a
       LEFT JOIN llm_registry m ON m.id = a.model_uuid AND m.record_type = 'model'
       LEFT JOIN llm_registry p ON p.id = m.provider_id AND p.record_type = 'provider'
       ORDER BY created_at DESC
     `);
        res.json((r.rows || []).map((row) => {
            const { provider_name: _provider_name, provider_slug: _provider_slug, ...rest } = row || {};
            return {
                ...rest,
                model_name: row.model_label || row.model_name || null,
            };
        }));
    }
    catch (e) {
        console.error(JSON.stringify({
            level: 'error',
            service: 'control-plane-api',
            route: 'GET /api/agents',
            error: String(e?.message || e),
        }));
        res.setHeader('x-error', 'agents_fetch_failed');
        res.status(500).json({ error: 'agents_fetch_failed' });
    }
});

app.get('/api/agents/:id', async (req, res) => {
    const agentId = String(req.params.id || '').trim();
    if (!agentId) return res.status(400).json({ error: 'missing_agent_id' });
    try {
        const agentRow = await pool.query(
            `SELECT a.id, a.name, a.voice_id, a.system_prompt, a.tools, a.model_uuid, a.endpoint_key, a.created_at,
              m.label AS model_label, m.model_id AS model_name, m.provider_id,
              p.name AS provider_name, p.slug AS provider_slug
       FROM agents a
       LEFT JOIN llm_registry m ON m.id = a.model_uuid AND m.record_type = 'model'
       LEFT JOIN llm_registry p ON p.id = m.provider_id AND p.record_type = 'provider'
       WHERE a.id = $1`,
            [agentId]
        );
        if (agentRow.rowCount === 0) return res.status(404).json({ error: 'agent_not_found' });
        const controlsRow = await pool.query(
            `SELECT controls, style_overlay, updated_at
       FROM agent_runtime_controls
       WHERE agent_id = $1`,
            [agentId]
        );
        const injectionsRow = await pool.query(
            `SELECT id, trigger_type, mode, payload, priority, one_shot, active, expires_at, created_at
       FROM agent_injections
       WHERE agent_id = $1
       ORDER BY priority ASC, created_at DESC
       LIMIT 200`,
            [agentId]
        );
        return res.json({
            ...agentRow.rows[0],
            model_name: agentRow.rows[0]?.model_label || agentRow.rows[0]?.model_name || null,
            provider_name: undefined,
            provider_slug: undefined,
            runtime_controls: controlsRow.rowCount > 0 ? controlsRow.rows[0] : { controls: {}, style_overlay: {}, updated_at: null },
            injections: injectionsRow.rows,
        });
    }
    catch {
        res.setHeader('x-error', 'agent_fetch_failed');
        return res.status(500).json({ error: 'agent_fetch_failed' });
    }
});

app.post('/api/agents', async (req, res) => {
    const { id, name, voice_id, system_prompt, tools, model_uuid } = req.body || {};
    if (!name) {
        res.setHeader('x-error', 'missing_name');
        return res.status(400).json({ error: 'missing_name' });
    }
    const agentId = normalizeAgentUuid(id ? String(id) : '');
    const toolsArray = Array.isArray(tools) ? tools : (tools ? [tools] : []);
    try {
        const r = await pool.query(`
       INSERT INTO agents (id, name, voice_id, system_prompt, tools, model_uuid)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::uuid)
       ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name,
           voice_id = EXCLUDED.voice_id,
           system_prompt = EXCLUDED.system_prompt,
           tools = EXCLUDED.tools,
           model_uuid = EXCLUDED.model_uuid
       RETURNING id, name, voice_id, system_prompt, tools, model_uuid, endpoint_key, created_at
     `, [
            agentId,
            String(name),
            voice_id ? String(voice_id) : null,
            system_prompt ? String(system_prompt) : null,
            JSON.stringify(toolsArray),
            model_uuid ? String(model_uuid) : null,
        ]);
        res.status(201).json(r.rows[0]);
    }
    catch (e) {
        res.setHeader('x-error', 'agents_upsert_failed');
        res.status(500).json({ error: 'agents_upsert_failed' });
    }
});

app.patch('/api/agents/:id', async (req, res) => {
    const agentId = String(req.params.id || '').trim();
    if (!agentId) return res.status(400).json({ error: 'missing_agent_id' });
    const updates = [];
    const values = [];
    let i = 1;
    const setIf = (field, value) => {
        updates.push(`${field} = $${i++}`);
        values.push(value);
    };
    if (req.body?.name !== undefined) setIf('name', String(req.body.name || '').trim());
    if (req.body?.voice_id !== undefined) setIf('voice_id', req.body.voice_id ? String(req.body.voice_id) : null);
    if (req.body?.system_prompt !== undefined) setIf('system_prompt', req.body.system_prompt ? String(req.body.system_prompt) : null);
    if (req.body?.tools !== undefined) {
        const tools = Array.isArray(req.body.tools) ? req.body.tools : (req.body.tools ? [req.body.tools] : []);
        setIf('tools', JSON.stringify(tools));
        updates[updates.length - 1] += '::jsonb';
    }
    if (req.body?.model_uuid !== undefined) setIf('model_uuid', req.body.model_uuid ? String(req.body.model_uuid) : null);
    if (updates.length === 0) return res.status(400).json({ error: 'no_updates' });
    values.push(agentId);
    try {
        const r = await pool.query(
            `UPDATE agents
       SET ${updates.join(', ')}
       WHERE id = $${i}
       RETURNING id, name, voice_id, system_prompt, tools, model_uuid, endpoint_key, created_at`,
            values
        );
        if (r.rowCount === 0) return res.status(404).json({ error: 'agent_not_found' });
        res.json(r.rows[0]);
    }
    catch {
        res.setHeader('x-error', 'agent_patch_failed');
        res.status(500).json({ error: 'agent_patch_failed' });
    }
});

// Bulk import subagents: body = { agents: Array<{ id?, name, voice_id?, system_prompt?, tools? }> }
app.post('/api/agents/import', async (req, res) => {
    const payload = req.body || {};
    const raw = payload.agents;
    if (!Array.isArray(raw) || raw.length === 0) {
        res.setHeader('x-error', 'invalid_body');
        return res.status(400).json({ error: "Body must include 'agents' array with at least one agent." });
    }
    const client = await pool.connect();
    const imported = [];
    try {
        await client.query('BEGIN');
        for (let i = 0; i < raw.length; i++) {
            const a = raw[i] || {};
            const id = normalizeAgentUuid(a.id ? String(a.id) : '');
            const name = a.name ? String(a.name) : 'Unnamed';
            const voice_id = a.voice_id ? String(a.voice_id) : null;
            const system_prompt = a.system_prompt ? String(a.system_prompt) : null;
            const model_uuid = a.model_uuid ? String(a.model_uuid) : null;
            const tools = Array.isArray(a.tools) ? a.tools : (a.tools ? [a.tools] : []);
            await client.query(`
         INSERT INTO agents (id, name, voice_id, system_prompt, tools, model_uuid)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::uuid)
         ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name,
             voice_id = EXCLUDED.voice_id,
             system_prompt = EXCLUDED.system_prompt,
             tools = EXCLUDED.tools,
             model_uuid = EXCLUDED.model_uuid
       `, [id, name, voice_id, system_prompt, JSON.stringify(tools), model_uuid]);
            imported.push(id);
        }
        await client.query('COMMIT');
        res.json({ ok: true, imported });
    }
    catch (e) {
        await client.query('ROLLBACK');
        res.setHeader('x-error', 'agents_import_failed');
        res.status(500).json({ error: 'agents_import_failed' });
    }
    finally {
        client.release();
    }
});

app.get('/api/agents/:id/runtime-controls', async (req, res) => {
    const agentId = String(req.params.id || '').trim();
    if (!agentId) return res.status(400).json({ error: 'missing_agent_id' });
    try {
        const row = await pool.query(
            `SELECT agent_id, controls, style_overlay, updated_at
       FROM agent_runtime_controls
       WHERE agent_id = $1`,
            [agentId]
        );
        if (row.rowCount === 0) {
            return res.json({ agent_id: agentId, controls: {}, style_overlay: {}, updated_at: null });
        }
        return res.json(row.rows[0]);
    }
    catch {
        res.setHeader('x-error', 'agent_runtime_controls_fetch_failed');
        return res.status(500).json({ error: 'agent_runtime_controls_fetch_failed' });
    }
});

app.patch('/api/agents/:id/runtime-controls', async (req, res) => {
    const agentId = String(req.params.id || '').trim();
    if (!agentId) return res.status(400).json({ error: 'missing_agent_id' });
    const controls = req.body?.controls && typeof req.body.controls === 'object' ? req.body.controls : {};
    const styleOverlay = req.body?.style_overlay && typeof req.body.style_overlay === 'object' ? req.body.style_overlay : {};
    try {
        const agent = await pool.query(`SELECT id FROM agents WHERE id = $1`, [agentId]);
        if (agent.rowCount === 0) return res.status(404).json({ error: 'agent_not_found' });
        const row = await pool.query(
            `INSERT INTO agent_runtime_controls (agent_id, controls, style_overlay, updated_at)
       VALUES ($1,$2::jsonb,$3::jsonb, now())
       ON CONFLICT (agent_id) DO UPDATE
       SET controls = EXCLUDED.controls,
           style_overlay = EXCLUDED.style_overlay,
           updated_at = now()
       RETURNING agent_id, controls, style_overlay, updated_at`,
            [agentId, JSON.stringify(controls), JSON.stringify(styleOverlay)]
        );
        res.json(row.rows[0]);
    }
    catch {
        res.setHeader('x-error', 'agent_runtime_controls_upsert_failed');
        res.status(500).json({ error: 'agent_runtime_controls_upsert_failed' });
    }
});

app.get('/api/agents/:id/injections', async (req, res) => {
    const agentId = String(req.params.id || '').trim();
    if (!agentId) return res.status(400).json({ error: 'missing_agent_id' });
    const activeOnly = String(req.query.active || 'true').toLowerCase() !== 'false';
    try {
        const rows = await pool.query(
            `SELECT id, agent_id, trigger_type, mode, payload, priority, one_shot, active, expires_at, created_at
       FROM agent_injections
       WHERE agent_id = $1
         AND ($2::boolean = false OR active = true)
       ORDER BY priority ASC, created_at DESC
       LIMIT 200`,
            [agentId, activeOnly]
        );
        res.json(rows.rows);
    }
    catch {
        res.setHeader('x-error', 'agent_injections_fetch_failed');
        res.status(500).json({ error: 'agent_injections_fetch_failed' });
    }
});

app.post('/api/agents/:id/injections', async (req, res) => {
    const agentId = String(req.params.id || '').trim();
    if (!agentId) return res.status(400).json({ error: 'missing_agent_id' });
    const payload = String(req.body?.payload || '').trim();
    if (!payload) return res.status(400).json({ error: 'missing_payload' });
    const triggerType = String(req.body?.trigger_type || 'next_turn');
    const mode = String(req.body?.mode || 'prepend');
    const priority = parsePositiveInt(req.body?.priority, 100);
    const oneShot = req.body?.one_shot !== false;
    const expiresAt = req.body?.expires_at ? new Date(req.body.expires_at) : null;
    try {
        const agent = await pool.query(`SELECT id FROM agents WHERE id = $1`, [agentId]);
        if (agent.rowCount === 0) return res.status(404).json({ error: 'agent_not_found' });
        const row = await pool.query(
            `INSERT INTO agent_injections (agent_id, trigger_type, mode, payload, priority, one_shot, active, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,true,$7)
       RETURNING id, agent_id, trigger_type, mode, payload, priority, one_shot, active, expires_at, created_at`,
            [agentId, triggerType, mode, payload, priority, oneShot, expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt.toISOString() : null]
        );
        res.status(201).json(row.rows[0]);
    }
    catch {
        res.setHeader('x-error', 'agent_injections_create_failed');
        res.status(500).json({ error: 'agent_injections_create_failed' });
    }
});

app.post('/api/agents/:id/injections/:injId/disable', async (req, res) => {
    const agentId = String(req.params.id || '').trim();
    const injId = String(req.params.injId || '').trim();
    if (!agentId || !injId) return res.status(400).json({ error: 'missing_fields' });
    try {
        const r = await pool.query(
            `UPDATE agent_injections
       SET active = false
       WHERE id = $1 AND agent_id = $2
       RETURNING id, agent_id, active`,
            [injId, agentId]
        );
        if (r.rowCount === 0) return res.status(404).json({ error: 'injection_not_found' });
        res.json(r.rows[0]);
    }
    catch {
        res.setHeader('x-error', 'agent_injections_disable_failed');
        res.status(500).json({ error: 'agent_injections_disable_failed' });
    }
});

app.get('/api/llm/logs', async (req, res) => {
    const limit = parsePositiveInt(req.query.limit, 200);
    const agentId = String(req.query.agent_id || '').trim();
    try {
        const q = await pool.query(
            `SELECT id, trace_id, span_id, agent_id, session_id, level, event, detail, created_at
       FROM llm_debug_logs
       WHERE ($1::text = '' OR agent_id = $1)
       ORDER BY created_at DESC
       LIMIT $2`,
            [agentId, limit]
        );
        res.json(q.rows);
    }
    catch {
        res.setHeader('x-error', 'llm_logs_fetch_failed');
        res.status(500).json({ error: 'llm_logs_fetch_failed' });
    }
});

app.get('/api/logs/services', async (_req, res) => {
    res.json({
        services: DOCKERED_SERVICE_KEYS.map((key) => ({
            key,
            label: key,
            request_log_services: REQUEST_LOG_SERVICE_BY_DOCKER_KEY[key] || [],
            has_llm_logs: key === 'control-plane-api',
        })),
    });
});

app.get('/api/logs/stream', async (req, res) => {
    const limit = parsePositiveInt(req.query.limit, 400);
    const serviceKey = String(req.query.service_key || 'all').trim();
    const routeContains = String(req.query.route_contains || '').trim();
    const source = String(req.query.source || 'all').trim().toLowerCase();
    const severity = String(req.query.severity || 'all').trim().toLowerCase();
    const includeRequest = source === 'all' || source === 'request';
    const includeLlm = source === 'all' || source === 'llm';
    const serviceFilters = serviceKey === 'all'
        ? []
        : (REQUEST_LOG_SERVICE_BY_DOCKER_KEY[serviceKey] || []);
    try {
        const rows = [];
        if (includeRequest) {
            const requestLimit = includeLlm ? Math.ceil(limit * 0.75) : limit;
            const requestQuery = serviceFilters.length > 0
                ? await pool.query(`
            SELECT trace_id::text,
                   span_id::text,
                   service,
                   route,
                   start_ts::text,
                   end_ts::text,
                   latency_ms,
                   status,
                   error,
                   COALESCE(NULLIF(severity, ''), 'info') AS severity,
                   metadata,
                   'request'::text AS log_source
            FROM request_logs
            WHERE service = ANY($1::text[])
              AND ($2::text = '' OR route ILIKE '%' || $2 || '%')
              AND ($3::text = 'all' OR COALESCE(NULLIF(severity, ''), 'info') = $3)
            ORDER BY start_ts DESC
            LIMIT $4
          `, [serviceFilters, routeContains, severity, requestLimit])
                : await pool.query(`
            SELECT trace_id::text,
                   span_id::text,
                   service,
                   route,
                   start_ts::text,
                   end_ts::text,
                   latency_ms,
                   status,
                   error,
                   COALESCE(NULLIF(severity, ''), 'info') AS severity,
                   metadata,
                   'request'::text AS log_source
            FROM request_logs
            WHERE ($1::text = '' OR route ILIKE '%' || $1 || '%')
              AND ($2::text = 'all' OR COALESCE(NULLIF(severity, ''), 'info') = $2)
            ORDER BY start_ts DESC
            LIMIT $3
          `, [routeContains, severity, requestLimit]);
            rows.push(...requestQuery.rows);
        }
        if (includeLlm && (serviceKey === 'all' || serviceKey === 'control-plane-api')) {
            const llmLimit = includeRequest ? Math.max(50, Math.floor(limit * 0.4)) : limit;
            const llmQuery = await pool.query(`
          SELECT trace_id::text,
                 span_id::text,
                 'control-plane-api'::text AS service,
                 ('LLM ' || event)::text AS route,
                 created_at::text AS start_ts,
                 created_at::text AS end_ts,
                 0::integer AS latency_ms,
                 CASE WHEN level ILIKE 'error' THEN 500 ELSE 200 END AS status,
                 CASE WHEN level ILIKE 'error' THEN LEFT(COALESCE(detail::text, ''), 600) ELSE NULL END AS error,
                 CASE
                   WHEN level ILIKE 'error' AND (
                     event ILIKE '%knowledge%'
                     OR event ILIKE '%orchestrator%'
                     OR detail::text ILIKE '%knowledge%'
                     OR detail::text ILIKE '%orchestrator%'
                   ) THEN 'critical'
                   WHEN level ILIKE 'error' THEN 'error'
                   ELSE 'info'
                 END AS severity,
                 jsonb_build_object(
                   'source', 'llm_debug_logs',
                   'level', level,
                   'event', event,
                   'agent_id', agent_id,
                   'session_id', session_id,
                   'detail', detail
                 ) AS metadata,
                 'llm'::text AS log_source
          FROM llm_debug_logs
          WHERE (
            $2::text = 'all'
            OR (
              CASE
                WHEN level ILIKE 'error' AND (
                  event ILIKE '%knowledge%'
                  OR event ILIKE '%orchestrator%'
                  OR detail::text ILIKE '%knowledge%'
                  OR detail::text ILIKE '%orchestrator%'
                ) THEN 'critical'
                WHEN level ILIKE 'error' THEN 'error'
                ELSE 'info'
              END
            ) = $2
          )
          ORDER BY created_at DESC
          LIMIT $1
        `, [llmLimit, severity]);
            rows.push(...llmQuery.rows);
        }
        rows.sort((a, b) => new Date(b.start_ts).getTime() - new Date(a.start_ts).getTime());
        res.json(rows.slice(0, limit));
    }
    catch {
        res.setHeader('x-error', 'logs_stream_fetch_failed');
        res.status(500).json({ error: 'logs_stream_fetch_failed' });
    }
});
app.get('/api/alerts/critical', async (req, res) => {
    const limit = Math.max(1, Math.min(200, parsePositiveInt(req.query.limit, 50)));
    const lookbackMinutes = Math.max(1, Math.min(1440, parsePositiveInt(req.query.lookback_minutes, 30)));
    try {
        const [requestRows, llmRows] = await Promise.all([
            pool.query(
                `SELECT
                   trace_id::text,
                   span_id::text,
                   service,
                   route,
                   start_ts::text,
                   end_ts::text,
                   latency_ms,
                   status,
                   error,
                   COALESCE(NULLIF(severity, ''), 'info') AS severity,
                   metadata,
                   'request'::text AS log_source
                 FROM request_logs
                 WHERE start_ts >= now() - ($1::int * interval '1 minute')
                   AND COALESCE(NULLIF(severity, ''), 'info') = 'critical'
                 ORDER BY start_ts DESC
                 LIMIT $2`,
                [lookbackMinutes, limit]
            ),
            pool.query(
                `SELECT
                   trace_id::text,
                   span_id::text,
                   'control-plane-api'::text AS service,
                   ('LLM ' || event)::text AS route,
                   created_at::text AS start_ts,
                   created_at::text AS end_ts,
                   0::integer AS latency_ms,
                   CASE WHEN level ILIKE 'error' THEN 500 ELSE 200 END AS status,
                   CASE WHEN level ILIKE 'error' THEN LEFT(COALESCE(detail::text, ''), 600) ELSE NULL END AS error,
                   CASE
                     WHEN level ILIKE 'error' AND (
                       event ILIKE '%knowledge%'
                       OR event ILIKE '%orchestrator%'
                       OR detail::text ILIKE '%knowledge%'
                       OR detail::text ILIKE '%orchestrator%'
                     ) THEN 'critical'
                     WHEN level ILIKE 'error' THEN 'error'
                     ELSE 'info'
                   END AS severity,
                   jsonb_build_object(
                     'source', 'llm_debug_logs',
                     'level', level,
                     'event', event,
                     'detail', detail
                   ) AS metadata,
                   'llm'::text AS log_source
                 FROM llm_debug_logs
                 WHERE created_at >= now() - ($1::int * interval '1 minute')
                   AND level ILIKE 'error'
                   AND (
                     event ILIKE '%knowledge%'
                     OR event ILIKE '%orchestrator%'
                     OR detail::text ILIKE '%knowledge%'
                     OR detail::text ILIKE '%orchestrator%'
                   )
                 ORDER BY created_at DESC
                 LIMIT $2`,
                [lookbackMinutes, limit]
            ),
        ]);
        const merged = [...(requestRows.rows || []), ...(llmRows.rows || [])]
            .sort((a, b) => new Date(b.start_ts).getTime() - new Date(a.start_ts).getTime())
            .slice(0, limit);
        res.json({
            ok: true,
            active: merged.length > 0,
            count: merged.length,
            alerts: merged,
        });
    } catch (error) {
        res.setHeader('x-error', 'critical_alerts_fetch_failed');
        res.status(500).json({ error: 'critical_alerts_fetch_failed', message: String(error?.message || error) });
    }
});

app.get('/api/logs', async (req, res) => {
    const limit = parsePositiveInt(req.query.limit, 200);
    const traceId = String(req.query.trace_id || '').trim();
    const service = String(req.query.service || '').trim();
    const routeContains = String(req.query.route_contains || '').trim();
    try {
        const r = await pool.query(
            `
       SELECT trace_id, span_id, service, route, start_ts, end_ts, latency_ms, status, error, metadata
       FROM request_logs
       WHERE ($1::text = '' OR trace_id::text = $1)
         AND ($2::text = '' OR service = $2)
         AND ($3::text = '' OR route ILIKE '%' || $3 || '%')
       ORDER BY start_ts DESC
       LIMIT $4
     `,
            [traceId, service, routeContains, limit]
        );
        res.json(r.rows);
    }
    catch (e) {
        res.setHeader('x-error', 'logs_fetch_failed');
        res.status(500).json({ error: 'logs_fetch_failed' });
    }
});

const ALLOWED_DASHBOARD_WIDGETS = new Set(['kpi', 'line', 'bar', 'table', 'waterfall']);
const ALLOWED_QUERY_TEMPLATES = new Set([
    'throughput_rps',
    'latency_p50_ms',
    'latency_p95_ms',
    'retrieval_latency_ms',
    'synthesis_latency_ms',
    'citation_coverage',
    'groundedness_score',
    'relevance_score',
    'cache_hit_rate',
    'no_context_rate',
    'token_usage',
    'rag_stage_latency_ms',
]);

function validateDashboardSpec(spec) {
    const errors = [];
    const warnings = [];
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        return { ok: false, errors: ['spec must be an object'], warnings, normalized_spec: null };
    }
    const title = firstNonEmptyString(spec.title, 'Untitled dashboard');
    const widgets = Array.isArray(spec.widgets) ? spec.widgets : [];
    if (widgets.length === 0) {
        errors.push('spec.widgets must contain at least one widget');
    }
    const normalized = [];
    for (let i = 0; i < widgets.length; i += 1) {
        const widget = widgets[i] && typeof widgets[i] === 'object' ? widgets[i] : {};
        const type = firstNonEmptyString(widget.type).toLowerCase();
        const metric = firstNonEmptyString(widget.metric).toLowerCase();
        if (!ALLOWED_DASHBOARD_WIDGETS.has(type)) {
            errors.push(`widgets[${i}].type is not allowlisted`);
            continue;
        }
        if (!ALLOWED_QUERY_TEMPLATES.has(metric)) {
            errors.push(`widgets[${i}].metric is not allowlisted`);
            continue;
        }
        if (widget.script || widget.javascript || widget.sql || widget.query) {
            errors.push(`widgets[${i}] includes forbidden executable fields (script/javascript/sql/query)`);
            continue;
        }
        normalized.push({
            type,
            metric,
            label: firstNonEmptyString(widget.label, `${type}:${metric}`),
        });
    }
    if (normalized.length > 24) {
        errors.push('spec.widgets exceeds maximum of 24');
    }
    if (normalized.length === 0 && errors.length === 0) {
        warnings.push('No valid widgets passed allowlist checks');
    }
    return {
        ok: errors.length === 0,
        errors,
        warnings,
        normalized_spec: {
            title,
            widgets: normalized.slice(0, 24),
            generated_at: nowIso(),
        },
    };
}

app.post('/api/knowledge/dashboard-spec/validate', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    const spec = req.body?.spec;
    const result = validateDashboardSpec(spec);
    const statusCode = result.ok ? 200 : 400;
    const end_ts = nowIso();
    await insertRequestLogRow({
        trace_id,
        span_id,
        route: 'POST /api/knowledge/dashboard-spec/validate',
        start_ts,
        end_ts,
        latency_ms: Date.now() - start,
        status: statusCode,
        error: result.ok ? null : 'invalid_dashboard_spec',
        metadata: {
            widget_count: Array.isArray(spec?.widgets) ? spec.widgets.length : 0,
            valid_widget_count: Array.isArray(result?.normalized_spec?.widgets) ? result.normalized_spec.widgets.length : 0,
            error_count: Array.isArray(result?.errors) ? result.errors.length : 0,
        },
    });
    if (!result.ok) {
        return res.status(400).json(result);
    }
    return res.json(result);
});

app.get('/api/dashboard/smart-search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(50, Math.max(1, parsePositiveInt(req.query.limit, 20)));
    if (q.length < 2) {
        res.setHeader('x-error', 'invalid_query');
        return res.status(400).json({ error: 'invalid_query', hint: 'q must be at least 2 characters.' });
    }
    try {
        const [logsRows, knowledgeRows] = await Promise.all([
            pool.query(
                `SELECT trace_id, service, route, status, latency_ms, start_ts, error, metadata
                 FROM request_logs
                 WHERE route ILIKE '%' || $1 || '%'
                    OR service ILIKE '%' || $1 || '%'
                    OR error ILIKE '%' || $1 || '%'
                    OR metadata::text ILIKE '%' || $1 || '%'
                 ORDER BY start_ts DESC
                 LIMIT $2`,
                [q, limit]
            ),
            pool.query(
                `SELECT id, title, content, tags, created_at
                 FROM knowledge_entries
                 WHERE title ILIKE '%' || $1 || '%'
                    OR content ILIKE '%' || $1 || '%'
                    OR tags::text ILIKE '%' || $1 || '%'
                 ORDER BY created_at DESC
                 LIMIT $2`,
                [q, limit]
            ),
        ]);
        return res.json({
            ok: true,
            query: q,
            logs: logsRows.rows,
            knowledge: knowledgeRows.rows,
            suggested_prompt: `Investigate "${q}" using returned logs and knowledge. Explain root cause and next actions.`,
        });
    } catch (e) {
        res.setHeader('x-error', 'smart_search_failed');
        return res.status(500).json({ error: 'smart_search_failed', message: String(e?.message || e) });
    }
});

app.post('/api/dashboard/llm/respond/stream', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    const prompt = String(req.body?.prompt || '').trim();
    const modelOverride = String(req.body?.model_uuid || '').trim();
    const context = req.body?.context && typeof req.body.context === 'object' ? req.body.context : {};
    if (!prompt) {
        res.setHeader('x-error', 'missing_prompt');
        return res.status(400).json({ error: 'missing_prompt' });
    }
    const route = 'POST /api/dashboard/llm/respond/stream';
    const upstreamController = new AbortController();
    let streamOpened = false;
    let finished = false;
    const abortUpstream = () => {
        if (!finished) upstreamController.abort();
    };
    req.on('aborted', abortUpstream);
    res.on('close', abortUpstream);
    try {
        const auth = parseAuthedUserFromRequest(req);
        const runtime = await resolveDashboardAssistantRuntime({
            model_uuid: modelOverride,
            user_id: auth?.id || '',
        });
        const siteRow = runtime.site_row || await getDashboardAssistantSiteRow();
        const assistantState = runtime.assistant_state || buildDashboardAssistantEffectiveSettings({ siteRow, userRow: runtime.user_row || null });
        const systemPrompt =
            firstNonEmptyString(
                assistantState?.effective?.system_prompt,
                'You are a concise dashboard AI assistant. Use server-side evidence only and provide actionable steps.'
            ) || 'You are a concise dashboard AI assistant.';
        const enabledToolIds = normalizeDashboardToolIds(assistantState?.effective?.enabled_tool_ids);
        const toolsMeta = enabledToolIds.length > 0
            ? (await pool.query(
                `SELECT id, name, kind, status FROM tools WHERE id = ANY($1::uuid[]) ORDER BY name`,
                [enabledToolIds]
            )).rows
            : [];
        const smartSearch = await (async () => {
            try {
                const resp = await pool.query(
                    `SELECT trace_id, service, route, status, latency_ms, start_ts, error
                     FROM request_logs
                     WHERE route ILIKE '%' || $1 || '%'
                        OR service ILIKE '%' || $1 || '%'
                        OR error ILIKE '%' || $1 || '%'
                     ORDER BY start_ts DESC
                     LIMIT 15`,
                    [prompt]
                );
                return resp.rows;
            } catch (_) {
                return [];
            }
        })();
        const dashboardSnapshot = await (async () => {
            try {
                const [overview, queueStats, latestAlerts] = await Promise.all([
                    buildMetricsOverview().catch(() => null),
                    pool.query(
                        `SELECT
                           COUNT(*) FILTER (WHERE status = 'queued')::int AS queued_jobs,
                           COUNT(*) FILTER (WHERE status = 'processing')::int AS processing_jobs,
                           COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_jobs,
                           COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_jobs
                         FROM ingestion_jobs`
                    ).catch(() => ({ rows: [] })),
                    pool.query(
                        `SELECT trace_id, service, route, status, latency_ms, start_ts, error
                         FROM request_logs
                         WHERE status >= 500 OR error IS NOT NULL
                         ORDER BY start_ts DESC
                         LIMIT 5`
                    ).catch(() => ({ rows: [] })),
                ]);
                return sanitizeForLogs({
                    assistant_status: {
                        configured: runtime.assistant_state?.configured ?? assistantState?.configured ?? null,
                        source: assistantState?.source || runtime.assistant_state?.source || null,
                        effective_model_id: llm.model_id,
                    },
                    metrics_sources: Array.isArray(overview?.sources)
                        ? overview.sources.slice(0, 6).map((source) => ({
                            slug: source.slug,
                            health_status: source.health_status,
                            health_latency_ms: source.health_latency_ms,
                            metrics: source.metrics || null,
                        }))
                        : [],
                    ingestion_queue: queueStats.rows?.[0] || null,
                    recent_platform_alerts: latestAlerts.rows || [],
                });
            } catch (_) {
                return null;
            }
        })();
        const llm = runtime.llm;
        if (!llm) {
            res.setHeader('x-error', 'dashboard_llm_not_configured');
            return res.status(503).json({ error: 'dashboard_llm_not_configured', hint: 'Configure enabled provider/model and API key env.' });
        }
        const generationDefaults = resolveAssistantGenerationDefaults(assistantState?.effective?.config);
        const body = {
            model: llm.model_id,
            temperature: generationDefaults.temperature,
            top_p: generationDefaults.top_p,
            max_tokens: generationDefaults.max_tokens,
            messages: [
                {
                    role: 'system',
                    content: `${systemPrompt}\n\nEnabled tools for dashboard context: ${toolsMeta.map((t) => `${t.name}(${t.kind})`).join(', ') || 'none'}`,
                },
                {
                    role: 'user',
                    content: JSON.stringify(
                        {
                            prompt,
                            context,
                            smart_search: smartSearch,
                            dashboard_snapshot: dashboardSnapshot,
                        },
                        null,
                        2
                    ),
                },
            ],
        };
        const prepared = prepareLlmChatRequest({ llm, body, route });
        if (!prepared.ok) {
            res.setHeader('x-error', prepared.error || 'dashboard_llm_failed');
            return res.status(prepared.status || 400).json({
                error: prepared.error || 'dashboard_llm_failed',
                message: prepared.message || 'Unable to prepare website assistant request.',
                token_policy: prepared.token_policy || null,
            });
        }

        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();
        streamOpened = true;

        writeSseEvent(res, 'accepted', {
            trace_id,
            model: llm.label || llm.model_id,
        });
        writeSseEvent(res, 'thinking', {
            trace_id,
            phase: 'provider_stream_connecting',
        });

        const upstreamRes = await fetch(llm.chat_url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...buildApiKeyHeaders(llm.api_key, llm.auth_header_name || 'Authorization'),
                ...(trace_id ? { 'x-trace-id': trace_id } : {}),
            },
            body: JSON.stringify({ ...prepared.body, stream: true }),
            signal: upstreamController.signal,
        });
        if (!upstreamRes.ok || !upstreamRes.body) {
            const failBody = await upstreamRes.text().catch(() => '');
            const streamUnsupported = upstreamRes.status === 400 && /stream\s*=\s*true\s+is\s+not\s+supported/i.test(failBody);
            if (streamUnsupported) {
                writeSseEvent(res, 'thinking', {
                    trace_id,
                    phase: 'provider_stream_unsupported_fallback',
                });
                const fallbackRes = await fetch(llm.chat_url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...buildApiKeyHeaders(llm.api_key, llm.auth_header_name || 'Authorization'),
                        ...(trace_id ? { 'x-trace-id': trace_id } : {}),
                    },
                    body: JSON.stringify(prepared.body),
                    signal: upstreamController.signal,
                });
                const fallbackBody = await fallbackRes.json().catch(() => ({}));
                if (!fallbackRes.ok) {
                    writeSseEvent(res, 'error', {
                        trace_id,
                        error: 'dashboard_llm_failed',
                        message: firstNonEmptyString(fallbackBody?.error?.message, fallbackBody?.error, fallbackBody?.message) || `upstream_${fallbackRes.status || 502}`,
                        upstream_status: fallbackRes.status || null,
                    });
                    writeSseEvent(res, 'done', {
                        trace_id,
                        ok: false,
                    });
                    const end_ts = nowIso();
                    await insertRequestLogRow({
                        trace_id,
                        span_id,
                        route,
                        start_ts,
                        end_ts,
                        latency_ms: Date.now() - start,
                        status: fallbackRes.status || 502,
                        error: 'dashboard_llm_failed',
                        metadata: {
                            model_uuid: llm.model_uuid,
                            model_id: llm.model_id,
                            enabled_tool_count: toolsMeta.length,
                            upstream_status: fallbackRes.status || 0,
                            fallback_mode: 'non_streaming',
                        },
                    });
                    finished = true;
                    return res.end();
                }
                const fallbackText = extractLlmText(fallbackBody) || '';
                if (fallbackText) {
                    const chunks = splitTextForStreaming(fallbackText, 30);
                    for (let idx = 0; idx < chunks.length; idx += 1) {
                        if (upstreamController.signal.aborted) break;
                        writeSseEvent(res, 'delta', {
                            trace_id,
                            index: idx + 1,
                            text: chunks[idx],
                        });
                        if (idx < (chunks.length - 1)) {
                            await wait(35);
                        }
                    }
                }
                writeSseEvent(res, 'done', {
                    trace_id,
                    ok: true,
                    text: fallbackText,
                    model: llm.label || llm.model_id,
                    enabled_tools: toolsMeta,
                    token_policy: prepared.token_policy,
                    token_policy_notice: prepared.notice || null,
                    fallback_mode: 'non_streaming',
                });
                const end_ts = nowIso();
                await insertRequestLogRow({
                    trace_id,
                    span_id,
                    route,
                    start_ts,
                    end_ts,
                    latency_ms: Date.now() - start,
                    status: 200,
                    error: null,
                    metadata: {
                        model_uuid: llm.model_uuid,
                        model_id: llm.model_id,
                        enabled_tool_count: toolsMeta.length,
                        upstream_status: 200,
                        token_policy: prepared.token_policy,
                        streamed_token_events: fallbackText ? 1 : 0,
                        fallback_mode: 'non_streaming',
                    },
                });
                finished = true;
                return res.end();
            }
            writeSseEvent(res, 'error', {
                trace_id,
                error: 'dashboard_llm_failed',
                message: failBody.slice(0, 1000) || `upstream_${upstreamRes.status || 502}`,
                upstream_status: upstreamRes.status || null,
            });
            writeSseEvent(res, 'done', {
                trace_id,
                ok: false,
            });
            const end_ts = nowIso();
            await insertRequestLogRow({
                trace_id,
                span_id,
                route,
                start_ts,
                end_ts,
                latency_ms: Date.now() - start,
                status: upstreamRes.status || 502,
                error: 'dashboard_llm_failed',
                metadata: {
                    model_uuid: llm.model_uuid,
                    model_id: llm.model_id,
                    enabled_tool_count: toolsMeta.length,
                    upstream_status: upstreamRes.status || 0,
                },
            });
            finished = true;
            return res.end();
        }

        let text = '';
        let tokenCount = 0;
        const decoder = new TextDecoder();
        const parser = createVllmStreamParser(
            (delta) => {
                text += delta;
                tokenCount += 1;
                writeSseEvent(res, 'delta', { trace_id, index: tokenCount, text: delta });
            },
            () => {
                writeSseEvent(res, 'thinking', { trace_id, phase: 'provider_stream_complete' });
            }
        );
        for await (const chunk of upstreamRes.body) {
            parser(decoder.decode(chunk, { stream: true }));
        }
        parser('\n');

        writeSseEvent(res, 'done', {
            trace_id,
            ok: true,
            text,
            model: llm.label || llm.model_id,
            enabled_tools: toolsMeta,
            token_policy: prepared.token_policy,
            token_policy_notice: prepared.notice || null,
        });
        const end_ts = nowIso();
        await insertRequestLogRow({
            trace_id,
            span_id,
            route,
            start_ts,
            end_ts,
            latency_ms: Date.now() - start,
            status: 200,
            error: null,
            metadata: {
                model_uuid: llm.model_uuid,
                model_id: llm.model_id,
                enabled_tool_count: toolsMeta.length,
                upstream_status: 200,
                token_policy: prepared.token_policy,
                streamed_token_events: tokenCount,
            },
        });
        finished = true;
        return res.end();
    } catch (e) {
        const aborted = upstreamController.signal.aborted;
        const end_ts = nowIso();
        await insertRequestLogRow({
            trace_id,
            span_id,
            route,
            start_ts,
            end_ts,
            latency_ms: Date.now() - start,
            status: aborted ? 499 : 500,
            error: aborted ? 'dashboard_llm_cancelled' : 'dashboard_llm_failed',
            metadata: { error: String(e?.message || e) },
        });
        if (!streamOpened) {
            res.setHeader('x-error', aborted ? 'dashboard_llm_cancelled' : 'dashboard_llm_failed');
            return res.status(aborted ? 499 : 500).json({
                error: aborted ? 'dashboard_llm_cancelled' : 'dashboard_llm_failed',
                message: aborted ? 'request_cancelled' : String(e?.message || e),
            });
        }
        writeSseEvent(res, 'error', {
            trace_id,
            error: aborted ? 'dashboard_llm_cancelled' : 'dashboard_llm_failed',
            message: aborted ? 'request_cancelled' : String(e?.message || e),
        });
        writeSseEvent(res, 'done', {
            trace_id,
            ok: false,
            aborted,
        });
        finished = true;
        return res.end();
    }
});

app.post('/api/dashboard/llm/respond', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    const prompt = String(req.body?.prompt || '').trim();
    const modelOverride = String(req.body?.model_uuid || '').trim();
    const context = req.body?.context && typeof req.body.context === 'object' ? req.body.context : {};
    if (!prompt) {
        res.setHeader('x-error', 'missing_prompt');
        return res.status(400).json({ error: 'missing_prompt' });
    }
    try {
        const auth = parseAuthedUserFromRequest(req);
        const runtime = await resolveDashboardAssistantRuntime({
            model_uuid: modelOverride,
            user_id: auth?.id || '',
        });
        const siteRow = runtime.site_row || await getDashboardAssistantSiteRow();
        const assistantState = runtime.assistant_state || buildDashboardAssistantEffectiveSettings({ siteRow, userRow: runtime.user_row || null });
        const systemPrompt =
            firstNonEmptyString(
                assistantState?.effective?.system_prompt,
                'You are a concise dashboard AI assistant. Use server-side evidence only and provide actionable steps.'
            ) || 'You are a concise dashboard AI assistant.';
        const enabledToolIds = normalizeDashboardToolIds(assistantState?.effective?.enabled_tool_ids);
        const toolsMeta = enabledToolIds.length > 0
            ? (await pool.query(
                `SELECT id, name, kind, status FROM tools WHERE id = ANY($1::uuid[]) ORDER BY name`,
                [enabledToolIds]
            )).rows
            : [];

        const smartSearch = await (async () => {
            try {
                const resp = await pool.query(
                    `SELECT trace_id, service, route, status, latency_ms, start_ts, error
                     FROM request_logs
                     WHERE route ILIKE '%' || $1 || '%'
                        OR service ILIKE '%' || $1 || '%'
                        OR error ILIKE '%' || $1 || '%'
                     ORDER BY start_ts DESC
                     LIMIT 15`,
                    [prompt]
                );
                return resp.rows;
            } catch (_) {
                return [];
            }
        })();

        const llm = runtime.llm;
        if (!llm) {
            res.setHeader('x-error', 'dashboard_llm_not_configured');
            return res.status(503).json({ error: 'dashboard_llm_not_configured', hint: 'Configure enabled provider/model and API key env.' });
        }

        const body = {
            model: llm.model_id,
            temperature: 0.2,
            messages: [
                {
                    role: 'system',
                    content: `${systemPrompt}\n\nEnabled tools for dashboard context: ${toolsMeta.map((t) => `${t.name}(${t.kind})`).join(', ') || 'none'}`,
                },
                {
                    role: 'user',
                    content: JSON.stringify(
                        {
                            prompt,
                            context,
                            smart_search: smartSearch,
                        },
                        null,
                        2
                    ),
                },
            ],
        };
        const dashboardBaseUrl = String(llm?.base_url || '').trim();
        const dashboardToolLoopCapableProvider = supportsToolLoopForBaseUrl(dashboardBaseUrl);
        const llmResult = (toolsMeta.length > 0 && dashboardToolLoopCapableProvider)
            ? await runOpenAiToolLoop({
                llm,
                trace_id,
                route: 'POST /api/dashboard/llm/respond',
                headers: {
                    'Content-Type': 'application/json',
                    ...buildApiKeyHeaders(llm.api_key, llm.auth_header_name || 'Authorization'),
                    ...(trace_id ? { 'x-trace-id': trace_id } : {}),
                },
                systemMessage: String(body.messages?.[0]?.content || ''),
                userMessage: String(body.messages?.[1]?.content || ''),
                toolRows: toolsMeta,
                generation: {
                    temperature: body.temperature,
                    max_tokens: body.max_tokens,
                    top_p: body.top_p,
                    stop: body.stop,
                },
                agent_id: null,
            })
            : await callConfiguredLlm({
                llm,
                trace_id,
                route: 'POST /api/dashboard/llm/respond',
                body,
            });
        const upstreamBody = llmResult.upstream_body || {};
        const text = String(firstNonEmptyString(llmResult.output, extractLlmText(upstreamBody)) || '').trim() || null;
        const end_ts = nowIso();
        const latency_ms = Date.now() - start;
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/dashboard/llm/respond',
            start_ts,
            end_ts,
            latency_ms,
            status: llmResult.ok ? 200 : llmResult.status || 502,
            error: llmResult.ok ? null : 'dashboard_llm_failed',
            metadata: {
                model_uuid: llm.model_uuid,
                model_id: llm.model_id,
                enabled_tool_count: toolsMeta.length,
                upstream_status: llmResult.status || 0,
                token_policy: llmResult.token_policy,
            },
        });
        if (!llmResult.ok) {
            res.setHeader('x-error', 'dashboard_llm_failed');
            return res.status(llmResult.status || 502).json({
                error: llmResult.error || 'dashboard_llm_failed',
                message: llmResult.message || 'upstream_failed',
                token_policy: llmResult.token_policy,
            });
        }
        return res.json({
            ok: true,
            trace_id,
            text,
            model: llm.label || llm.model_id,
            enabled_tools: toolsMeta,
            token_policy: llmResult.token_policy,
            token_policy_notice: llmResult.token_policy_notice,
        });
    } catch (e) {
        const end_ts = nowIso();
        const latency_ms = Date.now() - start;
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/dashboard/llm/respond',
            start_ts,
            end_ts,
            latency_ms,
            status: 500,
            error: 'dashboard_llm_failed',
            metadata: { error: String(e?.message || e) },
        });
        res.setHeader('x-error', 'dashboard_llm_failed');
        return res.status(500).json({ error: 'dashboard_llm_failed', message: String(e?.message || e) });
    }
});

app.post('/api/elevenlabs/sync', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const runSpanId = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    const agentId = String(req.body?.agent_id || '').trim();
    if (!ELEVENLABS_API_KEY) {
        res.setHeader('x-error', 'elevenlabs_api_key_missing');
        return res.status(503).json({ error: 'elevenlabs_api_key_missing' });
    }
    const runRow = await pool.query(
        `INSERT INTO elevenlabs_sync_runs (trace_id, agent_id, started_at, status, metadata)
         VALUES ($1,$2,now(),'running',$3::jsonb)
         RETURNING id`,
        [trace_id, agentId || null, JSON.stringify({ trigger: 'api_sync' })]
    ).catch(() => ({ rowCount: 0, rows: [] }));
    const runId = runRow.rowCount > 0 ? runRow.rows[0].id : null;

    let cursor = null;
    let fetchedTotal = 0;
    let insertedTotal = 0;
    let updatedTotal = 0;
    let pageCount = 0;
    const syncErrors = [];

    try {
        do {
            pageCount += 1;
            const listResp = await elevenlabsFetchJson('/v1/convai/conversations', {
                query: {
                    agent_id: agentId || undefined,
                    cursor: cursor || undefined,
                    page_size: 100,
                },
            });
            if (!listResp.ok) {
                const errMsg = firstNonEmptyString(listResp.data?.error?.message, listResp.data?.error, listResp.data?.message) || 'elevenlabs_list_failed';
                throw new Error(`${listResp.status || 0}:${errMsg}`);
            }

            const body = safeJson(listResp.data, {});
            const rows = Array.isArray(body.conversations)
                ? body.conversations
                : Array.isArray(body.data)
                    ? body.data
                    : Array.isArray(listResp.data)
                        ? listResp.data
                        : [];
            fetchedTotal += rows.length;

            for (const item of rows) {
                const conversationId = firstNonEmptyString(item?.conversation_id, item?.id);
                if (!conversationId) continue;

                const detailPayload = await fetchElevenlabsConversationDetail(conversationId);
                const aux = await fetchElevenlabsConversationAux(conversationId);
                const mergedPayload = mergeConversationPayload(item, detailPayload, aux);
                const normalized = normalizeConversationRow(mergedPayload, agentId || null);
                if (!normalized.conversation_id) continue;
                if (!normalized.user_id && normalized.customer_number) normalized.user_id = normalized.customer_number;

                if (!normalized.audio_url) {
                    normalized.audio_url = firstNonEmptyString(aux.audio?.audio_url, aux.audio?.audioUrl, aux.audio?.url);
                }
                if (!normalized.recording_url) {
                    normalized.recording_url = firstNonEmptyString(aux.audio?.recording_url, aux.audio?.recordingUrl);
                }
                if (normalized.tokens_total == null) {
                    normalized.tokens_total = firstFiniteNumber(aux.tokens?.total_tokens, aux.tokens?.tokens_total);
                }
                if (normalized.tokens_prompt == null) {
                    normalized.tokens_prompt = firstFiniteNumber(aux.tokens?.prompt_tokens, aux.tokens?.tokens_prompt);
                }
                if (normalized.tokens_completion == null) {
                    normalized.tokens_completion = firstFiniteNumber(aux.tokens?.completion_tokens, aux.tokens?.tokens_completion);
                }

                const existing = await pool.query(
                    `SELECT conversation_id FROM elevenlabs_conversations WHERE conversation_id = $1 LIMIT 1`,
                    [normalized.conversation_id]
                );
                const existed = existing.rowCount > 0;

                const client = await pool.connect();
                try {
                    await client.query('BEGIN');
                    await client.query(
                        `INSERT INTO elevenlabs_conversations (
                           conversation_id, agent_id, agent_name, user_id, customer_number, call_status, call_successful,
                           direction, started_at, ended_at, call_duration_secs, message_count, overview_summary,
                           transcript_summary, call_summary_title, latest_input, audio_url, recording_url,
                           call_cost, tokens_prompt, tokens_completion, tokens_total, metadata, raw_payload, imported_at, updated_at
                         ) VALUES (
                           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,$24::jsonb,now(),now()
                         )
                         ON CONFLICT (conversation_id) DO UPDATE
                         SET agent_id = EXCLUDED.agent_id,
                             agent_name = EXCLUDED.agent_name,
                             user_id = EXCLUDED.user_id,
                             customer_number = EXCLUDED.customer_number,
                             call_status = EXCLUDED.call_status,
                             call_successful = EXCLUDED.call_successful,
                             direction = EXCLUDED.direction,
                             started_at = EXCLUDED.started_at,
                             ended_at = EXCLUDED.ended_at,
                             call_duration_secs = EXCLUDED.call_duration_secs,
                             message_count = EXCLUDED.message_count,
                             overview_summary = EXCLUDED.overview_summary,
                             transcript_summary = EXCLUDED.transcript_summary,
                             call_summary_title = EXCLUDED.call_summary_title,
                             latest_input = EXCLUDED.latest_input,
                             audio_url = EXCLUDED.audio_url,
                             recording_url = EXCLUDED.recording_url,
                             call_cost = EXCLUDED.call_cost,
                             tokens_prompt = EXCLUDED.tokens_prompt,
                             tokens_completion = EXCLUDED.tokens_completion,
                             tokens_total = EXCLUDED.tokens_total,
                             metadata = EXCLUDED.metadata,
                             raw_payload = EXCLUDED.raw_payload,
                             updated_at = now()`,
                        [
                            normalized.conversation_id,
                            normalized.agent_id,
                            normalized.agent_name,
                            normalized.user_id,
                            normalized.customer_number,
                            normalized.call_status,
                            normalized.call_successful,
                            normalized.direction,
                            normalized.started_at,
                            normalized.ended_at,
                            normalized.call_duration_secs != null ? Math.trunc(normalized.call_duration_secs) : null,
                            normalized.message_count != null ? Math.trunc(normalized.message_count) : null,
                            normalized.overview_summary,
                            normalized.transcript_summary,
                            normalized.call_summary_title,
                            normalized.latest_input,
                            normalized.audio_url,
                            normalized.recording_url,
                            normalized.call_cost != null ? Number(normalized.call_cost) : null,
                            normalized.tokens_prompt != null ? Math.trunc(normalized.tokens_prompt) : null,
                            normalized.tokens_completion != null ? Math.trunc(normalized.tokens_completion) : null,
                            normalized.tokens_total != null ? Math.trunc(normalized.tokens_total) : null,
                            JSON.stringify(safeJson(normalized.metadata, {})),
                            JSON.stringify(safeJson(normalized.raw_payload, {})),
                        ]
                    );

                    const normalizedMessages = normalizeConversationMessages(mergedPayload).map((m) => ({
                        ...m,
                        conversation_id: normalized.conversation_id,
                    }));
                    await client.query(`DELETE FROM elevenlabs_conversation_messages WHERE conversation_id = $1`, [normalized.conversation_id]);
                    for (const m of normalizedMessages) {
                        await client.query(
                            `INSERT INTO elevenlabs_conversation_messages (conversation_id, message_id, role, message, time_value, raw_payload)
                             VALUES ($1,$2,$3,$4,$5,$6::jsonb)
                             ON CONFLICT (conversation_id, message_id) DO UPDATE
                             SET role = EXCLUDED.role,
                                 message = EXCLUDED.message,
                                 time_value = EXCLUDED.time_value,
                                 raw_payload = EXCLUDED.raw_payload`,
                            [
                                m.conversation_id,
                                m.message_id,
                                m.role,
                                m.message,
                                m.time_value,
                                JSON.stringify(safeJson(m.raw_payload, {})),
                            ]
                        );
                    }

                    await client.query('COMMIT');
                    if (existed) updatedTotal += 1;
                    else insertedTotal += 1;
                } catch (e) {
                    await client.query('ROLLBACK');
                    syncErrors.push({
                        conversation_id: normalized.conversation_id,
                        error: String(e?.message || e),
                    });
                } finally {
                    client.release();
                }
            }

            cursor = firstNonEmptyString(body.next_cursor, body.nextCursor, body.cursor);
        } while (cursor);

        const end_ts = nowIso();
        const durationMs = Date.now() - start;
        if (runId) {
            await pool.query(
                `UPDATE elevenlabs_sync_runs
                 SET ended_at = now(),
                     duration_ms = $2,
                     status = 'completed',
                     fetched_total = $3,
                     inserted_total = $4,
                     updated_total = $5,
                     page_count = $6,
                     error = $7,
                     metadata = $8::jsonb
                 WHERE id = $1`,
                [
                    runId,
                    durationMs,
                    fetchedTotal,
                    insertedTotal,
                    updatedTotal,
                    pageCount,
                    syncErrors.length > 0 ? 'partial_errors' : null,
                    JSON.stringify({ errors: syncErrors.slice(0, 20) }),
                ]
            );
        }
        await insertRequestLogRow({
            trace_id,
            span_id: runSpanId,
            route: 'POST /api/elevenlabs/sync',
            start_ts,
            end_ts,
            latency_ms: durationMs,
            status: 200,
            error: syncErrors.length > 0 ? 'partial_errors' : null,
            metadata: {
                run_id: runId,
                agent_id: agentId || null,
                fetched_total: fetchedTotal,
                inserted_total: insertedTotal,
                updated_total: updatedTotal,
                page_count: pageCount,
                partial_errors: syncErrors.length,
            },
        });
        return res.json({
            ok: true,
            run_id: runId,
            agent_id: agentId || null,
            fetched_total: fetchedTotal,
            inserted_total: insertedTotal,
            updated_total: updatedTotal,
            imported_count: insertedTotal + updatedTotal,
            page_count: pageCount,
            duration_ms: durationMs,
            partial_errors: syncErrors.length,
        });
    } catch (e) {
        const end_ts = nowIso();
        const durationMs = Date.now() - start;
        if (runId) {
            await pool.query(
                `UPDATE elevenlabs_sync_runs
                 SET ended_at = now(),
                     duration_ms = $2,
                     status = 'failed',
                     fetched_total = $3,
                     inserted_total = $4,
                     updated_total = $5,
                     page_count = $6,
                     error = $7,
                     metadata = $8::jsonb
                 WHERE id = $1`,
                [
                    runId,
                    durationMs,
                    fetchedTotal,
                    insertedTotal,
                    updatedTotal,
                    pageCount,
                    String(e?.message || e),
                    JSON.stringify({ errors: syncErrors.slice(0, 20) }),
                ]
            );
        }
        await insertRequestLogRow({
            trace_id,
            span_id: runSpanId,
            route: 'POST /api/elevenlabs/sync',
            start_ts,
            end_ts,
            latency_ms: durationMs,
            status: 502,
            error: 'elevenlabs_sync_failed',
            metadata: {
                run_id: runId,
                agent_id: agentId || null,
                fetched_total: fetchedTotal,
                inserted_total: insertedTotal,
                updated_total: updatedTotal,
                page_count: pageCount,
                reason: String(e?.message || e),
            },
        });
        res.setHeader('x-error', 'elevenlabs_sync_failed');
        return res.status(502).json({
            error: 'elevenlabs_sync_failed',
            message: String(e?.message || e),
            run_id: runId,
            fetched_total: fetchedTotal,
            inserted_total: insertedTotal,
            updated_total: updatedTotal,
            page_count: pageCount,
        });
    }
});

app.get('/api/elevenlabs/calls', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    const agentId = String(req.query.agent_id || '').trim();
    const page = Math.max(1, parsePositiveInt(req.query.page, 1));
    const limit = Math.min(25, Math.max(1, parsePositiveInt(req.query.limit, 25)));
    const offset = (page - 1) * limit;
    try {
        const rowsQ = await pool.query(
            `SELECT
               conversation_id,
               conversation_id AS session_id,
               agent_id,
               COALESCE(agent_name, agent_id, 'Unknown Agent') AS agent_name,
               NULL::uuid AS trace_id,
               'GET /api/elevenlabs/calls'::text AS route,
               CASE
                 WHEN call_successful = true THEN 200
                 WHEN call_successful = false THEN 409
                 ELSE NULL
               END AS status,
               call_status,
               call_successful AS success,
               COALESCE(started_at, imported_at) AS date,
               COALESCE(started_at, imported_at) AS time,
               customer_number,
               COALESCE(overview_summary, '') AS overview_summary,
               COALESCE(transcript_summary, '') AS transcript_summary,
               call_summary_title,
               NULL::integer AS latency_ms,
               NULL::text AS error,
               latest_input,
               message_count,
               direction,
               imported_at,
               COALESCE(user_id, customer_number) AS user_id,
               COALESCE(transcript_summary, overview_summary, '') AS summary,
               audio_url,
               recording_url,
               call_cost,
               COUNT(*) OVER() AS total_count
             FROM elevenlabs_conversations
             WHERE ($1::text = '' OR agent_id = $1)
             ORDER BY COALESCE(started_at, imported_at) DESC, conversation_id DESC
             LIMIT $2 OFFSET $3`,
            [agentId, limit, offset]
        );
        const rows = rowsQ.rows || [];
        const total = rows.length > 0 ? Number(rows[0].total_count || 0) : 0;
        const totalPages = total > 0 ? Math.ceil(total / limit) : 1;
        const end_ts = nowIso();
        const latency_ms = Date.now() - start;
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'GET /api/elevenlabs/calls',
            start_ts,
            end_ts,
            latency_ms,
            status: 200,
            metadata: { agent_id: agentId || null, page, limit, total },
        });
        return res.json({ rows, page, limit, total, total_pages: totalPages });
    } catch (e) {
        const end_ts = nowIso();
        const latency_ms = Date.now() - start;
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'GET /api/elevenlabs/calls',
            start_ts,
            end_ts,
            latency_ms,
            status: 500,
            error: 'elevenlabs_calls_fetch_failed',
            metadata: { error: String(e?.message || e) },
        });
        res.setHeader('x-error', 'elevenlabs_calls_fetch_failed');
        return res.status(500).json({ error: 'elevenlabs_calls_fetch_failed' });
    }
});

app.get('/api/elevenlabs/agents', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    try {
        const rowsQ = await pool.query(
            `SELECT
               COALESCE(NULLIF(TRIM(agent_name), ''), 'Unknown Agent') AS agent_name,
               agent_id,
               COUNT(*)::integer AS call_count,
               MAX(COALESCE(started_at, imported_at)) AS latest_call_at
             FROM elevenlabs_conversations
             WHERE agent_id IS NOT NULL AND TRIM(agent_id) <> ''
             GROUP BY 1, 2
             ORDER BY LOWER(COALESCE(NULLIF(TRIM(agent_name), ''), 'Unknown Agent')) ASC,
                      MAX(COALESCE(started_at, imported_at)) DESC`
        );
        const groupsMap = new Map();
        for (const row of rowsQ.rows || []) {
            const groupName = firstNonEmptyString(row.agent_name) || 'Unknown Agent';
            if (!groupsMap.has(groupName)) groupsMap.set(groupName, []);
            groupsMap.get(groupName).push({
                agent_id: firstNonEmptyString(row.agent_id) || '',
                call_count: Number(row.call_count || 0),
                latest_call_at: toDateValue(row.latest_call_at)?.toISOString() || null,
            });
        }
        const groups = Array.from(groupsMap.entries()).map(([agent_name, agents]) => ({
            agent_name,
            agents: agents.sort((a, b) => {
                const ta = new Date(a.latest_call_at || 0).getTime();
                const tb = new Date(b.latest_call_at || 0).getTime();
                if (tb !== ta) return tb - ta;
                return String(a.agent_id).localeCompare(String(b.agent_id));
            }),
        }));
        const end_ts = nowIso();
        const latency_ms = Date.now() - start;
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'GET /api/elevenlabs/agents',
            start_ts,
            end_ts,
            latency_ms,
            status: 200,
            metadata: {
                group_count: groups.length,
                total_agents: (rowsQ.rows || []).length,
            },
        });
        return res.json({
            ok: true,
            groups,
            total_agents: (rowsQ.rows || []).length,
        });
    } catch (e) {
        const end_ts = nowIso();
        const latency_ms = Date.now() - start;
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'GET /api/elevenlabs/agents',
            start_ts,
            end_ts,
            latency_ms,
            status: 500,
            error: 'elevenlabs_agents_fetch_failed',
            metadata: { error: String(e?.message || e) },
        });
        res.setHeader('x-error', 'elevenlabs_agents_fetch_failed');
        return res.status(500).json({ error: 'elevenlabs_agents_fetch_failed' });
    }
});

app.get('/api/elevenlabs/calls/export', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    const agentId = String(req.query.agent_id || '').trim();
    const format = String(req.query.format || '').trim().toLowerCase();
    if (!['xlsx', 'html'].includes(format)) {
        const end_ts = nowIso();
        const latency_ms = Date.now() - start;
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'GET /api/elevenlabs/calls/export',
            start_ts,
            end_ts,
            latency_ms,
            status: 400,
            error: 'elevenlabs_calls_export_invalid_format',
            metadata: { format, agent_id: agentId || null },
        });
        res.setHeader('x-error', 'elevenlabs_calls_export_invalid_format');
        return res.status(400).json({ error: 'invalid_export_format', message: 'format must be xlsx or html' });
    }
    try {
        const rowsQ = await pool.query(
            `SELECT
               conversation_id,
               agent_id,
               COALESCE(agent_name, agent_id, 'Unknown Agent') AS agent_name,
               call_status,
               call_successful,
               COALESCE(started_at, imported_at) AS call_timestamp,
               customer_number,
               user_id,
               COALESCE(transcript_summary, '') AS transcript_summary,
               COALESCE(overview_summary, '') AS overview_summary,
               COALESCE(call_summary_title, '') AS call_summary_title,
               direction,
               message_count,
               call_duration_secs,
               call_cost,
               imported_at
             FROM elevenlabs_conversations
             WHERE ($1::text = '' OR agent_id = $1)
             ORDER BY COALESCE(started_at, imported_at) DESC, conversation_id DESC`,
            [agentId]
        );
        const exportRows = (rowsQ.rows || []).map((row) => {
            const isoTimestamp = toDateValue(row.call_timestamp)?.toISOString() || '';
            const customerNumber = firstNonEmptyString(row.customer_number, row.user_id) || '';
            const summary =
                firstNonEmptyString(row.transcript_summary, row.overview_summary, row.call_summary_title) || '';
            const statusText = firstNonEmptyString(
                row.call_status,
                row.call_successful === true ? 'success' : row.call_successful === false ? 'failure' : null,
                'unknown'
            );
            return {
                conversation_id: firstNonEmptyString(row.conversation_id) || '',
                agent_id: firstNonEmptyString(row.agent_id) || '',
                agent_name: firstNonEmptyString(row.agent_name) || '',
                status: statusText || 'unknown',
                date: formatDateAu(row.call_timestamp),
                time: formatTimeAu(row.call_timestamp),
                call_datetime_iso: isoTimestamp,
                customer_number: customerNumber,
                summary,
                direction: firstNonEmptyString(row.direction) || '',
                message_count: firstFiniteNumber(row.message_count),
                call_duration_secs: firstFiniteNumber(row.call_duration_secs),
                call_cost: firstFiniteNumber(row.call_cost),
                imported_at: toDateValue(row.imported_at)?.toISOString() || '',
            };
        });
        const utcStamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filenameBase = `elevenlabs-calls-${sanitizeFilenameSegment(agentId, 'all')}-${utcStamp}`;
        if (format === 'xlsx') {
            const workbook = new ExcelJS.Workbook();
            workbook.creator = 'GhostDash Control Plane';
            workbook.created = new Date();
            const sheet = workbook.addWorksheet('ElevenLabs Calls', {
                views: [{ state: 'frozen', ySplit: 1 }],
                properties: { defaultColWidth: 18 },
            });
            sheet.columns = [
                { header: 'Conversation ID', key: 'conversation_id', width: 40 },
                { header: 'Agent Name', key: 'agent_name', width: 26 },
                { header: 'Agent ID', key: 'agent_id', width: 40 },
                { header: 'Status', key: 'status', width: 16 },
                { header: 'Date', key: 'date', width: 18 },
                { header: 'Time', key: 'time', width: 14 },
                { header: 'Call DateTime (ISO)', key: 'call_datetime_iso', width: 30 },
                { header: 'Customer Number', key: 'customer_number', width: 24 },
                { header: 'Summary', key: 'summary', width: 72 },
                { header: 'Direction', key: 'direction', width: 14 },
                { header: 'Message Count', key: 'message_count', width: 14 },
                { header: 'Call Duration (s)', key: 'call_duration_secs', width: 16 },
                { header: 'Call Cost', key: 'call_cost', width: 14 },
                { header: 'Imported At (ISO)', key: 'imported_at', width: 30 },
            ];
            sheet.getRow(1).font = { bold: true };
            sheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'left' };
            for (const row of exportRows) {
                sheet.addRow({
                    conversation_id: sanitizeSpreadsheetCell(row.conversation_id),
                    agent_name: sanitizeSpreadsheetCell(row.agent_name),
                    agent_id: sanitizeSpreadsheetCell(row.agent_id),
                    status: sanitizeSpreadsheetCell(row.status),
                    date: sanitizeSpreadsheetCell(row.date),
                    time: sanitizeSpreadsheetCell(row.time),
                    call_datetime_iso: sanitizeSpreadsheetCell(row.call_datetime_iso),
                    customer_number: sanitizeSpreadsheetCell(row.customer_number),
                    summary: sanitizeSpreadsheetCell(row.summary),
                    direction: sanitizeSpreadsheetCell(row.direction),
                    message_count: row.message_count,
                    call_duration_secs: row.call_duration_secs,
                    call_cost: row.call_cost,
                    imported_at: sanitizeSpreadsheetCell(row.imported_at),
                });
            }
            sheet.getColumn('summary').alignment = { wrapText: true, vertical: 'top' };
            sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
                if (rowNumber === 1) return;
                row.alignment = { vertical: 'top' };
            });
            const buffer = await workbook.xlsx.writeBuffer();
            res.setHeader(
                'Content-Type',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            );
            res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.xlsx"`);
            res.setHeader('Cache-Control', 'no-store');
            const end_ts = nowIso();
            const latency_ms = Date.now() - start;
            await insertRequestLogRow({
                trace_id,
                span_id,
                route: 'GET /api/elevenlabs/calls/export',
                start_ts,
                end_ts,
                latency_ms,
                status: 200,
                metadata: { format, agent_id: agentId || null, row_count: exportRows.length },
            });
            return res.send(Buffer.from(buffer));
        }
        const htmlRows = exportRows
            .map(
                (row) => `
      <tr>
        <td>${escapeHtml(row.customer_number || '—')}</td>
        <td>${escapeHtml(row.date)}</td>
        <td>${escapeHtml(row.time)}</td>
        <td>${escapeHtml(row.summary || '—')}</td>
        <td>${escapeHtml(row.status)}</td>
        <td>${escapeHtml(row.agent_name)}</td>
        <td><code>${escapeHtml(row.conversation_id)}</code></td>
      </tr>`
            )
            .join('\n');
        const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>ElevenLabs Calls Export</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; padding: 24px; font-family: "Segoe UI", Arial, sans-serif; background: #f6f8fb; color: #111827; }
    h1 { margin: 0 0 6px; font-size: 20px; }
    .meta { margin-bottom: 16px; font-size: 12px; color: #4b5563; }
    .table-wrap { background: white; border: 1px solid #d1d5db; border-radius: 10px; overflow: auto; }
    table { border-collapse: collapse; width: 100%; min-width: 1000px; }
    thead th { position: sticky; top: 0; background: #f3f4f6; z-index: 1; }
    th, td { border-bottom: 1px solid #e5e7eb; padding: 10px 12px; text-align: left; vertical-align: top; font-size: 13px; }
    th { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: #374151; }
    td:nth-child(4) { white-space: pre-wrap; min-width: 420px; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    @media print {
      body { padding: 0; background: #fff; }
      .table-wrap { border: 0; border-radius: 0; }
      thead th { position: static; }
    }
  </style>
</head>
<body>
  <h1>ElevenLabs Calls Export</h1>
  <div class="meta">Generated UTC: ${escapeHtml(new Date().toISOString())} | Filter agent_id: ${escapeHtml(agentId || 'all')} | Rows: ${exportRows.length}</div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Customer Number</th>
          <th>Date</th>
          <th>Time</th>
          <th>Summary</th>
          <th>Status</th>
          <th>Agent</th>
          <th>Conversation ID</th>
        </tr>
      </thead>
      <tbody>
${htmlRows}
      </tbody>
    </table>
  </div>
</body>
</html>`;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.html"`);
        res.setHeader('Cache-Control', 'no-store');
        const end_ts = nowIso();
        const latency_ms = Date.now() - start;
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'GET /api/elevenlabs/calls/export',
            start_ts,
            end_ts,
            latency_ms,
            status: 200,
            metadata: { format, agent_id: agentId || null, row_count: exportRows.length },
        });
        return res.send(html);
    } catch (e) {
        const end_ts = nowIso();
        const latency_ms = Date.now() - start;
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'GET /api/elevenlabs/calls/export',
            start_ts,
            end_ts,
            latency_ms,
            status: 500,
            error: 'elevenlabs_calls_export_failed',
            metadata: { format, agent_id: agentId || null, error: String(e?.message || e) },
        });
        res.setHeader('x-error', 'elevenlabs_calls_export_failed');
        return res.status(500).json({ error: 'elevenlabs_calls_export_failed' });
    }
});

app.get('/api/elevenlabs/calls/:conversationId', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    const conversationId = String(req.params.conversationId || '').trim();
    if (!conversationId) return res.status(400).json({ error: 'missing_conversation_id' });
    try {
        const convo = await pool.query(
            `SELECT conversation_id, agent_id, call_status, call_successful, direction,
                    COALESCE(started_at, imported_at) AS date,
                    customer_number, COALESCE(transcript_summary, overview_summary, '') AS transcript_summary,
                    COALESCE(call_summary_title, '') AS call_summary_title,
                    message_count, call_duration_secs, imported_at, updated_at,
                    COALESCE(user_id, customer_number) AS user_id, audio_url, recording_url, overview_summary, call_cost
             FROM elevenlabs_conversations
             WHERE conversation_id = $1
             LIMIT 1`,
            [conversationId]
        );
        if (convo.rowCount === 0) {
            res.setHeader('x-error', 'elevenlabs_call_not_found');
            return res.status(404).json({ error: 'elevenlabs_call_not_found' });
        }
        const transcriptRows = await pool.query(
            `SELECT role, message, time_value
             FROM elevenlabs_conversation_messages
             WHERE conversation_id = $1
             ORDER BY message_id ASC`,
            [conversationId]
        );
        const row = convo.rows[0];
        const payload = {
            ...row,
            call_successful: row.call_successful === true,
            transcript: (transcriptRows.rows || []).map((m) => ({
                role: m.role || 'speaker',
                message: m.message || '',
                time: m.time_value,
            })),
            summary: firstNonEmptyString(row.transcript_summary, row.overview_summary) || '',
        };
        const end_ts = nowIso();
        const latency_ms = Date.now() - start;
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: `GET /api/elevenlabs/calls/${conversationId}`,
            start_ts,
            end_ts,
            latency_ms,
            status: 200,
            metadata: { conversation_id: conversationId, transcript_count: payload.transcript.length },
        });
        return res.json(payload);
    } catch (e) {
        const end_ts = nowIso();
        const latency_ms = Date.now() - start;
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: `GET /api/elevenlabs/calls/${conversationId}`,
            start_ts,
            end_ts,
            latency_ms,
            status: 500,
            error: 'elevenlabs_call_fetch_failed',
            metadata: { conversation_id: conversationId, error: String(e?.message || e) },
        });
        res.setHeader('x-error', 'elevenlabs_call_fetch_failed');
        return res.status(500).json({ error: 'elevenlabs_call_fetch_failed' });
    }
});

app.get('/api/elevenlabs/search/history', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    const scope = buildSearchScope(req);
    const limit = Math.min(15, Math.max(1, parsePositiveInt(req.query.limit, 15)));
    try {
        const rows = await pool.query(
            `SELECT id, query_text, comparison_mode, result_count, metadata, created_at
             FROM elevenlabs_search_history
             WHERE scope_key = $1
             ORDER BY created_at DESC
             LIMIT $2`,
            [scope.scope_key, limit]
        );
        const end_ts = nowIso();
        const latency_ms = Date.now() - start;
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'GET /api/elevenlabs/search/history',
            start_ts,
            end_ts,
            latency_ms,
            status: 200,
            metadata: { scope_key: scope.scope_key, limit },
        });
        return res.json({ ok: true, rows: rows.rows || [] });
    } catch (e) {
        const end_ts = nowIso();
        const latency_ms = Date.now() - start;
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'GET /api/elevenlabs/search/history',
            start_ts,
            end_ts,
            latency_ms,
            status: 500,
            error: 'elevenlabs_search_history_failed',
            metadata: { error: String(e?.message || e) },
        });
        res.setHeader('x-error', 'elevenlabs_search_history_failed');
        return res.status(500).json({ error: 'elevenlabs_search_history_failed' });
    }
});

app.get('/api/elevenlabs/search/saved', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    const scope = buildSearchScope(req);
    try {
        const rows = await pool.query(
            `SELECT id, name, query_text, metadata, created_at, updated_at
             FROM elevenlabs_saved_searches
             WHERE scope_key = $1
             ORDER BY updated_at DESC, created_at DESC`,
            [scope.scope_key]
        );
        const end_ts = nowIso();
        const latency_ms = Date.now() - start;
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'GET /api/elevenlabs/search/saved',
            start_ts,
            end_ts,
            latency_ms,
            status: 200,
            metadata: { scope_key: scope.scope_key, count: rows.rowCount },
        });
        return res.json({ ok: true, rows: rows.rows || [] });
    } catch (e) {
        const end_ts = nowIso();
        const latency_ms = Date.now() - start;
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'GET /api/elevenlabs/search/saved',
            start_ts,
            end_ts,
            latency_ms,
            status: 500,
            error: 'elevenlabs_saved_searches_fetch_failed',
            metadata: { error: String(e?.message || e) },
        });
        res.setHeader('x-error', 'elevenlabs_saved_searches_fetch_failed');
        return res.status(500).json({ error: 'elevenlabs_saved_searches_fetch_failed' });
    }
});

app.post('/api/elevenlabs/search/saved', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    const scope = buildSearchScope(req);
    const queryText = String(req.body?.query || req.body?.query_text || '').trim();
    const nameRaw = String(req.body?.name || '').trim();
    const name = nameRaw || `Saved search ${new Date().toLocaleString('en-AU')}`;
    if (!queryText) return res.status(400).json({ error: 'missing_query' });
    try {
        const out = await pool.query(
            `INSERT INTO elevenlabs_saved_searches (user_id, scope_key, name, query_text, metadata, created_at, updated_at)
             VALUES ($1::uuid, $2, $3, $4, $5::jsonb, now(), now())
             RETURNING id, name, query_text, metadata, created_at, updated_at`,
            [scope.user_id, scope.scope_key, name, queryText, JSON.stringify({ comparison_mode: detectComparisonQuery(queryText) })]
        );
        const end_ts = nowIso();
        const latency_ms = Date.now() - start;
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/elevenlabs/search/saved',
            start_ts,
            end_ts,
            latency_ms,
            status: 201,
            metadata: { scope_key: scope.scope_key, saved_search_id: out.rows?.[0]?.id || null },
        });
        return res.status(201).json({ ok: true, row: out.rows[0] });
    } catch (e) {
        const end_ts = nowIso();
        const latency_ms = Date.now() - start;
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/elevenlabs/search/saved',
            start_ts,
            end_ts,
            latency_ms,
            status: 500,
            error: 'elevenlabs_saved_search_create_failed',
            metadata: { error: String(e?.message || e) },
        });
        res.setHeader('x-error', 'elevenlabs_saved_search_create_failed');
        return res.status(500).json({ error: 'elevenlabs_saved_search_create_failed' });
    }
});

app.delete('/api/elevenlabs/search/saved/:id', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    const scope = buildSearchScope(req);
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'missing_saved_search_id' });
    try {
        const out = await pool.query(
            `DELETE FROM elevenlabs_saved_searches
             WHERE id = $1::uuid AND scope_key = $2`,
            [id, scope.scope_key]
        );
        const end_ts = nowIso();
        const latency_ms = Date.now() - start;
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'DELETE /api/elevenlabs/search/saved/:id',
            start_ts,
            end_ts,
            latency_ms,
            status: 200,
            metadata: { scope_key: scope.scope_key, deleted: out.rowCount > 0, saved_search_id: id },
        });
        return res.json({ ok: true, deleted: out.rowCount > 0 });
    } catch (e) {
        const end_ts = nowIso();
        const latency_ms = Date.now() - start;
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'DELETE /api/elevenlabs/search/saved/:id',
            start_ts,
            end_ts,
            latency_ms,
            status: 500,
            error: 'elevenlabs_saved_search_delete_failed',
            metadata: { error: String(e?.message || e), saved_search_id: id },
        });
        res.setHeader('x-error', 'elevenlabs_saved_search_delete_failed');
        return res.status(500).json({ error: 'elevenlabs_saved_search_delete_failed' });
    }
});

async function resolveElevenLabsLlmRequestConfig(payload = {}) {
    const preferredModelUuid = String(payload?.model_uuid || '').trim();
    const llmOverride = payload?.llm_override && typeof payload.llm_override === 'object'
        ? payload.llm_override
        : null;
    const overrideModelId = String(llmOverride?.model_id || '').trim();
    const overrideBaseUrlRaw = String(llmOverride?.base_url || '').trim();
    const overrideApiKey = String(llmOverride?.api_key || '').trim();
    const overrideApiModeRaw = String(llmOverride?.api_mode || '').trim().toLowerCase();
    const hasLlmOverride = !!(overrideModelId || overrideBaseUrlRaw || overrideApiKey);
    if (hasLlmOverride && (!overrideModelId || !overrideBaseUrlRaw || !overrideApiKey)) {
        return {
            ok: false,
            status: 400,
            error: 'invalid_llm_override',
            hint: 'Provide llm_override.model_id, llm_override.base_url, and llm_override.api_key.',
        };
    }
    const persistedLlm = await loadDashboardLlmConfig(preferredModelUuid);
    let llm = persistedLlm;
    if (hasLlmOverride) {
        const normalizedBaseUrl = resolveConfiguredOpenAiBaseUrl(overrideBaseUrlRaw);
        const overrideChatUrl = resolveOpenAiChatCompletionsUrl(overrideBaseUrlRaw);
        const overrideResponsesUrl = resolveOpenAiResponsesUrl(overrideBaseUrlRaw);
        if (!overrideChatUrl) {
            return {
                ok: false,
                status: 400,
                error: 'invalid_llm_override_base_url',
                hint: 'Provide an OpenAI-compatible base URL such as https://api.openai.com/v1',
            };
        }
        const settings = await getEngineSettings().catch(() => ({ config: {} }));
        const fallbackTokenPolicy = persistedLlm?.token_policy && typeof persistedLlm.token_policy === 'object'
            ? persistedLlm.token_policy
            : normalizeModelTokenPolicy({}, resolveLlmTokenPolicyDefaults(settings.config || {}));
        llm = {
            model_uuid: persistedLlm?.model_uuid || null,
            model_id: overrideModelId,
            base_url: normalizedBaseUrl,
            chat_url: overrideChatUrl,
            responses_url: overrideResponsesUrl,
            api_mode: resolveLlmApiMode({
                apiModeRaw: overrideApiModeRaw,
                baseUrl: normalizedBaseUrl,
                modelId: overrideModelId,
            }),
            api_key: overrideApiKey,
            token_policy: fallbackTokenPolicy,
        };
    }
    if (!llm) {
        return {
            ok: false,
            status: 503,
            error: 'dashboard_llm_not_configured',
        };
    }
    return {
        ok: true,
        llm,
        hasLlmOverride,
    };
}

app.post('/api/elevenlabs/search', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    const scope = buildSearchScope(req);
    const query = String(req.body?.query || '').trim();
    const agentId = String(req.body?.agent_id || '').trim();
    const maxCandidates = Math.min(120, Math.max(20, parsePositiveInt(req.body?.candidate_limit, 80)));
    if (!query) return res.status(400).json({ error: 'missing_query' });
    const comparisonMode = detectComparisonQuery(query);
    const queryRange = extractDateRangeFromQuery(query);
    const fromIso = toIsoOrNull(req.body?.from_date) || queryRange.fromIso;
    const toIso = toIsoOrNull(req.body?.to_date) || queryRange.toIso;
    try {
        const llmConfig = await resolveElevenLabsLlmRequestConfig(req.body || {});
        if (!llmConfig.ok) {
            res.setHeader('x-error', llmConfig.error);
            return res.status(llmConfig.status || 500).json({
                error: llmConfig.error || 'elevenlabs_llm_config_failed',
                ...(llmConfig.hint ? { hint: llmConfig.hint } : {}),
            });
        }
        const llm = llmConfig.llm;
        const hasLlmOverride = llmConfig.hasLlmOverride === true;
        const candidatesQ = await pool.query(
            `SELECT
               c.conversation_id,
               c.agent_id,
               COALESCE(c.agent_name, c.agent_id, 'Unknown Agent') AS agent_name,
               COALESCE(c.user_id, c.customer_number) AS customer,
               c.customer_number,
               c.call_status,
               c.call_successful,
               COALESCE(c.started_at, c.imported_at) AS started_at,
               COALESCE(c.transcript_summary, c.overview_summary, '') AS summary,
               c.call_summary_title,
               c.call_cost,
               COALESCE(msg.transcript_text, '') AS transcript_text
             FROM elevenlabs_conversations c
             LEFT JOIN LATERAL (
                SELECT string_agg(COALESCE(mm.role, 'speaker') || ': ' || COALESCE(mm.message, ''), E'\\n' ORDER BY mm.message_id) AS transcript_text
                FROM (
                  SELECT message_id, role, message
                  FROM elevenlabs_conversation_messages m
                  WHERE m.conversation_id = c.conversation_id
                  ORDER BY message_id ASC
                  LIMIT 30
                ) mm
             ) msg ON true
             WHERE ($1::text = '' OR c.agent_id = $1)
               AND ($2::timestamptz IS NULL OR COALESCE(c.started_at, c.imported_at) >= $2::timestamptz)
               AND ($3::timestamptz IS NULL OR COALESCE(c.started_at, c.imported_at) <= $3::timestamptz)
             ORDER BY COALESCE(c.started_at, c.imported_at) DESC
             LIMIT $4`,
            [agentId, fromIso, toIso, maxCandidates]
        );
        const candidates = (candidatesQ.rows || []).map((r) => ({
            conversation_id: r.conversation_id,
            customer: r.customer || null,
            agent_id: r.agent_id || null,
            agent_name: r.agent_name || null,
            started_at: r.started_at,
            call_status: r.call_status || null,
            summary: String(r.summary || ''),
            transcript_excerpt: String(r.transcript_text || '').slice(0, 1800),
            call_summary_title: r.call_summary_title || null,
        }));
        const searchPrompt = [
            'You are an expert call-quality analyst for support calls.',
            'Analyze the user query and identify calls matching it.',
            'Return STRICT JSON only with this schema:',
            '{"comparison_mode":boolean,"matches":[{"conversation_id":string,"score":number,"bucket":"negative|positive|neutral","reason":string}]}',
            'Rules:',
            '- Use score between 0 and 1.',
            '- For non-comparison queries, use bucket "neutral" unless clear positive/negative sentiment is central.',
            '- If comparison query (vs/versus), bucket negative cohort as "negative" and other cohort as "positive".',
            '- Only include genuinely matched calls.',
        ].join('\n');
        const llmReqBody = {
            model: llm.model_id,
            temperature: 0.1,
            max_tokens: 2048,
            messages: [
                { role: 'system', content: searchPrompt },
                {
                    role: 'user',
                    content: JSON.stringify({
                        query,
                        comparison_mode_hint: comparisonMode,
                        date_range: { from: fromIso, to: toIso },
                        calls: candidates,
                    }),
                },
            ],
        };
        const upstreamStart = Date.now();
        const llmResult = await callConfiguredLlm({
            llm,
            trace_id,
            route: 'POST /api/elevenlabs/search',
            body: llmReqBody,
        });
        const upstreamBody = llmResult.upstream_body || {};
        const upstreamLatency = Date.now() - upstreamStart;
        if (!llmResult.ok) {
            const end_ts = nowIso();
            await insertRequestLogRow({
                trace_id,
                span_id,
                route: 'POST /api/elevenlabs/search',
                start_ts,
                end_ts,
                latency_ms: Date.now() - start,
                status: llmResult.status || 502,
                error: 'elevenlabs_search_llm_failed',
                metadata: {
                    scope_key: scope.scope_key,
                    query,
                    comparison_mode: comparisonMode,
                    candidate_count: candidates.length,
                    model_id: llm.model_id,
                    llm_override: hasLlmOverride,
                    llm_upstream_status: llmResult.status || null,
                    llm_upstream_latency_ms: upstreamLatency,
                    token_policy: llmResult.token_policy,
                },
            });
            res.setHeader('x-error', 'elevenlabs_search_llm_failed');
            return res.status(llmResult.status || 502).json({
                error: llmResult.error || 'elevenlabs_search_llm_failed',
                message: llmResult.message || 'LLM search failed',
                token_policy: llmResult.token_policy,
            });
        }
        const llmText = extractLlmText(upstreamBody);
        const parsed = parseJsonFromLlmText(llmText) || {};
        const rawMatches = Array.isArray(parsed.matches) ? parsed.matches : [];
        const matchById = new Map();
        for (const m of rawMatches) {
            const id = String(m?.conversation_id || '').trim();
            if (!id) continue;
            matchById.set(id, {
                score: Number.isFinite(Number(m?.score)) ? Number(m.score) : 0,
                bucket: ['negative', 'positive', 'neutral'].includes(String(m?.bucket || '').toLowerCase())
                    ? String(m.bucket || '').toLowerCase()
                    : 'neutral',
                reason: firstNonEmptyString(m?.reason) || '',
            });
        }
        const matchedRows = (candidatesQ.rows || [])
            .filter((row) => matchById.has(String(row.conversation_id)))
            .map((row) => {
                const m = matchById.get(String(row.conversation_id));
                return {
                    conversation_id: row.conversation_id,
                    session_id: row.conversation_id,
                    agent_id: row.agent_id,
                    agent_name: row.agent_name,
                    customer_number: row.customer_number,
                    user_id: row.customer,
                    call_status: row.call_status,
                    success: row.call_successful,
                    status: row.call_successful === true ? 200 : row.call_successful === false ? 409 : null,
                    date: row.started_at,
                    time: row.started_at,
                    overview_summary: row.summary || '',
                    transcript_summary: row.summary || '',
                    call_summary_title: row.call_summary_title || null,
                    call_cost: row.call_cost,
                    llm_match_score: m?.score ?? 0,
                    llm_bucket: m?.bucket || 'neutral',
                    llm_reason: m?.reason || '',
                };
            })
            .sort((a, b) => Number(b.llm_match_score || 0) - Number(a.llm_match_score || 0));
        await pool.query(
            `INSERT INTO elevenlabs_search_history (user_id, scope_key, query_text, comparison_mode, result_count, metadata, created_at)
             VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, now())`,
            [
                scope.user_id,
                scope.scope_key,
                query,
                comparisonMode,
                matchedRows.length,
                JSON.stringify({
                    from_date: fromIso,
                    to_date: toIso,
                    candidate_count: candidates.length,
                    model_id: llm.model_id,
                    llm_override: hasLlmOverride,
                    upstream_latency_ms: upstreamLatency,
                    token_policy: llmResult.token_policy,
                }),
            ]
        );
        await pool.query(
            `DELETE FROM elevenlabs_search_history
             WHERE scope_key = $1
               AND id NOT IN (
                 SELECT id FROM elevenlabs_search_history
                 WHERE scope_key = $1
                 ORDER BY created_at DESC
                 LIMIT 15
               )`,
            [scope.scope_key]
        );
        const end_ts = nowIso();
        const latency_ms = Date.now() - start;
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/elevenlabs/search',
            start_ts,
            end_ts,
            latency_ms,
            status: 200,
            metadata: {
                scope_key: scope.scope_key,
                query,
                comparison_mode: comparisonMode,
                candidate_count: candidates.length,
                match_count: matchedRows.length,
                model_id: llm.model_id,
                llm_override: hasLlmOverride,
                llm_upstream_status: llmResult.status,
                llm_upstream_latency_ms: upstreamLatency,
                token_policy: llmResult.token_policy,
            },
        });
        return res.json({
            ok: true,
            comparison_mode: parsed.comparison_mode === true || comparisonMode,
            from_date: fromIso,
            to_date: toIso,
            candidates_considered: candidates.length,
            matched_count: matchedRows.length,
            rows: matchedRows,
            model_id: llm.model_id,
            llm_override: hasLlmOverride,
            token_policy: llmResult.token_policy,
            token_policy_notice: llmResult.token_policy_notice,
        });
    } catch (e) {
        const end_ts = nowIso();
        const latency_ms = Date.now() - start;
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/elevenlabs/search',
            start_ts,
            end_ts,
            latency_ms,
            status: 500,
            error: 'elevenlabs_search_failed',
            metadata: { error: String(e?.message || e), query },
        });
        res.setHeader('x-error', 'elevenlabs_search_failed');
        return res.status(500).json({ error: 'elevenlabs_search_failed', message: String(e?.message || e) });
    }
});

app.post('/api/elevenlabs/llm/test', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    try {
        const llmConfig = await resolveElevenLabsLlmRequestConfig(req.body || {});
        if (!llmConfig.ok) {
            const end_ts = nowIso();
            const latency_ms = Date.now() - start;
            await insertRequestLogRow({
                trace_id,
                span_id,
                route: 'POST /api/elevenlabs/llm/test',
                start_ts,
                end_ts,
                latency_ms,
                status: llmConfig.status || 500,
                error: llmConfig.error || 'elevenlabs_llm_test_failed',
                metadata: { llm_override: req.body?.llm_override ? true : false },
            });
            res.setHeader('x-error', llmConfig.error || 'elevenlabs_llm_test_failed');
            return res.status(llmConfig.status || 500).json({
                error: llmConfig.error || 'elevenlabs_llm_test_failed',
                ...(llmConfig.hint ? { hint: llmConfig.hint } : {}),
            });
        }
        const llm = llmConfig.llm;
        const hasLlmOverride = llmConfig.hasLlmOverride === true;
        const upstreamStart = Date.now();
        const llmResult = await callConfiguredLlm({
            llm,
            trace_id,
            route: 'POST /api/elevenlabs/llm/test',
            body: {
                model: llm.model_id,
                temperature: 0,
                max_tokens: 64,
                messages: [
                    { role: 'system', content: 'Return exactly: OK' },
                    { role: 'user', content: 'connection test' },
                ],
            },
        });
        const upstreamLatency = Date.now() - upstreamStart;
        if (!llmResult.ok) {
            const end_ts = nowIso();
            const latency_ms = Date.now() - start;
            await insertRequestLogRow({
                trace_id,
                span_id,
                route: 'POST /api/elevenlabs/llm/test',
                start_ts,
                end_ts,
                latency_ms,
                status: llmResult.status || 502,
                error: 'elevenlabs_llm_test_failed',
                metadata: {
                    model_id: llm.model_id,
                    llm_override: hasLlmOverride,
                    llm_upstream_status: llmResult.status || null,
                    llm_upstream_latency_ms: upstreamLatency,
                    token_policy: llmResult.token_policy,
                },
            });
            res.setHeader('x-error', 'elevenlabs_llm_test_failed');
            return res.status(llmResult.status || 502).json({
                ok: false,
                error: llmResult.error || 'elevenlabs_llm_test_failed',
                message: llmResult.message || 'LLM connection test failed',
                model_id: llm.model_id,
                llm_override: hasLlmOverride,
                token_policy: llmResult.token_policy,
            });
        }
        const upstreamBody = llmResult.upstream_body || {};
        const replyText = extractLlmText(upstreamBody);
        const end_ts = nowIso();
        const latency_ms = Date.now() - start;
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/elevenlabs/llm/test',
            start_ts,
            end_ts,
            latency_ms,
            status: 200,
            metadata: {
                model_id: llm.model_id,
                llm_override: hasLlmOverride,
                llm_upstream_status: llmResult.status || 200,
                llm_upstream_latency_ms: upstreamLatency,
                token_policy: llmResult.token_policy,
            },
        });
        return res.json({
            ok: true,
            model_id: llm.model_id,
            llm_override: hasLlmOverride,
            upstream_latency_ms: upstreamLatency,
            message: replyText ? String(replyText).slice(0, 80) : 'OK',
            token_policy_notice: llmResult.token_policy_notice,
        });
    } catch (e) {
        const end_ts = nowIso();
        const latency_ms = Date.now() - start;
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/elevenlabs/llm/test',
            start_ts,
            end_ts,
            latency_ms,
            status: 500,
            error: 'elevenlabs_llm_test_failed',
            metadata: { error: String(e?.message || e) },
        });
        res.setHeader('x-error', 'elevenlabs_llm_test_failed');
        return res.status(500).json({ error: 'elevenlabs_llm_test_failed', message: String(e?.message || e) });
    }
});

app.post('/api/elevenlabs/summarize-missing', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const start = Date.now();
    const start_ts = nowIso();
    const agentId = String(req.body?.agent_id || '').trim();
    const limit = Math.min(500, Math.max(1, parsePositiveInt(req.body?.limit, 200)));
    try {
        const llmConfig = await resolveElevenLabsLlmRequestConfig(req.body || {});
        if (!llmConfig.ok) {
            res.setHeader('x-error', llmConfig.error);
            return res.status(llmConfig.status || 500).json({
                error: llmConfig.error || 'elevenlabs_llm_config_failed',
                ...(llmConfig.hint ? { hint: llmConfig.hint } : {}),
            });
        }
        const llm = llmConfig.llm;
        const hasLlmOverride = llmConfig.hasLlmOverride === true;
        const missingQ = await pool.query(
            `SELECT conversation_id, COALESCE(user_id, customer_number) AS user_id, agent_id
             FROM elevenlabs_conversations
             WHERE ($1::text = '' OR agent_id = $1)
               AND (transcript_summary IS NULL OR btrim(transcript_summary) = '')
             ORDER BY COALESCE(started_at, imported_at) DESC
             LIMIT $2`,
            [agentId, limit]
        );
        let processed = 0;
        let summarized = 0;
        const errors = [];
        for (const row of missingQ.rows || []) {
            processed += 1;
            const transcriptRows = await pool.query(
                `SELECT role, message, time_value
                 FROM elevenlabs_conversation_messages
                 WHERE conversation_id = $1
                 ORDER BY message_id ASC
                 LIMIT 600`,
                [row.conversation_id]
            );
            const transcriptText = (transcriptRows.rows || [])
                .map((m) => `[${String(m.role || 'speaker')}] ${String(m.message || '').trim()}`)
                .filter(Boolean)
                .join('\n')
                .slice(0, 24000);
            if (!transcriptText) continue;
            try {
                const llmResult = await callConfiguredLlm({
                    llm,
                    trace_id,
                    route: 'POST /api/elevenlabs/summarize-missing',
                    body: {
                        model: llm.model_id,
                        temperature: 0,
                        max_tokens: 2048,
                        messages: [
                            {
                                role: 'system',
                                content: [
                                    'You are a senior call-audit analyst.',
                                    'Write a complete and detailed operator-grade summary of this conversation.',
                                    'Output MUST be plain text only and use the exact section headers below:',
                                    '1) Call Objective',
                                    '2) Customer Details Captured',
                                    '3) Timeline of Conversation',
                                    '4) Questions Asked by Customer',
                                    '5) Actions Taken by Agent',
                                    '6) Outcome and Resolution Status',
                                    '7) Escalations, Transfers, or Follow-ups Required',
                                    '8) Risks, Compliance, and Data Quality Notes',
                                    '9) Key Facts and Identifiers',
                                    '',
                                    'Rules:',
                                    '- Be specific and factual; do not invent details.',
                                    '- If something is missing, explicitly write \"Not captured\".',
                                    '- Include important names, phone numbers, booking/order/job references, addresses, dates, times, and promised callbacks if present.',
                                    '- Timeline should be step-by-step and cover the full call flow.',
                                    '- Keep concise but complete; target 180-400 words.',
                                ].join('\n'),
                            },
                            {
                                role: 'user',
                                content: [
                                    `Conversation ID: ${row.conversation_id}`,
                                    `User ID: ${row.user_id || 'unknown'}`,
                                    '',
                                    'Transcript:',
                                    transcriptText,
                                ].join('\n'),
                            },
                        ],
                    },
                });
                const upstreamBody = llmResult.upstream_body || {};
                if (!llmResult.ok) {
                    const authDenied = [401, 403].includes(Number(llmResult.status || 0));
                    errors.push({
                        conversation_id: row.conversation_id,
                        error: authDenied
                            ? 'LLM provider rejected credentials (401/403) during summarization.'
                            : (llmResult.message || 'LLM summarization failed'),
                    });
                    continue;
                }
                const summaryText = extractLlmTextFromUpstreamBody(upstreamBody) || null;
                if (!summaryText) continue;
                await pool.query(
                    `UPDATE elevenlabs_conversations
                     SET transcript_summary = $2,
                         updated_at = now()
                     WHERE conversation_id = $1`,
                    [row.conversation_id, summaryText]
                );
                summarized += 1;
            } catch (e) {
                errors.push({ conversation_id: row.conversation_id, error: String(e?.message || e) });
            }
        }
        const end_ts = nowIso();
        const latency_ms = Date.now() - start;
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/elevenlabs/summarize-missing',
            start_ts,
            end_ts,
            latency_ms,
            status: 200,
            error: errors.length > 0 ? 'partial_errors' : null,
            metadata: {
                processed,
                summarized,
                skipped: Math.max(0, processed - summarized),
                error_count: errors.length,
                model_id: llm.model_id,
                llm_override: hasLlmOverride,
                agent_id: agentId || null,
                token_policy: llm.token_policy,
            },
        });
        return res.json({
            ok: true,
            processed,
            summarized,
            skipped: Math.max(0, processed - summarized),
            model_id: llm.model_id,
            llm_override: hasLlmOverride,
            errors: errors.slice(0, 20),
        });
    } catch (e) {
        const end_ts = nowIso();
        const latency_ms = Date.now() - start;
        await insertRequestLogRow({
            trace_id,
            span_id,
            route: 'POST /api/elevenlabs/summarize-missing',
            start_ts,
            end_ts,
            latency_ms,
            status: 500,
            error: 'elevenlabs_summarize_failed',
            metadata: { error: String(e?.message || e), agent_id: agentId || null },
        });
        res.setHeader('x-error', 'elevenlabs_summarize_failed');
        return res.status(500).json({ error: 'elevenlabs_summarize_failed', message: String(e?.message || e) });
    }
});

const HUBTIGER_PROXY_URL = (process.env.HUBTIGER_PROXY_URL || process.env.HUBTIGER_URL || '').replace(/\/$/, '');
const HUBTIGER_MCP_URL = (process.env.HUBTIGER_MCP_URL || '').replace(/\/$/, '');
const ELEVENLABS_API_KEY = String(process.env.ELEVENLABS_API_KEY || '').trim();
const ELEVENLABS_API_BASE_URL = String(process.env.ELEVENLABS_API_BASE_URL || 'https://api.elevenlabs.io').trim().replace(/\/$/, '');

async function elevenlabsFetchJson(path, { query = {}, timeoutMs = 20000 } = {}) {
    const url = `${ELEVENLABS_API_BASE_URL}${path}${buildQuery(query)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const resp = await fetch(url, {
            method: 'GET',
            headers: {
                'xi-api-key': ELEVENLABS_API_KEY,
                Accept: 'application/json',
            },
            signal: controller.signal,
        });
        const data = await resp.json().catch(() => null);
        return { ok: resp.ok, status: resp.status, data };
    } catch (e) {
        return { ok: false, status: 0, data: { error: String(e?.message || e) } };
    } finally {
        clearTimeout(timer);
    }
}

async function fetchElevenlabsConversationDetail(conversationId) {
    const primary = await elevenlabsFetchJson(`/v1/convai/conversations/${encodeURIComponent(conversationId)}`);
    if (primary.ok && primary.data) return primary.data;
    const fallback = await elevenlabsFetchJson(`/v1/convai/conversation/${encodeURIComponent(conversationId)}`);
    return fallback.ok && fallback.data ? fallback.data : null;
}

async function fetchElevenlabsConversationAux(conversationId) {
    const [audioA, audioB, tokensA, tokensB] = await Promise.all([
        elevenlabsFetchJson(`/v1/convai/conversations/${encodeURIComponent(conversationId)}/audio`),
        elevenlabsFetchJson(`/v1/convai/conversations/${encodeURIComponent(conversationId)}/recording`),
        elevenlabsFetchJson(`/v1/convai/conversations/${encodeURIComponent(conversationId)}/tokens`),
        elevenlabsFetchJson(`/v1/convai/conversations/${encodeURIComponent(conversationId)}/usage`),
    ]);
    const audio = (audioA.ok && audioA.data) ? audioA.data : ((audioB.ok && audioB.data) ? audioB.data : null);
    const tokens = (tokensA.ok && tokensA.data) ? tokensA.data : ((tokensB.ok && tokensB.data) ? tokensB.data : null);
    return { audio, tokens };
}

function mergeConversationPayload(basePayload, detailPayload, auxPayload) {
    const base = safeJson(basePayload, {});
    const detail = safeJson(detailPayload, {});
    const audio = safeJson(auxPayload?.audio, {});
    const tokens = safeJson(auxPayload?.tokens, {});
    const merged = { ...base, ...detail };
    if (Object.keys(audio).length > 0) merged.audio = audio;
    if (Object.keys(tokens).length > 0 && !merged.usage) merged.usage = tokens;
    if (Object.keys(tokens).length > 0) merged.tokens = tokens;
    return merged;
}

function detectAmbiguousKnowledgeQuery(query, context = {}) {
    const raw = String(query || '').trim();
    if (!raw) {
        return { ambiguous: true, reason: 'missing_query', matched_token: null };
    }
    const q = raw.toLowerCase();
    const tokens = q.split(/\s+/).filter(Boolean);
    const matchedToken = q.match(/\b(this|that|it|thing|stuff)\b/);
    const hasExplicitScope = Boolean(firstNonEmptyString(
        context?.collection_name,
        context?.index_id,
        context?.agent_id,
        context?.document_id,
        context?.query_scope
    ));
    const skipClarification = context?.skip_clarification === true;
    if (skipClarification) {
        return { ambiguous: false, reason: 'skip_clarification', matched_token: matchedToken?.[1] || null };
    }
    if (hasExplicitScope && (raw.length >= 32 || tokens.length >= 6)) {
        return { ambiguous: false, reason: 'explicit_scope', matched_token: matchedToken?.[1] || null };
    }
    if (raw.length >= 80 || tokens.length >= 12) {
        return { ambiguous: false, reason: 'long_form_query', matched_token: matchedToken?.[1] || null };
    }
    if (raw.length < 12) {
        return { ambiguous: true, reason: 'too_short', matched_token: matchedToken?.[1] || null };
    }
    if (matchedToken && tokens.length <= 6 && !hasExplicitScope) {
        return { ambiguous: true, reason: 'underspecified_reference', matched_token: matchedToken[1] };
    }
    return { ambiguous: false, reason: 'sufficiently_specific', matched_token: matchedToken?.[1] || null };
}
function classifyKnowledgeRetrievalMode(query) {
    const q = String(query || '').toLowerCase();
    if (/\b(affect|impact|relationship|between|branch|location|policy|employee|vs|versus)\b/.test(q)) return 'graph';
    if (/\b(and|or|both|compare)\b/.test(q)) return 'hybrid';
    return 'vector';
}
async function fetchSqlKnowledgeCandidates(query, limit = 20) {
    const q = String(query || '').trim();
    if (!q) return [];
    const tokens = q.toLowerCase().split(/\s+/).map((t) => t.trim()).filter((t) => t.length >= 3).slice(0, 8);
    const sql = await pool.query(
        `SELECT id::text AS ref_id,
                title,
                LEFT(content, 1800) AS snippet,
                tags::text AS meta
         FROM knowledge_entries
         WHERE (
                title ILIKE '%' || $1 || '%'
             OR content ILIKE '%' || $1 || '%'
             OR tags::text ILIKE '%' || $1 || '%'
             OR EXISTS (
                    SELECT 1
                    FROM unnest($3::text[]) tok
                    WHERE title ILIKE '%' || tok || '%'
                       OR content ILIKE '%' || tok || '%'
                       OR tags::text ILIKE '%' || tok || '%'
                )
         )
           AND NOT (
                lower(title) LIKE 'r&d correction:%'
             OR lower(content) LIKE '%the model /model does not exist%'
             OR tags::text ILIKE '%rd_engine%'
           )
         ORDER BY created_at DESC
         LIMIT $2`,
        [q, limit, tokens]
    );
    return (sql.rows || []).map((row, index) => ({
        source: 'sql',
        ref_id: row.ref_id || `sql-${index}`,
        title: String(row.title || 'Knowledge entry'),
        snippet: String(row.snippet || ''),
        score: Math.max(0.1, 0.7 - index * 0.02),
        metadata: { tags: row.meta || null },
    }));
}
async function resolveKnowledgeVectorCollections(limit = 3) {
    const names = [];
    const seen = new Set();
    try {
        const jobs = await pool.query(
            `SELECT options
             FROM ingestion_jobs
             WHERE status = 'completed'
             ORDER BY updated_at DESC NULLS LAST, created_at DESC
             LIMIT 40`
        );
        for (const row of jobs.rows || []) {
            const options = row?.options && typeof row.options === 'object' ? row.options : {};
            const candidate = String(options.collection_name || '').trim();
            if (!candidate) continue;
            if (seen.has(candidate)) continue;
            seen.add(candidate);
            names.push(candidate);
            if (names.length >= limit) return names;
        }
    }
    catch {
        // Fall through to Qdrant collection probe.
    }
    try {
        const all = await qdrantRequest('/collections', 'GET');
        const collections = Array.isArray(all?.result?.collections) ? all.result.collections : [];
        for (const item of collections) {
            const candidate = String(item?.name || '').trim();
            if (!candidate) continue;
            if (seen.has(candidate)) continue;
            seen.add(candidate);
            names.push(candidate);
            if (names.length >= limit) break;
        }
    }
    catch {
        // Keep defaults on failure.
    }
    if (!names.includes('knowledge_base')) names.push('knowledge_base');
    return names.slice(0, limit);
}
async function fetchVectorKnowledgeCandidates(query, collectionName = 'knowledge_base', limit = 40) {
    const q = String(query || '').trim();
    if (!q) return [];
    try {
        const collection = await qdrantRequest(`/collections/${collectionName}`, 'GET');
        const vectorSize = Number(collection?.result?.config?.params?.vectors?.size || 1536) || 1536;
        const embedding = await createEmbeddingVector(q, vectorSize);
        const points = await qdrantRequest(`/collections/${collectionName}/points/search`, 'POST', {
            vector: embedding.vector,
            limit,
            with_payload: true,
            score_threshold: 0.0,
        });
        const rows = Array.isArray(points?.result) ? points.result : [];
        return rows.map((row, index) => ({
            source: 'vector',
            ref_id: String(row?.id || `vec-${index}`),
            title: String(row?.payload?.filename || row?.payload?.title || 'Vector snippet'),
            snippet: String(row?.payload?.content || '').slice(0, 1800),
            score: Number(row?.score || 0),
            metadata: {
                collection: collectionName,
                chunk_index: row?.payload?.chunk_index ?? null,
                document_id: row?.payload?.document_id ?? null,
            },
        }));
    }
    catch {
        return [];
    }
}
async function fetchChunkKnowledgeCandidates(query, limit = 20, collectionName = '') {
    const q = String(query || '').trim();
    if (!q) return [];
    const tokens = q.toLowerCase().split(/\s+/).map((t) => t.trim()).filter((t) => t.length >= 3).slice(0, 8);
    const cleanCollectionName = String(collectionName || '').trim();
    const asksForFinanceLedgers = /\b(xlsx|excel|ledger|p&l|profit|loss|financial|balance\s*sheet|journal)\b/i.test(q);
    const sql = await pool.query(
        `WITH matched AS (
            SELECT c.id::text AS ref_id,
                   d.original_filename AS title,
                   LEFT(c.content, 1800) AS snippet,
                   c.metadata::text AS meta,
                   c.created_at,
                   (
                       CASE WHEN d.original_filename ILIKE '%' || $1 || '%' THEN 5 ELSE 0 END
                     + CASE WHEN c.content ILIKE '%' || $1 || '%' THEN 3 ELSE 0 END
                     + COALESCE((
                         SELECT COUNT(*)
                         FROM unnest($3::text[]) tok
                         WHERE c.content ILIKE '%' || tok || '%'
                            OR d.original_filename ILIKE '%' || tok || '%'
                     ), 0)
                     + CASE WHEN $5::boolean = true AND d.original_filename ILIKE '%.xlsx' THEN 6 ELSE 0 END
                     + CASE WHEN $5::boolean = true AND d.original_filename ~* '(ledger|journal|profit|loss|pnl|balance|invoice|payment)' THEN 3 ELSE 0 END
                   )::int AS rank_score
            FROM document_chunks c
            INNER JOIN ingestion_jobs j ON j.id = c.job_id
            INNER JOIN ingestion_documents d ON d.id = c.document_id
            WHERE j.status = 'completed'
              AND ($4::text = '' OR COALESCE(j.options->>'collection_name', '') = $4::text)
              AND (
                   c.content ILIKE '%' || $1 || '%'
                OR d.original_filename ILIKE '%' || $1 || '%'
                OR EXISTS (
                       SELECT 1
                       FROM unnest($3::text[]) tok
                       WHERE c.content ILIKE '%' || tok || '%'
                          OR d.original_filename ILIKE '%' || tok || '%'
                   )
              )
        ), diversified AS (
            SELECT *,
                   ROW_NUMBER() OVER (PARTITION BY lower(title) ORDER BY rank_score DESC, created_at DESC) AS per_file_rank
            FROM matched
        )
        SELECT ref_id, title, snippet, meta, rank_score
        FROM diversified
        WHERE per_file_rank <= 2
        ORDER BY rank_score DESC, created_at DESC
        LIMIT $2`,
        [q, limit, tokens, cleanCollectionName, asksForFinanceLedgers]
    );
    return (sql.rows || []).map((row, index) => ({
        source: 'chunks',
        ref_id: row.ref_id || `chunk-${index}`,
        title: String(row.title || 'Ingested chunk'),
        snippet: String(row.snippet || ''),
        score: Number.isFinite(Number(row.rank_score))
            ? Math.max(0.12, 0.2 + Number(row.rank_score) / 20)
            : Math.max(0.12, 0.68 - index * 0.015),
        metadata: { chunk_meta: row.meta || null },
    }));
}
async function fetchGraphKnowledgeCandidates(query, limit = 20) {
    const entities = extractCandidateEntities(String(query || ''), 10);
    if (!entities.length) return [];
    const labels = entities.map((e) => String(e.label || '').toLowerCase());
    const rows = await pool.query(
        `SELECT e.id::text AS entity_id,
                e.label,
                e.entity_type,
                r.relation_type,
                e2.id::text AS linked_entity_id,
                e2.label AS linked_label,
                c.id::text AS chunk_id,
                LEFT(c.content, 1600) AS snippet
         FROM knowledge_entities e
         LEFT JOIN knowledge_relationships r ON r.source_entity_id = e.id
         LEFT JOIN knowledge_entities e2 ON e2.id = r.target_entity_id
         LEFT JOIN knowledge_chunk_entities ce ON ce.entity_id = e.id
         LEFT JOIN document_chunks c ON c.id = ce.chunk_id
         WHERE lower(e.label) = ANY($1::text[])
            OR EXISTS (
                SELECT 1
                FROM unnest($1::text[]) AS q
                WHERE lower(e.label) LIKE '%' || q || '%'
            )
         ORDER BY c.created_at DESC NULLS LAST
         LIMIT $2`,
        [labels, limit]
    );
    return (rows.rows || []).map((row, index) => ({
        source: 'graph',
        ref_id: row.chunk_id || row.entity_id || `graph-${index}`,
        title: `${row.label}${row.linked_label ? ` -> ${row.linked_label}` : ''}`,
        snippet: String(row.snippet || ''),
        score: 0.75 - index * 0.01,
        metadata: {
            entity_type: row.entity_type || null,
            relation_type: row.relation_type || null,
            linked_entity_id: row.linked_entity_id || null,
        },
    }));
}
async function rerankCandidatesWithCohere(query, candidates, config) {
    const ranked = Array.isArray(candidates) ? [...candidates] : [];
    const key = String(config?.cohere_rerank_api_key || '').trim();
    const enabled = config?.rerank_enabled !== false;
    if (!enabled || !key || ranked.length === 0) {
        return { rows: ranked.sort((a, b) => Number(b.score || 0) - Number(a.score || 0)), provider: null, latency_ms: 0, used: false };
    }
    const started = Date.now();
    try {
        const docs = ranked.map((item) => ({
            text: `${item.title || ''}\n${item.snippet || ''}`.trim().slice(0, 4000),
        }));
        const upstream = await fetch('https://api.cohere.com/v2/rerank', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${key}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: String(config?.rerank_model || 'rerank-v3.5'),
                query: String(query || ''),
                documents: docs,
                top_n: Math.min(25, docs.length),
            }),
        });
        const body = await upstream.json().catch(() => ({}));
        if (!upstream.ok || !Array.isArray(body?.results)) {
            throw new Error(String(body?.message || body?.error || 'rerank_failed'));
        }
        const byIndex = new Map();
        for (const item of body.results) {
            const idx = Number(item?.index);
            if (!Number.isFinite(idx) || idx < 0 || idx >= ranked.length) continue;
            byIndex.set(idx, Number(item?.relevance_score || 0));
        }
        const rescored = ranked.map((item, idx) => ({
            ...item,
            rerank_score: byIndex.has(idx) ? Number(byIndex.get(idx)) : null,
            score: byIndex.has(idx) ? Number(byIndex.get(idx)) : Number(item.score || 0),
        }));
        rescored.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
        return { rows: rescored, provider: 'cohere', latency_ms: Date.now() - started, used: true };
    }
    catch {
        ranked.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
        return { rows: ranked, provider: 'cohere', latency_ms: Date.now() - started, used: false };
    }
}

function extractPriorityPhrasesFromQuery(query = '') {
    const raw = String(query || '').trim();
    if (!raw) return [];
    const genericPhrases = new Set([
        'executive take',
        'what the data proves',
        'what the data suggests',
        'what remains unknown',
        'strategic implications',
        'recommended actions',
        'required next data',
        'risks and assumptions',
        'current australian climate',
    ]);
    const phrases = new Set();
    const capitalizedMatches = raw.match(/\b[A-Z][A-Za-z0-9&'.-]+(?:\s+[A-Z][A-Za-z0-9&'.-]+){1,3}\b/g) || [];
    for (const match of capitalizedMatches) {
        const phrase = String(match || '').trim().toLowerCase();
        if (!phrase || genericPhrases.has(phrase)) continue;
        phrases.add(phrase);
    }
    const domainMatches = raw.toLowerCase().match(/\b[a-z0-9.-]+\.[a-z]{2,}\b/g) || [];
    for (const match of domainMatches) phrases.add(String(match || '').trim());
    if (raw.toLowerCase().includes('ride electric')) phrases.add('ride electric');
    return Array.from(phrases).filter((phrase) => phrase.length >= 6).slice(0, 8);
}

function applyPriorityPhraseBoost(query = '', rows = []) {
    const phrases = extractPriorityPhrasesFromQuery(query);
    if (!phrases.length || !Array.isArray(rows) || rows.length === 0) return Array.isArray(rows) ? rows : [];
    const boosted = rows.map((row, index) => {
        const haystack = [
            String(row?.title || ''),
            String(row?.snippet || ''),
            row?.metadata ? JSON.stringify(row.metadata) : '',
        ].join('\n').toLowerCase();
        let boost = 0;
        for (const phrase of phrases) {
            if (!phrase) continue;
            if (haystack.includes(phrase)) {
                boost += phrase.includes('.') ? 0.5 : 0.38;
                continue;
            }
            const tokens = phrase.split(/\s+/).filter(Boolean);
            if (tokens.length >= 2 && tokens.every((token) => haystack.includes(token))) {
                boost += 0.2;
            }
        }
        if (boost <= 0) return { ...row, priority_phrase_boost: 0, priority_phrase_match: false };
        return {
            ...row,
            priority_phrase_boost: Math.round(boost * 1000) / 1000,
            priority_phrase_match: true,
            score: Number(row?.score || 0) + boost + Math.max(0, 0.03 - index * 0.001),
        };
    });
    boosted.sort((a, b) => {
        const diff = Number(b.score || 0) - Number(a.score || 0);
        if (diff !== 0) return diff;
        return Number(b.priority_phrase_boost || 0) - Number(a.priority_phrase_boost || 0);
    });
    return boosted;
}

async function callLlamaIndexRetrieve({ query, limit, mode, trace_id = '', parent_span_id = '', upstream_context = {} }) {
    const settings = await getEngineSettings();
    const knowledgeConfig = resolveKnowledgeStorageSettings(settings.config || {});
    const baseUrl = String(knowledgeConfig.llamaindex_url || '').trim().replace(/\/$/, '');
    if (!baseUrl) {
        return { ok: false, reason: 'llamaindex_not_configured', latency_ms: 0 };
    }
    const upstreamTraceId = parseTraceId(trace_id) || crypto.randomUUID();
    const span_id = crypto.randomUUID();
    const start_ts = nowIso();
    const started = Date.now();
    const timeoutMs = Math.max(15000, parsePositiveInt(process.env.LLAMAINDEX_QUERY_TIMEOUT_MS, 20000));
    let payload = null;
    let status = 0;
    let error = null;
    let usedEndpoint = '';
    try {
        const requestBody = {
            query: String(query || ''),
            limit: Math.max(1, Math.min(25, Number(limit) || 12)),
            mode: String(mode || ''),
            retrieval_context: upstream_context?.retrieval_context || {},
            graphrag_results: Array.isArray(upstream_context?.graphrag_results) ? upstream_context.graphrag_results : [],
            qdrant_hits: Array.isArray(upstream_context?.qdrant_hits) ? upstream_context.qdrant_hits : [],
            db_rows: Array.isArray(upstream_context?.db_rows) ? upstream_context.db_rows : [],
            response_style: String(upstream_context?.response_style || '').trim() || null,
            metadata: upstream_context?.metadata && typeof upstream_context.metadata === 'object' ? upstream_context.metadata : {},
        };
        const headers = {
            'Content-Type': 'application/json',
            'x-trace-id': upstreamTraceId,
            'x-span-id': span_id,
            ...(parent_span_id ? { 'x-parent-span-id': String(parent_span_id) } : {}),
            ...(knowledgeConfig.llamaindex_internal_key ? { 'X-Internal-Key': knowledgeConfig.llamaindex_internal_key } : {}),
        };
        const endpoints = [`${baseUrl}/orchestrate/query`, `${baseUrl}/orchestrate/retrieve`, `${baseUrl}/query`];
        let response = null;
        for (const endpoint of endpoints) {
            const candidate = await fetch(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify(requestBody),
                signal: AbortSignal.timeout(timeoutMs),
            });
            const candidatePayload = await candidate.json().catch(() => ({}));
            if ((candidate.status === 404 || candidate.status === 405) && endpoint !== endpoints[endpoints.length - 1]) {
                status = candidate.status;
                payload = candidatePayload;
                continue;
            }
            response = candidate;
            payload = candidatePayload;
            usedEndpoint = endpoint;
            break;
        }
        if (!response) {
            return { ok: false, reason: 'llamaindex_no_supported_endpoint', latency_ms: Date.now() - started };
        }
        status = response.status;
        const latency_ms = Date.now() - started;
        error = response.ok ? null : String(payload?.error || `llamaindex_status_${response.status}`);
        await insertRequestLogRow({
            trace_id: upstreamTraceId,
            span_id,
            route: 'POST /llamaindex/upstream-query',
            start_ts,
            end_ts: nowIso(),
            latency_ms,
            status,
            error,
            metadata: {
                upstream_service: 'llamaindex',
                upstream_url: usedEndpoint || `${baseUrl}/orchestrate/query`,
                mode: String(mode || ''),
                query_preview: String(query || '').slice(0, 120),
                timeout_ms: timeoutMs,
            },
        });
        const upstreamRows = Array.isArray(payload?.rows)
            ? payload.rows
            : Array.isArray(payload?.results)
                ? payload.results
                : Array.isArray(payload?.candidates)
                    ? payload.candidates
                    : Array.isArray(payload?.data?.rows)
                        ? payload.data.rows
                        : Array.isArray(payload?.data?.results)
                            ? payload.data.results
                            : Array.isArray(payload?.data?.candidates)
                                ? payload.data.candidates
                                : null;
        if (!response.ok || !payload) {
            return { ok: false, reason: error || 'llamaindex_invalid_response', latency_ms };
        }
        const safeRows = Array.isArray(upstreamRows) ? upstreamRows : [];
        return {
            ok: true,
            mode: payload?.mode || mode || 'hybrid',
            rows: safeRows,
            diagnostics: {
                ...(payload?.diagnostics || {}),
                upstream_result_count: Number(payload?.count || safeRows.length || 0),
                upstream_payload_has_rows: Array.isArray(upstreamRows),
                upstream_endpoint: usedEndpoint || null,
                upstream_status: status,
            },
            latency_ms,
        };
    } catch (err) {
        const latency_ms = Date.now() - started;
        const isTimeout = String(err?.name || '').toLowerCase().includes('abort')
            || String(err?.message || '').toLowerCase().includes('timeout');
        const reason = isTimeout ? 'llamaindex_timeout' : String(err?.message || err);
        await insertRequestLogRow({
            trace_id: upstreamTraceId,
            span_id,
            route: 'POST /llamaindex/upstream-query',
            start_ts,
            end_ts: nowIso(),
            latency_ms,
            status: 0,
            error: reason,
            metadata: {
                upstream_service: 'llamaindex',
                upstream_url: usedEndpoint || `${baseUrl}/orchestrate/query`,
                mode: String(mode || ''),
                timeout_ms: timeoutMs,
            },
        });
        return { ok: false, reason, latency_ms };
    }
}
async function runKnowledgeRetrieval({ query, limit = 12, mode = '', trace_id = '', span_id = '', upstream_context = {}, options = {} }) {
    const cleanQuery = String(query || '').trim();
    const retrievalMode = mode || classifyKnowledgeRetrievalMode(cleanQuery);
    const requestedCollection = firstNonEmptyString(
        upstream_context?.metadata?.index_id,
        upstream_context?.metadata?.collection_name,
        upstream_context?.index_id,
        upstream_context?.collection_name
    ) || '';
    const collectionFilter = String(requestedCollection || '').trim();
    const skipLlamaindex = options.skip_llamaindex === true;
    let llamaindexResult = {
        ok: false,
        reason: 'llamaindex_skipped_by_runtime',
        latency_ms: 0,
        rows: [],
        diagnostics: { skipped_by_runtime: true },
    };
    let llamaRows = [];
    if (!skipLlamaindex) {
        llamaindexResult = await callLlamaIndexRetrieve({
            query: cleanQuery,
            limit: Math.max(1, Math.min(100, Number(limit) || 12)),
            mode: retrievalMode,
            trace_id,
            parent_span_id: span_id,
            upstream_context,
        });
        llamaRows = Array.isArray(llamaindexResult.rows) ? llamaindexResult.rows : [];
        llamaRows = applyPriorityPhraseBoost(cleanQuery, llamaRows);
        if (llamaindexResult.ok && llamaRows.length > 0) {
            return {
                mode: llamaindexResult.mode || retrievalMode,
                rows: llamaRows.slice(0, Math.max(1, Math.min(100, limit))),
                diagnostics: {
                    ...(llamaindexResult.diagnostics || {}),
                    candidate_count: llamaRows.length,
                    orchestration_provider: 'llamaindex',
                    llamaindex_latency_ms: llamaindexResult.latency_ms,
                    degraded_mode: false,
                },
            };
        }
    }
    const settings = await getEngineSettings();
    const knowledgeConfig = resolveKnowledgeStorageSettings(settings.config || {});
    const vectorCollections = collectionFilter ? [collectionFilter] : await resolveKnowledgeVectorCollections(3);
    const [sqlRows, chunkRows, vectorRowsByCollection, graphRows] = await Promise.all([
        collectionFilter ? Promise.resolve([]) : fetchSqlKnowledgeCandidates(cleanQuery, 40),
        fetchChunkKnowledgeCandidates(cleanQuery, 40, collectionFilter),
        Promise.all(vectorCollections.map((collectionName) => fetchVectorKnowledgeCandidates(cleanQuery, collectionName, 20))),
        retrievalMode === 'vector' || collectionFilter ? Promise.resolve([]) : fetchGraphKnowledgeCandidates(cleanQuery, 40),
    ]);
    const vectorRows = (vectorRowsByCollection || []).flat();
    const merged = [];
    if (retrievalMode === 'vector') merged.push(...vectorRows, ...chunkRows, ...sqlRows);
    else if (retrievalMode === 'graph') merged.push(...graphRows, ...vectorRows, ...chunkRows, ...sqlRows);
    else merged.push(...vectorRows, ...graphRows, ...chunkRows, ...sqlRows);
    const deduped = [];
    const seen = new Set();
    for (const row of merged) {
        const key = `${row.source}:${row.ref_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(row);
    }
    const reranked = await rerankCandidatesWithCohere(cleanQuery, deduped.slice(0, 100), knowledgeConfig);
    const prioritizedRows = applyPriorityPhraseBoost(cleanQuery, reranked.rows);
    const fallbackDegradedReason = skipLlamaindex
        ? null
        : (llamaindexResult.ok && llamaRows.length === 0
            ? 'llamaindex_empty_results'
            : llamaindexResult.reason || 'llamaindex_unavailable');
    return {
        mode: retrievalMode,
        rows: prioritizedRows.slice(0, Math.max(1, Math.min(100, limit))),
        diagnostics: {
            candidate_count: deduped.length,
            rerank_provider: reranked.provider,
            rerank_latency_ms: reranked.latency_ms,
            rerank_used: reranked.used,
            priority_phrase_count: extractPriorityPhrasesFromQuery(cleanQuery).length,
            graph_hops: retrievalMode === 'graph' || retrievalMode === 'hybrid' ? 1 : 0,
            orchestration_provider: skipLlamaindex ? 'control_plane_direct' : 'control-plane-fallback',
            degraded_mode: skipLlamaindex ? false : true,
            degraded_reason: fallbackDegradedReason,
            skip_llamaindex_retrieval: skipLlamaindex,
            llamaindex_upstream_status: llamaindexResult?.diagnostics?.upstream_status || null,
            llamaindex_upstream_endpoint: llamaindexResult?.diagnostics?.upstream_endpoint || null,
            collection_filter: collectionFilter || null,
        },
    };
}
function buildGraphRagExplainText(retrievalMode, diagnostics = {}) {
    const mode = String(retrievalMode || 'hybrid');
    const graphHops = Number(diagnostics?.graph_hops || 0);
    const rerankUsed = diagnostics?.rerank_used === true;
    if (mode === 'graph') {
        return `Graph-priority mode: relationship evidence is prioritized first, then vector/sql fallbacks. Graph hops used: ${graphHops}. Rerank ${rerankUsed ? 'enabled' : 'not used'}.`;
    }
    if (mode === 'vector') {
        return `Vector mode: semantic nearest-neighbor retrieval only. Graph hops used: ${graphHops}.`;
    }
    return `Hybrid mode: vector + graph + SQL signals are fused and reranked when available. Graph hops used: ${graphHops}.`;
}
function shouldUseDocumentListingFallback(query = '') {
    const q = String(query || '').toLowerCase();
    if (!q) return false;
    const asksToList = /\b(list|which|what|show)\b/.test(q);
    const asksBusinessOrDocs = /\b(business|businesses|document|documents|files|financial)\b/.test(q);
    return asksToList && asksBusinessOrDocs;
}
function collectDistinctKnowledgeTitles(rows = [], limit = 8) {
    const titles = [];
    const seen = new Set();
    for (const row of Array.isArray(rows) ? rows : []) {
        const title = String(row?.title || '').trim();
        if (!title) continue;
        if (/^ingestion-e2e-/i.test(title)) continue;
        const key = title.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        titles.push(title);
        if (titles.length >= limit) break;
    }
    return titles;
}
function inferBusinessNamesFromTitles(titles = []) {
    const names = new Set();
    for (const title of Array.isArray(titles) ? titles : []) {
        const normalized = String(title || '')
            .replace(/\.[a-z0-9]+$/i, '')
            .replace(/[_-]+/g, ' ')
            .replace(/\bprofit\s*and\s*loss\b/ig, ' ')
            .replace(/\b202\d[-\s]?\d{2}[-\s]?\d{2}\b/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const lowered = normalized.toLowerCase();
        if (!lowered) continue;
        if (/\bbrisbane\b/.test(lowered)) names.add('Brisbane');
        if (/\bburleigh\b/.test(lowered)) names.add('Burleigh');
        if (/\bretail\b/.test(lowered)) names.add('Retail');
    }
    return Array.from(names).slice(0, 12);
}
function isDashboardSpecPayload(text = '') {
    const raw = String(text || '').trim();
    if (!raw) return false;
    return raw.includes('"title"') && raw.includes('Agent KB Live View')
        && raw.includes('"widgets"') && raw.includes('throughput_rps');
}
function buildDocumentListingAnswer(titles = []) {
    if (!Array.isArray(titles) || titles.length === 0) {
        return 'I could not find matched financial documents for that question. Try naming a location, business unit, or date.';
    }
    const businessNames = inferBusinessNamesFromTitles(titles);
    const lines = titles.map((title, idx) => `${idx + 1}. ${title}`);
    return [
        businessNames.length > 0
            ? `I have financial documents for: ${businessNames.join(', ')}.`
            : 'I found these financial documents in the current knowledge scope:',
        '',
        'Matched documents:',
        ...lines,
        '',
        'If you want, I can now compare key metrics across these files (revenue, COGS, EBITDA, net profit, and variance).',
    ].join('\n');
}
function isBoardroomStrategyQuery(query = '') {
    const q = String(query || '').toLowerCase();
    if (!q) return false;
    return /\b(ceo|board|boardroom|turnaround|strategy|strategic|margin|cash|profit|profitability|survival|restructure|repric|renegotiat)\b/.test(q);
}
function buildKnowledgeAnswerSystemPrompt(query = '') {
    const boardroomMode = isBoardroomStrategyQuery(query);
    const queryLower = String(query || '').toLowerCase();
    const prefersSpreadsheetFinancialAuthority = queryLower.includes('xlsx');
    const allowsPdfInterpretation = queryLower.includes('pdf');
    const rules = [
        boardroomMode
            ? 'You are a boardroom-grade strategy, turnaround, and financial evidence analyst.'
            : 'You are a GraphRAG answer composer.',
        'Use ONLY provided evidence context.',
        'If evidence is insufficient, say exactly what is missing.',
        'Never output placeholders or template fillers such as "$ (missing)", "Category 1", "Channel 1", "Business Unit 1", or "...".',
        'Never invent values, categories, channels, business units, or rankings that are not explicitly supported by the evidence.',
        'If spreadsheet evidence is raw, noisy, or partially visible, explain what is visible, what cannot be concluded, and what additional aggregation would be required.',
        'Prefer clear prose and decision-oriented bullets over row dumps.',
        'Include inline evidence tags like [source:ref_id].',
    ];
    if (prefersSpreadsheetFinancialAuthority) {
        rules.push('Treat spreadsheet evidence as the authority for financial and numeric claims.');
    }
    if (allowsPdfInterpretation) {
        rules.push('Use PDF-style narrative or strategic material only for interpretation and recommendations, never to override spreadsheet numbers.');
    }
    if (boardroomMode) {
        rules.push('Write a detailed executive memo, not a short generic summary.');
        rules.push('Organize the answer as: Executive diagnosis; What the numbers say; Why performance is changing; Cash and margin risks; What management should do next; Key unknowns.');
        rules.push('Only include sections that are supported by evidence. If evidence is absent, state the gap plainly instead of fabricating a section.');
        rules.push('Call out who is affected, what is happening, why it matters, and how management should respond.');
    } else {
        rules.push('Keep response practical for business users.');
    }
    return rules.join('\n');
}
async function listCompletedKnowledgeDocumentTitles(limit = 20, collectionName = '') {
    const cappedLimit = Math.max(1, Math.min(50, Number(limit) || 20));
    const cleanCollection = String(collectionName || '').trim();
    const sql = await pool.query(
        `SELECT DISTINCT ON (d.original_filename)
                d.original_filename
         FROM ingestion_jobs j
         INNER JOIN ingestion_documents d ON d.id = j.document_id
         WHERE j.status = 'completed'
           AND d.status = 'completed'
           AND COALESCE(d.original_filename, '') <> ''
           AND d.original_filename NOT ILIKE 'ingestion-e2e-%'
           AND ($1::text = '' OR COALESCE(j.options->>'collection_name', '') = $1::text)
         ORDER BY d.original_filename, j.updated_at DESC NULLS LAST, j.created_at DESC
         LIMIT $2`,
        [cleanCollection, cappedLimit]
    );
    const titles = (sql.rows || [])
        .map((row) => String(row?.original_filename || '').trim())
        .filter(Boolean);
    return titles;
}
async function synthesizeKnowledgeAnswer({ query, retrieval, trace_id, model_uuid = '' }) {
    const rows = Array.isArray(retrieval?.rows) ? retrieval.rows : [];
    const citations = rows.slice(0, 5).map((row) => ({
        source: String(row.source || 'unknown'),
        ref_id: String(row.ref_id || ''),
        title: String(row.title || ''),
        score: Number(row.score || 0),
    }));
    if (shouldUseDocumentListingFallback(query)) {
        const filteredTitles = await listCompletedKnowledgeDocumentTitles(18, String(retrieval?.diagnostics?.collection_filter || ''))
            .catch(() => []);
        const globalTitles = await listCompletedKnowledgeDocumentTitles(18, '')
            .catch(() => []);
        const indexedTitles = [...filteredTitles, ...globalTitles];
        const rankedTitles = collectDistinctKnowledgeTitles(rows, 12);
        const mergedTitles = Array.from(new Set([...(indexedTitles || []), ...rankedTitles])).slice(0, 18);
        return {
            answer: buildDocumentListingAnswer(mergedTitles),
            citations,
            model: null,
        };
    }
    if (rows.length === 0) {
        const degradedReason = String(retrieval?.diagnostics?.degraded_reason || '').trim();
        const guidance = degradedReason === 'llamaindex_not_configured'
            ? 'No ranked evidence was retrieved. LlamaIndex orchestrator is not configured, so fallback retrieval ran with no matching corpus. Next: configure LLAMAINDEX_URL, set LLAMAINDEX_INTERNAL_KEY, and ingest policy documents before querying.'
            : 'No ranked evidence was retrieved for this query. Try adding specific entity names, policy IDs, branch names, and timeframe.';
        return {
            answer: guidance,
            citations,
            model: null,
        };
    }
    const llm = await loadDashboardLlmConfig(model_uuid);
    if (!llm) {
        const top = rows.slice(0, 3).map((row, idx) => {
            const snippet = String(row.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 220);
            return `${idx + 1}. ${row.title || 'Untitled'} (${row.source}:${row.ref_id}) — ${snippet}`;
        });
        return {
            answer: `Dashboard LLM is not configured, so this is retrieval-only output.\nTop evidence:\n${top.join('\n')}`,
            citations,
            model: null,
        };
    }
    const contextBlock = buildKnowledgeInjectionBlock(retrieval, 8);
    const llmResult = await callConfiguredLlm({
        llm,
        trace_id,
        route: 'POST /api/knowledge/query',
        body: {
            model: llm.model_id,
            temperature: 0.05,
            max_tokens: isBoardroomStrategyQuery(query) ? 1400 : 900,
            messages: [
                {
                    role: 'system',
                    content: buildKnowledgeAnswerSystemPrompt(query),
                },
                {
                    role: 'user',
                    content: `Question:\n${String(query || '')}\n\nEvidence:\n${contextBlock}`,
                },
            ],
        },
    });
    const body = llmResult.upstream_body || {};
    const text = firstNonEmptyString(body?.choices?.[0]?.message?.content, body?.output_text);
    if (text && isDashboardSpecPayload(text)) {
        return {
            answer: buildDocumentListingAnswer(collectDistinctKnowledgeTitles(rows, 12)),
            citations,
            model: llm.model_id,
            token_policy: llmResult.token_policy,
            token_policy_notice: llmResult.token_policy_notice,
        };
    }
    if (!llmResult.ok || !text) {
        return {
            answer: llmResult.error === 'context_too_large_for_model'
                ? llmResult.message
                : 'Evidence was retrieved, but answer synthesis failed upstream. Use the ranked candidates and context preview below.',
            citations,
            model: llm.model_id,
            token_policy: llmResult.token_policy,
            token_policy_notice: llmResult.token_policy_notice,
        };
    }
    return {
        answer: String(text).trim(),
        citations,
        model: llm.model_id,
        token_policy: llmResult.token_policy,
        token_policy_notice: llmResult.token_policy_notice,
    };
}
async function synthesizeKnowledgeAnswerStream({ query, retrieval, trace_id, model_uuid = '', res, signal = null }) {
    const rows = Array.isArray(retrieval?.rows) ? retrieval.rows : [];
    const citations = rows.slice(0, 5).map((row) => ({
        source: String(row.source || 'unknown'),
        ref_id: String(row.ref_id || ''),
        title: String(row.title || ''),
        score: Number(row.score || 0),
    }));
    let answer = '';
    let streamedTokenCount = 0;
    const emitTextChunks = async (text, eventName = 'delta') => {
        const chunks = splitTextForStreaming(String(text || ''), 30);
        for (let idx = 0; idx < chunks.length; idx += 1) {
            if (signal?.aborted) break;
            streamedTokenCount += 1;
            writeSseEvent(res, eventName, {
                trace_id,
                index: streamedTokenCount,
                text: chunks[idx],
            });
            if (idx < chunks.length - 1) await wait(20);
        }
    };
    if (shouldUseDocumentListingFallback(query)) {
        const filteredTitles = await listCompletedKnowledgeDocumentTitles(18, String(retrieval?.diagnostics?.collection_filter || ''))
            .catch(() => []);
        const globalTitles = await listCompletedKnowledgeDocumentTitles(18, '')
            .catch(() => []);
        const indexedTitles = [...filteredTitles, ...globalTitles];
        const rankedTitles = collectDistinctKnowledgeTitles(rows, 12);
        const mergedTitles = Array.from(new Set([...(indexedTitles || []), ...rankedTitles])).slice(0, 18);
        answer = buildDocumentListingAnswer(mergedTitles);
        await emitTextChunks(answer);
        return {
            answer,
            citations,
            model: null,
            streamed_token_count: streamedTokenCount,
        };
    }
    if (rows.length === 0) {
        const degradedReason = String(retrieval?.diagnostics?.degraded_reason || '').trim();
        answer = degradedReason === 'llamaindex_not_configured'
            ? 'No ranked evidence was retrieved. LlamaIndex orchestrator is not configured, so fallback retrieval ran with no matching corpus. Next: configure LLAMAINDEX_URL, set LLAMAINDEX_INTERNAL_KEY, and ingest policy documents before querying.'
            : 'No ranked evidence was retrieved for this query. Try adding specific entity names, policy IDs, branch names, and timeframe.';
        await emitTextChunks(answer);
        return {
            answer,
            citations,
            model: null,
            streamed_token_count: streamedTokenCount,
        };
    }
    const llm = await loadDashboardLlmConfig(model_uuid);
    if (!llm) {
        const top = rows.slice(0, 3).map((row, idx) => {
            const snippet = String(row.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 220);
            return `${idx + 1}. ${row.title || 'Untitled'} (${row.source}:${row.ref_id}) — ${snippet}`;
        });
        answer = `Dashboard LLM is not configured, so this is retrieval-only output.\nTop evidence:\n${top.join('\n')}`;
        await emitTextChunks(answer);
        return {
            answer,
            citations,
            model: null,
            streamed_token_count: streamedTokenCount,
        };
    }
    const contextBlock = buildKnowledgeInjectionBlock(retrieval, 8);
    const requestBody = {
        model: llm.model_id,
        temperature: 0.05,
        max_tokens: isBoardroomStrategyQuery(query) ? 1400 : 900,
        messages: [
            {
                role: 'system',
                content: buildKnowledgeAnswerSystemPrompt(query),
            },
            {
                role: 'user',
                content: `Question:\n${String(query || '')}\n\nEvidence:\n${contextBlock}`,
            },
        ],
    };
    const llmMode = String(llm?.api_mode || 'chat_completions').toLowerCase() === 'responses'
        ? 'responses'
        : 'chat_completions';
    writeSseEvent(res, 'provider_selected', {
        trace_id,
        model_uuid: llm.model_uuid || null,
        model_id: llm.model_id,
        provider: llm.provider_slug || null,
        mode: llmMode,
    });
    if (llmMode === 'responses') {
        writeSseEvent(res, 'thinking', {
            trace_id,
            phase: 'provider_request_started',
            provider_streaming: false,
            reason: 'responses_mode_non_streaming_bridge',
        });
        const llmResult = await callConfiguredLlm({
            llm,
            trace_id,
            route: 'POST /api/knowledge/query',
            body: requestBody,
        });
        const answerText = String(extractLlmTextFromUpstreamBody(llmResult.upstream_body || {}) || '').trim();
        if (!llmResult.ok || !answerText) {
            answer = llmResult.error === 'context_too_large_for_model'
                ? llmResult.message
                : 'Evidence was retrieved, but answer synthesis failed upstream. Use the ranked candidates and context preview below.';
            await emitTextChunks(answer);
            return {
                answer,
                citations,
                model: llm.model_id,
                token_policy: llmResult.token_policy,
                token_policy_notice: llmResult.token_policy_notice,
                streamed_token_count: streamedTokenCount,
            };
        }
        answer = answerText;
        await emitTextChunks(answer);
        return {
            answer,
            citations,
            model: llm.model_id,
            token_policy: llmResult.token_policy,
            token_policy_notice: llmResult.token_policy_notice,
            streamed_token_count: streamedTokenCount,
        };
    }
    const prepared = prepareLlmChatRequest({ llm, body: requestBody, route: 'POST /api/knowledge/query' });
    if (!prepared.ok) {
        answer = prepared.message || 'The knowledge answer request exceeds the configured token budget.';
        await emitTextChunks(answer);
        return {
            answer,
            citations,
            model: llm.model_id,
            token_policy: prepared.token_policy,
            streamed_token_count: streamedTokenCount,
        };
    }
    writeSseEvent(res, 'thinking', {
        trace_id,
        phase: 'provider_stream_connecting',
        provider_streaming: true,
    });
    const upstreamRes = await fetch(llm.chat_url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...buildApiKeyHeaders(llm.api_key, llm.auth_header_name || 'Authorization'),
            ...(trace_id ? { 'x-trace-id': trace_id } : {}),
        },
        body: JSON.stringify({ ...prepared.body, stream: true }),
        signal: signal || undefined,
    });
    if (!upstreamRes.ok || !upstreamRes.body) {
        const failBody = await upstreamRes.text().catch(() => '');
        const streamUnsupported = upstreamRes.status === 400 && /stream\s*=\s*true\s+is\s+not\s+supported/i.test(failBody);
        if (!streamUnsupported) {
            answer = failBody.slice(0, 1000) || `upstream_${upstreamRes.status || 502}`;
            await emitTextChunks(answer);
            return {
                answer,
                citations,
                model: llm.model_id,
                token_policy: prepared.token_policy,
                token_policy_notice: prepared.notice || null,
                streamed_token_count: streamedTokenCount,
            };
        }
        writeSseEvent(res, 'thinking', {
            trace_id,
            phase: 'provider_stream_unsupported_fallback',
            provider_streaming: false,
        });
        const fallbackRes = await fetch(llm.chat_url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...buildApiKeyHeaders(llm.api_key, llm.auth_header_name || 'Authorization'),
                ...(trace_id ? { 'x-trace-id': trace_id } : {}),
            },
            body: JSON.stringify(prepared.body),
            signal: signal || undefined,
        });
        const fallbackBody = await fallbackRes.json().catch(() => ({}));
        const fallbackText = String(extractLlmTextFromUpstreamBody(fallbackBody) || '').trim();
        answer = (!fallbackRes.ok || !fallbackText)
            ? firstNonEmptyString(fallbackBody?.error?.message, fallbackBody?.error, fallbackBody?.message)
                || 'Evidence was retrieved, but answer synthesis failed upstream. Use the ranked candidates and context preview below.'
            : fallbackText;
        await emitTextChunks(answer);
        return {
            answer,
            citations,
            model: llm.model_id,
            token_policy: prepared.token_policy,
            token_policy_notice: prepared.notice || null,
            streamed_token_count: streamedTokenCount,
        };
    }
    const decoder = new TextDecoder();
    const parser = createVllmStreamParser(
        (delta) => {
            answer += delta;
            streamedTokenCount += 1;
            writeSseEvent(res, 'delta', {
                trace_id,
                index: streamedTokenCount,
                text: delta,
            });
        },
        () => {
            writeSseEvent(res, 'thinking', {
                trace_id,
                phase: 'provider_stream_complete',
                provider_streaming: true,
            });
        }
    );
    for await (const chunk of upstreamRes.body) {
        if (signal?.aborted) break;
        parser(decoder.decode(chunk, { stream: true }));
    }
    parser('\n');
    if (!answer.trim()) {
        answer = 'Evidence was retrieved, but answer synthesis returned no text.';
        await emitTextChunks(answer);
    }
    return {
        answer: String(answer).trim(),
        citations,
        model: llm.model_id,
        token_policy: prepared.token_policy,
        token_policy_notice: prepared.notice || null,
        streamed_token_count: streamedTokenCount,
    };
}
function buildKnowledgeInjectionBlock(retrievalResult, topN = 6) {
    const rows = Array.isArray(retrievalResult?.rows) ? retrievalResult.rows.slice(0, topN) : [];
    if (rows.length === 0) return '';
    const lines = rows.map((row, idx) => {
        const source = String(row.source || 'unknown');
        const id = String(row.ref_id || `row-${idx + 1}`);
        const title = String(row.title || 'snippet');
        const snippet = String(row.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 700);
        return `[${idx + 1}] (${source}:${id}) ${title}\n${snippet}`;
    });
    return [
        'Knowledge Context (ranked snippets):',
        ...lines,
        'Use these snippets as evidence. If missing required details, say what is missing.',
    ].join('\n\n');
}

function normalizeStrategyWorkflowConfig(controls = {}) {
    const workflow = controls?.strategy_workflow && typeof controls.strategy_workflow === 'object'
        ? controls.strategy_workflow
        : {};
    const specialistPrompts = controls?.strategy_specialists && typeof controls.strategy_specialists === 'object'
        ? controls.strategy_specialists
        : {};
    const specialistAgents = workflow?.specialist_agents && typeof workflow.specialist_agents === 'object'
        ? workflow.specialist_agents
        : {};
    const requestedOrder = Array.isArray(workflow?.specialist_order)
        ? workflow.specialist_order.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
    return {
        enabled: workflow?.enabled === true,
        llm_synthesis: workflow?.llm_synthesis !== false,
        include_intermediate: workflow?.include_intermediate === true,
        specialist_order: requestedOrder.length > 0
            ? requestedOrder
            : ['data_quality', 'commercial_analytics', 'strategy_decision', 'board_pack'],
        specialist_prompts: specialistPrompts,
        specialist_agents: specialistAgents,
    };
}

function shouldRunStrategyWorkflowQuery(query = '', workflowConfig = {}, retrievalResult = null) {
    if (!workflowConfig?.enabled) return false;
    if (!Array.isArray(retrievalResult?.rows) || retrievalResult.rows.length === 0) return false;
    const q = String(query || '').toLowerCase();
    if (!q) return false;
    if (isBoardroomStrategyQuery(q)) return true;
    return /\b(90[\s-]?day|12[\s-]?month|board-ready|current climate|what direction|direction should|action plan|roadmap|business strategy|strategy build|where to compete|how to win|what to stop|commission)\b/.test(q);
}

async function runParallelStrategyWorkflow({
    llm,
    trace_id = '',
    routeTemplate = '',
    agentId = '',
    sessionId = '',
    query = '',
    baseSystemPrompt = '',
    knowledgeInjection = '',
    workflowConfig = {},
    runtimeSettings = {},
}) {
    const requestedMaxTokens = Math.max(1200, Number(runtimeSettings?.max_tokens || 3200));
    const stageMaxTokens = Math.max(1200, Math.min(3200, Math.round(requestedMaxTokens * 0.45)));
    const finalMaxTokens = Math.max(2600, Math.min(7000, requestedMaxTokens));
    const stageNames = {
        data_quality: 'Data Quality',
        commercial_analytics: 'Commercial Analytics',
        strategy_decision: 'Strategy Decision',
        board_pack: 'Board Pack',
    };
    const defaultStagePrompts = {
        data_quality: 'You are the Harvard strategist data-quality specialist. Assess what the evidence can support, what it cannot support, what is missing, and where the evidence is weak.',
        commercial_analytics: 'You are the Harvard strategist commercial-analytics specialist. Focus on revenue drivers, contribution, margin, cash generation, working capital, and low-quality growth traps.',
        strategy_decision: 'You are the Harvard strategist strategy-decision specialist. Determine where to compete, how to win, what to stop, and which trade-offs are mandatory.',
        board_pack: 'You are the Harvard strategist board-pack specialist. Turn the grounded analysis into a crisp board-ready strategy memo with explicit trade-offs, priorities, risks, and next data required.',
    };
    const orderedStages = Array.from(new Set(
        (Array.isArray(workflowConfig?.specialist_order) ? workflowConfig.specialist_order : [])
            .map((entry) => String(entry || '').trim())
            .filter(Boolean)
    ));
    const parallelStageKeys = orderedStages.filter((entry) => entry !== 'board_pack');
    if (!llm || parallelStageKeys.length === 0 || !knowledgeInjection) {
        return { ok: false, error: 'strategy_workflow_not_runnable', stage_results: [] };
    }

    const buildStageSystemPrompt = (stageKey) => [
        String(baseSystemPrompt || '').trim(),
        String(workflowConfig?.specialist_prompts?.[stageKey] || defaultStagePrompts[stageKey] || '').trim(),
        'Use ONLY the supplied knowledge context.',
        'When the query names a company or brand, prioritize direct evidence about that company above generic macro or policy context.',
        'Never invent internal company metrics, growth rates, market share, or macro facts that are not explicitly present in the evidence.',
        'Separate fact, interpretation, recommendation, and missing evidence whenever possible.',
        'If evidence is weak or incomplete, say so plainly instead of smoothing over the gap.',
    ].filter(Boolean).join('\n\n');

    const buildStageUserPrompt = (stageKey) => [
        `Original strategy question:\n${String(query || '').trim()}`,
        knowledgeInjection,
        `Specialist task (${stageNames[stageKey] || stageKey}): focus only on your lane and return a concise memo with evidence-backed findings, implications, trade-offs, and critical unknowns.`,
    ].filter(Boolean).join('\n\n');

    const stageResults = await Promise.all(parallelStageKeys.map(async (stageKey) => {
        const llmResult = await callConfiguredLlm({
            llm,
            trace_id,
            route: `${routeTemplate}::strategy_stage::${stageKey}`,
            body: {
                model: llm.model_id,
                temperature: Math.min(0.2, Math.max(0, Number(runtimeSettings?.temperature ?? 0.1) || 0.1)),
                max_tokens: stageMaxTokens,
                messages: [
                    { role: 'system', content: buildStageSystemPrompt(stageKey) },
                    { role: 'user', content: buildStageUserPrompt(stageKey) },
                ],
            },
        });
        const output = String(extractLlmTextFromUpstreamBody(llmResult?.upstream_body || {}) || '').trim();
        await insertLlmDebugLog({
            trace_id,
            span_id: crypto.randomUUID(),
            agent_id: agentId || null,
            session_id: sessionId || null,
            level: llmResult?.ok ? 'debug' : 'error',
            event: 'strategy.workflow.stage',
            detail: {
                stage: stageKey,
                status: llmResult?.status || 0,
                ok: llmResult?.ok === true,
                specialist_agent_id: workflowConfig?.specialist_agents?.[stageKey] || null,
                output_preview: output ? output.slice(0, 2000) : null,
                error: llmResult?.ok ? null : (llmResult?.error || 'strategy_stage_failed'),
            },
        });
        return {
            key: stageKey,
            label: stageNames[stageKey] || stageKey,
            ok: llmResult?.ok === true && !!output,
            status: llmResult?.status || 0,
            output,
            error: llmResult?.ok ? null : (llmResult?.error || 'strategy_stage_failed'),
        };
    }));

    const usableStageResults = stageResults.filter((stage) => stage.ok && stage.output);
    if (usableStageResults.length === 0) {
        return { ok: false, error: 'strategy_workflow_no_stage_outputs', stage_results: stageResults };
    }

    if (workflowConfig?.llm_synthesis === false) {
        const mergedOutput = usableStageResults
            .map((stage) => `## ${stage.label}\n${stage.output}`)
            .join('\n\n');
        return {
            ok: true,
            output: mergedOutput,
            reasoning: '',
            upstream_status: 200,
            upstream_body: { usage: null, workflow_only: true },
            usage: null,
            token_policy: llm?.token_policy || null,
            token_policy_notice: null,
            stage_results: stageResults,
        };
    }

    const synthesisPrompt = [
        String(baseSystemPrompt || '').trim(),
        String(workflowConfig?.specialist_prompts?.board_pack || defaultStagePrompts.board_pack).trim(),
        'You are synthesizing parallel Harvard strategist specialist outputs into one final answer.',
        'Use ONLY the supplied knowledge context and specialist outputs.',
        'Company-specific evidence comes first. Use generic market, policy, or macro material only as supporting context unless the company-specific evidence is absent.',
        'Keep this exact section order: Executive take | What the data proves | What the data suggests | What remains unknown | Strategic implications | Recommended actions in order | Required next data | Risks and assumptions.',
        'Do not invent percentages, growth rates, internal company facts, or macro claims that are not in the knowledge context.',
        'If something is inference rather than direct evidence, label it clearly.',
    ].filter(Boolean).join('\n\n');

    const synthesisUserPrompt = [
        `Original strategy question:\n${String(query || '').trim()}`,
        knowledgeInjection,
        'Specialist outputs:',
        ...usableStageResults.map((stage) => `### ${stage.label}\n${stage.output}`),
        workflowConfig?.include_intermediate === true
            ? 'Preserve the distinct specialist angles where they materially improve clarity.'
            : 'Produce only the final board-ready answer.',
    ].filter(Boolean).join('\n\n');

    const finalResult = await callConfiguredLlm({
        llm,
        trace_id,
        route: `${routeTemplate}::strategy_workflow_final`,
        body: {
            model: llm.model_id,
            temperature: Math.min(0.15, Math.max(0, Number(runtimeSettings?.temperature ?? 0.1) || 0.1)),
            max_tokens: finalMaxTokens,
            messages: [
                { role: 'system', content: synthesisPrompt },
                { role: 'user', content: synthesisUserPrompt },
            ],
        },
    });
    const finalOutput = String(extractLlmTextFromUpstreamBody(finalResult?.upstream_body || {}) || '').trim();
    const finalReasoning = String(extractLlmReasoningFromUpstreamBody(finalResult?.upstream_body || {}) || '').trim();

    await insertLlmDebugLog({
        trace_id,
        span_id: crypto.randomUUID(),
        agent_id: agentId || null,
        session_id: sessionId || null,
        level: finalResult?.ok ? 'debug' : 'error',
        event: 'strategy.workflow.final',
        detail: {
            status: finalResult?.status || 0,
            ok: finalResult?.ok === true && !!finalOutput,
            used_stages: usableStageResults.map((stage) => stage.key),
            output_preview: finalOutput ? finalOutput.slice(0, 2000) : null,
            error: finalResult?.ok ? null : (finalResult?.error || 'strategy_workflow_final_failed'),
        },
    });

    return {
        ok: finalResult?.ok === true && !!finalOutput,
        output: finalOutput,
        reasoning: finalReasoning,
        upstream_status: finalResult?.status || 0,
        upstream_body: finalResult?.upstream_body || null,
        usage: finalResult?.upstream_body?.usage || null,
        token_policy: finalResult?.token_policy || null,
        token_policy_notice: finalResult?.token_policy_notice || null,
        stage_results: stageResults,
        error: finalResult?.ok ? null : (finalResult?.error || 'strategy_workflow_final_failed'),
    };
}

async function loadDashboardLlmConfig(modelUuid = '', options = {}) {
    const runtime = await resolveDashboardAssistantRuntime({
        model_uuid: modelUuid,
        user_id: options?.user_id || '',
        engine_settings: options?.engine_settings || null,
        user_row: options?.user_row,
    });
    return runtime?.llm || null;
}

async function runAgentCompletion({
    trace_id,
    routeTemplate,
    agentId,
    endpointKey,
    input,
    sessionId,
    modelOverride,
}) {
    const start = Date.now();
    const start_ts = nowIso();
    const outboundSpanId = crypto.randomUUID();
    const cleanAgentId = String(agentId || '').trim();
    const cleanInput = String(input || '').trim();
    const cleanEndpointKey = String(endpointKey || '').trim();
    const resolvedSessionId = resolveSessionId(sessionId);
    const requestedModelOverride = String(modelOverride || '').trim();
    // Endpoint-key invocations are agent-scoped; ignore caller model overrides so
    // the configured server-side agent model remains the processing source of truth.
    const cleanModelOverride = cleanEndpointKey ? '' : requestedModelOverride;
    let turnContext = null;
    if (!cleanAgentId || !cleanInput) {
        return {
            status: 400,
            payload: { error: 'missing_fields', hint: 'Provide agent id or endpoint key, and input/message.' },
        };
    }
    try {
        const state = await loadAgentPromptState(cleanAgentId);
        if (!state) return { status: 404, payload: { error: 'agent_not_found' } };
        const { agent, controls, styleOverlay, activeInjections, prepend, append, styleHint, controlHint } = state;
        let model = state.model;
        const runtimeSettings = resolveAgentRuntimeSettings(controls || {});
        const completionResolved = await resolveAgentCompletionModelView(model, runtimeSettings.completion_model_uuid);
        if (completionResolved.error) {
            return {
                status: 400,
                payload: {
                    ok: false,
                    error: completionResolved.error,
                    hint: completionResolved.error === 'invalid_completion_model_uuid'
                        ? 'Set strategy_runtime.completion_model_uuid to a valid llm_registry model id.'
                        : 'Pick an enabled model from LLM settings or clear completion_model_uuid.',
                },
            };
        }
        model = completionResolved.model;
        if (runtimeSettings.max_input_chars && cleanInput.length > runtimeSettings.max_input_chars) {
            return {
                status: 400,
                payload: {
                    ok: false,
                    error: 'input_exceeds_max_input_chars',
                    message: `Input exceeds configured max_input_chars (${runtimeSettings.max_input_chars}).`,
                },
            };
        }
        try {
            turnContext = await beginAgentTurnPersistence({
                agent_id: cleanAgentId,
                session_id: resolvedSessionId,
                trace_id,
                span_id: outboundSpanId,
                input: cleanInput,
                route: routeTemplate,
                transport: 'http',
            });
        }
        catch (persistErr) {
            await insertLlmDebugLog({
                trace_id,
                span_id: outboundSpanId,
                agent_id: cleanAgentId,
                session_id: resolvedSessionId,
                level: 'error',
                event: 'agent.turn.persist.user_failed',
                detail: { error: String(persistErr && persistErr.message || persistErr) },
            });
        }
        const knowledgeRetrieval = await runKnowledgeRetrieval({
            query: cleanInput,
            limit: Number(runtimeSettings.top_k) || 12,
            mode: runtimeSettings.retrieval_mode || '',
            trace_id,
            span_id: outboundSpanId,
            upstream_context: runtimeSettings.runtimeCollectionName
                ? {
                    metadata: {
                        agent_id: cleanAgentId,
                        tool_id: null,
                        collection_name: runtimeSettings.runtimeCollectionName,
                        index_id: runtimeSettings.runtimeCollectionName,
                    },
                    collection_name: runtimeSettings.runtimeCollectionName,
                    index_id: runtimeSettings.runtimeCollectionName,
                }
                : {
                    metadata: {
                        agent_id: cleanAgentId,
                        tool_id: null,
                    },
                },
            options: { skip_llamaindex: runtimeSettings.skip_llamaindex_retrieval === true },
        }).catch(() => ({ mode: 'vector', rows: [], diagnostics: { candidate_count: 0, graph_hops: 0 } }));
        const degradedReason = String(knowledgeRetrieval?.diagnostics?.degraded_reason || '').trim().toLowerCase();
        const strictCollectionMode = runtimeSettings.strict_evidence === true && runtimeSettings.collection_only === true;
        const upstreamAuthFailure = degradedReason === 'llamaindex_status_401' || degradedReason === 'llamaindex_status_403';
        if (strictCollectionMode && upstreamAuthFailure) {
            if (turnContext?.turn_no) {
                try {
                    await finalizeAssistantTurnPersistence({
                        agent_id: cleanAgentId,
                        session_id: turnContext.session_id,
                        turn_no: turnContext.turn_no,
                        trace_id,
                        span_id: outboundSpanId,
                        status: 503,
                        latency_ms: Date.now() - start,
                        model: cleanModelOverride || model?.model_id || null,
                        output: null,
                        error: 'retrieval_upstream_auth_failed_strict_mode',
                        usage: null,
                        decision_snapshot: buildDecisionSnapshot({
                            route: routeTemplate,
                            strict_evidence: runtimeSettings.strict_evidence,
                            collection_only: runtimeSettings.collection_only,
                            retrieval_degraded_reason: degradedReason,
                        }),
                    });
                }
                catch (_) {}
            }
            return {
                status: 503,
                payload: {
                    ok: false,
                    error: 'retrieval_upstream_auth_failed_strict_mode',
                    message: 'Strict evidence mode is enabled and upstream retrieval authentication failed.',
                },
            };
        }
        const knowledgeInjection = buildKnowledgeInjectionBlock(knowledgeRetrieval, Number(runtimeSettings.top_k) || 12);
        const systemParts = [
            String(agent.system_prompt || '').trim(),
            prepend,
            styleHint,
            controlHint,
            knowledgeInjection,
        ].filter(Boolean);
        const systemPrompt = systemParts.join('\n\n');
        const userPrompt = append ? `${input}\n\n${append}` : input;

        const providerBaseUrl = String(model?.base_url || VLLM_INTERNAL_BASE_URL || '').trim();
        const settingsState = await getEngineSettings().catch(() => ({ config: {} }));
        let resolvedProviderApiKey = resolveStoredProviderSecret(settingsState.config || {}, {
            id: model?.provider_id,
            slug: model?.provider_slug,
            name: model?.provider_name,
            base_url: providerBaseUrl,
            api_key_env: model?.api_key_env,
        });
        const baseLower = String(providerBaseUrl || '').toLowerCase();
        const apiKeyEnvUpper = String(model?.api_key_env || '').trim().toUpperCase();
        if (
            !resolvedProviderApiKey
            && (baseLower.includes('/api/llamaindex') || apiKeyEnvUpper === 'LLAMAINDEX_INTERNAL_KEY')
        ) {
            const knowledgeLi = resolveKnowledgeStorageSettings(settingsState.config || {});
            resolvedProviderApiKey = String(process.env.LLAMAINDEX_INTERNAL_KEY || '').trim()
                || String(knowledgeLi.llamaindex_internal_key || '').trim();
        }
        const providerAuthHeader = resolveAssistantApiKeyHeaderName({
            base_url: providerBaseUrl,
            slug: model?.provider_slug,
            api_key_env: model?.api_key_env,
            name: model?.provider_name,
        });

        await insertLlmDebugLog({
            trace_id,
            span_id: outboundSpanId,
            agent_id: cleanAgentId,
            session_id: resolvedSessionId,
            level: 'debug',
            event: 'llm.request.build',
            detail: {
                model: cleanModelOverride || model?.model_id || VLLM_MODEL,
                base_url: model?.base_url || VLLM_INTERNAL_BASE_URL,
                provider: model?.provider_slug || 'default',
                has_api_key: !!resolvedProviderApiKey,
                auth_header_name: providerAuthHeader,
                agent_name: agent.name,
                input,
                controls,
                style_overlay: styleOverlay,
                injections_applied: activeInjections.map((i) => ({ id: i.id, mode: i.mode, one_shot: i.one_shot })),
                retrieval_mode: knowledgeRetrieval?.mode || null,
                candidate_count: knowledgeRetrieval?.diagnostics?.candidate_count ?? 0,
                rerank_provider: knowledgeRetrieval?.diagnostics?.rerank_provider || null,
                rerank_latency_ms: knowledgeRetrieval?.diagnostics?.rerank_latency_ms || 0,
                graph_hops: knowledgeRetrieval?.diagnostics?.graph_hops || 0,
                token_policy: model?.token_policy || null,
                skip_llamaindex_retrieval: runtimeSettings.skip_llamaindex_retrieval === true,
                completion_model_uuid: runtimeSettings.completion_model_uuid || null,
                knowledge_orchestration: runtimeSettings.knowledge_orchestration || null,
            },
        });
        if (!resolvedProviderApiKey) {
            if (turnContext?.turn_no) {
                try {
                    await finalizeAssistantTurnPersistence({
                        agent_id: cleanAgentId,
                        session_id: turnContext.session_id,
                        turn_no: turnContext.turn_no,
                        trace_id,
                        span_id: outboundSpanId,
                        status: 401,
                        latency_ms: Date.now() - start,
                        model: cleanModelOverride || model?.model_id || null,
                        output: null,
                        error: 'provider_api_key_missing',
                        usage: null,
                        decision_snapshot: buildDecisionSnapshot({ route: routeTemplate, error: 'provider_api_key_missing' }),
                    });
                }
                catch (_) {}
            }
            return {
                status: 401,
                payload: {
                    ok: false,
                    error: 'provider_api_key_missing',
                    message: 'Model provider API key is not configured in environment or stored provider secrets.',
                },
            };
        }

        const resolvedModelId = resolveRuntimeModelId({
            modelOverride: cleanModelOverride,
            providerSlug: model?.provider_slug || 'default',
            configuredModelId: model?.model_id,
        });
        const llmApiMode = resolveLlmApiMode({
            apiModeRaw: model?.config?.api_mode,
            baseUrl: providerBaseUrl,
            modelId: resolvedModelId,
        });
        const endpoint = llmApiMode === 'responses'
            ? resolveOpenAiResponsesUrl(providerBaseUrl)
            : resolveOpenAiChatCompletionsUrl(providerBaseUrl);
        if (!endpoint) {
            if (turnContext?.turn_no) {
                try {
                    await finalizeAssistantTurnPersistence({
                        agent_id: cleanAgentId,
                        session_id: turnContext.session_id,
                        turn_no: turnContext.turn_no,
                        trace_id,
                        span_id: outboundSpanId,
                        status: 503,
                        latency_ms: Date.now() - start,
                        model: resolvedModelId || null,
                        output: null,
                        error: 'model_provider_base_url_missing',
                        usage: null,
                        decision_snapshot: buildDecisionSnapshot({ route: routeTemplate, error: 'model_provider_base_url_missing' }),
                    });
                }
                catch (_) {}
            }
            return { status: 503, payload: { error: 'model_provider_base_url_missing' } };
        }
        const body = {
            model: resolvedModelId,
            messages: [
                { role: 'system', content: systemPrompt || 'You are a controlled assistant.' },
                { role: 'user', content: userPrompt },
            ],
        };
        if (runtimeSettings.temperature !== null) body.temperature = runtimeSettings.temperature;
        if (runtimeSettings.max_tokens !== null) body.max_tokens = runtimeSettings.max_tokens;
        if (runtimeSettings.top_p !== null) body.top_p = runtimeSettings.top_p;
        if (runtimeSettings.presence_penalty !== null) body.presence_penalty = runtimeSettings.presence_penalty;
        if (runtimeSettings.frequency_penalty !== null) body.frequency_penalty = runtimeSettings.frequency_penalty;
        if (runtimeSettings.stop.length > 0) body.stop = runtimeSettings.stop;
        const configuredReasoningEffort = String(model?.config?.reasoning_effort || '').trim().toLowerCase();
        const configuredVerbosity = String(model?.config?.verbosity || '').trim().toLowerCase();
        const headers = {
            'Content-Type': 'application/json',
            ...buildApiKeyHeaders(resolvedProviderApiKey, providerAuthHeader),
        };
        const preparedRequest = prepareLlmChatRequest({
            llm: {
                model_uuid: model?.id || null,
                model_id: resolvedModelId,
                chat_url: endpoint,
                api_key: resolvedProviderApiKey,
                provider_kind: model?.provider_kind,
                provider_slug: model?.provider_slug,
                token_policy: model?.token_policy || normalizeModelTokenPolicy({}, resolveLlmTokenPolicyDefaults(settingsState.config || {})),
            },
            body,
            route: routeTemplate,
        });
        if (!preparedRequest.ok) {
            if (turnContext?.turn_no) {
                try {
                    await finalizeAssistantTurnPersistence({
                        agent_id: cleanAgentId,
                        session_id: turnContext.session_id,
                        turn_no: turnContext.turn_no,
                        trace_id,
                        span_id: outboundSpanId,
                        status: preparedRequest.status || 400,
                        latency_ms: Date.now() - start,
                        model: resolvedModelId || null,
                        output: null,
                        error: preparedRequest.error,
                        usage: null,
                        decision_snapshot: buildDecisionSnapshot({ route: routeTemplate, error: preparedRequest.error }),
                    });
                }
                catch (_) {}
            }
            return {
                status: preparedRequest.status || 400,
                payload: {
                    ok: false,
                    error: preparedRequest.error,
                    message: preparedRequest.message,
                    token_policy: preparedRequest.token_policy,
                },
            };
        }
        const preparedBody = preparedRequest.body;
        const configuredToolIds = (() => {
            if (Array.isArray(agent.tools)) return agent.tools.map((tool) => String(tool || '').trim()).filter(Boolean);
            if (typeof agent.tools === 'string') {
                try {
                    const parsed = JSON.parse(agent.tools);
                    return Array.isArray(parsed) ? parsed.map((tool) => String(tool || '').trim()).filter(Boolean) : [];
                }
                catch (_) {
                    return [];
                }
            }
            return [];
        })().filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id));
        const enabledToolRows = configuredToolIds.length > 0
            ? (await pool.query(
                `SELECT id, name, kind, status FROM tools WHERE id = ANY($1::uuid[]) AND status = 'active' ORDER BY name`,
                [configuredToolIds]
            )).rows
            : [];
        const strategyWorkflow = normalizeStrategyWorkflowConfig(controls || {});
        const llmConfigForCalls = {
            model_uuid: model?.id || null,
            model_id: resolvedModelId,
            chat_url: llmApiMode === 'responses' ? resolveOpenAiChatCompletionsUrl(providerBaseUrl) : endpoint,
            responses_url: llmApiMode === 'responses' ? endpoint : resolveOpenAiResponsesUrl(providerBaseUrl),
            api_key: resolvedProviderApiKey,
            auth_header_name: providerAuthHeader,
            provider_kind: model?.provider_kind,
            provider_slug: model?.provider_slug,
            token_policy: model?.token_policy || normalizeModelTokenPolicy({}, resolveLlmTokenPolicyDefaults(settingsState.config || {})),
            base_url: providerBaseUrl,
            api_mode: llmApiMode,
            config: model?.config || {},
        };
        const upstreamPayload = llmApiMode === 'responses'
            ? (() => {
                const payload = {
                    model: preparedBody.model,
                    instructions: firstNonEmptyString(
                        ...((Array.isArray(preparedBody.messages) ? preparedBody.messages : [])
                            .filter((message) => String(message?.role || '').trim().toLowerCase() === 'system')
                            .map((message) => String(message?.content || '').trim())
                            .filter(Boolean))
                    ) || undefined,
                    input: toResponsesInput(preparedBody.messages),
                    max_output_tokens: preparedBody.max_tokens,
                };
                if (Number.isFinite(Number(preparedBody.temperature))) payload.temperature = Number(preparedBody.temperature);
                if (Number.isFinite(Number(preparedBody.top_p))) payload.top_p = Number(preparedBody.top_p);
                if (Array.isArray(preparedBody.stop) && preparedBody.stop.length > 0) payload.stop = preparedBody.stop;
                if (['minimal', 'low', 'medium', 'high'].includes(configuredReasoningEffort)) {
                    payload.reasoning = { effort: configuredReasoningEffort };
                }
                if (['low', 'medium', 'high'].includes(configuredVerbosity)) {
                    payload.text = { verbosity: configuredVerbosity };
                }
                return payload;
            })()
            : preparedBody;

        let upstreamStatus = 200;
        let upstreamOk = true;
        let upstreamData = null;
        let output = null;
        let strategyWorkflowResult = null;
        const toolLoopCapableProvider = supportsToolLoopForBaseUrl(providerBaseUrl);
        const shouldRunStrategyWorkflow = enabledToolRows.length === 0
            && shouldRunStrategyWorkflowQuery(cleanInput, strategyWorkflow, knowledgeRetrieval);
        if (shouldRunStrategyWorkflow) {
            strategyWorkflowResult = await runParallelStrategyWorkflow({
                llm: llmConfigForCalls,
                trace_id,
                routeTemplate,
                agentId: cleanAgentId,
                sessionId: resolvedSessionId,
                query: cleanInput,
                baseSystemPrompt: systemPrompt || 'You are a controlled assistant.',
                knowledgeInjection,
                workflowConfig: strategyWorkflow,
                runtimeSettings,
            });
            if (strategyWorkflowResult?.ok) {
                upstreamStatus = Number(strategyWorkflowResult.upstream_status || 200);
                upstreamOk = true;
                upstreamData = strategyWorkflowResult.upstream_body || { usage: strategyWorkflowResult.usage || null };
                output = strategyWorkflowResult.output || '';
            }
        }
        if (!strategyWorkflowResult?.ok && enabledToolRows.length > 0 && toolLoopCapableProvider) {
            const toolLoop = await runOpenAiToolLoop({
                llm: {
                    model_id: resolvedModelId,
                    base_url: providerBaseUrl,
                    provider_kind: model?.provider_kind,
                    provider_slug: model?.provider_slug,
                    token_policy: model?.token_policy || normalizeModelTokenPolicy({}, resolveLlmTokenPolicyDefaults(settingsState.config || {})),
                },
                trace_id,
                route: routeTemplate,
                headers,
                systemMessage: systemPrompt || 'You are a controlled assistant.',
                userMessage: userPrompt,
                toolRows: enabledToolRows,
                generation: {
                    temperature: runtimeSettings.temperature,
                    max_tokens: runtimeSettings.max_tokens,
                    top_p: runtimeSettings.top_p,
                    stop: runtimeSettings.stop,
                },
                agent_id: cleanAgentId,
            });
            upstreamStatus = Number(toolLoop.status || 200);
            upstreamOk = toolLoop.ok === true;
            upstreamData = toolLoop.upstream_body || null;
            output = toolLoop.output || extractLlmTextFromUpstreamBody(toolLoop.upstream_body || null);
        } else if (!strategyWorkflowResult?.ok) {
            const upstreamRes = await fetch(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify(upstreamPayload),
            });
            upstreamStatus = Number(upstreamRes.status || 502);
            upstreamOk = upstreamRes.ok;
            const ct = upstreamRes.headers.get('content-type') || '';
            if (ct.includes('application/json')) {
                try {
                    upstreamData = await upstreamRes.json();
                }
                catch (_) {}
            } else {
                try {
                    const txt = await upstreamRes.text();
                    upstreamData = txt ? { _raw: txt.slice(0, 4000) } : null;
                }
                catch (_) {}
            }
            output = extractLlmTextFromUpstreamBody(upstreamData);
        }

        if (runtimeSettings.max_output_chars && typeof output === 'string' && output.length > runtimeSettings.max_output_chars) {
            output = output.slice(0, runtimeSettings.max_output_chars);
        }
        let reasoning = strategyWorkflowResult?.ok
            ? String(strategyWorkflowResult?.reasoning || '').trim()
            : extractLlmReasoningFromUpstreamBody(upstreamData);
        if (runtimeSettings.max_output_chars && typeof reasoning === 'string' && reasoning.length > runtimeSettings.max_output_chars) {
            reasoning = reasoning.slice(0, runtimeSettings.max_output_chars);
        }
        const latency_ms = Date.now() - start;
        const end_ts = nowIso();
        const errorDetail = upstreamOk ? null : `${upstreamStatus}: llm_upstream_failed`;

        await insertLlmDebugLog({
            trace_id,
            span_id: outboundSpanId,
            agent_id: cleanAgentId,
            session_id: resolvedSessionId,
            level: upstreamOk ? 'debug' : 'error',
            event: 'llm.response.raw',
            detail: {
                upstream_status: upstreamStatus,
                upstream_body: upstreamData,
                output_preview: output ? String(output).slice(0, 2000) : null,
            },
        });

        try {
            await pool.query(
                `INSERT INTO request_logs (trace_id, span_id, service, route, start_ts, end_ts, latency_ms, status, error, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                [
                    trace_id,
                    outboundSpanId,
                    'control-plane-api',
                    routeTemplate,
                    start_ts,
                    end_ts,
                    latency_ms,
                    upstreamStatus,
                    errorDetail,
                    JSON.stringify(sanitizeForLogs({
                        agent_id: cleanAgentId,
                        session_id: resolvedSessionId,
                        model: preparedBody.model,
                        endpoint,
                        api_mode: llmApiMode,
                        endpoint_key: cleanEndpointKey || null,
                        invoked_via: cleanEndpointKey ? 'endpoint_key' : 'agent_id',
                        runtime_collection_name: runtimeSettings.runtimeCollectionName || null,
                        generation_controls: {
                            temperature: runtimeSettings.temperature,
                            max_tokens: runtimeSettings.max_tokens,
                            top_p: runtimeSettings.top_p,
                            presence_penalty: runtimeSettings.presence_penalty,
                            frequency_penalty: runtimeSettings.frequency_penalty,
                            stop: runtimeSettings.stop,
                            max_input_chars: runtimeSettings.max_input_chars,
                            max_output_chars: runtimeSettings.max_output_chars,
                        },
                        request_body: upstreamPayload,
                        token_policy: preparedRequest.token_policy,
                        upstream_body: upstreamData,
                        usage: upstreamData?.usage || null,
                        strategy_workflow_used: strategyWorkflowResult?.ok === true,
                        strategy_workflow_stage_keys: Array.isArray(strategyWorkflowResult?.stage_results)
                            ? strategyWorkflowResult.stage_results.filter((stage) => stage?.ok).map((stage) => stage.key)
                            : [],
                    })),
                ]
            );
        }
        catch (_) {}

        if (!upstreamOk) {
            if (turnContext?.turn_no) {
                try {
                    await finalizeAssistantTurnPersistence({
                        agent_id: cleanAgentId,
                        session_id: turnContext.session_id,
                        turn_no: turnContext.turn_no,
                        trace_id,
                        span_id: outboundSpanId,
                        status: 502,
                        latency_ms,
                        model: preparedBody.model,
                        output: null,
                        error: 'llm_upstream_failed',
                        usage: upstreamData?.usage || null,
                        decision_snapshot: buildDecisionSnapshot({ upstream_status: upstreamStatus, route: routeTemplate }),
                    });
                }
                catch (persistErr) {
                    await insertLlmDebugLog({
                        trace_id,
                        span_id: outboundSpanId,
                        agent_id: cleanAgentId,
                        session_id: resolvedSessionId,
                        level: 'error',
                        event: 'agent.turn.persist.assistant_failed',
                        detail: { error: String(persistErr && persistErr.message || persistErr), status: 502 },
                    });
                }
            }
            return {
                status: 502,
                payload: {
                    ok: false,
                    error: 'llm_upstream_failed',
                    message: preparedRequest.notice || 'LLM upstream failed',
                    trace_id,
                    latency_ms,
                    session_id: resolvedSessionId,
                    status: upstreamStatus,
                    token_policy: preparedRequest.token_policy,
                    data: sanitizeForLogs(upstreamData),
                },
            };
        }

        const oneShotIds = activeInjections
            .filter((i) => i.one_shot === true)
            .map((i) => i.id);
        if (oneShotIds.length > 0) {
            await pool.query(`UPDATE agent_injections SET active = false WHERE id = ANY($1::uuid[])`, [oneShotIds]).catch(() => {});
        }

        await insertLlmDebugLog({
            trace_id,
            span_id: outboundSpanId,
            agent_id: cleanAgentId,
            session_id: resolvedSessionId,
            level: 'debug',
            event: 'llm.response.final',
            detail: {
                latency_ms,
                usage: upstreamData?.usage || null,
                output,
            },
        });
        if (turnContext?.turn_no) {
            try {
                await finalizeAssistantTurnPersistence({
                    agent_id: cleanAgentId,
                    session_id: turnContext.session_id,
                    turn_no: turnContext.turn_no,
                    trace_id,
                    span_id: outboundSpanId,
                    status: 200,
                    latency_ms,
                    model: preparedBody.model,
                    output,
                    error: null,
                    usage: upstreamData?.usage || null,
                    decision_snapshot: buildDecisionSnapshot({
                        route: routeTemplate,
                        completion_status: 200,
                        skip_llamaindex_retrieval: runtimeSettings.skip_llamaindex_retrieval === true,
                        completion_model_uuid: runtimeSettings.completion_model_uuid || null,
                        retrieval_orchestration: knowledgeRetrieval?.diagnostics?.orchestration_provider || null,
                        strategy_workflow_used: strategyWorkflowResult?.ok === true,
                    }),
                });
            }
            catch (persistErr) {
                await insertLlmDebugLog({
                    trace_id,
                    span_id: outboundSpanId,
                    agent_id: cleanAgentId,
                    session_id: resolvedSessionId,
                    level: 'error',
                    event: 'agent.turn.persist.assistant_failed',
                    detail: { error: String(persistErr && persistErr.message || persistErr), status: 200 },
                });
            }
        }

        return {
            status: 200,
            payload: {
                ok: true,
                trace_id,
                latency_ms,
                agent_id: cleanAgentId,
                session_id: resolvedSessionId,
                model: preparedBody.model,
                api_mode: llmApiMode,
                output,
                reasoning,
                usage: upstreamData?.usage || null,
                raw: sanitizeForLogs(upstreamData),
                token_policy: preparedRequest.token_policy,
                token_policy_notice: preparedRequest.notice,
                runtime_path: {
                    skip_llamaindex_retrieval: runtimeSettings.skip_llamaindex_retrieval === true,
                    completion_model_uuid: runtimeSettings.completion_model_uuid || null,
                    retrieval_orchestration: knowledgeRetrieval?.diagnostics?.orchestration_provider || null,
                    strategy_workflow: strategyWorkflowResult?.ok === true ? 'parallel_specialists' : null,
                },
            },
        };
    }
    catch (err) {
        const latency_ms = Date.now() - start;
        await insertLlmDebugLog({
            trace_id,
            span_id: outboundSpanId,
            agent_id: cleanAgentId || null,
            session_id: resolvedSessionId,
            level: 'error',
            event: 'llm.response.exception',
            detail: { error: String(err && err.message || err) },
        });
        if (turnContext?.turn_no) {
            try {
                await finalizeAssistantTurnPersistence({
                    agent_id: cleanAgentId,
                    session_id: turnContext.session_id,
                    turn_no: turnContext.turn_no,
                    trace_id,
                    span_id: outboundSpanId,
                    status: 500,
                    latency_ms,
                    model: cleanModelOverride || null,
                    output: null,
                    error: 'agent_respond_failed',
                    usage: null,
                    decision_snapshot: buildDecisionSnapshot({ route: routeTemplate, exception: String(err && err.message || err) }),
                });
            }
            catch (_) {}
        }
        return { status: 500, payload: { ok: false, error: 'agent_respond_failed', trace_id, latency_ms, session_id: resolvedSessionId } };
    }
}

const agentRespondHandler = async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    let agentId = String(req.params.id || '').trim();
    const endpointKey = String(req.params.endpointKey || '').trim();
    if (!agentId && endpointKey) {
        agentId = await resolveAgentIdByEndpointKey(endpointKey);
    }
    const input = String(req.body?.input ?? req.body?.message ?? '').trim();
    const sessionId = String(req.body?.session_id || '').trim() || null;
    const modelOverride = String(req.body?.model || '').trim();
    const routeTemplate = req.route?.path ? `${req.method} ${String(req.route.path)}` : `POST ${req.path}`;
    const completion = await runAgentCompletion({
        trace_id,
        routeTemplate,
        agentId,
        endpointKey,
        input,
        sessionId,
        modelOverride,
    });
    return res.status(completion.status).json(completion.payload);
};

app.post('/api/agents/:id/respond', agentRespondHandler);
app.post('/api/agent-endpoints/:endpointKey/respond', agentRespondHandler);
app.get('/v1/models', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const endpointKey = parseBearerToken(req.headers.authorization);
    if (!endpointKey) {
        res.setHeader('x-error', 'missing_endpoint_bearer_token');
        return res.status(401).json(formatOpenAiError({
            message: 'Missing bearer token. Use endpoint key as Authorization bearer token.',
            type: 'authentication_error',
            code: 'missing_bearer_token',
            trace_id,
        }));
    }
    const agentId = await resolveAgentIdByEndpointKey(endpointKey);
    if (!agentId) {
        res.setHeader('x-error', 'invalid_endpoint_key');
        return res.status(403).json(formatOpenAiError({
            message: 'Invalid endpoint key.',
            type: 'authentication_error',
            code: 'invalid_endpoint_key',
            trace_id,
        }));
    }
    try {
        const rowRes = await pool.query(
            `SELECT a.id, a.name, a.model_uuid, m.model_id, m.label
             FROM agents a
             LEFT JOIN llm_registry m
               ON m.id = a.model_uuid
              AND m.record_type = 'model'
             WHERE a.id = $1
             LIMIT 1`,
            [agentId]
        );
        if (rowRes.rowCount === 0) {
            return res.json({ object: 'list', data: [] });
        }
        const row = rowRes.rows[0] || {};
        const nowSec = Math.floor(Date.now() / 1000);
        const safeName = String(row.name || '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '')
            .slice(0, 64);
        const preferredId = firstNonEmptyString(row.model_id, safeName, String(row.id || '').trim(), 'agent-model');
        const aliases = [
            preferredId,
            safeName || null,
            String(row.id || '').trim() || null,
        ].filter(Boolean);
        const seen = new Set();
        const data = aliases
            .map((id) => String(id || '').trim())
            .filter((id) => {
                if (!id || seen.has(id)) return false;
                seen.add(id);
                return true;
            })
            .map((id) => ({
                id,
                object: 'model',
                created: nowSec,
                owned_by: 'ghost-agent-endpoint',
                permission: [],
                root: preferredId,
                parent: null,
                metadata: {
                    agent_id: String(row.id || ''),
                    agent_name: String(row.name || ''),
                    endpoint_key_suffix: String(endpointKey || '').slice(-8),
                    label: String(row.label || ''),
                },
            }));
        return res.json({ object: 'list', data });
    } catch (error) {
        res.setHeader('x-error', 'models_list_failed');
        return res.status(500).json(formatOpenAiError({
            message: String(error?.message || error),
            type: 'api_error',
            code: 'models_list_failed',
            trace_id,
        }));
    }
});
app.post('/v1/chat/completions', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const authHeader = req.headers.authorization;
    const endpointKey = parseBearerToken(authHeader);
    if (!endpointKey) {
        res.setHeader('x-error', 'missing_endpoint_bearer_token');
        return res.status(401).json(formatOpenAiError({
            message: 'Missing bearer token. Use endpoint key as Authorization bearer token.',
            type: 'authentication_error',
            code: 'missing_bearer_token',
            trace_id,
        }));
    }
    const agentId = await resolveAgentIdByEndpointKey(endpointKey);
    if (!agentId) {
        res.setHeader('x-error', 'invalid_endpoint_key');
        return res.status(403).json(formatOpenAiError({
            message: 'Invalid endpoint key.',
            type: 'authentication_error',
            code: 'invalid_endpoint_key',
            trace_id,
        }));
    }
    const input = extractOpenAiInput(req.body?.messages);
    if (!input) {
        res.setHeader('x-error', 'missing_messages');
        return res.status(400).json(formatOpenAiError({
            message: 'messages must include at least one text user message.',
            type: 'invalid_request_error',
            code: 'missing_messages',
            trace_id,
        }));
    }
    const sessionId = String(req.body?.metadata?.session_id || req.body?.session_id || req.body?.user || '').trim() || null;
    const modelOverride = String(req.body?.model || '').trim();
    const routeTemplate = req.route?.path ? `${req.method} ${String(req.route.path)}` : `POST ${req.path}`;
    const completion = await runAgentCompletion({
        trace_id,
        routeTemplate,
        agentId,
        endpointKey,
        input,
        sessionId,
        modelOverride,
    });
    if (completion.status !== 200) {
        const errorCode = String(completion.payload?.error || 'chat_completion_failed');
        const errorType = completion.status === 400
            ? 'invalid_request_error'
            : completion.status === 401 || completion.status === 403
                ? 'authentication_error'
                : 'api_error';
        res.setHeader('x-error', errorCode);
        return res.status(completion.status).json(formatOpenAiError({
            message: errorCode,
            type: errorType,
            code: errorCode,
            trace_id,
        }));
    }
    const output = String(completion.payload?.output || '').trim();
    const responseModel = String(modelOverride || completion.payload?.model || 'unknown').trim();
    const usage = normalizeOpenAiUsage(completion.payload?.usage || null);
    const completionId = `chatcmpl_${crypto.randomUUID().replace(/-/g, '')}`;
    const createdTs = Math.floor(Date.now() / 1000);
    const wantsStream = req.body?.stream === true;

    if (wantsStream) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        if (typeof res.flushHeaders === 'function') res.flushHeaders();

        const writeEvent = (payload) => {
            if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify(payload)}\n\n`);
                if (typeof res.flush === 'function') res.flush();
            }
        };
        const splitStreamChunks = (text, chunkSize = STREAM_CHUNK_SIZE) => {
            const value = String(text || '');
            if (!value) return [];
            const chunks = [];
            for (let i = 0; i < value.length; i += chunkSize) {
                chunks.push(value.slice(i, i + chunkSize));
            }
            return chunks;
        };
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

        writeEvent({
            id: completionId,
            object: 'chat.completion.chunk',
            created: createdTs,
            model: responseModel,
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        });

        for (const part of splitStreamChunks(output)) {
            writeEvent({
                id: completionId,
                object: 'chat.completion.chunk',
                created: createdTs,
                model: responseModel,
                choices: [{ index: 0, delta: { content: part }, finish_reason: null }],
            });
            // Small pacing makes UI render incrementally instead of one large burst.
            await sleep(STREAM_CHUNK_DELAY_MS);
        }

        const doneChunk = {
            id: completionId,
            object: 'chat.completion.chunk',
            created: createdTs,
            model: responseModel,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        };
        if (usage) doneChunk.usage = usage;
        writeEvent(doneChunk);
        if (!res.writableEnded) {
            res.write('data: [DONE]\n\n');
            if (typeof res.flush === 'function') res.flush();
            res.end();
        }
        return;
    }

    const response = {
        id: completionId,
        object: 'chat.completion',
        created: createdTs,
        model: responseModel,
        choices: [
            {
                index: 0,
                message: { role: 'assistant', content: output },
                finish_reason: 'stop',
            },
        ],
        ghost_runtime_path: completion.payload?.runtime_path || null,
    };
    if (usage) response.usage = usage;
    return res.status(200).json(response);
});
app.post('/v1/responses', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const authHeader = req.headers.authorization;
    const endpointKey = parseBearerToken(authHeader);
    if (!endpointKey) {
        res.setHeader('x-error', 'missing_endpoint_bearer_token');
        return res.status(401).json(formatOpenAiError({
            message: 'Missing bearer token. Use endpoint key as Authorization bearer token.',
            type: 'authentication_error',
            code: 'missing_bearer_token',
            trace_id,
        }));
    }
    const agentId = await resolveAgentIdByEndpointKey(endpointKey);
    if (!agentId) {
        res.setHeader('x-error', 'invalid_endpoint_key');
        return res.status(403).json(formatOpenAiError({
            message: 'Invalid endpoint key.',
            type: 'authentication_error',
            code: 'invalid_endpoint_key',
            trace_id,
        }));
    }
    const inputText = firstNonEmptyString(
        extractResponsesInput(req.body?.input),
        extractOpenAiInput(req.body?.messages),
        String(req.body?.text || '').trim()
    );
    if (!inputText) {
        res.setHeader('x-error', 'missing_input');
        return res.status(400).json(formatOpenAiError({
            message: 'input must include at least one text user message.',
            type: 'invalid_request_error',
            code: 'missing_input',
            trace_id,
        }));
    }
    const instructions = String(req.body?.instructions || '').trim();
    const routedInput = instructions ? `${instructions}\n\n${inputText}` : inputText;
    const sessionId = String(req.body?.metadata?.session_id || req.body?.session_id || req.body?.user || '').trim() || null;
    const modelOverride = String(req.body?.model || '').trim();
    const routeTemplate = req.route?.path ? `${req.method} ${String(req.route.path)}` : `POST ${req.path}`;
    const completion = await runAgentCompletion({
        trace_id,
        routeTemplate,
        agentId,
        endpointKey,
        input: routedInput,
        sessionId,
        modelOverride,
    });
    if (completion.status !== 200) {
        const errorCode = String(completion.payload?.error || 'responses_failed');
        const errorType = completion.status === 400
            ? 'invalid_request_error'
            : completion.status === 401 || completion.status === 403
                ? 'authentication_error'
                : 'api_error';
        res.setHeader('x-error', errorCode);
        return res.status(completion.status).json(formatOpenAiError({
            message: errorCode,
            type: errorType,
            code: errorCode,
            trace_id,
        }));
    }
    const output = String(completion.payload?.output || '').trim();
    const responseModel = String(modelOverride || completion.payload?.model || 'unknown').trim();
    const usage = normalizeOpenAiUsage(completion.payload?.usage || null);
    const response = {
        id: `resp_${crypto.randomUUID().replace(/-/g, '')}`,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        status: 'completed',
        model: responseModel,
        output_text: output,
        output: [
            {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: output }],
            },
        ],
        usage: usage || null,
    };
    return res.status(200).json(response);
});

wsAgentRespond.on('connection', (socket, req) => {
    const parsedUrl = new URL(req.url || '/ws/agents/respond', 'http://localhost');
    const agentId = String(parsedUrl.searchParams.get('agent_id') || '').trim();
    const sessionId = resolveSessionId(parsedUrl.searchParams.get('session_id'));
    const modelOverride = String(parsedUrl.searchParams.get('model') || '').trim();
    const trace_id = parseTraceId(req.headers['x-trace-id']);
    const span_id = crypto.randomUUID();
    const start = Date.now();
    const outboundSpanId = crypto.randomUUID();

    const send = (payload) => {
        if (socket.readyState === 1) socket.send(JSON.stringify(payload));
    };

    send({ type: 'meta', trace_id, span_id, agent_id: agentId || null, session_id: sessionId });
    insertLlmDebugLog({
        trace_id,
        span_id: outboundSpanId,
        agent_id: agentId || null,
        session_id: sessionId,
        level: 'debug',
        event: 'llm.ws.connected',
        detail: { url: req.url || '', model_override: modelOverride || null },
    });

    socket.on('message', async (raw) => {
        const requestStart = Date.now();
        const requestStartTs = nowIso();
        let requestLogWritten = false;
        const writeWsRequestLog = async ({ status, error = null, metadata = {} }) => {
            if (requestLogWritten) return;
            requestLogWritten = true;
            await insertRequestLogRow({
                trace_id,
                span_id: outboundSpanId,
                route: 'WS /ws/agents/respond',
                start_ts: requestStartTs,
                end_ts: nowIso(),
                latency_ms: Math.max(1, Date.now() - requestStart),
                status,
                error,
                metadata: sanitizeForLogs({
                    agent_id: agentId || null,
                    session_id: sessionId,
                    ...metadata,
                }),
            });
        };
        const incoming = String(raw || '').trim();
        let input = incoming;
        let turnContext = null;
        try {
            const parsed = JSON.parse(incoming);
            input = String(parsed?.input ?? parsed?.message ?? incoming).trim();
        }
        catch (_) {}

        if (!agentId || !input) {
            await writeWsRequestLog({
                status: 400,
                error: 'missing_agent_or_input',
                metadata: { input_present: Boolean(input), raw_preview: incoming.slice(0, 1000) },
            });
            send({ type: 'error', error: 'missing_agent_or_input' });
            return;
        }
        try {
            const state = await loadAgentPromptState(agentId);
            if (!state) {
                await writeWsRequestLog({
                    status: 404,
                    error: 'agent_not_found',
                });
                send({ type: 'error', error: 'agent_not_found' });
                return;
            }
            const { agent, controls, styleOverlay, activeInjections, prepend, append, styleHint, controlHint } = state;
            let model = state.model;
            const runtimeSettings = resolveAgentRuntimeSettings(controls || {});
            const wsCompletionResolved = await resolveAgentCompletionModelView(model, runtimeSettings.completion_model_uuid);
            if (wsCompletionResolved.error) {
                await writeWsRequestLog({
                    status: 400,
                    error: wsCompletionResolved.error,
                    metadata: { hint: 'strategy_runtime.completion_model_uuid' },
                });
                send({
                    type: 'error',
                    error: wsCompletionResolved.error,
                    message: 'Invalid or disabled completion_model_uuid in runtime controls.',
                });
                return;
            }
            model = wsCompletionResolved.model;
            if (runtimeSettings.max_input_chars && input.length > runtimeSettings.max_input_chars) {
                await writeWsRequestLog({
                    status: 400,
                    error: 'input_exceeds_max_input_chars',
                    metadata: { max_input_chars: runtimeSettings.max_input_chars, input_chars: input.length },
                });
                send({ type: 'error', error: 'input_exceeds_max_input_chars', message: `Input exceeds max_input_chars (${runtimeSettings.max_input_chars}).` });
                return;
            }
            try {
                turnContext = await beginAgentTurnPersistence({
                    agent_id: agentId,
                    session_id: sessionId,
                    trace_id,
                    span_id: outboundSpanId,
                    input,
                    route: 'WS /ws/agents/respond',
                    transport: 'ws',
                });
            }
            catch (persistErr) {
                await insertLlmDebugLog({
                    trace_id,
                    span_id: outboundSpanId,
                    agent_id: agentId,
                    session_id: sessionId,
                    level: 'error',
                    event: 'agent.turn.persist.user_failed',
                    detail: { error: String(persistErr && persistErr.message || persistErr) },
                });
            }
            const knowledgeRetrieval = await runKnowledgeRetrieval({
                query: String(input || '').trim(),
                limit: 6,
                mode: runtimeSettings.retrieval_mode || '',
                trace_id,
                span_id: outboundSpanId,
                upstream_context: runtimeSettings.runtimeCollectionName
                    ? {
                        metadata: {
                            agent_id: agentId,
                            tool_id: null,
                            collection_name: runtimeSettings.runtimeCollectionName,
                            index_id: runtimeSettings.runtimeCollectionName,
                        },
                        collection_name: runtimeSettings.runtimeCollectionName,
                        index_id: runtimeSettings.runtimeCollectionName,
                    }
                    : {
                        metadata: {
                            agent_id: agentId,
                            tool_id: null,
                        },
                    },
                options: { skip_llamaindex: runtimeSettings.skip_llamaindex_retrieval === true },
            }).catch(() => ({ mode: 'vector', rows: [], diagnostics: { candidate_count: 0, graph_hops: 0 } }));
            const degradedReason = String(knowledgeRetrieval?.diagnostics?.degraded_reason || '').trim().toLowerCase();
            const strictCollectionMode = runtimeSettings.strict_evidence === true && runtimeSettings.collection_only === true;
            const upstreamAuthFailure = degradedReason === 'llamaindex_status_401' || degradedReason === 'llamaindex_status_403';
            if (strictCollectionMode && upstreamAuthFailure) {
                await writeWsRequestLog({
                    status: 503,
                    error: 'retrieval_upstream_auth_failed_strict_mode',
                    metadata: {
                        strict_evidence: runtimeSettings.strict_evidence,
                        collection_only: runtimeSettings.collection_only,
                        retrieval_degraded_reason: degradedReason,
                    },
                });
                send({
                    type: 'error',
                    error: 'retrieval_upstream_auth_failed_strict_mode',
                    message: 'Strict evidence mode is enabled and upstream retrieval authentication failed.',
                });
                return;
            }
            const knowledgeInjection = buildKnowledgeInjectionBlock(knowledgeRetrieval, Number(runtimeSettings.top_k) || 12);
            const systemParts = [String(agent.system_prompt || '').trim(), prepend, styleHint, controlHint, knowledgeInjection].filter(Boolean);
            const systemPrompt = systemParts.join('\n\n');
            const userPrompt = append ? `${input}\n\n${append}` : input;
            const providerBaseUrl = String(model?.base_url || VLLM_INTERNAL_BASE_URL || '').trim();
            const resolvedModelId = resolveRuntimeModelId({
                modelOverride,
                providerSlug: model?.provider_slug || 'default',
                configuredModelId: model?.model_id,
            });
            const llmApiMode = resolveLlmApiMode({
                apiModeRaw: model?.config?.api_mode,
                baseUrl: providerBaseUrl,
                modelId: resolvedModelId,
            });
            const endpoint = llmApiMode === 'responses'
                ? resolveOpenAiResponsesUrl(providerBaseUrl)
                : resolveOpenAiChatCompletionsUrl(providerBaseUrl);
            if (!endpoint) {
                if (turnContext?.turn_no) {
                    try {
                        await finalizeAssistantTurnPersistence({
                            agent_id: agentId,
                            session_id: turnContext.session_id,
                            turn_no: turnContext.turn_no,
                            trace_id,
                            span_id: outboundSpanId,
                            status: 503,
                            latency_ms: Date.now() - start,
                            model: resolvedModelId || null,
                            output: null,
                            error: 'model_provider_base_url_missing',
                            usage: null,
                            decision_snapshot: buildDecisionSnapshot({ route: 'WS /ws/agents/respond', error: 'model_provider_base_url_missing' }),
                        });
                    }
                    catch (_) {}
                }
                await writeWsRequestLog({
                    status: 503,
                    error: 'model_provider_base_url_missing',
                    metadata: { model: resolvedModelId || null },
                });
                send({ type: 'error', error: 'model_provider_base_url_missing' });
                return;
            }
            const body = {
                model: resolvedModelId,
                messages: [
                    { role: 'system', content: systemPrompt || 'You are a controlled assistant.' },
                    { role: 'user', content: userPrompt },
                ],
            };
            if (runtimeSettings.temperature !== null) body.temperature = runtimeSettings.temperature;
            if (runtimeSettings.max_tokens !== null) body.max_tokens = runtimeSettings.max_tokens;
            if (runtimeSettings.top_p !== null) body.top_p = runtimeSettings.top_p;
            if (runtimeSettings.presence_penalty !== null) body.presence_penalty = runtimeSettings.presence_penalty;
            if (runtimeSettings.frequency_penalty !== null) body.frequency_penalty = runtimeSettings.frequency_penalty;
            if (runtimeSettings.stop.length > 0) body.stop = runtimeSettings.stop;
            const configuredReasoningEffort = String(model?.config?.reasoning_effort || '').trim().toLowerCase();
            const configuredVerbosity = String(model?.config?.verbosity || '').trim().toLowerCase();
            const headers = { 'Content-Type': 'application/json' };
            const settingsState = await getEngineSettings().catch(() => ({ config: {} }));
            const resolvedProviderApiKey = resolveStoredProviderSecret(settingsState.config || {}, {
                id: model?.provider_id,
                slug: model?.provider_slug,
                name: model?.provider_name,
                base_url: providerBaseUrl,
                api_key_env: model?.api_key_env,
            });
            const providerAuthHeader = resolveAssistantApiKeyHeaderName({
                base_url: providerBaseUrl,
                slug: model?.provider_slug,
                api_key_env: model?.api_key_env,
                name: model?.provider_name,
            });
            Object.assign(headers, buildApiKeyHeaders(resolvedProviderApiKey, providerAuthHeader));
            const preparedRequest = prepareLlmChatRequest({
                llm: {
                    model_uuid: model?.id || null,
                    model_id: resolvedModelId,
                    chat_url: endpoint,
                    api_key: resolvedProviderApiKey,
                    provider_kind: model?.provider_kind,
                    provider_slug: model?.provider_slug,
                    token_policy: model?.token_policy || normalizeModelTokenPolicy({}, resolveLlmTokenPolicyDefaults(settingsState.config || {})),
                },
                body,
                route: 'WS /ws/agents/respond',
            });
            if (!preparedRequest.ok) {
                await writeWsRequestLog({
                    status: preparedRequest.status || 400,
                    error: preparedRequest.error,
                    metadata: { token_policy: preparedRequest.token_policy, message: preparedRequest.message },
                });
                send({ type: 'error', error: preparedRequest.error, message: preparedRequest.message });
                return;
            }
            if (!resolvedProviderApiKey) {
                await writeWsRequestLog({
                    status: 401,
                    error: 'provider_api_key_missing',
                    metadata: { model: resolvedModelId || null, endpoint, api_mode: llmApiMode },
                });
                send({ type: 'error', error: 'provider_api_key_missing', message: 'Provider API key is not configured.' });
                return;
            }
            const preparedBody = preparedRequest.body;
            const upstreamPayload = llmApiMode === 'responses'
                ? (() => {
                    const payload = {
                        model: preparedBody.model,
                        instructions: firstNonEmptyString(
                            ...((Array.isArray(preparedBody.messages) ? preparedBody.messages : [])
                                .filter((message) => String(message?.role || '').trim().toLowerCase() === 'system')
                                .map((message) => String(message?.content || '').trim())
                                .filter(Boolean))
                        ) || undefined,
                        input: toResponsesInput(preparedBody.messages),
                        max_output_tokens: preparedBody.max_tokens,
                    };
                    if (Number.isFinite(Number(preparedBody.temperature))) payload.temperature = Number(preparedBody.temperature);
                    if (Number.isFinite(Number(preparedBody.top_p))) payload.top_p = Number(preparedBody.top_p);
                    if (Array.isArray(preparedBody.stop) && preparedBody.stop.length > 0) payload.stop = preparedBody.stop;
                    if (['minimal', 'low', 'medium', 'high'].includes(configuredReasoningEffort)) {
                        payload.reasoning = { effort: configuredReasoningEffort };
                    }
                    if (['low', 'medium', 'high'].includes(configuredVerbosity)) {
                        payload.text = { verbosity: configuredVerbosity };
                    }
                    return payload;
                })()
                : { ...preparedBody, stream: true };

            await insertLlmDebugLog({
                trace_id,
                span_id: outboundSpanId,
                agent_id: agentId,
                session_id: sessionId,
                level: 'debug',
                event: 'llm.ws.request.build',
                detail: {
                    model: preparedBody.model,
                    endpoint,
                    api_mode: llmApiMode,
                    provider: model?.provider_slug || 'default',
                    has_api_key: !!resolvedProviderApiKey,
                    auth_header_name: providerAuthHeader,
                    runtime_collection_name: runtimeSettings.runtimeCollectionName || null,
                    controls,
                    style_overlay: styleOverlay,
                    injections_applied: activeInjections.map((i) => ({ id: i.id, mode: i.mode, one_shot: i.one_shot })),
                    input,
                    token_policy: preparedRequest.token_policy,
                    skip_llamaindex_retrieval: runtimeSettings.skip_llamaindex_retrieval === true,
                    completion_model_uuid: runtimeSettings.completion_model_uuid || null,
                },
            });

            const configuredTools = (() => {
                if (Array.isArray(agent.tools)) return agent.tools.map((tool) => String(tool || '').trim()).filter(Boolean);
                if (typeof agent.tools === 'string') {
                    try {
                        const parsed = JSON.parse(agent.tools);
                        return Array.isArray(parsed) ? parsed.map((tool) => String(tool || '').trim()).filter(Boolean) : [];
                    }
                    catch (_) {
                        return [];
                    }
                }
                return [];
            })();
            send({
                type: 'accepted',
                trace_id,
                session_id: turnContext?.session_id || sessionId,
                model: model?.label || preparedBody.model,
                api_mode: llmApiMode,
                configured_tools: configuredTools,
                token_policy: preparedRequest.token_policy || null,
                token_policy_notice: preparedRequest.notice || null,
            });

            let output = '';
            let tokenIndex = 0;
            let thinkingCount = 0;
            const streamToolEvents = [];
            const streamStartPayload = llmApiMode === 'responses'
                ? { ...upstreamPayload, stream: true }
                : upstreamPayload;
            const onParsedStreamEvent = (parsed) => {
                const thoughtEntries = extractStreamThinkingEntries(parsed);
                for (const thought of thoughtEntries) {
                    thinkingCount += 1;
                    send({
                        type: 'thinking',
                        trace_id,
                        index: thinkingCount,
                        text: String(thought || '').trim(),
                    });
                }
                const toolEvents = extractStreamToolEvents(parsed);
                for (const toolEvent of toolEvents) {
                    const eventPayload = {
                        index: streamToolEvents.length + 1,
                        id: toolEvent.id || null,
                        name: toolEvent.name || 'unknown_tool',
                        type: toolEvent.type || 'tool_call',
                        arguments: toolEvent.arguments || '',
                        status: toolEvent.status || null,
                        source_event: toolEvent.source_event || null,
                    };
                    streamToolEvents.push(eventPayload);
                    send({ type: 'tool', trace_id, ...eventPayload });
                }
            };

            let upstreamRes = await fetch(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify(streamStartPayload),
            });

            if (!upstreamRes.ok || !upstreamRes.body) {
                const failBody = await upstreamRes.text().catch(() => '');
                const streamUnsupported = upstreamRes.status === 400 && /stream\s*=\s*true\s+is\s+not\s+supported/i.test(failBody);
                if (streamUnsupported) {
                    send({ type: 'thinking', trace_id, phase: 'provider_stream_unsupported_fallback' });
                    upstreamRes = await fetch(endpoint, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify(upstreamPayload),
                    });
                    const fallbackBody = await upstreamRes.json().catch(() => ({}));
                    if (!upstreamRes.ok) {
                        await insertLlmDebugLog({
                            trace_id,
                            span_id: outboundSpanId,
                            agent_id: agentId,
                            session_id: sessionId,
                            level: 'error',
                            event: 'llm.ws.upstream_failed',
                            detail: { status: upstreamRes.status, body: JSON.stringify(fallbackBody).slice(0, 2000), fallback_mode: 'non_streaming' },
                        });
                        if (turnContext?.turn_no) {
                            try {
                                await finalizeAssistantTurnPersistence({
                                    agent_id: agentId,
                                    session_id: turnContext.session_id,
                                    turn_no: turnContext.turn_no,
                                    trace_id,
                                    span_id: outboundSpanId,
                                    status: upstreamRes.status || 502,
                                    latency_ms: Date.now() - start,
                                    model: preparedBody.model,
                                    output: null,
                                    error: 'llm_upstream_failed',
                                    usage: null,
                                    decision_snapshot: buildDecisionSnapshot({ upstream_status: upstreamRes.status, route: 'WS /ws/agents/respond', fallback_mode: 'non_streaming' }),
                                });
                            }
                            catch (_) {}
                        }
                        await writeWsRequestLog({
                            status: upstreamRes.status || 502,
                            error: 'llm_upstream_failed',
                            metadata: {
                                endpoint,
                                api_mode: llmApiMode,
                                model: preparedBody.model,
                                upstream_status: upstreamRes.status || null,
                                fallback_mode: 'non_streaming',
                                token_policy: preparedRequest.token_policy,
                            },
                        });
                        send({ type: 'error', error: 'llm_upstream_failed', status: upstreamRes.status, data: JSON.stringify(fallbackBody).slice(0, 1000) });
                        return;
                    }
                    output = String(extractLlmTextFromUpstreamBody(fallbackBody) || '').trim();
                    const chunks = splitTextForStreaming(output, 24);
                    for (let idx = 0; idx < chunks.length; idx += 1) {
                        const delta = String(chunks[idx] || '');
                        if (!delta) continue;
                        tokenIndex += 1;
                        send({ type: 'token', index: tokenIndex, text: delta });
                        if (idx < chunks.length - 1) {
                            // Small delay keeps fallback readable instead of one-frame dump.
                            await wait(20);
                        }
                    }
                }
                else {
                    await insertLlmDebugLog({
                        trace_id,
                        span_id: outboundSpanId,
                        agent_id: agentId,
                        session_id: sessionId,
                        level: 'error',
                        event: 'llm.ws.upstream_failed',
                        detail: { status: upstreamRes.status, body: failBody.slice(0, 2000) },
                    });
                    if (turnContext?.turn_no) {
                        try {
                            await finalizeAssistantTurnPersistence({
                                agent_id: agentId,
                                session_id: turnContext.session_id,
                                turn_no: turnContext.turn_no,
                                trace_id,
                                span_id: outboundSpanId,
                                status: upstreamRes.status || 502,
                                latency_ms: Date.now() - start,
                                model: preparedBody.model,
                                output: null,
                                error: 'llm_upstream_failed',
                                usage: null,
                                decision_snapshot: buildDecisionSnapshot({ upstream_status: upstreamRes.status, route: 'WS /ws/agents/respond' }),
                            });
                        }
                        catch (_) {}
                    }
                    await writeWsRequestLog({
                        status: upstreamRes.status || 502,
                        error: 'llm_upstream_failed',
                        metadata: {
                            endpoint,
                            api_mode: llmApiMode,
                            model: preparedBody.model,
                            upstream_status: upstreamRes.status || null,
                            upstream_has_body: Boolean(upstreamRes.body),
                            upstream_body_preview: failBody.slice(0, 1000),
                            token_policy: preparedRequest.token_policy,
                        },
                    });
                    send({ type: 'error', error: 'llm_upstream_failed', status: upstreamRes.status, data: failBody.slice(0, 1000) });
                    return;
                }
            }
            else {
                send({ type: 'thinking', trace_id, phase: 'provider_stream_open' });
                const decoder = new TextDecoder();
                const parser = createVllmStreamParser(
                    async (delta) => {
                        output += delta;
                        tokenIndex += 1;
                        send({ type: 'token', index: tokenIndex, text: delta });
                        await insertLlmDebugLog({
                            trace_id,
                            span_id: outboundSpanId,
                            agent_id: agentId,
                            session_id: sessionId,
                            level: 'debug',
                            event: 'llm.ws.token',
                            detail: { index: tokenIndex, text: delta },
                        });
                    },
                    () => {
                        send({ type: 'thinking', trace_id, phase: 'provider_stream_complete' });
                    },
                    onParsedStreamEvent
                );
                for await (const chunk of upstreamRes.body) {
                    parser(decoder.decode(chunk, { stream: true }));
                }
                parser('\n');
            }

            const oneShotIds = activeInjections.filter((i) => i.one_shot === true).map((i) => i.id);
            if (oneShotIds.length > 0) {
                await pool.query(`UPDATE agent_injections SET active = false WHERE id = ANY($1::uuid[])`, [oneShotIds]).catch(() => {});
            }

            if (runtimeSettings.max_output_chars && output.length > runtimeSettings.max_output_chars) {
                output = output.slice(0, runtimeSettings.max_output_chars);
            }
            const latency_ms = Date.now() - start;
            await insertLlmDebugLog({
                trace_id,
                span_id: outboundSpanId,
                agent_id: agentId,
                session_id: sessionId,
                level: 'debug',
                event: 'llm.ws.done',
                detail: { token_count: tokenIndex, tool_event_count: streamToolEvents.length, thinking_count: thinkingCount, output, latency_ms },
            });
            try {
                await writeWsRequestLog({
                    status: 200,
                    metadata: {
                        model: preparedBody.model,
                        endpoint,
                        api_mode: llmApiMode,
                        output,
                        token_count: tokenIndex,
                        tool_event_count: streamToolEvents.length,
                        thinking_event_count: thinkingCount,
                        token_policy: preparedRequest.token_policy,
                    },
                });
            }
            catch (_) {}
            if (turnContext?.turn_no) {
                try {
                    await finalizeAssistantTurnPersistence({
                        agent_id: agentId,
                        session_id: turnContext.session_id,
                        turn_no: turnContext.turn_no,
                        trace_id,
                        span_id: outboundSpanId,
                        status: 200,
                        latency_ms,
                        model: preparedBody.model,
                        output,
                        error: null,
                        usage: null,
                        decision_snapshot: buildDecisionSnapshot({ route: 'WS /ws/agents/respond', token_count: tokenIndex, tool_event_count: streamToolEvents.length, thinking_count: thinkingCount }),
                    });
                }
                catch (_) {}
            }
            send({
                type: 'done',
                trace_id,
                latency_ms,
                output,
                model: model?.label || preparedBody.model,
                api_mode: llmApiMode,
                token_count: tokenIndex,
                tool_events: streamToolEvents,
                thinking_event_count: thinkingCount,
                configured_tools: configuredTools,
                token_policy: preparedRequest.token_policy || null,
                token_policy_notice: preparedRequest.notice || null,
            });
        }
        catch (err) {
            await insertLlmDebugLog({
                trace_id,
                span_id: outboundSpanId,
                agent_id: agentId || null,
                session_id: sessionId,
                level: 'error',
                event: 'llm.ws.exception',
                detail: { error: String(err && err.message || err) },
            });
            if (turnContext?.turn_no) {
                try {
                    await finalizeAssistantTurnPersistence({
                        agent_id: agentId,
                        session_id: turnContext.session_id,
                        turn_no: turnContext.turn_no,
                        trace_id,
                        span_id: outboundSpanId,
                        status: 500,
                        latency_ms: Date.now() - start,
                        model: modelOverride || null,
                        output: null,
                        error: 'ws_agent_respond_failed',
                        usage: null,
                        decision_snapshot: buildDecisionSnapshot({ route: 'WS /ws/agents/respond', exception: String(err && err.message || err) }),
                    });
                }
                catch (_) {}
            }
            await writeWsRequestLog({
                status: 500,
                error: 'ws_agent_respond_failed',
                metadata: { message: String(err && err.message || err) },
            });
            send({ type: 'error', error: 'ws_agent_respond_failed', message: String(err && err.message || err) });
        }
    });
});

// POST /api/tools — create tool (idempotent by name+kind)
app.post('/api/tools', async (req, res) => {
    const { name, kind, config } = req.body || {};
    if (!name || !kind) {
        res.setHeader('x-error', 'missing_fields');
        return res.status(400).json({ error: 'missing_fields' });
    }
    try {
        let nextConfig = config && typeof config === 'object' ? { ...config } : {};
        if (String(kind) === 'shopify_mcp') {
            const existing = await pool.query(
                `SELECT config FROM tools WHERE name = $1 AND kind = $2 LIMIT 1`,
                [String(name), String(kind)]
            );
            const existingConfig = existing.rowCount > 0 && existing.rows[0]?.config && typeof existing.rows[0].config === 'object'
                ? { ...existing.rows[0].config }
                : {};
            nextConfig = { ...existingConfig, ...nextConfig };
            // Never persist Shopify secrets in DB config.
            delete nextConfig.internal_key;
            delete nextConfig.api_token;
            nextConfig.module_url = String(nextConfig.module_url || '').trim().replace(/\/$/, '');
            nextConfig.base_url = String(nextConfig.base_url || '').trim().replace(/\/$/, '');
            nextConfig.test_path = String(nextConfig.test_path || '/health').trim() || '/health';
            nextConfig.execute_path = String(nextConfig.execute_path || '/tool').trim() || '/tool';
        }
        if (String(kind) === 'odoo_rpc') {
            const existing = await pool.query(
                `SELECT config FROM tools WHERE name = $1 AND kind = $2 LIMIT 1`,
                [String(name), String(kind)]
            );
            const existingConfig = existing.rowCount > 0 && existing.rows[0]?.config && typeof existing.rows[0].config === 'object'
                ? { ...existing.rows[0].config }
                : {};
            nextConfig = { ...existingConfig, ...nextConfig };
            // Never persist Odoo secrets in DB config.
            delete nextConfig.internal_key;
            delete nextConfig.api_token;
            nextConfig.module_url = String(nextConfig.module_url || '').trim().replace(/\/$/, '');
            nextConfig.base_url = String(nextConfig.base_url || '').trim().replace(/\/$/, '');
            nextConfig.test_path = String(nextConfig.test_path || '/health').trim() || '/health';
            nextConfig.execute_path = String(nextConfig.execute_path || '/tool').trim() || '/tool';
        }
        const r = await pool.query(
            `INSERT INTO tools (name, kind, config, status) VALUES ($1,$2,$3::jsonb,'active')
             ON CONFLICT (name, kind) DO UPDATE SET config = EXCLUDED.config, updated_at = now()
             RETURNING id, name, kind, config, status`,
            [String(name), String(kind), JSON.stringify(nextConfig)]
        );
        res.status(201).json(sanitizeToolForPublicView(r.rows[0]));
    }
    catch (e) {
        res.setHeader('x-error', 'tools_create_failed');
        res.status(500).json({ error: 'tools_create_failed' });
    }
});

// POST /api/tools/:id/test — tool connectivity + query test (hubtiger: POST /jobs/search)
app.post('/api/tools/:id/test', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const toolId = req.params.id;

    const toolRow = await pool.query('SELECT id, name, kind, config, status FROM tools WHERE id = $1', [toolId]);
    if (toolRow.rowCount === 0) {
        res.setHeader('x-error', 'tool_not_found');
        return res.status(404).json({ error: 'tool_not_found' });
    }
    const tool = toolRow.rows[0];
    if (tool.kind === 'shopify_mcp') {
        const start = Date.now();
        const start_ts = nowIso();
        const outboundSpanId = crypto.randomUUID();
        try {
            const settings = await getEngineSettings();
            const knowledge = resolveKnowledgeStorageSettings(settings.config || {});
            const toolConfig = tool.config && typeof tool.config === 'object' ? tool.config : {};
            const baseUrl = String(
                toolConfig.module_url
                || knowledge.shopify_mcp_url
                || SHOPIFY_MCP_URL
                || toolConfig.base_url
                || ''
            ).trim().replace(/\/$/, '');
            const testPath = String(toolConfig.test_path || '/health').trim() || '/health';
            const override = req.body && typeof req.body === 'object' && req.body.auth_override && typeof req.body.auth_override === 'object'
                ? req.body.auth_override
                : {};
            const internalKey = String(
                override.internal_key
                || knowledge.shopify_mcp_internal_key
                || process.env.SHOPIFY_MCP_INTERNAL_KEY
                || ''
            ).trim();
            const apiToken = String(override.api_token || process.env.SHOPIFY_MCP_API_TOKEN || '').trim();
            if (!baseUrl) {
                res.setHeader('x-error', 'shopify_mcp_unavailable');
                return res.status(503).json({ ok: false, error: 'shopify_mcp_unavailable', trace_id });
            }
            const authHeaders = {};
            if (internalKey) authHeaders['x-internal-key'] = internalKey;
            if (apiToken) authHeaders.Authorization = `Bearer ${apiToken}`;
            const upstream = await fetch(`${baseUrl}${testPath.startsWith('/') ? testPath : `/${testPath}`}`, {
                method: 'GET',
                headers: {
                    'x-trace-id': trace_id,
                    'x-span-id': outboundSpanId,
                    ...authHeaders,
                },
                signal: AbortSignal.timeout(10000),
            });
            const latency_ms = Date.now() - start;
            const end_ts = nowIso();
            const text = await upstream.text().catch(() => '');
            const response_snippet = text ? (text.length > 500 ? `${text.slice(0, 500)}...` : text) : null;
            const errorDetail = upstream.ok ? null : `${upstream.status}: shopify_mcp_test_failed`;
            await pool.query(
                `INSERT INTO request_logs (trace_id, span_id, service, route, start_ts, end_ts, latency_ms, status, error, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                [trace_id, outboundSpanId, 'control-plane-api', `POST /api/tools/${toolId}/test`, start_ts, end_ts, latency_ms, upstream.status, errorDetail, JSON.stringify({
                    tool_id: toolId,
                    tool_kind: 'shopify_mcp',
                    upstream_route: `GET ${testPath}`,
                    upstream_status: upstream.status,
                    upstream_latency_ms: latency_ms,
                    upstream_url: baseUrl,
                })]
            ).catch(() => {});
            return res.status(upstream.ok ? 200 : 502).json({
                ok: upstream.ok,
                status: upstream.status,
                latency_ms,
                trace_id,
                response_snippet,
            });
        } catch (err) {
            const latency_ms = Date.now() - start;
            const end_ts = nowIso();
            await pool.query(
                `INSERT INTO request_logs (trace_id, span_id, service, route, start_ts, end_ts, latency_ms, status, error, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                [trace_id, outboundSpanId, 'control-plane-api', `POST /api/tools/${toolId}/test`, start_ts, end_ts, latency_ms, 0, String(err), JSON.stringify({
                    tool_id: toolId,
                    tool_kind: 'shopify_mcp',
                    upstream_route: 'GET /health',
                })]
            ).catch(() => {});
            res.setHeader('x-error', 'shopify_mcp_request_failed');
            return res.status(502).json({ ok: false, error: 'shopify_mcp_request_failed', latency_ms, trace_id });
        }
    }
    if (tool.kind === 'odoo_rpc') {
        const start = Date.now();
        const start_ts = nowIso();
        const outboundSpanId = crypto.randomUUID();
        try {
            const toolConfig = tool.config && typeof tool.config === 'object' ? tool.config : {};
            const baseUrl = String(
                toolConfig.module_url
                || ODOO_RPC_URL
                || toolConfig.base_url
                || ''
            ).trim().replace(/\/$/, '');
            const testPath = String(toolConfig.test_path || '/health').trim() || '/health';
            const override = req.body && typeof req.body === 'object' && req.body.auth_override && typeof req.body.auth_override === 'object'
                ? req.body.auth_override
                : {};
            const internalKey = String(
                override.internal_key
                || ODOO_RPC_INTERNAL_KEY
                || process.env.ODOO_RPC_INTERNAL_KEY
                || ''
            ).trim();
            const apiToken = String(override.api_token || process.env.ODOO_RPC_API_TOKEN || '').trim();
            if (!baseUrl) {
                res.setHeader('x-error', 'odoo_rpc_unavailable');
                return res.status(503).json({ ok: false, error: 'odoo_rpc_unavailable', trace_id });
            }
            const authHeaders = {};
            if (internalKey) authHeaders['x-internal-key'] = internalKey;
            if (apiToken) authHeaders.Authorization = `Bearer ${apiToken}`;
            const upstream = await fetch(`${baseUrl}${testPath.startsWith('/') ? testPath : `/${testPath}`}`, {
                method: 'GET',
                headers: {
                    'x-trace-id': trace_id,
                    'x-span-id': outboundSpanId,
                    ...authHeaders,
                },
                signal: AbortSignal.timeout(10000),
            });
            const latency_ms = Date.now() - start;
            const end_ts = nowIso();
            const text = await upstream.text().catch(() => '');
            const response_snippet = text ? (text.length > 500 ? `${text.slice(0, 500)}...` : text) : null;
            const errorDetail = upstream.ok ? null : `${upstream.status}: odoo_rpc_test_failed`;
            await pool.query(
                `INSERT INTO request_logs (trace_id, span_id, service, route, start_ts, end_ts, latency_ms, status, error, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                [trace_id, outboundSpanId, 'control-plane-api', `POST /api/tools/${toolId}/test`, start_ts, end_ts, latency_ms, upstream.status, errorDetail, JSON.stringify({
                    tool_id: toolId,
                    tool_kind: 'odoo_rpc',
                    upstream_route: `GET ${testPath}`,
                    upstream_status: upstream.status,
                    upstream_latency_ms: latency_ms,
                    upstream_url: baseUrl,
                })]
            ).catch(() => {});
            return res.status(upstream.ok ? 200 : 502).json({
                ok: upstream.ok,
                status: upstream.status,
                latency_ms,
                trace_id,
                response_snippet,
            });
        } catch (err) {
            const latency_ms = Date.now() - start;
            const end_ts = nowIso();
            await pool.query(
                `INSERT INTO request_logs (trace_id, span_id, service, route, start_ts, end_ts, latency_ms, status, error, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                [trace_id, outboundSpanId, 'control-plane-api', `POST /api/tools/${toolId}/test`, start_ts, end_ts, latency_ms, 0, String(err), JSON.stringify({
                    tool_id: toolId,
                    tool_kind: 'odoo_rpc',
                    upstream_route: 'GET /health',
                })]
            ).catch(() => {});
            res.setHeader('x-error', 'odoo_rpc_request_failed');
            return res.status(502).json({ ok: false, error: 'odoo_rpc_request_failed', latency_ms, trace_id });
        }
    }
    if (tool.kind !== 'hubtiger') {
        res.setHeader('x-error', 'test_not_supported');
        return res.status(400).json({ error: 'test_not_supported', kind: tool.kind });
    }

    if (!HUBTIGER_MCP_URL) {
        res.setHeader('x-error', 'hubtiger_mcp_unavailable');
        return res.status(503).json({ ok: false, error: 'hubtiger_mcp_unavailable', trace_id });
    }

    const start = Date.now();
    const start_ts = nowIso();
    const outboundSpanId = crypto.randomUUID();
    const mcpUrl = `${HUBTIGER_MCP_URL}/test`;

    try {
        const bodyIn = req.body && typeof req.body === 'object' ? req.body : {};
        const query = String(bodyIn.query ?? bodyIn.q ?? 'test').trim() || 'test';
        const response = await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-trace-id': trace_id, 'x-span-id': outboundSpanId },
            body: JSON.stringify({ query }),
        });
        const latency_ms = Date.now() - start;
        const end_ts = nowIso();
        const status = response.status;

        const ct = response.headers.get('content-type') || '';
        let upstreamBody = null;
        if (ct.includes('application/json')) {
            try { upstreamBody = await response.json(); } catch (_) {}
        } else if (!response.ok) {
            try {
                const rawText = await response.text();
                upstreamBody = { _raw: rawText.length > 2000 ? rawText.slice(0, 2000) + '...' : rawText };
            } catch (_) {}
        }

        let responseSnippet = null;
        if (upstreamBody != null) {
            try {
                const str = JSON.stringify(upstreamBody);
                responseSnippet = str.length > 500 ? str.slice(0, 500) + '...' : str;
            } catch (_) {}
        }

        let errorDetail = null;
        if (!response.ok) {
            const msg = upstreamBody && (upstreamBody.error || upstreamBody.message || (typeof upstreamBody._raw === 'string' ? upstreamBody._raw : null));
            errorDetail = msg ? `${status}: ${String(msg).slice(0, 500)}` : `hubtiger_mcp ${status}`;
        }

        const metadata = {
            tool_id: toolId,
            tool_kind: 'hubtiger',
            operation: 'jobs_search',
            upstream_route: 'POST /test',
            upstream_status: status,
            upstream_latency_ms: latency_ms,
            test_query: query,
        };
        if (upstreamBody != null) metadata.upstream_body = sanitizeForLogs(upstreamBody);
        metadata.request_payload = sanitizeForLogs({ query });

        try {
            await pool.query(
                `INSERT INTO request_logs (trace_id, span_id, service, route, start_ts, end_ts, latency_ms, status, error, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                [trace_id, outboundSpanId, 'control-plane-api', `POST /api/tools/${toolId}/test`, start_ts, end_ts, latency_ms, status, errorDetail, JSON.stringify(metadata)]
            );
        } catch (_) {}

        const body = {
            ok: response.ok,
            status,
            latency_ms,
            trace_id,
            response_snippet: responseSnippet,
            retry_count: Number(upstreamBody?.retry_count || 0),
            cache_hit: upstreamBody?.cache_hit === true,
            circuit_state: upstreamBody?.circuit_state || null,
        };
        res.status(response.ok ? 200 : 502).json(body);
    }
    catch (err) {
        const latency_ms = Date.now() - start;
        const end_ts = nowIso();
        const metadata = { tool_id: toolId, tool_kind: 'hubtiger', operation: 'jobs_search', upstream_route: 'POST /test', upstream_status: null, upstream_latency_ms: latency_ms };
        try {
            await pool.query(
                `INSERT INTO request_logs (trace_id, span_id, service, route, start_ts, end_ts, latency_ms, status, error, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                [trace_id, outboundSpanId, 'control-plane-api', `POST /api/tools/${toolId}/test`, start_ts, end_ts, latency_ms, 0, String(err), JSON.stringify(metadata)]
            );
        }
        catch (_) {}
        res.setHeader('x-error', 'hubtiger_mcp_request_failed');
        res.status(502).json({ ok: false, error: 'hubtiger_mcp_request_failed', latency_ms, trace_id });
    }
});

// POST /api/tools/:id/execute — voice-agent usable (operation + payload → hubtiger-proxy)
app.post('/api/tools/:id/execute', async (req, res) => {
    const trace_id = req.trace_id ?? parseTraceId(req.headers['x-trace-id']);
    const span_id = req.span_id ?? crypto.randomUUID();
    const toolId = req.params.id;
    const { operation: operationRaw, payload, agent_id } = req.body || {};

    const toolRow = await pool.query('SELECT id, name, kind, config, status FROM tools WHERE id = $1', [toolId]);
    if (toolRow.rowCount === 0) {
        res.setHeader('x-error', 'tool_not_found');
        return res.status(404).json({ error: 'tool_not_found' });
    }
    const tool = toolRow.rows[0];
    if (tool.kind === 'shopify_mcp') {
        const start = Date.now();
        const start_ts = nowIso();
        const outboundSpanId = crypto.randomUUID();
        try {
            const settings = await getEngineSettings();
            const knowledge = resolveKnowledgeStorageSettings(settings.config || {});
            const toolConfig = tool.config && typeof tool.config === 'object' ? tool.config : {};
            const baseUrl = String(
                toolConfig.module_url
                || knowledge.shopify_mcp_url
                || SHOPIFY_MCP_URL
                || toolConfig.base_url
                || ''
            ).trim().replace(/\/$/, '');
            const executePath = String(toolConfig.execute_path || '/tool').trim() || '/tool';
            const override = req.body && typeof req.body === 'object' && req.body.auth_override && typeof req.body.auth_override === 'object'
                ? req.body.auth_override
                : {};
            const internalKey = String(
                override.internal_key
                || knowledge.shopify_mcp_internal_key
                || process.env.SHOPIFY_MCP_INTERNAL_KEY
                || ''
            ).trim();
            const apiToken = String(override.api_token || process.env.SHOPIFY_MCP_API_TOKEN || '').trim();
            if (!baseUrl) {
                res.setHeader('x-error', 'shopify_mcp_unavailable');
                return res.status(503).json({ error: 'shopify_mcp_unavailable' });
            }
            const authHeaders = {};
            if (internalKey) authHeaders['x-internal-key'] = internalKey;
            if (apiToken) authHeaders.Authorization = `Bearer ${apiToken}`;
            const normalizedOperation = String(operationRaw || '').trim();
            if (!normalizedOperation) {
                return res.status(400).json({ error: 'missing_operation', hint: 'Provide operation and payload.' });
            }
            const upstreamPayload = {
                operation: normalizedOperation,
                payload: payload && typeof payload === 'object' ? payload : {},
                tool_id: toolId,
            };
            const upstream = await fetch(`${baseUrl}${executePath.startsWith('/') ? executePath : `/${executePath}`}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-trace-id': trace_id,
                    'x-span-id': outboundSpanId,
                    ...authHeaders,
                },
                body: JSON.stringify(upstreamPayload),
                signal: AbortSignal.timeout(20000),
            });
            const latency_ms = Date.now() - start;
            const end_ts = nowIso();
            const data = await upstream.json().catch(() => null);
            const errorDetail = upstream.ok ? null : `${upstream.status}: ${String(data?.error || 'shopify_mcp_execute_failed')}`;
            await pool.query(
                `INSERT INTO request_logs (trace_id, span_id, service, route, start_ts, end_ts, latency_ms, status, error, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                [trace_id, outboundSpanId, 'control-plane-api', `POST /api/tools/${toolId}/execute`, start_ts, end_ts, latency_ms, upstream.status, errorDetail, JSON.stringify({
                    tool_id: toolId,
                    tool_kind: 'shopify_mcp',
                    operation: normalizedOperation,
                    upstream_route: `POST ${executePath}`,
                    upstream_status: upstream.status,
                    upstream_latency_ms: latency_ms,
                    request_payload: sanitizeForLogs(payload ?? {}),
                })]
            ).catch(() => {});
            return res.status(upstream.status).json({
                ok: upstream.ok,
                trace_id,
                latency_ms,
                data,
            });
        } catch (err) {
            const latency_ms = Date.now() - start;
            const end_ts = nowIso();
            await pool.query(
                `INSERT INTO request_logs (trace_id, span_id, service, route, start_ts, end_ts, latency_ms, status, error, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                [trace_id, outboundSpanId, 'control-plane-api', `POST /api/tools/${toolId}/execute`, start_ts, end_ts, latency_ms, 0, String(err), JSON.stringify({
                    tool_id: toolId,
                    tool_kind: 'shopify_mcp',
                    operation: String(operationRaw || ''),
                })]
            ).catch(() => {});
            res.setHeader('x-error', 'shopify_mcp_request_failed');
            return res.status(502).json({ error: 'shopify_mcp_request_failed', message: String(err?.message || err) });
        }
    }
    if (tool.kind === 'odoo_rpc') {
        const start = Date.now();
        const start_ts = nowIso();
        const outboundSpanId = crypto.randomUUID();
        try {
            const toolConfig = tool.config && typeof tool.config === 'object' ? tool.config : {};
            const baseUrl = String(
                toolConfig.module_url
                || ODOO_RPC_URL
                || toolConfig.base_url
                || ''
            ).trim().replace(/\/$/, '');
            const executePath = String(toolConfig.execute_path || '/tool').trim() || '/tool';
            const override = req.body && typeof req.body === 'object' && req.body.auth_override && typeof req.body.auth_override === 'object'
                ? req.body.auth_override
                : {};
            const internalKey = String(
                override.internal_key
                || ODOO_RPC_INTERNAL_KEY
                || process.env.ODOO_RPC_INTERNAL_KEY
                || ''
            ).trim();
            const apiToken = String(override.api_token || process.env.ODOO_RPC_API_TOKEN || '').trim();
            if (!baseUrl) {
                res.setHeader('x-error', 'odoo_rpc_unavailable');
                return res.status(503).json({ error: 'odoo_rpc_unavailable' });
            }
            const authHeaders = {};
            if (internalKey) authHeaders['x-internal-key'] = internalKey;
            if (apiToken) authHeaders.Authorization = `Bearer ${apiToken}`;
            const normalizedOperation = String(operationRaw || '').trim();
            if (!normalizedOperation) {
                return res.status(400).json({ error: 'missing_operation', hint: 'Provide operation and payload.' });
            }
            const upstreamPayload = {
                operation: normalizedOperation,
                payload: payload && typeof payload === 'object' ? payload : {},
                tool_id: toolId,
            };
            const upstream = await fetch(`${baseUrl}${executePath.startsWith('/') ? executePath : `/${executePath}`}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-trace-id': trace_id,
                    'x-span-id': outboundSpanId,
                    ...authHeaders,
                },
                body: JSON.stringify(upstreamPayload),
                signal: AbortSignal.timeout(20000),
            });
            const latency_ms = Date.now() - start;
            const end_ts = nowIso();
            const data = await upstream.json().catch(() => null);
            const errorDetail = upstream.ok ? null : `${upstream.status}: ${String(data?.error || 'odoo_rpc_execute_failed')}`;
            await pool.query(
                `INSERT INTO request_logs (trace_id, span_id, service, route, start_ts, end_ts, latency_ms, status, error, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                [trace_id, outboundSpanId, 'control-plane-api', `POST /api/tools/${toolId}/execute`, start_ts, end_ts, latency_ms, upstream.status, errorDetail, JSON.stringify({
                    tool_id: toolId,
                    tool_kind: 'odoo_rpc',
                    operation: normalizedOperation,
                    upstream_route: `POST ${executePath}`,
                    upstream_status: upstream.status,
                    upstream_latency_ms: latency_ms,
                    request_payload: sanitizeForLogs(payload ?? {}),
                })]
            ).catch(() => {});
            return res.status(upstream.status).json({
                ok: upstream.ok,
                trace_id,
                latency_ms,
                data,
            });
        } catch (err) {
            const latency_ms = Date.now() - start;
            const end_ts = nowIso();
            await pool.query(
                `INSERT INTO request_logs (trace_id, span_id, service, route, start_ts, end_ts, latency_ms, status, error, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                [trace_id, outboundSpanId, 'control-plane-api', `POST /api/tools/${toolId}/execute`, start_ts, end_ts, latency_ms, 0, String(err), JSON.stringify({
                    tool_id: toolId,
                    tool_kind: 'odoo_rpc',
                    operation: String(operationRaw || ''),
                })]
            ).catch(() => {});
            res.setHeader('x-error', 'odoo_rpc_request_failed');
            return res.status(502).json({ error: 'odoo_rpc_request_failed', message: String(err?.message || err) });
        }
    }
    if (tool.kind !== 'hubtiger') {
        res.setHeader('x-error', 'execute_not_supported');
        return res.status(400).json({ error: 'execute_not_supported', kind: tool.kind });
    }

    if (!HUBTIGER_MCP_URL) {
        res.setHeader('x-error', 'hubtiger_mcp_unavailable');
        return res.status(503).json({ error: 'hubtiger_mcp_unavailable' });
    }

    const start = Date.now();
    const start_ts = nowIso();
    const outboundSpanId = crypto.randomUUID();

    let proxyPath, method, body;
    const operation = normalizeHubtigerOperation(operationRaw);
    const p = payload && typeof payload === 'object' ? payload : {};
    const toolConfig = tool.config && typeof tool.config === 'object' ? tool.config : {};
    if (operation === 'jobs_search') {
        const rawQuery = String(p.q ?? p.query ?? '').trim();
        const normalizedCallerId = normalizePhoneE164(
            p.callerId ?? p.caller_id ?? p.from ?? p.phone ?? '',
            String(p.countryCode ?? p.country ?? 'AU')
        );
        const query = rawQuery || normalizedCallerId || '';
        if (!query) {
            return res.status(400).json({
                error: 'missing_query',
                hint: 'Provide payload.q (or callerId/caller_id/from/phone for auto-normalized lookup).',
            });
        }
        proxyPath = '/jobs/search';
        method = 'POST';
        body = { q: query, allStores: p.allStores === true };
    }
    else if (operation === 'job_get') {
        const id = p.id ?? p.jobId;
        if (!id) {
            return res.status(400).json({ error: 'missing_job_id', hint: 'Use results[].id from jobs_search' });
        }
        proxyPath = `/jobs/${encodeURIComponent(String(id))}`;
        method = 'GET';
        body = null;
    }
    else if (operation === 'job_messages') {
        const jobId = p.jobId ?? p.id;
        if (!jobId) {
            return res.status(400).json({ error: 'missing_jobId' });
        }
        proxyPath = `/jobs/${encodeURIComponent(jobId)}/messages`;
        method = 'GET';
        body = null;
    }
    else if (operation === 'messages_unread') {
        proxyPath = `/messages/unread${buildQuery({ page: parsePositiveInt(p.page, 1), limit: parsePositiveInt(p.limit, 20) })}`;
        method = 'GET';
        body = null;
    }
    else if (operation === 'customer_search') {
        const q = String(p.q ?? p.search ?? '').trim();
        if (!q) return res.status(400).json({ error: 'missing_query', hint: 'Provide q/search and optional type=phone|email|name' });
        proxyPath = `/customers/search${buildQuery({ q, type: p.type ?? 'phone', page: parsePositiveInt(p.page, 0), limit: parsePositiveInt(p.limit, 20) })}`;
        method = 'GET';
        body = null;
    }
    else if (operation === 'customer_create') {
        proxyPath = '/customers';
        method = 'POST';
        body = p;
    }
    else if (operation === 'bookings_week_samples') {
        const fromDate = p.fromDate ? toDateOnlyIso(p.fromDate) : toDateOnlyIso(new Date());
        const toDate = p.toDate ? toDateOnlyIso(p.toDate) : (fromDate ? addDays(fromDate, 7) : null);
        if (!fromDate || !toDate) {
            return res.status(400).json({ error: 'invalid_date_range' });
        }
        proxyPath = `/bookings/week-samples${buildQuery({
            fromDate,
            toDate,
            count: parsePositiveInt(p.count, 3),
            distinctStores: p.distinctStores === false ? 'false' : 'true',
        })}`;
        method = 'GET';
        body = null;
    }
    else if (operation === 'products_search') {
        const rawQuery = firstNonEmptyString(p.q, p.search, p.query, p.prompt, p.search_prompt) || '';
        const normalizedQuery = String(rawQuery).trim();
        if (!normalizedQuery) {
            return res.status(400).json({
                error: 'missing_products_search_query',
                hint: 'Provide payload.q/search/query. Example: { "operation":"products_search", "payload":{"q":"zero 11x controller"} }',
            });
        }
        proxyPath = `/products/search${buildQuery({
            q: normalizedQuery,
            limit: parsePositiveInt(p.limit, 25),
        })}`;
        method = 'GET';
        body = null;
    }
    else if (operation === 'bike_create') {
        proxyPath = '/bikes';
        method = 'POST';
        body = p;
    }
    else if (operation === 'availability_search') {
        const fromDate = p.fromDate ? toDateOnlyIso(p.fromDate) : toDateOnlyIso(new Date());
        const toDate = p.toDate ? toDateOnlyIso(p.toDate) : (fromDate ? addDays(fromDate, 7) : null);
        let technicians = resolveTechniciansCsv(p, toolConfig);
        const store = String(
            p.store
            ?? p.storeName
            ?? p.store_name
            ?? p.storeLocation
            ?? p.store_location
            ?? p.location
            ?? p.branch
            ?? p.workshop
            ?? p.workshopLocation
            ?? p.workshop_location
            ?? p.suburb
            ?? ''
        ).trim();
        const requiredMinutes = parsePositiveInt(p.requiredMinutes, 60);
        if ((!technicians || technicians.length === 0) && fromDate && toDate) {
            try {
                const samplesPath = `/bookings/week-samples${buildQuery({ fromDate, toDate, count: 25, distinctStores: 'false' })}`;
                const sampleResp = await fetch(`${HUBTIGER_PROXY_URL}${samplesPath}`, { headers: { 'x-trace-id': trace_id } });
                if (sampleResp.ok) {
                    const sampleData = await sampleResp.json().catch(() => null);
                    const autoIds = extractTechniciansFromWeekSamplesPayload(sampleData);
                    if (autoIds.length > 0) technicians = autoIds.join(',');
                }
            } catch (_) {}
        }
        if (!fromDate || !toDate) {
            return res.status(400).json({
                error: 'missing_availability_params',
                hint: 'Provide fromDate and toDate. technicians optional.',
            });
        }
        proxyPath = `/availability/technicians${buildQuery({ fromDate, toDate, technicians, requiredMinutes, store })}`;
        method = 'GET';
        body = null;
    }
    else if (operation === 'booking_find_earliest') {
        const fromDate = p.fromDate ? toDateOnlyIso(p.fromDate) : toDateOnlyIso(new Date());
        const toDate = p.toDate ? toDateOnlyIso(p.toDate) : (fromDate ? addDays(fromDate, 14) : null);
        let technicians = resolveTechniciansCsv(p, toolConfig);
        const store = String(
            p.store
            ?? p.storeName
            ?? p.store_name
            ?? p.storeLocation
            ?? p.store_location
            ?? p.location
            ?? p.branch
            ?? p.workshop
            ?? p.workshopLocation
            ?? p.workshop_location
            ?? p.suburb
            ?? ''
        ).trim();
        const requiredMinutes = parsePositiveInt(p.requiredMinutes ?? p.durationMinutes, 60);
        if ((!technicians || technicians.length === 0) && fromDate && toDate) {
            try {
                const samplesPath = `/bookings/week-samples${buildQuery({ fromDate, toDate, count: 25, distinctStores: 'false' })}`;
                const sampleResp = await fetch(`${HUBTIGER_PROXY_URL}${samplesPath}`, { headers: { 'x-trace-id': trace_id } });
                if (sampleResp.ok) {
                    const sampleData = await sampleResp.json().catch(() => null);
                    const autoIds = extractTechniciansFromWeekSamplesPayload(sampleData);
                    if (autoIds.length > 0) technicians = autoIds.join(',');
                }
            } catch (_) {}
        }
        if (!fromDate || !toDate) {
            return res.status(400).json({
                error: 'missing_booking_find_earliest_params',
                hint: 'Provide fromDate/toDate if needed. technicians optional.',
            });
        }
        proxyPath = `/availability/technicians${buildQuery({ fromDate, toDate, technicians, requiredMinutes, store })}`;
        method = 'GET';
        body = null;
    }
    else if (operation === 'booking_create') {
        proxyPath = '/bookings';
        method = 'POST';
        body = { ...p };
        const normalizeServiceDate = (v) => {
            if (v === undefined || v === null) return v;
            const s = String(v).trim();
            if (!s) return v;
            // Hubtiger ScheduleService is less flaky with local naive datetime
            // (YYYY-MM-DDTHH:mm:ss) instead of timezone suffixed values.
            const noZone = s.replace(/Z$/i, '').replace(/\.\d{1,3}$/, '');
            if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(noZone)) return `${noZone}:00`;
            if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(noZone)) return noZone;
            return s;
        };
        const toBool = (v) => {
            if (typeof v === 'boolean') return v;
            const s = String(v ?? '').trim().toLowerCase();
            if (s === 'true' || s === '1' || s === 'yes') return true;
            if (s === 'false' || s === '0' || s === 'no') return false;
            return v;
        };
        const toInt = (v) => {
            if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v);
            const n = Number(String(v ?? '').trim());
            return Number.isFinite(n) ? Math.floor(n) : v;
        };
        body.ID = toInt(body.ID ?? body.partnerId ?? body.PartnerID ?? 2186);
        body.BikeID = toInt(body.BikeID ?? body.bikeId);
        body.TechnicianID = toInt(body.TechnicianID);
        body.ServiceDate = normalizeServiceDate(body.ServiceDate ?? body.serviceDate ?? body.DateCheckedIn);
        if (body.PleaseBookIn !== undefined) body.PleaseBookIn = toBool(body.PleaseBookIn);
        if (body.isBikeHere !== undefined) body.isBikeHere = toBool(body.isBikeHere);
        if (body.PleaseBookIn === undefined) body.PleaseBookIn = true;
        if (body.isBikeHere === undefined) body.isBikeHere = true;
        // New booking endpoint should not receive jobcard mutation hints from voice payloads.
        delete body.NewJobcardID;
        delete body.newJobcardId;
        delete body.DateCheckedIn;
        delete body.serviceDate;
        // Accept single service type from voice tools and normalize to array expected by Hubtiger.
        if (!Array.isArray(body.ServiceTypes) || body.ServiceTypes.length === 0) {
            const singleType = body.ServiceType ?? body.serviceType ?? body.typeId ?? body.TypeID;
            const n = Number(singleType);
            if (Number.isFinite(n) && n > 0) {
                body.ServiceTypes = [Math.floor(n)];
            }
        }
        const firstServiceFlag = String(body.isFirstService ?? body.IsFirstService ?? '').trim().toLowerCase();
        if ((!Array.isArray(body.ServiceTypes) || body.ServiceTypes.length === 0) && (firstServiceFlag === 'true' || firstServiceFlag === '1' || firstServiceFlag === 'yes')) {
            // Ride Electric first-service booking type observed in successful schedule payloads.
            body.ServiceTypes = [32693];
        }
        const vehicleModelRaw = String(body.vehicleModel ?? body.VehicleModel ?? '').trim();
        if (vehicleModelRaw) {
            const parts = vehicleModelRaw.split(/\s+/).filter(Boolean);
            if (parts.length >= 2) {
                if (!body.Manufacturer) body.Manufacturer = parts[0];
                if (!body.Model) body.Model = parts.slice(1).join(' ');
            } else if (parts.length === 1) {
                if (!body.Manufacturer) body.Manufacturer = parts[0];
                if (!body.Model) body.Model = parts[0];
            }
        }
        delete body.ServiceType;
        delete body.serviceType;
        delete body.typeId;
        delete body.TypeID;
        const isPositiveInt = (v) => Number.isInteger(v) && v > 0;
        const hasValidServiceTypes = Array.isArray(body.ServiceTypes) && body.ServiceTypes.some((v) => {
            const n = Number(v);
            return Number.isFinite(n) && n > 0;
        });
        const hasServiceDate = typeof body.ServiceDate === 'string' && body.ServiceDate.trim().length > 0;
        const missing = [];
        if (!isPositiveInt(body.ID)) missing.push('ID');
        if (!isPositiveInt(body.BikeID)) missing.push('BikeID');
        if (!isPositiveInt(body.TechnicianID)) missing.push('TechnicianID');
        if (!hasValidServiceTypes) missing.push('ServiceTypes');
        if (!hasServiceDate) missing.push('ServiceDate');
        if (missing.length > 0) {
            return res.status(400).json({
                error: 'missing_booking_create_fields',
                missing,
                hint: 'booking_create needs ID, BikeID, ServiceTypes, ServiceDate, TechnicianID. Run customer/bike steps first, then submit booking.',
            });
        }
    }
    else if (operation === 'booking_amend_slot') {
        proxyPath = '/bookings/slot';
        method = 'POST';
        body = p;
    }
    else if (operation === 'booking_amend') {
        proxyPath = '/bookings/update';
        method = 'POST';
        body = p;
    }
    else if (operation === 'job_note_add') {
        const visibility = String(p.visibility || p.type || 'internal').toLowerCase();
        proxyPath = visibility === 'customer' ? '/bookings/notes/customer' : '/bookings/notes/internal';
        method = 'POST';
        body = p;
    }
    else if (operation === 'quote_add_line_item') {
        proxyPath = '/quotes/line-item';
        method = 'POST';
        body = p;
    }
    else if (operation === 'quote_find_add') {
        const serviceId = p.serviceId ?? p.jobId ?? p.ID;
        const search = String(firstNonEmptyString(p.search, p.q, p.query, p.prompt, p.search_prompt) || '').trim();
        if (!serviceId || !search) {
            return res.status(400).json({ error: 'missing_quote_find_add_fields', hint: 'Provide serviceId/jobId and search text.' });
        }
        proxyPath = '/quotes/find-add';
        method = 'POST';
        body = p;
    }
    else if (operation === 'quote_find_add_and_request_approval') {
        const serviceId = p.serviceId ?? p.jobId ?? p.ID;
        const search = String(firstNonEmptyString(p.search, p.q, p.query, p.prompt, p.search_prompt) || '').trim();
        if (!serviceId || !search) {
            return res.status(400).json({ error: 'missing_quote_find_add_request_fields', hint: 'Provide serviceId/jobId and search text.' });
        }
        proxyPath = '/quotes/find-add-request-approval';
        method = 'POST';
        body = p;
    }
    else if (operation === 'quote_request_approval') {
        const userId = p.userId ?? p.cyclistId;
        if (!userId) return res.status(400).json({ error: 'missing_user_id', hint: 'Provide userId/cyclistId from job details' });
        proxyPath = `/quotes/request-approval/${encodeURIComponent(String(userId))}`;
        method = 'POST';
        body = p;
    }
    else if (
        operation === 'portal_call' ||
        operation === 'portal_mutation'
    ) {
        proxyPath = '/portal/call';
        method = 'POST';
        body = p;
    }
    else {
        return res.status(400).json({ error: 'unsupported_operation', operation: operationRaw || null, normalized_operation: operation || null });
    }

    const mcpUrl = `${HUBTIGER_MCP_URL}/execute`;

    try {
        const response = await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-trace-id': trace_id, 'x-span-id': outboundSpanId },
            body: JSON.stringify({
                operation,
                method,
                proxy_path: proxyPath,
                proxy_body: body,
            }),
        });
        const latency_ms = Date.now() - start;
        const end_ts = nowIso();

        const ct = response.headers.get('content-type') || '';
        let data = null;
        if (ct.includes('application/json')) {
            try {
                data = await response.json();
            }
            catch (_) {}
        } else if (!response.ok) {
            try {
                const rawText = await response.text();
                data = { _raw: rawText.length > 2000 ? rawText.slice(0, 2000) + '...' : rawText };
            }
            catch (_) {}
        }
        const upstreamData = data && typeof data === 'object' && 'data' in data ? data.data : data;

        let errorDetail = null;
        if (!response.ok) {
            const msg = data && (data.error || data.message || (typeof data._raw === 'string' ? data._raw : null));
            errorDetail = msg ? `${response.status}: ${String(msg).slice(0, 500)}` : `hubtiger_mcp ${response.status}`;
        }
        const metadata = {
            tool_id: toolId,
            tool_kind: 'hubtiger',
            operation,
            agent_id: agent_id || null,
            upstream_route: `POST /execute`,
            upstream_status: response.status,
            upstream_latency_ms: latency_ms,
            request_payload: sanitizeForLogs(payload ?? null),
            mcp_request: sanitizeForLogs({ method, proxy_path: proxyPath, proxy_body: body ?? null }),
            mcp_cache_hit: data?.cache_hit === true,
            mcp_retry_count: Number(data?.retry_count || 0),
            mcp_circuit_state: data?.circuit_state || null,
        };
        if (data != null) metadata.upstream_body = sanitizeForLogs(data?.data ?? data);

        try {
            await pool.query(
                `INSERT INTO request_logs (trace_id, span_id, service, route, start_ts, end_ts, latency_ms, status, error, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                [trace_id, outboundSpanId, 'control-plane-api', `POST /api/tools/${toolId}/execute`, start_ts, end_ts, latency_ms, response.status, errorDetail, JSON.stringify(metadata)]
            );
        }
        catch (_) {}

        if (response.ok && operation === 'booking_find_earliest' && upstreamData && typeof upstreamData === 'object') {
            const earliest = upstreamData.earliest || null;
            return res.status(response.status).json({
                ok: true,
                trace_id,
                latency_ms,
                data: upstreamData,
                recommendation: earliest
                    ? {
                        type: 'earliest_available_slot',
                        slot: earliest,
                        guidance: 'Use booking_create with this slot and the matching technicianId.',
                    }
                    : {
                        type: 'no_capacity_found',
                        guidance: 'No availability met requiredMinutes in the provided date window.',
                    },
            });
        }
        // When booking/availability fails due to portal mode, return guidance so the agent does not invent reasons (e.g. "bookings waiting for parts")
        const bookingAvailabilityOps = ['booking_find_earliest', 'booking_create', 'bookings_week_samples', 'availability_search'];
        const errCode = upstreamData && typeof upstreamData.error === 'string' ? upstreamData.error : '';
        const isPortalModeError = /only_supported_in_portal_mode|portal_not_configured/.test(errCode);
        if (!response.ok && bookingAvailabilityOps.includes(operation) && isPortalModeError) {
            return res.status(response.status).json({
                ok: false,
                trace_id,
                latency_ms,
                data: upstreamData,
                guidance: 'Do not invent reasons. Say: "I can\'t access the workshop calendar right now. Let me connect you with a team member who can book you in and send you a text with the time." Then offer human handoff.',
                customer_message: "I can't access the workshop calendar right now. Let me connect you with a team member who can book you in and send you a text with the time.",
            });
        }
        res.status(response.status).json({ ok: response.ok, trace_id, latency_ms, data: upstreamData, mcp: data ? { retry_count: data.retry_count || 0, cache_hit: data.cache_hit === true, circuit_state: data.circuit_state || null } : null });
    }
    catch (err) {
        const latency_ms = Date.now() - start;
        const end_ts = nowIso();
        const metadata = { tool_id: toolId, tool_kind: 'hubtiger', operation, agent_id: agent_id || null, upstream_route: 'POST /execute', upstream_status: null, upstream_latency_ms: latency_ms };
        try {
            await pool.query(
                `INSERT INTO request_logs (trace_id, span_id, service, route, start_ts, end_ts, latency_ms, status, error, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                [trace_id, outboundSpanId, 'control-plane-api', `POST /api/tools/${toolId}/execute`, start_ts, end_ts, latency_ms, 0, String(err), JSON.stringify(metadata)]
            );
        }
        catch (_) {}
        res.setHeader('x-error', 'hubtiger_mcp_request_failed');
        res.status(502).json({ error: 'hubtiger_mcp_request_failed', message: String(err && err.message || err) });
    }
});

// CLIENT CRASH REPORTING (this is how we stop guessing "blank")
app.post('/api/client-errors', (req, res) => {
    jsonLog({
        level: 'error',
        kind: 'client_error',
        service: 'web-ui',
        route: 'POST /api/client-errors',
        payload: req.body || {},
    });
    res.json({ ok: true });
});

app.get('/api/users', async (_req, res) => {
    try {
        const out = await pool.query(
            `SELECT id, email, role, created_at
             FROM users
             ORDER BY created_at DESC, email ASC`
        );
        return res.json({ ok: true, rows: out.rows || [] });
    } catch (e) {
        res.setHeader('x-error', 'users_fetch_failed');
        return res.status(500).json({ error: 'users_fetch_failed', message: String(e?.message || e) });
    }
});

app.post('/api/users', async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const roleRaw = String(req.body?.role || 'operator').trim().toLowerCase();
    const role = ['admin', 'operator', 'viewer'].includes(roleRaw) ? roleRaw : '';
    if (!email || !password || !role) {
        res.setHeader('x-error', 'missing_fields');
        return res.status(400).json({ error: 'missing_fields', hint: 'email, password, role required' });
    }
    try {
        const hash = await bcrypt.hash(password, 12);
        const created = await pool.query(
            `INSERT INTO users (email, role, password_hash)
             VALUES ($1, $2, $3)
             RETURNING id, email, role, created_at`,
            [email, role, hash]
        );
        return res.status(201).json({ ok: true, user: created.rows[0] });
    } catch (e) {
        if (String(e?.message || '').toLowerCase().includes('duplicate key')) {
            res.setHeader('x-error', 'email_already_exists');
            return res.status(409).json({ error: 'email_already_exists' });
        }
        res.setHeader('x-error', 'user_create_failed');
        return res.status(500).json({ error: 'user_create_failed', message: String(e?.message || e) });
    }
});

app.patch('/api/users/:id', async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'missing_user_id' });
    const updates = [];
    const values = [];
    let i = 1;
    const addField = (field, value) => {
        updates.push(`${field} = $${i++}`);
        values.push(value);
    };
    if (req.body?.email !== undefined) {
        const email = String(req.body.email || '').trim().toLowerCase();
        if (!email) return res.status(400).json({ error: 'invalid_email' });
        addField('email', email);
    }
    if (req.body?.role !== undefined) {
        const roleRaw = String(req.body.role || '').trim().toLowerCase();
        if (!['admin', 'operator', 'viewer'].includes(roleRaw)) {
            return res.status(400).json({ error: 'invalid_role' });
        }
        addField('role', roleRaw);
    }
    if (req.body?.password !== undefined) {
        const password = String(req.body.password || '');
        if (!password) return res.status(400).json({ error: 'invalid_password' });
        const hash = await bcrypt.hash(password, 12);
        addField('password_hash', hash);
    }
    if (updates.length === 0) return res.status(400).json({ error: 'no_updates' });
    values.push(id);
    try {
        const out = await pool.query(
            `UPDATE users
             SET ${updates.join(', ')}
             WHERE id = $${i}
             RETURNING id, email, role, created_at`,
            values
        );
        if (out.rowCount === 0) return res.status(404).json({ error: 'user_not_found' });
        return res.json({ ok: true, user: out.rows[0] });
    } catch (e) {
        if (String(e?.message || '').toLowerCase().includes('duplicate key')) {
            res.setHeader('x-error', 'email_already_exists');
            return res.status(409).json({ error: 'email_already_exists' });
        }
        res.setHeader('x-error', 'user_update_failed');
        return res.status(500).json({ error: 'user_update_failed', message: String(e?.message || e) });
    }
});

// Bootstrap status
app.get('/api/auth/bootstrap/status', async (_req, res) => {
    const r = await pool.query(`SELECT COUNT(*)::int AS n FROM users`);
    res.json({ hasAnyUser: r.rows[0].n > 0 });
});
// Bootstrap create (only when users=0)
app.post('/api/auth/bootstrap/create', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
        res.setHeader('x-error', 'missing_fields');
        return res.status(400).json({ error: 'missing_fields' });
    }
    const r = await pool.query(`SELECT COUNT(*)::int AS n FROM users`);
    if (r.rows[0].n > 0) {
        res.setHeader('x-error', 'bootstrap_closed');
        return res.status(403).json({ error: 'bootstrap_closed' });
    }
    const hash = await bcrypt.hash(String(password), 12);
    const created = await pool.query(`INSERT INTO users (email, role, password_hash)
     VALUES ($1,'admin',$2)
     RETURNING id, email, role, created_at`, [String(email).toLowerCase(), hash]);
    const user = created.rows[0];
    const token = signToken(user);
    res.json({ user, token });
});
// Login
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
        res.setHeader('x-error', 'missing_fields');
        return res.status(400).json({ error: 'missing_fields' });
    }
    const found = await pool.query(`SELECT id, email, role, password_hash FROM users WHERE email=$1`, [
        String(email).toLowerCase(),
    ]);
    if (found.rowCount === 0) {
        res.setHeader('x-error', 'invalid_credentials');
        return res.status(401).json({ error: 'invalid_credentials' });
    }
    const user = found.rows[0];
    const ok = await bcrypt.compare(String(password), String(user.password_hash || ''));
    if (!ok) {
        res.setHeader('x-error', 'invalid_credentials');
        return res.status(401).json({ error: 'invalid_credentials' });
    }
    const token = signToken(user);
    res.json({ user: { id: user.id, email: user.email, role: user.role }, token });
});
app.get('/api/auth/me', async (req, res) => {
    const auth = parseAuthedUserFromRequest(req);
    if (!auth) {
        res.setHeader('x-error', 'unauthorized');
        return res.status(401).json({ error: 'unauthorized' });
    }
    try {
        const out = await pool.query(`SELECT id, email, role, created_at FROM users WHERE id = $1::uuid LIMIT 1`, [auth.id]);
        if (out.rowCount === 0) {
            res.setHeader('x-error', 'user_not_found');
            return res.status(404).json({ error: 'user_not_found' });
        }
        return res.json({ ok: true, user: out.rows[0] });
    } catch (e) {
        res.setHeader('x-error', 'auth_me_failed');
        return res.status(500).json({ error: 'auth_me_failed', message: String(e?.message || e) });
    }
});
app.patch('/api/auth/profile', async (req, res) => {
    const auth = parseAuthedUserFromRequest(req);
    if (!auth) {
        res.setHeader('x-error', 'unauthorized');
        return res.status(401).json({ error: 'unauthorized' });
    }
    const nextEmail = req.body?.email !== undefined ? String(req.body.email || '').trim().toLowerCase() : null;
    const currentPassword = String(req.body?.current_password || '');
    const nextPassword = req.body?.new_password !== undefined ? String(req.body.new_password || '') : '';
    if (nextEmail !== null && !nextEmail) {
        res.setHeader('x-error', 'invalid_email');
        return res.status(400).json({ error: 'invalid_email' });
    }
    if (!nextEmail && !nextPassword) {
        res.setHeader('x-error', 'no_updates');
        return res.status(400).json({ error: 'no_updates' });
    }
    try {
        const found = await pool.query(`SELECT id, email, role, password_hash FROM users WHERE id = $1::uuid LIMIT 1`, [auth.id]);
        if (found.rowCount === 0) {
            res.setHeader('x-error', 'user_not_found');
            return res.status(404).json({ error: 'user_not_found' });
        }
        const currentUser = found.rows[0];
        const updates = [];
        const values = [];
        let i = 1;
        if (nextEmail && nextEmail !== String(currentUser.email || '').toLowerCase()) {
            updates.push(`email = $${i++}`);
            values.push(nextEmail);
        }
        if (nextPassword) {
            if (!currentPassword) {
                res.setHeader('x-error', 'current_password_required');
                return res.status(400).json({ error: 'current_password_required' });
            }
            const ok = await bcrypt.compare(currentPassword, String(currentUser.password_hash || ''));
            if (!ok) {
                res.setHeader('x-error', 'invalid_current_password');
                return res.status(401).json({ error: 'invalid_current_password' });
            }
            const hash = await bcrypt.hash(nextPassword, 12);
            updates.push(`password_hash = $${i++}`);
            values.push(hash);
        }
        if (updates.length === 0) return res.json({ ok: true, user: { id: currentUser.id, email: currentUser.email, role: currentUser.role } });
        values.push(currentUser.id);
        const out = await pool.query(
            `UPDATE users
             SET ${updates.join(', ')}
             WHERE id = $${i}::uuid
             RETURNING id, email, role, created_at`,
            values
        );
        const updated = out.rows[0];
        const token = signToken(updated);
        return res.json({ ok: true, user: updated, token });
    } catch (e) {
        if (String(e?.message || '').toLowerCase().includes('duplicate key')) {
            res.setHeader('x-error', 'email_already_exists');
            return res.status(409).json({ error: 'email_already_exists' });
        }
        res.setHeader('x-error', 'profile_update_failed');
        return res.status(500).json({ error: 'profile_update_failed', message: String(e?.message || e) });
    }
});
// ──────────────────────────────────────────────────────────────────────
// LlamaIndex settings API
// ──────────────────────────────────────────────────────────────────────

app.get('/api/settings/llamaindex', async (_req, res) => {
    try {
        const settings = await getEngineSettings();
        const cfg = settings.config?.llamaindex || {};
        const knowledge = resolveKnowledgeStorageSettings(settings.config || {});
        const view = {
            ...cfg,
            orchestrator_url: knowledge.llamaindex_url || String(cfg.orchestrator_url || '').trim(),
            internal_key_set: !!knowledge.llamaindex_internal_key || !!cfg.internal_key,
        };
        res.json({ ok: true, llamaindex: view });
    } catch {
        res.status(500).json({ error: 'llamaindex_settings_fetch_failed' });
    }
});

app.patch('/api/settings/llamaindex', async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const allowedFields = [
            'orchestrator_url', 'internal_key', 'default_llm_model',
            'default_embed_model', 'qdrant_collection', 'context_ttl_seconds',
            'chat_memory_ttl_seconds', 'checkpointing_enabled',
            'max_context_tokens', 'retrieval_mode',
        ];
        const next = {};
        for (const f of allowedFields) {
            if (Object.prototype.hasOwnProperty.call(body, f)) {
                next[f] = typeof body[f] === 'boolean' ? body[f] : (typeof body[f] === 'number' ? body[f] : String(body[f] || '').trim());
            }
        }
        if (Object.prototype.hasOwnProperty.call(next, 'internal_key')
            && isMaskedSecretPlaceholder(next.internal_key)) {
            return res.status(400).json({ error: 'invalid_internal_key', hint: 'Provide a real key value, not a masked placeholder.' });
        }
        if (Object.keys(next).length === 0) return res.status(400).json({ error: 'no_updates' });
        const knowledgePatch = {};
        if (Object.prototype.hasOwnProperty.call(next, 'orchestrator_url')) {
            knowledgePatch.llamaindex_url = String(next.orchestrator_url || '').trim();
        }
        if (Object.prototype.hasOwnProperty.call(next, 'internal_key')) {
            knowledgePatch.llamaindex_internal_key = String(next.internal_key || '').trim();
        }
        const patch = {
            llamaindex: next,
            ...(Object.keys(knowledgePatch).length > 0 ? { knowledge_storage: knowledgePatch } : {}),
        };
        const updated = await saveEngineSettingsPatch(patch);
        const resolvedKnowledge = resolveKnowledgeStorageSettings(updated.config || {});
        const view = {
            ...(updated.config?.llamaindex || {}),
            orchestrator_url: resolvedKnowledge.llamaindex_url || String(updated.config?.llamaindex?.orchestrator_url || '').trim(),
            internal_key_set: !!resolvedKnowledge.llamaindex_internal_key,
        };
        res.json({ ok: true, updated_at: updated.updated_at, llamaindex: view });
    } catch {
        res.status(500).json({ error: 'llamaindex_settings_update_failed' });
    }
});

app.post('/api/settings/llamaindex/test', async (req, res) => {
    const trace_id = crypto.randomUUID();
    const started = Date.now();
    try {
        const settings = await getEngineSettings();
        const cfg = settings.config?.llamaindex || {};
        const knowledge = resolveKnowledgeStorageSettings(settings.config || {});
        const url = String(req.body?.orchestrator_url || knowledge.llamaindex_url || cfg.orchestrator_url || LLAMAINDEX_URL || '').trim().replace(/\/$/, '');
        const key = String(req.body?.internal_key || knowledge.llamaindex_internal_key || cfg.internal_key || LLAMAINDEX_INTERNAL_KEY || '').trim();
        if (!url) return res.status(400).json({ error: 'no_orchestrator_url', trace_id });
        const headers = { 'Content-Type': 'application/json', 'x-trace-id': trace_id };
        if (key) headers['x-internal-key'] = key;
        const resp = await fetch(`${url}/health`, { method: 'GET', headers, signal: AbortSignal.timeout(10000) });
        const body = await resp.json().catch(() => ({}));
        const latency_ms = Date.now() - started;
        res.json({ ok: resp.ok, status: resp.status, latency_ms, trace_id, health: body });
    } catch (e) {
        res.json({ ok: false, error: String(e?.message || e), latency_ms: Date.now() - started, trace_id });
    }
});

app.post('/api/settings/llamaindex/reload', async (req, res) => {
    const trace_id = crypto.randomUUID();
    try {
        const settings = await getEngineSettings();
        const cfg = settings.config?.llamaindex || {};
        const knowledge = resolveKnowledgeStorageSettings(settings.config || {});
        const url = String(knowledge.llamaindex_url || cfg.orchestrator_url || LLAMAINDEX_URL || '').trim().replace(/\/$/, '');
        const key = String(knowledge.llamaindex_internal_key || cfg.internal_key || LLAMAINDEX_INTERNAL_KEY || '').trim();
        if (!url) return res.status(400).json({ error: 'no_orchestrator_url', trace_id });
        const headers = { 'Content-Type': 'application/json', 'x-trace-id': trace_id };
        if (key) headers['x-internal-key'] = key;
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const resp = await fetch(`${url}/config`, { method: 'PATCH', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
        const result = await resp.json().catch(() => ({}));
        res.json({ ok: resp.ok, status: resp.status, trace_id, result });
    } catch (e) {
        res.json({ ok: false, error: String(e?.message || e), trace_id });
    }
});

// ──────────────────────────────────────────────────────────────────────
// MCP Server Registry API
// ──────────────────────────────────────────────────────────────────────

app.get('/api/mcp/servers', async (_req, res) => {
    try {
        const rows = await pool.query(`SELECT * FROM mcp_servers ORDER BY name ASC`);
        res.json({ ok: true, servers: rows.rows });
    } catch {
        res.status(500).json({ error: 'mcp_servers_fetch_failed' });
    }
});

app.post('/api/mcp/servers', async (req, res) => {
    try {
        const { name, url, auth_type, auth_key_env, enabled, config } = req.body || {};
        if (!name || !url) return res.status(400).json({ error: 'name_and_url_required' });
        const row = await pool.query(
            `INSERT INTO mcp_servers (name, url, auth_type, auth_key_env, enabled, config)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb)
             RETURNING *`,
            [
                String(name).trim(),
                String(url).trim(),
                String(auth_type || 'none').trim(),
                auth_key_env ? String(auth_key_env).trim() : null,
                enabled !== false,
                JSON.stringify(config || {}),
            ]
        );
        res.json({ ok: true, server: row.rows[0] });
    } catch (e) {
        if (String(e?.message || '').includes('mcp_servers_name_uq')) {
            return res.status(409).json({ error: 'mcp_server_name_exists' });
        }
        res.status(500).json({ error: 'mcp_server_create_failed', message: String(e?.message || e) });
    }
});

app.patch('/api/mcp/servers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const body = req.body || {};
        const fields = [];
        const values = [];
        let i = 1;
        for (const [key, val] of Object.entries(body)) {
            if (['name', 'url', 'auth_type', 'auth_key_env', 'enabled', 'config'].includes(key)) {
                if (key === 'config') {
                    fields.push(`config = $${i++}::jsonb`);
                    values.push(JSON.stringify(val || {}));
                } else if (key === 'enabled') {
                    fields.push(`enabled = $${i++}`);
                    values.push(val === true);
                } else {
                    fields.push(`${key} = $${i++}`);
                    values.push(String(val || '').trim());
                }
            }
        }
        if (fields.length === 0) return res.status(400).json({ error: 'no_updates' });
        fields.push(`updated_at = now()`);
        values.push(id);
        const row = await pool.query(
            `UPDATE mcp_servers SET ${fields.join(', ')} WHERE id = $${i}::uuid RETURNING *`,
            values
        );
        if (row.rowCount === 0) return res.status(404).json({ error: 'not_found' });
        res.json({ ok: true, server: row.rows[0] });
    } catch (e) {
        res.status(500).json({ error: 'mcp_server_update_failed', message: String(e?.message || e) });
    }
});

app.delete('/api/mcp/servers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const row = await pool.query(`DELETE FROM mcp_servers WHERE id = $1::uuid RETURNING id, name`, [id]);
        if (row.rowCount === 0) return res.status(404).json({ error: 'not_found' });
        res.json({ ok: true, deleted: row.rows[0] });
    } catch {
        res.status(500).json({ error: 'mcp_server_delete_failed' });
    }
});

app.post('/api/mcp/servers/:id/test', async (req, res) => {
    const trace_id = crypto.randomUUID();
    const started = Date.now();
    try {
        const { id } = req.params;
        const srv = await pool.query(`SELECT * FROM mcp_servers WHERE id = $1::uuid`, [id]);
        if (srv.rowCount === 0) return res.status(404).json({ error: 'not_found' });
        const server = srv.rows[0];
        const resp = await fetch(`${server.url.replace(/\/$/, '')}/health`, {
            method: 'GET',
            headers: { 'x-trace-id': trace_id },
            signal: AbortSignal.timeout(10000),
        });
        const latency_ms = Date.now() - started;
        const healthStatus = resp.ok ? 'healthy' : 'degraded';
        await pool.query(
            `UPDATE mcp_servers SET last_health_status = $1, last_health_at = now(), updated_at = now() WHERE id = $2::uuid`,
            [healthStatus, id]
        );
        res.json({ ok: resp.ok, status: resp.status, latency_ms, trace_id, health_status: healthStatus });
    } catch (e) {
        const latency_ms = Date.now() - started;
        await pool.query(
            `UPDATE mcp_servers SET last_health_status = 'offline', last_health_at = now(), updated_at = now() WHERE id = $1::uuid`,
            [req.params.id]
        ).catch(() => {});
        res.json({ ok: false, error: String(e?.message || e), latency_ms, trace_id, health_status: 'offline' });
    }
});

app.get('/api/mcp/servers/:id/tools', async (req, res) => {
    const trace_id = crypto.randomUUID();
    try {
        const { id } = req.params;
        const srv = await pool.query(`SELECT * FROM mcp_servers WHERE id = $1::uuid`, [id]);
        if (srv.rowCount === 0) return res.status(404).json({ error: 'not_found' });
        const server = srv.rows[0];
        const resp = await fetch(`${server.url.replace(/\/$/, '')}/tools/list`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-trace-id': trace_id },
            body: JSON.stringify({}),
            signal: AbortSignal.timeout(10000),
        });
        const body = await resp.json().catch(() => ({}));
        res.json({ ok: resp.ok, tools: body.tools || [], trace_id });
    } catch (e) {
        res.json({ ok: false, error: String(e?.message || e), tools: [], trace_id });
    }
});

// ──────────────────────────────────────────────────────────────────────
// Phoenix Observability API
// ──────────────────────────────────────────────────────────────────────

app.get('/api/phoenix/status', async (_req, res) => {
    const trace_id = crypto.randomUUID();
    const started = Date.now();
    try {
        const settings = await getEngineSettings();
        const phoenixUrl = String(settings.config?.phoenix?.url || '').trim().replace(/\/$/, '');
        if (!phoenixUrl) return res.json({ ok: false, error: 'phoenix_url_not_configured', trace_id });
        const resp = await fetch(`${phoenixUrl}/healthz`, {
            method: 'GET',
            signal: AbortSignal.timeout(10000),
        });
        const latency_ms = Date.now() - started;
        res.json({ ok: resp.ok, status: resp.status, latency_ms, trace_id });
    } catch (e) {
        res.json({ ok: false, error: String(e?.message || e), latency_ms: Date.now() - started, trace_id });
    }
});

app.get('/api/phoenix/traces', async (req, res) => {
    try {
        const settings = await getEngineSettings();
        const phoenixUrl = String(settings.config?.phoenix?.url || '').trim().replace(/\/$/, '');
        if (!phoenixUrl) return res.json({ ok: false, error: 'phoenix_url_not_configured' });
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
        const resp = await fetch(`${phoenixUrl}/v1/traces?limit=${limit}`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(15000),
        });
        const body = await resp.json().catch(() => ({}));
        res.json({ ok: resp.ok, traces: body.data || body.traces || [], count: (body.data || body.traces || []).length });
    } catch (e) {
        res.json({ ok: false, error: String(e?.message || e), traces: [] });
    }
});

app.get('/api/phoenix/traces/:traceId', async (req, res) => {
    try {
        const settings = await getEngineSettings();
        const phoenixUrl = String(settings.config?.phoenix?.url || '').trim().replace(/\/$/, '');
        if (!phoenixUrl) return res.json({ ok: false, error: 'phoenix_url_not_configured' });
        const resp = await fetch(`${phoenixUrl}/v1/traces/${req.params.traceId}`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(10000),
        });
        const body = await resp.json().catch(() => ({}));
        res.json({ ok: resp.ok, trace: body });
    } catch (e) {
        res.json({ ok: false, error: String(e?.message || e) });
    }
});

// ──────────────────────────────────────────────────────────────────────
// Phoenix settings API
// ──────────────────────────────────────────────────────────────────────

app.get('/api/settings/phoenix', async (_req, res) => {
    try {
        const settings = await getEngineSettings();
        res.json({ ok: true, phoenix: settings.config?.phoenix || {} });
    } catch {
        res.status(500).json({ error: 'phoenix_settings_fetch_failed' });
    }
});

app.patch('/api/settings/phoenix', async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const allowedFields = ['url', 'otel_endpoint', 'sampling_rate', 'retention_days'];
        const next = {};
        for (const f of allowedFields) {
            if (Object.prototype.hasOwnProperty.call(body, f)) {
                next[f] = typeof body[f] === 'number' ? body[f] : String(body[f] || '').trim();
            }
        }
        if (Object.keys(next).length === 0) return res.status(400).json({ error: 'no_updates' });
        const updated = await saveEngineSettingsPatch({ phoenix: next });
        res.json({ ok: true, updated_at: updated.updated_at, phoenix: updated.config?.phoenix || {} });
    } catch {
        res.status(500).json({ error: 'phoenix_settings_update_failed' });
    }
});

// ──────────────────────────────────────────────────────────────────────
// Orchestration Status API
// ──────────────────────────────────────────────────────────────────────

app.get('/api/orchestration/status', async (_req, res) => {
    const trace_id = crypto.randomUUID();
    try {
        const settings = await getEngineSettings();
        const knowledge = resolveKnowledgeStorageSettings(settings.config || {});
        const liUrl = String(knowledge.llamaindex_url || settings.config?.llamaindex?.orchestrator_url || LLAMAINDEX_URL || '').trim().replace(/\/$/, '');
        const liKey = String(knowledge.llamaindex_internal_key || settings.config?.llamaindex?.internal_key || LLAMAINDEX_INTERNAL_KEY || '').trim();
        const phoenixUrl = String(settings.config?.phoenix?.url || '').trim().replace(/\/$/, '');

        let llamaindexStatus = null;
        if (liUrl) {
            try {
                const headers = { 'x-trace-id': trace_id };
                if (liKey) headers['x-internal-key'] = liKey;
                const resp = await fetch(`${liUrl}/health`, { method: 'GET', headers, signal: AbortSignal.timeout(8000) });
                llamaindexStatus = await resp.json().catch(() => ({ ok: resp.ok, status: resp.status }));
            } catch (e) {
                llamaindexStatus = { ok: false, error: String(e?.message || e) };
            }
        }

        let phoenixStatus = null;
        if (phoenixUrl) {
            try {
                const resp = await fetch(`${phoenixUrl}/healthz`, { method: 'GET', signal: AbortSignal.timeout(5000) });
                phoenixStatus = { ok: resp.ok, status: resp.status };
            } catch (e) {
                phoenixStatus = { ok: false, error: String(e?.message || e) };
            }
        }

        const mcpServers = await pool.query(`SELECT id, name, url, enabled, last_health_status, last_health_at FROM mcp_servers ORDER BY name`);
        const activeSessions = await pool.query(
            `SELECT COUNT(*) as count FROM orchestration_sessions WHERE state = 'active'`
        );

        res.json({
            ok: true,
            trace_id,
            llamaindex: llamaindexStatus,
            phoenix: phoenixStatus,
            mcp_servers: mcpServers.rows,
            active_sessions: Number(activeSessions.rows[0]?.count || 0),
        });
    } catch (e) {
        res.json({ ok: false, error: String(e?.message || e), trace_id });
    }
});

app.get('/api/orchestration/sessions', async (req, res) => {
    try {
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
        const rows = await pool.query(
            `SELECT * FROM orchestration_sessions ORDER BY last_activity_at DESC LIMIT $1`,
            [limit]
        );
        res.json({ ok: true, sessions: rows.rows });
    } catch {
        res.status(500).json({ error: 'sessions_fetch_failed' });
    }
});

app.post('/api/orchestration/sessions/:id/terminate', async (req, res) => {
    try {
        const { id } = req.params;
        const row = await pool.query(
            `UPDATE orchestration_sessions SET state = 'terminated', last_activity_at = now() WHERE id = $1::uuid AND state = 'active' RETURNING *`,
            [id]
        );
        if (row.rowCount === 0) return res.status(404).json({ error: 'not_found_or_already_terminated' });
        res.json({ ok: true, session: row.rows[0] });
    } catch {
        res.status(500).json({ error: 'session_terminate_failed' });
    }
});

async function main() {
    await ensureSchema();
    await applyKnowledgeRuntimeSettings();
    await startEngineScheduler();
    server.listen(PORT, '0.0.0.0', () => {
        jsonLog({ level: 'info', msg: 'control-plane-api listening', port: PORT });
    });
}
main().catch((e) => {
    console.error(JSON.stringify({ level: 'error', msg: 'startup_failed', error: String(e) }));
    process.exit(1);
});
