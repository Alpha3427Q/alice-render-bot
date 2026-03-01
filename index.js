const {
    default: makeWASocket,
    DisconnectReason,
    initAuthCreds,
    BufferJSON,
    downloadMediaMessage,
    delay,
    fetchLatestWaWebVersion,
    makeCacheableSignalKeyStore // 🛡️ Prevents MongoDB crash & connection loops
} = require('@whiskeysockets/baileys');
const mongoose = require('mongoose');
const express = require('express');
const QRCode = require('qrcode');
const axios = require('axios');
const pino = require('pino');

// --- HIDE NOISY LIBSIGNAL LOGS ---
const originalLog = console.log;
console.log = function() {
    if (arguments[0] && typeof arguments[0] === 'string' && arguments[0].includes('Closing session: SessionEntry')) return;
    originalLog.apply(console, arguments);
};

const app = express();

// --- CONFIGURATION ---
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const N8N_WEBHOOK = process.env.N8N_WEBHOOK;
const QR_PASSWORD = process.env.QR_PASSWORD || "agartha_secret";
const CLIENT_ID = process.env.CLIENT_ID || "Alice_Fresh_V1";

let sock;
let currentQR = null;

// Memory cache to map n8n @c.us replies back to WhatsApp @lid addresses
const jidMap = new Map();

app.get('/', (req, res) => res.send("<html><body><h1>🟢 Alice Smart Forwarder (Baileys Engine v7)</h1></body></html>"));

// --- MONGODB AUTH STATE ---
const AuthSchema = new mongoose.Schema({ _id: String, data: String }, { strict: false });
const AuthModel = mongoose.model('BaileysAuth', AuthSchema);

async function useMongoDBAuthState(collectionName) {
    const writeData = async (data, id) => {
        const info = JSON.stringify(data, BufferJSON.replacer);
        await AuthModel.updateOne({ _id: `${collectionName}-${id}` }, { data: info }, { upsert: true });
    };
    const readData = async (id) => {
        const doc = await AuthModel.findById(`${collectionName}-${id}`);
        if (doc) return JSON.parse(doc.data, BufferJSON.reviver);
        return null;
    };
    const removeData = async (id) => {
        await AuthModel.deleteOne({ _id: `${collectionName}-${id}` });
    };

    const creds = (await readData('creds')) || initAuthCreds();

    // 🛡️ RAW KEYS BEFORE CACHING
    const rawKeys = {
        get: async (type, ids) => {
            const data = {};
            await Promise.all(ids.map(async id => {
                let value = await readData(`${type}-${id}`);
                if (type === 'app-state-sync-key' && value) {
                    value = makeWASocket.authStateCreator.appStateSyncKey(value);
                }
                data[id] = value;
            }));
            return data;
        },
        set: async (data) => {
            const tasks = [];
            for (const category in data) {
                for (const id in data[category]) {
                    const value = data[category][id];
                    const name = `${category}-${id}`;
                    tasks.push(value ? writeData(value, name) : removeData(name));
                }
            }
            await Promise.all(tasks);
        }
    };

    return {
        state: {
            creds,
            // 🛡️ SHOCK ABSORBER: Caches keys in RAM to prevent DB overload during sync
            keys: makeCacheableSignalKeyStore(rawKeys, pino({ level: 'silent' })) 
        },
        saveCreds: () => writeData(creds, 'creds')
    };
}

// --- INITIALIZATION ---
mongoose.connect(MONGO_URI).then(async () => {
    originalLog('✅ Connected to MongoDB');
    startWhatsApp();
});

