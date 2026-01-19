const { Client, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const express = require('express');
const QRCode = require('qrcode');
const axios = require('axios');
const app = express();

// --- CONFIGURATION ---
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const QR_PASSWORD = process.env.QR_PASSWORD || "agartha_secret";
const N8N_WEBHOOK = process.env.N8N_WEBHOOK;

// TIMESTAMP: Ignore messages from before the bot started (Saves RAM)
const BOOT_TIMESTAMP = Math.floor(Date.now() / 1000);

let client;
let currentQR = null;

app.get('/', (req, res) => res.send("<html><body><h1>🟢 System Online</h1></body></html>"));

// --- DATABASE & CLIENT ---
mongoose.connect(MONGO_URI).then(() => {
    console.log('✅ Connected to MongoDB');
    const store = new MongoStore({ mongoose: mongoose });

    client = new Client({
        // 👇👇👇 EMERGENCY SAVE SETTINGS 👇👇👇
        authStrategy: new RemoteAuth({ 
            clientId: 'Alice_Final_Persistent', // New ID
            store: store, 
            // ⚠️ EXTREME SETTING: Try to save every 10 seconds.
            // This ensures we catch the session data before the crash happens.
            backupSyncIntervalMs: 10000 
        }),
        // 👆👆👆 END FIX 👆👆👆

        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36',

        puppeteer: {
            executablePath: '/usr/bin/google-chrome-stable',
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process', 
                '--disable-gpu',
                '--disable-extensions',
                '--disable-software-rasterizer',
                '--mute-audio',
                // RAM Optimizations
                '--disable-features=site-per-process', 
                '--renderer-process-limit=1', 
                '--window-size=800,600',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36'
            ],
            timeout: 60000
        }
    });

    // Debug Logs for Saving
    client.on('remote_session_saved', () => {
        console.log("💾 SUCCESS: Session saved to MongoDB! (You are safe now)");
    });

    client.on('qr', (qr) => { 
        console.log("📌 QR Code Received");
        currentQR = qr; 
    });
    
    client.on('ready', async () => { 
        console.log('🚀 WhatsApp Ready!'); 
        currentQR = "connected"; 
        
        // 👇 MANUALLY FORCE STORAGE UPDATE IF POSSIBLE
        // (We rely on the 10s timer, but this log confirms we reached this state)
        console.log("⏳ Attempting to survive long enough to save...");
    });

    // --- INBOUND MESSAGE HANDLING ---
    client.on('message', async (msg) => {
        // 1. Ignore History (Critical for RAM)
        if (msg.timestamp < BOOT_TIMESTAMP) return;

        if (!N8N_WEBHOOK) return;
        if (global.gc) global.gc(); // Clean RAM

        const cleanFrom = msg.from.includes('@c.us') ? msg.from.replace('@c.us', '') : msg.from;
        
        // Human Behavior
        try {
            const chat = await msg.getChat();
            await chat.clearState();
            await new Promise(resolve => setTimeout(resolve, 500));
            await chat.sendSeen();
            await new Promise(resolve => setTimeout(resolve, 300));
            await chat.sendStateTyping(); 
        } catch (e) {}

        let attachment = null;

        if (msg.hasMedia) {
            try {
                const media = await msg.downloadMedia();
                if(media) {
                    attachment = {
                        mimetype: media.mimetype,
                        data: media.data,
                        filename: media.filename || "unknown_file"
                    };
                }
                media = null;
            } catch (err) { console.error("Media Error:", err.message); }
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
            attachment = null;
        } catch(e) { console.error("Webhook Error:", e.message); }
    });

    client.initialize();
});

// --- API ENDPOINTS ---
app.get('/connect', async (req, res) => {
    if(req.query.password !== QR_PASSWORD) return res.status(403).send("⛔");
    if(currentQR === "connected") return res.send("✅ Connected");
    if(!currentQR) return res.send("⏳ Booting...");
    
    try {
        const qrImage = await QRCode.toDataURL(currentQR);
        res.send(`<div style="display:flex;justify-content:center;align-items:center;height:100vh;"><img src="${qrImage}" style="width:300px;height:300px;border:5px solid black;"/></div>`);
    } catch (e) { res.status(500).send("Error generating QR"); }
});

app.post('/send', async (req, res) => {
    if(req.headers['authorization'] !== `Bearer ${QR_PASSWORD}`) return res.status(401).json({error: "Unauthorized"});
    let { number, message, attachment } = req.body;
    req.body = null; 

    if (!number) return res.status(400).json({error: "No number provided"});

    const chatId = number.includes('@') ? number : number.replace('+', '') + "@c.us";
    
    try {
        if (attachment && attachment.data) {
            let media = new MessageMedia(attachment.mimetype, attachment.data, attachment.filename);
            await client.sendMessage(chatId, media, { caption: message || "" });
            media = null;
        } else {
            await client.sendMessage(chatId, message);
        }
        
        try {
            const chat = await client.getChatById(chatId);
            await chat.clearState(); 
        } catch (e) {}

        res.json({status: "sent"});
    } catch(e) {
        if (e.message && e.message.includes('markedUnread')) {
            console.log("⚠️ Bug ignored");
            return res.json({status: "sent", note: "Patched Error"});
        }
        res.status(500).json({error: e.toString()});
    } finally {
        if (global.gc) global.gc();
    }
});

app.listen(PORT, () => console.log(`Server live on port ${PORT}`));
