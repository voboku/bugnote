# bugnote

Static web granular sampler.

## Structure

- `index.html` - page entry
- `style.css` - visual styling
- `script.js` - p5.js and Web Audio logic
- `sounds/` - optional local sound assets
- `images/` - optional image assets
- `assets/` - optional shared assets

## Deploy

Upload the `bugnote` folder to any static host. The root entry should be `index.html`.

p5.js is loaded from CDN.

## iPhone Safari

Use an HTTPS static host when possible.

- Tap the center point to choose an audio file.
- Touch the cloud to play grains.
- iPhone uses a lighter particle and voice count for smoother playback.
- Recording depends on the browser's MediaRecorder support.
