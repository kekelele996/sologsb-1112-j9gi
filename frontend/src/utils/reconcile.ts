import type { RingRecord } from '../types/ring-record';
import type { BirdSite } from '../types/bird-site';
import {
  CENTER_ARCHIVE_APP,
  CENTER_REPORT_APP,
  type CenterArchivePackage,
  type CenterArchiveRecord,
  type CenterReportPackage,
  type ReconcileProgress,
} from '../types/center-archive';

/** meta 表键：缓存的中心档案包 */
export const META_ARCHIVE = 'center-archive-package';
/** meta 表键：两侧比对/上报进度（断网续传依据） */
export const META_PROGRESS = 'reconcile-progress';

/** 环号归一化（去空格 + 小写），用于逐只比对 */
export function ringKey(ringNo: string): string {
  return ringNo.trim().toLowerCase();
}

export function emptyProgress(): ReconcileProgress {
  return {
    compare: { done: [], failed: [] },
    report: { done: [], failed: [] },
  };
}

/** 解析并校验中心档案包（带 app 标记，避免与备份文件混淆） */
export function parseArchive(text: string): CenterArchivePackage {
  const pkg = JSON.parse(text) as Partial<CenterArchivePackage>;
  if (!pkg || pkg.app !== CENTER_ARCHIVE_APP) {
    throw new Error(`档案包格式不匹配（缺少 app=${CENTER_ARCHIVE_APP} 标记）`);
  }
  if (!Array.isArray(pkg.records)) {
    throw new Error('档案包缺少 records 数组');
  }
  return pkg as CenterArchivePackage;
}

export function currentQuarter(d = new Date()): string {
  return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
}

/** 生成本站示例档案包：与示例台账的重捕/回收记录对应，另含外站环志、本站未捕获的鸟种 */
export function buildSampleArchive(): CenterArchivePackage {
  const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const records: CenterArchiveRecord[] = [
    { ringNo: 'A-10099', speciesCn: '红喉歌鸲', speciesSci: 'Calliope calliope', originalRingDate: '2023-09-15', bandingSite: '山东长岛环志站', kind: '回收', note: '外站环志，本站回收' },
    { ringNo: 'A-10101', speciesCn: '红喉歌鸲', speciesSci: 'Calliope calliope', originalRingDate: '2024-01-20', bandingSite: '河北北戴河环志站', kind: '外站环志' },
    { ringNo: 'A-10231', speciesCn: '红喉歌鸲', speciesSci: 'Calliope calliope', originalRingDate: day(21), bandingSite: '山东黄河口环志站', kind: '外站环志', note: '中心存档的环志记录，供跨站核对' },
    { ringNo: 'A-20999', speciesCn: '黄眉柳莺', speciesSci: 'Phylloscopus inornatus', originalRingDate: '2024-08-02', bandingSite: '辽宁大连环志站', kind: '外站环志' },
    { ringNo: 'B-77881', speciesCn: '白腰杓鹬', speciesSci: 'Numenius arquata', originalRingDate: '2024-05-30', bandingSite: '山东黄河口环志站', kind: '外站环志' },
  ];
  return {
    app: CENTER_ARCHIVE_APP,
    schemaVersion: 1,
    quarter: currentQuarter(),
    issuedAt: new Date().toISOString(),
    source: '全国鸟类环志中心 · 外站环志与回收档案（示例）',
    records,
  };
}

/**
 * 逐只比对：中心档案只确认「身份」——鸟种（中文名/学名）与原环志日期以中心为准。
 * 本站实测的量度（morphs 按 ringId 关联，不在此改动）与鸟点生境（siteId）不在此覆盖。
 */
export function reconcileOne(
  arch: CenterArchiveRecord,
  _local: RingRecord,
): Pick<RingRecord, 'speciesCn' | 'speciesSci' | 'originalRingDate'> {
  return {
    speciesCn: arch.speciesCn,
    speciesSci: arch.speciesSci,
    originalRingDate: arch.originalRingDate,
  };
}

/** 本站带环个体（重捕 / 回收）：台账只记本地捕获，初捕不与外站档案比对 */
export function bandedRecords(records: RingRecord[]): RingRecord[] {
  return records.filter((record) => record.status === '重捕' || record.status === '回收');
}

/** 档案环号 → 档案记录 映射（归一化环号） */
export function archiveMatchMap(pkg: CenterArchivePackage | null): Map<string, CenterArchiveRecord> {
  const map = new Map<string, CenterArchiveRecord>();
  pkg?.records.forEach((record) => map.set(ringKey(record.ringNo), record));
  return map;
}

/** 生成本站上报包：全部带环个体（重捕/回收），只编译不新增，重捕次数不会因再核而多算 */
export function buildReportPackage(records: RingRecord[], sites: BirdSite[]): CenterReportPackage {
  const siteById = new Map(sites.map((site) => [site.id, site]));
  return {
    app: CENTER_REPORT_APP,
    schemaVersion: 1,
    reportedAt: new Date().toISOString(),
    station: '本站环志台账',
    records: bandedRecords(records).map((record) => {
      const site = siteById.get(record.siteId);
      return {
        ringNo: record.ringNo,
        colorRing: record.colorRing,
        speciesCn: record.speciesCn,
        speciesSci: record.speciesSci,
        status: record.status,
        ringDate: record.ringDate,
        originalRingDate: record.originalRingDate,
        siteName: site?.name ?? '未知鸟点',
        habitat: site?.habitat,
        netNo: record.netNo,
        netRound: record.netRound,
        ringer: record.ringer,
      };
    }),
  };
}

/** 从 meta 读取进度（防御性解析，损坏则回退空进度） */
export function parseProgress(text: string | undefined): ReconcileProgress {
  const base = emptyProgress();
  if (!text) return base;
  try {
    const parsed = JSON.parse(text) as Partial<ReconcileProgress>;
    (['compare', 'report'] as const).forEach((side) => {
      const s = parsed[side];
      if (Array.isArray(s?.done)) base[side].done = s.done;
      if (Array.isArray(s?.failed)) base[side].failed = s.failed;
      if (typeof s?.updatedAt === 'string') base[side].updatedAt = s.updatedAt;
    });
  } catch {
    return base;
  }
  return base;
}
