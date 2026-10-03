import 'fake-indexeddb/auto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { db, DB_NAME } from '../utils/db';
import { useSyncStore } from '../stores/syncStore';
import { SAMPLE_ARCHIVE, SAMPLE_ARCHIVE_JSON } from '../utils/sampleArchive';
import type { BirdSite } from '../types/bird-site';
import type { Morphometrics } from '../types/morphometrics';
import type { RingRecord } from '../types/ring-record';

/** 断网 / 重连 / 刷新页面（store 重建但 IndexedDB 保留）场景下的端到端行为 */
describe('syncStore 断点续核与幂等合并', () => {
  beforeEach(async () => {
    await db.syncItems.clear();
    await db.archives.clear();
    await db.rings.clear();
    await db.morphs.clear();
    await db.sites.clear();
    setActivePinia(createPinia());
  });

  afterAll(async () => {
    await db.close();
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onblocked = () => resolve();
    });
  });

  /** 本站台账：A-10231 两行（初捕 + 重捕），量度与生境齐备 */
  async function seedLocal() {
    const site: BirdSite = {
      id: 'site-1',
      siteNo: 'S-01',
      name: '大汶流芦苇荡',
      lng: 118.052,
      lat: 38.921,
      habitat: '芦苇湿地',
      netCount: 12,
    };
    const base = {
      ringNo: 'A-10231',
      colorRing: '红-黄',
      speciesCn: '红喉歌鸲',
      speciesSci: 'Calliope calliope',
      age: '成' as const,
      netNo: '3 号网',
      netRound: 2,
      ringer: '韩雪',
      siteId: 'site-1',
      sessionId: 'session-1',
    };
    const rings: RingRecord[] = [
      { ...base, id: 'ring-a', status: '初捕', ringDate: '2024-09-12T03:00:00.000Z' },
      { ...base, id: 'ring-b', status: '重捕', ringDate: '2024-09-26T03:00:00.000Z', netRound: 5 },
    ];
    const morphs: Morphometrics[] = ['ring-a', 'ring-b'].map((ringId, i) => ({
      id: `morph-${i}`,
      ringId,
      billLength: 14,
      billWidth: 4,
      wingLength: 74,
      tailLength: 58,
      tarsusLength: 23,
      weight: 23,
      fatScore: 2,
      measuredBy: '韩雪',
      measuredAt: '2024-09-12T04:00:00.000Z',
    }));
    await db.sites.put(site);
    await db.rings.bulkPut(rings);
    await db.morphs.bulkPut(morphs);
    return { rings, morphs, sites: [site] };
  }

  it('断网时站侧结论先留住；重连并“刷新页面”后只补核中心侧，已通过的站侧不重算', async () => {
    const ctx = await seedLocal();
    const store = useSyncStore();
    await store.importArchive(SAMPLE_ARCHIVE_JSON);
    const archiveId = store.currentArchiveId;

    // —— 比对到一半断网 ——
    store.setOnline(false);
    await store.runAll(archiveId, ctx);

    let item = store.itemsOf(archiveId).find((i) => i.ringNo === 'A10231')!;
    expect(item.station.status).toBe('pass'); // 本地核验不受断网影响
    expect(item.center.status).toBe('fail'); // 中心侧因断网失败
    expect(item.center.issues.join()).toMatch(/网络中断/);
    const stationCheckedAt = item.station.checkedAt;

    // —— “恢复后已经核好的要留住”：模拟关掉页面重开，store 从零 hydrate ——
    setActivePinia(createPinia());
    const reopened = useSyncStore();
    await reopened.hydrate();
    expect(reopened.currentArchiveId).toBe(archiveId);
    item = reopened.itemsOf(archiveId).find((i) => i.ringNo === 'A10231')!;
    expect(item.station.status).toBe('pass');
    expect(item.station.checkedAt).toBe(stationCheckedAt); // 落库的结论原样保留
    expect(item.center.status).toBe('fail');

    // —— 网络恢复，继续比对：站侧 pass 自动跳过，只补中心侧 ——
    reopened.setOnline(true);
    await reopened.runAll(archiveId, ctx);
    item = reopened.itemsOf(archiveId).find((i) => i.ringNo === 'A10231')!;
    expect(item.station.checkedAt).toBe(stationCheckedAt); // 没有重算
    expect(item.center.status).toBe('pass');
  });

  it('出问题的一侧可以单独重置重核，另一侧结论不动', async () => {
    const ctx = await seedLocal();
    const store = useSyncStore();
    await store.importArchive(SAMPLE_ARCHIVE_JSON);
    const archiveId = store.currentArchiveId;
    store.setOnline(false);
    await store.runAll(archiveId, ctx);

    const item = store.itemsOf(archiveId).find((i) => i.ringNo === 'A10231')!;
    const stationTime = item.station.checkedAt;
    await store.resetSide(item.id, 'center');
    const reset = store.items.find((i) => i.id === item.id)!;
    expect(reset.center.status).toBe('pending');
    expect(reset.station.status).toBe('pass'); // 站侧不受影响
    expect(reset.station.checkedAt).toBe(stationTime);

    store.setOnline(true);
    await store.checkSide(reset.id, 'center', ctx);
    expect(store.items.find((i) => i.id === item.id)!.center.status).toBe('pass');
    expect(store.items.find((i) => i.id === item.id)!.station.checkedAt).toBe(stationTime);
  });

  it('合并只改中心权威字段、不增删台账行；重复合并幂等，重捕次数不变', async () => {
    const ctx = await seedLocal();
    const store = useSyncStore();
    await store.importArchive(SAMPLE_ARCHIVE_JSON);
    const archiveId = store.currentArchiveId;
    await store.runAll(archiveId, ctx); // 默认在线

    const item = store.itemsOf(archiveId).find((i) => i.ringNo === 'A10231')!;
    expect(item.station.status).toBe('pass');
    expect(item.center.status).toBe('pass');

    const ringsBefore = await db.rings.toArray();
    const recapturesBefore = ringsBefore.filter((r) => r.status === '重捕').length;

    const first = await store.mergeAllReady(archiveId, {
      rings: await db.rings.toArray(),
      morphs: ctx.morphs,
      sites: ctx.sites,
    });
    expect(first.merged).toBeGreaterThan(0);

    // 台账行数恒定
    const ringsAfter = await db.rings.toArray();
    expect(ringsAfter).toHaveLength(ringsBefore.length);
    expect(ringsAfter.filter((r) => r.status === '重捕')).toHaveLength(recapturesBefore);

    // A-10231 两行：中心原环志日期回填、本站捕获日期 / 网号 / 鸟点原样
    const merged = ringsAfter.filter((r) => r.ringNo === 'A-10231');
    expect(merged).toHaveLength(2);
    expect(merged.every((r) => r.originRingDate?.slice(0, 10) === '2023-09-02')).toBe(true);
    expect(merged.find((r) => r.id === 'ring-a')!.ringDate).toBe('2024-09-12T03:00:00.000Z');
    expect(merged.find((r) => r.id === 'ring-b')!.ringDate).toBe('2024-09-26T03:00:00.000Z');
    expect(merged.every((r) => r.siteId === 'site-1' && r.netNo === '3 号网')).toBe(true);

    // 再核 / 再合并一次：没有任何新增变更，重捕次数依然不变
    const second = await store.mergeAllReady(archiveId, {
      rings: await db.rings.toArray(),
      morphs: ctx.morphs,
      sites: ctx.sites,
    });
    expect(second.merged).toBe(0);
    const ringsTwice = await db.rings.toArray();
    expect(ringsTwice).toHaveLength(ringsBefore.length);
    expect(ringsTwice.filter((r) => r.status === '重捕')).toHaveLength(recapturesBefore);
    const itemAfter = store.itemsOf(archiveId).find((i) => i.ringNo === 'A10231')!;
    expect(itemAfter.merged).toBe(true);
  });

  it('未两侧通过的条目拒绝合并；外站档案不能并账', async () => {
    const ctx = await seedLocal();
    const store = useSyncStore();
    await store.importArchive(SAMPLE_ARCHIVE_JSON);
    const archiveId = store.currentArchiveId;

    const external = store.itemsOf(archiveId).find((i) => i.ringNo === 'D40388')!;
    await expect(store.mergeItem(external.id, ctx)).rejects.toThrow(/只登记/);

    // 在线全量核验后，E-50002 中心侧因档案缺回收地点失败，仍不可合并
    await store.runAll(archiveId, ctx);
    const badArchive = store.itemsOf(archiveId).find((i) => i.ringNo === 'E50002')!;
    expect(badArchive.center.status).toBe('fail');
    // 它是外站档案（本站无记录），本来也不允许并账
    expect(badArchive.localRingIds).toHaveLength(0);
  });

  it('同一批次号重复导入不重置已核结论（断点续核前提）', async () => {
    const ctx = await seedLocal();
    const store = useSyncStore();
    const first = await store.importArchive(SAMPLE_ARCHIVE_JSON);
    expect(first.reused).toBe(false);
    await store.runAll(first.batch.id, ctx);
    const itemBefore = store.itemsOf(first.batch.id).find((i) => i.ringNo === 'A10231')!;
    expect(itemBefore.station.status).toBe('pass');

    const again = await store.importArchive(SAMPLE_ARCHIVE_JSON);
    expect(again.reused).toBe(true);
    const itemAfter = store.itemsOf(again.batch.id).find((i) => i.ringNo === 'A10231')!;
    expect(itemAfter.id).toBe(itemBefore.id);
    expect(itemAfter.station.status).toBe('pass');
    // 条目没有被复制
    expect(store.itemsOf(again.batch.id)).toHaveLength(SAMPLE_ARCHIVE.records.length);
    expect(await db.archives.count()).toBe(1);
  });
});
