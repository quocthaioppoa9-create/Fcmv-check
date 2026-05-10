// ═══════════════════════════════════════════════════
//  FC MOBILE VN CHECKER - Frontend Application
// ═══════════════════════════════════════════════════

// ── Socket.IO Connection ──
const socket = io();
let sessionId = null;
let accounts = [];
let isRunning = false;

// ══════════════════════════════════════════════
//  SOCKET EVENT HANDLERS
// ══════════════════════════════════════════════

socket.on('connect', () => {
    updateConnectionStatus(true);
    addLog('Đã kết nối tới server', 'success');
});

socket.on('disconnect', () => {
    updateConnectionStatus(false);
    addLog('Mất kết nối server', 'error');
});

// Session tạo thành công
socket.on('session_created', (data) => {
    sessionId = data.sessionId;
    isRunning = true;
    accounts = [];

    document.getElementById('inputPanel').classList.add('hidden');
    document.getElementById('progressPanel').classList.remove('hidden');
    document.getElementById('btnStart').disabled = true;

    addLog(`Phiên ${data.sessionId}: ${data.accountCount} tài khoản, ${data.proxyCount} proxy`, 'info');
});

// Cập nhật tiến trình
socket.on('progress', (data) => {
    document.getElementById('statCurrent').textContent = `${data.current}/${data.total}`;
    document.getElementById('progressBar').style.width = `${data.percent}%`;
    document.getElementById('progressText').textContent = `${data.percent}%`;
    document.getElementById('currentAccName').textContent = maskUsername(data.currentAccount);
    document.getElementById('statTime').textContent = formatTime(data.remaining);
});

// Cập nhật trạng thái tài khoản
socket.on('status_update', (data) => {
    const acc = data.account;
    updateAccountInTable(acc);

    document.getElementById('currentAccStatus').textContent = getStatusLabel(acc.status);
    document.getElementById('currentAccStatus').className = `status-badge ${acc.status}`;

    // Hiện captcha panel nếu cần
    if (acc.status === 'captcha') {
        document.getElementById('captchaPanel').classList.remove('hidden');
    } else {
        document.getElementById('captchaPanel').classList.add('hidden');
    }
});

// Account hoàn thành
socket.on('account_done', (data) => {
    const acc = data.account;

    // Thêm hoặc cập nhật trong mảng local
    const existIdx = accounts.findIndex(a => a.id === acc.id);
    if (existIdx >= 0) {
        accounts[existIdx] = acc;
    } else {
        accounts.push(acc);
    }

    updateAccountInTable(acc);
    updateStats();
});

// Screenshot
socket.on('screenshot', (data) => {
    const img = document.getElementById('screenshotImage');
    const placeholder = document.getElementById('screenshotPlaceholder');
    img.src = data.image;
    img.classList.add('visible');
    placeholder.style.display = 'none';
    document.getElementById('screenshotLabel').textContent = data.label || '';
});

// Captcha xuất hiện
socket.on('captcha_required', (data) => {
    document.getElementById('captchaPanel').classList.remove('hidden');
    document.getElementById('captchaImage').src = data.screenshot;
    document.getElementById('captchaLoading').style.display = 'none';
    document.getElementById('captchaAnswer').value = '';
    document.getElementById('captchaAnswer').focus();

    addLog(`🔐 CAPTCHA! Xem ảnh và giải captcha trên giao diện`, 'captcha');

    // Bắt đầu đếm ngược
    startCaptchaTimer(300);
});

// Captcha update
socket.on('captcha_update', (data) => {
    document.getElementById('captchaImage').src = data.screenshot;
    document.getElementById('captchaTimer').textContent = `${data.remaining}s`;
});

// Log message
socket.on('log', (data) => {
    addLog(data.message, data.type);
});

// Bắt đầu chạy
socket.on('started', (data) => {
    addLog(`🚀 Bắt đầu: ${data.total} tài khoản, ${data.proxyCount} proxy`, 'info');
});

// Hoàn thành tất cả
socket.on('all_done', (data) => {
    isRunning = false;
    sessionId = data.sessionId;

    document.getElementById('btnStart').disabled = false;
    document.getElementById('inputPanel').classList.remove('hidden');
    document.getElementById('captchaPanel').classList.add('hidden');
    document.getElementById('btnDownload').classList.remove('hidden');
    document.getElementById('btnStop').disabled = true;

    accounts = data.accounts;
    rebuildTable(accounts);
    updateStats();

    const success = accounts.filter(a => a.status === 'done').length;
    const fail = accounts.filter(a => a.status === 'error').length;

    addLog(`🏁 HOÀN THÀNH: ${success} thành công, ${fail} thất bại`, 'success');
    addLog(`📥 Tải kết quả: ${data.downloadUrl}`, 'info');
});

