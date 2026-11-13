# Claude Mobile maintenance

- Keep desktop-owned sessions, writer ownership and native unread state authoritative.
- Preserve operation IDs and durable delivery/read receipts; do not replay uncertain native actions.
- Do not rewrite native conversation history or replace native unread with a local mask.
- Default tests use temporary files, mock transports and injected native dependencies.
  They must not need or control a real desktop App, credentials or live sessions.
- Real Ego browser checks are opt-in, use a dedicated agent-owned Space and isolated
  fixture server, and must finish that Space without touching user-owned Spaces.
- Keep the reviewed mobile UI, navigation, media previews and fixed composer height.
- Do not run install/uninstall scripts, restart services or publish without authorization.
- Third-party files are an explicit allowlist documented in THIRD_PARTY.md;
  never commit desktop CLI binaries, local runtime state or credentials.
