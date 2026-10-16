import json
import time
from threading import Event
import pytest
from fastapi import FastAPI
import asyncio
from httpx import AsyncClient, ASGITransport
from core.audio_scoring.service import AnalysisService
from core.audio_scoring.api import scoring_router


def wait_job(service, job):
    for _ in range(500):
        state = service.job(job)
        if state['status'] in ['COMPLETED', 'CANCELLED', 'FAILED', 'INTERRUPTED']:
            return state
        time.sleep(.02)
    raise AssertionError('job timeout')


def test_jobs_persist_export_and_cache_invalidate(audio_library, tmp_path):
    root, _ = audio_library
    svc = AnalysisService(root, tmp_path / 'analysis.sqlite')
    job = svc.submit(['valid_cd.flac', 'padded_24.flac'], mode='BALANCED', concurrency=2)
    state = wait_job(svc, job)
    assert state['status'] == 'COMPLETED'
    rows = svc.results(job)
    assert len(rows) == 2
    assert all(r['result']['file_sha256'] for r in rows)
    cached = svc.single('valid_cd.flac')
    assert cached['cache_hit'] is True
    uncached = svc.single('valid_cd.flac', expectations={'sample_rate': 96000})
    assert uncached['cache_hit'] is False
    assert uncached['rules']['metadata']['status'] == 'FAIL'
    svc.config['version'] = 'fixture-change'
    assert svc.single('valid_cd.flac')['cache_hit'] is False
    resumed = AnalysisService(root, tmp_path / 'analysis.sqlite')
    assert resumed.job(job)['completed'] == 2
    app = FastAPI()
    app.include_router(scoring_router(svc))
    async def api_checks():
        async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
            res = await client.get(f'/api/scoring/jobs/{job}/export?format=json')
            assert res.status_code == 200
            assert len(res.json()) == 2
            assert (await client.get(f'/api/scoring/jobs/{job}/export?format=csv')).text.startswith('filepath,')
            assert len((await client.get(f'/api/scoring/jobs/{job}/export?format=jsonl')).text.splitlines()) == 2
            assert (await client.post('/api/scoring/analyze', json={'filepath': '../escape.flac'})).status_code == 403
            assert (await client.post('/api/scoring/jobs', json={'folder': '../'})).status_code == 403
            assert (await client.post('/api/scoring/jobs', json={'filepaths': ['valid_cd.flac'], 'concurrency': 100})).status_code == 422
            assert (await client.post('/api/scoring/analyze', json={'filepath': 'valid_cd.flac', 'reference': '../x.wav'})).status_code == 403
            assert (await client.post('/api/scoring/analyze', json={'filepath': 'valid_cd.flac', 'mode': 'BAD'})).status_code == 422
    asyncio.run(api_checks())

def test_cancel_and_symlink_escape(audio_library, tmp_path):
    root, _ = audio_library
    svc = AnalysisService(root, tmp_path / 'jobs.sqlite')
    job = svc.submit(folder='', mode='DEEP', concurrency=1)
    svc.cancel(job)
    assert wait_job(svc, job)['status'] == 'CANCELLED'
    escape = root / 'escape.flac'
    escape.symlink_to(tmp_path / 'other.flac')
    try:
        with pytest.raises(ValueError):
            svc.resolve('escape.flac')
    finally:
        escape.unlink()


def test_unicode_paths_content_reference_and_rule_invalidation(audio_library, tmp_path):
    import shutil
    root, _ = audio_library
    path = root / 'Nhạc 日本語 🎵.flac'
    reference = root / 'trusted-reference.flac'
    shutil.copyfile(root/'valid_cd.flac', path)
    shutil.copyfile(root/'valid_cd.flac', reference)
    svc = AnalysisService(root, tmp_path/'cache.sqlite')
    try:
        first = svc.single(path.name, reference=reference.name)
        assert not first['cache_hit'] and first['reference']['pcm_identical']
        assert svc.single(path.name, reference=reference.name)['cache_hit']
        shutil.copyfile(root/'padded_24.flac', path)
        changed = svc.single(path.name, reference=reference.name)
        assert not changed['cache_hit']
        assert changed['file_sha256'] != first['file_sha256']
        shutil.copyfile(root/'padded_24.flac', reference)
        new_reference = svc.single(path.name, reference=reference.name)
        assert not new_reference['cache_hit'] and new_reference['reference']['pcm_identical']
    finally:
        path.unlink()
        reference.unlink()


def test_runtime_output_limits_and_running_cancel():
    import sys
    from core.audio_scoring.process import run, AnalysisCancelled, ToolError
    import threading
    with pytest.raises(ToolError, match='thời gian'):
        run([sys.executable, '-c', 'import time;time.sleep(5)'], timeout=.2)
    with pytest.raises(ToolError, match='Đầu ra'):
        run([sys.executable, '-c', "print('x'*100000)"], max_output=10)
    event = threading.Event()
    timer = threading.Timer(.2, event.set)
    timer.start()
    try:
        with pytest.raises(AnalysisCancelled):
            run([sys.executable, '-c', 'import time;time.sleep(5)'], cancel=event)
    finally:
        timer.cancel()


def test_legacy_audit_keeps_measurements_when_optional_gain_tool_missing(audio_library, monkeypatch):
    from core.audiophile_engine import run_full_audiophile_audit
    from core.audio_scoring import analyze
    root, _ = audio_library
    path = root/'valid_cd.flac'
    def missing_gain(*args, **kwargs):
        raise RuntimeError('rsgain unavailable')
    monkeypatch.setattr('core.audiophile_engine.measure_replaygain_ebu_r128', missing_gain)
    audit = run_full_audiophile_audit(str(path), scoring=analyze(path))
    assert audit['authenticity']['score'] == 100
    assert audit['loudness']['available'] is False
    assert 'replaygain_track_gain' not in audit['loudness']
    assert audit['gapless']


def test_dashboard_keeps_dsd_grouping(tmp_path, monkeypatch):
    monkeypatch.setenv('AUDIO_TOOLS_CACHE_DIR', str(tmp_path/'cache'))
    import app
    monkeypatch.setattr(app, 'ROOT_DIR', tmp_path)
    monkeypatch.setattr(app, 'cached_by_path', lambda *args: {})
    for name, codec in [('native.dsf', 'dsd_lsbf'), ('fallback.dff', 'unknown')]:
        (tmp_path/name).touch()
        monkeypatch.setattr('organize_library.process_file_metadata', lambda *args: {
            'metadata_available': True, 'sr': 2822400, 'codec': codec,
            'tier': '01_HiRes_Master', 'bits': 1, 'title': '', 'artist': '', 'album': ''})
        item = next(item for item in app.library_items() if item['original_path'] == name)
        assert item['verdict'] == 'DSD_SOURCE_UNVERIFIED'
