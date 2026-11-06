// A password email links here: choose the password, then you are signed in. As with the sign-in link,
// the token sits in the fragment and nothing happens until the button is pressed.
import { useState, type FormEvent } from "react";
import { authClient } from "./api";
import { t } from "./texts";
import { Dialog } from "./Dialog";

export function AuthPassword() {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get("t");
  const email = params.get("e") ?? "";
  const [password, setPassword] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setState("busy");
    const r = await authClient.resetPassword({ newPassword: password, token: token ?? "" });
    if (r.error) return setState("error");
    if (email) await authClient.signIn.email({ email, password });
    location.replace("/");
  };
  return (
    <Dialog title={t("passwordTitle")} onClose={() => location.replace("/")} small>
      <section className="join">
        {!token ? (
          <p className="join-lead">{t("linkIncomplete")}</p>
        ) : state === "error" ? (
          <p className="join-lead">{t("linkExpired")}</p>
        ) : (
          <form className="signin" onSubmit={save}>
            {email && <p className="join-lead">{email}</p>}
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
              {t("savePassword")}
            </button>
          </form>
        )}
      </section>
    </Dialog>
  );
}