// Lỗi
socket.on('error', (data) => {
    addLog(`❌ Lỗi: ${data.message}`, 'error');
    isRunning = false;
    document.getElementById('btnStart').disabled = false;
});

// ══════════════════════════════════════════════
//  USER ACTIONS
// ══════════════════════════════════════════════

function startCheck() {
    const accountText = document.getElementById('accountInput').value.trim();
    const proxyText = document.getElementById('proxyInput').value.trim();

    if (!accountText) {
        addLog('Vui lòng nhập danh sách tài khoản!', 'error');
        return;
    }

    // Gửi lên server
    socket.emit('start_check', { accountText, proxyText });

    document.getElementById('btnStart').disabled = true;
    document.getElementById('btnStop').disabled = false;
    addLog('Đang gửi yêu cầu...', 'info');
}

function stopCheck() {
    socket.emit('stop_check');
    document.getElementById('btnStop').disabled = true;
    addLog('Đang dừng...', 'warning');
}

function submitCaptcha() {
    const answer = document.getElementById('captchaAnswer').value.trim();
    if (answer) {
        socket.emit('captcha_answer', { answer });
        addLog(`Đã gửi đáp án captcha: ${answer}`, 'info');
    }
}

function previewAccounts() {
    const accountText = document.getElementById('accountInput').value.trim();
    if (!accountText) {
        addLog('Chưa nhập tài khoản', 'warning');
        return;
    }

    fetch('/api/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            accountText,
            proxyText: document.getElementById('proxyInput').value
        })
    })
        .then(r => r.json())
        .then(data => {
            document.getElementById('accountCount').textContent = `${data.accountCount} tài khoản`;
            document.getElementById('proxyCount').textContent = `${data.proxyCount} proxy`;

            const est = data.accountCount * 120;
            document.getElementById('estimatedTime').textContent =
                `⏱ Thời gian ước tính: ${formatTime(est)}`;

            addLog(`Tìm thấy ${data.accountCount} tài khoản, ${data.proxyCount} proxy`, 'success');

            // Preview vào bảng
            const tbody = document.getElementById('resultBody');
            tbody.innerHTML = '';
            data.accounts.forEach((acc, i) => {
                const tr = document.createElement('tr');
                tr.id = `row-${acc.username}`;
                tr.innerHTML = `
                    <td>${i + 1}</td>
                    <td>${acc.masked}</td>
                    <td>-</td><td>-</td><td>-</td><td>-</td><td>-</td>
                    <td><span class="status-badge waiting">Chờ xử lý</span></td>
                `;
                tbody.appendChild(tr);
            });
        })
        .catch(err => addLog(`Lỗi: ${err.message}`, 'error'));
}

function downloadResult() {
    if (sessionId) {
        window.open(`/api/download/${sessionId}`, '_blank');
    }
}

function clearInput(id) {
    document.getElementById(id).value = '';
}

function clearLog() {
    document.getElementById('logContainer').innerHTML = '';
}

// ══════════════════════════════════════════════
//  UI UPDATE FUNCTIONS
// ══════════════════════════════════════════════

function updateConnectionStatus(connected) {
    const el = document.getElementById('connectionStatus');
    if (connected) {
        el.innerHTML = '<span class="status-dot online"></span><span>Đã kết nối</span>';
    } else {
        el.innerHTML = '<span class="status-dot offline"></span><span>Mất kết nối</span>';
    }
}

function addLog(message, type = 'info') {
    const container = document.getElementById('logContainer');
    const time = new Date().toLocaleTimeString('vi-VN');

    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.innerHTML = `
        <span class="log-time">${time}</span>
        <span class="log-msg">${escapeHtml(message)}</span>
    `;

    container.appendChild(entry);
    container.scrollTop = container.scrollHeight;

    // Giới hạn 200 dòng log
    while (container.children.length > 200) {
        container.removeChild(container.firstChild);
    }
}

