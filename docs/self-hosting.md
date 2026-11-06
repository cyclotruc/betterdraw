# Self-hosting

Everything runs in one container: the web app, the realtime server, the database (SQLite) and the image
store. Postgres and S3 are options for bigger installs, never requirements.

## Install

From a clone of the repository:

```bash
docker compose -f deploy/docker-compose.yml up -d
```

The server listens on `http://localhost:3000`. Everything stays in the `data` volume, mounted at
`/data`: the database `betterdraw.db`, the `files` folder with images, and `secret`, the key that signs
sessions. The container reports its health to Docker and restarts by itself.

Without Docker, with Node 22.13 or later: `npm ci && npm run build && npm start`. Data then goes to `./data`.
Agents' screenshots need a Chromium, which the Docker image includes: run
`npx playwright-core install chromium-headless-shell` once, or set `CHROMIUM_PATH` ([mcp.md](mcp.md) says
more). Without one, everything else works.

## Configuration

Every setting is an environment variable, set in `deploy/docker-compose.yml` or a `.env` file.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on. |
| `BIND` | `127.0.0.1` | Address to listen on. `0.0.0.0` makes it reachable from other machines. |
| `BASE_URL` | `http://localhost:PORT` | The address people use. Required behind a reverse proxy: login links, Google and SSO redirects and secure cookies depend on it. |
| `DATA_DIR` | `./data` (`/data` in Docker) | Database, images and secret. |
| `FILES_DIR` | `DATA_DIR/files` | Where images are kept on disk, when no S3 bucket is set. |
| `DATABASE_URL` | SQLite in `DATA_DIR` | `postgres://user:pass@host:5432/db` to use Postgres. |
| `SMTP_URL` | none | How login emails are sent, for example `smtps://user:pass@smtp.example.com:465`. |
| `SMTP_FROM` | `betterdraw <no-reply@localhost>` | Sender of login emails. |
| `MAIL_TO_LOGS` | on | Without SMTP, login links are printed in the server output. Set `off` to refuse instead. |
| `SIGNUP` | `open` | `closed`: only existing accounts can sign in and create canvases. Guests can still open shared canvases. |
| `ALLOWED_EMAIL_DOMAINS` | any | Comma-separated domains allowed to create accounts, for example `acme.com,acme.io`. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | none | Enables "Continue with Google". |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_NAME` | none | Enables sign-in through your company's identity provider. |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | none | Stores images in an S3-compatible bucket instead of the disk. |
| `LEGAL_DIR` | none | Folder of `notice.html`, `privacy.html`, `terms.html` served at `/legal/…` and linked in Settings. |
| `MAX_FILE_MB` | `10` | Largest image accepted. |
| `QUOTA_CANVASES_GUEST`, `QUOTA_CANVASES_USER` | `5`, `0` | Canvases a guest or an account may own. `0` means no limit. |
| `QUOTA_STORAGE_MB_GUEST`, `QUOTA_STORAGE_MB_USER` | `10`, `2000` | Storage per owner: their images, drawing data and trash. An image that would pass it is refused. |
| `GUEST_CANVAS_HOURS` | `24` | How long a guest's canvas lasts from its creation, unless the guest makes an account. `0` keeps them. A canvas keeps the lifetime it was made with. |
| `MAX_ELEMENTS_PER_CANVAS` | `50000` | Shapes per canvas. |
| `MAX_CANVAS_MB` | `100` | What a canvas's shapes may weigh as JSON, deleted ones included. New shapes are refused past it, and changes to the others a tenth further on, so that a full canvas can still be tidied. |
| `MAX_ELEMENT_KB` | `2048` | Largest shape kept, as JSON: a bigger one from the editor is not saved, and an agent's is refused. A request to the agent API may carry 16 times as much. |
| `EXPORT_MAX_MB` | `512` | Largest "export everything" zip, counted in images. Each canvas can still be exported alone. |
| `PURGE_EMPTY_HOURS`, `PURGE_DELETED_DAYS`, `PURGE_GUEST_DAYS` | `24`, `30`, `30` | When empty canvases, deleted canvases and idle guests are removed. |
| `PURGE_INTERVAL_MINUTES` | `60` | How often that housekeeping runs. |
| `TRUSTED_PROXIES` | `127.0.0.0/8,::1` | Reverse proxies whose `X-Forwarded-For` names the visitor, as addresses or ranges, comma-separated. The Compose files set Docker's private ranges, `172.16.0.0/12,192.168.0.0/16`. |
| `RATE_LIMIT` | on | Limits how often one address or person may try passwords, ask for login emails, sign in as a guest, send feedback and call the agent API. `off` turns these limits off. |
| `METRICS_TOKEN` | none | Enables `/metrics` (Prometheus format) for requests carrying `Authorization: Bearer <token>`. |
| `CHROMIUM_PATH` | Playwright's | A Chrome or Chromium binary for agents' screenshots. The Docker image has one. |
| `AUTH_SECRET` | generated | Signs sessions. Generated in `DATA_DIR/secret` when not set. Keep it with your backups. |

There is no telemetry: the server talks to nobody but the services you configure. Visitors' addresses never
leave the server.

## Put it on the internet

Run it behind a reverse proxy that handles HTTPS. WebSockets go through `/ws` on the same address.

Caddy:

```caddy
draw.example.com {
	reverse_proxy 127.0.0.1:3000
}
```

nginx:

```nginx
server {
  server_name draw.example.com;
  listen 443 ssl;
  # ssl_certificate …;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_read_timeout 1h;
    client_max_body_size 51m;  # nginx stops at 1 MB: images, and a bug report's screenshots
  }
}
```

Then set `BASE_URL=https://draw.example.com`. Rate limits count the visitor's address: the
connection's, unless the connection comes from a proxy named in `TRUSTED_PROXIES`, by default the machine
itself. Then it is the last address in `X-Forwarded-For` that is not such a proxy, so what a client writes
in that header is never believed. In Docker, a proxy on the host reaches the app from the gateway of
Docker's network, which the Compose files trust; publish the port beyond 127.0.0.1 only with that setting
changed.

