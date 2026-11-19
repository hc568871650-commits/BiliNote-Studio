import type { StructuredNoteDocument } from '@/types/structuredNote'

export const structuredPreviewDoc: StructuredNoteDocument = {
  schema_version: 1,
  note_style: 'knowledge',
  title: '数据库连接池调优与主动回忆实战（结构化演示）',
  platform: 'local',
  video_id: 'sample',
  sections: [
    {
      id: 'sec-1',
      title: '数据库连接池参数调优',
      level: 2,
      time_ranges: [
        { start: 728, end: 870, label: '12:08' },
        { start: 2055, end: 2120, label: '34:15' },
      ],
      core_takeaways: [
        {
          spans: [
            { text: '连接数绝不是越大越好', emphasis: 'hl', annotation_id: 'why-1' },
            { text: '：超过磁盘并发上限后，线程上下文切换反而会拖垮整体吞吐量。', emphasis: 'plain' },
          ],
        },
      ],
      blocks: [
        {
          type: 'paragraph',
          spans: [
            { text: '原片压测中盲目拉高连接上限直接引发了线上接口响应雪崩', emphasis: 'plain', annotation_id: 'case-1' },
            { text: '；生产环境建议遵守', emphasis: 'plain' },
            { text: '核数两倍封顶原则', emphasis: 'ul' },
            { text: '，且', emphasis: 'plain' },
            { text: '严禁连接存活时间大于服务端超时', emphasis: 'wave', annotation_id: 'pit-1' },
            { text: '。', emphasis: 'plain' },
          ],
        },
        {
          type: 'table',
          table_kind: 'params',
          columns: ['核心参数', '推荐值', '作用与改错后果'],
          column_modes: ['nowrap', 'nowrap', 'wrap'],
          rows: [
            [
              [{ text: 'maximumPoolSize', emphasis: 'code' }],
              [{ text: 'CPU核数 × 2 + 1', emphasis: 'code' }],
              [{ text: '控制最大并发连接；设太高引发锁争抢，吞吐量不升反降' }],
            ],
            [
              [{ text: 'connectionTimeout', emphasis: 'code' }],
              [{ text: '3000 ms', emphasis: 'code' }],
              [{ text: '获取连接等待上限；默认 30 秒太长，故障时易拖死上游调用' }],
            ],
            [
              [{ text: 'maxLifetime', emphasis: 'code' }],
              [{ text: '比服务端短 60 s', emphasis: 'code' }],
              [{ text: '主动回收老连接；避免拿到已被防火墙或数据库静默断开的死连接' }],
            ],
          ],
        },
      ],
      annotations: [
        {
          id: 'why-1',
          kind: 'why',
          short_hint: '单核同一时刻只能跑单线程，多了全耗在排队切换',
          full_detail: 'CPU 单核同一时刻只能执行一个线程。当活跃连接数远超核数时，操作系统每秒要进行数万次寄存器保存与恢复（上下文切换），真正花在 SQL 查询上的有效时间反而不到 30%。',
          timestamp: 744,
          timestamp_label: '原片 12:24',
        },
        {
          id: 'case-1',
          kind: 'case',
          short_hint: '连接数从 20 盲目加到 200 后 TPS 当场暴跌 75%',
          full_detail: 'UP 主在 8 核压测机上现场对比：连接池设为 20 时 TPS 稳定在 4500；改成 200 后 TPS 直接掉到 1100，平均响应延迟从 4 ms 飙升到 180 ms。',
          timestamp: 845,
          timestamp_label: '原片 14:05',
        },
        {
          id: 'pit-1',
          kind: 'pit',
          short_hint: '服务端超时主动掐连接，客户端不知情必抛异常',
          full_detail: 'MySQL 的 wait_timeout 或云网关通常会在空闲数分钟后单方面断开连接。若客户端 maxLifetime 更长，下次借出该连接发请求就会直接抛 Connection reset 报错。',
          timestamp: 2055,
          timestamp_label: '原片 34:15',
        },
      ],
      quiz: {
        short_prompt: '8 核慢查询卡顿，连接池拉到 100 管用吗？',
        full_question: '线上 8 核数据库突发慢查询卡顿，直接把连接池拉大到 100 能缓解吗？',
        options: [
          { key: 'A', text: '能缓解，扩容后线程不用在池外排队等待连接' },
          { key: 'B', text: '不能，更多慢 SQL 并发涌入只会加剧 CPU 切换与锁争抢' },
          { key: 'C', text: '只要同步把 connectionTimeout 调回 30 秒即可缓解' },
        ],
        correct_key: 'B',
        explanation: '慢查询瓶颈在索引缺失或锁等待，盲目扩到 100 只会让上百线程争抢 8 核；应维持 17 左右并优先查慢 SQL。',
      },
    },
    {
      id: 'sec-2',
      title: '慢查询与行锁争抢排查',
      level: 2,
      time_ranges: [
        { start: 1300, end: 1420, label: '21:40' },
        { start: 2530, end: 2620, label: '42:10' },
      ],
      core_takeaways: [
        {
          spans: [
            { text: '未命中索引的更新会触发全表扫描锁', emphasis: 'hl' },
            { text: '：即使单次查询仅耗时 ', emphasis: 'plain' },
            { text: '80 ms', emphasis: 'code' },
            { text: '，高并发叠加后也会把正常读写请求全部阻塞在锁等待队列中。', emphasis: 'plain' },
          ],
        },
      ],
      blocks: [
        {
          type: 'flow_chain',
          steps: [
            [{ text: '开启慢日志捕获耗时语句', emphasis: 'plain' }],
            [{ text: '检查执行计划 ', emphasis: 'plain' }, { text: 'type', emphasis: 'code' }, { text: ' 列', emphasis: 'plain' }],
            [{ text: '补齐联合索引消除表锁升级', emphasis: 'plain' }],
          ],
        },
        {
          type: 'checklist',
          title: '上线前索引与锁排查自查',
          items: [
            {
              id: 'chk-1',
              spans: [
                { text: '已开启慢查询日志并将阈值 ', emphasis: 'plain' },
                { text: 'long_query_time', emphasis: 'code' },
                { text: ' 调至 ', emphasis: 'plain' },
                { text: '0.5 s', emphasis: 'code' },
              ],
              checked: false,
            },
            {
              id: 'chk-2',
              spans: [
                { text: '确认核心更新语句命中联合索引，避免 ', emphasis: 'plain' },
                { text: 'type=ALL', emphasis: 'code', annotation_id: 'pit-lock' },
              ],
              checked: false,
            },
            {
              id: 'chk-3',
              spans: [
                { text: '核对客户端 ', emphasis: 'plain' },
                { text: 'maxLifetime', emphasis: 'code' },
                { text: ' 严格短于服务端超时 ', emphasis: 'plain' },
                { text: '60 s', emphasis: 'code' },
              ],
              checked: true,
            },
          ],
        },
        {
          type: 'table',
          table_kind: 'comparison',
          columns: ['对比方案', '核心原理', '适用场景', '局限性'],
          column_modes: ['nowrap', 'wrap', 'wrap', 'wrap'],
          rows: [
            [
              [{ text: '主动检索自测', emphasis: 'hl' }],
              [{ text: '合上笔记用实战问题提取记忆，及时暴露模糊边界' }],
              [{ text: '原理推演与参数取舍等重难点章节' }],
              [{ text: '过场章节无需强出题，需配间隔复习巩固' }],
            ],
            [
              [{ text: '重复通读划重点', emphasis: 'plain' }],
              [{ text: '单向浏览完整文本，容易产生已掌握错觉' }],
              [{ text: '仅用于初次快速扫读整体框架' }],
              [{ text: '长期留存率明显低于检索练习与二维对比表' }],
            ],
          ],
        },
      ],
      annotations: [
        {
          id: 'pit-lock',
          kind: 'pit',
          short_hint: '全表扫描更新会锁住整张表的间隙，并发直接雪崩',
          full_detail: 'InnoDB 在可重复读隔离级别下，若 UPDATE 的 WHERE 条件未命中索引，会退化为全表记录加锁，导致其他不相关行的写入请求也被阻塞。',
          timestamp: 2530,
          timestamp_label: '原片 42:10',
        },
      ],
      quiz: null,
    },
  ],
}
