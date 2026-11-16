'use strict';

const KajplatsLightDevice = require('../../lib/KajplatsLightDevice');

/** IKEA KAJPLATS white spectrum (WS) bulb in Zigbee mode. */
class KajplatsWhiteDevice extends KajplatsLightDevice {

  get isColorLight() {
    return false;
  }

}

module.exports = KajplatsWhiteDevice;
