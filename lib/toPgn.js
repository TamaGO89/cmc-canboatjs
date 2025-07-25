/**
 * Copyright 2018 Scott Bender (scott@scottbender.net)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const { getField } = require('./fromPgn')
const { pgns, getCustomPgn, lookupEnumerationValue, lookupFieldTypeEnumerationValue, lookupBitEnumerationName, lookupFieldTypeEnumerationBits } = require('./pgns')
const _ = require('lodash')
const BitStream = require('bit-buffer').BitStream
const Int64LE = require('int64-buffer').Int64LE
const Uint64LE = require('int64-buffer').Uint64LE
const { getPlainPGNs } = require('./utilities')
const { encodeActisense, encodeActisenseN2KACSII, encodeYDRAW, encodeYDRAWFull, parseActisense, encodePCDIN, encodeMXPGN, encodePDGY } = require('./stringMsg')
const { encodeN2KActisense } = require('./n2k-actisense')
const { encodeCanId } = require('./canId')
const { getIndustryCode, getManufacturerCode } = require('./codes')
const debug = require('debug')('canboatjs:toPgn')

const RES_STRINGLAU = 'STRING_LAU' //'ASCII or UNICODE string starting with length and control byte'
const RES_STRINGLZ = 'STRING_LZ' //'ASCII string starting with length byte'


var fieldTypeWriters = {}
var fieldTypeMappers = {}

var lengthsOff = { 129029: 45, 127257:8, 127258:8, 127251:8 }

function toPgn(data) {
  const customPgns = getCustomPgn(data.pgn)
  let pgnList = pgns[data.pgn]
  if (!pgnList && !customPgns ) {
    debug("no pgn found: " + data.pgn)
    return
  }
  
  if ( customPgns ) {
    pgnList = [ ...customPgns.definitions, ...(pgnList || []) ]
  }
  
  const pgn_number = data.pgn
  var pgnData = pgnList[0]

  var bs = new BitStream(Buffer.alloc(500))

  if ( data.fields ) {
    data = data.fields
  }

  var fields = pgnData.Fields
  if ( !_.isArray(fields) ) {
    fields = [ fields.Field ]
  }
  let RepeatingFields = pgnData.RepeatingFieldSet1Size ? pgnData.RepeatingFieldSet1Size : 0
  for ( var index = 0; index < fields.length - RepeatingFields; index++ ) {
    var field = fields[index]
    var value = data[field.Id];

    if ( !_.isUndefined(field.Match) ) {
      //console.log(`matching ${field.Id} ${field.Match} ${value} ${_.isString(value)}`)
      if ( _.isString(value) ) {
        pgnList = pgnList.filter(f => f.Fields[index].Description == value)
      } else {
        pgnList = pgnList.filter(f => f.Fields[index].Match == value)
      }
      if ( pgnList.length > 0 ) {
        //console.log(`matched ${field.Id} ${pgnList[0].Fields[index].Match}`)
        pgnData = pgnList[0]
        value = pgnData.Fields[index].Match
        fields = pgnData.Fields
        RepeatingFields = pgnData.RepeatingFieldSet1Size ? pgnData.RepeatingFieldSet1Size : 0
      }
    }
    writeField(bs, pgn_number, field, data, value, fields)
  }

  if ( data.list ) {
    data.list.forEach(repeat => {
      for (var index = 0; index < RepeatingFields; index++ ) {
        var field = fields[pgnData.Fields.length-RepeatingFields+index]
        var value = repeat[field.Id];

        writeField(bs, pgn_number, field, data, value, fields)
      }
    })
  }

  var bitsLeft = (bs.byteIndex * 8) - bs.index
  if ( bitsLeft > 0 ) {
    //finish off the last byte
    bs.writeBits(0xffff, bitsLeft)
    //console.log(`bits left ${bitsLeft}`)
  }

  if ( pgnData.Length != 0xff
       && fields[fields.length-1].FieldType != RES_STRINGLAU
       && fields[fields.length-1].FieldType != RES_STRINGLZ
       && !RepeatingFields ) {

    var len = lengthsOff[pgnData.PGN] || pgnData.Length
    //console.log(`Length ${len}`)

    if ( bs.byteIndex < len ) {
      //console.log(`bytes left ${pgnData.Length-bs.byteIndex}`)
    }

    for ( var i = bs.byteIndex; i < len; i++ ) {
      bs.writeUint8(0xff)
    }
  }

  return bs.view.buffer.slice(0, bs.byteIndex)
}

function dumpWritten(bs, field, startPos, value) {
  //console.log(`${startPos} ${bs.byteIndex}`)
  if ( startPos == bs.byteIndex )
    startPos--
  var string = `${field.Id} (${field.BitLength}): [`
  for ( var i = startPos; i < bs.byteIndex; i++ ) {
    string = string + bs.view.buffer[i].toString(16) + ', '
  }
  console.log(string + `] ${value}`)
}

function writeField(bs, pgn_number, field, data, value, fields, bitLength) {
  var startPos = bs.byteIndex

  if ( _.isUndefined(bitLength) ) {
    if ( field.BitLengthVariable && field.FieldType === "KEY_VALUE" ) {
      bitLength = lookupKeyBitLength(data, fields)
    } else {
      bitLength = field.BitLength
    }
  }

  // console.log(`${field.Id}:${value}(${bitLength}-${field.Resolution})`)
  if ( _.isUndefined(value) || value === null) {
    if ( field.FieldType && fieldTypeWriters[field.FieldType] ) {
      fieldTypeWriters[field.FieldType](pgn_number, field, value, bs)
    } else if ( bitLength % 8  == 0 ) {
      var bytes = bitLength/8
      var lastByte = field.Signed ? 0x7f : 0xff
      var byte = field.Id.startsWith('reserved') ? 0x00 : 0xff
      for ( var i = 0; i < bytes-1; i++ ) {
        bs.writeUint8(0xff)
      }
      bs.writeUint8(field.Signed ? 0x7f : 0xff)
    } else {
      bs.writeBits(0xffffffff, bitLength)
    }
  } else {
    let type = field.FieldType
    if ( field.Id === 'industryCode' ) {
      if ( _.isString(value) ) {
        value = Number(getIndustryCode(value))
      }
    } else if ( type && fieldTypeMappers[type] ) {
      value = fieldTypeMappers[type](field, value)
    } else if ((field.FieldType === 'LOOKUP' ||
                field.FieldType === 'FIELDTYPE_LOOKUP') && _.isString(value)) {
      if (!(field.Id === "timeStamp" && value < 60)) {
        value = lookup(field, value)
      }
    }

    if (field.Resolution && typeof value === 'number' ) {
      value = Number((value / field.Resolution).toFixed(0))
    }

    if ( field.FieldType && fieldTypeWriters[field.FieldType] ) {
      fieldTypeWriters[field.FieldType](pgn_number, field, value, bs)
    } else {
      if ( _.isString(value) && typeof bitLength !== 'undefined' && bitLength !== 0 ) {
        value = Number(value)
      }

      if ( field.Unit === "kWh" ) {
        value /= 3.6e6; // 1 kWh = 3.6 MJ.
      } else if (field.Unit === "Ah") {
        value /= 3600.0; // 1 Ah = 3600 C.
      }
      if ( field.Offset ) {
        value -= field.Offset
      }

      if ( field.FieldType === 'VARIABLE' ) { 
        writeVariableLengthField(bs, pgn_number, data, field, value, fields)
      } else if ( _.isBuffer(value) ) {
        value.copy(bs.view.buffer, bs.byteIndex)
        bs.byteIndex += value.length
      } else if (bitLength === 8) {
        if (field.Signed) {
          bs.writeInt8(value)
        } else {
          bs.writeUint8(value)
        }
      } else if (bitLength === 16) {
        if (field.Signed) {
          bs.writeInt16(value)
        } else {
          bs.writeUint16(value)
        }
      } else if (bitLength === 32) {
        if (field.Signed) {
          bs.writeInt32(value)
        } else {
          bs.writeUint32(value) 
        }
      } else if (bitLength === 48 || bitLength == 24) {
        var count = bitLength/8;
        var val = value;
        if ( value < 0 ) {
          val++
        }
        while (count-- > 0 ) {
          if ( value > 0 ) {
            bs.writeUint8(val & 255);
            val /= 256;
          } else {
            bs.writeUint8(((-val) & 255) ^ 255);
            val /= 256;
          }
        }
      } else if (bitLength === 64) {
        var num
        if (field.Signed) {
          num = new Int64LE(value)
        } else {
          num = new Int64LE(value)
        }
        var buf = num.toBuffer()
        buf.copy(bs.view.buffer, bs.byteIndex)
        bs.byteIndex += buf.length
      } else {
        bs.writeBits(value, bitLength)
      }
    }
  }
  //dumpWritten(bs, field, startPos, value)
}

  function writeVariableLengthField(bs, pgn_number, pgn, field, value, fields) {
  var refField = getField(pgn.PGN, bs.view.buffer[bs.byteIndex-1]-1, pgn)

  if ( refField ) {
    var bits = (refField.BitLength + 7) & ~7; // Round # of bits in field refField up to complete bytes: 1->8, 7->8, 8->8 etc.

    return writeField(bs, pgn_number, refField, pgn, value, fields, bits)
  }
}

function lookup(field, stringValue) {
  var res
  if ( field.LookupEnumeration ) {
    res = lookupEnumerationValue(field.LookupEnumeration, stringValue)
  } else {
    res = lookupFieldTypeEnumerationValue(field.LookupFieldTypeEnumeration, stringValue)
  }
  return _.isUndefined(res) ? stringValue : res
}

function lookupKeyBitLength(data, fields)
{
  let field = fields.find(field => (field.Id === 'key'))

  let val = data['Key']
  if ( typeof val === 'string' ) {
    val = lookupFieldTypeEnumerationValue(field.LookupFieldTypeEnumeration, val)
  }
  return lookupFieldTypeEnumerationBits(field.LookupFieldTypeEnumeration, val)
}

function isDefined(value) {
  return typeof value !== 'undefined' && value != null
}

function parseHex(s) {
  return parseInt(s, 16)
};

function canboat2Buffer(canboatData) {
  return Buffer.alloc(canboatData.split(',').slice(6).map(parseHex), 'hex')
}

function pgnToActisenseSerialFormat(pgn) {
  return encodeActisense({ pgn: pgn.pgn, data: toPgn(pgn), dst: pgn.dst, src: pgn.src, prio: pgn.prio})
}

function pgnToActisenseN2KAsciiFormat(pgn) {
  return encodeActisenseN2KACSII({ pgn: pgn.pgn, data: toPgn(pgn), dst: pgn.dst, src: pgn.src, prio: pgn.prio})
}

function pgnToN2KActisenseFormat(pgn) {
  return encodeN2KActisense({ pgn: pgn.pgn, data: toPgn(pgn), dst: pgn.dst, src: pgn.src, prio: pgn.prio})
}

function toiKonvertSerialFormat(pgn, data, dst=255) {
  return `!PDGY,${pgn},${dst},${data.toString('base64')}`
}

function pgnToiKonvertSerialFormat(pgn) {
  return toiKonvertSerialFormat(pgn.pgn, toPgn(pgn), pgn.dst)
}

function pgnToYdgwRawFormat(info) {
  return encodeYDRAW({ ...info, data: toPgn(info) })
}

function pgnToYdgwFullRawFormat(info) {
  return encodeYDRAWFull({ ...info, data: toPgn(info) })
}

function pgnToPCDIN(info) {
  return encodePCDIN({ ...info, data: toPgn(info) })
}

function pgnToMXPGN(info) {
  return encodeMXPGN({ ...info, data: toPgn(info) })
}

const actisenseToYdgwRawFormat = _.flow(parseActisense, encodeYDRAW)
const actisenseToYdgwFullRawFormat = _.flow(parseActisense, encodeYDRAWFull)
const actisenseToPCDIN = _.flow(parseActisense, encodePCDIN)
const actisenseToMXPGN = _.flow(parseActisense, encodeMXPGN)
const actisenseToiKonvert = _.flow(parseActisense, encodePDGY)
const actisenseToN2KAsciiFormat = _.flow(parseActisense, encodeActisenseN2KACSII)
const actisenseToN2KActisenseFormat = _.flow(parseActisense, encodeN2KActisense)

function bitIsSet(field, index, value) {
  return value.indexOf(lookupBitEnumerationName(field.LookupBitEnumeration, index)) != -1
}

fieldTypeWriters['BITLOOKUP'] = (pgn, field, value, bs) => {
  if ( _.isUndefined(value) || value.length === 0 ) {
    if ( field.BitLength % 8  == 0 ) {
      var bytes = field.BitLength/8
      var lastByte = field.Signed ? 0x7f : 0xff
      for ( var i = 0; i < bytes-1; i++ ) {
        bs.writeUint8(0x0)
      }
      bs.writeUint8(0x0)
    } else {
      bs.writeBits(0xffffffff, field.BitLength)
    }
  } else {
    for ( var i = 0; i < field.BitLength; i++ ) {
      bs.writeBits(bitIsSet(field, i, value) ? 1 : 0, 1)
    }
  }
}

fieldTypeWriters['STRING_FIX'] = (pgn, field, value, bs) => {

  let fill = 0xff
  if ( (pgn === 129810 && (field.Id === "vendorId" || field.Id === "allsign")) || (pgn === 129809 && field.Id === 'name') ) {
    if ( _.isUndefined(value) || value.length == 0 ) {
      {
        fill = 0x40
        value = ""
      }
    }
  }

  if ( _.isUndefined(value) ) {
    value = ""
  }
  var fieldLen = field.BitLength / 8

  for ( var i = 0; i < value.length; i++ ) {
    bs.writeUint8(value.charCodeAt(i))
  }

  for ( var i = 0; i < fieldLen - value.length; i++ ) {
    bs.writeUint8(fill)
  }
}

fieldTypeWriters[RES_STRINGLZ] = (pgn, field, value, bs) => {
  if ( _.isUndefined(value) ) {
    value = ""
  }
  bs.writeUint8(value.length)
  for ( var i = 0; i < value.length; i++ ) {
    bs.writeUint8(value.charCodeAt(i))
  }  
  bs.writeUint8(0)
}

fieldTypeWriters["String with start/stop byte"] = (pgn, field, value, bs) => {
  if ( _.isUndefined(value) ) {
    value = ""
  }
  bs.writeUint8(0x02)
  for ( var i = 0; i < value.length; i++ ) {
    bs.writeUint8(value.charCodeAt(i))
  }
  bs.writeUint8(0x01)
}

fieldTypeWriters[RES_STRINGLAU] = (pgn, field, value, bs) => {
  if ( pgn === 129041 && field.Id === "atonName" ) {
    if ( value.length > 18 ) {
      value = value.substring(0, 18)
    } else {
      value = value.padEnd(18, ' ')
    }
  }

  bs.writeUint8(value ? value.length+2 : 2)
  bs.writeUint8(1)
  
  if ( value ) {
    for ( var idx = 0; idx < value.length; idx++ ) {
      bs.writeUint8(value.charCodeAt(idx))
    }
  }
}

fieldTypeMappers['DATE'] = (field, value) => {
  //console.log(`Date: ${value}`)
  if ( _.isString(value) ) {
    var date = new Date(value)
    return date.getTime() / 86400 / 1000
  }

  return value
}

fieldTypeMappers['TIME'] = (field, value) => {
  if ( _.isString(value) ) {
    var split = value.split(':')

    var hours = Number(split[0])
    var minutes = Number(split[1])
    var seconds = Number(split[2])

    value = (hours * 60 * 60) + (minutes * 60) + seconds
  }
  return value
}

/*
fieldTypeMappers['Manufacturer code'] = (field, value) => {
  if ( _.isString(value) ) {
    value = getManufacturerCode(value)
  }
  return Number(value)
  }
*/

