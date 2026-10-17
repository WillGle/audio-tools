# Navidrome companion redesign

Approved in conversation: three destinations (Kho nhạc, Công cụ, Cài đặt), a compact library with track details, consistent choose/review/apply tool workflows, automatic Navidrome updates, and lightweight presentation/runtime. This supersedes the cosmetic-only all-ui-redesign spec for this work.

Retain all existing analysis, export/history/cancellation, playback/A-B, metadata organization/edit/undo, duplicate/archive, tagging/backups/undo, tiering modes/rollback and smart-playlist functions. Keep Vietnamese product text, confirmations and filesystem boundaries. No new runtime dependencies or test files. Do not operate on the user's music during verification.

Library is the default. Tools has four choices with contextual back navigation. Settings contains music-root information and Navidrome configuration/playlists. Track details open in a keyboard-accessible side panel; expensive diagnostics run only on request. Primary library columns are title, artist, album and status, with optional detailed columns.

Persist Navidrome credentials only in a server-side owner-readable config file in the cache directory; never return the password. Existing browser configuration migrates once. Saved connection changes are explicit. Both apps must access the same underlying music. Each completed mutation batch requests at most one scan; report local completion separately from scan status, retain retry on failure, and bound active-only polling. Full scan is an explicit manual option. Do not claim remote per-track synchronization from global scan completion.

Reuse a short-lived, locked library listing keyed by root/cache evidence, invalidate after mutations, and provide explicit refresh. Retain FastAPI/vanilla JavaScript. Use system fonts, neutral solid surfaces, one accent, no decorative animation, three labeled mobile destinations, and scrollable tables without page overflow.

Verification: existing Python suite, JavaScript syntax, HTML IDs/parse, disposable browser checks on desktop/mobile and mock Navidrome integration. Live provider claims require actual live evidence.

## User refinement: scorer first

The user clarified that this is a music quality checker/scorer, rather than primarily a library companion. Chấm điểm is now the default and first navigation destination, followed by Kho nhạc, Công cụ and Cài đặt. The overview shows actual per-track technical score, coverage, confidence and evidence status; unmeasured values remain blank, FAST/insufficient evidence remains N/A, and integrity warnings remain independent of the score. A livelier midnight-blue/aqua palette and lightly tinted maintenance cards replace the muted charcoal theme. Core scoring rules and backend operations are unchanged.

## User refinement: dashboard and top navigation

This supersedes the navigation/default-screen choices above. The landing dashboard counts unique current files across saved analyses: hi-res format, suspected upsampling, lossy/technical failure, standard lossless, review and unchecked. Category buttons filter in place; measured rows open saved evidence without rescanning. Counts are mutually exclusive and stale results are excluded. Hi-res describes the container format, not verified source resolution; spectral boundaries remain suspected upsampling only. All primary functions are directly accessible in the top bar, including on mobile, with no tools gateway or back-navigation step. Analysis results persist per file across jobs and restarts.
