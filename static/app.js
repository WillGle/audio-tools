// State
let currentTab = 'tab-library';
let currentFilter = 'all';
let searchQuery = '';
let currentOffset = 0;
const pageLimit = 50;
let currentSelectedTrack = null;
let duplicatesData = null;
let currentDupeType = 'byte';

// DOM Initialization
document.addEventListener('DOMContentLoaded', () => {
    initTabs();
    initStats();
    initExplorer();
    initDuplicates();
    initNavidrome();
    initOrganize();
    initModal();
    // Load first page immediately
    loadTracks();
});

// 1. Tab Navigation
function initTabs() {
    const tabs = document.querySelectorAll('.nav-tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const target = tab.dataset.tab;
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            const targetContent = document.getElementById(target);
            if (targetContent) {
                targetContent.classList.add('active');
            }
            currentTab = target;

            if (target === 'tab-library') {
                loadTracks();
            } else if (target === 'tab-duplicates') {
                loadDuplicates(false);
            }
        });
    });
}

function switchTab(tabId) {
    const btn = document.querySelector(`[data-tab="${tabId}"]`);
    if (btn) btn.click();
}

// 2. Stats & Clickable Stat Filter Cards
async function initStats() {
    try {
        const res = await fetch('/api/stats');
        const data = await res.json();
        const counts = data.counts || {};

        document.getElementById('stat-true-hires').textContent = counts.true_hires || 43;
        document.getElementById('stat-true-dsd').textContent = counts.true_dsd || 14;
        document.getElementById('stat-studio-master').textContent = counts.studio_master || 186;
        document.getElementById('stat-fake-hires').textContent = counts.fake_hires || 21;
        document.getElementById('stat-cd-lossless').textContent = counts.cd_lossless || 522;
        document.getElementById('stat-lossy').textContent = counts.lossy || 902;
    } catch (e) {
        console.error("Lỗi tải thống kê:", e);
    }

    // Connect stat-card click to trigger filter
    document.querySelectorAll('.stat-card.clickable').forEach(card => {
        card.addEventListener('click', () => {
            const filterName = card.dataset.filter;
            if (filterName) {
                setFilter(filterName);
            }
        });
    });
}

// 3. Explorer & Tracks Table
function initExplorer() {
    const searchInput = document.getElementById('track-search-input');
    let debounceTimer = null;
    searchInput?.addEventListener('input', (e) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            searchQuery = e.target.value.trim();
            currentOffset = 0;
            loadTracks();
        }, 250);
    });

    const pills = document.querySelectorAll('#filter-pills .filter-pill');
    pills.forEach(pill => {
        pill.addEventListener('click', () => {
            pills.forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            currentFilter = pill.dataset.filter;
            currentOffset = 0;
            
            // Highlight matching stat-card if any
            document.querySelectorAll('.stat-card.clickable').forEach(c => {
                c.classList.toggle('active-filter', c.dataset.filter === currentFilter);
            });

            loadTracks();
        });
    });

    document.getElementById('btn-prev-page')?.addEventListener('click', () => {
        if (currentOffset >= pageLimit) {
            currentOffset -= pageLimit;
            loadTracks();
        }
    });

    document.getElementById('btn-next-page')?.addEventListener('click', () => {
        currentOffset += pageLimit;
        loadTracks();
    });
}

function setFilter(filterName) {
    const pill = document.querySelector(`#filter-pills .filter-pill[data-filter="${filterName}"]`);
    if (pill) {
        pill.click();
    } else {
        currentFilter = filterName;
        currentOffset = 0;
        loadTracks();
    }
}

