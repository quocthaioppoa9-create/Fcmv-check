// ══════════════════════════════════════════════════
//  CAPTCHA HANDLER
//  Vì chạy trên cloud (Render) không có màn hình,
//  ta chụp screenshot captcha → gửi lên web
//  → user nhập đáp án → gửi lại server
// ══════════════════════════════════════════════════

const path = require('path');
const fs = require('fs');
const { delay } = require('./utils');

class CaptchaHandler {
    constructor(io, socketId) {
        this.io = io;              // Socket.IO instance
        this.socketId = socketId;  // Socket ID của client
        this.pendingResolve = null;
    }

    /**
     * Chờ user giải captcha
     * Chụp screenshot → gửi lên client → chờ đáp án hoặc chờ trang tự chuyển
     */
    async waitForCaptchaSolution(page, accountId) {
        return new Promise(async (resolve) => {
            this.pendingResolve = resolve;

            try {
                // Chụp screenshot toàn trang
                const screenshotBuffer = await page.screenshot({
                    encoding: 'base64',
                    fullPage: false
                });

                // Gửi ảnh captcha lên client
                this.io.to(this.socketId).emit('captcha_required', {
                    accountId: accountId,
                    screenshot: `data:image/png;base64,${screenshotBuffer}`,
                    message: 'Vui lòng xem ảnh captcha và nhập đáp án (nếu là text captcha), hoặc chờ...',
                    timestamp: Date.now()
                });

                // Đồng thời polling kiểm tra trang đã chuyển chưa
                // (trường hợp captcha tự giải hoặc không cần input)
                const maxWait = 300000; // 5 phút
                const startTime = Date.now();

                const pollInterval = setInterval(async () => {
                    try {
                        const currentUrl = page.url();
                        const elapsed = Date.now() - startTime;

                        // Đã đăng nhập thành công (trang chuyển)
                        if (!currentUrl.includes('sso.garena.com') &&
                            !currentUrl.includes('login')) {
                            clearInterval(pollInterval);
                            if (this.pendingResolve) {
                                this.pendingResolve({ success: true, method: 'auto_redirect' });
                                this.pendingResolve = null;
                            }
                            return;
                        }

                        // Hết thời gian
                        if (elapsed >= maxWait) {
                            clearInterval(pollInterval);
                            if (this.pendingResolve) {
                                this.pendingResolve({ success: false, error: 'timeout' });
                                this.pendingResolve = null;
                            }
                            return;
                        }

                        // Cập nhật screenshot mới mỗi 10 giây
                        if (elapsed > 0 && elapsed % 10000 < 2000) {
                            const newScreenshot = await page.screenshot({
                                encoding: 'base64',
                                fullPage: false
                            });
                            this.io.to(this.socketId).emit('captcha_update', {
                                accountId: accountId,
                                screenshot: `data:image/png;base64,${newScreenshot}`,
                                remaining: Math.floor((maxWait - elapsed) / 1000)
                            });
                        }

                    } catch (e) {
                        // Page có thể đã navigate
                        clearInterval(pollInterval);
                        if (this.pendingResolve) {
                            this.pendingResolve({ success: true, method: 'page_changed' });
                            this.pendingResolve = null;
                        }
                    }
                }, 2000);

            } catch (error) {
                resolve({ success: false, error: error.message });
            }
        });
    }

    /**
     * Nhận đáp án captcha từ client (text captcha)
     */
    async submitCaptchaAnswer(page, answer) {
        try {
            // Tìm ô nhập captcha và điền đáp án
            const captchaInput = await page.$('input[name="captcha"], input[id*="captcha"], input[placeholder*="captcha"]');
            if (captchaInput) {
                await captchaInput.click({ clickCount: 3 });
                await captchaInput.type(answer, { delay: 50 });
                await delay(500);

                // Nhấn submit
                const submitBtn = await page.$('button[type="submit"], input[type="submit"]');
                if (submitBtn) {
                    await submitBtn.click();
                }
            }

            await delay(3000);

            // Kiểm tra kết quả
            const currentUrl = page.url();
            const success = !currentUrl.includes('login') && !currentUrl.includes('sso.garena.com');

            if (this.pendingResolve) {
                this.pendingResolve({ success, method: 'manual_input' });
                this.pendingResolve = null;
            }

            return success;

        } catch (error) {
            return false;
        }
    }

    /**
     * Hủy chờ captcha
     */
    cancel() {
        if (this.pendingResolve) {
            this.pendingResolve({ success: false, error: 'cancelled' });
            this.pendingResolve = null;
        }
    }
}

module.exports = CaptchaHandler;
