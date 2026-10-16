# Audio Authenticity & Quality Scoring Engine

The primary domain measures technical consistency with declared or user-entered
claims. It cannot identify an original master, certify native Hi-Res, infer an
MP3 bitrate from cutoff, or rank listening quality. Mastering diagnostics are a
separate domain. Nothing in a scoring scan edits, tags, normalizes, resamples,
moves or deletes source files.

## Reproducible evidence model

The versioned configuration is
[`core/audio_scoring/rules.v1.json`](../core/audio_scoring/rules.v1.json).
Initial category weights are integrity 20, metadata 10, lossy transcode 25,
bit depth 15, sample rate 20, technical defects 10. They are product heuristics,
not an audio standard. Rules return status, confidence, raw measurements,
evidence family/code, penalty in weighted points, contribution, explanation,
detector/version and limitations. Pydantic validates this evidence envelope.

For each applicable category with usable evidence:

`contribution = category_weight × (1 − configured_penalty_fraction)`

`coverage = assessed_weight / applicable_weight`

`score = 100 × sum(contributions) / assessed_weight`

NOT_APPLICABLE categories leave the applicable denominator. INCONCLUSIVE and
unresolved REVIEW categories stay in it, but contribute neither points nor
penalties until assessed. A REVIEW may be assessable for direct measurements
(e.g. DC offset without a configured penalty); spectral source-history REVIEW
is always unassessed. The initial numeric-score gate is coverage ≥60%; FAST
always suppresses a numeric score. Confidence concerns the scope of the evidence,
not the likelihood of genuine provenance; the aggregate is deliberately capped
at MEDIUM even at complete coverage. Critical integrity FAIL overrides the band
and suppresses a favorable score independently of numeric-score availability.

The dashboard colors scores and verdicts using the result's stored configuration:
90–100, 75–89, 50–74 and 0–49 are the initial score bands. Confirmed rule FAIL
or critical integrity failure takes red priority; SUSPECT takes orange; REVIEW
takes amber, including when no numeric score is available. Otherwise coverage
below the configured confidence threshold (initially 80%) produces an amber
scope warning even at 100 points. Unassessed results without such warnings are
gray. Green means no warning in the assessed scope, never verified provenance.
Coverage uses its own colors and the configured 60%/80% gates; insufficient
coverage does not establish a defective or fraudulent file. These are display
rules and do not alter measurements, penalties, score gates or cached results.

Example: declared CD PCM excludes the Hi-Res bit-depth and sample-rate rules.
A valid file may score 100 with 40/65 = 61.54% coverage; **25 weighted points of
lossy-source history remain unresolved**. This is not 100% authenticity. A lossy
transcode with a cutoff can also have 100 on the assessed subset while its source
history remains REVIEW. The UI displays coverage, the review flag and limitations
next to the score. Raise the coverage gate to 0.8 or 1.0 for workflows that should
withhold these numbers. With present detectors, many Hi-Res files correctly get
N/A rather than an invented certainty.

Bands are configurable: ≥90 no significant issue detected in assessed checks;
≥75 minor concerns; ≥50 suspicious/review; <50 significant mismatch/defects.
An unresolved review is appended to a numeric band. These are provisional and
not calibrated probabilities.

## What is measured and what can deduct points

