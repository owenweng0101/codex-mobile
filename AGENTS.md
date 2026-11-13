# Unified mobile-chats maintenance

- This repository is the single source for Codex, DSH, Claude and the desktop QR updater. Keep the existing GitHub repository history.
- The user-facing entry is one `手机连接.png` in the desktop `手机连接` folder. Never restore separate QR fallback images or a second pairing-page server.
- The three iframe views still require their own adapters. Removing an obsolete entry page does not authorize removing a backend used by the unified entry.
- Preserve live desktop sessions, private Application Support state, tokens, uploads and terminal processes. Use the existing Codex update preflight before restarting its backend.
- DSH uses a reviewed, pinned local frontend and explicit mobile-module allowlist. Never recapture desktop assets during start, install, background updates or tests.
- Do not modify desktop application packages, signatures or session databases to adjust mobile presentation.
- A message must remain visible by default. Do not hide a person's input in a peer/activity disclosure to remove a disclaimer. Claude's native-user input integration remains incomplete.
- Keep the mobile input areas at their original empty height; long text scrolls inside. Preserve IME, drafts, attachments and send behavior.
- Do not publish generated upstream UI bundles, local plugins, QR images, runtime receipts, user conversation data or secrets. Keep third-party notices with redistributable libraries.
- Verify source and installed runtime separately. Publishing is complete only after the exact pushed SHA passes GitHub CI; physical-phone acceptance is a separate claim.
