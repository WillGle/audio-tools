"""Read-only Audio Authenticity & Integrity engine, independent of the dashboard."""
from datetime import datetime, timezone
import copy
from functools import lru_cache
import hashlib
import json
import logging
from pathlib import Path
import time

from .models import Expectations, rule
from .process import AnalysisCancelled, ToolError, checkpoint
from . import tools
from .measurements import measure

LOGGER = logging.getLogger(__name__)
ENGINE_VERSION = '1.0.0'
NO_PROVENANCE = 'Không thể xác minh nguồn master chỉ từ file này. Điểm là chỉ số bằng chứng, không phải xác suất file thật.'


def load_config():
    return json.loads(Path(__file__).with_name('rules.v1.json').read_text(encoding='utf8'))


@lru_cache(maxsize=1)
def engine_signature():
    digest = hashlib.sha256()
    for path in sorted(Path(__file__).parent.glob('*.py')):
        digest.update(path.read_bytes())
    return digest.hexdigest()


def evidence(code, family, detail):
    return {'code': code, 'family': family, 'detail': detail}


def aggregate(rules, config, preliminary=False):
    weights = config['weights']
    applicable = sum(weights[key] for key, r in rules.items() if r['status'] != 'NOT_APPLICABLE')
    assessed = sum(weights[key] for key, r in rules.items() if r['score_contribution'] is not None)
    coverage = assessed / applicable if applicable else 0
    score = round(100 * sum(r['score_contribution'] or 0 for r in rules.values()) / assessed, 1) if assessed and coverage >= config['minimum_coverage'] and not preliminary else None
    critical = rules['integrity']['status'] == 'FAIL'
    if critical:
        verdict, band = 'INTEGRITY_FAIL', 'LỖI TOÀN VẸN: cần kiểm tra tệp hỏng'
        score = 0 if score is not None else None
    elif score is None:
        verdict, band = 'INSUFFICIENT_EVIDENCE', 'Chưa đủ bằng chứng để chấm điểm'
    else:
        verdict = 'REVIEW' if any(r['status'] in ('FAIL', 'SUSPECT', 'REVIEW') for r in rules.values()) else 'NO_SIGNIFICANT_ISSUE_DETECTED'
        band = next(b['label'] for b in config['bands'] if score >= b['min'])
    if any(r['status'] == 'REVIEW' for r in rules.values()):
        band += ' · Có phép kiểm tra cần xem xét'
    return {'score': score, 'verdict': verdict, 'band': band, 'critical_failure': critical,
            'coverage': round(coverage, 4), 'applicable_weight': applicable, 'assessed_weight': assessed,
            'assessment_confidence': 'LOW' if score is None or coverage < config['confidence_coverage'] else 'MEDIUM',
            'inconclusive_checks': [k for k, r in rules.items() if r['score_contribution'] is None and r['status'] != 'NOT_APPLICABLE']}


def validate_config(config):
    keys = {'integrity', 'metadata', 'lossy_transcode', 'bit_depth', 'sample_rate', 'signal_defects'}
    if set(config['weights']) != keys or any(v < 0 for v in config['weights'].values()) or sum(config['weights'].values()) <= 0:
        raise ValueError('Cấu hình trọng số không hợp lệ')
    if not 0 <= config['minimum_coverage'] <= 1 or any(not 0 <= p <= 1 for p in config['penalties'].values()):
        raise ValueError('Cấu hình coverage/penalty không hợp lệ')


