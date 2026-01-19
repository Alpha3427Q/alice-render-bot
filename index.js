const { Client, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const express = require('express');
const QRCode = require('qrcode');
const axios = require('axios');
const app = express();

// --- CONFIGURATION ---
app.use(express.json({ limit: '50mb' })); // Reduced limit to save RAM
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const QR_PASSWORD = process.env.QR_PASSWORD || "agartha_secret";
const N8N_WEBHOOK = process.env.N8N_WEBHOOK;

// --- MEMORY HEALTH ---
// Tighter limit: Restart at 400MB to avoid crashing the whole container
function checkMemoryHealth() {
    const used = process.memoryUsage().rss / 1024 / 1024;
    if (used > 400) {
        console.warn(`⚠️ Memory Warning: ${Math.round(used)}MB used. Restarting to clear RAM...`);
        process.exit(1);
    }
}

// Garbage Collection: Run manually if exposed (optional but helps)
if (global.gc) {
    setInterval(() => { global.gc(); }, 30000);
}

let client;
let currentQR = null;

app.get('/', (req, res) => res.send("<html><body><h1>System Online</h1></body></html>"));

// --- DATABASE & CLIENT ---
mongoose.connect(MONGO_URI).then(() => {
    console.log('✅ Connected to MongoDB');
    const store = new MongoStore({ mongoose: mongoose });

    client = new Client({
        // 🔐 SESSION FIX: Save faster & keep ID static
        authStrategy: new RemoteAuth({ 
            clientId: 'Alice_Main_V1', // Permanent ID
            store: store, 
            backupSyncIntervalMs: 60000 // Save every 60s (Fixes "Scan Again" loop)
        }),
        
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36',

        // 🛡️ RAM OPTIMIZATION SETTINGS
        puppeteer: {
            executablePath: '/usr/bin/google-chrome-stable',
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', // Memory handling
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process', // Critical for low RAM envs
                '--disable-gpu',
                '--disable-extensions',
                '--disable-software-rasterizer',
                '--mute-audio',
                // 👇 Block heavy content to save RAM
                '--disable-gl-drawing-for-tests',
                '--window-size=800,600', // Smaller window uses less RAM
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36'
            ],
            timeout: 60000
        }
    });

    // Debug Log: Confirm session restoration
    client.on('remote_session_saved', () => {
        console.log("💾 Session Saved to MongoDB");
    });

    client.on('qr', (qr) => { currentQR = qr; console.log("📌 Scan QR Code"); });
    client.on('ready', () => { console.log('🚀 WhatsApp Ready!'); currentQR = "connected"; });

    // --- INBOUND MESSAGE HANDLING ---
    client.on('message', async (msg) => {
        if (!N8N_WEBHOOK) return;

        // Clean memory before processing heavy messages
        if (global.gc) global.gc();

        const cleanFrom = msg.from.includes('@c.us') ? msg.from.replace('@c.us', '') : msg.from;
        
        // Human Behavior
        try {
            const chat = await msg.getChat();
            await chat.sendSeen();
            await chat.sendStateTyping(); 
        } catch (e) {}

        let attachment = null;

        // 1. Download Media (Memory Intensive!)
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
                // Help GC clear large media buffer
                media = null;
            } catch (err) { console.error("Media Err:", err.message); }
        }

        console.log(`📩 From ${cleanFrom} | Media: ${msg.hasMedia ? "YES" : "NO"}`);
        
        // 2. Send to N8N
        try {
            await axios.post(N8N_WEBHOOK, {
                from: msg.from,
                body: msg.body,
                name: msg._data.notifyName || "Unknown",
                timestamp: msg.timestamp,
                attachment: attachment
            });
            // Clear attachment from memory immediately
            attachment = null;
        } catch(e) { console.error("Webhook Error:", e.message); }
        
        checkMemoryHealth();
    });

    client.initialize();
});

// --- API ENDPOINTS ---
app.get('/connect', async (req, res) => {
    if(req.query.password !== QR_PASSWORD) return res.status(403).send("⛔");
    if(currentQR === "connected") return res.send("✅ Connected");
    if(!currentQR) return res.send("⏳ Booting...");
    const qrImage = await QRCode.toDataURL(currentQR);
    res.send(`<img src="${qrImage}" />`);
});

app.post('/send', async (req, res) => {
    if(req.headers['authorization'] !== `Bearer ${QR_PASSWORD}`) return res.status(401).json({error: "Unauthorized"});
    let { number, message, attachment } = req.body;
    
    // Clear heavy request body asap
    req.body = null; 
    
    if (!number) return res.status(400).json({error: "No number"});

    const chatId = number.includes('@') ? number : number.replace('+', '') + "@c.us";
    
    try {
        if (attachment && attachment.data) {
            let media = new MessageMedia(attachment.mimetype, attachment.data, attachment.filename);
            await client.sendMessage(chatId, media, { caption: message || "" });
            media = null; // Clear memory
        } else {
            await client.sendMessage(chatId, message);
        }
        res.json({status: "sent"});
    } catch(e) {
        if (e.message && e.message.includes('markedUnread')) {
            console.log("⚠️ Bug ignored");
            return res.json({status: "sent", note: "Patched"});
        }
        res.status(500).json({error: e.toString()});
    } finally {
        checkMemoryHealth();
        if (global.gc) global.gc();
    }
});

app.listen(PORT, () => console.log(`Server live on port ${PORT}`));
