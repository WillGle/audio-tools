"""Persistent results and bounded background scans. Only cache files are written."""
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import threading
import uuid

from core.paths import vault_path
from . import analyze, load_config, engine_signature
from .models import Expectations
from .process import AnalysisCancelled, ToolError, checkpoint
from .tools import file_hash, tool_versions

AUDIO_EXTENSIONS = {'.flac', '.wav', '.m4a', '.mp3', '.ape', '.ogg', '.wma', '.aac', '.opus', '.aif', '.aiff', '.dsf', '.dff', '.wv'}


class AnalysisService:
    def __init__(self, root, db):
        self.root = Path(root).resolve()
        self.db = Path(db)
        self.db.parent.mkdir(parents=True, exist_ok=True)
        self.config = load_config()
        self.lock = threading.Lock()
        self.events = {}
        self.slots = threading.BoundedSemaphore(self.config['limits']['max_workers'])
        with closing(self.connect()) as conn:
            conn.executescript('''
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS analysis_cache (key TEXT PRIMARY KEY, result TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS scoring_jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL,
                    total INTEGER DEFAULT 0, completed INTEGER DEFAULT 0, errors INTEGER DEFAULT 0,
                    options TEXT NOT NULL, message TEXT DEFAULT '');
                CREATE TABLE IF NOT EXISTS scoring_results (seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    job_id TEXT NOT NULL, filepath TEXT NOT NULL, payload TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS scoring_results_job ON scoring_results(job_id,seq);
            ''')
            conn.execute("UPDATE scoring_jobs SET status='INTERRUPTED', message='Ứng dụng đã khởi động lại; hãy tạo lượt quét mới.' WHERE status IN ('QUEUED','SCANNING','RUNNING','CANCELLING')")
            conn.commit()

    def connect(self):
        return sqlite3.connect(self.db, timeout=30)

    def resolve(self, value, directory=False):
        # Resolve symlinks and reject FIFOs/devices before any decoder is invoked.
        if directory and value in ('', '.'):
            path = self.root
        else:
            path = vault_path(self.root, value)
        if directory:
            if not path.is_dir():
                raise FileNotFoundError('Không tìm thấy thư mục')
        elif not path.is_file() or path.suffix.lower() not in AUDIO_EXTENSIONS:
            raise FileNotFoundError('Không tìm thấy tệp audio được hỗ trợ')
        return path

    def single(self, value, *, mode='BALANCED', expectations=None, reference=None, cancel=None, versions=None):
        path = self.resolve(value)
        ref = self.resolve(reference) if reference else None
        if mode not in self.config['modes']:
            raise ValueError('Chế độ không hợp lệ')
        if path.stat().st_size > self.config['limits']['file_bytes'] or (ref and ref.stat().st_size > self.config['limits']['file_bytes']):
            raise ValueError('Tệp vượt giới hạn kích thước')
        claims = Expectations.model_validate(expectations or {}).model_dump(exclude_none=True)
        while not self.slots.acquire(timeout=.1):
            checkpoint(cancel)
        try:
            checkpoint(cancel)
            before = path.stat()
            ref_before = ref.stat() if ref else None
            sha = file_hash(path, cancel)
            ref_sha = file_hash(ref, cancel) if ref else None
            versions = versions if versions is not None else tool_versions(cancel)
            key = hashlib.sha256(json.dumps({'sha': sha, 'suffix': path.suffix.lower(), 'reference': ref_sha,
                                             'config': self.config, 'tools': versions, 'engine': engine_signature(),
                                             'mode': mode, 'claims': claims}, sort_keys=True).encode()).hexdigest()
            with closing(self.connect()) as conn:
                row = conn.execute('SELECT result FROM analysis_cache WHERE key=?', (key,)).fetchone()
            if row:
                data = json.loads(row[0])
                data['cache_hit'] = True
                data['filename'] = path.name
            else:
                data = analyze(path, mode=mode, expectations=claims, reference=ref, config=self.config,
                               cancel=cancel, versions=versions)
                data['cache_hit'] = False
                if data['file_sha256'] != sha or (ref_sha and data.get('reference') and data['reference']['file_sha256'] != ref_sha):
                    raise ToolError('Tệp thay đổi trong lúc phân tích')
            after = path.stat()
            if self._changed(before, after) or (ref and self._changed(ref_before, ref.stat())):
                raise ToolError('Tệp thay đổi trong lúc phân tích')
            if not row:
                with closing(self.connect()) as conn:
                    conn.execute('INSERT OR REPLACE INTO analysis_cache VALUES (?,?)', (key, json.dumps(data, ensure_ascii=False, allow_nan=False)))
                    conn.commit()
            return data
        finally:
            self.slots.release()

    @staticmethod
    def _changed(before, after):
        return (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns)

    def submit(self, filepaths=None, *, folder=None, mode='BALANCED', concurrency=2, expectations=None, reference=None):
        if mode not in self.config['modes'] or not 1 <= concurrency <= self.config['limits']['max_workers']:
            raise ValueError('Chế độ hoặc concurrency không hợp lệ')
        if bool(filepaths) == (folder is not None):
            raise ValueError('Chọn danh sách file hoặc một thư mục')
        if filepaths and len(filepaths) > self.config['limits']['max_files']:
            raise ValueError('Quá nhiều tệp')
        # Validate explicit paths before creating the job. Recursive enumeration is background work.
        if filepaths:
            filepaths = list(dict.fromkeys(str(self.resolve(p).relative_to(self.root)) for p in filepaths))
        if folder is not None:
            folder = str(self.resolve(folder, directory=True).relative_to(self.root))
        if reference:
            reference = str(self.resolve(reference).relative_to(self.root))
        expectations = Expectations.model_validate(expectations or {}).model_dump(exclude_none=True)
        options = {'filepaths': filepaths, 'folder': folder, 'mode': mode, 'concurrency': concurrency,
                   'expectations': expectations, 'reference': reference}
        with self.lock:
            if len(self.events) >= self.config['limits']['max_jobs']:
                raise ToolError('Hàng đợi đã đầy')
            job_id = uuid.uuid4().hex
            self.events[job_id] = threading.Event()
            with closing(self.connect()) as conn:
                conn.execute('INSERT INTO scoring_jobs(id,status,options) VALUES (?,?,?)',
                             (job_id, 'QUEUED', json.dumps(options, ensure_ascii=False)))
                conn.commit()
            threading.Thread(target=self._work, args=(job_id, options, self.events[job_id]), daemon=True).start()
        return job_id

    def _update(self, job_id, **fields):
        # Column names are fixed internal keys, values use SQL parameters.
        allowed = {'status', 'total', 'completed', 'errors', 'message'}
        assert fields.keys() <= allowed
        with closing(self.connect()) as conn:
            conn.execute('UPDATE scoring_jobs SET '+','.join(f'{k}=?' for k in fields)+' WHERE id=?', (*fields.values(), job_id))
            conn.commit()

    def _paths(self, options, cancel):
        if options['filepaths']:
            yield from options['filepaths']
            return
        root = self.resolve(options['folder'], directory=True)
        seen = set()
        for directory, dirs, files in os.walk(root, followlinks=False):
            checkpoint(cancel)
            dirs[:] = sorted(d for d in dirs if not d.startswith('.') and d not in {'_Vault_3_Tier', '_Duplicates_Archive'} and not (Path(directory)/d).is_symlink())
            for name in sorted(files):
                checkpoint(cancel)
                candidate = Path(directory)/name
                if candidate.suffix.lower() not in AUDIO_EXTENSIONS:
                    continue
                try:
                    resolved = self.resolve(candidate)
                except (ValueError, FileNotFoundError, OSError):
                    continue
                if resolved in seen:
                    continue
                seen.add(resolved)
                if len(seen) > self.config['limits']['max_files']:
                    raise ToolError('Thư mục vượt giới hạn số tệp; chọn thư mục nhỏ hơn')
                yield str(resolved.relative_to(self.root))

    def _work(self, job_id, options, event):
        completed = errors = 0
        try:
            self._update(job_id, status='SCANNING')
            paths = list(self._paths(options, event))
            checkpoint(event)
            self._update(job_id, status='RUNNING', total=len(paths))
            versions = tool_versions(event)
            iterator = iter(paths)
            with ThreadPoolExecutor(max_workers=options['concurrency']) as pool:
                pending = {}
                def fill():
                    while len(pending) < options['concurrency']:
                        checkpoint(event)
                        path = next(iterator, None)
                        if path is None:
                            break
                        future = pool.submit(self.single, path, mode=options['mode'], expectations=options['expectations'],
                                             reference=options['reference'], cancel=event, versions=versions)
                        pending[future] = path
                fill()
                while pending:
                    checkpoint(event)
                    done, _ = wait(pending, timeout=.2, return_when=FIRST_COMPLETED)
                    for future in done:
                        path = pending.pop(future)
                        try:
                            data = {'filepath': path, 'result': future.result(), 'error': None}
                        except AnalysisCancelled:
                            raise
                        except Exception as exc:
                            errors += 1
                            # Relative path is stored separately; avoid exposing decoder/private paths.
                            message = str(exc) if isinstance(exc, (ToolError, ValueError, FileNotFoundError)) else 'Lỗi phân tích; kết quả chưa có'
                            message = message.replace(str(self.root), '<vault>')[:1000]
                            data = {'filepath': path, 'result': None, 'error': message}
                        completed += 1
                        with closing(self.connect()) as conn:
                            conn.execute('INSERT INTO scoring_results(job_id,filepath,payload) VALUES (?,?,?)', (job_id, path, json.dumps(data, ensure_ascii=False, allow_nan=False)))
                            conn.commit()
                        self._update(job_id, completed=completed, errors=errors)
                    fill()
            checkpoint(event)
            self._update(job_id, status='COMPLETED')
        except AnalysisCancelled:
            self._update(job_id, status='CANCELLED', message='Đã hủy; kết quả hoàn tất trước đó vẫn được giữ.')
        except Exception as exc:
            self._update(job_id, status='FAILED', message=(str(exc).replace(str(self.root), '<vault>')[:1000] if isinstance(exc, (ToolError, ValueError, OSError)) else 'Lỗi hàng đợi'))
        finally:
            with self.lock:
                self.events.pop(job_id, None)

    def cancel(self, job_id):
        state = self.job(job_id)
        with self.lock:
            event = self.events.get(job_id)
            if event:
                # Publish cancellation before waking the worker; never overwrite a terminal state.
                with closing(self.connect()) as conn:
                    conn.execute("UPDATE scoring_jobs SET status='CANCELLING' WHERE id=? AND status IN ('QUEUED','SCANNING','RUNNING')", (job_id,))
                    conn.commit()
                event.set()
        return state

    def job(self, job_id):
        with closing(self.connect()) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute('SELECT * FROM scoring_jobs WHERE id=?', (job_id,)).fetchone()
        if row is None:
            raise KeyError('Không tìm thấy lượt quét')
        data = dict(row)
        data['options'] = json.loads(data['options'])
        return data

    def jobs(self):
        with closing(self.connect()) as conn:
            rows = conn.execute('SELECT id FROM scoring_jobs ORDER BY rowid DESC LIMIT 30').fetchall()
        return [self.job(row[0]) for row in rows]

    def results(self, job_id, offset=0, limit=100, sort='sequence', descending=False):
        self.job(job_id)
        score = "json_extract(payload, '$.result.score')"
        coverage = "json_extract(payload, '$.result.coverage')"
        # Match dashboard warning priority without decoding every stored result in Python.
        severity = f"""CASE
            WHEN json_extract(payload, '$.error') IS NOT NULL
                OR json_extract(payload, '$.result') IS NULL
                OR json_extract(payload, '$.result.critical_failure') = 1
                OR EXISTS (SELECT 1 FROM json_each(payload, '$.result.rules') WHERE json_extract(value, '$.status') = 'FAIL')
                OR {score} < json_extract(payload, '$.result.configuration.bands[2].min') THEN 5
            WHEN EXISTS (SELECT 1 FROM json_each(payload, '$.result.rules') WHERE json_extract(value, '$.status') = 'SUSPECT')
                OR {score} < json_extract(payload, '$.result.configuration.bands[1].min') THEN 4
            WHEN EXISTS (SELECT 1 FROM json_each(payload, '$.result.rules') WHERE json_extract(value, '$.status') = 'REVIEW')
                OR json_extract(payload, '$.result.verdict') = 'REVIEW'
                OR {score} < json_extract(payload, '$.result.configuration.bands[0].min') THEN 3
            WHEN {score} IS NULL THEN 2
            WHEN {coverage} < json_extract(payload, '$.result.configuration.confidence_coverage') THEN 3
            ELSE 1 END"""
        columns = {'sequence': 'seq', 'filepath': 'filepath COLLATE NOCASE',
                   'score': score, 'coverage': coverage, 'warning': severity}
        if sort not in columns:
            raise ValueError('Cột sắp xếp không hợp lệ')
        direction = 'DESC' if descending else 'ASC'
        nulls = f'{columns[sort]} IS NULL ASC, ' if sort in ('score', 'coverage') else ''
        with closing(self.connect()) as conn:
            rows = conn.execute(f'SELECT payload FROM scoring_results WHERE job_id=? ORDER BY {nulls}{columns[sort]} {direction}, seq ASC LIMIT ? OFFSET ?',
                                (job_id, limit, offset)).fetchall()
        return [json.loads(row[0]) for row in rows]
