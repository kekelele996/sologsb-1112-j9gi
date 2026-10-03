import { defineStore } from 'pinia';
import { db, getMeta, setMeta } from '../utils/db';
import { downloadText } from '../utils/export';
import { useRingStore } from './ringStore';
import { useSiteStore } from './siteStore';
import type { RingRecord } from '../types/ring-record';
import type {
  CenterArchivePackage,
  ReconcileProgress,
  ReconcileSide,
  SideRunStatus,
} from '../types/center-archive';
import {
  META_ARCHIVE,
  META_PROGRESS,
  archiveMatchMap,
  bandedRecords,
  buildReportPackage,
  buildSampleArchive,
  emptyProgress,
  parseArchive,
  parseProgress,
  reconcileOne,
  ringKey,
} from '../utils/reconcile';

/** 逐只比对时每只之间的间隔（模拟网络请求，便于观察断网续传） */
const STEP_DELAY = 220;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface SyncState {
  /** 已缓存的中心档案包（下载后留存，刷新不丢） */
  archive: CenterArchivePackage | null;
  /** 两侧进度（持久化到 meta，断网/刷新后留住） */
  progress: ReconcileProgress;
  /** 两侧运行状态 */
  runStatus: Record<ReconcileSide, SideRunStatus>;
  /** 两侧当前处理的环号 */
  current: Record<ReconcileSide, string>;
  /** 两侧最近错误 */
  error: Record<ReconcileSide, string>;
  /** 停止标记（内存中即可，进度本身已持久化） */
  stopFlags: Record<ReconcileSide, boolean>;
  /** 模拟网络抖动（随机失败，演示「出问题的一侧」） */
  flaky: boolean;
  /** 操作日志 */
  log: string[];
  hydrated: boolean;
}

