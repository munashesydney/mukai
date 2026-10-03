import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { existsSync } from 'node:fs';
import type { BuildOptions, BuildResult } from 'esbuild';

/** Electron cannot spawn an executable through a virtual ASAR pathname. */
export function capabilityCompiler(runtimeFilename = __filename): typeof import('esbuild') {
  const runtimeRequire = createRequire(runtimeFilename);
  const entry = runtimeRequire.resolve('esbuild');
  if (entry.includes('.asar' + sep) && !process.env.ESBUILD_BINARY_PATH) {
    const platformPackage = runtimeRequire.resolve(
      `@esbuild/${process.platform}-${process.arch}/package.json`,
    );
    const binary = join(
      dirname(platformPackage),
      process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild',
    ).replace('.asar' + sep, '.asar.unpacked' + sep);
    if (!existsSync(binary)) throw new Error('The packaged TypeScript compiler binary is missing.');
    // Compiler configuration only; custom workers do not inherit this environment.
    // Set before loading esbuild, which reads the override during module initialization.
    process.env.ESBUILD_BINARY_PATH = binary;
  }
  return runtimeRequire('esbuild') as typeof import('esbuild');
}
export function buildCapability(options: BuildOptions): Promise<BuildResult> {
  return capabilityCompiler().build(options);
}