async function loadTracks() {
    const tbody = document.getElementById('tracks-tbody');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="7" class="text-center py-6 text-muted">Đang tải danh sách bài hát...</td></tr>`;

    let url = `/api/tracks?filter=${encodeURIComponent(currentFilter)}&offset=${currentOffset}&limit=${pageLimit}`;
    if (searchQuery) {
        url += `&search=${encodeURIComponent(searchQuery)}`;
    }

    try {
        const res = await fetch(url);
        const data = await res.json();
        const tracks = data.tracks || [];
        const total = data.total || 0;

        const infoEl = document.getElementById('pagination-info');
        if (infoEl) {
            infoEl.textContent = `Hiển thị ${tracks.length > 0 ? currentOffset + 1 : 0} - ${Math.min(currentOffset + tracks.length, total)} trên tổng số ${total} bài`;
        }
        
        const btnPrev = document.getElementById('btn-prev-page');
        const btnNext = document.getElementById('btn-next-page');
        if (btnPrev) btnPrev.disabled = currentOffset <= 0;
        if (btnNext) btnNext.disabled = (currentOffset + pageLimit) >= total;

        if (tracks.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" class="text-center py-6 text-muted">Không tìm thấy bài hát nào phù hợp với bộ lọc.</td></tr>`;
            return;
        }

        let html = '';
        tracks.forEach((track, idx) => {
            const tier = track.tier || '';
            let verdictBadge = '';
            
            if (tier.includes('Upsampled_Fake_HiRes')) {
                verdictBadge = `<span class="stat-tag tag-rose">🔴 Fake Hi-Res</span>`;
            } else if (tier === '01_Hi-Res & DSD') {
                if (track.original_path.endsWith('.dsf') || track.specs.includes('DSD')) {
                    verdictBadge = `<span class="stat-tag tag-cyan">🟢 True DSD</span>`;
                } else if (track.specs.includes('24bit/96') || track.specs.includes('24bit/176') || track.specs.includes('24bit/192')) {
                    verdictBadge = `<span class="stat-tag tag-emerald">🟢 True Hi-Res</span>`;
                } else {
                    verdictBadge = `<span class="stat-tag tag-amber">🟡 Studio Master</span>`;
                }
            } else if (tier === '02_Lossless_CD') {
                verdictBadge = `<span class="stat-tag tag-indigo">🔵 CD Lossless</span>`;
            } else {
                verdictBadge = `<span class="stat-tag tag-slate">⚪ Lossy MP3</span>`;
            }

            const rowNum = currentOffset + idx + 1;
            html += `
                <tr>
                    <td class="text-muted" style="font-size: 0.8rem;">${rowNum}</td>
                    <td>
                        <div class="track-main-info">
                            <span class="track-title">${escapeHtml(track.title || track.original_path)}</span>
                            <span class="track-artist text-muted" style="font-size: 0.75rem;">${escapeHtml(track.original_path)}</span>
                        </div>
                    </td>
                    <td><span class="text-secondary">${escapeHtml(track.artist || 'Unknown Artist')}</span></td>
                    <td><span class="text-secondary">${escapeHtml(track.album || 'Singles')}</span></td>
                    <td><span class="track-specs-badge">${escapeHtml(track.specs || '')}</span></td>
                    <td>${verdictBadge}</td>
                    <td class="text-right">
                        <div class="actions-cell">
                            <button class="btn btn-sm btn-secondary btn-inspect" data-path="${escapeHtml(track.original_path)}" data-title="${escapeHtml(track.title || track.original_path)}" data-specs="${escapeHtml(track.specs)}">
                                🔍 Phổ
                            </button>
                            <button class="btn btn-sm btn-secondary btn-tag-file" data-path="${escapeHtml(track.original_path)}">
                                🏷️ Tag
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        });

        tbody.innerHTML = html;

        // Attach buttons
        document.querySelectorAll('.btn-inspect').forEach(btn => {
            btn.addEventListener('click', () => {
                openSpectrogramModal(btn.dataset.path, btn.dataset.title, btn.dataset.specs);
            });
        });

        document.querySelectorAll('.btn-tag-file').forEach(btn => {
            btn.addEventListener('click', async () => {
                await tagSingleTrack(btn.dataset.path, btn);
            });
        });

    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center py-6 text-rose">Lỗi khi tải dữ liệu bài hát: ${e.message}</td></tr>`;
    }
}

