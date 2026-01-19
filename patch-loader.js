// patch-loader.js
const fs = require('fs');
const path = require('path');

const targetFile = path.join(__dirname, 'node_modules', 'whatsapp-web.js', 'src', 'util', 'Injected', 'Utils.js');

if (fs.existsSync(targetFile)) {
    console.log("🛠️  Patching whatsapp-web.js to fix 'markedUnread' crash...");
    
    let content = fs.readFileSync(targetFile, 'utf8');

    // The robust fix code that includes try/catch
    const fixedFunction = `
    window.WWebJS.sendSeen = async (chatId) => {
        try {
            const chat = await window.WWebJS.getChat(chatId);
            if (chat) {
                await window.Store.SendSeen.sendSeen(chat);
                return true;
            }
            return false;
        } catch (e) {
            console.log("WWebJS: sendSeen error ignored");
            return true; 
        }
    };
    `;

    // Regex to find the original broken function
    const regex = /window\.WWebJS\.sendSeen\s*=\s*async\s*\(chatId\)\s*=>\s*\{[\s\S]*?return\s*false;\s*\};/m;

    if (regex.test(content)) {
        const newContent = content.replace(regex, fixedFunction);
        fs.writeFileSync(targetFile, newContent, 'utf8');
        console.log("✅ PATCH SUCCESS: Library fixed successfully.");
    } else {
        console.log("⚠️ PATCH SKIPPED: Code pattern not found (maybe already patched?)");
    }
} else {
    console.log("❌ PATCH FAILED: File not found at " + targetFile);
}
