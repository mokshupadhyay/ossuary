/*
 * Core's webhook code uses the `Buffer` global next to `node:crypto`
 * (poltergeist-engine design D8). Browsers have no `Buffer`, so the app
 * installs the `buffer` polyfill before core runs. Imported first by main.tsx.
 */
import { Buffer } from 'buffer';

const g = globalThis as { Buffer?: unknown };
if (g.Buffer === undefined) g.Buffer = Buffer;
