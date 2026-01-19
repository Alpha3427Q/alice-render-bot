const { Client, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const express = require('express');
const QRCode = require('qrcode');
const axios = require('axios');
const app = express();

// --- CONFIGURATION ---
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const QR_PASSWORD = process.env.QR_PASSWORD || "agartha_secret";
const N8N_WEBHOOK = process.env.N8N_WEBHOOK;

// --- MEMORY HEALTH ---
function checkMemoryHealth() {
    const used = process.memoryUsage().rss / 1024 / 1024;
    // console.log(`🧠 RAM: ${Math.round(used)} MB`);
    if (used > 470) {
        console.warn("⚠️ Memory Critical. Restarting...");
        process.exit(1);
    }
}

let client;
let currentQR = null;

app.get('/', (req, res) => res.send("<html><body><h1>System Maintenance</h1></body></html>"));

// --- DATABASE & CLIENT ---
mongoose.connect(MONGO_URI).then(() => {
    console.log('✅ Connected to MongoDB');
    const store = new MongoStore({ mongoose: mongoose });

    client = new Client({
        // 🔐 Session Management
        authStrategy: new RemoteAuth({ 
            clientId: 'Client_V3', 
            store: store, 
            backupSyncIntervalMs: 300000 
        }),
        
        // 🕵️ User Agent Spoofing (Tricks WhatsApp into thinking this is a real PC)
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36',

        // 🛡️ "Nuclear" Stability Settings for Render/Docker
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
                // Must match the userAgent above
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36'
            ],
            timeout: 60000
        }
    });

    client.on('qr', (qr) => { currentQR = qr; });
    client.on('ready', () => { console.log('🚀 WhatsApp Ready!'); currentQR = "connected"; });

    // --- INBOUND MESSAGE HANDLING ---
    client.on('message', async (msg) => {
        if (!N8N_WEBHOOK) return;

        const cleanFrom = msg.from.includes('@c.us') ? msg.from.replace('@c.us', '') : msg.from;
        
        // 👇👇👇 HUMAN BEHAVIOR BLOCK 👇👇👇
        // Safe to use now because 'patch-loader.js' fixed the crash!
        try {
            const chat = await msg.getChat();
            await chat.sendSeen();        // Sends Blue Tick
            await chat.sendStateTyping(); // Shows "Typing..." status
        } catch (e) {
            // Just ignore if we can't send seen/typing (don't let it stop the bot)
        }
        // 👆👆👆 END HUMAN BEHAVIOR 👆👆👆

        let attachment = null;

        // 1. Download Media if present
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
        
        // 2. Send to N8N AI Brain
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
    const qrImage = await QRCode.toDataURL(currentQR);
    res.send(`<img src="${qrImage}" />`);
});

app.post('/send', async (req, res) => {
    if(req.headers['authorization'] !== `Bearer ${QR_PASSWORD}`) return res.status(401).json({error: "Unauthorized"});
    let { number, message, attachment } = req.body;
    if (!number) return res.status(400).json({error: "No number provided"});

    const chatId = number.includes('@') ? number : number.replace('+', '') + "@c.us";
    
    try {
        if (attachment && attachment.data) {
            let media = new MessageMedia(attachment.mimetype, attachment.data, attachment.filename);
            await client.sendMessage(chatId, media, { caption: message || "" });
        } else {
            await client.sendMessage(chatId, message);
        }
        res.json({status: "sent"});
    } catch(e) {
        // Our patch handles the real error, but we log this just in case
        if (e.message && e.message.includes('markedUnread')) {
            console.log("⚠️ Bug ignored (markedUnread), message likely sent.");
            return res.json({status: "sent", note: "Patched Error"});
        }
        res.status(500).json({error: e.toString()});
    }
});

app.listen(PORT, () => console.log(`Server live on port ${PORT}`));
