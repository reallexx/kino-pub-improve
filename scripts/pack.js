const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const distDirectory = path.join(projectRoot, 'dist');
const manifest = JSON.parse(
  fs.readFileSync(path.join(projectRoot, 'manifest.json'), 'utf8')
);
const archiveName = `kino-pub-improve-${manifest.version}.zip`;
const archivePath = path.join(distDirectory, archiveName);

const includePaths = [
  'manifest.json',
  'background.js',
  'lib',
  'content-scripts',
  'popup',
  'options',
  'sidepanel',
  'report',
  'icons',
];

fs.mkdirSync(distDirectory, { recursive: true });
if (fs.existsSync(archivePath)) {
  fs.unlinkSync(archivePath);
}

const powershellCommand = [
  '$ErrorActionPreference = "Stop"',
  `New-Item -ItemType Directory -Force -Path "${distDirectory}" | Out-Null`,
  `$paths = @(${includePaths.map((entry) => `"${entry}"`).join(',')})`,
  `$existing = $paths | Where-Object { Test-Path (Join-Path "${projectRoot}" $_) }`,
  `Compress-Archive -Path ($existing | ForEach-Object { Join-Path "${projectRoot}" $_ }) -DestinationPath "${archivePath}" -Force`,
].join('; ');

execFileSync(
  'powershell.exe',
  ['-NoProfile', '-Command', powershellCommand],
  { cwd: projectRoot, stdio: 'inherit' }
);

console.log(`Packed: ${archivePath}`);
