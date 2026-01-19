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
        authStrategy: new RemoteAuth({ store: store, backupSyncIntervalMs: 300000 }),
        
        // 👇👇👇 THIS IS THE CRITICAL FIX FOR THE CRASH 👇👇👇
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
                '--disable-gpu'
            ],
            timeout: 60000
        }
        // 👆👆👆 END FIX 👆👆👆
    });

    client.on('qr', (qr) => { currentQR = qr; });
    client.on('ready', () => { console.log('🚀 WhatsApp Ready!'); currentQR = "connected"; });

    client.on('message', async (msg) => {
        if (!N8N_WEBHOOK) return;
        
        const cleanFrom = msg.from.includes('@c.us') ? msg.from.replace('@c.us', '') : msg.from;
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
        // Our 'patch-loader.js' handles the bug, this is just a fallback log
        if (e.message && e.message.includes('markedUnread')) {
            console.log("⚠️ Bug ignored (markedUnread), message likely sent.");
            return res.json({status: "sent", note: "Patched Error"});
        }
        res.status(500).json({error: e.toString()});
    }
});

app.listen(PORT, () => console.log(`Server live on port ${PORT}`));
