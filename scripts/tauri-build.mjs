import { spawnSync } from 'node:child_process';
import process from 'node:process';

const env = { ...process.env };

// linuxdeploy ships its own (often older) strip binary. On rolling-release
// distributions such as Manjaro/Arch, that strip binary can fail on modern
// ELF sections such as .relr.dyn. Let the system toolchain handle stripping
// instead, and allow AppImage tools to run without FUSE when necessary.
if (process.platform === 'linux') {
  env.NO_STRIP = '1';
  env.APPIMAGE_EXTRACT_AND_RUN = '1';
}

const command = process.platform === 'win32' ? 'tauri.cmd' : 'tauri';
const result = spawnSync(command, ['build', ...process.argv.slice(2)], {
  env,
  stdio: 'inherit',
  shell: false
});

if (result.error) {
  console.error(`Failed to start Tauri CLI: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
