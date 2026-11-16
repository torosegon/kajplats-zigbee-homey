'use strict';

const KajplatsLightDevice = require('../../lib/KajplatsLightDevice');

/** IKEA KAJPLATS colour / white spectrum (CWS) bulb in Zigbee mode. */
class KajplatsColorDevice extends KajplatsLightDevice {

  get isColorLight() {
    return true;
  }

}

module.exports = KajplatsColorDevice;
