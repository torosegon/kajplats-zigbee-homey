'use strict';

const { ZigBeeLightDevice, Util } = require('homey-zigbeedriver');
const { CLUSTER } = require('zigbee-clusters');

const { mapValueRange, limitValue } = Util;

const MAX_LEVEL = 254;
const MAX_HUE = 254;
const MAX_SATURATION = 254;
const XY_SCALE = 65535;

// Physical colour temperature ranges according to IKEA / zigbee-herdsman-converters, used as a
// fallback when the bulb does not answer `colorTempPhysicalMin/MaxMireds` in Zigbee mode.
const CT_RANGE_COLOR = { min: 153, max: 555 }; // CWS: 6500 K – 1800 K
const CT_RANGE_WHITE = { min: 153, max: 454 }; // WS:  6500 K – 2200 K

const COLOR_CAPABILITIES = ['light_hue', 'light_saturation', 'light_mode'];

/**
 * Converts a CIE 1931 xy chromaticity (0–1) to Homey hue/saturation (0–1) through linear sRGB.
 * The bundled colour-space conversion is known to be inaccurate for bulb xy values, so a
 * small dedicated conversion is used here.
 */
function xyToHueSaturation(x, y) {
  if (!(y > 0)) return null;
  const Y = 1;
  const X = (Y / y) * x;
  const Z = (Y / y) * (1 - x - y);

  let r = X * 3.2406 - Y * 1.5372 - Z * 0.4986;
  let g = -X * 0.9689 + Y * 1.8758 + Z * 0.0415;
  let b = X * 0.0557 - Y * 0.2040 + Z * 1.0570;

  // Clip negatives (out-of-gamut) and normalise so the brightest channel is 1
  r = Math.max(0, r);
  g = Math.max(0, g);
  b = Math.max(0, b);
  const maxChannel = Math.max(r, g, b);
  if (maxChannel <= 0) return null;
  r /= maxChannel;
  g /= maxChannel;
  b /= maxChannel;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta > 0) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue /= 6;
    if (hue < 0) hue += 1;
  }
  const saturation = max === 0 ? 0 : delta / max;
  return { hue: limitValue(hue, 0, 1), saturation: limitValue(saturation, 0, 1) };
}

/**
 * Base device for IKEA KAJPLATS lights in Zigbee mode. Subclasses decide whether the light is a
 * colour (CWS) or a white spectrum (WS) light via the `isColorLight` getter.
 */
class KajplatsLightDevice extends ZigBeeLightDevice {

  /** @returns {boolean} true for colour/white spectrum (CWS) drivers */
  get isColorLight() {
    return false;
  }

  get defaultColorTempRange() {
    return this.isColorLight ? CT_RANGE_COLOR : CT_RANGE_WHITE;
  }

  async onNodeInit({ zclNode, node }) {
    if (this.getSetting('debug_logging')) this.enableDebug();
    if (this.isFirstInit() || this.getSetting('debug_logging')) this.printNode();

    await this._ensureCapabilities();
    await this._configureColorControl();

    await super.onNodeInit({
      zclNode,
      node,
      supportsHueAndSaturation: this._resolveHueSaturationSupport(),
      supportsColorTemperature: this._resolveColorTemperatureSupport(),
    });

    this._registerAttributeListeners(zclNode);

    if (this.isFirstInit()) {
      await this._configureReporting().catch(err => this.error('Attribute reporting setup failed', err));
    }

    // Pull the current state once so the UI matches the bulb after (re)start
    this._syncState().catch(err => this.error('Initial state sync failed', err));
  }

