// State
let currentTab = 'tab-library';
let currentFilter = 'all';
let searchQuery = '';
let currentOffset = 0;
const pageLimit = 50;
let currentSelectedTrack = null;
let duplicatesData = null;
let currentDupeType = 'byte';
let userSelectedKeep = {}; // hash -> selected relative path to keep

// Column Search & Filter State
let colFilters = {
    title: '',
    artist: '',
    album: '',
    format: '',
    verdict: ''
};
let currentSortBy = 'index';
let currentSortDir = 'asc';
let showColFilters = true;

let allLibraryTracks = []; // for lab selector
let currentAuditResult = null;
let currentTieringPlan = null;
let selectedTieringMode = 'symlink';

// DOM Initialization
document.addEventListener('DOMContentLoaded', () => {
    initTabs();
    initStats();
    initExplorer();
    initAudiophileLab();
    initVaultTiering();
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
            } else if (target === 'tab-audiophile') {
                ensureLabTracksPopulated();
            } else if (target === 'tab-vault') {
                loadVaultTieringPlan();
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

        const elDupePill = document.getElementById('stat-dupe-meta-pill');
        if (elDupePill && counts.duplicate_meta_groups) {
            elDupePill.textContent = `${counts.duplicate_meta_groups} nhóm`;
        }
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

// 3. Explorer & Tracks Table with Column Filtering & Sorting
function initExplorer() {
    // Global search input
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

    // Top Category Filter pills
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

    // Toggle column filters row button
    const btnToggle = document.getElementById('btn-toggle-col-filters');
    const colFilterRow = document.getElementById('col-filter-row');
    btnToggle?.addEventListener('click', () => {
        showColFilters = !showColFilters;
        if (colFilterRow) {
            colFilterRow.style.display = showColFilters ? 'table-row' : 'none';
        }
        btnToggle.classList.toggle('active', showColFilters);
    });

    // Column filter inputs with debounce
    const colTitleInput = document.getElementById('col-filter-title');
    const colArtistInput = document.getElementById('col-filter-artist');
    const colAlbumInput = document.getElementById('col-filter-album');
    const colFormatSelect = document.getElementById('col-filter-format');
    const colVerdictSelect = document.getElementById('col-filter-verdict');

    let colDebounceTimer = null;
    const onColTextInput = () => {
        clearTimeout(colDebounceTimer);
        colDebounceTimer = setTimeout(() => {
            colFilters.title = colTitleInput?.value.trim() || '';
            colFilters.artist = colArtistInput?.value.trim() || '';
            colFilters.album = colAlbumInput?.value.trim() || '';
            currentOffset = 0;
            updateActiveFilterChips();
            loadTracks();
        }, 250);
    };

    colTitleInput?.addEventListener('input', onColTextInput);
    colArtistInput?.addEventListener('input', onColTextInput);
    colAlbumInput?.addEventListener('input', onColTextInput);

    colFormatSelect?.addEventListener('change', () => {
        colFilters.format = colFormatSelect.value;
        currentOffset = 0;
        updateActiveFilterChips();
        loadTracks();
    });

    colVerdictSelect?.addEventListener('change', () => {
        colFilters.verdict = colVerdictSelect.value;
        currentOffset = 0;
        updateActiveFilterChips();
        loadTracks();
    });

    // Reset column filters buttons
    const resetColFilters = () => {
        if (colTitleInput) colTitleInput.value = '';
        if (colArtistInput) colArtistInput.value = '';
        if (colAlbumInput) colAlbumInput.value = '';
        if (colFormatSelect) colFormatSelect.value = '';
        if (colVerdictSelect) colVerdictSelect.value = '';
        colFilters = { title: '', artist: '', album: '', format: '', verdict: '' };
        currentOffset = 0;
        updateActiveFilterChips();
        loadTracks();
    };

    document.getElementById('btn-reset-col-filters')?.addEventListener('click', resetColFilters);
    document.getElementById('btn-clear-all-col-filters')?.addEventListener('click', resetColFilters);

    // Sortable column headers
    document.querySelectorAll('.sortable-th').forEach(th => {
        th.addEventListener('click', () => {
            const sortKey = th.dataset.sort;
            if (!sortKey) return;

            if (currentSortBy === sortKey) {
                currentSortDir = (currentSortDir === 'asc' ? 'desc' : 'asc');
            } else {
                currentSortBy = sortKey;
                currentSortDir = 'asc';
            }

            updateSortIndicators();
            currentOffset = 0;
            loadTracks();
        });
    });

    // Pagination buttons
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

function updateSortIndicators() {
    document.querySelectorAll('.sortable-th').forEach(th => {
        const sortKey = th.dataset.sort;
        const icon = th.querySelector('.sort-icon');
        if (!icon) return;

        if (sortKey === currentSortBy) {
            th.classList.add('active-sort');
            icon.textContent = currentSortDir === 'asc' ? '↑' : '↓';
        } else {
            th.classList.remove('active-sort');
            icon.textContent = '↕';
        }
    });
}

function updateActiveFilterChips() {
    const bar = document.getElementById('active-col-filters-bar');
    const chipsContainer = document.getElementById('active-filter-chips');
    const badge = document.getElementById('col-filter-badge');
    if (!chipsContainer) return;

    let activeCount = 0;
    let chipsHtml = '';

    if (colFilters.title) {
        activeCount++;
        chipsHtml += `<span class="active-chip">Bài hát: "${escapeHtml(colFilters.title)}" <span class="active-chip-remove" data-key="title" title="Xóa lọc">✕</span></span>`;
    }
    if (colFilters.artist) {
        activeCount++;
        chipsHtml += `<span class="active-chip">Nghệ sĩ: "${escapeHtml(colFilters.artist)}" <span class="active-chip-remove" data-key="artist" title="Xóa lọc">✕</span></span>`;
    }
    if (colFilters.album) {
        activeCount++;
        chipsHtml += `<span class="active-chip">Album: "${escapeHtml(colFilters.album)}" <span class="active-chip-remove" data-key="album" title="Xóa lọc">✕</span></span>`;
    }
    if (colFilters.format) {
        activeCount++;
        const fmtLabel = colFilters.format.toUpperCase();
        chipsHtml += `<span class="active-chip">Định dạng: ${escapeHtml(fmtLabel)} <span class="active-chip-remove" data-key="format" title="Xóa lọc">✕</span></span>`;
    }
    if (colFilters.verdict) {
        activeCount++;
        const verdictLabels = {
            duplicate_meta: '⚠️ Trùng Metadata',
            true_hires: 'True Hi-Res',
            true_dsd: 'True DSD',
            studio_master: 'Studio Master',
            cd_lossless: 'CD Lossless',
            fake_hires: 'Fake Hi-Res',
            lossy: 'Lossy MP3'
        };
        const vLabel = verdictLabels[colFilters.verdict] || colFilters.verdict;
        chipsHtml += `<span class="active-chip">Đánh giá: ${escapeHtml(vLabel)} <span class="active-chip-remove" data-key="verdict" title="Xóa lọc">✕</span></span>`;
    }

    chipsContainer.innerHTML = chipsHtml;

    if (bar) {
        bar.style.display = activeCount > 0 ? 'flex' : 'none';
    }
    if (badge) {
        badge.textContent = activeCount;
        badge.style.display = activeCount > 0 ? 'inline-block' : 'none';
    }

    // Attach click to remove chip
    chipsContainer.querySelectorAll('.active-chip-remove').forEach(rm => {
        rm.addEventListener('click', (e) => {
            const key = rm.dataset.key;
            if (!key) return;

            colFilters[key] = '';
            if (key === 'title') {
                const el = document.getElementById('col-filter-title');
                if (el) el.value = '';
            } else if (key === 'artist') {
                const el = document.getElementById('col-filter-artist');
                if (el) el.value = '';
            } else if (key === 'album') {
                const el = document.getElementById('col-filter-album');
                if (el) el.value = '';
            } else if (key === 'format') {
                const el = document.getElementById('col-filter-format');
                if (el) el.value = '';
            } else if (key === 'verdict') {
                const el = document.getElementById('col-filter-verdict');
                if (el) el.value = '';
            }

            currentOffset = 0;
            updateActiveFilterChips();
            loadTracks();
        });
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
    if (searchQuery) url += `&search=${encodeURIComponent(searchQuery)}`;
    if (colFilters.title) url += `&col_title=${encodeURIComponent(colFilters.title)}`;
    if (colFilters.artist) url += `&col_artist=${encodeURIComponent(colFilters.artist)}`;
    if (colFilters.album) url += `&col_album=${encodeURIComponent(colFilters.album)}`;
    if (colFilters.format) url += `&col_format=${encodeURIComponent(colFilters.format)}`;
    if (colFilters.verdict) url += `&col_verdict=${encodeURIComponent(colFilters.verdict)}`;
    if (currentSortBy) {
        url += `&sort_by=${encodeURIComponent(currentSortBy)}&sort_dir=${encodeURIComponent(currentSortDir)}`;
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
            tbody.innerHTML = `<tr><td colspan="7" class="text-center py-6 text-muted">Không tìm thấy bài hát nào phù hợp với bộ lọc cột hoặc từ khóa tìm kiếm.</td></tr>`;
            return;
        }

        let html = '';
        tracks.forEach((track, idx) => {
            const tier = track.tier || '';
            let verdictBadge = '';
            
            if (tier.includes('Upsampled_Fake_HiRes')) {
                verdictBadge = `<span class="stat-tag tag-rose"><span class="badge-dot-rose"></span>Fake Hi-Res</span>`;
            } else if (tier === '01_Hi-Res & DSD') {
                if (track.original_path.endsWith('.dsf') || track.specs.includes('DSD')) {
                    verdictBadge = `<span class="stat-tag tag-cyan"><span class="badge-dot-cyan"></span>True DSD</span>`;
                } else if (track.specs.includes('24bit/96') || track.specs.includes('24bit/176') || track.specs.includes('24bit/192')) {
                    verdictBadge = `<span class="stat-tag tag-emerald"><span class="badge-dot-emerald"></span>True Hi-Res</span>`;
                } else {
                    verdictBadge = `<span class="stat-tag tag-amber"><span class="badge-dot-amber"></span>Studio Master</span>`;
                }
            } else if (tier === '02_Lossless_CD') {
                verdictBadge = `<span class="stat-tag tag-indigo"><span class="badge-dot-indigo"></span>CD Lossless</span>`;
            } else {
                verdictBadge = `<span class="stat-tag tag-slate"><span class="badge-dot-slate"></span>Lossy MP3</span>`;
            }

            let dupeBadge = '';
            if (track.is_duplicate_meta) {
                const isKeep = (track.dupe_status === 'keep');
                const badgeClass = isKeep ? 'tag-emerald' : 'tag-rose';
                const label = isKeep ? `🟢 Giữ (${track.dupe_count})` : `⚠️ Trùng (${track.dupe_count})`;
                const tooltip = isKeep ? 
                    `Bản đề xuất giữ lại tốt nhất trong nhóm trùng (${track.dupe_count} bản). Bấm để lọc nhóm trùng này` :
                    `Bản phụ trùng lặp (${track.dupe_count} bản trong kho). Bấm để lọc nhóm trùng này`;
                dupeBadge = `<span class="stat-tag ${badgeClass} btn-filter-dupe-group" data-title="${escapeHtml(track.title || track.original_path)}" style="font-size: 0.68rem; margin-left: 6px; cursor: pointer; padding: 2px 6px;" title="${tooltip}">${label}</span>`;
            }

            const rowNum = currentOffset + idx + 1;
            html += `
                <tr>
                    <td class="text-muted text-center" style="font-size: 0.8rem; font-family: 'JetBrains Mono', monospace;">${rowNum}</td>
                    <td>
                        <div class="track-main-info">
                            <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 4px;">
                                <span class="track-title">${escapeHtml(track.title || track.original_path)}</span>
                                ${dupeBadge}
                            </div>
                            <span class="track-artist text-muted" style="font-size: 0.75rem;">${escapeHtml(track.original_path)}</span>
                        </div>
                    </td>
                    <td><span class="text-secondary">${escapeHtml(track.artist || 'Unknown Artist')}</span></td>
                    <td><span class="text-secondary">${escapeHtml(track.album || 'Singles')}</span></td>
                    <td><span class="track-specs-badge">${escapeHtml(track.specs || '')}</span></td>
                    <td>${verdictBadge}</td>
                    <td class="text-right">
                        <div class="actions-cell">
                            <button class="btn btn-sm btn-secondary btn-inspect" data-path="${escapeHtml(track.original_path)}" data-title="${escapeHtml(track.title || track.original_path)}" data-specs="${escapeHtml(track.specs)}" title="Xem Spectrogram & Thông Số">
                                Phổ Âm
                            </button>
                            <button class="btn btn-sm btn-secondary btn-lab-jump" data-path="${escapeHtml(track.original_path)}" title="Mở trong Phòng Kiểm Định 7 Chuẩn">
                                7 Chuẩn
                            </button>
                            ${track.is_duplicate_meta ? `
                            <button class="btn btn-sm btn-outline btn-jump-dupes" data-title="${escapeHtml(track.title || track.original_path)}" title="Mở chi tiết so sánh & dọn dẹp các bản trùng trong tab Trùng Lặp">
                                🔍 Trùng
                            </button>
                            ` : ''}
                            <button class="btn btn-sm btn-secondary btn-tag-file" data-path="${escapeHtml(track.original_path)}" title="Ghi tag metadata">
                                Tag
                            </button>
                            <button class="btn btn-sm btn-outline-rose btn-untag-file" data-path="${escapeHtml(track.original_path)}" title="Hoàn tác / Khôi phục metadata gốc">
                                ↩️
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        });

        tbody.innerHTML = html;

        // Attach button events
        document.querySelectorAll('.btn-inspect').forEach(btn => {
            btn.addEventListener('click', () => {
                openSpectrogramModal(btn.dataset.path, btn.dataset.title, btn.dataset.specs);
            });
        });

        document.querySelectorAll('.btn-lab-jump').forEach(btn => {
            btn.addEventListener('click', () => {
                jumpToAudiophileLab(btn.dataset.path);
            });
        });

        document.querySelectorAll('.btn-tag-file').forEach(btn => {
            btn.addEventListener('click', async () => {
                await tagSingleTrack(btn.dataset.path, btn);
            });
        });

        document.querySelectorAll('.btn-untag-file').forEach(btn => {
            btn.addEventListener('click', async () => {
                await rollbackSingleTrack(btn.dataset.path, btn);
            });
        });

        document.querySelectorAll('.btn-filter-dupe-group').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const songTitle = btn.dataset.title;
                if (!songTitle) return;
                const searchInp = document.getElementById('track-search-input');
                if (searchInp) {
                    searchInp.value = songTitle.trim();
                    searchQuery = songTitle.trim();
                }
                setFilter('duplicate_meta');
            });
        });

        document.querySelectorAll('.btn-jump-dupes').forEach(btn => {
            btn.addEventListener('click', () => {
                const songTitle = btn.dataset.title || '';
                switchTab('tab-duplicates');
                currentDupeType = 'meta';
                document.querySelectorAll('#dupe-filter-pills .filter-pill').forEach(p => {
                    p.classList.toggle('active', p.dataset.dupetype === 'meta');
                });
                const subbar = document.getElementById('dupe-subtoolbar');
                if (subbar) subbar.style.display = 'flex';
                const inp = document.getElementById('dupe-search-input');
                if (inp) {
                    inp.value = songTitle;
                    dupeSearchQuery = songTitle.toLowerCase().trim();
                }
                renderDuplicates();
            });
        });

    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center py-6 text-rose">Lỗi khi tải dữ liệu bài hát: ${e.message}</td></tr>`;
    }
}

// ==============================================================================
// 4. AUDIOPHILE 7-PILLAR STUDIO LAB
// ==============================================================================
function initAudiophileLab() {
    const btnAudit = document.getElementById('btn-run-audiophile-audit');
    btnAudit?.addEventListener('click', () => {
        const select = document.getElementById('lab-track-select');
        const path = select?.value;
        if (!path) {
            alert('Vui lòng chọn một bài hát từ danh sách!');
            return;
        }
        runAudiophileAuditForPath(path);
    });

    const btnTagNow = document.getElementById('btn-audiophile-tag-now');
    btnTagNow?.addEventListener('click', async () => {
        if (!currentAuditResult) return;
        btnTagNow.disabled = true;
        btnTagNow.textContent = '⏳ Đang ghi tag...';
        try {
            const naviCfg = getNavidromeConfigFromStorage();
            const res = await fetch('/api/audiophile/tag', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    filepath: currentAuditResult.filepath,
                    audit_data: currentAuditResult,
                    navidrome_config: naviCfg
                })
            });
            const data = await res.json();
            if (data.success) {
                alert(`✅ ${data.message}`);
                if (typeof loadTracks === 'function') loadTracks();
            } else {
                alert(`❌ Lỗi: ${data.message}`);
            }
        } catch (e) {
            alert(`❌ Lỗi: ${e.message}`);
        } finally {
            btnTagNow.disabled = false;
            btnTagNow.textContent = '🏷️ Ghi Toàn Bộ Tag Vào Metadata';
        }
    });

    const btnUntagNow = document.getElementById('btn-audiophile-untag-now');
    btnUntagNow?.addEventListener('click', async () => {
        if (!currentAuditResult) return;
        await rollbackSingleTrack(currentAuditResult.filepath, btnUntagNow);
    });
}

async function ensureLabTracksPopulated() {
    const select = document.getElementById('lab-track-select');
    if (!select || select.children.length > 2) return;

    try {
        const res = await fetch('/api/tracks?filter=all&offset=0&limit=500');
        const data = await res.json();
        const tracks = data.tracks || [];
        allLibraryTracks = tracks;

        let optionsHtml = '<option value="">-- Chọn bài hát để kiểm định 7 tiêu chuẩn --</option>';
        tracks.forEach(t => {
            const label = `${t.title || t.original_path} [${t.specs || 'Audio'}] - ${t.artist || 'Unknown'}`;
            optionsHtml += `<option value="${escapeHtml(t.original_path)}">${escapeHtml(label)}</option>`;
        });
        select.innerHTML = optionsHtml;
    } catch (e) {
        console.error("Lỗi nạp danh sách vào Audiophile Lab:", e);
    }
}

function jumpToAudiophileLab(filepath) {
    switchTab('tab-audiophile');
    ensureLabTracksPopulated().then(() => {
        const select = document.getElementById('lab-track-select');
        if (select) {
            // Kiểm tra xem option đã có chưa, nếu chưa thêm vào
            let found = false;
            for (let opt of select.options) {
                if (opt.value === filepath) {
                    select.value = filepath;
                    found = true;
                    break;
                }
            }
            if (!found) {
                const newOpt = document.createElement('option');
                newOpt.value = filepath;
                newOpt.textContent = filepath;
                newOpt.selected = true;
                select.appendChild(newOpt);
            }
        }
        runAudiophileAuditForPath(filepath);
    });
}

async function runAudiophileAuditForPath(filepath) {
    const loadingBox = document.getElementById('audiophile-loading-box');
    const btnTagNow = document.getElementById('btn-audiophile-tag-now');
    if (loadingBox) loadingBox.style.display = 'block';

    try {
        const res = await fetch('/api/audiophile/audit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filepath })
        });
        const data = await res.json();
        currentAuditResult = data;

        renderAudiophileAuditResults(data);
        if (btnTagNow) btnTagNow.style.display = 'inline-block';
        const btnUntagNow = document.getElementById('btn-audiophile-untag-now');
        if (btnUntagNow) btnUntagNow.style.display = 'inline-block';
    } catch (e) {
        alert(`❌ Lỗi kiểm định: ${e.message}`);
    } finally {
        if (loadingBox) loadingBox.style.display = 'none';
    }
}

function renderAudiophileAuditResults(data) {
    // 1. Dynamic Range Meter
    const dr = data.dynamic_range || {};
    const drScore = dr.dr_score || 0;
    const scoreHuge = document.getElementById('dr-score-huge');
    if (scoreHuge) {
        scoreHuge.textContent = drScore > 0 ? `DR${drScore}` : 'DR--';
        scoreHuge.style.color = dr.badge_color || '#fbbf24';
    }
    const drBadge = document.getElementById('pillar-dr-badge');
    if (drBadge) {
        drBadge.textContent = dr.dr_badge || `DR${drScore}`;
        drBadge.style.color = dr.badge_color || '#fff';
    }
    const needle = document.getElementById('dr-needle');
    if (needle) {
        // DR scale 1 to 20 -> 0% to 100%
        const pct = Math.max(0, Math.min(100, ((drScore - 1) / 19.0) * 100));
        needle.style.left = `${pct}%`;
    }
    document.getElementById('dr-stat-peak').textContent = `${dr.peak_db !== undefined ? dr.peak_db : '--'} dB`;
    document.getElementById('dr-stat-rms').textContent = `${dr.rms_db !== undefined ? dr.rms_db : '--'} dB`;
    document.getElementById('dr-stat-channels').textContent = `${dr.dr_left || '--'} / ${dr.dr_right || '--'}`;
    document.getElementById('dr-verdict-desc').textContent = dr.verdict_text || 'Đã hoàn tất đo đạc Dynamic Range.';

    // 2. FLAC Integrity & Bit-Rot
    const integrity = data.integrity || {};
    const integBadge = document.getElementById('pillar-integrity-badge');
    if (integBadge) {
        integBadge.textContent = integrity.badge || integrity.status;
        integBadge.style.color = integrity.badge_color || '#fff';
    }
    document.getElementById('md5-streaminfo-hex').textContent = integrity.header_md5 || 'N/A';
    document.getElementById('integrity-msg-desc').textContent = integrity.message || '';

    // 3. Fake 24-bit
    const bits = data.bit_depth || {};
    const bitBadge = document.getElementById('pillar-bitdepth-badge');
    if (bitBadge) {
        bitBadge.textContent = bits.badge || `${bits.real_bits}-bit`;
        bitBadge.style.color = bits.badge_color || '#fff';
    }
    const entropyPct = bits.lsb_nonzero_pct || 0.0;
    document.getElementById('lsb-entropy-pct').textContent = `${entropyPct}% non-zero`;
    const fill = document.getElementById('lsb-entropy-fill');
    if (fill) {
        fill.style.width = `${entropyPct}%`;
        fill.style.background = bits.is_fake_24bit ? '#f43f5e' : '#10b981';
    }
    document.getElementById('bitdepth-msg-desc').textContent = bits.explanation || '';

    // 4. DSD / SACD Purity
    const dsd = data.dsd || {};
    const dsdBadge = document.getElementById('pillar-dsd-badge');
    if (dsdBadge) {
        dsdBadge.textContent = dsd.badge || dsd.purity;
        dsdBadge.style.color = dsd.badge_color || '#fff';
    }
    document.getElementById('dsd-channels-val').textContent = dsd.channel_type || (dsd.channels ? `${dsd.channels} Channels` : 'Stereo 2.0');
    document.getElementById('dsd-noise-rise-val').textContent = dsd.noise_shape_rise_db !== undefined ? `+${dsd.noise_shape_rise_db} dB` : 'N/A';
    document.getElementById('dsd-msg-desc').textContent = dsd.explanation || '';

    // 5. ReplayGain & EBU R128
    const loudness = data.loudness || {};
    const loudBadge = document.getElementById('pillar-loudness-badge');
    if (loudBadge) {
        loudBadge.textContent = loudness.replaygain_track_gain || 'ReplayGain OK';
    }
    document.getElementById('loudness-lufs-val').textContent = `${loudness.integrated_lufs !== undefined ? loudness.integrated_lufs + ' LUFS' : '--'}`;
    document.getElementById('loudness-peak-val').textContent = `${loudness.true_peak_db !== undefined ? loudness.true_peak_db + ' dBTP' : '--'}`;
    document.getElementById('loudness-rg-val').textContent = loudness.replaygain_track_gain || '--';
    document.getElementById('loudness-msg-desc').textContent = `Target: -18 LUFS (ReplayGain 2.0) | R128 Gain: ${loudness.r128_track_gain || '--'}. Bit-perfect, không suy hao âm chất.`;

    // 6. Gapless Playback
    const gapless = data.gapless || {};
    const gapBadge = document.getElementById('pillar-gapless-badge');
    if (gapBadge) {
        gapBadge.textContent = gapless.gapless_rating || 'Gapless OK';
        gapBadge.style.color = gapless.rating_color || '#fff';
    }
    document.getElementById('gapless-intro-val').textContent = `${gapless.intro_silence_ms !== undefined ? gapless.intro_silence_ms + ' ms' : '--'}`;
    document.getElementById('gapless-outro-val').textContent = `${gapless.outro_silence_ms !== undefined ? gapless.outro_silence_ms + ' ms' : '--'}`;
    document.getElementById('gapless-msg-desc').textContent = gapless.is_seamless_live_candidate ?
        '🟢 Phát hiện điểm giao nhau âm lượng cao (> -45dBFS) chuẩn Live/Mix liền mạch!' :
        `Định dạng hỗ trợ: ${gapless.container_gapless_support ? 'Sample-Accurate Native' : 'Container Padded'}. Boundary: ${gapless.boundary_end_db} dBFS.`;

    // 7. Vault Tier Proposal
    const tier = data.vault_tier || {};
    const tierBadge = document.getElementById('pillar-tier-badge');
    if (tierBadge) {
        tierBadge.textContent = tier.badge || tier.tier_name;
        tierBadge.style.color = tier.badge_color || '#fff';
    }
    document.getElementById('pillar-tier-dest').textContent = tier.tier_name || '--';
}

// ==============================================================================
// 5. VAULT TIERING 3 CẤP
// ==============================================================================
function initVaultTiering() {
    const btnSymlink = document.getElementById('btn-mode-symlink');
    const btnMove = document.getElementById('btn-mode-move');

    btnSymlink?.addEventListener('click', () => {
        btnSymlink.classList.add('active');
        btnMove.classList.remove('active');
        selectedTieringMode = 'symlink';
    });

    btnMove?.addEventListener('click', () => {
        btnMove.classList.add('active');
        btnSymlink.classList.remove('active');
        selectedTieringMode = 'move';
    });

    document.getElementById('btn-execute-tiering')?.addEventListener('click', async () => {
        if (!currentTieringPlan || !currentTieringPlan.items) {
            alert('Chưa có dữ liệu kế hoạch phân cấp. Đang tải lại...');
            await loadVaultTieringPlan();
        }

        const modeText = selectedTieringMode === 'symlink' ?
            'TẠO LIÊN KẾT MỀM (SYMLINK)\n👉 An toàn tuyệt đối 100%: File gốc KHÔNG bị di chuyển hay thay đổi vị trí!' :
            'DI CHUYỂN THẬT (MOVE)\n👉 Các file sẽ được di chuyển vào 3 thư mục tương ứng. Hệ thống tự động tạo file rollback để khôi phục bất cứ lúc nào!';

        if (!confirm(`Bạn có chắc chắn muốn thực thi phân loại ${currentTieringPlan.total_files} bài hát theo chế độ:\n\n${modeText}`)) {
            return;
        }

        const btn = document.getElementById('btn-execute-tiering');
        btn.disabled = true;
        btn.textContent = '⏳ Đang thực thi...';

        const statusBox = document.getElementById('tiering-status-box');
        const statusMsg = document.getElementById('tiering-status-msg');
        statusBox.style.display = 'block';
        statusMsg.textContent = 'Đang tiến hành phân cấp kho nhạc...';

        try {
            const res = await fetch('/api/vault/tiering/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: selectedTieringMode, plan_items: currentTieringPlan.items })
            });
            const data = await res.json();
            if (data.success) {
                statusMsg.innerHTML = `<span class="text-emerald">✅ ${data.message}</span> (Thư mục đích: <code>${data.target_base}</code>)`;
                alert(`✅ ${data.message}`);
            } else {
                statusMsg.innerHTML = `<span class="text-rose">❌ Lỗi: ${data.message}</span>`;
            }
        } catch (e) {
            statusMsg.innerHTML = `<span class="text-rose">❌ Lỗi: ${e.message}</span>`;
        } finally {
            btn.disabled = false;
            btn.textContent = '⚡ 1-Click Thực Thi Phân Cấp Kho Nhạc';
        }
    });

    document.getElementById('btn-rollback-tiering')?.addEventListener('click', async () => {
        if (!confirm('Hệ thống sẽ đối chiếu .vault_tiering_rollback.json và khôi phục toàn bộ các tệp đã di chuyển về lại đúng vị trí thư mục nguyên bản. Bạn có muốn tiếp tục?')) {
            return;
        }

        const btn = document.getElementById('btn-rollback-tiering');
        btn.disabled = true;
        btn.textContent = '⏳ Đang khôi phục...';

        try {
            const res = await fetch('/api/vault/tiering/rollback', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                alert(`✅ ${data.message}`);
                await loadVaultTieringPlan();
            } else {
                alert(`❌ ${data.message}`);
            }
        } catch (e) {
            alert(`❌ Lỗi: ${e.message}`);
        } finally {
            btn.disabled = false;
            btn.textContent = '🔄 Khôi Phục (Rollback)';
        }
    });
}

async function loadVaultTieringPlan() {
    const tbody = document.getElementById('tiering-preview-tbody');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="4" class="text-center py-6 text-muted">Đang quét và tính toán kế hoạch 3 cấp Vault Tiering...</td></tr>`;

    try {
        const res = await fetch('/api/vault/tiering/plan');
        const data = await res.json();
        currentTieringPlan = data;

        const sum = data.summary || {};
        const t1 = sum.tier_1 || {};
        const t2 = sum.tier_2 || {};
        const t3 = sum.tier_3 || {};

        document.getElementById('tier1-count').textContent = `${t1.count || 0} bài`;
        document.getElementById('tier1-size').textContent = `Dung lượng: ~${t1.size_gb || 0} GB`;

        document.getElementById('tier2-count').textContent = `${t2.count || 0} bài`;
        document.getElementById('tier2-size').textContent = `Dung lượng: ~${t2.size_gb || 0} GB`;

        document.getElementById('tier3-count').textContent = `${t3.count || 0} bài`;
        document.getElementById('tier3-size').textContent = `Dung lượng: ~${t3.size_gb || 0} GB`;

        document.getElementById('plan-total-badge').textContent = `${data.total_files || 0} tệp (${data.total_size_gb || 0} GB)`;

        // Render sample preview (first 100 items)
        const items = data.items || [];
        let html = '';
        items.slice(0, 100).forEach(item => {
            let tierTag = '';
            if (item.tier === 'tier_1') {
                tierTag = `<span class="stat-tag tag-cyan">Tầng 1 &bull; Hi-Res</span>`;
            } else if (item.tier === 'tier_2') {
                tierTag = `<span class="stat-tag tag-indigo">Tầng 2 &bull; CD</span>`;
            } else {
                tierTag = `<span class="stat-tag tag-rose">Tầng 3 &bull; Quarantine</span>`;
            }

            html += `
                <tr>
                    <td>
                        <div style="font-weight: 500; color: #e2e8f0;">${escapeHtml(item.title || item.original_path)}</div>
                        <div class="text-muted" style="font-size: 0.75rem;">${escapeHtml(item.original_path)}</div>
                    </td>
                    <td>${tierTag}</td>
                    <td><span class="text-secondary" style="font-size: 0.8rem;">${escapeHtml(item.reason || '')}</span></td>
                    <td><code class="dupe-path-code" style="font-size: 0.75rem;">${escapeHtml(item.dest_path)}</code></td>
                </tr>
            `;
        });

        tbody.innerHTML = html;
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="4" class="text-center py-6 text-rose">Lỗi tải kế hoạch: ${e.message}</td></tr>`;
    }
}

