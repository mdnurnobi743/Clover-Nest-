// api/spin.js — Spin Wheel endpoint. Every outcome is decided AND credited
// right here, server-side, atomically — index.html's wheel animation is
// purely cosmetic playback of a result that's already final by the time it
// starts spinning (see the comment in spinWheelNow()).
//
//   POST /api/spin   body: { action: 'spin', initData }
//
// Two independent reward currencies, matching the two stat boxes on the
// Spin tab and the reference wheel design 1:1:
//   • CN   → users.wtcBalance   — most wedges, a random whole amount inside
//                                 that wedge's min–max range
//   • USDT → users.usdtBalance  — the rare "$0.005" / "$0.1" wedges, credited
//                                 as real USD/USDT, kept in its own field
//                                 instead of being converted into CN
// The "+1 SPIN" wedge touches neither balance — it just refunds the spin
// that was spent to land on it (net-zero cost to the daily allowance).
//
// lib/constants.js SPIN_SEGMENTS is the ONLY place the wedges/odds are
// defined — index.html's SPIN_SEGMENTS_UI mirrors it purely for rendering
// and has zero influence on what a spin actually pays out.

import { connectToDatabase } from '../lib/mongodb.js';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';
import { ensureDailyReset } from '../lib/dailyReset.js';
import { SPIN_SEGMENTS } from '../lib/constants.js';

// Same anti-abuse gate api/earn.js's reward handlers use — a multi-account
// -flagged user earns nothing NEW until they verify channel + community
// membership. The spin itself still happens (and still costs a spin) so the
// UI doesn't look broken to them, it just credits nothing until verified.
const REWARD_ELIGIBLE_FILTER = { $or: [{ multiAccountFlag: { $ne: true } }, { channelVerified: true }] };

// Weighted pick — SPIN_SEGMENTS' weights are parts-per-100 and are asserted
// to sum to exactly 100 at import time (see lib/constants.js).
function pickSegment() {
    const roll = Math.random() * 100;
    let acc = 0;
    for (let i = 0; i < SPIN_SEGMENTS.length; i++) {
        acc += SPIN_SEGMENTS[i].weight;
        if (roll < acc) return { segment: SPIN_SEGMENTS[i], segmentIndex: i };
    }
    // Float-rounding fallback — lands on the last segment instead of undefined.
    return { segment: SPIN_SEGMENTS[SPIN_SEGMENTS.length - 1], segmentIndex: SPIN_SEGMENTS.length - 1 };
}

async function handleSpin(req, res, db, userId) {
    const users = db.collection('users');
    await ensureDailyReset(users, userId);

    const user = await users.findOne({ _id: userId });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });

    // ── STEP 1: atomically spend one spin. The `spinsRemaining: { $gt: 0 }`
    // guard means two near-simultaneous requests can't both spend the same
    // last spin — exactly one of them gets `spend`, the other falls through
    // to the no_spins_left response below. ──
    const spend = await users.findOneAndUpdate(
        { _id: userId, spinsRemaining: { $gt: 0 } },
        { $inc: { spinsRemaining: -1 } },
        { returnDocument: 'after' }
    );
    if (!spend) {
        const fresh = await users.findOne({ _id: userId }, { projection: { spinsRemaining: 1 } });
        return res.status(200).json({ ok: false, error: 'no_spins_left', spinsRemaining: fresh?.spinsRemaining || 0 });
    }

    const { segment, segmentIndex } = pickSegment();

    // ── STEP 2: credit the outcome. ──
    let amountWtc = 0;
    let amountUsd = 0;

    if (segment.type === 'spin') {
        // Net-zero — give back the spin that was just spent, touch no balance.
        await users.updateOne({ _id: userId }, { $inc: { spinsRemaining: 1 } });
    } else if (segment.type === 'cn') {
        amountWtc = Math.floor(Math.random() * (segment.max - segment.min + 1)) + segment.min;
        const credited = await users.updateOne(
            { _id: userId, ...REWARD_ELIGIBLE_FILTER },
            { $inc: { wtcBalance: amountWtc, lifetimeWtcEarned: amountWtc } }
        );
        // Multi-account-flagged + unverified — the wheel still spins (spin
        // already spent above) but nothing is actually credited. Zero the
        // reported amount too so the result screen doesn't show a win the
        // user never actually received.
        if (credited.matchedCount === 0) amountWtc = 0;
    } else if (segment.type === 'usd') {
        amountUsd = segment.usdAmount;
        const credited = await users.updateOne(
            { _id: userId, ...REWARD_ELIGIBLE_FILTER },
            { $inc: { usdtBalance: amountUsd, lifetimeUsdEarned: amountUsd } }
        );
        if (credited.matchedCount === 0) amountUsd = 0;
    }

    const after = await users.findOne({ _id: userId }, { projection: { spinsRemaining: 1 } });

    return res.status(200).json({
        ok: true,
        type: segment.type,          // 'cn' | 'usd' | 'spin' — index.html branches the result modal on this
        segmentIndex,                 // which wedge to land the rotor on
        amountWtc,                    // CN credited this spin (0 unless type === 'cn')
        amountUsd,                    // USDT credited this spin (0 unless type === 'usd')
        spinsRemaining: after?.spinsRemaining ?? spend.spinsRemaining,
    });
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

    const { action } = req.body || {};
    if (action !== 'spin') return res.status(400).json({ ok: false, error: 'unknown_action' });

    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    const { db } = await connectToDatabase();
    return handleSpin(req, res, db, userId);
}
