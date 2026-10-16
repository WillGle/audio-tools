// State
let currentTab = 'tab-library';
let currentFilter = 'all';
let searchQuery = '';
let currentOffset = 0;
let pageLimit = 50;
let currentSelectedTrack = null;
let duplicatesData = null;
let currentDupeType = 'byte';
let userSelectedKeep = {}; // hash -> selected relative path to keep

// Multi-select & Batch State
let selectedTrackPaths = new Set();
let currentTotalTracks = 0;

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

let currentAuditResult = null;
let currentTieringPlan = null;
let selectedTieringMode = 'symlink';
let tierPlanFilter = 'all';
let tierPlanSearch = '';

// Audio Player Global State
let audioPlayer = {
    element: null,
    isPlaying: false,
    currentPath: null,
    currentTitle: '',
    currentArtist: '',
    currentSpecs: '',
    abActive: false,
    channelA: null,
    channelB: null,
    currentChannel: 'A'
};

// ==============================================================================
// TOAST NOTIFICATIONS & CONFIRMATION MODAL HELPERS
// ==============================================================================
function showToast(message, type = 'info', duration = 3500) {
    const container = document.getElementById('toast-container');
    if (!container) {
        alert(message);
        return;
    }
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    let icon = 'ℹ️';
    if (type === 'success') icon = '✅';
    else if (type === 'error') icon = '❌';
    else if (type === 'warning') icon = '⚠️';

    toast.innerHTML = `
        <span style="font-size: 1.1rem; line-height: 1;">${icon}</span>
        <div class="toast-msg">${escapeHtml(message)}</div>
        <button class="toast-close">&times;</button>
    `;

    toast.querySelector('.toast-close').addEventListener('click', () => {
        toast.remove();
    });

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(50px)';
        setTimeout(() => toast.remove(), 250);
    }, duration);
}

function showConfirm(title, message) {
    return new Promise(resolve => {
        const modal = document.getElementById('confirm-modal');
        const titleEl = document.getElementById('confirm-modal-title');
        const msgEl = document.getElementById('confirm-modal-message');
        const btnOk = document.getElementById('confirm-modal-btn-ok');
        const btnCancel = document.getElementById('confirm-modal-btn-cancel');
        const btnClose = document.getElementById('confirm-modal-close');

        if (!modal) {
            resolve(window.confirm(message));
            return;
        }

        if (titleEl) titleEl.textContent = title;
        if (msgEl) msgEl.innerHTML = message.replace(/\n/g, '<br>');
        modal.style.display = 'flex';

        const cleanup = (val) => {
            modal.style.display = 'none';
            btnOk.onclick = null;
            btnCancel.onclick = null;
            btnClose.onclick = null;
            resolve(val);
        };

        btnOk.onclick = () => cleanup(true);
        btnCancel.onclick = () => cleanup(false);
        btnClose.onclick = () => cleanup(false);
    });
}

function getNavidromeConfigFromStorage() {
    return {
        server_url: localStorage.getItem('navidrome_server_url') || document.getElementById('navi-url')?.value || '',
        username: localStorage.getItem('navidrome_username') || document.getElementById('navi-user')?.value || '',
        password: document.getElementById('navi-pass')?.value || ''
    };
}

// ==============================================================================
// GLOBAL AUDIO PLAYER & A/B COMPARISON SYSTEM
// ==============================================================================
function initAudioPlayer() {
    const audio = document.getElementById('global-audio-element');
    if (!audio) return;
    audioPlayer.element = audio;

    const btnPlayPause = document.getElementById('player-btn-play-pause');
    const iconPlay = document.getElementById('player-icon-play');
    const iconPause = document.getElementById('player-icon-pause');
    const timeCur = document.getElementById('player-current-time');
    const timeDur = document.getElementById('player-duration-time');
    const slider = document.getElementById('player-seek-slider');
    const scrubberFill = document.getElementById('player-scrubber-fill');
    const volSlider = document.getElementById('player-volume-slider');
    const btnVol = document.getElementById('player-btn-volume');
    const btnClose = document.getElementById('player-btn-close');

    const btnAbA = document.getElementById('btn-ab-a');
    const btnAbB = document.getElementById('btn-ab-b');

    const updatePlayState = (playing) => {
        audioPlayer.isPlaying = playing;
        if (iconPlay) iconPlay.style.display = playing ? 'none' : 'block';
        if (iconPause) iconPause.style.display = playing ? 'block' : 'none';
        
        // Update table playing indicators
        document.querySelectorAll('.btn-play-track').forEach(btn => {
            const isThis = btn.dataset.path === audioPlayer.currentPath;
            btn.classList.toggle('is-playing', isThis && playing);
            btn.innerHTML = (isThis && playing) ? '⏸' : '▶';
        });
    };

    btnPlayPause?.addEventListener('click', () => {
        if (!audio.src) return;
        if (audio.paused) {
            audio.play().then(() => updatePlayState(true)).catch(e => console.error(e));
        } else {
            audio.pause();
            updatePlayState(false);
        }
    });

    audio.addEventListener('play', () => updatePlayState(true));
    audio.addEventListener('pause', () => updatePlayState(false));
    audio.addEventListener('ended', () => {
        updatePlayState(false);
        if (slider) slider.value = 0;
        if (scrubberFill) scrubberFill.style.width = '0%';
    });

    const formatTime = (secs) => {
        if (isNaN(secs) || secs < 0) return '0:00';
        const m = Math.floor(secs / 60);
        const s = Math.floor(secs % 60);
        return `${m}:${s < 10 ? '0' : ''}${s}`;
    };

    audio.addEventListener('timeupdate', () => {
        if (audio.duration && !slider.matches(':active')) {
            const pct = (audio.currentTime / audio.duration) * 100;
            if (slider) slider.value = pct;
            if (scrubberFill) scrubberFill.style.width = `${pct}%`;
            if (timeCur) timeCur.textContent = formatTime(audio.currentTime);
        }
    });

    audio.addEventListener('loadedmetadata', () => {
        if (timeDur) timeDur.textContent = formatTime(audio.duration);
    });

    slider?.addEventListener('input', () => {
        const pct = slider.value;
        if (scrubberFill) scrubberFill.style.width = `${pct}%`;
        if (audio.duration) {
            audio.currentTime = (pct / 100) * audio.duration;
            if (timeCur) timeCur.textContent = formatTime(audio.currentTime);
        }
    });

    volSlider?.addEventListener('input', () => {
        audio.volume = parseFloat(volSlider.value);
    });

    btnVol?.addEventListener('click', () => {
        audio.muted = !audio.muted;
        btnVol.style.opacity = audio.muted ? '0.4' : '1';
    });

    btnClose?.addEventListener('click', () => {
        audio.pause();
        updatePlayState(false);
        const bar = document.getElementById('audio-player-bar');
        if (bar) bar.style.display = 'none';
    });

    // A/B Channel toggle
    const switchChannel = (targetChannel) => {
        if (!audioPlayer.abActive || audioPlayer.currentChannel === targetChannel) return;
        const targetData = (targetChannel === 'A') ? audioPlayer.channelA : audioPlayer.channelB;
        if (!targetData) return;

        const curTime = audio.currentTime;
        const wasPlaying = !audio.paused;

        audioPlayer.currentChannel = targetChannel;
        audioPlayer.currentPath = targetData.path;

        if (btnAbA) btnAbA.classList.toggle('active', targetChannel === 'A');
        if (btnAbB) btnAbB.classList.toggle('active', targetChannel === 'B');

        document.getElementById('player-track-title').textContent = targetData.title || targetData.path.split('/').pop();
        document.getElementById('player-track-title').title = document.getElementById('player-track-title').textContent;
        document.getElementById('player-track-spec').textContent = targetData.specs || targetChannel;

        audio.src = `/api/stream?filepath=${encodeURIComponent(targetData.path)}`;
        audio.addEventListener('loadedmetadata', function onLoaded() {
            audio.currentTime = curTime;
            if (wasPlaying) {
                audio.play().catch(e => console.error(e));
            }
            audio.removeEventListener('loadedmetadata', onLoaded);
        });

        showToast(`🎚️ Đã chuyển sang nghe Kênh ${targetChannel}: ${targetData.title || targetData.path.split('/').pop()}`, 'info', 2000);
    };

    btnAbA?.addEventListener('click', () => switchChannel('A'));
    btnAbB?.addEventListener('click', () => switchChannel('B'));
    audioPlayer.switchChannel = switchChannel;
}

