// One toast at a time, optionally with actions (Undo, Show). Announced to screen readers.
import { useEffect, useState } from "react";

type Action = { label: string; run: () => void };
type Toast = { id: number; text: string; actions: Action[]; ms: number };
let push: (t: Toast) => void = () => {};
let seq = 0;

export function toast(text: string, action?: Action | Action[], ms?: number) {
  const actions = !action ? [] : Array.isArray(action) ? action : [action];
  push({ id: ++seq, text, actions, ms: ms ?? (actions.length ? 6000 : 3000) });
}

export function Toasts() {
  const [current, setCurrent] = useState<Toast | null>(null);
  useEffect(() => {
    push = setCurrent;
  }, []);
  useEffect(() => {
    if (!current) return;
    const timer = setTimeout(() => setCurrent((c) => (c?.id === current.id ? null : c)), current.ms);
    return () => clearTimeout(timer);
  }, [current]);
  return (
    <div className="toast-zone" role="status" aria-live="polite">
      {current && (
        <div className="toast" key={current.id}>
          <span>{current.text}</span>
          {current.actions.map((a) => (
            <button
              key={a.label}
              className="toast-action"
              onClick={() => {
                a.run();
                setCurrent(null);
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
