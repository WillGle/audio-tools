# Library reliability improvements

Approved scope: the six recommendations accepted in the conversation on 2026-10-29.
Execute in this checkout, without adding maintained tests or dependencies.

Design: keep current FastAPI, SQLite and browser workflows. Archive only copies
revalidated as byte-identical, retain at least one original, journal moves before
execution and support conflict-safe undo. Metadata and filename matches remain
review candidates. Rank candidates by current integrity evidence first, explain
the recommendation, and keep format/naming preferences secondary. Persist review
decisions against vault, group membership and file stamps so changes reopen review.
Use one cache-directory resolver, preserving existing backup databases on migration.
Resume scans in a new job with the original options and only unfinished/stale files;
retry failures separately. Present integrity, format and source uncertainty before
the score without changing detector rules.

- [x] Unify cache paths in app, dedup, tagger and CLI; preserve old backups.
- [x] Add journaled, revalidated duplicate archiving and conflict-safe undo.
- [x] Replace naming-driven quality ranking with explained integrity-first ordering.
- [x] Add persistent keep-both/different-edition/ignore decisions and undo.
- [x] Add resume/retry API and browser controls, retaining original scan history.
- [x] Put evidence and uncertainty ahead of quality scores.
- [x] Run existing Python/browser checks and disposable probes; review the diff.

Verification: existing pytest suite, Python/JavaScript syntax, existing Chromium
workflow, and temporary probes for changed files, last-copy protection, interrupted
moves, restore conflicts, changed review groups, integrity ordering, configured
cache paths and interrupted/failed scans. Never run file mutations on the real vault.

Verification completed: existing pytest 31/31 (64.73s), existing Chromium 18 workflows / 25 rows, new disposable browser and safety/recovery probes passed. See docs/audio-test-results.md for evidence and limits. No maintained tests added.
