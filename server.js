const express = require('express');
const cors = require('cors');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const QRCode = require('qrcode');
const P = require('pino');

// ─────────────────────────────────────────
// Firebase Admin Init
// ─────────────────────────────────────────
const firebaseConfig = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(firebaseConfig) });
const db = getFirestore();

// ─────────────────────────────────────────
// App Setup
// ─────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

let sock = null;
let isReady = false;
let qrBase64 = null;
let initAttempts = 0;
const MAX_RETRIES = 5;

// ─────────────────────────────────────────
// Firebase Auth State Store (Baileys)
// ─────────────────────────────────────────
async function useFirebaseAuthState() {
    const col = db.collection('rsybattle_wa_auth');

    const readData = async (key) => {
        try {
            const doc = await col.doc(key.replace(/\//g, '_')).get();
            return doc.exists ? JSON.parse(doc.data().value) : undefined;
        } catch { return undefined; }
    };

    const writeData = async (key, value) => {
        try {
            await col.doc(key.replace(/\//g, '_')).set({
                value: JSON.stringify(value, null, 0),
                updatedAt: new Date()
            });
        } catch (e) { console.error('Auth write error:', e.message); }
    };

    const removeData = async (key) => {
        try {
            await col.doc(key.replace(/\//g, '_')).delete();
        } catch {}
    };

    // Load existing creds
    let creds = await readData('creds');

    const { default: makeWASocket, initAuthCreds, BufferJSON, proto } = await import('@whiskeysockets/baileys');

    if (!creds) {
        creds = initAuthCreds();
    }

    const keys = {};

    const state = {
        creds,
        keys: {
            get: async (type, ids) => {
                const data = {};
                for (const id of ids) {
                    let value = keys[`${type}-${id}`];
                    if (!value) {
                        value = await readData(`keys_${type}_${id}`);
                        if (value) keys[`${type}-${id}`] = value;
                    }
                    if (value) {
                        if (type === 'app-state-sync-key') {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }
                }
                return data;
            },
            set: async (data) => {
                const tasks = [];
                for (const category in data) {
                    for (const id in data[category]) {
                        const value = data[category][id];
                        const key = `${category}-${id}`;
                        keys[key] = value;
                        if (value) {
                            tasks.push(writeData(`keys_${category}_${id}`, value));
                        } else {
                            tasks.push(removeData(`keys_${category}_${id}`));
                        }
                    }
                }
                await Promise.all(tasks);
            }
        }
    };

    const saveCreds = async () => {
        await writeData('creds', state.creds);
    };

    return { state, saveCreds, makeWASocket };
}

// ─────────────────────────────────────────
// WhatsApp Init (Baileys)
// ─────────────────────────────────────────
async function initWhatsApp() {
    if (initAttempts >= MAX_RETRIES) {
        console.error(`❌ Max retries (${MAX_RETRIES}) reached. Manual restart needed.`);
        return;
    }
    initAttempts++;
    console.log(`🔄 WhatsApp Baileys init attempt #${initAttempts}`);

    isReady = false;
    qrBase64 = null;

    try {
        const { state, saveCreds, makeWASocket } = await useFirebaseAuthState();
        const { default: makeWASocketReal } = await import('@whiskeysockets/baileys');

        sock = makeWASocketReal({
            auth: state,
            printQRInTerminal: false,
            logger: P({ level: 'silent' }),
            browser: ['RSY Battle', 'Chrome', '110.0.0'],
            connectTimeoutMs: 60000,
            retryRequestDelayMs: 2000,
            maxMsgRetryCount: 3,
            generateHighQualityLinkPreview: false,
            syncFullHistory: false,
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('📱 QR Code ready — /qr page pe jaao!');
                try {
                    qrBase64 = await QRCode.toDataURL(qr);
                } catch (e) {
                    console.error('QR gen error:', e.message);
                }
            }

            if (connection === 'open') {
                console.log('✅ WhatsApp CONNECTED! 24/7 active.');
                isReady = true;
                qrBase64 = null;
                initAttempts = 0;
            }

            if (connection === 'close') {
                isReady = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const { default: boom } = await import('@hapi/boom');
                const { DisconnectReason } = await import('@whiskeysockets/baileys');
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                console.log(`⚡ Disconnected (code: ${statusCode}), reconnect: ${shouldReconnect}`);

                if (shouldReconnect) {
                    setTimeout(() => initWhatsApp(), 5000);
                } else {
                    console.log('🔴 Logged out — Firebase auth clear ho raha hai...');
                    // Clear auth from Firebase so fresh QR shows
                    try {
                        const snap = await db.collection('rsybattle_wa_auth').get();
                        const batch = db.batch();
                        snap.docs.forEach(doc => batch.delete(doc.ref));
                        await batch.commit();
                        console.log('🗑️ Auth cleared. Restart karo ya wait karo...');
                    } catch (e) {
                        console.error('Auth clear error:', e.message);
                    }
                    setTimeout(() => initWhatsApp(), 10000);
                }
            }
        });

        sock.ev.on('messages.upsert', () => {}); // Required to keep connection alive

    } catch (err) {
        console.error('❌ Init error:', err.message);
        setTimeout(() => initWhatsApp(), 15000);
    }
}

initWhatsApp();

// ─────────────────────────────────────────
// OTP Store (Firebase, 5 min TTL)
// ─────────────────────────────────────────
async function saveOTP(mobile, otp) {
    await db.collection('rsybattle_otps').doc(mobile).set({
        otp,
        expires: Date.now() + 5 * 60 * 1000,
        createdAt: new Date()
    });
}

async function getOTP(mobile) {
    const doc = await db.collection('rsybattle_otps').doc(mobile).get();
    return doc.exists ? doc.data() : null;
}

async function deleteOTP(mobile) {
    await db.collection('rsybattle_otps').doc(mobile).delete();
}

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// ─────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({
        app: 'RSY Battle WhatsApp OTP Server',
        status: isReady ? '✅ Connected' : '⏳ Not connected',
        hasQR: !!qrBase64,
        time: new Date().toISOString()
    });
});

