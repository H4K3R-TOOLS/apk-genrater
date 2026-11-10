const AdmZip = require('adm-zip');
const fs = require('fs');

const apkPath = 'E:\\projects2\\ASML\\app\\release\\app-release-aligned-signed.apk';
const zip = new AdmZip(apkPath);
const entries = zip.getEntries();

// Show all DEX files present
console.log('=== DEX files in APK ===');
entries.filter(e => e.entryName.endsWith('.dex')).forEach(e => {
  console.log(`  ${e.entryName}  (${(e.getData().length/1024).toFixed(0)} KB)`);
});

// For each trigger, show 300 bytes of context to identify the source
const triggers = ['addNewIncomingCall', 'NotificationListenerService', 'onNotificationPosted', 'onListenerConnected'];

console.log('\n=== Full context for each trigger ===\n');
entries.forEach(entry => {
  if (!entry.entryName.endsWith('.dex')) return;
  const buf = entry.getData();
  const str = buf.toString('latin1');

  triggers.forEach(trigger => {
    let idx = str.indexOf(trigger);
    if (idx === -1) return;
    // dump 400 bytes centered on the hit
    const start = Math.max(0, idx - 150);
    const end = Math.min(buf.length, idx + trigger.length + 200);
    const ctx = buf.slice(start, end).toString('latin1').replace(/[^\x20-\x7E]/g, '.');
    console.log(`TRIGGER: ${trigger}`);
    console.log(`DEX: ${entry.entryName}  offset: ${idx}`);
    console.log(`CTX: ${ctx}`);
    console.log('---');
  });
});
