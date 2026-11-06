// Identity. Everyone starts as a guest (an anonymous account made on first visit). An email turns the
// guest into an account: one message carries a link, and a new address picks its password on arrival. Google and any OpenID Connect
// provider plug in through environment variables; both sign in through /callback/<provider>, where the
// anonymous plugin hands the guest's canvases over to the account. A password is optional, and only ever
// chosen through a link sent to the address: nobody can put one on someone else's email.
import { AsyncLocalStorage } from "node:async_hooks";
import { betterAuth } from "better-auth";
import { anonymous, genericOAuth, magicLink } from "better-auth/plugins";
import { APIError } from "better-auth/api";
import { authDatabase, q } from "./db.js";
import { env } from "./env.js";
import { guestName } from "./texts.js";
import { sendLoginEmail } from "./mail.js";
import { LINK_MINUTES, linkAskedGuest, linkGuest } from "./guests.js";
import { event, hit, isBrowser } from "./stats.js";
import { emit } from "./extend.js";
import { VISITOR_IP_HEADER } from "./security.js";

// While /api/login/email runs, the link and its token land here: that route sends the email itself.
export const loginBox = new AsyncLocalStorage<{ link?: string; token?: string }>();
// Same for the token of a password email, which /api/login/password-reset sends itself.
export const resetBox = new AsyncLocalStorage<{ token?: string }>();

export const emailAllowed = (email: string) =>
  !env.allowedDomains.length || env.allowedDomains.includes(email.split("@")[1]?.toLowerCase() ?? "");

