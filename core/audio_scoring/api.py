"""Local scoring routes; every input path stays inside the configured music vault."""
import csv
from io import StringIO
import json
from typing import Literal
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from .models import Expectations
from .process import ToolError


class AnalyzeRequest(BaseModel):
    model_config = {'extra': 'forbid'}
    filepath: str = Field(max_length=4096)
    mode: Literal['FAST', 'BALANCED', 'DEEP'] = 'BALANCED'
    expectations: Expectations | None = None
    reference: str | None = Field(None, max_length=4096)


class ScanRequest(BaseModel):
    model_config = {'extra': 'forbid'}
    filepaths: list[str] | None = Field(None, max_length=100000)
    folder: str | None = Field(None, max_length=4096)
    mode: Literal['FAST', 'BALANCED', 'DEEP'] = 'BALANCED'
    concurrency: int = Field(2, ge=1, le=4)
    expectations: Expectations | None = None
    reference: str | None = Field(None, max_length=4096)


def scoring_router(service):
    router = APIRouter(prefix='/api/scoring', tags=['Audio scoring'])

    def guarded(function, *args, **kwargs):
        try:
            return function(*args, **kwargs)
        except FileNotFoundError:
            raise HTTPException(404, 'Không tìm thấy tệp/thư mục được hỗ trợ')
        except ValueError as exc:
            raise HTTPException(403, str(exc).replace(str(service.root), '<vault>'))
        except KeyError:
            raise HTTPException(404, 'Không tìm thấy lượt quét')
        except ToolError as exc:
            raise HTTPException(503, str(exc).replace(str(service.root), '<vault>'))

    @router.get('/config')
    def configuration():
        return service.config

    @router.post('/analyze')
    def single(req: AnalyzeRequest):
        return guarded(service.single, req.filepath, mode=req.mode,
                       expectations=req.expectations.model_dump(exclude_none=True) if req.expectations else None,
                       reference=req.reference)

    @router.post('/jobs', status_code=202)
    def start(req: ScanRequest):
        job_id = guarded(service.submit, **req.model_dump(exclude_none=True))
        return {'job_id': job_id}

    @router.get('/jobs')
    def jobs():
        return service.jobs()

    @router.get('/jobs/{job_id}')
    def state(job_id: str):
        return guarded(service.job, job_id)

    @router.post('/jobs/{job_id}/cancel')
    def cancel(job_id: str):
        guarded(service.cancel, job_id)
        return guarded(service.job, job_id)

    @router.get('/jobs/{job_id}/results')
    def results(job_id: str, offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=500)):
        return guarded(service.results, job_id, offset, limit)

    @router.get('/jobs/{job_id}/export')
    def export(job_id: str, format: Literal['json', 'jsonl', 'csv'] = 'json'):
        guarded(service.job, job_id)
        # Snapshot the number of completed rows so a download stays self-consistent.
        completed = service.job(job_id)['completed']
        def rows():
            offset = 0
            while offset < completed:
                page = service.results(job_id, offset, min(25, completed-offset))
                if not page:
                    break
                yield from page
                offset += len(page)
        def safe_cell(value):
            value = '' if value is None else str(value)
            return "'"+value if value.lstrip().startswith(('=', '+', '-', '@', '\t', '\r')) else value
        def body():
            if format == 'csv':
                columns = ['filepath', 'score', 'verdict', 'coverage', 'confidence', 'critical_failure', 'error', 'rule_evidence']
                buf = StringIO(newline='')
                writer = csv.writer(buf)
                writer.writerow(columns)
                yield buf.getvalue()
                for row in rows():
                    r = row['result'] or {}
                    writer_row = [row['filepath'], r.get('score'), r.get('verdict'), r.get('coverage'),
                                  r.get('assessment_confidence'), r.get('critical_failure'), row['error'],
                                  json.dumps(r.get('rules', {}), ensure_ascii=False)]
                    buf.seek(0)
                    buf.truncate()
                    writer.writerow([safe_cell(v) for v in writer_row])
                    yield buf.getvalue()
            else:
                if format == 'json':
                    yield '['
                first = True
                for row in rows():
                    yield ('' if first or format == 'jsonl' else ',') + json.dumps(row, ensure_ascii=False, allow_nan=False) + ('\n' if format == 'jsonl' else '')
                    first = False
                if format == 'json':
                    yield ']'
        return StreamingResponse(body(), media_type={'csv': 'text/csv; charset=utf-8', 'json': 'application/json', 'jsonl': 'application/x-ndjson'}[format],
                                 headers={'Content-Disposition': f'attachment; filename="audio-audit-{job_id}.{format}"'})

    return router
