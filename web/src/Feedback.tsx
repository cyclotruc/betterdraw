// The feedback button and what it opens: a few words, screenshots pasted or dropped, and what the browser knows
// of the moment, sent along without being shown (browser, screen, page, canvas, recent errors).
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { Dialog } from "./Dialog";
import { Icon, PATH } from "./Icon";
import { t } from "./texts";
import { toast } from "./toast";
import { usePrefs } from "./prefs";
import { loadConfig, useConfig } from "./api";
import brand from "../../branding/brand.json";

// The last errors of this page, kept from the start so that a bug report carries them.
const errors: { at: string; message: string; stack?: string }[] = [];
const note = (message: unknown, stack?: unknown) => {
  errors.push({
    at: new Date().toISOString(),
    message: String(message).slice(0, 500),
    stack: stack ? String(stack).slice(0, 1500) : undefined,
  });
  if (errors.length > 20) errors.shift();
};
window.addEventListener("error", (e: ErrorEvent) => note(e.message, e.error?.stack));
window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => note(e.reason?.message ?? e.reason, e.reason?.stack));
const consoleError = console.error;
console.error = (...args: unknown[]) => {
  note(args.map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a)?.slice(0, 200))).join(" "));
  consoleError(...args);
};

async function context(prefs: { theme: string; accent: string }) {
  const nav = navigator as any;
  const config = await loadConfig().catch(() => null);
  return {
    url: location.href,
    canvas: location.pathname.match(/^\/c\/([\w-]+)/)?.[1] ?? null,
    title: document.title,
    referrer: document.referrer || null,
    at: new Date().toISOString(),
    version: config?.version ?? null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    language: navigator.language,
    languages: navigator.languages,
    userAgent: navigator.userAgent,
    platform: nav.userAgentData?.platform ?? navigator.platform,
    mobile: nav.userAgentData?.mobile ?? /Mobi/.test(navigator.userAgent),
    viewport: { width: innerWidth, height: innerHeight },
    screen: { width: screen.width, height: screen.height, pixelRatio: devicePixelRatio },
    theme: document.documentElement.dataset.theme,
    systemTheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    prefs,
    touchPoints: navigator.maxTouchPoints,
    cores: navigator.hardwareConcurrency,
    memoryGb: nav.deviceMemory ?? null,
    connection: nav.connection
      ? { type: nav.connection.effectiveType, rtt: nav.connection.rtt, downlinkMbps: nav.connection.downlink }
      : null,
    online: navigator.onLine,
    installed: matchMedia("(display-mode: standalone)").matches,
    secondsOnPage: Math.round(performance.now() / 1000),
    errors: [...errors],
  };
}

// Always on screen: the way in to the feedback form. In the editor it sits in the bottom bar, left of the
// shortcuts (inline); elsewhere it floats at the bottom right. The form goes to the page's body, so it never
// takes the editor's styles.
export function FeedbackButton({ inline }: { inline?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={"feedback-btn" + (inline ? " inline" : "")} onClick={() => setOpen(true)} title={t("feedbackTitle")}>
        <Icon d={PATH.chat} size={15} />
        {t("feedback")}
      </button>
      {open && createPortal(<FeedbackDialog onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

type Shot = { file: File; url: string };

export function FeedbackDialog({ onClose }: { onClose: () => void }) {
  const prefs = usePrefs();
  const [kind, setKind] = useState<"feedback" | "bug">("feedback");
  const [message, setMessage] = useState("");
  const [shots, setShots] = useState<Shot[]>([]);
  const [sending, setSending] = useState(false);
  const [over, setOver] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  useEffect(() => () => shots.forEach((s) => URL.revokeObjectURL(s.url)), []);
  // The server's limits, which it checks too: none until it has told them.
  const config = useConfig();
  const maxShots = config?.feedbackShots ?? Infinity;
  const tooBig = t("feedbackTooBig", { mb: config?.feedbackShotMb ?? "" });

  const add = (files: Iterable<File>) => {
    const next: Shot[] = [];
    for (const f of files) {
      if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) continue;
      if (config && f.size > config.feedbackShotMb * 1048576) {
        toast(tooBig);
        continue;
      }
      next.push({ file: f, url: URL.createObjectURL(f) });
    }
    setShots((old) => [...old, ...next].slice(0, maxShots));
  };
  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (files.length) {
      e.preventDefault();
      add(files);
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    add(e.dataTransfer.files);
  };

  const send = async () => {
    if (!message.trim() && !shots.length) return;
    setSending(true);
    try {
      const form = new FormData();
      form.set("kind", kind);
      form.set("message", message);
      form.set("context", JSON.stringify(await context({ theme: prefs.theme, accent: prefs.accent })));
      for (const s of shots) form.append("shots", s.file, s.file.name || "screenshot.png");
      const r = await fetch("/api/feedback", { method: "POST", body: form, credentials: "same-origin" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "failed");
      toast(t("feedbackSent"));
      onClose();
    } catch (e: any) {
      toast(e?.message === "rate_limited" ? t("feedbackTooMany") : e?.message === "too_big" ? tooBig : t("err_generic"));
      setSending(false);
    }
  };

  return (
    <Dialog title={t("feedbackTitle")} onClose={onClose}>
      <section
        className={"feedback" + (over ? " over" : "")}
        onPaste={onPaste}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <p className="hint">{t("feedbackLead", { app: brand.name })}</p>
        <div className="seg" role="radiogroup" aria-label={t("feedbackKind")}>
          {(["feedback", "bug"] as const).map((k) => (
            <button key={k} role="radio" aria-checked={kind === k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
              {t(k === "bug" ? "kindBug" : "kindFeedback")}
            </button>
          ))}
        </div>
        <textarea
          id="feedback-message"
          data-autofocus
          rows={6}
          maxLength={10000}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && send()}
          placeholder={t(kind === "bug" ? "bugPlaceholder" : "feedbackPlaceholder", { app: brand.name })}
          aria-label={t("feedbackTitle")}
        />
        <div className="shots">
          {shots.map((s, i) => (
            <span key={s.url} className="shot">
              <img src={s.url} alt="" />
              <button
                type="button"
                aria-label={t("remove")}
                title={t("remove")}
                onClick={() => {
                  URL.revokeObjectURL(s.url);
                  setShots((old) => old.filter((_, j) => j !== i));
                }}
              >
                ×
              </button>
            </span>
          ))}
          {shots.length < maxShots && (
            <button type="button" className="shot-add" onClick={() => picker.current?.click()}>
              <Icon d={PATH.image} size={18} />
              <span>{t("feedbackShots")}</span>
            </button>
          )}
          <input
            ref={picker}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={(e) => {
              add(e.target.files ?? []);
              e.target.value = "";
            }}
          />
        </div>
        <div className="feedback-foot">
          <small className="hint">{t("feedbackContext")}</small>
          <button className="btn primary" disabled={sending || (!message.trim() && !shots.length)} onClick={send}>
            {sending ? t("feedbackSending") : t("feedbackSend")}
          </button>
        </div>
      </section>
    </Dialog>
  );
}
