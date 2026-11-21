import { expect, test, type Page } from '@playwright/test';

/*
 * Layout and accessibility checks at the current project's width (desktop
 * 1280 px, mobile 390 px): no horizontal scroll, readable text, a visible
 * focus ring on every focusable control, and text contrast of at least 4.5:1
 * against the colours actually painted behind it. Run on the seeded circle
 * and again with a finished storm on screen.
 */

const ignorePglite = (page: Page, errors: string[]) =>
  page.on('pageerror', (e) => {
    if (!(e.name === 'ErrnoError' || e.message === 'ErrnoError')) errors.push(`${e.name}: ${e.message}`);
  });

interface Low {
  text: string;
  ratio: number;
  color: string;
  background: string;
}

/** Every visible text node's contrast against the worst-case colour behind it (solid colours and gradient stops, alpha-blended). */
async function lowContrast(page: Page): Promise<Low[]> {
  return page.evaluate(() => {
    type RGBA = [number, number, number, number];
    const parse = (c: string): RGBA[] =>
      [...c.matchAll(/rgba?\(([^)]+)\)/g)].map((m) => {
        const p = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
        return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
      });
    const over = (top: RGBA, under: RGBA): RGBA => {
      const a = top[3];
      return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
    };
    const lum = ([r, g, b]: RGBA) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a: RGBA, b: RGBA) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
      return (x + 0.05) / (y + 0.05);
    };
    /** The candidate colours painted behind `el`, from the root down. */
    const backdrops = (el: Element): RGBA[] => {
      const chain: Element[] = [];
      for (let e: Element | null = el; e; e = e.parentElement) chain.unshift(e);
      let layers: RGBA[] = [[18, 13, 10, 1]];
      for (const e of chain) {
        const cs = getComputedStyle(e);
        const solid = parse(cs.backgroundColor).filter((c) => c[3] > 0);
        const stops = cs.backgroundImage === 'none' ? [] : parse(cs.backgroundImage).filter((c) => c[3] > 0);
        const next: RGBA[] = [];
        for (const under of layers) {
          const base = solid.length ? over(solid[0]!, under) : under;
          if (stops.length) for (const s of stops) next.push(over(s, base));
          else next.push(base);
        }
        // Keep the darkest and lightest candidates only.
        const sorted = next.sort((a, b) => lum(a) - lum(b));
        layers = [sorted[0]!, sorted[sorted.length - 1]!];
      }
      return layers;
    };
    const out: { text: string; ratio: number; color: string; background: string }[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.textContent ?? '').trim();
      const el = n.parentElement;
      if (!text || !el || /^[\p{Extended_Pictographic}\s→✓✗✝⚠○⌛·]+$/u.test(text)) continue;
      if (el.closest('[aria-hidden="true"], .sr-only, option')) continue;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      const color = parse(cs.color)[0]!;
      // Disabled controls are exempt from contrast minimums (WCAG 1.4.3).
      if (el.closest('button:disabled, input:disabled, select:disabled')) continue;
      for (const bg of backdrops(el)) {
        const fg = over(color, bg);
        const q = ratio(fg, bg);
        if (q < 4.5) out.push({ text: text.slice(0, 60), ratio: Math.round(q * 100) / 100, color: cs.color, background: `rgb(${bg.slice(0, 3).map(Math.round).join(' ')})` });
      }
    }
    return out;
  });
}

/** Tabs through the page; returns controls whose focus shows no outline or box-shadow. */
async function focusWithoutRing(page: Page, max = 80): Promise<string[]> {
  const missing: string[] = [];
  await page.locator('body').focus();
  const seen = new Set<string>();
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2) || (cs.boxShadow !== 'none' && cs.boxShadow !== '');
      const label = `${el.tagName.toLowerCase()}:${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}`;
      return { label, ring, visible: el.matches(':focus-visible') };
    });
    if (!info) continue;
    if (seen.has(info.label)) break;
    seen.add(info.label);
    if (!info.ring || !info.visible) missing.push(info.label);
  }
  expect(seen.size).toBeGreaterThan(5);
  return missing;
}

async function smallText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const small: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      if (el.closest('[aria-hidden="true"], .sr-only')) continue;
      const own = [...el.childNodes].some((c) => c.nodeType === Node.TEXT_NODE && c.textContent?.trim());
      if (!own || el.getBoundingClientRect().width === 0) continue;
      if (parseFloat(getComputedStyle(el).fontSize) < 12) small.push(`${el.tagName.toLowerCase()}.${el.className}: ${el.textContent?.trim().slice(0, 30)}`);
    }
    return small;
  });
}

async function noHorizontalScroll(page: Page) {
  const { scroll, width, wide } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    width: window.innerWidth,
    wide: [...document.querySelectorAll<HTMLElement>('main *')]
      .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && !e.closest('.faults__wrap, .lane, [aria-hidden="true"], .sr-only'))
      .map((e) => `${e.tagName.toLowerCase()}.${e.className}`)
      .slice(0, 5),
  }));
  expect(wide).toEqual([]);
  expect(scroll).toBeLessThanOrEqual(width);
}

test('layout, focus rings and contrast at this width, before and after a storm', async ({ page }) => {
  const errors: string[] = [];
  ignorePglite(page, errors);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'The Midnight Circle', level: 2 })).toBeVisible({ timeout: 60_000 });

  await noHorizontalScroll(page);
  expect(await smallText(page)).toEqual([]);
  expect(await lowContrast(page)).toEqual([]);
  expect(await focusWithoutRing(page)).toEqual([]);

  const seance = page.getByRole('region', { name: 'Summon the Poltergeist' });
  await seance.getByRole('button', { name: 'Summon the Poltergeist' }).click();
  await expect(seance.getByTestId('seance-result')).toBeVisible({ timeout: 150_000 });

  await noHorizontalScroll(page);
  expect(await smallText(page)).toEqual([]);
  expect(await lowContrast(page)).toEqual([]);
  expect(await focusWithoutRing(page, 200)).toEqual([]);
  expect(errors).toEqual([]);
});
