import type { ArchivePackage } from '../types/archive';

/**
 * 演示用「中心季度档案包」。环号刻意与 seed.ts 的本站台账交叉，覆盖：
 * - 站侧 / 中心侧都通过、可正常合并（含原环志日期回填、鸟种订正）；
 * - 站侧缺实测量度 / 缺生境（本地补材料后只需重核站侧）；
 * - 中心侧条目缺回收地点（联网核对失败，只需重核中心侧）；
 * - 外站环志 / 回收、本站台账没有的环号（只登记不并账）；
 * - 同一环号本站已有多行（初捕 + 重捕），验证重捕次数不被多算。
 */
export const SAMPLE_ARCHIVE: ArchivePackage = {
  app: 'gbbirdring-archive',
  batchNo: 'ARC-2024-Q3',
  quarter: '2024-Q3',
  issuedAt: '2024-09-30T02:00:00.000Z',
  records: [
    {
      ringNo: 'A-10101',
      colorRing: '绿-橙',
      speciesCn: '红喉歌鸲',
      speciesSci: 'Calliope calliope',
      originRingDate: '2024-05-08T00:00:00.000Z',
      originStation: '丹东鸭绿江口环志站',
      eventType: '环志',
      eventDate: '2024-05-08T00:00:00.000Z',
      remark: '本站台账两行（初捕/重捕）原环志日期留空，需回填',
    },
    {
      ringNo: 'A-10231',
      colorRing: '红-黄',
      speciesCn: '红喉歌鸲',
      speciesSci: 'Calliope calliope',
      originRingDate: '2023-09-02T00:00:00.000Z',
      originStation: '丹东鸭绿江口环志站',
      eventType: '环志',
      eventDate: '2023-09-02T00:00:00.000Z',
      remark: '本站误把本季捕获日当环志日，以中心原环志日期为准',
    },
    {
      ringNo: 'A-10242',
      colorRing: '黄-蓝-白',
      speciesCn: '白腰杓鹬',
      speciesSci: 'Numenius arquata',
      originRingDate: '2022-04-16T00:00:00.000Z',
      originStation: '盘锦辽河口环志站',
      eventType: '环志',
      eventDate: '2022-04-16T00:00:00.000Z',
    },
    {
      ringNo: 'A-10232',
      colorRing: '无',
      speciesCn: '黄眉柳莺',
      speciesSci: 'Phylloscopus inornatus',
      originRingDate: '2024-08-12T00:00:00.000Z',
      originStation: '秦皇岛北戴河环志站',
      eventType: '环志',
      eventDate: '2024-08-12T00:00:00.000Z',
    },
    {
      ringNo: 'A-10243',
      colorRing: '无',
      speciesCn: '西方滨鹬',
      speciesSci: 'Calidris mauri',
      originRingDate: '2024-06-10T00:00:00.000Z',
      originStation: '唐山三岛环志站',
      eventType: '环志',
      eventDate: '2024-06-10T00:00:00.000Z',
      remark: '本站现场定为黑腹滨鹬，鸟种以中心鉴定订正',
    },
    {
      ringNo: 'A-10099',
      colorRing: '无',
      speciesCn: '红喉歌鸲',
      speciesSci: 'Calliope calliope',
      originRingDate: '2024-09-19T00:00:00.000Z',
      originStation: '沧州南大港环志站',
      eventType: '回收',
      eventDate: '2024-09-30T00:00:00.000Z',
      recoverPlace: '大汶流芦苇荡网场',
      remark: '本站缺实测量度：站侧失败，补齐量度后只需重核站侧',
    },
    {
      ringNo: 'D-40217',
      colorRing: '蓝-白',
      speciesCn: '灰斑鸻',
      speciesSci: 'Pluvialis squatarola',
      originRingDate: '2024-07-21T00:00:00.000Z',
      originStation: '营口辽河环志站',
      eventType: '环志',
      eventDate: '2024-07-21T00:00:00.000Z',
    },
    {
      ringNo: 'D-40388',
      colorRing: '无',
      speciesCn: '红颈滨鹬',
      speciesSci: 'Calidris ruficollis',
      originRingDate: '2023-08-30T00:00:00.000Z',
      originStation: '连云港环志站',
      eventType: '回收',
      eventDate: '2024-09-12T00:00:00.000Z',
      recoverPlace: '湛江雷州湾',
      remark: '外站回收档案，本站无捕获记录，只登记不并账',
    },
    {
      ringNo: 'E-50002',
      colorRing: '无',
      speciesCn: '大滨鹬',
      speciesSci: 'Calidris tenuirostris',
      originRingDate: '2024-05-03T00:00:00.000Z',
      originStation: '上海崇明东滩环志站',
      eventType: '回收',
      eventDate: '2024-09-02T00:00:00.000Z',
      remark: '中心档案缺回收地点：中心侧核对失败，修订档案下发后仅重核中心侧',
    },
  ],
};

/** 下载用 JSON 文本 */
export const SAMPLE_ARCHIVE_JSON = JSON.stringify(SAMPLE_ARCHIVE, null, 2);
