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

module.exports = { registerStartHandler, checkSubscriptionHandler };
