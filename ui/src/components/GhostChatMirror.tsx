import { AnimatePresence, motion } from "framer-motion";
import { CloseIcon, MessageSquareIcon } from "./ReferenceIcons";

type Props = {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
};

export default function GhostChatMirror({ open, onOpen, onClose }: Props) {
  const ghostChatUiPath = "/ghost_chatui/";

  return (
    <>
      <AnimatePresence>
        {!open && (
          <motion.button
            type="button"
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 20, opacity: 0 }}
            onClick={onOpen}
            className="glass-chat fixed bottom-4 left-1/2 z-[9999] mb-0 flex -translate-x-1/2 items-center gap-2 rounded-t-xl border-b-0 px-4 py-2 text-[0.78rem] font-semibold text-slate-900"
          >
            <MessageSquareIcon size={14} />
            GhostChat
          </motion.button>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 24 }}
            transition={{ type: "spring", stiffness: 260, damping: 28 }}
            className="fixed inset-x-3 bottom-3 top-20 z-[9999] ghost-chat-panel glass-chat flex flex-col overflow-hidden rounded-2xl border-b-0"
          >
            <div className="flex items-center justify-between gap-2 border-b border-black/5 bg-white/70 px-3 py-2">
              <div className="flex items-center gap-2 text-[0.85rem] font-semibold text-slate-900">
                <MessageSquareIcon size={16} className="text-ghost-orange" />
                GhostChat (mirror)
                <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[0.64rem] font-semibold uppercase tracking-[0.16em] text-slate-700">
                  like-for-like
                </span>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={ghostChatUiPath}
                  target="_blank"
                  rel="noreferrer"
                  className="ghost-btn text-[0.72rem]"
                  title="Open Ghost ChatUI in a new tab"
                >
                  Open full page
                </a>
                <button type="button" onClick={onClose} className="ghost-icon-btn text-slate-600" title="Close chat mirror">
                  <CloseIcon size={14} />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 bg-white">
              <iframe
                title="Ghost ChatUI"
                src={ghostChatUiPath}
                className="h-full w-full border-0"
                loading="eager"
                referrerPolicy="same-origin"
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
