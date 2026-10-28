import csv
from io import StringIO
import math
import subprocess
from pathlib import Path
from typing import Dict, Any, Optional, List
import numpy as np

# ==============================================================================
# 4. DSD / SACD PURITY DETERMINATION
# ==============================================================================
def check_dsd_purity(filepath: str, specs: Optional[Dict] = None) -> Dict[str, Any]:
    """
    Phân định DSD / SACD Purity:
    - Nhận diện kênh: Stereo 2.0 vs Multi-channel 5.1 Surround
    - Phân tích dải tần siêu âm >30kHz (tiếng ồn lượng tử Sigma-Delta Noise Shaping)
    - Phân loại: Native DSD (SACD) vs DSD Converted from PCM (44.1k/48k hoặc 96k)
    """
    p = Path(filepath)
    ext = p.suffix.lower()

    # Kiểm tra channel layout và codec
    from core.audio_scoring.tools import probe
    from core.audio_scoring.process import ToolError
    try:
        specs = specs or probe(p)
        codec = specs['codec']
        sr = specs['sample_rate']
        channels = specs['channels']
        dur = specs.get('duration')
    except ToolError:
        return {
            'is_dsd': False, 'purity': 'UNKNOWN', 'codec': ext[1:].upper(),
            'channels': None, 'channel_type': 'Chưa rõ', 'channel_badge': '',
            'badge': '⚪ DSD chưa xác thực', 'badge_color': '#94a3b8',
            'explanation': 'Không đọc được thông tin âm thanh; không thể xác thực DSD.'
        }

    is_dsd = ('dsd' in codec.lower() or ext in ('.dsf', '.dff'))

    channel_type = 'Mono' if channels == 1 else 'Stereo 2.0' if channels == 2 else f'{channels} kênh'
    channel_badge = channel_type

    if not is_dsd:
        return {
            'is_dsd': False,
            'codec': codec.upper(),
            'channels': channels,
            'channel_type': channel_type,
            'channel_badge': channel_badge,
            'purity': 'NOT_DSD',
            'badge': 'PCM Audio',
            'badge_color': '#94a3b8',
            'explanation': 'Định dạng PCM thông thường, không phải DSD.'
        }

    # Phân tích phổ dải siêu âm 30kHz - 80kHz qua PCM 176.4kHz
    start_sec = min(5.0, max(0.0, dur * 0.25)) if dur else 0.0
    read_len = min(12.0, max(5.0, dur - start_sec)) if dur else 12.0

    cmd_decode = [
        'ffmpeg', '-v', 'error',
        '-ss', str(start_sec), '-t', str(read_len),
        '-i', str(p),
        '-ar', '176400',
        '-ac', '1',
        '-f', 'f32le',
        '-'
    ]
    res_dec = subprocess.run(cmd_decode, capture_output=True)
    samples = np.frombuffer(res_dec.stdout, dtype=np.float32)

    if res_dec.returncode != 0 or len(samples) < 176400:
        return {
            'is_dsd': True,
            'codec': codec.upper(),
            'channels': channels,
            'channel_type': channel_type,
            'channel_badge': channel_badge,
            'purity': 'UNKNOWN',
            'badge': f'⚪ DSD chưa xác thực ({channel_type})',
            'badge_color': '#06b6d4',
            'explanation': 'Không đủ mẫu giải mã để đánh giá nguồn DSD.'
        }

    nfft = 8192
    spec = np.abs(np.fft.rfft(samples[:min(len(samples) // nfft, 15) * nfft].reshape(-1, nfft) * np.hanning(nfft)))
    avg_power = np.mean(spec ** 2, axis=0)
    freqs = np.fft.rfftfreq(nfft, 1.0 / 176400)

    def band_db(f1, f2):
        m = (freqs >= f1) & (freqs < f2)
        if not np.any(m): return -120.0
        return float(10 * np.log10(np.mean(avg_power[m]) + 1e-15))

    db_20k = band_db(18000, 22000)
    db_30k = band_db(28000, 35000)
    db_50k = band_db(49000, 65000)

    # Độ dốc tiếng ồn lượng tử Sigma-Delta: DSD thật noise tăng mạnh từ 30k đến 50k+
    noise_shape_rise = round(db_50k - db_30k, 1)
    drop_at_22k = round(db_20k - db_30k, 1)

    purity = 'DSD_SOURCE_UNVERIFIED'
    badge = f'DSD ({channel_type}) — nguồn chưa xác thực'
    badge_color = '#06b6d4'
    explanation = (f'Đo độ tăng nhiễu siêu âm {noise_shape_rise}dB. '
                   'Noise shaping hoặc giới hạn phổ không xác lập DSD native, SACD hay lịch sử chuyển đổi PCM.')

    return {
        'is_dsd': True,
        'codec': codec.upper(),
        'sample_rate': sr,
        'channels': channels,
        'channel_type': channel_type,
        'channel_badge': channel_badge,
        'purity': purity,
        'badge': badge,
        'badge_color': badge_color,
        'noise_shape_rise_db': noise_shape_rise,
        'drop_at_22k_db': drop_at_22k,
        'explanation': explanation
    }


# ==============================================================================
# 5. REPLAYGAIN 2.0 & EBU R128 LOUDNESS
# ==============================================================================
def measure_replaygain_ebu_r128(filepath: str, measurement: Optional[Dict] = None) -> Dict[str, Any]:
    """
    Đo đạc ReplayGain 2.0 và EBU R128 (Integrated LUFS, True Peak, LRA).
    Tính toán thông số bù trừ âm lượng không làm giảm chất lượng bit-perfect.
    """
    p = Path(filepath)
    if measurement is None:
        from core.audio_scoring import load_config
        from core.audio_scoring.tools import loudness
        measurement = loudness(p, load_config())
    integrated_lufs = measurement.get('integrated_lufs')
    lra = measurement.get('lra_lu')
    true_peak_db = measurement.get('true_peak_dbtp')
    if any(value is None for value in (integrated_lufs, lra, true_peak_db)):
        raise ValueError('Chưa có đủ phép đo loudness để tạo ReplayGain')

    # Chuẩn ReplayGain 2.0: Target -18.0 LUFS
    track_gain_rg2 = round(-18.00 - integrated_lufs, 2)
    # Chuẩn EBU R128: Target -23.0 LUFS
    track_gain_r128 = round(-23.00 - integrated_lufs, 2)
    # Peak dạng tỷ lệ (ratio 0.0 -> 1.0+)
    track_peak_ratio = round(float(10.0 ** (true_peak_db / 20.0)), 6)

    # Giữ phép đo DSD bằng FFmpeg: rsgain 3.6 chưa hỗ trợ DSF, DFF.
    backend = 'ffmpeg' if p.suffix.lower() in ('.dsf', '.dff') else 'rsgain'
    if backend == 'rsgain':
        try:
            scan = subprocess.run(
                ['rsgain', 'custom', '-s', 's', '-l', '-18', '-t', '-O', '-q', str(p.resolve())],
                capture_output=True, text=True, timeout=60, check=True
            )
        except FileNotFoundError as e:
            raise RuntimeError('Cần cài rsgain >= 3.6 và đặt trong PATH để đo ReplayGain') from e
        rows = list(csv.DictReader(StringIO(scan.stdout), delimiter='\t'))
        if len(rows) != 1 or None in rows[0]:
            raise ValueError('rsgain không trả kết quả cho đúng một tệp')
        track_gain_rg2 = float(rows[0]['Gain (dB)'])
        track_peak_ratio = float(rows[0]['Peak'])
        if not all(math.isfinite(v) for v in (track_gain_rg2, track_peak_ratio)):
            raise ValueError('rsgain trả giá trị ReplayGain không hợp lệ')

    return {
        'replaygain_backend': backend,
        'integrated_lufs': float(integrated_lufs),
        'loudness_range_lra': float(lra),
        'true_peak_db': float(true_peak_db),
        'replaygain_track_gain': f"{track_gain_rg2:+.2f} dB",
        'replaygain_track_peak': float(track_peak_ratio),
        'r128_track_gain': f"{track_gain_r128:+.2f} dB",
        'summary': f"{integrated_lufs} LUFS | Peak {true_peak_db:+.1f} dBFS | Gain {track_gain_rg2:+.2f} dB"
    }


# ==============================================================================
# 6. GAPLESS PLAYBACK & SEAMLESS TRANSITIONS CHECKER
# ==============================================================================
def check_gapless_attributes(filepath: str, duration: Optional[float] = None) -> Dict[str, Any]:
    """
    Kiểm tra thuộc tính Gapless Playback:
    - Đo độ dài khoảng lặng mở đầu (lead-in silence) và kết thúc (lead-out silence).
    - Phân tích mức năng lượng biên (boundary energy) để phát hiện chuyển bài liền mạch (Live/Mix).
    """
    p = Path(filepath)
    ext = p.suffix.lower()

    # Đo khoảng lặng đầu và đuôi bằng ffmpeg
    cmd_start = [
        'ffmpeg', '-v', 'error',
        '-t', '2.0',
        '-i', str(p),
        '-f', 'f32le', '-ac', '1', '-ar', '44100', '-'
    ]
    res_start = subprocess.run(cmd_start, capture_output=True)
    raw_start = np.frombuffer(res_start.stdout, dtype=np.float32)

    if duration is None:
        from core.audio_scoring.tools import probe
        from core.audio_scoring.process import ToolError
        try:
            duration = probe(p)['duration']
        except ToolError:
            duration = None
    tail_seek = ['-ss', str(max(0.0, duration - 2.0))] if duration else ['-sseof', '-2.0']
    cmd_end = [
        'ffmpeg', '-v', 'error',
        *tail_seek, '-t', '2.0',
        '-i', str(p),
        '-f', 'f32le', '-ac', '1', '-ar', '44100', '-'
    ]
    res_end = subprocess.run(cmd_end, capture_output=True)
    raw_end = np.frombuffer(res_end.stdout, dtype=np.float32)

    start_valid = res_start.returncode == 0 and len(raw_start) > 0 and bool(np.all(np.isfinite(raw_start)))
    end_valid = res_end.returncode == 0 and len(raw_end) > 0 and bool(np.all(np.isfinite(raw_end)))

    # Tìm khoảng lặng đầu (silent samples < -60 dBFS = 0.001)
    silence_threshold = 0.001
    intro_silence_samples = 0
    if len(raw_start) > 0:
        for s in np.abs(raw_start):
            if s < silence_threshold:
                intro_silence_samples += 1
            else:
                break
    intro_silence_ms = round((intro_silence_samples / 44100.0) * 1000.0, 1) if start_valid else None

    # Tìm khoảng lặng đuôi
    outro_silence_samples = 0
    if len(raw_end) > 0:
        for s in reversed(np.abs(raw_end)):
            if s < silence_threshold:
                outro_silence_samples += 1
            else:
                break
    outro_silence_ms = round((outro_silence_samples / 44100.0) * 1000.0, 1) if end_valid else None

    # Năng lượng tại 100ms cuối cùng (boundary energy)
    boundary_samples = raw_end[-4410:] if len(raw_end) >= 4410 else raw_end
    boundary_rms = float(np.sqrt(np.mean(boundary_samples ** 2))) if end_valid else None
    boundary_db = round(20.0 * np.log10(max(boundary_rms, 1e-9)), 1) if boundary_rms is not None else None

    is_seamless_candidate = bool(boundary_db > -45.0) if boundary_db is not None else None

    container_gapless_support = bool(ext in ('.flac', '.wav', '.dsf', '.dff', '.ape'))

    if not start_valid or not end_valid:
        gapless_rating = 'Chưa đủ dữ liệu đo gapless'
        rating_color = '#94a3b8'
    elif container_gapless_support:
        gapless_rating = 'Seamless Native Ready'
        rating_color = '#10b981'
    elif intro_silence_ms < 50.0 and outro_silence_ms < 50.0:
        gapless_rating = 'Gapless Compatible'
        rating_color = '#06b6d4'
    else:
        gapless_rating = 'Standard Padded'
        rating_color = '#94a3b8'

    return {
        'intro_silence_ms': intro_silence_ms,
        'outro_silence_ms': outro_silence_ms,
        'boundary_end_db': boundary_db,
        'is_seamless_live_candidate': is_seamless_candidate,
        'container_gapless_support': container_gapless_support,
        'gapless_rating': gapless_rating,
        'rating_color': rating_color,
        'summary': f"Intro: {intro_silence_ms}ms | Outro: {outro_silence_ms}ms | Boundary: {boundary_db}dBFS" if start_valid and end_valid else 'Chưa đủ dữ liệu đo khoảng lặng và năng lượng biên.'
    }


# ==============================================================================
# COMBINED AUDIO DIAGNOSTICS
# ==============================================================================
def run_full_audiophile_audit(filepath: str, scoring: Optional[Dict] = None) -> Dict[str, Any]:
    """
    Thu thập phép đo và chẩn đoán kỹ thuật cho một tệp âm thanh.
    Tích hợp bằng chứng kỹ thuật; nguồn master không xác thực từ phổ.
    """
    p = Path(filepath)
    if not p.is_file():
        raise FileNotFoundError(f"Tệp không tồn tại: {filepath}")

    from core.audio_scoring import analyze
    from core.audio_scoring.legacy import dashboard_fields
    from core.audio_scoring.process import ToolError
    scoring = scoring or analyze(filepath)
    fields = dashboard_fields(scoring)
    specs = scoring['claims']['container_assertions']
    dr_data = fields['dynamic_range']
    integrity_data = fields['integrity']
    bit_data = fields['bit_depth']

    # DSD format and spectral evidence
    dsd_data = check_dsd_purity(filepath, specs=specs)

    # ReplayGain & EBU R128
    try:
        measured = scoring['mastering'] if scoring['mastering'].get('available') else None
        lufs_data = measure_replaygain_ebu_r128(filepath, measurement=measured)
        lufs_data['available'] = True
    except (RuntimeError, ValueError, OSError, subprocess.SubprocessError, ToolError) as exc:
        # Optional ReplayGain failure must not hide the independent file evidence.
        lufs_data = {'available': False, 'error': str(exc),
                     'integrated_lufs': scoring['mastering'].get('integrated_lufs'),
                     'true_peak_db': scoring['mastering'].get('true_peak_dbtp')}


    # Gapless playback
    gapless_data = check_gapless_attributes(filepath, duration=specs.get('duration'))

    # Spectral evidence; cutoff alone cannot establish source history
    spectrum_data = fields['spectrum']
    spectrum_data.pop('authenticity', None)  # The full report is already at the audit root.
    spectrum_data['filepath'] = str(p.resolve())

    # Acoustic fingerprint (Chromaprint / fpcalc)
    from core.fingerprint import get_audio_fingerprint
    try:
        fp_res = get_audio_fingerprint(filepath)
        fp_data = {
            'is_available': fp_res.get('is_available', False),
            'duration': fp_res.get('duration'),
            'sample_count': fp_res.get('sample_count'),
            'badge': '🟢 Chromaprint OK' if fp_res.get('is_available') else '⚪ Fingerprint N/A'
        }
    except Exception:
        fp_data = {
            'is_available': False,
            'duration': None,
            'sample_count': None,
            'badge': '⚪ Fingerprint N/A'
        }

    # 9. Vault Tier Classification
    tier = classify_vault_tier(
        filepath=filepath,
        integrity=integrity_data,
        bit_purity=bit_data,
        dsd_purity=dsd_data,
        spectrum=spectrum_data
    )

    return {
        'filepath': str(filepath),
        'filename': p.name,
        'authenticity': scoring,
        'dynamic_range': dr_data,
        'integrity': integrity_data,
        'bit_depth': bit_data,
        'dsd': dsd_data,
        'loudness': lufs_data,
        'gapless': gapless_data,
        'spectrum': spectrum_data,
        'fingerprint': fp_data,
        'vault_tier': tier
    }


def classify_vault_tier(filepath: str, integrity: Dict, bit_purity: Dict, dsd_purity: Dict, spectrum: Optional[Dict] = None) -> Dict[str, Any]:
    """
    Phân loại vào 3 Cấp Kho Nhạc (Vault Tiering):
    1. 01_DSD & Hi-Res (>24/96k)
    2. 02_Lossless CD (16/44.1k hoặc Studio Master 24/44.1k)
    3. 03_Quarantine (Fake Hi-Res, Fake 24-bit, MP3, File Lỗi Bit-Rot)
    """
    p = Path(filepath)
    ext = p.suffix.lower()

    # 1. Kiểm tra file lỗi hoặc Bit-Rot
    if integrity.get('status') in ('FAIL', 'BIT_ROT_CORRUPTED'):
        return {
            'tier_id': '03_quarantine',
            'tier_name': '03_Quarantine (Fake Hi-Res, MP3, File Lỗi)',
            'sub_category': 'Corrupted_Bit_Rot',
            'badge': '🔴 Quarantine (File Lỗi / Bit-Rot)',
            'badge_color': '#f43f5e'
        }

    # 2. Kiểm tra Fake 24-bit
    if bit_purity.get('is_fake_24bit', False):
        return {
            'tier_id': '03_quarantine',
            'tier_name': '03_Quarantine (Fake Hi-Res, MP3, File Lỗi)',
            'sub_category': 'Fake_24bit_Padded',
            'badge': 'Padding PCM đã đo; xem xét kỳ vọng nguồn',
            'badge_color': '#f43f5e'
        }

    # 5. Kiểm tra file nén Lossy
    from core.analyzer import get_audio_specs
    specs = spectrum if spectrum and spectrum.get('codec') else get_audio_specs(filepath)
    codec = specs['codec'].lower()
    if codec in ('mp3', 'aac', 'vorbis', 'opus', 'wmav1', 'wmav2', 'wmapro'):
        return {
            'tier_id': '03_quarantine',
            'tier_name': '03_Quarantine (Fake Hi-Res, MP3, File Lỗi)',
            'sub_category': 'Lossy_Audio',
            'badge': '⚪ Quarantine (Lossy MP3/AAC)',
            'badge_color': '#94a3b8'
        }

    if ext in ('.dsf', '.dff') and dsd_purity.get('purity') == 'UNKNOWN':
        return {
            'tier_id': '03_quarantine', 'tier_name': '03_Quarantine',
            'sub_category': 'Unverified_DSD', 'badge': '⚪ DSD chưa xác thực',
            'badge_color': '#94a3b8'
        }

    # 6. DSD thật
    if dsd_purity.get('is_dsd', False):
        return {
            'tier_id': '01_hires_dsd',
            'tier_name': '01_DSD & Hi-Res (>24/96k)',
            'sub_category': 'DSD_Source_Unverified',
            'badge': 'DSD — phân nhóm định dạng, nguồn chưa xác thực',
            'badge_color': '#06b6d4'
        }

    # 7. PCM Hi-Res (>24/96k hoặc 24-bit)
    real_bits = bit_purity.get('real_bits')
    bits_label = str(real_bits) if real_bits is not None else '—'

    sr = specs['sample_rate']
    if sr is None:
        return {'tier_id': '03_quarantine', 'tier_name': '03_Quarantine',
                'sub_category': 'Unverified', 'badge': 'Chưa đủ thông tin định dạng', 'badge_color': '#94a3b8'}

    if sr >= 88200 or (real_bits is not None and real_bits >= 24 and sr > 48000):
        return {
            'tier_id': '01_hires_dsd',
            'tier_name': '01_DSD & Hi-Res (>24/96k)',
            'sub_category': f'HiRes_{bits_label}bit_{sr//1000}k',
            'badge': f'🟢 DSD & Hi-Res ({bits_label}b/{sr//1000}k)',
            'badge_color': '#10b981'
        }
    else:
        return {
            'tier_id': '02_cd_lossless',
            'tier_name': '02_Lossless CD (16/44.1k)',
            'sub_category': f'CD_{bits_label}bit_{sr//1000}k',
            'badge': f'🔵 Lossless CD ({bits_label}b/{sr//1000}k)',
            'badge_color': '#6366f1'
        }


def audit_album_gapless_and_dr(track_paths: List[str]) -> Dict[str, Any]:
    """
    Kiểm định toàn bộ Album:
    - Tính Official Album Dynamic Range (DR trung bình toàn Album theo chuẩn Pleasurize Music Foundation)
    - Phân tích chuyển tiếp Gapless giữa các track liên tiếp (phát hiện gap lỗi hoặc chuyển bài mượt)
    """
    track_audits = []
    dr_scores = []
    
    # Sắp xếp theo tên file / số thứ tự
    sorted_paths = sorted(track_paths, key=lambda p: Path(p).name)

    for tp in sorted_paths:
        try:
            audit = run_full_audiophile_audit(tp)
            track_audits.append(audit)
            score = audit.get('dynamic_range', {}).get('dr_score')
            if score is not None and score > 0:
                dr_scores.append(score)
        except Exception as e:
            print(f"Lỗi kiểm định track {tp}: {e}")

    if not track_audits:
        return {'error': 'Không có track nào được phân tích thành công'}

    album_dr = round(float(np.mean(dr_scores))) if dr_scores else None
    album_dr_float = round(float(np.mean(dr_scores)), 2) if dr_scores else None

    # Phân tích chuyển tiếp Gapless giữa track i và track i+1
    transitions = []
    for i in range(len(track_audits) - 1):
        t1 = track_audits[i]
        t2 = track_audits[i + 1]

        t1_gapless = t1.get('gapless', {})
        t2_gapless = t2.get('gapless', {})

        t1_outro_silence = t1_gapless.get('outro_silence_ms')
        t2_intro_silence = t2_gapless.get('intro_silence_ms')
        total_silence_gap = round(t1_outro_silence + t2_intro_silence, 1) if t1_outro_silence is not None and t2_intro_silence is not None else None

        t1_end_db = t1_gapless.get('boundary_end_db')

        # Đánh giá chuyển tiếp
        if total_silence_gap is None or t1_end_db is None:
            status = 'INCONCLUSIVE'
            status_badge = 'Chưa đủ dữ liệu'
            status_color = '#94a3b8'
            note = 'Chưa đo được khoảng lặng hoặc năng lượng biên.'
        elif total_silence_gap == 0.0 and t1_end_db > -45.0:
            status = 'SEAMLESS_CONTINUOUS'
            status_badge = '🟢 Chuyển Liền Mạch (Live / Mix)'
            status_color = '#10b981'
            note = 'Chuyển bài tuyệt đối mượt mà, không bị chèn khoảng lặng.'
        elif total_silence_gap > 300.0:
            status = 'ISOLATED_TRACKS'
            status_badge = '⚪ Tách Bài Chuẩn (Có Khoảng Lặng)'
            status_color = '#94a3b8'
            note = f'Khoảng lặng phân cách {total_silence_gap}ms giữa 2 bài hát.'
        else:
            status = 'SUBTLE_TRANSITION'
            status_badge = '🟡 Chuyển Tiếp Ngắn'
            status_color = '#eab308'
            note = f'Khoảng chuyển tiếp ngắn {total_silence_gap}ms.'

        transitions.append({
            'from_track': t1.get('filename', ''),
            'to_track': t2.get('filename', ''),
            'from_end_db': t1_end_db,
            'total_silence_gap_ms': total_silence_gap,
            'status': status,
            'status_badge': status_badge,
            'status_color': status_color,
            'note': note
        })

    return {
        'track_count': len(track_audits),
        'album_dr_score': album_dr,
        'album_dr_float': album_dr_float,
        'album_dr_badge': f"Album DR{album_dr}" if album_dr is not None else 'Album DR chưa đo được',
        'transitions': transitions,
        'tracks': track_audits
    }
