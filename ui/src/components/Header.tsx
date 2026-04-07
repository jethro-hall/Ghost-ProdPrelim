import { motion } from "framer-motion";

type Props = {
  onFullSync: () => void;
  onToggleRight: () => void;
  onToggleChat: () => void;
  syncing: boolean;
};

export default function Header({ onFullSync, onToggleRight, onToggleChat, syncing }: Props) {
  return (
    <header className="glass-panel relative z-10 flex items-center justify-between gap-4 px-4 py-3">
      <div>
        <p className="text-xs uppercase tracking-widest text-slate-400">Operator</p>
        <h1 className="text-lg font-semibold text-white">Knowledge & retrieval</h1>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <motion.button
          type="button"
          whileTap={{ scale: 0.97 }}
          className="glass-button-primary disabled:opacity-50"
          onClick={onFullSync}
          disabled={syncing}
        >
          Full Sync
        </motion.button>
        <button type="button" className="glass-button text-xs" onClick={onToggleRight}>
          Connections
        </button>
        <button type="button" className="glass-button text-xs" onClick={onToggleChat}>
          Chat
        </button>
      </div>
    </header>
  );
}
