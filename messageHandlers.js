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
// 0. Persisted user storage (users.json)
// STATE.userSessions is just an in-memory Map, wiped on every restart/
// redeploy. That made /pushAnnounce only reach whoever ran /start *after*
// the last deploy. users.json is the durable copy — same read-modify-write
// pattern bot.js already uses for payments.json — and STATE.userSessions
// gets hydrated from it once at boot (see loadUsersIntoState below, called
// from bot.js before registerStartHandler is wired up).
// ------------------------------------------------
const fs = require('fs');
const path = require('path');
const USERS_DB_PATH = path.join(__dirname, 'users.json');

function loadUsersFromDisk() {
  try {
    return JSON.parse(fs.readFileSync(USERS_DB_PATH, 'utf8'));
  } catch (e) {
    return {}; // file doesn't exist yet, or is corrupt — start fresh
  }
}

function saveUsersToDisk(usersObj) {
  try {
    fs.writeFileSync(USERS_DB_PATH, JSON.stringify(usersObj, null, 2));
  } catch (e) {
    console.error('❌ Failed to write users.json:', e.message);
  }
}

function persistUser(chatId, session) {
  const usersObj = loadUsersFromDisk();
  usersObj[chatId] = session;
  saveUsersToDisk(usersObj);
}

// Call once at boot, before registerStartHandler starts adding new
// entries, so the broadcast list already has every user who has ever
// run /start, not just ones seen since the last restart.
function loadUsersIntoState(STATE) {
  const usersObj = loadUsersFromDisk();
  let count = 0;
  for (const [chatId, session] of Object.entries(usersObj)) {
    STATE.userSessions.set(Number(chatId), session);
    count++;
  }
  console.log(`👥 Loaded ${count} persisted user(s) from users.json`);
}

