import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { checkSource } from '../../src/checker.js';
import { RULE_IDS } from '../../src/rules.js';
import { REPO_ROOT } from '../helpers/sandbox.js';

const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const TOOL_NAMES = ['ossuary_check_money_code', 'ossuary_run_poltergeist', 'ossuary_explain_rule'];

/** Names exported by `export { a, b } from` / `export function a` / `export const a` / `export class a` in a file. */
function exportedNames(rel: string): Set<string> {
  const src = read(rel);
  const names = new Set<string>();
  for (const m of src.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const part of m[1]!.split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()!.replace(/^type\s+/, '').trim();
      if (name) names.add(name);
    }
  }
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|class|interface|type)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]!);
  return names;
}

const CORE_EXPORTS = new Set([...exportedNames('packages/core/src/index.ts'), ...exportedNames('packages/core/src/errors/index.ts')]);
const HELPER_EXPORTS = new Set(
  readdirSync(path.join(REPO_ROOT, 'packages/core/tests/helpers')).flatMap((f) => [...exportedNames(`packages/core/tests/helpers/${f}`)]),
);

/** Backticked words that are not code references. */
const PLAIN = new Set([
  'bigint', 'numeric', 'clean', 'rule', 'line', 'excerpt', 'message', 'fix', 'kind', 'tx', 'db', 'path', 'code', 'filename',
  'allowOverdraft', 'idempotencyKey', 'summary', 'driftTotal', 'drifted', 'driftedFaults', 'true', 'false', 'Number',
  '0n', '0', 'git', 'diff', '409', 'beforeAll',
]);

const SKILLS = ['money-code-review', 'poltergeist-test', 'add-a-money-flow'];

