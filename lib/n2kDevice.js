/**
 * Copyright 2025 Scott Bender (scott@scottbender.net)
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

const debug = require('debug')('canboatjs:n2kdevice')
const EventEmitter = require('events')
const _ = require('lodash')
const Uint64LE = require('int64-buffer').Uint64LE
const { defaultTransmitPGNs, defaultReceivePGNs, getIndustryCode, getManufacturerCode, getDeviceClassCode } = require('./codes')
const { toPgn } = require('./toPgn')
let packageJson

try
{
  packageJson = require('../' + 'package.json')
} catch (ex) {
}

const deviceTransmitPGNs = [ 60928, 59904, 126996, 126464 ]
const deviceReceivePGNs = [ 60928, 59904, 126996, 126464 ]

class N2kDevice extends EventEmitter {
  /**
   * 
   * @param {*} options : list of options used to configure the n2k device
   * uniqueNumber: (if not specified in addressClaim)
   *   set the unique number of the address claim, otherwise it will be set at random
   * addressClaim:
   *   Dictionary containing the device information for address claim procedure (pgn 60928)
   * productInfo:
   *   Specify the product informations, published on pgn 126996
   * configurationInfo:
   *   Specify the configuration informations, published on pgn 126998
   * serverUrl | serverDescription | serverVersion: (if configurationInfo is not specified)
   *   Used to set the configuration informations, published on pgn 126998
   * preferredAddress:
   *   Specify the preferred source address to claim in the address claim procedure
   * addressClaimDetectionTime:
   *   Specify the rate used to check conflicts on the address claim procedure
   * disableDefaultTransmitPGNs | disableDefaultReceivePGNs:
   *   Specify if the defaultTransmitPGNs|defaultReceivePGNs should be set or not
   * transmitPGNs | receivePGNs:
   *   Specify additional transmitPGNs|receivePGNs to set, published on pgn 126464
   */
  constructor (options) {
    super()

    if ( options.addressClaim ) {
      this.addressClaim = options.addressClaim
      this.addressClaim.pgn = 60928
      this.addressClaim.dst = 255
      this.addressClaim.prio = 6
    } else {
      this.addressClaim = {
        pgn: 60928,
        dst: 255,
        prio:6,        
        "Manufacturer Code": 999,
        "Device Function": 130,      // PC gateway
        "Device Class": 25,          // Inter/Intranetwork Device
        "Device Instance Lower": 0,
        "Device Instance Upper": 0,
        "System Instance": 0,
        "Industry Group": 4,          // Marine
        "Reserved1": 1,
        "Reserved2": 2
      }
    }
    // usually set at random, it makes more sense to set it indipendently from the addressClaim information
    if ( this.addressClaim["Unique Number"] === undefined )
      this.addressClaim["Unique Number"] = options.uniqueNumber || Math.floor(Math.random() * 2097151)

    let version = packageJson ? packageJson.version : "1.0"

    if ( options.productInfo ) {
      this.productInfo = options.productInfo
      this.productInfo.pgn = 126996
      this.productInfo.dst = 255
    } else {
      this.productInfo = {
        pgn: 126996,
        dst: 255,
        "NMEA 2000 Version": 1300,
        "Product Code": 667,   // Just made up..
        "Model ID": "Signal K",
        "Model Version": "canboatjs",
        "Model Serial Code": "000001",  // this solve a different purpose from "unique number"
        "Certification Level": 0,
        "Load Equivalency": 1
      }
    }

    this.productInfo["Software Version Code"] = version

    if ( options.configurationInfo ) {
      this.configurationInfo = options.configurationInfo
      this.configurationInfo.pgn = 126998
      this.configurationInfo.dst = 255
    } else if ( options.serverVersion && options.serverUrl ) {
      this.configurationInfo = {
        pgn: 126998,
        dst: 255,
        "Installation Description #1": options.serverUrl,
        "Installation Description #2": options.serverDescription,
        "Manufacturer Information": options.serverVersion
      }
    }

    this.options = _.isUndefined(options) ? {} : options

    this.address = _.isUndefined(options.preferredAddress) ? 100 : options.preferredAddress
    this.cansend = false
    this.foundConflict = false
    this.heartbeatCounter = 0
    this.devices = {}
    this.sentAvailable = false
    this.addressClaimDetectionTime = options.addressClaimDetectionTime !== undefined ? options.addressClaimDetectionTime : 5000

    if ( !options.disableDefaultTransmitPGNs ) {
      this.transmitPGNs = _.union(deviceTransmitPGNs, defaultTransmitPGNs)
    } else {
      this.transmitPGNs = [...deviceTransmitPGNs]
    }

    if ( this.options.transmitPGNs ) {
      this.transmitPGNs = _.union(this.transmitPGNs,
                                  this.options.transmitPGNs)
    }

    if ( !options.disableDefaultReceivePGNs ) {
      this.receivePGNs = _.union(deviceReceivePGNs, defaultReceivePGNs)
    } else {
      this.receivePGNs = [...deviceReceivePGNs]
    }

    if ( this.options.receivePGNs ) {
      this.receivePGNs = _.union(this.receivePGNs, this.options.receivePGNs)
    }
  }

  start() {
    sendISORequest(this, 60928, 254)
    setTimeout(() => {
      sendAddressClaim(this)
    }, 1000)
  }

  setStatus(msg) {
    if ( this.options.app && this.options.app.setPluginStatus ) {
      this.options.app.setProviderStatus(this.options.providerId, msg)
    }
  }

  n2kMessage(pgn) {
    if ( pgn.dst == 255 || pgn.dst == this.address ) {
      try {
        if ( pgn.pgn == 59904 ) {
          handleISORequest(this, pgn)
        } else if ( pgn.pgn == 126208 ) {
          handleGroupFunction(this, pgn)
        } else if ( pgn.pgn == 60928 ) {
          handleISOAddressClaim(this, pgn)
        } else if ( pgn.pgn == 126996 ) {
          handleProductInformation(this, pgn)
        }
      } catch ( err ) {
        console.error(err)
        console.error(err.stack)
      }

      /*
      var handler = this.handlers[pgn.pgn.toString()]
      if ( pgn.dst == this.address )
        debug(`handler ${handler}`)
      if ( _.isFunction(handler) ) {
        debug(`got handled PGN %j  ${handled}`, pgn)
        handler(pgn)
      }
      */
    }
  }

  sendPGN(pgn, src) {
  }
}

