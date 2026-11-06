// Sending email: any SMTP server through one URL. Without one, messages are printed to the server
// output (the self-hoster reads the link there), unless MAIL_TO_LOGS=off.
import nodemailer from "nodemailer";
import brand from "../branding/brand.json" with { type: "json" };
import { env } from "./env.js";
import { mailText } from "./texts.js";

const transport = env.smtpUrl ? nodemailer.createTransport(env.smtpUrl) : null;

export async function sendMail(to: string, subject: string, text: string, html?: string) {
  if (transport) {
    await transport.sendMail({ from: env.smtpFrom, to, subject, text, html });
    return;
  }
  if (!env.mailToLogs) throw new Error("No SMTP_URL configured and MAIL_TO_LOGS=off: cannot send email");
  console.log(`\n[mail] no SMTP_URL, printing instead\n[mail] to: ${to}\n[mail] ${subject}\n${text}\n`);
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// The brand's accent (#rrggbb), and for links on white the same with a fifth of black, as the web app's
// color-mix() would: email clients have no color-mix().
const accent = brand.accent;
const darker = (i: number) => Math.round(parseInt(accent.slice(i, i + 2), 16) * 0.79);
const accentDark = "#" + [1, 3, 5].map((i) => darker(i).toString(16).padStart(2, "0")).join("");

type Words = { title: string; intro: string; button: string; orLink: string; ignore: string };

function render(m: Words, link: string) {
  const app = env.appName;
  const text = [m.title, "", m.intro, "", `${m.orLink}\n${link}`, "", m.ignore].join("\n");
  const base = escape(env.baseUrl);
  const sketchy = "border-radius:14px;border-radius:255px 15px 225px 15px/15px 225px 15px 255px";
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light">
<style>@font-face{font-family:"Bricolage Grotesque";font-weight:800;src:url(${base}/fonts/BricolageGrotesque/BricolageGrotesque-ExtraBold.woff2) format("woff2")}</style></head>
<body style="margin:0;padding:32px 16px;background:#fbfaf8;background-image:radial-gradient(#e2ddd6 1.2px,transparent 1.2px);background-size:26px 26px;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#1f1d1a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto"><tr><td>
<p style="margin:0 0 20px"><a href="${base}"><img src="${base}/email-logo.png" width="172" height="32" alt="${escape(app)}" style="display:block;border:0"></a></p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border:2px solid #1f1d1a;border-radius:14px"><tr><td style="padding:30px 28px">
<h1 style="margin:0 0 10px;font:800 28px/1.15 'Bricolage Grotesque',system-ui,-apple-system,'Segoe UI',sans-serif;letter-spacing:-0.03em">${escape(m.title)}</h1>
<p style="margin:0 0 24px;font-size:16px;line-height:1.55;color:#1f1d1a">${escape(m.intro)}</p>
<p style="margin:0 0 24px"><a href="${escape(link)}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;padding:13px 24px;font-weight:700;font-size:16px;border:2px solid ${accent};${sketchy}">${escape(m.button)}</a></p>
<p style="margin:0;font-size:13px;line-height:1.5;color:#6f6a63;word-break:break-all">${escape(m.orLink)}<br><a href="${escape(link)}" style="color:${accentDark}">${escape(link)}</a></p>
</td></tr></table>
<p style="margin:18px 4px 0;font-size:13px;line-height:1.5;color:#6f6a63">${escape(m.ignore)}</p>
</td></tr></table></body></html>`;
  return { text, html };
}

// A new address gets the sign-up words: its link asks for a password.
export async function sendLoginEmail(to: string, link: string, isNew = false) {
  const m = isNew ? mailText.signup : mailText;
  const { text, html } = render(m, link);
  await sendMail(to, m.subject(env.appName), text, html);
}

export async function sendPasswordEmail(to: string, link: string) {
  const m = mailText.password;
  const { text, html } = render(m, link);
  await sendMail(to, m.subject(env.appName), text, html);
}
