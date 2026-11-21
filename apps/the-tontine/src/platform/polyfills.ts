/*
 * Core's webhook code uses the `Buffer` global next to `node:crypto`
 * (poltergeist-engine design D8). Browsers have no Buffer, so the app
 * installs the `buffer` package's implementation before core is called.
 * Imported first by main.tsx.
 */
import { Buffer } from 'buffer';

const g = globalThis as { Buffer?: typeof Buffer };
if (g.Buffer === undefined) g.Buffer = Buffer;