export const useSyncStore = defineStore('sync', {
  state: (): SyncState => ({
    archive: null,
    progress: emptyProgress(),
    runStatus: { compare: 'idle', report: 'idle' },
    current: { compare: '', report: '' },
    error: { compare: '', report: '' },
    stopFlags: { compare: false, report: false },
    flaky: false,
    log: [],
    hydrated: false,
  }),

  getters: {
    /** 本站带环个体（重捕 + 回收）：比对与上报的对象 */
    targets(): RingRecord[] {
      return bandedRecords(useRingStore().rings);
    },
    /** 档案环号 → 档案记录 */
    matchMap(state) {
      return archiveMatchMap(state.archive);
    },
    /** 档案中有、但本站未捕获的环号（台账只记本地捕获，不写入本站） */
    unmatchedArchive(state): CenterArchivePackage['records'] {
      const local = new Set(useRingStore().rings.map((record) => ringKey(record.ringNo)));
      return (state.archive?.records ?? []).filter((record) => !local.has(ringKey(record.ringNo)));
    },
    compareStats(state) {
      const total = bandedRecords(useRingStore().rings).length;
      const done = state.progress.compare.done.length;
      const failed = state.progress.compare.failed.length;
      return { total, done, failed, pending: Math.max(0, total - done - failed) };
    },
    reportStats(state) {
      const total = bandedRecords(useRingStore().rings).length;
      const done = state.progress.report.done.length;
      const failed = state.progress.report.failed.length;
      return { total, done, failed, pending: Math.max(0, total - done - failed) };
    },
  },

  actions: {
    async hydrate() {
      const [archiveText, progressText] = await Promise.all([getMeta(META_ARCHIVE), getMeta(META_PROGRESS)]);
      if (archiveText) {
        try {
          this.archive = parseArchive(archiveText);
        } catch {
          this.archive = null;
        }
      }
      this.progress = parseProgress(progressText);
      this.hydrated = true;
    },

    async persistArchive() {
      if (this.archive) await setMeta(META_ARCHIVE, JSON.stringify(this.archive));
    },

    async persistProgress() {
      this.progress.compare.updatedAt = new Date().toISOString();
      await setMeta(META_PROGRESS, JSON.stringify(this.progress));
    },

    async loadArchiveText(text: string) {
      this.archive = parseArchive(text);
      await this.persistArchive();
      this.pushLog(`已载入中心档案：${this.archive.quarter}，共 ${this.archive.records.length} 条`);
    },

    async loadSampleArchive() {
      this.archive = buildSampleArchive();
      await this.persistArchive();
      this.pushLog(`已载入示例档案：${this.archive.quarter}，共 ${this.archive.records.length} 条`);
    },

    async clearArchive() {
      this.archive = null;
      await db.meta.delete(META_ARCHIVE);
      this.pushLog('已清除缓存的中心档案');
    },

    setFlaky(value: boolean) {
      this.flaky = value;
    },

    pushLog(line: string) {
      this.log.unshift(`${new Date().toTimeString().slice(0, 8)}  ${line}`);
      if (this.log.length > 80) this.log.length = 80;
    },

    stopSide(side: ReconcileSide) {
      this.stopFlags[side] = true;
    },

    async runCompare() {
      await this.runSide('compare');
    },

    async runReport() {
      await this.runSide('report');
    },

    /** 单侧执行：逐只处理，已完成的留住、失败的可重试，两侧互不影响 */
    async runSide(side: ReconcileSide) {
      if (this.runStatus[side] === 'running') return;
      this.stopFlags[side] = false;
      this.runStatus[side] = 'running';
      this.error[side] = '';
      const label = side === 'compare' ? '比对' : '上报';
      const targets = bandedRecords(useRingStore().rings);
      const matchMap = archiveMatchMap(this.archive);

      for (const record of targets) {
        if (this.stopFlags[side]) {
          this.runStatus[side] = 'stopped';
          this.pushLog(`${label}已停止：已核进度已留住，可继续或重新来过`);
          break;
        }
        if (this.progress[side].done.includes(record.id)) continue;

        this.current[side] = record.ringNo;
        try {
          await delay(STEP_DELAY);
          if (this.flaky && Math.random() < 0.18) {
            throw new Error('网络抖动：请求超时，请重试该侧');
          }

          if (side === 'compare') {
            const arch = matchMap.get(ringKey(record.ringNo));
            if (arch) {
              // 以中心为准更新身份字段；量度（ringId 关联）与鸟点生境（siteId）不动
              const patch = reconcileOne(arch, record);
              await useRingStore().updateRing(record.id, patch);
              this.pushLog(`已核 ${record.ringNo}：鸟种/学名/原环志日期已以中心档案为准`);
            } else {
              this.pushLog(`已核 ${record.ringNo}：中心档案无该环号，保持本站记录`);
            }
          } else {
            this.pushLog(`已编译 ${record.ringNo} 进入上报包`);
          }

          this.progress[side].done.push(record.id);
          this.progress[side].failed = this.progress[side].failed.filter((id) => id !== record.id);
          await this.persistProgress();
        } catch (error) {
          if (!this.progress[side].failed.includes(record.id)) this.progress[side].failed.push(record.id);
          await this.persistProgress();
          this.runStatus[side] = 'error';
          this.error[side] = (error as Error).message;
          this.pushLog(`${label}在 ${record.ringNo} 出错：${(error as Error).message}（已核 ${this.progress[side].done.length} 条已留住）`);
          break;
        }
      }

      this.current[side] = '';
      if (this.runStatus[side] === 'running') {
        this.runStatus[side] = 'done';
        this.pushLog(`${label}完成：共 ${this.progress[side].done.length} 条已核`);
      }
    },

    /** 某一侧重新来过：只清该侧进度，不影响另一侧；重捕不会因再核而多算 */
    async resetSide(side: ReconcileSide) {
      this.progress[side] = { done: [], failed: [] };
      this.runStatus[side] = 'idle';
      this.error[side] = '';
      this.current[side] = '';
      await this.persistProgress();
      this.pushLog(`${side === 'compare' ? '比对' : '上报'}侧已重新来过：进度已清空，可重新执行（不会重复计入重捕）`);
    },

    /** 生成并下载本站上报包（只编译不新增记录） */
    async downloadReport() {
      const pkg = buildReportPackage(useRingStore().rings, useSiteStore().sites);
      downloadText(
        `gbbirdring-center-report-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(pkg, null, 2),
      );
      this.pushLog(`已生成上报包：${pkg.records.length} 条带环个体`);
    },
  },
});
