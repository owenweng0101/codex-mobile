# Claude Mobile tests

Run `npm ci --ignore-scripts --workspaces=false`, then `npm test`.
The complete Node suite runs serially with temporary directories, mock HTTP/peer
servers and injected native implementations. No real desktop App or CLI is needed.

Four browser suites remain opt-in and report explicit skips by default:

- `CLAUDE_PREVIEW_BROWSER_TEST=1`: `test/media-preview.browser.test.mjs`.
- `CLAUDE_NAVIGATION_EGO=1`: browser case in `test/navigation-interactions.test.mjs`.
- `CLAUDE_COMPOSER_EGO=1`: browser case in `test/composer-fixed-height.test.mjs`.
- `CLAUDE_LIST_EGO_SPACE=<agent-owned Space name>`: browser case in
  `test/session-list-refresh.test.mjs`.

They require the Ego CLI and its own agent-controlled Space. All browser fixtures
serve synthetic local data. Default CI does not launch Ego or connect to native
sessions. Do not set these flags in generic CI.
