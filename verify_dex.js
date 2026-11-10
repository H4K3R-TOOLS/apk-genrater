const AdmZip = require('adm-zip');

const apkPath = 'E:\\projects2\\ASML\\app\\release\\app-release-aligned-signed.apk';
const zip = new AdmZip(apkPath);
const entries = zip.getEntries();

const critical = [
  'ConnectionService',
  'addNewIncomingCall',
  'NotificationListenerService',
  'BIND_NOTIFICATION_LISTENER',
  'onNotificationPosted',
  'onListenerConnected',
];

let results = {};
critical.forEach(t => results[t] = []);

entries.forEach(entry => {
  if (!entry.entryName.endsWith('.dex')) return;
  const buf = entry.getData();
  const str = buf.toString('latin1');
  critical.forEach(trigger => {
    let idx = 0;
    while ((idx = str.indexOf(trigger, idx)) !== -1) {
      const start = Math.max(0, idx - 50);
      const end = Math.min(buf.length, idx + trigger.length + 80);
      const ctx = buf.slice(start, end).toString('latin1').replace(/[^\x20-\x7E]/g, '.');
      results[trigger].push({ dex: entry.entryName, offset: idx, ctx });
      idx += trigger.length;
    }
  });
});

console.log('\n=== DEX Play Protect Trigger Scan ===\n');
let allClear = true;
critical.forEach(t => {
  const hits = results[t];
  if (hits.length === 0) {
    console.log(`  ✅ ABSENT : ${t}`);
  } else {
    allClear = false;
    console.log(`  ❌ FOUND  : ${t} (${hits.length} hit${hits.length>1?'s':''})`);
    hits.slice(0,2).forEach(h => console.log(`     offset ${h.offset}: ${h.ctx.substring(0,100)}`));
  }
});

// Manifest scan
const manifestEntry = entries.find(e => e.entryName === 'AndroidManifest.xml');
console.log('\n=== Manifest Service Tag Scan ===');
if (manifestEntry) {
  const raw = manifestEntry.getData().toString('latin1');
  ['ConnectionService','NotificationListener','AlertWatcher','AudioRouteService','BIND_TELECOM','BIND_NOTIFICATION'].forEach(t => {
    const present = raw.includes(t);
    console.log(`  ${present ? '❌' : '✅'} ${t}: ${present ? 'PRESENT' : 'absent'}`);
    if (present) allClear = false;
  });
}

console.log('\n' + '='.repeat(50));
console.log(allClear ? '🟢  ALL CLEAR' : '🔴  PP TRIGGERS FOUND');
console.log('='.repeat(50) + '\n');
