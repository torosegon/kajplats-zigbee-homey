'use strict';

const Homey = require('homey');

class KajplatsZigbeeApp extends Homey.App {

  async onInit() {
    this.log('KAJPLATS Zigbee app is running');
  }

}

module.exports = KajplatsZigbeeApp;