function playTrack(path, title, artist, specs, abData = null) {
    const audio = audioPlayer.element || document.getElementById('global-audio-element');
    const bar = document.getElementById('audio-player-bar');
    if (!audio || !bar) return;

    audioPlayer.currentPath = path;
    audioPlayer.currentTitle = title || path.split('/').pop();
    audioPlayer.currentArtist = artist || '';
    audioPlayer.currentSpecs = specs || '';

    bar.style.display = 'flex';
    document.getElementById('player-track-title').textContent = audioPlayer.currentTitle;
    document.getElementById('player-track-title').title = audioPlayer.currentTitle;
    document.getElementById('player-track-subtitle').textContent = audioPlayer.currentArtist || path;
    document.getElementById('player-track-spec').textContent = audioPlayer.currentSpecs || 'AUDIO';

    const abBox = document.getElementById('player-ab-box');
    if (abData && abData.fileA && abData.fileB) {
        audioPlayer.abActive = true;
        audioPlayer.channelA = abData.fileA;
        audioPlayer.channelB = abData.fileB;
        audioPlayer.currentChannel = 'A';
        if (abBox) abBox.style.display = 'inline-flex';
        const btnAbA = document.getElementById('btn-ab-a');
        const btnAbB = document.getElementById('btn-ab-b');
        if (btnAbA) btnAbA.classList.add('active');
        if (btnAbB) btnAbB.classList.remove('active');
    } else {
        audioPlayer.abActive = false;
        if (abBox) abBox.style.display = 'none';
    }

    audio.src = `/api/stream?filepath=${encodeURIComponent(path)}`;
    audio.play().catch(e => {
        console.warn("Autoplay block or stream error:", e);
    });

    document.querySelectorAll('.btn-play-track').forEach(btn => {
        const isThis = btn.dataset.path === path;
        btn.classList.toggle('is-playing', isThis);
        btn.innerHTML = isThis ? '⏸' : '▶';
    });
}

// DOM Initialization
document.addEventListener('DOMContentLoaded', () => {
    initTabs();
    initStats();
    initExplorer();
    initBatchActions();
    initAudioPlayer();
    initAudiophileLab();
    initLabCombobox();
    initVaultTiering();
    initDuplicates();
    initNavidrome();
    initNavidromeStorage();
    initOrganize();
    initModal();
    initKeyboardShortcuts();
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

        document.getElementById('stat-true-hires').textContent = counts.true_hires ?? 0;
        document.getElementById('stat-true-dsd').textContent = counts.true_dsd ?? 0;
        document.getElementById('stat-studio-master').textContent = counts.studio_master ?? 0;
        document.getElementById('stat-fake-hires').textContent = counts.fake_hires ?? 0;
        document.getElementById('stat-cd-lossless').textContent = counts.cd_lossless ?? 0;
        document.getElementById('stat-lossy').textContent = counts.lossy ?? 0;

        const elDupePill = document.getElementById('stat-dupe-meta-pill');
        if (elDupePill) {
            elDupePill.textContent = counts.duplicate_meta_groups !== undefined ? counts.duplicate_meta_groups : 0;
        }

        const elTotalPill = document.getElementById('stat-total-pill');
        if (elTotalPill) {
            elTotalPill.textContent = Number(counts.total ?? 0).toLocaleString('vi-VN');
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

    // Page size selector
    document.getElementById('select-page-size')?.addEventListener('change', (e) => {
        pageLimit = parseInt(e.target.value, 10) || 50;
        currentOffset = 0;
        loadTracks();
    });
}

function initBatchActions() {
    const chkAll = document.getElementById('check-all-tracks');
    chkAll?.addEventListener('change', () => {
        const cbs = document.querySelectorAll('.track-row-checkbox');
        cbs.forEach(cb => {
            cb.checked = chkAll.checked;
            const path = cb.dataset.path;
            const row = cb.closest('tr');
            if (chkAll.checked) {
                selectedTrackPaths.add(path);
                row?.classList.add('row-selected');
            } else {
                selectedTrackPaths.delete(path);
                row?.classList.remove('row-selected');
            }
        });
        updateBatchBar();
    });

    document.getElementById('btn-batch-clear-selection')?.addEventListener('click', () => {
        selectedTrackPaths.clear();
        document.querySelectorAll('.track-row-checkbox').forEach(cb => {
            cb.checked = false;
            cb.closest('tr')?.classList.remove('row-selected');
        });
        if (chkAll) chkAll.checked = false;
        updateBatchBar();
    });

    document.getElementById('btn-batch-tag')?.addEventListener('click', async () => {
        if (selectedTrackPaths.size === 0) return;
        const count = selectedTrackPaths.size;
        const confirmed = await showConfirm(
            'Xác nhận ghi Tag hàng loạt',
            `Bạn có chắc chắn muốn ghi tag chất lượng vào ${count} bài hát đã chọn?`
        );
        if (!confirmed) return;

        const btn = document.getElementById('btn-batch-tag');
        btn.disabled = true;
        btn.textContent = '⏳ Đang ghi...';

        try {
            const naviCfg = getNavidromeConfigFromStorage();
            const res = await fetch('/api/tag/batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    filepaths: Array.from(selectedTrackPaths),
                    navidrome_config: naviCfg
                })
            });
            const data = await res.json();
            if (data.success) {
                showToast(`✅ Đã ghi tag thành công cho ${data.tagged_count} / ${count} bài hát!`, 'success');
                selectedTrackPaths.clear();
                updateBatchBar();
                loadTracks();
            } else {
                showToast(`❌ Lỗi ghi tag hàng loạt`, 'error');
            }
        } catch (e) {
            showToast(`❌ Lỗi: ${e.message}`, 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = '🏷️ Ghi Tag Metadata';
        }
    });

    document.getElementById('btn-batch-audiophile-tag')?.addEventListener('click', async () => {
        if (selectedTrackPaths.size === 0) return;
        const count = selectedTrackPaths.size;
        const confirmed = await showConfirm(
            'Xác nhận kiểm định & ghi Tag 7 chuẩn hàng loạt',
            `Hệ thống sẽ đo lường DR, EBU R128, Audio MD5 và ghi tag đầy đủ cho ${count} bài hát đã chọn. Bạn có muốn tiếp tục?`
        );
        if (!confirmed) return;

        const btn = document.getElementById('btn-batch-audiophile-tag');
        btn.disabled = true;
        btn.textContent = '⏳ Đang kiểm định...';

        try {
            const naviCfg = getNavidromeConfigFromStorage();
            const res = await fetch('/api/audiophile/tag/batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    filepaths: Array.from(selectedTrackPaths),
                    navidrome_config: naviCfg
                })
            });
            const data = await res.json();
            if (data.success) {
                showToast(`🔬 Đã kiểm định và ghi tag 7 chuẩn cho ${data.tagged_count} / ${count} bài!`, 'success');
                selectedTrackPaths.clear();
                updateBatchBar();
                loadTracks();
            } else {
                showToast(`❌ Lỗi kiểm định 7 chuẩn hàng loạt`, 'error');
            }
        } catch (e) {
            showToast(`❌ Lỗi: ${e.message}`, 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = '🔬 Ghi Tag 7 Chuẩn';
        }
    });
}

