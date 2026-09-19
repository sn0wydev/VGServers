// ============================================
// MESSAGE HANDLERS
// ============================================
// Only two things live here:
//   1. /start (the greeting) — moved out of bot.js
//   2. check-subscription — the endpoint script.js's Subscription.checkMembership()
//      calls (CONFIG.SUBSCRIPTION_CHECK_URL), which didn't exist in bot.js yet.
//
// Everything else (help, stats, ping, monitor, payments, refund, etc.)
// stays exactly where it already is in bot.js.

// ------------------------------------------------
// 1. /start
// ------------------------------------------------
function registerStartHandler(bot, STATE, WEB_APP_URL) {
  bot.onText(/\/start$/, async (msg) => {
    const chatId = msg.chat.id;
    const user = msg.from;

    STATE.userSessions.set(chatId, {
      userId: user.id,
      firstName: user.first_name,
      lastName: user.last_name,
      username: user.username,
      lastActive: Date.now()
    });

    await bot.sendMessage(chatId,
      `👋 <b>Welcome to Void Gift!</b>\n\n` +
      `🎮 Play the spin wheel\n` +
      `🎁 Win amazing prizes\n` +
      `💰 Purchase coins with Telegram Stars\n` +
      `📦 Build your collection\n\n` +
      `Click the button below to start playing:`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            {
              text: '🎮 Open Mini App',
              web_app: { url: WEB_APP_URL }
            }
          ]]
        }
      }
    );
  });
}

// ------------------------------------------------
// 2. GET /check-subscription?user_id=...&channel=...
// Returns { subscribed: true|false } as script.js expects.
// Uses bot.getChatMember, which requires the bot to be an
// admin of the channel to reliably see membership status.
// ------------------------------------------------
function checkSubscriptionHandler(bot) {
  return async (req, res) => {
    const { user_id, channel } = req.query;

    if (!user_id || !channel) {
      return res.status(400).json({ subscribed: false, error: 'Missing user_id or channel' });
    }

    try {
      const member = await bot.getChatMember(channel, user_id);
      const subscribed = ['member', 'administrator', 'creator'].includes(member.status);
      return res.json({ subscribed });
    } catch (error) {
      console.error('❌ check-subscription error:', error.message);
      // Fail closed, matching the frontend's own fail-closed behavior.
      return res.json({ subscribed: false });
    }
  };
}

// ------------------------------------------------
// 3. POST /push-announce
// Called by the support bot's /pushAnnounce command — NOT by users, and
// NOT reachable without the shared secret. Body:
//   { managerId, text, photoBase64, photoMime }
// Header: x-push-secret must equal the PUSH_BRIDGE_SECRET this handler
// was constructed with (same value the support bot process holds).
//
// Broadcasts to every chatId currently in STATE.userSessions — i.e.
// everyone who has ever run /start. This is a blast-radius action, so the
// secret check is fail-closed: if no secret was configured, every request
// is rejected rather than silently allowed.
//
// ASSUMPTION: I don't have your main bot's entry file (only this
// messageHandlers.js), so I don't know how your Express app/bot instance
// are wired together. This is written the same way checkSubscriptionHandler
// already is — a factory that returns an Express handler — so wire it in
// next to that one, e.g.:
//   app.post('/push-announce', express.json({ limit: '10mb' }),
//     pushAnnounceHandler(bot, STATE, { secret: process.env.PUSH_BRIDGE_SECRET }));
// Note express.json() with a raised body limit: a photo comes across as
// base64 in the JSON body, and the default ~100kb Express limit will
// reject anything but a tiny image.
//
// ASSUMPTION: I deliberately do NOT set parse_mode: 'HTML' on the
// broadcast text. Managers are typing free text ("Hi 347!" etc.) — if that
// text ever contains a stray `<` or `&`, Telegram's HTML parser throws a
// 400 and the *entire* broadcast for that batch fails, not just that one
// oddity. Sending as plain text is more failure-resistant for something
// going to your whole user base. Swap parse_mode back in if you'd rather
// managers be able to use bold/links and are okay enforcing valid HTML.
// ------------------------------------------------
function pushAnnounceHandler(bot, STATE, { secret } = {}) {
  return async (req, res) => {
    if (!secret) {
      console.error('❌ push-announce: PUSH_BRIDGE_SECRET not configured — refusing all requests.');
      return res.status(500).json({ ok: false, error: 'Broadcast bridge not configured' });
    }
    if (req.headers['x-push-secret'] !== secret) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const { managerId, text, photoBase64, photoMime } = req.body || {};

    if ((!text || !text.trim()) && !photoBase64) {
      return res.status(400).json({ ok: false, error: 'Empty announcement (need text and/or photo)' });
    }

    let photoBuffer = null;
    if (photoBase64) {
      try {
        photoBuffer = Buffer.from(photoBase64, 'base64');
      } catch (err) {
        return res.status(400).json({ ok: false, error: 'Bad photoBase64' });
      }
    }

    const chatIds = [...STATE.userSessions.keys()];
    console.log(`📣 push-announce: manager ${managerId} broadcasting to ${chatIds.length} users`);

    // Telegram allows roughly 30 messages/sec across all chats. Fire all
    // sendMessage/sendPhoto calls at once and Telegram will start
    // returning 429s partway through any non-trivial user base — so send
    // in small batches with a short pause between them instead.
    const BATCH_SIZE = 20;
    const BATCH_DELAY_MS = 1000;

    let sent = 0;
    let blocked = 0;
    let failed = 0;

    for (let i = 0; i < chatIds.length; i += BATCH_SIZE) {
      const batch = chatIds.slice(i, i + BATCH_SIZE);

      await Promise.all(batch.map(async (chatId) => {
        try {
          if (photoBuffer) {
            await bot.sendPhoto(
              chatId,
              photoBuffer,
              { caption: text || undefined },
              { filename: 'announce.jpg', contentType: photoMime || 'image/jpeg' }
            );
          } else {
            await bot.sendMessage(chatId, text);
          }
          sent++;
        } catch (err) {
          // 403 = user blocked the bot or deleted their account. Drop them
          // from userSessions so future broadcasts stop retrying a dead chat.
          if (err.response && err.response.statusCode === 403) {
            blocked++;
            STATE.userSessions.delete(chatId);
          } else {
            failed++;
            console.error(`push-announce failed for ${chatId}:`, err.message);
          }
        }
      }));

      if (i + BATCH_SIZE < chatIds.length) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    console.log(`📣 push-announce done: sent=${sent} blocked=${blocked} failed=${failed}`);
    return res.json({ ok: true, sent, blocked, failed, total: chatIds.length });
  };
}

module.exports = { registerStartHandler, checkSubscriptionHandler, pushAnnounceHandler };
