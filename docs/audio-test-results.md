# Audio scoring validation results

## Library reliability validation — 2026-10-29

The existing Python suite passed **31/31** in 64.73 seconds after the archive
and scan recovery changes. The existing Chromium workflow passed all 18 checks
with 25 batch rows and no JavaScript errors. These runs used disposable generated
audio and caches; the real music vault was not modified. Python/API/Chromium runs
used execution outside the managed sandbox because of its thread-wakeup behavior.

Additional temporary probes (not new maintained tests) checked integrity-first
ordering; all three persistent review decisions and undo; changed-group reopening;
vault-specific duplicate caches; configured tag backup location; arbitrary-file
and last-copy archive rejection; archive/restore, destination conflicts, repeated
undo, interrupted journal intents and interrupted hard-link moves. Original and
archive symlink replacements, including parent-directory aliases, were rejected
while preserving audio and the recovery journal.

Recovery probes verified restart/interruption handling, skipping unchanged
successful files, rescanning changed files, retrying only failed files, retaining
original history and the resume API. A four-worker cancellation after committed
progress exited promptly, retained completed rows and released the SQLite writer.
New Chromium controls were exercised for resume/retry, evidence before score,
review persistence across reload, decision undo, byte archive/restore and disabled
non-byte archiving. At 390px there was no document overflow or JavaScript error.

Limits: this does not validate large-vault throughput, arbitrary external file
changes during an operation, power-loss durability or cross-browser behavior.
Archive operations require same-filesystem hard-link support and fail without
removing the source when that support is unavailable.

Measured locally on 2026-10-16, Linux x86_64, Python 3.14, NumPy 2.5.4,
FFmpeg/ffprobe 8.0, FLAC 1.5.0, optional flaccheck 0.1.2. Rules: 1.0.0.
These results verify implementation behavior on generated signals. They do
**not** establish real-world music provenance accuracy or production certification.

## Automated regressions

`python -m pytest -q`: **31 passed**, 61.39 seconds after debloat, without optional
flaccheck. The earlier integration run also passed **31 tests** in 69.44 seconds
with the pinned flaccheck release in PATH. The DEEP calibration below was rerun
with flaccheck after cleanup.

Coverage includes actual decoding, exact per-channel padding, a single nonzero
low-bit counterexample, dither, silence/very-low-level abstention, opposite-polarity
channels, native Hi-Res and legitimate low-pass controls, MP3/AAC transcodes,
mixed-source audio, suspected upsampling, full-scale plateaus, NaN/Inf, floating
headroom and near-rail values, corruption, missing MD5, claims/reference/FAST,
Unicode paths, queue persistence/cache invalidation, cancellation, runtime/output
limits, symlink traversal rejection, API exports and legacy audit fallback.

Independent review found two regressions, both reproduced before repair and now
covered: metadata-only truncated FLAC must remain a critical integrity failure;
DSD must be grouped before high-rate PCM, including extension fallback. A
confirmed FLAC failure also survives an independent decoder allocation error.
Unknown MP3 bit depth cannot create a fictitious user-claim mismatch.
The DSD grouping test exercises application logic; it is not a real DSD recording
or DSD provenance validation.

The managed execution sandbox exhibited an AnyIO thread-wakeup hang even in a
minimal standalone reproduction. API/full-suite and Chromium validation ran
outside that sandbox against disposable caches and synthetic vaults. No real
music library was modified or used as calibration data.

## Reproducible fixtures and calibration

[`tests/audio_fixtures.py`](../tests/audio_fixtures.py) uses seed 20261016 and
actual FFmpeg encoders/decoders. It creates 22 labeled analysis fixtures, generally
four seconds long (the mixed-source fixture concatenates two sections). All
samples are self-generated. Intermediate MP3/AAC files are also present for scans.
AAC encoding was available in this environment. No copyrighted reference music
is distributed.

[`examples/calibration.json`](examples/calibration.json) contains all measured
rows. Its DEEP run used optional flaccheck; per-file runtime ranged from 1.2908
to 2.0478 seconds, median 1.4675 seconds. Cache was not used in this calibration.

| Fixture / actual JSON | Observed result | Score / coverage |
|---|---|---|
| [Valid 16-bit/44.1 kHz](examples/valid_cd.json) | Full decode, FLAC checksum verified; source history INCONCLUSIVE | 100 / 61.54% |
| [16-bit padded to 24-bit](examples/padded_24.json) | All eight low bits zero in both channels; exact padding deduction | 78.2 / 68.75% |
| [44.1 → 96 kHz](examples/upsampled_96000.json) | Spectral bandwidth REVIEW; suspected source rate null | N/A / 55% |
| [MP3 128 kbps → FLAC](examples/mp3_128k.json) | Source-history REVIEW, no unsupported codec/bitrate claim or penalty | 100 / 68.75% |
| [Truncated FLAC](examples/truncated.json) | Critical integrity FAIL independently displayed | N/A / 46.15% |
| [Legitimate 20 kHz low-pass](examples/legitimate_lowpass.json) | Spectral REVIEW, no transcode accusation/deduction | 100 / 61.54% |

