"""Adapters for existing dashboard contracts; never resurrect provenance labels."""
from . import NO_PROVENANCE
from .tools import is_lossless


def dashboard_fields(result):
    specs = result['claims']['container_assertions']
    rules = result['rules']
    mastering = result['mastering']
    integ = rules['integrity']['measurements']
    depth = rules['bit_depth']['measurements']
    color = '#f43f5e' if result['critical_failure'] else '#f59e0b' if result['verdict'] in ('REVIEW', 'INSUFFICIENT_EVIDENCE') else '#6366f1'
    codec = specs.get('codec', '')
    if result['critical_failure']:
        verdict = 'INTEGRITY_FAIL'
    elif result['verdict'] == 'REVIEW':
        verdict = 'REVIEW'
    elif not is_lossless(codec):
        verdict = 'LOSSY' if codec in {'mp3', 'aac', 'opus', 'vorbis', 'wmav1', 'wmav2', 'wmapro'} else 'UNKNOWN'
    elif specs.get('sample_rate', 0) > 48000:
        verdict = 'FORMAT_HIRES'
    else:
        verdict = 'CD_LOSSLESS'
    regions = result['spectral'].get('regions', [])
    edges = [r for r in regions if r.get('boundary_hz')]
    strongest = max(edges, key=lambda r: r['drop_db']) if edges else {}
    spectrum = {'scoring_version': result['schema_version'], 'file_stat': result['file_stat'],
                'engine_signature': result['engine_signature'], 'rule_version': result['rule_version'],
                'file_sha256': result['file_sha256'], 'filename': result['filename'],
                'codec': codec.upper(), 'sample_rate': specs.get('sample_rate'), 'bit_depth': specs.get('bit_depth'),
                'cutoff_hz': strongest.get('boundary_hz'), 'cutoff_drop_db': strongest.get('drop_db'),
                'drop_at_22k': None, 'ultrasonic_db': None, 'has_24bit_bits': None,
                'verdict': verdict, 'badge': result['band'], 'badge_color': color,
                'explanation': NO_PROVENANCE, 'authenticity': result}
    flac = integ.get('flac', {})
    integrity = {'status': rules['integrity']['status'], 'is_valid': rules['integrity']['status'] != 'FAIL',
                 'header_md5': flac.get('header_md5'), 'checksum_verified': integ.get('checksum_verified', False),
                 'badge': 'Lỗi toàn vẹn' if result['critical_failure'] else 'Decode đầy đủ' if integ.get('full_decode') else 'Chưa kết luận',
                 'message': rules['integrity']['explanation'], 'badge_color': color}
    usage = depth.get('observed_bit_usage')
    bitdepth = {'nominal_bits': specs.get('bit_depth'), 'real_bits': max(usage) if usage else specs.get('bit_depth'),
                'is_fake_24bit': any(e['code'] == 'BIT_DEPTH_PADDING_DETECTED' for e in rules['bit_depth']['evidence']),
                'badge': rules['bit_depth']['status'], 'badge_color': color,
                'lsb_nonzero_pct': min(depth.get('lsb_nonzero_percent') or [0]),
                'noise_floor_db': None, 'explanation': rules['bit_depth']['explanation']}
    dr = mastering.get('dr_estimate')
    dynamic = {'dr_score': round(dr) if dr is not None else 0, 'dr_float': dr,
               'dr_badge': f'DR≈{dr:.1f}' if dr is not None else 'DR chưa đo được',
               'peak_db': mastering.get('sample_peak_dbfs'), 'rms_db': mastering.get('rms_dbfs'),
               'badge_color': '#6366f1', 'verdict_text': 'Ước lượng DR từ block 3 giây; không đánh giá nguồn master hoặc chất lượng nghe.',
               'is_estimate': True, 'method': mastering.get('dr_method')}
    return {'spectrum': spectrum, 'integrity': integrity, 'bit_depth': bitdepth, 'dynamic_range': dynamic}


def cached_record_current(record, path):
    from . import engine_signature, load_config
    if not record.get('scoring_version'):
        return False
    if record.get('engine_signature') != engine_signature() or record.get('rule_version') != load_config()['version']:
        return False
    try:
        stat = path.stat()
        return record.get('file_stat') == {'size_bytes': stat.st_size, 'mtime_ns': stat.st_mtime_ns, 'ctime_ns': stat.st_ctime_ns}
    except OSError:
        return False
