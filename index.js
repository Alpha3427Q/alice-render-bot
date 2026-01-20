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
const CLIENT_ID = "Alice_Fresh_V1";
// 🕒 TIMESTAMP: Safety filter for old messages
const BOOT_TIMESTAMP = Math.floor(Date.now() / 1000);

let client;
let currentQR = null;
let isSessionFound = false;

app.get('/', (req, res) => res.send("<html><body><h1>🟢 Alice Smart Forwarder</h1></body></html>"));

// --- DATABASE & INITIALIZATION ---
mongoose.connect(MONGO_URI).then(async () => {
    console.log('✅ Connected to MongoDB');

    // Check for existing login file
    const db = mongoose.connection.db;
    const bucketCheck = await db.listCollections({ name: `whatsapp-RemoteAuth-${CLIENT_ID}.files` }).toArray();

    if (bucketCheck.length > 0) {
        console.log(`🎉 FOUND EXISTING CREDENTIALS`);
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

    client.on('qr', (qr) => { console.log("📌 QR Generated"); currentQR = qr; });
    client.on('ready', () => { console.log('🚀 Ready!'); currentQR = "connected"; });

    // --- INBOUND MESSAGES ---
    client.on('message', async (msg) => {
        // 1. IGNORE STATUS UPDATES (Safety First)
        if (msg.from === 'status@broadcast' || msg.isStatus) return;

        // 2. IGNORE HISTORY
        if (msg.timestamp < BOOT_TIMESTAMP) return;

        if (!N8N_WEBHOOK) return;
        if (global.gc) global.gc();

        // 3. 🔍 ID RESOLVER (THE FIX)
        // We fetch the contact info to get the REAL phone number, ignoring @lid
        let realNumberId = msg.from;
        let contactName = msg._data.notifyName || "Unknown";
        
        try {
            const contact = await msg.getContact();
            if (contact && contact.number) {
                // This converts "12345@lid" -> "919999999999@c.us"
                realNumberId = contact.number + "@c.us";
                contactName = contact.name || contact.pushname || contactName;
            }
        } catch (e) {
            console.log("⚠️ Contact lookup failed, using original ID");
        }

        console.log(`📩 Resolved ID: ${realNumberId} (was ${msg.from})`);

        // 4. BLUE TICK + TYPING (The Human Touch)
        try {
            const chat = await msg.getChat();
            await chat.clearState(); // Clear any stuck status
            
            // Send Blue Tick
            await chat.sendSeen().catch(() => {});
            
            // Wait a tiny bit (human reaction time)
            await new Promise(r => setTimeout(r, 300));
            
            // Start "Typing..." (This stays active while n8n thinks)
            await chat.sendStateTyping(); 
        } catch (e) {}

        let attachment = null;
        if (msg.hasMedia) {
            try {
                const media = await msg.downloadMedia();
                if(media) {
                    attachment = { mimetype: media.mimetype, data: media.data, filename: media.filename || "file" };
                }
            } catch (err) {}
        }

        // 🚀 SEND TO N8N
        try {
            await axios.post(N8N_WEBHOOK, {
                from: realNumberId,     // The real number
                original_id: msg.from,  // Backup ID
                body: msg.body,
                name: contactName,
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
        // 👇👇👇 OUTBOUND TYPING SIMULATION (Added Feature) 👇👇👇
        const chat = await client.getChatById(chatId);
        
        // 1. Ensure "Typing..." is showing
        await chat.sendStateTyping();
        
        // 2. Simulate "Writing Time" (1 second fixed delay for realism)
        // This prevents the bot from replying INSTANTLY which looks robotic
        await new Promise(resolve => setTimeout(resolve, 1000));
        // 👆👆👆 END SIMULATION 👆👆👆

        if (attachment && attachment.data) {
            let media = new MessageMedia(attachment.mimetype, attachment.data, attachment.filename);
            await client.sendMessage(chatId, media, { caption: message || "" });
        } else {
            await client.sendMessage(chatId, message);
        }
        
        // 3. Stop Typing immediately after sending
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
