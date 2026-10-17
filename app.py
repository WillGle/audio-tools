import os
import sys
import json
import shutil
from pathlib import Path
from typing import Optional, List
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

# Add current folder to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from core.analyzer import analyze_audio_file, generate_spectrogram_image
from core.paths import vault_path
from core.navidrome_config import read_config, resolve_config, public_config, write_config
from core.tagger import apply_quality_tag
from core.dedup import scan_duplicates, get_metadata_duplicates_map
from core.navidrome import (
    test_navidrome_connection,
    trigger_navidrome_scan,
    get_navidrome_scan_status,
    get_available_smart_playlists,
    create_smart_playlists
)
import time
from threading import Lock

_verdict_lock = Lock()

_dupe_map_cache = None
_dupe_map_time = 0

def get_cached_dupe_map():
    global _dupe_map_cache, _dupe_map_time
    now = time.time()
    if _dupe_map_cache is None or (now - _dupe_map_time) > 15:
        dupe_map, count = get_metadata_duplicates_map(ROOT_DIR)
        _dupe_map_cache = (dupe_map, count)
        _dupe_map_time = now
    return _dupe_map_cache

app = FastAPI(
    title="Hi-Res Vault Companion for Navidrome",
    description="Web App kiểm định chuẩn Hi-Res, phân loại thư viện và tích hợp Navidrome",
    version="1.0.0"
)

@app.middleware("http")
async def add_no_cache_headers(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.endswith((".html", ".js", ".css")):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

TOOLS_DIR = Path(__file__).resolve().parent
ROOT_DIR = Path(os.environ.get('HIRES_VAULT_DIR', '/mnt/vault/GleVault/Hires')).resolve()
CACHE_DIR = Path(os.environ.get('AUDIO_TOOLS_CACHE_DIR', str(TOOLS_DIR / 'cache')))
CACHE_DIR.mkdir(parents=True, exist_ok=True)
SPECTROGRAM_CACHE = CACHE_DIR / 'spectrograms'
SPECTROGRAM_CACHE.mkdir(parents=True, exist_ok=True)

from core.audio_scoring.service import AnalysisService
from core.audio_scoring.api import scoring_router
from core.audio_scoring.legacy import dashboard_fields, cached_record_current
scoring_service = AnalysisService(ROOT_DIR, CACHE_DIR / 'audio_scoring.sqlite')
app.include_router(scoring_router(scoring_service))

# Cache file kết quả kiểm định
VERDICTS_CACHE_FILE = CACHE_DIR / 'hires_verdicts.json'
METADATA_CACHE_FILE = CACHE_DIR / 'metadata_results.json'

def audio_path(value):
    try:
        path = vault_path(ROOT_DIR, value)
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Không tìm thấy tệp âm thanh")
    if path.suffix.lower() not in AUDIO_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Định dạng âm thanh không hỗ trợ")
    return path


class NavidromeConfig(BaseModel):
    server_url: Optional[str] = None
    username: Optional[str] = None
    password: Optional[str] = None
    full_scan: Optional[bool] = False

class AnalyzeRequest(BaseModel):
    filepath: str

class TagRequest(BaseModel):
    filepath: Optional[str] = None
    tag_all: Optional[bool] = False
    navidrome_config: Optional[NavidromeConfig] = None

class SmartPlaylistsRequest(BaseModel):
    playlists: Optional[List[str]] = None
    navidrome_config: Optional[NavidromeConfig] = None

VERDICT_FILTERS = {
    'true_hires': 'FORMAT_HIRES', 'true_dsd': 'DSD_SOURCE_UNVERIFIED', 'dsd': 'DSD_SOURCE_UNVERIFIED',
    'studio_master': 'REVIEW', 'cd_lossless': 'CD_LOSSLESS',
    'fake_hires': 'INTEGRITY_FAIL', 'fake_lossless': 'FAKE_LOSSLESS',
    'lossy': 'LOSSY', 'suspicious': 'REVIEW', 'unverified': 'UNKNOWN'
}


def save_verdict(result):
    with _verdict_lock:
        records = []
        if VERDICTS_CACHE_FILE.exists():
            records = json.loads(VERDICTS_CACHE_FILE.read_text(encoding='utf-8'))
        records = [item for item in records if item.get('filepath') != result['filepath']]
        records.append({k: v for k, v in result.items() if k != 'authenticity'})
        temp = VERDICTS_CACHE_FILE.with_suffix('.tmp')
        temp.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding='utf-8')
        temp.replace(VERDICTS_CACHE_FILE)


