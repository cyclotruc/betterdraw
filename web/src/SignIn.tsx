// Google (and the server's own SSO) or an email: the email carries a link, and a new address picks its
// password when it comes back through it. Signing in to an existing account starts at the password, with
// a link as the fallback.
// Google and SSO appear when the server has them configured.
import { useState, type FormEvent } from "react";
import { api, ApiError, authClient, useConfig } from "./api";
import { t, type Key } from "./texts";
import { leaving } from "./nav";

// After signing in, come back to the same canvas; if it was an empty guest canvas, it no longer exists
// and the canvas page sends the person to their most recent one instead.
const back = () => location.pathname + location.search;
const remember = () => {
  leaving.onPurpose = true;
  try {
    sessionStorage.setItem("justSignedIn", "1");
  } catch {}
};

export function SignIn({ existing = false }: { existing?: boolean }) {
  const config = useConfig();
  const [email, setEmail] = useState("");
  const [step, setStep] = useState<"email" | "sent" | "password">(existing ? "password" : "email");
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fail = (err: unknown) => {
    const k = ("err_" + (err instanceof ApiError ? err.code : "generic")) as Key;
    setError(t(k) === k ? t("err_generic") : t(k));
  };
  const send = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/login/email", { method: "POST", body: JSON.stringify({ email }) });
      setStep("sent");
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const withPassword = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await authClient.signIn.email({ email: email.trim().toLowerCase(), password });
    if (r.error) {
      setBusy(false);
      return setError(r.error.status === 429 ? t("err_rate_limited") : t("err_bad_password"));
    }
    remember();
    location.replace(back());
  };
  const askLink = async () => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError(t("err_invalid_email"));
    setBusy(true);
    setError(null);
    try {
      await api("/api/login/password-reset", { method: "POST", body: JSON.stringify({ email }) });
      setNotice(t("resetSent", { email: email.trim() }));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const google = async () => {
    remember();
    await authClient.signIn.social({ provider: "google", callbackURL: back() });
  };
  const sso = async () => {
    remember();
    const r = await authClient.signIn.social({ provider: "oidc" as any, callbackURL: back() });
    if (r.error) setError(t("err_generic"));
  };

  const emailInput = (
    <input
      id="signin-email"
      type="email"
      required
      autoComplete="email"
      placeholder={t("emailPlaceholder")}
      value={email}
      onChange={(e) => setEmail(e.target.value)}
      aria-label="Email"
      autoFocus={!email}
    />
  );
  const providers = (config?.google || config?.oidc) && step !== "sent" && (
    <>
      <div className="or">
        <span>{t("or")}</span>
      </div>
      {config.google && (
        <button type="button" className="btn tall wide" onClick={google}>
          <GoogleMark /> {t("continueGoogle")}
        </button>
      )}
      {config.oidc && (
        <button type="button" className="btn tall wide" onClick={sso}>
          {t("continueWith", { name: config.oidc })}
        </button>
      )}
    </>
  );

  return (
    <div className="signin">
      {step === "password" ? (
        <form onSubmit={withPassword}>
          {emailInput}
          <input
            id="signin-password"
            type="password"
            required
            autoComplete="current-password"
            placeholder={t("password")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-label={t("password")}
            autoFocus={!!email}
          />
          <button className="btn primary tall wide" disabled={busy}>
            {t("signIn")}
          </button>
          <div className="signin-links">
            <button type="button" className="link-btn" onClick={askLink} disabled={busy}>
              {t("forgotPassword")}
            </button>
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setStep("email");
                setError(null);
                setNotice(null);
              }}
            >
              {t("linkInstead")}
            </button>
          </div>
        </form>
      ) : step === "email" ? (
        <form onSubmit={send}>
          {emailInput}
          <button className="btn primary tall wide" disabled={busy}>
            {t("continueEmail")}
          </button>
        </form>
      ) : (
        <div className="signin-sent">
          <p>{t("linkSent", { email })}</p>
          <button type="button" className="link-btn" onClick={() => setStep("email")}>
            {t("otherEmail")}
          </button>
        </div>
      )}
      {notice && <p className="hint">{notice}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {providers}
    </div>
  );
}

const GoogleMark = () => (
  <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
    <path
      fill="#FFC107"
      d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"
    />
    <path
      fill="#FF3D00"
      d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
    />
    <path
      fill="#4CAF50"
      d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"
    />
    <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
  </svg>
);