| Rule | Actual evidence | Initial deductions / abstention |
|---|---|---|
| Integrity | ffprobe readability; full native decode; official `flac -t` frame/CRC/STREAMINFO MD5; decoded sample count versus FLAC total_samples | Confirmed decode/frame/MD5/count errors deduct 100% of category and are independently critical. Tool failures, resource limits and partial decode abstain. Missing/zero MD5 is not a mismatch. Full FFmpeg decode remains useful when optional FLAC verification is unavailable; checksum stays false/unverified. |
| Metadata | Actual demuxer/codec/header versus file extension and optional user expectations | Explicit claim mismatch: 100% of category; extension/header mismatch without external claims: 50%. Multiple audio streams flag REVIEW; only stream `a:0` is measured. No penalty simply for a correctly declared lossy codec. |
| Lossy history | Per-channel PSD sections, cutoff/transition measurements; optional pinned flaccheck evidence | **No penalties enabled.** Spectral observations are one correlated family. MDCT, pre-echo and other artifact evidence from flaccheck remains experimental pending independent real-music validation. A cutoff alone can only trigger REVIEW. No exact source codec/bitrate is asserted. Absence of artifacts is INCONCLUSIVE. |
| Bit depth | Exact signed integer native PCM reductions across every decoded sample/channel, low-bit utilization, active sample counts | Exact ≥8 zero low bits for 24-bit PCM (or corresponding ≤16-bit utilization in 32-bit PCM), enough active samples in every channel, RMS >−70 dBFS and complete error-free decoding: deduct 80% of category. Silence/very low level/partial decode/float precision abstain. A single nonzero low sample prevents the exact-padding deduction. Full low-bit utilization establishes usage only; it does not prove native recording resolution. |
| Sample-rate history | Observed bandwidth and marked native-rate/channel spectral transition regions, across configured sections | **No penalties enabled.** Declared rates ≤48 kHz are not required to be Hi-Res. Higher rates with bandwidth limits return REVIEW. Suspected original rate remains null, including 22 kHz bandwidth in a 96/192 kHz file; low-pass mastering can look identical. |
| Signal defects | Full-scale sample and same-sign plateau run counts; NaN/Inf; DC; silence/dropout regions; discontinuity candidates | ≥3 consecutive same-sign full-scale samples: 50% of category (confirmed digital rail plateau, consistent with clipping; intentional square waves can also do this). NaN/Inf: 100%. Use maximum severity within category, not additive correlated penalties. DC >0.01, silence and channel dropouts are REVIEW-only. No automatic deductions for loudness, low DR, true-peak overs or absence of ultrasonics. |

Padding identifies observed sample representation, not dishonesty or recording
history. Dither/noise can populate all low bits without restoring any source
detail. Effective utilization is not a measured analog noise floor. The
suspected_source_bit_depth is only an observed supported upper bound in the exact
padding case; it does not prove that a particular recording once existed at that
depth. Opposite-polarity channels are never downmixed for forensic measurements.

## Mastering diagnostics

A streaming native-rate/channel PCM pass measures sample peak, RMS, DC, crest
factor, stereo RMS balance, invalid/full-scale samples, quiet-block RMS, silence
and potential channel anomalies. Quiet-block RMS (10th percentile of bounded
block measurements) includes musical content and is **not** the original noise
floor. The first at most 200,000 processing blocks are retained for that statistic.
Silence is reported as regions of blocks below −80 dBFS for at least 0.5 seconds;
channel dropout and large discontinuity candidates require listening/context,
not a claim that mastering is wrong. Opposite-polarity or intentionally silent
channels are not automatically penalized.

LUFS/LRA/true peak use FFmpeg's EBU R128 / ITU-R BS.1770 filter with true-peak
oversampling, in a second full filtered pass. No replacement numbers are emitted
if unavailable. Very short or silent inputs may not have meaningful gated
loudness. DR is explicitly a **DR estimate**: per-channel peak minus RMS of the
loudest 20% of complete 3-second blocks, averaged across channels. It is not
certified TT DR or a listening-quality verdict. No complete block means null.
Estimates are not written to tags as official TT DR values.

## Spectral visualization and scan modes

FAST decodes at most the first 20 seconds, measures initial screening, skips
full FLAC verification/EBU R128/flaccheck and is always preliminary. BALANCED
fully decodes, checks FLAC, measures loudness and screens up to six distributed
one-second regions. Only DEEP uses optional flaccheck `max`, with 24 PSD regions;
BALANCED avoids this experimental full-file buffer and additional decode.
All channels are kept; native sample rate is preserved. The PSD uses a Hann
window, 4096 samples, a relative −75 dB occupied-bandwidth floor and a configurable
transition screen (initially 2 kHz, ≥25 dB drop). These thresholds are experimental,
not codec fingerprints. A 128-band visualization shows measured sections with
actual timestamps and marked spectral boundaries. It does not interpolate over
unmeasured parts. The original FFmpeg spectrogram remains available separately.