def cached_by_path(cache_file, path_key):
    try:
        records = json.loads(cache_file.read_text(encoding='utf-8'))
    except (ValueError, OSError):
        return {}
    result = {}
    for record in records:
        if cache_file == VERDICTS_CACHE_FILE and not record.get('scoring_version'):
            continue
        try:
            path = vault_path(ROOT_DIR, record[path_key])
            if cache_file == VERDICTS_CACHE_FILE and not cached_record_current(record, path):
                continue
        except (KeyError, ValueError, OSError):
            continue
        result[str(path)] = record
    return result


def _read_library_items():
    from organize_library import process_file_metadata
    from core.dedup import IGNORE_DIRS
    import os

    by_path = cached_by_path(VERDICTS_CACHE_FILE, 'filepath')
    specs_by_path = cached_by_path(METADATA_CACHE_FILE, 'path')
    items = []
    for directory, dirs, files in os.walk(ROOT_DIR):
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS and not d.startswith('.')]
        for name in files:
            path = Path(directory) / name
            if path.suffix.lower() not in AUDIO_EXTENSIONS:
                continue
            try:
                resolved = vault_path(ROOT_DIR, path)
                if not resolved.is_file():
                    continue
            except (ValueError, OSError):
                continue
            meta = process_file_metadata(str(resolved), specs_by_path, by_path)
            verdict = by_path.get(str(resolved), {}).get('verdict', 'UNKNOWN')
            source = 'audit' if verdict != 'UNKNOWN' else 'unknown'
            if verdict == 'UNKNOWN' and meta['metadata_available']:
                if 'dsd' in meta['codec'].lower() or path.suffix.lower() in ('.dsf', '.dff'):
                    verdict, source = 'DSD_SOURCE_UNVERIFIED', 'metadata'
                elif meta['sr'] > 48000 and meta['codec'].lower() not in ('mp3', 'aac', 'opus', 'vorbis'):
                    verdict, source = 'FORMAT_HIRES', 'metadata'
                elif meta['tier'] == '02_Lossless_CD':
                    verdict, source = 'CD_LOSSLESS', 'metadata'
                elif meta['codec'].lower() in ('mp3', 'aac', 'vorbis', 'opus', 'wmav1', 'wmav2', 'wmapro', 'ac3', 'eac3'):
                    verdict, source = 'LOSSY', 'metadata'
            items.append({
                'original_path': str(path.relative_to(ROOT_DIR)),
                'tier': meta['tier'], 'title': meta['title'] or path.stem,
                'artist': meta['artist'] or 'Unknown Artist',
                'album': meta['album'] or 'Singles',
                'specs': f"{meta['codec'].upper()} {meta['bits']}bit/{meta['sr']/1000:.1f}kHz",
                'verdict': verdict, 'verdict_source': source
            })
    return sorted(items, key=lambda item: item['original_path'])


_library_lock = Lock()
_library_snapshot = None
_library_snapshot_key = None
_library_snapshot_time = 0


def invalidate_library():
    global _library_snapshot, _dupe_map_cache
    with _library_lock:
        _library_snapshot = None
        _dupe_map_cache = None


def library_items():
    global _library_snapshot, _library_snapshot_key, _library_snapshot_time
    def stamp(path):
        try:
            stat = path.stat()
            return (stat.st_mtime_ns, stat.st_size)
        except OSError:
            return None
    key = (str(ROOT_DIR), stamp(ROOT_DIR), stamp(VERDICTS_CACHE_FILE), stamp(METADATA_CACHE_FILE))
    with _library_lock:
        if _library_snapshot is None or key != _library_snapshot_key or time.monotonic() - _library_snapshot_time > 15:
            _library_snapshot = _read_library_items()
            _library_snapshot_key = key
            _library_snapshot_time = time.monotonic()
        return _library_snapshot


@app.post('/api/library/refresh')
def refresh_library():
    invalidate_library()
    return {'success': True}


@app.get("/api/stats")
def get_library_stats():
    items = library_items()
    verdict_counts = {'total': len(items)}
    for key, verdict in VERDICT_FILTERS.items():
        if key == 'dsd':
            continue
        verdict_counts[key] = sum(item['verdict'] == verdict for item in items)
    try:
        dupe_map, dupe_groups = get_cached_dupe_map()
        verdict_counts['duplicate_meta'] = len(dupe_map)
        verdict_counts['duplicate_meta_groups'] = dupe_groups
    except Exception:
        verdict_counts['duplicate_meta'] = 0
        verdict_counts['duplicate_meta_groups'] = 0
    return {'root_directory': str(ROOT_DIR), 'counts': verdict_counts, 'status': 'Ready'}


@app.get('/api/quality-result')
def quality_result(filepath: str):
    path = audio_path(filepath)
    result = scoring_service.saved_result(str(path.relative_to(ROOT_DIR)))
    if not result:
        raise HTTPException(409, 'Kết quả chưa có hoặc đã cũ. Hãy kiểm tra lại tệp.')
    return result


