import { describe, expect, it } from 'vitest';
import {
  applyChangesToRing,
  normalizeRingNo,
  pairWithLocal,
  parseArchive,
  planMerge,
  readyToMerge,
  runCenterCheck,
  runStationCheck,
  stationEvidenceOf,
} from '../utils/archiveSync';
import { SAMPLE_ARCHIVE, SAMPLE_ARCHIVE_JSON } from '../utils/sampleArchive';
import { SEED_RINGS, SEED_MORPHS, SEED_SITES } from '../utils/seed';
import type { ArchivePackage, SideCheck } from '../types/archive';
import type { RingRecord } from '../types/ring-record';

/** 构造一只本站台账记录的简写 */
function localRing(partial: Partial<RingRecord> & { ringNo: string }): RingRecord {
  return {
    id: partial.id ?? `ring-${partial.ringNo}`,
    colorRing: '无',
    speciesCn: partial.speciesCn ?? '黑腹滨鹬',
    speciesSci: partial.speciesSci ?? 'Calidris alpina',
    age: '成',
    ringDate: partial.ringDate ?? '2024-09-20T03:00:00.000Z',
    netNo: '1 号网',
    netRound: 1,
    status: partial.status ?? '初捕',
    ringer: '韩雪',
    siteId: partial.siteId ?? 'site-002',
    sessionId: 'session-002',
    ...partial,
  };
}

describe('环号归一化', () => {
  it('忽略空白、连字符与大小写', () => {
    expect(normalizeRingNo('a-10231')).toBe('A10231');
    expect(normalizeRingNo(' a 10231 ')).toBe('A10231');
    expect(normalizeRingNo('A-10231')).toBe('A10231');
    expect(normalizeRingNo('A10231')).toBe('A10231');
  });
});

describe('档案包解析', () => {
  it('示例档案包可解析；配对键被归一化（只留字母数字、大写）', () => {
    const pkg = parseArchive(SAMPLE_ARCHIVE_JSON);
    expect(pkg.batchNo).toBe('ARC-2024-Q3');
    expect(pkg.records).toHaveLength(9);
    // 档案条目保留原始环号用于展示
    expect(pkg.records.some((r) => r.ringNo === 'A-10101')).toBe(true);
    // 比对键归一化
    const pairs = pairWithLocal(pkg, []);
    expect(pairs.every((p) => p.ringNo === p.ringNo.replace(/[^A-Z0-9]/g, ''))).toBe(true);
    expect(pairs.map((p) => p.ringNo)).toContain('A10101');
  });

  it('拒绝缺少 app 标记的包', () => {
    expect(() => parseArchive(JSON.stringify({ batchNo: 'X', records: [] }))).toThrow(/格式不匹配/);
  });

  it('拒绝环号重复的包', () => {
    const bad: ArchivePackage = {
      ...SAMPLE_ARCHIVE,
      records: [SAMPLE_ARCHIVE.records[0], { ...SAMPLE_ARCHIVE.records[1], ringNo: SAMPLE_ARCHIVE.records[0].ringNo }],
    };
    expect(() => parseArchive(JSON.stringify(bad))).toThrow(/环号重复/);
  });

  it('拒绝非法日期与非法事件类型', () => {
    const bad = {
      ...SAMPLE_ARCHIVE,
      records: [{ ...SAMPLE_ARCHIVE.records[0], originRingDate: 'not-a-date' }],
    };
    expect(() => parseArchive(JSON.stringify(bad))).toThrow(/原环志日期/);
    const bad2 = {
      ...SAMPLE_ARCHIVE,
      records: [{ ...SAMPLE_ARCHIVE.records[0], eventType: '逃逸' }],
    };
    expect(() => parseArchive(JSON.stringify(bad2))).toThrow(/事件类型/);
  });
});

describe('逐只配对', () => {
  it('本站台账没有的环号标记为空（外站档案），本站多出的环号不产生条目', () => {
    const pairs = pairWithLocal(SAMPLE_ARCHIVE, SEED_RINGS);
    const external = pairs.filter((p) => p.local.length === 0).map((p) => p.ringNo);
    expect(external).toContain('D40388');
    expect(external).toContain('D40217');
    expect(external).toContain('E50002');
    // A-10231 本站有两行（初捕 + 重捕）
    const a10231 = pairs.find((p) => p.ringNo === 'A10231');
    expect(a10231?.local).toHaveLength(2);
    // 本站有、档案没有的 C-30101 不应出现
    expect(pairs.some((p) => p.ringNo === 'C30101')).toBe(false);
  });
});