async function startWhatsApp() {
    const { state, saveCreds } = await useMongoDBAuthState(CLIENT_ID);

    // 🛡️ DYNAMIC VERSION FETCHING
    let waVersion = [2, 3000, 1015901307]; 
    try {
        const { version, isLatest } = await fetchLatestWaWebVersion();
        waVersion = version;
        originalLog(`📡 Using WA Web v${version.join('.')}, isLatest: ${isLatest}`);
    } catch (e) {
        originalLog(`⚠️ Failed to fetch latest WA version, using fallback: v${waVersion.join('.')}`);
    }

    sock = makeWASocket({
        version: waVersion,
        auth: state,
        logger: pino({ level: 'silent' }), // 🤫 Silent to save memory
        printQRInTerminal: false,
        browser: ["Alice Smart Forwarder", "Chrome", "1.0.0"],
        markOnlineOnConnect: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            originalLog("📌 QR Generated");
            currentQR = qr;
        }

        if (connection === 'close') {
            currentQR = null;
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            originalLog('⚠️ Connection closed due to:', lastDisconnect.error?.message || lastDisconnect.error, 'Reconnecting:', shouldReconnect);
            
            if (shouldReconnect) {
                setTimeout(() => startWhatsApp(), 3000);
            } else {
                originalLog('❌ Logged out from WhatsApp. Clear MongoDB to scan new QR.');
            }
        } else if (connection === 'open') {
            originalLog('🚀 Ready! Connected to WhatsApp.');
            currentQR = "connected";
        }
    });

    // --- INBOUND MESSAGES ---
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return; 
        
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const originalJid = msg.key.remoteJid;
        if (originalJid === 'status@broadcast') return;
        if (!N8N_WEBHOOK) return;

        // ⏱️ FILTER: Only process messages from the last 24 hours (No boot-up spam)
        const ONE_DAY_AGO = Math.floor(Date.now() / 1000) - (24 * 60 * 60);
        if (msg.messageTimestamp < ONE_DAY_AGO) return; 

        // 🧹 RAM CLEAR
        if (global.gc) global.gc();

        // 🧠 THE LID RESOLVER: Hunt down the real phone number
        let lid = originalJid.includes('@lid') ? originalJid : (msg.key.participant?.includes('@lid') ? msg.key.participant : null);
        let pn = originalJid.includes('s.whatsapp.net') ? originalJid : null;
        
        if (!pn && msg.key.remoteJidAlt?.includes('s.whatsapp.net')) pn = msg.key.remoteJidAlt;
        if (!pn && msg.key.participantAlt?.includes('s.whatsapp.net')) pn = msg.key.participantAlt;
        if (!pn && msg.key.senderPn) pn = msg.key.senderPn;
        if (!pn) pn = originalJid; 

        if (lid && pn.includes('s.whatsapp.net')) {
            const basePn = pn.split('@')[0];
            jidMap.set(basePn, lid);
        }

        let realNumberId = pn.replace(/@(s\.whatsapp\.net|lid)/, '@c.us');
        let displayName = msg.pushName || "Unknown";
        let body = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

        originalLog(`📩 Received from: ${displayName} (${realNumberId})`);

        try {
            await sock.readMessages([msg.key]); 
            await delay(300);
            await sock.sendPresenceUpdate('composing', originalJid); 
            await delay(1000); 
            await sock.sendPresenceUpdate('paused', originalJid); 
        } catch (e) {}

        let attachment = null;
        const messageType = Object.keys(msg.message)[0];
        
        // 🎙️ UPDATED: Added audioMessage to be downloaded to n8n
        if (['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage'].includes(messageType)) {
            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                const mediaMsg = msg.message[messageType];
                
                attachment = {
                    mimetype: mediaMsg.mimetype,
                    data: buffer.toString('base64'),
                    filename: mediaMsg.fileName || (messageType === 'audioMessage' ? 'audio.ogg' : 'file')
                };
                if (!body) body = mediaMsg.caption || ""; 
            } catch (err) {
                originalLog("⚠️ Media download failed", err.message);
            }
        }

        try {
            await axios.post(N8N_WEBHOOK, {
                from: realNumberId,
                original_id: originalJid, 
                body: body,
                name: displayName,
                username: displayName,
                timestamp: msg.messageTimestamp,
                attachment: attachment
            });
        } catch(e) { 
            originalLog("❌ Webhook Error:", e.message); 
        } finally {
            if (global.gc) global.gc(); 
        }
    });
}

// --- API (OUTBOUND MESSAGES FROM N8N) ---
app.post('/send', async (req, res) => {
    if(req.headers['authorization'] !== `Bearer ${QR_PASSWORD}`) return res.status(401).json({error: "Unauthorized"});
    
    let { number, message, attachment } = req.body;
    req.body = null; 

    if (!number) return res.status(400).json({error: "No number provided"});

    const baseNumber = number.replace('@c.us', '').replace('+', '');
    let jid = jidMap.has(baseNumber) ? jidMap.get(baseNumber) : baseNumber + "@s.whatsapp.net";

    try {
        let sendPayload = {};

        if (attachment && attachment.data) {
            const buffer = Buffer.from(attachment.data, 'base64');
            const isImage = attachment.mimetype.includes('image');
            const isVideo = attachment.mimetype.includes('video');
            const isAudio = attachment.mimetype.includes('audio') || attachment.mimetype.includes('ogg'); // 🎙️ Check for audio

            if (isImage) {
                sendPayload = { image: buffer, caption: message || "", mimetype: attachment.mimetype };
                await sock.sendPresenceUpdate('composing', jid);
            } else if (isVideo) {
                sendPayload = { video: buffer, caption: message || "", mimetype: attachment.mimetype };
                await sock.sendPresenceUpdate('composing', jid);
            } else if (isAudio) {
                // 🎙️ UPDATED: Send as a Voice Note (PTT)
                sendPayload = { 
                    audio: buffer, 
                    mimetype: 'audio/ogg; codecs=opus', 
                    ptt: true // This is the magic flag that makes it a voice note
                };
                await sock.sendPresenceUpdate('recording', jid); // Show "recording audio..." instead of "typing..."
            } else {
                sendPayload = { document: buffer, caption: message || "", mimetype: attachment.mimetype, fileName: attachment.filename || "document" };
                await sock.sendPresenceUpdate('composing', jid);
            }
        } else {
            sendPayload = { text: message || "" };
            await sock.sendPresenceUpdate('composing', jid);
        }

        await delay(1000); // Human-like delay

        await sock.sendMessage(jid, sendPayload);
        await sock.sendPresenceUpdate('paused', jid); 

        res.json({status: "sent"});
    } catch(e) {
        originalLog("❌ Send Error:", e.message);
        res.status(500).json({error: e.toString()});
    } finally {
        if (global.gc) global.gc(); 
    }
});

app.get('/connect', async (req, res) => {
    if(req.query.password !== QR_PASSWORD) return res.status(403).send("⛔");
    if(currentQR === "connected") return res.send("✅ Connected to WhatsApp");
    if(!currentQR) return res.send("⏳ Booting or Reconnecting...");
    const qrImage = await QRCode.toDataURL(currentQR);
    res.send(`<img src="${qrImage}" />`);
});
// --- GRACEFUL SHUTDOWN FOR RENDER DEPLOYMENTS ---
process.on('SIGTERM', () => {
    console.log('🛑 Render deployment detected! Closing old WhatsApp connection safely...');
    if (sock) {
        sock.ws.close(); 
    }
    setTimeout(() => process.exit(0), 500); 
});

app.listen(PORT, () => originalLog(`🚀 Server live on port ${PORT}`));