@app.get('/api/quality-dashboard')
def quality_dashboard(category: str = 'all', offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=200)):
    from core.audio_scoring import engine_signature
    from core.audio_scoring.tools import is_lossless

    categories = ('hires', 'upsample', 'low_quality', 'standard', 'review', 'unchecked')
    if category not in ('all', *categories):
        raise HTTPException(400, 'Nhóm kết quả không hợp lệ')
    results = scoring_service.dashboard_results()
    counts = dict.fromkeys(categories, 0)
    rows = []
    signature = engine_signature()
    for item in library_items():
        path = item['original_path']
        result = results.get(path)
        if result:
            try:
                stat = vault_path(ROOT_DIR, path).stat()
                current = result.get('file_stat') == {'size_bytes': stat.st_size, 'mtime_ns': stat.st_mtime_ns, 'ctime_ns': stat.st_ctime_ns}
            except (ValueError, OSError):
                current = False
            if not current or result.get('engine_signature') != signature or result.get('rule_version') != scoring_service.config['version']:
                result = None
        group = 'unchecked'
        if result:
            rules = result['rules']
            specs = result['claims']['container_assertions']
            if result['critical_failure'] or rules['signal_defects']['status'] == 'SUSPECT' or any(rules[key]['status'] == 'FAIL' for key in rules):
                group = 'low_quality'
            elif rules['sample_rate']['measurements'].get('resampling_evidence'):
                group = 'upsample'
            elif specs.get('codec') and not is_lossless(specs['codec']) and specs['codec'] in {'mp3', 'aac', 'opus', 'vorbis', 'wmav1', 'wmav2', 'wmapro', 'ac3', 'eac3'}:
                group = 'low_quality'
            elif result['preliminary'] or any(rule['status'] in ('REVIEW', 'SUSPECT') for rule in rules.values()):
                group = 'review'
            else:
                group = 'hires' if is_lossless(specs.get('codec', '')) and specs.get('sample_rate', 0) > 48000 and specs.get('bit_depth', 0) > 16 else 'standard'
        counts[group] += 1
        if category in ('all', group):
            rows.append({**item, 'category': group, 'score': result['score'] if result else None})
    total = sum(counts.values())
    return {'total': total, 'counts': counts, 'matched': len(rows), 'offset': offset,
            'files': rows[offset:offset + limit]}


@app.get("/api/tracks")
def get_tracks(
    filter: str = Query('all'),
    search: Optional[str] = None,
    col_title: Optional[str] = None,
    col_artist: Optional[str] = None,
    col_album: Optional[str] = None,
    col_format: Optional[str] = None,
    col_verdict: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_dir: Optional[str] = 'asc',
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0)
):
    items = library_items()

    try:
        dupe_map, _ = get_cached_dupe_map()
    except Exception:
        dupe_map = {}
            
    filtered = []
    for it in items:
        tier = it.get('tier', '')
        specs = it.get('specs', '')
        orig_p = it.get('original_path', '')
        title = it.get('title', '')
        artist = it.get('artist', '')
        album = it.get('album', '')
        is_dupe = orig_p in dupe_map

        # 1. Global category filter (stat cards / top pills)
        if filter == 'duplicate_meta':
            if not is_dupe:
                continue
        elif filter in VERDICT_FILTERS and it['verdict'] != VERDICT_FILTERS[filter]:
            continue
            
        # 2. Global search check
        if search:
            q = search.lower()
            text = f"{orig_p} {artist} {title} {album} {specs}".lower()
            if q not in text:
                continue

        # 3. Column-specific search & filter
        if col_title:
            q_title = col_title.strip().lower()
            if q_title not in title.lower() and q_title not in orig_p.lower():
                continue

        if col_artist:
            q_artist = col_artist.strip().lower()
            if q_artist not in artist.lower():
                continue

        if col_album:
            q_album = col_album.strip().lower()
            if q_album not in album.lower():
                continue

        if col_format:
            fmt = col_format.strip().lower()
            specs_lower = specs.lower()
            orig_lower = orig_p.lower()
            if fmt == 'flac':
                if not (orig_lower.endswith('.flac') or 'flac' in specs_lower):
                    continue
            elif fmt == 'dsd':
                if not (orig_lower.endswith(('.dsf', '.dff')) or 'dsd' in specs_lower):
                    continue
            elif fmt == 'mp3':
                if not (orig_lower.endswith('.mp3') or 'mp3' in specs_lower):
                    continue
            elif fmt in ('m4a', 'aac'):
                if not (orig_lower.endswith(('.m4a', '.aac')) or 'aac' in specs_lower or 'alac' in specs_lower):
                    continue
            elif fmt == 'wav':
                if not (orig_lower.endswith('.wav') or 'wav' in specs_lower):
                    continue
            elif fmt == '24bit':
                if '24bit' not in specs_lower:
                    continue
            elif fmt == '16bit':
                if '16bit' not in specs_lower:
                    continue
            else:
                if fmt not in specs_lower and fmt not in orig_lower:
                    continue

        if col_verdict:
            verd = col_verdict.strip().lower()
            if verd == 'duplicate_meta':
                if not is_dupe:
                    continue
            elif verd in VERDICT_FILTERS and it['verdict'] != VERDICT_FILTERS[verd]:
                continue

        item_copy = dict(it)
        if is_dupe:
            d_info = dupe_map[orig_p]
            item_copy['is_duplicate_meta'] = True
            item_copy['dupe_group_id'] = d_info['group_id']
            item_copy['dupe_group_title'] = d_info['group_title']
            item_copy['dupe_count'] = d_info['dupe_count']
            item_copy['dupe_status'] = d_info['dupe_status']
            item_copy['recommended_keep'] = d_info['recommended_keep']
        else:
            item_copy['is_duplicate_meta'] = False
            item_copy['dupe_count'] = 0
            item_copy['dupe_status'] = 'normal'
            item_copy['dupe_group_id'] = None

        filtered.append(item_copy)

    # 4. Sorting
    if sort_by:
        reverse = (sort_dir == 'desc')
        if sort_by == 'title':
            filtered.sort(key=lambda x: (x.get('title') or x.get('original_path', '')).lower(), reverse=reverse)
        elif sort_by == 'artist':
            filtered.sort(key=lambda x: (x.get('artist') or '').lower(), reverse=reverse)
        elif sort_by == 'album':
            filtered.sort(key=lambda x: (x.get('album') or '').lower(), reverse=reverse)
        elif sort_by == 'format':
            filtered.sort(key=lambda x: (x.get('specs') or '').lower(), reverse=reverse)
        elif sort_by == 'verdict':
            filtered.sort(key=lambda x: (x.get('tier') or '').lower(), reverse=reverse)
        elif sort_by == 'index':
            if reverse:
                filtered.reverse()

    total_count = len(filtered)
    page_items = filtered[offset : offset + limit]
    
    return {
        'total': total_count,
        'offset': offset,
        'limit': limit,
        'tracks': page_items
    }

