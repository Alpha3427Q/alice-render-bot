const { Client, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const express = require('express');
const QRCode = require('qrcode');
const axios = require('axios');
const app = express();

// --- 1. CONFIGURATION ---
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const QR_PASSWORD = process.env.QR_PASSWORD || "agartha_secret";
const N8N_WEBHOOK = process.env.N8N_WEBHOOK;

// --- 2. MEMORY HEALTH MONITOR ---
function checkMemoryHealth() {
    const used = process.memoryUsage().rss / 1024 / 1024;
    if (used > 470) {
        console.warn("⚠️ Memory Critical. Restarting...");
        process.exit(1);
    }
}

// --- 3. GLOBAL VARIABLES ---
let client;
let currentQR = null;
const SYSTEM_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36';

app.get('/', (req, res) => res.send("<html><body><h1>🟢 Alice is Online</h1></body></html>"));

// --- 4. DATABASE & CLIENT ---
mongoose.connect(MONGO_URI).then(() => {
    console.log('✅ Connected to MongoDB');
    const store = new MongoStore({ mongoose: mongoose });

    client = new Client({
        // 👇👇👇 PERSISTENCE FIX 👇👇👇
        authStrategy: new RemoteAuth({ 
            // 1. STABLE ID: We stop changing this name now. 'Alice_Main' is permanent.
            clientId: 'Alice_Main', 
            store: store, 
            // 2. FAST SAVE: Save session every 60 seconds (instead of 5 mins)
            backupSyncIntervalMs: 60000 
        }),
        // 👆👆👆 END FIX 👆👆👆

        userAgent: SYSTEM_USER_AGENT,

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
                '--disable-gl-drawing-for-tests',
                '--window-size=1280,1024',
                `--user-agent=${SYSTEM_USER_AGENT}`
            ],
            timeout: 60000
        }
    });

    // --- NEW: LOGIN DEBUGGING ---
    // This tells us if MongoDB is actually working
    client.on('authenticated', () => {
        console.log("🔑 AUTH SUCCESS: Session restored from MongoDB!");
    });

    client.on('auth_failure', (msg) => {
        console.error("⛔ AUTH FAILED: ", msg);
    });

    client.on('qr', (qr) => { 
        console.log("📌 QR Code Received (Scan required)");
        currentQR = qr; 
    });
    
    client.on('ready', () => { 
        console.log('🚀 WhatsApp Ready & Connected!'); 
        currentQR = "connected"; 
    });

    // --- INBOUND MESSAGES ---
    client.on('message', async (msg) => {
        if (!N8N_WEBHOOK) return;

        const cleanFrom = msg.from.includes('@c.us') ? msg.from.replace('@c.us', '') : msg.from;
        
        // Human Behavior (Blue Ticks + Typing)
        try {
            const chat = await msg.getChat();
            await chat.clearState();
            await new Promise(resolve => setTimeout(resolve, 500));
            await chat.sendSeen();
            await new Promise(resolve => setTimeout(resolve, 300));
            await chat.sendStateTyping(); 
        } catch (e) {
            console.error("⚠️ Status Error:", e.message);
        }

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
            } catch (err) { console.error("Media Download Failed:", err.message); }
        }

        console.log(`📩 From ${cleanFrom} | Media: ${msg.hasMedia ? "YES" : "NO"}`);

        try {
            await axios.post(N8N_WEBHOOK, {
                from: msg.from,
                body: msg.body,
                name: msg._data.notifyName || "Unknown",
                timestamp: msg.timestamp,
                attachment: attachment
            });
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
    
    try {
        const qrImage = await QRCode.toDataURL(currentQR);
        res.send(`<div style="display:flex;justify-content:center;align-items:center;height:100vh;"><img src="${qrImage}" style="width:300px;height:300px;border:5px solid black;"/></div>`);
    } catch (e) {
        res.status(500).send("Error generating QR");
    }
});

app.post('/send', async (req, res) => {
    if(req.headers['authorization'] !== `Bearer ${QR_PASSWORD}`) return res.status(401).json({error: "Unauthorized"});

    let { number, message, attachment } = req.body;
    if (!number) return res.status(400).json({error: "No number provided"});

    const chatId = number.includes('@') ? number : number.replace('+', '') + "@c.us";
    
    try {
        if (attachment && attachment.data) {
            let media = new MessageMedia(attachment.mimetype, attachment.data, attachment.filename);
            await client.sendMessage(chatId, media, { caption: message || "", sendAudioAsVoice: attachment.mimetype.startsWith('audio') });
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
            console.log("⚠️ Library Bug Ignored");
            return res.json({status: "sent", note: "Patched Error"});
        }
        res.status(500).json({error: e.toString()});
    }
});

app.listen(PORT, () => console.log(`Server live on port ${PORT}`));
