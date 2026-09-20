// ============================================
// TELEGRAM BOT - COMPLETE NODE.JS VERSION
// ============================================
// Version: 7.1 - DIRECT INVOICE OPENING (openInvoice) + STAR CREDITS
// Invoice opens as popup in Mini App - NO chat redirect!
//
// 7.1 changes (search "7.1"):
//   - Paid Stars packages are now actually delivered. Before, nothing ever
//     wrote the purchased Stars anywhere the app could read (a bot can't
//     write to a user's Telegram CloudStorage). Now the payment records an
//     unclaimed credit and the app collects it from GET /stars/claim-credits,
//     the same pull-model ton-payments.js already uses. Authenticated with
//     Telegram initData, so one user can't claim another user's credits.
//   - /check-subscription is registered AFTER cors(), so browsers can read it.
//   - Invoice text says "N Stars" (it said "N Void Coins", which the app
//     never credits).
//   - Fixed a ReferenceError that silently dropped the "PAYMENT INITIATED" log.

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;

// ============================================
// CONFIGURATION
// ============================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEB_APP_URL = process.env.WEB_APP_URL;
const HTTP_PORT = process.env.PORT || 3000;

// Telegram Group Logging Configuration
const LOG_CHAT_ID = process.env.LOG_CHAT_ID;
const SYSTEM_LOG_TOPIC_ID = 6;      // Error/exception logs
const TRANSACTION_LOG_TOPIC_ID = 3;  // Payments, refunds, transactions

// ============================================
// PRODUCT CATALOG - MATCHES WEBAPP (13 products)
// ============================================

const PRODUCTS = {
  package_tiny: {
    id: "package_tiny",
    stars: 1,
    coins: 10,
    title: "Tiny Package",
    description: "10 Void Coins"
  },
  package_mini: {
    id: "package_mini",
    stars: 25,
    coins: 250,
    title: "Mini Package",
    description: "250 Void Coins"
  },
  package_small: {
    id: "package_small",
    stars: 50,
    coins: 500,
    title: "Small Package",
    description: "500 Void Coins"
  },
  package_bit: {
    id: "package_bit",
    stars: 75,
    coins: 750,
    title: "Bit Package",
    description: "750 Void Coins"
  },
  package_medium: {
    id: "package_medium",
    stars: 100,
    coins: 1000,
    title: "Medium Package",
    description: "1000 Void Coins"
  },
  package_biggermedium: {
    id: "package_biggermedium",
    stars: 250,
    coins: 2500,
    title: "Bigger Medium Package",
    description: "2500 Void Coins"
  },
  package_moderate: {
    id: "package_moderate",
    stars: 500,
    coins: 5000,
    title: "Moderate Package",
    description: "5000 Void Coins"
  },
  package_large: {
    id: "package_large",
    stars: 750,
    coins: 7500,
    title: "Large Package",
    description: "7500 Void Coins"
  },
  package_superlarge: {
    id: "package_superlarge",
    stars: 1000,
    coins: 10000,
    title: "Super Large Package",
    description: "10000 Void Coins"
  },
  package_huge: {
    id: "package_huge",
    stars: 2500,
    coins: 25000,
    title: "Huge Package",
    description: "25000 Void Coins"
  },
  package_xlsize: {
    id: "package_xlsize",
    stars: 5000,
    coins: 50000,
    title: "XL Package",
    description: "50000 Void Coins"
  },
  package_mega: {
    id: "package_mega",
    stars: 7500,
    coins: 75000,
    title: "Mega Package",
    description: "75000 Void Coins"
  },
  package_giant: {
    id: "package_giant",
    stars: 10000,
    coins: 100000,
    title: "Giant Package",
    description: "100000 Void Coins"
  }
};

// ============================================
// GLOBAL STATE
// ============================================

const STATE = {
  userSessions: new Map(),
  serverStartTime: Date.now(),
  pendingPayments: new Map() // Track payment_id -> {userId, productId, timestamp}
};

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();