// ==============================================================================
// 6. DUPLICATES TAB (Cached, Ultra Fast)
// ==============================================================================
// ==============================================================================
// 6. DUPLICATES TAB (Interactive Byte, Metadata, and Name Duplicates)
// ==============================================================================
let dupeSearchQuery = '';
let dupeSubFilter = 'all';
let currentFilteredDuplicates = [];

function initDuplicates() {
    // 1. Tab switching (Byte / Meta / Name)
    const pills = document.querySelectorAll('#dupe-filter-pills .filter-pill');
    pills.forEach(pill => {
        pill.addEventListener('click', () => {
            pills.forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            currentDupeType = pill.dataset.dupetype;
            
            // Show/hide subfilter bar for metadata vs others
            const subbar = document.getElementById('dupe-subtoolbar');
            if (subbar) {
                subbar.style.display = 'flex';
            }

            const subfilterPills = document.getElementById('dupe-subfilter-pills');
            if (subfilterPills) {
                subfilterPills.style.display = currentDupeType === 'meta' ? 'flex' : 'none';
            }

            renderDuplicates();
        });
    });

    // 2. Subfilter pills for metadata duplicates (All / FLAC vs Lossy / Mixed / Numbered)
    const subPills = document.querySelectorAll('#dupe-subfilter-pills .filter-pill');
    subPills.forEach(pill => {
        pill.addEventListener('click', () => {
            subPills.forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            dupeSubFilter = pill.dataset.subfilter;
            renderDuplicates();
        });
    });

    // 3. Search input for duplicates
    const searchInput = document.getElementById('dupe-search-input');
    let debounceTimer = null;
    searchInput?.addEventListener('input', (e) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            dupeSearchQuery = e.target.value.trim().toLowerCase();
            renderDuplicates();
        }, 200);
    });

    // 4. Refresh button
    document.getElementById('btn-refresh-dupes')?.addEventListener('click', async () => {
        const btn = document.getElementById('btn-refresh-dupes');
        btn.disabled = true;
        btn.textContent = '⏳ Đang quét...';
        await loadDuplicates(true);
        btn.disabled = false;
        btn.textContent = '🔄 Quét Lại';
    });

    // 5. Batch Archive Button (works for Byte, Meta, and Name duplicates!)
    document.getElementById('btn-archive-byte-dupes')?.addEventListener('click', async () => {
        await executeBatchArchiveDuplicates();
    });
}

