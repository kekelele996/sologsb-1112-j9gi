/** 中心下发的外站环志/回收档案记录 */
export interface CenterArchiveRecord {
  /** 金属环号 */
  ringNo: string;
  /** 鸟种中文名（以中心为准） */
  speciesCn: string;
  /** 学名（以中心为准） */
  speciesSci: string;
  /** 原环志日期 YYYY-MM-DD（以中心为准） */
  originalRingDate: string;
  /** 外站环志地点 */
  bandingSite?: string;
  /** 档案类别：外站环志 / 回收 */
  kind: '外站环志' | '回收';
  /** 备注 */
  note?: string;
}

/** 中心每季度下发的档案包（本站「下载」后缓存到 IndexedDB） */
export interface CenterArchivePackage {
  app: typeof CENTER_ARCHIVE_APP;
  schemaVersion: number;
  /** 季度，如 2024-Q3 */
  quarter: string;
  issuedAt: string;
  source: string;
  records: CenterArchiveRecord[];
}

/** 本站上报给中心的带环个体（重捕/回收）记录包 */
export interface CenterReportPackage {
  app: typeof CENTER_REPORT_APP;
  schemaVersion: number;
  reportedAt: string;
  station: string;
  records: CenterReportRecord[];
}

export interface CenterReportRecord {
  ringNo: string;
  colorRing: string;
  speciesCn: string;
  speciesSci: string;
  status: string;
  /** 本站捕获日期 */
  ringDate: string;
  /** 中心档案原环志日期（已核时填写） */
  originalRingDate?: string;
  siteName: string;
  habitat?: string;
  netNo: string;
  netRound: number;
  ringer: string;
}

export const CENTER_ARCHIVE_APP = 'gbbirdring-center-archive' as const;
export const CENTER_REPORT_APP = 'gbbirdring-center-report' as const;

/** 比对 / 上报 两侧（可分别中断、分别重来） */
export type ReconcileSide = 'compare' | 'report';

/** 单侧进度：已完成的留住，失败的可重试 */
export interface SideProgress {
  /** 已核/已编译的本地记录 id */
  done: string[];
  /** 处理出错的本地记录 id */
  failed: string[];
  updatedAt?: string;
}

export interface ReconcileProgress {
  compare: SideProgress;
  report: SideProgress;
}

export type SideRunStatus = 'idle' | 'running' | 'stopped' | 'error' | 'done';
