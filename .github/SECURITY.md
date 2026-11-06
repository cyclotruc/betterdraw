# Security

## Reporting a vulnerability

Email [security@betterdraw.dev](mailto:security@betterdraw.dev). Do not open a public issue. You will get an
answer within a week, and credit in the release notes if you want it.

## Supported versions

Security fixes go into the latest release: pull the new code and rebuild the container
([docs/self-hosting.md](../docs/self-hosting.md) says how).

## How the app protects canvases

- A canvas address holds 128 random bits. By default anyone with the address can edit; owners can make
  a canvas view-only or private, which disconnects everyone else at once.
- The server's admins can open any canvas read-only without appearing on it, to moderate. Each such view
  is logged, with the admin and the canvas.
- Browsers must send writes and WebSocket connections from the app's own origin. Uploaded files are
  limited to image types and served with a sandboxing Content-Security-Policy.
- Login links are single-use, expire after 10 minutes, are stored hashed, and are rate limited per
  address and per IP. The link only signs in after a button press, so mail scanners cannot use it.
- Only the Better Auth endpoints the app needs are reachable from outside.