async function loadDuplicates(refresh = false) {
    const container = document.getElementById('dupes-container');
    if (!container) return;
    container.innerHTML = `<p class="text-center py-6 text-muted">Đang quét tìm tệp trùng lặp (SQLite Cache)...</p>`;

    try {
        const res = await fetch(`/api/duplicates?refresh=${refresh}`);
        duplicatesData = await res.json();

        const byteCount = (duplicatesData.byte_duplicates || []).length;
        const metaCount = (duplicatesData.meta_duplicates || []).length;
        const nameCount = (duplicatesData.name_duplicates || []).length;

        document.getElementById('dupe-count-byte').textContent = byteCount;
        document.getElementById('dupe-count-meta').textContent = metaCount;
        document.getElementById('dupe-count-name').textContent = nameCount;

        // Auto-switch to Metadata tab if Byte duplicates is 0 but Metadata duplicates exist
        if (currentDupeType === 'byte' && byteCount === 0 && metaCount > 0) {
            currentDupeType = 'meta';
            document.querySelectorAll('#dupe-filter-pills .filter-pill').forEach(p => {
                p.classList.toggle('active', p.dataset.dupetype === 'meta');
            });
            const subbar = document.getElementById('dupe-subtoolbar');
            if (subbar) subbar.style.display = 'flex';
        }

        // Top navigation tab badge: show total count of actionable duplicates
        const badgeCount = byteCount || metaCount || nameCount;
        const navBadge = document.getElementById('dupe-badge-count');
        if (navBadge) navBadge.textContent = badgeCount;

        // Update Subfilter Pill counts
        const metaList = duplicatesData.meta_duplicates || [];
        const elAll = document.getElementById('dupe-subcount-all');
        const elFlac = document.getElementById('dupe-subcount-flac');
        const elMixed = document.getElementById('dupe-subcount-mixed');
        const elNum = document.getElementById('dupe-subcount-numbered');
        if (elAll) elAll.textContent = metaList.length;
        if (elFlac) elFlac.textContent = metaList.filter(m => m.has_flac_vs_lossy).length;
        if (elMixed) elMixed.textContent = metaList.filter(m => m.has_mixed_formats).length;
        if (elNum) elNum.textContent = metaList.filter(m => m.has_numbered_file).length;

        renderDuplicates();
    } catch (e) {
        container.innerHTML = `<p class="text-center py-6 text-rose">Lỗi khi quét trùng lặp: ${e.message}</p>`;
    }
}