// ============================================
// MESSAGE HANDLERS (external module)
// ============================================
const { registerStartHandler, checkSubscriptionHandler, pushAnnounceHandler, loadUsersIntoState } = require('./messageHandlers');

// Restore every user who has ever run /start (from users.json) before
// registerStartHandler starts adding new ones — otherwise every redeploy
// wipes STATE.userSessions and /pushAnnounce only reaches people who
// /start'd since the last deploy.
loadUsersIntoState(STATE);

registerStartHandler(bot, STATE, WEB_APP_URL);
// 7.1: /check-subscription is registered further down, AFTER cors(). Express
// only applies middleware to routes registered after it, so registering the
// route here meant it was served without Access-Control-Allow-Origin and the
// browser refused to let the mini app read the answer.

// ============================================
// EXPRESS MIDDLEWARE
// ============================================

app.use(cors({
  origin: '*', // Allow all origins (you can restrict this to your domain)
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'X-Telegram-Init-Data'] // 7.1: the app sends initData when collecting Star credits
}));

// Raised from the default ~100kb so a broadcast photo (sent as base64 in
// the JSON body by the support bot) doesn't get rejected before it even
// reaches pushAnnounceHandler. — changed for /push-announce
app.use(express.json({ limit: '10mb' }));

// POST /push-announce — manager broadcast bridge, called by the support
// bot's /pushAnnounce command. Secret check happens inside
// pushAnnounceHandler (messageHandlers.js owns that config, not this
// file). — new
app.post('/push-announce', pushAnnounceHandler(bot, STATE));

// 7.1: moved here from above the cors() call (see note there).
app.get('/check-subscription', checkSubscriptionHandler(bot));

// ============================================
// LOGGING FUNCTIONS
// ============================================

async function sendSystemLog(message, options = {}) {
  try {
    await bot.sendMessage(LOG_CHAT_ID, message, {
      message_thread_id: SYSTEM_LOG_TOPIC_ID,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...options
    });
  } catch (error) {
    console.error('Error sending system log to Telegram:', error);
  }
}

async function sendTransactionLog(message, options = {}) {
  try {
    await bot.sendMessage(LOG_CHAT_ID, message, {
      message_thread_id: TRANSACTION_LOG_TOPIC_ID,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...options
    });
  } catch (error) {
    console.error('Error sending transaction log to Telegram:', error);
  }
}

async function sendErrorLog(error, context = '') {
  const message = `
❌ <b>ERROR OCCURRED</b>
━━━━━━━━━━━━━━━━━━━━

<b>Context:</b> ${context}
<b>Error:</b> ${error.message}

<b>Stack:</b>
<code>${error.stack?.substring(0, 500) || 'No stack trace'}</code>

🕐 <b>Time:</b> ${new Date().toLocaleString()}
  `.trim();
  
  await sendSystemLog(message);
}

// ============================================
// TRANSACTION LOGGING
// ============================================