def analyze(path, *, mode='BALANCED', expectations=None, reference=None, config=None, cancel=None, versions=None, file_sha256=None):
    started = time.monotonic()
    checkpoint(cancel)
    path = Path(path).resolve(strict=True)
    mode = mode.upper()
    config = copy.deepcopy(config or load_config())
    validate_config(config)
    if mode not in config['modes']:
        raise ValueError('Chế độ quét không hợp lệ')
    if not path.is_file() or path.stat().st_size > config['limits']['file_bytes']:
        raise ValueError('Tệp không hợp lệ hoặc vượt giới hạn kích thước')
    before = path.stat()
    claims = Expectations.model_validate(expectations or {}).model_dump(exclude_none=True)
    versions = versions if versions is not None else tools.tool_versions(cancel)
    sha = file_sha256 or tools.file_hash(path, cancel)
    rules = {key: rule('Chưa có đủ dữ liệu đo.', limitations=[NO_PROVENANCE]) for key in config['weights']}
    out = {'schema_version': ENGINE_VERSION, 'rule_version': config['version'],
           'engine_signature': engine_signature(), 'file_sha256': sha, 'filename': path.name,
           'analysis_timestamp': datetime.now(timezone.utc).isoformat(), 'mode': mode,
           'preliminary': mode == 'FAST', 'detector_versions': versions, 'configuration': config,
           'claims': {'container_assertions': {}, 'user_expectations': claims,
                      'independent_reference': None, 'source_quality_verified': False},
           'rules': rules, 'mastering': {}, 'spectral': {'regions': []}, 'reference': None,
           'warnings': [NO_PROVENANCE], 'read_only': True, 'file_stat': {'size_bytes': before.st_size, 'mtime_ns': before.st_mtime_ns, 'ctime_ns': before.st_ctime_ns}}
    if mode == 'FAST':
        out['warnings'].append('FAST là sàng lọc sơ bộ; chưa giải mã đầy đủ hoặc kiểm tra toàn bộ FLAC.')
    try:
        if not versions.get('ffmpeg') or not versions.get('ffprobe'):
            raise ToolError('Thiếu FFmpeg/ffprobe; không thể đo âm thanh')
        specs = tools.probe(path, cancel)
        out['claims']['container_assertions'] = specs
        if specs['codec'].startswith('dsd'):
            # DSD-to-PCM conversion cannot establish integer source resolution.
            rules['bit_depth'] = rule('Bit depth PCM không áp dụng cho DSD.', status='NOT_APPLICABLE')
            rules['sample_rate'] = rule('Phân tích DSD nằm ở mục chẩn đoán riêng.', status='NOT_APPLICABLE')
            raise ToolError('Định dạng DSD: dùng mục DSD riêng; chưa chấm authenticity cho DSD.')
        for key in ['sample_rate', 'channels']:
            if specs[key] <= 0 or specs[key] > config['limits'][key]:
                raise ToolError('Thông số âm thanh vượt giới hạn phân tích')
        if specs['duration'] and specs['duration'] > config['limits']['duration_seconds']:
            raise ToolError('Thời lượng vượt giới hạn phân tích')
        metadata = evaluate_metadata(path, specs, claims, config, versions)
        rules['metadata'] = metadata
        flac = tools.flac_integrity(path, config, cancel) if specs['codec'] == 'flac' and mode != 'FAST' else {}
        # Preserve confirmed frame/MD5 failures even if no samples can be measured.
        if flac:
            rules['integrity'] = evaluate_integrity(
                {'decode_errors': '', 'decode_returncode': 0, 'frames': 0},
                flac, specs, False, config, versions)
            if rules['integrity']['status'] == 'FAIL':
                out['warnings'].append('LỖI TOÀN VẸN: FLAC frame/checksum không hợp lệ.')
        m = measure(path, specs, mode, config, cancel)
        out['spectral'] = m['spectral']
        full = mode != 'FAST' and (m['duration_measured'] + .1 >= specs['duration'] if specs['duration'] else m['duration_measured'] < config['limits']['duration_seconds'] - 1/specs['sample_rate'])
        rules['integrity'] = evaluate_integrity(m, flac, specs, full, config, versions)
        if rules['integrity']['status'] == 'FAIL':
            out['warnings'].append('LỖI TOÀN VẸN: giải mã/frame/checksum không hợp lệ; điểm không thể bỏ qua lỗi này.')
        rules['bit_depth'] = evaluate_depth(m, specs, full, config)
        optional = tools.flaccheck_evidence(path, specs, mode, config, versions, cancel)
        rules['lossy_transcode'], rules['sample_rate'] = evaluate_spectral(m, specs, optional, config)
        rules['signal_defects'] = evaluate_signal(m, full, config)
        # EBU R128 requires its own full filtered pass; never substitute crest factor.
        loud = tools.loudness(path, config, cancel) if mode != 'FAST' else {'available': False, 'reason': 'FAST không đo EBU R128 đầy đủ'}
        out['mastering'] = {key: value for key, value in m.items() if key not in {
            'spectral', 'zero_low_bits', 'active_samples_per_channel', 'lsb_nonzero_percent', 'decode_errors', 'decode_returncode'}}
        out['mastering'].update(loud)
        out['mastering']['coverage'] = 'FULL' if full else 'PRELIMINARY'
        if reference:
            out['reference'] = compare_reference(Path(reference).resolve(strict=True), specs, m, config, cancel)
            out['claims']['independent_reference'] = {
                'file_sha256': out['reference']['file_sha256'], 'trust': 'USER_ASSERTED',
                'verified_external_provenance': False}
    except ToolError as exc:
        out['warnings'].append(str(exc))
        # An unavailable tool or limit is not corruption. Preserve completed evidence.
    after = path.stat()
    if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        raise ToolError('Tệp thay đổi trong lúc phân tích; kết quả bị loại bỏ')
    out.update(aggregate(rules, config, mode == 'FAST'))
    out['runtime_seconds'] = round(time.monotonic()-started, 4)
    LOGGER.info('audio analysis id=%s mode=%s verdict=%s', sha[:12], mode, out['verdict'])
    return out


