import { describe, expect, it } from 'vitest';

describe('smoke', () => {
  it('adds bigints exactly', () => {
    expect(1n + 2n).toBe(3n);
  });
});
