const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const { parseAccounts, parseProxies, saveResults } = require('./utils');
const AccountChecker = require('./checker');

// ══════════════════════════════════════════════
//  SERVER SETUP
// ══════════════════════════════════════════════

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' },
    maxHttpBufferSize: 5e6   // 5MB cho screenshot
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Lưu trữ sessions đang chạy
const activeSessions = new Map();

// ══════════════════════════════════════════════
//  API ROUTES
// ══════════════════════════════════════════════

// Trang chủ
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API parse tài khoản (preview)
app.post('/api/parse', (req, res) => {
    const { accountText, proxyText } = req.body;
    const accounts = parseAccounts(accountText || '');
    const proxies = parseProxies(proxyText || '');
    res.json({
        success: true,
        accountCount: accounts.length,
        proxyCount: proxies.length,
        accounts: accounts.map(a => ({
            username: a.username,
            masked: a.username.substring(0, 3) + '***'
        }))
    });
});

// API tải kết quả
app.get('/api/download/:sessionId', (req, res) => {
    const filePath = path.join(__dirname, 'results', `result_${req.params.sessionId}.txt`);
    const fs = require('fs');
    if (fs.existsSync(filePath)) {
        res.download(filePath);
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

// ══════════════════════════════════════════════
//  SOCKET.IO - REAL-TIME COMMUNICATION
// ══════════════════════════════════════════════

io.on('connection', (socket) => {
    console.log(`[+] Client connected: ${socket.id}`);

    // ── Bắt đầu check ──
    socket.on('start_check', async (data) => {
        const { accountText, proxyText } = data;

        const accounts = parseAccounts(accountText || '');
        const proxies = parseProxies(proxyText || '');

        if (accounts.length === 0) {
            socket.emit('error', { message: 'Không tìm thấy tài khoản hợp lệ!' });
            return;
        }

        const sessionId = uuidv4().substring(0, 8);
        const checker = new AccountChecker(io, socket.id, sessionId);

        activeSessions.set(socket.id, { checker, sessionId, accounts });

        socket.emit('session_created', {
            sessionId,
            accountCount: accounts.length,
            proxyCount: proxies.length,
            estimatedTime: accounts.length * 120
        });

        socket.emit('log', {
            message: `Phiên ${sessionId}: Bắt đầu check ${accounts.length} tài khoản...`,
            type: 'info'
        });

        // Chạy checker (async)
        try {
            const results = await checker.processAccounts(accounts, proxies);
            const filePath = saveResults(results, sessionId);

            socket.emit('all_done', {
                sessionId,
                accounts: results,
                downloadUrl: `/api/download/${sessionId}`
            });
        } catch (error) {
            socket.emit('error', { message: error.message });
        }
    });

    // ── Dừng check ──
    socket.on('stop_check', () => {
        const session = activeSessions.get(socket.id);
        if (session) {
            session.checker.stop();
            socket.emit('log', { message: 'Đang dừng...', type: 'warning' });
        }
    });

    // ── Nhận đáp án captcha từ client ──
    socket.on('captcha_answer', async (data) => {
        const session = activeSessions.get(socket.id);
        if (session && session.checker.page) {
            // Tìm captcha handler và submit
            try {
                const CaptchaHandler = require('./captcha-handler');
                const handler = new CaptchaHandler(io, socket.id);
                await handler.submitCaptchaAnswer(session.checker.page, data.answer);
            } catch (e) {
                socket.emit('log', { message: `Lỗi nhập captcha: ${e.message}`, type: 'error' });
            }
        }
    });

    // ── Client ngắt kết nối ──
    socket.on('disconnect', () => {
        console.log(`[-] Client disconnected: ${socket.id}`);
        const session = activeSessions.get(socket.id);
        if (session) {
            session.checker.stop();
            session.checker.closeBrowser();
            activeSessions.delete(socket.id);
        }
    });
});

// ══════════════════════════════════════════════
//  START SERVER
// ══════════════════════════════════════════════

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log('═'.repeat(50));
    console.log('  FC MOBILE VN - ACCOUNT CHECKER');
    console.log('═'.repeat(50));
    console.log(`  🌐 Server:  http://localhost:${PORT}`);
    console.log(`  📅 Started: ${new Date().toLocaleString('vi-VN')}`);
    console.log('═'.repeat(50));
});
