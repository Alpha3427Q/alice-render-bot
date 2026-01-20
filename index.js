const { Client, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const express = require('express');
const QRCode = require('qrcode');
const axios = require('axios');
const app = express();

// --- CONFIGURATION ---
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const N8N_WEBHOOK = process.env.N8N_WEBHOOK;
const QR_PASSWORD = process.env.QR_PASSWORD || "agartha_secret";

// 🔵 PERMANENT ID
const CLIENT_ID = "Alice_Fresh_V1";
// 🕒 TIMESTAMP
const BOOT_TIMESTAMP = Math.floor(Date.now() / 1000);

let client;
let currentQR = null;
let isSessionFound = false;

app.get('/', (req, res) => res.send("<html><body><h1>🟢 Alice System Online</h1></body></html>"));

// --- DATABASE ---
mongoose.connect(MONGO_URI).then(async () => {
    console.log('✅ Connected to MongoDB');

    const db = mongoose.connection.db;
    const bucketCheck = await db.listCollections({ name: `whatsapp-RemoteAuth-${CLIENT_ID}.files` }).toArray();

    if (bucketCheck.length > 0) {
        console.log(`🎉 FOUND CREDENTIALS: "whatsapp-RemoteAuth-${CLIENT_ID}.files"`);
        isSessionFound = true;
    } else {
        console.log(`⚠️ NO CREDENTIALS FOUND. Scan QR.`);
        isSessionFound = false;
    }

    const store = new MongoStore({ mongoose: mongoose });

    client = new Client({
        authStrategy: new RemoteAuth({ 
            clientId: CLIENT_ID, 
            store: store, 
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

    client.on('qr', (qr) => { console.log("📌 QR Code Generated"); currentQR = qr; });
    client.on('ready', () => { console.log('🚀 WhatsApp Ready!'); currentQR = "connected"; });
    
    // --- INBOUND MESSAGES ---
    client.on('message', async (msg) => {
        if (msg.timestamp < BOOT_TIMESTAMP) return;
        if (!N8N_WEBHOOK) return;
        if (global.gc) global.gc();

        const cleanFrom = msg.from.includes('@c.us') ? msg.from.replace('@c.us', '') : msg.from;
        
        // 👇👇👇 NUCLEAR BLUE TICK FIX 👇👇👇
        try {
            // We force the "Seen" status using the raw Puppeteer page if the library fails
            const chat = await msg.getChat();
            
            // 1. Standard Attempt
            await chat.sendSeen().catch(() => {});
            
            // 2. Direct WWebJS Internal Call (The "Nuclear" Option)
            // This bypasses the high-level error check
            try {
                await client.pupPage.evaluate(async (chatId) => {
                    const chat = await window.Store.Chat.get(chatId);
                    if (chat) {
                        await window.Store.ReadSeen.sendSeen(chat);
                    }
                }, chat.id._serialized);
            } catch (e) {} // Ignore if even this fails

            // 3. Typing Status
            await chat.sendStateTyping(); 
            
        } catch (e) {
            console.log("⚠️ Human behavior failed");
        }
        // 👆👆👆 END FIX 👆👆👆

        let attachment = null;
        if (msg.hasMedia) {
            try {
                const media = await msg.downloadMedia();
                if(media) {
                    attachment = { mimetype: media.mimetype, data: media.data, filename: media.filename || "file" };
                }
            } catch (err) {}
        }

        console.log(`📩 New Message from ${cleanFrom}`);
        
        try {
            await axios.post(N8N_WEBHOOK, {
                from: msg.from,
                body: msg.body,
                name: msg._data.notifyName || "Unknown",
                timestamp: msg.timestamp,
                attachment: attachment
            });
        } catch(e) { console.error("Webhook Error:", e.message); }
    });

    client.initialize();
});

// --- API ---
app.get('/connect', async (req, res) => {
    if(req.query.password !== QR_PASSWORD) return res.status(403).send("⛔");
    if(currentQR === "connected") return res.send("✅ Connected");
    if(!currentQR) {
        if(isSessionFound) return res.send("⏳ Loading session...");
        return res.send("⏳ Booting...");
    }
    const qrImage = await QRCode.toDataURL(currentQR);
    res.send(`<img src="${qrImage}" />`);
});

app.post('/send', async (req, res) => {
    if(req.headers['authorization'] !== `Bearer ${QR_PASSWORD}`) return res.status(401).json({error: "Unauthorized"});
    let { number, message, attachment } = req.body;
    
    // 👇 AUTO-FIX PHONE NUMBER FORMAT 👇
    if (!number) return res.status(400).json({error: "No number"});
    
    // Removes "whatsapp.net" or weird symbols, ensures clean ID
    number = number.replace('@s.whatsapp.net', '').replace('@c.us', ''); 
    const chatId = number + "@c.us";
    
    try {
        if (attachment && attachment.data) {
            let media = new MessageMedia(attachment.mimetype, attachment.data, attachment.filename);
            await client.sendMessage(chatId, media, { caption: message || "" });
        } else {
            await client.sendMessage(chatId, message);
        }
        res.json({status: "sent"});
    } catch(e) {
        res.status(500).json({error: e.toString()});
    }
});

app.listen(PORT, () => console.log(`Server live on port ${PORT}`));
