import { execFileSync } from 'node:child_process';
import { mkdir, copyFile, readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const expectedNode = (await readFile(join(root, '.nvmrc'), 'utf8')).trim();
if (process.version !== `v${expectedNode}`) throw new Error(`Node.js ${expectedNode} is required to build; found ${process.version}.`);
const expected = (await readFile(join(root, '.go-version'), 'utf8')).trim();
const runGo = (args, options = {}) => execFileSync('go', args, { cwd: root, encoding: 'utf8', ...options });
async function copyAsset(source, destination) {
  // Go module-cache files are read-only; keep generated copies writable so the
  // next build can replace them without requiring elevated permissions.
  try { await chmod(destination, 0o644); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await copyFile(source, destination);
  await chmod(destination, 0o644);
}
const version = runGo(['env', 'GOVERSION']).trim();
if (version !== `go${expected}`) throw new Error(`Go ${expected} is required; found ${version}.`);
const goroot = runGo(['env', 'GOROOT']).trim();
const output = join(root, 'web/public/wasm');
await mkdir(output, { recursive: true });
runGo(['build', '-trimpath', '-ldflags=-s -w', '-o', join(output, 'core.wasm'), './cmd/wasm'], {
  env: { ...process.env, GOOS: 'js', GOARCH: 'wasm' }, stdio: 'inherit',
});
const netipx = runGo(['list', '-m', '-f', '{{.Dir}}', 'go4.org/netipx']).trim();
await copyAsset(join(goroot, 'lib/wasm/wasm_exec.js'), join(output, 'wasm_exec.js'));
// Homebrew keeps LICENSE next to libexec; official Go archives keep it in GOROOT.
try {
  await copyAsset(join(goroot, 'LICENSE'), join(output, 'GO-LICENSE'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  await copyAsset(join(goroot, '..', 'LICENSE'), join(output, 'GO-LICENSE'));
}
await copyAsset(join(netipx, 'LICENSE'), join(output, 'NETIPX-LICENSE'));
await writeFile(join(output, 'build.json'), `${JSON.stringify({ go: version, target: 'js/wasm' }, null, 2)}\n`);
console.log(`Built core.wasm and copied wasm_exec.js from ${version}.`);
