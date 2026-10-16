/* Read-only evidence workflow. Existing tagging, playback and album tools stay separate. */
(() => {
    'use strict';
    const el = id => document.getElementById(id);
    const names = {integrity: 'Toàn vẹn tệp', metadata: 'Container, codec và kỳ vọng',
        lossy_transcode: 'Phân tích nguồn lossy', bit_depth: 'Bit-depth authenticity',
        sample_rate: 'Sample-rate authenticity', signal_defects: 'Lỗi kỹ thuật tín hiệu'};
    const statuses = {PASS: 'Đạt trong phạm vi kiểm tra', REVIEW: 'Cần xem xét', SUSPECT: 'Có bằng chứng đáng ngờ',
        FAIL: 'Lỗi', INCONCLUSIVE: 'Chưa kết luận', NOT_APPLICABLE: 'Không áp dụng'};
    let jobId = null, timer = null, offset = 0, lastCompleted = 0;
    let viewGeneration = 0;

    async function request(url, options) {
        const res = await fetch(url, options);
        const data = await res.json();
        if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Yêu cầu không hợp lệ');
        return data;
    }
    const post = (url, body) => request(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    const fail = error => { el('scoring-progress').textContent = error.message; };
    function text(tag, content, parent) {
        const node = document.createElement(tag);
        node.textContent = content;
        if (parent) parent.append(node);
        return node;
    }
    function detail(parent, title, description, data) {
        const box = document.createElement('details');
        box.className = 'scoring-detail';
        text('summary', title, box);
        text('p', description, box);
        text('pre', JSON.stringify(data, null, 2), box);
        parent.append(box);
        return box;
    }
    function properties(r) {
        const container = el('auth-properties');
        container.replaceChildren();
        const declared = r.claims.container_assertions;
        const expected = r.claims.user_expectations;
        const depth = r.rules.bit_depth.measurements;
        const rate = r.rules.sample_rate.measurements;
        const table = document.createElement('table');
        table.className = 'tracks-table';
        const heading = document.createElement('tr');
        ['Thuộc tính', 'Header khai báo', 'Kỳ vọng người dùng', 'Đo được'].forEach(v => text('th', v, heading));
        table.append(heading);
        [ ['Codec', declared.codec, expected.codec, 'Xác thực khả năng decode, không xác minh codec nguồn'],
          ['Container', declared.container, expected.container, r.rules.metadata.status],
          ['Sample rate', declared.sample_rate, expected.sample_rate, `Bandwidth ${rate.observed_bandwidth ?? 'N/A'} Hz; rate nguồn chưa rõ`],
          ['Bit depth', declared.bit_depth, expected.bit_depth, depth.observed_bit_usage ? depth.observed_bit_usage.join(' / ') + ' bit sử dụng theo kênh' : 'Chưa xác lập độ phân giải nguồn']
        ].forEach(values => {
            const tr = document.createElement('tr');
            values.forEach(v => text('td', v ?? 'Không có', tr));
            table.append(tr);
        });
        container.append(table);
    }
    function spectrum(r) {
        const canvas = el('auth-spectrum');
        const ctx = canvas.getContext('2d');
        const regions = r.spectral.regions || [];
        const channels = [...new Set(regions.map(region => region.channel))];
        canvas.height = Math.max(180, channels.length * 190);
        ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        const nyquist = r.spectral.nyquist_hz;
        channels.forEach((channel, channelIndex) => {
            const slices = regions.filter(region => region.channel === channel);
            const y0 = channelIndex * 190 + 22, plotHeight = 130, left = 70;
            const width = (canvas.width - left - 10) / slices.length;
            ctx.fillStyle = '#e2e8f0'; ctx.font = '12px sans-serif';
            ctx.fillText(`Kênh ${channel + 1} · ${(nyquist/1000).toFixed(1)} kHz`, 5, y0 - 7);
            ctx.fillText('0 Hz', 12, y0 + plotHeight);
            slices.forEach((slice, index) => {
                const bands = slice.spectrum_db;
                bands.forEach((value, band) => {
                    const level = Math.max(0, Math.min(1, (value + 100) / 100));
                    ctx.fillStyle = `hsl(${250 - level * 210}, 80%, ${8 + level * 55}%)`;
                    ctx.fillRect(left + index * width, y0 + plotHeight - (band + 1)*plotHeight/bands.length, width - 1, plotHeight/bands.length + .5);
                });
                if (slice.boundary_hz) {
                    const y = y0 + plotHeight * (1 - slice.boundary_hz / nyquist);
                    ctx.strokeStyle = '#fb7185'; ctx.lineWidth = 2;
                    ctx.beginPath(); ctx.moveTo(left + index * width, y); ctx.lineTo(left + (index+1)*width - 1, y); ctx.stroke();
                }
                ctx.fillStyle = '#e2e8f0'; ctx.font = '10px sans-serif';
                if (slices.length <= 12 || index % 3 === 0) ctx.fillText(`${slice.start.toFixed(1)}s`, left + index * width, y0 + plotHeight + 16);
            });
        });
        el('auth-spectrum-note').textContent = regions.length ? `${r.spectral.method}. Độ phân giải ${r.spectral.frequency_resolution_hz.toFixed(1)} Hz. Trục ngang: các cửa sổ 1 giây được đo, ghi mốc bắt đầu.` : 'Chưa có dữ liệu phổ đủ để hiển thị.';
    }
    window.renderAuthenticity = r => {
        el('auth-score').textContent = r.score == null ? 'N/A' : `${r.score}/100`;
        el('auth-verdict').textContent = `${r.filename} · ${r.band}${r.preliminary ? ' · FAST sơ bộ' : ''}`;
        el('auth-confidence').textContent = `Độ tin cậy đánh giá: ${r.assessment_confidence} · Coverage: ${(r.coverage*100).toFixed(1)}% (${r.assessed_weight}/${r.applicable_weight} trọng số áp dụng)`;
        el('auth-warnings').className = r.critical_failure ? 'critical' : '';
        el('auth-warnings').replaceChildren();
        r.warnings.forEach(w => text('p', w, el('auth-warnings')));
        const parent = el('auth-details'); parent.replaceChildren();
        Object.entries(r.rules).forEach(([key, rule]) => {
            const box = detail(parent, `${names[key]} · ${statuses[rule.status]} · trừ ${rule.penalty_applied} điểm trọng số`, rule.explanation, rule.measurements);
            text('p', `Tin cậy: ${rule.confidence}. Detector: ${rule.detector} (${rule.detector_version}).`, box);
            rule.evidence.forEach(e => text('p', `${e.code}: ${e.detail}`, box));
            rule.limitations.forEach(l => text('p', l, box));
        });
        detail(parent, 'Mastering & Signal Diagnostics · tách khỏi điểm authenticity', 'LUFS, LRA, peak, RMS, crest factor và DR được đo; loudness hoặc DR thấp không bị trừ điểm.', r.mastering);
        if (r.reference) detail(parent, 'So sánh tệp tham chiếu', r.reference.explanation, r.reference);
        detail(parent, 'Thông tin tái lập phân tích', `Rule ${r.rule_version} · ${r.analysis_timestamp}`, {
            file_sha256: r.file_sha256, versions: r.detector_versions, configuration: r.configuration,
            claims: r.claims, cache_hit: r.cache_hit, runtime_seconds: r.runtime_seconds});
        properties(r); spectrum(r);
    };
    function options() {
        const expectations = {};
        [['codec', 'claim-codec'], ['container', 'claim-container'], ['source_label', 'claim-source'], ['release', 'claim-release']].forEach(([key, id]) => {
            if (el(id).value.trim()) expectations[key] = el(id).value.trim();
        });
        [['sample_rate', 'claim-rate'], ['bit_depth', 'claim-depth']].forEach(([key, id]) => {
            if (el(id).value) expectations[key] = Number(el(id).value);
        });
        if (el('claim-lossless').value) expectations.lossless = el('claim-lossless').value === 'true';
        return {mode: el('scoring-mode').value, concurrency: Number(el('scoring-workers').value), expectations,
            reference: el('claim-reference').value.trim() || null};
    }
    function appendRows(rows) {
        rows.forEach(row => {
            const tr = document.createElement('tr'), r = row.result;
            [row.filepath, r?.score == null ? 'N/A' : `${r.score}/100`, r ? `${(r.coverage*100).toFixed(1)}%` : '—', row.error || r?.band].forEach(v => text('td', v, tr));
            const cell = document.createElement('td');
            if (r) {
                const button = text('button', 'Chi tiết', cell);
                button.className = 'btn btn-secondary btn-sm';
                button.addEventListener('click', () => window.renderAuthenticity(r));
            }
            tr.append(cell); el('scoring-results').append(tr);
        });
        offset += rows.length;
    }
    async function loadMore(generation) {
        const rows = await request(`/api/scoring/jobs/${jobId}/results?offset=${offset}&limit=50`);
        if (generation !== viewGeneration) return;
        appendRows(rows);
        if (offset === 1 && rows[0]?.result) window.renderAuthenticity(rows[0].result);
        el('scoring-more').hidden = offset >= lastCompleted;
    }
    async function poll(generation) {
        try {
            const state = await request(`/api/scoring/jobs/${jobId}`);
            if (generation !== viewGeneration) return;
            lastCompleted = state.completed;
            el('scoring-progress').textContent = `${state.status} · ${state.completed}/${state.total} tệp · ${state.errors} lỗi. ${state.message}`;
            const active = ['QUEUED', 'SCANNING', 'RUNNING', 'CANCELLING'].includes(state.status);
            el('scoring-cancel').disabled = !active;
            if (offset < state.completed && offset < 200) await loadMore(generation);
            el('scoring-more').hidden = offset >= state.completed;
            if (active) timer = setTimeout(() => poll(generation), 1000);
            else await history();
        } catch (error) { fail(error); }
    }
    function view(id) {
        clearTimeout(timer); jobId = id; offset = 0; lastCompleted = 0;
        viewGeneration += 1;
        localStorage.setItem('audio-scoring-job', id);
        el('scoring-results').replaceChildren();
        ['json', 'jsonl', 'csv'].forEach(format => {
            const link = el(`scoring-export-${format}`);
            link.href = `/api/scoring/jobs/${id}/export?format=${format}`; link.hidden = false;
        });
        poll(viewGeneration);
    }
    async function history() {
        const jobs = await request('/api/scoring/jobs');
        const select = el('scoring-history'); select.replaceChildren(new Option('Chọn lượt quét', ''));
        jobs.forEach(j => select.add(new Option(`${j.status} · ${j.completed}/${j.total} · ${j.id.slice(0, 8)}`, j.id)));
        select.value = jobId || '';
    }
    async function start(target) {
        try { const job = await post('/api/scoring/jobs', {...options(), ...target}); view(job.job_id); }
        catch (error) { fail(error); }
    }
    document.addEventListener('DOMContentLoaded', () => {
        el('scoring-single').addEventListener('click', () => {
            const path = el('lab-selected-path').value;
            if (!path) return fail(new Error('Chọn một bài trong ô tìm kiếm của Lab.'));
            start({filepaths: [path]});
        });
        el('scoring-selected').addEventListener('click', () => {
            const paths = [...selectedTrackPaths];
            if (!paths.length) return fail(new Error('Chọn bài trong bảng Kho nhạc trước khi quét.'));
            start({filepaths: paths});
        });
        el('scoring-folder-start').addEventListener('click', () => start({folder: el('scoring-folder').value.trim()}));
        el('scoring-cancel').addEventListener('click', () => post(`/api/scoring/jobs/${jobId}/cancel`, {}).then(() => poll(viewGeneration)).catch(fail));
        el('scoring-history').addEventListener('change', e => { if (e.target.value) view(e.target.value); });
        el('scoring-more').addEventListener('click', () => loadMore(viewGeneration).catch(fail));
        history().then(() => {
            const saved = localStorage.getItem('audio-scoring-job');
            if (saved && [...el('scoring-history').options].some(option => option.value === saved)) view(saved);
        }).catch(fail);
    });
})();
