const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { delay, appendResult } = require('./utils');
const CaptchaHandler = require('./captcha-handler');

puppeteer.use(StealthPlugin());

const GARENA_LOGIN_URL = 'https://account.garena.com/';
const FC_MOBILE_URL = 'https://fcmobile.garena.vn/';

class AccountChecker {
    constructor(io, socketId, sessionId) {
        this.io = io;
        this.socketId = socketId;
        this.sessionId = sessionId;
        this.browser = null;
        this.page = null;
        this.isRunning = false;
        this.shouldStop = false;
        this.processedCount = 0;
        this.totalAccounts = 0;
        this.startTime = null;
    }

    async launchBrowser(proxy = null) {
        const args = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--single-process',
            '--no-zygote',
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars',
            '--window-size=1280,800',
            '--lang=vi-VN',
        ];

        if (proxy) {
            args.push(`--proxy-server=http://${proxy.host}:${proxy.port}`);
        }

        this.browser = await puppeteer.launch({
            headless: 'new',
            args,
            defaultViewport: { width: 1280, height: 800 },
            ignoreHTTPSErrors: true,
        });

        this.page = (await this.browser.pages())[0] || await this.browser.newPage();

        if (proxy && proxy.username) {
            await this.page.authenticate({
                username: proxy.username,
                password: proxy.password
            });
        }