@app.post("/api/analyze")
def analyze_track(req: AnalyzeRequest):
    p = audio_path(req.filepath)
        
    res = dashboard_fields(scoring_service.single(str(p)))['spectrum']
    res['filepath'] = str(p)
    save_verdict(res)
    return res

@app.get("/api/spectrogram")
def get_spectrogram(filepath: str):
    p = audio_path(filepath)
        
    from core.audio_scoring.tools import file_hash
    cache_name = f"spec_v2_{file_hash(p)}.png"
    out_png = SPECTROGRAM_CACHE / cache_name
    
    if not out_png.exists():
        success = generate_spectrogram_image(str(p), str(out_png))
        if not success or not out_png.exists():
            raise HTTPException(status_code=500, detail="Không thể tạo biểu đồ spectrogram")
            
    return FileResponse(out_png, media_type="image/png")

@app.get("/api/stream")
def stream_audio(filepath: str):
    p = audio_path(filepath)

    ext = p.suffix.lower()

    # DSD formats (.dsf, .dff): transcode on-the-fly to 24-bit PCM WAV for browser playback
    if ext in ['.dsf', '.dff']:
        import subprocess
        cmd = [
            'ffmpeg', '-v', 'error',
            '-i', str(p),
            '-f', 'wav',
            '-ar', '48000',
            '-acodec', 'pcm_s24le',
            'pipe:1'
        ]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        def iter_proc():
            try:
                while True:
                    chunk = proc.stdout.read(64 * 1024)
                    if not chunk:
                        break
                    yield chunk
            finally:
                proc.stdout.close()
                proc.kill()
        return StreamingResponse(iter_proc(), media_type="audio/wav")

    mime_map = {
        '.flac': 'audio/flac',
        '.mp3': 'audio/mpeg',
        '.m4a': 'audio/mp4',
        '.aac': 'audio/aac',
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',
        '.opus': 'audio/opus',
        '.aif': 'audio/aiff',
        '.aiff': 'audio/aiff'
    }
    media_type = mime_map.get(ext, 'application/octet-stream')
    return FileResponse(
        str(p),
        media_type=media_type,
        headers={"Accept-Ranges": "bytes"}
    )

def connection_config(cfg=None):
    return resolve_config(CACHE_DIR, cfg.model_dump() if cfg else None)


def request_navidrome_scan(cfg=None, full_scan=False):
    config = connection_config(cfg)
    if not config.get('server_url'):
        return None
    try:
        return trigger_navidrome_scan(config['server_url'], config.get('username') or '',
                                     config.get('password') or '', full_scan)
    except Exception:
        return {'success': False, 'message': 'Không thể yêu cầu Navidrome cập nhật. Thay đổi cục bộ vẫn được giữ.'}


