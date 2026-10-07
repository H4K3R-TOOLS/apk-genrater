/**
 * strip_meta.js — strips AGP build fingerprint entries from an AS-built APK,
 * then re-signs with v2+v3 using usman90.jks.
 *
 * These META-INF entries are Play Protect fingerprints that mark the APK as
 * a sideloaded/non-Play-Store build and trigger more aggressive scanning:
 *   - META-INF/com/android/build/gradle/app-metadata.properties  (AGP version)
 *   - META-INF/version-control-info.textproto                     (VCS fingerprint)
 *
 * Run: node strip_meta.js <input.apk> <output-unsigned.apk>
 */

const AdmZip = require('adm-zip');
const fs     = require('fs');
const path   = require('path');
const { execSync } = require('child_process');

const inApk   = process.argv[2];
const outBase = process.argv[3] || inApk.replace('.apk', '-stripped.apk');

// Entries to remove — AGP build fingerprints
const STRIP_ENTRIES = [
    'META-INF/com/android/build/gradle/app-metadata.properties',
    'META-INF/version-control-info.textproto',
];

// Signature entries to strip (re-signing requires clean META-INF)
const SIG_EXTS = ['.SF', '.RSA', '.DSA', '.EC', 'MANIFEST.MF'];

console.log(`[STRIP] Input:  ${inApk}`);
console.log(`[STRIP] Output: ${outBase}`);

const zip = new AdmZip(inApk);

let removed = 0;
for (const entry of zip.getEntries()) {
    const n = entry.entryName;

    // Remove AGP fingerprint entries
    if (STRIP_ENTRIES.includes(n)) {
        zip.deleteFile(n);
        console.log(`[STRIP] Removed: ${n}`);
        removed++;
        continue;
    }

    // Remove existing signature blocks (uber-apk-signer / apksigner will re-add)
    if (n.startsWith('META-INF/') && SIG_EXTS.some(x => n.toUpperCase().endsWith(x))) {
        zip.deleteFile(n);
        console.log(`[STRIP] Removed sig: ${n}`);
        removed++;
        continue;
    }
}

// Ensure manifest is always method 8 (deflated) — Play Protect check
const manifestEntry = zip.getEntry('AndroidManifest.xml');
if (manifestEntry) {
    const buf = manifestEntry.getData();
    manifestEntry.setData(buf);
    manifestEntry.header.method = 8;
    console.log('[STRIP] Manifest forced to method 8');
}

// resources.arsc must be STORED (method 0)
const arscEntry = zip.getEntry('resources.arsc');
if (arscEntry) arscEntry.header.method = 0;

zip.writeZip(outBase);
console.log(`[STRIP] Done. Removed ${removed} entries. Written: ${outBase}`);

// Now re-sign with apksigner (v2 + v3)
const java       = 'C:\\Program Files\\Android\\Android Studio\\jbr\\bin\\java.exe';
const apksigner  = 'C:\\Users\\pasha\\AppData\\Local\\Android\\Sdk\\build-tools\\36.0.0\\lib\\apksigner.jar';
const ks         = path.join(__dirname, 'assets', 'usman90.jks');
const outSigned  = outBase.replace('.apk', '-signed.apk');

const signCmd = [
    `"${java}" -jar "${apksigner}" sign`,
    `--ks "${ks}"`,
    `--ks-key-alias usman90`,
    `--ks-pass "pass:God112256@"`,
    `--key-pass "pass:God112256@"`,
    `--v1-signing-enabled false`,   // minSdk=24 → v1 not required
    `--v2-signing-enabled true`,
    `--v3-signing-enabled true`,
    `--out "${outSigned}"`,
    `"${outBase}"`
].join(' ');

console.log('[SIGN] Running apksigner...');
try {
    execSync(signCmd, { stdio: 'pipe' });
    console.log(`[SIGN] Signed: ${outSigned}`);
    const size = fs.statSync(outSigned).size;
    console.log(`[SIGN] Size: ${(size/1024/1024).toFixed(2)} MB`);
} catch(e) {
    console.error('[SIGN] Failed:', e.stderr?.toString() || e.message);
    process.exit(1);
}
