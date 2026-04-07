import { AnimatePresence, motion } from "framer-motion";
import type { TaskStep } from "../api";

type Props = {
  open: boolean;
  steps: TaskStep[];
};

export default function FullScreenLoader({ open, steps }: Props) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/80 backdrop-blur-md"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div className="glass-panel max-w-md p-6">
            <h3 className="mb-4 text-lg font-semibold text-white">Full sync</h3>
            <ul className="space-y-2 text-sm">
              {steps.map((s) => (
                <li
                  key={s.id}
                  className={`flex items-center gap-2 ${s.done ? "text-emerald-300" : s.active ? "text-ghost-orange" : "text-slate-400"}`}
                >
                  <span>{s.done ? "✓" : s.active ? "›" : "○"}</span>
                  {s.label}
                </li>
              ))}
            </ul>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