async function logTransactionToChannel(userId, username, payment, product, status = 'success') {
  try {
    const user = username ? `@${username}` : `User ID: ${userId}`;
    const timestamp = new Date().toISOString();
    
    let message = '';
    
    if (status === 'success') {
      message = `
✅ <b>PAYMENT SUCCESSFUL</b>
━━━━━━━━━━━━━━━━━━━━

👤 <b>User:</b> ${user}
🆔 <b>User ID:</b> <code>${userId}</code>
📦 <b>Product:</b> ${product.title}
💎 <b>Product ID:</b> <code>${product.id}</code>
⭐ <b>Stars Paid:</b> ${product.stars}
⭐ <b>Stars credited:</b> ${product.stars}
💳 <b>Charge ID:</b> <code>${payment.telegram_payment_charge_id}</code>
🔗 <b>Provider Charge ID:</b> <code>${payment.provider_payment_charge_id}</code>
📅 <b>Date:</b> ${timestamp}

<b>Method:</b> openInvoice (Direct Popup)
<b>Status:</b> Credit recorded, the app collects it via /stars/claim-credits
`;
    } else if (status === 'failed') {
      message = `
❌ <b>PAYMENT FAILED</b>
━━━━━━━━━━━━━━━━━━━━

👤 <b>User:</b> ${user}
🆔 <b>User ID:</b> <code>${userId}</code>
📦 <b>Product:</b> ${product.title}
💎 <b>Product ID:</b> <code>${product.id}</code>
⭐ <b>Stars:</b> ${product.stars}
🪙 <b>Coins:</b> ${product.coins}
📅 <b>Date:</b> ${timestamp}

<b>Status:</b> Payment processing error - NO CHARGE MADE
`;
    } else if (status === 'pre_checkout') {
      message = `
⏳ <b>PAYMENT INITIATED</b>
━━━━━━━━━━━━━━━━━━━━

👤 <b>User:</b> ${user}
🆔 <b>User ID:</b> <code>${userId}</code>
📦 <b>Product:</b> ${product.title}
💎 <b>Product ID:</b> <code>${product.id}</code>
⭐ <b>Stars:</b> ${product.stars}
🪙 <b>Coins:</b> ${product.coins}
📅 <b>Date:</b> ${timestamp}

<b>Method:</b> openInvoice (Direct Popup)
<b>Status:</b> Pre-checkout approved, awaiting payment
`;
    }
    
    await sendTransactionLog(message);
    console.log('📊 Transaction logged to channel (Topic 3)');
    
  } catch (error) {
    console.error('❌ Error logging to channel:', error);
  }
}

// ============================================
// DATABASE FUNCTIONS
// ============================================

async function savePaymentRecord(userId, chargeId, productId, spentStars, coinsDelivered, createdAt) {
  try {
    let payments = [];
    try {
      const data = await fs.readFile('payments.json', 'utf8');
      payments = JSON.parse(data);
    } catch (e) {
      // File doesn't exist yet
    }
    
    const payment = {
      id: payments.length + 1,
      userId,
      chargeId,
      productId,
      spentStars,
      coinsDelivered,
      createdAt,
      timestamp: new Date().toISOString(),
      refunded: false
    };
    
    payments.push(payment);
    await fs.writeFile('payments.json', JSON.stringify(payments, null, 2));
    
    console.log('💾 Payment saved to database:', payment.id);
    
  } catch (error) {
    console.error('❌ Error saving payment:', error);
  }
}

async function notifyStarsPurchased(userId, stars) {
  try {
    await bot.sendMessage(userId,
      `✅ <b>Payment Successful!</b>\n\n` +
      `${stars} ⭐ Stars have been added to your account!\n\n` +
      `Open the app to see your new balance.`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: '🎮 Open App', web_app: { url: WEB_APP_URL } }
          ]]
        }
      }
    );
    return true;
  } catch (error) {
    console.error('⚠️ Could not send purchase notice (non-fatal, credit is recorded):', error.message);
    return false;
  }
}

function logFailedDelivery(userId, chargeId, error) {
  const logEntry = {
    userId,
    chargeId,
    error: error.toString(),
    timestamp: new Date().toISOString()
  };
  
  require('fs').appendFileSync('failed_deliveries.log', JSON.stringify(logEntry) + '\n');
  
  sendTransactionLog(`
🚨 <b>DELIVERY FAILED</b>

👤 <b>User ID:</b> <code>${userId}</code>
💳 <b>Charge ID:</b> <code>${chargeId}</code>
❌ <b>Error:</b> ${error.toString()}
📅 <b>Time:</b> ${new Date().toISOString()}

⚠️ <b>ACTION REQUIRED:</b> Manual refund may be needed!
Use: <code>/refund ${chargeId}</code>
`);
  
  console.error(`🚨 FAILED DELIVERY: User ${userId}, Charge ${chargeId}, Error: ${error}`);
}

