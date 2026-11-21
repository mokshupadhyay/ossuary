import { parseUsdc } from '../money';
import type { TontineService } from './service';

/*
 * The demo circle, so the first screen is never empty (Requirement 11.1).
 * It is built through the same service calls as the UI: the same keys, the
 * same rail and the same ledger as a click.
 */

export const DEMO_CIRCLE = {
  name: 'The Midnight Circle',
  members: ['Asha', 'Kwame', 'Lupe', 'Mateo', 'Nkechi'],
  contribution: parseUsdc('50'),
} as const;

/** Round 1 paid and paid out to Asha; round 2 paid by Asha, Kwame and Lupe; Mateo marked late; Nkechi owes. */
export async function seedDemoCircle(service: TontineService): Promise<string> {
  const id = await service.createCircle({ ...DEMO_CIRCLE, members: [...DEMO_CIRCLE.members] });
  for (let p = 0; p < DEMO_CIRCLE.members.length; p++) await service.contribute(id, 1, p);
  await service.payout(id, 1);
  for (const p of [0, 1, 2]) await service.contribute(id, 2, p);
  await service.markMissed(id, 2, 3);
  return id;
}

/** Seeds the demo circle only when the database has no circle yet. */
export async function seedIfEmpty(service: TontineService): Promise<void> {
  if ((await service.listCircles()).length === 0) await seedDemoCircle(service);
}
