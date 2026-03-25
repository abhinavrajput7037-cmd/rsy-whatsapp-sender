const express = require('express');
const cors = require('cors');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const QRCode = require('qrcode');
const P = require('pino');

const firebaseConfig = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(firebaseConfig) });
const db = getFirestore();

const app = express();
app.use(cors());
app.use(express.json());

let sock = null;
let isReady = false;
let qrBase64 = null;
let initAttempts = 0;
const MAX_RETRIES = 5;

async function useFirebaseAuthState(initAuthCreds, proto) {
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
                value: JSON.stringify(value),
                updatedAt: new Date()
            });
        } catch (e) { console.error('Auth write error:', e.message); }
    };

    const removeData = async (key) => {
        try { await col.doc(key.replace(/\//g, '_')).delete(); } catch {}
    };

    let creds = await readData('creds');
    if (!creds) creds = initAuthCreds();

    const keysCache = {};

    const state = {
        creds,
        keys: {
            get: async (type, ids) => {
                const data = {};
                for (const id of ids) {
                    let value = keysCache[`${type}-${id}`];
                    if (!value) {
                        value = await readData(`keys_${type}_${id}`);
                        if (value) keysCache[`${type}-${id}`] = value;
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
                        keysCache[`${category}-${id}`] = value;
                        tasks.push(value ? writeData(`keys_${category}_${id}`, value) : removeData(`keys_${category}_${id}`));
                    }
                }
                await Promise.all(tasks);
            }
        }
    };

    const saveCreds = async () => { await writeData('creds', state.creds); };
    return { state, saveCreds };
}

async function initWhatsApp() {
    if (initAttempts >= MAX_RETRIES) {
        console.error('Max retries reached.');
        return;
    }
    initAttempts++;
    console.log(`🔄 WhatsApp init attempt #${initAttempts}`);
    isReady = false;
    qrBase64 = null;

    try {
        const baileys = await import('@whiskeysockets/baileys');
        const makeWASocket = baileys.default || baileys.makeWASocket;
        const { initAuthCreds, proto, DisconnectReason, Browsers } = baileys;

        const { state, saveCreds } = await useFirebaseAuthState(initAuthCreds, proto);

        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: P({ level: 'silent' }),
            browser: Browsers.ubuntu('Chrome'),
            connectTimeoutMs: 60000,
            generateHighQualityLinkPreview: false,
            syncFullHistory: false,
            retryRequestDelayMs: 2000,
            maxMsgRetryCount: 3,
            getMessage: async () => ({ conversation: '' }),
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('📱 QR ready — visit /qr');
                try { qrBase64 = await QRCode.toDataURL(qr); } catch (e) { console.error('QR error:', e.message); }
            }

            if (connection === 'open') {
                console.log('✅ WhatsApp CONNECTED!');
                isReady = true;
                qrBase64 = null;
                initAttempts = 0;
            }

            if (connection === 'close') {
                isReady = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`⚡ Disconnected (${statusCode}), reconnect: ${shouldReconnect}`);

                if (shouldReconnect) {
                    setTimeout(() => initWhatsApp(), 5000);
                } else {
                    try {
                        const snap = await db.collection('rsybattle_wa_auth').get();
                        const batch = db.batch();
                        snap.docs.forEach(d => batch.delete(d.ref));
                        await batch.commit();
                        console.log('Auth cleared. Reconnecting...');
                    } catch (e) { console.error('Auth clear error:', e.message); }
                    setTimeout(() => initWhatsApp(), 10000);
                }
            }
        });

        sock.ev.on('messages.upsert', () => {});

    } catch (err) {
        console.error('❌ Init error:', err.message);
        setTimeout(() => initWhatsApp(), 15000);
    }
}

initWhatsApp();

