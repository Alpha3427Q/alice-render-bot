const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const express = require('express');
const QRCode = require('qrcode');
const axios = require('axios');
const app = express();

app.use(express.json());

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const QR_PASSWORD = process.env.QR_PASSWORD || "agartha_secret";
const N8N_WEBHOOK = process.env.N8N_WEBHOOK;

// --- 1. FAKE WEBSITE (The Camouflage) ---
app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>System Status</title></head>
            <body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#f0f2f5;font-family:Arial;">
                <div style="text-align:center;">
                    <h1>🚧 System Maintenance 🚧</h1>
                    <p>Our servers are currently updating. Please try again later.</p>
                </div>
            </body>
        </html>
    `);
});

// --- 2. DATABASE & BOT SETUP ---
let client;
let currentQR = null;

mongoose.connect(MONGO_URI).then(() => {
    console.log('✅ Connected to MongoDB');
    
    const store = new MongoStore({ mongoose: mongoose });
    
    client = new Client({
        authStrategy: new RemoteAuth({
            store: store,
            backupSyncIntervalMs: 300000 // Save session every 5 mins
        }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    client.on('qr', (qr) => {
        console.log('🆕 New QR Code generated');
        currentQR = qr;
    });

    client.on('ready', () => {
        console.log('🚀 WhatsApp Client is Ready!');
        currentQR = "connected";
    });

    client.on('message', async (msg) => {
        if (!N8N_WEBHOOK) return;

        // Clean the ID slightly for easier reading, but keep important parts
        // If it's a standard number, remove @c.us. If it's LID or Group, keep it.
        const cleanFrom = msg.from.includes('@c.us') ? msg.from.replace('@c.us', '') : msg.from;

        console.log(`📩 Forwarding message from ${cleanFrom} to Brain...`);

        try {
            await axios.post(N8N_WEBHOOK, {
                from: msg.from, // Send the FULL ID (including @lid or @c.us) to be safe
                body: msg.body,
                name: msg._data.notifyName || "Unknown",
                timestamp: msg.timestamp
            });
        } catch(e) { 
            console.error("❌ Failed to send to Brain:", e.message); 
        }
    });

    client.initialize();
});

// --- 3. SECRET QR PAGE ---
app.get('/connect', async (req, res) => {
    const pwd = req.query.password;
    if(pwd !== QR_PASSWORD) return res.status(403).send("⛔ Access Denied");

    if(currentQR === "connected") return res.send("<h1>✅ Bot is already connected!</h1>");
    if(!currentQR) return res.send("<h1>⏳ Booting up... Refresh in 10s</h1>");

    const qrImage = await QRCode.toDataURL(currentQR);
    res.send(`
        <html><body style="text-align:center; padding-top:50px;">
            <h1>Scan with WhatsApp</h1>
            <img src="${qrImage}" />
            <p>Refresh if this expires.</p>
        </body></html>
    `);
});

// --- 4. SEND MESSAGE API (THE FIX IS HERE) ---
app.post('/send', async (req, res) => {
    // Security check
    const authHeader = req.headers['authorization'];
    if(!authHeader || authHeader !== `Bearer ${QR_PASSWORD}`) {
        return res.status(401).json({error: "Unauthorized"});
    }

    const { number, message } = req.body;

    if (!number || !message) {
        return res.status(400).json({error: "Missing number or message"});
    }
    
    try {
        // 🛠️ SMART ID FIX:
        // If the number already has '@c.us', '@lid', or '@g.us', don't change it.
        // If it's just digits (e.g. 9198...), add '@c.us'.
        const chatId = number.includes('@') ? number : number.replace('+', '') + "@c.us";
        
        await client.sendMessage(chatId, message);
        console.log(`📤 Sent reply to ${chatId}`);
        res.json({status: "sent"});
    } catch(e) {
        console.error("❌ Send Error:", e.toString());
        res.status(500).json({error: e.toString()});
    }
});

app.listen(PORT, () => console.log(`Server live on port ${PORT}`));
