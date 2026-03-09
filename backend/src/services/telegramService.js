'use strict';

// ─── Config ───────────────────────────────────────────────────────
const TELEGRAM_API_BASE = 'https://api.telegram.org';
const REQUEST_TIMEOUT_MS = 10000;

function createTelegramService() {
  const enabled   = (process.env.TELEGRAM_ENABLED || 'false').toLowerCase() === 'true';
  const botToken  = process.env.TELEGRAM_BOT_TOKEN  || '';
  const chatId    = process.env.TELEGRAM_CHAT_ID    || '';
  const parseMode = process.env.TELEGRAM_PARSE_MODE || 'HTML';

  if (!enabled) {
    console.log('[telegram] Telegram delivery is disabled (TELEGRAM_ENABLED=false)');
  } else if (!botToken || !chatId) {
    console.warn('[telegram] WARNING: TELEGRAM_ENABLED=true but BOT_TOKEN or CHAT_ID is not set');
  } else {
    console.log(`[telegram] Telegram delivery enabled, chat=${chatId}`);
  }

  // ── sendMessage ─────────────────────────────────────────────
  async function sendMessage(text, options = {}) {
    if (!enabled) {
      return { success: false, skipped: true, reason: 'telegram_disabled' };
    }
    if (!botToken || !chatId) {
      return { success: false, skipped: true, reason: 'missing_credentials' };
    }

    const body = JSON.stringify({
      chat_id:    chatId,
      text,
      parse_mode: options.parseMode || parseMode,
      ...( options.disableWebPagePreview ? { disable_web_page_preview: true } : {} ),
    });

    const url = `${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      let response;
      try {
        response = await fetch(url, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const statusCode = response.status;

      if (response.ok) {
        const data = await response.json();
        const messageId = data?.result?.message_id ?? null;
        return { success: true, statusCode, telegramMessageId: messageId };
      }

      // Ошибки Telegram API
      let errorText = `HTTP ${statusCode}`;
      try {
        const errData = await response.json();
        errorText = errData?.description || errorText;
      } catch (_) {}

      return { success: false, statusCode, error: errorText };

    } catch (err) {
      // Network error / timeout
      const isTimeout = err.name === 'AbortError';
      return {
        success:   false,
        statusCode: null,
        error:     isTimeout ? 'Request timeout' : err.message,
      };
    }
  }

  return { sendMessage, enabled };
}

module.exports = { createTelegramService };
