/**
 * 中心档案比对的纯逻辑层（无 Dexie / 无 DOM，全部可单测）。
 *
 * 与 stores/syncStore.ts 的分工：
 * - 本文件只管"算"：解析档案、环号归一化、按只配对、站侧 / 中心侧核验、算字段合并计划；
 * - store 管"存"：把结果幂等写入 IndexedDB，并在断线重连后只重跑失败侧。
 */
import type { ArchivePackage, ArchiveRecord, FieldChange, SideCheck } from '../types/archive';
import { PENDING_CHECK } from '../types/archive';
import type { BirdSite } from '../types/bird-site';
import type { Morphometrics } from '../types/morphometrics';
import type { RingRecord } from '../types/ring-record';

/**
 * 环号归一化：只保留字母与数字并统一大写，作为跨档案匹配键
 * （A-10231、A10231、a 10231 视为同一只；仅用于比对，不改写原始录入）
 */
export function normalizeRingNo(ringNo: string): string {
  return ringNo.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function isIsoDate(value: unknown): boolean {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/** 解析中心下发的 JSON 档案包，并做结构校验与按环号去重 */
export function parseArchive(text: string): ArchivePackage {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('档案包不是合法 JSON');
  }
  const pkg = raw as Partial<ArchivePackage> | null;
  if (!pkg || typeof pkg !== 'object') throw new Error('档案包内容为空');
  if (pkg.app !== 'gbbirdring-archive') {
    throw new Error('档案包格式不匹配（缺少 app=gbbirdring-archive 标记）');
  }
  if (!pkg.batchNo || typeof pkg.batchNo !== 'string') throw new Error('档案包缺少批次号 batchNo');
  if (!pkg.quarter || typeof pkg.quarter !== 'string') throw new Error('档案包缺少季度 quarter');
  if (!Array.isArray(pkg.records) || pkg.records.length === 0) throw new Error('档案包没有任何档案条目');

  const seen = new Set<string>();
  const records: ArchiveRecord[] = [];
  pkg.records.forEach((row, index) => {
    const pos = `第 ${index + 1} 条`;
    if (!row || typeof row !== 'object') throw new Error(`${pos}：不是有效条目`);
    const r = row as Partial<ArchiveRecord>;
    if (!r.ringNo || typeof r.ringNo !== 'string') throw new Error(`${pos}：缺少金属环号`);
    if (!r.speciesCn) throw new Error(`${pos}（${r.ringNo}）：缺少鸟种中文名`);
    if (!r.speciesSci) throw new Error(`${pos}（${r.ringNo}）：缺少学名`);
    if (!isIsoDate(r.originRingDate)) throw new Error(`${pos}（${r.ringNo}）：原环志日期缺失或无法解析`);
    if (!r.originStation) throw new Error(`${pos}（${r.ringNo}）：缺少原环志站`);
    if (r.eventType !== '环志' && r.eventType !== '回收') throw new Error(`${pos}（${r.ringNo}）：事件类型只能是「环志 / 回收」`);
    if (!isIsoDate(r.eventDate)) throw new Error(`${pos}（${r.ringNo}）：事件日期缺失或无法解析`);
    const key = normalizeRingNo(r.ringNo);
    if (seen.has(key)) throw new Error(`${pos}（${r.ringNo}）：档案包内环号重复`);
    seen.add(key);
    records.push({
      ringNo: r.ringNo.trim(),
      colorRing: r.colorRing || '无',
      speciesCn: r.speciesCn.trim(),
      speciesSci: r.speciesSci.trim(),
      originRingDate: new Date(r.originRingDate as string).toISOString(),
      originStation: r.originStation.trim(),
      eventType: r.eventType,
      eventDate: new Date(r.eventDate as string).toISOString(),
      recoverPlace: r.recoverPlace?.trim() || undefined,
      remark: r.remark?.trim() || undefined,
    });
  });

  return {
    app: 'gbbirdring-archive',
    batchNo: pkg.batchNo.trim(),
    quarter: pkg.quarter.trim(),
    issuedAt: isIsoDate(pkg.issuedAt) ? new Date(pkg.issuedAt as string).toISOString() : new Date().toISOString(),
    records,
  };
}

export interface PairResult {
  /** 归一化环号 */
  ringNo: string;
  archive: ArchiveRecord;
  /** 本站台账中同一环号的全部记录（初捕/重捕/回收可能有多行）；空 = 外站档案 */
  local: RingRecord[];
}

/**
 * 逐只配对：档案中的每一条按环号在本站台账里找。
 * 本站有、档案没有的环号不产生条目（它们不来自这包档案，无需比对）。
 */
export function pairWithLocal(pkg: ArchivePackage, localRings: RingRecord[]): PairResult[] {
  const byRingNo = new Map<string, RingRecord[]>();
  localRings.forEach((record) => {
    const key = normalizeRingNo(record.ringNo);
    const list = byRingNo.get(key);
    if (list) list.push(record);
    else byRingNo.set(key, [record]);
  });
  return pkg.records.map((archive) => ({
    ringNo: normalizeRingNo(archive.ringNo),
    archive,
    local: byRingNo.get(normalizeRingNo(archive.ringNo)) ?? [],
  }));
}

export interface StationEvidence {
  /** 该只本站所有台账行是否都有至少一条实测量度 */
  measured: boolean;
  /** 该只各捕获行的鸟点是否都登记了生境 */
  habitatComplete: boolean;
  /** 该只本站最早捕获日期（YYYY-MM-DD），无记录为空 */
  firstLocalDate: string;
  missingMeasureRings: string[];
  missingHabitatSiteIds: string[];
}

/**
 * 站侧材料核对（本地即可完成，不依赖"中心联网"）：
 * 本站实测的量度与鸟点生境是本站权威，核对只检查"有没有"，绝不拿档案值去改它们。
 */
export function stationEvidenceOf(pair: PairResult, morphs: Morphometrics[], sites: BirdSite[]): StationEvidence {
  const morphRingIds = new Set(morphs.map((morph) => morph.ringId));
  const siteById = new Map(sites.map((site) => [site.id, site]));

  const missingMeasureRings: string[] = [];
  const missingHabitatSiteIds: string[] = [];
  pair.local.forEach((record) => {
    if (!morphRingIds.has(record.id)) missingMeasureRings.push(record.id);
    const site = siteById.get(record.siteId);
    if (!site || !site.habitat) missingHabitatSiteIds.push(record.siteId);
  });

  const dates = pair.local.map((record) => record.ringDate).sort();
  return {
    measured: missingMeasureRings.length === 0,
    habitatComplete: missingHabitatSiteIds.length === 0,
    firstLocalDate: dates[0] ? dates[0].slice(0, 10) : '',
    missingMeasureRings,
    missingHabitatSiteIds: [...new Set(missingHabitatSiteIds)],
  };
}

/**
 * 站侧核验结论。外站档案（本站无记录）不参与站侧核验，保持 pending，
 * 在界面上单独按"外站档案"展示，不能并账。
 */
export function runStationCheck(pair: PairResult, evidence: StationEvidence): SideCheck {
  if (pair.local.length === 0) return { ...PENDING_CHECK };
  const issues: string[] = [];
  if (!evidence.measured) {
    issues.push(`本站有 ${evidence.missingMeasureRings.length} 条捕获记录缺实测量度（量度为本站权威材料，补齐后再核）`);
  }
  if (!evidence.habitatComplete) {
    issues.push(`有 ${evidence.missingHabitatSiteIds.length} 个关联鸟点未登记生境（鸟点生境为本站权威材料）`);
  }
  // 原环志日期不可能晚于本站捕获日期；若中心日期晚于本站最早捕获，材料对不上。
  const originDate = pair.archive.originRingDate.slice(0, 10);
  if (evidence.firstLocalDate && originDate > evidence.firstLocalDate) {
    issues.push(`中心原环志日期 ${originDate} 晚于本站最早捕获日期 ${evidence.firstLocalDate}，时间线矛盾，请复核`);
  }
  return issues.length === 0
    ? { status: 'pass', issues: [], checkedAt: new Date().toISOString() }
    : { status: 'fail', issues, checkedAt: new Date().toISOString() };
}

/**
 * 中心侧核验：校验档案条目自洽性。真实部署中这一步需要联网访问中心系统；
 * 断网时 store 会让这一侧失败而不动站侧结论。online=false 时直接返回网络错误。
 */
export function runCenterCheck(archive: ArchiveRecord, online: boolean): SideCheck {
  if (!online) {
    return { status: 'fail', issues: ['无法连接候鸟环志中心（网络中断），恢复后可仅重核本侧'], checkedAt: new Date().toISOString() };
  }
  const issues: string[] = [];
  const originDate = archive.originRingDate.slice(0, 10);
  const eventDate = archive.eventDate.slice(0, 10);
  if (originDate > eventDate) {
    issues.push(`档案时间线矛盾：原环志日期 ${originDate} 晚于${archive.eventType}日期 ${eventDate}`);
  }
  if (archive.eventType === '回收' && !archive.recoverPlace) {
    issues.push('回收事件缺少回收地点');
  }
  if (archive.speciesCn.trim().length < 2) {
    issues.push('鸟种中文名异常');
  }
  return issues.length === 0
    ? { status: 'pass', issues: [], checkedAt: new Date().toISOString() }
    : { status: 'fail', issues, checkedAt: new Date().toISOString() };
}

/** 中心权威、允许覆盖本站台账的字段定义 */
const MERGE_FIELDS: Array<{ key: FieldChange['field']; label: string; read: (a: ArchiveRecord) => string }> = [
  { key: 'speciesCn', label: '鸟种（中文）', read: (a) => a.speciesCn },
  { key: 'speciesSci', label: '鸟种（学名）', read: (a) => a.speciesSci },
  { key: 'originRingDate', label: '原环志日期', read: (a) => a.originRingDate.slice(0, 10) },
  { key: 'originStation', label: '原环志站', read: (a) => a.originStation },
];

/**
 * 计算一只的字段合并计划（只算，不落库）。
 *
 * 只覆盖 4 个中心权威字段；以下本站字段一律不动：
 * ringDate（本站捕获日期）、netNo/netRound、siteId（鸟点生境）、status、ringer，
 * 以及 morphs 表里本站实测量度。
 *
 * 同一环号在本站有多行（初捕 + 重捕）时逐行比较，但只返回一份去重后的变更清单，
 * 且不新增 / 不删除任何台账行——这是"重捕次数不会因再核一次而多算"的根本保证。
 */
export function planMerge(pair: PairResult): { updates: Array<{ id: string; changes: FieldChange[] }>; changes: FieldChange[] } {
  const updates: Array<{ id: string; changes: FieldChange[] }> = [];
  const mergedChangeKeys = new Set<string>();
  const changes: FieldChange[] = [];

  pair.local.forEach((record) => {
    const rowChanges: FieldChange[] = [];
    MERGE_FIELDS.forEach((field) => {
      const target = field.read(pair.archive);
      const current =
        field.key === 'originRingDate'
          ? record.originRingDate
            ? record.originRingDate.slice(0, 10)
            : ''
          : String((record as unknown as Record<string, unknown>)[field.key] ?? '').trim();
      // 空值（本站从未经中心核准）也算一次变更；非空且一致则不动。
      if (current === target) return;
      const change: FieldChange = { field: field.key, label: field.label, from: current, to: target };
      rowChanges.push(change);
      if (!mergedChangeKeys.has(field.key)) {
        mergedChangeKeys.add(field.key);
        changes.push(change);
      }
    });
    if (rowChanges.length > 0) updates.push({ id: record.id, changes: rowChanges });
  });

  return { updates, changes };
}

/** 把合并计划应用到一行台账记录（纯函数，返回新对象） */
export function applyChangesToRing(record: RingRecord, changes: FieldChange[]): RingRecord {
  const next: RingRecord = { ...record };
  changes.forEach((change) => {
    if (change.field === 'originRingDate') {
      next.originRingDate = new Date(`${change.to}T00:00:00.000Z`).toISOString();
    } else {
      (next as unknown as Record<string, string>)[change.field] = change.to;
    }
  });
  return next;
}

/** 两侧都通过才允许合并 */
export function readyToMerge(station: SideCheck, center: SideCheck): boolean {
  return station.status === 'pass' && center.status === 'pass';
}
