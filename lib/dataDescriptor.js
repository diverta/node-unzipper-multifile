var binary = require('binary');
var Buffer = require('./Buffer');

var SIGNATURE = Buffer.alloc(4);
SIGNATURE.writeUInt32LE(0x08074b50, 0);

var LENGTH = 16;
var ZIP64_LENGTH = 24;
var UINT32 = 0x100000000;

// Records that can follow a data descriptor.
var NEXT_SIGNATURES = [
  0x04034b50, // local file header
  0x02014b50, // central directory file header
  0x08064b50, // archive extra data
  0x05054b50, // digital signature
  0x06064b50, // zip64 end of central directory
  0x06054b50  // end of central directory
];

function startsRecord(buffer, at) {
  return NEXT_SIGNATURES.indexOf(buffer.readUInt32LE(at)) !== -1;
}

/**
 * Tells the data descriptor that closes an entry apart from the same four
 * signature bytes occurring inside its compressed data: only the real one
 * records the number of bytes that precede it.
 *
 * The 8-byte size layout cannot be trusted to the zip64 extra field alone:
 * some writers use 8-byte sizes past 4GB without one, others keep 4-byte
 * sizes despite one. When the fields fit both layouts, the record that
 * follows decides, and the zip64 extra field only breaks a remaining tie.
 *
 * @param {boolean} zip64 The local header carries a zip64 extra field.
 * @return {{describes: function(Buffer, number, number): (boolean|undefined), length: function(): number}}
 *   `describes(buffer, at, dataLength)` is undefined while the bytes it needs
 *   have not arrived; `length()` is the size of the accepted descriptor.
 */
function matcher(zip64) {
  var length = zip64 ? ZIP64_LENGTH : LENGTH;

  function describes(buffer, at, dataLength) {
    if (buffer.length < at + 16) return undefined;
    var low = buffer.readUInt32LE(at + 8);
    var high = buffer.readUInt32LE(at + 12);
    // An 8-byte size that matches always matches in its low 4 bytes too.
    if (low !== dataLength % UINT32) return false;
    if (low + high * UINT32 !== dataLength) {
      length = LENGTH;
      return true;
    }
    if (buffer.length < at + ZIP64_LENGTH + 4) return undefined;
    var narrowNext = startsRecord(buffer, at + LENGTH);
    var wideNext = startsRecord(buffer, at + ZIP64_LENGTH);
    if (narrowNext !== wideNext) {
      length = wideNext ? ZIP64_LENGTH : LENGTH;
    } else {
      length = zip64 ? ZIP64_LENGTH : LENGTH;
    }
    return true;
  }

  return {
    describes: describes,
    length: function() { return length; }
  };
}

/**
 * @param {Buffer} data A whole descriptor, signature included.
 * @return {{crc32: number, compressedSize: number, uncompressedSize: number}}
 */
function parse(data) {
  if (data.length === ZIP64_LENGTH) {
    return binary.parse(data)
      .word32lu('dataDescriptorSignature')
      .word32lu('crc32')
      .word64lu('compressedSize')
      .word64lu('uncompressedSize')
      .vars;
  }
  return binary.parse(data)
    .word32lu('dataDescriptorSignature')
    .word32lu('crc32')
    .word32lu('compressedSize')
    .word32lu('uncompressedSize')
    .vars;
}

module.exports = {
  SIGNATURE: SIGNATURE,
  matcher: matcher,
  parse: parse
};
