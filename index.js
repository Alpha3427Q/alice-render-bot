const { Client, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const express = require('express');
const QRCode = require('qrcode');
const axios = require('axios');
const fs = require('fs'); // 🛠️ FIX: Import File System
const app = express();

// --- CONFIGURATION ---
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const N8N_WEBHOOK = process.env.N8N_WEBHOOK;
const QR_PASSWORD = process.env.QR_PASSWORD || "agartha_secret";
const CLIENT_ID = "Alice_Fresh_V1";
const BOOT_TIMESTAMP = Math.floor(Date.now() / 1000);

let client;
let currentQR = null;
let isSessionFound = false;

app.get('/', (req, res) => res.send("<html><body><h1>🟢 Alice Smart Forwarder</h1></body></html>"));

// --- DATABASE & INITIALIZATION ---
mongoose.connect(MONGO_URI).then(async () => {
    console.log('✅ Connected to MongoDB');

    const db = mongoose.connection.db;
    const bucketCheck = await db.listCollections({ name: `whatsapp-RemoteAuth-${CLIENT_ID}.files` }).toArray();

    if (bucketCheck.length > 0) {
        console.log(`🎉 FOUND EXISTING CREDENTIALS`);
        isSessionFound = true;
    } else {
        console.log(`⚠️ NO CREDENTIALS FOUND. Scan QR.`);
        isSessionFound = false;
    }

    // 🛠️ FIX: Manually create the auth folder to prevent ENOENT crash
    const AUTH_DIR = './.wwebjs_auth';
    if (!fs.existsSync(AUTH_DIR)){
        fs.mkdirSync(AUTH_DIR);
        console.log("📂 Created missing auth directory.");
    }

    const store = new MongoStore({ mongoose: mongoose });

    client = new Client({
        authStrategy: new RemoteAuth({
            clientId: CLIENT_ID,
            store: store,
            dataPath: AUTH_DIR, // 🛠️ FIX: Explicitly set the path
            backupSyncIntervalMs: 60000
        }),
        puppeteer: {
            executablePath: '/usr/bin/google-chrome-stable',
            headless: true,
            args: [
                '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
                '--single-process', '--disable-gpu', '--disable-extensions',
                '--mute-audio', '--disable-features=site-per-process',
                '--window-size=800,600'
            ],
            timeout: 60000
        }
    });

    client.on('qr', (qr) => { console.log("📌 QR Generated"); currentQR = qr; });
    client.on('ready', () => { console.log('🚀 Ready!'); currentQR = "connected"; });

    // --- INBOUND MESSAGES ---
    client.on('message', async (msg) => {
        if (msg.from === 'status@broadcast' || msg.isStatus) return;
        if (msg.timestamp < BOOT_TIMESTAMP) return;

        if (!N8N_WEBHOOK) return;
        if (global.gc) global.gc();

        let realNumberId = msg.from;
        let displayName = msg._data.notifyName || "Unknown";
        let publicPushname = msg._data.notifyName || "Unknown";

        try {
            const contact = await msg.getContact();
            if (contact) {
                if (contact.number) realNumberId = contact.number + "@c.us";
                if (contact.pushname) publicPushname = contact.pushname;
                displayName = contact.name || contact.pushname || displayName;
            }
        } catch (e) { console.log("⚠️ Contact lookup failed"); }

        console.log(`📩 Resolved: ${displayName} (${realNumberId})`);

        try {
            const chat = await msg.getChat();
            await chat.clearState();
            await chat.sendSeen().catch(() => {});
            await new Promise(r => setTimeout(r, 300));
            await chat.sendStateTyping();
        } catch (e) {}

        let attachment = null;
        if (msg.hasMedia) {
            try {
                const media = await msg.downloadMedia();
                if(media) attachment = { mimetype: media.mimetype, data: media.data, filename: media.filename || "file" };
            } catch (err) {}
        }

        try {
            await axios.post(N8N_WEBHOOK, {
                from: realNumberId,
                original_id: msg.from,
                body: msg.body,
                name: displayName,
                username: publicPushname,
                timestamp: msg.timestamp,
                attachment: attachment
            });
        } catch(e) { console.error("Webhook Error:", e.message); }
    });

    client.initialize();
});

// --- API (OUTBOUND) ---
app.post('/send', async (req, res) => {
    if(req.headers['authorization'] !== `Bearer ${QR_PASSWORD}`) return res.status(401).json({error: "Unauthorized"});
    let { number, message, attachment } = req.body;
    req.body = null;

    if (!number) return res.status(400).json({error: "No number provided"});

    const chatId = number.includes('@') ? number : number.replace('+', '') + "@c.us";

    try {
        const chat = await client.getChatById(chatId);
        await chat.sendStateTyping();
        await new Promise(resolve => setTimeout(resolve, 1000));

        if (attachment && attachment.data) {
            let media = new MessageMedia(attachment.mimetype, attachment.data, attachment.filename);
            await client.sendMessage(chatId, media, { caption: message || "" });
        } else {
            await client.sendMessage(chatId, message);
        }

        await chat.clearState();
        res.json({status: "sent"});
    } catch(e) {
        console.error("❌ Send Error:", e.message);
        res.status(500).json({error: e.toString()});
    } finally {
        if (global.gc) global.gc();
    }
});

app.get('/connect', async (req, res) => {
    if(req.query.password !== QR_PASSWORD) return res.status(403).send("⛔");
    if(currentQR === "connected") return res.send("✅ Connected");
    if(!currentQR) return res.send("⏳ Booting...");
    const qrImage = await QRCode.toDataURL(currentQR);
    res.send(`<img src="${qrImage}" />`);
});

app.listen(PORT, () => console.log(`Server live on port ${PORT}`));
