import { z } from 'zod';
import type { ToolContext } from '../context.js';
import { describeZodError, fail, ok, type ToolResult } from '../result.js';
import { RULE_IDS, RULES_BY_ID, type RuleId } from '../rules.js';

export const explainRuleShape = {
  rule: z.enum(RULE_IDS).describe(`One of: ${RULE_IDS.join(', ')}.`),
};

const schema = z.object(explainRuleShape).strict();

export interface ExplainRuleResult {
  id: RuleId;
  title: string;
  steeringFile: string;
  rule: string;
  bug: string;
  fix: string;
}

export async function explainRule(input: unknown, _ctx?: ToolContext): Promise<ToolResult<ExplainRuleResult>> {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    return fail('invalid_input', `${describeZodError(parsed.error)}. Valid rules: ${RULE_IDS.join(', ')}`);
  }
  const r = RULES_BY_ID.get(parsed.data.rule)!;
  return ok({ id: r.id, title: r.title, steeringFile: r.steeringFile, rule: r.rule, bug: r.bug, fix: r.fixExample });
}
