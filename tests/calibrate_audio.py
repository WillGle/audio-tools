"""Run the real engine on reproducible fixtures; write actual reports, never snapshots as detectors.

Usage: python -m tests.calibrate_audio /tmp/audio-fixtures docs/examples
"""
import json
from pathlib import Path
import resource
import sys
import time
from core.audio_scoring import analyze
from tests.audio_fixtures import generate_fixtures


def calibrate(root, destination):
    labels = generate_fixtures(root)
    destination.mkdir(parents=True, exist_ok=True)
    rows = []
    for name, item in labels.items():
        if 'path' not in item:
            continue
        start = time.monotonic()
        r = analyze(root/item['path'], mode='DEEP')
        if name in {'valid_cd', 'padded_24', 'upsampled_96000', 'mp3_128k', 'truncated', 'legitimate_lowpass'}:
            (destination/(name+'.json')).write_text(json.dumps(r, ensure_ascii=False, separators=(',', ':'), allow_nan=False)+'\n', encoding='utf8')
        thirdparty = r['rules']['lossy_transcode']['measurements'].get('third_party', {})
        rows.append({'fixture': name, 'label': item['label'], 'score': r['score'],
                     'coverage': r['coverage'], 'critical': r['critical_failure'],
                     'lossy_status': r['rules']['lossy_transcode']['status'],
                     'sample_rate_status': r['rules']['sample_rate']['status'],
                     'padding': r['rules']['bit_depth']['penalty_applied'] > 0,
                     'upstream_flaccheck': thirdparty.get('upstream_verdict'),
                     'runtime_seconds': round(time.monotonic()-start, 4)})
        print(name, rows[-1], flush=True)
    negative = [r for r in rows if r['label'] == 'lossless_control']
    positive = [r for r in rows if r['label'] in ('transcoded', 'partially_transcoded')]
    positives = lambda seq: sum(r['lossy_status'] in ('SUSPECT', 'FAIL') for r in seq)
    tp, fp = positives(positive), positives(negative)
    screening_tp = sum(r['lossy_status'] == 'REVIEW' for r in positive)
    screening_fp = sum(r['lossy_status'] == 'REVIEW' for r in negative)
    upstream_tp = sum(r['upstream_flaccheck'] in ('TRANSCODED','SUSPICIOUS') for r in positive)
    upstream_fp = sum(r['upstream_flaccheck'] in ('TRANSCODED','SUSPICIOUS') for r in negative)
    summary = {'dataset': 'Deterministic synthetic fixtures; not real-world music provenance calibration',
               'rules': rows, 'automatic_transcode': {'true_positives': tp, 'false_positives': fp,
                   'false_negatives_including_abstentions': len(positive)-tp,
                   'true_negatives': sum(r['lossy_status'] == 'PASS' for r in negative),
                   'abstained_positive_cases': sum(r['lossy_status'] in ('REVIEW','INCONCLUSIVE') for r in positive),
                   'abstained_negative_cases': sum(r['lossy_status'] in ('REVIEW','INCONCLUSIVE') for r in negative),
                   'precision': tp/(tp+fp) if tp+fp else None, 'recall': tp/len(positive) if positive else None,
                   'abstention_rate': sum(r['lossy_status'] in ('REVIEW','INCONCLUSIVE') for r in rows)/len(rows)},
               'review_screening': {'true_positives': screening_tp, 'false_positives': screening_fp, 'negative_controls': len(negative), 'positives': len(positive),
                   'precision': screening_tp/(screening_tp+screening_fp) if screening_tp+screening_fp else None, 'recall': screening_tp/len(positive)},
               'upstream_flaccheck_raw': {'true_positives':upstream_tp, 'false_positives':upstream_fp, 'false_negatives':len(positive)-upstream_tp,
                   'precision':upstream_tp/(upstream_tp+upstream_fp) if upstream_tp+upstream_fp else None, 'recall':upstream_tp/len(positive)},
               'peak_rss_mb_process': round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024, 2),
               'peak_rss_mb_largest_child': round(resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss/1024, 2)}
    (destination/'calibration.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf8')
    return summary


if __name__ == '__main__':
    calibrate(Path(sys.argv[1]), Path(sys.argv[2]))
