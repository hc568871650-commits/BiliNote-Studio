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
    {
      id: 'sec-3',
      title: '索引设计与最左前缀原则',
      level: 2,
      time_ranges: [{ start: 2740, end: 3120, label: '45:40' }],
      core_takeaways: [
        {
          spans: [
            { text: '联合索引把等值列放最前、范围列放最后', emphasis: 'hl', annotation_id: 'why-idx' },
            { text: '：只要中间出现 ', emphasis: 'plain' },
            { text: '>', emphasis: 'code' },
            { text: ' 或 ', emphasis: 'plain' },
            { text: 'BETWEEN', emphasis: 'code' },
            { text: '，后续列就会退出索引有序查找。', emphasis: 'plain' },
          ],
        },
      ],
      blocks: [
        {
          type: 'paragraph',
          spans: [
            { text: '对高频查询优先建立覆盖索引，', emphasis: 'plain' },
            { text: '避免在索引列上套用函数或隐式类型转换', emphasis: 'wave', annotation_id: 'pit-idx' },
            { text: '，否则优化器会直接放弃 B+ 树检索。', emphasis: 'plain' },
          ],
        },
        {
          type: 'table',
          table_kind: 'comparison',
          columns: ['写法示例', '是否命中索引', '底层原因'],
          column_modes: ['nowrap', 'nowrap', 'wrap'],
          rows: [
            [
              [{ text: 'created_at >= ?', emphasis: 'code' }],
              [{ text: '命中范围扫描', emphasis: 'hl' }],
              [{ text: '保持列原值参与比较，B+ 树可直接二分定位起点' }],
            ],
            [
              [{ text: 'DATE(created_at) = ?', emphasis: 'code' }],
              [{ text: '索引失效', emphasis: 'plain' }],
              [{ text: '函数破坏了索引键的有序性，被迫退化为全索引/全表扫描' }],
            ],
          ],
        },
      ],
      annotations: [
        {
          id: 'why-idx',
          kind: 'why',
          short_hint: 'B+ 树按第一列全局有序，第二列仅在第一列相等时有序',
          full_detail: '联合索引 (a, b, c) 在叶子节点先按 a 排序，a 相同时再按 b 排序；一旦 a 走了范围条件，对应区间的 b 不再全局有序，因此无法继续利用二分查找。',
          timestamp: 2810,
          timestamp_label: '原片 46:50',
        },
        {
          id: 'pit-idx',
          kind: 'pit',
          short_hint: '字符串列传数字会触发隐式 CAST 导致索引失效',
          full_detail: '例如手机号列为 VARCHAR 时写 WHERE phone = 13800138000，MySQL 会把每行字符串转成浮点数比较，相当于在列上套了函数。',
          timestamp: 3015,
          timestamp_label: '原片 50:15',
        },
      ],
      quiz: null,
    },
    {
      id: 'sec-3-1',
      title: '覆盖索引与回表代价权衡',
      level: 3,
      time_ranges: [{ start: 3120, end: 3340, label: '52:00' }],
      core_takeaways: [
        {
          spans: [
            { text: '把高频列表页所需字段收进联合索引可消除随机回表 IO', emphasis: 'ul' },
            { text: '，但单表二级索引总数建议控制在 ', emphasis: 'plain' },
            { text: '5 个以内', emphasis: 'code' },
            { text: ' 以防写入放大。', emphasis: 'plain' },
          ],
        },
      ],
      blocks: [
        {
          type: 'paragraph',
          spans: [
            { text: '当 ', emphasis: 'plain' },
            { text: 'EXPLAIN', emphasis: 'code' },
            { text: ' 的 Extra 列出现 ', emphasis: 'plain' },
            { text: 'Using index', emphasis: 'code' },
            { text: ' 时，说明查询仅靠二级索引页就完成了全部字段返回，无需二次查聚簇索引。', emphasis: 'plain' },
          ],
        },
      ],
      annotations: [],
      quiz: null,
    },
    {
      id: 'sec-4',
      title: '事务隔离级别与 MVCC 快照读',
      level: 2,
      time_ranges: [{ start: 3420, end: 3900, label: '57:00' }],
      core_takeaways: [
        {
          spans: [
            { text: '长事务会拖住 Undo Log 无法回收', emphasis: 'hl', annotation_id: 'why-mvcc' },
            { text: '：并发读写下既撑爆表空间，又会拉长普通快照读的版本链遍历耗时。', emphasis: 'plain' },
          ],
        },
      ],
      blocks: [
        {
          type: 'paragraph',
          spans: [
            { text: '严禁在数据库事务内调用外部 HTTP 接口或等待用户输入', emphasis: 'wave' },
            { text: '；先在事务外准备完所有外部数据，再以最短路径完成加锁与提交。', emphasis: 'plain' },
          ],
        },
      ],
      annotations: [
        {
          id: 'why-mvcc',
          kind: 'why',
          short_hint: '最早未提交事务决定整个系统的 ReadView 水位',
          full_detail: 'InnoDB 的 Purge 线程只能清理早于最老活跃事务 ID 的历史版本。哪怕只是一个忘记提交的只读事务，也会让全库千万级变更历史滞留在 Undo 表空间中。',
          timestamp: 3600,
          timestamp_label: '原片 60:00',
        },
      ],
      quiz: {
        short_prompt: '事务里顺手调个第三方支付查询接口会怎样？',
        full_question: '在开启数据库事务后、提交前顺手调用一个耗时 2 秒的外部 HTTP 接口，最大的隐患是什么？',
        options: [
          { key: 'A', text: '外部接口失败会自动回滚远端状态，属于推荐写法' },
          { key: 'B', text: '连接和行锁被白白占用 2 秒，高并发下迅速打满连接池并阻塞其他写入' },
          { key: 'C', text: '仅会多耗一点内存，对并发吞吐没有影响' },
        ],
        correct_key: 'B',
        explanation: '事务期间数据库连接与已持有的行锁都不会释放；把网络 IO 放进事务会把毫秒级锁持有拉长成秒级，直接引发雪崩。',
      },
    },
    {
      id: 'sec-5',
      title: '缓存穿透、击穿与雪崩治理',
      level: 2,
      time_ranges: [{ start: 3960, end: 4440, label: '66:00' }],
      core_takeaways: [
        {
          spans: [
            { text: '缓存失效治理的核心是把突发回源请求削平为单飞回源', emphasis: 'hl' },
            { text: '：空值短缓存挡穿透，互斥锁/逻辑过期挡击穿，随机 TTL 抖动挡雪崩。', emphasis: 'plain' },
          ],
        },
      ],
      blocks: [
        {
          type: 'flow_chain',
          steps: [
            [{ text: '布隆过滤器拦截非法 ID', emphasis: 'plain' }],
            [{ text: '热点 Key 采用 ', emphasis: 'plain' }, { text: 'singleflight', emphasis: 'code' }, { text: ' 合并回源', emphasis: 'plain' }],
            [{ text: 'TTL 叠加 ', emphasis: 'plain' }, { text: '±15%', emphasis: 'code' }, { text: ' 随机抖动', emphasis: 'plain' }],
          ],
        },
        {
          type: 'table',
          table_kind: 'comparison',
          columns: ['故障形态', '典型诱因', '首选防线'],
          column_modes: ['nowrap', 'wrap', 'wrap'],
          rows: [
            [
              [{ text: '缓存穿透', emphasis: 'code' }],
              [{ text: '恶意或异常查询大量根本不存在的主键' }],
              [{ text: '短 TTL 空对象缓存 + 参数校验 / 布隆过滤器' }],
            ],
            [
              [{ text: '缓存击穿', emphasis: 'code' }],
              [{ text: '单个超高并发热点 Key 突然到期' }],
              [{ text: '逻辑过期异步重建或单机/分布式互斥回源' }],
            ],
            [
              [{ text: '缓存雪崩', emphasis: 'code' }],
              [{ text: '大批量 Key 同一秒集中过期或缓存节点宕机' }],
              [{ text: '随机 TTL 打散过期时间 + 多级本地缓存兜底' }],
            ],
          ],
        },
      ],
      annotations: [],
      quiz: null,
    },
    {
      id: 'sec-6',
      title: '读写分离与主从延迟应对',
      level: 2,
      time_ranges: [{ start: 4500, end: 4920, label: '75:00' }],
      core_takeaways: [
        {
          spans: [
            { text: '写后立刻读的场景必须强制路由主库', emphasis: 'hl', annotation_id: 'case-repl' },
            { text: '：不要假设只读副本能在毫秒内完成 Binlog 回放。', emphasis: 'plain' },
          ],
        },
      ],
      blocks: [
        {
          type: 'paragraph',
          spans: [
            { text: '把业务读请求划分为', emphasis: 'plain' },
            { text: '强一致读（走主库）', emphasis: 'ul' },
            { text: '与', emphasis: 'plain' },
            { text: '最终一致读（走从库）', emphasis: 'ul' },
            { text: '，并在大批量数据订正时限速分批写入，防止主从延迟被拉大到数十秒。', emphasis: 'plain' },
          ],
        },
      ],
      annotations: [
        {
          id: 'case-repl',
          kind: 'case',
          short_hint: '用户刚改完配置立刻刷新页面却看到旧值',
          full_detail: '大促期间主库写入峰值为平时的 6 倍，只读副本出现 1.8 秒同步延迟；用户提交设置后前端立即发 GET 请求落到从库，导致误以为保存失败并重复提交。',
          timestamp: 4680,
          timestamp_label: '原片 78:00',
        },
      ],
      quiz: null,
    },
    {
      id: 'sec-7',
      title: '连接泄漏定位与全链路观测',
      level: 2,
      time_ranges: [{ start: 4980, end: 5340, label: '83:00' }],
      core_takeaways: [
        {
          spans: [
            { text: '监控活跃连接占比与等待线程数比只看 CPU 更早预警', emphasis: 'hl' },
            { text: '：当 ', emphasis: 'plain' },
            { text: 'active / max > 80%', emphasis: 'code' },
            { text: ' 持续 1 分钟时就应立刻触发告警。', emphasis: 'plain' },
          ],
        },
      ],
      blocks: [
        {
          type: 'flow_chain',
          steps: [
            [{ text: '开启 ', emphasis: 'plain' }, { text: 'leakDetectionThreshold', emphasis: 'code' }],
            [{ text: '捕获未归还连接的调用栈', emphasis: 'plain' }],
            [{ text: '收敛流式游标与异常分支的 ', emphasis: 'plain' }, { text: 'finally', emphasis: 'code' }, { text: ' 释放', emphasis: 'plain' }],
          ],
        },
      ],
      annotations: [],
      quiz: null,
    },
    {
      id: 'sec-8',
      title: '压测验收与容量规划清单',
      level: 2,
      time_ranges: [{ start: 5400, end: 5760, label: '90:00' }],
      core_takeaways: [
        {
          spans: [
            { text: '压测只看平均延迟极具欺骗性', emphasis: 'hl' },
            { text: '：验收基线必须同时盯住 ', emphasis: 'plain' },
            { text: 'P95 / P99', emphasis: 'code' },
            { text: ' 尾延迟与错误率曲线。', emphasis: 'plain' },
          ],
        },
      ],
      blocks: [
        {
          type: 'checklist',
          title: '发布前压测验收核对',
          items: [
            {
              id: 'chk-perf-1',
              spans: [
                { text: '核心接口在 2 倍峰值 QPS 下 ', emphasis: 'plain' },
                { text: 'P99 < 120 ms', emphasis: 'code' },
                { text: ' 且无连接池等待堆积', emphasis: 'plain' },
              ],
              checked: false,
            },
            {
              id: 'chk-perf-2',
              spans: [
                { text: '模拟单节点缓存失效后，回源 QPS 稳定可控、不触发数据库满载', emphasis: 'plain' },
              ],
              checked: false,
            },
            {
              id: 'chk-perf-3',
              spans: [
                { text: '已配置慢查询、锁等待与连接池饱和度三级告警阈值', emphasis: 'plain' },
              ],
              checked: true,
            },
          ],
        },
      ],
      annotations: [],
      quiz: null,
    },
  ],
}
