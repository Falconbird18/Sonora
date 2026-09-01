import { spawnSync } from 'node:child_process';
import process from 'node:process';

const env = { ...process.env };
const args = ['build', ...process.argv.slice(2)];

if (process.platform === 'linux') {
  // AppImage's linuxdeploy ships an older strip binary that is incompatible
  // with modern ELF .relr.dyn sections commonly found on Arch/Manjaro.
  env.NO_STRIP = '1';
  env.APPIMAGE_EXTRACT_AND_RUN = '1';

  // The normal local Linux build should be reliable on rolling-release hosts.
  // AppImage is built separately in a clean Linux CI environment, where
  // linuxdeploy is much more predictable. Set SONORA_BUILD_APPIMAGE=1 to
  // explicitly request it locally.
  if (env.SONORA_BUILD_APPIMAGE !== '1' && !args.includes('--bundles')) {
    args.push('--bundles', 'deb,rpm');
  }
}

const command = process.platform === 'win32' ? 'tauri.cmd' : 'tauri';
const result = spawnSync(command, args, {
  env,
  stdio: 'inherit',
  shell: false
});

if (result.error) {
  console.error(`Failed to start Tauri CLI: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
