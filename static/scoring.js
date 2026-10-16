/* Read-only evidence workflow. Existing tagging, playback and album tools stay separate. */
(() => {
    'use strict';
    const el = id => document.getElementById(id);
    const names = {integrity: 'Toàn vẹn tệp', metadata: 'Container, codec và kỳ vọng',
        lossy_transcode: 'Dấu hiệu nguồn lossy', bit_depth: 'Độ sâu bit',
        sample_rate: 'Tần số lấy mẫu', signal_defects: 'Lỗi kỹ thuật tín hiệu'};
    const statuses = {PASS: 'Đạt trong phạm vi kiểm tra', REVIEW: 'Cần xem xét', SUSPECT: 'Có bằng chứng đáng ngờ',
        FAIL: 'Lỗi', INCONCLUSIVE: 'Chưa kết luận', NOT_APPLICABLE: 'Không áp dụng'};
    let jobId = null, timer = null, offset = 0, lastCompleted = 0;
    let viewGeneration = 0;
    let busy = false, singleResult = false;
    const confidence = {HIGH: 'Cao', MEDIUM: 'Vừa', LOW: 'Thấp'};
    const jobLabels = {QUEUED: 'Đang chờ', SCANNING: 'Đang tìm tệp', RUNNING: 'Đang kiểm tra',
        CANCELLING: 'Đang hủy', COMPLETED: 'Đã hoàn tất', CANCELLED: 'Đã hủy',
        FAILED: 'Không hoàn tất', INTERRUPTED: 'Bị gián đoạn khi khởi động lại'};

    async function request(url, options) {
        const res = await fetch(url, options);
        const data = await res.json();
        if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Yêu cầu không hợp lệ');
        return data;
    }
    const post = (url, body) => request(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    const fail = error => {
        el('scoring-error').textContent = error.message;
        el('scoring-error').hidden = false;
    };
    function syncSelection() {
        const scope = el('scoring-target').value;
        document.querySelectorAll('[data-scan-scope]').forEach(node => { node.hidden = node.dataset.scanScope !== scope; });
        el('scoring-selected-count').textContent = selectedTrackPaths.size;
        el('scoring-single').disabled = busy || (scope === 'single' && !el('lab-selected-path').value) || (scope === 'selected' && !selectedTrackPaths.size);
        el('scoring-single').textContent = busy ? 'Đang kiểm tra…' : 'Bắt đầu kiểm tra';
        el('btn-run-audiophile-audit').disabled = busy || !el('lab-selected-path').value;
    }
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
        const raw = document.createElement('details'); raw.className = 'scoring-raw';
        text('summary', 'Số liệu kỹ thuật', raw);
        raw.addEventListener('toggle', () => {
            if (raw.open && !raw.querySelector('pre')) text('pre', JSON.stringify(data, null, 2), raw);
        });
        box.append(raw);
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
          ['Container', declared.container, expected.container, statuses[r.rules.metadata.status]],
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
        clearLabAudit();
        el('scoring-result').hidden = false;
        el('scoring-result').dataset.verdict = r.critical_failure ? 'critical' : r.verdict;
        el('auth-score').textContent = r.score == null ? 'N/A' : `${r.score}/100`;
        el('auth-filename').textContent = r.filename;
        el('auth-properties-panel').open = false;
        el('auth-verdict').textContent = `${r.band}${r.preliminary ? ' · FAST sơ bộ' : ''}`;
        el('auth-confidence').textContent = `Độ tin cậy: ${confidence[r.assessment_confidence]} · Phạm vi đánh giá (coverage): ${(r.coverage*100).toFixed(1)}% (${r.assessed_weight}/${r.applicable_weight} trọng số áp dụng)`;
        el('auth-warnings').className = r.critical_failure ? 'critical' : '';
        el('auth-warnings').replaceChildren();
        r.warnings.forEach(w => text('p', w, el('auth-warnings')));
        const parent = el('auth-details'); parent.replaceChildren();
        const priority = {FAIL: 0, SUSPECT: 1, REVIEW: 2, INCONCLUSIVE: 3, PASS: 4, NOT_APPLICABLE: 5};
        Object.entries(r.rules).sort((a, b) => priority[a[1].status] - priority[b[1].status]).forEach(([key, rule]) => {
            const penalty = rule.penalty_applied ? ` · trừ ${rule.penalty_applied} điểm trọng số` : '';
            const box = detail(parent, `${names[key]} · ${statuses[rule.status]}${penalty}`, rule.explanation, rule.measurements);
            box.dataset.status = rule.status;
            text('p', `Tin cậy: ${confidence[rule.confidence]}. Công cụ: ${rule.detector} (${rule.detector_version}).`, box);
            rule.evidence.forEach(e => text('p', `${e.code}: ${e.detail}`, box));
            rule.limitations.forEach(l => text('p', l, box));
        });
        const mastering = detail(parent, 'Chẩn đoán mastering và tín hiệu', 'Các phép đo dưới đây không đánh giá chất lượng nghe. Loudness hoặc DR thấp không bị trừ điểm.', r.mastering);
        const metrics = document.createElement('dl'); metrics.className = 'scoring-metrics';
        [['Loudness', 'integrated_lufs', 'LUFS'], ['Loudness Range', 'lra_lu', 'LU'],
            ['DR ước lượng', 'dr_estimate', 'dB'], ['Crest factor', 'crest_factor_db', 'dB'],
            ['Sample peak', 'sample_peak_dbfs', 'dBFS'], ['True peak', 'true_peak_dbtp', 'dBTP'], ['RMS', 'rms_dbfs', 'dBFS']].forEach(([label, key, unit]) => {
            const item = document.createElement('div'); text('dt', label, item);
            text('dd', r.mastering[key] == null ? 'Chưa đo được' : `${r.mastering[key].toFixed(1)} ${unit}`, item); metrics.append(item);
        });
        mastering.insertBefore(metrics, mastering.querySelector('.scoring-raw'));
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
                button.addEventListener('click', () => {
                    el('scoring-results').querySelectorAll('tr').forEach(item => item.classList.remove('scoring-row-active'));
                    tr.classList.add('scoring-row-active');
                    selectLabTrack(row.filepath, r.filename); window.renderAuthenticity(r);
                    el('scoring-result').focus({preventScroll: true}); el('scoring-result').scrollIntoView({block: 'start'});
                });
            }
            tr.append(cell); el('scoring-results').append(tr);
        });
        offset += rows.length;
    }
    async function loadMore(generation) {
        if (el('scoring-more').disabled) return;
        el('scoring-more').disabled = true;
        const rows = await request(`/api/scoring/jobs/${jobId}/results?offset=${offset}&limit=50`);
        if (generation !== viewGeneration) return;
        appendRows(rows);
        if (singleResult && el('scoring-result').hidden) {
            const first = rows.find(row => row.result);
            if (first) { selectLabTrack(first.filepath, first.result.filename); window.renderAuthenticity(first.result); }
        }
        el('scoring-more').disabled = false;
        el('scoring-more').hidden = offset >= lastCompleted;
    }
    async function poll(generation) {
        try {
            const state = await request(`/api/scoring/jobs/${jobId}`);
            if (generation !== viewGeneration) return;
            el('scoring-error').hidden = true;
            lastCompleted = state.completed;
            singleResult = state.options.filepaths?.length === 1 && state.options.folder == null;
            el('scoring-progress').dataset.status = state.status;
            el('scoring-progress').textContent = `${jobLabels[state.status]} · ${state.completed}/${state.total} tệp · ${state.errors} lỗi. ${state.message}`;
            const active = ['QUEUED', 'SCANNING', 'RUNNING', 'CANCELLING'].includes(state.status);
            busy = active; syncSelection();
            el('scoring-cancel').disabled = !active || state.status === 'CANCELLING';
            el('scoring-cancel').hidden = !active;
            el('scoring-meter').hidden = !active && !state.total;
            el('scoring-meter').max = Math.max(1, state.total);
            if (state.status === 'SCANNING' || state.status === 'QUEUED') el('scoring-meter').removeAttribute('value');
            else el('scoring-meter').value = state.completed;
            if (el('scoring-comparison').hidden && state.completed && state.total > 1) el('scoring-comparison').open = true;
            el('scoring-comparison').hidden = !state.completed;
            el('scoring-comparison-title').textContent = `Kết quả ${state.completed} tệp · chọn Chi tiết để xem bằng chứng`;
            if (offset < state.completed && offset < 200) await loadMore(generation);
            el('scoring-more').hidden = offset >= state.completed;
            if (active) timer = setTimeout(() => poll(generation), 1000);
            else await history();
        } catch (error) {
            if (generation !== viewGeneration) return;
            el('scoring-more').disabled = false;
            fail(new Error(`Chưa cập nhật được tiến độ. Đang thử lại… ${error.message}`));
            timer = setTimeout(() => poll(generation), 3000);
        }
    }
    function view(id) {
        clearTimeout(timer); jobId = id; offset = 0; lastCompleted = 0;
        el('scoring-setup').open = false;
        clearLabAudit();
        viewGeneration += 1;
        el('scoring-result').hidden = true;
        el('scoring-comparison').hidden = true;
        el('scoring-comparison').open = false;
        el('scoring-more').disabled = false;
        el('scoring-error').hidden = true;
        el('scoring-progress').textContent = 'Đang tải lượt kiểm tra…';
        el('scoring-progress').dataset.status = 'QUEUED';
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
        jobs.forEach(j => {
            const scope = j.options.folder != null ? j.options.folder === '.' ? 'Toàn bộ kho' : j.options.folder : j.options.filepaths.length === 1 ? j.options.filepaths[0] : `${j.total} tệp đã chọn`;
            select.add(new Option(`${jobLabels[j.status]} · ${j.completed}/${j.total} · ${scope}`, j.id));
        });
        select.value = jobId || '';
    }
    async function start(target) {
        if (busy) return;
        el('scoring-error').hidden = true;
        busy = true; syncSelection();
        try { const job = await post('/api/scoring/jobs', {...options(), ...target}); view(job.job_id); }
        catch (error) { busy = false; syncSelection(); fail(error); }
    }
    document.addEventListener('DOMContentLoaded', () => {
        el('scoring-form').addEventListener('submit', event => {
            event.preventDefault();
            const scope = el('scoring-target').value;
            const paths = scope === 'single' ? [el('lab-selected-path').value].filter(Boolean) : [...selectedTrackPaths];
            if (scope !== 'folder' && !paths.length) return fail(new Error('Chọn bài trước khi kiểm tra.'));
            start(scope === 'folder' ? {folder: el('scoring-folder').value.trim()} : {filepaths: paths});
        });
        el('scoring-target').addEventListener('change', syncSelection);
        document.addEventListener('audio-selection-change', syncSelection);
        el('btn-batch-score').addEventListener('click', () => {
            switchTab('tab-audiophile'); el('scoring-target').value = 'selected'; syncSelection(); el('scoring-single').click();
        });
        el('scoring-mode').addEventListener('change', () => {
            el('scoring-mode-help').textContent = {FAST: 'Chỉ sàng lọc 20 giây đầu; chưa có điểm kết luận.', BALANCED: 'Giải mã toàn tệp, kiểm tra toàn vẹn và đo nhiều vùng phổ.', DEEP: 'Nhiều vùng phổ hơn và detector thử nghiệm nếu có; cần thêm thời gian.'}[el('scoring-mode').value];
        });
        el('scoring-cancel').addEventListener('click', () => {
            el('scoring-cancel').disabled = true;
            post(`/api/scoring/jobs/${jobId}/cancel`, {}).catch(fail);
        });
        el('scoring-history').addEventListener('change', e => { if (e.target.value) view(e.target.value); });
        el('scoring-more').addEventListener('click', () => loadMore(viewGeneration).catch(error => { el('scoring-more').disabled = false; fail(error); }));
        syncSelection();
        history().then(() => {
            const saved = localStorage.getItem('audio-scoring-job');
            if (saved && [...el('scoring-history').options].some(option => option.value === saved)) view(saved);
        }).catch(fail);
    });
})();