async function saveOTP(mobile, otp) {
    await db.collection('rsybattle_otps').doc(mobile).set({ otp, expires: Date.now() + 5 * 60 * 1000, createdAt: new Date() });
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

app.get('/', (req, res) => res.json({ app: 'RSY Battle WhatsApp OTP Server', status: isReady ? '✅ Connected' : '⏳ Not connected', hasQR: !!qrBase64, time: new Date().toISOString() }));

app.get('/qr', (req, res) => {
    if (isReady) return res.send(`<html><body style="background:#111;color:#25D366;font-family:sans-serif;text-align:center;padding:40px;"><h2>✅ WhatsApp Connected!</h2><script>setTimeout(()=>location.reload(),30000)</script></body></html>`);
    if (qrBase64) return res.send(`<html><body style="background:#111;color:#fff;font-family:sans-serif;text-align:center;padding:40px;"><h2 style="color:#25D366;">📱 Scan WhatsApp QR</h2><p style="color:#aaa;">WhatsApp → Linked Devices → Link a Device</p><br><img src="${qrBase64}" style="width:280px;height:280px;border:4px solid #25D366;border-radius:12px;"><br><br><button onclick="location.reload()" style="background:#25D366;border:none;color:#fff;padding:12px 24px;border-radius:8px;font-size:1rem;cursor:pointer;">🔄 Refresh</button><script>setTimeout(()=>location.reload(),20000)</script></body></html>`);
    return res.send(`<html><body style="background:#111;color:#fff;font-family:sans-serif;text-align:center;padding:40px;"><h2>⏳ QR Generate ho raha hai...</h2><p>30-60 sec wait karo</p><button onclick="location.reload()" style="background:#1A6FE8;border:none;color:#fff;padding:12px 24px;border-radius:8px;font-size:1rem;cursor:pointer;">🔄 Refresh</button><script>setTimeout(()=>location.reload(),15000)</script></body></html>`);
});

app.get('/status', (req, res) => res.json({ connected: isReady, hasQR: !!qrBase64, time: new Date().toISOString() }));

app.post('/send-otp', async (req, res) => {
    const { mobile } = req.body;
    if (!mobile || !/^[0-9]{10}$/.test(mobile)) return res.status(400).json({ success: false, message: 'Valid 10-digit mobile number required' });
    if (!isReady) return res.status(503).json({ success: false, message: 'WhatsApp connected nahi hai. Admin /qr pe QR scan karo.' });

    const otp = generateOTP();
    try { await saveOTP(mobile, otp); } catch (e) { return res.status(500).json({ success: false, message: 'Server error. Try again.' }); }

    const jid = '91' + mobile + '@s.whatsapp.net';
    const message = `🎮 *RSY Battle - OTP Verification*\n\nAapka OTP hai: *${otp}*\n\n⏱ Yeh OTP sirf *5 minute* ke liye valid hai.\n\n⚠️ Yeh OTP kisi ke saath share mat karo.\n\n— RSY Battle Team`;

    try {
        await sock.sendMessage(jid, { text: message });
        console.log(`✅ OTP sent to ${mobile}`);
        res.json({ success: true, message: 'OTP WhatsApp pe send ho gaya! ✅' });
    } catch (err) {
        console.error('❌ Send error:', err.message);
        await deleteOTP(mobile).catch(() => {});
        res.status(500).json({ success: false, message: 'Message send nahi hua.' });
    }
});

app.post('/verify-otp', async (req, res) => {
    const { mobile, otp } = req.body;
    if (!mobile || !otp) return res.status(400).json({ success: false, message: 'Mobile aur OTP dono zaroori hain' });

    let data;
    try { data = await getOTP(mobile); } catch (e) { return res.status(500).json({ success: false, message: 'Server error.' }); }

    if (!data) return res.status(400).json({ success: false, message: 'OTP nahi mila. Pehle send karo.' });
    if (Date.now() > data.expires) { await deleteOTP(mobile).catch(() => {}); return res.status(400).json({ success: false, message: 'OTP expire ho gaya.' }); }
    if (data.otp !== String(otp).trim()) return res.status(400).json({ success: false, message: 'Galat OTP.' });

    await deleteOTP(mobile).catch(() => {});
    res.json({ success: true, message: 'OTP verify ho gaya! ✅' });
});

const RENDER_URL = process.env.RENDER_EXTERNAL_URL || '';
if (RENDER_URL) {
    setInterval(async () => {
        try { const r = await fetch(RENDER_URL + '/status'); const d = await r.json(); console.log('🏓 Self-ping:', d.connected ? 'Connected' : 'Not connected'); }
        catch (e) { console.log('⚠️ Self-ping failed:', e.message); }
    }, 14 * 60 * 1000);
    console.log('🏓 Self-ping enabled:', RENDER_URL);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 RSY Battle OTP Server on port ${PORT}`));
