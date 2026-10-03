import { defineStore } from 'pinia';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { toPlain } from '../utils/plain';
import type { ArchiveBatch, ArchivePackage, FieldChange, SideCheck, SyncItem } from '../types/archive';
import { PENDING_CHECK } from '../types/archive';
import type { Morphometrics } from '../types/morphometrics';
import type { BirdSite } from '../types/bird-site';
import type { RingRecord } from '../types/ring-record';
import {
  normalizeRingNo,
  pairWithLocal,
  parseArchive,
  planMerge,
  applyChangesToRing,
  readyToMerge,
  runCenterCheck,
  runStationCheck,
  stationEvidenceOf,
} from '../utils/archiveSync';

type SideKey = 'station' | 'center';

interface SyncState {
  archives: ArchiveBatch[];
  items: SyncItem[];
  /** 当前打开的档案批次 id */
  currentArchiveId: string;
  /** 与中心系统的网络连通状态（断网时只能做站侧本地核验） */
  online: boolean;
  /** 正在批量逐只核验（供界面中断 / 等待） */
  running: boolean;
  hydrated: boolean;
}

/** 中心季度档案导入、逐只比对与断点续核 */
export const useSyncStore = defineStore('sync', {
  state: (): SyncState => ({
    archives: [],
    items: [],
    currentArchiveId: '',
    online: true,
    running: false,
    hydrated: false,
  }),

  getters: {
    itemsOf(state) {
      return (archiveId: string): SyncItem[] =>
        state.items
          .filter((item) => item.archiveId === archiveId)
          .sort((a, b) => a.archive.ringNo.localeCompare(b.archive.ringNo));
    },
    currentItems(state): SyncItem[] {
      return state.items
        .filter((item) => item.archiveId === state.currentArchiveId)
        .sort((a, b) => a.archive.ringNo.localeCompare(b.archive.ringNo));
    },
    byRingNo(state) {
      return (ringNo: string): SyncItem | undefined =>
        state.items.find(
          (item) => item.archiveId === state.currentArchiveId && item.ringNo === normalizeRingNo(ringNo),
        );
    },
  },

  actions: {
    async hydrate() {
      const [archives, items] = await Promise.all([db.archives.orderBy('importedAt').reverse().toArray(), db.syncItems.toArray()]);
      this.archives = archives;
      this.items = items;
      if (!this.currentArchiveId && archives.length > 0) {
        this.currentArchiveId = archives[0].id;
      }
      this.hydrated = true;
    },

    selectArchive(id: string) {
      this.currentArchiveId = id;
    },

    setOnline(value: boolean) {
      this.online = value;
    },

    /**
     * 导入一包档案。同一批次号重复导入不重置已核结论（断点续核的前提），
     * 直接返回已有批次；新批次则逐只与本站台账配对生成待核条目。
     */
    async importArchive(text: string): Promise<{ batch: ArchiveBatch; reused: boolean }> {
      const pkg = parseArchive(text);
      const existed = this.archives.find((batch) => batch.batchNo === pkg.batchNo);
      if (existed) {
        this.currentArchiveId = existed.id;
        return { batch: existed, reused: true };
      }

      // 配对所需台账数据直接从 IndexedDB 取，避免依赖其它 store 是否已 hydrate
      const [localRings] = await Promise.all([db.rings.toArray()]);
      const pairs = pairWithLocal(pkg, localRings);

      const batch: ArchiveBatch = {
        id: uid('archive'),
        batchNo: pkg.batchNo,
        quarter: pkg.quarter,
        issuedAt: pkg.issuedAt,
        importedAt: new Date().toISOString(),
        recordCount: pkg.records.length,
      };
      const items: SyncItem[] = pairs.map((pair) => ({
        id: uid('sync'),
        archiveId: batch.id,
        batchNo: batch.batchNo,
        quarter: batch.quarter,
        ringNo: pair.ringNo,
        archive: pair.archive,
        localRingIds: pair.local.map((record) => record.id),
        station: { ...PENDING_CHECK },
        center: { ...PENDING_CHECK },
        merged: false,
        mergedAt: '',
        appliedChanges: [],
      }));

      await db.transaction('rw', db.archives, db.syncItems, async () => {
        await db.archives.put(toPlain(batch));
        await db.syncItems.bulkPut(toPlain(items));
      });
      this.archives = [batch, ...this.archives];
      this.items = [...this.items, ...items];
      this.currentArchiveId = batch.id;
      return { batch, reused: false };
    },

    async removeArchive(archiveId: string) {
      await db.transaction('rw', db.archives, db.syncItems, async () => {
        await db.syncItems.where('archiveId').equals(archiveId).delete();
        await db.archives.delete(archiveId);
      });
      this.items = this.items.filter((item) => item.archiveId !== archiveId);
      this.archives = this.archives.filter((batch) => batch.id !== archiveId);
      if (this.currentArchiveId === archiveId) {
        this.currentArchiveId = this.archives[0]?.id ?? '';
      }
    },

    /** 单侧核验进度汇总 */
    progressOf(archiveId: string): {
      total: number;
      matched: number;
      stationPass: number;
      centerPass: number;
      bothPass: number;
      merged: number;
    } {
      const items = this.items.filter((item) => item.archiveId === archiveId);
      const matched = items.filter((item) => item.localRingIds.length > 0);
      return {
        total: items.length,
        matched: matched.length,
        stationPass: matched.filter((item) => item.station.status === 'pass').length,
        centerPass: matched.filter((item) => item.center.status === 'pass').length,
        bothPass: matched.filter((item) => readyToMerge(item.station, item.center)).length,
        merged: items.filter((item) => item.merged).length,
      };
    },

    /**
     * 核一只的一侧。已通过的一侧默认不重跑（断网恢复后留住已核结论）；
     * force=true 用于"出问题的那一侧重新来过"——先 resetSide 再调本方法。
     * 外站档案（本站无记录）不做站侧核验。
     */
    async checkSide(
      itemId: string,
      side: SideKey,
      context: { rings: RingRecord[]; morphs: Morphometrics[]; sites: BirdSite[] },
      options: { force?: boolean } = {},
    ): Promise<SyncItem> {
      const item = this.items.find((candidate) => candidate.id === itemId);
      if (!item) throw new Error('比对条目不存在');
      if (!options.force && item[side].status === 'pass') return item;
      if (side === 'station' && item.localRingIds.length === 0) return item;

      let result: SideCheck;
      if (side === 'center') {
        result = runCenterCheck(item.archive, this.online);
      } else {
        const local = context.rings.filter((record) => item.localRingIds.includes(record.id));
        const pair = { ringNo: item.ringNo, archive: item.archive, local };
        const evidence = stationEvidenceOf(pair, context.morphs, context.sites);
        result = runStationCheck(pair, evidence);
      }

      const next: SyncItem = { ...item, [side]: result };
      await db.syncItems.put(toPlain(next));
      this.items = this.items.map((candidate) => (candidate.id === itemId ? next : candidate));
      return next;
    },

    /** 出问题的一侧重新来过：清掉该侧结论，已通过的另一侧原样保留 */
    async resetSide(itemId: string, side: SideKey) {
      const item = this.items.find((candidate) => candidate.id === itemId);
      if (!item || item[side].status === 'pending') return;
      const next: SyncItem = {
        ...item,
        [side]: { ...PENDING_CHECK },
        // 若合并尚未完成，字段变更计划随核验结论一并作废重算；已合并的不动台账
        appliedChanges: item.merged ? item.appliedChanges : [],
      };
      await db.syncItems.put(toPlain(next));
      this.items = this.items.map((candidate) => (candidate.id === itemId ? next : candidate));
    },

    /**
     * 批量逐只核验（每只两侧），用于"开始/继续比对"。
     * - 已 pass 的一侧自动跳过（断线后续跑不会重复劳动）；
     * - 外站档案只跑中心侧；
     * - 每核完一只立即落库，中途断网 / 关掉页面，已核好的结论都留住；
     * - 每只之间让出事件循环，期间切换「断网」开关会立即影响后续中心侧核验。
     */
    async runAll(
      archiveId: string,
      context: { rings: RingRecord[]; morphs: Morphometrics[]; sites: BirdSite[] },
      options: { onItem?: (item: SyncItem) => void; signal?: { cancelled: boolean } } = {},
    ): Promise<{ processed: number; failed: number }> {
      this.running = true;
      let processed = 0;
      let failed = 0;
      try {
        for (const item of this.itemsOf(archiveId)) {
          if (options.signal?.cancelled) break;
          const sides: SideKey[] = item.localRingIds.length > 0 ? ['station', 'center'] : ['center'];
          let sideFailed = false;
          for (const side of sides) {
            if (options.signal?.cancelled) break;
            const next = await this.checkSide(item.id, side, context);
            if (next[side].status === 'fail') sideFailed = true;
            await new Promise((resolve) => setTimeout(resolve, 60));
          }
          if (sideFailed) failed += 1;
          processed += 1;
          options.onItem?.(this.items.find((candidate) => candidate.id === item.id) ?? item);
        }
      } finally {
        this.running = false;
      }
      return { processed, failed };
    },

    /**
     * 应用一只的字段合并。铁律：
     * 1) 两侧核验都通过才允许；
     * 2) 只更新中心权威字段（鸟种、原环志日期、原环志站），本站 ringDate / 鸟点 / 量度绝不碰；
     * 3) 只 put 已存在的台账行，绝不 add / delete——重捕次数（行数）恒定；
     * 4) 已 merged 的条目重复调用直接返回，appliedChanges 不再增加（幂等，再核一次不会多算）。
     */
    async mergeItem(
      itemId: string,
      context: { rings: RingRecord[]; morphs: Morphometrics[]; sites: BirdSite[] },
    ): Promise<{ item: SyncItem; changedRows: number }> {
      const item = this.items.find((candidate) => candidate.id === itemId);
      if (!item) throw new Error('比对条目不存在');
      if (item.localRingIds.length === 0) throw new Error('外站档案只登记备查，不能并入本站台账');
      if (!readyToMerge(item.station, item.center)) throw new Error('站侧与中心侧核验均通过后才能合并');
      if (item.merged) return { item, changedRows: 0 };

      const local = context.rings.filter((record) => item.localRingIds.includes(record.id));
      const plan = planMerge({ ringNo: item.ringNo, archive: item.archive, local });

      const nextRings = plan.updates.map((update) => {
        const record = local.find((candidate) => candidate.id === update.id);
        if (!record) throw new Error('台账记录缺失，终止合并');
        return applyChangesToRing(record, update.changes);
      });

      const now = new Date().toISOString();
      const nextItem: SyncItem = {
        ...item,
        merged: true,
        mergedAt: now,
        appliedChanges: plan.changes,
        note: plan.changes.length === 0 ? '中心档案与本站记录一致，无字段变更' : undefined,
      };

      await db.transaction('rw', db.rings, db.syncItems, async () => {
        // bulkPut 按主键覆盖，行数不变；绝不涉及 add/delete
        await db.rings.bulkPut(toPlain(nextRings));
        await db.syncItems.put(toPlain(nextItem));
      });
      this.items = this.items.map((candidate) => (candidate.id === itemId ? nextItem : candidate));
      // 调用方（页面）随后应 hydrate ringStore 让台账列表反映新字段
      return { item: nextItem, changedRows: nextRings.length };
    },

    /** 全部"两侧通过且未合并"的逐只合并；已合并的跳过，天然幂等 */
    async mergeAllReady(
      archiveId: string,
      context: { rings: RingRecord[]; morphs: Morphometrics[]; sites: BirdSite[] },
    ): Promise<{ merged: number; skipped: number }> {
      let merged = 0;
      let skipped = 0;
      for (const item of this.itemsOf(archiveId)) {
        if (item.merged) {
          skipped += 1;
          continue;
        }
        if (item.localRingIds.length === 0 || !readyToMerge(item.station, item.center)) {
          skipped += 1;
          continue;
        }
        await this.mergeItem(item.id, context);
        merged += 1;
      }
      return { merged, skipped };
    },

    /** 只读地预览一只的字段变更计划（不落库） */
    previewChanges(item: SyncItem, rings: RingRecord[]): FieldChange[] {
      const local = rings.filter((record) => item.localRingIds.includes(record.id));
      return planMerge({ ringNo: item.ringNo, archive: item.archive, local }).changes;
    },
  },
});
