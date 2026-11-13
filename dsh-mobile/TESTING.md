# DSH Mobile tests and local frontend assets

`npm ci --ignore-scripts --workspaces=false` installs this package on its own.
`npm test` runs the complete suite serially. HTTP, credentials and WebSocket
integration tests use temporary state and an isolated mock upstream; they do not
need a desktop App and never start a second DSH host.

The public `frontend/manifest.json` records the fixed snapshot's release, resource
names and SHA-256 values. `frontend/index.html`, `frontend/public/` and
`frontend/bundles/` are reviewed local assets, ignored by Git. They are not
recaptured, downloaded or upgraded by install/start/test hooks.

When the complete snapshot is absent, the following existing tests are retained
and report explicit Node test SKIP reasons:

- Every case in `test/frontend.test.mjs`: pinned serving, hashes, boot whitelist,
  compression/cache behavior and PDF lazy-chunk integration.
- Every case in `test/session-restore.test.mjs`: extracted pinned workspace and
  conversation code, restoration state and served-profile hooks.
- Only `pinned sidebar patch covers restore, all layout actions and split
  controls; unknown builds fail closed` in `test/preview-single-pane.test.mjs`.
  Its independent single-pane state test still runs.

`DSHM_TEST_PINNED=0 npm test` explicitly selects this source-only CI mode.
`npm run test:pinned` requires the complete reviewed snapshot and fails clearly
if it is unavailable. Use this command for local release acceptance; missing or
partially copied assets must not be accepted as successful pinned validation.

Copy the already approved snapshot when migrating an existing installation.
Do not run `scripts/pin-frontend.mjs --replace` as part of migration or CI.
