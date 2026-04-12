import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import {
  AlertTriangle,
  Bell,
  Bot,
  Cpu,
  Database,
  ExternalLink,
  FileText,
  FlaskConical,
  LayoutDashboard,
  Logs,
  Menu,
  MessageSquare,
  Mic2,
  Network,
  Search,
  Settings as SettingsIcon,
  SlidersHorizontal,
  Wrench,
  X,
} from 'lucide-react';
import {
  DEFAULT_GLASS_OPACITY,
  MAX_GLASS_OPACITY,
  MIN_GLASS_OPACITY,
  getGlassOpacity,
  initGlassOpacity,
  setGlassOpacity,
} from '../lib/visualSettings';
import { getToken } from '../lib/auth';
import { SystemMetricsBar } from './SystemMetricsBar';

type NavItem = {
  to: string;
  label: string;
  icon: React.ReactNode;
  tooltip: string;
  href?: string;
  newWindow?: boolean;
};
type CriticalBannerAlert = {
  trace_id: string;
  span_id: string;
  route: string;
  service: string;
  start_ts: string;
  error?: string | null;
  status: number;
  severity?: string;
};

type DismissedAlertMap = Record<string, number>;
type DashboardVersionInfo = {
  ok: boolean;
  dashboard_version?: string | null;
  package_version?: string | null;
  git_commit?: string | null;
  git_commit_short?: string | null;
  git_branch?: string | null;
  git_tag?: string | null;
  git_remote?: string | null;
  github_url?: string | null;
  github_commit_url?: string | null;
  source?: string | null;
  generated_at?: string | null;
  error?: string | null;
};
type AssistantSetupStatus = {
  configured: boolean;
  required: boolean;
  source: string;
};

const ALERT_DISMISS_TTL_MS = 30 * 60 * 1000;
const LOGO_HOVER_DELAY_MS = 5000;

function normalizeAlertText(value: string | null | undefined) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/g, 'uuid')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

function alertFingerprint(alert: CriticalBannerAlert) {
  return [
    String(alert.service || '').toLowerCase(),
    String(alert.route || '').toLowerCase(),
    String(alert.status || ''),
    normalizeAlertText(alert.error),
  ].join('|');
}

function classifyAlertSeverity(alert: CriticalBannerAlert): 'critical' | 'warning' {
  const normalized = String(alert.severity || '').trim().toLowerCase();
  if (normalized.includes('warn')) return 'warning';
  if (normalized.includes('critical')) return 'critical';
  return Number(alert.status || 0) >= 500 ? 'critical' : 'warning';
}

function parseDismissedMap(raw: string | null): DismissedAlertMap {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const now = Date.now();
    const out: DismissedAlertMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const expiresAt = Number(value);
      if (!Number.isFinite(expiresAt) || expiresAt <= now) continue;
      out[key] = expiresAt;
    }
    return out;
  } catch {
    return {};
  }
}