function getActiveDuplicatesList() {
    if (!duplicatesData) return [];
    if (currentDupeType === 'byte') return duplicatesData.byte_duplicates || [];
    if (currentDupeType === 'meta') return duplicatesData.meta_duplicates || [];
    return duplicatesData.name_duplicates || [];
}

function renderDuplicates() {
    const container = document.getElementById('dupes-container');
    if (!container || !duplicatesData) return;

    let rawList = getActiveDuplicatesList();

    // Set title and description based on currentDupeType
    if (currentDupeType === 'byte') {
        document.getElementById('dupe-title-text').textContent = 'Trùng 100% Byte (An toàn tuyệt đối)';
        document.getElementById('dupe-desc-text').textContent = 'Các file có cùng mã băm MD5 tuyệt đối. Có thể di chuyển các bản thừa vào thư mục _Duplicates_Archive/ để giải phóng dung lượng đĩa.';
    } else if (currentDupeType === 'meta') {
        document.getElementById('dupe-title-text').textContent = `Trùng Metadata Ca Sĩ & Tên Bài (${rawList.length} nhóm)`;
        document.getElementById('dupe-desc-text').textContent = 'Các bài hát cùng Ca Sĩ & Tên Bài. Thuật toán đã tự động xếp bản có Metadata đầy đủ nhất, nằm trong Album chuẩn và chất lượng cao nhất lên làm bản để xuất giữ lại. Bạn có thể bấm chọn đổi bản muốn giữ.';
    } else {
        document.getElementById('dupe-title-text').textContent = `Trùng Tên Tệp Ở Khác Thư Mục (${rawList.length} nhóm)`;
        document.getElementById('dupe-desc-text').textContent = 'Các file có cùng tên nhưng nằm ở cả thư mục gốc và các thư mục album con (một số file là bản rip khác chất lượng hoặc bản phát hành khác). Hệ thống đã phân tích bitrate và độ phân giải để đề xuất bản tối ưu nhất.';
    }

    // Apply filtering
    let filteredList = rawList.filter(item => {
        // 1. Search Query Filter
        if (dupeSearchQuery) {
            let textToSearch = '';
            if (currentDupeType === 'meta') {
                textToSearch = `${item.artist} ${item.title} ${(item.files || []).map(f => `${f.path} ${f.album || ''}`).join(' ')}`.toLowerCase();
            } else if (currentDupeType === 'name') {
                textToSearch = `${item.filename} ${(item.files || []).map(f => typeof f === 'string' ? f : f.path).join(' ')}`.toLowerCase();
            } else {
                textToSearch = `${(item.files || []).join(' ')}`.toLowerCase();
            }
            if (!textToSearch.includes(dupeSearchQuery)) {
                return false;
            }
        }

        // 2. Subfilter (for metadata duplicates)
        if (currentDupeType === 'meta') {
            if (dupeSubFilter === 'flac_vs_lossy' && !item.has_flac_vs_lossy) {
                return false;
            }
            if (dupeSubFilter === 'mixed_formats' && !item.has_mixed_formats) {
                return false;
            }
            if (dupeSubFilter === 'numbered' && !item.has_numbered_file) {
                return false;
            }
        }

        return true;
    });

    currentFilteredDuplicates = filteredList;

    if (filteredList.length === 0) {
        container.innerHTML = `<div class="technical-note text-center py-6"><span class="text-emerald">🎉 Không có bản trùng lặp nào phù hợp với bộ lọc hiện tại!</span></div>`;
        updateDupeArchiveButton([]);
        return;
    }

    let html = '<div class="dupes-list">';
    filteredList.slice(0, 100).forEach((item, idx) => {
        const groupId = item.id || item.hash || (`grp_${idx}`);
        const files = item.files || [];

        // Determine currently kept file
        const defaultKept = typeof files[0] === 'string' ? files[0] : files[0].path;
        if (!userSelectedKeep[groupId]) {
            userSelectedKeep[groupId] = defaultKept;
        }
        const keptFile = userSelectedKeep[groupId];

        // Group Header text
        let groupTitle = '';
        let groupBadges = '';
        if (currentDupeType === 'meta') {
            groupTitle = `${escapeHtml(item.artist || 'Unknown')} &bull; ${escapeHtml(item.title || 'Untitled')}`;
            if (item.has_flac_vs_lossy) {
                groupBadges += `<span class="stat-tag tag-emerald" style="font-size: 0.74rem;">Có FLAC vs MP3</span>`;
            } else if (item.has_mixed_formats) {
                groupBadges += `<span class="stat-tag tag-indigo" style="font-size: 0.74rem;">Khác Định Dạng</span>`;
            }
            if (item.has_numbered_file) {
                groupBadges += `<span class="stat-tag tag-amber" style="font-size: 0.74rem;">Có Bản Đuôi (1)</span>`;
            }
        } else if (currentDupeType === 'name') {
            groupTitle = `📄 ${escapeHtml(item.filename)}`;
            groupBadges += `<span class="stat-tag tag-cyan" style="font-size: 0.74rem;">Khác Thư Mục</span>`;
        } else {
            groupTitle = `Nhóm #${idx + 1} (${item.size_mb || 0} MB / file)`;
        }

        const keptFilename = keptFile.split('/').pop();
        const numToArchive = files.length - 1;

        html += `
            <div class="dupe-card mb-4" data-groupid="${groupId}">
                <div class="dupe-card-header">
                    <div class="dupe-card-title-group">
                        <span style="font-weight: 600; font-size: 1.05rem; color: #f8fafc;">${groupTitle}</span>
                        <span class="stat-tag tag-slate">${files.length} bản</span>
                        ${groupBadges}
                    </div>
                    <div class="dupe-card-meta-group">
                        <span class="text-secondary" style="font-size: 0.82rem;">
                            Đang giữ: <strong class="text-emerald" id="lbl-kept-${groupId}">${escapeHtml(keptFilename)}</strong>
                        </span>
                        <button class="btn btn-sm btn-secondary btn-archive-single-group" data-groupid="${groupId}">
                            📦 Archive nhóm này (${numToArchive} bản)
                        </button>
                    </div>
                </div>

                <div class="dupe-file-list">
                    ${files.map(f => {
                        const filePath = typeof f === 'string' ? f : f.path;
                        const fileName = typeof f === 'string' ? f.split('/').pop() : (f.filename || f.path.split('/').pop());
                        const isKept = (filePath === keptFile);
                        
                        let ext = '';
                        let sizeMb = '';
                        let album = '';
                        let specs = '';
                        let isLossless = false;
                        let hasNum = false;

                        if (typeof f === 'string') {
                            ext = (f.split('.').pop() || '').toUpperCase();
                            sizeMb = item.size_mb ? `${item.size_mb} MB` : '';
                            isLossless = ['FLAC', 'DSF', 'DFF', 'WAV', 'APE'].includes(ext);
                            hasNum = Boolean(fileName.match(/\(\d+\)/));
                        } else {
                            ext = f.ext ? f.ext.replace('.', '').toUpperCase() : '';
                            sizeMb = f.size_mb ? `${f.size_mb} MB` : '';
                            album = f.album || '';
                            specs = f.specs || '';
                            isLossless = f.is_lossless || false;
                            hasNum = f.has_number_suffix || false;
                        }

                        let extBadgeClass = 'tag-slate';
                        if (['FLAC', 'APE'].includes(ext)) extBadgeClass = 'tag-emerald';
                        else if (['DSF', 'DFF'].includes(ext)) extBadgeClass = 'tag-cyan';
                        else if (['WAV', 'ALAC'].includes(ext)) extBadgeClass = 'tag-indigo';
                        else if (['M4A', 'AAC'].includes(ext)) extBadgeClass = 'tag-amber';

                        return `
                            <div class="dupe-file-row ${isKept ? 'is-kept' : 'is-archive'}" data-groupid="${groupId}" data-file="${escapeHtml(filePath)}">
                                <input type="radio" name="dupe_radio_${groupId}" class="dupe-radio-custom" value="${escapeHtml(filePath)}" ${isKept ? 'checked' : ''}>
                                <span class="${isKept ? 'dupe-badge-keep' : 'dupe-badge-archive'}">
                                    ${isKept ? '🟢 ĐỀ XUẤT GIỮ' : '🗑️ BẢN PHỤ'}
                                </span>
                                <span class="stat-tag ${extBadgeClass}" style="font-size: 0.72rem; padding: 2px 7px; font-weight: 600;">
                                    .${ext}
                                </span>
                                ${specs ? `<span class="dupe-specs-tag">${escapeHtml(specs)}</span>` : ''}
                                <code class="dupe-path-code">${escapeHtml(filePath)}</code>
                                ${album ? `<span class="dupe-tag-pill dupe-tag-album">${escapeHtml(album)}</span>` : ''}
                                ${sizeMb ? `<span class="text-secondary" style="font-size: 0.75rem; font-family: 'JetBrains Mono', monospace; white-space: nowrap;">${sizeMb}</span>` : ''}
                                ${hasNum ? `<span class="dupe-tag-pill dupe-tag-number">Đuôi (${fileName.match(/\((\d+)\)/)?.[1] || 'số'})</span>` : ''}
                                <button class="btn btn-xs btn-outline btn-row-spectrogram" title="Mở phổ âm kiểm tra tần số cut-off" data-file="${escapeHtml(filePath)}" data-title="${escapeHtml(fileName)}" data-specs="${escapeHtml(specs || ext)}">
                                    📊 Phổ Âm
                                </button>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
    });
    html += '</div>';
    container.innerHTML = html;

    // 1. Attach interactive click event on each file row
    container.querySelectorAll('.dupe-file-row').forEach(row => {
        row.addEventListener('click', (e) => {
            // If clicked on spectrogram button, don't change selection
            if (e.target.closest('.btn-row-spectrogram')) return;

            const gId = row.dataset.groupid;
            const file = row.dataset.file;
            if (!gId || !file) return;

            userSelectedKeep[gId] = file;

            // Update UI within this card
            const card = row.closest('.dupe-card');
            if (card) {
                card.querySelectorAll('.dupe-file-row').forEach(r => {
                    const rFile = r.dataset.file;
                    const radio = r.querySelector('input[type="radio"]');
                    const badge = r.querySelector('.dupe-badge-keep, .dupe-badge-archive');
                    
                    if (rFile === file) {
                        r.classList.add('is-kept');
                        r.classList.remove('is-archive');
                        if (radio) radio.checked = true;
                        if (badge) {
                            badge.className = 'dupe-badge-keep';
                            badge.textContent = '🟢 ĐỀ XUẤT GIỮ';
                        }
                    } else {
                        r.classList.remove('is-kept');
                        r.classList.add('is-archive');
                        if (radio) radio.checked = false;
                        if (badge) {
                            badge.className = 'dupe-badge-archive';
                            badge.textContent = '🗑️ BẢN PHỤ';
                        }
                    }
                });

                const lblKept = document.getElementById(`lbl-kept-${gId}`);
                if (lblKept) {
                    lblKept.textContent = file.split('/').pop();
                }
            }

            updateDupeArchiveButton(filteredList);
        });
    });

    // 2. Attach spectrogram button event
    container.querySelectorAll('.btn-row-spectrogram').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const filePath = btn.dataset.file;
            const title = btn.dataset.title;
            const specs = btn.dataset.specs;
            openSpectrogramModal(filePath, title, specs);
        });
    });

    // 3. Attach single group archive buttons
    container.querySelectorAll('.btn-archive-single-group').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const gId = btn.dataset.groupid;
            const item = rawList.find(x => (x.id || x.hash) === gId);
            if (!item) return;

            const files = item.files || [];
            const kept = userSelectedKeep[gId] || (typeof files[0] === 'string' ? files[0] : files[0].path);
            const toArchive = files
                .map(f => typeof f === 'string' ? f : f.path)
                .filter(p => p !== kept);

            if (toArchive.length === 0) {
                alert("Không có bản phụ nào trong nhóm này để di chuyển!");
                return;
            }

            const title = item.title ? `${item.artist} - ${item.title}` : (item.filename || 'nhóm này');
            const confirmMsg = `Bạn có chắc chắn muốn giữ lại bản:\n👉 ${kept}\n\nVà di chuyển ${toArchive.length} bản phụ của bài "${title}" vào thư mục '_Duplicates_Archive/'?`;
            if (!confirm(confirmMsg)) return;

            btn.disabled = true;
            btn.textContent = '⏳ Đang di chuyển...';
            try {
                const res = await fetch('/api/duplicates/archive-byte-dupes', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ files_to_archive: toArchive })
                });
                const data = await res.json();
                if (data.success) {
                    await loadDuplicates(true);
                } else {
                    alert(`❌ Lỗi: ${data.message}`);
                    btn.disabled = false;
                    btn.textContent = '📦 Archive nhóm này';
                }
            } catch (err) {
                alert(`❌ Lỗi: ${err.message}`);
                btn.disabled = false;
                btn.textContent = '📦 Archive nhóm này';
            }
        });
    });

    updateDupeArchiveButton(filteredList);
}

