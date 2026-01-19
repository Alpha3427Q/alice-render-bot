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

// 🛡️ CRASH PROTECTION: Prevents the bot from dying during the "History Flood"
let isSystemReady = false; 

let client;
let currentQR = null;

app.get('/', (req, res) => res.send("<html><body><h1>🟢 System Online</h1></body></html>"));

// --- DATABASE & CLIENT ---
mongoose.connect(MONGO_URI).then(() => {
    console.log('✅ Connected to MongoDB');
    const store = new MongoStore({ mongoose: mongoose });

    client = new Client({
        authStrategy: new RemoteAuth({ 
            clientId: 'Alice_Typing_Only', // New ID for a fresh, clean start
            store: store, 
            backupSyncIntervalMs: 60000 // Save session every 60s
        }),
        
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
                '--disable-features=site-per-process', 
                '--window-size=800,600',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36'
            ],
            timeout: 60000
        }
    });

    client.on('qr', (qr) => { 
        console.log("📌 QR Code Received");
        currentQR = qr; 
    });

    client.on('remote_session_saved', () => {
        console.log("💾 Session successfully saved to MongoDB!");
    });
    
    client.on('ready', () => { 
        console.log('🚀 WhatsApp Ready! Starting Cool-down...'); 
        currentQR = "connected"; 
        
        // 👇 CRITICAL: Wait 30s before processing messages to prevent crash
        setTimeout(() => {
            isSystemReady = true;
            console.log("✅ Cool-down complete. Bot is active.");
        }, 30000); 
    });

    // --- INBOUND MESSAGE HANDLING ---
    client.on('message', async (msg) => {
        // ⛔ Ignore messages during startup to save RAM
        if (!isSystemReady) return;

        if (!N8N_WEBHOOK) return;
        if (global.gc) global.gc();

        const cleanFrom = msg.from.includes('@c.us') ? msg.from.replace('@c.us', '') : msg.from;
        
        // --- TYPING STATUS ONLY (No Blue Tick) ---
        try {
            const chat = await msg.getChat();
            await chat.clearState(); // Clear previous status
            await chat.sendStateTyping(); // Start Typing...
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
        
        // Stop "Typing..." after sending
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
