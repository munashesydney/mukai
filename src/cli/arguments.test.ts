import { describe, expect, it } from 'vitest';
import { parseArguments } from './arguments';

describe('CLI arguments', () => {
  it('supports foreground browser serving, ephemeral ports, and explicit data paths', () => {
    expect(
      parseArguments(['serve', '--port', '0', '--open', '--data-dir', './data']),
    ).toMatchObject({ command: 'serve', port: 0, open: true });
    expect(parseArguments(['serve'], '8080').port).toBe(8080);
    expect(parseArguments(['serve', '--port', '9000'], '8080').port).toBe(9000);
    expect(parseArguments(['--version'], 'invalid').command).toBe('version');
    expect(parseArguments(['update'], 'invalid').command).toBe('update');
  });
  it('fails on unknown commands, ambiguous flags and invalid ports', () => {
    for (const args of [
      ['wat'],
      ['serve', '--port', '-1'],
      ['serve', '--port', '65536'],
      ['serve', '--port', '1.5'],
      ['serve', '--host', '0.0.0.0'],
      ['serve', 'extra'],
      ['status', '--open'],
      ['doctor', '--port', '80'],
      ['update', '--open'],
      ['update', '--port', '80'],
      ['serve', '--data-dir', ''],
    ])
      expect(() => parseArguments(args)).toThrow();
  });
});
