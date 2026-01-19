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
// Prevents the server from freezing by restarting if RAM gets too full
function checkMemoryHealth() {
    const used = process.memoryUsage().rss / 1024 / 1024;
    // console.log(`🧠 RAM Usage: ${Math.round(used)} MB`);
    if (used > 470) {
        console.warn("⚠️ Memory Critical (>470MB). Restarting to maintain stability...");
        process.exit(1);
    }
}

// --- 3. GLOBAL VARIABLES ---
let client;
let currentQR = null;
const SYSTEM_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36';

// --- 4. SERVER ROOT ---
app.get('/', (req, res) => res.send("<html><body><h1>🟢 System Online</h1></body></html>"));

// --- 5. MAIN BOT LOGIC ---
mongoose.connect(MONGO_URI).then(() => {
    console.log('✅ Connected to MongoDB');
    const store = new MongoStore({ mongoose: mongoose });

    client = new Client({
        // 🔐 Session Management: Use 'Client_V4' to ensure a fresh, clean session
        authStrategy: new RemoteAuth({ 
            clientId: 'Client_V4', 
            store: store, 
            backupSyncIntervalMs: 300000 
        }),
        
        // 🕵️ Spoofing: Pretend to be a real Windows PC
        userAgent: SYSTEM_USER_AGENT,

        // 🛡️ Stability: "Nuclear" settings to prevent Docker crashes
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

    client.on('qr', (qr) => { 
        console.log("📌 New QR Code Generated");
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
        console.log(`📩 Message from ${cleanFrom}`);

        // 👇👇👇 ROBUST HUMAN BEHAVIOR LOGIC 👇👇👇
        // Solves the "Missing Blue Tick" issue by forcing timing delays
        try {
            const chat = await msg.getChat();
            
            // 1. Reset State: Stop any stuck "typing" or "recording" status
            await chat.clearState();
            
            // 2. Wait 500ms: Ensure WhatsApp server registers the reset
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // 3. Send Blue Tick: Now safe to send because state is clean
            await chat.sendSeen();
            
            // 4. Wait 300ms: Human-like pause before typing
            await new Promise(resolve => setTimeout(resolve, 300));
            
            // 5. Start Typing: Shows "Typing..." to the user
            await chat.sendStateTyping(); 
            
        } catch (e) {
            console.error("⚠️ Status Error (Non-fatal):", e.message);
        }
        // 👆👆👆 END HUMAN LOGIC 👆👆👆

        let attachment = null;

        // Media Handling
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

        // Send to AI Brain (N8N)
        try {
            await axios.post(N8N_WEBHOOK, {
                from: msg.from,
                body: msg.body,
                name: msg._data.notifyName || "Unknown",
                timestamp: msg.timestamp,
                attachment: attachment
            });
        } catch(e) { console.error("❌ Brain Error:", e.message); }

        checkMemoryHealth();
    });

    client.initialize();
});

// --- 6. CONNECT ENDPOINT ---
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

// --- 7. SEND ENDPOINT ---
app.post('/send', async (req, res) => {
    if(req.headers['authorization'] !== `Bearer ${QR_PASSWORD}`) return res.status(401).json({error: "Unauthorized"});

    let { number, message, attachment } = req.body;
    if (!number) return res.status(400).json({error: "No number provided"});

    const chatId = number.includes('@') ? number : number.replace('+', '') + "@c.us";
    
    try {
        // Send Media or Text
        if (attachment && attachment.data) {
            let media = new MessageMedia(attachment.mimetype, attachment.data, attachment.filename);
            const isAudio = attachment.mimetype.startsWith('audio');
            
            await client.sendMessage(chatId, media, { 
                caption: message || "",
                sendAudioAsVoice: isAudio // Sends audio as a real voice note
            });
        } else {
            await client.sendMessage(chatId, message);
        }
        
        // 👇 CLEANUP: Stop "Typing..." immediately after sending reply
        try {
            const chat = await client.getChatById(chatId);
            await chat.clearState(); 
        } catch (e) {}

        res.json({status: "sent"});

    } catch(e) {
        // Safety Net: Even if the patch misses something, we log and ignore the specific bug
        if (e.message && e.message.includes('markedUnread')) {
            console.log("⚠️ Library Bug Ignored (Message likely sent)");
            return res.json({status: "sent", note: "Patched Error"});
        }
        console.error("❌ Send Error:", e.toString());
        res.status(500).json({error: e.toString()});
    } finally {
        checkMemoryHealth();
    }
});

// --- 8. START SERVER ---
app.listen(PORT, () => console.log(`Server live on port ${PORT}`));
