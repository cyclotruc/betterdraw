// Response headers, same-origin checks and small in-memory rate limits.
import { BlockList, isIP } from "node:net";
import type { Context, MiddlewareHandler } from "hono";
import { env } from "./env.js";
import { indexable } from "./extend.js";

const baseOrigin = new URL(env.baseUrl).origin;

// A browser always sends Origin on writes. It must name the host it is talking to (whatever IP or name
// the user typed) or the configured public URL. No Origin means a script or an agent, not a browser.
export function sameOrigin(origin: string | undefined | null, host: string | undefined | null) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.host === host || u.origin === baseOrigin;
  } catch {
    return false;
  }
}

// What the app itself may load. Excalidraw needs inline styles, WebAssembly in its font worker, and embeds
// from anywhere. Profile pictures may come from Google or the OpenID Connect provider (knownImage in auth.ts).
function appPolicy(host: string) {
  const ws = /^[\w.:\-\[\]]+$/.test(host) ? ` ws://${host} wss://${host}` : "";
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self'${ws}`,
    "frame-src https:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set("x-content-type-options", "nosniff");
  // The canvas URL is the secret: never hand it to the sites a canvas links to.
  h.set("referrer-policy", "same-origin");
  // Search engines index only the pages an extension names: any other page may hold a canvas address.
  if (!indexable(c.req.path)) h.set("x-robots-tag", "noindex, nofollow");
  if (!h.has("content-security-policy")) h.set("content-security-policy", appPolicy(c.req.header("host") ?? ""));
  if (baseOrigin.startsWith("https:")) h.set("strict-transport-security", "max-age=31536000");
};

export const originCheck: MiddlewareHandler = async (c, next) => {
  if (
    !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
    !c.req.path.startsWith("/api/auth/") &&
    !sameOrigin(c.req.header("origin"), c.req.header("host"))
  )
    return c.json({ error: "bad_origin" }, 403);
  await next();
};

// The proxies whose X-Forwarded-For is believed (TRUSTED_PROXIES). An entry that is neither an address nor a range
// stops the server, rather than trusting other peers than meant.
const proxies = new BlockList();
for (const entry of env.trustedProxies) {
  const [, address, bits] = entry.match(/^([^/]+)(?:\/(\d{1,3}))?$/) ?? [];
  const family = address ? isIP(address) : 0;
  if (!family || Number(bits ?? 0) > (family === 6 ? 128 : 32))
    throw new Error(`TRUSTED_PROXIES: "${entry}" is neither an address nor a range such as 172.16.0.0/12.`);
  if (bits) proxies.addSubnet(address, Number(bits), family === 6 ? "ipv6" : "ipv4");
  else proxies.addAddress(address, family === 6 ? "ipv6" : "ipv4");
}
const isProxy = (ip: string) => {
  const family = isIP(ip);
  return !!family && proxies.check(ip, family === 6 ? "ipv6" : "ipv4");
};

// The visitor's address: the connection's, unless it comes from a trusted proxy. Then X-Forwarded-For is read from
// the nearest hop back, and the first address in it that is not a trusted proxy is the visitor's: what a client
// writes in the header itself, further left, is never reached.
export function clientIp(c: Context) {
  return ipOf((c.env as any)?.incoming?.socket?.remoteAddress ?? "", c.req.header("x-forwarded-for"));
}
export function ipOf(remote: string, xff: string | string[] | undefined) {
  if (!isProxy(remote)) return remote;
  const hops = (Array.isArray(xff) ? xff.join(",") : (xff ?? ""))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) if (!isProxy(hops[i])) return isIP(hops[i]) ? hops[i] : remote;
  return hops[0] ?? remote;
}
// Better Auth counts its own rate limits by the address in this header (auth.ts), which the /api/auth routes set to
// the visitor's address whatever the request carried (app.ts).
export const VISITOR_IP_HEADER = "x-visitor-ip";

const hits = new Map<string, number[]>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 86_400_000) hits.delete(k);
}, 600_000).unref();

// True when `key` already used `max` attempts in the last `windowMs`, or would with `n` more: a request may count
// as several attempts, such as a batch of messages, and then passes only if all of them fit.
export function limited(key: string, max: number, windowMs: number, n = 1) {
  if (!env.rateLimit) return false;
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  const over = recent.length + n > max;
  if (!over) for (let i = 0; i < n; i++) recent.push(now);
  hits.set(key, recent);
  return over;
}
