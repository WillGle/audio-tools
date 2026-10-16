"""Measure fresh-process RSS/runtime on generated audio; not a throughput benchmark."""
import json
from pathlib import Path
import subprocess
import sys


def run(root):
    root.mkdir(parents=True, exist_ok=True)
    reports = []
    for seconds in (4, 120):
        path = root/f'perf-{seconds}.flac'
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                        f'anoisesrc=sample_rate=96000:amplitude=0.15:duration={seconds}:seed=20261016',
                        '-ac', '2', '-c:a', 'flac', '-sample_fmt', 's32', str(path)],
                       check=True, timeout=60)
        program = '''import json,resource,sys
from core.audio_scoring import analyze,load_config
c=load_config();c['flaccheck']['enabled']=False
r=analyze(sys.argv[1],config=c)
print(json.dumps({'seconds':r['mastering']['duration_measured'],
'runtime_seconds':r['runtime_seconds'],
'peak_rss_mb_python':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024,
'peak_rss_mb_largest_child':resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss/1024,
'full_decode':r['rules']['integrity']['measurements']['full_decode']}))'''
        output = subprocess.check_output([sys.executable, '-c', program, str(path)],
                                         text=True, timeout=120)
        reports.append(json.loads(output))
    (root/'performance.json').write_text(json.dumps(reports, indent=2), encoding='utf8')
    print(json.dumps(reports, indent=2))


if __name__ == '__main__':
    run(Path(sys.argv[1]).resolve())
