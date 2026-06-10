import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { Link, NavLink } from "react-router-dom";
import {
  ActivityIcon,
  BarChart3Icon,
  DatabaseIcon,
  FileInputIcon,
  FlaskIcon,
  LayoutDashboardIcon,
  NetworkIcon,
  PanelLeftIcon,
  SettingsIcon,
  ShieldCheckIcon,
  WorkflowIcon,
} from "./ReferenceIcons";

type Props = { open: boolean; onToggle: () => void };

type NavItemProps = {
  to: string;
  label: string;
  icon: ReactNode;
  end?: boolean;
};

function NavItem({ to, label, icon, end }: NavItemProps) {
  const className = [
    "flex items-center gap-2 border-l-2 px-3 py-1.5 text-[0.8rem] font-medium transition-all duration-150",
    "border-transparent text-slate-500 hover:bg-slate-50 hover:text-slate-900",
  ].join(" ");

  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        isActive
          ? className.replace(
              "border-transparent text-slate-500 hover:bg-slate-50 hover:text-slate-900",
              "border-ghost-orange bg-white text-slate-900 font-semibold",
            )
          : className
      }
    >
      {icon}
      <span>{label}</span>
    </NavLink>
  );
}

export default function Sidebar({ open, onToggle }: Props) {
  return (
    <motion.aside
      initial={false}
      animate={{ marginLeft: open ? 0 : -170 }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
      className="z-20 flex h-screen w-[170px] flex-col overflow-y-auto border-r border-black/5 bg-white py-3"
    >
      <div className="px-3 pb-4 text-base font-extrabold tracking-tight text-slate-900">
        <div className="flex items-center justify-between gap-2">
          <Link to="/" className="flex items-center gap-1.5 text-left">
            <span aria-hidden="true">👻</span>
            <span>
              Ghost<span className="font-normal text-slate-500">DASH</span>
            </span>
          </Link>
          <button type="button" onClick={onToggle} className="ghost-icon-btn text-slate-400 hover:text-slate-900" aria-label="Toggle sidebar">
            <PanelLeftIcon size={16} strokeWidth={2.2} />
          </button>
        </div>
      </div>

      <div className="mb-4">
        <div className="mb-1 px-3 text-[0.6rem] font-bold uppercase tracking-[0.22em] text-slate-400">
          Rag Infrastructure
        </div>
        <nav className="flex flex-col gap-0.5">
          <NavItem to="/connections" label="LLM Connections" icon={<NetworkIcon size={14} />} />
          <NavItem to="/" end label="Knowledge & Retrieval" icon={<DatabaseIcon size={14} />} />
          <NavItem to="/vectors" label="Vector DBs" icon={<BarChart3Icon size={14} />} />
          <NavItem to="/logs" label="Operational Trace" icon={<LayoutDashboardIcon size={14} />} />
        </nav>
      </div>

      <div className="mb-4">
        <div className="mb-1 px-3 text-[0.6rem] font-bold uppercase tracking-[0.22em] text-slate-400">
          Ingestion
        </div>
        <nav className="flex flex-col gap-0.5">
          <NavItem to="/data-sources" label="Data Sources" icon={<FileInputIcon size={14} />} />
          <NavItem to="/pipelines" label="Parsing Pipelines" icon={<WorkflowIcon size={14} />} />
        </nav>
      </div>

      <div className="mb-4">
        <div className="mb-1 px-3 text-[0.6rem] font-bold uppercase tracking-[0.22em] text-slate-400">
          Agent
        </div>
        <nav className="flex flex-col gap-0.5">
          <NavItem to="/agent" label="Agent Config" icon={<ShieldCheckIcon size={14} />} />
        </nav>
      </div>

      <div className="mb-4">
        <div className="mb-1 px-3 text-[0.6rem] font-bold uppercase tracking-[0.22em] text-slate-400">
          Quality Assurance
        </div>
        <nav className="flex flex-col gap-0.5">
          <NavItem to="/knowledge-lab" label="Knowledge Lab" icon={<FlaskIcon size={14} />} />
          <NavItem to="/analysis/call-analysis" label="Call Analysis" icon={<ActivityIcon size={14} />} />
          <NavItem to="/analysis/voice-ops" label="Voice Ops" icon={<ShieldCheckIcon size={14} />} />
          <NavItem to="/analysis/test-workbench" label="Test Workbench" icon={<ActivityIcon size={14} />} />
        </nav>
      </div>

      <div>
        <div className="mb-1 px-3 text-[0.6rem] font-bold uppercase tracking-[0.22em] text-slate-400">
          Settings
        </div>
        <nav className="flex flex-col gap-0.5">
          <NavItem to="/tools" label="Tool Settings" icon={<NetworkIcon size={14} />} />
          <NavItem to="/config-explorer" label="Config Explorer" icon={<DatabaseIcon size={14} />} />
          <NavItem to="/settings" label="System Settings" icon={<SettingsIcon size={14} />} />
        </nav>
      </div>
    </motion.aside>
  );
}
