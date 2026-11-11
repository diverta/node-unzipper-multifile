'use strict';

// Builds archives the way streaming writers do: every entry has bit 3 set,
// zero sizes in the local header and its sizes in a trailing data descriptor.
var zlib = require('zlib');

var CRC_TABLE = (function() {
  var table = [];
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table.push(c >>> 0);
  }
  return table;
})();

function crc32(buf) {
  var crc = 0xffffffff;
  for (var i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(v) { var b = Buffer.alloc(2); b.writeUInt16LE(v, 0); return b; }
function u32(v) { var b = Buffer.alloc(4); b.writeUInt32LE(v, 0); return b; }
function u64(v) { var b = Buffer.alloc(8); b.writeUInt32LE(v % 0x100000000, 0); b.writeUInt32LE(Math.floor(v / 0x100000000), 4); return b; }

// A zip64 extra field as streaming writers emit it: both sizes still unknown.
var ZIP64_LOCAL_EXTRA = Buffer.concat([u16(0x0001), u16(16), u64(0), u64(0)]);

/**
 * @param {Array<{name: string, data: Buffer, deflate: boolean, zip64: boolean,
 *   localZip64: boolean, descriptor64: boolean}>} entries
 *   `deflate` uses level 0, so the payload appears verbatim in the compressed data.
 *   `zip64` sets both `localZip64` (zip64 extra field in the local header) and
 *   `descriptor64` (8-byte sizes in the data descriptor); either can be set alone.
 * @return {Buffer}
 */
function buildArchive(entries) {
  var parts = [];
  var central = [];
  var offset = 0;

  entries.forEach(function(entry) {
    var name = Buffer.from(entry.name);
    var method = entry.deflate ? 8 : 0;
    var body = entry.deflate ? zlib.deflateRawSync(entry.data, {level: 0}) : entry.data;
    var crc = crc32(entry.data);
    var localZip64 = entry.localZip64 !== undefined ? entry.localZip64 : !!entry.zip64;
    var descriptor64 = entry.descriptor64 !== undefined ? entry.descriptor64 : !!entry.zip64;
    var extra = localZip64 ? ZIP64_LOCAL_EXTRA : Buffer.alloc(0);

    var local = Buffer.concat([
      u32(0x04034b50), u16(localZip64 ? 45 : 20), u16(0x0008), u16(method), u16(0), u16(0),
      u32(0), u32(0), u32(0), u16(name.length), u16(extra.length), name, extra
    ]);
    var descriptor = descriptor64
      ? Buffer.concat([u32(0x08074b50), u32(crc), u64(body.length), u64(entry.data.length)])
      : Buffer.concat([u32(0x08074b50), u32(crc), u32(body.length), u32(entry.data.length)]);

    central.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0008), u16(method), u16(0), u16(0),
      u32(crc), u32(body.length), u32(entry.data.length), u16(name.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), name
    ]));
    parts.push(local, body, descriptor);
    offset += local.length + body.length + descriptor.length;
  });

  var centralDir = Buffer.concat(central);
  var end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralDir.length), u32(offset), u16(0)
  ]);
  return Buffer.concat(parts.concat([centralDir, end]));
}

module.exports = {buildArchive: buildArchive};