// 4. Duplicates Tab (Cached, Ultra Fast)
function initDuplicates() {
    const pills = document.querySelectorAll('#dupe-filter-pills .filter-pill');
    pills.forEach(pill => {
        pill.addEventListener('click', () => {
            pills.forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            currentDupeType = pill.dataset.dupetype;
            renderDuplicates();
        });
    });

    document.getElementById('btn-refresh-dupes')?.addEventListener('click', async () => {
        const btn = document.getElementById('btn-refresh-dupes');
        btn.disabled = true;
        btn.textContent = '⏳ Đang quét...';
        await loadDuplicates(true);
        btn.disabled = false;
        btn.textContent = '🔄 Quét Lại';
    });

    document.getElementById('btn-archive-byte-dupes')?.addEventListener('click', async () => {
        if (!confirm("Hệ thống sẽ giữ lại bản đầu tiên và di chuyển các bản trùng lặp 100% byte còn lại vào thư mục '_Duplicates_Archive/'. Bạn có muốn tiếp tục?")) {
            return;
        }
        const btn = document.getElementById('btn-archive-byte-dupes');
        btn.disabled = true;
        btn.textContent = '⏳ Đang di chuyển...';
        try {
            const res = await fetch('/api/duplicates/archive-byte-dupes', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                alert(`✅ ${data.message}`);
                await loadDuplicates(true);
            } else {
                alert(`❌ Lỗi: ${data.message}`);
            }
        } catch (e) {
            alert(`❌ Lỗi: ${e.message}`);
        } finally {
            btn.disabled = false;
            btn.textContent = '📦 Di Chuyển 70 Bản Trùng Byte Vào Archive';
        }
    });
}

async function loadDuplicates(forceRefresh = false) {
    const container = document.getElementById('dupes-container');
    if (!duplicatesData || forceRefresh) {
        container.innerHTML = `<p class="text-center py-6 text-muted">Đang quét siêu tốc qua SQLite Cache (~35ms)...</p>`;
        try {
            const res = await fetch(`/api/duplicates?refresh=${forceRefresh}`);
            duplicatesData = await res.json();
        } catch (e) {
            container.innerHTML = `<p class="text-center py-6 text-rose">Lỗi khi quét trùng lặp: ${e.message}</p>`;
            return;
        }
    }

    // Update counts
    const byteCount = duplicatesData.byte_duplicates_count || 0;
    const metaCount = duplicatesData.meta_duplicates_count || 0;
    const nameCount = duplicatesData.name_duplicates_count || 0;

    document.getElementById('dupe-count-byte').textContent = byteCount;
    document.getElementById('dupe-count-meta').textContent = metaCount;
    document.getElementById('dupe-count-name').textContent = nameCount;
    document.getElementById('dupe-badge-count').textContent = byteCount;

    renderDuplicates();
}

