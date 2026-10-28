// Missing measurements must stay unknown; measured zero remains a valid result.
function formatMeasurement(value, unit = '') {
    return Number.isFinite(value) ? `${value}${unit}` : '—';
}

function postJSON(url, body) {
    return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
}

// State
let currentTab = 'tab-audiophile';
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
let showColFilters = false;
let libraryTrackDetails = new Map();
let trackDetailsOpener = null;
let albumPaths = [];
let albumBusy = false;

let currentAuditResult = null;
let currentTieringPlan = null;
let selectedTieringMode = 'symlink';
let tierPlanFilter = 'all';
let tierPlanSearch = '';
let tierVisibleLimit = 100, tierViewKey = '';
let dupeVisibleLimit = 100, dupeViewKey = '';

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
        if (msgEl) msgEl.textContent = message;
        const opener = document.activeElement;
        modal.style.display = 'flex';
        btnCancel.focus();

        const cleanup = (val) => {
            modal.style.display = 'none';
            btnOk.onclick = null;
            btnCancel.onclick = null;
            btnClose.onclick = null;
            opener?.focus();
            resolve(val);
        };

        btnOk.onclick = () => cleanup(true);
        btnCancel.onclick = () => cleanup(false);
        btnClose.onclick = () => cleanup(false);
    });
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
    initSidebar();
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
    initOrganize();
    initModal();
    initKeyboardShortcuts();
    // Load first page immediately
    loadTracks();
});

// Sidebar Collapsible & Mobile Management
function initSidebar() {
    const sidebar = document.getElementById('sidebar');
    // Top navigation stays visible regardless of the old sidebar preference.
    sidebar?.classList.remove('collapsed');
}

// 1. Tab Navigation
const TAB_TITLES = {
    'tab-library': 'Kho nhạc',
    'tab-organize': 'Đổi tên & sắp xếp',
    'tab-audiophile': 'Tổng quan chất lượng',
    'tab-vault': 'Nhóm theo định dạng',
    'tab-duplicates': 'Quản lý trùng lặp',
    'tab-navidrome': 'Cài đặt',
    'tab-tools': 'Ghi tag'
};

function updateTaskContext() {
    const path = document.getElementById('lab-selected-path').value;
    const track = document.getElementById('context-track');
    track.hidden = !path;
    track.textContent = path ? `Bài đang chọn: ${path.split('/').pop()}` : '';
    track.title = path;
    const selection = document.getElementById('context-selection');
    selection.hidden = !selectedTrackPaths.size;
    selection.textContent = `${selectedTrackPaths.size} bài đã chọn trong Kho nhạc`;
    const filters = [];
    if (currentFilter !== 'all') {
        const pill = document.querySelector(`#filter-pills [data-filter="${currentFilter}"]`);
        filters.push(`Kho nhạc: ${pill?.textContent.trim() || currentFilter}`);
    }
    if (searchQuery) filters.push(`Tìm trong kho: “${searchQuery}”`);
    const columnNames = {title: 'Tên bài', artist: 'Nghệ sĩ', album: 'Album', format: 'Định dạng', verdict: 'Kết quả'};
    Object.entries(colFilters).forEach(([key, value]) => { if (value) filters.push(`${columnNames[key]}: ${value}`); });
    if (currentTab === 'tab-duplicates') {
        filters.push(`Bài trùng: ${currentDupeType === 'byte' ? 'giống từng byte' : currentDupeType === 'meta' ? 'cùng metadata' : 'cùng tên'}`);
        if (dupeSearchQuery) filters.push(`Tìm: “${dupeSearchQuery}”`);
        if (dupeSubFilter !== 'all' && currentDupeType === 'meta') {
            filters.push(document.querySelector(`#dupe-subfilter-pills [data-subfilter="${dupeSubFilter}"]`)?.textContent.trim() || dupeSubFilter);
        }
        if (document.getElementById('dupe-show-reviewed').checked) filters.push('Gồm nhóm đã duyệt');
    }
    if (currentTab === 'tab-vault') {
        if (tierPlanFilter !== 'all') filters.push(document.getElementById('plan-filter-active-badge').textContent);
        if (tierPlanSearch) filters.push(`Tìm nhóm: “${tierPlanSearch}”`);
    }
    document.getElementById('context-filters').textContent = filters.join(' · ');
    document.getElementById('task-context').hidden = !path && !selectedTrackPaths.size && !filters.length;
}

function initTabs() {
    document.getElementById('context-track').addEventListener('click', () => {
        switchTab('tab-audiophile');
        const scope = document.getElementById('scoring-target');
        scope.value = 'single'; scope.dispatchEvent(new Event('change'));
        document.getElementById('scoring-setup').open = true;
        document.getElementById('lab-combobox-input').focus();
    });
    document.getElementById('context-selection').addEventListener('click', () => switchTab('tab-library'));
    document.addEventListener('audio-selection-change', updateTaskContext);
    new ResizeObserver(entries => { document.documentElement.style.setProperty('--taskbar-top', `${entries[0].target.getBoundingClientRect().height}px`); }).observe(document.querySelector('.topbar'));
    document.querySelectorAll('[data-tab]').forEach(button => {
        button.addEventListener('click', () => switchTab(button.dataset.tab));
    });
    document.getElementById('library-detail-columns').addEventListener('change', event => {
        document.getElementById('tab-library').classList.toggle('show-library-details', event.target.checked);
    });
    document.getElementById('library-refresh').addEventListener('click', async event => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
            const response = await fetch('/api/library/refresh', {method: 'POST'});
            if (!response.ok) throw new Error('Không làm mới được kho nhạc.');
            currentOffset = 0;
            await Promise.all([loadTracks(), initStats()]);
        } catch (error) { showToast(error.message, 'error'); }
        finally { button.disabled = false; }
    });
    document.getElementById('btn-batch-organize').addEventListener('click', () => {
        // Organization works on folders; never imply it applies to selected tracks only.
        switchTab('tab-organize');
        const input = document.getElementById('metadata-organize-folder');
        const folders = new Set([...selectedTrackPaths].map(path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''));
        input.value = folders.size === 1 ? [...folders][0] : '';
        input.dispatchEvent(new Event('input'));
        document.getElementById('metadata-organize-status').textContent = 'Sắp xếp theo thư mục, gồm cả bài chưa chọn. Xem trước phạm vi trước khi áp dụng.';
        input.focus();
    });
}

function switchTab(tabId) {
    const target = document.getElementById(tabId);
    if (!target?.classList.contains('tab-content')) return;
    const parent = tabId;
    document.querySelectorAll('.sidebar-nav-item').forEach(button => {
        const active = button.dataset.tab === parent;
        button.classList.toggle('active', active);
        if (active) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
    });
    document.querySelectorAll('.tab-content').forEach(section => section.classList.toggle('active', section === target));
    currentTab = tabId;
    updateTaskContext();
    document.getElementById('tool-back-row').hidden = true;
    document.getElementById('topbar-page-title').textContent = TAB_TITLES[tabId] || 'Công cụ';
    updateBatchBar();
    if (tabId === 'tab-library') loadTracks();
    else if (tabId === 'tab-vault') loadVaultTieringPlan();
    else if (tabId === 'tab-duplicates') loadDuplicates(false);
    else if (tabId === 'tab-navidrome') loadSmartPlaylists();
    window.scrollTo({top: 0});
}

