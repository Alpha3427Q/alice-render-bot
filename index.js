const { Client, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const express = require('express');
const QRCode = require('qrcode');
const axios = require('axios');
const app = express();

// Increase limit for heavy media
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI; // Make sure this is set in Render
const QR_PASSWORD = process.env.QR_PASSWORD || "agartha_secret";
const N8N_WEBHOOK = process.env.N8N_WEBHOOK;

// --- 1. FAKE MAINTENANCE PAGE ---
app.get('/', (req, res) => res.send("<html><body><h1>🚧 System Maintenance 🚧</h1></body></html>"));

// --- 2. DATABASE & BOT SETUP ---
let client;
let currentQR = null;

// Connect to Mongo
mongoose.connect(MONGO_URI).then(() => {
    console.log('✅ Connected to MongoDB');
    const store = new MongoStore({ mongoose: mongoose });
    
    client = new Client({
        authStrategy: new RemoteAuth({ store: store, backupSyncIntervalMs: 300000 }),
        puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
    });

    client.on('qr', (qr) => { currentQR = qr; });
    client.on('ready', () => { console.log('🚀 WhatsApp Ready!'); currentQR = "connected"; });

    // --- INBOUND (Receive) ---
    client.on('message', async (msg) => {
        if (!N8N_WEBHOOK) return;

        // Clean ID logic
        const cleanFrom = msg.from.includes('@c.us') ? msg.from.replace('@c.us', '') : msg.from;
        
        let attachment = null;

        // Check for ANY Media (Voice, Image, Video, PDF)
        if (msg.hasMedia) {
            try {
                const media = await msg.downloadMedia();
                if(media) {
                    attachment = {
                        mimetype: media.mimetype,
                        data: media.data, // Base64
                        filename: media.filename || "unknown_file"
                    };
                }
            } catch (err) { console.error("Media Download Failed:", err.message); }
        }

        console.log(`📩 From ${cleanFrom} | Media: ${msg.hasMedia ? "YES" : "NO"}`);

        // Send to n8n
        try {
            await axios.post(N8N_WEBHOOK, {
                from: msg.from,
                body: msg.body,
                name: msg._data.notifyName || "Unknown",
                timestamp: msg.timestamp,
                attachment: attachment // n8n receives this
            });
        } catch(e) { console.error("❌ Brain Error:", e.message); }
    });

    client.initialize();
});

// --- 3. CONNECT PAGE ---
app.get('/connect', async (req, res) => {
    if(req.query.password !== QR_PASSWORD) return res.status(403).send("⛔");
    if(currentQR === "connected") return res.send("✅ Connected");
    if(!currentQR) return res.send("⏳ Booting...");
    const qrImage = await QRCode.toDataURL(currentQR);
    res.send(`<img src="${qrImage}" />`);
});

// --- 4. OUTBOUND (Send) ---
app.post('/send', async (req, res) => {
    if(req.headers['authorization'] !== `Bearer ${QR_PASSWORD}`) return res.status(401).json({error: "Unauthorized"});

    const { number, message, attachment } = req.body;
    if (!number) return res.status(400).json({error: "No number provided"});

    try {
        const chatId = number.includes('@') ? number : number.replace('+', '') + "@c.us";
        
        // --- SEND MEDIA (Image/Audio/Doc) ---
        if (attachment && attachment.data) {
            const media = new MessageMedia(attachment.mimetype, attachment.data, attachment.filename);
            
            // 🎤 MAGIC SWITCH: If it's audio, send as Voice Note (waveform)
            const isAudio = attachment.mimetype.startsWith('audio');
            
            await client.sendMessage(chatId, media, { 
                caption: message || "",
                sendAudioAsVoice: isAudio // <--- THIS MAKES IT REAL
            });
            console.log(`📤 Sent MEDIA (${attachment.mimetype}) to ${chatId}`);
        
        // --- SEND TEXT ONLY ---
        } else {
            await client.sendMessage(chatId, message);
            console.log(`📤 Sent TEXT to ${chatId}`);
        }
        
        res.json({status: "sent"});
    } catch(e) {
        console.error("❌ Send Error:", e.toString());
        res.status(500).json({error: e.toString()});
    }
});

app.listen(PORT, () => console.log(`Server live on port ${PORT}`));
