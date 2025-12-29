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
const MONGO_URI = process.env.MONGO_URI; // Secret Database URL
const QR_PASSWORD = process.env.QR_PASSWORD || "agartha_secret"; // Password to see QR
const N8N_WEBHOOK = process.env.N8N_WEBHOOK; // Your n8n URL

// --- 1. FAKE WEBSITE (The Camouflage) ---
app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>Welcome to Agartha</title></head>
            <body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#f0f2f5;font-family:Arial;">
                <div style="text-align:center;">
                    <h1>🚧 Under Maintenance 🚧</h1>
                    <p>We are currently upgrading our systems. Please check back later.</p>
                </div>
            </body>
        </html>
    `);
});

// --- 2. DATABASE & BOT SETUP ---
let client;
let currentQR = null; // Store QR code to show on website

mongoose.connect(MONGO_URI).then(() => {
    console.log('✅ Connected to MongoDB');
    
    const store = new MongoStore({ mongoose: mongoose });
    
    client = new Client({
        authStrategy: new RemoteAuth({
            store: store,
            backupSyncIntervalMs: 300000
        }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    client.on('qr', (qr) => {
        console.log('🆕 New QR Code generated');
        currentQR = qr; // Save it to memory to serve via web
    });

    client.on('ready', () => {
        console.log('🚀 WhatsApp Client is Ready!');
        currentQR = "connected"; // Stop showing QR
    });

    client.on('message', async (msg) => {
        // Send to n8n
        if(N8N_WEBHOOK) {
            try {
                await axios.post(N8N_WEBHOOK, {
                    from: msg.from.replace('@c.us', ''),
                    body: msg.body,
                    name: msg._data.notifyName
                });
            } catch(e) { console.error("n8n Error:", e.message); }
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

    // Convert text QR to Image
    const qrImage = await QRCode.toDataURL(currentQR);
    res.send(`
        <html><body style="text-align:center; padding-top:50px;">
            <h1>Scan with WhatsApp</h1>
            <img src="${qrImage}" />
            <p>Refresh if it expires.</p>
        </body></html>
    `);
});

// --- 4. SEND MESSAGE API (For n8n) ---
app.post('/send', async (req, res) => {
    // Basic security check
    if(req.headers['authorization'] !== `Bearer ${QR_PASSWORD}`) 
        return res.status(401).json({error: "Unauthorized"});

    const { number, message } = req.body;
    const chatId = number.replace('+', '') + "@c.us";
    
    try {
        await client.sendMessage(chatId, message);
        res.json({status: "sent"});
    } catch(e) {
        res.status(500).json({error: e.toString()});
    }
});

app.listen(PORT, () => console.log(`Server live on port ${PORT}`));