Entire-file integer-bit and integrity coverage does not mean entire-file spectral
coverage. Short mixed-source segments outside selected regions can be missed;
DEEP improves temporal sampling without guaranteeing detection. Spectral images,
aliases and source-identifying resampling signatures are not claimed. No validated
standalone pre-echo/MDCT classifier is implemented in this application.

## Claims and reference comparison

Container assertions, optional seller/user expectations and measurements are
separate fields. Expectations accept codec, container, rate, bit depth, lossless,
source label and release. They are claims, not facts. The optional reference is
user-trusted, not independently authenticated. Reference-assisted comparison
hashes full native-rate/channel decoded samples as canonical little-endian f64
PCM (exactly represents decoded ≤32-bit integer samples); it does not resample,
normalize gain, align delays or compare perceptual fingerprints. Equal PCM at
equal rate/channel count means equality to **that reference**. A mismatch can
also arise from gain, delay or different mastering. Neither result authenticates
the reference's provenance. Reference analysis never increases source-history
score coverage and does not automatically remove other warnings.

## Jobs, cache and safeguards

`core/audio_scoring/` separates measurement, rules, subprocess IO, service and API.
SQLite stores per-result cache, persistent job state and incremental rows. Content
SHA-256 is recomputed before lookup; cache keys include mode, claims, reference
content hash, detector versions, full config and an engine source digest. Changed
bytes, engine/rules/config/reference versions invalidate it. Stat/ctime checks
reject files changed during hashing/analysis. Legacy verdicts without current
engine/rules/file signatures are not reused as forensic evidence.

Use one application worker (the repository's default). Up to four simultaneous
file analyses share a process-wide semaphore, with configurable per-job concurrency
1–4 and at most eight active scans. Enumeration and submission are bounded at
100,000 files/job, 50 GiB/file, six hours/file, 384 kHz and eight channels. Each
subprocess has a watchdog (initially 1800 seconds), bounded output/error queues and
one decoder/filter thread. On POSIX a fresh process sets a 2 GiB address-space
limit without unsafe threaded preexec hooks. On Windows, portable IO/runtime
limits still work, but OS-enforced process memory limits are not implemented;
Windows is not runtime-validated by this release. flaccheck is skipped when its
estimated full PCM buffer exceeds 256 MiB or duration is unknown.

The queue submits only the configured number of futures at once. Cancellation
kills active subprocesses and stops hashing/enumeration; completed rows survive.
Restart marks unfinished jobs INTERRUPTED, with explicit rescan, rather than
silently claiming they completed. Each completed result can be fetched immediately
or exported as JSON, JSONL or CSV (formula-leading cells are escaped). Exports
snapshot the completed row count. Neither queue nor cache is a multi-host service;
results and cache require normal local filesystem access protection.

All API paths, references and folder roots resolve inside HIRES_VAULT_DIR;
symlink escapes, nonregular files and unsupported extensions are rejected.
Directory symlinks are not traversed. Executable names are fixed and supplied
argument arrays are never passed to a shell. Decoder protocol and demuxer
whitelists reject playlists/network inputs. These limits do not sandbox an
upstream codec vulnerability; keep binaries patched. Logs use short file hashes
and status, not personal full paths. Results intentionally include a basename and
relative path for the local UI; exports can contain personal source/release labels.

Existing playback, gapless, ReplayGain tagging and fingerprint tools remain
separate. Missing rsgain no longer hides the rest of an audit, but ReplayGain tag
writing fails rather than saving a fabricated gain. Existing explicit tag and
vault-management actions still require the user's click; a scoring job never
calls them. DSD noise diagnostics remain outside the score and no longer assert
native SACD/PCM provenance. Legacy HIRES_VERIFIED tags are written UNVERIFIED when
new diagnostics are explicitly saved: format grouping cannot verify provenance.
