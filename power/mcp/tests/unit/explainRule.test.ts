import { describe, expect, it } from 'vitest';
import { checkSource } from '../../src/checker.js';
import { RULE_IDS } from '../../src/rules.js';
import { explainRule } from '../../src/tools/explainRule.js';

describe('ossuary_explain_rule', () => {
  it.each(RULE_IDS.map((id) => [id]))('explains %s with a flagged bug and a clean fix', async (id) => {
    const r = await explainRule({ rule: id });
    if (!r.ok) throw new Error(r.error.message);
    expect(Object.keys(r.data).sort()).toEqual(['bug', 'fix', 'id', 'rule', 'steeringFile', 'title']);
    expect(r.data.id).toBe(id);
    expect(r.data.steeringFile).toMatch(/^\.kiro\/steering\/[a-z]+\.md$/);
    expect(checkSource(r.data.bug).map((v) => v.rule)).toContain(id);
    expect(checkSource(r.data.fix)).toEqual([]);
  });

  it.each([
    ['an unknown rule', { rule: 'no-floats' }],
    ['a wrong type', { rule: 3 }],
    ['no rule', {}],
    ['undefined', undefined],
    ['an extra property', { rule: 'float-money', path: '../x' }],
    ['a case variant', { rule: 'FLOAT-MONEY' }],
  ])('rejects %s and lists the valid rules', async (_name, input) => {
    const r = await explainRule(input);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid_input');
    for (const id of RULE_IDS) expect(r.error.message).toContain(id);
  });
});
