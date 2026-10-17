# Hi-Res Vault Companion UI Redesign

## Goal

Give every visible screen in the Hi-Res Vault Companion a consistent, readable, and responsive visual system while preserving current workflows, data behavior, element IDs, and safety boundaries.

## Scope

The redesign covers the Library, Audio Lab, Vault Tiering, Duplicates, Navidrome, audio-player bar, spectrogram/audit modal, confirmation modal, and toast notifications.

It includes shared surface, typography, spacing, button, badge, input, table, status, focus, and responsive rules; tab-specific hierarchy and spacing; and replacement of redundant inline presentation styles with named classes where that improves consistency.

It does not change API contracts, JavaScript state transitions, audio analysis behavior, file operations, destructive-action confirmation requirements, or existing element IDs used by `static/app.js`.

## Design

Use one dark navy visual foundation with restrained cyan, emerald, amber, rose, and indigo status accents. Each tab follows the same rhythm: context banner, primary controls, status or summary, then the main data/evidence surface. Cards, tables, forms, and overlays share the same border, radius, focus, and spacing tokens.

The Library remains the densest screen. The Audio Lab emphasizes a clear setup-to-result sequence and evidence cards. Vault and Duplicates make action scope, rollback, keep/archive decisions, and status more prominent. Navidrome separates connection state from tagging actions. Mobile layouts stack controls, preserve table scrolling, and keep destructive buttons visually distinct.

## Constraints

- Preserve all existing IDs and `data-*` hooks consumed by `static/app.js`.
- Do not add product dependencies.
- Keep destructive actions behind their current confirmation or rollback flows.
- Keep Vietnamese product copy unless a wording change is needed to clarify an existing action.
- Preserve unrelated working-tree changes.

## Verification

Run `git diff --check`, Python compilation, the focused audio scoring tests, and an HTML parse check. Start the app for a route smoke check when the sandbox permits local binding.