fieldTypeMappers['Pressure'] = (field, value) => {
  if (field.Unit)
  {
    switch (field.Unit[0]) {
    case 'h':
    case 'H':
      value /= 100;
      break;
    case 'k':
    case 'K':
      value /= 1000;
      break;
    case 'd':
      value *= 10;
      break;
    }
  }
  return value
}


module.exports.canboat2Buffer = canboat2Buffer
module.exports.toPgn = toPgn
module.exports.toiKonvertSerialFormat = toiKonvertSerialFormat
module.exports.pgnToiKonvertSerialFormat = pgnToiKonvertSerialFormat
module.exports.pgnToYdgwRawFormat = pgnToYdgwRawFormat
module.exports.pgnToYdgwFullRawFormat = pgnToYdgwFullRawFormat
module.exports.actisenseToYdgwRawFormat = actisenseToYdgwRawFormat
module.exports.actisenseToYdgwFullRawFormat = actisenseToYdgwFullRawFormat
module.exports.pgnToActisenseSerialFormat = pgnToActisenseSerialFormat
module.exports.pgnToActisenseN2KAsciiFormat = pgnToActisenseN2KAsciiFormat
module.exports.pgnToN2KActisenseFormat = pgnToN2KActisenseFormat
module.exports.pgnToPCDIN = pgnToPCDIN
module.exports.actisenseToPCDIN = actisenseToPCDIN
module.exports.pgnToMXPGN = pgnToMXPGN
module.exports.actisenseToMXPGN = actisenseToMXPGN
module.exports.actisenseToiKonvert = actisenseToiKonvert
module.exports.actisenseToN2KAsciiFormat = actisenseToN2KAsciiFormat
module.exports.actisenseToN2KActisenseFormat = actisenseToN2KActisenseFormat