function updateDupeArchiveButton(activeList) {
    const btn = document.getElementById('btn-archive-byte-dupes');
    const summarySpan = document.getElementById('dupe-selection-summary');
    if (!btn) return;

    if (!activeList || activeList.length === 0) {
        btn.disabled = true;
        btn.textContent = 'Di Chuyển 0 Bản Phụ Vào Archive';
        if (summarySpan) {
            summarySpan.textContent = 'Không có bản phụ nào để di chuyển';
        }
        return;
    }

    let totalToArchive = 0;
    activeList.forEach((item, idx) => {
        const gId = item.id || item.hash || (`grp_${idx}`);
        const files = item.files || [];
        const kept = userSelectedKeep[gId] || (typeof files[0] === 'string' ? files[0] : files[0].path);
        
        files.forEach(f => {
            const p = typeof f === 'string' ? f : f.path;
            if (p !== kept) {
                totalToArchive++;
            }
        });
    });

    const typeLabel = currentDupeType === 'meta' ? 'Bản Phụ Metadata' : (currentDupeType === 'name' ? 'Bản Trùng Tên' : 'Bản Trùng Byte');
    btn.textContent = `Di Chuyển ${totalToArchive} ${typeLabel} Vào Archive`;
    btn.disabled = (totalToArchive === 0);

    if (summarySpan) {
        const filterNote = dupeSubFilter !== 'all' ? ` (theo bộ lọc hiện tại)` : '';
        summarySpan.textContent = `Đang giữ ${activeList.length} bài đã chọn • Sẵn sàng di chuyển ${totalToArchive} bản phụ vào Archive${filterNote}`;
    }
}

