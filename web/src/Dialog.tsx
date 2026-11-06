// A modal that behaves: focus goes in and stays in, Escape and the backdrop close it, focus comes back.
// Excalidraw takes its shortcuts from the whole page, so keys pressed in a modal stop at it.
import { useEffect, useRef, type ReactNode } from "react";
import { t } from "./texts";

export function Dialog({
  title,
  onClose,
  children,
  wide,
  small,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  small?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const box = ref.current!;
    const focusables = () =>
      [...box.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter(
        (e) => !e.hasAttribute("disabled"),
      );
    (
      box.querySelector<HTMLElement>("[data-autofocus]") ??
      focusables().find((e) => e.tagName === "INPUT" || e.tagName === "TEXTAREA") ??
      focusables()[0]
    )?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      if (e.key !== "Tab") return;
      const f = focusables();
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) {
        e.preventDefault();
        f[f.length - 1].focus();
      } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
        e.preventDefault();
        f[0].focus();
      }
    };
    box.addEventListener("keydown", onKey);
    return () => {
      box.removeEventListener("keydown", onKey);
      before?.focus?.();
    };
  }, []);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={"dialog" + (wide ? " wide" : "") + (small ? " small" : "")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t("close")}>
            ✕
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

// Asks before something that can only be undone for a moment. The action has the focus, so Enter confirms.
export function Confirm({
  title,
  text,
  action,
  onConfirm,
  onClose,
}: {
  title: string;
  text: string;
  action: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog title={title} onClose={onClose} small>
      <p className="confirm-text">{text}</p>
      <div className="confirm-acts">
        <button type="button" className="btn" onClick={onClose}>
          {t("cancel")}
        </button>
        <button
          type="button"
          className="btn danger"
          data-autofocus
          onClick={() => {
            onClose();
            onConfirm();
          }}
        >
          {action}
        </button>
      </div>
    </Dialog>
  );
}