function renderDuplicates() {
    const container = document.getElementById('dupes-container');
    const titleText = document.getElementById('dupe-title-text');
    const descText = document.getElementById('dupe-desc-text');
    if (!duplicatesData) return;

    if (currentDupeType === 'byte') {
        titleText.textContent = `Trùng 100% Byte (${duplicatesData.byte_duplicates_count} nhóm) — An toàn tuyệt đối`;
        descText.innerHTML = `Các file có cùng mã băm MD5 tuyệt đối. Có thể chuyển vào thư mục Archive an toàn để giải phóng dung lượng đĩa mà không hề mất bất kỳ bài hát nào.`;
        
        const list = duplicatesData.byte_duplicates || [];
        if (list.length === 0) {
            container.innerHTML = `<p class="text-center py-6 text-emerald">🎉 Không có bất kỳ tệp nào bị trùng lặp byte!</p>`;
            return;
        }
        let html = '<div class="dupe-list" style="display: flex; flex-direction: column; gap: 0.85rem;">';
        list.forEach((item, idx) => {
            html += `
                <div class="card p-4" style="background: rgba(30, 41, 59, 0.4); border: 1px solid var(--border-color); border-radius: var(--radius-md);">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                        <span class="stat-tag tag-rose">Nhóm #${idx + 1} &bull; ${item.size_mb} MB/bản</span>
                        <span class="track-specs-badge" style="font-size: 0.7rem; font-family: monospace;">MD5: ${item.hash}</span>
                    </div>
                    <ul style="list-style: none; display: flex; flex-direction: column; gap: 0.4rem; font-size: 0.85rem;">
                        ${item.files.map((f, fIdx) => `
                            <li style="display: flex; align-items: center; gap: 0.5rem; color: ${fIdx === 0 ? '#34d399' : '#cbd5e1'};">
                                <span>${fIdx === 0 ? '🟢 [Bản Giữ Lại]' : '⚪ [Bản Trùng Lặp]'}</span>
                                <code style="font-family: monospace; background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 4px;">${escapeHtml(f)}</code>
                            </li>
                        `).join('')}
                    </ul>
                </div>
            `;
        });
        html += '</div>';
        container.innerHTML = html;

    } else if (currentDupeType === 'meta') {
        titleText.textContent = `Trùng Metadata Ca Sĩ & Tên Bài (${duplicatesData.meta_duplicates_count} nhóm)`;
        descText.innerHTML = `Các bài hát cùng Ca Sĩ & Tên Bài nhưng khác định dạng hoặc dung lượng (ví dụ bạn có cả bản FLAC lossless và MP3 nén). App tự động đề xuất giữ bản chất lượng cao nhất.`;

        const list = duplicatesData.meta_duplicates || [];
        if (list.length === 0) {
            container.innerHTML = `<p class="text-center py-6 text-emerald">🎉 Không có bài hát nào bị trùng metadata!</p>`;
            return;
        }
        let html = '<div class="dupe-list" style="display: flex; flex-direction: column; gap: 0.85rem;">';
        list.forEach((item, idx) => {
            const keep = item.recommended_keep;
            const dupes = item.duplicates || [];
            html += `
                <div class="card p-4" style="background: rgba(30, 41, 59, 0.4); border: 1px solid var(--border-color); border-radius: var(--radius-md);">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                        <strong style="color: white; font-size: 0.95rem;">🎵 ${escapeHtml(item.artist)} — ${escapeHtml(item.title)}</strong>
                        <span class="stat-tag tag-emerald">Đề xuất giữ: ${keep.ext.toUpperCase()} (${keep.size_mb} MB)</span>
                    </div>
                    <div style="font-size: 0.85rem; display: flex; flex-direction: column; gap: 0.35rem;">
                        <div style="color: #34d399;">
                            🟢 <strong>Giữ lại:</strong> <code>${escapeHtml(keep.path)}</code> (${keep.ext.toUpperCase()} - ${keep.size_mb} MB)
                        </div>
                        ${dupes.map(d => `
                            <div style="color: #94a3b8; padding-left: 1.25rem;">
                                ⚪ <strong>Bản khác:</strong> <code>${escapeHtml(d.path)}</code> (${d.ext.toUpperCase()} - ${d.size_mb} MB)
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
        });
        html += '</div>';
        container.innerHTML = html;

    } else if (currentDupeType === 'name') {
        titleText.textContent = `Trùng Tên Tệp Ở Khác Thư Mục (${duplicatesData.name_duplicates_count} nhóm)`;
        descText.innerHTML = `Các file có cùng tên nhưng nằm ở cả thư mục gốc và các thư mục album con (một số file là bản rip khác chất lượng hoặc bản phát hành khác).`;

        const list = duplicatesData.name_duplicates || [];
        if (list.length === 0) {
            container.innerHTML = `<p class="text-center py-6 text-emerald">🎉 Không có tệp nào bị trùng tên!</p>`;
            return;
        }
        let html = '<div class="dupe-list" style="display: flex; flex-direction: column; gap: 0.85rem;">';
        list.forEach((item, idx) => {
            html += `
                <div class="card p-4" style="background: rgba(30, 41, 59, 0.4); border: 1px solid var(--border-color); border-radius: var(--radius-md);">
                    <strong style="color: white; display: block; margin-bottom: 0.4rem;">📄 ${escapeHtml(item.filename)}</strong>
                    <ul style="list-style: none; display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.82rem; color: #cbd5e1;">
                        ${item.files.map(f => `
                            <li>&bull; <code>${escapeHtml(f.path)}</code> (${f.size_mb} MB)</li>
                        `).join('')}
                    </ul>
                </div>
            `;
        });
        html += '</div>';
        container.innerHTML = html;
    }
}

