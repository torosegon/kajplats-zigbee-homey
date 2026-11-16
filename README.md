# KAJPLATS Zigbee – Homey app

Control IKEA KAJPLATS (and VARMBLIXT) lights that were switched from Matter to their hidden
Zigbee mode on Homey Pro, using `homey-zigbeedriver`.

| Driver | Capabilities |
|---|---|
| **KAJPLATS colour (CWS, Zigbee)** – `kajplats_color` | `onoff`, `dim`, `light_hue`, `light_saturation`, `light_temperature`, `light_mode` |
| **KAJPLATS white spectrum (WS, Zigbee)** – `kajplats_white` | `onoff`, `dim`, `light_temperature` |

Both drivers accept the same identifiers: every known KAJPLATS modelID (based on
[zigbee-herdsman-converters](https://github.com/Koenkk/zigbee-herdsman-converters)), plus an
empty modelID and manufacturerName, because some bulbs report empty Basic cluster attributes in
Zigbee mode. Whether a bulb is added as a colour or a white light is decided by **the driver you
start pairing from**.

## Installation

```bash
npm install
homey app install        # installs the app permanently on Homey Pro
# or in development mode, with a live log:
homey app run --remote
```

## Pairing

1. If the bulb is already paired in another app (e.g. the *IKEA Kajplats Zigbee* CT driver, or
   Homey's IKEA app as a STARKVIND), remove it there first.
2. Homey → *Add device* → **KAJPLATS Zigbee** → **KAJPLATS colour (CWS, Zigbee)**.
   Make sure to start from this app: generic Zigbee pairing may assign the bulb to Homey's
   IKEA app.
3. **Matter pairing:** switch the bulb off and on 6 times in a row (about 1 s on / 1 s off)
   until it starts blinking. It is now in Matter pairing mode.
4. **Zigbee mode:** then switch it off and on 12 times in a row. The bulb blinks again once it
   has entered Zigbee pairing mode, and Homey finds it.

## How it works

- The choice between hue/saturation and xy commands, and the colour temperature range, come
  from the ColorControl `colorCapabilities` and `colorTempPhysicalMin/MaxMireds` attributes.
  If the bulb does not answer, the documented range is used: CWS 153–555 mired
  (6500–1800 K), WS 153–454 mired.
- **Colour command** setting (colour driver only): *Automatic* / *Hue-saturation* /
  *CIE xy*. If colours look wrong, try the other one.
- State is kept in sync by attribute reports (onOff, currentLevel, colorMode, hue/sat, xy,
  mireds) and by reading the state at startup and after every power-on (end device announce).
  Changes made from another controller (e.g. a remote) and power-ons after a power cut
  therefore show up in Homey.
- **Verbose logging** setting: logs Zigbee commands and the node structure. The node structure
  is always logged on first initialisation, regardless of this setting.

## Limitations

- There is no OTA in Zigbee mode; firmware can only be updated over Matter.
- Zigbee mode is not an officially supported IKEA feature.
- Runs on Homey Pro only (`platforms: local`); Homey Bridge does not run community apps.