function updateAccountInTable(acc) {
    const tbody = document.getElementById('resultBody');

    // Xóa empty row
    const emptyRow = tbody.querySelector('.empty-row');
    if (emptyRow) emptyRow.remove();

    let row = document.getElementById(`row-${acc.id}`);

    if (!row) {
        row = document.createElement('tr');
        row.id = `row-${acc.id}`;
        tbody.appendChild(row);
    }

    const idx = Array.from(tbody.children).indexOf(row) + 1;

    row.innerHTML = `
        <td>${idx}</td>
        <td>${maskUsername(acc.username)}</td>
        <td class="${getOvrClass(acc.ovr)}">${acc.ovr}</td>
        <td>${acc.gem}</td>
        <td>${acc.coin}</td>
        <td>${acc.maxPlayer}</td>
        <td>${acc.fv}</td>
        <td><span class="status-badge ${acc.status}">${acc.statusText}</span></td>
    `;
}

function rebuildTable(accounts) {
    const tbody = document.getElementById('resultBody');
    tbody.innerHTML = '';

    if (accounts.length === 0) {
        tbody.innerHTML = '<tr class="empty-row"><td colspan="8">Chưa có dữ liệu</td></tr>';
        return;
    }

    accounts.forEach((acc, i) => {
        const row = document.createElement('tr');
        row.id = `row-${acc.id}`;
        row.innerHTML = `
            <td>${i + 1}</td>
            <td>${maskUsername(acc.username)}</td>
            <td class="${getOvrClass(acc.ovr)}">${acc.ovr}</td>
            <td>${acc.gem}</td>
            <td>${acc.coin}</td>
            <td>${acc.maxPlayer}</td>
            <td>${acc.fv}</td>
            <td><span class="status-badge ${acc.status}">${acc.statusText}</span></td>
        `;
        tbody.appendChild(row);
    });
}

function updateStats() {
    const success = accounts.filter(a => a.status === 'done').length;
    const fail = accounts.filter(a => a.status === 'error').length;
    document.getElementById('statSuccess').textContent = success;
    document.getElementById('statFail').textContent = fail;
}

// ══════════════════════════════════════════════
//  CAPTCHA TIMER
// ══════════════════════════════════════════════

let captchaInterval = null;

function startCaptchaTimer(seconds) {
    if (captchaInterval) clearInterval(captchaInterval);

    let remaining = seconds;
    document.getElementById('captchaTimer').textContent = `${remaining}s`;

    captchaInterval = setInterval(() => {
        remaining--;
        document.getElementById('captchaTimer').textContent = `${remaining}s`;

        if (remaining <= 0) {
            clearInterval(captchaInterval);
        }
    }, 1000);
}

// ══════════════════════════════════════════════
//  HELPER FUNCTIONS
// ══════════════════════════════════════════════

function maskUsername(username) {
    if (!username || username.length <= 3) return username || '';
    return username.substring(0, 3) + '*'.repeat(Math.min(username.length - 3, 5));
}

function formatTime(seconds) {
    if (!seconds || seconds < 0) return '--';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function getOvrClass(ovr) {
    const num = parseInt(ovr);
    if (isNaN(num)) return '';
    if (num >= 115) return 'ovr-high';
    if (num >= 100) return 'ovr-mid';
    return 'ovr-low';
}

function getStatusLabel(status) {
    const labels = {
        'waiting': 'Chờ xử lý',
        'logging_in': 'Đang đăng nhập',
        'captcha': '🔐 Captcha!',
        'scraping': 'Lấy dữ liệu',
        'done': '✅ Xong',
        'error': '❌ Lỗi'
    };
    return labels[status] || status;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ══════════════════════════════════════════════
//  AUTO-UPDATE ACCOUNT COUNT ON INPUT
// ══════════════════════════════════════════════

document.getElementById('accountInput').addEventListener('input', function () {
    const lines = this.value.split('\n').filter(l => {
        const t = l.trim();
        return t.length > 0 && !t.startsWith('#') && (t.includes(':') || t.includes('|'));
    });
    document.getElementById('accountCount').textContent = `${lines.length} tài khoản`;

    const est = lines.length * 120;
    document.getElementById('estimatedTime').textContent =
        `⏱ Thời gian ước tính: ${formatTime(est)}`;
});

document.getElementById('proxyInput').addEventListener('input', function () {
    const lines = this.value.split('\n').filter(l => {
        const t = l.trim();
        return t.length > 0 && !t.startsWith('#');
    });
    document.getElementById('proxyCount').textContent = `${lines.length} proxy`;
});

// Enter gửi captcha
document.getElementById('captchaAnswer').addEventListener('keypress', function (e) {
    if (e.key === 'Enter') submitCaptcha();
});

console.log('⚽ FC Mobile VN Checker loaded');