function handleISORequest(device, n2kMsg) {
  debug('handleISORequest %j', n2kMsg)

  switch (n2kMsg.fields.PGN) {
  case 126996:  // Product Information request
    sendProductInformation(device)
    break;
  case 126998:  // Config Information request
    sendConfigInformation(device)
    break;
  case 60928:   // ISO address claim request
    device.sendPGN(device.addressClaim)
    break;
  case 126464:
    sendPGNList(device)
    break;
  default:
    if ( !device.options.disableNAKs ) {
      debug(`Got unsupported ISO request for PGN ${n2kMsg.fields.PGN}. Sending NAK.`)
      sendNAKAcknowledgement(device, n2kMsg.src, n2kMsg.fields.PGN)
    }
  }
}

function handleGroupFunction(device, n2kMsg) {
  debug('handleGroupFunction %j', n2kMsg)
  if(n2kMsg.fields["Function Code"] === 'Request') {
    handleRequestGroupFunction(device, n2kMsg)
  } else if(n2kMsg.fields["Function Code"] === 'Command') {
    handleCommandGroupFunction(device, n2kMsg)
  } else {
    debug('Got unsupported Group Function PGN: %j', n2kMsg)
  }

  function handleRequestGroupFunction(device, n2kMsg) {
    if ( !device.options.disableNAKs ) {
      // We really don't support group function requests for any PGNs yet -> always respond with pgnErrorCode 1 = "PGN not supported"
      debug("Sending 'PGN Not Supported' Group Function response for requested PGN", n2kMsg.fields.PGN)
      
      const acknowledgement = {
        pgn: 126208,
        dst: n2kMsg.src,
        "Function Code": 2,
        "PGN": n2kMsg.fields.PGN,
        "PGN error code": 4,
        "Transmission interval/Priority error code": 0,
      "# of Parameters": 0
      }
      device.sendPGN(acknowledgement)
    }
  }

  function handleCommandGroupFunction(device, n2kMsg) {
    if ( !device.options.disableNAKs ) {
      // We really don't support group function commands for any PGNs yet -> always respond with pgnErrorCode 1 = "PGN not supported"
      debug("Sending 'PGN Not Supported' Group Function response for commanded PGN", n2kMsg.fields.PGN)
      
      const acknowledgement = {
        pgn: 126208,
        dst: n2kMsg.src,
        "Function Code": 2,
        "PGN": n2kMsg.fields.PGN,
        "PGN error code": 4,
      "Transmission interval/Priority error code": 0,
        "# of Parameters": 0
      }
      device.sendPGN(acknowledgement)
    }
  }
}

