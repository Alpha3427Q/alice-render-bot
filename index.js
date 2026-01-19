const { Client, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const express = require('express');
const QRCode = require('qrcode');
const axios = require('axios');
const app = express();

// --- 1. CONFIGURATION & LIMITS ---
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const QR_PASSWORD = process.env.QR_PASSWORD || "agartha_secret";
const N8N_WEBHOOK = process.env.N8N_WEBHOOK;

// --- 2. MEMORY MANAGEMENT UTILS ---
function checkMemoryHealth() {
    const used = process.memoryUsage().rss / 1024 / 1024;
    console.log(`🧠 RAM Usage: ${Math.round(used)} MB`);
    if (used > 470) {
        console.warn("⚠️ Memory Critical (>470MB)! Restarting to prevent crash...");
        process.exit(1);
    }
}

// --- 3. DATABASE & BOT SETUP ---
let client;
let currentQR = null;

app.get('/', (req, res) => res.send("<html><body><h1>🚧 System Maintenance 🚧</h1></body></html>"));

mongoose.connect(MONGO_URI).then(() => {
    console.log('✅ Connected to MongoDB');
    const store = new MongoStore({ mongoose: mongoose });

    client = new Client({
        authStrategy: new RemoteAuth({ store: store, backupSyncIntervalMs: 300000 }),
        
        // 👇👇👇 FIX START: FORCE OLD VERSION TO PREVENT 'markedUnread' ERROR 👇👇👇
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1031490220-alpha.html',
        },
        // 👆👆👆 FIX END 👆👆👆

        // 🛠️ PUPPETEER CONFIG (Keep these! They prevent startup timeouts)
        puppeteer: {
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
            timeout: 60000,
            protocolTimeout: 120000
        }
    });

    client.on('qr', (qr) => { currentQR = qr; });
    client.on('ready', () => { console.log('🚀 WhatsApp Ready!'); currentQR = "connected"; });

    // --- INBOUND (Receive) ---
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
                media = null; 
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
            attachment = null; 
        } catch(e) { console.error("❌ Brain Error:", e.message); }

        checkMemoryHealth();
    });

    client.initialize();
});

// --- 4. CONNECT PAGE ---
app.get('/connect', async (req, res) => {
    if(req.query.password !== QR_PASSWORD) return res.status(403).send("⛔");
    if(currentQR === "connected") return res.send("✅ Connected");
    if(!currentQR) return res.send("⏳ Booting...");
    const qrImage = await QRCode.toDataURL(currentQR);
    res.send(`<img src="${qrImage}" />`);
});

// --- 5. OUTBOUND (Send) ---
app.post('/send', async (req, res) => {
    if(req.headers['authorization'] !== `Bearer ${QR_PASSWORD}`) return res.status(401).json({error: "Unauthorized"});

    let { number, message, attachment } = req.body;
    if (!number) return res.status(400).json({error: "No number provided"});

    try {
        const chatId = number.includes('@') ? number : number.replace('+', '') + "@c.us";

        if (attachment && attachment.data) {
            console.log(`📤 Sending Media...`);
            let media = new MessageMedia(attachment.mimetype, attachment.data, attachment.filename);
            const isAudio = attachment.mimetype.startsWith('audio');

            await client.sendMessage(chatId, media, {
                caption: message || "",
                sendAudioAsVoice: isAudio
            });
        } else {
            await client.sendMessage(chatId, message);
        }
        
        console.log(`✅ Sent to ${chatId}`);
        
        if(attachment) { attachment.data = null; attachment = null; }
        req.body = null;
        res.json({status: "sent"});

    } catch(e) {
        const errorMsg = e.toString();
        
        // I kept your original fallback here just in case, 
        // but the webVersionCache fix above should prevent this error from ever happening.
        if (errorMsg.includes('markedUnread')) {
            console.warn("⚠️ Known Library Bug (#5718) detected. Ignoring... (Message Sent)");
            return res.json({status: "sent", note: "Handled internal bug"});
        }

        console.error("❌ Send Error:", errorMsg);
        res.status(500).json({error: errorMsg});
    } finally {
        checkMemoryHealth();
    }
});

app.listen(PORT, () => console.log(`Server live on port ${PORT}`));
