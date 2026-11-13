# Third-party source allowlist

Only these reviewed third-party files are included in this package:

- `backend/vendor/marked.umd.js`, `marked.esm.js`, `marked-LICENSE.md`:
  Marked, MIT. Preserve the included copyright and permission notice.
- `backend/vendor/pdfjs/loader.mjs`, `pdf.mjs`, `pdf.worker.mjs`,
  `binary-assets.mjs`, `compat.mjs`, `SOURCE.md`, `LICENSE.txt`:
  the pinned PDF.js build and thin local wrappers. Exact provenance and the
  original combined Apache/MIT/other bundled notices are preserved in SOURCE.md
  and LICENSE.txt; preserve both when redistributing these files.

This is not permission to include the complete DSH frontend, desktop Claude CLI,
App bundles, runtime credentials or unrelated generated assets. The optional
`bin/claude` location is local-only; normal CLI discovery uses the installed App
or `CLM_CLAUDE_BIN`.