def evaluate_metadata(path, specs, claims, config, versions):
    mismatches = []
    unknown_claims = []
    for key in ['codec', 'sample_rate', 'bit_depth']:
        if key in claims and specs.get(key) is None:
            unknown_claims.append(key)
        elif key in claims and str(claims[key]).lower() != str(specs.get(key)).lower():
            mismatches.append(f'{key}: kỳ vọng {claims[key]}, header {specs.get(key)}')
    containers = set(specs['container'].split(','))
    if claims.get('container') and claims['container'].lower().lstrip('.') not in containers:
        aliases = {'m4a': 'mov', 'aif': 'aiff'}
        if aliases.get(claims['container'].lower(), '') not in containers:
            mismatches.append('Container khác kỳ vọng của người dùng')
    lossless = tools.is_lossless(specs['codec'])
    if 'lossless' in claims and claims['lossless'] != lossless:
        mismatches.append('Trạng thái codec lossless khác kỳ vọng')
    expected = {'.flac': {'flac'}, '.wav': {'wav'}, '.m4a': {'mov', 'mp4', 'm4a'},
                '.mp3': {'mp3'}, '.aif': {'aiff'}, '.aiff': {'aiff'}, '.ogg': {'ogg'},
                '.aac': {'aac'}, '.opus': {'ogg'}, '.ape': {'ape'}, '.wma': {'asf'}}.get(path.suffix.lower())
    header_mismatch = bool(expected and not expected.intersection(containers))
    if path.suffix.lower() == '.flac' and specs['codec'] != 'flac':
        header_mismatch = True
    penalty = config['weights']['metadata'] * (config['penalties']['claim_mismatch'] if mismatches else config['penalties']['header_mismatch'] if header_mismatch else 0)
    return rule('Thông số khác kỳ vọng/header.' if mismatches or header_mismatch else 'Header không cung cấp thuộc tính kỳ vọng; chưa kết luận.' if unknown_claims else 'Container/codec đọc được; chưa xác thực nguồn gốc.',
                status='FAIL' if mismatches or header_mismatch else 'INCONCLUSIVE' if unknown_claims else 'REVIEW' if specs['audio_streams'] > 1 else 'PASS',
                confidence='HIGH' if not unknown_claims else 'LOW', score_contribution=config['weights']['metadata']-penalty if penalty or not unknown_claims else None,
                penalty_applied=penalty, detector='ffprobe', version=versions['ffprobe'],
                measurements={'declared': specs, 'expected': claims, 'mismatches': mismatches, 'unknown_claims': unknown_claims, 'header_mismatch': header_mismatch},
                evidence=[evidence('CLAIM_MISMATCH', 'metadata', '; '.join(mismatches))] if mismatches else [],
                limitations=['Chỉ phân tích luồng audio đầu tiên.' if specs['audio_streams'] > 1 else NO_PROVENANCE])


