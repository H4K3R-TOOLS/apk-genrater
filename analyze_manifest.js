const AdmZip = require('adm-zip');
const zip = new AdmZip('assets/base.apk');
const buf = zip.getEntry('AndroidManifest.xml').getData();
const strCount = buf.readUInt32LE(16);
const strStart = buf.readUInt32LE(28);

function getString(idx){
  if(idx === 0xFFFFFFFF || idx >= strCount || idx < 0) return null;
  const off = buf.readUInt32LE(36 + idx*4);
  const abs = 8 + strStart + off;
  const len = buf.readUInt16LE(abs);
  return buf.toString('utf16le', abs+2, abs+2+len*2);
}

const strPoolChunkSize = buf.readUInt32LE(12);
const resIdStart = 8 + strPoolChunkSize;
const resIdSize  = buf.readUInt32LE(resIdStart+4);
const xmlStart   = resIdStart + resIdSize;

let p = xmlStart;
let depth = 0;

while(p < buf.length - 8){
  const nodeType = buf.readUInt16LE(p);
  const nodeSize = buf.readUInt32LE(p+4);

  if(nodeType === 0x0102){ // START_ELEMENT
    const nameIdx   = buf.readUInt32LE(p+16);
    const attrStart = buf.readUInt16LE(p+20);
    const attrSize  = buf.readUInt16LE(p+22);
    const attrCount = buf.readUInt16LE(p+24);
    const name = getString(nameIdx) || '?';

    const pad = '  '.repeat(depth);
    let line = pad + '<' + name;

    for(let a = 0; a < attrCount; a++){
      const aBase    = p + 8 + attrStart + a * attrSize;
      const aNameIdx = buf.readUInt32LE(aBase + 4);
      const aRawIdx  = buf.readUInt32LE(aBase + 8);
      const aType    = buf[aBase + 12];
      const aData    = buf.readUInt32LE(aBase + 16);

      const aName = getString(aNameIdx) || '?';
      let aVal;
      if(aType === 0x03 || aType === 0x08){
        aVal = getString(aRawIdx) || getString(aData) || '?';
      } else if(aType === 0x12){
        aVal = aData ? 'true' : 'false';
      } else if(aType === 0x10){
        aVal = aData;
      } else {
        aVal = '0x' + aData.toString(16);
      }
      line += ' ' + aName + '=' + JSON.stringify(String(aVal));
    }
    line += '>';
    console.log(line);
    depth++;

  } else if(nodeType === 0x0103){ // END_ELEMENT
    depth = Math.max(0, depth-1);
  }

  if(!nodeSize || nodeSize > buf.length - p) break;
  p += nodeSize;
}