// 2. Stats & Clickable Stat Filter Cards
async function initStats() {
    ['stat-true-hires', 'stat-true-dsd', 'stat-studio-master', 'stat-fake-hires', 'stat-cd-lossless', 'stat-lossy', 'stat-dupe-meta-pill', 'stat-total-pill'].forEach(id => {
        document.getElementById(id).textContent = '—';
    });
    try {
        const res = await fetch('/api/stats');
        if (!res.ok) throw new Error('Không tải được thống kê.');
        const data = await res.json();
        const counts = data.counts || {};
        document.getElementById('settings-root-path').textContent = data.root_directory || 'Chưa có thư mục';
        const rootLabel = document.getElementById('sidebar-root-label');
        rootLabel.textContent = data.root_directory?.split('/').pop() || 'Kho nhạc';
        rootLabel.title = data.root_directory || '';

        document.getElementById('stat-true-hires').textContent = formatMeasurement(counts.true_hires);
        document.getElementById('stat-true-dsd').textContent = formatMeasurement(counts.true_dsd);
        document.getElementById('stat-studio-master').textContent = formatMeasurement(counts.studio_master);
        document.getElementById('stat-fake-hires').textContent = formatMeasurement(counts.fake_hires);
        document.getElementById('stat-cd-lossless').textContent = formatMeasurement(counts.cd_lossless);
        document.getElementById('stat-lossy').textContent = formatMeasurement(counts.lossy);

        const elDupePill = document.getElementById('stat-dupe-meta-pill');
        if (elDupePill) {
            elDupePill.textContent = formatMeasurement(counts.duplicate_meta_groups);
        }

        const elTotalPill = document.getElementById('stat-total-pill');
        if (elTotalPill) {
            elTotalPill.textContent = Number.isFinite(counts.total) ? counts.total.toLocaleString('vi-VN') : '—';
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
    document.getElementById('btn-batch-album').addEventListener('click', previewAlbumAnalysis);
    document.getElementById('btn-run-album').addEventListener('click', runAlbumAnalysis);
    document.getElementById('btn-close-album').addEventListener('click', () => {
        document.getElementById('album-analysis').hidden = true;
        document.getElementById('btn-batch-album').focus();
    });
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
        const paths = Array.from(selectedTrackPaths);
        const count = paths.length;
        const confirmed = await showConfirm(
            'Xác nhận ghi Tag hàng loạt',
            `Phạm vi: ${count} bài đã chọn trong Kho nhạc, kể cả ngoài trang hiện tại. Ghi ghi chú phân nhóm và trạng thái chưa xác minh, không thêm ReplayGain. Có thể thay đổi ghi chú hiện có; tag gốc được sao lưu. Tiếp tục?`
        );
        if (!confirmed) return;

        const btn = document.getElementById('btn-batch-tag');
        btn.disabled = true;
        btn.textContent = '⏳ Đang ghi...';

        try {
            const naviCfg = getNavidromeConfigFromStorage();
            const res = await postJSON('/api/tag/batch', {
                filepaths: paths,
                navidrome_config: naviCfg
            });
            const data = await res.json();
            if (data.navidrome_scan) handleNavidromeResult(data.navidrome_scan);
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
            btn.textContent = 'Ghi nhãn phân loại';
        }
    });

    document.getElementById('btn-batch-audiophile-tag')?.addEventListener('click', async () => {
        if (selectedTrackPaths.size === 0) return;
        const paths = Array.from(selectedTrackPaths);
        const count = paths.length;
        const confirmed = await showConfirm(
            'Xác nhận kiểm tra & ghi tag hàng loạt',
            `Phạm vi: ${count} bài đã chọn trong Kho nhạc, kể cả ngoài trang hiện tại. Đo chẩn đoán, ghi ghi chú và trạng thái chưa xác minh, thêm ReplayGain khi đo được. Có thể thay đổi ghi chú hiện có; tag gốc được sao lưu. Dữ liệu âm thanh không được mã hóa lại. Tiếp tục?`
        );
        if (!confirmed) return;

        const btn = document.getElementById('btn-batch-audiophile-tag');
        btn.disabled = true;
        btn.textContent = '⏳ Đang kiểm định...';

        try {
            const naviCfg = getNavidromeConfigFromStorage();
            const res = await postJSON('/api/audiophile/tag/batch', {
                filepaths: paths,
                navidrome_config: naviCfg
            });
            const data = await res.json();
            if (data.navidrome_scan) handleNavidromeResult(data.navidrome_scan);
            if (data.success) {
                showToast(`🔬 Đã kiểm tra và ghi tag cho ${data.tagged_count} / ${count} bài!`, 'success');
                selectedTrackPaths.clear();
                updateBatchBar();
                loadTracks();
            } else {
                showToast(`❌ Lỗi kiểm tra và ghi tag hàng loạt`, 'error');
            }
        } catch (e) {
            showToast(`❌ Lỗi: ${e.message}`, 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Đo & ghi tag';
        }
    });
}

function updateBatchBar() {
    updateTaskContext();
    const bar = document.getElementById('floating-batch-bar');
    const countEl = document.getElementById('batch-selected-count');
    const chkAll = document.getElementById('check-all-tracks');
    const size = selectedTrackPaths.size;
    document.getElementById('btn-batch-album').disabled = size < 2 || albumBusy;
    if (countEl) countEl.textContent = size;
    document.dispatchEvent(new Event('audio-selection-change'));
    if (bar) bar.style.display = size > 0 && currentTab === 'tab-library' ? 'flex' : 'none';

    const visibleCbs = document.querySelectorAll('.track-row-checkbox');
    if (chkAll && visibleCbs.length > 0) {
        chkAll.checked = Array.from(visibleCbs).every(cb => cb.checked);
    }
}

function previewAlbumAnalysis() {
    if (albumBusy || selectedTrackPaths.size < 2) return;
    // Match the endpoint's filename ordering, including Unicode code points.
    albumPaths = [...selectedTrackPaths].sort((a, b) => {
        const left = Array.from(a.split('/').pop(), c => c.codePointAt(0));
        const right = Array.from(b.split('/').pop(), c => c.codePointAt(0));
        for (let i = 0; i < Math.min(left.length, right.length); i++) {
            if (left[i] !== right[i]) return left[i] - right[i];
        }
        return left.length - right.length;
    });
    const panel = document.getElementById('album-analysis');
    document.getElementById('album-scope').textContent = `Phạm vi: ${albumPaths.length} bài đã chọn, kể cả ngoài trang hiện tại. Danh sách này được giữ cố định cho lượt phân tích.`;
    document.getElementById('album-order').innerHTML = albumPaths.map(path => `<li>${escapeHtml(path)}</li>`).join('');
    document.getElementById('album-status').textContent = '';
    document.getElementById('album-results').hidden = true;
    panel.hidden = false;
    panel.scrollIntoView({block: 'center'});
    document.getElementById('btn-run-album').focus();
}

async function runAlbumAnalysis() {
    if (albumBusy || albumPaths.length < 2) return;
    const paths = [...albumPaths];
    const status = document.getElementById('album-status');
    const results = document.getElementById('album-results');
    const button = document.getElementById('btn-run-album');
    albumBusy = true;
    button.disabled = true;
    document.getElementById('btn-close-album').disabled = true;
    updateBatchBar();
    results.hidden = true;
    status.textContent = `Đang phân tích ${paths.length} bài… Có thể mất vài phút.`;
    try {
        const response = await postJSON('/api/audiophile/audit-album', {track_paths: paths});
        const data = await response.json();
        if (!response.ok || data.error) throw new Error(data.detail || data.error || 'Không phân tích được album');
        const measured = (data.tracks || []).filter(track => Number.isFinite(track.dynamic_range?.dr_score) && track.dynamic_range.dr_score > 0).length;
        status.textContent = `Đã phân tích ${data.track_count}/${paths.length} bài; ${measured} bài có DR dùng để tính trung bình.${data.track_count < paths.length ? ' Một số bài không phân tích được; chuyển tiếp bên dưới chỉ gồm các bài có kết quả.' : ''}`;
        results.innerHTML = `<h4>DR trung bình: ${formatMeasurement(data.album_dr_float)}</h4>
            <p class="text-secondary">Trung bình DR của các bài đo được, không xác minh nguồn master hay chất lượng nghe. Khoảng lặng ở biên không tự xác nhận phát liền mạch.</p>
            <h4>Chuyển tiếp giữa các bài</h4>${(data.transitions || []).map(item => `<article class="album-transition"><strong>${escapeHtml(item.from_track)} → ${escapeHtml(item.to_track)}</strong><p>Khoảng lặng: ${formatMeasurement(item.total_silence_gap_ms, ' ms')} · Mức cuối bài: ${formatMeasurement(item.from_end_db, ' dB')}</p><p>${escapeHtml(item.note || 'Chưa đủ dữ liệu')}</p></article>`).join('') || '<p>Chưa đủ bài có kết quả để so sánh chuyển tiếp.</p>'}`;
        results.hidden = false;
    } catch (error) {
        status.textContent = `Không hoàn tất: ${error.message}. Có thể thử lại với danh sách trên.`;
    } finally {
        albumBusy = false;
        button.disabled = false;
        document.getElementById('btn-close-album').disabled = false;
        updateBatchBar();
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
            true_hires: 'PCM tần số cao',
            true_dsd: 'True DSD',
            studio_master: 'Cần xem xét',
            cd_lossless: 'CD Lossless',
            fake_hires: 'Lỗi toàn vẹn',
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
    updateTaskContext();
    const tbody = document.getElementById('tracks-tbody');
    if (!tbody) return;
    document.getElementById('pagination-info').textContent = 'Đang tải danh sách…';
    document.getElementById('pagination-page-display').textContent = '—';
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
        if (!res.ok) throw new Error('Không tải được danh sách tệp.');
        const data = await res.json();
        if (!Array.isArray(data.tracks) || !Number.isInteger(data.total)) throw new Error('Danh sách tệp thiếu dữ liệu.');
        const tracks = data.tracks;
        libraryTrackDetails = new Map(tracks.map(track => [track.original_path, track]));
        const total = data.total;
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
                                <button type="button" class="track-title btn-track-details" data-path="${escapeHtml(track.original_path)}">${escapeHtml(track.title || track.original_path)}</button>
                                ${dupeBadge}
                            </div>
                            <span class="track-artist track-path text-muted" style="font-size: 0.75rem;">${escapeHtml(track.original_path)}</span>
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
                            <button class="btn-action-icon btn-track-details" data-path="${escapeHtml(track.original_path)}" title="Chi tiết bài hát">Chi tiết</button>
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

        document.querySelectorAll('.btn-track-details').forEach(button => {
            button.addEventListener('click', () => {
                const track = libraryTrackDetails.get(button.dataset.path);
                openSpectrogramModal(track.original_path, track.title, track.specs);
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
        document.getElementById('pagination-info').textContent = 'Chưa tải được danh sách';
        document.getElementById('pagination-page-display').textContent = '—';
        document.getElementById('btn-prev-page').disabled = true;
        document.getElementById('btn-next-page').disabled = true;
        tbody.innerHTML = `<tr><td colspan="8" class="text-center py-6 text-rose">Lỗi khi tải dữ liệu bài hát: ${e.message}</td></tr>`;
    }
}

// ==============================================================================
// 4. AUDIO ANALYSIS & SUPPLEMENTARY DIAGNOSTICS
// ==============================================================================
function initAudiophileLab() {
    const btnTagNow = document.getElementById('btn-audiophile-tag-now');
    btnTagNow?.addEventListener('click', async () => {
        if (!currentAuditResult) return;
        btnTagNow.disabled = true;
        btnTagNow.textContent = '⏳ Đang ghi tag...';
        try {
            const naviCfg = getNavidromeConfigFromStorage();
            const res = await postJSON('/api/audiophile/tag', {
                filepath: currentAuditResult.filepath,
                audit_data: currentAuditResult,
                navidrome_config: naviCfg
            });
            const data = await res.json();
            if (data.navidrome_scan) handleNavidromeResult(data.navidrome_scan);
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
            btnTagNow.textContent = 'Ghi tag cho bài này';
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
    if (document.getElementById('lab-selected-path').value !== path) document.getElementById('scoring-result').hidden = true;
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
        const res = await postJSON('/api/audiophile/audit', { filepath });
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
    const drScore = dr.dr_score;
    const scoreHuge = document.getElementById('dr-score-huge');
    if (scoreHuge) {
        scoreHuge.textContent = Number.isFinite(drScore) ? `DR${drScore}` : 'DR--';
        scoreHuge.style.color = dr.badge_color || '#fbbf24';
    }
    const drBadge = document.getElementById('pillar-dr-badge');
    if (drBadge) {
        drBadge.textContent = dr.dr_badge || (Number.isFinite(drScore) ? `DR${drScore}` : 'Chưa đo');
        drBadge.style.color = dr.badge_color || '#fff';
    }
    const needle = document.getElementById('dr-needle');
    if (needle) {
        // DR scale 1 to 20 -> 0% to 100%
        const pct = Math.max(0, Math.min(100, ((drScore - 1) / 19.0) * 100));
        needle.hidden = !Number.isFinite(drScore);
        needle.style.left = `${pct}%`;
    }
    document.getElementById('dr-stat-peak').textContent = formatMeasurement(dr.peak_db, ' dB');
    document.getElementById('dr-stat-rms').textContent = formatMeasurement(dr.rms_db, ' dB');
    document.getElementById('dr-stat-channels').textContent = `${formatMeasurement(dr.dr_left)} / ${formatMeasurement(dr.dr_right)}`;
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
        bitBadge.textContent = bits.badge || formatMeasurement(bits.real_bits, '-bit');
        bitBadge.style.color = bits.badge_color || '#fff';
    }
    const entropyPct = bits.lsb_nonzero_pct;
    document.getElementById('lsb-entropy-pct').textContent = formatMeasurement(entropyPct, '% non-zero');
    const fill = document.getElementById('lsb-entropy-fill');
    if (fill) {
        fill.hidden = !Number.isFinite(entropyPct);
        fill.style.width = Number.isFinite(entropyPct) ? `${entropyPct}%` : '0%';
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
    document.getElementById('dsd-channels-val').textContent = dsd.channel_type || formatMeasurement(dsd.channels, ' kênh');
    document.getElementById('dsd-noise-rise-val').textContent = formatMeasurement(dsd.noise_shape_rise_db, ' dB');
    document.getElementById('dsd-msg-desc').textContent = dsd.explanation || '';

    // 5. ReplayGain & EBU R128
    const loudness = data.loudness || {};
    const loudBadge = document.getElementById('pillar-loudness-badge');
    if (loudBadge) {
        loudBadge.textContent = loudness.replaygain_track_gain || 'ReplayGain chưa đo được';
    }
    document.getElementById('loudness-lufs-val').textContent = formatMeasurement(loudness.integrated_lufs, ' LUFS');
    document.getElementById('loudness-peak-val').textContent = formatMeasurement(loudness.true_peak_db, ' dBTP');
    document.getElementById('loudness-rg-val').textContent = loudness.replaygain_track_gain || '--';
    document.getElementById('loudness-msg-desc').textContent = loudness.error || `Mục tiêu: -18 LUFS (ReplayGain 2.0) · R128 Gain: ${loudness.r128_track_gain ?? '—'}. Ghi tag không mã hóa lại dữ liệu âm thanh.`;

    // 6. Gapless Playback
    const gapless = data.gapless || {};
    const gapBadge = document.getElementById('pillar-gapless-badge');
    if (gapBadge) {
        gapBadge.textContent = gapless.gapless_rating || 'Chưa đo';
        gapBadge.style.color = gapless.rating_color || '#fff';
    }
    document.getElementById('gapless-intro-val').textContent = formatMeasurement(gapless.intro_silence_ms, ' ms');
    document.getElementById('gapless-outro-val').textContent = formatMeasurement(gapless.outro_silence_ms, ' ms');
    document.getElementById('gapless-msg-desc').textContent = gapless.is_seamless_live_candidate ?
        '🟢 Phát hiện điểm giao nhau âm lượng cao (> -45dBFS) chuẩn Live/Mix liền mạch!' :
        gapless.summary || 'Chưa có đủ dữ liệu đo gapless.';

    // 7. Vault Tier Proposal
    const tier = data.vault_tier || {};
    const tierBadge = document.getElementById('pillar-tier-badge');
    if (tierBadge) {
        tierBadge.textContent = tier.badge || tier.tier_name;
        tierBadge.style.color = tier.badge_color || '#fff';
    }
    document.getElementById('pillar-tier-dest').textContent = tier.tier_name || '--';
    const warnings = {
        integrity: integrity.status === 'FAIL' || integrity.status === 'REVIEW',
        bitdepth: bits.is_fake_24bit || ['FAIL', 'SUSPECT', 'REVIEW'].includes(bits.badge),
        loudness: Boolean(loudness.error),
        gapless: gapless.intro_silence_ms == null || gapless.outro_silence_ms == null,
        dsd: dsd.is_dsd && ['SUSPECT', 'REVIEW', 'UNKNOWN'].includes(dsd.purity)
    };
    ['dr', 'integrity', 'bitdepth', 'dsd', 'loudness', 'gapless', 'tier'].forEach(name => {
        const card = document.getElementById(`pillar-${name}-card`);
        card.open = Boolean(warnings[name]);
        card.dataset.warning = String(Boolean(warnings[name]));
    });
}

// ==============================================================================
// 5. VAULT TIERING 3 CẤP
// ==============================================================================
function initVaultTiering() {
    document.getElementById('tiering-more').addEventListener('click', () => {
        tierVisibleLimit += 100; renderVaultTieringPlanTable();
    });
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
        card.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); card.click(); }
        });
        card.addEventListener('click', () => {
            document.querySelectorAll('.clickable-tier').forEach(item => item.setAttribute('aria-pressed', String(item === card)));
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
        document.querySelectorAll('.clickable-tier').forEach(c => { c.style.outline = 'none'; c.setAttribute('aria-pressed', 'false'); });
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
            if (!currentTieringPlan?.items) return;
        }

        const modeText = selectedTieringMode === 'symlink' ?
            'Tạo liên kết: giữ nguyên vị trí tệp gốc.' :
            'Di chuyển tệp vào các nhóm đích. Có nhật ký để khôi phục vị trí; tệp xung đột sẽ không bị ghi đè.';

        const confirmed = await showConfirm(
            `Xác nhận thực thi phân cấp (${currentTieringPlan.total_files} bài)`,
            `Phạm vi: TOÀN BỘ ${currentTieringPlan.items.length} tệp trong kế hoạch, kể cả tệp ngoài bộ lọc và chưa hiển thị.\n${document.getElementById('tiering-scope').textContent}\n\n${modeText}`
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
            const res = await postJSON('/api/vault/tiering/execute', { mode: selectedTieringMode, plan_items: currentTieringPlan.items });
            const data = await res.json();
            if (data.navidrome_scan) handleNavidromeResult(data.navidrome_scan);
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
            btn.textContent = 'Áp dụng kế hoạch';
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
            if (data.navidrome_scan) handleNavidromeResult(data.navidrome_scan);
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
    currentTieringPlan = null;
    document.getElementById('tiering-more').hidden = true;
    document.getElementById('tiering-scope').textContent = 'Đang tải kế hoạch; chưa thể áp dụng.';
    document.getElementById('btn-execute-tiering').disabled = true;
    for (let tier = 1; tier <= 3; tier++) {
        document.getElementById(`tier${tier}-count`).textContent = '—';
        document.getElementById(`tier${tier}-size`).textContent = 'Dung lượng: —';
    }
    document.getElementById('plan-total-badge').textContent = 'Đang tải…';
    tbody.innerHTML = `<tr><td colspan="4" class="text-center py-6 text-muted">Đang quét và tính toán kế hoạch 3 cấp Vault Tiering...</td></tr>`;

    try {
        const res = await fetch('/api/vault/tiering/plan');
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Không tải được kế hoạch phân cấp.');
        if (!Array.isArray(data.items) || !Number.isInteger(data.total_files) || !Number.isFinite(data.total_size_gb)
            || !['tier_1', 'tier_2', 'tier_3'].every(key => Number.isInteger(data.summary?.[key]?.count) && Number.isFinite(data.summary?.[key]?.size_gb))) {
            throw new Error('Kết quả phân nhóm thiếu số liệu.');
        }
        currentTieringPlan = data;
        document.getElementById('btn-execute-tiering').disabled = !data.items.length;

        const sum = data.summary || {};
        const t1 = sum.tier_1 || {};
        const t2 = sum.tier_2 || {};
        const t3 = sum.tier_3 || {};

        document.getElementById('tier1-count').textContent = `${t1.count} bài`;
        document.getElementById('tier1-size').textContent = `Dung lượng: ~${t1.size_gb} GB`;

        document.getElementById('tier2-count').textContent = `${t2.count} bài`;
        document.getElementById('tier2-size').textContent = `Dung lượng: ~${t2.size_gb} GB`;

        document.getElementById('tier3-count').textContent = `${t3.count} bài`;
        document.getElementById('tier3-size').textContent = `Dung lượng: ~${t3.size_gb} GB`;

        document.getElementById('plan-total-badge').textContent = `${data.total_files} tệp (${data.total_size_gb} GB)`;

        renderVaultTieringPlanTable();
    } catch (e) {
        currentTieringPlan = null;
        document.getElementById('plan-total-badge').textContent = 'Không tải được dữ liệu';
        tbody.replaceChildren();
        const cell = tbody.insertRow().insertCell(); cell.colSpan = 4;
        cell.className = 'text-center py-6 text-rose';
        cell.textContent = `Lỗi tải kế hoạch: ${e.message}. Chọn lại tab để thử lại.`;
        document.getElementById('tiering-scope').textContent = 'Không tải được kế hoạch; chưa thể áp dụng.';
    }
}

function renderVaultTieringPlanTable() {
    const tbody = document.getElementById('tiering-preview-tbody');
    if (!tbody || !currentTieringPlan) return;

    let items = currentTieringPlan.items || [];
    const viewKey = JSON.stringify([tierPlanFilter, tierPlanSearch]);
    if (viewKey !== tierViewKey) { tierVisibleLimit = 100; tierViewKey = viewKey; }
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

    const shown = Math.min(tierVisibleLimit, items.length);
    const affected = currentTieringPlan.items.length;
    document.getElementById('tiering-scope').textContent = `Đang hiển thị ${shown}/${items.length} tệp khớp bộ lọc · Toàn kế hoạch: ${affected} tệp · Áp dụng sẽ xử lý cả ${affected} tệp, kể cả ngoài bộ lọc.`;
    document.getElementById('tiering-more').hidden = shown >= items.length;
    updateTaskContext();
    if (items.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="text-center py-6 text-muted">Không có bài hát nào phù hợp với bộ lọc hoặc từ khóa tìm kiếm.</td></tr>`;
        return;
    }

    let html = '';
    items.slice(0, tierVisibleLimit).forEach(item => {
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
    document.getElementById('dupes-more').addEventListener('click', () => {
        const previous = dupeVisibleLimit;
        dupeVisibleLimit += 100; renderDuplicates();
        if (document.getElementById('dupes-more').hidden) {
            document.querySelectorAll('.dupe-card')[previous]?.querySelector('input')?.focus();
        }
    });
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

    document.getElementById('dupe-show-reviewed').addEventListener('change', () => loadDuplicates());
    document.getElementById('btn-undo-dupe-archive').addEventListener('click', async () => {
        if (!await showConfirm('Hoàn tác lưu trữ', 'Khôi phục các bản trùng đã lưu trữ? Tệp có sẵn ở đường dẫn gốc sẽ không bị ghi đè.')) return;
        const button = document.getElementById('btn-undo-dupe-archive');
        button.disabled = true;
        try {
            const response = await postJSON('/api/duplicates/rollback', {});
            const result = await response.json();
            if (!response.ok) throw new Error(result.detail || 'Không thể hoàn tác');
            showToast([result.message, ...(result.errors || [])].join('\n'), result.success ? 'success' : 'warning');
            if (result.navidrome_scan) handleNavidromeResult(result.navidrome_scan);
            await loadDuplicates();
        } catch (error) { showToast(error.message, 'error'); }
        finally { button.disabled = false; }
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

    // 5. Archive only byte-identical groups; other matches require review.
    document.getElementById('btn-archive-byte-dupes')?.addEventListener('click', async () => {
        await executeBatchArchiveDuplicates();
    });

    // 6. Use the same explained server recommendation in every view.
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

            const first = files[0];
            const bestFile = typeof first === 'string' ? first : first.path;

            if (bestFile) {
                userSelectedKeep[gId] = bestFile;
                changed++;
            }
        });

        renderDuplicates();
        showToast(`Đã dùng đề xuất kiểm tra toàn vẹn / metadata cho ${changed} nhóm; không xác minh bản master.`, 'success');
    });
}

async function loadDuplicates(refresh = false) {
    const container = document.getElementById('dupes-container');
    if (!container) return;
    duplicatesData = null;
    currentFilteredDuplicates = [];
    updateDupeArchiveButton([]);
    document.getElementById('dupes-more').hidden = true;
    document.getElementById('dupe-display-count').textContent = 'Đang tải nhóm trùng…';
    ['dupe-count-byte', 'dupe-count-meta', 'dupe-count-name', 'dupe-subcount-all', 'dupe-subcount-flac', 'dupe-subcount-mixed', 'dupe-subcount-numbered'].forEach(id => {
        document.getElementById(id).textContent = '—';
    });
    document.getElementById('dupe-selection-summary').textContent = 'Đang chờ kết quả quét…';
    container.innerHTML = `<p class="text-center py-6 text-muted">Đang quét tìm tệp trùng lặp (SQLite Cache)...</p>`;

    try {
        const res = await fetch(`/api/duplicates?refresh=${refresh}`);
        if (!res.ok) throw new Error('Không tải được kết quả quét trùng lặp');
        const data = await res.json();
        if (!['byte_duplicates', 'meta_duplicates', 'name_duplicates'].every(key => Array.isArray(data[key]))) {
            throw new Error('Kết quả quét trùng lặp thiếu dữ liệu.');
        }
        duplicatesData = data;
        if (!document.getElementById('dupe-show-reviewed').checked) {
            ['byte_duplicates', 'meta_duplicates', 'name_duplicates'].forEach(kind => {
                duplicatesData[kind] = duplicatesData[kind].filter(group => !group.review_decision);
            });
        }

        const byteCount = (duplicatesData.byte_duplicates || []).length;
        const metaCount = (duplicatesData.meta_duplicates || []).length;
        const nameCount = (duplicatesData.name_duplicates || []).length;

        document.getElementById('dupe-count-byte').textContent = byteCount;
        document.getElementById('dupe-count-meta').textContent = metaCount;
        document.getElementById('dupe-count-name').textContent = nameCount;

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
        document.getElementById('dupe-selection-summary').textContent = 'Chưa có kết quả quét; chưa thể lưu trữ.';
        document.getElementById('dupe-display-count').textContent = 'Không tải được nhóm trùng.';
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
    const viewKey = JSON.stringify([currentDupeType, dupeSearchQuery, dupeSubFilter, document.getElementById('dupe-show-reviewed').checked]);
    if (viewKey !== dupeViewKey) { dupeVisibleLimit = 100; dupeViewKey = viewKey; }
    updateTaskContext();

    // Set title and description based on currentDupeType
    if (currentDupeType === 'byte') {
        document.getElementById('dupe-title-text').textContent = 'Tệp giống hệt từng byte';
        document.getElementById('dupe-desc-text').textContent = 'Các bản trùng byte được xác minh lại trước khi lưu trữ. Luôn giữ ít nhất một bản gốc; có thể hoàn tác. Lưu trữ trong cùng kho không làm giảm dung lượng đã dùng.';
    } else if (currentDupeType === 'meta') {
        document.getElementById('dupe-title-text').textContent = `Trùng Metadata Ca Sĩ & Tên Bài (${rawList.length} nhóm)`;
        document.getElementById('dupe-desc-text').textContent = 'Cùng nghệ sĩ / tên bài chỉ là gợi ý để xem xét. Đề xuất ưu tiên kiểm tra toàn vẹn còn hiệu lực, rồi metadata và vị trí; các bản master hoặc phát hành khác nhau nên giữ riêng. Không tự lưu trữ nhóm này.';
    } else {
        document.getElementById('dupe-title-text').textContent = `Trùng Tên Tệp Ở Khác Thư Mục (${rawList.length} nhóm)`;
        document.getElementById('dupe-desc-text').textContent = 'Trùng tên không chứng minh trùng âm thanh hoặc cùng bản phát hành. Nghe A/B và xem bằng chứng; đánh dấu giữ cả hai, khác bản phát hành hoặc bỏ qua. Không tự lưu trữ nhóm này.';
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
    filteredList.forEach(item => {
        const paths = item.files.map(file => typeof file === 'string' ? file : file.path);
        const key = item.id || item.hash;
        if (!paths.includes(userSelectedKeep[key])) userSelectedKeep[key] = paths[0];
    });
    document.getElementById('dupe-display-count').textContent = `Đang hiển thị ${Math.min(dupeVisibleLimit, filteredList.length)}/${filteredList.length} nhóm khớp bộ lọc · Tổng loại đang xem: ${rawList.length} nhóm.`;
    document.getElementById('dupes-more').hidden = dupeVisibleLimit >= filteredList.length;

    if (filteredList.length === 0) {
        container.innerHTML = `<div class="technical-note text-center py-6"><span class="text-emerald">🎉 Không có bản trùng lặp nào phù hợp với bộ lọc hiện tại!</span></div>`;
        updateDupeArchiveButton([]);
        return;
    }

    let html = '<div class="dupes-list">';
    filteredList.slice(0, dupeVisibleLimit).forEach((item, idx) => {
        const groupId = item.id || item.hash || (`grp_${idx}`);
        const files = item.files || [];

        // Determine currently kept file
        const defaultKept = typeof files[0] === 'string' ? files[0] : files[0].path;
        if (!files.some(file => (typeof file === 'string' ? file : file.path) === userSelectedKeep[groupId])) {
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
            groupTitle = `Nhóm #${idx + 1} (${formatMeasurement(item.size_mb)} MB / file)`;
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
                        ${currentDupeType === 'byte' && !item.review_decision ? `<button class="btn btn-sm btn-secondary btn-archive-single-group" data-groupid="${groupId}">📦 Lưu trữ (${numToArchive} bản)</button>` : ''}
                        <select class="dupe-review-decision" data-reviewkey="${item.review_key}" aria-label="Quyết định cho nhóm ${escapeHtml(keptFilename)}">
                            <option value="" ${!item.review_decision ? 'selected' : ''}>Chưa duyệt / Hoàn tác quyết định</option>
                            <option value="keep_both" ${item.review_decision === 'keep_both' ? 'selected' : ''}>Giữ tất cả</option>
                            <option value="different_edition" ${item.review_decision === 'different_edition' ? 'selected' : ''}>Khác bản phát hành</option>
                            <option value="ignore" ${item.review_decision === 'ignore' ? 'selected' : ''}>Bỏ qua nhóm này</option>
                        </select>
                    </div>
                </div>

                <div class="dupe-file-list dupe-comparison" role="list" aria-label="So sánh các bản của nhóm">
                    ${files.map(f => {
                        const filePath = typeof f === 'string' ? f : f.path;
                        const info = {...(typeof f === 'object' ? f : {}), ...item.file_details?.[filePath]};
                        const fileName = filePath.split('/').pop();
                        const isKept = filePath === keptFile;
                        const ext = (filePath.split('.').pop() || '').toUpperCase();
                        const integrity = {PASS: 'Đạt trong phạm vi đo', FAIL: 'Có lỗi', REVIEW: 'Cần xem xét', INCONCLUSIVE: 'Chưa kết luận'}[info.integrity_status] || 'Chưa kiểm tra / kết quả đã cũ';
                        const duration = Number.isFinite(info.duration) && info.duration > 0 ? `${Math.floor(info.duration / 60)}:${String(Math.floor(info.duration % 60)).padStart(2, '0')}` : 'Chưa đọc được';
                        const reason = info.recommendation_reason || (currentDupeType === 'byte' ? 'Nội dung giống từng byte; chọn vị trí muốn giữ.' : 'Chưa có kiểm tra toàn vẹn còn hiệu lực.');
                        return `
                            <div class="dupe-file-row dupe-copy ${isKept ? 'is-kept' : 'is-archive'}" data-groupid="${groupId}" data-file="${escapeHtml(filePath)}" role="listitem">
                                <label class="dupe-choice"><input type="radio" name="dupe_radio_${groupId}" class="dupe-radio-custom" value="${escapeHtml(filePath)}" ${isKept ? 'checked' : ''} aria-label="Chọn giữ ${escapeHtml(fileName)}"><span class="${isKept ? 'dupe-badge-keep' : 'dupe-badge-archive'}">${isKept ? 'ĐANG GIỮ' : 'BẢN KHÁC'}</span></label>
                                <strong class="dupe-copy-name">${escapeHtml(fileName)}</strong>
                                <dl class="dupe-copy-facts">
                                    <div><dt>Định dạng</dt><dd>${escapeHtml(info.specs || ext)}</dd></div>
                                    <div><dt>Thời lượng</dt><dd>${duration}</dd></div>
                                    <div><dt>Toàn vẹn</dt><dd>${integrity}</dd></div>
                                    <div><dt>Album</dt><dd>${escapeHtml(info.album || 'Chưa có metadata')}</dd></div>
                                </dl>
                                <p class="dupe-reason">${escapeHtml(reason)}</p>
                                <details class="dupe-path"><summary>Đường dẫn tệp</summary><code>${escapeHtml(filePath)}</code></details>
                                ${Number.isFinite(info.acoustic_match_pct) && !isKept ? `<p class="scoring-row-note">Vân tay: ${info.acoustic_match_pct}% khớp đề xuất ban đầu.</p>` : ''}
                                <div class="dupe-copy-actions">
                                    <button type="button" class="btn btn-sm btn-outline btn-row-play" data-file="${escapeHtml(filePath)}" data-title="${escapeHtml(fileName)}" data-specs="${escapeHtml(info.specs || ext)}">Nghe</button>
                                    <button type="button" ${isKept ? 'hidden' : ''} class="btn btn-sm btn-outline btn-row-compare-acoustic" data-file1="${escapeHtml(keptFile)}" data-file2="${escapeHtml(filePath)}" title="Đối chiếu vân tay với bản đang giữ">So vân tay</button>
                                    <button type="button" class="btn btn-sm btn-outline btn-row-spectrogram" data-file="${escapeHtml(filePath)}" data-title="${escapeHtml(fileName)}" data-specs="${escapeHtml(info.specs || ext)}">Xem phổ</button>
                                </div>
                            </div>`;
                    }).join('')}
                </div>
            </div>
        `;
    });
    html += '</div>';
    container.innerHTML = html;

    container.querySelectorAll('.dupe-review-decision').forEach(select => {
        select.addEventListener('change', async () => {
            select.disabled = true;
            try {
                const response = await postJSON('/api/duplicates/decision', {group_key: select.dataset.reviewkey, decision: select.value || null});
                const result = await response.json();
                if (!response.ok) throw new Error(result.detail || 'Không lưu được quyết định');
                await loadDuplicates();
            } catch (error) { showToast(error.message, 'error'); select.disabled = false; }
        });
    });

    // 1. Attach interactive click event on each file row
    container.querySelectorAll('.dupe-file-row').forEach(row => {
        row.addEventListener('click', (e) => {
            if (e.target.closest('button, details')) return;

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
                    
                    if (rFile === file) {
                        r.classList.add('is-kept');
                        r.classList.remove('is-archive');
                        if (radio) radio.checked = true;
                        if (badge) {
                            badge.className = 'dupe-badge-keep';
                            badge.textContent = 'ĐANG GIỮ';
                        }
                    } else {
                        r.classList.remove('is-kept');
                        r.classList.add('is-archive');
                        if (radio) radio.checked = false;
                        if (badge) {
                            badge.className = 'dupe-badge-archive';
                            badge.textContent = 'BẢN KHÁC';
                        }
                    }
                });

                const lblKept = document.getElementById(`lbl-kept-${gId}`);
                if (lblKept) {
                    lblKept.textContent = file.split('/').pop();
                }
            }

            card?.querySelectorAll('.btn-row-compare-acoustic').forEach(button => {
                if (button.dataset.file1 !== file) {
                    button.textContent = 'So vân tay';
                    button.className = 'btn btn-sm btn-outline btn-row-compare-acoustic';
                }
                button.dataset.file1 = file;
                button.hidden = button.dataset.file2 === file;
            });
            updateDupeArchiveButton(filteredList);
        });
    });

    container.querySelectorAll('.dupe-radio-custom').forEach(radio => {
        radio.addEventListener('change', () => radio.closest('.dupe-file-row').click());
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
                const res = await postJSON('/api/fingerprint/compare', { file1: f1, file2: f2 });
                const data = await res.json();
                if (!btn.isConnected || btn.dataset.file1 !== f1 || btn.dataset.file2 !== f2) return;
                if (data.navidrome_scan) handleNavidromeResult(data.navidrome_scan);
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
        const res = await postJSON('/api/duplicates/archive-byte-dupes', { files_to_archive: toArchive });
        const data = await res.json();
        if (data.navidrome_scan) handleNavidromeResult(data.navidrome_scan);
        if (data.success) {
            showToast(`✅ Đã di chuyển ${data.archived_count || toArchive.length} bản phụ vào _Duplicates_Archive`, 'success');
            await loadDuplicates(true);
        } else {
            showToast([data.message || data.detail || 'Không thể di chuyển file', ...(data.errors || [])].join('\n'), 'warning');
            await loadDuplicates();
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

function duplicateArchivePaths(activeList) {
    if (currentDupeType !== 'byte') return [];
    return activeList.filter(item => !item.review_decision).flatMap((item, idx) => {
        const gId = item.id || item.hash || (`grp_${idx}`);
        const paths = (item.files || []).map(file => typeof file === 'string' ? file : file.path);
        const kept = paths.includes(userSelectedKeep[gId]) ? userSelectedKeep[gId] : paths[0];
        return paths.filter(path => path !== kept);
    });
}

function updateDupeArchiveButton(activeList) {
    const btn = document.getElementById('btn-archive-byte-dupes');
    const summarySpan = document.getElementById('dupe-selection-summary');
    if (!btn) return;

    if (currentDupeType !== 'byte' || !activeList || activeList.length === 0) {
        btn.disabled = true;
        btn.textContent = 'Di Chuyển 0 Bản Phụ Vào Archive';
        if (summarySpan) {
            summarySpan.textContent = currentDupeType === 'byte' ? 'Không có bản trùng byte nào để lưu trữ' : 'Nhóm này cần xem xét; chỉ cho phép lưu trữ bản giống từng byte.';
        }
        return;
    }

    const totalToArchive = duplicateArchivePaths(activeList).length;

    const typeLabel = currentDupeType === 'meta' ? 'Bản Phụ Metadata' : (currentDupeType === 'name' ? 'Bản Trùng Tên' : 'Bản Trùng Byte');
    btn.textContent = `Lưu trữ ${totalToArchive} bản trùng byte`;
    btn.disabled = (totalToArchive === 0);

    if (summarySpan) {
        const filterNote = dupeSubFilter !== 'all' ? ` (theo bộ lọc hiện tại)` : '';
        summarySpan.textContent = `Lưu trữ ${totalToArchive} bản từ tất cả ${activeList.filter(item => !item.review_decision).length} nhóm chưa duyệt khớp bộ lọc, kể cả nhóm chưa hiển thị. Mỗi nhóm giữ lại một bản${filterNote}.`;
    }
}

async function executeBatchArchiveDuplicates() {
    if (currentDupeType !== 'byte') return;
    const activeList = currentFilteredDuplicates;
    if (!activeList || activeList.length === 0) return;

    const filesToArchive = duplicateArchivePaths(activeList);

    if (filesToArchive.length === 0) {
        showToast("Không có bản phụ nào được chọn để di chuyển!", 'warning');
        return;
    }

    const typeDesc = currentDupeType === 'meta' ? 'trùng Metadata' : (currentDupeType === 'name' ? 'trùng Tên tệp' : 'trùng 100% Byte');
    const filterContext = dupeSubFilter !== 'all' ? ` [Bộ lọc: ${dupeSubFilter}]` : (dupeSearchQuery ? ` [Tìm kiếm: "${dupeSearchQuery}"]` : '');
    const confirmed = await showConfirm(
        'Xác nhận di chuyển bản phụ hàng loạt',
        `${document.getElementById('dupe-display-count').textContent}\n\nPhạm vi: TẤT CẢ nhóm chưa duyệt khớp bộ lọc hiện tại, kể cả nhóm chưa hiển thị.\nLưu trữ ${filesToArchive.length} bản trùng byte; mỗi nhóm giữ lại một bản. Có thể hoàn tác.\n${filterContext}\n\nTiếp tục?`
    );
    if (!confirmed) return;

    const btn = document.getElementById('btn-archive-byte-dupes');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ Đang di chuyển bản phụ...';
    }

    try {
        const res = await postJSON('/api/duplicates/archive-byte-dupes', { files_to_archive: filesToArchive });
        const data = await res.json();
        if (data.navidrome_scan) handleNavidromeResult(data.navidrome_scan);
        if (data.success) {
            showToast(`✅ ${data.message}`, 'success');
            await loadDuplicates(true);
        } else {
            showToast([data.message || data.detail || 'Không thể di chuyển file', ...(data.errors || [])].join('\n'), 'warning');
            await loadDuplicates();
        }
    } catch (e) {
        showToast(`❌ Lỗi: ${e.message}`, 'error');
    } finally {
        updateDupeArchiveButton(currentFilteredDuplicates);
    }
}

// ==============================================================================
// 7. NAVIDROME INTEGRATION & SEAMLESS SYNC
// ==============================================================================
let navidromeScanInterval = null;
let navidromeConnection = null;
let navidromeMonitorGeneration = 0;
let navidromeScanRequest = null;

async function navidromeRequest(path, method = 'POST', body) {
    const response = await fetch(`/api/navidrome/${path}`, {
        method, headers: {'Content-Type': 'application/json'},
        ...(body === undefined ? {} : {body: JSON.stringify(body)})
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'Không thể kết nối Navidrome.');
    return data;
}

function getNavidromeConfigFromStorage() {
    // Only public connection information ever reaches the client.
    return navidromeConnection?.configured ? {server_url: navidromeConnection.server_url, username: navidromeConnection.username} : null;
}

function getNavidromeConfigFromInputs() {
    return {server_url: document.getElementById('navi-url').value.trim(),
        username: document.getElementById('navi-user').value.trim(),
        password: document.getElementById('navi-pass').value};
}

function populateNavidromeSettings() {
    document.getElementById('navi-url').value = navidromeConnection?.server_url || '';
    document.getElementById('navi-user').value = navidromeConnection?.username || '';
    document.getElementById('navi-pass').value = '';
    document.getElementById('navi-password-help').textContent = navidromeConnection?.password_saved
        ? 'Mật khẩu đã lưu trên máy chủ. Để trống để giữ nguyên.' : 'Mật khẩu chỉ được lưu trên máy chạy ứng dụng.';
}

async function initNavidrome() {
    document.getElementById('navi-header-text').addEventListener('click', () => switchTab('tab-navidrome'));
    document.getElementById('btn-quick-rescan').addEventListener('click', () => triggerNavidromeRescan(false));
    document.getElementById('navidrome-retry').addEventListener('click', () => triggerNavidromeRescan(false));
    document.getElementById('btn-trigger-navidrome-scan').addEventListener('click', () => triggerNavidromeRescan(true));
    document.getElementById('btn-install-all-playlists').addEventListener('click', installAllSmartPlaylists);
    document.getElementById('btn-test-navidrome').addEventListener('click', async event => {
        const button = event.currentTarget; button.disabled = true;
        stopNavidromeMonitor();
        try {
            navidromeConnection = await navidromeRequest('config', 'POST', getNavidromeConfigFromInputs());
            populateNavidromeSettings();
            await checkNavidromeHealth(false);
        } catch (error) { document.getElementById('navi-result-msg').textContent = error.message; }
        finally { button.disabled = false; }
    });
    document.getElementById('navi-disconnect').addEventListener('click', async () => {
        try {
            navidromeConnection = await navidromeRequest('config', 'DELETE');
            stopNavidromeMonitor(); populateNavidromeSettings(); updateNavidromeUIStatus(false);
            document.getElementById('navi-result-msg').textContent = 'Đã xóa kết nối đã lưu.';
            document.getElementById('navidrome-sync-notice').hidden = true;
        } catch (error) { showToast(error.message, 'error'); }
    });
    try {
        navidromeConnection = await navidromeRequest('config', 'GET');
        // Migrate earlier browser settings once; only remove them after a successful save.
        const oldUrl = localStorage.getItem('navi_url') || localStorage.getItem('navidrome_server_url');
        if (!navidromeConnection.configured && oldUrl) {
            navidromeConnection = await navidromeRequest('config', 'POST', {server_url: oldUrl,
                username: localStorage.getItem('navi_user') || localStorage.getItem('navidrome_username') || '',
                password: localStorage.getItem('navi_pass') || localStorage.getItem('navidrome_password') || ''});
        }
        ['navi_url', 'navi_user', 'navi_pass', 'navidrome_server_url', 'navidrome_username', 'navidrome_password'].forEach(key => localStorage.removeItem(key));
        populateNavidromeSettings();
        if (navidromeConnection.configured) await checkNavidromeHealth(true);
        else updateNavidromeUIStatus(false);
    } catch (error) {
        updateNavidromeUIStatus(false);
        document.getElementById('navi-result-msg').textContent = error.message;
    }
}

async function checkNavidromeHealth(silent = false) {
    try {
        const data = await navidromeRequest('test');
        updateNavidromeUIStatus(data.success);
        if (!silent) document.getElementById('navi-result-msg').textContent = data.message;
        if (data.success) {
            const scan = await navidromeRequest('scan-status');
            if (scan.success && scan.scanning) startNavidromeScanMonitor();
        }
        return data.success;
    } catch (error) {
        updateNavidromeUIStatus(false);
        if (!silent) document.getElementById('navi-result-msg').textContent = error.message;
        return false;
    }
}

function updateNavidromeUIStatus(isOnline) {
    const configured = navidromeConnection?.configured;
    const url = navidromeConnection?.server_url || '';
    const label = isOnline ? 'Đã kết nối' : configured ? 'Ngoại tuyến' : 'Chưa kết nối';
    const state = isOnline ? 'online' : 'offline';
    document.getElementById('navidrome-quick-pill').className = `navidrome-pill ${state}`;
    document.getElementById('navi-header-dot').className = `status-pulse-dot ${state}`;
    document.getElementById('navi-header-text').textContent = `Navidrome · ${label}`;
    document.getElementById('navi-hero-dot').className = `status-pulse-dot ${state}`;
    document.getElementById('navi-hero-status-label').textContent = label;
    document.getElementById('navidrome-badge').textContent = label;
    document.getElementById('navidrome-status-dot').className = isOnline ? 'nav-badge online' : 'nav-badge';
    ['btn-open-navidrome', 'btn-hero-open-navidrome'].forEach(id => {
        const link = document.getElementById(id);
        link.style.display = configured ? 'inline-flex' : 'none';
        link.href = url || '#';
    });
    document.getElementById('btn-quick-rescan').disabled = !configured;
}

function showNavidromeSync(message, retry = false) {
    document.getElementById('navidrome-sync-notice').hidden = false;
    document.getElementById('navidrome-sync-message').textContent = message;
    document.getElementById('navidrome-retry').hidden = !retry;
}

function handleNavidromeResult(scan) {
    if (!scan) return;
    if (scan.success) {
        showNavidromeSync('Đã lưu thay đổi cục bộ · Navidrome đang cập nhật thư viện…');
        startNavidromeScanMonitor();
    } else {
        stopNavidromeMonitor(); updateNavidromeUIStatus(false);
        showNavidromeSync('Thay đổi cục bộ đã được giữ. Navidrome chưa cập nhật: ' + (scan.message || 'Không kết nối được.'), true);
    }
}

async function triggerNavidromeRescan(fromTab = true) {
    if (!navidromeConnection?.configured) {
        switchTab('tab-navidrome'); document.getElementById('navi-url').focus();
        return;
    }
    if (navidromeScanRequest) return navidromeScanRequest;
    const full = fromTab && document.getElementById('navi-full-scan').checked;
    document.getElementById('navi-full-scan').checked = false;
    navidromeScanRequest = (async () => {
        try {
            const result = await navidromeRequest('scan', 'POST', {full_scan: full});
            if (result.success) {
                showNavidromeSync('Đã yêu cầu Navidrome cập nhật thư viện…');
                startNavidromeScanMonitor();
            } else {
                updateNavidromeUIStatus(false);
                showNavidromeSync(result.message || 'Chưa cập nhật được Navidrome.', true);
            }
        } catch (error) { showNavidromeSync(error.message, true); }
        finally { navidromeScanRequest = null; }
    })();
    return navidromeScanRequest;
}

function stopNavidromeMonitor() {
    clearTimeout(navidromeScanInterval); navidromeScanInterval = null;
    navidromeMonitorGeneration += 1;
    document.getElementById('navi-scan-progress').style.display = 'none';
}

function startNavidromeScanMonitor() {
    stopNavidromeMonitor();
    const generation = navidromeMonitorGeneration;
    const started = Date.now();
    document.getElementById('navidrome-quick-pill').className = 'navidrome-pill scanning';
    document.getElementById('navi-header-text').textContent = 'Navidrome · Đang cập nhật';
    document.getElementById('navi-scan-progress').style.display = 'block';
    document.getElementById('navi-scan-count-text').textContent = 'Đang chờ tiến độ từ Navidrome…';
    const check = async () => {
        if (generation !== navidromeMonitorGeneration) return;
        try {
            const status = await navidromeRequest('scan-status');
            if (generation !== navidromeMonitorGeneration) return;
            if (!status.success) throw new Error('Không đọc được tiến độ Navidrome.');
            if (!status.scanning) {
                stopNavidromeMonitor(); updateNavidromeUIStatus(true);
                showNavidromeSync('Navidrome đã hoàn tất lượt quét thư viện.');
                return;
            }
            document.getElementById('navi-scan-count-text').textContent = `${formatMeasurement(status.count)} bài đã xử lý`;
            if (Date.now() - started > 10 * 60 * 1000) throw new Error('Navidrome vẫn có thể đang quét. Kiểm tra lại trạng thái khi cần.');
            navidromeScanInterval = setTimeout(check, document.hidden ? 10000 : 2500);
        } catch (error) {
            if (generation !== navidromeMonitorGeneration) return;
            stopNavidromeMonitor(); updateNavidromeUIStatus(false);
            showNavidromeSync(error.message + ' Thay đổi cục bộ vẫn được giữ.', true);
        }
    };
    navidromeScanInterval = setTimeout(check, 800);
}

async function loadSmartPlaylists() {
    const container = document.getElementById('smart-playlists-container');
    if (!container) return;

    try {
        const res = await fetch('/api/navidrome/smart-playlists');
        const data = await res.json();
        if (!data.success || !data.playlists) {
            container.innerHTML = `<p class="text-rose text-center py-3">Không thể tải danh sách Smart Playlists</p>`;
            return;
        }

        container.innerHTML = data.playlists.map(pl => `
            <div class="smart-playlist-item">
                <div class="smart-playlist-info">
                    <h4>
                        ${escapeHtml(pl.name)}
                        ${pl.installed 
                            ? '<span class="stat-tag tag-emerald" style="font-size: 0.65rem; padding: 1px 6px;">✓ Đã cài đặt</span>' 
                            : '<span class="stat-tag" style="font-size: 0.65rem; padding: 1px 6px; background: rgba(255,255,255,0.08); color: var(--text-muted);">Chưa có tệp</span>'
                        }
                    </h4>
                    <p>${escapeHtml(pl.description)} &bull; <code>${escapeHtml(pl.filename)}</code></p>
                </div>
                <div class="smart-playlist-actions">
                    <button class="btn btn-xs ${pl.installed ? 'btn-secondary' : 'btn-primary'} btn-install-single-pl" data-filename="${escapeHtml(pl.filename)}">
                        ${pl.installed ? 'Ghi đè lại' : 'Cài đặt'}
                    </button>
                </div>
            </div>
        `).join('');

        // Wire single install buttons
        container.querySelectorAll('.btn-install-single-pl').forEach(btn => {
            btn.addEventListener('click', async () => {
                const filename = btn.dataset.filename;
                await installSmartPlaylists([filename]);
            });
        });
    } catch (e) {
        container.innerHTML = `<p class="text-rose text-center py-3">Lỗi: ${e.message}</p>`;
    }
}

async function installAllSmartPlaylists() {
    await installSmartPlaylists(null);
}

async function installSmartPlaylists(playlistKeys = null) {
    const cfg = getNavidromeConfigFromStorage();
    showToast('⚙️ Đang ghi file .nsp vào kho nhạc...', 'info');

    try {
        const res = await postJSON('/api/navidrome/smart-playlists/install', {
            playlists: playlistKeys,
            navidrome_config: cfg
        });
        const data = await res.json();
        if (data.navidrome_scan) handleNavidromeResult(data.navidrome_scan);
        if (data.success) {
            showToast(`✅ ${data.message}`, 'success', 4000);
            loadSmartPlaylists();

        } else {
            showToast(`❌ Lỗi: ${data.message}`, 'error');
        }
    } catch (e) {
        showToast(`❌ Lỗi: ${e.message}`, 'error');
    }
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
        [search, filter, changeFilter, ...document.querySelectorAll('.organize-edit')].forEach(node => { node.disabled = busy; });
        buttons.forEach(id => {
            document.getElementById(id).disabled = busy || (id === 'metadata-organize-apply' && !plan?.counts.READY);
        });
    };
    const request = async (action, body = {}) => {
        const res = await fetch(`/api/organize/${action}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
        const data = await res.json();
        if (data.navidrome_scan) handleNavidromeResult(data.navidrome_scan);
        if (!res.ok) throw new Error(res.status === 405 && action === 'edit'
            ? 'Máy chủ đang chạy bản cũ, chưa hỗ trợ lưu tên. Hãy khởi động lại ứng dụng rồi thử lại.'
            : data.detail || 'Không hoàn tất thao tác.');
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
                const nameLine = side === 'new' ? add('div', 'organize-name-line', '', group) : group;
                const name = add('p', 'organize-filename', '', nameLine);
                if (side === 'new' && !item.dest_path) name.textContent = 'Chưa có đề xuất';
                else if (renamed) {
                    name.append(document.createTextNode(chars.slice(0, prefix).join('')));
                    if (chars.length - suffix > prefix) add('mark', '', chars.slice(prefix, chars.length - suffix).join(''), name);
                    name.append(document.createTextNode(chars.slice(chars.length - suffix).join('')));
                } else name.textContent = chars.join('');
                const directory = side === 'new' && !item.dest_path ? 'Chưa có đề xuất' : folder === '.' ? 'Gốc kho nhạc' : folder;
                add('p', 'organize-directory', `Thư mục${side === 'new' && moved ? ' mới' : ''}: ${directory}`, group);
                if (side === 'new' && item.dest_path && item.status !== 'REVIEW') {
                    const edit = add('button', 'btn btn-secondary btn-sm organize-edit', item.filename_edited ? 'Sửa tên · đã chỉnh' : 'Sửa tên', nameLine);
                    edit.type = 'button';
                    edit.setAttribute('aria-label', `Sửa tên đề xuất: ${newName}`);
                    edit.addEventListener('click', () => {
                        setBusy(true);
                        name.hidden = true; edit.hidden = true;
                        const editor = add('form', 'organize-editor', '', group);
                        group.insertBefore(editor, nameLine);
                        const input = add('input', '', '', editor);
                        input.value = newName;
                        input.setAttribute('aria-label', 'Tên file đề xuất');
                        add('p', 'organize-directory', `Giữ đuôi ${newName.slice(newName.lastIndexOf('.'))}. Chỉ đổi tên file, không sửa tag.`, editor);
                        const actions = add('div', 'btn-group', '', editor);
                        const save = add('button', 'btn btn-primary btn-sm', 'Lưu tên', actions); save.type = 'submit';
                        const cancel = add('button', 'btn btn-secondary btn-sm', 'Hủy', actions); cancel.type = 'button';
                        const error = add('p', 'organize-edit-error', '', editor); error.setAttribute('role', 'alert');
                        const close = () => { editor.remove(); name.hidden = false; edit.hidden = false; setBusy(false); edit.focus(); };
                        cancel.addEventListener('click', close);
                        input.addEventListener('keydown', event => {
                            if (event.key === 'Escape' && !cancel.disabled) { event.preventDefault(); close(); }
                        });
                        editor.addEventListener('submit', async event => {
                            event.preventDefault(); error.textContent = '';
                            input.disabled = save.disabled = cancel.disabled = true;
                            const scroll = rows.closest('.organize-table-scroll');
                            const position = scroll.scrollTop;
                            try {
                                plan = await request('edit', {plan_id: plan.plan_id, original_path: item.original_path, filename: input.value});
                                render(); scroll.scrollTop = position;
                                status.textContent = `Đã lưu tên đề xuất. ${plan.counts.READY} bài sẵn sàng · ${plan.counts.CONFLICT} trùng đích. Chưa thay đổi tệp.`;
                                setBusy(false);
                            } catch (err) {
                                error.textContent = err.message;
                                input.disabled = save.disabled = cancel.disabled = false;
                                input.focus();
                            }
                        });
                        input.focus(); input.setSelectionRange(0, newName.lastIndexOf('.'));
                    });
                }

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
        document.getElementById('metadata-organize-count').textContent = `Hiển thị ${items.length}/${plan?.total || 0} bài trong bản xem trước · Áp dụng: ${plan?.counts.READY || 0} bài sẵn sàng trong toàn bộ bản xem trước, kể cả ngoài bộ lọc.`;
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
            : `${document.getElementById('metadata-organize-count').textContent}\nPhạm vi: TẤT CẢ ${preview.counts.READY} bài sẵn sàng trong bản xem trước, kể cả ngoài bộ lọc. Bỏ qua bài thiếu metadata và trùng đích. Nội dung audio và tag được giữ nguyên. Tiếp tục?`);
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
            if (data.navidrome_scan) handleNavidromeResult(data.navidrome_scan);
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
        const btn = document.getElementById('btn-tag-navidrome-all');
        const box = document.getElementById('organize-status-box');
        btn.disabled = true;
        btn.textContent = 'Đang đọc phạm vi…';
        if (box) box.innerHTML = `<span class="text-muted">Đang đọc danh sách toàn bộ kho để xác nhận phạm vi…</span>`;
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
            const confirmed = await showConfirm(
                `Đo & ghi tag toàn bộ kho (${tracks.length} bài)`,
                `Phạm vi: TOÀN BỘ ${tracks.length} bài trong kho. Bỏ qua bộ lọc và danh sách bài đã chọn. Đo chẩn đoán rồi ghi ghi chú, trạng thái chưa xác minh và ReplayGain khi đo được. Có thể thay đổi ghi chú hiện có; tag gốc được sao lưu trước khi ghi. Dữ liệu âm thanh không được mã hóa lại. Tiếp tục?`
            );
            if (!confirmed) { if (box) box.textContent = 'Đã hủy; chưa ghi tag.'; return; }
            let success = 0;
            for (let i = 0; i < tracks.length; i++) {
                const t = tracks[i];
                if (box) box.innerHTML = `<span class="text-muted">Đang ghi tag [${i + 1}/${tracks.length}]: ${escapeHtml(t.title || t.original_path)}</span>`;
                try {
                    const tagRes = await postJSON('/api/audiophile/tag', { filepath: t.original_path, defer_scan: true });
                    const tagData = await tagRes.json();
                    if (tagData.success) success++;
                } catch (err) {}
            }
            if (success > 0 && navidromeConnection?.configured) await triggerNavidromeRescan(false);
            if (box) box.innerHTML = `<div class="text-emerald">✅ Đã gắn tag và sao lưu metadata cho ${success}/${tracks.length} bài hát!</div>`;
            showToast(`✅ Đã gắn tag thành công cho ${success}/${tracks.length} bài hát!`, 'success');
            if (typeof loadTracks === 'function') loadTracks();
        } catch (e) {
            if (box) box.innerHTML = `<div class="text-rose">❌ Lỗi: ${escapeHtml(e.message)}</div>`;
            showToast(`❌ Lỗi: ${e.message}`, 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Đo & ghi tag toàn bộ kho';
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
            const res = await postJSON('/api/audiophile/tag/rollback-all', {navidrome_config: naviCfg});
            const data = await res.json();
            if (data.navidrome_scan) handleNavidromeResult(data.navidrome_scan);
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
            closeSpectrogramModal();
        });
    });

    modal?.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeSpectrogramModal();
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

    document.getElementById('modal-btn-duplicates').addEventListener('click', () => {
        if (!currentSelectedTrack) return;
        const title = currentSelectedTrack.title || '';
        closeSpectrogramModal();
        currentDupeType = 'meta';
        dupeSearchQuery = title.toLowerCase().trim();
        document.getElementById('dupe-search-input').value = title;
        document.querySelectorAll('#dupe-filter-pills .filter-pill').forEach(pill => pill.classList.toggle('active', pill.dataset.dupetype === 'meta'));
        document.getElementById('dupe-subtoolbar').style.display = 'flex';
        document.getElementById('dupe-subfilter-pills').style.display = 'flex';
        switchTab('tab-duplicates');
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
    document.getElementById('modal-btn-classification-tag').addEventListener('click', () => {
        if (currentSelectedTrack) tagSingleTrack(currentSelectedTrack.path, document.getElementById('modal-btn-classification-tag'), false);
    });
    document.getElementById('btn-retry-fingerprint').addEventListener('click', loadTrackFingerprint);
}

function closeSpectrogramModal() {
    const modal = document.getElementById('spectrogram-modal');
    if (modal) modal.classList.remove('active');
    trackDetailsOpener?.focus();
}

async function openSpectrogramModal(filepath, title, specs) {
    const modal = document.getElementById('spectrogram-modal');
    trackDetailsOpener = document.activeElement;
    modal.classList.add('active');
    modal.focus();

    currentSelectedTrack = { path: filepath, title, specs };
    const fingerprint = document.getElementById('track-fingerprint');
    fingerprint.open = false;
    document.getElementById('track-fingerprint-status').textContent = 'Mở để đọc vân tay của tệp này.';
    document.getElementById('track-fingerprint-data').replaceChildren();
    document.getElementById('btn-retry-fingerprint').hidden = true;
    document.querySelector('#modal-btn-apply-tag').closest('details').open = false;
    fingerprint.ontoggle = () => {
        if (fingerprint.open && !currentSelectedTrack.fingerprintRequested) loadTrackFingerprint();
    };
    currentAuditResult = null;
    document.getElementById('modal-track-title').textContent = title || filepath;
    document.getElementById('modal-track-path').textContent = filepath;

    // Update Navidrome direct search button in modal
    const naviBtn = document.getElementById('modal-btn-open-navidrome');
    if (naviBtn) {
        const naviCfg = getNavidromeConfigFromStorage() || getNavidromeConfigFromInputs();
        if (naviCfg && naviCfg.server_url) {
            const query = (title || filepath.split('/').pop() || '').replace(/\.[^/.]+$/, "");
            const naviUrl = naviCfg.server_url.replace(/\/+$/, '');
            naviBtn.href = `${naviUrl}/#/search?q=${encodeURIComponent(query)}`;
            naviBtn.style.display = 'inline-flex';
        } else {
            naviBtn.style.display = 'none';
        }
    }

    const track = libraryTrackDetails.get(filepath) || {};
    document.getElementById('modal-btn-duplicates').hidden = !track.is_duplicate_meta;
    document.getElementById('track-summary').innerHTML = [
        ['Nghệ sĩ', track.artist || '—'], ['Album', track.album || '—'], ['Định dạng', specs || '—'],
        ['Nguồn thông tin', track.verdict_source === 'audit' ? 'Kết quả kiểm tra đã lưu' : 'Metadata · nguồn master chưa xác thực']
    ].map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');
    const diagnostics = document.getElementById('track-diagnostics');
    diagnostics.open = false;
    diagnostics.ontoggle = () => {
        if (!diagnostics.open || diagnostics.dataset.path === filepath) return;
        diagnostics.dataset.path = filepath;
        loadTrackDiagnostics(filepath);
    };
    delete diagnostics.dataset.path;
}

async function loadTrackFingerprint() {
    const track = currentSelectedTrack;
    if (!track || track.fingerprintLoading) return;
    track.fingerprintRequested = true;
    track.fingerprintLoading = true;
    const status = document.getElementById('track-fingerprint-status');
    const retry = document.getElementById('btn-retry-fingerprint');
    retry.hidden = true;
    status.textContent = 'Đang đọc vân tay…';
    try {
        const response = await fetch(`/api/fingerprint/info?filepath=${encodeURIComponent(track.path)}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || 'Không đọc được vân tay');
        if (currentSelectedTrack !== track) return;
        status.textContent = data.is_available ? 'Có vân tay để so sánh bản thu; không xác minh nguồn master.' : `Chưa có vân tay. ${data.error || 'Không tạo được vân tay cho tệp này.'}`;
        document.getElementById('track-fingerprint-data').innerHTML = [
            ['Trạng thái', data.is_available ? 'Có sẵn' : 'Không có'],
            ['Thời lượng', formatMeasurement(data.duration, ' giây')],
            ['Số giá trị vân tay', formatMeasurement(data.sample_count)]
        ].map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');
        retry.hidden = data.is_available;
    } catch (error) {
        if (currentSelectedTrack !== track) return;
        status.textContent = `Không đọc được vân tay: ${error.message}`;
        retry.hidden = false;
    } finally {
        track.fingerprintLoading = false;
    }
}

function loadTrackDiagnostics(filepath) {
    const img = document.getElementById('spectrogram-img');
    const dspGrid = document.getElementById('dsp-metrics-grid');
    img.src = '';
    dspGrid.innerHTML = `<div class="text-muted">Đang phân tích thông số DSP &amp; tải phổ âm...</div>`;

    document.getElementById('modal-audit-md5').textContent = 'Đang đọc...';
    document.getElementById('modal-audit-gain').textContent = '-- dB';
    document.getElementById('modal-audit-tier').textContent = '--';
    document.getElementById('modal-dr-badge-header').textContent = 'DR--';
    document.getElementById('modal-audit-cutoff').textContent = '—';
    document.getElementById('modal-audit-fp').textContent = '—';

    // 1. Phân tích DSP cơ bản
    postJSON('/api/analyze', { filepath })
    .then(r => { if (!r.ok) throw new Error('Không phân tích được tệp'); return r.json(); })
    .then(data => {
        if (currentSelectedTrack?.path !== filepath) return;
        const cutoffLabel = data.cutoff_hz ? `${(data.cutoff_hz/1000).toFixed(1)} kHz (${formatMeasurement(data.cutoff_drop_db, ' dB sụt')})` : 'Không rõ';
        dspGrid.innerHTML = `
            <div class="dsp-metric">
                <span class="dsp-metric-label">Biên phổ (sàng lọc)</span>
                <span class="dsp-metric-value" style="color: ${data.cutoff_drop_db >= 20 ? '#f43f5e' : '#10b981'}">${cutoffLabel}</span>
            </div>
            <div class="dsp-metric">
                <span class="dsp-metric-label">Độ Sụt Tần 22k</span>
                <span class="dsp-metric-value">${Number.isFinite(data.drop_at_22k) ? data.drop_at_22k + ' dB' : 'N/A'}</span>
            </div>
            <div class="dsp-metric">
                <span class="dsp-metric-label">Dải Siêu Âm >24k</span>
                <span class="dsp-metric-value">${Number.isFinite(data.ultrasonic_db) ? data.ultrasonic_db + ' dB' : 'N/A'}</span>
            </div>
            <div class="dsp-metric">
                <span class="dsp-metric-label">Đánh Giá Phổ Âm</span>
                <span class="dsp-metric-value" style="color: ${data.badge_color || '#fff'}">${escapeHtml(data.badge || data.verdict || '')}</span>
            </div>
        `;
    })
    .catch(() => {
        if (currentSelectedTrack?.path !== filepath) return;
        dspGrid.innerHTML = `<div class="text-rose">Lỗi khi phân tích DSP</div>`;
    });

    // 2. Chạy nhanh Audiophile audit cho modal
    postJSON('/api/audiophile/audit', { filepath })
    .then(r => { if (!r.ok) throw new Error('Không phân tích được tệp'); return r.json(); })
    .then(data => {
        if (currentSelectedTrack?.path !== filepath) return;
        currentAuditResult = data;
        const dr = data.dynamic_range || {};
        const integ = data.integrity || {};
        const loud = data.loudness || {};
        const tier = data.vault_tier || {};
        const fp = data.fingerprint || {};
        const spec = data.spectrum || {};

        const drHeader = document.getElementById('modal-dr-badge-header');
        if (drHeader) {
            drHeader.textContent = dr.dr_badge || formatMeasurement(dr.dr_score, ' DR');
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
            elFp.textContent = fp.is_available ? `Chromaprint (${formatMeasurement(fp.sample_count)} giá trị)` : 'Chưa có';
            elFp.style.color = fp.is_available ? '#34d399' : '#94a3b8';
        }
    })
    .catch(() => {
        if (currentSelectedTrack?.path !== filepath) return;
        ['modal-audit-md5', 'modal-audit-gain', 'modal-audit-tier', 'modal-dr-badge-header', 'modal-audit-cutoff', 'modal-audit-fp'].forEach(id => {
            document.getElementById(id).textContent = 'Không đo được';
        });
    });

    // 3. Tải ảnh Spectrogram
    img.src = `/api/spectrogram?filepath=${encodeURIComponent(filepath)}`;
}

async function tagSingleTrack(filepath, btnElement = null, diagnostics = true) {
    const confirmed = await showConfirm(
        diagnostics ? 'Đo & ghi tag' : 'Ghi nhãn phân loại',
        `Phạm vi: 1 bài:\n${filepath}\n${diagnostics ? 'Đo chẩn đoán, ghi ghi chú và trạng thái chưa xác minh, thêm ReplayGain khi đo được.' : 'Ghi ghi chú phân nhóm và trạng thái chưa xác minh, không thêm ReplayGain.'} Có thể thay đổi ghi chú hiện có; tag gốc được sao lưu. Tiếp tục?`
    );
    if (!confirmed) return;
    const originalText = btnElement?.textContent;
    if (btnElement) {
        btnElement.textContent = '⏳...';
        btnElement.disabled = true;
    }
    try {
        const naviCfg = getNavidromeConfigFromStorage();
        const res = await postJSON(diagnostics ? '/api/audiophile/tag' : '/api/tag/single', { filepath, navidrome_config: naviCfg });
        const data = await res.json();
        if (data.navidrome_scan) handleNavidromeResult(data.navidrome_scan);
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
            btnElement.textContent = originalText;
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
        const res = await postJSON('/api/audiophile/tag/rollback', { filepath, navidrome_config: naviCfg });
        const data = await res.json();
        if (data.navidrome_scan) handleNavidromeResult(data.navidrome_scan);
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

function initKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
        const activeTag = document.activeElement ? document.activeElement.tagName : '';
        const isEditing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeTag) ||
                          (document.activeElement && document.activeElement.isContentEditable);

        const confirmation = document.getElementById('confirm-modal');
        if (confirmation.style.display === 'flex') {
            if (e.key === 'Escape') { e.preventDefault(); document.getElementById('confirm-modal-btn-cancel').click(); }
            if (e.key === 'Tab') {
                const buttons = [...confirmation.querySelectorAll('button')].filter(button => !button.disabled);
                const first = buttons[0], last = buttons[buttons.length - 1];
                if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            }
            return;
        }
        const drawer = document.getElementById('spectrogram-modal');
        if (drawer.classList.contains('active')) {
            if (e.key === 'Escape') { e.preventDefault(); closeSpectrogramModal(); }
            if (e.key === 'Tab') {
                const focusable = [...drawer.querySelectorAll('button, a[href], summary, input')].filter(node => !node.disabled && node.getClientRects().length);
                const first = focusable[0], last = focusable[focusable.length - 1];
                if (e.shiftKey && (document.activeElement === first || document.activeElement === drawer)) { e.preventDefault(); last?.focus(); }
                else if (!e.shiftKey && (document.activeElement === last || document.activeElement === drawer)) { e.preventDefault(); first?.focus(); }
            }
            return;
        }
        // Top-level navigation shortcuts, with legacy tool shortcuts retained.
        if (!isEditing && !e.ctrlKey && !e.metaKey && !e.altKey && e.key >= '1' && e.key <= '6') {
            const tabMap = {
                '1': 'tab-audiophile',
                '2': 'tab-library',
                '3': 'tab-tools',
                '4': 'tab-navidrome',
                '5': 'tab-duplicates',
                '6': 'tab-navidrome'
            };
            if (tabMap[e.key]) {
                e.preventDefault();
                switchTab(tabMap[e.key]);
                return;
            }
        }

        // Sidebar toggle shortcut: Ctrl+B or '['
        if (((e.ctrlKey && e.key.toLowerCase() === 'b') || (!isEditing && e.key === '['))) {
            e.preventDefault();
            document.getElementById('sidebar-toggle')?.click();
            return;
        }

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
            const searchInput = document.getElementById('track-search-input');
            if (searchInput) {
                if (currentTab !== 'tab-library') switchTab('tab-library');
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