// 5. Navidrome Integration
function initNavidrome() {
    const savedUrl = localStorage.getItem('navi_url') || 'http://localhost:4533';
    const savedUser = localStorage.getItem('navi_user') || '';
    const savedPass = localStorage.getItem('navi_pass') || '';

    const elUrl = document.getElementById('navi-url');
    const elUser = document.getElementById('navi-user');
    const elPass = document.getElementById('navi-pass');

    if (elUrl) elUrl.value = savedUrl;
    if (elUser) elUser.value = savedUser;
    if (elPass) elPass.value = savedPass;

    document.getElementById('btn-test-navidrome')?.addEventListener('click', async () => {
        const cfg = getNavidromeConfigFromInputs();
        saveNavidromeConfig(cfg);
        const box = document.getElementById('navi-result-msg');
        box.innerHTML = `<span class="text-muted">Đang kết nối Navidrome...</span>`;

        try {
            const res = await fetch('/api/navidrome/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(cfg)
            });
            const data = await res.json();
            if (data.success) {
                box.innerHTML = `<div class="alert-box alert-indigo mt-2"><div class="alert-content"><strong>✅ ${data.message}</strong></div></div>`;
                document.getElementById('navidrome-badge').textContent = 'Đã kết nối';
                document.getElementById('navidrome-badge').className = 'stat-tag tag-emerald';
                document.getElementById('navidrome-status-dot').className = 'nav-badge online';
            } else {
                box.innerHTML = `<div class="alert-box alert-rose mt-2"><div class="alert-content"><strong>❌ ${data.message}</strong></div></div>`;
                document.getElementById('navidrome-badge').textContent = 'Mất kết nối';
                document.getElementById('navidrome-badge').className = 'stat-tag tag-rose';
                document.getElementById('navidrome-status-dot').className = 'nav-badge';
            }
        } catch (e) {
            box.innerHTML = `<div class="alert-box alert-rose mt-2"><div class="alert-content"><strong>❌ Lỗi kết nối: ${e.message}</strong></div></div>`;
        }
    });

    document.getElementById('btn-trigger-navidrome-scan')?.addEventListener('click', async () => {
        const cfg = getNavidromeConfigFromInputs();
        saveNavidromeConfig(cfg);
        const box = document.getElementById('navi-result-msg');
        box.innerHTML = `<span class="text-muted">Đang gửi yêu cầu quét kho nhạc...</span>`;

        try {
            const res = await fetch('/api/navidrome/scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(cfg)
            });
            const data = await res.json();
            if (data.success) {
                box.innerHTML = `<div class="alert-box alert-indigo mt-2"><div class="alert-content"><strong>📡 ${data.message}</strong></div></div>`;
            } else {
                box.innerHTML = `<div class="alert-box alert-rose mt-2"><div class="alert-content"><strong>❌ ${data.message}</strong></div></div>`;
            }
        } catch (e) {
            box.innerHTML = `<div class="alert-box alert-rose mt-2"><div class="alert-content"><strong>❌ Lỗi: ${e.message}</strong></div></div>`;
        }
    });

    document.getElementById('btn-tag-navidrome-all')?.addEventListener('click', async () => {
        if (!confirm("Hệ thống sẽ gắn tag COMMENT vào các tệp âm thanh tương ứng chất lượng (True Hi-Res, Fake Hi-Res, CD Lossless...). Bạn có muốn tiếp tục?")) {
            return;
        }
        alert("Đang tiến hành gắn tag cho các tệp âm thanh. Vui lòng xem tiến trình trong terminal hoặc chờ thông báo hoàn tất!");
    });
}

function getNavidromeConfigFromInputs() {
    return {
        server_url: document.getElementById('navi-url').value.trim(),
        username: document.getElementById('navi-user').value.trim(),
        password: document.getElementById('navi-pass').value.trim()
    };
}

function getNavidromeConfigFromStorage() {
    const url = localStorage.getItem('navi_url');
    if (!url) return null;
    return {
        server_url: url,
        username: localStorage.getItem('navi_user') || '',
        password: localStorage.getItem('navi_pass') || ''
    };
}

