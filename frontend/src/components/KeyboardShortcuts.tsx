import { useEffect, useState } from "react";
import { X, Keyboard } from "lucide-react";

const SHORTCUTS = [
  { keys: ["⌘", "K"], label: "Quick search — jump to worker or pool" },
  { keys: ["?"],       label: "Show keyboard shortcuts" },
];

function Key({ k }: { k: string }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[1.4rem] h-5 px-1.5 rounded bg-gray-800 border border-gray-700 text-[11px] font-mono text-gray-300 shadow-sm">
      {k}
    </kbd>
  );
}

export function KeyboardShortcuts() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (
        e.key === "?" && !e.metaKey && !e.ctrlKey &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        setOpen(v => !v);
      }
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={() => setOpen(false)}
    >
      <div
        className="bg-gray-900 border border-gray-700/80 rounded-xl shadow-2xl overflow-hidden w-80"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div className="flex items-center gap-2 text-xs font-semibold text-gray-400 uppercase tracking-wider">
            <Keyboard size={12} /> Keyboard Shortcuts
          </div>
          <button onClick={() => setOpen(false)} className="p-1 rounded hover:bg-gray-800 text-gray-600 hover:text-gray-400 transition-colors">
            <X size={13} />
          </button>
        </div>
        <ul className="py-2">
          {SHORTCUTS.map(({ keys, label }) => (
            <li key={label} className="flex items-center justify-between px-5 py-2.5 gap-4">
              <span className="text-xs text-gray-400">{label}</span>
              <div className="flex items-center gap-1 flex-shrink-0">
                {keys.map(k => <Key key={k} k={k} />)}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
