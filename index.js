const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode');
const P = require('pino');
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, get, set, remove } = require('firebase/database');

// ── Firebase init ──
const firebaseApp = initializeApp({ databaseURL: process.env.FIREBASE_DB_URL || 'https://rsy-battle-default-rtdb.firebaseio.com' });
const db = getDatabase(firebaseApp);

// ── Firebase Auth State ──
async function useFirebaseAuthState() {
    const credsRef = ref(db, 'wa_session/creds');
    const keysRef  = ref(db, 'wa_session/keys');

    const readData = async (r) => {
        const snap = await get(r);
        if (!snap.exists()) return null;
        try { return JSON.parse(snap.val(), BufferJSON.reviver); } catch { return null; }
    };

    let creds = (await readData(credsRef)) || initAuthCreds();

    const keys = {
        get: async (type, ids) => {
            const data = {};
            const snap = await get(keysRef);
            const stored = snap.exists() ? JSON.parse(snap.val(), BufferJSON.reviver) : {};
            for (const id of ids) {
                let val = stored[type]?.[id];
                if (type === 'app-state-sync-key' && val) val = proto.Message.AppStateSyncKeyData.fromObject(val);
                data[id] = val;
            }
            return data;
        },
        set: async (data) => {
            const snap = await get(keysRef);
            const stored = snap.exists() ? JSON.parse(snap.val(), BufferJSON.reviver) : {};
            for (const category in data) {
                stored[category] = stored[category] || {};
                for (const id in data[category]) {
                    const val = data[category][id];
                    if (val) stored[category][id] = val;
                    else delete stored[category][id];
                }
            }
            await set(keysRef, JSON.stringify(stored, BufferJSON.replacer));
        }
    };

    return {
        state: { creds, keys },
        saveCreds: async () => {
            await set(credsRef, JSON.stringify(creds, BufferJSON.replacer));
        }
    };
}

const app = express();
app.use(express.json());

// ── CORS ──
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Secret');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || 'rsybattle_wa_2024';

let sock = null;
let clientReady = false;
let qrCodeData = null;
let isConnecting = false;
const logger = P({ level: 'silent' });

async function startWhatsApp() {
    if (isConnecting) return;
    isConnecting = true;
    try {
        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useFirebaseAuthState();

        sock = makeWASocket({
            version,
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
            printQRInTerminal: true,
            logger,
            browser: ['RSY Battle', 'Chrome', '120.0.0'],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
            retryRequestDelayMs: 2000,
            getMessage: async () => ({ conversation: '' }),
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                clientReady = false;
                try { qrCodeData = await qrcode.toDataURL(qr); } catch(e) {}
            }
            if (connection === 'open') {
                console.log('WhatsApp connected!');
                clientReady = true;
                qrCodeData = null;
                isConnecting = false;
            }
            if (connection === 'close') {
                clientReady = false;
                isConnecting = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) {
                    setTimeout(startWhatsApp, 5000);
                } else {
                    await remove(ref(db, 'wa_session'));
                    console.log('Logged out — session cleared');
                }
            }
        });
    } catch (err) {
        console.error('startWhatsApp error:', err.message);
        isConnecting = false;
        setTimeout(startWhatsApp, 5000);
    }
}

startWhatsApp();

function formatNumber(mobile) {
    let num = String(mobile).replace(/\D/g, '');
    if (num.startsWith('0')) num = num.slice(1);
    if (!num.startsWith('91') && num.length === 10) num = '91' + num;
    return num + '@s.whatsapp.net';
}