Opened directly by IP on a local network, everything works, but browsers only allow
copying links to the clipboard on HTTPS or localhost, and login links in emails point to `BASE_URL`.

## Email

Any SMTP server works through one URL:

| Provider | `SMTP_URL` |
|---|---|
| Resend | `smtps://resend:<API key>@smtp.resend.com:465` |
| Postmark | `smtp://<server token>:<server token>@smtp.postmarkapp.com:587` |
| Brevo | `smtp://<login>:<SMTP key>@smtp-relay.brevo.com:587` |
| Gmail (app password) | `smtps://you%40gmail.com:<app password>@smtp.gmail.com:465` |

Switching provider, or moving to your own mail server, only changes this variable. Each login email
carries a link. It opens a
page with a button (or, for a new address, a password field), so mail scanners that open links do not burn it.

## Google sign-in

1. In Google Cloud, create an OAuth client of type "Web application".
2. Add the redirect URI `https://draw.example.com/api/auth/callback/google`.
3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, and restart.

Only the `openid`, `email` and `profile` scopes are used, so Google asks for no review beyond the brand
check of the consent screen.

## Company single sign-on (OpenID Connect)

Register an application in your identity provider (Okta, Entra ID, Keycloak, Authentik, Google
Workspace…) with the redirect URI `https://draw.example.com/api/auth/callback/oidc`, then set
`OIDC_ISSUER` (the URL before `/.well-known/openid-configuration`), `OIDC_CLIENT_ID`,
`OIDC_CLIENT_SECRET`, and `OIDC_NAME` (the button label, for example `Acme SSO`). Combine with
`ALLOWED_EMAIL_DOMAINS` and `SIGNUP=closed` for a private company server.

## Postgres and S3

`DATABASE_URL=postgres://…` switches to Postgres; tables are created at start. Images move to a bucket
with the `S3_*` variables (AWS, Cloudflare R2, Scaleway, OVH, Backblaze, MinIO: any S3-compatible
service, addressed in path style).

## A public instance with Docker Compose

`deploy/` holds a production setup: the app, Postgres, and a container that dumps the database every
night and keeps 14 days.

```bash
cp deploy/env.prod.example deploy/.env.prod   # fill it in; never commit it
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod up -d
```

Put Caddy in front with `deploy/Caddyfile`: it keeps canvas addresses, which are secrets, out of the
access logs. Set `MAIL_TO_LOGS=off` so that a broken email setting fails instead of printing login
links. Only one app container may run against the database, so deploy by recreating it, not by
scaling. To restore a dump:

```bash
gunzip -c backup.sql.gz | docker compose -f deploy/docker-compose.prod.yml exec -T db psql -U betterdraw betterdraw
```

## Backups and updates

With SQLite, stop the container and copy the `data` volume: database, images and secret. With
Postgres, use `pg_dump` and back up the image folder or bucket. Only one server may use a given
database at a time: a second one refuses to start. Restarting is safe: open canvases are written to the
database first, and browsers reconnect by themselves.

To update, pull the new code and rebuild the container: `git pull`, then the same `docker compose … up -d`
with `--build`. The database schema is upgraded automatically at start, so back up before a major update.

## Health and monitoring

`/healthz` answers `{"ok":true}` when the server and its database work; the Docker health check uses it.
Set `METRICS_TOKEN` to read counters (open canvases, connections, changes, failed writes) at `/metrics`.

## Administration and legal pages

Admins open `/admin`: visitors, sign-ups, retention, shapes drawn and agent use over the last 7, 30 or
90 days, any dates or all time, every account with its devices and canvases, who is on which canvas right
now, every canvas, to take one down or delete it, and the feedback people send from the app. An admin can
open any canvas read-only without appearing on it, to moderate; each such view is recorded. Make an
account admin in the database: `update "user" set "isAdmin" = true where email = 'you@example.com';`
(SQLite: `= 1`).

To show legal pages, put your own `notice.html`, `privacy.html` and `terms.html` in a folder and set
`LEGAL_DIR`: they are served at `/legal/…` and linked in Settings.

## Troubleshooting

- **"Port 3000 is already in use"**: pick another with `PORT`.
- **"Another server is already using this database"**: stop the other process, or delete the
  `betterdraw.db.lock` file it names if it is not running.
- **Login emails never arrive**: check the server output, spam, and the SPF and DKIM
  records your provider asks for.
- **Sign-in fails behind a proxy**: `BASE_URL` must match the address in the browser, including
  `https`.
