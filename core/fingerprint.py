import os
import shutil
import subprocess
import json
from pathlib import Path
from typing import Dict, Any, Optional, List

def get_fpcalc_path() -> Optional[str]:
    """Tìm đường dẫn thực thi của công cụ fpcalc (Chromaprint)."""
    p = shutil.which('fpcalc')
    if p:
        return p
    # NixOS default store path fallback
    nix_candidates = [
        '/nix/store/3ixi5f34xanddj5qf2wzc5ibxhzpv3rw-chromaprint-1.6.0/bin/fpcalc',
        '/run/current-system/sw/bin/fpcalc'
    ]
    for cand in nix_candidates:
        if os.path.exists(cand):
            return cand
    return None

def get_audio_fingerprint(filepath: str) -> Dict[str, Any]:
    """
    Trích xuất dấu vân tay âm học (Acoustic Fingerprint) bằng Chromaprint/fpcalc.
    Cho phép nhận diện bài hát độc lập hoàn toàn với metadata hoặc tên file.
    """
    p = Path(filepath)
    if not p.is_file():
        return {'error': f'Tệp không tồn tại: {filepath}'}

    fpcalc_bin = get_fpcalc_path()
    if not fpcalc_bin:
        return {'error': 'Không tìm thấy tiện ích fpcalc trên hệ thống'}

    cmd = [fpcalc_bin, '-json', '-raw', str(p)]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        if res.returncode != 0:
            return {'error': f'fpcalc lỗi: {res.stderr.strip()}'}
        data = json.loads(res.stdout)
        fp_val = data.get('fingerprint', [])
        raw_ints = fp_val if isinstance(fp_val, list) else []

        return {
            'duration': float(data.get('duration', 0.0)),
            'raw_ints': raw_ints,
            'is_available': bool(raw_ints),
            'sample_count': len(raw_ints)
        }
    except Exception as e:
        return {'error': f'Lỗi trích xuất fingerprint: {str(e)}'}

def compare_fingerprints(fp1_raw: List[int], fp2_raw: List[int], max_shift: int = 15) -> float:
    """
    So sánh độ tương đồng âm thanh (Acoustic Match %) giữa 2 vân tay Chromaprint.
    Hỗ trợ căn chỉnh độ lệch pha/khoảng lặng mở đầu (lead-in shift alignment).
    Trả về tỷ lệ % khớp (0.0% đến 100.0%).
    Nếu match > 80%: Hai tệp chính là cùng một bản ghi âm (dù khác bitrate/format).
    """
    if not fp1_raw or not fp2_raw:
        return 0.0

    best_match = 0.0
    max_len = 350

    for shift in range(-max_shift, max_shift + 1):
        if shift >= 0:
            sub1 = fp1_raw[shift:]
            sub2 = fp2_raw
        else:
            sub1 = fp1_raw
            sub2 = fp2_raw[-shift:]
        l = min(len(sub1), len(sub2), max_len)
        if l < 20:
            continue
        diff_bits = sum((sub1[i] ^ sub2[i]).bit_count() for i in range(l))
        match_pct = (1.0 - (diff_bits / (l * 32))) * 100.0
        if match_pct > best_match:
            best_match = match_pct

    return round(max(0.0, min(100.0, best_match)), 1)

def compare_audio_files(path1: str, path2: str) -> float:
    """So sánh trực tiếp 2 tệp âm thanh xem có phải là bản ghi âm trùng lặp không."""
    fp1 = get_audio_fingerprint(path1)
    fp2 = get_audio_fingerprint(path2)
    raw1 = fp1.get('raw_ints', [])
    raw2 = fp2.get('raw_ints', [])
    return compare_fingerprints(raw1, raw2)

def lookup_acoustid_metadata(duration: float, fingerprint: str, api_key: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """
    Truy vấn thông tin bản quyền và Metadata chuẩn từ cơ sở dữ liệu MusicBrainz / AcoustID.
    """
    if not fingerprint or not duration:
        return None

    import requests
    import certifi

    key = api_key or os.environ.get('ACOUSTID_API_KEY', '')
    if not key:
        return None

    url = 'https://api.acoustid.org/v2/lookup'
    payload = {
        'client': key,
        'meta': 'recordings releasegroups',
        'duration': int(duration),
        'fingerprint': fingerprint
    }
    try:
        resp = requests.post(url, data=payload, timeout=8, verify=certifi.where())
        data = resp.json()
        if data.get('status') == 'ok' and data.get('results'):
            res = data['results'][0]
            recordings = res.get('recordings', [])
            if recordings:
                rec = recordings[0]
                artists = rec.get('artists', [{}])
                artist = artists[0].get('name', 'Unknown') if artists else 'Unknown'
                title = rec.get('title', 'Unknown')
                release_groups = rec.get('releasegroups', [])
                album = release_groups[0].get('title', '') if release_groups else ''
                return {
                    'title': title,
                    'artist': artist,
                    'album': album,
                    'score': res.get('score', 0.0),
                    'musicbrainz_id': rec.get('id', '')
                }
    except Exception:
        pass
    return None
