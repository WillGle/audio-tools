"""Existing tools provide decode, FLAC frame/MD5 validation and EBU R128."""
import hashlib
import json
import math
import re
import shutil
from .process import run, ToolError, checkpoint

DEMUXERS = 'flac,wav,mov,mp3,aac,ogg,aiff,ape,wv,asf,dsf,iff'


def is_lossless(codec):
    return codec in {'flac', 'alac', 'ape', 'wavpack', 'wmalossless', 'truehd', 'mlp'} or codec.startswith('pcm_')


def tool_versions(cancel=None):
    versions = {}
    for name in ['ffmpeg', 'ffprobe', 'flac', 'flaccheck']:
        if shutil.which(name) is None:
            versions[name] = None
            continue
        code, out, err = run([name, '--version' if name in ('flac', 'flaccheck') else '-version'],
                             timeout=10, cancel=cancel)
        versions[name] = (out.decode('utf8', 'replace') or err).splitlines()[0][:300] if code == 0 else None
    return versions


def file_hash(path, cancel=None):
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        while data := handle.read(1024 * 1024):
            checkpoint(cancel)
            digest.update(data)
    return digest.hexdigest()


def probe(path, cancel=None):
    code, out, err = run(['ffprobe', '-v', 'error', '-max_alloc', '268435456',
                          '-protocol_whitelist', 'file,pipe', '-format_whitelist', DEMUXERS, '-select_streams', 'a',
                          '-show_streams', '-show_format', '-of', 'json', str(path)],
                         timeout=30, cancel=cancel)
    try:
        data = json.loads(out)
        streams = data['streams']
        st = streams[0]
        fmt = data.get('format', {})
        bits = int(st.get('bits_per_raw_sample') or 0) or int(st.get('bits_per_sample') or 0) or None
        duration = float(st.get('duration') or fmt.get('duration') or 0)
        return {
            'codec': st['codec_name'], 'container': fmt.get('format_name', ''),
            'sample_rate': int(st['sample_rate']), 'bit_depth': bits,
            'sample_format': st.get('sample_fmt'), 'channels': int(st['channels']),
            'channel_layout': st.get('channel_layout'),
            'duration': duration if math.isfinite(duration) and duration > 0 else None,
            'audio_streams': len(streams), 'probe_returncode': code,
            'probe_warnings': err.replace(str(path), '<audio>')[:4000],
        }
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise ToolError('ffprobe không đọc được luồng âm thanh') from exc


def flac_integrity(path, config, cancel=None):
    md5 = None
    total_samples = None
    try:
        from mutagen.flac import FLAC
        audio = FLAC(path)
        md5 = f'{audio.info.md5_signature:032x}' if audio.info.md5_signature else None
        total_samples = audio.info.total_samples
    except Exception:
        pass
    if not shutil.which('flac'):
        return {'available': False, 'checksum_verified': False, 'header_md5': md5,
                'total_samples': total_samples, 'error': 'Thiếu flac; chưa kiểm tra frame CRC/MD5'}
    code, _, err = run(['flac', '--test', '--silent', str(path)],
                        timeout=config['limits']['timeout_seconds'], cancel=cancel,
                        memory_mb=config['limits']['subprocess_memory_mb'])
    return {'available': True, 'returncode': code, 'header_md5': md5,
            'checksum_verified': code == 0 and md5 is not None and 'cannot check md5' not in err.lower(),
            'total_samples': total_samples, 'technical_details': err.replace(str(path), '<audio>')[:4000]}


def flaccheck_evidence(path, specs, mode, config, versions, cancel=None):
    settings = config['flaccheck']
    if not settings['enabled'] or not versions.get('flaccheck'):
        return {'available': False, 'reason': 'flaccheck tùy chọn chưa được cài đặt hoặc đã tắt'}
    version = versions['flaccheck'].split()[-1]
    if version != settings['supported_version']:
        return {'available': False, 'reason': 'Phiên bản flaccheck chưa được kiểm chứng', 'version': version}
    # Upstream decodes the full file to RAM, so do not run it on oversized/unknown inputs.
    duration = specs['duration']
    if not duration or duration * specs['sample_rate'] * specs['channels'] * 4 > config['limits']['optional_pcm_bytes']:
        return {'available': False, 'reason': 'Bỏ qua flaccheck do giới hạn bộ nhớ PCM'}
    if mode != 'DEEP' or not is_lossless(specs['codec']) or path.suffix.lower() not in {'.flac', '.wav', '.m4a', '.aiff', '.aif', '.ape'}:
        return {'available': False, 'reason': 'flaccheck không áp dụng cho lượt quét này'}
    try:
        code, out, err = run(['flaccheck', 'scan', str(path), '--format', 'json', '--quiet',
                              '--explain', '--workers', '1', '--mode', 'max'],
                             timeout=config['limits']['timeout_seconds'], cancel=cancel,
                             memory_mb=config['limits']['subprocess_memory_mb'])
        report = json.loads(out)
        if code != 0 or report.get('errors') or len(report.get('results', [])) != 1:
            raise ToolError('flaccheck không trả về một kết quả hợp lệ')
        data = report['results'][0]
        # Do not propagate unsupported codec/bitrate guesses, or its GENUINE label to the UI.
        return {'available': True, 'experimental': True, 'version': version,
                'upstream_verdict': data['transcode_verdict'],
                'evidence': [e for e in data.get('evidence', []) if e.get('signal') not in {'codec_guess', 'est_bitrate_kbps', 'genuine_hires'}], 'penalty_enabled': False}
    except (ToolError, ValueError, KeyError, TypeError) as exc:
        return {'available': False, 'reason': str(exc)}


def loudness(path, config, cancel=None):
    args = ['ffmpeg', '-nostdin', '-hide_banner', '-nostats', '-v', 'info', '-max_alloc', '268435456',
            '-threads', '1', '-protocol_whitelist', 'file,pipe', '-format_whitelist', DEMUXERS, '-i', str(path), '-map', '0:a:0',
            '-filter_threads', '1', '-af', 'ebur128=peak=true', '-f', 'null', '-']
    code, _, err = run(args, timeout=config['limits']['timeout_seconds'], cancel=cancel,
                        memory_mb=config['limits']['subprocess_memory_mb'])
    if code != 0 or 'Summary:' not in err:
        return {'available': False, 'error': 'FFmpeg EBU R128 không đo được'}
    summary = err.rsplit('Summary:', 1)[-1]
    def extract(pattern):
        m = re.search(pattern, summary)
        value = float(m.group(1)) if m else None
        return value if value is not None and math.isfinite(value) else None
    return {'available': True, 'integrated_lufs': extract(r'I:\s*([-+\w.]+) LUFS'),
            'lra_lu': extract(r'LRA:\s*([-+\w.]+) LU'),
            'true_peak_dbtp': extract(r'Peak:\s*([-+\w.]+) dBFS'),
            'method': 'FFmpeg ebur128 (EBU R128 / ITU-R BS.1770); true-peak oversampling',
            'limitations': ['LUFS/LRA của bản rất ngắn hoặc im lặng có thể không có ý nghĩa.']}
