# Visual review harness

Start Vite on an isolated origin (`npm run dev -- --port 5175`) and open `/tests/ui/`. The harness refuses to seed an existing score database. Use a fresh origin or a fresh browser profile for each run.

Fixtures exercise work grouping, edition comparison, metadata editing, settings, light/dark themes, curated accents, density, composer-name formats, and keyboard focus. Native IPC is mocked. Actual IMSLP networking, parsing, and filesystem operations have separate Rust tests.

`score-preview.png` is the public-domain IMSLP first-page preview for `PMLP1471-420.pdf`, retrieved October 20, 2026 from https://cdn.imslp.org/images/thumb/pdfs/72/097e974a8ae09ff66b2f11e5cef07d41aef02a56.png.

## Live native thumbnail decoding

Run the ignored `live_diverse_works_and_decoded_images` Rust test with `SONORA_IMSLP_REVIEW_OUTPUT` set to an output JSON path. Copy that output to `tests/ui/live-imslp.local.json`, then visit `/tests/ui/live-thumbnails.html` on the review server. The page feeds the actual captured native data URLs through `ImslpThumbnail` and the persistent cache. Verify that each image's `naturalWidth` and `naturalHeight` are nonzero. The generated `.local.json` file is temporary and excluded from Git.