describe('skills', () => {
  it('exist for exactly the three skills', () => {
    expect(readdirSync(path.join(REPO_ROOT, 'power/skills')).sort()).toEqual([...SKILLS].sort());
  });

  describe.each(SKILLS)('%s', (name) => {
    const rel = `power/skills/${name}/SKILL.md`;
    const text = read(rel);

    it('starts with front matter naming the skill and saying when to use it', () => {
      const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
      expect(m).not.toBeNull();
      const fm = parseYaml(m![1]!) as { name: string; description: string };
      expect(fm.name).toBe(name);
      expect(fm.description).toMatch(/\bUse (?:when|whenever|after)\b/);
      expect(fm.description.length).toBeLessThan(500);
    });

    it('names only tools and rule ids that exist', () => {
      for (const m of text.matchAll(/\bossuary_[a-z_]+/g)) expect(TOOL_NAMES).toContain(m[0]);
      const ruleLike = [...text.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)].map((m) => m[1]!);
      for (const r of ruleLike) expect([...RULE_IDS, ...SKILLS], `${r} in ${rel}`).toContain(r);
    });

    it('names only repository paths that exist', () => {
      // apps/ paths are examples of where a user's own code would live; everything else must exist.
      const paths = [...text.matchAll(/`((?:packages|power|\.kiro|docs)\/[\w./-]+)`/g)].map((m) => m[1]!);
      for (const p of paths) expect(existsSync(path.join(REPO_ROOT, p)), `${p} in ${rel}`).toBe(true);
      for (const m of text.matchAll(/\.kiro\/steering\/[a-z]+\.md|`([a-z]+\.md)`/g)) {
        const file = m[1] ? `.kiro/steering/${m[1]}` : m[0];
        if (file.endsWith('SKILL.md')) continue;
        expect(existsSync(path.join(REPO_ROOT, file)), `${file} in ${rel}`).toBe(true);
      }
    });

    it('names only core exports and test helpers that exist', () => {
      const idents = [...text.matchAll(/`([A-Za-z_$][\w$]*)(?:\([^`]*\))?`/g)].map((m) => m[1]!);
      for (const id of idents) {
        if (PLAIN.has(id) || TOOL_NAMES.includes(id)) continue;
        expect(CORE_EXPORTS.has(id) || HELPER_EXPORTS.has(id), `${id} in ${rel} is not exported by @ossuary/core or its test helpers`).toBe(true);
      }
      for (const m of text.matchAll(/import \{([^}]+)\} from '@ossuary\/core'/g)) {
        for (const name of m[1]!.split(',').map((s) => s.trim())) expect(CORE_EXPORTS.has(name), name).toBe(true);
      }
    });

    it('shows only TypeScript examples that pass the checker', () => {
      for (const m of text.matchAll(/```ts\n([\s\S]*?)```/g)) expect(checkSource(m[1]!)).toEqual([]);
    });

    it('names only package scripts that exist', () => {
      const corePkg = JSON.parse(read('packages/core/package.json')) as { scripts: Record<string, string> };
      for (const m of text.matchAll(/pnpm --filter core ([a-z-]+)/g)) expect(Object.keys(corePkg.scripts)).toContain(m[1]);
    });
  });

  it('money-code-review uses the checker and the rule explainer', () => {
    const text = read('power/skills/money-code-review/SKILL.md');
    expect(text).toContain('ossuary_check_money_code');
    expect(text).toContain('ossuary_explain_rule');
    for (const id of RULE_IDS) expect(text).toContain(id);
  });

  it('poltergeist-test covers helpers, 25 runs, the mutation check and both ways to run the poltergeist', () => {
    const text = read('power/skills/poltergeist-test/SKILL.md');
    expect(text).toMatch(/at least 25 runs/i);
    expect(text).toMatch(/break the code/i);
    expect(text).toContain('ossuary_run_poltergeist');
    expect(text).toContain('pnpm --filter core poltergeist --seed 7 --events 300 --target ossuary --json');
    for (const h of ['createPropertyDb', 'createCrashingDb', 'calibrate', 'signedDelivery', 'fakeClock', 'runConfig']) expect(text).toContain(h);
  });

  it('add-a-money-flow walks through key, transaction, property test, break, checker and poltergeist', () => {
    const text = read('power/skills/add-a-money-flow/SKILL.md');
    const steps = [...text.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => m[2]!);
    expect(steps).toEqual([
      'Model it as ledger entries',
      'Take an idempotency key',
      'Keep it in one transaction',
      'Check the code',
      'Write a property test',
      'Break it on purpose',
      'Run the poltergeist',
      'Report',
    ]);
    expect(text).toContain('ossuary_check_money_code');
    expect(text).toContain('ossuary_run_poltergeist');
  });
});

describe('plugin.json', () => {
  const plugin = JSON.parse(read('power/plugin.json')) as {
    name: string;
    steering: string[];
    skills: string[];
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  const fromPower = (p: string) => path.join(REPO_ROOT, 'power', p);

  it('starts the built server with node', () => {
    expect(plugin.name).toBe('ossuary');
    expect(plugin.mcpServers.ossuary).toMatchObject({ command: 'node', args: ['./mcp/dist/server.js'] });
  });

  it('lists only paths that exist (after the build)', () => {
    for (const p of [...plugin.steering, ...plugin.skills, ...plugin.mcpServers.ossuary!.args]) {
      expect(existsSync(fromPower(p)), p).toBe(true);
    }
    expect(existsSync(fromPower('../.kiro/steering/money.md'))).toBe(true);
  });
});

describe('power/README.md', () => {
  const text = read('power/README.md');

  it('documents build, both installs, the tools, the workspace root, the hook, the agent and CI', () => {
    for (const heading of ['## Build', '### Kiro CLI', '### Kiro IDE', '## Tools', '## Workspace root', '## Hook, headless agent and CI']) {
      expect(text).toContain(heading);
    }
    for (const name of TOOL_NAMES) expect(text).toContain(`### \`${name}\``);
    for (const id of RULE_IDS) expect(text).toContain(`\`${id}\``);
    for (const f of ['.kiro/hooks/summon-poltergeist.kiro.hook', '.kiro/agents/money-auditor.json', '.github/workflows/money-audit.yml']) {
      expect(text).toContain(f);
      expect(existsSync(path.join(REPO_ROOT, f)), f).toBe(true);
    }
    expect(text).toContain('KIRO_API_KEY');
  });

  it('has only JSON examples that parse', () => {
    const blocks = [...text.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]!);
    expect(blocks.length).toBeGreaterThan(5);
    for (const b of blocks) {
      const candidate = b.trim().startsWith('"') ? `{${b}}` : b; // a bare `"key": value` fragment
      expect(() => JSON.parse(candidate.replaceAll('"…": "…"', '"more": "…"')), b).not.toThrow();
    }
  });

  it('uses only kiro-cli flags that the docs list', () => {
    expect(text).toContain('kiro-cli mcp add --name ossuary --scope workspace --command node --args power/mcp/dist/server.js');
    expect(text).toContain('kiro-cli chat --no-interactive --agent money-auditor');
  });
});

