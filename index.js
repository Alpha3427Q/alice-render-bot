const { Client, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const express = require('express');
const QRCode = require('qrcode');
const axios = require('axios');
const app = express();

// --- CONFIGURATION ---
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const N8N_WEBHOOK = process.env.N8N_WEBHOOK;
const QR_PASSWORD = process.env.QR_PASSWORD || "agartha_secret";

// 🔵 THE PERMANENT ID (Matches Termux)
const CLIENT_ID = "Alice_Fresh_V1";
// 🕒 TIMESTAMP: Ignore old messages to prevent Blue Tick crashes on startup
const BOOT_TIMESTAMP = Math.floor(Date.now() / 1000);

let client;
let currentQR = null;
let isSessionFound = false;

app.get('/', (req, res) => res.send("<html><body><h1>🟢 Alice System Online</h1></body></html>"));

// --- DATABASE & INITIALIZATION ---
mongoose.connect(MONGO_URI).then(async () => {
    console.log('✅ Connected to MongoDB');

    // 1. PRE-CHECK: Look for the file manually before starting
    const db = mongoose.connection.db;
    const existingSession = await db.collection('whatsapp-remote-auth-sessions').findOne({ _id: CLIENT_ID });

    if (existingSession) {
        console.log(`🎉 FOUND EXISTING CREDENTIALS for "${CLIENT_ID}". Auto-logging in...`);
        isSessionFound = true;
    } else {
        console.log(`⚠️ NO CREDENTIALS FOUND for "${CLIENT_ID}". You must scan the QR code.`);
        isSessionFound = false;
    }

    // 2. SETUP STORE & CLIENT
    const store = new MongoStore({ mongoose: mongoose });

    client = new Client({
        authStrategy: new RemoteAuth({ 
            clientId: CLIENT_ID, // Use this name for loading AND saving
            store: store, 
            backupSyncIntervalMs: 60000 // Save every 60s
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

    // --- EVENTS ---

    // QR Event: Only fires if session is missing or invalid
    client.on('qr', (qr) => { 
        console.log("📌 QR Code Generated (Session missing or invalid)");
        currentQR = qr; 
    });

    // Save Event: confirm we are updating the DB
    client.on('remote_session_saved', () => {
        console.log("💾 Session Data Saved to MongoDB!");
    });
    
    // Ready Event
    client.on('ready', () => { 
        console.log('🚀 WhatsApp Ready!'); 
        currentQR = "connected"; 
    });

    // --- INBOUND MESSAGE HANDLING (Original Features Restored) ---
    client.on('message', async (msg) => {
        // 1. Safety Filter: Ignore messages from before the server started
        // This allows you to have Blue Ticks enabled without crashing on the "History Flood"
        if (msg.timestamp < BOOT_TIMESTAMP) return;

        if (!N8N_WEBHOOK) return;
        if (global.gc) global.gc();

        const cleanFrom = msg.from.includes('@c.us') ? msg.from.replace('@c.us', '') : msg.from;
        
        // 2. BLUE TICKS & TYPING (Restored Feature)
        try {
            const chat = await msg.getChat();
            
            // Wait slightly to feel human
            await new Promise(resolve => setTimeout(resolve, 500));
            await chat.sendSeen(); // 🔵 Blue Tick
            
            await new Promise(resolve => setTimeout(resolve, 300));
            await chat.sendStateTyping(); // ✍️ Typing...
            
        } catch (e) {
            console.log("⚠️ Status update failed (ignoring)");
        }

        let attachment = null;

        // 3. MEDIA HANDLING (Restored Feature)
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
            } catch (err) { console.error("Media Error:", err.message); }
        }

        console.log(`📩 New Message from ${cleanFrom}`);
        
        // 4. SEND TO N8N (Restored Feature)
        try {
            await axios.post(N8N_WEBHOOK, {
                from: msg.from,
                body: msg.body,
                name: msg._data.notifyName || "Unknown",
                timestamp: msg.timestamp,
                attachment: attachment
            });
        } catch(e) { console.error("Webhook Error:", e.message); }
    });

    client.initialize();
});

// --- API ENDPOINTS ---
app.get('/connect', async (req, res) => {
    if(req.query.password !== QR_PASSWORD) return res.status(403).send("⛔");
    
    if(currentQR === "connected") return res.send("✅ Connected (Logged in via MongoDB)");
    
    if(!currentQR) {
        if(isSessionFound) return res.send("⏳ Loading existing session from MongoDB...");
        return res.send("⏳ Booting...");
    }
    
    try {
        const qrImage = await QRCode.toDataURL(currentQR);
        res.send(`
            <div style="display:flex;flex-direction:column;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;">
                <h2>⚠️ No Saved Session Found</h2>
                <p>Scan this to create "Alice_Fresh_V1"</p>
                <img src="${qrImage}" style="width:300px;height:300px;border:5px solid black;"/>
            </div>
        `);
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
        
        // Stop typing after sending
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
