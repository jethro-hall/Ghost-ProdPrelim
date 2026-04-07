import { NavLink } from "react-router-dom";
import { motion } from "framer-motion";

type Props = { collapsed: boolean; onToggle: () => void };

export default function Sidebar({ collapsed, onToggle }: Props) {
  return (
    <motion.aside
      initial={false}
      animate={{ width: collapsed ? 72 : 240 }}
      transition={{ type: "spring", stiffness: 320, damping: 32 }}
      className="glass-panel relative z-10 flex h-full flex-col p-3"
    >
      <div className="mb-6 flex items-center justify-between gap-2">
        {!collapsed && (
          <span className="text-sm font-semibold tracking-wide text-white">
            Ghost<span className="text-ghost-orange">DASH</span>
          </span>
        )}
        <button type="button" className="glass-button text-xs" onClick={onToggle}>
          {collapsed ? "»" : "«"}
        </button>
      </div>
      <nav className="flex flex-col gap-1">
        <NavLink
          to="/"
          className={({ isActive }) =>
            `rounded-lg px-3 py-2 text-sm transition ${isActive ? "bg-white/10 text-white" : "text-slate-300 hover:bg-white/5"}`
          }
        >
          {!collapsed ? "Console" : "⌂"}
        </NavLink>
      </nav>
    </motion.aside>
  );
}
