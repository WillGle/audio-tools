import hashlib
import json
from pathlib import Path
import random
import string
import urllib.parse
import urllib.request
import urllib.error

SMART_PLAYLISTS_TEMPLATES = {
    "True_HiRes.nsp": {
        "name": "PCM tần số cao",
        "description": "Lọc theo tag định dạng PCM tần số cao; không xác minh nguồn master.",
        "content": {
            "all": [
                {"comment": {"contains": "[PCM sample rate cao]"}}
            ],
            "sort": "artist",
            "order": "asc"
        }
    },
    "Studio_Master_24bit.nsp": {
        "name": "Nhãn 24-bit cũ",
        "description": "Lọc tag [Studio Master] đã có từ phiên bản cũ; không xác nhận nguồn master.",
        "content": {
            "all": [
                {"comment": {"contains": "[Studio Master]"}}
            ],
            "sort": "artist",
            "order": "asc"
        }
    },
    "CD_Lossless_16_44.nsp": {
        "name": "💿 CD Lossless Chuẩn (16-bit / 44.1kHz)",
        "description": "Lọc nhạc Lossless chuẩn Redbook CD 16-bit 44.1kHz",
        "content": {
            "all": [
                {"bitDepth": {"is": 16}},
                {"sampleRate": {"is": 44100}}
            ],
            "sort": "artist",
            "order": "asc"
        }
    },
    "DSD_Direct.nsp": {
        "name": "⚡ DSD Direct (DSF / DFF)",
        "description": "Lọc toàn bộ file định dạng 1-bit DSD (Direct Stream Digital)",
        "content": {
            "all": [
                {"suffix": {"in": ["dsf", "dff"]}}
            ],
            "sort": "artist",
            "order": "asc"
        }
    },
    "Review_Needed.nsp": {
        "name": "Cần kiểm tra",
        "description": "Lọc tag cảnh báo toàn vẹn hoặc tag cần xem lại từ phiên bản cũ.",
        "content": {
            "any": [
                {"comment": {"contains": "[Lỗi toàn vẹn]"}},
                {"comment": {"contains": "[Fake Hi-Res]"}}
            ],
            "sort": "artist",
            "order": "asc"
        }
    }
}

def get_available_smart_playlists(vault_dir: Path):
    """Lấy danh sách các Smart Playlist định dạng .nsp cho Navidrome và trạng thái tồn tại."""
    playlists = []
    target_dir = Path(vault_dir)
    for filename, item in SMART_PLAYLISTS_TEMPLATES.items():
        file_path = target_dir / filename
        playlists.append({
            'filename': filename,
            'name': item['name'],
            'description': item['description'],
            'content': item['content'],
            'installed': file_path.exists(),
            'path': str(file_path)
        })
    return {'success': True, 'playlists': playlists, 'vault_dir': str(target_dir)}

def create_smart_playlists(vault_dir: Path, playlist_keys: list = None):
    """Tạo các file .nsp vào thư mục kho nhạc để Navidrome tự nhận diện Smart Playlists."""
    target_dir = Path(vault_dir)
    if not target_dir.exists():
        return {'success': False, 'message': f"Thư mục kho nhạc {target_dir} không tồn tại!"}
    
    created = []
    errors = []
    keys_to_process = playlist_keys if playlist_keys else list(SMART_PLAYLISTS_TEMPLATES.keys())
    
    for filename in keys_to_process:
        if filename not in SMART_PLAYLISTS_TEMPLATES:
            continue
        try:
            file_path = target_dir / filename
            data = SMART_PLAYLISTS_TEMPLATES[filename]['content']
            with open(file_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            created.append(filename)
        except Exception as e:
            errors.append(f"{filename}: {str(e)}")
            
    if errors:
        return {
            'success': False,
            'message': f"Tạo được {len(created)} playlists, lỗi {len(errors)}: {'; '.join(errors)}",
            'created': created
        }
    return {
        'success': True,
        'message': f"Đã cài đặt thành công {len(created)} Smart Playlists vào kho nhạc!",
        'created': created
    }


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
