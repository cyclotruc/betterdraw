import { useEffect, useState } from "react";
import { api, authClient, useConfig, type Me } from "./api";
import { Dialog } from "./Dialog";
import { t, type Key } from "./texts";
import { ACCENTS, setPrefs, usePrefs } from "./prefs";
import { leaving } from "./nav";
import { Icon, PATH } from "./Icon";
import type { Next } from "./Sidebar";
import { ProfilePhoto } from "./ProfilePhoto";
import { SettingsExtra } from "./extend";
import { toast } from "./toast";
import brand from "../../branding/brand.json";

// Everything about you and the app in one place. A guest finds the way to an account at the top, with the
// time their first canvas has left.
export function Settings({
  me,
  setMe,
  next,
  onJoin,
  onClose,
}: {
  me: Me;
  setMe: (m: Me) => void;
  next: Next | null;
  onJoin: () => void;
  onClose: () => void;
}) {
  const prefs = usePrefs();
  const config = useConfig();
  // Guests' canvases do not expire on this server, and none of theirs was made while they did.
  const kept = config?.guestCanvasHours === 0 && !next;
  const [name, setName] = useState(me.name);
  const [saved, setSaved] = useState(false);

  const saveName = async () => {
    const n = name.trim().slice(0, 40);
    if (!n || n === me.name) return;
    await authClient.updateUser({ name: n });
    setMe({ ...me, name: n });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };
  const [confirmDelete, setConfirmDelete] = useState(false);
  const signOut = async () => {
    await authClient.signOut();
    leaving.onPurpose = true;
    location.href = "/";
  };
  const deleteAll = async () => {
    if (!confirmDelete) return setConfirmDelete(true);
    await api("/api/me", { method: "DELETE", body: JSON.stringify({ confirm: true }) });
    await authClient.signOut().catch(() => {});
    leaving.onPurpose = true;
    location.href = "/";
  };
  const askPassword = () =>
    api("/api/login/password-reset", { method: "POST", body: JSON.stringify({ email: me.email }) }).then(
      () => toast(t("passwordSent", { email: me.email ?? "" })),
      () => toast(t("err_generic")),
    );
  const isPreset = ACCENTS.some((a) => a.hex === prefs.accent);

  return (
    <Dialog title={t("settings")} onClose={onClose}>
      <section className="set-profile" tabIndex={-1} data-autofocus>
        <ProfilePhoto me={me} setMe={setMe} />
        <div className="set-id">
          <input
            id="settings-name"
            type="text"
            value={name}
            maxLength={40}
            aria-label={t("yourName")}
            title={t("nameHint")}
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
          <span className="sub">{saved ? <span className="ok">{t("saved")}</span> : me.anonymous ? t("guestSub") : me.email}</span>
        </div>
        {!me.anonymous && (
          <button className="btn" onClick={signOut}>
            {t("signOut")}
          </button>
        )}
      </section>

      {me.anonymous ? (
        <section>
          <div className="join-cta">
            <span className="guest-ic" aria-hidden="true">
              <Icon d={PATH.hourglass} size={18} />
            </span>
            <span className="guest-text">
              <b>{t(kept ? "guestCardKept" : "guestCard")}</b>
              <span>{next ? t("joinLeft", next) : t(kept ? "guestCardKeptSub" : "guestCardSub")}</span>
            </span>
            <button
              className="btn primary"
              onClick={() => {
                onClose();
                onJoin();
              }}
            >
              {t("createAccount2")}
            </button>
          </div>
        </section>
      ) : (
        <section>
          <h3>{t("account")}</h3>
          <div className="set-row">
            <span className="set-label">
              <b>{t("password")}</b>
              <small>{me.hasPassword ? t("passwordSome") : t("passwordNone")}</small>
            </span>
            <button className="btn" onClick={askPassword}>
              {me.hasPassword ? t("changePassword") : t("addPassword")}
            </button>
          </div>
        </section>
      )}

      <section>
        <h3>{t("appearance")}</h3>
        <div className="set-row">
          <span className="set-label">
            <b>{t("theme")}</b>
          </span>
          <div className="seg" role="radiogroup" aria-label={t("theme")}>
            {(["system", "light", "dark"] as const).map((th) => (
              <button
                key={th}
                role="radio"
                aria-checked={prefs.theme === th}
                className={prefs.theme === th ? "on" : ""}
                onClick={() => setPrefs({ theme: th })}
              >
                {t(th)}
              </button>
            ))}
          </div>
        </div>
        <div className="set-row">
          <span className="set-label">
            <b>{t("accent")}</b>
          </span>
          <div className="swatches">
            {ACCENTS.map((a) => (
              <button
                key={a.hex}
                className={"swatch" + (prefs.accent === a.hex ? " on" : "")}
                style={{ background: a.hex }}
                title={a.name}
                aria-label={a.name}
                aria-pressed={prefs.accent === a.hex}
                onClick={() => setPrefs({ accent: a.hex })}
              />
            ))}
            <label className={"swatch custom" + (!isPreset ? " on" : "")} title={t("customColor")}>
              <input
                type="color"
                value={prefs.accent}
                onChange={(e) => setPrefs({ accent: e.target.value })}
                aria-label={t("customColor")}
              />
            </label>
          </div>
        </div>
      </section>

      <Agents />

      {me.admin && (
        <section>
          <h3>{t("admin")}</h3>
          <div className="set-row">
            <span className="set-label">
              <b>{t("adminView")}</b>
              <small>{t("adminViewHint")}</small>
            </span>
            <div className="seg" role="radiogroup" aria-label={t("adminView")}>
              {(["on", "off"] as const).map((v) => (
                <button
                  key={v}
                  role="radio"
                  aria-checked={prefs.adminView === v}
                  className={prefs.adminView === v ? "on" : ""}
                  onClick={() => setPrefs({ adminView: v })}
                >
                  {t(v === "on" ? "shown" : "hidden")}
                </button>
              ))}
            </div>
          </div>
        </section>
      )}

      <SettingsExtra me={me} />

      <footer className="about">
        <a href="/api/export" download>
          {t("exportAll")}
        </a>
        <div className="about-links">
          {config?.legal.map((p) => (
            <a key={p} href={`/legal/${p}`} target="_blank" rel="noopener">
              {t(("legal_" + p) as Key) === "legal_" + p ? p : t(("legal_" + p) as Key)}
            </a>
          ))}
          <a href="/licenses.txt" target="_blank" rel="noopener">
            {t("licenses")}
          </a>
          <a href="https://github.com/excalidraw/excalidraw" target="_blank" rel="noopener">
            {t("builtOn")}
          </a>
        </div>
        <button className={"link-btn danger" + (confirmDelete ? " armed" : "")} onClick={deleteAll} onBlur={() => setConfirmDelete(false)}>
          {confirmDelete ? t("confirmDelete") : me.anonymous ? t("deleteGuest") : t("deleteAccount")}
        </button>
      </footer>
    </Dialog>
  );
}

