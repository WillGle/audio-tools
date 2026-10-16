# Dependencies and detector review

Review date: 2026-10-16. Analysis is local; no file, hash or fingerprint is sent
out. Upstream labels and benchmark claims are not calibration evidence here.
The repository has no declared distribution license. No third-party GPL source
has been copied or linked into the new engine. Redistribution of the application
or bundled binaries still needs a deliberate project-license review.

| Candidate | License / compatibility | Maintenance and platform evidence | Interface, method and library-scale decision |
|---|---|---|---|
| [FFmpeg / ffprobe](https://ffmpeg.org/) | Primarily LGPL-2.1-or-later; enabling GPL/version3 changes binary license. The installed 8.0 build has `--enable-gpl --enable-version3`. Invoked as a separate executable, not linked or bundled. | Active upstream (GitHub push 2026-10-16). Linux/macOS/Windows; tested here with 8.0. | Selected. ffprobe JSON, streaming native-rate/channel PCM, `ebur128=peak=true` for EBU R128 / BS.1770 LUFS, LRA and true peak. Full decoding, bounded IO and single decoder/filter threads. These measurements establish signal properties, not source provenance. |
| [Official FLAC](https://xiph.org/flac/) | libFLAC BSD; CLI `flac` GPL-2.0-or-later. Separate subprocess, not source integration. | Latest release verified: 1.5.0, 2025-02-11; tested 1.5.0. Linux/macOS/Windows. | Selected `flac --test --silent`. Streaming frame/CRC and STREAMINFO MD5 checks. Exit code plus bounded stderr; no stable JSON, so do not parse human output into speculative error counts. Missing/zero MD5 is explicitly unverified, not failed. MD5 is self-contained integrity, not a trusted reference checksum. |
| [flaccheck](https://github.com/dasunNimantha/flaccheck) | MIT. Optional external CLI; no upstream source copied. Dependencies include Rust, Symphonia (MPL-2.0), rustfft, serde; optional ML/web dependencies are unnecessary. | Latest published release v0.1.2, 2026-07-04. Repository push 2026-10-15. Reviewed source checkout `f9b011ce80512d8e23f106e0abd28b8d3f8580ce` (2026-08-19). Release binaries Linux x86_64/aarch64, macOS x86_64/aarch64 and Windows x86_64. | Selected only as **experimental evidence**. `flaccheck scan FILE --format json --quiet --explain --workers 1 --mode balanced|max`. Actual schema: `{results: [...], skipped: [...], errors: [...]}`. Spectral/Hi-Res rules, artifact features and quantization heuristics; several features share the same spectral family. Full-file PCM allocation means bounded input estimation and process memory limits are required. Unknown versions, oversized input, unsupported formats or missing tool abstain. No score penalties. |
| [audio-integrity-toolkit](https://github.com/hycccc/audio-integrity-toolkit) | MIT; Python ≥3.10; NumPy/SciPy/libsndfile via soundfile. | v0.3.0, 2026-08-19; reviewed `569b9bdf408b402baed29f1dc24c2add8f72a057`. Seven commits at review. Python portability depends on soundfile/libsndfile packages. | Rejected for verdicts. CLI JSONL and Python API exist. Reads entire file, downmixes channels, Welch cutoff with relative −80 dB floor. Its codec/bitrate mapping and “genuinely full-band” claim are not justified by a cutoff. Clipping threshold ≥0.999 is not proof of clipping. Would duplicate existing dependencies/measurements and introduce avoidable false accusations. |
| [SoX](https://sourceforge.net/projects/sox/) | CLI GPL-2.0-or-later, libSoX LGPL-2.1-or-later; codec dependencies can vary. | Last stable 14.4.2 (2015); development/package maintenance varies. Linux/macOS/Windows. Not installed in this environment. | Evaluated, not required. `sox FILE -n stat`, `stats`, `spectrogram` give useful measurements/image output, but no forensic provenance oracle or unified JSON. FFmpeg already supplies decoding, loudness and visualization, avoiding another executable and repeat decodes. |
| [Spek](https://github.com/alexkay/spek) | GPL-3.0-or-later. No code integration. | Latest release v0.8.5, Jan 2023; repository push 2024-07-28. C++/wxWidgets/FFmpeg; Linux/BSD/macOS/Windows. | Optional manual review only. GUI spectral image viewer, no supported structured forensic verdict API. Unsuitable as a headless batch backend. A visible cutoff has the same ambiguity as the automated PSD screening. |
| [Chromaprint](https://github.com/acoustid/chromaprint) | LGPL-2.1-or-later with FFT-backend exceptions/dependency licenses; FFTW builds can introduce GPL obligations. Inspect chosen build's license. | Latest v1.6.2, 2026-10-15; active upstream. C/C++, FFT backend and FFmpeg for fpcalc; Linux/macOS/Windows. | Existing `fpcalc -json -raw` functionality retained outside score. Perceptual fingerprints help group recordings, but do not prove PCM identity or source authenticity. The new reference comparison uses full decoded PCM SHA-256 instead, without fingerprint service lookups. |

The alternatives listed in flaccheck's comparison (audiocheckr, isflac, FLAC
Detective, soundaudit, legacy auCDtect) were screened through that comparison,
not independently benchmarked or license-approved. No better maintained,
independently validated codec-history oracle was established. They are not
runtime dependencies. In particular, an upstream self-reported benchmark is
not a reason to enable score deductions.

## flaccheck validation and pin

Validated the v0.1.2 Linux x86_64 release on this project's own generated fixtures.
Release asset:
`flaccheck-0.1.2-x86_64-unknown-linux-gnu`.
SHA-256 (matched GitHub release asset digest):
`cc843029168f6b021d307d34e1f8d08345a38254514f4963d481d551a695ef0a`.
The temporary test binary is not committed, installed globally or bundled.
Put a verified binary named `flaccheck` in the application's PATH to enable it.
Only version 0.1.2 is accepted by the initial adapter. Other OS assets need their
own digest verification and runtime tests.

It incorrectly labels both the legitimate 16 kHz low-pass control and the
legitimate 20 kHz low-pass control `TRANSCODED`, labels synthetic wideband Hi-Res
`SUSPICIOUS`, and misses the mixed-source fixture (`GENUINE`). This is why the
adapter never maps `GENUINE` to PASS, discards codec/bitrate/native-Hi-Res guesses,
and never applies a transcode/upsampling penalty. Evidence remains visible for
review. See [test results](audio-test-results.md), including all false positives
and abstentions. The quantization and artifact families are not considered
independently validated corroboration yet.

## New and existing Python dependencies

No new audio runtime package is required. NumPy performs exact integer-bit
reductions, streaming statistics and explicitly experimental windowed PSD;
Pydantic validates expectations and rule outputs; Python's sqlite3 stores jobs
and results. Existing FastAPI, Mutagen and MediaFile remain. The old unbounded
DR decode path was replaced with a named streaming DR estimate; the unused
dr14meter dependency has been removed. The estimator does not claim an official
TT DR result. Playwright **1.58.0** is only installed with the optional `browser`
extra, using system Chromium. `uv.lock` pins the resolved environment. Optional
flaccheck runs only in DEEP; BALANCED avoids its full-file memory allocation.

Sources: [FFmpeg legal](https://ffmpeg.org/legal.html),
[FLAC license](https://xiph.org/flac/license.html),
[FLAC releases](https://github.com/xiph/flac/releases),
[flaccheck releases](https://github.com/dasunNimantha/flaccheck/releases),
[toolkit source](https://github.com/hycccc/audio-integrity-toolkit/blob/main/src/audio_integrity/analysis.py),
[SoX](https://sourceforge.net/projects/sox/),
[Spek](https://github.com/alexkay/spek),
[Chromaprint license](https://github.com/acoustid/chromaprint/blob/master/LICENSE.md).
GitHub API release/repository metadata was fetched live during this review;
release dates above are observed metadata, not an assumption about future support.
