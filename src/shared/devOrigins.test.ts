import { describe, expect, it } from 'vitest';
import {
  apiPort,
  backendOrigin,
  DEFAULT_API_PORT,
  DESKTOP_DEV_PORT,
  devOriginPorts,
  isDevOrigin,
  isDevUiOrigin,
  WEB_DEV_PORT,
  webDevPort,
} from './devOrigins';

describe('dev UI ports', () => {
  it('keeps the Desktop and browser dev UIs on separate ports by default', () => {
    expect(DESKTOP_DEV_PORT).toBe(5173);
    expect(WEB_DEV_PORT).toBe(5273);
    expect(webDevPort({})).toBe(WEB_DEV_PORT);
    expect(apiPort({})).toBe(DEFAULT_API_PORT);
  });

  it('follows the port a standalone backend uses', () => {
    expect(apiPort({ PORT: '47900' })).toBe(47900);
    expect(apiPort({ PORT: '47900', MUKAI_API_PORT: '47950' })).toBe(47950);
    expect(apiPort({ PORT: 'not-a-port' })).toBe(DEFAULT_API_PORT);
    expect(apiPort({ PORT: '0' })).toBe(DEFAULT_API_PORT);
  });

  it('moves only the browser UI when asked to', () => {
    expect(webDevPort({ MUKAI_WEB_PORT: '5300' })).toBe(5300);
    expect(webDevPort({ MUKAI_WEB_PORT: '70000' })).toBe(WEB_DEV_PORT);
    expect(devOriginPorts({ MUKAI_WEB_PORT: '5300' })).toEqual([DESKTOP_DEV_PORT, 5300]);
  });
});

describe('backend origin', () => {
  it('is the loopback origin of the port the backend listens on', () => {
    expect(backendOrigin({})).toBe(`http://127.0.0.1:${DEFAULT_API_PORT}`);
    expect(backendOrigin({ PORT: '47900' })).toBe('http://127.0.0.1:47900');
    expect(backendOrigin({ MUKAI_API_PORT: '47950' })).toBe('http://127.0.0.1:47950');
  });

  it('is trusted as this machine but is not itself a dev UI', () => {
    for (const env of [{}, { PORT: '47900' }, { MUKAI_API_PORT: '47950' }]) {
      expect(isDevOrigin(backendOrigin(env), env)).toBe(true);
      expect(isDevUiOrigin(backendOrigin(env), env)).toBe(false);
    }
  });

  it('only trusts the origin of the backend that is actually configured', () => {
    expect(isDevOrigin('http://127.0.0.1:47900', { PORT: '47900' })).toBe(true);
    expect(isDevOrigin('http://127.0.0.1:47900', {})).toBe(false);
    expect(isDevOrigin('http://localhost:47831', {})).toBe(false);
    expect(isDevOrigin(`https://127.0.0.1:${DEFAULT_API_PORT}`, {})).toBe(false);
  });
});

describe('dev origin allowlist', () => {
  it('accepts both dev UIs on either loopback host', () => {
    for (const origin of [
      'http://127.0.0.1:5173',
      'http://localhost:5173',
      'http://127.0.0.1:5273',
      'http://localhost:5273',
    ]) {
      expect(isDevUiOrigin(origin, {})).toBe(true);
      expect(isDevOrigin(origin, {})).toBe(true);
    }
  });

  it('rejects other ports, hosts, and shapes', () => {
    for (const origin of [
      'http://127.0.0.1:5174',
      'http://127.0.0.1:47999',
      'https://127.0.0.1:5273',
      'http://evil.example:5273',
      'http://127.0.0.1.evil.example:5273',
      'http://127.0.0.1:5273/extra',
      'http://localhost',
      'file://',
      'null',
      '',
    ])
      expect(isDevOrigin(origin, {})).toBe(false);
  });

  it('adds configured loopback entries and ignores the rest', () => {
    const env = {
      MUKAI_DEV_ORIGINS:
        '5300, http://127.0.0.1:5301 , https://evil.example:5302, 99999, localhost:5303',
    };
    expect(devOriginPorts(env)).toEqual([DESKTOP_DEV_PORT, WEB_DEV_PORT, 5300, 5301]);
    expect(isDevOrigin('http://localhost:5301', env)).toBe(true);
    expect(isDevOrigin('http://127.0.0.1:5302', env)).toBe(false);
    expect(isDevOrigin('http://127.0.0.1:5303', env)).toBe(false);
  });

  it('never lists the same port twice', () => {
    expect(devOriginPorts({ MUKAI_WEB_PORT: '5173', MUKAI_DEV_ORIGINS: '5173' })).toEqual([5173]);
  });
});