// Admin QR page
app.get('/qr', (req, res) => {
    if (isReady) {
        return res.send(`<!DOCTYPE html><html><body style="background:#111;color:#25D366;font-family:sans-serif;text-align:center;padding:40px;">
            <h2>✅ WhatsApp Already Connected!</h2>
            <p>OTP server 24/7 active hai. Koi action needed nahi.</p>
            <p style="color:#888;font-size:.85rem;">Auto-refresh in 30s</p>
            <script>setTimeout(()=>location.reload(),30000)</script>
        </body></html>`);
    }
    if (qrBase64) {
        return res.send(`<!DOCTYPE html><html><body style="background:#111;color:#fff;font-family:sans-serif;text-align:center;padding:40px;">
            <h2 style="color:#25D366;">📱 Scan WhatsApp QR Code</h2>
            <p style="color:#aaa;">WhatsApp → Linked Devices → Link a Device → Scan this QR</p>
            <br>
            <img src="${qrBase64}" style="width:280px;height:280px;border:4px solid #25D366;border-radius:12px;">
            <br><br>
            <p style="color:#888;">⚡ Ek baar scan karo — session Firebase mein save ho jaayega</p>
            <p style="color:#888;">Next time automatically connect ho jaayega!</p>
            <br>
            <button onclick="location.reload()" style="background:#25D366;border:none;color:#fff;padding:12px 24px;border-radius:8px;font-size:1rem;cursor:pointer;">🔄 Refresh</button>
            <p style="color:#888;font-size:.85rem;margin-top:10px;">Auto refreshes in 20 seconds</p>
            <script>setTimeout(()=>location.reload(),20000)</script>
        </body></html>`);
    }
    return res.send(`<!DOCTYPE html><html><body style="background:#111;color:#fff;font-family:sans-serif;text-align:center;padding:40px;">
        <h2>⏳ QR Code Generate ho raha hai...</h2>
        <p style="color:#aaa;">Kripya 30-60 seconds wait karo aur refresh karo.</p>
        <br>
        <button onclick="location.reload()" style="background:#1A6FE8;border:none;color:#fff;padding:12px 24px;border-radius:8px;font-size:1rem;cursor:pointer;">🔄 Refresh</button>
        <script>setTimeout(()=>location.reload(),15000)</script>
    </body></html>`);
});

