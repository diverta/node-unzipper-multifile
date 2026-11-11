'use strict';

var test = require('tap').test;
var Stream = require('stream');
var unzip = require('../');
var buildArchive = require('./lib/zipBuilder').buildArchive;
var dataDescriptor = require('../lib/dataDescriptor');

var SIGNATURE = Buffer.from([0x50, 0x4b, 0x07, 0x08]);

// Data descriptor signatures inside the entry data, followed by sizes that do
// not describe the bytes before them: two in a row, and one so close to the
// end that its fields overlap the real descriptor.
var TRAP = Buffer.concat([
  Buffer.from('head:'), SIGNATURE, Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]),
  SIGNATURE, Buffer.from(':tail:'), SIGNATURE, Buffer.from('end')
]);
var SECOND = Buffer.from('second entry follows the descriptor');
var EMPTY = Buffer.alloc(0);

function chunked(buffer, sizes) {
  var chunks = [];
  var position = 0;
  var i = 0;
  while (position < buffer.length) {
    var size = sizes[Math.min(i++, sizes.length - 1)];
    chunks.push(buffer.slice(position, position + size));
    position += size;
  }
  var source = new Stream.Readable({read: function() {}});
  chunks.forEach(function(chunk) { source.push(chunk); });
  source.push(null);
  return source;
}

function parseAll(source) {
  return new Promise(function(resolve, reject) {
    var results = [];
    var pending = [];
    source
      .pipe(unzip.Parse({forceStream: true}))
      .on('error', reject)
      .on('data', function(entry) {
        pending.push(entry.buffer().then(function(data) {
          return {entry: entry, data: data};
        }));
      })
      .on('finish', function() {
        // entry.size comes from the descriptor, which is read after the entry ends.
        Promise.all(pending).then(function(read) {
          resolve(read.map(function(r) {
            return {path: r.entry.path, data: r.data, size: r.entry.size};
          }));
        }, reject);
      });
  });
}

function expectEntries(t, results, entries) {
  t.equal(results.length, entries.length, 'entry count');
  entries.forEach(function(entry, i) {
    var result = results[i] || {};
    t.equal(result.path, entry.name, 'path of ' + entry.name);
    t.ok(result.data && result.data.equals(entry.data), 'content of ' + entry.name);
    t.equal(result.size, entry.data.length, 'size of ' + entry.name + ' from the data descriptor');
  });
}

[
  {label: 'stored', deflate: false, localZip64: false, descriptor64: false},
  {label: 'deflated', deflate: true, localZip64: false, descriptor64: false},
  {label: 'stored, zip64', deflate: false, localZip64: true, descriptor64: true},
  {label: 'deflated, zip64', deflate: true, localZip64: true, descriptor64: true},
  {label: 'zip64 extra, 4-byte descriptor sizes', deflate: true, localZip64: true, descriptor64: false},
  {label: 'no zip64 extra, 8-byte descriptor sizes', deflate: true, localZip64: false, descriptor64: true}
].forEach(function(variant) {
  var entries = [TRAP, EMPTY, SECOND].map(function(data, i) {
    return {
      name: ['trap.bin', 'empty.txt', 'second.txt'][i], data: data, deflate: variant.deflate,
      localZip64: variant.localZip64, descriptor64: variant.descriptor64
    };
  });
  var archive = buildArchive(entries);

  test('ignores a descriptor signature inside entry data (' + variant.label + ')', function(t) {
    parseAll(chunked(archive, [archive.length])).then(function(results) {
      expectEntries(t, results, entries);
      t.end();
    }, function(err) {
      t.fail(err.message);
      t.end();
    });
  });

  test('finds the real descriptor wherever chunks split (' + variant.label + ')', function(t) {
    var splits = [];
    for (var at = 1; at < archive.length; at++) splits.push([at, archive.length]);
    for (var size = 1; size <= 32; size++) splits.push([size]);

    splits.reduce(function(previous, sizes) {
      return previous.then(function() {
        return parseAll(chunked(archive, sizes)).then(function(results) {
          var ok = results.length === entries.length && results.every(function(result, i) {
            return result.path === entries[i].name && result.data.equals(entries[i].data) &&
              result.size === entries[i].data.length;
          });
          if (!ok) t.fail('chunk sizes ' + JSON.stringify(sizes));
        }, function(err) {
          t.fail('chunk sizes ' + JSON.stringify(sizes) + ': ' + err.message);
        });
      });
    }, Promise.resolve()).then(function() {
      t.pass('all ' + splits.length + ' chunkings parsed');
      t.end();
    });
  });
});

// Past 4GB the 4-byte and 8-byte layouts can only be told apart by their fields.
test('matcher reads sizes past 4GB in either descriptor layout', function(t) {
  var dataLength = 0x100000010;
  function descriptor(fields) {
    return Buffer.concat([SIGNATURE, Buffer.alloc(4)].concat(fields.map(function(v) {
      var b = Buffer.alloc(4); b.writeUInt32LE(v, 0); return b;
    })).concat([Buffer.from('PK\u0003\u0004')]));
  }
  // compressed 0x1_00000010, uncompressed 0x2_00000020
  var wide = descriptor([0x10, 0x1, 0x20, 0x2]);
  var narrow = descriptor([0x10, 0x20]);

  [false, true].forEach(function(zip64) {
    var m = dataDescriptor.matcher(zip64);
    t.equal(m.describes(wide, 0, dataLength), true, 'accepts 8-byte sizes (zip64 extra: ' + zip64 + ')');
    t.equal(m.length(), 24, '8-byte layout length (zip64 extra: ' + zip64 + ')');
    t.equal(dataDescriptor.parse(wide.slice(0, 24)).uncompressedSize, 0x200000020, '8-byte uncompressed size');

    var n = dataDescriptor.matcher(zip64);
    t.equal(n.describes(narrow, 0, dataLength), true, 'accepts 4-byte sizes (zip64 extra: ' + zip64 + ')');
    t.equal(n.length(), 16, '4-byte layout length (zip64 extra: ' + zip64 + ')');
  });
  t.equal(dataDescriptor.matcher(false).describes(wide, 0, dataLength + 1), false, 'rejects other lengths');
  t.end();
});