function handleISOAddressClaim(device, n2kMsg) {
  if ( n2kMsg.src != device.address ) {
    if ( !device.devices[n2kMsg.src] ) {
      debug(`registering device ${n2kMsg.src}`)
      device.devices[n2kMsg.src] = { addressClaim: n2kMsg }
      if ( device.cansend ) {
        //sendISORequest(device, 126996, undefined, n2kMsg.src)
      }
    }
    return
  }

  debug('Checking ISO address claim. %j', n2kMsg)

  const uint64ValueFromReceivedClaim = getISOAddressClaimAsUint64(n2kMsg)
  const uint64ValueFromOurOwnClaim = getISOAddressClaimAsUint64(device.addressClaim)

  if(uint64ValueFromOurOwnClaim < uint64ValueFromReceivedClaim) {
    debug(`Address conflict detected! Kept our address as ${device.address}.`)
    sendAddressClaim(device)      // We have smaller address claim data -> we can keep our address -> re-claim it
  } else if(uint64ValueFromOurOwnClaim > uint64ValueFromReceivedClaim) {
    this.foundConflict = true
    increaseOwnAddress(device)    // We have bigger address claim data -> we have to change our address
    debug(`Address conflict detected!  trying address ${device.address}.`)
    sendAddressClaim(device)
  }
}

function increaseOwnAddress(device) {
  var start = device.address
  do {
    device.address = (device.address + 1) % 253
  } while ( device.address != start && device.devices[device.address] )
}

function handleProductInformation(device, n2kMsg) {
  if ( !device.devices[n2kMsg.src] ) {
    device.devices[n2kMsg.src] = {}
  }
  debug('got product information %j', n2kMsg)
  device.devices[n2kMsg.src].productInformation = n2kMsg
}

function sendHeartbeat(device)
{
  device.heartbeatCounter = device.heartbeatCounter + 1
  if ( device.heartbeatCounter > 252 )
  {
    device.heartbeatCounter = 0
  }
  device.sendPGN({
    pgn: 126993,
    dst: 255,
    prio:7,
    "Data transmit offset": "00:01:00",
    "Sequence Counter": device.heartbeatCounter,
    "Controller 1 State":"Error Active"
  })
}


function sendAddressClaim(device) {
  if ( device.devices[device.address] ) {
    //someone already has this address, so find a free one
    increaseOwnAddress(device)
  }
  debug(`Sending address claim ${device.address}`)
  device.sendPGN(device.addressClaim)
  device.setStatus(`Claimed address ${device.address}`)
  device.addressClaimSentAt = Date.now()
  if ( device.addressClaimChecker ) {
    clearTimeout(device.addressClaimChecker)
  }
  
  device.addressClaimChecker = setTimeout(() => {
    //if ( Date.now() - device.addressClaimSentAt > 1000 ) {
      //device.addressClaimChecker = null
      debug('claimed address %d', device.address)
      device.cansend = true
      if ( !device.sentAvailable ) {
        if ( device.options.app ) {
          device.options.app.emit('nmea2000OutAvailable')
        }
        device.emit('nmea2000OutAvailable')
          device.sentAvailable = true
      }
      sendISORequest(device, 126996)
      if ( !device.heartbeatInterval ) {
        device.heartbeatInterval = setInterval(() => {
          sendHeartbeat(device)
        }, 60*1000)
      }
    //}
  }, device.addressClaimDetectionTime)
}

function sendISORequest(device, pgn, src, dst=255) {
  debug(`Sending iso request for ${pgn} to ${dst}`)

  const isoRequest = {
    pgn: 59904,
    dst: dst,
    "PGN": pgn
  }
  device.sendPGN(isoRequest, src)
}


function sendProductInformation(device) {
  debug("Sending product info..")

  device.sendPGN(device.productInfo)
}

function sendConfigInformation(device) {
  if ( device.configurationInfo ) {
    debug("Sending config info..")
    device.sendPGN(device.configurationInfo)
  }
}

function sendNAKAcknowledgement(device, src, requestedPGN) {
  const acknowledgement = {
    pgn: 59392,
    dst: src,
    Control: 1,
    "Group Function": 255,
    PGN: requestedPGN
  }
  device.sendPGN(acknowledgement)
}

// TAMA : 2025-05-16 : send both received and transmitted PGN List
function _sendPGNList(device, src, pgnlist, funcode=0) {
  //FIXME: for now, adding everything that signalk-to-nmea2000 supports
  //need a way for plugins, etc. to register the pgns they provide
  const pgnList = {
    pgn: 126464,
    dst: src,
    "Function Code": funcode,
    list: pgnlist
  }
  device.sendPGN(pgnList)
}

function sendPGNList(device, src) {
  _sendPGNList(device,src,device.receivePGNs,1);
  _sendPGNList(device,src,device.transmitPGNs,0);
}

function getISOAddressClaimAsUint64(pgn) {
  return new Uint64LE(toPgn(pgn))
}

module.exports = N2kDevice