        await this.setupPage();
    }

    async setupPage() {
        const page = this.page;

        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        await page.setExtraHTTPHeaders({
            'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7'
        });

        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['vi-VN', 'vi', 'en-US', 'en'] });
            Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });

            window.chrome = { runtime: {}, loadTimes: () => { }, csi: () => { }, app: {} };

            const origQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (params) =>
                params.name === 'notifications'
                    ? Promise.resolve({ state: Notification.permission })
                    : origQuery(params);
        });

        page.on('pageerror', () => {});
        page.on('error', () => {});

        page.setDefaultNavigationTimeout(30000);
        page.setDefaultTimeout(15000);
    }

    async processAccounts(accounts, proxies = []) {
        this.isRunning = true;
        this.shouldStop = false;
        this.totalAccounts = accounts.length;
        this.processedCount = 0;
        this.startTime = Date.now();

        this.emit('started', {
            total: accounts.length,
            proxyCount: proxies.length
        });

        try {
            const proxy = proxies.length > 0 ? proxies[0] : null;
            await this.launchBrowser(proxy);

            for (let i = 0; i < accounts.length; i++) {
                if (this.shouldStop) {
                    this.emit('log', { message: 'Đã dừng bởi người dùng', type: 'warning' });
                    break;
                }

                const account = accounts[i];
                this.processedCount = i;
                this.emitProgress(account, i);

                try {
                    await this.processOneAccount(account);
                } catch (err) {
                    account.status = 'error';
                    account.statusText = `❌ Lỗi: ${err.message}`;
                    account.error = err.message;
                    this.emit('log', {
                        message: `Lỗi acc ${account.username}: ${err.message}`,
                        type: 'error'
                    });
                }

                this.emit('account_done', { account, index: i });
                appendResult(account, this.sessionId);

                await this.logout();
                if (i < accounts.length - 1) {
                    const waitMs = 3000 + Math.random() * 5000;
                    this.emit('log', {
                        message: `Chờ ${(waitMs / 1000).toFixed(1)}s...`,
                        type: 'info'
                    });
                    await delay(waitMs);
                }
            }

        } catch (error) {
            this.emit('log', {
                message: `Lỗi nghiêm trọng: ${error.message}`,
                type: 'error'
            });
        } finally {
            await this.closeBrowser();
            this.isRunning = false;
            this.processedCount = accounts.length;

            this.emit('finished', {
                accounts,
                elapsed: Date.now() - this.startTime
            });
        }

        return accounts;
    }

    async processOneAccount(account) {
        account.status = 'logging_in';
        account.statusText = '🔑 Đang đăng nhập...';
        this.emit('status_update', { account });

        const loginResult = await this.login(account);

        if (!loginResult.success) {
            account.status = 'error';
            switch (loginResult.error) {
                case 'wrong_password':
                    account.statusText = '❌ Sai mật khẩu';
                    break;
                case 'locked':
                    account.statusText = '🔒 Tài khoản bị khóa';
                    break;
                case 'timeout':
                    account.statusText = '⏰ Hết thời gian chờ Captcha';
                    break;
                case 'captcha_failed':
                    account.statusText = '❌ Không giải được Captcha';
                    break;
                default:
                    account.statusText = `❌ ${loginResult.error}`;
            }
            this.emit('status_update', { account });
            return;
        }

        account.status = 'scraping';
        account.statusText = '📊 Đang lấy dữ liệu FC Mobile...';
        this.emit('status_update', { account });

        const data = await this.scrapeData();
        account.ovr = data.ovr || '-';
        account.gem = data.gem || '-';
        account.coin = data.coin || '-';
        account.maxPlayer = data.maxPlayer || '-';
        account.fv = data.fv || '-';

        account.status = 'done';
        account.statusText = '✅ Hoàn thành';
        this.emit('status_update', { account });

        this.emit('log', {
            message: `✅ ${account.username} | OVR: ${account.ovr} | Gem: ${account.gem} | Coin: ${account.coin}`,
            type: 'success'
        });
    }

    async login(account) {
        const page = this.page;

        try {
            await page.goto(GARENA_LOGIN_URL, {
                waitUntil: 'networkidle2',
                timeout: 30000
            });
            await delay(2000);

            await this.sendScreenshot('Trang đăng nhập đã mở');

            const usernameField = await this.findElement([
                'input[name="username"]',
                'input#username',
                'input[type="text"]:not([name="captcha"])',
                'input[placeholder*="tài khoản"]',
                'input[placeholder*="username"]',
                'input[placeholder*="Tên đăng nhập"]',
                'input[placeholder*="Phone"]',
                'input[autocomplete="username"]'
            ]);

            if (!usernameField) {
                return { success: false, error: 'Không tìm thấy ô nhập tài khoản' };
            }

            await usernameField.click({ clickCount: 3 });
            await delay(300);
            await this.typeHuman(usernameField, account.username);
            await delay(500);

            const passwordField = await this.findElement([
                'input[name="password"]',
                'input#password',
                'input[type="password"]'
            ]);

            if (!passwordField) {
                return { success: false, error: 'Không tìm thấy ô nhập mật khẩu' };
            }

            await passwordField.click({ clickCount: 3 });
            await delay(300);
            await this.typeHuman(passwordField, account.password);
            await delay(800);

            const loginBtn = await this.findElement([
                'button[type="submit"]',
                '#btn-login',
                'button.btn-primary',
                'button.login-btn',
                'input[type="submit"]',
                'button:not([disabled])'
            ]);

            if (loginBtn) {
                await loginBtn.click();
            } else {
                await passwordField.press('Enter');
            }

            await delay(3000);
            await this.sendScreenshot('Sau khi nhấn đăng nhập');

            return await this.checkLoginResult(account);

        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async checkLoginResult(account) {
        const page = this.page;
        const maxWait = 300000;
        let elapsed = 0;
        let captchaHandled = false;

        while (elapsed < maxWait) {
            if (this.shouldStop) {
                return { success: false, error: 'stopped' };
            }

            const url = page.url();

            if (!url.includes('sso.garena.com') && !url.includes('/login')) {
                return { success: true };
            }

            const errorMsg = await page.evaluate(() => {
                const els = document.querySelectorAll(
                    '.error-message, .alert-danger, .error, [class*="error"], .toast-error, .notice-error'
                );
                for (const el of els) {
                    const t = (el.textContent || '').toLowerCase();
                    if (t.includes('sai') || t.includes('wrong') || t.includes('incorrect') ||
                        t.includes('invalid') || t.includes('không đúng') || t.includes('fail')) {
                        return el.textContent.trim();
                    }
                }
                return null;
            });

            if (errorMsg) {
                return { success: false, error: 'wrong_password', detail: errorMsg };
            }

            const isLocked = await page.evaluate(() => {
                const t = document.body.textContent.toLowerCase();
                if (t.includes('captcha') || t.includes('trượt') || t.includes('verify') ||
                    t.includes('xác minh') || t.includes('quyền truy cập') || t.includes('slide')) {
                    return false;
                }
                return (t.includes('tài khoản đã bị khóa') ||
                        t.includes('account is locked') ||
                        t.includes('account suspended') ||
                        t.includes('account banned'));
            });

            if (isLocked) {
                return { success: false, error: 'locked' };
            }

            const hasCaptcha = await page.evaluate(() => {
                const indicators = [
                    '.geetest_holder', '.geetest_panel', '.geetest_popup_wrap',
                    '.geetest_widget', '.geetest_btn',
                    'iframe[src*="recaptcha"]', '.g-recaptcha',
                    'iframe[src*="hcaptcha"]',
                    '.captcha-container', '.captcha-wrapper',
                    'img[src*="captcha"]',
                    '.slide-captcha', '.captcha-slider',
                    '[class*="captcha"]', '[id*="captcha"]',
                    '[class*="slider"]', '[class*="verify"]'
                ];
                for (const sel of indicators) {
                    const el = document.querySelector(sel);
                    if (el && el.offsetParent !== null) return true;
                }
                const iframes = document.querySelectorAll('iframe');
                for (const f of iframes) {
                    if ((f.src || '').match(/captcha|challenge|geetest|recaptcha/i)) return true;
                }
                const bodyText = document.body.textContent.toLowerCase();
                if (bodyText.includes('trượt sang phải') ||
                    bodyText.includes('slide to verify') ||
                    bodyText.includes('drag the slider') ||
                    bodyText.includes('xác minh') ||
                    bodyText.includes('quyền truy cập của bạn')) {
                    return true;
                }
                return false;
            });

            if (hasCaptcha && !captchaHandled) {
                captchaHandled = true;

                account.status = 'captcha';
                account.statusText = '🔐 Chờ giải Captcha...';
                this.emit('status_update', { account });

                this.emit('log', {
                    message: `🔐 CAPTCHA xuất hiện cho ${account.username}! Xem ảnh trên giao diện web.`,
                    type: 'captcha'
                });

                const captchaHandler = new CaptchaHandler(this.io, this.socketId);
                const captchaResult = await captchaHandler.waitForCaptchaSolution(page, account.id);

                if (captchaResult.success) {
                    this.emit('log', {
                        message: `✅ Captcha đã được giải (${captchaResult.method})`,
                        type: 'success'
                    });
                } else {
                    return { success: false, error: 'captcha_failed' };
                }
            }

            if (captchaHandled && elapsed % 10000 < 2000) {
                const remain = Math.floor((maxWait - elapsed) / 1000);
                account.statusText = `🔐 Chờ giải Captcha... (${remain}s)`;
                this.emit('status_update', { account });
            }

            await delay(2000);
            elapsed += 2000;
        }

        return { success: false, error: 'timeout' };
    }

    async scrapeData() {
        const page = this.page;
        const data = { ovr: '-', gem: '-', coin: '-', maxPlayer: '-', fv: '-' };

        try {
            this.emit('log', { message: 'Truy cập FC Mobile VN...', type: 'info' });

            await page.goto(FC_MOBILE_URL, {
                waitUntil: 'networkidle2',
                timeout: 20000
            });
            await delay(3000);

            await this.sendScreenshot('Trang FC Mobile');

            const scraped = await page.evaluate(() => {
                const result = {};

                const findValue = (labels) => {
                    for (const label of labels) {
                        const allElements = document.querySelectorAll('*');
                        for (const el of allElements) {
                            const text = (el.textContent || '').trim();
                            if (text.toLowerCase().includes(label.toLowerCase())) {
                                const nums = text.replace(/,/g, '').match(/\d+/g);
                                if (nums) {
                                    const filtered = nums.filter(n => parseInt(n) > 0);
                                    if (filtered.length > 0) return filtered[filtered.length - 1];
                                }
                                const next = el.nextElementSibling;
                                if (next) {
                                    const nextNums = (next.textContent || '').replace(/,/g, '').match(/\d+/g);
                                    if (nextNums) return nextNums[0];
                                }
                            }
                        }
                    }
                    return null;
                };

                result.ovr = findValue(['OVR', 'Overall', 'Đội hình', 'Team OVR']) || '-';
                result.gem = findValue(['Gem', 'Diamond', 'FIFA Point', 'FC Point']) || '-';
                result.coin = findValue(['Coin', 'Gold', 'Tiền']) || '-';
                result.fv = findValue(['FV', 'Face Value', 'FIFA Value']) || '-';

                const playerCards = document.querySelectorAll('[class*="player"], [class*="card"], .item');
                let maxOvr = 0;
                let maxName = '-';

                playerCards.forEach(card => {
                    const cardText = card.textContent || '';
                    const nums = cardText.match(/\d+/g);
                    const nameMatch = cardText.match(/[A-Z][a-z]+(?:\s[A-Z][a-z]+)*/);

                    if (nums) {
                        nums.forEach(n => {
                            const val = parseInt(n);
                            if (val > 60 && val < 200 && val > maxOvr) {
                                maxOvr = val;
                                maxName = nameMatch ? nameMatch[0] : `Player ${val}`;
                            }
                        });
                    }
                });

                result.maxPlayer = maxOvr > 0 ? `${maxName} (${maxOvr})` : '-';
                return result;
            });

            Object.assign(data, scraped);

        } catch (error) {
            this.emit('log', {
                message: `Lỗi scrape: ${error.message}`,
                type: 'warning'
            });
        }

        return data;
    }

    async logout() {
        try {
            const page = this.page;

            await page.goto('https://account.garena.com/api/logout', {
                waitUntil: 'networkidle2',
                timeout: 10000
            }).catch(() => { });

            const cookies = await page.cookies();
            if (cookies.length > 0) await page.deleteCookie(...cookies);

            await page.evaluate(() => {
                try { localStorage.clear(); } catch (e) { }
                try { sessionStorage.clear(); } catch (e) { }
            });

            await delay(1000);

        } catch (e) {
            try {
                const cookies = await this.page.cookies();
                if (cookies.length > 0) await this.page.deleteCookie(...cookies);
            } catch (e2) { }
        }
    }

    async findElement(selectors, timeout = 10000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            for (const sel of selectors) {
                try {
                    const el = await this.page.$(sel);
                    if (el) {
                        const visible = await this.page.evaluate(e => {
                            const s = window.getComputedStyle(e);
                            return s.display !== 'none' && s.visibility !== 'hidden' && e.offsetParent !== null;
                        }, el);
                        if (visible) return el;
                    }
                } catch (e) { }
            }
            await delay(500);
        }
        return null;
    }

    async typeHuman(element, text) {
        for (const char of text) {
            await element.type(char, { delay: 30 + Math.random() * 100 });
            if (Math.random() < 0.1) await delay(200 + Math.random() * 300);
        }
    }

    async sendScreenshot(label = '') {
        try {
            const buf = await this.page.screenshot({ encoding: 'base64', fullPage: false });
            this.io.to(this.socketId).emit('screenshot', {
                image: `data:image/png;base64,${buf}`,
                label,
                timestamp: Date.now()
            });
        } catch (e) { }
    }

    emitProgress(account, index) {
        const elapsed = (Date.now() - this.startTime) / 1000;
        const avgTime = elapsed / Math.max(index, 1);
        const remaining = avgTime * (this.totalAccounts - index);
        const percent = Math.round((index / this.totalAccounts) * 100);

        this.emit('progress', {
            current: index + 1,
            total: this.totalAccounts,
            percent,
            currentAccount: account.username,
            elapsed: Math.floor(elapsed),
            remaining: Math.floor(remaining),
            avgTime: Math.floor(avgTime)
        });
    }

    emit(event, data) {
        this.io.to(this.socketId).emit(event, data);
    }

    stop() {
        this.shouldStop = true;
    }

    async closeBrowser() {
        try {
            if (this.browser) await this.browser.close();
        } catch (e) { }
        this.browser = null;
        this.page = null;
    }
}

module.exports = AccountChecker;
