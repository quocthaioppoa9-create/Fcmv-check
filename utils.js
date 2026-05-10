const fs = require('fs');
const path = require('path');

// ══════════════════════════════════════════════
//  PARSE TÀI KHOẢN - Hỗ trợ nhiều định dạng
// ══════════════════════════════════════════════

function parseAccounts(rawText) {
    const accounts = [];
    if (!rawText) return accounts;

    const lines = rawText
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith('#') && !l.startsWith('//'));

    for (const line of lines) {
        let username = '';
        let password = '';

        // Định dạng: https://100054.connect.garena.com:user:pass
        const garenaRegex = /https?:\/\/[^:]+\.(?:connect\.)?garena\.com[^:]*:([^:]+):(.+)/i;
        const garenaMatch = line.match(garenaRegex);

        if (garenaMatch) {
            username = garenaMatch[1].trim();
            password = garenaMatch[2].trim();
        }
        // Định dạng: bất kỳ URL garena nào có :user:pass ở cuối
        else if (line.toLowerCase().includes('garena')) {
            const parts = line.split(':');
            if (parts.length >= 4) {
                password = parts[parts.length - 1].trim();
                username = parts[parts.length - 2].trim();
            }
        }
        // Định dạng: user:pass
        else if (line.includes(':')) {
            const idx = line.indexOf(':');
            username = line.substring(0, idx).trim();
            password = line.substring(idx + 1).trim();
        }
        // Định dạng: user|pass
        else if (line.includes('|')) {
            const parts = line.split('|');
            username = parts[0].trim();
            password = parts[1].trim();
        }
        // Định dạng: user<tab>pass
        else if (line.includes('\t')) {
            const parts = line.split('\t');
            username = parts[0].trim();
            password = parts[1].trim();
        }

        if (username && password) {
            accounts.push({
                id: `acc_${accounts.length + 1}`,
                username,
                password,
                status: 'waiting',         // waiting, logging_in, captcha, scraping, done, error
                statusText: 'Chờ xử lý',
                ovr: '-',
                gem: '-',
                coin: '-',
                maxPlayer: '-',
                fv: '-',
                error: null
            });
        }
    }

    return accounts;
}

// ══════════════════════════════════════════════
//  PARSE PROXY
// ══════════════════════════════════════════════

function parseProxies(rawText) {
    const proxies = [];
    if (!rawText) return proxies;

    const lines = rawText
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith('#'));

    for (const line of lines) {
        let proxy = { host: '', port: '', username: '', password: '' };

        // http://user:pass@ip:port
        const urlAuth = /https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)/;
        const m1 = line.match(urlAuth);
        if (m1) {
            proxy = { username: m1[1], password: m1[2], host: m1[3], port: m1[4] };
        }
        // http://ip:port
        else if (line.startsWith('http')) {
            const clean = line.replace(/https?:\/\//, '');
            const parts = clean.split(':');
            proxy.host = parts[0];
            proxy.port = parts[1] || '80';
        }
        // ip:port:user:pass
        else {
            const parts = line.split(':');
            proxy.host = parts[0];
            proxy.port = parts[1] || '80';
            if (parts.length >= 4) {
                proxy.username = parts[2];
                proxy.password = parts[3];
            }
        }

        if (proxy.host && proxy.port) {
            proxies.push(proxy);
        }
    }

    return proxies;
}

// ══════════════════════════════════════════════
//  LƯU KẾT QUẢ
// ══════════════════════════════════════════════

function saveResults(accounts, sessionId) {
    const dir = path.join(__dirname, 'results');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const filePath = path.join(dir, `result_${sessionId}.txt`);
    const time = new Date().toLocaleString('vi-VN');

    let content = '';
    content += '═'.repeat(100) + '\n';
    content += `  FC MOBILE VN - KẾT QUẢ CHECK - ${time}\n`;
    content += '═'.repeat(100) + '\n\n';

    content += padRight('STT', 5) + '│ ' +
        padRight('Tài khoản', 20) + '│ ' +
        padRight('OVR', 8) + '│ ' +
        padRight('Gem', 12) + '│ ' +
        padRight('Coin', 12) + '│ ' +
        padRight('Max Player', 20) + '│ ' +
        padRight('FV', 10) + '│ ' +
        'Trạng thái\n';
    content += '─'.repeat(100) + '\n';

    accounts.forEach((acc, i) => {
        content += padRight(String(i + 1), 5) + '│ ' +
            padRight(acc.username, 20) + '│ ' +
            padRight(String(acc.ovr), 8) + '│ ' +
            padRight(String(acc.gem), 12) + '│ ' +
            padRight(String(acc.coin), 12) + '│ ' +
            padRight(String(acc.maxPlayer), 20) + '│ ' +
            padRight(String(acc.fv), 10) + '│ ' +
            acc.statusText + '\n';
    });

    content += '═'.repeat(100) + '\n';

    const success = accounts.filter(a => a.status === 'done').length;
    const fail = accounts.filter(a => a.status === 'error').length;
    content += `\nTổng: ${accounts.length} | Thành công: ${success} | Thất bại: ${fail}\n`;

    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
}

function appendResult(account, sessionId) {
    const dir = path.join(__dirname, 'results');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const filePath = path.join(dir, `result_${sessionId}_live.txt`);
    const time = new Date().toLocaleTimeString('vi-VN');

    const line = `[${time}] ${account.username} | OVR: ${account.ovr} | ` +
        `Gem: ${account.gem} | Coin: ${account.coin} | ` +
        `Max: ${account.maxPlayer} | FV: ${account.fv} | ${account.statusText}\n`;

    fs.appendFileSync(filePath, line, 'utf8');
}

function padRight(str, len) {
    if (str.length >= len) return str.substring(0, len);
    return str + ' '.repeat(len - str.length);
}

function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function maskUser(username) {
    if (!username || username.length <= 3) return username || '';
    return username.substring(0, 3) + '*'.repeat(Math.min(username.length - 3, 5));
}

module.exports = {
    parseAccounts,
    parseProxies,
    saveResults,
    appendResult,
    delay,
    maskUser
};
