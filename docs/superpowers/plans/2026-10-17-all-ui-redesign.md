# All UI Redesign Implementation Plan

Historical cosmetic-only scope; superseded for the approved overhaul by [Navidrome companion design](../specs/2026-10-17-navidrome-companion.md).
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Apply one consistent, responsive visual system to every existing Hi-Res Vault Companion screen without changing behavior.

**Architecture:** Keep the current single-page HTML/JS structure and element IDs. Consolidate visual treatment in `static/style.css`, add only small semantic classes to `static/index.html` where inline styles prevent consistency, and leave `static/app.js` unchanged.

**Tech Stack:** Static HTML, CSS, vanilla JavaScript, FastAPI-served assets.

**Spec:** `docs/superpowers/specs/2026-10-17-all-ui-redesign.md`

## Global Constraints

- Preserve all existing IDs and `data-*` hooks consumed by `static/app.js`.
- Do not add product dependencies.
- Keep destructive actions behind their current confirmation or rollback flows.
- Keep Vietnamese product copy unless clarification is necessary.
- Preserve unrelated working-tree changes.

## Review Focus

- Hidden and loading states must remain visually discoverable without changing their `hidden` or inline display hooks.
- Dense tables must retain horizontal scrolling and readable action columns at narrow widths.
- Destructive actions must remain visually distinct from safe navigation and preview actions.
- Focus-visible states must remain visible against every dark surface.
- Modal, player, toast, and batch surfaces must not cover primary controls on small screens.

### Task 1: Shared visual foundation

**Files:**
- Modify: `static/style.css`

- [ ] Normalize design tokens, surfaces, typography, spacing, buttons, badges, forms, tables, focus states, and breakpoints while preserving current selectors.
- [ ] Add shared rules for hidden/loading/status surfaces and responsive stacking.
- [ ] Run `git diff --check` and the focused existing test suite.

### Task 2: Tab-specific hierarchy

**Files:**
- Modify: `static/index.html`
- Modify: `static/style.css`

- [ ] Replace only redundant inline presentation with named classes where needed.
- [ ] Tune Library, Audio Lab, Vault, Duplicates, and Navidrome layouts to share the approved context-controls-status-content rhythm.
- [ ] Preserve every JavaScript-consumed ID and `data-*` hook.
- [ ] Parse HTML and run the focused existing test suite.

### Task 3: Shared overlays and final responsive pass

**Files:**
- Modify: `static/style.css`

- [ ] Normalize the audio player, spectrogram/audit modal, confirmation modal, toast stack, and floating batch bar.
- [ ] Verify narrow-screen overflow, focus states, and table scrolling with static inspection and an app startup smoke check where local binding permits.
- [ ] Run `git diff --check`, Python compilation, HTML parsing, and the focused existing test suite.