describe('站侧核验（本站量度 / 生境权威）', () => {
  it('量度与生境齐备且时间线合理时通过', () => {
    const pkg = parseArchive(SAMPLE_ARCHIVE_JSON);
    const pairs = pairWithLocal(pkg, SEED_RINGS);
    const pair = pairs.find((p) => p.ringNo === 'A10101')!;
    const evidence = stationEvidenceOf(pair, SEED_MORPHS, SEED_SITES);
    const check = runStationCheck(pair, evidence);
    expect(check.status).toBe('pass');
    expect(evidence.measured).toBe(true);
    expect(evidence.habitatComplete).toBe(true);
  });

  it('缺实测量度时失败，但生境与其它项照常检查', () => {
    const archive = SAMPLE_ARCHIVE.records.find((r) => r.ringNo === 'A-10243')!;
    const rings = [localRing({ ringNo: 'A-10243', speciesCn: '黑腹滨鹬', speciesSci: 'Calidris alpina' })];
    const pair = { ringNo: 'A10243', archive, local: rings };
    // 不给任何 morphs
    const evidence = stationEvidenceOf(pair, [], SEED_SITES);
    const check = runStationCheck(pair, evidence);
    expect(check.status).toBe('fail');
    expect(check.issues.join()).toMatch(/实测量度/);
  });

  it('关联鸟点未登记生境时失败', () => {
    const archive = SAMPLE_ARCHIVE.records[0];
    const rings = [localRing({ ringNo: 'A-10101', id: 'ring-x', siteId: 'site-ghost' })];
    const pair = { ringNo: 'A10101', archive, local: rings };
    const evidence = stationEvidenceOf(pair, [{ ringId: 'ring-x' } as never], SEED_SITES);
    const check = runStationCheck(pair, evidence);
    expect(check.status).toBe('fail');
    expect(check.issues.join()).toMatch(/生境/);
  });

  it('中心原环志日期晚于本站最早捕获日期时提示时间线矛盾', () => {
    const archive = { ...SAMPLE_ARCHIVE.records[0], originRingDate: '2025-01-01T00:00:00.000Z' };
    const rings = [localRing({ ringNo: 'A-10101', id: 'ring-x', ringDate: '2024-09-20T03:00:00.000Z' })];
    const pair = { ringNo: 'A10101', archive, local: rings };
    const evidence = stationEvidenceOf(pair, [{ ringId: 'ring-x' } as never], SEED_SITES);
    const check = runStationCheck(pair, evidence);
    expect(check.issues.join()).toMatch(/时间线/);
  });

  it('外站档案不做站侧核验，保持 pending', () => {
    const archive = SAMPLE_ARCHIVE.records.find((r) => r.ringNo === 'D-40388')!;
    const pair = { ringNo: 'D40388', archive, local: [] };
    const check = runStationCheck(pair, stationEvidenceOf(pair, SEED_MORPHS, SEED_SITES));
    expect(check.status).toBe('pending');
  });
});

describe('中心侧核验（联网）', () => {
  it('断网时失败并提示可仅重核本侧', () => {
    const check = runCenterCheck(SAMPLE_ARCHIVE.records[0], false);
    expect(check.status).toBe('fail');
    expect(check.issues.join()).toMatch(/网络中断/);
  });

  it('在线时缺回收地点失败；补齐地点后通过——同一侧可单独重来', () => {
    const bad = SAMPLE_ARCHIVE.records.find((r) => r.ringNo === 'E-50002')!;
    const first = runCenterCheck(bad, true);
    expect(first.status).toBe('fail');
    expect(first.issues.join()).toMatch(/回收地点/);

    const fixed = runCenterCheck({ ...bad, recoverPlace: '湛江雷州湾' }, true);
    expect(fixed.status).toBe('pass');
  });

  it('原环志日期晚于事件日期时失败', () => {
    const bad = {
      ...SAMPLE_ARCHIVE.records[0],
      originRingDate: '2024-09-20T00:00:00.000Z',
      eventDate: '2024-05-01T00:00:00.000Z',
    };
    expect(runCenterCheck(bad, true).status).toBe('fail');
  });
});

