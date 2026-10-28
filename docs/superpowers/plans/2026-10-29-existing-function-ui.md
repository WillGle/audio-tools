# Existing-function UI implementation plan

Approved scope: expose album analysis, on-demand fingerprint information and
matching single/multiple-track tag choices within the existing screens.

Use existing endpoints and Vietnamese UI conventions. Preserve inherited changes;
add no dependencies or maintained tests, and do not modify real music files.
Implement directly in the current checkout as requested.

- [x] Add a library album action with a filename-ordered preview, explicit selected
  scope, run/error states, album DR and transition results. Show partial coverage.
- [x] Add lazy fingerprint details to the track drawer, with errors/retry and
  protection against responses from a previously opened track.
- [x] Add classification-only tagging beside diagnostics + ReplayGain in the track
  drawer; retain the same labels as selection tagging and confirm the exact path.
- [x] Run syntax/whitespace checks, existing browser checks and disposable probes
  for real album/fingerprint APIs, failure states, tag scope and mobile layout.

Files: `static/index.html`, `static/app.js`, `static/style.css`. Existing backend
semantics stay in use: album analysis sorts by filename; its DR is the mean of
available positive track DR scores, and transitions describe measured boundaries.
Display these limits rather than claim master quality or album completeness.

Verification: the existing 18-workflow Chromium check passed with 25 batch rows
and no JavaScript errors. A disposable probe exercised the real album and
fingerprint APIs, classification-only tag writes and rollback, exact single-file
confirmations and cancellation. Diagnostics tagging returned the existing missing
rsgain error, which the UI displayed correctly; successful ReplayGain writing was
not verified on this machine. Simulated error/partial/late responses checked
recovery and stale-result protection. Mobile review corrected inherited footer
button sizing in the new tag menu, then a focused 390px layout probe passed.
No backend changes were needed. Syntax, unique HTML ID and whitespace checks passed.
Evidence: `/tmp/audio-function-ui-proof/` and
`/tmp/audio-function-ui-browser/browser-results.json`.
