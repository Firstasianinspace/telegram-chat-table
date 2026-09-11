/**
 * E2E test matrix — filter combination x sort field, verified against an
 * independently computed ground truth (not just "doesn't crash").
 *
 * This exercises exactly the paths the SQLite migration rewrote:
 *  - multi-type filters (previously a full unindexed table scan; now a
 *    per-type keyset UNION ALL merge — see queryBuilder.ts)
 *  - non-timestamp sorts, including 'from' (sender) and 'type'
 * combined with date-range and text-search filters.
 *
 * Sorting by the computed "length" column is verified in queryBuilder.test.ts
 * instead of here: getColumnsForType() never actually routes any live page
 * to the column set that exposes it (see that test file's comment), so there
 * is no reachable UI path to exercise for it at the DOM/e2e layer.
 *
 * Scale: 3,000 rows — large enough to span every type/sender combination
 * and multiple virtual-scroll pages, small enough to stay fast in CI. The
 * 1,000,000-row scale claim is verified separately: queryBuilder.test.ts
 * runs the same filter x sort matrix against a real SQLite engine, and
 * docs/architecture/ENTERPRISE_TABLE_ARCHITECTURE.md records measured
 * numbers from a 1,000,000-row browser prototype.
 *
 * Columns (allMessageColumns): 0 = id, 1 = timestamp, 2 = from, 3 = type
 */
import { test, expect, buildSeedMessages, type SeedMessage } from './fixtures/seed';

const SEED = buildSeedMessages({ count: 3000, spanDays: 120, seed: 2024 });

/** Ground truth: filter + sort the seed array in plain JS. */
function expectedIds(
  seed: SeedMessage[],
  filter: { types?: string[]; fromId?: string; search?: string },
  sortField: 'id' | 'timestamp' | 'from' | 'type',
  desc: boolean,
): number[] {
  let rows = seed.filter((m) => {
    if (filter.types && !filter.types.includes(m.type)) return false;
    if (filter.fromId && m.fromId !== filter.fromId) return false;
    if (filter.search && !m.text?.toLowerCase().includes(filter.search.toLowerCase())) return false;
    return true;
  });
  const key = (m: SeedMessage): number | string => {
    if (sortField === 'timestamp') return new Date(m.timestamp).getTime();
    if (sortField === 'from') return m.from;
    if (sortField === 'type') return m.type;
    return m.id;
  };
  rows = [...rows].sort((a, b) => {
    const ak = key(a);
    const bk = key(b);
    const cmp = ak < bk ? -1 : ak > bk ? 1 : a.id - b.id;
    return desc ? -cmp : cmp;
  });
  return rows.map((m) => m.id);
}