function updateBatchBar() {
    const bar = document.getElementById('floating-batch-bar');
    const countEl = document.getElementById('batch-selected-count');
    const chkAll = document.getElementById('check-all-tracks');
    const size = selectedTrackPaths.size;
    if (countEl) countEl.textContent = size;
    document.dispatchEvent(new Event('audio-selection-change'));
    if (bar) bar.style.display = size > 0 ? 'flex' : 'none';

    const visibleCbs = document.querySelectorAll('.track-row-checkbox');
    if (chkAll && visibleCbs.length > 0) {
        chkAll.checked = Array.from(visibleCbs).every(cb => cb.checked);
    }
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
    tbody.innerHTML = `<tr><td colspan="8" class="text-center py-6 text-muted">Đang tải danh sách bài hát...</td></tr>`;

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
        currentTotalTracks = total;

        const infoEl = document.getElementById('pagination-info');
        if (infoEl) {
            infoEl.textContent = `Hiển thị ${tracks.length > 0 ? currentOffset + 1 : 0} - ${Math.min(currentOffset + tracks.length, total)} trên tổng số ${total} bài`;
        }

        const pageNum = Math.floor(currentOffset / pageLimit) + 1;
        const totalPages = Math.max(1, Math.ceil(total / pageLimit));
        const pageDisplay = document.getElementById('pagination-page-display');
        if (pageDisplay) {
            pageDisplay.textContent = `Trang ${pageNum} / ${totalPages}`;
        }
        
        const btnPrev = document.getElementById('btn-prev-page');
        const btnNext = document.getElementById('btn-next-page');
        if (btnPrev) btnPrev.disabled = currentOffset <= 0;
        if (btnNext) btnNext.disabled = (currentOffset + pageLimit) >= total;

        if (tracks.length === 0) {
            tbody.innerHTML = `<tr><td colspan="8" class="text-center py-6 text-muted">Không tìm thấy bài hát nào phù hợp với bộ lọc cột hoặc từ khóa tìm kiếm.</td></tr>`;
            return;
        }

        let html = '';
        tracks.forEach((track, idx) => {
            const verdictStyles = {
                FORMAT_HIRES: ['indigo', 'PCM sample rate cao'],
                DSD_SOURCE_UNVERIFIED: ['cyan', 'DSD, nguồn chưa xác thực'],
                REVIEW: ['amber', 'Cần xem xét'],
                INTEGRITY_FAIL: ['rose', 'Lỗi toàn vẹn'],
                TRUE_DSD: ['cyan', 'True DSD'],

                FAKE_HIRES_UPSAMPLED: ['rose', 'Fake Hi-Res'],
                FAKE_LOSSLESS: ['rose', 'Fake Lossless'],
                FAKE_24BIT: ['rose', 'Fake 24-bit'],
                DSD_CONVERTED_FROM_PCM: ['rose', 'DSD từ PCM'],
                CD_LOSSLESS: ['indigo', 'CD Lossless'],
                LOSSY: ['slate', 'Lossy'],
                SUSPICIOUS_HIRES: ['amber', 'Cần kiểm định thêm']
            };
            const [color, label] = verdictStyles[track.verdict] || ['slate', 'Chưa kiểm định'];
            const note = track.verdict_source === 'metadata'
                ? 'Phân loại từ định dạng và metadata; chưa kiểm định chất lượng âm thanh'
                : '';
            const verdictBadge = `<span class="stat-tag tag-${color}" title="${note}">${label}</span>`;

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
            const isSelected = selectedTrackPaths.has(track.original_path);
            const isPlayingThis = (audioPlayer.currentPath === track.original_path && audioPlayer.isPlaying);

            html += `
                <tr class="${isSelected ? 'row-selected' : ''}">
                    <td class="td-checkbox">
                        <input type="checkbox" class="track-checkbox track-row-checkbox" data-path="${escapeHtml(track.original_path)}" ${isSelected ? 'checked' : ''}>
                    </td>
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
                            <button class="btn-action-icon btn-play-track ${isPlayingThis ? 'is-playing' : ''}" data-path="${escapeHtml(track.original_path)}" data-title="${escapeHtml(track.title || track.original_path)}" data-artist="${escapeHtml(track.artist || '')}" data-specs="${escapeHtml(track.specs || '')}" title="Phát nghe thử trực tiếp">
                                ${isPlayingThis ? '⏸' : '▶'}
                            </button>
                            <button class="btn-action-icon btn-inspect" data-path="${escapeHtml(track.original_path)}" data-title="${escapeHtml(track.title || track.original_path)}" data-specs="${escapeHtml(track.specs)}" title="Xem Spectrogram & Thông Số">
                                📊
                            </button>
                            <button class="btn-action-icon btn-lab-jump" data-path="${escapeHtml(track.original_path)}" title="Kiểm tra tính nhất quán kỹ thuật của bài này">
                                🔬
                            </button>
                            ${track.is_duplicate_meta ? `
                            <button class="btn-action-icon btn-jump-dupes" data-title="${escapeHtml(track.title || track.original_path)}" title="Mở chi tiết so sánh & dọn dẹp các bản trùng trong tab Trùng Lặp">
                                🔍
                            </button>
                            ` : ''}
                            <button class="btn-action-icon btn-tag-file" data-path="${escapeHtml(track.original_path)}" title="Ghi tag metadata">
                                🏷️
                            </button>
                            <button class="btn-action-icon btn-untag-file" data-path="${escapeHtml(track.original_path)}" title="Hoàn tác / Khôi phục metadata gốc">
                                ↩️
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        });

        tbody.innerHTML = html;

        // Attach play button events
        document.querySelectorAll('.btn-play-track').forEach(btn => {
            btn.addEventListener('click', () => {
                if (audioPlayer.currentPath === btn.dataset.path && audioPlayer.isPlaying) {
                    audioPlayer.element?.pause();
                } else {
                    playTrack(btn.dataset.path, btn.dataset.title, btn.dataset.artist, btn.dataset.specs);
                }
            });
        });

        // Attach row checkbox events
        document.querySelectorAll('.track-row-checkbox').forEach(cb => {
            cb.addEventListener('change', () => {
                const p = cb.dataset.path;
                const row = cb.closest('tr');
                if (cb.checked) {
                    selectedTrackPaths.add(p);
                    row?.classList.add('row-selected');
                } else {
                    selectedTrackPaths.delete(p);
                    row?.classList.remove('row-selected');
                }
                updateBatchBar();
            });
        });

        // Update master checkbox
        const chkAll = document.getElementById('check-all-tracks');
        if (chkAll) {
            chkAll.checked = tracks.length > 0 && tracks.every(t => selectedTrackPaths.has(t.original_path));
        }

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
        tbody.innerHTML = `<tr><td colspan="8" class="text-center py-6 text-rose">Lỗi khi tải dữ liệu bài hát: ${e.message}</td></tr>`;
    }
}

// ==============================================================================
// 4. AUDIOPHILE 7-PILLAR STUDIO LAB
// ==============================================================================
function initAudiophileLab() {
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
                showToast(`✅ ${data.message}`, 'success');
                if (typeof loadTracks === 'function') loadTracks();
            } else {
                showToast(`❌ Lỗi: ${data.message}`, 'error');
            }
        } catch (e) {
            showToast(`❌ Lỗi: ${e.message}`, 'error');
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

function clearLabAudit() {
    currentAuditResult = null;
    document.getElementById('audiophile-pillars-grid').hidden = true;
    document.getElementById('additional-current').textContent = 'Chưa đo chẩn đoán bổ sung cho bài đang chọn.';
    ['btn-audiophile-tag-now', 'btn-audiophile-untag-now'].forEach(id => {
        document.getElementById(id).style.display = 'none';
    });
}

function selectLabTrack(path, title = path) {
    document.getElementById('lab-selected-path').value = path;
    document.getElementById('lab-combobox-input').value = title;
    document.getElementById('lab-combobox-clear').style.display = title ? 'block' : 'none';
    document.getElementById('btn-run-audiophile-audit').disabled = !path;
    clearLabAudit();
    document.dispatchEvent(new Event('audio-selection-change'));
}

function initLabCombobox() {
    const input = document.getElementById('lab-combobox-input');
    const dropdown = document.getElementById('lab-combobox-dropdown');
    const hiddenPath = document.getElementById('lab-selected-path');
    let debounce, controller, active = -1;
    const close = () => {
        dropdown.style.display = 'none';
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
    };
    input.addEventListener('input', () => {
        const q = input.value.trim();
        selectLabTrack('', input.value);
        clearTimeout(debounce);
        controller?.abort();
        close();
        if (!q) return;
        debounce = setTimeout(async () => {
            controller = new AbortController();
            try {
                const res = await fetch(`/api/tracks?search=${encodeURIComponent(q)}&limit=25`, {signal: controller.signal});
                if (!res.ok) throw new Error('Không tải được danh sách bài. Hãy thử lại.');
                const data = await res.json();
                if (input.value.trim() !== q || hiddenPath.value) return;
                dropdown.replaceChildren(); active = -1;
                (data.tracks || []).forEach((track, index) => {
                    const item = document.createElement('button');
                    item.type = 'button'; item.className = 'combobox-item'; item.id = `lab-option-${index}`;
                    item.setAttribute('role', 'option'); item.setAttribute('aria-selected', 'false');
                    item.innerHTML = `<span><span class="combobox-item-title">${escapeHtml(track.title || track.original_path)}</span><span class="combobox-item-sub">${escapeHtml(track.artist || '')} · ${escapeHtml(track.original_path)}</span></span>`;
                    item.addEventListener('click', () => {
                        selectLabTrack(track.original_path, track.title || track.original_path);
                        close(); input.focus();
                    });
                    dropdown.append(item);
                });
                if (!dropdown.children.length) dropdown.textContent = 'Không tìm thấy bài. Thử tên nghệ sĩ hoặc đường dẫn khác.';
                dropdown.style.display = 'block'; input.setAttribute('aria-expanded', 'true');
            } catch (error) {
                if (error.name === 'AbortError') return;
                dropdown.textContent = error.message;
                dropdown.style.display = 'block'; input.setAttribute('aria-expanded', 'true');
            }
        }, 250);
    });
    input.addEventListener('keydown', e => {
        const items = [...dropdown.querySelectorAll('.combobox-item')];
        if (e.key === 'Escape') { close(); e.stopPropagation(); }
        if (dropdown.style.display === 'none' || !items.length) return;
        if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
            e.preventDefault();
            active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            items.forEach((item, index) => { item.classList.toggle('active', index === active); item.setAttribute('aria-selected', index === active ? 'true' : 'false'); });
            input.setAttribute('aria-activedescendant', items[active].id);
            items[active].scrollIntoView({block: 'nearest'});
        } else if (e.key === 'Enter') {
            e.preventDefault(); items[Math.max(0, active)].click();
        }
    });
    input.addEventListener('focus', () => {
        if (input.value.trim() && !hiddenPath.value) input.dispatchEvent(new Event('input'));
    });
    document.getElementById('lab-combobox-clear').addEventListener('click', () => {
        clearTimeout(debounce); controller?.abort(); selectLabTrack(''); close(); input.focus();
    });
    document.addEventListener('click', e => {
        if (!e.target.closest('.track-picker-card')) close();
    });
    document.getElementById('btn-run-audiophile-audit').addEventListener('click', () => {
        if (hiddenPath.value) runAudiophileAuditForPath(hiddenPath.value);
    });
}

function jumpToAudiophileLab(filepath) {
    switchTab('tab-audiophile');
    selectLabTrack(filepath, filepath.split('/').pop());
    const scope = document.getElementById('scoring-target');
    scope.value = 'single'; scope.dispatchEvent(new Event('change'));
    document.getElementById('scoring-single').click();
}

async function runAudiophileAuditForPath(filepath) {
    const loadingBox = document.getElementById('audiophile-loading-box');
    const btnTagNow = document.getElementById('btn-audiophile-tag-now');
    if (loadingBox) loadingBox.style.display = 'block';
    const auditButton = document.getElementById('btn-run-audiophile-audit');
    auditButton.disabled = true;
    clearLabAudit();

    try {
        const res = await fetch('/api/audiophile/audit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filepath })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Không phân tích được audio');
        if (document.getElementById('lab-selected-path').value !== filepath) return;
        renderAudiophileAuditResults(data);
        currentAuditResult = data;
        if (btnTagNow) btnTagNow.style.display = 'inline-block';
        const btnUntagNow = document.getElementById('btn-audiophile-untag-now');
        if (btnUntagNow) btnUntagNow.style.display = 'inline-block';
    } catch (e) {
        showToast(`Không hoàn tất chẩn đoán: ${e.message}`, 'error');
    } finally {
        if (loadingBox) loadingBox.style.display = 'none';
        auditButton.disabled = !document.getElementById('lab-selected-path').value;
    }
}

function renderAudiophileAuditResults(data) {
    if (data.authenticity && window.renderAuthenticity) window.renderAuthenticity(data.authenticity);
    document.getElementById('audiophile-pillars-grid').hidden = false;
    document.getElementById('additional-current').textContent = `Chẩn đoán của: ${data.filename || data.filepath}`;
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

    // fakeflac Spectral Cutoff
    const spec = data.spectrum || {};
    const elCutoffHz = document.getElementById('pillar-cutoff-hz');
    const elCutoffDrop = document.getElementById('pillar-cutoff-drop');
    if (elCutoffHz) {
        elCutoffHz.textContent = spec.cutoff_hz ? `${spec.cutoff_hz.toLocaleString()} Hz` : 'N/A';
    }
    if (elCutoffDrop) {
        elCutoffDrop.textContent = spec.cutoff_drop_db != null ? `-${spec.cutoff_drop_db} dB` : '--';
    }

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
        loudBadge.textContent = loudness.replaygain_track_gain || 'ReplayGain chưa đo được';
    }
    document.getElementById('loudness-lufs-val').textContent = `${loudness.integrated_lufs !== undefined ? loudness.integrated_lufs + ' LUFS' : '--'}`;
    document.getElementById('loudness-peak-val').textContent = `${loudness.true_peak_db !== undefined ? loudness.true_peak_db + ' dBTP' : '--'}`;
    document.getElementById('loudness-rg-val').textContent = loudness.replaygain_track_gain || '--';
    document.getElementById('loudness-msg-desc').textContent = loudness.error || `Target: -18 LUFS (ReplayGain 2.0) | R128 Gain: ${loudness.r128_track_gain || '--'}. Bit-perfect, không suy hao âm chất.`;

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

    // Interactive Click on 3 Tier Cards to filter plan table
    document.querySelectorAll('.clickable-tier').forEach(card => {
        card.addEventListener('click', () => {
            const tier = card.dataset.tier;
            document.querySelectorAll('.clickable-tier').forEach(c => c.style.outline = 'none');
            card.style.outline = '2px solid var(--accent-indigo)';

            tierPlanFilter = tier;
            const badge = document.getElementById('plan-filter-active-badge');
            if (badge) {
                badge.textContent = `Đang lọc: ${card.querySelector('h3')?.textContent || tier}`;
                badge.style.display = 'inline-block';
            }
            renderVaultTieringPlanTable();
        });
    });

    document.getElementById('btn-tier-filter-all')?.addEventListener('click', () => {
        tierPlanFilter = 'all';
        document.querySelectorAll('.clickable-tier').forEach(c => c.style.outline = 'none');
        const badge = document.getElementById('plan-filter-active-badge');
        if (badge) badge.style.display = 'none';
        renderVaultTieringPlanTable();
    });

    const searchInput = document.getElementById('tiering-search-input');
    let searchDebounce = null;
    searchInput?.addEventListener('input', (e) => {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => {
            tierPlanSearch = e.target.value.trim().toLowerCase();
            renderVaultTieringPlanTable();
        }, 200);
    });

    document.getElementById('btn-execute-tiering')?.addEventListener('click', async () => {
        if (!currentTieringPlan || !currentTieringPlan.items) {
            showToast('Chưa có dữ liệu kế hoạch phân cấp. Đang tải lại...', 'warning');
            await loadVaultTieringPlan();
        }

        const modeText = selectedTieringMode === 'symlink' ?
            'TẠO LIÊN KẾT MỀM (SYMLINK)\n👉 An toàn tuyệt đối 100%: File gốc KHÔNG bị di chuyển hay thay đổi vị trí!' :
            'DI CHUYỂN THẬT (MOVE)\n👉 Các file sẽ được di chuyển vào 3 thư mục tương ứng. Hệ thống tự động tạo file rollback để khôi phục bất cứ lúc nào!';

        const confirmed = await showConfirm(
            `Xác nhận thực thi phân cấp (${currentTieringPlan.total_files} bài)`,
            `Bạn có chắc chắn muốn thực thi phân loại ${currentTieringPlan.total_files} bài hát theo chế độ:\n\n${modeText}`
        );
        if (!confirmed) return;

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
                showToast(`✅ ${data.message}`, 'success', 5000);
            } else {
                statusMsg.innerHTML = `<span class="text-rose">❌ Lỗi: ${data.message}</span>`;
                showToast(`❌ Lỗi: ${data.message}`, 'error');
            }
        } catch (e) {
            statusMsg.innerHTML = `<span class="text-rose">❌ Lỗi: ${e.message}</span>`;
            showToast(`❌ Lỗi: ${e.message}`, 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = '⚡ 1-Click Thực Thi Phân Cấp Kho Nhạc';
        }
    });

    document.getElementById('btn-rollback-tiering')?.addEventListener('click', async () => {
        const confirmed = await showConfirm(
            'Khôi phục vị trí thư mục (Rollback)',
            'Hệ thống sẽ đối chiếu .vault_tiering_rollback.json và khôi phục toàn bộ các tệp đã di chuyển về lại đúng vị trí thư mục nguyên bản. Bạn có muốn tiếp tục?'
        );
        if (!confirmed) return;

        const btn = document.getElementById('btn-rollback-tiering');
        btn.disabled = true;
        btn.textContent = '⏳ Đang khôi phục...';

        try {
            const res = await fetch('/api/vault/tiering/rollback', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                showToast(`✅ ${data.message}`, 'success');
                await loadVaultTieringPlan();
            } else {
                showToast(`❌ ${data.message}`, 'error');
            }
        } catch (e) {
            showToast(`❌ Lỗi: ${e.message}`, 'error');
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

        renderVaultTieringPlanTable();
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="4" class="text-center py-6 text-rose">Lỗi tải kế hoạch: ${e.message}</td></tr>`;
    }
}

function renderVaultTieringPlanTable() {
    const tbody = document.getElementById('tiering-preview-tbody');
    if (!tbody || !currentTieringPlan) return;

    let items = currentTieringPlan.items || [];
    if (tierPlanFilter !== 'all') {
        items = items.filter(it => it.tier === tierPlanFilter || it.tier_id === tierPlanFilter);
    }
    if (tierPlanSearch) {
        items = items.filter(it => 
            (it.title || '').toLowerCase().includes(tierPlanSearch) ||
            (it.original_path || '').toLowerCase().includes(tierPlanSearch) ||
            (it.dest_path || '').toLowerCase().includes(tierPlanSearch)
        );
    }

    if (items.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="text-center py-6 text-muted">Không có bài hát nào phù hợp với bộ lọc hoặc từ khóa tìm kiếm.</td></tr>`;
        return;
    }

    let html = '';
    items.slice(0, 100).forEach(item => {
        let tierTag = '';
        if (item.tier === '01_Hi-Res & DSD' || item.tier === 'tier_1') {
            tierTag = `<span class="stat-tag tag-cyan">Tầng 1 &bull; Hi-Res</span>`;
        } else if (item.tier === '02_Lossless_CD' || item.tier === 'tier_2') {
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

    // 6. Auto-pick best audio quality for all duplicate groups using Audiophile Quality Standards
    document.getElementById('btn-auto-pick-best-dupes')?.addEventListener('click', () => {
        let allGroups = [];
        if (duplicatesData) {
            allGroups = [
                ...(duplicatesData.byte_duplicates || []),
                ...(duplicatesData.meta_duplicates || []),
                ...(duplicatesData.name_duplicates || [])
            ];
        }
        let changed = 0;
        allGroups.forEach((item, idx) => {
            const gId = item.id || item.hash || (`grp_${idx}`);
            const files = item.files || [];
            if (files.length <= 1) return;

            let bestFile = null;
            let bestScore = -Infinity;
            files.forEach(f => {
                const filePath = typeof f === 'string' ? f : f.path;
                const score = scoreAudiophileQuality(f);

                if (score > bestScore) {
                    bestScore = score;
                    bestFile = filePath;
                }
            });

            if (bestFile) {
                userSelectedKeep[gId] = bestFile;
                changed++;
            }
        });

        renderDuplicates();
        showToast(`⚡ Đã tự động chọn bản tối ưu theo chuẩn Audiophile cho ${changed} nhóm trùng lặp!`, 'success');
    });
}

function scoreAudiophileQuality(f) {
    const path = typeof f === 'string' ? f : (f.path || '');
    const filename = path.split('/').pop() || '';
    const fnLower = filename.toLowerCase();
    const ext = (filename.split('.').pop() || '').toLowerCase();
    const specs = ((typeof f === 'object' && f.specs) ? f.specs : '').toLowerCase();
    const sizeMb = (typeof f === 'object' && f.size_mb) ? parseFloat(f.size_mb) : 0;
    const art = ((typeof f === 'object' && f.artist) ? f.artist : '').trim().toLowerCase();
    const tit = ((typeof f === 'object' && f.title) ? f.title : '').trim().toLowerCase();
    const alb = ((typeof f === 'object' && f.album) ? f.album : '').trim().toLowerCase();

    let score = 1000.0;

    // 1. Format Tier (Thứ hạng định dạng)
    if (['dsf', 'dff'].includes(ext)) {
        score += 5000.0;
    } else if (['flac', 'wav', 'aif', 'aiff', 'alac', 'ape'].includes(ext)) {
        if (specs.includes('24bit') || specs.includes('32bit') || specs.includes('96k') || specs.includes('192k') || specs.includes('88.2k') || specs.includes('176.4k')) {
            score += 4500.0;
        } else {
            score += 3500.0;
        }
    } else if (['m4a', 'aac', 'ogg', 'opus'].includes(ext)) {
        score += 1800.0;
    } else if (ext === 'mp3') {
        score += 1200.0;
    } else {
        score += 800.0;
    }

    // 2. Technical specs precision
    if (specs.includes('24bit') || specs.includes('32bit')) score += 600.0;
    if (specs.includes('192k') || specs.includes('176.4k')) score += 500.0;
    else if (specs.includes('96k') || specs.includes('88.2k')) score += 400.0;
    else if (specs.includes('48k')) score += 100.0;

    if (specs.includes('320k')) score += 250.0;
    else if (specs.includes('256k')) score += 150.0;
    else if (specs.includes('128k')) score -= 300.0;

    // File size bonus (chống file bị cắt cụt)
    score += Math.min(sizeMb * 2.0, 300.0);

    // 3. Trừ điểm rất nặng bản sao lưu tải trùng
    if (/\(\s*\d+\s*\)/.test(filename)) score -= 8000.0;
    if (/\[\s*\d+\s*\](?!\s*[\.\w])/.test(filename)) score -= 6000.0;
    if (/[-_\s]copy\b/i.test(fnLower)) score -= 8000.0;
    if (/_1\.[a-z0-9]+$/i.test(fnLower)) score -= 5000.0;

    // 4. Trừ điểm tệp dán nhãn web rip / tag video rác
    if (/nhacpro\.net|chiasenhac|nhaccuatui|zingmp3|y2mate|tubidy/i.test(fnLower)) score -= 3000.0;
    if (/\((official\s*(?:mv|music\s*video|audio|video)|lyric\s*video)\)/i.test(fnLower)) score -= 1500.0;
    if (/\((128\s*kbps)\)/i.test(fnLower)) score -= 2500.0;
    if (/\((320\s*kbps)\)/i.test(fnLower)) score -= 300.0;
    if (filename.startsWith('#') || filename.startsWith('.')) score -= 500.0;
    if (filename.includes(' - - ') || filename.includes('--')) score -= 300.0;

    // 5. Cấu trúc thư mục: ưu tiên nằm trong album hoàn chỉnh
    const parts = path.split('/').filter(Boolean);
    const depth = parts.length - 1;
    if (depth >= 2) {
        score += 500.0;
        const parent = parts[parts.length - 2].toLowerCase();
        if (/\[\d{4}\]|\(\d{4}\)|\b(19\d\d|20\d\d)\b/.test(parent)) score += 300.0;
        if (/album|disc|cd|vinyl|remaster|soundtrack|ost/.test(parent)) score += 200.0;
    } else if (depth === 1) {
        score += 200.0;
    } else {
        score -= 400.0; // file vứt mồ côi ở root
    }

    // Track number ở đầu tên file (01., 10.)
    if (/^\d{2,3}[\.\s_-]/.test(filename)) score += 150.0;

    // 6. Metadata đầy đủ
    if (tit && !['track', 'untitled', 'no title'].includes(tit)) score += 150.0;
    if (art && !['unknown', 'unknown artist', 'none'].includes(art)) score += 150.0;
    if (alb && !['unknown', 'unknown album', 'none', 'singles'].includes(alb)) score += 150.0;

    // Tiếng Việt chuẩn có dấu
    const vnChars = /[àáảãạâầấẩẫậăằắẳẵặèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđĐ]/i;
    if (vnChars.test(filename)) score += 200.0;

    return score;
}

async function loadDuplicates(refresh = false) {
    const container = document.getElementById('dupes-container');
    if (!container) return;
    container.innerHTML = `<p class="text-center py-6 text-muted">Đang quét tìm tệp trùng lặp (SQLite Cache)...</p>`;

    try {
        const res = await fetch(`/api/duplicates?refresh=${refresh}`);
        if (!res.ok) throw new Error('Không tải được kết quả quét trùng lặp');
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
        if (navBadge) {
            navBadge.textContent = badgeCount;
            const groupType = byteCount ? 'trùng byte' : metaCount ? 'trùng metadata' : 'trùng tên file';
            navBadge.title = badgeCount ? `${badgeCount} nhóm ${groupType}; không phải số file` : 'Không tìm thấy nhóm trùng lặp';
        }

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
                        ${files.length >= 2 ? `
                        <button class="btn btn-sm btn-emerald btn-group-play-ab" data-groupid="${groupId}" title="Nghe và chuyển đổi tức thì giữa bản giữ và bản phụ">
                            ▶ Nghe A/B
                        </button>
                        ` : ''}
                        <button class="btn btn-sm btn-secondary btn-archive-single-group" data-groupid="${groupId}">
                            📦 Archive (${numToArchive} bản)
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

                        const qScore = Math.round(scoreAudiophileQuality(f));
                        const scoreDisplay = (qScore > 0 ? '+' : '') + qScore;

                        let extBadgeClass = 'tag-slate';
                        if (['FLAC', 'APE'].includes(ext)) extBadgeClass = 'tag-emerald';
                        else if (['DSF', 'DFF'].includes(ext)) extBadgeClass = 'tag-cyan';
                        else if (['WAV', 'ALAC'].includes(ext)) extBadgeClass = 'tag-indigo';
                        else if (['M4A', 'AAC'].includes(ext)) extBadgeClass = 'tag-amber';

                        return `
                            <div class="dupe-file-row ${isKept ? 'is-kept' : 'is-archive'}" data-groupid="${groupId}" data-file="${escapeHtml(filePath)}" data-score="${scoreDisplay}">
                                <input type="radio" name="dupe_radio_${groupId}" class="dupe-radio-custom" value="${escapeHtml(filePath)}" ${isKept ? 'checked' : ''}>
                                <span class="${isKept ? 'dupe-badge-keep' : 'dupe-badge-archive'}">
                                    ${isKept ? '🟢 ĐỀ XUẤT GIỮ' : '🗑️ BẢN PHỤ'} <span class="dupe-score-tag" style="opacity: 0.85; font-size: 0.72rem; margin-left: 3px;">(${scoreDisplay}đ)</span>
                                </span>
                                <span class="stat-tag ${extBadgeClass}" style="font-size: 0.72rem; padding: 2px 7px; font-weight: 600;">
                                    .${ext}
                                </span>
                                ${specs ? `<span class="dupe-specs-tag">${escapeHtml(specs)}</span>` : ''}
                                <code class="dupe-path-code">${escapeHtml(filePath)}</code>
                                ${album ? `<span class="dupe-tag-pill dupe-tag-album">${escapeHtml(album)}</span>` : ''}
                                ${sizeMb ? `<span class="text-secondary" style="font-size: 0.75rem; font-family: 'JetBrains Mono', monospace; white-space: nowrap;">${sizeMb}</span>` : ''}
                                ${hasNum ? `<span class="dupe-tag-pill dupe-tag-number">Đuôi (${fileName.match(/\((\d+)\)/)?.[1] || 'số'})</span>` : ''}
                                ${typeof f === 'object' && f.acoustic_match_pct !== undefined && f.acoustic_match_pct !== null && !isKept ? `
                                    <span class="stat-tag ${f.acoustic_match_pct >= 80 ? 'tag-emerald' : 'tag-rose'}" style="font-size: 0.72rem; padding: 2px 7px;" title="Độ khớp vân tay Chromaprint với bản đề xuất giữ">
                                        🎵 ${f.acoustic_match_pct}% Khớp
                                    </span>
                                ` : ''}
                                ${!isKept ? `
                                <button class="btn btn-xs btn-outline btn-row-compare-acoustic" title="So sánh dấu vân tay âm học Chromaprint với bản giữ" data-file1="${escapeHtml(keptFile)}" data-file2="${escapeHtml(filePath)}">
                                    🎵 So Âm
                                </button>
                                ` : ''}
                                <button class="btn btn-xs btn-outline btn-row-play" title="Phát nghe thử tệp âm thanh này" data-file="${escapeHtml(filePath)}" data-title="${escapeHtml(fileName)}" data-specs="${escapeHtml(specs || ext)}">
                                    ▶ Nghe
                                </button>
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
            if (e.target.closest('.btn-row-spectrogram') || e.target.closest('.btn-row-play') || e.target.closest('.btn-row-compare-acoustic')) return;

            const gId = row.dataset.groupid;
            const file = row.dataset.file;
            if (!gId || !file) return;

            userSelectedKeep[gId] = file;

            const card = row.closest('.dupe-card');
            if (card) {
                card.querySelectorAll('.dupe-file-row').forEach(r => {
                    const rFile = r.dataset.file;
                    const radio = r.querySelector('input[type="radio"]');
                    const badge = r.querySelector('.dupe-badge-keep, .dupe-badge-archive');
                    const sVal = r.dataset.score || '';
                    
                    if (rFile === file) {
                        r.classList.add('is-kept');
                        r.classList.remove('is-archive');
                        if (radio) radio.checked = true;
                        if (badge) {
                            badge.className = 'dupe-badge-keep';
                            badge.innerHTML = `🟢 ĐỀ XUẤT GIỮ <span class="dupe-score-tag" style="opacity: 0.85; font-size: 0.72rem; margin-left: 3px;">(${sVal}đ)</span>`;
                        }
                    } else {
                        r.classList.remove('is-kept');
                        r.classList.add('is-archive');
                        if (radio) radio.checked = false;
                        if (badge) {
                            badge.className = 'dupe-badge-archive';
                            badge.innerHTML = `🗑️ BẢN PHỤ <span class="dupe-score-tag" style="opacity: 0.85; font-size: 0.72rem; margin-left: 3px;">(${sVal}đ)</span>`;
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

    // 2. Attach row play buttons
    container.querySelectorAll('.btn-row-play').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            playTrack(btn.dataset.file, btn.dataset.title, '', btn.dataset.specs);
        });
    });

    // 2b. Attach acoustic fingerprint comparison buttons
    container.querySelectorAll('.btn-row-compare-acoustic').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const f1 = btn.dataset.file1;
            const f2 = btn.dataset.file2;
            if (!f1 || !f2) return;
            btn.textContent = '⏳...';
            btn.disabled = true;
            try {
                const res = await fetch('/api/fingerprint/compare', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ file1: f1, file2: f2 })
                });
                const data = await res.json();
                if (data.match_pct !== undefined) {
                    showToast(`🎵 Khớp ${data.match_pct}%: ${data.explanation}`, data.is_identical ? 'success' : 'info');
                    btn.textContent = `🎵 ${data.match_pct}%`;
                    btn.className = `btn btn-xs ${data.is_identical ? 'btn-emerald' : 'btn-outline-rose'} btn-row-compare-acoustic`;
                } else {
                    showToast(`❌ Lỗi: ${data.detail || 'Không thể so sánh'}`, 'error');
                    btn.textContent = '🎵 So Âm';
                }
            } catch (err) {
                showToast(`❌ Lỗi kết nối: ${err.message}`, 'error');
                btn.textContent = '🎵 So Âm';
            } finally {
                btn.disabled = false;
            }
        });
    });

    // 3. Attach group A/B comparison buttons
    container.querySelectorAll('.btn-group-play-ab').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const gId = btn.dataset.groupid;
            const item = currentFilteredDuplicates.find(it => (it.id || it.hash || '') === gId) ||
                         currentFilteredDuplicates[parseInt(gId.replace('grp_', ''), 10)];
            if (!item || !item.files || item.files.length < 2) return;

            const kept = userSelectedKeep[gId] || (typeof item.files[0] === 'string' ? item.files[0] : item.files[0].path);
            const other = item.files.find(f => {
                const p = typeof f === 'string' ? f : f.path;
                return p !== kept;
            });
            const otherPath = typeof other === 'string' ? other : (other ? other.path : '');

            playTrack(kept, `${item.title || kept.split('/').pop()} (Kênh A)`, item.artist || '', 'Bản A', {
                fileA: { path: kept, title: `${item.title || kept.split('/').pop()} [Bản A - Giữ]`, specs: 'Bản A' },
                fileB: { path: otherPath, title: `${item.title || otherPath.split('/').pop()} [Bản B - Phụ]`, specs: 'Bản B' }
            });
        });
    });

    // 4. Attach spectrogram button event
    container.querySelectorAll('.btn-row-spectrogram').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const filePath = btn.dataset.file;
            const title = btn.dataset.title;
            const specs = btn.dataset.specs;
            openSpectrogramModal(filePath, title, specs);
        });
    });

    // 5. Attach single group archive buttons
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
                showToast("Không có bản phụ nào trong nhóm này để di chuyển!", 'warning');
                return;
            }

            const title = item.title ? `${item.artist} - ${item.title}` : (item.filename || 'nhóm này');
            const confirmed = await showConfirm(
                'Lưu trữ bản phụ nhóm trùng lặp',
                `Di chuyển ${toArchive.length} bản phụ của bài "${title}" vào thư mục "_Duplicates_Archive/"?\n\nFile giữ lại: ${kept}`
            );
            if (!confirmed) return;

            await archiveSingleGroup(toArchive, btn);
        });
    });

    updateDupeArchiveButton(filteredList);
}