// ------------------------------------------------
// 1. /start
// ------------------------------------------------
function registerStartHandler(bot, STATE, WEB_APP_URL) {
  bot.onText(/\/start$/, async (msg) => {
    const chatId = msg.chat.id;
    const user = msg.from;

    const session = {
      userId: user.id,
      firstName: user.first_name,
      lastName: user.last_name,
      username: user.username,
      lastActive: Date.now()
    };
    STATE.userSessions.set(chatId, session);
    persistUser(chatId, session);

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
// Returns { subscribed: true|false } as script.js expects, plus:
//   source: 'override' | 'cache' | 'telegram'   (how the answer was reached)
//   error:  'unavailable' | 'config'            (only when it could NOT verify)
//
// What changed vs. the old version (why some users kept failing):
//   - A transient Telegram/network error (429, 5xx, timeout) used to come
//     back as a plain `subscribed:false`, so a perfectly subscribed user was
//     told "you haven't joined". Now it's retried with backoff, and if it
//     still can't be verified the response says so (`error`) so the app can
//     show "couldn't verify, try again" instead.
//   - Members whose status is `restricted` (but still in the channel, e.g.
//     muted by an admin) were counted as NOT subscribed. They count now.
//   - Positive answers are cached for a few minutes and concurrent checks
//     for the same user share one Telegram call, so a busy moment can't
//     push the bot into Telegram's rate limit.
//   - Manual override: a manager can mark a user as subscribed with
//     /setsub in the support bot (stored in prize-store).
//   - The channel comes from the server (SUBSCRIPTION_CHANNEL env var,
//     default @VoidGiftsOfficial), not from the query string.
//
// Env (all optional):
//   SUBSCRIPTION_CHANNEL    channel @username or id            (default @VoidGiftsOfficial)
//   PRIZE_STORE_URL         enables the manual override lookup (same URL the relayer uses)
//   SUBSCRIPTION_FAIL_OPEN  'true' = if Telegram can't be reached at all, let the
//                           user through instead of blocking them     (default false)
//
// The bot MUST be an admin of the channel to see membership reliably.
// ------------------------------------------------
const SUBSCRIPTION_CHANNEL = process.env.SUBSCRIPTION_CHANNEL || '@VoidGiftsOfficial';
const PRIZE_STORE_URL = (process.env.PRIZE_STORE_URL || '').replace(/\/$/, '');
const SUBSCRIPTION_FAIL_OPEN = String(process.env.SUBSCRIPTION_FAIL_OPEN || '').toLowerCase() === 'true';

const SUB_POSITIVE_TTL_MS = 10 * 60 * 1000; // remember "subscribed" for 10 min
const SUB_OVERRIDE_TTL_MS = 30 * 1000;      // re-read the manual override every 30 s
const subPositiveCache = new Map();         // userId -> expiresAt
const subOverrideCache = new Map();         // userId -> { value, expiresAt }
const subInFlight = new Map();              // userId -> Promise<{subscribed, source}>

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Read the manual override from prize-store. Any failure just means "no
// override" — it must never break (or slow down) the real check.
async function hasSubscriptionOverride(userId) {
  if (!PRIZE_STORE_URL) return false;
  const cached = subOverrideCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const r = await fetch(`${PRIZE_STORE_URL}/users/${encodeURIComponent(userId)}/subscription`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return false;
    const data = await r.json();
    const value = data.subscription_override === true;
    subOverrideCache.set(userId, { value, expiresAt: Date.now() + SUB_OVERRIDE_TTL_MS });
    return value;
  } catch (err) {
    console.warn('⚠️ subscription override lookup failed (ignored):', err.message);
    return false;
  }
}

function telegramErrorInfo(error) {
  const body = error?.response?.body || {};
  return {
    code: body.error_code || error?.response?.statusCode || 0,
    description: String(body.description || error?.message || ''),
    retryAfter: body.parameters?.retry_after,
  };
}

// Calls getChatMember, retrying only errors that are plausibly temporary.
async function getMemberWithRetry(bot, userId) {
  const MAX_ATTEMPTS = 3;
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await bot.getChatMember(SUBSCRIPTION_CHANNEL, userId);
    } catch (error) {
      lastError = error;
      const { code, description, retryAfter } = telegramErrorInfo(error);

      // Definitive answers — retrying won't change them.
      if (/user not found|PARTICIPANT_ID_INVALID/i.test(description)) return { status: 'left' };
      if (/chat not found|not enough rights|member list is inaccessible|bot is not a member|CHAT_ADMIN_REQUIRED/i.test(description)) {
        error.isConfigError = true;
        throw error;
      }
      if (code === 400 || code === 401 || code === 403) throw error;

      // Temporary: 429 (rate limit), 5xx, or a network error with no HTTP code.
      if (attempt < MAX_ATTEMPTS) {
        const wait = code === 429 && retryAfter ? Math.min(retryAfter, 3) * 1000 : 300 * attempt * attempt;
        await sleep(wait);
      }
    }
  }
  throw lastError;
}

function isSubscribedStatus(member) {
  if (['member', 'administrator', 'creator'].includes(member.status)) return true;
  // `restricted` users are still in the channel when is_member is true.
  if (member.status === 'restricted' && member.is_member === true) return true;
  return false; // 'left', 'kicked', restricted-and-not-a-member
}

async function resolveSubscription(bot, userId) {
  if (await hasSubscriptionOverride(userId)) return { subscribed: true, source: 'override' };

  const cachedUntil = subPositiveCache.get(userId);
  if (cachedUntil && cachedUntil > Date.now()) return { subscribed: true, source: 'cache' };

  const member = await getMemberWithRetry(bot, userId);
  const subscribed = isSubscribedStatus(member);
  if (subscribed) subPositiveCache.set(userId, Date.now() + SUB_POSITIVE_TTL_MS);
  else subPositiveCache.delete(userId); // never cache "no": they may join a second from now
  return { subscribed, source: 'telegram' };
}

function checkSubscriptionHandler(bot) {
  return async (req, res) => {
    const userId = String(req.query.user_id || '').trim();

    if (!/^\d{1,15}$/.test(userId)) {
      return res.status(400).json({ subscribed: false, error: 'Missing or invalid user_id' });
    }

    try {
      // Share one in-flight lookup between concurrent requests for a user
      // (double taps, the auto-retry on the client, etc.).
      let pending = subInFlight.get(userId);
      if (!pending) {
        pending = resolveSubscription(bot, userId).finally(() => subInFlight.delete(userId));
        subInFlight.set(userId, pending);
      }
      const result = await pending;
      return res.json(result);
    } catch (error) {
      const { description } = telegramErrorInfo(error);
      if (error.isConfigError) {
        // Affects EVERYONE, not just this user — make it loud.
        console.error(`🚨 check-subscription: bot can't read channel ${SUBSCRIPTION_CHANNEL} (${description}). Make the bot an ADMIN of the channel and check SUBSCRIPTION_CHANNEL.`);
      } else {
        console.error(`❌ check-subscription could not verify ${userId}: ${description}`);
      }

      if (SUBSCRIPTION_FAIL_OPEN) {
        return res.json({ subscribed: true, source: 'fail-open', error: error.isConfigError ? 'config' : 'unavailable' });
      }
      // Fail closed, but tell the client this was a failure to verify —
      // NOT a confirmed "this person hasn't joined".
      return res.json({ subscribed: false, error: error.isConfigError ? 'config' : 'unavailable' });
    }
  };
}

// PUSH_BRIDGE_SECRET: shared secret the support bot must send in the
// x-push-secret header on every /push-announce request. Must match the
// value set on the support bot's process exactly. Lives here (not in
// bot.js) since this file already owns all the "global announcement /
// subscription check" surface area — bot.js just wires the route.
const PUSH_BRIDGE_SECRET = process.env.PUSH_BRIDGE_SECRET;
if (!PUSH_BRIDGE_SECRET) {
  console.warn('⚠️  PUSH_BRIDGE_SECRET not set — /push-announce will reject every request.');
}

// ------------------------------------------------
// 3. POST /push-announce
// Called by the support bot's /pushAnnounce command — NOT by users, and
// NOT reachable without the shared secret. Body:
//   { managerId, text, photoBase64, photoMime }
// Header: x-push-secret must equal PUSH_BRIDGE_SECRET above.
//
// Broadcasts to every chatId currently in STATE.userSessions — i.e.
// everyone who has ever run /start. This is a blast-radius action, so the
// secret check is fail-closed: if no secret was configured, every request
// is rejected rather than silently allowed.
//
// Wire this into your Express app next to checkSubscriptionHandler:
//   app.post('/push-announce', pushAnnounceHandler(bot, STATE));
// Needs express.json() registered before it, with a raised limit (a photo
// comes across as base64 in the body, and Express's default ~100kb limit
// will reject anything but a tiny image) — e.g.
//   app.use(express.json({ limit: '10mb' }));
//
// ASSUMPTION: I deliberately do NOT set parse_mode: 'HTML' on the
// broadcast text. Managers are typing free text ("Hi 347!" etc.) — if that
// text ever contains a stray `<` or `&`, Telegram's HTML parser throws a
// 400 and the *entire* broadcast for that batch fails, not just that one
// oddity. Sending as plain text is more failure-resistant for something
// going to your whole user base. Swap parse_mode back in if you'd rather
// managers be able to use bold/links and are okay enforcing valid HTML.
// ------------------------------------------------
function pushAnnounceHandler(bot, STATE) {
  return async (req, res) => {
    if (!PUSH_BRIDGE_SECRET) {
      console.error('❌ push-announce: PUSH_BRIDGE_SECRET not configured — refusing all requests.');
      return res.status(500).json({ ok: false, error: 'Broadcast bridge not configured' });
    }
    if (req.headers['x-push-secret'] !== PUSH_BRIDGE_SECRET) {
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
            const usersObj = loadUsersFromDisk();
            delete usersObj[chatId];
            saveUsersToDisk(usersObj);
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

module.exports = { registerStartHandler, checkSubscriptionHandler, pushAnnounceHandler, loadUsersIntoState };