test.describe('Filter x sort matrix', () => {
  test.beforeEach(async ({ seedMessages }) => {
    await seedMessages(SEED);
  });

  test('no filter, default sort (timestamp desc): count and top rows match ground truth', async ({ messagePage }) => {
    await messagePage.goto();
    await messagePage.waitForRowsLoaded();

    expect(await messagePage.getTotalCount()).toBe(SEED.length);

    const expected = expectedIds(SEED, {}, 'timestamp', true);
    const rows = messagePage.getVisibleRows();
    const sample = Math.min(await rows.count(), 5);
    for (let index = 0; index < sample; index++) {
      const idText = await messagePage.getCellText(rows.nth(index), 0);
      expect(Number(idText)).toBe(expected[index]);
    }
  });

  test('multi-type filter (voice + photo): count matches and only those types appear', async ({ messagePage }) => {
    await messagePage.goto();
    await messagePage.waitForRowsLoaded();

    await messagePage.page.locator('label[for="type-voice"]').click();
    await messagePage.page.locator('label[for="type-photo"]').click();
    await messagePage.page.waitForTimeout(1000);
    await messagePage.waitForRowsLoaded();

    const expectedCount = SEED.filter((m) => m.type === 'voice' || m.type === 'photo').length;
    expect(await messagePage.getTotalCount()).toBe(expectedCount);

    const rows = messagePage.getVisibleRows();
    const sample = Math.min(await rows.count(), 8);
    for (let index = 0; index < sample; index++) {
      const type = await messagePage.getCellText(rows.nth(index), 3);
      expect(['voice', 'photo']).toContain(type);
    }
  });

  test('multi-type filter (text + sticker + animation) + sort by sender: rows ordered and correctly filtered', async ({ messagePage }) => {
    await messagePage.goto();
    await messagePage.waitForRowsLoaded();

    await messagePage.page.locator('label[for="type-text"]').click();
    await messagePage.page.locator('label[for="type-sticker"]').click();
    await messagePage.page.locator('label[for="type-animation"]').click();
    await messagePage.page.waitForTimeout(1000);
    await messagePage.waitForRowsLoaded();

    // Sort by "От" (sender) column.
    await messagePage.clickColumnHeader(2);
    await messagePage.page.waitForTimeout(1000);
    await messagePage.waitForRowsLoaded();

    const expectedCount = SEED.filter((m) => m.type === 'text' || m.type === 'sticker' || m.type === 'animation').length;
    expect(await messagePage.getTotalCount()).toBe(expectedCount);

    const dir = await messagePage.getSortDirection(2);
    const desc = dir === 'desc';
    const expected = expectedIds(SEED, { types: ['text', 'sticker', 'animation'] }, 'from', desc);

    const rows = messagePage.getVisibleRows();
    const sample = Math.min(await rows.count(), 6);
    for (let index = 0; index < sample; index++) {
      const idText = await messagePage.getCellText(rows.nth(index), 0);
      expect(Number(idText)).toBe(expected[index]);
    }
  });

  test('sort by "type" column groups rows by type value (previously required a full unindexed scan)', async ({ messagePage }) => {
    await messagePage.goto();
    await messagePage.waitForRowsLoaded();

    await messagePage.clickColumnHeader(3); // allMessageColumns: 3 = type
    await messagePage.page.waitForTimeout(1000);
    await messagePage.waitForRowsLoaded();

    const dir = await messagePage.getSortDirection(3);
    const desc = dir === 'desc';
    const expected = expectedIds(SEED, {}, 'type', desc);

    const rows = messagePage.getVisibleRows();
    const sample = Math.min(await rows.count(), 6);
    for (let index = 0; index < sample; index++) {
      const idText = await messagePage.getCellText(rows.nth(index), 0);
      expect(Number(idText)).toBe(expected[index]);
    }
  });

  test('date range + multi-type filter combined', async ({ messagePage }) => {
    await messagePage.goto();
    await messagePage.waitForRowsLoaded();

    await messagePage.page.locator('label[for="type-photo"]').click();
    await messagePage.page.locator('label[for="type-sticker"]').click();
    await messagePage.page.waitForTimeout(1000);

    const start = new Date('2026-01-15T00:00:00Z');
    const end = new Date('2026-02-15T00:00:00Z');
    await messagePage.setDateRange(start, end);
    await messagePage.page.waitForTimeout(1000);
    await messagePage.waitForRowsLoaded();

    // The date picker operates on whole calendar days in the browser's local
    // timezone and is inclusive of the entire end day, not just midnight.
    const endOfDay = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59, 999);
    const startOfDay = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 0, 0, 0, 0);
    const expectedCount = SEED.filter((m) => {
      const t = new Date(m.timestamp).getTime();
      return (m.type === 'photo' || m.type === 'sticker') && t >= startOfDay.getTime() && t <= endOfDay.getTime();
    }).length;

    expect(await messagePage.getTotalCount()).toBe(expectedCount);
  });

  test('text search + type filter: only matching, correctly-typed rows counted', async ({ messagePage }) => {
    await messagePage.goto('text');
    await messagePage.waitForRowsLoaded();

    // Seeded text messages are "Message number N from <sender>" (see
    // e2e/fixtures/seed.ts) -- search for a sender name rather than
    // free-form text content.
    await messagePage.typeInSearch('Bob');
    await messagePage.page.waitForTimeout(1000);
    await messagePage.waitForRowsLoaded();

    const expectedCount = SEED.filter(
      (m) => m.type === 'text' && m.text?.toLowerCase().includes('bob'),
    ).length;
    expect(await messagePage.getTotalCount()).toBe(expectedCount);
  });
});