async function archiveSingleGroup(toArchive, btn) {
    if (!toArchive || toArchive.length === 0) return;
    if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ Đang di chuyển...';
    }
    try {
        const res = await fetch('/api/duplicates/archive-byte-dupes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ files_to_archive: toArchive })
        });
        const data = await res.json();
        if (data.success) {
            showToast(`✅ Đã di chuyển ${data.archived_count || toArchive.length} bản phụ vào _Duplicates_Archive`, 'success');
            await loadDuplicates(true);
        } else {
            showToast(`❌ Lỗi: ${data.message || 'Không thể di chuyển file'}`, 'error');
            if (btn) {
                btn.disabled = false;
                btn.textContent = '📦 Archive nhóm này';
            }
        }
    } catch (err) {
        showToast(`❌ Lỗi: ${err.message}`, 'error');
        if (btn) {
            btn.disabled = false;
            btn.textContent = '📦 Archive nhóm này';
        }
    }
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
        showToast("Không có bản phụ nào được chọn để di chuyển!", 'warning');
        return;
    }

    const typeDesc = currentDupeType === 'meta' ? 'trùng Metadata' : (currentDupeType === 'name' ? 'trùng Tên tệp' : 'trùng 100% Byte');
    const filterContext = dupeSubFilter !== 'all' ? ` [Bộ lọc: ${dupeSubFilter}]` : (dupeSearchQuery ? ` [Tìm kiếm: "${dupeSearchQuery}"]` : '');
    const confirmed = await showConfirm(
        'Xác nhận di chuyển bản phụ hàng loạt',
        `Hệ thống sẽ:\n• Giữ lại ${activeList.length} bản chất lượng cao nhất bạn đã chọn\n• Di chuyển an toàn ${filesToArchive.length} bản phụ (${typeDesc}${filterContext}) vào thư mục '_Duplicates_Archive/'\n\nBạn có chắc chắn muốn thực hiện?`
    );
    if (!confirmed) return;

    const btn = document.getElementById('btn-archive-byte-dupes');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ Đang di chuyển bản phụ...';
    }

    try {
        const res = await fetch('/api/duplicates/archive-byte-dupes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ files_to_archive: filesToArchive })
        });
        const data = await res.json();
        if (data.success) {
            showToast(`✅ ${data.message}`, 'success');
            await loadDuplicates(true);
        } else {
            showToast(`❌ Lỗi: ${data.message}`, 'error');
        }
    } catch (e) {
        showToast(`❌ Lỗi: ${e.message}`, 'error');
    } finally {
        if (btn) btn.disabled = false;
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
    const form = document.getElementById('metadata-organize-form');
    const status = document.getElementById('metadata-organize-status');
    const apply = document.getElementById('metadata-organize-apply');
    const filter = document.getElementById('metadata-organize-filter');
    const filenameFormat = document.getElementById('metadata-organize-format');
    const search = document.getElementById('metadata-organize-search');
    const changeFilter = document.getElementById('metadata-organize-change');
    let plan = null;
    const labels = {READY: 'Sẵn sàng', REVIEW: 'Cần kiểm tra', CONFLICT: 'Trùng đích', UNCHANGED: 'Đã đúng vị trí'};
    const buttons = ['metadata-organize-preview', 'metadata-organize-apply', 'metadata-organize-undo'];
    const setBusy = busy => {
        document.getElementById('metadata-organize-folder').disabled = busy;
        filenameFormat.disabled = busy;
        buttons.forEach(id => {
            document.getElementById(id).disabled = busy || (id === 'metadata-organize-apply' && !plan?.counts.READY);
        });
    };
    const request = async (action, body = {}) => {
        const res = await fetch(`/api/organize/${action}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Không hoàn tất thao tác.');
        return data;
    };
    const render = () => {
        const rows = document.getElementById('metadata-organize-rows'); rows.replaceChildren();
        const query = search.value.trim().toLocaleLowerCase();
        const items = (plan?.items || []).filter(item => {
            if (filter.value !== 'all' && item.status !== filter.value) return false;
            const renamed = item.dest_path && item.original_path.split('/').pop() !== item.dest_path.split('/').pop();
            const moved = item.dest_path && item.original_path !== item.dest_path;
            if (changeFilter.value === 'rename' && !renamed) return false;
            if (changeFilter.value === 'move' && (renamed || !moved)) return false;
            return !query || [item.original_path, item.dest_path, item.title, item.artist, item.album]
                .some(value => (value || '').toLocaleLowerCase().includes(query));
        });
        const fragment = document.createDocumentFragment();
        items.forEach(item => {
            const row = document.createElement('tr');
            row.className = 'organize-item'; row.dataset.status = item.status;
            const add = (tag, className, value, parent) => {
                const node = document.createElement(tag); node.className = className;
                node.textContent = value; parent.append(node); return node;
            };
            const oldName = item.original_path.split('/').pop();
            const newName = item.dest_path ? item.dest_path.split('/').pop() : oldName;
            const oldFolder = item.original_path.includes('/') ? item.original_path.slice(0, item.original_path.lastIndexOf('/')) : '.';
            const newFolder = item.dest_path ? item.dest_path.slice(0, item.dest_path.lastIndexOf('/')) || '.' : oldFolder;
            const renamed = oldName !== newName, moved = oldFolder !== newFolder;
            const before = Array.from(oldName), after = Array.from(newName);
            let prefix = 0, suffix = 0;
            while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
            while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
            [['Tên hiện tại', before, oldFolder, 'old'], ['Tên đề xuất', after, newFolder, 'new']].forEach(([label, chars, folder, side]) => {
                const group = add('td', 'organize-path', '', row);
                group.dataset.label = label;
                group.dataset.side = side;
                const name = add('p', 'organize-filename', '', group);
                if (side === 'new' && !item.dest_path) name.textContent = 'Chưa có đề xuất';
                else if (renamed) {
                    name.append(document.createTextNode(chars.slice(0, prefix).join('')));
                    if (chars.length - suffix > prefix) add('mark', '', chars.slice(prefix, chars.length - suffix).join(''), name);
                    name.append(document.createTextNode(chars.slice(chars.length - suffix).join('')));
                } else name.textContent = chars.join('');
                const directory = side === 'new' && !item.dest_path ? 'Chưa có đề xuất' : folder === '.' ? 'Gốc kho nhạc' : folder;
                add('p', 'organize-directory', `Thư mục${side === 'new' && moved ? ' mới' : ''}: ${directory}`, group);
            });
            const info = add('td', 'organize-info', '', row);
            info.dataset.label = 'Trạng thái / Chi tiết';
            add('span', 'organize-badge', labels[item.status], info);
            const details = add('details', 'organize-details', '', info);
            add('summary', '', 'Chi tiết', details);
            add('span', 'organize-change-kind', renamed ? `Đổi tên${moved ? ' + chuyển thư mục' : ''}` : moved ? 'Chỉ chuyển thư mục' : item.dest_path ? 'Giữ nguyên' : 'Chưa có đề xuất', details);
            [['Nghệ sĩ', item.artist || 'Chưa có tag'], ['Album', item.album || 'Chưa có tag']].forEach(([label, value]) => {
                add('p', 'organize-directory', `${label}: ${value}`, details);
            });
            if (item.status !== 'READY' || item.reason.includes('Thiếu album')) add('p', 'organize-reason', item.reason, details);
            fragment.append(row);
        });
        rows.append(fragment);
        rows.closest('.organize-table-scroll').scrollTop = 0;
        if (!items.length) {
            const empty = rows.insertRow().insertCell(); empty.colSpan = 3;
            empty.textContent = 'Không có bài khớp bộ lọc hoặc từ khóa.';
        }
        document.getElementById('metadata-organize-count').textContent = `${items.length} / ${plan?.total || 0} bài khớp bộ lọc`;
        apply.textContent = `Áp dụng ${plan?.counts.READY || 0} bài sẵn sàng (toàn bộ danh sách)`;
    };
    form.addEventListener('submit', async event => {
        event.preventDefault(); plan = null; setBusy(true);
        document.getElementById('metadata-organize-results').hidden = true;
        status.textContent = 'Đang đọc metadata trong thư mục và các thư mục con…';
        try {
            plan = await request('preview', {folder: document.getElementById('metadata-organize-folder').value.trim(), filename_format: filenameFormat.value});
            filter.value = 'all'; search.value = ''; changeFilter.value = 'all'; render();
            const c = plan.counts;
            status.textContent = `${plan.total} bài · ${c.READY} sẵn sàng · ${c.REVIEW} cần kiểm tra · ${c.CONFLICT} trùng đích · ${c.UNCHANGED} đã đúng vị trí. Chưa thay đổi tệp.`;
            document.getElementById('metadata-organize-results').hidden = false;
        } catch (error) { status.textContent = error.message; }
        finally { setBusy(false); }
    });
    const invalidatePreview = () => {
        plan = null; apply.disabled = true;
        document.getElementById('metadata-organize-results').hidden = true;
        status.textContent = 'Thư mục hoặc mẫu tên đã đổi. Bấm đọc metadata để xem trước lại.';
    };
    document.getElementById('metadata-organize-folder').addEventListener('input', invalidatePreview);
    filenameFormat.addEventListener('input', invalidatePreview);
    filter.addEventListener('change', render);
    search.addEventListener('input', render);
    changeFilter.addEventListener('change', render);
    const changeFiles = async undo => {
        if (!undo && !plan?.counts.READY) return;
        const preview = plan;
        setBusy(true);
        const confirmed = await showConfirm(undo ? 'Khôi phục vị trí cũ' : 'Áp dụng bản xem trước', undo
            ? 'Khôi phục các tệp trong nhật ký sắp xếp metadata về vị trí cũ? Các thay đổi phân cấp chất lượng không nằm trong thao tác này.'
            : `Đổi tên và di chuyển ${preview.counts.READY} bài theo bản xem trước? Bỏ qua bài thiếu metadata và trùng đích. Nội dung audio và tag được giữ nguyên.`);
        if (!confirmed) { setBusy(false); return; }
        status.textContent = undo ? 'Đang khôi phục vị trí…' : 'Đang đổi tên và sắp xếp…';
        try {
            const data = await request(undo ? 'rollback' : 'apply', undo ? {} : {plan_id: preview.plan_id});
            status.textContent = [data.message, ...(data.errors || [])].join('\n');
            selectedTrackPaths.clear(); updateBatchBar(); loadTracks();
        } catch (error) { status.textContent = error.message; }
        finally {
            plan = null; setBusy(false);
            document.getElementById('metadata-organize-results').hidden = true;
        }
    };
    apply.addEventListener('click', () => changeFiles(false));
    document.getElementById('metadata-organize-undo').addEventListener('click', () => changeFiles(true));
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
        const confirmed = await showConfirm(
            'Gắn tag Audiophile toàn bộ thư viện',
            'Gắn tag Audiophile (Dynamic Range, True Hi-Res...) vào toàn bộ các bài hát trong thư viện?\n\nBản sao lưu metadata gốc sẽ được tạo tự động để bạn có thể hoàn tác bất kỳ lúc nào.'
        );
        if (!confirmed) return;

        const btn = document.getElementById('btn-tag-navidrome-all');
        const box = document.getElementById('organize-status-box');
        btn.disabled = true;
        btn.textContent = '⏳ Đang gắn tag toàn bộ thư viện...';
        if (box) box.innerHTML = `<span class="text-muted">Đang tải danh sách bài hát và ghi metadata...</span>`;
        try {
            const tracks = [];
            let total = 0;
            do {
                const res = await fetch(`/api/tracks?filter=all&offset=${tracks.length}&limit=500`);
                if (!res.ok) throw new Error('Không tải được danh sách bài hát');
                const data = await res.json();
                const page = data.tracks || [];
                total = data.total || 0;
                if (!page.length && tracks.length < total) throw new Error('Danh sách bài hát bị thiếu');
                tracks.push(...page);
            } while (tracks.length < total);
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
            showToast(`✅ Đã gắn tag thành công cho ${success}/${tracks.length} bài hát!`, 'success');
            if (typeof loadTracks === 'function') loadTracks();
        } catch (e) {
            if (box) box.innerHTML = `<div class="text-rose">❌ Lỗi: ${escapeHtml(e.message)}</div>`;
            showToast(`❌ Lỗi: ${e.message}`, 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Ghi Metadata Tag Vào File Âm Thanh';
        }
    });

    document.getElementById('btn-rollback-all-tags')?.addEventListener('click', async () => {
        const confirmed = await showConfirm(
            'Hoàn tác toàn bộ metadata',
            'Hệ thống sẽ đối chiếu cơ sở dữ liệu sao lưu metadata và khôi phục TOÀN BỘ các file âm thanh đã từng được gắn tag về trạng thái nguyên bản ban đầu.\n\nBạn có chắc chắn muốn thực hiện hoàn tác toàn bộ?'
        );
        if (!confirmed) return;

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
                showToast(`✅ ${data.message}`, 'success');
                if (typeof loadTracks === 'function') {
                    loadTracks();
                }
            } else {
                if (box) box.innerHTML = `<div class="text-rose">❌ Lỗi: ${escapeHtml(data.message || data.detail)}</div>`;
                showToast(`❌ Lỗi: ${data.message || data.detail}`, 'error');
            }
        } catch (e) {
            if (box) box.innerHTML = `<div class="text-rose">❌ Lỗi: ${escapeHtml(e.message)}</div>`;
            showToast(`❌ Lỗi: ${e.message}`, 'error');
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

    document.getElementById('modal-btn-play-preview')?.addEventListener('click', () => {
        if (currentSelectedTrack) {
            playTrack(currentSelectedTrack.path, currentSelectedTrack.title, '', currentSelectedTrack.specs);
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

function closeSpectrogramModal() {
    const modal = document.getElementById('spectrogram-modal');
    if (modal) modal.classList.remove('active');
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
        const cutoffLabel = data.cutoff_hz ? (data.cutoff_hz > 24000 ? '>24 kHz (Full Range)' : `${(data.cutoff_hz/1000).toFixed(1)} kHz (-${data.cutoff_drop_db || 0}dB)`) : 'Không rõ';
        dspGrid.innerHTML = `
            <div class="dsp-metric">
                <span class="dsp-metric-label">Biên phổ (sàng lọc)</span>
                <span class="dsp-metric-value" style="color: ${data.cutoff_drop_db >= 20 ? '#f43f5e' : '#10b981'}">${cutoffLabel}</span>
            </div>
            <div class="dsp-metric">
                <span class="dsp-metric-label">Độ Sụt Tần 22k</span>
                <span class="dsp-metric-value">${data.drop_at_22k !== null ? data.drop_at_22k + ' dB' : 'N/A'}</span>
            </div>
            <div class="dsp-metric">
                <span class="dsp-metric-label">Dải Siêu Âm >24k</span>
                <span class="dsp-metric-value">${data.ultrasonic_db !== null ? data.ultrasonic_db + ' dB' : 'N/A'}</span>
            </div>
            <div class="dsp-metric">
                <span class="dsp-metric-label">Đánh Giá Phổ Âm</span>
                <span class="dsp-metric-value" style="color: ${data.badge_color || '#fff'}">${escapeHtml(data.badge || data.verdict || '')}</span>
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
        const fp = data.fingerprint || {};
        const spec = data.spectrum || {};

        const drHeader = document.getElementById('modal-dr-badge-header');
        if (drHeader) {
            drHeader.textContent = dr.dr_badge || `DR${dr.dr_score}`;
            drHeader.className = dr.dr_score >= 12 ? 'dr-score-pill dr-score-high' :
                                 dr.dr_score >= 8 ? 'dr-score-pill dr-score-mid' : 'dr-score-pill dr-score-low';
        }

        document.getElementById('modal-audit-md5').textContent = integ.header_md5 ? integ.header_md5.slice(0, 12) + '...' : 'N/A';
        document.getElementById('modal-audit-gain').textContent = loud.replaygain_track_gain || '--';
        document.getElementById('modal-audit-tier').textContent = tier.badge || '--';
        
        const elCutoff = document.getElementById('modal-audit-cutoff');
        if (elCutoff) {
            elCutoff.textContent = spec.cutoff_hz ? `${(spec.cutoff_hz/1000).toFixed(1)} kHz` : '--';
        }
        const elFp = document.getElementById('modal-audit-fp');
        if (elFp) {
            elFp.textContent = fp.is_available ? `Chromaprint (${fp.sample_count}s)` : 'Chưa có';
            elFp.style.color = fp.is_available ? '#34d399' : '#94a3b8';
        }
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
            showToast(`✅ ${data.message}`, 'success');
            if (typeof loadTracks === 'function') loadTracks();
        } else {
            showToast(`❌ Lỗi: ${data.message}`, 'error');
        }
    } catch (e) {
        showToast(`❌ Lỗi: ${e.message}`, 'error');
    } finally {
        if (btnElement) {
            btnElement.textContent = 'Tag';
            btnElement.disabled = false;
        }
    }
}