def evaluate_integrity(m, flac, specs, full, config, versions):
    errors = m['decode_errors']
    resource_terms = ['memory', 'allocate', 'not found', 'permission denied']
    resource_error = any(term in errors.lower() for term in resource_terms)
    flac_resource_error = any(term in flac.get('technical_details', '').lower() for term in resource_terms)
    checksum_failed = bool(flac.get('available') and flac.get('returncode', 0) > 0) and not flac_resource_error
    decode_failed = bool(m['decode_returncode'] > 0 or errors.strip()) and not resource_error
    sample_mismatch = bool(full and flac.get('total_samples') and flac['total_samples'] != m['frames'])
    failed = checksum_failed or decode_failed or (sample_mismatch and not resource_error)
    complete = full and m['decode_returncode'] == 0 and not resource_error
    details = {'integrity_status': 'FAIL' if failed else 'PASS' if complete else 'INCONCLUSIVE',
               'checksum_verified': flac.get('checksum_verified', False),
               'decode_errors': errors.splitlines(), 'decoded_frames': m['frames'],
               'full_decode': complete, 'flac': flac, 'sample_count_mismatch': sample_mismatch,
               'technical_details': 'Full decode + flac -t' if flac.get('available') else 'FFmpeg decode only; checksum unverified'}
    penalty = config['weights']['integrity'] * config['penalties']['integrity_failure'] if failed else 0
    return rule('Phát hiện lỗi giải mã/frame/checksum.' if failed else 'Giải mã đầy đủ; checksum được báo riêng.' if complete else 'Chưa hoàn tất kiểm tra toàn bộ luồng.',
                status='FAIL' if failed else 'PASS' if complete else 'INCONCLUSIVE',
                confidence='HIGH' if failed or complete else 'LOW',
                score_contribution=config['weights']['integrity']-penalty if failed or complete else None,
                penalty_applied=penalty, detector='FFmpeg + official FLAC', version=str(versions),
                measurements=details, evidence=[evidence('CORRUPTION_DETECTED', 'integrity', 'Decode/frame/MD5 hoặc số mẫu không hợp lệ')] if failed else [],
                limitations=['MD5 khớp chỉ xác minh dữ liệu với STREAMINFO; không chứng minh bit-perfect playback hoặc nguồn master.',
                             'Checksum thiếu không phải checksum sai.'])


def evaluate_depth(m, specs, full, config):
    bits = specs['bit_depth']
    data = {'declared_bit_depth': bits, 'observed_bit_usage': None, 'suspected_source_bit_depth': None,
            'zero_low_bits': m['zero_low_bits'], 'lsb_nonzero_percent': m['lsb_nonzero_percent'],
            'floating_point_storage': m['floating_point'], 'frames_measured': m['frames']}
    kwargs = {'detector': 'FFmpeg exact PCM integer bit utilization', 'measurements': data,
              'limitations': ['Bit usage không chứng minh độ phân giải nguồn; dither/noise có thể lấp bit thấp.',
                              'Padding mô tả mẫu giải mã; không xác lập lịch sử thu âm.']}
    if m['floating_point']:
        return rule('Độ chính xác lưu trữ floating point khác độ phân giải nguồn; chưa kết luận.', **kwargs)
    if bits is None or bits > 32:
        return rule('Không xác định được độ sâu PCM chính xác.', **kwargs)
    if bits <= 16:
        return rule('Định dạng khai báo ≤16 bit; không yêu cầu Hi-Res.', status='NOT_APPLICABLE', **kwargs)
    enough = all(v >= config['thresholds']['minimum_active_samples'] for v in m['active_samples_per_channel'])
    audible = all(v is not None and v > config['thresholds']['bit_depth_minimum_rms_dbfs'] for v in m['rms_dbfs_per_channel'])
    if not enough or not audible:
        return rule('Im lặng, quá ít mẫu hoạt động hoặc mức tín hiệu quá thấp; không kết luận padding.', **kwargs)
    zero = m['zero_low_bits']
    usage = [bits-v for v in zero]
    data['observed_bit_usage'] = usage
    padding = full and all(v >= bits-16 for v in zero) and m['decode_returncode'] == 0
    penalty = config['weights']['bit_depth'] * config['penalties']['exact_padding'] if padding else 0
    if padding:
        data['suspected_source_bit_depth'] = max(usage)
        text = f'Phát hiện ít nhất {min(zero)} bit thấp luôn bằng 0 trên toàn bộ PCM {bits}-bit từng kênh; phù hợp padding từ ≤{max(usage)} bit.'
    else:
        text = 'Đã đo bit thấp được sử dụng; không thể suy ra nguồn native từ entropy hoặc bit usage.'
    return rule(text, status='SUSPECT' if padding else 'PASS' if full and not any(zero) else 'INCONCLUSIVE',
                confidence='HIGH' if padding else 'MEDIUM', penalty_applied=penalty,
                score_contribution=config['weights']['bit_depth']-penalty if padding or (full and not any(zero)) else None,
                evidence=[evidence('BIT_DEPTH_PADDING_DETECTED', 'integer_bits', text)] if padding else [], **kwargs)