async function executeBatchArchiveDuplicates() {
    const activeList = currentFilteredDuplicates.length > 0 ? currentFilteredDuplicates : getActiveDuplicatesList();
    if (!activeList || activeList.length === 0) return;

    const filesToArchive = [];
    activeList.forEach((item, idx) => {
        const gId = item.id || item.hash || (`grp_${idx}`);
        const files = item.files || [];
        const kept = userSelectedKeep[gId] || (typeof files[0] === 'string' ? files[0] : files[0].path);

        files.forEach(f => {
            const p = typeof f === 'string' ? f : f.path;
            if (p !== kept) {
                filesToArchive.push(p);
            }
        });
    });

    if (filesToArchive.length === 0) {
        alert("Không có bản phụ nào được chọn để di chuyển!");
        return;
    }

    const typeDesc = currentDupeType === 'meta' ? 'trùng Metadata' : (currentDupeType === 'name' ? 'trùng Tên tệp' : 'trùng 100% Byte');
    const filterContext = dupeSubFilter !== 'all' ? ` [Bộ lọc: ${dupeSubFilter}]` : (dupeSearchQuery ? ` [Tìm kiếm: "${dupeSearchQuery}"]` : '');
    const confirmMsg = `Hệ thống sẽ:\n` +
        `• Giữ lại ${activeList.length} bản chất lượng cao nhất bạn đã chọn\n` +
        `• Di chuyển an toàn ${filesToArchive.length} bản phụ (${typeDesc}${filterContext}) vào thư mục '_Duplicates_Archive/' (bảo toàn cấu trúc thư mục gốc)\n\n` +
        `Bạn có chắc chắn muốn thực hiện?`;

    if (!confirm(confirmMsg)) return;

    const btn = document.getElementById('btn-archive-byte-dupes');
    btn.disabled = true;
    btn.textContent = '⏳ Đang di chuyển bản phụ...';

    try {
        const res = await fetch('/api/duplicates/archive-byte-dupes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ files_to_archive: filesToArchive })
        });
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
    }
}