async function rollbackSingleTrack(filepath, btnElement = null) {
    if (!filepath) return;
    const confirmed = await showConfirm(
        'Hoàn tác metadata file',
        `Bạn có chắc muốn hoàn tác (undo) và khôi phục metadata gốc cho tệp:\n${filepath} ?`
    );
    if (!confirmed) return;

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
            showToast(`✅ ${data.message}`, 'success');
            if (typeof loadTracks === 'function') {
                loadTracks();
            }
        } else {
            showToast(`❌ Lỗi: ${data.message || data.detail}`, 'error');
        }
    } catch (e) {
        showToast(`❌ Lỗi: ${e.message}`, 'error');
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

function switchABChannel(targetChannel) {
    if (typeof audioPlayer.switchChannel === 'function') {
        audioPlayer.switchChannel(targetChannel);
    }
}

function initNavidromeStorage() {
    const elUrl = document.getElementById('navi-url');
    const elUser = document.getElementById('navi-user');
    const elPass = document.getElementById('navi-pass');

    const savedUrl = localStorage.getItem('navi_url') || localStorage.getItem('navidrome_server_url');
    const savedUser = localStorage.getItem('navi_user') || localStorage.getItem('navidrome_username');
    const savedPass = localStorage.getItem('navi_pass') || localStorage.getItem('navidrome_password');

    if (elUrl && savedUrl) elUrl.value = savedUrl;
    if (elUser && savedUser) elUser.value = savedUser;
    if (elPass && savedPass) elPass.value = savedPass;

    [elUrl, elUser, elPass].forEach(el => {
        if (!el) return;
        el.addEventListener('input', () => {
            saveNavidromeConfig(getNavidromeConfigFromInputs());
        });
    });
}

function initKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
        const activeTag = document.activeElement ? document.activeElement.tagName : '';
        const isEditing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeTag) ||
                          (document.activeElement && document.activeElement.isContentEditable);

        // Escape: close modals / dropdowns
        if (e.key === 'Escape') {
            const confirmModal = document.getElementById('confirm-modal');
            if (confirmModal && confirmModal.style.display === 'flex') {
                confirmModal.style.display = 'none';
                return;
            }
            const specModal = document.getElementById('spectrogram-modal');
            if (specModal && specModal.classList.contains('active')) {
                closeSpectrogramModal();
                return;
            }
            const labDropdown = document.getElementById('lab-combobox-dropdown');
            if (labDropdown && labDropdown.style.display !== 'none') {
                labDropdown.style.display = 'none';
                document.getElementById('lab-combobox-input').setAttribute('aria-expanded', 'false');
                return;
            }
        }

        // Search shortcut: '/'
        if (e.key === '/' && !isEditing) {
            e.preventDefault();
            const searchInput = document.getElementById('search-input');
            if (searchInput) {
                searchInput.focus();
                searchInput.select();
            }
            return;
        }

        // Play/Pause shortcut: Space
        if (e.code === 'Space' && !isEditing) {
            const bar = document.getElementById('audio-player-bar');
            if (bar && bar.style.display !== 'none' && audioPlayer.element) {
                e.preventDefault();
                const btnPlayPause = document.getElementById('player-btn-play-pause');
                if (btnPlayPause) btnPlayPause.click();
            }
            return;
        }

        // A/B switch shortcut: 'a' or 'b'
        if ((e.key === 'a' || e.key === 'b' || e.key === 'A' || e.key === 'B') && !isEditing) {
            if (audioPlayer.abActive) {
                switchABChannel(e.key.toUpperCase());
            }
        }
    });
}
