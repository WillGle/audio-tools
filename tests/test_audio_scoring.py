import json
import pytest
from core.audio_scoring import analyze, load_config


def result(audio_library, name, **kwargs):
    root, manifest = audio_library
    return analyze(root / manifest[name]['path'], **kwargs)


def test_padding_is_exact_per_channel_and_silence_is_not_padding(audio_library):
    r = result(audio_library, 'padded_24')
    b = r['rules']['bit_depth']
    assert b['status'] == 'SUSPECT'
    assert b['measurements']['zero_low_bits'] == [8, 8]
    assert b['evidence'][0]['code'] == 'BIT_DEPTH_PADDING_DETECTED'
    assert b['penalty_applied'] > 0
    for name in ['silence', 'dithered_24', 'opposite_channels']:
        b = result(audio_library, name)['rules']['bit_depth']
        assert b['penalty_applied'] == 0
        assert not any(e['code'] == 'BIT_DEPTH_PADDING_DETECTED' for e in b['evidence'])


@pytest.mark.parametrize('name', ['valid_cd', 'valid_hires', 'bandlimited', 'legitimate_lowpass',
                                 'mono', 'low_level', 'valid_alac', 'missing_md5'])
def test_controls_are_not_accused(audio_library, name):
    r = result(audio_library, name)
    assert not r['critical_failure']
    assert r['rules']['lossy_transcode']['status'] not in ('SUSPECT', 'FAIL')
    assert r['rules']['sample_rate']['penalty_applied'] == 0
    assert r['rules']['integrity']['status'] == 'PASS'
    assert r['score'] is None or r['score'] == 100
    json.dumps(r, allow_nan=False)


@pytest.mark.parametrize('name', ['upsampled_96000', 'upsampled_192000', 'mp3_128k',
                                 'mp3_320k', 'aac_192k', 'mixed_source'])
def test_manipulated_spectral_evidence_abstains_without_corroboration(audio_library, name):
    r = result(audio_library, name, mode='DEEP')
    assert r['rules']['lossy_transcode']['confidence'] != 'HIGH'
    assert r['rules']['lossy_transcode']['penalty_applied'] == 0
    assert r['rules']['sample_rate']['measurements']['suspected_source_sample_rate'] is None
    assert r['spectral']['regions']
    if name.startswith('upsampled'):
        assert r['rules']['sample_rate']['status'] == 'REVIEW'


def test_corruption_is_critical_and_absent_checksum_is_not(audio_library):
    r = result(audio_library, 'truncated')
    assert r['critical_failure']
    assert r['verdict'] == 'INTEGRITY_FAIL'
    assert r['rules']['integrity']['status'] == 'FAIL'
    assert not result(audio_library, 'missing_md5')['rules']['integrity']['measurements']['checksum_verified']


def test_claims_reference_float_and_fast(audio_library):
    root, _ = audio_library
    r = result(audio_library, 'valid_cd', expectations={'sample_rate': 96000, 'bit_depth': 24})
    assert r['rules']['metadata']['status'] == 'FAIL'
    r = result(audio_library, 'valid_cd', reference=root / 'missing_md5.flac')
    assert r['reference']['pcm_identical'] is True
    r = result(audio_library, 'float')
    assert r['rules']['bit_depth']['status'] == 'INCONCLUSIVE'
    r = result(audio_library, 'valid_cd', mode='FAST')
    assert r['preliminary'] is True
    assert r['score'] is None
    assert r['rules']['integrity']['status'] == 'INCONCLUSIVE'


def test_signal_diagnostics_do_not_penalize_mastering(audio_library):
    clean = result(audio_library, 'valid_cd')
    assert clean['mastering']['integrated_lufs'] is not None
    assert clean['mastering']['true_peak_dbtp'] is not None
    assert clean['mastering']['crest_factor_db'] > 0
    assert clean['mastering']['dr_estimate'] is not None
    clipped = result(audio_library, 'clipped')
    assert clipped['mastering']['full_scale_samples'] > 0
    assert clipped['rules']['signal_defects']['penalty_applied'] > 0
    dc = result(audio_library, 'dc_offset')
    assert dc['rules']['signal_defects']['status'] == 'REVIEW'
    assert dc['rules']['signal_defects']['penalty_applied'] == 0


def test_coverage_configuration_and_cancel(audio_library):
    from core.audio_scoring.process import AnalysisCancelled
    from threading import Event
    config = load_config()
    config['minimum_coverage'] = 1
    assert result(audio_library, 'valid_cd', config=config)['score'] is None
    event = Event()
    event.set()
    with pytest.raises(AnalysisCancelled):
        result(audio_library, 'valid_cd', cancel=event)


