# Navidrome Companion Implementation Plan

> Execute inline using superpowers:executing-plans. User approved all and explicitly requested immediate implementation; no additional design approval round. Keep changes in the shared checkout; do not commit or add test files.

**Goal:** Deliver the approved simpler, lightweight library companion.
**Architecture:** Preserve current tool DOM hooks and handlers; simplify the shell, add focused tools navigation and lightweight track details. Centralize saved connection resolution and post-mutation scanning in the existing backend.
**Tech Stack:** FastAPI, static HTML/CSS, vanilla JavaScript.
**Spec:** docs/superpowers/specs/2026-10-17-navidrome-companion.md

## Constraints
Preserve existing features, Vietnamese copy, confirmations, backups and path boundaries. No dependencies or new tests. Use disposable fixtures for checks.

## Review focus
Unconfigured/disconnected Navidrome; partial file-operation success; one scan per batch; credentials never in browser persistence or URLs; keyboard/mobile details and navigation; expensive work only when requested; cached listing invalidation.

### Task 1: Connection and library runtime
- [x] Add private server-side connection config and password-free status API; POST scan status.
- [x] Route successful/partial mutations through one scan request and preserve local results on scan failure.
- [x] Cache listings with explicit refresh and mutation invalidation.
- [x] Verify with existing Python suite and disposable mocked integration checks.

### Task 2: Navigation and workflows
- [x] Three top-level destinations and a focused four-tool chooser/back navigation.
- [x] Compact filters/table, selection actions, track side panel with lazy diagnostics.
- [x] Explicit connection setup, migration, scan monitoring/retry, full-scan option and batch scan handling.
- [x] Preserve tool functions and plain, evidence-bounded wording.

### Task 3: Presentation and verification
- [x] Neutral system-font surfaces; desktop/mobile navigation, readable tables and non-overlapping player/actions.
- [x] Run existing Python/browser checks and disposable navigation/integration checks, inspect screenshots.
- [x] Review final diff and record validation and remaining live-provider limitation.

## Validation

- Existing Python suite: 31 passed (53.49s), with disposable music/cache paths. Sandboxed async runs stalled and were stopped; the successful run used normal process permissions.
- Existing browser workflow: 18 checks passed, 25 batch rows, no page errors. Only its navigation and advanced-mode selectors changed.
- Disposable browser/mock Navidrome checks: three destinations, four tools, lazy diagnostics, drawer focus/confirmation/escape, private server config, organization/undo each requesting one scan, cache invalidation, offline local completion/retry, full scan, mobile layout and persisted connection. Screenshots and results: `/tmp/audio-redesign-validation/`.
- Disposable API checks: single/batch/deferred scan counts, partial success, offline scan failure preserving local results, blank-password retention, config permissions, POST-only status, listing reuse/refresh, disconnect.
- JavaScript syntax, Python compilation, HTML parsing/unique IDs and `git diff --check` passed.
- Independent review found drawer confirmation layering/keyboard priority and an unsaved-settings fallback; both corrected and exercised by disposable checks.
- No new test files or runtime dependencies. Live Navidrome and the running user app were not restarted or modified. Concurrent `cache/hires_verdicts.json` changes were left untouched.
