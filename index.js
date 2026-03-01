const {
    default: makeWASocket,
    DisconnectReason,
    initAuthCreds,
    BufferJSON,
    downloadMediaMessage,
    delay,
    fetchLatestWaWebVersion // Standard export for fetching the latest version
} = require('@whiskeysockets/baileys');
const mongoose = require('mongoose');
const express = require('express');
const QRCode = require('qrcode');
const axios = require('axios');
const pino = require('pino');

const app = express();

// --- CONFIGURATION ---
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const N8N_WEBHOOK = process.env.N8N_WEBHOOK;
const QR_PASSWORD = process.env.QR_PASSWORD || "agartha_secret";
const CLIENT_ID = process.env.CLIENT_ID || "Alice_Fresh_V1";
const BOOT_TIMESTAMP = Math.floor(Date.now() / 1000);

let sock;
let currentQR = null;

app.get('/', (req, res) => res.send("<html><body><h1>🟢 Alice Smart Forwarder (Baileys Engine v7)</h1></body></html>"));

// --- MONGODB AUTH STATE FOR BAILEYS ---
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

    return {
        state: {
            creds,
            keys: {
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
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
}

// --- INITIALIZATION ---
mongoose.connect(MONGO_URI).then(async () => {
    console.log('✅ Connected to MongoDB');
    startWhatsApp();
});

async function startWhatsApp() {
    const { state, saveCreds } = await useMongoDBAuthState(CLIENT_ID);

    // 🛡️ DYNAMIC VERSION FETCHING
    let waVersion = [2, 3000, 1015901307]; 
    try {
        const { version, isLatest } = await fetchLatestWaWebVersion();
        waVersion = version;
        console.log(`📡 Using WA Web v${version.join('.')}, isLatest: ${isLatest}`);
    } catch (e) {
        console.log(`⚠️ Failed to fetch latest WA version, using fallback: v${waVersion.join('.')}`);
    }

    sock = makeWASocket({
        version: waVersion,
        auth: state,
        logger: pino({ level: 'silent' }), // Keeps logs quiet for memory
        printQRInTerminal: false,
        browser: ["Alice Smart Forwarder", "Chrome", "1.0.0"],
        markOnlineOnConnect: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("📌 QR Generated");
            currentQR = qr;
        }

        if (connection === 'close') {
            currentQR = null;
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('⚠️ Connection closed. Reconnecting:', shouldReconnect);
            
            if (shouldReconnect) {
                setTimeout(() => startWhatsApp(), 3000);
            } else {
                console.log('❌ Logged out from WhatsApp. Clear MongoDB to scan new QR.');
            }
        } else if (connection === 'open') {
            console.log('🚀 Ready! Connected to WhatsApp.');
            currentQR = "connected";
        }
    });

    // --- INBOUND MESSAGES (WEBHOOK TRIGGER) ---
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;
        if (remoteJid === 'status@broadcast') return;
        if (msg.messageTimestamp < BOOT_TIMESTAMP) return; 
        if (!N8N_WEBHOOK) return;

        // Force Garbage Collection to keep RAM low
        if (global.gc) global.gc();

        // Emulate your exact old variables for n8n payload
        let realNumberId = remoteJid.replace('@s.whatsapp.net', '@c.us');
        let displayName = msg.pushName || "Unknown";
        
        // Extract text
        let body = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

        console.log(`📩 Received from: ${displayName} (${realNumberId})`);

        try {
            // Human-like behavior matching your old wwebjs script
            await sock.readMessages([msg.key]); // Send Seen
            await delay(300);
            await sock.sendPresenceUpdate('composing', remoteJid); // State Typing
            await delay(1000); 
            await sock.sendPresenceUpdate('paused', remoteJid); // Clear State
        } catch (e) {}

        // Handle Media/Attachments
        let attachment = null;
        const messageType = Object.keys(msg.message)[0];
        
        if (['imageMessage', 'videoMessage', 'documentMessage'].includes(messageType)) {
            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                const mediaMsg = msg.message[messageType];
                
                attachment = {
                    mimetype: mediaMsg.mimetype,
                    data: buffer.toString('base64'),
                    filename: mediaMsg.fileName || "file"
                };
                
                // Fallback text body to caption if no regular body exists
                if (!body) body = mediaMsg.caption || ""; 
            } catch (err) {
                console.error("⚠️ Media download failed", err.message);
            }
        }

        try {
            await axios.post(N8N_WEBHOOK, {
                from: realNumberId,
                original_id: remoteJid, // Keep the actual string for your records
                body: body,
                name: displayName,
                username: displayName,
                timestamp: msg.messageTimestamp,
                attachment: attachment
            });
        } catch(e) { 
            console.error("❌ Webhook Error:", e.message); 
        } finally {
            if (global.gc) global.gc(); // Clean up memory after webhook post
        }
    });
}

// --- API (OUTBOUND MESSAGES FROM N8N) ---
app.post('/send', async (req, res) => {
    if(req.headers['authorization'] !== `Bearer ${QR_PASSWORD}`) return res.status(401).json({error: "Unauthorized"});
    
    let { number, message, attachment } = req.body;
    req.body = null; 

    if (!number) return res.status(400).json({error: "No number provided"});

    // Format legacy n8n @c.us format back to Baileys @s.whatsapp.net format
    const jid = number.includes('@') ? number.replace('@c.us', '@s.whatsapp.net') : number.replace('+', '') + "@s.whatsapp.net";

    try {
        // Human-like typing delay
        await sock.sendPresenceUpdate('composing', jid);
        await delay(1000);

        let sendPayload = {};

        if (attachment && attachment.data) {
            const buffer = Buffer.from(attachment.data, 'base64');
            const isImage = attachment.mimetype.includes('image');
            const isVideo = attachment.mimetype.includes('video');

            if (isImage) {
                sendPayload = { image: buffer, caption: message || "", mimetype: attachment.mimetype };
            } else if (isVideo) {
                sendPayload = { video: buffer, caption: message || "", mimetype: attachment.mimetype };
            } else {
                sendPayload = { document: buffer, caption: message || "", mimetype: attachment.mimetype, fileName: attachment.filename || "document" };
            }
        } else {
            sendPayload = { text: message || "" };
        }

        await sock.sendMessage(jid, sendPayload);
        await sock.sendPresenceUpdate('paused', jid); 

        res.json({status: "sent"});
    } catch(e) {
        console.error("❌ Send Error:", e.message);
        res.status(500).json({error: e.toString()});
    } finally {
        if (global.gc) global.gc(); // Free memory immediately after sending
    }
});

app.get('/connect', async (req, res) => {
    if(req.query.password !== QR_PASSWORD) return res.status(403).send("⛔");
    if(currentQR === "connected") return res.send("✅ Connected to WhatsApp");
    if(!currentQR) return res.send("⏳ Booting or Reconnecting...");
    const qrImage = await QRCode.toDataURL(currentQR);
    res.send(`<img src="${qrImage}" />`);
});

app.listen(PORT, () => console.log(`🚀 Server live on port ${PORT}`));
