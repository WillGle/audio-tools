import hashlib
import json
import random
import string
import urllib.parse
import urllib.request
import urllib.error

def _build_auth_params(username, password):
    salt = ''.join(random.choices(string.ascii_letters + string.digits, k=12))
    token = hashlib.md5((password + salt).encode('utf-8')).hexdigest()
    return {
        'u': username,
        't': token,
        's': salt,
        'v': '1.16.1',
        'c': 'HiResVaultCompanion',
        'f': 'json'
    }

def test_navidrome_connection(server_url, username, password):
    url = server_url.rstrip('/') + '/rest/ping.view'
    params = _build_auth_params(username, password)
    full_url = f"{url}?{urllib.parse.urlencode(params)}"
    
    try:
        req = urllib.request.Request(full_url, headers={'User-Agent': 'HiResVaultCompanion/1.0'})
        with urllib.request.urlopen(req, timeout=8) as response:
            data = json.loads(response.read().decode('utf-8'))
            sub_resp = data.get('subsonic-response', {})
            status = sub_resp.get('status')
            if status == 'ok':
                return {
                    'success': True,
                    'message': f"Kết nối Navidrome thành công! Phiên bản Subsonic API: {sub_resp.get('version', '1.16.1')}",
                    'server_version': sub_resp.get('version')
                }
            else:
                err = sub_resp.get('error', {})
                return {
                    'success': False,
                    'message': f"Lỗi từ Navidrome: {err.get('message', 'Xác thực thất bại')} (Mã lỗi: {err.get('code')})"
                }
    except urllib.error.HTTPError as e:
        return {'success': False, 'message': f"Lỗi HTTP {e.code}: {e.reason}"}
    except Exception as e:
        return {'success': False, 'message': f"Không thể kết nối đến Navidrome tại {server_url}: {str(e)}"}

def trigger_navidrome_scan(server_url, username, password, full_scan=False):
    url = server_url.rstrip('/') + '/rest/startScan.view'
    params = _build_auth_params(username, password)
    if full_scan:
        params['fullScan'] = 'true'
        
    full_url = f"{url}?{urllib.parse.urlencode(params)}"
    try:
        req = urllib.request.Request(full_url, headers={'User-Agent': 'HiResVaultCompanion/1.0'})
        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode('utf-8'))
            sub_resp = data.get('subsonic-response', {})
            if sub_resp.get('status') == 'ok':
                scan_status = sub_resp.get('scanStatus', {})
                return {
                    'success': True,
                    'message': "Đã kích hoạt quét thư viện Navidrome thành công!",
                    'scanning': scan_status.get('scanning', True),
                    'count': scan_status.get('count', 0)
                }
            else:
                err = sub_resp.get('error', {})
                return {
                    'success': False,
                    'message': f"Lỗi yêu cầu quét: {err.get('message', 'Không thành công')}"
                }
    except Exception as e:
        return {'success': False, 'message': f"Lỗi khi gửi yêu cầu quét Navidrome: {str(e)}"}

def get_navidrome_scan_status(server_url, username, password):
    url = server_url.rstrip('/') + '/rest/getScanStatus.view'
    params = _build_auth_params(username, password)
    full_url = f"{url}?{urllib.parse.urlencode(params)}"
    try:
        req = urllib.request.Request(full_url, headers={'User-Agent': 'HiResVaultCompanion/1.0'})
        with urllib.request.urlopen(req, timeout=8) as response:
            data = json.loads(response.read().decode('utf-8'))
            sub_resp = data.get('subsonic-response', {})
            if sub_resp.get('status') == 'ok':
                scan_status = sub_resp.get('scanStatus', {})
                return {
                    'success': True,
                    'scanning': scan_status.get('scanning', False),
                    'count': scan_status.get('count', 0)
                }
            return {'success': False, 'scanning': False, 'count': 0}
    except Exception as e:
        return {'success': False, 'error': str(e), 'scanning': False, 'count': 0}
