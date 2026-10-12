import { parseArguments } from './arguments';
import { version } from './runtime';

const help = `Mukai — your AI workspace, in your browser.

Usage:
  mukai serve [--port 47831] [--open] [--data-dir PATH]
  mukai status [--data-dir PATH]
  mukai doctor [--data-dir PATH]
  mukai --version
  mukai --help

serve runs locally in the foreground. Ctrl+C stops it.
--port 0 selects an available port. PORT sets the default port.
Data defaults to the desktop app's data directory, or MUKAI_DATA_DIR.
One backend per data directory. --data-dir selects a separate installation.
Re-run the installer to upgrade; it preserves application data.`;

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  switch (options.command) {
    case 'help':
      console.log(help);
      return 0;
    case 'version':
      console.log(version());
      return 0;
    case 'serve':
      await (await import('./commands/serve')).serve(options);
      return 0;
    case 'status':
      return (await import('./commands/status')).status(options.dataDir);
    case 'doctor':
      return (await import('./commands/doctor')).doctor(options.dataDir);
  }
}
void main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    console.error(
      code === 'EADDRINUSE'
        ? 'Port is already in use. Choose another --port or stop the existing Mukai server.'
        : error instanceof Error
          ? error.message
          : 'Mukai could not start.',
    );
    process.exitCode = 1;
  });
