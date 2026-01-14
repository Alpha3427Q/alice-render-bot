const { Client, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const express = require('express');
const QRCode = require('qrcode');
const axios = require('axios');
const app = express();

// --- 1. CONFIGURATION & LIMITS ---
// 100MB Limit (as requested)
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const QR_PASSWORD = process.env.QR_PASSWORD || "agartha_secret";
const N8N_WEBHOOK = process.env.N8N_WEBHOOK;

// --- 2. MEMORY MANAGEMENT UTILS ---
function checkMemoryHealth() {
    const used = process.memoryUsage().rss / 1024 / 1024;
    // Log current usage so you can monitor it in Render dashboard
    console.log(`🧠 RAM Usage: ${Math.round(used)} MB`);

    // ⚠️ TRIGGER: Only restart if we are critically close to the 512MB cliff.
    // Adjusted to 470MB as requested.
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
        // 🛠️ CRITICAL PUPPETEER FIXES FOR RENDER
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', // Writes temp data to disk, saves RAM
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process', // ⚠️ Important for Render memory limits
                '--disable-gpu'
            ],
            // ⚠️ TIMEOUT FIXES: Prevents "ProtocolError: Runtime.callFunctionOn timed out"
            timeout: 60000,          // 60 Seconds (Browser Launch Timeout)
            protocolTimeout: 120000  // 120 Seconds (Page Load/Inject Timeout)
        }
    });

    client.on('qr', (qr) => { currentQR = qr; });
    client.on('ready', () => { console.log('🚀 WhatsApp Ready!'); currentQR = "connected"; });

    // --- INBOUND (Receive) - 100% Compatible with your n8n ---
    client.on('message', async (msg) => {
        if (!N8N_WEBHOOK) return;

        const cleanFrom = msg.from.includes('@c.us') ? msg.from.replace('@c.us', '') : msg.from;
        let attachment = null;

        // Identical logic to your original code
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
                media = null; // Cleanup
            } catch (err) { console.error("Media Download Failed:", err.message); }
        }

        console.log(`📩 From ${cleanFrom} | Media: ${msg.hasMedia ? "YES" : "NO"}`);

        try {
            // Sends exact same structure to n8n
            await axios.post(N8N_WEBHOOK, {
                from: msg.from,
                body: msg.body,
                name: msg._data.notifyName || "Unknown",
                timestamp: msg.timestamp,
                attachment: attachment
            });
            attachment = null; // Cleanup
        } catch(e) { console.error("❌ Brain Error:", e.message); }

        // Check RAM status only after work is done
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

// --- 5. OUTBOUND (Send) - 100% Compatible ---
app.post('/send', async (req, res) => {
    if(req.headers['authorization'] !== `Bearer ${QR_PASSWORD}`) return res.status(401).json({error: "Unauthorized"});

    let { number, message, attachment } = req.body;
    if (!number) return res.status(400).json({error: "No number provided"});

    try {
        const chatId = number.includes('@') ? number : number.replace('+', '') + "@c.us";

        // Logic matches your original requirements exactly
        if (attachment && attachment.data) {
            console.log(`📤 Sending ${attachment.mimetype}...`);

            let media = new MessageMedia(attachment.mimetype, attachment.data, attachment.filename);
            const isAudio = attachment.mimetype.startsWith('audio');

            await client.sendMessage(chatId, media, {
                caption: message || "",
                sendAudioAsVoice: isAudio
            });
            console.log(`✅ Sent MEDIA to ${chatId}`);

            // Aggressive Cleanup
            media = null;
            attachment.data = null;
            attachment = null;
            req.body = null;

        } else {
            await client.sendMessage(chatId, message);
            console.log(`✅ Sent TEXT to ${chatId}`);
        }

        res.json({status: "sent"});

    } catch(e) {
        console.error("❌ Send Error:", e.toString());
        res.status(500).json({error: e.toString()});
    } finally {
        // Final Safety Check
        checkMemoryHealth();
    }
});

app.listen(PORT, () => console.log(`Server live on port ${PORT}`));