def evaluate_spectral(m, specs, optional, config):
    regions = m['spectral']['regions']
    marked = [r for r in regions if r['review']]
    lossy_data = {'spectral_regions': [{k: v for k, v in r.items() if k != 'spectrum_db'} for r in marked],
                  'third_party': optional, 'corroborated_detector_families': []}
    events = [evidence('SPECTRAL_BAND_LIMIT', 'spectral', f"Kênh {r['channel']}, {r['start']}–{r['end']}s: biên {r['boundary_hz']}Hz, sụt {r['drop_db']}dB") for r in marked]
    upstream_positive = optional.get('available') and str(optional.get('upstream_verdict', '')).lower() in ('transcoded', 'suspicious')
    if not tools.is_lossless(specs['codec']):
        lossy = rule('Codec khai báo lossy; không tự coi là gian lận.', status='NOT_APPLICABLE',
                     measurements=lossy_data, detector='FFmpeg + experimental screening')
    else:
        lossy = rule('Có dấu hiệu cần kiểm tra nguồn lossy; chưa đủ bằng chứng xác định codec gốc.' if marked or upstream_positive else 'Không phát hiện dấu hiệu lossy rõ ràng; không thể xác minh nguồn master chỉ từ file này.',
                     status='REVIEW' if marked or upstream_positive else 'INCONCLUSIVE',
                     confidence='LOW', measurements=lossy_data, evidence=events,
                     detector='FFmpeg PCM PSD + optional flaccheck',
                     limitations=['Cutoff, vùng phổ và các detector phổ là cùng một họ bằng chứng; không cộng dồn.',
                                  'Detector MDCT/artifact tùy chọn còn thử nghiệm, chưa cho phép penalty.', NO_PROVENANCE])
    data = {'declared_sample_rate': specs['sample_rate'], 'observed_bandwidth': m['spectral']['observed_bandwidth_hz'],
            'suspected_source_sample_rate': None, 'resampling_evidence': []}
    boundaries = [r for r in marked if r['boundary_hz'] < specs['sample_rate']/2-config['thresholds']['bandwidth_margin_hz']]
    if specs['sample_rate'] <= 48000:
        sample = rule('Không yêu cầu sample rate cao hơn định dạng đã khai báo.', status='NOT_APPLICABLE', measurements=data)
    else:
        data['resampling_evidence'] = [{k: r[k] for k in ['channel', 'start', 'end', 'boundary_hz', 'drop_db']} for r in boundaries]
        sample = rule('Phổ có giới hạn trong tệp sample rate cao. Cần kiểm tra thêm trước khi kết luận upsampling.' if boundaries else 'Không đủ bằng chứng xác lập sample rate nguồn.',
                      status='REVIEW' if boundaries else 'INCONCLUSIVE', measurements=data,
                      detector='Experimental native-rate PSD screening', evidence=events,
                      limitations=['Không có năng lượng siêu âm không phải bằng chứng upsampling.',
                                   'Biên phổ có thể do mastering hoặc nhạc cụ; không suy diễn rate nguồn.'])
    return lossy, sample