A score of 100 on the measured subset does not resolve lossy history. Coverage
and REVIEW must accompany it. The 192 kHz upsample fixture also yields N/A/55%.
Dither prevents an exact-padding finding but cannot restore or prove source
resolution. The clipped fixture scores 87.5; DC offset is REVIEW without a penalty.
All nine labeled lossless controls avoid automatic source-history accusations
and associated deductions. This does not imply all nine were positively verified
as original lossless sources.

| Decision policy, 4 lossy positives / 9 lossless controls | TP | FP | Missed positives | Precision | Recall |
|---|---:|---:|---:|---:|---:|
| Automatic lossy accusation (SUSPECT/FAIL) | 0 | 0 | 4 including abstentions | N/A | 0% |
| REVIEW screening, including optional flaccheck | 4 | 3 | 0 | 57.14% | 100% |
| Raw flaccheck TRANSCODED/SUSPICIOUS labels | 3 | 3 | 1 | 50% | 75% |

Automatic source-history abstention is **100%**: four positive and nine negative
cases abstain, with zero definitive true-negative source-history decisions.
Operational recall above counts abstained positives as misses; REVIEW is a
request for inspection, not a positive fraud classification. The three REVIEW
false positives are the two intentionally low-pass lossless controls and the
wideband synthetic Hi-Res control. flaccheck misses the mixed-source fixture.
Without optional flaccheck, both low-pass controls still trigger spectral REVIEW.
These small, synthetic sets cannot justify published accuracy claims. Lossy and
sample-rate penalties remain disabled pending independently labeled real-music
validation across distinct detector families.

## Runtime and memory

[`examples/performance.json`](examples/performance.json) measures BALANCED native
96 kHz stereo FLAC in a fresh interpreter for each duration, with optional
flaccheck disabled. Full decode, FLAC verification and EBU R128 all completed.

| Audio duration | Engine wall time | Python peak RSS | Largest individual child peak RSS |
|---|---:|---:|---:|
| 4 seconds | 2.3720 seconds | 51.02 MiB | 79.95 MiB |
| 120 seconds | 4.8328 seconds | 51.65 MiB | 79.92 MiB |

RSS uses Linux `getrusage`; the child column is not summed simultaneous memory.
The near-constant values support bounded streaming for these inputs only.
Calibration-process RSS includes fixture generation and must not be confused
with isolated engine RSS. No thousand-file, six-hour or maximum-concurrency soak
was performed; disk speed, channels, rates and optional tools affect performance.

## Dashboard checks

The real Chromium smoke run uses Playwright 1.58.0 and system Chromium 149,
a disposable uvicorn server, cache and generated vault. It exercises single-file
padding analysis, supplementary audit, recursive scanning, comparison selection,
critical warning with N/A, JSON export, FFmpeg spectrogram, streaming, live track
listing, keyboard search, clearing stale selections, expandable measurements,
invalid-folder retry, cancellation, history restoration and scanning selected
library tracks. The 390px viewport check asserts no document-level horizontal
overflow. See
[`examples/browser-results.json`](examples/browser-results.json) for actual counts
and JavaScript errors. Mobile rendering is a smoke check, not a full responsive-layout
or accessibility certification. Screenshots are produced in the chosen temporary
output directory.

Metadata organization was also checked in Chromium against four disposable FLACs:
one tagged file under three nested folders, one missing its title, and two sharing
a destination. The preview produced 1 READY, 1 REVIEW and 2 CONFLICT rows. Applying
and rolling back the single READY file preserved its complete bytes, including
tags. Thirteen checks covered preview, grouping, Unicode paths, move/rollback,
separate rollback journals, stale plans, changed sources, traversal/symlink escape
rejection and a 390px viewport with no document overflow; no JavaScript errors.
These checks cover the FLAC workflow, not metadata compatibility for every codec
or simultaneous changes made by another application during a move.
The redesigned preview was additionally exercised with 23 long-tag/path fixtures
(27 files total): 20-item pages, next/previous, group-filter page reset, explicit
all-pages apply count, and wrapping without horizontal overflow at desktop and
390px widths. No moves were applied to the long-name fixtures.

Editable filename formats were checked in Chromium with disposable FLACs:
changing the format invalidates the previous preview; `{artist} - {title}` is
used for the actual move and rollback preserves the original bytes. Invalid
tokens, attribute access, format modifiers, missing `{title}` and path separators
return HTTP 400. The preview highlights changed filename text, separates folders
from filenames and distinguishes rename from folder-only moves. Unicode and
underscores are preserved; the 390px check found no horizontal overflow or
JavaScript errors. Direct fixture checks also covered missing track numbers and
automatic versus explicit disc prefixes. The existing Python suite passed
31 tests in 64.80 seconds after these changes.

