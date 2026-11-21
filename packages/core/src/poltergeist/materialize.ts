import { uuidV5 } from '../webhooks/keys.js';
import { MEMBERS, type MemberRef } from './storm.js';

/*
 * Logical storm ids → concrete ids for one SUT instance (Requirement 3.8).
 * The run tag keeps several runs apart in one shared database. Concrete ids
 * never reach the report, so the run tag cannot change it.
 */

export const POLTERGEIST_NAMESPACE = '6f1c2b8e-5d7a-4c3e-9b1a-0e4d2c6a8f17';

export interface Concrete {
  readonly runTag: string;
  readonly circleId: string;
  readonly memberIds: Readonly<Record<MemberRef, string>>;
  eventId(logical: string): string;
  paymentId(logical: string): string;
  key(logical: string): string;
  /** Maps a concrete member id back to its Member_Ref, or `unknown`. */
  memberRef(memberId: string): MemberRef | 'unknown';
}

export function materialize(runTag: string): Concrete {
  const derive = (name: string) => uuidV5(POLTERGEIST_NAMESPACE, `${runTag}|${name}`);
  const memberIds = Object.fromEntries(MEMBERS.map((m) => [m, derive(`member|${m}`)])) as Record<MemberRef, string>;
  const back = new Map<string, MemberRef>(MEMBERS.map((m) => [memberIds[m], m]));
  return {
    runTag,
    circleId: derive('circle'),
    memberIds,
    eventId: (logical) => `${runTag}${logical}`,
    paymentId: (logical) => derive(logical),
    key: (logical) => derive(logical),
    memberRef: (memberId) => back.get(memberId.toLowerCase()) ?? 'unknown',
  };
}

/** 7 random hex characters and `~`, from the Web Crypto global (browser-safe, design D8). */
export function newRunTag(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return `${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 7)}~`;
}
