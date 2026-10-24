const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const www = path.join(root, 'www');

if (fs.existsSync(www)) {
  fs.rmSync(www, { recursive: true, force: true });
}
fs.mkdirSync(www, { recursive: true });

const filesToCopy = [
  'index.html',
  'feed.html',
  'feed.css',
  'feed.js',
  'shared.js',
  'sync.js',
  'nostr.bundle.js',
  'manifest.json'
];

for (const file of filesToCopy) {
  const src = path.join(root, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(www, file));
  }
}

const iconsSrc = path.join(root, 'icons');
const iconsDest = path.join(www, 'icons');
if (fs.existsSync(iconsSrc)) {
  fs.cpSync(iconsSrc, iconsDest, { recursive: true });
}

console.log('✓ Složka www/ připravena pro Capacitor Android build.');
