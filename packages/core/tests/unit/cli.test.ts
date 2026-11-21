import { describe, expect, it } from 'vitest';
import { formatUnits, main, parseCliArgs, UsageError, type CliIo } from '../../src/poltergeist/cli.js';
import { serializeReport } from '../../src/poltergeist/report.js';
import { generateStorm } from '../../src/poltergeist/storm.js';
import { summon } from '../../src/poltergeist/summon.js';
import { ossuaryFactory } from '../../src/poltergeist/sut.js';
import { twinFactory } from '../../src/poltergeist/twinSut.js';

function capture(): CliIo & { out: string; err: string } {
  const io = {
    out: '',
    err: '',
    stdout(t: string) {
      io.out += t;
    },
    stderr(t: string) {
      io.err += t;
    },
    now: () => 0,
  };
  return io;
}

describe('poltergeist CLI', () => {
  it('defaults to seed 7, 2000 events, target ossuary', () => {
    expect(parseCliArgs([])).toEqual({ seed: 7, events: 2000, target: 'ossuary', json: false });
    expect(parseCliArgs(['--seed', '0', '--events', '20000', '--target', 'twin', '--json'])).toEqual({
      seed: 0,
      events: 20000,
      target: 'twin',
      json: true,
    });
  });

  it('exits 2 with usage on stderr, and nothing on stdout, for each usage error', async () => {
    const bad = [
      ['--foo'],
      ['--seed', '1', '--seed', '2'],
      ['--json', '--json'],
      ['--seed=-1'],
      ['--seed', '4294967296'],
      ['--seed', '1.5'],
      ['--events', '0'],
      ['--events', '20001'],
      ['--target', 'stripe'],
      ['positional'],
      ['--seed'],
    ];
    for (const argv of bad) {
      expect(() => parseCliArgs(argv), argv.join(' ')).toThrow(UsageError);
      const io = capture();
      expect(await main(argv, io), argv.join(' ')).toBe(2);
      expect(io.out).toBe('');
      expect(io.err).toMatch(/usage: pnpm poltergeist/);
    }
  });

  for (const target of ['ossuary', 'twin'] as const) {
    it(`--json prints exactly the report for ${target}, equal to a direct summon`, async () => {
      const io = capture();
      expect(await main(['--seed', '12', '--events', '25', '--target', target, '--json'], io)).toBe(0);
      expect(io.out.endsWith('}\n')).toBe(true);
      expect(io.out.split('\n')).toHaveLength(2);
      const direct = await summon({
        storm: generateStorm({ seed: 12, size: 25 }),
        factory: target === 'ossuary' ? ossuaryFactory() : twinFactory(),
        target,
      });
      expect(io.out).toBe(`${serializeReport(direct)}\n`);
      expect(io.err).toMatch(/^ran in \d+ ms\n$/);
    });
  }

  it('prints a human summary with exact six-decimal amounts', async () => {
    const io = capture();
    expect(await main(['--seed', '3', '--events', '30', '--target', 'twin'], io)).toBe(0);
    expect(io.out).toMatch(/^Poltergeist vs twin · seed 3 · 30 events · generator 1\n/);
    expect(io.out).toMatch(/Drift: -?\d+\.\d{6} USDC/);
    expect(io.out).toMatch(/duplicate-delivery/);
  });

  it('formats minor units exactly, without rounding', () => {
    expect(formatUnits('0', 6)).toBe('0.000000');
    expect(formatUnits('1', 6)).toBe('0.000001');
    expect(formatUnits('-1234567', 6)).toBe('-1.234567');
    expect(formatUnits(123456789012345678901n, 6)).toBe('123456789012345.678901');
  });
});
