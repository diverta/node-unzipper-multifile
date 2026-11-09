'use strict';

var test = require('tap').test;
var zlib = require('zlib');
var Buffer = require('../lib/Buffer');
var unzip = require('../');

var probe = zlib.createInflateRaw();
var supported = typeof probe.bytesWritten === 'number' || typeof probe.bytesRead === 'number';
probe.close();

function makeArchive(name, payload) {
  var fileName = Buffer.from(name);
  // Level-zero DEFLATE preserves the inner ZIP's descriptor bytes.
  var compressed = zlib.deflateRawSync(payload, { level: 0 });
  var crc = 0xffffffff;
  for (var i = 0; i < payload.length; i++) {
    crc ^= payload[i];
    for (var bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  crc = (crc ^ 0xffffffff) >>> 0;

  var local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(fileName.length, 26);

  var descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(crc, 4);
  descriptor.writeUInt32LE(compressed.length, 8);
  descriptor.writeUInt32LE(payload.length, 12);

  var central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(fileName.length, 28);

  var end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + fileName.length, 12);
  end.writeUInt32LE(local.length + fileName.length + compressed.length + descriptor.length, 16);
  return Buffer.concat([local, fileName, compressed, descriptor, central, fileName, end]);
}

test('parse a nested ZIP with an unknown compressed size', {
  timeout: 3000,
  skip: !supported
}, function(t) {
  var inner = makeArchive('hello.txt', Buffer.from('hello'));
  var outer = makeArchive('nested.zip', inner);
  var parser = unzip.Parse();
  var contents;

  parser.on('entry', function(entry) {
    contents = entry.buffer();
    contents.catch(t.threw.bind(t));
  });
  parser.promise().then(function() {
    return contents;
  }).then(function(data) {
    t.same(data, inner, 'preserved the complete nested ZIP');
    t.end();
  }, t.threw.bind(t));

  parser.end(outer);
});