The compact comparison table was subsequently checked in Chromium with 1,006
disposable FLACs (1,000 short generated files plus six workflow fixtures).
Checks covered 50-row pagination, page reset on search, old/new-name and metadata
search, rename/folder-only filters, combined status filters, empty results,
expandable details, a scrolling table with sticky headers, and the unchanged
all-READY apply count while filtering. Rename/rollback and the existing stale-plan
and path checks also passed. At 1440, 1024, 768 and 390px there was no document or
table horizontal overflow; no JavaScript errors occurred. This validates preview
interaction at that size, not batch-move throughput or a full-library soak test.

After removing pagination, the 1,006-file Chromium check was repeated: all rows
were present and the last row was reachable by scrolling inside the bounded
table. Old/new folders were visible below the corresponding filenames with
details closed. Search and combined filters, empty results, scroll reset after
filtering, apply/rollback and path protections passed again, with no JavaScript
errors or horizontal overflow at the checked desktop/mobile widths. Metadata
details remain expandable; the all-READY apply count remains independent of filters.

Inline filename editing was checked in Chromium on disposable FLACs. Save/cancel,
Unicode edits, persisted preview revision, stale-plan rejection, invalid filenames,
path separators, changed extensions and overlong UTF-8 names were exercised.
Editing one duplicate recalculated both conflicting rows; editing back into a
collision and targeting an existing file were blocked from application. Applying
three edited proposals and rolling back preserved their complete bytes/tags.
The editor fit the 390px viewport. The 1,006-file continuous-list check was also
repeated successfully; both browser runs reported no JavaScript errors. These
edits affect proposed filenames only, not the metadata that generated them.
The existing Python suite passed 31 tests in 61.43 seconds after this backend change.

Warning presentation was checked with saved real analysis JSONs for valid CD,
padded 24-bit, truncated FLAC and suspected upsampling. Additional display-only
inputs exercised 90/89, 75/74, 50/49, 0, N/A and the 60%/80% coverage boundaries,
customized score thresholds, and FAIL/REVIEW priority over favorable scores.
Chromium verified distinct badge colors, an amber 100-point limited-coverage
result, red critical N/A, and no mobile document overflow or JavaScript errors.
These boundary inputs test presentation, not detector accuracy. The existing
18-workflow browser check also passed with 25 real batch results and no
JavaScript errors.

Column sorting was checked against 122 disposable stored rows based on the saved
analysis JSONs, with errors beyond the initial 50 rows. All four columns sorted
globally in both directions; numeric N/A stayed last, ties remained stable and
loading the next page preserved order. Chromium checked header arrows/aria-sort,
keyboard activation, details after sorting, and desktop/mobile overflow with no
JavaScript errors. Invalid sort columns returned 422, and JSON export kept its
original sequence. The six existing job/API tests passed in 16.52 seconds.

Shared layout checks covered all six tabs, the track modal, supplementary
diagnostics and duplicate-name groups at 1440, 1024, 768 and 390px, plus mobile
playback/batch actions and a long confirmation message (30 views). With generated
long metadata and paths, the browser reported no JavaScript errors, document
overflow or unexpected text overflow in the checked views. Wide tables and the
navigation have intentional scroll regions. This is a Chromium layout smoke
check, not an accessibility or cross-browser certification.

## Re-run

From the repository root, with development dependencies and system tools:

```bash
uv run pytest -q
uv run python -m tests.calibrate_audio /tmp/audio-fixtures /tmp/audio-results
uv run --extra browser python tests/browser_audio.py /tmp/audio-fixtures /tmp/audio-browser
uv run python -m tests.performance_audio /tmp/audio-performance
```

Add the verified flaccheck 0.1.2 binary to PATH to reproduce the optional-detector
column. JSON examples include hashes, actual timestamp, engine digest, detector
versions and configuration. They are saved measurements, never runtime detector
inputs. Fixture generator and performance commands are intended for dedicated
temporary directories and recreate their generated files there.

Remaining validation boundaries: real-world provenance labels, short mixed-source
segments outside sampled windows, validated independent MDCT/pre-echo/resampling
signatures, Windows/macOS runtime behavior, external-reference trust, real DSD
recordings, very large library stress and crash/disk-full recovery. Unfinished
jobs are explicitly INTERRUPTED after restart rather than automatically resumed.

## Debloat pass

Removed 114 net Python lines: unused legacy DSP/wrappers, duplicate loudness
parsing, unused block-peak buffers and redundant metadata subprocesses. A real
full audit now uses one metadata probe and emits the authenticity report once:
22,419 bytes versus 42,111 bytes if the same report were duplicated in spectrum.
The six complete analysis snapshots use compact JSON; no measurements or evidence
fields were removed (approximately 56% smaller across example reports).

Removed unused dr14meter. Playwright and its dependencies are opt-in through the
`browser` extra; they are not required for the app or Python regressions.
Experimental flaccheck runs only in DEEP. Queue, cache, cancellation, subprocess
limits, fixtures, evidence, reference comparison and existing dashboard remain.