type AgentKey = { id: string; name: string; created: string; lastUsed: string | null };

// Keys for AI agents: each one reads and draws with this person's access, through MCP or the HTTP API.
function Agents() {
  const [keys, setKeys] = useState<AgentKey[]>([]);
  const [made, setMade] = useState<string | null>(null);
  const load = () => api<AgentKey[]>("/api/keys").then(setKeys, () => {});
  useEffect(() => {
    load();
  }, []);
  const create = async () => {
    const name = new Date().toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" });
    const r = await api<{ key: string }>("/api/keys", { method: "POST", body: JSON.stringify({ name }) }).catch(() => null);
    if (!r) return toast(t("err_generic"));
    setMade(r.key);
    load();
  };
  const revoke = async (id: string) => {
    await api(`/api/keys/${id}`, { method: "DELETE" }).catch(() => {});
    load();
  };
  const mcp = `${location.origin}/mcp`;
  return (
    <section>
      <div className="set-row">
        <span className="set-label">
          <b>{t("agents")}</b>
          <small>{t("agentsExplain")}</small>
        </span>
        <button className="btn" onClick={create}>
          {t("newKey")}
        </button>
      </div>
      {made && (
        <div className="key-made">
          <p className="hint">{t("keyOnce")}</p>
          <Copyable text={made} />
          <p className="hint">{t("keyClaude")}</p>
          <Copyable text={`claude mcp add --transport http ${brand.name} ${mcp} --header "Authorization: Bearer ${made}"`} />
          <p className="hint">{t("keyOther", { url: mcp })}</p>
        </div>
      )}
      {keys.length > 0 && (
        <ul className="keys">
          {keys.map((k) => (
            <li key={k.id}>
              <span className="grow">{k.name}</span>
              <span className="hint">
                {k.lastUsed
                  ? t("keyUsed", { date: new Date(k.lastUsed).toLocaleDateString("en", { day: "numeric", month: "short" }) })
                  : t("keyUnused")}
              </span>
              <button className="link-btn danger" onClick={() => revoke(k.id)}>
                {t("revoke")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Copyable({ text }: { text: string }) {
  const copy = () =>
    navigator.clipboard.writeText(text).then(
      () => toast(t("copied")),
      () => toast(t("err_generic")),
    );
  return (
    <div className="copyable">
      <code>{text}</code>
      <button className="link-btn" onClick={copy}>
        {t("copy")}
      </button>
    </div>
  );
}
