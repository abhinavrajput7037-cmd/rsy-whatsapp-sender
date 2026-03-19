const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const qrcode  = require('qrcode');

const app = express();
app.use(express.json());

const PORT       = process.env.PORT       || 3000;
const API_SECRET = process.env.API_SECRET || 'rsybattle_wa_2024';

let clientReady = false;
let qrCodeData  = null;
let lastQrTime  = null;

// ══════════════════════════════════════
// WhatsApp Client
// ══════════════════════════════════════
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '/tmp/wwebjs_auth' }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ]
    }
});

client.on('qr', async (qr) => {
    console.log('QR Code ready — scan karo!');
    lastQrTime = new Date().toISOString();
    try { qrCodeData = await qrcode.toDataURL(qr); } catch(e) { qrCodeData = null; }
    clientReady = false;
});

client.on('ready', () => {
    console.log('WhatsApp connected!');
    clientReady = true;
    qrCodeData  = null;
});

client.on('disconnected', (reason) => {
    console.log('Disconnected:', reason);
    clientReady = false;
});

client.on('auth_failure', () => {
    console.log('Auth failed — rescan QR!');
    clientReady = false;
});

client.initialize().catch(err => console.error('Init error:', err.message));

// ══════════════════════════════════════
// Helpers
// ══════════════════════════════════════
function formatNumber(mobile) {
    let num = String(mobile).replace(/\D/g, '');
    if (num.startsWith('0')) num = num.slice(1);
    if (!num.startsWith('91') && num.length === 10) num = '91' + num;
    return num + '@c.us';
}

function buildMessage(data) {
    const { method, amount, code, pin, name } = data;
    const greeting = name ? `Hii *${name}*! 👋` : 'Hii! 👋';
    const footer   = `\n\n🎮 *RSY Battle* — Keep Playing, Keep Winning!\n_rsybattle.xyz_`;
    const divider  = '\n━━━━━━━━━━━━━━━━\n';

    if (method === 'amazon') {
        return `🎉 *Withdrawal Successful!*\n\n${greeting}\n\nTumhara *₹${amount}* ka *Amazon Gift Card* ready hai!${divider}📦 *AMAZON GIFT CARD CODE*\n\`\`\`${code}\`\`\`${pin ? `\n\n🔑 *PIN Code:*\n\`\`\`${pin}\`\`\`` : ''}${divider}📌 *Kaise use karein:*\nAmazon.in → Gift Cards → _Redeem a Gift Card_${footer}`;
    }
    if (method === 'flipkart') {
        return `🎉 *Withdrawal Successful!*\n\n${greeting}\n\nTumhara *₹${amount}* ka *Flipkart Gift Card* ready hai!${divider}🛍️ *FLIPKART GIFT CARD CODE*\n\`\`\`${code}\`\`\`${pin ? `\n\n🔑 *PIN Code:*\n\`\`\`${pin}\`\`\`` : ''}${divider}📌 *Kaise use karein:*\nFlipkart App → Gift Cards → _Redeem_${footer}`;
    }
    if (method === 'redeem') {
        return `🎉 *Withdrawal Successful!*\n\n${greeting}\n\nTumhara *₹${amount}* ka *Google Play Redeem Code* ready hai!${divider}🎮 *REDEEM CODE*\n\`\`\`${code}\`\`\`${pin ? `\n\n🔑 *PIN Code:*\n\`\`\`${pin}\`\`\`` : ''}${divider}📌 *Kaise use karein:*\nGoogle Play Store → _Redeem_${footer}`;
    }

    // Bank / UPI / PhonePe — success confirmation
    const methodLabel = method === 'upi'     ? '💳 UPI Transfer'
                      : method === 'phonepe' ? '📱 PhonePe'
                      : method === 'bank'    ? '🏦 Bank Transfer'
                      : '💰 Wallet';
    return `✅ *Withdrawal Successful!*\n\n${greeting}\n\nTumhara *₹${amount}* withdrawal process ho gaya hai!${divider}${methodLabel}\n💸 Amount: *₹${amount}*\n📋 Status: *Approved ✅*${divider}Paise 24 hours mein account mein aa jaayenge.${footer}`;
}

// ══════════════════════════════════════
// Routes
// ══════════════════════════════════════

app.get('/', (req, res) => {
    res.json({
        service : 'RSY Battle WhatsApp Sender',
        status  : clientReady ? 'connected' : 'disconnected',
        qr      : !!qrCodeData
    });
});

app.get('/qr', (req, res) => {
    if (clientReady) {
        return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0d0f1a;color:#fff;">
            <h2 style="color:#00c853;">WhatsApp Connected!</h2>
            <p style="color:#9ba3c8;">RSY Battle WhatsApp sender active hai.</p>
        </body></html>`);
    }
    if (!qrCodeData) {
        return res.send(`<html><head><meta http-equiv="refresh" content="4"></head>
            <body style="font-family:sans-serif;text-align:center;padding:40px;background:#0d0f1a;color:#fff;">
            <h2 style="color:#ffab00;">QR generate ho raha hai...</h2>
            <p style="color:#9ba3c8;">Page 4 sec mein auto-refresh hoga.</p>
        </body></html>`);
    }
    res.send(`<html>
        <head><meta http-equiv="refresh" content="28"></head>
        <body style="font-family:sans-serif;text-align:center;padding:30px;background:#0d0f1a;color:#fff;">
            <h2 style="color:#e91e8c;">RSY Battle — WhatsApp Connect</h2>
            <p style="color:#9ba3c8;margin-bottom:20px;">WhatsApp → Linked Devices → Link a Device → Yeh QR scan karo</p>
            <img src="${qrCodeData}" style="border-radius:16px;border:3px solid #e91e8c;max-width:260px;"/>
            <p style="font-size:12px;color:#5e6891;margin-top:14px;">QR 30 sec mein expire hota hai. Page auto-refresh ho raha hai.</p>
        </body>
    </html>`);
});

// Main send endpoint
app.post('/send', async (req, res) => {
    const secret = req.headers['x-api-secret'] || req.body.secret;
    if (secret !== API_SECRET) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    if (!clientReady) {
        return res.status(503).json({ success: false, error: 'WhatsApp not connected. Visit /qr to scan.' });
    }

    const { mobile, method, amount, code, pin, name } = req.body;
    if (!mobile) {
        return res.status(400).json({ success: false, error: 'mobile required' });
    }

    const chatId  = formatNumber(mobile);
    const message = buildMessage({ method: method || 'redeem', amount, code, pin, name });

    try {
        await client.sendMessage(chatId, message);
        console.log(`Sent to ${mobile} | method:${method} | amount:${amount}`);
        res.json({ success: true, message: 'WhatsApp message sent!', to: mobile });
    } catch (err) {
        console.error(`Error sending to ${mobile}:`, err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Test endpoint
app.post('/test', async (req, res) => {
    const secret = req.headers['x-api-secret'] || req.body.secret;
    if (secret !== API_SECRET) return res.status(401).json({ success: false });
    if (!clientReady) return res.json({ success: false, error: 'Not connected — scan /qr first' });

    const { mobile } = req.body;
    if (!mobile) return res.status(400).json({ success: false, error: 'mobile required' });

    try {
        await client.sendMessage(
            formatNumber(mobile),
            `✅ *RSY Battle* — WhatsApp test successful! 🎮\n\nYeh message automatically bheja gaya. Sab kuch sahi kaam kar raha hai!`
        );
        res.json({ success: true, message: 'Test sent!' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(PORT, () => console.log(`RSY Battle WA Sender running on port ${PORT}`));