def finish_library_change(result, changed, cfg=None):
    # A partial batch still needs a refresh for the files that changed.
    if changed:
        invalidate_library()
    result['navidrome_scan'] = request_navidrome_scan(cfg) if changed else None
    return result


@app.get('/api/navidrome/config')
def navidrome_config_status():
    return public_config(read_config(CACHE_DIR))


@app.post('/api/navidrome/config')
def save_navidrome_config(cfg: NavidromeConfig):
    try:
        return write_config(CACHE_DIR, cfg.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.delete('/api/navidrome/config')
def disconnect_navidrome():
    (CACHE_DIR / 'navidrome.json').unlink(missing_ok=True)
    return public_config({})


@app.post('/api/navidrome/test')
def test_navidrome(cfg: Optional[NavidromeConfig] = None):
    config = connection_config(cfg)
    if not config.get('server_url'):
        return {'success': False, 'message': 'Chưa cấu hình Navidrome.'}
    return test_navidrome_connection(config['server_url'], config.get('username') or '', config.get('password') or '')


@app.post('/api/navidrome/scan')
def trigger_scan(cfg: Optional[NavidromeConfig] = None):
    return request_navidrome_scan(cfg, bool(cfg and cfg.full_scan)) or {'success': False, 'message': 'Chưa cấu hình Navidrome.'}


@app.post('/api/navidrome/scan-status')
def scan_status():
    config = connection_config()
    if not config.get('server_url'):
        return {'success': False, 'scanning': False, 'message': 'Chưa cấu hình Navidrome.'}
    return get_navidrome_scan_status(config['server_url'], config.get('username') or '', config.get('password') or '')

@app.get("/api/navidrome/smart-playlists")
def get_smart_playlists():
    return get_available_smart_playlists(ROOT_DIR)

@app.post("/api/navidrome/smart-playlists/install")
def install_smart_playlists(req: Optional[SmartPlaylistsRequest] = None):
    keys = req.playlists if req else None
    res = create_smart_playlists(ROOT_DIR, keys)
    scan_res = request_navidrome_scan(req.navidrome_config if req else None) if res.get('created') else None
    res['navidrome_scan'] = scan_res
    return res

@app.post("/api/tag/single")
def tag_single_file(req: TagRequest):
    if not req.filepath:
        raise HTTPException(status_code=400, detail="Cần cung cấp filepath")
    p = audio_path(req.filepath)
        
    analysis = analyze_audio_file(str(p))
    ok, msg = apply_quality_tag(str(p), analysis)
    
    # Trigger Navidrome scan nếu có config
    if ok:
        invalidate_library()
    scan_res = request_navidrome_scan(req.navidrome_config) if ok else None
        
    return {
        'success': ok,
        'message': msg,
        'analysis': analysis,
        'navidrome_scan': scan_res
    }

@app.post("/api/organize/dry-run")
def organize_dry_run():
    script = TOOLS_DIR / 'organize_library.py'
    import subprocess
    cmd = [sys.executable, str(script), '--dry-run', str(ROOT_DIR)]
    res = subprocess.run(cmd, cwd=str(ROOT_DIR), capture_output=True, text=True)
    return {
        'success': res.returncode == 0,
        'output': res.stdout,
        'error': res.stderr
    }


_organize_lock = Lock()
_organize_plan_file = CACHE_DIR / 'metadata_organize_plan.json'


class OrganizeRequest(BaseModel):
    folder: str = ''
    plan_id: str = ''
    filename_format: str = '{track} - {title}'


@app.post('/api/organize/preview')
def preview_metadata_organization(req: OrganizeRequest):
    from core.organizer import metadata_plan
    from uuid import uuid4
    with _organize_lock:
        try:
            plan = metadata_plan(ROOT_DIR, req.folder, req.filename_format)
        except (ValueError, OSError) as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        plan['plan_id'] = uuid4().hex
        temp = _organize_plan_file.with_suffix('.tmp')
        temp.write_text(json.dumps(plan, ensure_ascii=False), encoding='utf-8')
        temp.replace(_organize_plan_file)
        return plan


class OrganizeEditRequest(BaseModel):
    plan_id: str
    original_path: str
    filename: str


@app.post('/api/organize/edit')
def edit_metadata_organization(req: OrganizeEditRequest):
    from core.organizer import edit_proposed_filename
    from uuid import uuid4
    with _organize_lock:
        if not _organize_plan_file.exists():
            raise HTTPException(status_code=409, detail='Hãy tạo bản xem trước mới.')
        plan = json.loads(_organize_plan_file.read_text(encoding='utf-8'))
        if not req.plan_id or plan['plan_id'] != req.plan_id:
            raise HTTPException(status_code=409, detail='Bản xem trước đã thay đổi. Hãy xem lại trước khi áp dụng.')
        try:
            edit_proposed_filename(ROOT_DIR, plan, req.original_path, req.filename)
        except (ValueError, OSError) as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        plan['plan_id'] = uuid4().hex
        temp = _organize_plan_file.with_suffix('.tmp')
        temp.write_text(json.dumps(plan, ensure_ascii=False), encoding='utf-8')
        temp.replace(_organize_plan_file)
        return plan


@app.post('/api/organize/apply')
def apply_metadata_organization(req: OrganizeRequest):
    from core.organizer import file_stamp, ROLLBACK_NAME
    with _organize_lock:
        if not _organize_plan_file.exists():
            raise HTTPException(status_code=409, detail='Hãy tạo bản xem trước mới.')
        plan = json.loads(_organize_plan_file.read_text(encoding='utf-8'))
        if not req.plan_id or plan['plan_id'] != req.plan_id:
            raise HTTPException(status_code=409, detail='Bản xem trước đã thay đổi. Hãy xem lại trước khi áp dụng.')
        ready = [item for item in plan['items'] if item['status'] == 'READY']
        try:
            for item in ready:
                path = audio_path(item['original_path'])
                if file_stamp(path) != item['stamp']:
                    raise ValueError('Tệp nguồn đã thay đổi; hãy tạo bản xem trước mới.')
                dest = vault_path(ROOT_DIR, item['dest_path'])
                if dest.exists() or dest.is_symlink():
                    raise ValueError('Đích đã tồn tại; hãy tạo bản xem trước mới.')
        except (ValueError, OSError) as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        result = execute_tiering(ROOT_DIR, ready, mode='move', rollback_name=ROLLBACK_NAME)
        _organize_plan_file.unlink(missing_ok=True)
        global _dupe_map_cache
        _dupe_map_cache = None
        return finish_library_change(result, result.get('success_count', 0))


@app.post('/api/organize/rollback')
def undo_metadata_organization():
    from core.organizer import ROLLBACK_NAME
    with _organize_lock:
        result = rollback_vault_tiering(ROOT_DIR, rollback_name=ROLLBACK_NAME)
        _organize_plan_file.unlink(missing_ok=True)
        global _dupe_map_cache
        _dupe_map_cache = None
        return finish_library_change(result, result.get('restored_count', 0))

@app.get("/api/duplicates")
def get_duplicates_report(refresh: bool = False):
    dupes = scan_duplicates(ROOT_DIR, force_refresh=refresh)
    return dupes

class ArchiveDupesRequest(BaseModel):
    files_to_archive: Optional[List[str]] = None

@app.post("/api/duplicates/archive-byte-dupes")
def archive_byte_duplicates(payload: Optional[ArchiveDupesRequest] = None):
    archive_dir = vault_path(ROOT_DIR, '_Duplicates_Archive')
    archive_dir.mkdir(parents=True, exist_ok=True)
    
    files_to_move = []
    if payload and payload.files_to_archive is not None:
        files_to_move = payload.files_to_archive
    else:
        dupes = scan_duplicates(ROOT_DIR)
        byte_dupes = dupes.get('byte_duplicates', [])
        for grp in byte_dupes:
            files = grp.get('files', [])
            # Giữ lại file đầu tiên (đã được score_file_for_keeping xếp hạng cao nhất), chuyển các bản sau
            files_to_move.extend(files[1:])
            
    archived_count = 0
    moved_paths = []
    sources = [audio_path(value) for value in files_to_move]
    for src in sources:
        f_rel = str(src.relative_to(ROOT_DIR.resolve()))
        if src.exists() and src.is_file():
            # Giữ nguyên cấu trúc thư mục tương đối bên trong _Duplicates_Archive
            dst = vault_path(archive_dir, f_rel)
            dst.parent.mkdir(parents=True, exist_ok=True)
            if dst.exists():
                counter = 1
                while dst.exists():
                    dst = dst.parent / f"{dst.stem}_{counter}{dst.suffix}"
                    counter += 1
            try:
                shutil.move(src, dst)
                archived_count += 1
                moved_paths.append(f_rel)
            except Exception as e:
                print(f"Lỗi di chuyển {src} -> {dst}: {e}")

    # Xóa các file đã chuyển khỏi SQLite cache để lần sau quét cực nhanh
    if moved_paths:
        try:
            from core.dedup import get_cache_db
            conn = get_cache_db(ROOT_DIR)
            c = conn.cursor()
            c.executemany("DELETE FROM file_cache WHERE path = ?", [(p,) for p in moved_paths])
            conn.commit()
            conn.close()
        except Exception:
            pass

    return finish_library_change({
        'success': True,
        'message': f"Đã di chuyển an toàn {archived_count} tệp trùng lặp vào thư mục '_Duplicates_Archive/' (bảo toàn cấu trúc thư mục gốc)!",
        'archived_count': archived_count
    }, archived_count)

# ==============================================================================
# 7 AUDIOPHILE PILLARS & VAULT TIERING ENDPOINTS
# ==============================================================================
from core.audiophile_engine import run_full_audiophile_audit, audit_album_gapless_and_dr
from core.tagger import apply_audiophile_tags, revert_audiophile_tags, rollback_all_audiophile_tags
from core.vault_tiering import AUDIO_EXTENSIONS, scan_and_generate_tiering_plan, execute_tiering, rollback_vault_tiering
from core.fingerprint import compare_audio_files, get_audio_fingerprint

class CompareFingerprintRequest(BaseModel):
    file1: str
    file2: str

@app.post("/api/fingerprint/compare")
def compare_fingerprints_endpoint(req: CompareFingerprintRequest):
    p1 = audio_path(req.file1)
    p2 = audio_path(req.file2)

    match_pct = compare_audio_files(str(p1), str(p2))
    is_identical = match_pct >= 80.0
    
    if match_pct >= 90.0:
        badge = f"🟢 Trùng Âm Học Tuyệt Đối ({match_pct}%)"
        badge_color = "#10b981"
        verdict = "IDENTICAL_RECORDING"
        explanation = "Hai tệp là cùng một bản ghi âm gốc (khớp vân tay Chromaprint tuyệt đối)."
    elif match_pct >= 80.0:
        badge = f"🟢 Trùng Bản Thu ({match_pct}%)"
        badge_color = "#06b6d4"
        verdict = "SAME_RECORDING_VARIATION"
        explanation = "Cùng một bản thu, có thể khác master, bitrate hoặc nén âm lượng."
    elif match_pct >= 60.0:
        badge = f"🟡 Tương Đồng Một Phần ({match_pct}%)"
        badge_color = "#eab308"
        verdict = "SIMILAR_RECORDING"
        explanation = "Có đoạn tương đồng (bản live khác hoặc remix)."
    else:
        badge = f"⚪ Khác Bản Thu ({match_pct}%)"
        badge_color = "#94a3b8"
        verdict = "DIFFERENT_RECORDING"
        explanation = "Nội dung âm thanh khác biệt hoàn toàn."

    return {
        'file1': req.file1,
        'file2': req.file2,
        'match_pct': match_pct,
        'is_identical': is_identical,
        'verdict': verdict,
        'badge': badge,
        'badge_color': badge_color,
        'explanation': explanation
    }

@app.get("/api/fingerprint/info")
def get_fingerprint_info(filepath: str):
    p = audio_path(filepath)

    fp_res = get_audio_fingerprint(str(p))
    return {
        'filepath': filepath,
        'filename': p.name,
        'is_available': fp_res.get('is_available', False),
        'duration': fp_res.get('duration', 0.0),
        'sample_count': fp_res.get('sample_count', 0),
        'error': fp_res.get('error')
    }

class AudiophileAuditRequest(BaseModel):
    filepath: str

class AudiophileAlbumAuditRequest(BaseModel):
    track_paths: List[str]

class AudiophileTagRequest(BaseModel):
    defer_scan: bool = False
    filepath: str
    audit_data: Optional[dict] = None
    navidrome_config: Optional[NavidromeConfig] = None

class TagRollbackRequest(BaseModel):
    filepath: str
    navidrome_config: Optional[NavidromeConfig] = None

class TagRollbackAllRequest(BaseModel):
    navidrome_config: Optional[NavidromeConfig] = None

class BatchTagRequest(BaseModel):
    filepaths: List[str]
    navidrome_config: Optional[NavidromeConfig] = None

class TieringExecuteRequest(BaseModel):
    mode: str = 'symlink' # 'symlink' or 'move'
    plan_items: Optional[List[dict]] = None

@app.post("/api/audiophile/audit")
def audiophile_audit(req: AudiophileAuditRequest):
    p = audio_path(req.filepath)

    try:
        res = run_full_audiophile_audit(str(p), scoring=scoring_service.single(str(p)))
        if res.get('spectrum'):
            save_verdict(res['spectrum'])
        return res
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Lỗi phân tích Audiophile: {str(e)}")

@app.post("/api/audiophile/audit-album")
def audiophile_album_audit(req: AudiophileAlbumAuditRequest):
    full_paths = []
    for fp in req.track_paths:
        full_paths.append(str(audio_path(fp)))

    if not full_paths:
        raise HTTPException(status_code=400, detail="Không tìm thấy tệp âm thanh hợp lệ trong danh sách")

    try:
        res = audit_album_gapless_and_dr(full_paths)
        return res
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Lỗi phân tích Album: {str(e)}")

@app.post("/api/audiophile/tag")
def audiophile_apply_tags(req: AudiophileTagRequest):
    p = audio_path(req.filepath)

    audit = req.audit_data
    if not audit:
        audit = run_full_audiophile_audit(str(p), scoring=scoring_service.single(str(p)))

    ok, msg = apply_audiophile_tags(str(p), audit)

    if ok:
        invalidate_library()
    scan_res = request_navidrome_scan(req.navidrome_config) if ok and not req.defer_scan else None

    return {
        'success': ok,
        'message': msg,
        'audit': audit,
        'navidrome_scan': scan_res
    }

@app.post("/api/audiophile/tag/rollback")
def audiophile_rollback_tags(req: TagRollbackRequest):
    p = audio_path(req.filepath)

    ok, msg = revert_audiophile_tags(str(p))

    if ok:
        invalidate_library()
    scan_res = request_navidrome_scan(req.navidrome_config) if ok else None

    return {
        'success': ok,
        'message': msg,
        'navidrome_scan': scan_res
    }

@app.post("/api/audiophile/tag/rollback-all")
def audiophile_rollback_all_tags(req: Optional[TagRollbackAllRequest] = None):
    try:
        count, paths = rollback_all_audiophile_tags(ROOT_DIR)
        if count:
            invalidate_library()
        scan_res = request_navidrome_scan(req.navidrome_config if req else None) if count else None
        return {
            'success': True,
            'reverted_count': count,
            'message': f"Đã hoàn tác và khôi phục metadata gốc cho {count} bài hát!",
            'navidrome_scan': scan_res
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Lỗi hoàn tác toàn bộ tag: {str(e)}")

@app.post("/api/tag/batch")
def batch_tag_files(req: BatchTagRequest):
    results = []
    success_count = 0
    for fp in req.filepaths:
        try:
            p = audio_path(fp)
            analysis = analyze_audio_file(str(p))
            ok, msg = apply_quality_tag(str(p), analysis)
            if ok:
                success_count += 1
            results.append({"filepath": fp, "success": ok, "message": msg})
        except Exception as e:
            results.append({"filepath": fp, "success": False, "message": str(e)})

    if success_count:
        invalidate_library()
    scan_res = request_navidrome_scan(req.navidrome_config) if success_count else None

    return {
        "success": True,
        "total": len(req.filepaths),
        "tagged_count": success_count,
        "results": results,
        "navidrome_scan": scan_res
    }

@app.post("/api/audiophile/tag/batch")
def batch_audiophile_tag(req: BatchTagRequest):
    results = []
    success_count = 0
    for fp in req.filepaths:
        try:
            p = audio_path(fp)
            audit = run_full_audiophile_audit(str(p), scoring=scoring_service.single(str(p)))
            ok, msg = apply_audiophile_tags(str(p), audit)
            if ok:
                success_count += 1
            results.append({"filepath": fp, "success": ok, "message": msg})
        except Exception as e:
            results.append({"filepath": fp, "success": False, "message": str(e)})

    if success_count:
        invalidate_library()
    scan_res = request_navidrome_scan(req.navidrome_config) if success_count else None

    return {
        "success": True,
        "total": len(req.filepaths),
        "tagged_count": success_count,
        "results": results,
        "navidrome_scan": scan_res
    }

@app.get("/api/vault/tiering/plan")
def get_vault_tiering_plan():
    try:
        plan = scan_and_generate_tiering_plan(ROOT_DIR, TOOLS_DIR)
        return plan
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Lỗi tạo kế hoạch Vault Tiering: {str(e)}")

@app.post("/api/vault/tiering/execute")
def execute_vault_tiering(req: TieringExecuteRequest):
    plan_items = req.plan_items
    if not plan_items:
        plan = scan_and_generate_tiering_plan(ROOT_DIR, TOOLS_DIR)
        plan_items = plan.get('items', [])

    try:
        res = execute_tiering(ROOT_DIR, plan_items, mode=req.mode)
        return finish_library_change(res, res.get('success_count', 0))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Lỗi thực thi Vault Tiering: {str(e)}")

@app.post("/api/vault/tiering/rollback")
def rollback_vault_tiering_api():
    try:
        res = rollback_vault_tiering(ROOT_DIR)
        return finish_library_change(res, res.get('restored_count', 0))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Lỗi khôi phục Vault Tiering: {str(e)}")


# Mount static files
STATIC_DIR = TOOLS_DIR / 'static'
if STATIC_DIR.exists():
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")

if __name__ == '__main__':
    import uvicorn
    host = os.environ.get('HOST', '127.0.0.1')
    port = int(os.environ.get('PORT', '5050'))
    print(f"Khởi động Hi-Res Vault Companion Web App tại http://{host}:{port}")
    uvicorn.run("app:app", host=host, port=port)