// ============================================
// STAR CREDITS (7.1)
// ============================================
// A paid package is recorded here as an unclaimed credit. The app pulls it
// with GET /stars/claim-credits and applies it to the balance itself,
// because CloudStorage can only be written from the client. Flat JSON file,
// same pattern as payments.json / ton_credits.json.
const crypto = require('crypto');
const fsSync = require('fs');
const STAR_CREDITS_FILE = 'star_credits.json';

// userId -> [{ stars, chargeId, productId, createdAt, claimed }]
let starCredits = {};
try { starCredits = JSON.parse(fsSync.readFileSync(STAR_CREDITS_FILE, 'utf8')); } catch { starCredits = {}; }

let starCreditsWrite = Promise.resolve();
function persistStarCredits() {
  // Serialise writes so two payments landing together can't interleave.
  starCreditsWrite = starCreditsWrite
    .then(() => fs.writeFile(STAR_CREDITS_FILE, JSON.stringify(starCredits, null, 2)))
    .catch(err => console.error('❌ Failed to write star_credits.json:', err));
  return starCreditsWrite;
}

// Returns false if this charge was already recorded (Telegram can redeliver
// an update after a restart; the charge id makes crediting idempotent).
function recordStarCredit(userId, chargeId, productId, stars) {
  const key = String(userId);
  const list = starCredits[key] || (starCredits[key] = []);
  if (list.some(c => c.chargeId === chargeId)) return false;
  list.push({ stars, chargeId, productId, createdAt: Date.now(), claimed: false });
  return true;
}

// Verifies the raw, Telegram-signed initData string and returns the user.
// Same algorithm as gift-relayer.js. maxAgeSeconds is generous on purpose:
// a mini app can stay open for days and initData isn't refreshed while it is.
function verifyInitData(initData, botToken, maxAgeSeconds = 7 * 24 * 60 * 60) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (computed.length !== hash.length ||
      !crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hash))) return null;
  const authDate = parseInt(params.get('auth_date'), 10) || 0;
  if (Date.now() / 1000 - authDate > maxAgeSeconds) return null;
  try { return JSON.parse(params.get('user') || 'null'); } catch { return null; }
}

// ============================================
// HTTP ENDPOINTS
// ============================================

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Void Gift Bot - Invoice API',
    version: '7.1',
    uptime: Math.floor((Date.now() - STATE.serverStartTime) / 1000),
    features: ['openInvoice', 'starCredits', 'pushAnnounce']
  });
});