describe('.kiro/hooks/summon-poltergeist.kiro.hook', () => {
  const hook = JSON.parse(read('.kiro/hooks/summon-poltergeist.kiro.hook')) as {
    enabled: boolean;
    when: { type: string };
    then: { type: string; prompt: string };
  };

  it('stays a manual askAgent hook', () => {
    expect(hook.enabled).toBe(true);
    expect(hook.when).toEqual({ type: 'userTriggered' });
    expect(hook.then.type).toBe('askAgent');
  });

  it('calls the tool for both targets, with the CLI as fallback, and demands zero Ossuary drift', () => {
    const p = hook.then.prompt;
    expect(p).toContain('ossuary_run_poltergeist');
    expect(p).toContain('"target": "ossuary"');
    expect(p).toContain('"target": "twin"');
    expect(p).toContain('pnpm --filter core poltergeist --seed 7 --events 300 --target ossuary --json');
    for (const field of ['summary.driftTotal', 'summary.driftedFaults', 'report.counterexample']) expect(p).toContain(field);
    expect(p).toMatch(/Ossuary must show drift 0/);
  });
});

describe('.kiro/agents/money-auditor.json', () => {
  const agent = JSON.parse(read('.kiro/agents/money-auditor.json')) as {
    name: string;
    prompt: string;
    tools: string[];
    allowedTools: string[];
    resources: string[];
    mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
  };
  const ALLOWED = ['read', 'grep', 'glob', '@ossuary/ossuary_check_money_code', '@ossuary/ossuary_explain_rule'];

  it('loads the Ossuary MCP server from the built bundle', () => {
    expect(agent.name).toBe('money-auditor');
    expect(agent.mcpServers.ossuary).toMatchObject({ command: 'node', args: ['power/mcp/dist/server.js'], env: { OSSUARY_WORKSPACE: '.' } });
    expect(existsSync(path.join(REPO_ROOT, agent.mcpServers.ossuary!.args[0]!))).toBe(true);
  });

  it('has only read-only tools, all pre-approved for --no-interactive', () => {
    expect([...agent.tools].sort()).toEqual([...ALLOWED].sort());
    expect([...agent.allowedTools].sort()).toEqual([...ALLOWED].sort());
    expect(agent.tools.join(' ')).not.toMatch(/write|shell|bash|run_poltergeist|@builtin|\*/);
  });

  it('loads the steering and the review skill', () => {
    expect(agent.resources).toEqual(['file://.kiro/steering/**/*.md', 'skill://power/skills/money-code-review/SKILL.md']);
    expect(existsSync(path.join(REPO_ROOT, 'power/skills/money-code-review/SKILL.md'))).toBe(true);
  });

  it('tells the agent to check each changed file, never modify files, and end with a verdict line', () => {
    expect(agent.prompt).toContain('ossuary_check_money_code');
    expect(agent.prompt).toContain('ossuary_explain_rule');
    expect(agent.prompt).toMatch(/Never create, modify or delete files/);
    expect(agent.prompt).toContain("'VERDICT: PASS'");
    expect(agent.prompt).toContain("'VERDICT: FAIL'");
    expect(agent.prompt).toMatch(/last line/);
  });
});

