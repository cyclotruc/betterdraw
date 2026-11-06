// All configuration, read once from the environment, after loading a .env file if there is one.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import brand from "../branding/brand.json" with { type: "json" };
import pkg from "../package.json" with { type: "json" };

(await import("dotenv")).config({ quiet: true } as any);

const str = (k: string, fallback?: string) => {
  const v = process.env[k];
  if (v !== undefined && v !== "") return v;
  if (fallback === undefined) throw new Error(`Missing environment variable ${k}`);
  return fallback;
};
const opt = (k: string) => (process.env[k] ? process.env[k] : undefined);
const num = (k: string, fallback: number) => (process.env[k] ? Number(process.env[k]) : fallback);
const list = (k: string) =>
  (process.env[k] ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

const port = num("PORT", 3000);

// Without settings, everything lives in DATA_DIR: the SQLite database, the images and a generated secret.
const dataDir = str("DATA_DIR", "./data");
const generatedSecret = () => {
  const file = join(dataDir, "secret");
  if (!existsSync(file)) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  return readFileSync(file, "utf8").trim();
};

export const env = {
  appName: brand.name,
  version: pkg.version,
  port,
  bind: str("BIND", "127.0.0.1"),
  // Used for login links, OAuth redirects and secure cookies. Never derived from the request's Host header.
  baseUrl: str("BASE_URL", `http://localhost:${port}`).replace(/\/$/, ""),
  dataDir,
  databaseUrl: str("DATABASE_URL", `sqlite:${join(dataDir, "betterdraw.db")}`),
  authSecret: opt("AUTH_SECRET") ?? generatedSecret(),
  filesDir: str("FILES_DIR", join(dataDir, "files")),
  s3: opt("S3_BUCKET")
    ? {
        endpoint: str("S3_ENDPOINT").replace(/\/$/, ""),
        bucket: str("S3_BUCKET"),
        region: str("S3_REGION", "auto"),
        key: str("S3_ACCESS_KEY_ID"),
        secret: str("S3_SECRET_ACCESS_KEY"),
      }
    : null,
  smtpUrl: opt("SMTP_URL"),
  smtpFrom: str("SMTP_FROM", `${brand.name} <no-reply@localhost>`),
  // Without SMTP, login emails are printed in the server output, which is what a solo self-hoster wants.
  // Set MAIL_TO_LOGS=off where nobody should ever read login links in logs.
  mailToLogs: process.env.MAIL_TO_LOGS !== "off",
  signup: str("SIGNUP", "open") as "open" | "closed",
  allowedDomains: list("ALLOWED_EMAIL_DOMAINS"),
  google:
    opt("GOOGLE_CLIENT_ID") && opt("GOOGLE_CLIENT_SECRET")
      ? { clientId: str("GOOGLE_CLIENT_ID"), clientSecret: str("GOOGLE_CLIENT_SECRET") }
      : null,
  oidc: opt("OIDC_ISSUER")
    ? {
        issuer: str("OIDC_ISSUER").replace(/\/$/, ""),
        clientId: str("OIDC_CLIENT_ID"),
        clientSecret: str("OIDC_CLIENT_SECRET"),
        name: str("OIDC_NAME", "SSO"),
      }
    : null,
  maxFileBytes: num("MAX_FILE_MB", 10) * 1024 * 1024,
  maxElements: num("MAX_ELEMENTS_PER_CANVAS", 50_000),
  // What a canvas's drawing data may weigh, as JSON, deleted elements included: rooms hold it all in memory.
  maxCanvasBytes: num("MAX_CANVAS_MB", 100) * 1024 * 1024,
  // 0 means unlimited. Guests get limits by default so an open server cannot be filled anonymously.
  quota: {
    guestCanvases: num("QUOTA_CANVASES_GUEST", 5),
    userCanvases: num("QUOTA_CANVASES_USER", 0),
    guestBytes: num("QUOTA_STORAGE_MB_GUEST", 10) * 1024 * 1024,
    userBytes: num("QUOTA_STORAGE_MB_USER", 2000) * 1024 * 1024,
  },
  // How long a guest's canvas lasts from its creation, unless the guest makes an account; 0 keeps it. A canvas
  // keeps the lifetime it was made with.
  guestCanvasHours: num("GUEST_CANVAS_HOURS", 24),
  maxElementBytes: num("MAX_ELEMENT_KB", 2048) * 1024,
  exportMaxBytes: num("EXPORT_MAX_MB", 512) * 1024 * 1024,
  purge: {
    everyMs: num("PURGE_INTERVAL_MINUTES", 60) * 60_000,
    emptyAfterMs: num("PURGE_EMPTY_HOURS", 24) * 3_600_000,
    deletedAfterMs: num("PURGE_DELETED_DAYS", 30) * 86_400_000,
    guestAfterMs: num("PURGE_GUEST_DAYS", 30) * 86_400_000,
  },
  metricsToken: opt("METRICS_TOKEN"),
  legalDir: opt("LEGAL_DIR"),
  rateLimit: process.env.RATE_LIMIT !== "off",
  // The reverse proxies whose X-Forwarded-For names the visitor, as addresses or ranges: the machine itself by default.
  trustedProxies: process.env.TRUSTED_PROXIES ? list("TRUSTED_PROXIES") : ["127.0.0.0/8", "::1"],
};