// 7.1: the app calls this after a payment ("paid") to collect purchased Stars.
// Header: X-Telegram-Init-Data = the raw Telegram.WebApp.initData string.
app.get('/stars/claim-credits', async (req, res) => {
  try {
    const user = verifyInitData(req.get('x-telegram-init-data'), BOT_TOKEN);
    if (!user || !user.id) return res.status(401).json({ error: 'Invalid or expired Telegram session' });

    const list = starCredits[String(user.id)] || [];
    const unclaimed = list.filter(c => !c.claimed);
    if (!unclaimed.length) return res.json({ stars: 0, claimed: [] });

    // Mark claimed synchronously (before any await) so two simultaneous
    // requests can never both receive the same credit.
    unclaimed.forEach(c => { c.claimed = true; });
    const total = unclaimed.reduce((sum, c) => sum + c.stars, 0);
    await persistStarCredits();

    await sendTransactionLog(`
📬 <b>STAR CREDITS CLAIMED</b>
━━━━━━━━━━━━━━━━━━━━

🆔 <b>User ID:</b> <code>${user.id}</code>
⭐ <b>Stars delivered:</b> ${total}
💳 <b>Charges:</b> ${unclaimed.map(c => `<code>${c.chargeId}</code>`).join(', ')}
📅 <b>Date:</b> ${new Date().toISOString()}
`);

    res.json({ stars: total, claimed: unclaimed.map(c => ({ stars: c.stars, chargeId: c.chargeId })) });
  } catch (error) {
    console.error('❌ /stars/claim-credits error:', error);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Create invoice link endpoint
app.post('/create-invoice', async (req, res) => {
  try {
    const { userId, productId } = req.body;
    
    console.log(`📱 Invoice request received:`, { userId, productId });
    
    if (!userId || !productId) {
      console.log('❌ Missing required fields');
      return res.status(400).json({ 
        error: 'Missing userId or productId',
        received: { userId, productId }
      });
    }
    
    const product = PRODUCTS[productId];
    
    if (!product) {
      console.log('❌ Invalid product:', productId);
      return res.status(400).json({ 
        error: 'Invalid product',
        productId: productId,
        availableProducts: Object.keys(PRODUCTS)
      });
    }
    
    console.log(`✅ Creating invoice for ${product.title} (${product.stars} stars)`);
    
    // Create invoice link using Bot API
    const invoiceLink = await bot.createInvoiceLink(
      product.title,                    // title
      `${product.stars} Stars for Void Gift`, // description (7.1: was "N Void Coins", which the app never credits)
      JSON.stringify({                  // payload
        product_id: productId,
        user_id: userId,
        timestamp: Date.now()
      }),
      '',                               // provider_token (empty for Stars)
      'XTR',                           // currency (Telegram Stars)
      [{
        label: `${product.stars} Stars`,
        amount: product.stars
      }],
      {
        need_name: false,
        need_phone_number: false,
        need_email: false,
        need_shipping_address: false,
        is_flexible: false
      }
    );
    
    console.log(`✅ Invoice link created successfully`);
    console.log(`🔗 Link: ${invoiceLink}`);
    
    // Log invoice creation
    await sendTransactionLog(`
📝 <b>INVOICE CREATED</b>

👤 <b>User ID:</b> <code>${userId}</code>
📦 <b>Product:</b> ${product.title}
💎 <b>Product ID:</b> <code>${productId}</code>
⭐ <b>Stars:</b> ${product.stars}
🪙 <b>Coins:</b> ${product.coins}
🔗 <b>Method:</b> openInvoice API
📅 <b>Time:</b> ${new Date().toISOString()}
`);
    
    res.json({ 
      success: true,
      invoiceLink: invoiceLink,
      product: {
        id: product.id,
        title: product.title,
        stars: product.stars,
        coins: product.coins
      }
    });
    
  } catch (error) {
    console.error('❌ Error creating invoice link:', error);
    await sendErrorLog(error, 'Create Invoice Link Endpoint');
    
    res.status(500).json({ 
      error: 'Failed to create invoice',
      message: error.message
    });
  }
});

// ============================================
// PAYMENT HANDLERS
// ============================================

// Handle pre-checkout query (user clicked PAY button)
async function handlePreCheckoutQuery(query) {
  try {
    const payload = JSON.parse(query.invoice_payload);
    const productId = payload.product_id;
    const userId = payload.user_id;
    
    console.log(`💳 Pre-checkout query from user ${query.from.id}`);
    console.log(`📦 Product ID: ${productId}`);
    console.log(`💰 Amount: ${query.total_amount} Stars`);
    
    const product = PRODUCTS[productId];
    
    if (!product) {
      await bot.answerPreCheckoutQuery(query.id, false, {
        error_message: 'Invalid product. Please contact support.'
      });
      console.log('❌ Invalid product ID in pre-checkout');
      return;
    }
    
    // Verify amount matches
    if (query.total_amount !== product.stars) {
      await bot.answerPreCheckoutQuery(query.id, false, {
        error_message: 'Price mismatch. Please contact support.'
      });
      
      console.log(`⚠️ FRAUD ALERT: Price mismatch!`);
      console.log(`Expected: ${product.stars}, Got: ${query.total_amount}`);
      
      await sendTransactionLog(
        `⚠️ <b>FRAUD ALERT:</b> Price mismatch\n` +
        `User: ${query.from.id} (@${query.from.username || 'no_username'})\n` +
        `Product: ${productId}\n` +
        `Expected: ${product.stars} stars\n` +
        `Received: ${query.total_amount} stars`
      );
      return;
    }
    
    // Store pending payment info
    STATE.pendingPayments.set(query.id, {
      userId: userId,
      productId: productId,
      timestamp: Date.now()
    });
    
    // Log pre-checkout
    await logTransactionToChannel(
      query.from.id,
      query.from.username,
      null,
      product,
      'pre_checkout'
    );
    
    // Approve payment
    await bot.answerPreCheckoutQuery(query.id, true);
    console.log(`✅ Pre-checkout approved for user ${query.from.id}`);
    
  } catch (error) {
    console.error('❌ Error in pre-checkout:', error);
    await sendErrorLog(error, 'Pre-checkout Handler');
    
    // Decline payment with error message
    await bot.answerPreCheckoutQuery(query.id, false, {
      error_message: 'An error occurred. Please try again later.'
    });
  }
}

// Handle successful payment
async function handleSuccessfulPayment(msg) {
  const payment = msg.successful_payment;
  const userId = msg.from.id;
  const userInfo = msg.from;
  
  console.log(`🎉 PAYMENT SUCCESSFUL!`);
  console.log(`👤 User: ${userId} (@${userInfo.username || 'no_username'})`);
  console.log(`💰 Amount: ${payment.total_amount} stars`);
  console.log(`💳 Charge ID: ${payment.telegram_payment_charge_id}`);
  
  try {
    // Parse payload to get product info
    const payload = JSON.parse(payment.invoice_payload);
    const productId = payload.product_id;
    const product = PRODUCTS[productId];
    
    if (!product) {
      throw new Error(`Invalid product ID: ${productId}`);
    }
    
    // Verify amount
    if (payment.total_amount !== product.stars) {
      throw new Error(
        `Amount mismatch: Expected ${product.stars}, got ${payment.total_amount}`
      );
    }
    
    console.log(`📦 Product: ${product.title}`);
    console.log(`⭐ Stars to credit: ${product.stars}`);
    
    // Save to database
    await savePaymentRecord(
      userId,
      payment.telegram_payment_charge_id,
      productId,
      product.stars,
      product.coins,
      Date.now()
    );

    // 7.1: record the Stars credit. This is the actual delivery; the app
    // collects it from /stars/claim-credits. Idempotent per charge id.
    const isNewCharge = recordStarCredit(
      userId,
      payment.telegram_payment_charge_id,
      productId,
      product.stars
    );
    if (!isNewCharge) {
      console.log(`↩️  Charge ${payment.telegram_payment_charge_id} already credited — ignoring duplicate update`);
      return;
    }
    await persistStarCredits();

    // Best-effort chat notice. It no longer decides whether delivery worked
    // (a user who blocked the bot still gets their Stars in the app).
    await notifyStarsPurchased(userId, product.stars);
    
    // Log successful transaction
    await logTransactionToChannel(
      userId,
      userInfo.username,
      payment,
      product,
      'success'
    );
    
    console.log(`✅ Payment processed successfully!`);
    console.log(`⭐ ${product.stars} Stars credited to user ${userId}`);
    
  } catch (error) {
    console.error('❌ CRITICAL ERROR processing payment:', error);
    await sendErrorLog(error, `Successful Payment - Charge: ${payment.telegram_payment_charge_id}`);
    
    // Notify user of error
    await bot.sendMessage(msg.chat.id,
      `⚠️ <b>Payment Received - Processing Issue</b>\n\n` +
      `Your payment was successful, but there was an error delivering your Stars. ` +
      `Don't worry - our team will resolve this shortly!\n\n` +
      `<b>Payment Details:</b>\n` +
      `Charge ID: <code>${payment.telegram_payment_charge_id}</code>\n` +
      `Amount: ${payment.total_amount} ⭐\n\n` +
      `Please contact support with the Charge ID above if your Stars don't arrive within 24 hours.`,
      { 
        parse_mode: 'HTML'
      }
    );
    
    // Log failed delivery for manual intervention
    logFailedDelivery(
      userId,
      payment.telegram_payment_charge_id,
      error
    );
  }
}

// ============================================
// BOT COMMANDS
// ============================================

bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  
  const helpText = `
🤖 <b>Bot Commands:</b>

<b>Game Commands:</b>
/start - Open the mini app

<b>Payment System:</b>
✅ Direct invoice opening with openInvoice()
✅ Invoice appears as popup in Mini App
✅ NO chat redirect needed
✅ Stays in Mini App during payment
✅ Automatic coin delivery via Cloud Storage
✅ 13 coin packages available
✅ Transaction logging

<b>How Payments Work:</b>
1. User clicks "Purchase" in Mini App
2. Invoice popup appears INSTANTLY
3. User pays with Stars (stays in app!)
4. Coins auto-added via Cloud Storage
5. Balance updates immediately!

<b>Technical:</b>
- 🌐 HTTP Server: Port ${HTTP_PORT}
- 🔗 Endpoint: POST /create-invoice
- 📱 Method: Telegram.WebApp.openInvoice()
- ☁️ Storage: CloudStorage API
- 📊 Logging: Enabled

<b>Features:</b>
- 📝 Detailed transaction logs
- 💰 Secure Star payments
  `.trim();
  
  await bot.sendMessage(chatId, helpText, { parse_mode: 'HTML' });
});

// ============================================
// EVENT LISTENERS
// ============================================

bot.on('pre_checkout_query', handlePreCheckoutQuery);
bot.on('successful_payment', handleSuccessfulPayment);

// ============================================
// ERROR HANDLING
// ============================================

process.on('uncaughtException', async (error) => {
  console.error('Uncaught Exception:', error);
  await sendErrorLog(error, 'Uncaught Exception');
});

process.on('unhandledRejection', async (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  await sendErrorLog(new Error(String(reason)), 'Unhandled Rejection');
});

// ============================================
// PERIODIC TASKS
// ============================================

// NOTE: this used to delete anyone inactive for 24h from STATE.userSessions,
// which silently shrank the /pushAnnounce list to "active today" instead of
// "everyone who ever used the bot". Removed — users.json (via
// loadUsersIntoState) is now the source of truth for who gets broadcasts,
// and pruning should only happen on an actual 403 (user blocked the bot),
// which pushAnnounceHandler already does.

// ============================================
// STARTUP
// ============================================

async function startBot() {
  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log('🚀 VOID GIFT BOT - PAYMENT SYSTEM V7.0');
  console.log('═══════════════════════════════════════════');
  console.log('');
  console.log('✅ Bot started successfully!');
  console.log('🌐 Web App URL:', WEB_APP_URL);
  console.log('💰 Payment System: Telegram Stars (openInvoice)');
  console.log('📦 Available Packages: 13');
  console.log('📝 Transaction Logging: Enabled');
  console.log('');
  console.log('🆕 NEW PAYMENT FLOW:');
  console.log('   1. User clicks Purchase in Mini App');
  console.log('   2. WebApp calls POST /create-invoice');
  console.log('   3. Bot creates invoice link');
  console.log('   4. WebApp opens invoice with openInvoice()');
  console.log('   5. Invoice appears as POPUP in Mini App');
  console.log('   6. User pays (STAYS IN APP!)');
  console.log('   7. Coins auto-delivered via Cloud Storage');
  console.log('   ✨ NO chat redirect - seamless UX!');
  console.log('');
  
  // Start HTTP server
  app.listen(HTTP_PORT, () => {
    console.log(`🌐 HTTP Server running on port ${HTTP_PORT}`);
    console.log(`🔗 Invoice endpoint: POST http://localhost:${HTTP_PORT}/create-invoice`);
    console.log('');
  });
  
  console.log('═══════════════════════════════════════════');
  console.log('🎮 BOT IS READY - Waiting for requests...');
  console.log('═══════════════════════════════════════════');
  console.log('');
}

startBot().catch(error => {
  console.error('❌ Failed to start bot:', error);
  process.exit(1);
});