app.get('/status', (req, res) => {
    res.json({
        connected: isReady,
        hasQR: !!qrBase64,
        time: new Date().toISOString()
    });
});

// Send OTP
app.post('/send-otp', async (req, res) => {
    const { mobile } = req.body;
    if (!mobile || !/^[0-9]{10}$/.test(mobile)) {
        return res.status(400).json({ success: false, message: 'Valid 10-digit mobile number required' });
    }
    if (!isReady) {
        return res.status(503).json({ success: false, message: 'WhatsApp connected nahi hai. Admin please /qr page pe jaake QR scan karo.' });
    }

    const otp = generateOTP();

    try {
        await saveOTP(mobile, otp);
    } catch (e) {
        console.error('OTP save error:', e.message);
        return res.status(500).json({ success: false, message: 'Server error. Try again.' });
    }

    const jid = '91' + mobile + '@s.whatsapp.net'; // Baileys format
    const message =
        `🎮 *RSY Battle - OTP Verification*\n\n` +
        `Aapka OTP hai: *${otp}*\n\n` +
        `⏱ Yeh OTP sirf *5 minute* ke liye valid hai.\n\n` +
        `⚠️ Yeh OTP kisi ke saath share mat karo.\n\n` +
        `— RSY Battle Team`;

    try {
        await sock.sendMessage(jid, { text: message });
        console.log(`✅ OTP sent to ${mobile}: ${otp}`);
        res.json({ success: true, message: 'OTP WhatsApp pe send ho gaya! ✅' });
    } catch (err) {
        console.error('❌ Send error:', err.message);
        await deleteOTP(mobile).catch(() => {});
        res.status(500).json({ success: false, message: 'Message send nahi hua. Number pe WhatsApp hai?' });
    }
});

// Verify OTP
app.post('/verify-otp', async (req, res) => {
    const { mobile, otp } = req.body;
    if (!mobile || !otp) {
        return res.status(400).json({ success: false, message: 'Mobile aur OTP dono zaroori hain' });
    }

    let data;
    try {
        data = await getOTP(mobile);
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Server error. Try again.' });
    }

    if (!data) return res.status(400).json({ success: false, message: 'OTP nahi mila. Pehle OTP send karo.' });
    if (Date.now() > data.expires) {
        await deleteOTP(mobile).catch(() => {});
        return res.status(400).json({ success: false, message: 'OTP expire ho gaya. Dobara try karo.' });
    }
    if (data.otp !== String(otp).trim()) {
        return res.status(400).json({ success: false, message: 'Galat OTP. Dobara check karo.' });
    }

    await deleteOTP(mobile).catch(() => {});
    res.json({ success: true, message: 'OTP verify ho gaya! ✅' });
});

// ─────────────────────────────────────────
// Self-ping every 14 minutes (Render free plan sleep prevention)
// ─────────────────────────────────────────
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || '';
if (RENDER_URL) {
    setInterval(async () => {
        try {
            const response = await fetch(RENDER_URL + '/status');
            const data = await response.json();
            console.log('🏓 Self-ping OK:', data.connected ? 'Connected' : 'Not connected');
        } catch (e) {
            console.log('⚠️ Self-ping failed:', e.message);
        }
    }, 14 * 60 * 1000);
    console.log('🏓 Self-ping enabled for:', RENDER_URL);
}

// ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 RSY Battle OTP Server running on port ${PORT}`));
