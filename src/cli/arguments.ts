import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { defaultDataDir } from '../server/config';

export interface CliArguments {
  command: 'help' | 'version' | 'serve' | 'status' | 'doctor' | 'auth-reset' | 'update';
  port: number;
  open: boolean;
  dataDir: string;
}
export function parseArguments(args: string[], envPort = process.env.PORT): CliArguments {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      port: { type: 'string' },
      open: { type: 'boolean' },
      'data-dir': { type: 'string' },
    },
  });
  const command = values.help ? 'help' : values.version ? 'version' : positionals[0] || 'help';
  if (!['help', 'version', 'serve', 'status', 'doctor', 'auth-reset', 'update'].includes(command))
    throw new Error(`Unknown command: ${command}. Run mukai --help.`);
  if (positionals.length > 1) throw new Error('Unexpected arguments. Run mukai --help.');
  if (!['serve', 'help', 'version'].includes(command) && (values.port !== undefined || values.open))
    throw new Error('--port and --open apply to mukai serve.');
  const rawPort = values.port ?? (command === 'serve' ? envPort : undefined) ?? '47831';
  if (!/^\d+$/.test(rawPort) || Number(rawPort) > 65535)
    throw new Error('--port must be an integer between 0 and 65535 (0 selects an available port).');
  if (values['data-dir'] === '') throw new Error('--data-dir requires a directory.');
  return {
    command: command as CliArguments['command'],
    port: Number(rawPort),
    open: Boolean(values.open),
    dataDir: resolve(values['data-dir'] ?? defaultDataDir()),
  };
}
