/**
 * 候鸟环志中心季度下发档案与逐只比对的类型定义。
 *
 * 权威边界（业务铁律）：
 * - 中心权威字段：鸟种（中文名 / 学名）、原环志日期、原环志站。比对命中时以档案为准回填；
 * - 本站权威字段：本站捕获日期、网号网次、鸟点 / 生境、本站实测量度。档案绝不能盖掉；
 * - 档案中本站台账没有的环号属于外站环志 / 回收档案，只登记备查，不写入本站环志台账。
 */

/** 中心档案中的单只环志 / 回收条目 */
export interface ArchiveRecord {
  /** 金属环号（匹配键，比对前统一归一化） */
  ringNo: string;
  /** 彩环组合（可空） */
  colorRing?: string;
  /** 鸟种中文名（中心权威） */
  speciesCn: string;
  /** 学名（中心权威） */
  speciesSci: string;
  /** 原环志日期 ISO（中心权威） */
  originRingDate: string;
  /** 原环志站（中心权威） */
  originStation: string;
  /** 事件类型：环志 / 回收 */
  eventType: '环志' | '回收';
  /** 事件 / 回收日期 ISO */
  eventDate: string;
  /** 回收地点（回收事件可填） */
  recoverPlace?: string;
  /** 备注 */
  remark?: string;
}

/** 中心每季度下发的一包档案 */
export interface ArchivePackage {
  /** 固定标记，解析时校验 */
  app: 'gbbirdring-archive';
  /** 档案批次号，如 ARC-2024-Q3 */
  batchNo: string;
  /** 季度，如 2024-Q3 */
  quarter: string;
  /** 下发日期 ISO */
  issuedAt: string;
  records: ArchiveRecord[];
}

/** 单侧（站侧 / 中心侧）核验结果 */
export interface SideCheck {
  /** pending 未核 / pass 通过 / fail 出问题 */
  status: 'pending' | 'pass' | 'fail';
  /** 未通过或提示项 */
  issues: string[];
  /** 核验完成时间 ISO */
  checkedAt: string;
}

/** 合并时单个字段的变更（用于界面展示"谁覆盖了谁"） */
export interface FieldChange {
  field: 'speciesCn' | 'speciesSci' | 'originRingDate' | 'originStation';
  label: string;
  /** 本站现值（无则空） */
  from: string;
  /** 中心档案值 */
  to: string;
}

/** 一只的比对状态 */
export interface SyncItem {
  id: string;
  /** 所属档案批次 id */
  archiveId: string;
  batchNo: string;
  quarter: string;
  /** 归一化后的环号 */
  ringNo: string;
  /** 档案条目快照（解析时落库，断网后仍可查看） */
  archive: ArchiveRecord;
  /** 命中的本站环志记录 id；空数组 = 外站档案，本站无记录 */
  localRingIds: string[];

  /** 站侧核验：本站量度、鸟点生境等实测材料是否齐备（本地可完成，不依赖网络） */
  station: SideCheck;
  /** 中心侧核验：档案条目自洽性与中心系统联网核对（断网时这一侧失败，可单独重跑） */
  center: SideCheck;

  /** 是否已执行字段合并 */
  merged: boolean;
  mergedAt: string;
  /** 本次实际应用的字段变更（幂等重跑时为空） */
  appliedChanges: FieldChange[];
  /** 上次合并时间（用于幂等重跑提示） */
  note?: string;
}

/** 一包档案的汇总信息（条目本身存在 syncItems 里） */
export interface ArchiveBatch {
  id: string;
  batchNo: string;
  quarter: string;
  issuedAt: string;
  importedAt: string;
  recordCount: number;
}

export const PENDING_CHECK: SideCheck = { status: 'pending', issues: [], checkedAt: '' };
