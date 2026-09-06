// lib/telegram.js — thin wrapper around Telegram's Bot API (sendMessage,
// editMessageText, sendPhoto, answerCallbackQuery, getChatMember).
//
// ⚠️ RECONSTRUCTED FILE: this file was imported everywhere (api/bot.js,
// api/user.js, api/earn.js, lib/referral.js) for tgSend/tgEdit/tgSendPhoto/
// tgAnswerCallback/isMember/OFFICIAL_CHANNEL/COMMUNITY_GROUP/PAYMENT_CHANNEL/
// PAYMENT_PROOF_PHOTO, but the file that actually shipped in this snapshot
// only contained the unrelated initData-verification code (now correctly
// split into lib/telegramAuth.js). That made every API route that touches
// Telegram — which is nearly all of them — crash at import time. Rebuilt
// from how each export is called at every call site.
//
// Signed Mini App `initData` verification lives in lib/telegramAuth.js, not
// here — that's a pure signature check with no network calls, unrelated to
// this file's Bot API traffic.

const BOT_TOKEN = process.env.BOT_TOKEN;
const TG_API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ── Channel/group usernames used for the "join to unlock" gate (api/user.js
// handleCheckJoin, api/bot.js /start flow). Override via env vars without a
// code change if the channel/group ever moves. Defaults mirror index.html's
// OFFICIAL_CHANNEL / COMMUNITY_GROUP constants (search that file for
// "mirrors lib/telegram.js") so the "Join" links and the server-side
// membership check always point at the same place.
export const OFFICIAL_CHANNEL = process.env.OFFICIAL_CHANNEL_USERNAME || 'clover_nest_official';
export const COMMUNITY_GROUP = process.env.COMMUNITY_GROUP_USERNAME || 'clover_nest_community';

// ── Public channel withdrawals get posted to as social proof, plus the
// photo used for that post's proof image (api/bot.js finalizeWithdrawal).
// No safe hardcoded default for either — leave unset and the withdrawal
// still completes, it just skips the public post (see the try/catch around
// tgSendPhoto at that call site) instead of posting to the wrong place.
export const PAYMENT_CHANNEL = process.env.PAYMENT_CHANNEL_USERNAME || '';
export const PAYMENT_PROOF_PHOTO = process.env.PAYMENT_PROOF_PHOTO_URL || '';

// ── Low-level call — every other export in this file goes through this. ──
export async function tgApi(method, payload = {}) {
    if (!BOT_TOKEN) throw new Error('BOT_TOKEN environment variable is not set');
    const res = await fetch(`${TG_API_BASE}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) {
        throw new Error(`Telegram API ${method} failed: ${data.description || `HTTP ${res.status}`}`);
    }
    return data.result;
}

export async function tgSend(chatId, text, extra = {}) {
    return tgApi('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...extra,
    });
}

export async function tgEdit(chatId, messageId, text, extra = {}) {
    return tgApi('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...extra,
    });
}

export async function tgSendPhoto(chatId, photo, caption = '', extra = {}) {
    return tgApi('sendPhoto', {
        chat_id: chatId,
        photo,
        caption,
        parse_mode: 'HTML',
        ...extra,
    });
}

export async function tgAnswerCallback(callbackQueryId, text, showAlert = false) {
    return tgApi('answerCallbackQuery', {
        callback_query_id: callbackQueryId,
        ...(text ? { text } : {}),
        show_alert: !!showAlert,
    });
}

// Returns true/false — never throws, so a Telegram-side hiccup (bot not an
// admin in the channel yet, channel temporarily unreachable, etc.) fails
// closed as "not a member" for the caller instead of 500ing the whole
// endpoint (checkJoin, task completion, and the /start gate all call this).
export async function isMember(userId, channelUsername) {
    if (!channelUsername) return false;
    const chatId = String(channelUsername).startsWith('@') ? channelUsername : `@${channelUsername}`;
    try {
        const result = await tgApi('getChatMember', { chat_id: chatId, user_id: userId });
        return ['creator', 'administrator', 'member'].includes(result.status);
    } catch (err) {
        console.error(`lib/telegram.js isMember(${channelUsername}) failed:`, err.message);
        return false;
    }
}
