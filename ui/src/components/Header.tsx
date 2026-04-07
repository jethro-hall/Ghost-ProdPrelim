import { motion } from "framer-motion";
import { useLocation } from "react-router-dom";
import { PanelLeftIcon, PlusIcon } from "./ReferenceIcons";

type Props = {
  onFullSync: () => void;
  onToggleRight: () => void;
  onToggleSidebar: () => void;
  syncing: boolean;
};

const TITLES: Record<string, string> = {
  "/": "Knowledge & retrieval",
  "/connections": "LLM connections",
  "/data-sources": "Data sources",
  "/pipelines": "Parsing pipelines",
  "/vectors": "Vector DBs",
  "/knowledge-lab": "Knowledge lab",
  "/settings": "System administration",
  "/agent": "Agent configuration",
  "/logs": "Operational trace",
};

export default function Header({ onFullSync, onToggleRight, onToggleSidebar, syncing }: Props) {
  const location = useLocation();
  const title = TITLES[location.pathname] ?? "GhostDASH";

  return (
    <header className="glass-header sticky top-0 z-20 flex h-[44px] items-center justify-between px-4">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onToggleSidebar}
          className="ghost-icon-btn text-slate-400 hover:text-slate-900"
          title="Toggle menu"
        >
          <PanelLeftIcon size={18} strokeWidth={2.5} />
        </button>
        <div className="text-[0.9rem] font-semibold text-slate-900">{title}</div>
      </div>

      <div className="flex items-center gap-2">
        <motion.button
          type="button"
          whileTap={{ scale: 0.98 }}
          onClick={onFullSync}
          disabled={syncing}
          className="ghost-btn-primary"
        >
          {syncing ? "Full Syncing..." : "Full Sync"}
        </motion.button>
        <button type="button" onClick={onToggleRight} className="ghost-btn">
          <PlusIcon size={14} strokeWidth={2.5} />
          Add Provider
        </button>
      </div>
    </header>
  );
}