// The profile pictures the app sets itself: the person's own upload, the Google photo copied at sign-in, or one
// that the OpenID Connect provider serves from its own address. Collaborators' browsers load the picture, so any
// other address would tell its server who opens the canvas and when: it counts as none.
export function knownImage(image: unknown, userId?: string): string | null {
  if (typeof image !== "string" || !image) return null;
  const own = /^\/api\/avatar\/([^/?#]+)\?v=\d+$/.exec(image);
  if (own) return own[1] === userId ? image : null;
  try {
    const { protocol, host } = new URL(image);
    if (protocol === "https:" && (/^lh\d\.googleusercontent\.com$/.test(host) || (env.oidc && host === new URL(env.oidc.issuer).host)))
      return image;
  } catch {}
  return null;
}

export const auth = betterAuth({
  appName: env.appName,
  baseURL: env.baseUrl,
  secret: env.authSecret,
  database: authDatabase as any,
  // The configured URL, plus whatever address the browser used to reach this very server (a LAN IP, a
  // second hostname). A page from another site never matches its own Host, so this stays CSRF-safe.
  trustedOrigins: async (request) => {
    const origins: string[] = [env.baseUrl];
    const origin = request?.headers.get("origin");
    const host = request?.headers.get("host");
    try {
      if (origin && host && new URL(origin).host === host) origins.push(origin);
    } catch {}
    return origins;
  },
  // Guests are identified by their session only: keep it for a year, renewed while in use.
  session: { expiresIn: 60 * 60 * 24 * 365, updateAge: 60 * 60 * 24 },
  rateLimit: { enabled: env.rateLimit, window: 60, max: 120 },
  // Counted by the visitor's address as security.ts finds it, never by what the request says of itself.
  advanced: { ipAddress: { ipAddressHeaders: [VISITOR_IP_HEADER] } },
  user: {
    additionalFields: {
      isAdmin: { type: "boolean", defaultValue: false, input: false },
      isProgram: { type: "boolean", defaultValue: false, input: false },
    },
  },
  account: { accountLinking: { enabled: true, trustedProviders: ["google", "oidc"] } },
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    resetPasswordTokenExpiresIn: 60 * 60,
    sendResetPassword: async ({ user, token }) => {
      const box = resetBox.getStore();
      if (box && !(user as any).isAnonymous && user.emailVerified) box.token = token;
    },
  },
  socialProviders: env.google
    ? { google: { clientId: env.google.clientId, clientSecret: env.google.clientSecret, prompt: "select_account" } }
    : {},
  databaseHooks: {
    session: {
      create: {
        after: async (session: any) => {
          await linkAskedGuest(session.userId).catch((e) => console.error("guest hand-over:", e?.message ?? e));
        },
      },
    },
    // An account that had no picture takes its Google photo when it links Google later (a new Google
    // account already gets it from Better Auth).
    account: {
      create: {
        after: async (account: any) => {
          if (account.providerId !== "google" || !account.idToken) return;
          try {
            const { picture } = JSON.parse(Buffer.from(account.idToken.split(".")[1], "base64url").toString());
            if (knownImage(picture)) await q(`update "user" set image = $1 where id = $2 and image is null`, [picture, account.userId]);
          } catch {}
        },
      },
    },
    user: {
      create: {
        after: async (user: any, ctx: any) => {
          // A guest made by a program (a script or an agent's program, a robot: no browser) is not a person who
          // came by: marked so, it stays out of the people, and its agents work for the owners of the canvases.
          const ua = ctx?.headers?.get?.("user-agent") ?? ctx?.request?.headers?.get?.("user-agent");
          if (user.isAnonymous && !isBrowser(ua)) {
            await q(`update "user" set "isProgram" = $2 where id = $1`, [user.id, true]).catch(() => {});
            return;
          }
          if (user.isAnonymous) hit("guest", "new");
          emit("personCreated", { id: user.id, account: !user.isAnonymous });
          event(
            user.isAnonymous
              ? { kind: "guest", who: user.name, user: user.id }
              : { kind: "signup", who: user.name, user: user.id, detail: user.email },
          );
        },
        before: async (user: any) => {
          // A provider's picture from anywhere else is left out.
          const data = user.image && !knownImage(user.image) ? { data: { image: null } } : undefined;
          if (user.isAnonymous) return data;
          if (env.signup === "closed") throw new APIError("FORBIDDEN", { message: "signup_closed" });
          if (!emailAllowed(user.email)) throw new APIError("FORBIDDEN", { message: "domain_not_allowed" });
          return data;
        },
      },
      // update-user takes any address as the picture: only the ones the app sets get through.
      update: {
        before: async (data: any, ctx: any) => {
          if (data.image && !knownImage(data.image, ctx?.context?.session?.user?.id))
            throw new APIError("BAD_REQUEST", { message: "bad_image" });
        },
      },
    },
  },
  plugins: [
    anonymous({
      generateName: async () => guestName(),
      onLinkAccount: async ({ anonymousUser, newUser }) => linkGuest(anonymousUser.user, newUser.user),
    }),
    magicLink({
      expiresIn: LINK_MINUTES * 60,
      storeToken: "hashed",
      sendMagicLink: async ({ email, token }) => {
        // Our own page: opening it does nothing until the button is pressed, so mail scanners that
        // follow links burn nothing. The token sits in the fragment, which they never see anyway.
        const link = `${env.baseUrl}/auth/confirm#t=${token}`;
        const box = loginBox.getStore();
        if (box) Object.assign(box, { link, token });
        else await sendLoginEmail(email, link);
      },
    }),
    ...(env.oidc
      ? [
          genericOAuth({
            config: [
              {
                providerId: "oidc",
                discoveryUrl: `${env.oidc.issuer}/.well-known/openid-configuration`,
                clientId: env.oidc.clientId,
                clientSecret: env.oidc.clientSecret,
                scopes: ["openid", "email", "profile"],
                pkce: true,
              },
            ],
          }),
        ]
      : []),
  ],
});

export type SessionUser = {
  id: string;
  name: string;
  email: string | null;
  anonymous: boolean;
  admin: boolean;
  program: boolean; // a guest made by a program, not a person
  image: string | null; // their upload or a sign-in provider's photo (knownImage); none means the drawn face
};

export async function sessionUser(headers: Headers): Promise<SessionUser | null> {
  const s = await auth.api.getSession({ headers }).catch(() => null);
  if (!s) return null;
  const anon = !!(s.user as any).isAnonymous;
  const email = anon ? null : s.user.email;
  return {
    id: s.user.id,
    name: s.user.name,
    email,
    anonymous: anon,
    admin: !anon && !!(s.user as any).isAdmin,
    program: anon && !!(s.user as any).isProgram,
    // Rows written before knownImage existed may hold any address.
    image: knownImage(s.user.image, s.user.id),
  };
}