  async onEndDeviceAnnounce() {
    // A KAJPLATS bulb announces itself after every power cycle, refresh everything then
    await this._syncState().catch(err => this.error('State sync after announce failed', err));
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('color_command_mode')) {
      // Applied on the next colour command, the `supportsHueAndSaturation` getter reads it live
      this.log('Colour command mode changed to', newSettings.color_command_mode);
    }
    if (changedKeys.includes('debug_logging')) {
      if (newSettings.debug_logging) this.enableDebug();
      else this.disableDebug();
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Capability / colour configuration
  // ---------------------------------------------------------------------------------------------

  async _ensureCapabilities() {
    const wanted = ['onoff', 'dim', 'light_temperature', ...(this.isColorLight ? COLOR_CAPABILITIES : [])];
    for (const capabilityId of wanted) {
      if (!this.hasCapability(capabilityId)) {
        await this.addCapability(capabilityId).catch(this.error);
      }
    }
    if (!this.isColorLight) {
      for (const capabilityId of COLOR_CAPABILITIES) {
        if (this.hasCapability(capabilityId)) {
          await this.removeCapability(capabilityId).catch(this.error);
        }
      }
    }
  }

  /**
   * Reads the ColorControl attributes once and stores sane fallbacks. In Zigbee mode KAJPLATS
   * bulbs report empty Basic cluster attributes and may not answer every ColorControl
   * attribute, in which case the library would otherwise end up with `undefined` ranges.
   */
  async _configureColorControl() {
    if (!this.getStoreValue('kajplatsColorConfigured')) {
      try {
        const attributes = await this.colorControlCluster.readAttributes([
          'colorCapabilities', 'colorTempPhysicalMinMireds', 'colorTempPhysicalMaxMireds',
        ]);
        this.log('ColorControl attributes', attributes);
        const caps = attributes.colorCapabilities || {};
        await this.setStoreValue('colorCapabilities', {
          hueAndSaturation: caps.hueAndSaturation,
          enhancedHue: caps.enhancedHue,
          colorLoop: caps.colorLoop,
          xy: caps.xy,
          colorTemperature: caps.colorTemperature,
        });
        await this.setStoreValue('colorTempMin', attributes.colorTempPhysicalMinMireds);
        await this.setStoreValue('colorTempMax', attributes.colorTempPhysicalMaxMireds);
        await this.setStoreValue('kajplatsColorConfigured', true);
      } catch (err) {
        this.error('Could not read ColorControl attributes, using defaults', err);
      }
    }

    // Validate the stored colour temperature range, fall back to the documented range
    const fallback = this.defaultColorTempRange;
    const validMired = v => typeof v === 'number' && v >= 50 && v <= 1000;
    let min = this.getStoreValue('colorTempMin');
    let max = this.getStoreValue('colorTempMax');
    if (!validMired(min) || !validMired(max) || min >= max) {
      min = fallback.min;
      max = fallback.max;
    }
    await this.setStoreValue('colorTempMin', min);
    await this.setStoreValue('colorTempMax', max);
    // Prevent the library from re-reading (and overwriting) the validated values
    await this.setStoreValue('colorClusterConfigured', true);
  }

  _resolveHueSaturationSupport() {
    if (!this.isColorLight) return false;
    const mode = this.getSetting('color_command_mode') || 'auto';
    if (mode === 'hs') return true;
    if (mode === 'xy') return false;
    const caps = this.getStoreValue('colorCapabilities') || {};
    // Unknown → KAJPLATS CWS supports both hs and xy, prefer hs
    return caps.hueAndSaturation !== false;
  }

  _resolveColorTemperatureSupport() {
    const caps = this.getStoreValue('colorCapabilities') || {};
    // Every KAJPLATS bulb is at least white spectrum
    return caps.colorTemperature !== false;
  }

  // Library getter, overridden so the device setting is honoured without a restart
  get supportsHueAndSaturation() {
    return this._resolveHueSaturationSupport();
  }

  get colorTemperatureRange() {
    const fallback = this.defaultColorTempRange;
    return {
      min: this.getStoreValue('colorTempMin') || fallback.min,
      max: this.getStoreValue('colorTempMax') || fallback.max,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // State feedback (attribute reports + reads)
  // ---------------------------------------------------------------------------------------------

  async _configureReporting() {
    const config = [
      { cluster: CLUSTER.ON_OFF, attributeName: 'onOff', minInterval: 0, maxInterval: 600 },
      {
        cluster: CLUSTER.LEVEL_CONTROL, attributeName: 'currentLevel', minInterval: 1, maxInterval: 600, minChange: 2,
      },
      {
        cluster: CLUSTER.COLOR_CONTROL, attributeName: 'colorTemperatureMireds', minInterval: 1, maxInterval: 600, minChange: 2,
      },
    ];
    if (this.isColorLight) {
      config.push(
        { cluster: CLUSTER.COLOR_CONTROL, attributeName: 'colorMode', minInterval: 1, maxInterval: 600 },
        {
          cluster: CLUSTER.COLOR_CONTROL, attributeName: 'currentHue', minInterval: 1, maxInterval: 600, minChange: 2,
        },
        {
          cluster: CLUSTER.COLOR_CONTROL, attributeName: 'currentSaturation', minInterval: 1, maxInterval: 600, minChange: 2,
        },
        {
          cluster: CLUSTER.COLOR_CONTROL, attributeName: 'currentX', minInterval: 1, maxInterval: 600, minChange: 100,
        },
        {
          cluster: CLUSTER.COLOR_CONTROL, attributeName: 'currentY', minInterval: 1, maxInterval: 600, minChange: 100,
        },
      );
    }
    await this.configureAttributeReporting(config);
    this.log('Attribute reporting configured');
  }

  _registerAttributeListeners(zclNode) {
    const endpoint = zclNode.endpoints[this.getClusterEndpoint(CLUSTER.COLOR_CONTROL) || 1];
    const { onOff, levelControl, colorControl } = endpoint.clusters;

    if (onOff) {
      onOff.on('attr.onOff', value => this._applyOnOff(value));
    }
    if (levelControl) {
      levelControl.on('attr.currentLevel', value => this._applyLevel(value));
    }
    if (colorControl) {
      colorControl.on('attr.colorTemperatureMireds', value => this._applyColorTemperature(value));
      colorControl.on('attr.colorMode', value => this._applyColorMode(value));
      colorControl.on('attr.currentHue', value => {
        if (this._isHsActive()) this._setCap('light_hue', limitValue(value / MAX_HUE, 0, 1));
      });
      colorControl.on('attr.currentSaturation', value => {
        if (this._isHsActive()) this._setCap('light_saturation', limitValue(value / MAX_SATURATION, 0, 1));
      });
      colorControl.on('attr.currentX', value => {
        this._lastX = value;
        this._applyXY();
      });
      colorControl.on('attr.currentY', value => {
        this._lastY = value;
        this._applyXY();
      });
    }
  }

  async _syncState() {
    const { onOff } = await this.onOffCluster.readAttributes(['onOff']);
    this._applyOnOff(onOff);

    const { currentLevel } = await this.levelControlCluster.readAttributes(['currentLevel']);
    if (onOff) this._applyLevel(currentLevel);

    const colorAttributes = ['colorMode', 'colorTemperatureMireds'];
    if (this.isColorLight) colorAttributes.push('currentHue', 'currentSaturation', 'currentX', 'currentY');
    const color = await this.colorControlCluster.readAttributes(colorAttributes);
    this.debug('Synced ColorControl state', color);

    if (typeof color.colorMode === 'string') this._colorMode = color.colorMode;
    if (typeof color.colorTemperatureMireds === 'number') this._applyColorTemperature(color.colorTemperatureMireds);

    if (this.isColorLight) {
      if (this._colorMode === 'currentXAndCurrentY') {
        this._lastX = color.currentX;
        this._lastY = color.currentY;
        this._applyXY();
      } else if (this._colorMode === 'currentHueAndCurrentSaturation') {
        if (typeof color.currentHue === 'number') this._setCap('light_hue', limitValue(color.currentHue / MAX_HUE, 0, 1));
        if (typeof color.currentSaturation === 'number') {
          this._setCap('light_saturation', limitValue(color.currentSaturation / MAX_SATURATION, 0, 1));
        }
      }
      if (this._colorMode) this._applyColorMode(this._colorMode);
    }
  }

  _applyOnOff(value) {
    this._setCap('onoff', !!value);
  }

  _applyLevel(level) {
    if (typeof level !== 'number') return;
    // Do not overwrite dim with 0 while off, Homey keeps the last brightness
    if (this.getCapabilityValue('onoff') === false) return;
    this._setCap('dim', limitValue(level / MAX_LEVEL, 0.01, 1));
  }

  _applyColorTemperature(mireds) {
    if (typeof mireds !== 'number' || mireds === 0 || mireds === 0xFFFF) return;
    const { min, max } = this.colorTemperatureRange;
    this._setCap('light_temperature', limitValue(mapValueRange(min, max, 0, 1, mireds), 0, 1));
  }

  _applyColorMode(colorMode) {
    this._colorMode = colorMode;
    if (!this.isColorLight) return;
    this._setCap('light_mode', colorMode === 'colorTemperatureMireds' ? 'temperature' : 'color');
  }

  _isHsActive() {
    return this.isColorLight && this._colorMode !== 'currentXAndCurrentY'
      && this._colorMode !== 'colorTemperatureMireds';
  }

  _applyXY() {
    if (!this.isColorLight || this._colorMode !== 'currentXAndCurrentY') return;
    if (typeof this._lastX !== 'number' || typeof this._lastY !== 'number') return;
    const hs = xyToHueSaturation(this._lastX / XY_SCALE, this._lastY / XY_SCALE);
    if (!hs) return;
    this._setCap('light_hue', hs.hue);
    this._setCap('light_saturation', hs.saturation);
  }

  _setCap(capabilityId, value) {
    if (!this.hasCapability(capabilityId)) return;
    if (this.getCapabilityValue(capabilityId) === value) return;
    this.setCapabilityValue(capabilityId, value).catch(this.error);
  }

}

module.exports = KajplatsLightDevice;