describe('合并计划：中心权威字段覆盖、本站字段保护', () => {
  const archive = SAMPLE_ARCHIVE.records.find((r) => r.ringNo === 'A-10243')!;

  it('鸟种以中心为准；本站 ringDate / 网号 / 鸟点不在变更清单里', () => {
    const rings = [
      localRing({
        ringNo: 'A-10243',
        speciesCn: '黑腹滨鹬',
        speciesSci: 'Calidris alpina',
        ringDate: '2024-09-12T03:00:00.000Z',
        netNo: '1 号网',
        siteId: 'site-002',
      }),
    ];
    const plan = planMerge({ ringNo: 'A-10243', archive, local: rings });
    const fields = plan.changes.map((c) => c.field);
    expect(fields).toContain('speciesCn');
    expect(fields).toContain('speciesSci');
    expect(fields).toContain('originRingDate');
    expect(fields).not.toContain('ringDate');
    // 本站权威字段必须原样
    const next = applyChangesToRing(rings[0], plan.updates[0].changes);
    expect(next.speciesCn).toBe('西方滨鹬');
    expect(next.speciesSci).toBe('Calidris mauri');
    expect(next.ringDate).toBe(rings[0].ringDate);
    expect(next.netNo).toBe('1 号网');
    expect(next.siteId).toBe('site-002');
    expect(next.status).toBe('初捕');
    // 量度在独立的 morphs 表，合并不触碰
  });

  it('原环志日期以中心为准且不覆盖本站捕获日期', () => {
    const a10231 = SAMPLE_ARCHIVE.records.find((r) => r.ringNo === 'A-10231')!;
    const rings = SEED_RINGS.filter((r) => r.ringNo === 'A-10231');
    expect(rings).toHaveLength(2);
    const plan = planMerge({ ringNo: 'A-10231', archive: a10231, local: rings });
    expect(plan.changes.find((c) => c.field === 'originRingDate')?.to).toBe('2023-09-02');
    plan.updates.forEach((update) => {
      const record = rings.find((r) => r.id === update.id)!;
      const next = applyChangesToRing(record, update.changes);
      expect(next.ringDate).toBe(record.ringDate);
      expect(next.originRingDate?.slice(0, 10)).toBe('2023-09-02');
    });
  });

  it('幂等：对已回填中心字段的记录再算一次，无新增变更', () => {
    const rings = [
      localRing({
        ringNo: 'A-10243',
        speciesCn: '西方滨鹬',
        speciesSci: 'Calidris mauri',
        originRingDate: '2024-06-10T00:00:00.000Z',
        originStation: '唐山三岛环志站',
      }),
    ];
    const plan = planMerge({ ringNo: 'A-10243', archive, local: rings });
    expect(plan.changes).toHaveLength(0);
    expect(plan.updates).toHaveLength(0);
  });

  it('同环号两行（初捕+重捕）逐行更新但只产生一份变更清单，台账行数恒为 2', () => {
    const a10231 = SAMPLE_ARCHIVE.records.find((r) => r.ringNo === 'A-10231')!;
    const rings = SEED_RINGS.filter((r) => r.ringNo === 'A-10231');
    expect(rings).toHaveLength(2);
    expect(rings.map((r) => r.status)).toEqual(['初捕', '重捕']);
    const recaptureBefore = rings.filter((r) => r.status === '重捕').length;
    const plan = planMerge({ ringNo: 'A-10231', archive: a10231, local: rings });
    const updated = rings.map((record) => {
      const update = plan.updates.find((u) => u.id === record.id);
      return update ? applyChangesToRing(record, update.changes) : record;
    });
    // 关键断言：行数不变 → 重捕次数不会因再核一次而多算
    expect(updated).toHaveLength(rings.length);
    expect(updated.filter((r) => r.status === '重捕')).toHaveLength(recaptureBefore);
    expect(updated.every((r) => r.originRingDate?.slice(0, 10) === '2023-09-02')).toBe(true);
    // 本站捕获日期保持各自不变
    updated.forEach((record, i) => expect(record.ringDate).toBe(rings[i].ringDate));
  });
});

describe('合并准入', () => {
  const pass: SideCheck = { status: 'pass', issues: [], checkedAt: 't' };
  const fail: SideCheck = { status: 'fail', issues: ['x'], checkedAt: 't' };
  const pending: SideCheck = { status: 'pending', issues: [], checkedAt: '' };
  it('必须两侧都 pass', () => {
    expect(readyToMerge(pass, pass)).toBe(true);
    expect(readyToMerge(fail, pass)).toBe(false);
    expect(readyToMerge(pass, pending)).toBe(false);
  });
});