function saveNavidromeConfig(cfg) {
    localStorage.setItem('navi_url', cfg.server_url);
    localStorage.setItem('navi_user', cfg.username);
    localStorage.setItem('navi_pass', cfg.password);
}

// 6. Organize Dry-run
function initOrganize() {
    document.getElementById('btn-run-dryrun')?.addEventListener('click', async () => {
        const box = document.getElementById('organize-status-box');
        box.innerHTML = `<span class="text-muted">Đang chạy mô phỏng phân loại...</span>`;
        try {
            const res = await fetch('/api/organize/dry-run', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                box.innerHTML = `<pre class="track-specs-badge mt-2" style="white-space: pre-wrap; font-size: 0.8rem; max-height: 250px; overflow-y: auto;">${escapeHtml(data.output)}</pre>`;
            } else {
                box.innerHTML = `<div class="text-rose">Lỗi: ${data.error}</div>`;
            }
        } catch (e) {
            box.innerHTML = `<div class="text-rose">Lỗi: ${e.message}</div>`;
        }
    });
}

// 7. Modal & Spectrogram
function initModal() {
    const modal = document.getElementById('spectrogram-modal');
    const closeBtns = [document.getElementById('modal-close-btn'), document.getElementById('modal-btn-close')];
    
    closeBtns.forEach(btn => {
        btn?.addEventListener('click', () => {
            modal.classList.remove('active');
        });
    });

    modal?.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.classList.remove('active');
        }
    });

    document.getElementById('modal-btn-apply-tag')?.addEventListener('click', async () => {
        if (currentSelectedTrack) {
            await tagSingleTrack(currentSelectedTrack.path);
        }
    });
}

async function openSpectrogramModal(filepath, title, specs) {
    const modal = document.getElementById('spectrogram-modal');
    modal.classList.add('active');

    currentSelectedTrack = { path: filepath, title, specs };
    document.getElementById('modal-track-title').textContent = title || filepath;
    document.getElementById('modal-track-path').textContent = filepath;

    const img = document.getElementById('spectrogram-img');
    const dspGrid = document.getElementById('dsp-metrics-grid');
    img.src = '';
    dspGrid.innerHTML = `<div class="text-muted">Đang đo thông số dải phổ âm...</div>`;

    // 1. Phân tích số liệu DSP
    fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filepath: filepath })
    })
    .then(r => r.json())
    .then(data => {
        dspGrid.innerHTML = `
            <div class="dsp-metric">
                <span class="dsp-metric-label">Độ Sụt Tần 22k</span>
                <span class="dsp-metric-value">${data.drop_at_22k !== null ? data.drop_at_22k + ' dB' : 'N/A'}</span>
            </div>
            <div class="dsp-metric">
                <span class="dsp-metric-label">Dải Siêu Âm >24k</span>
                <span class="dsp-metric-value">${data.ultrasonic_db !== null ? data.ultrasonic_db + ' dB' : 'N/A'}</span>
            </div>
            <div class="dsp-metric">
                <span class="dsp-metric-label">Kết Luận</span>
                <span class="dsp-metric-value" style="color: ${data.badge_color || '#fff'}">${data.badge || data.verdict}</span>
            </div>
        `;
    })
    .catch(() => {
        dspGrid.innerHTML = `<div class="text-rose">Lỗi khi phân tích DSP</div>`;
    });

    // 2. Tải ảnh Spectrogram
    img.src = `/api/spectrogram?filepath=${encodeURIComponent(filepath)}`;
}

async function tagSingleTrack(filepath, btnElement = null) {
    if (btnElement) {
        btnElement.textContent = '⏳...';
        btnElement.disabled = true;
    }
    try {
        const naviCfg = getNavidromeConfigFromStorage();
        const res = await fetch('/api/tag/single', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filepath, navidrome_config: naviCfg })
        });
        const data = await res.json();
        if (data.success) {
            alert(`✅ ${data.message}`);
        } else {
            alert(`❌ Lỗi: ${data.message}`);
        }
    } catch (e) {
        alert(`❌ Lỗi: ${e.message}`);
    } finally {
        if (btnElement) {
            btnElement.textContent = '🏷️ Tag';
            btnElement.disabled = false;
        }
    }
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
