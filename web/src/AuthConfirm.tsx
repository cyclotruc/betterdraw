import { useState, type FormEvent } from "react";
import { api, authClient } from "./api";
import { t } from "./texts";
import { Dialog } from "./Dialog";

// The email links here, a popup over the app. It does nothing on load, so mail scanners that follow the link burn
// nothing. The token sits in the fragment, which they never see anyway. A new address (new=1) picks its
// password here, and that one press both signs in and creates the account.
export function AuthConfirm() {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get("t");
  const isNew = params.get("new") === "1";
  const [password, setPassword] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");
  const go = async (e?: FormEvent) => {
    e?.preventDefault();
    setState("busy");
    const r = await authClient.magicLink.verify({ query: { token: token ?? "" } });
    if (r.error) return setState("error");
    if (isNew) await api("/api/login/set-password", { method: "POST", body: JSON.stringify({ password }) }).catch(() => {});
    try {
      sessionStorage.setItem("justSignedIn", "1");
    } catch {}
    location.replace("/");
  };
  return (
    <Dialog title={isNew ? t("passwordTitle") : t("signInTitle")} onClose={() => location.replace("/")} small>
      <section className="join">
        {!token ? (
          <p className="join-lead">{t("linkIncomplete")}</p>
        ) : state === "error" ? (
          <p className="join-lead">{t("linkExpired")}</p>
        ) : isNew ? (
          <form className="signin" onSubmit={go}>
            <p className="join-lead">{t("passwordLead")}</p>
            <input
              type="password"
              required
              minLength={8}
              maxLength={128}
              autoComplete="new-password"
              placeholder={t("newPassword")}
              aria-label={t("newPassword")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
            <button className="btn primary tall wide" disabled={state === "busy" || password.length < 8}>
              {t("createAccount")}
            </button>
          </form>
        ) : (
          <div className="signin">
            <p className="join-lead">{t("confirmExplain")}</p>
            <button className="btn primary tall wide" onClick={() => go()} disabled={state === "busy"} data-autofocus>
              {t("signIn")}
            </button>
          </div>
        )}
      </section>
    </Dialog>
  );
}
