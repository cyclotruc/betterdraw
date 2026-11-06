# Vision

betterdraw is a whiteboard for people and their agents, built on a fork of the Excalidraw editor.

- **The server is the source of truth.** Every canvas lives on a server, never only in a browser tab.
- **Multiplayer from the first stroke.** Every canvas is a live room. Sharing is sending the URL, and
  the URL is the secret; the owner can make a canvas view-only or private.
- **Agents are collaborators.** They read and draw through an API and MCP, with the rights of the
  person they act for.
- **No friction.** Opening the app opens a canvas. No sign-up to draw, no lobby, no confirmation
  screens. Keeping canvases takes Google, or an email link and a password.
- **Small enough to host anywhere.** One container, database included. The code stays
  short: a feature that needs more moving parts waits.

Everything needed to host betterdraw is in this repository, under the MIT license. The hosted version at
https://betterdraw.dev runs this code, plus a private layer of its own, such as its landing page.