// ==============================================================================
// 7. NAVIDROME INTEGRATION
// ==============================================================================
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

// 8. Organize Dry-run & Batch Operations
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

    document.getElementById('btn-tag-navidrome-all')?.addEventListener('click', async () => {
        if (!confirm('Gắn tag Audiophile (Dynamic Range, True Hi-Res...) vào toàn bộ các bài hát trong thư viện?\n\nBản sao lưu metadata gốc sẽ được tạo tự động để bạn có thể hoàn tác bất kỳ lúc nào.')) {
            return;
        }
        const btn = document.getElementById('btn-tag-navidrome-all');
        const box = document.getElementById('organize-status-box');
        btn.disabled = true;
        btn.textContent = '⏳ Đang gắn tag toàn bộ thư viện...';
        if (box) box.innerHTML = `<span class="text-muted">Đang tải danh sách bài hát và ghi metadata...</span>`;
        try {
            const res = await fetch('/api/tracks?filter=all&offset=0&limit=500');
            const data = await res.json();
            const tracks = data.tracks || [];
            let success = 0;
            const naviCfg = getNavidromeConfigFromStorage();
            for (let i = 0; i < tracks.length; i++) {
                const t = tracks[i];
                if (box) box.innerHTML = `<span class="text-muted">Đang ghi tag [${i + 1}/${tracks.length}]: ${escapeHtml(t.title || t.original_path)}</span>`;
                try {
                    const tagRes = await fetch('/api/audiophile/tag', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ filepath: t.original_path, navidrome_config: naviCfg })
                    });
                    const tagData = await tagRes.json();
                    if (tagData.success) success++;
                } catch (err) {}
            }
            if (box) box.innerHTML = `<div class="text-emerald">✅ Đã gắn tag và sao lưu metadata cho ${success}/${tracks.length} bài hát!</div>`;
            alert(`✅ Đã gắn tag thành công cho ${success}/${tracks.length} bài hát!`);
            if (typeof loadTracks === 'function') loadTracks();
        } catch (e) {
            if (box) box.innerHTML = `<div class="text-rose">❌ Lỗi: ${e.message}</div>`;
            alert(`❌ Lỗi: ${e.message}`);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Ghi Metadata Tag Vào File Âm Thanh';
        }
    });

    document.getElementById('btn-rollback-all-tags')?.addEventListener('click', async () => {
        if (!confirm('Hệ thống sẽ đối chiếu cơ sở dữ liệu sao lưu metadata và khôi phục TOÀN BỘ các file âm thanh đã từng được gắn tag về trạng thái nguyên bản ban đầu.\n\nBạn có chắc chắn muốn thực hiện hoàn tác toàn bộ?')) {
            return;
        }
        const btn = document.getElementById('btn-rollback-all-tags');
        const box = document.getElementById('organize-status-box');
        btn.disabled = true;
        btn.textContent = '⏳ Đang hoàn tác toàn bộ tag...';
        if (box) box.innerHTML = `<span class="text-muted">Đang hoàn tác và khôi phục metadata gốc...</span>`;

        try {
            const naviCfg = getNavidromeConfigFromStorage();
            const res = await fetch('/api/audiophile/tag/rollback-all', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(naviCfg || {})
            });
            const data = await res.json();
            if (data.success) {
                if (box) box.innerHTML = `<div class="text-emerald">✅ ${escapeHtml(data.message)}</div>`;
                alert(`✅ ${data.message}`);
                if (typeof loadTracks === 'function') {
                    loadTracks();
                }
            } else {
                if (box) box.innerHTML = `<div class="text-rose">❌ Lỗi: ${escapeHtml(data.message || data.detail)}</div>`;
                alert(`❌ Lỗi: ${data.message || data.detail}`);
            }
        } catch (e) {
            if (box) box.innerHTML = `<div class="text-rose">❌ Lỗi: ${escapeHtml(e.message)}</div>`;
            alert(`❌ Lỗi: ${e.message}`);
        } finally {
            btn.disabled = false;
            btn.textContent = '↩️ Hoàn Tác Toàn Bộ Tag Đã Ghi (Khôi phục Metadata gốc)';
        }
    });
}

