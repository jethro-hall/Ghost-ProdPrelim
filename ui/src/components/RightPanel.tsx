import { AnimatePresence, motion } from "framer-motion";
import type { Connection } from "../api";

type Props = {
  open: boolean;
  onClose: () => void;
  connections: Connection[];
  onSave: (c: {
    provider: string;
    label?: string;
    api_key?: string;
    base_url?: string;
    chat_model?: string;
    embedding_model?: string;
    enabled?: boolean;
  }) => Promise<void>;
};

export default function RightPanel({ open, onClose, connections, onSave }: Props) {
  const openai = connections.find((c) => c.provider === "openai");

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.button
            type="button"
            aria-label="Close panel"
            className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.aside
            className="glass-panel fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col gap-4 p-5 shadow-2xl"
            initial={{ x: "100%", opacity: 0.8 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: "100%", opacity: 0.8 }}
            transition={{ type: "spring", stiffness: 280, damping: 30 }}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-white">Connections</h2>
              <button type="button" className="glass-button text-xs" onClick={onClose}>
                Close
              </button>
            </div>
            <form
              className="flex flex-col gap-3"
              onSubmit={async (e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                await onSave({
                  provider: "openai",
                  label: (fd.get("label") as string) || "OpenAI",
                  api_key: (fd.get("api_key") as string) || undefined,
                  base_url: (fd.get("base_url") as string) || undefined,
                  chat_model: (fd.get("chat_model") as string) || undefined,
                  embedding_model: (fd.get("embedding_model") as string) || undefined,
                  enabled: true,
                });
              }}
            >
              <label className="text-xs text-slate-400">Label</label>
              <input
                name="label"
                className="glass-input"
                defaultValue={openai?.label ?? "OpenAI"}
              />
              <label className="text-xs text-slate-400">API key</label>
              <input
                name="api_key"
                type="password"
                className="glass-input"
                placeholder={openai?.has_api_key ? "•••••••• (leave blank to keep)" : "sk-..."}
              />
              <label className="text-xs text-slate-400">Base URL</label>
              <input
                name="base_url"
                className="glass-input"
                defaultValue={openai?.base_url ?? "https://api.openai.com/v1"}
              />
              <label className="text-xs text-slate-400">Chat model</label>
              <input
                name="chat_model"
                className="glass-input"
                defaultValue={openai?.chat_model ?? "gpt-5.4"}
              />
              <label className="text-xs text-slate-400">Embedding model</label>
              <input
                name="embedding_model"
                className="glass-input"
                defaultValue={openai?.embedding_model ?? "text-embedding-3-small"}
              />
              <button type="submit" className="glass-button-primary mt-2">
                Save OpenAI
              </button>
            </form>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