def test_missing_tools_and_float_invalid_samples(audio_library):
    from core.audio_scoring import tools
    from core.audio_scoring.measurements import measure
    from pathlib import Path
    import numpy as np
    root, _ = audio_library
    versions = {'ffmpeg': None, 'ffprobe': None, 'flac': None, 'flaccheck': None}
    r = result(audio_library, 'valid_cd', versions=versions)
    assert r['score'] is None and not r['critical_failure']
    assert all(rule['status'] == 'INCONCLUSIVE' for rule in r['rules'].values())
    # NaN/Inf are actual decoded sample values, not a simulated detector response.
    raw = root / 'invalid-samples.raw'
    invalid = np.zeros((44100, 2), dtype='<f8')
    invalid[100, 0] = np.nan
    invalid[101, 1] = np.inf
    raw.write_bytes(invalid.tobytes())
    from tests.audio_fixtures import ffmpeg
    path = root / 'invalid-samples.wav'
    ffmpeg('-f', 'f64le', '-ar', 44100, '-ac', 2, '-i', raw, '-c:a', 'pcm_f64le', path)
    try:
        r = analyze(path)
        assert r['rules']['signal_defects']['status'] == 'FAIL'
        assert r['mastering']['invalid_samples'] == 2
        json.dumps(r, allow_nan=False)
    finally:
        raw.unlink()
        path.unlink()


def test_padding_broken_by_one_sample_and_float_not_cast_to_int(audio_library):
    from tests.audio_fixtures import ffmpeg
    import numpy as np
    root, _ = audio_library
    pcm = root / 'one-sample.raw'
    import subprocess
    decoded = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(root/'padded_24.flac'),
                              '-f', 's32le', '-'], check=True, capture_output=True).stdout
    x = np.frombuffer(decoded, '<i4').copy()
    x[-1] |= 256  # one nonzero bit in the low byte of native 24-bit PCM
    pcm.write_bytes(x.tobytes())
    altered = root / 'one-sample.flac'
    ffmpeg('-f', 's32le', '-ar', 44100, '-ac', 2, '-i', pcm, '-c:a', 'flac', altered)
    try:
        r = analyze(altered)
        assert r['rules']['bit_depth']['penalty_applied'] == 0
    finally:
        pcm.unlink()
        altered.unlink()


def test_critical_integrity_even_with_score_unavailable(audio_library):
    config = load_config()
    config['minimum_coverage'] = 1
    r = result(audio_library, 'truncated', config=config)
    assert r['score'] is None and r['critical_failure']
    assert r['verdict'] == 'INTEGRITY_FAIL'


def test_float_headroom_and_near_rail_are_not_confirmed_clipping(audio_library):
    from tests.audio_fixtures import ffmpeg
    import numpy as np
    root, _ = audio_library
    samples = np.full((44100, 1), .1, dtype='<f8')
    samples[100:120] = 1 - 2**-40
    samples[200:220] = 1.25  # float headroom is permitted, not a PCM integer rail
    raw, path = root/'float-headroom.raw', root/'float-headroom.wav'
    raw.write_bytes(samples.tobytes())
    ffmpeg('-f','f64le','-ar',44100,'-ac',1,'-i',raw,'-c:a','pcm_f64le',path)
    try:
        r = analyze(path)
        assert r['mastering']['full_scale_samples'] == 0
        assert r['rules']['signal_defects']['penalty_applied'] == 0
    finally:
        raw.unlink()
        path.unlink()


def test_unreported_depth_is_not_an_explicit_claim_mismatch(audio_library):
    root, _ = audio_library
    r = analyze(root/'mp3_128k.mp3', expectations={'bit_depth':24})
    assert r['claims']['container_assertions']['bit_depth'] is None
    assert r['rules']['metadata']['status'] == 'INCONCLUSIVE'
    assert r['rules']['metadata']['penalty_applied'] == 0


def test_flac_without_audio_frames_is_still_a_critical_failure(audio_library):
    root, _ = audio_library
    data = (root/'valid_cd.flac').read_bytes()
    offset = 4
    while True:
        last = bool(data[offset] & 128)
        size = int.from_bytes(data[offset+1:offset+4], 'big')
        offset += 4 + size
        if last:
            break
    path = root/'metadata-only.flac'
    path.write_bytes(data[:offset])
    try:
        r = analyze(path)
        assert r['critical_failure']
        assert r['rules']['integrity']['status'] == 'FAIL'
        assert r['rules']['integrity']['measurements']['flac']['returncode'] != 0
        from core.audio_scoring import evaluate_integrity
        checked = evaluate_integrity(
            {'decode_errors': 'Cannot allocate memory', 'decode_returncode': 1, 'frames': 0},
            r['rules']['integrity']['measurements']['flac'], {}, False, load_config(), r['detector_versions'])
        assert checked['status'] == 'FAIL'  # an independent failed MD5 survives a decoder resource error
    finally:
        path.unlink()
