"""Streaming sample statistics and experimental spectral screening, never provenance.

FFmpeg preserves channels/rate and supplies exact signed 32-bit integer samples.
Floating point streams are decoded separately as f64; no integer-depth claim is
made for them. Only bounded blocks and a fixed set of PSD sections are retained.
"""
import hashlib
import math
import numpy as np
from .process import Process, ToolError
from .tools import DEMUXERS


def db(value):
    return round(20 * math.log10(value), 4) if value > 0 and math.isfinite(value) else None


def measure(path, specs, mode, config, cancel=None):
    rate, channels = specs['sample_rate'], specs['channels']
    floating = (specs.get('sample_format') or '').startswith(('flt', 'dbl'))
    dtype = '<f8' if floating else '<i4'
    width = 8 if floating else 4
    args = ['ffmpeg', '-nostdin', '-hide_banner', '-v', 'error', '-max_alloc', '268435456',
            '-threads', '1', '-protocol_whitelist', 'file,pipe', '-format_whitelist', DEMUXERS, '-i', str(path), '-map', '0:a:0',
            '-vn', '-sn', '-dn']
    limit = config['modes'][mode]['decode_seconds']
    args += ['-t', str(limit or config['limits']['duration_seconds'])]
    args += ['-c:a', 'pcm_f64le' if floating else 'pcm_s32le', '-f', 'f64le' if floating else 's32le', 'pipe:1']
    proc = Process(args, timeout=config['limits']['timeout_seconds'], cancel=cancel,
                   memory_mb=config['limits']['subprocess_memory_mb'])
    total = 0
    sums = np.zeros(channels)
    squares = np.zeros(channels)
    peaks = np.zeros(channels)
    bit_or = np.zeros(channels, dtype=np.uint32)
    active = np.zeros(channels, dtype=np.int64)
    lsb_nonzero = np.zeros(channels, dtype=np.int64)
    full_scale = 0
    over_full_scale = 0
    invalid = 0
    longest_runs = np.zeros(channels, dtype=np.int64)
    runs = np.zeros(channels, dtype=np.int64)
    last_rail = np.zeros(channels)
    digest = hashlib.sha256()
    noise_blocks = []
    dr_blocks = []
    block_square, block_count = np.zeros(channels), 0
    duration = specs['duration'] or (limit or config['limits']['duration_seconds'])
    duration = min(duration, limit or config['limits']['duration_seconds'])
    sections = config['modes'][mode]['spectral_sections']
    starts = np.linspace(0, max(0, duration - 1), sections)
    nfft = config['thresholds']['spectral_nfft']
    window = np.hanning(nfft)
    spectra = [np.zeros((nfft//2+1, channels)) for _ in starts]
    spectral_counts = [0 for _ in starts]
    silence_start = [None] * channels
    silent_regions = []
    previous_samples = None
    discontinuity_candidates = []
    frame_width = channels * width
    buffer = b''
    processing_frames = 8192
    bits = specs['bit_depth'] or 32
    integer_shift = max(0, 32 - bits)
    max_positive = (2**31 - 2**integer_shift) / 2**31
    threshold = 10 ** (config['thresholds']['silence_dbfs']/20)
    def consume(raw):
        nonlocal total, full_scale, over_full_scale, invalid, block_square, block_count, previous_samples
        values = np.frombuffer(raw, dtype=dtype).reshape(-1, channels)
        x = values.astype(np.float64) if floating else values.astype(np.float64) / 2**31
        invalid += int(np.count_nonzero(~np.isfinite(x)))
        x = np.where(np.isfinite(x), x, 0)
        digest.update(x.astype('<f8').tobytes())
        if not floating:
            bit_or[:] |= np.bitwise_or.reduce(values.view(np.uint32), axis=0)
            active[:] += np.count_nonzero(values, axis=0)
            lsb_nonzero[:] += np.count_nonzero((values >> integer_shift) & 255, axis=0)
        sums[:] += np.sum(x, axis=0)
        squares[:] += np.sum(x*x, axis=0)
        peaks[:] = np.maximum(peaks, np.max(np.abs(x), axis=0))
        rails = ((x == -1) | (x == 1)) if floating else ((x <= -1) | (x >= max_positive))
        full_scale += int(np.count_nonzero(rails))
        over_full_scale += int(np.count_nonzero(np.abs(x) > 1)) if floating else 0
        for ch in range(channels):
            rail = np.where(rails[:, ch], np.sign(x[:, ch]), 0)
            boundaries = np.r_[0, np.flatnonzero(rail[1:] != rail[:-1])+1, len(rail)]
            for left, right in zip(boundaries[:-1], boundaries[1:]):
                if rail[left] == 0:
                    runs[ch] = 0
                else:
                    extra = int(runs[ch]) if left == 0 and last_rail[ch] == rail[left] else 0
                    runs[ch] = right-left+extra
                    longest_runs[ch] = max(longest_runs[ch], runs[ch])
                last_rail[ch] = rail[left]
        rms = np.sqrt(np.mean(x*x, axis=0))
        if len(noise_blocks) < 200000:
            noise_blocks.append(rms.tolist())
        # Silence/dropouts remain review-only: intentional pauses are common.
        for ch in range(channels):
            if rms[ch] < threshold:
                if silence_start[ch] is None:
                    silence_start[ch] = total / rate
            elif silence_start[ch] is not None:
                if total/rate - silence_start[ch] >= config['thresholds']['silence_review_seconds'] and len(silent_regions) < 200:
                    silent_regions.append({'channel': ch, 'start': silence_start[ch], 'end': total/rate})
                silence_start[ch] = None
        delta = np.abs(np.diff(x, axis=0, prepend=previous_samples[None, :] if previous_samples is not None else x[:1]))
        jumps = np.argwhere(delta > config['thresholds']['discontinuity_step'])
        for frame, channel in jumps[:max(0, 100-len(discontinuity_candidates))]:
            discontinuity_candidates.append({'time': (total+int(frame))/rate, 'channel': int(channel)})
        previous_samples = x[-1]
        offset = 0
        while offset < len(x):
            take = min(len(x)-offset, rate*3-block_count)
            part = x[offset:offset+take]
            block_square += np.sum(part*part, axis=0)
            block_count += take
            offset += take
            if block_count == rate*3:
                dr_blocks.append(np.sqrt(block_square / block_count))
                block_square, block_count = np.zeros(channels), 0
        for index, start in enumerate(starts):
            # Select FFT frames by their actual sample time, independently per channel.
            for off in range(0, len(x)-nfft+1, nfft):
                sec = (total+off) / rate
                if start <= sec < start+1:
                    transformed = np.fft.rfft(x[off:off+nfft] * window[:, None], axis=0)
                    spectra[index][:] += np.abs(transformed)**2
                    spectral_counts[index] += 1
        total += len(x)
        if total > config['limits']['duration_seconds'] * rate:
            raise ToolError('Vượt giới hạn số mẫu')

    try:
        for chunk in proc.chunks():
            buffer += chunk
            while len(buffer) >= frame_width * processing_frames:
                raw, buffer = buffer[:frame_width * processing_frames], buffer[frame_width * processing_frames:]
                consume(raw)
        if buffer:
            if len(buffer) % frame_width:
                raise ToolError('PCM bị cắt giữa mẫu')
            consume(buffer)
    finally:
        proc.close()
    if total == 0:
        raise ToolError('Không giải mã được mẫu âm thanh')
    for ch, start in enumerate(silence_start):
        if start is not None and total/rate-start >= config['thresholds']['silence_review_seconds'] and len(silent_regions) < 200:
            silent_regions.append({'channel': ch, 'start': start, 'end': total/rate})
    rms = np.sqrt(squares / total)
    dc = sums / total
    zero_bits = []
    for used in bit_or:
        value = int(used)
        trailing = (value & -value).bit_length()-1 if value else 32
        zero_bits.append(max(0, trailing-integer_shift))
    dr = None
    if dr_blocks:
        block_rms = np.array(dr_blocks)
        count = max(1, math.ceil(len(block_rms)*.2))
        loud_rms = np.sqrt(np.mean(np.sort(block_rms**2, axis=0)[-count:], axis=0))
        channel_dr = [db(float(p/r)) for p, r in zip(peaks, loud_rms) if r > 0]
        channel_dr = [v for v in channel_dr if v is not None]
        dr = round(float(np.mean(channel_dr)), 2) if channel_dr else None
    spectrum = spectral_summary(spectra, spectral_counts, starts, rate, config)
    return {
        'frames': total, 'duration_measured': total/rate, 'pcm_sha256': digest.hexdigest(),
        'decode_returncode': proc.proc.returncode, 'decode_errors': proc.stderr.replace(str(path), '<audio>'),
        'floating_point': floating, 'zero_low_bits': zero_bits if not floating else None,
        'active_samples_per_channel': active.tolist() if not floating else None,
        'lsb_nonzero_percent': (lsb_nonzero / total * 100).round(4).tolist() if not floating else None,
        'rms_dbfs_per_channel': [db(float(v)) for v in rms],
        'sample_peak_dbfs_per_channel': [db(float(v)) for v in peaks],
        'sample_peak_dbfs': db(float(np.max(peaks))),
        'rms_dbfs': db(float(np.sqrt(np.mean(squares/total)))),
        'crest_factor_db': db(float(np.max(peaks)/np.sqrt(np.mean(squares/total)))) if np.any(squares) else None,
        'dc_offset_per_channel': dc.round(8).tolist(), 'full_scale_samples': full_scale,
        'over_full_scale_samples': over_full_scale,
        'longest_full_scale_run_per_channel': longest_runs.tolist(), 'invalid_samples': invalid,
        'silence_regions': silent_regions, 'discontinuity_candidates': discontinuity_candidates,
        'channel_dropouts': [r for r in silent_regions if channels > 1 and r['start'] > 0 and r['end'] < total/rate],
        'stereo_balance_db': db(float(rms[0]/rms[1])) if channels == 2 and rms[1] > 0 else None,
        'quiet_block_rms_dbfs_per_channel': [db(float(v)) for v in np.percentile(noise_blocks, 10, axis=0)],
        'dr_estimate': dr, 'dr_method': 'Peak minus RMS of loudest 20% of complete 3-second blocks, per channel; not certified TT DR',
        'noise_limitations': 'Quiet-block RMS includes musical content; it is not the recording noise floor.',
        'spectral': spectrum,
    }


def spectral_summary(spectra, counts, starts, rate, config):
    nfft = config['thresholds']['spectral_nfft']
    freqs = np.fft.rfftfreq(nfft, 1/rate)
    regions = []
    thresholds = config['thresholds']
    transition = thresholds['spectral_transition_hz']
    for powers, count, start in zip(spectra, counts, starts):
        if not count:
            continue
        for ch in range(powers.shape[1]):
            power = powers[:, ch] / count
            ref = float(np.max(power))
            if ref < thresholds['spectral_min_power']:
                continue
            relative = 10*np.log10(np.maximum(power/ref, 1e-16))
            occupied = np.flatnonzero(relative > thresholds['spectral_floor_db'])
            bandwidth = float(freqs[occupied[-1]]) if len(occupied) else None
            candidates = []
            for boundary in range(thresholds['spectral_min_boundary_hz'], int(rate/2)-800, thresholds['spectral_boundary_step_hz']):
                left = (freqs >= boundary-transition) & (freqs < boundary-100)
                right = (freqs > boundary+100) & (freqs <= boundary+transition)
                if not np.any(left) or not np.any(right):
                    continue
                before, after = float(np.mean(relative[left])), float(np.mean(relative[right]))
                if before > thresholds['spectral_active_floor_db'] and after < thresholds['spectral_active_floor_db'] and before-after >= thresholds['spectral_drop_db']:
                    candidates.append((before-after, boundary))
            drop, boundary = max(candidates, default=(0, None))
            # Plot coarse log power, retaining all channels and section locations.
            groups = np.array_split(relative, 128)
            regions.append({'channel': ch, 'start': round(float(start), 3),
                            'end': round(float(start)+1, 3), 'observed_bandwidth_hz': bandwidth,
                            'boundary_hz': boundary, 'drop_db': round(drop, 2),
                            'review': boundary is not None,
                            'spectrum_db': [round(float(np.max(g)), 1) for g in groups]})
    bands = [r['observed_bandwidth_hz'] for r in regions if r['observed_bandwidth_hz'] is not None]
    return {'method': 'Experimental Hann-window PSD screening, 4096 samples, native channels/rate',
            'regions': regions, 'observed_bandwidth_hz': max(bands) if bands else None,
            'frequency_resolution_hz': rate/nfft, 'nyquist_hz': rate/2,
            'limitations': ['Cutoff không chứng minh codec, bitrate, lossy hay upsampling.',
                            'Các vùng ngoài cửa sổ được đo có thể chứa nguồn khác.']}

