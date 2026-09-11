'use strict';

const fs = require('node:fs');
const path = require('node:path');

fs.copyFileSync(
  path.join(__dirname, '../main/baileys-loader.cjs'),
  path.join(__dirname, '../dist/baileys-loader.cjs'),
);

// The first-run "is this PC the till or the scale station?" chooser is plain
// HTML loaded with loadFile, so it has to sit next to the compiled main
// process: electron-builder packages dist/** but not renderer/**, and a
// packaged build would otherwise open an empty window on first launch —
// the one moment the operator has no other way forward.
fs.copyFileSync(
  path.join(__dirname, '../renderer/station-setup.html'),
  path.join(__dirname, '../dist/station-setup.html'),
);
