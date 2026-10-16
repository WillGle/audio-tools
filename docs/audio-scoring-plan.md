# Audio scoring integration plan

Goal: locally audit advertised technical consistency with reproducible evidence,
without asserting master provenance or equating resolution with listening quality.
The user task is the specification; implementation proceeds inline as requested.

Architecture: preserve FastAPI, NumPy and the existing dashboard. Add a separate
typed scoring package, read-only subprocess adapters, streaming PCM measurements,
and a persistent SQLite cache/job queue. Keep ReplayGain, gapless, playback and
DSD diagnostics outside scoring. Retire unsupported legacy provenance verdicts.

1. Inspect upstream licenses, implementations, releases and JSON interfaces before
   DSP work. Prefer FFmpeg/ffprobe, official FLAC and an optional pinned flaccheck
   subprocess; experimental third-party results cannot deduct score.
2. Add reproducible synthetic fixtures and failing regressions for exact padding,
   false-positive controls, corruption, coverage, claims and cancellation.
3. Implement versioned rules and typed evidence. Decode without resampling or
   mixing channels; bound buffers, runtime, channels, sample rate and workers.
   Full FLAC verification is separate; FAST remains preliminary.
4. Add content-hash/version/config/claim/reference keyed persistent cache and
   bounded background jobs, cancellation, incremental results and JSON/CSV export.
5. Integrate Vietnamese evidence cards, library comparison, claims and reference
   input, and measured time-frequency visualization into the existing Lab.
6. Run generated-audio, API, queue and frontend checks; save actual JSON examples,
   calibration metrics and limitations in the three requested documents.

Review focus: silence is not padding; opposite channels must not cancel during
analysis; absent checksums and optional tools are unknown, not corruption;
symlinks cannot escape the vault; changing bytes/config/reference invalidates cache;
cutoff evidence never establishes a codec, bitrate, native DSD or native Hi-Res.

Progress: implementation and independent review fixes complete; 31 regressions
pass. Real Chromium, generated-fixture calibration and fresh-process performance
checks have run. See audio-test-results.md for measured results and acceptance
limits: source-history detectors remain experimental and cannot certify provenance.
The initial worktree was clean; no source music, commit or push was changed.
