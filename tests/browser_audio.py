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
                assert page.locator('#scoring-single').is_disabled()
                assert page.locator('#scoring-result').is_hidden()
                search = page.locator('#lab-combobox-input')
                search.fill('padded_24')
                page.locator('.combobox-item').first.wait_for()
                search.press('ArrowDown'); search.press('Enter')
                assert page.locator('#lab-selected-path').input_value() == 'padded_24.flac'
                page.locator('#scoring-single').click()
                page.wait_for_function("document.getElementById('scoring-progress').dataset.status === 'COMPLETED'", timeout=60000)
                page.wait_for_function("document.getElementById('auth-score').textContent === '78.2/100'")
                assert 'BIT_DEPTH_PADDING_DETECTED' in page.locator('#auth-details').text_content()
                assert page.locator('#auth-details pre').count() == 0  # raw JSON is lazy and expandable
                page.locator('#auth-details > details').first.locator('summary').first.click()
                assert page.locator('#auth-details > details').first.get_attribute('data-status') == 'SUSPECT'
                page.locator('summary', has_text='Phổ theo cửa sổ và từng kênh').click()
                page.evaluate('window.scrollTo(0,0)')
                page.screenshot(path=str(output/'scoring-desktop.png'), full_page=True)
                # Editing search clears stale selection; supplementary audit uses the selected file.
                page.locator('#scoring-setup > summary').click()
                search.fill('valid_cd')
                assert page.locator('#scoring-single').is_disabled()
                page.locator('.combobox-item', has_text='valid_cd.flac').click()
                page.locator('#additional-diagnostics > summary').click()
                page.locator('#btn-run-audiophile-audit').click()
                page.wait_for_function("document.getElementById('auth-score').textContent === '100/100'", timeout=60000)
                assert 'valid_cd.flac' in page.locator('#additional-current').inner_text()
                assert page.locator('#btn-audiophile-tag-now').is_visible()
                page.locator('#additional-diagnostics > summary').click()
                assert page.request.get(base+'/api/spectrogram?filepath=valid_cd.flac').ok
                assert page.request.get(base+'/api/stream?filepath=valid_cd.flac').ok
                assert page.request.get(base+'/api/tracks').json()['total'] > 0
                # Recursive job, progressive rows, exports and comparison selection.
                previous_export = page.locator('#scoring-export-json').get_attribute('href')
                page.locator('#scoring-target').select_option('folder')
                page.locator('#scoring-single').click()
                page.wait_for_function("previous => document.getElementById('scoring-export-json').getAttribute('href') !== previous", arg=previous_export)
                job_id = page.locator('#scoring-export-json').get_attribute('href').split('/')[4]
                page.wait_for_function("async id => (await (await fetch('/api/scoring/jobs/' + id)).json()).status === 'COMPLETED'", arg=job_id, timeout=90000, polling=500)
                page.wait_for_function("document.getElementById('scoring-progress').dataset.status === 'COMPLETED'", timeout=90000)
                total = page.request.get(base+'/api/scoring/jobs/'+job_id).json()['total']
                page.wait_for_function("total => document.querySelectorAll('#scoring-results tr').length === total", arg=total)
                export = page.request.get(base+page.locator('#scoring-export-json').get_attribute('href'))
                rows = export.json()
                assert len(rows) == total and all('result' in row for row in rows)
                assert page.locator('#scoring-result').is_hidden()  # batch waits for explicit selection
                # Select the critical result; score may be N/A, warning must remain visible.
                for row in page.locator('#scoring-results tr').all():
                    if row.locator('td').first.inner_text() == 'truncated.flac':
                        row.locator('button').click()
                        break
                assert 'LỖI TOÀN VẸN' in page.locator('#auth-warnings').inner_text()
                assert page.locator('#auth-warnings').get_attribute('class') == 'critical'
                assert page.locator('#btn-audiophile-tag-now').is_hidden()
                # A bad folder reports an actionable error and leaves retry available.
                page.locator('#scoring-setup > summary').click()
                page.locator('#scoring-folder').fill('../outside')
                page.locator('#scoring-single').click()
                page.locator('#scoring-error').wait_for(state='visible')
                assert page.locator('#scoring-single').is_enabled()
                page.locator('#scoring-folder').fill('')
                page.set_viewport_size({'width':390, 'height':844})
                page.evaluate('window.scrollTo(0,0)')
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'mobile page overflows'
                page.screenshot(path=str(output/'scoring-mobile.png'), full_page=True)
                # Cancel a new mode, restore completed history, then scan library selections.
                page.locator('#scoring-mode').select_option('DEEP')
                page.locator('#scoring-single').click()
                page.locator('#scoring-cancel').wait_for(state='visible')
                page.locator('#scoring-cancel').click()
                page.wait_for_function("document.getElementById('scoring-progress').dataset.status === 'CANCELLED'", timeout=30000)
                assert page.locator('#scoring-single').is_enabled()
                page.locator('#scoring-history').select_option(job_id)
                page.wait_for_function("document.getElementById('scoring-progress').dataset.status === 'COMPLETED' && document.querySelectorAll('#scoring-results tr').length === 25")
                page.set_viewport_size({'width':1440, 'height':1100})
                page.locator('#btn-tab-library').click()
                for name in ['padded_24.flac', 'valid_cd.flac']:
                    page.locator(f'.track-row-checkbox[data-path="{name}"]').check()
                page.locator('#btn-batch-score').click()
                assert page.locator('#scoring-selected-count').text_content() == '2'
                page.wait_for_function("document.getElementById('scoring-progress').dataset.status === 'COMPLETED' && document.querySelectorAll('#scoring-results tr').length === 2", timeout=60000)
                assert not errors, errors
                (output/'browser-results.json').write_text(json.dumps({'page_errors': errors,
                    'batch_rows':len(rows), 'checks':['single padding','legacy audit','recursive batch','comparison',
                    'critical warning with N/A','JSON export','spectrogram','stream','track list','mobile no overflow',
                    'keyboard search','stale selection cleared','supplementary audit','lazy raw measurements','folder error retry',
                    'cancel scan','restore history','library selection scan']}, indent=2))
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
