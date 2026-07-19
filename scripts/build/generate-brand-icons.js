const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

const root = process.cwd();
const sourcePath = path.join(root, 'public', 'quantpilot-mark.svg');
const targets = [
  { size: 16, path: 'public/favicon-16.png' },
  { size: 32, path: 'public/favicon-32.png' },
  { size: 128, path: 'public/favicon.png' },
  { size: 180, path: 'public/apple-touch-icon.png' },
  { size: 192, path: 'public/icons/quantpilot-192.png' },
  { size: 512, path: 'public/icons/quantpilot-512.png' },
  { size: 512, path: 'public/QuantPilot_Icon.png' },
];

async function main() {
  const source = await fs.readFile(sourcePath);
  await Promise.all(targets.map(async (target) => {
    const outputPath = path.join(root, target.path);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await sharp(source, { density: 768 })
      .resize(target.size, target.size, { fit: 'contain' })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toFile(outputPath);
  }));
  console.log(`[brand-icons] generated ${targets.length} assets from public/quantpilot-mark.svg`);
}

main().catch((error) => {
  console.error('[brand-icons] failed', error);
  process.exit(1);
});