function buildMessage(data) {
    const { method, amount, code, pin, name } = data;
    const greeting = name ? `Hii *${name}*! 👋` : 'Hii! 👋';
    const footer = `\n\n🎮 *RSY Battle* — Keep Playing, Keep Winning!\n_rsybattle.xyz_`;
    const divider = '\n━━━━━━━━━━━━━━━━\n';
    if (method === 'amazon') return `🎉 *Withdrawal Successful!*\n\n${greeting}\n\nTumhara *₹${amount}* ka *Amazon Gift Card* ready hai!${divider}📦 *AMAZON GIFT CARD CODE*\n\`\`\`${code}\`\`\`${pin ? `\n\n🔑 *PIN:* \`\`\`${pin}\`\`\`` : ''}${divider}📌 Amazon.in → Gift Cards → Redeem a Gift Card${footer}`;
    if (method === 'flipkart') return `🎉 *Withdrawal Successful!*\n\n${greeting}\n\nTumhara *₹${amount}* ka *Flipkart Gift Card* ready hai!${divider}🛍️ *FLIPKART GIFT CARD CODE*\n\`\`\`${code}\`\`\`${pin ? `\n\n🔑 *PIN:* \`\`\`${pin}\`\`\`` : ''}${divider}📌 Flipkart App → Gift Cards → Redeem${footer}`;
    if (method === 'redeem') return `🎉 *Withdrawal Successful!*\n\n${greeting}\n\nTumhara *₹${amount}* ka *Google Play Redeem Code* ready hai!${divider}🎮 *REDEEM CODE*\n\`\`\`${code}\`\`\`${pin ? `\n\n🔑 *PIN:* \`\`\`${pin}\`\`\`` : ''}${divider}📌 Google Play Store → Redeem${footer}`;
    const methodLabel = method === 'upi' ? '💳 UPI' : method === 'phonepe' ? '📱 PhonePe' : method === 'bank' ? '🏦 Bank Transfer' : '💰 Wallet';
    return `✅ *Withdrawal Successful!*\n\n${greeting}\n\nTumhara *₹${amount}* withdrawal process ho gaya!${divider}${methodLabel}\n💸 Amount: *₹${amount}*\n📋 Status: *Approved ✅*${divider}Paise 24 hours mein aa jaayenge.${footer}`;
}

app.get('/', (req, res) => res.json({ service: 'RSY Battle WA Sender', status: clientReady ? 'connected' : 'disconnected', qr: !!qrCodeData }));

app.get('/qr', (req, res) => {
    if (clientReady) return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0d0f1a;color:#fff;"><h2 style="color:#00c853;">✅ WhatsApp Connected!</h2><p style="color:#9ba3c8;">RSY Battle sender active hai. Session Firebase mein saved hai — permanent!</p></body></html>`);
    if (!qrCodeData) return res.send(`<html><head><meta http-equiv="refresh" content="4"></head><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0d0f1a;color:#fff;"><h2 style="color:#ffab00;">⏳ QR generate ho raha hai...</h2><p style="color:#9ba3c8;">4 sec mein auto-refresh. Ruko thoda.</p></body></html>`);
    res.send(`<html><head><meta http-equiv="refresh" content="28"></head><body style="font-family:sans-serif;text-align:center;padding:30px;background:#0d0f1a;color:#fff;">
        <h2 style="color:#e91e8c;">RSY Battle — WhatsApp Connect</h2>
        <p style="color:#9ba3c8;margin-bottom:20px;">WhatsApp → Linked Devices → Link a Device → Scan karo</p>
        <img src="${qrCodeData}" style="border-radius:16px;border:3px solid #e91e8c;max-width:260px;"/>
        <p style="font-size:12px;color:#5e6891;margin-top:14px;">QR 30 sec mein expire hota hai. Auto-refresh ho raha hai.</p>
    </body></html>`);
});

app.post('/send', async (req, res) => {
    const secret = req.headers['x-api-secret'] || req.body.secret;
    if (secret !== API_SECRET) return res.status(401).json({ success: false, error: 'Unauthorized' });
    if (!clientReady) return res.status(503).json({ success: false, error: 'WhatsApp not connected. Visit /qr' });
    const { mobile, method, amount, code, pin, name } = req.body;
    if (!mobile) return res.status(400).json({ success: false, error: 'mobile required' });
    try {
        await sock.sendMessage(formatNumber(mobile), { text: buildMessage({ method: method || 'redeem', amount, code, pin, name }) });
        res.json({ success: true, message: 'WhatsApp sent!', to: mobile });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/test', async (req, res) => {
    const secret = req.headers['x-api-secret'] || req.body.secret;
    if (secret !== API_SECRET) return res.status(401).json({ success: false });
    if (!clientReady) return res.json({ success: false, error: 'Not connected' });
    const { mobile } = req.body;
    if (!mobile) return res.status(400).json({ success: false, error: 'mobile required' });
    try {
        await sock.sendMessage(formatNumber(mobile), { text: `✅ *RSY Battle* — WhatsApp test successful! 🎮` });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(PORT, () => console.log(`RSY Battle WA Sender on port ${PORT}`));