describe('.github/workflows/money-audit.yml', () => {
  interface Step { name: string; id?: string; if?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> }
  const wf = parseYaml(read('.github/workflows/money-audit.yml')) as {
    on: { pull_request: { paths: string[] } };
    permissions: Record<string, string>;
    jobs: { audit: { 'runs-on': string; steps: Step[] } };
  };
  const steps = wf.jobs.audit.steps;
  const step = (name: RegExp) => steps.find((s) => name.test(s.name))!;
  const GATE = "steps.gate.outputs.enabled == 'true'";

  /** Runs a step script the way GitHub does (bash -eo pipefail) in a temp dir; returns stdout, outputs, summary and exit code. */
  function runStep(s: Step, env: Record<string, string>, files: Record<string, string> = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), 'ossuary-wf-'));
    try {
      for (const [f, text] of Object.entries(files)) writeFileSync(path.join(dir, f), text);
      const out = path.join(dir, 'out');
      const summary = path.join(dir, 'summary');
      writeFileSync(out, '');
      writeFileSync(summary, '');
      const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', s.run!], {
        cwd: dir,
        env: { PATH: process.env.PATH!, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary, ...env },
        encoding: 'utf8',
      });
      return { status: r.status, stdout: r.stdout, outputs: readFileSync(out, 'utf8'), summary: readFileSync(summary, 'utf8') };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('runs on pull requests touching packages, apps, power or .kiro, with read-only permissions', () => {
    expect(wf.on.pull_request.paths).toEqual(['packages/**', 'apps/**', 'power/**', '.kiro/**']);
    expect(wf.permissions).toEqual({ contents: 'read' });
  });

  it('gates every step after the first on the secret check', () => {
    const [gate, ...rest] = steps;
    expect(gate!.id).toBe('gate');
    expect(gate!.if).toBeUndefined();
    expect(gate!.env).toEqual({ KIRO_API_KEY: '${{ secrets.KIRO_API_KEY }}' });
    for (const s of rest) expect(s.if, s.name).toContain(GATE);
  });

  it('builds the server, installs Kiro, runs the money-auditor headless and publishes the report', () => {
    expect(step(/Build the Ossuary MCP server/).run).toContain('pnpm --dir power/mcp install --frozen-lockfile');
    expect(step(/Build the Ossuary MCP server/).run).toContain('pnpm --dir power/mcp build');
    expect(step(/Install the Kiro CLI/).run).toContain('kiro');
    const audit = step(/Audit the diff/);
    expect(audit.env).toEqual({ KIRO_API_KEY: '${{ secrets.KIRO_API_KEY }}' });
    expect(audit.run).toContain('kiro-cli chat --no-interactive --agent money-auditor');
    expect(audit.run).toContain('stop-commands');
    expect(step(/Publish the report/).run).toContain('GITHUB_STEP_SUMMARY');
    expect(step(/Publish the report/).if).toContain('always()');
  });

  it('never expands ${{ }} inside a run script', () => {
    for (const s of steps) if (s.run) expect(s.run, s.name).not.toContain('${{');
    expect(step(/Write the diff/).env).toEqual({ BASE_REF: '${{ github.base_ref }}' });
  });

  it('skips with a notice and passes when the secret is absent or empty', () => {
    for (const env of [{}, { KIRO_API_KEY: '' }] as Record<string, string>[]) {
      const r = runStep(steps[0]!, env);
      expect(r.status).toBe(0);
      expect(r.outputs.trim()).toBe('enabled=false');
      expect(r.stdout).toMatch(/^::notice title=Money audit skipped::The KIRO_API_KEY secret is not set/);
      expect(r.summary).toContain('Money audit skipped');
    }
  });

  it('enables the audit when the secret is present', () => {
    const r = runStep(steps[0]!, { KIRO_API_KEY: 'k' });
    expect(r).toMatchObject({ status: 0, outputs: 'enabled=true\n', summary: '' });
    expect(r.stdout).toBe('');
  });

  it('passes only when the last non-empty line of the report is VERDICT: PASS', () => {
    const verdict = step(/Require VERDICT PASS/);
    const status = (report: string) => runStep(verdict, {}, { 'audit.md': report }).status;
    expect(status('# Audit\nclean\n\nVERDICT: PASS\n\n')).toBe(0);
    expect(status('\u001b[32mVERDICT: PASS\u001b[0m\r\n')).toBe(0);
    expect(status('VERDICT: PASS  \n')).toBe(0);
    expect(status('# Audit\nVERDICT: FAIL\n')).toBe(1);
    expect(status('VERDICT: PASS\nbut then more text\n')).toBe(1);
    expect(status('VERDICT: PASSED\n')).toBe(1);
    expect(status('')).toBe(1);
  });
});
