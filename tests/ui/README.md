# Visual review harness

Start Vite on an isolated origin (`npm run dev -- --port 5175`) and open `/tests/ui/`. The harness refuses to seed an existing score database. Use a fresh origin or a fresh browser profile for each run.

Fixtures exercise work grouping, edition comparison, metadata editing, settings, light/dark themes, curated accents, density, composer-name formats, and keyboard focus. Native IPC is mocked. Actual IMSLP networking, parsing, and filesystem operations have separate Rust tests.

`score-preview.png` is the public-domain IMSLP first-page preview for `PMLP1471-420.pdf`, retrieved October 20, 2026 from https://cdn.imslp.org/images/thumb/pdfs/72/097e974a8ae09ff66b2f11e5cef07d41aef02a56.png.

## Live native thumbnail decoding

Run the ignored `live_diverse_works_and_decoded_images` Rust test with `SONORA_IMSLP_REVIEW_OUTPUT` set to an output JSON path. Copy that output to `tests/ui/live-imslp.local.json`, then visit `/tests/ui/live-thumbnails.html` on the review server. The page feeds the actual captured native data URLs through `ImslpThumbnail` and the persistent cache. Verify that each image's `naturalWidth` and `naturalHeight` are nonzero. The generated `.local.json` file is temporary and excluded from Git.

## Folder migration checks

Open `/tests/ui/folders-regression.html` on the review server. It uses a unique temporary database and checks the real v10-to-v12 upgrade, replacement of virtual groups with filesystem paths, preservation of PDF blobs, nested folders, score serialization, archive hierarchy remapping, and rejection of cyclic archive folders. It deletes only its own temporary database on completion.

The library now displays explicit folders and scores. Existing work metadata remains compatible with imports, but no longer determines folder membership after migration. Folders and scores share the 60-item library pagination budget.

Open `/tests/ui/folder-interactions.html` for automated browser UI checks. The fixture mocks native disk commands and verifies All Scores/Folders navigation, grid and list folders, selection without layout shifts, creating an empty folder without selection, dragging folders into folders, dragging rows onto the home breadcrumb to move them back to the root, and preserving score membership. Native filesystem operations (including sidecar preservation, cycles and collision handling) are covered by `cargo test --lib score_folders --offline`.