def evaluate_signal(m, full, config):
    plateau = max(m['longest_full_scale_run_per_channel']) >= config['thresholds']['clipping_run']
    invalid = m['invalid_samples'] > 0
    dc = max(abs(v) for v in m['dc_offset_per_channel']) > config['thresholds']['dc_review']
    severity = max(config['penalties']['clipping_plateau'] if plateau else 0,
                   config['penalties']['invalid_samples'] if invalid else 0)
    penalty = config['weights']['signal_defects'] * severity
    events = []
    if plateau:
        events.append(evidence('DIGITAL_FULL_SCALE_PLATEAU', 'sample_values', 'Chuỗi mẫu liên tiếp tại rail số; phù hợp digital clipping. Có thể do tín hiệu tổng hợp chủ ý.'))
    if invalid:
        events.append(evidence('INVALID_SAMPLES', 'sample_values', 'Mẫu NaN/Infinity trong dữ liệu floating point.'))
    if dc:
        events.append(evidence('DC_OFFSET_REVIEW', 'sample_values', 'DC vượt ngưỡng xem xét; không tự trừ điểm.'))
    data = {key: m[key] for key in ['dc_offset_per_channel', 'full_scale_samples', 'longest_full_scale_run_per_channel',
                                   'invalid_samples', 'silence_regions', 'channel_dropouts', 'discontinuity_candidates']}
    return rule('Đã đo rail số, mẫu không hợp lệ, DC và vùng im lặng; không dùng loudness/DR để trừ điểm.',
                status='FAIL' if invalid else 'SUSPECT' if plateau else 'REVIEW' if dc or m['silence_regions'] else 'PASS' if full else 'INCONCLUSIVE',
                confidence='HIGH' if invalid else 'MEDIUM', score_contribution=config['weights']['signal_defects']-penalty if full or penalty else None,
                penalty_applied=penalty, measurements=data, evidence=events, detector='Streaming PCM sample statistics',
                limitations=['DC, silence, dropout và bước nhảy cần ngữ cảnh; không tự kết luận lỗi biên tập.',
                             'True peak vượt 0 dBTP không tự xác lập clipping của mẫu gốc.'])


def compare_reference(path, specs, m, config, cancel):
    if not path.is_file() or path.stat().st_size > config['limits']['file_bytes']:
        raise ToolError('Tệp tham chiếu vượt giới hạn')
    before = path.stat()
    rs = tools.probe(path, cancel)
    if rs['channels'] > config['limits']['channels'] or rs['sample_rate'] > config['limits']['sample_rate'] or (rs['duration'] or 0) > config['limits']['duration_seconds']:
        raise ToolError('Thông số tệp tham chiếu vượt giới hạn')
    rh = tools.file_hash(path, cancel)
    rm = measure(path, rs, 'BALANCED', config, cancel)
    after = path.stat()
    if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        raise ToolError('Tệp tham chiếu thay đổi trong khi đo')
    same = all(specs[key] == rs[key] for key in ['sample_rate', 'channels']) and m['frames'] == rm['frames'] and m['pcm_sha256'] == rm['pcm_sha256']
    complete = rm['decode_returncode'] == m['decode_returncode'] == 0 and not rm['decode_errors'] and not m['decode_errors'] and not rm['invalid_samples'] and not m['invalid_samples'] and (not specs['duration'] or m['duration_measured']+.1 >= specs['duration'])
    return {'status': 'PASS' if complete and same else 'REVIEW' if complete else 'INCONCLUSIVE',
            'file_sha256': rh, 'pcm_identical': same if complete else None,
            'reference_specs': rs, 'method': 'SHA-256 of full decoded native-rate/channel normalized f64 PCM; no resampling, gain or alignment',
            'explanation': 'So sánh với tệp do người dùng tin cậy; không độc lập xác minh nguồn master.',
            'limitations': ['PCM khác nhau không tự chứng minh lossy; khác gain, delay hay mastering cũng gây khác biệt.']}
