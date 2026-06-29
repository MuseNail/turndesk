import './setup-globals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { xlsxBlob } from '../js/app/utils.js';

// Independent CRC32 (same polynomial) so the test doesn't trust the implementation's table.
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

async function unzipStored(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer);
  // EOCD is the last 22 bytes (we write no zip comment).
  const eocdOff = buf.length - 22;
  assert.equal(dv.getUint32(eocdOff, true), 0x06054b50, 'EOCD signature');
  const count = dv.getUint16(eocdOff + 10, true);
  let cd = dv.getUint32(eocdOff + 16, true);
  const files = {};
  for (let i = 0; i < count; i++) {
    assert.equal(dv.getUint32(cd, true), 0x02014b50, 'central header signature');
    const crc = dv.getUint32(cd + 16, true);
    const size = dv.getUint32(cd + 20, true);
    const nameLen = dv.getUint16(cd + 28, true);
    const localOff = dv.getUint32(cd + 42, true);
    const name = new TextDecoder().decode(buf.slice(cd + 46, cd + 46 + nameLen));
    assert.equal(dv.getUint32(localOff, true), 0x04034b50, 'local header signature');
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.slice(dataStart, dataStart + size);
    assert.equal(crc32(data), crc, `CRC for ${name}`);
    files[name] = new TextDecoder().decode(data);
    cd += 46 + nameLen;
  }
  return files;
}

test('xlsxBlob builds a valid stored zip with all workbook parts', async () => {
  const blob = xlsxBlob([
    { name: 'Totals', rows: [['Technician', 'Billed'], ['Kat', 1234.5], ['Emily', 0]] },
    { name: 'Kat', rows: [['Date', 'Service', 'Amount'], ['2026-06-08', 'Gel Manicure <deluxe> & "art"', 45]] },
  ]);
  const files = await unzipStored(blob);
  const names = Object.keys(files);
  assert.deepEqual(names.sort(), [
    '[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels',
    'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml',
  ].sort());
  assert.match(files['xl/workbook.xml'], /<sheet name="Totals" sheetId="1"/);
  assert.match(files['xl/workbook.xml'], /<sheet name="Kat" sheetId="2"/);
  // Numbers are numeric cells; strings are inline strings; XML is escaped.
  assert.match(files['xl/worksheets/sheet1.xml'], /<c r="B2"><v>1234.5<\/v><\/c>/);
  assert.match(files['xl/worksheets/sheet1.xml'], /<c r="A2" t="inlineStr"><is><t xml:space="preserve">Kat<\/t>/);
  assert.match(files['xl/worksheets/sheet2.xml'], /Gel Manicure &lt;deluxe&gt; &amp; &quot;art&quot;/);
  // Zero is a real numeric cell (not skipped like null/'').
  assert.match(files['xl/worksheets/sheet1.xml'], /<c r="B3"><v>0<\/v><\/c>/);
});

test('xlsxBlob sanitizes and dedupes sheet names (Excel rules)', async () => {
  const blob = xlsxBlob([
    { name: 'a/b:c?d', rows: [['x']] },
    { name: 'This sheet name is far far far too long for Excel', rows: [['x']] },
    { name: 'Same', rows: [['x']] },
    { name: 'same', rows: [['x']] },
  ]);
  const files = await unzipStored(blob);
  const wb = files['xl/workbook.xml'];
  const names = [...wb.matchAll(/<sheet name="([^"]+)"/g)].map(m => m[1]);
  assert.equal(names.length, 4);
  for (const n of names) {
    assert.ok(n.length <= 31, `≤31 chars: ${n}`);
    assert.ok(!/[\\/?*[\]:]/.test(n), `no forbidden chars: ${n}`);
  }
  assert.equal(new Set(names.map(n => n.toLowerCase())).size, 4, 'unique case-insensitively');
});