export function Layout() {
  const location = useLocation();
  const versionHoverTimerRef = useRef<number | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [quickSettingsOpen, setQuickSettingsOpen] = useState(false);
  const [criticalAlerts, setCriticalAlerts] = useState<CriticalBannerAlert[]>([]);
  const [dismissedAlerts, setDismissedAlerts] = useState<DismissedAlertMap>(() =>
    parseDismissedMap(localStorage.getItem('dismissedAlertsV2') || sessionStorage.getItem('dismissedAlertsV2'))
  );

  const [glassOpacity, setGlassOpacityState] = useState<number>(() => getGlassOpacity());
  const [versionCardOpen, setVersionCardOpen] = useState(false);
  const [versionLoading, setVersionLoading] = useState(false);
  const [versionError, setVersionError] = useState('');
  const [versionInfo, setVersionInfo] = useState<DashboardVersionInfo | null>(null);
  const [assistantSetupStatus, setAssistantSetupStatus] = useState<AssistantSetupStatus | null>(null);

  const handleDismissAlert = (key: string) => {
    setDismissedAlerts((prev) => {
      const next: DismissedAlertMap = { ...prev, [key]: Date.now() + ALERT_DISMISS_TTL_MS };
      localStorage.setItem('dismissedAlertsV2', JSON.stringify(next));
      return next;
    });
  };

  const dismissAllCurrentAlerts = () => {
    const expiry = Date.now() + ALERT_DISMISS_TTL_MS;
    setDismissedAlerts((prev) => {
      const next: DismissedAlertMap = { ...prev };
      for (const alert of criticalAlerts) {
        next[alertFingerprint(alert)] = expiry;
      }
      localStorage.setItem('dismissedAlertsV2', JSON.stringify(next));
      return next;
    });
  };

  const clearVersionHoverTimer = () => {
    if (versionHoverTimerRef.current !== null) {
      window.clearTimeout(versionHoverTimerRef.current);
      versionHoverTimerRef.current = null;
    }
  };

  const loadDashboardVersion = async () => {
    if (versionLoading) return;
    setVersionLoading(true);
    setVersionError('');
    try {
      const res = await fetch('/api/version', { credentials: 'include' });
      const data = (await res.json().catch(() => ({}))) as DashboardVersionInfo;
      if (!res.ok) {
        setVersionError(String(data?.error || 'Unable to load dashboard version.'));
        return;
      }
      setVersionInfo(data);
    } catch {
      setVersionError('Unable to load dashboard version.');
    } finally {
      setVersionLoading(false);
    }
  };

  const openVersionCard = () => {
    clearVersionHoverTimer();
    setVersionCardOpen(true);
    if (!versionInfo && !versionLoading) {
      void loadDashboardVersion();
    }
  };

  const handleLogoHoverStart = () => {
    clearVersionHoverTimer();
    versionHoverTimerRef.current = window.setTimeout(() => {
      openVersionCard();
    }, LOGO_HOVER_DELAY_MS);
  };

  const handleLogoHoverEnd = () => {
    clearVersionHoverTimer();
  };

  useEffect(() => {
    // Apply persisted visual settings early.
    initGlassOpacity();
  }, [location.pathname]);

  useEffect(() => {
    // Keep CSS var + localStorage in sync.
    setGlassOpacity(glassOpacity);
  }, [glassOpacity]);

  useEffect(() => {
    // Close the drawer / popovers on navigation.
    setMobileOpen(false);
    setQuickSettingsOpen(false);
  }, [location.pathname]);

  useEffect(() => () => clearVersionHoverTimer(), []);

  useEffect(() => {
    let cancelled = false;
    const loadSetupStatus = async () => {
      const token = getToken();
      if (!token) return;
      try {
        const res = await fetch('/api/llm/setup/status', {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        const data = (await res.json().catch(() => ({}))) as AssistantSetupStatus;
        if (!cancelled && res.ok) {
          setAssistantSetupStatus(data);
        }
      } catch {
        if (!cancelled) setAssistantSetupStatus(null);
      }
    };
    void loadSetupStatus();
    const timer = window.setInterval(() => {
      void loadSetupStatus();
    }, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setDismissedAlerts((prev) => {
        const now = Date.now();
        const next: DismissedAlertMap = {};
        let changed = false;
        for (const [key, expiresAt] of Object.entries(prev)) {
          if (expiresAt > now) next[key] = expiresAt;
          else changed = true;
        }
        if (changed) localStorage.setItem('dismissedAlertsV2', JSON.stringify(next));
        return changed ? next : prev;
      });
    }, 10000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    let cancelled = false;
    const loadCriticalAlerts = async () => {
      try {
        const res = await fetch('/api/alerts/critical?lookback_minutes=30&limit=5', { credentials: 'include' });
        const data = await res.json().catch(() => ({}));
        if (!cancelled && res.ok) {
          setCriticalAlerts(Array.isArray(data?.alerts) ? data.alerts : []);
        }
      } catch {
        if (!cancelled) setCriticalAlerts([]);
      }
    };
    void loadCriticalAlerts();
    const timer = window.setInterval(() => {
      void loadCriticalAlerts();
    }, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const navPrimary = useMemo<NavItem[]>(
    () => [
      { to: '/monitoring', label: 'Mission Control', icon: <LayoutDashboard size={18} />, tooltip: 'High-level system view for agent activity, health, latency, live events, and deployment state.' },
      { to: '/agents', label: 'Agents', icon: <Bot size={18} />, tooltip: 'Create and manage agent behavior, runtime settings, prompts, tools, routing, and deployment readiness.' },
      { to: '/ghost', label: 'Ghost', icon: <MessageSquare size={18} />, tooltip: 'Run the Ghost operator workflow, attach or detach your strategy prompt, and chat with the server-side dashboard runtime.' },
      { to: '/agent-knowledge', label: 'AGENT KNOWLEDGE BASE', icon: <FileText size={18} />, tooltip: 'Run the canonical intake wizard, apply assistant settings, upload files, and verify the exact ingest configuration before processing.' },
      { to: '/agent-knowledge?tab=ops', label: 'Knowledge Ops', icon: <Database size={18} />, tooltip: 'Operate ingestion telemetry, retrieval experiments, evaluation runs, and live query performance from one place.' },
      { to: '/agent-knowledge?tab=experiments', label: 'Eval Lab', icon: <FlaskConical size={18} />, tooltip: 'Compare retrieval and generation strategies, test datasets, and measure quality, cost, and latency changes.' },
      { to: '/logs', label: 'Trace Explorer', icon: <Network size={18} />, tooltip: 'Inspect end-to-end execution traces across ingestion, retrieval, synthesis, and tool calls.' },
      { to: '/llm-logs', label: 'Event Stream', icon: <Logs size={18} />, tooltip: 'View structured logs, system events, failures, warnings, and execution history in real time.' },
      { to: '/settings', label: 'System Settings', icon: <SettingsIcon size={18} />, tooltip: 'Configure platform defaults, environments, UI behavior, observability, storage, and operational policies.' },
    ],
    []
  );

  const navSecondary = useMemo<NavItem[]>(
    () => [
      { to: '/llm-settings', label: 'LLM SETTINGS', icon: <Cpu size={18} />, tooltip: 'Canonical control surface for website-assistant runtime, provider onboarding, model discovery, and transparent validation.' },
      { to: '/tools', label: 'Tool Gateway', icon: <Wrench size={18} />, tooltip: 'Control secure server-side access to external tools, APIs, and MCP-backed integrations.' },
      { to: '/n8n', href: 'https://ghost.rideai.com.au:7070', newWindow: true, label: 'n8n', icon: <ExternalLink size={18} />, tooltip: 'Open the n8n automation workspace in a new browser window.' },
      { to: '/knowledge-test', label: 'Docling Test UI', icon: <FileText size={18} />, tooltip: 'Upload files and validate Docling extraction/metadata in the GUI without going through agent knowledge tabs.' },
      { to: '/integration-lab', label: 'Integration Lab', icon: <Search size={18} />, tooltip: 'Dedicated operator lane for raw request building, saved scenarios, trace drilldown, and API result inspection.' },
      { to: '/orchestration', label: 'Orchestration', icon: <Network size={18} />, tooltip: 'Workflow health, MCP registry state, active sessions, and orchestration trace visibility.' },
      { to: '/elevenlabs', label: 'Voice Stack', icon: <Mic2 size={18} />, tooltip: 'Review voice sessions, call activity, synthesis settings, and voice execution telemetry.' },
    ],
    []
  );

  return (
    <div className="min-h-screen w-full overflow-hidden">
      {/* Background atmosphere */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-24 -left-24 h-[28rem] w-[28rem] rounded-full bg-[#4FC3F7]/18 blur-[120px]" />
        <div className="absolute -bottom-24 -right-24 h-[28rem] w-[28rem] rounded-full bg-[#00E676]/14 blur-[120px]" />
        <div className="absolute top-[38%] left-[52%] h-[18rem] w-[18rem] rounded-full bg-[#A2BFFE]/10 blur-[110px]" />
      </div>

      <div className="relative z-10 flex min-h-screen">
        {assistantSetupStatus?.required && location.pathname !== '/llm-settings' ? (
          <div className="fixed inset-0 z-[90] bg-[rgba(3,8,16,0.72)] backdrop-blur-md p-6 flex items-center justify-center">
            <div className="w-full max-w-2xl rounded-[2rem] border border-amber-500/20 bg-[rgba(20,20,26,0.92)] p-8 shadow-[0_40px_120px_rgba(0,0,0,0.5)]">
              <div className="flex items-start gap-4">
                <div className="mt-1 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3 text-amber-300">
                  <AlertTriangle size={20} />
                </div>
                <div className="space-y-3">
                  <div>
                    <div className="text-lg font-semibold text-white/90">Website assistant setup required</div>
                    <div className="mt-1 text-sm text-white/60">
                      The website assistant is separate from the `Agents` feature and cannot run until a verified runtime exists for this signed-in user or the shared site default.
                    </div>
                  </div>
                  <div className="text-xs uppercase tracking-[0.18em] text-amber-300/80">
                    Current source: {assistantSetupStatus.source || 'unconfigured'}
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <NavLink to="/llm-settings" className="glass-button-primary px-4 py-2 rounded-xl text-sm">
                      Open LLM SETTINGS
                    </NavLink>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : null}
        {/* Desktop sidebar */}
        <aside className="hidden md:flex md:w-[17.5rem] md:shrink-0 md:flex-col glass-panel border-y-0 border-l-0 border-r border-white/10 bg-[rgba(10,20,30,0.6)]">
          <div className="p-6 flex items-center gap-3">
            <button
              type="button"
              className="flex items-center gap-3 rounded-2xl text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[#4FC3F7]/70"
              onMouseEnter={handleLogoHoverStart}
              onMouseLeave={handleLogoHoverEnd}
              onDoubleClick={openVersionCard}
              aria-label="Show dashboard version"
              title="Double-click, or hover for 5 seconds, to show dashboard version"
            >
              <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-[#00E676] to-[#4FC3F7] p-[1px] shadow-[0_0_20px_rgba(0,230,118,0.18)]">
                <div className="w-full h-full rounded-2xl bg-[#0f172a]/90 border border-white/10 flex items-center justify-center">
                  <span className="logo-text text-[11px] font-bold">RAIG</span>
                </div>
              </div>
              <div>
                <div className="text-[17px] font-semibold tracking-tight text-[#f2f3ff] leading-tight">
                  RideAI — GhostDash
                </div>
                <div
                  className="text-[10px] uppercase tracking-[0.18em] text-[#94A3B8] font-semibold"
                  title="Create, configure, deploy, and monitor specialized voice agents with server-side tools, retrieval, telemetry, and evaluation."
                >
                  Voice AI Agents
                </div>
              </div>
            </button>
          </div>

          <nav className="px-4 space-y-2">
            {navPrimary.map((item) => (
              <SidebarItem key={item.to} to={item.to} icon={item.icon} label={item.label} tooltip={item.tooltip} />
            ))}
          </nav>

          <div className="px-4 pt-4 mt-4 border-t border-white/8">
            <div
              className="text-[11px] uppercase tracking-[0.14em] text-[#94A3B8] font-semibold mb-2"
              title="Secondary modules that are useful for advanced workflows but not required for the core agent lifecycle."
            >
              Extended
            </div>
            <div className="space-y-2">
              {navSecondary.map((item) => (
                <SidebarItem key={item.to} to={item.to} icon={item.icon} label={item.label} tooltip={item.tooltip} />
              ))}
            </div>
          </div>

          <div className="p-4 mt-auto border-t border-white/8">
            <div className="text-xs text-[#94A3B8]">
              <div className="flex items-center gap-2 font-medium">
                <span className="w-2 h-2 rounded-full bg-[#00E676] shadow-[0_0_10px_rgba(0,230,118,0.75)]" />
                Control Plane Ready
              </div>
              <div className="mt-2 font-mono text-[11px] text-[#cdd2f3] bg-white/5 px-2 py-1 rounded border border-white/10">
                ghost.rideai.com.au
              </div>
            </div>
          </div>
        </aside>

        {/* Mobile sidebar overlay */}
        <AnimatePresence>
          {mobileOpen && (
            <motion.div
              className="fixed inset-0 z-50 md:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              aria-label="Mobile navigation"
            >
              <motion.button
                className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                onClick={() => setMobileOpen(false)}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                aria-label="Close navigation overlay"
              />
              <motion.aside
                initial={{ x: -320 }}
                animate={{ x: 0 }}
                exit={{ x: -320 }}
                transition={{ type: 'spring', stiffness: 260, damping: 28 }}
                className="absolute left-0 top-0 h-full w-[84%] max-w-xs glass-panel border-y-0 border-l-0 border-r border-white/10 bg-[rgba(10,20,30,0.7)] p-5 flex flex-col"
              >
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    className="flex items-center gap-3 rounded-2xl text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[#4FC3F7]/70"
                    onMouseEnter={handleLogoHoverStart}
                    onMouseLeave={handleLogoHoverEnd}
                    onDoubleClick={openVersionCard}
                    aria-label="Show dashboard version"
                    title="Double-click, or hover for 5 seconds, to show dashboard version"
                  >
                    <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-[#00E676] to-[#4FC3F7] p-[1px] shadow-[0_0_20px_rgba(0,230,118,0.18)]">
                      <div className="w-full h-full rounded-2xl bg-[#0f172a]/90 border border-white/10 flex items-center justify-center">
                        <span className="logo-text text-[11px] font-bold">RAIG</span>
                      </div>
                    </div>
                    <div>
                      <div className="text-lg font-semibold tracking-tight text-[#f2f3ff] leading-tight">
                        RideAI — GhostDash
                      </div>
                      <div
                        className="text-[10px] uppercase tracking-[0.20em] text-[#94A3B8] font-semibold"
                        title="Create, configure, deploy, and monitor specialized voice agents with server-side tools, retrieval, telemetry, and evaluation."
                      >
                        Voice AI Agents
                      </div>
                    </div>
                  </button>

                  <button
                    className="p-2 rounded-xl glass-button"
                    onClick={() => setMobileOpen(false)}
                    aria-label="Close navigation"
                  >
                    <X size={18} />
                  </button>
                </div>

                <nav className="mt-6 space-y-2">
                  {navPrimary.map((item) => (
                    <SidebarItem key={item.to} to={item.to} icon={item.icon} label={item.label} tooltip={item.tooltip} />
                  ))}
                </nav>

                <div className="mt-4 pt-4 border-t border-white/8">
                  <div
                    className="text-[11px] uppercase tracking-[0.14em] text-[#94A3B8] font-semibold mb-2"
                    title="Secondary modules that are useful for advanced workflows but not required for the core agent lifecycle."
                  >
                    Extended
                  </div>
                  <div className="space-y-2">
                    {navSecondary.map((item) => (
                      <SidebarItem key={`mobile-${item.to}`} to={item.to} icon={item.icon} label={item.label} tooltip={item.tooltip} />
                    ))}
                  </div>
                </div>

                <div className="mt-4 pt-4 border-t border-white/8 text-xs text-[#94A3B8]">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-[#00E676] shadow-[0_0_10px_rgba(0,230,118,0.75)]" />
                    Control Plane Ready
                  </div>
                </div>
              </motion.aside>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {versionCardOpen && (
            <motion.div
              className="fixed inset-0 z-[60] pointer-events-none"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <button
                className="absolute inset-0 pointer-events-auto bg-black/20 backdrop-blur-[2px]"
                onClick={() => setVersionCardOpen(false)}
                aria-label="Close dashboard version popup"
              />
              <motion.div
                initial={{ opacity: 0, x: -10, y: -10, scale: 0.98 }}
                animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
                exit={{ opacity: 0, x: -10, y: -10, scale: 0.98 }}
                transition={{ duration: 0.16 }}
                className="pointer-events-auto absolute left-4 top-4 w-[min(92vw,24rem)] glass-panel rounded-3xl border border-white/12 bg-[rgba(10,20,30,0.84)] p-4 shadow-2xl"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.18em] text-[#94A3B8]">Dashboard Version</div>
                    <div className="mt-1 text-lg font-semibold text-[#f2f3ff]">
                      {versionInfo?.dashboard_version || (versionLoading ? 'Loading...' : 'Unavailable')}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="rounded-xl glass-button px-2 py-1 text-xs"
                    onClick={() => setVersionCardOpen(false)}
                    aria-label="Close version popup"
                  >
                    <X size={14} />
                  </button>
                </div>

                <div className="mt-4 space-y-2 text-sm text-[#cdd2f3]">
                  <VersionRow label="Package" value={versionInfo?.package_version} />
                  <VersionRow label="Branch" value={versionInfo?.git_branch} />
                  <VersionRow label="Commit" value={versionInfo?.git_commit_short || versionInfo?.git_commit} mono />
                  <VersionRow label="Tag" value={versionInfo?.git_tag} />
                  <VersionRow label="Source" value={versionInfo?.github_url || versionInfo?.git_remote || versionInfo?.source} />
                  <VersionRow label="Generated" value={versionInfo?.generated_at ? new Date(versionInfo.generated_at).toLocaleString() : ''} />
                </div>

                {versionError ? (
                  <div className="mt-4 rounded-2xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-sm text-red-100">
                    {versionError}
                  </div>
                ) : null}

                <div className="mt-4 flex items-center justify-between gap-3 text-[11px] text-[#94A3B8]">
                  <span>Double-click or hover the RAIG mark for 5 seconds.</span>
                  <button type="button" className="glass-button rounded-xl px-3 py-1.5 text-xs text-[#f2f3ff]" onClick={() => void loadDashboardVersion()}>
                    Refresh
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Main */}
        <main className="flex-1 min-w-0 flex flex-col">
          <header className="h-16 glass-panel border-x-0 border-t-0 border-b border-white/10 flex items-center justify-between px-4 sm:px-6 lg:px-8">
            <div className="flex items-center gap-2 lg:gap-3">
              <button
                className="md:hidden p-2 rounded-xl glass-button"
                onClick={() => setMobileOpen(true)}
                aria-label="Open navigation"
              >
                <Menu size={18} />
              </button>
              <div className="toolbar-pill-dark hidden lg:flex items-center gap-2 rounded-xl px-3 py-1.5">
                <Search size={14} className="text-[#94A3B8]" />
                <input
                  placeholder="Search agents, traces, runs, routes, errors..."
                  title="Search across agents, traces, routes, runs, errors, and execution metadata."
                  className="bg-transparent border-none outline-none text-xs text-[#E6EDF3] placeholder:text-[#94A3B8] w-52"
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <div
                className="toolbar-pill-dark hidden md:flex items-center gap-2 text-xs rounded-xl px-2 py-1.5"
                title="Choose which environment you are viewing, such as development, staging, or production."
              >
                <span className="font-semibold">Environment</span>
                <select className="bg-transparent outline-none">
                  <option>Production</option>
                  <option>Staging</option>
                  <option>Dev</option>
                </select>
              </div>
              <div
                className="toolbar-pill-dark hidden md:flex items-center gap-2 text-xs rounded-xl px-2 py-1.5"
                title="Filter the current view by time window for metrics, traces, and logs."
              >
                <span className="font-semibold">Time Range</span>
                <select className="bg-transparent outline-none">
                  <option>Today</option>
                  <option>24h</option>
                  <option>7d</option>
                </select>
              </div>
              <div className="relative">
                <button
                  className="p-2 rounded-xl glass-button"
                  onClick={() => setQuickSettingsOpen((v) => !v)}
                  aria-label="Visual settings"
                  title="Visual settings"
                >
                  <SlidersHorizontal size={18} />
                </button>

                <AnimatePresence>
                  {quickSettingsOpen && (
                    <motion.div
                      initial={{ opacity: 0, y: 8, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 8, scale: 0.98 }}
                      transition={{ duration: 0.15 }}
                      className="absolute right-0 mt-3 w-72 glass-panel rounded-2xl p-4 border border-white/12 shadow-2xl"
                    >
                      <div className="flex items-center justify-between">
                        <div className="text-xs font-semibold uppercase tracking-wider text-[#94A3B8]">Brand Glass</div>
                        <NavLink to="/settings" className="text-xs text-[#d8ddff] hover:text-white transition-colors">
                          Advanced
                        </NavLink>
                      </div>

                      <div className="mt-3">
                        <div className="flex items-center justify-between text-[11px] text-[#94A3B8]">
                          <span>Transparency</span>
                          <span className="font-mono text-[#94A3B8]">{glassOpacity.toFixed(2)}</span>
                        </div>
                        <input
                          type="range"
                          min={MIN_GLASS_OPACITY}
                          max={MAX_GLASS_OPACITY}
                          step={0.01}
                          value={glassOpacity}
                          onChange={(e) => setGlassOpacityState(Number(e.target.value))}
                          className="mt-2 w-full accent-[#00E676] cursor-pointer"
                        />
                        <div className="mt-2 flex justify-between text-[10px] text-[#94A3B8] uppercase tracking-widest">
                          <span>Near Clear</span>
                          <span>Near Solid</span>
                        </div>
                        <button
                          onClick={() => setGlassOpacityState(DEFAULT_GLASS_OPACITY)}
                          className="mt-3 w-full rounded-lg glass-button px-3 py-1.5 text-xs"
                        >
                          Reset to balanced glass
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
              <button className="p-2 rounded-xl glass-button" aria-label="Notifications">
                <Bell size={17} />
              </button>
              <div
                className="toolbar-pill-dark hidden sm:flex items-center gap-2 rounded-xl px-2.5 py-1.5"
                title="Product identity badge for the GhostDash runtime surface."
              >
                <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-[#00E676] to-[#4FC3F7] p-[1px]">
                  <div className="w-full h-full rounded-lg bg-[#0f172a]/90 border border-white/10 flex items-center justify-center">
                    <span className="logo-text text-[9px] font-bold">RAIG</span>
                  </div>
                </div>
                <span className="text-xs text-[#f2f3ff] font-semibold">RideAI</span>
              </div>
            </div>
          </header>
          <div className="px-4 sm:px-6 lg:px-8 pt-3 text-sm text-[#94A3B8]">
            <span className="font-semibold text-[#f2f3ff]">{prettyTitleFromPath(location.pathname)}</span>
            <span className="ml-2">Operational workspace for agents, knowledge, telemetry, and runtime state.</span>
          </div>
          {(() => {
            const now = Date.now();
            const visibleAlerts = criticalAlerts.filter((a) => {
              const key = alertFingerprint(a);
              const expiresAt = dismissedAlerts[key];
              return !(Number.isFinite(expiresAt) && expiresAt > now);
            });
            const activeAlert = visibleAlerts[0];
            if (!activeAlert) return null;
            const severity = classifyAlertSeverity(activeAlert);
            const isWarning = severity === 'warning';
            return (
              <div className={`mx-4 sm:mx-6 lg:mx-8 mt-3 rounded-2xl px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 ${
                isWarning
                  ? 'border border-orange-400/30 bg-orange-500/10'
                  : 'border border-red-500/35 bg-red-500/12'
              }`}>
                <div className="inline-flex items-start gap-2 text-[#E6EDF3]">
                  <AlertTriangle size={16} className={`mt-0.5 ${isWarning ? 'text-orange-300' : 'text-red-300'}`} />
                  <div>
                    <div className={`text-xs uppercase tracking-[0.16em] ${isWarning ? 'text-orange-200' : 'text-red-200'}`}>
                      {isWarning ? 'Warning Backend Alert' : 'Critical Backend Alert'}
                    </div>
                    <div className="text-sm">
                      {activeAlert.route} · {activeAlert.error || `status ${activeAlert.status}`}
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <NavLink to="/agent-knowledge" className="glass-button px-3 py-1.5 rounded-lg text-xs">
                    Agent Knowledge
                  </NavLink>
                  <NavLink to="/logs" className="glass-button px-3 py-1.5 rounded-lg text-xs">
                    Logs
                  </NavLink>
                  <button
                    onClick={() => handleDismissAlert(alertFingerprint(activeAlert))}
                    className="glass-button px-3 py-1.5 rounded-lg text-xs"
                  >
                    <X size={14} className="inline mr-1 -mt-0.5" />
                    Dismiss
                  </button>
                  <button
                    onClick={dismissAllCurrentAlerts}
                    className="glass-button px-3 py-1.5 rounded-lg text-xs"
                    title="Dismiss all current critical alerts for 30 minutes"
                  >
                    Dismiss All Current
                  </button>
                </div>
              </div>
            );
          })()}

          <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
            <Outlet />
          </div>
          <SystemMetricsBar />
        </main>
      </div>
    </div>
  );
}

function SidebarItem({ to, icon, label, tooltip, href, newWindow = false }: NavItem) {
  const externalHref = href;
  if (externalHref) {
    return (
      <a
        href={externalHref}
        target={newWindow ? '_blank' : undefined}
        rel={newWindow ? 'noreferrer noopener' : undefined}
        title={tooltip}
        className="nav-item flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-200 text-[#94A3B8]"
      >
        {icon}
        <span className="text-sm font-medium">{label}</span>
      </a>
    );
  }
  return (
    <NavLink
      to={to}
      title={tooltip}
      className={({ isActive }) =>
        [
          'nav-item flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-200',
          isActive
            ? 'active text-white border-l-[3px] border-l-[#00E676]'
            : 'text-[#94A3B8]',
        ].join(' ')
      }
      end={to === '/'}
    >
      {icon}
      <span className="text-sm font-medium">{label}</span>
    </NavLink>
  );
}

function VersionRow({ label, value, mono = false }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-white/8 bg-white/5 px-3 py-2">
      <span className="text-[#94A3B8]">{label}</span>
      <span className={mono ? 'font-mono text-right text-[#f2f3ff]' : 'text-right text-[#f2f3ff]'}>
        {value || 'n/a'}
      </span>
    </div>
  );
}

function prettyTitleFromPath(pathname: string): string {
  if (!pathname || pathname === '/') return 'Mission Control';
  const key = pathname.split('/').filter(Boolean)[0] || 'monitoring';
  switch (key) {
    case 'monitoring':
      return 'Mission Control';
    case 'agents':
      return 'Agents';
    case 'ghost':
      return 'Ghost';
    case 'tools':
      return 'Tool Gateway';
    case 'integration-lab':
      return 'Integration Lab';
    case 'logs':
      return 'Trace Explorer';
    case 'llm-logs':
      return 'Event Stream';
    case 'elevenlabs':
      return 'Voice Stack';
    case 'models':
    case 'llm-settings':
      return 'LLM SETTINGS';
    case 'knowledge':
      return 'AGENT KNOWLEDGE BASE';
    case 'agent-knowledge':
      return 'AGENT KNOWLEDGE BASE';
    case 'orchestration':
      return 'Orchestration';
    case 'settings':
      return 'System Settings';
    default:
      return key.charAt(0).toUpperCase() + key.slice(1);
  }
}