// 9. Modal & Spectrogram
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

    document.getElementById('modal-btn-open-lab')?.addEventListener('click', () => {
        if (currentSelectedTrack) {
            modal.classList.remove('active');
            jumpToAudiophileLab(currentSelectedTrack.path);
        }
    });

    document.getElementById('modal-btn-rollback-tag')?.addEventListener('click', async () => {
        if (currentSelectedTrack) {
            const btn = document.getElementById('modal-btn-rollback-tag');
            await rollbackSingleTrack(currentSelectedTrack.path, btn);
        }
    });

    document.getElementById('modal-btn-apply-tag')?.addEventListener('click', async () => {
        if (currentSelectedTrack) {
            const btn = document.getElementById('modal-btn-apply-tag');
            await tagSingleTrack(currentSelectedTrack.path, btn);
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
    dspGrid.innerHTML = `<div class="text-muted">Đang phân tích thông số DSP &amp; tải phổ âm...</div>`;

    document.getElementById('modal-audit-md5').textContent = 'Đang đọc...';
    document.getElementById('modal-audit-gain').textContent = '-- dB';
    document.getElementById('modal-audit-tier').textContent = '--';
    document.getElementById('modal-dr-badge-header').textContent = 'DR--';

    // 1. Phân tích DSP cơ bản
    fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filepath })
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
                <span class="dsp-metric-label">Đánh Giá</span>
                <span class="dsp-metric-value" style="color: ${data.badge_color || '#fff'}">${data.badge || data.verdict}</span>
            </div>
        `;
    })
    .catch(() => {
        dspGrid.innerHTML = `<div class="text-rose">Lỗi khi phân tích DSP</div>`;
    });

    // 2. Chạy nhanh Audiophile audit cho modal
    fetch('/api/audiophile/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filepath })
    })
    .then(r => r.json())
    .then(data => {
        currentAuditResult = data;
        const dr = data.dynamic_range || {};
        const integ = data.integrity || {};
        const loud = data.loudness || {};
        const tier = data.vault_tier || {};

        const drHeader = document.getElementById('modal-dr-badge-header');
        if (drHeader) {
            drHeader.textContent = dr.dr_badge || `DR${dr.dr_score}`;
            drHeader.className = dr.dr_score >= 12 ? 'dr-score-pill dr-score-high' :
                                 dr.dr_score >= 8 ? 'dr-score-pill dr-score-mid' : 'dr-score-pill dr-score-low';
        }

        document.getElementById('modal-audit-md5').textContent = integ.header_md5 ? integ.header_md5.slice(0, 12) + '...' : 'N/A';
        document.getElementById('modal-audit-gain').textContent = loud.replaygain_track_gain || '--';
        document.getElementById('modal-audit-tier').textContent = tier.badge || '--';
    })
    .catch(() => {});

    // 3. Tải ảnh Spectrogram
    img.src = `/api/spectrogram?filepath=${encodeURIComponent(filepath)}`;
}

async function tagSingleTrack(filepath, btnElement = null) {
    if (btnElement) {
        btnElement.textContent = '⏳...';
        btnElement.disabled = true;
    }
    try {
        const naviCfg = getNavidromeConfigFromStorage();
        const res = await fetch('/api/audiophile/tag', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filepath, navidrome_config: naviCfg })
        });
        const data = await res.json();
        if (data.success) {
            alert(`✅ ${data.message}`);
            if (typeof loadTracks === 'function') loadTracks();
        } else {
            alert(`❌ Lỗi: ${data.message}`);
        }
    } catch (e) {
        alert(`❌ Lỗi: ${e.message}`);
    } finally {
        if (btnElement) {
            btnElement.textContent = 'Tag';
            btnElement.disabled = false;
        }
    }
}

async function rollbackSingleTrack(filepath, btnElement = null) {
    if (!filepath) return;
    if (!confirm(`Bạn có chắc muốn hoàn tác (undo) và khôi phục metadata gốc cho tệp:\n${filepath} ?`)) {
        return;
    }
    const origText = btnElement ? btnElement.innerHTML : '';
    if (btnElement) {
        btnElement.textContent = '⏳...';
        btnElement.disabled = true;
    }
    try {
        const naviCfg = getNavidromeConfigFromStorage();
        const res = await fetch('/api/audiophile/tag/rollback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filepath, navidrome_config: naviCfg })
        });
        const data = await res.json();
        if (data.success) {
            alert(`✅ ${data.message}`);
            if (typeof loadTracks === 'function') {
                loadTracks();
            }
        } else {
            alert(`❌ Lỗi: ${data.message || data.detail}`);
        }
    } catch (e) {
        alert(`❌ Lỗi: ${e.message}`);
    } finally {
        if (btnElement) {
            btnElement.innerHTML = origText;
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
