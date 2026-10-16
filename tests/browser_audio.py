"""Real Chromium smoke check against a disposable vault. Run directly, not pytest."""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from playwright.sync_api import sync_playwright


def run(root, output):
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='audio-browser-cache-') as cache:
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        env = {**os.environ, 'HIRES_VAULT_DIR': str(root), 'AUDIO_TOOLS_CACHE_DIR': cache}
        server = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'app:app', '--host', '127.0.0.1',
                                   '--port', str(port), '--log-level', 'warning'], env=env,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            base = f'http://127.0.0.1:{port}'
            for _ in range(100):
                if server.poll() is not None:
                    raise RuntimeError(server.stderr.read().decode())
                try:
                    urllib.request.urlopen(base+'/api/scoring/config', timeout=1)
                    break
                except Exception:
                    time.sleep(.1)
            with sync_playwright() as p:
                browser = p.chromium.launch(executable_path=shutil.which('chromium'), headless=True,
                                            args=['--no-sandbox', '--disable-dev-shm-usage'])
                page = browser.new_page(viewport={'width': 1440, 'height': 1100})
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(base, wait_until='networkidle')
                page.locator('#btn-tab-audiophile').click()
                page.evaluate("document.getElementById('lab-selected-path').value='padded_24.flac'")
                page.locator('#scoring-single').click()
                page.wait_for_function("document.getElementById('scoring-progress').textContent.startsWith('COMPLETED')", timeout=60000)
                page.wait_for_function("document.getElementById('auth-score').textContent !== 'N/A'")
                assert '78.2/100' in page.locator('#auth-score').inner_text()
                assert 'BIT_DEPTH_PADDING_DETECTED' in page.locator('#auth-details').text_content()
                page.locator('summary', has_text='Phổ theo cửa sổ và từng kênh').click()
                page.screenshot(path=str(output/'scoring-desktop.png'), full_page=True)
                # Actual legacy audit contract, including gracefully missing optional rsgain/fpcalc.
                audit = page.request.post(base+'/api/audiophile/audit', data={'filepath':'valid_cd.flac'})
                assert audit.ok, audit.text()
                payload = audit.json()
                assert all(key in payload for key in ['dynamic_range','integrity','bit_depth','dsd','loudness','gapless','vault_tier','authenticity'])
                page.evaluate('(data) => renderAudiophileAuditResults(data)', payload)
                assert page.locator('#auth-score').inner_text() == '100/100'
                assert page.request.get(base+'/api/spectrogram?filepath=valid_cd.flac').ok
                assert page.request.get(base+'/api/stream?filepath=valid_cd.flac').ok
                assert page.request.get(base+'/api/tracks').json()['total'] > 0
                # Recursive job, progressive rows, exports and comparison selection.
                previous_export = page.locator('#scoring-export-json').get_attribute('href')
                page.locator('#scoring-folder-start').click()
                page.wait_for_function("previous => document.getElementById('scoring-export-json').getAttribute('href') !== previous", arg=previous_export)
                job_id = page.locator('#scoring-export-json').get_attribute('href').split('/')[4]
                page.wait_for_function("async id => (await (await fetch('/api/scoring/jobs/' + id)).json()).status === 'COMPLETED'", arg=job_id, timeout=90000)
                page.wait_for_function("document.getElementById('scoring-progress').textContent.startsWith('COMPLETED')", timeout=90000)
                total = page.request.get(base+'/api/scoring/jobs/'+job_id).json()['total']
                page.wait_for_function("total => document.querySelectorAll('#scoring-results tr').length === total", arg=total)
                export = page.request.get(base+page.locator('#scoring-export-json').get_attribute('href'))
                rows = export.json()
                assert len(rows) == total and all('result' in row for row in rows)
                # Select the critical result; score may be N/A, warning must remain visible.
                for row in page.locator('#scoring-results tr').all():
                    if row.locator('td').first.inner_text() == 'truncated.flac':
                        row.locator('button').click()
                        break
                assert 'LỖI TOÀN VẸN' in page.locator('#auth-warnings').inner_text()
                assert page.locator('#auth-warnings').get_attribute('class') == 'critical'
                page.set_viewport_size({'width':390, 'height':844})
                page.screenshot(path=str(output/'scoring-mobile.png'), full_page=True)
                assert not errors, errors
                (output/'browser-results.json').write_text(json.dumps({'page_errors': errors,
                    'batch_rows':len(rows), 'checks':['single padding','legacy audit','recursive batch','comparison',
                    'critical warning with N/A','JSON export','spectrogram','stream','track list','mobile rendering']}, indent=2))
                browser.close()
        finally:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
            server.stderr.close()


if __name__ == '__main__':
    run(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
