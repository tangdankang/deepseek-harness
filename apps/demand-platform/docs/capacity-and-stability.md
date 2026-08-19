# 3000人规模容量与稳定性测试

## 两种负载模型

容量工具支持两种模型：

- `CLOSED_LOOP_MAX_THROUGHPUT`：并发工作线程完成请求后立即发送下一请求，用于寻找当前拓扑的相对吞吐上限。
- `OPEN_LOOP_SCHEDULED_RATE`：按`--target-rps`预定请求到达时间，用于模拟固定到达率，并报告P50/P95/P99/最大调度滞后。

生产验收应以开放式模型为主，闭环模型仅用于摸底。3000名员工不等于3000并发请求，真实目标RPS必须根据钉钉入口日志、峰值窗口和业务增长系数确定。

## 默认场景

- 3000个虚拟员工、30个虚拟部门；
- 300个预热请求、9000个测量请求；
- 100并发；
- 员工上下文、服务目录搜索、知识搜索三种DEAP只读工具循环；
- 每次调用使用唯一调用编号和独立签名身份；
- 不创建业务需求或下游工单，但会生成技术调用审计。

## 远程安全门禁

远程容量测试只允许HTTPS，并且必须同时提供：

- `--allow-remote-load`：明确允许向远程目标施加负载；
- `--confirm-approved-window`：确认已经取得测试窗口审批。

缺少任一参数均拒绝执行。实际凭据只从环境变量读取。

## 示例

```powershell
$env:TOOL_API_KEY='<通过公司密钥系统注入>'
$env:IDENTITY_HMAC_SECRET='<通过公司密钥系统注入>'
node scripts/run-capacity-test.mjs `
  --base-url https://capacity-ai-demand.example.internal `
  --allow-remote-load --confirm-approved-window `
  --virtual-employees 3000 --departments 30 `
  --requests 9000 --warmup-requests 300 `
  --concurrency 100 --target-rps 300 `
  --thresholds-file config/capacity-thresholds.example.json `
  --output-json approved/capacity-report.json `
  --output-markdown approved/capacity-report.md
```

## 九项门禁

错误率、P95、P99、最小吞吐、负载生成进程事件循环P99、Heap增长、RSS增长、429比例和请求调度滞后P95。阈值示例不是公司生产SLO，必须由架构、运维和业务Owner确认后冻结。

## 观测边界

远程运行时，Node进程的事件循环和内存指标属于负载生成器，不属于服务端。生产容量结论还必须联合采集：

- 网关吞吐、排队、连接数、429/5xx；
- 应用实例CPU、内存、事件循环、GC、线程/连接池；
- 数据库CPU、IOPS、锁等待、连接数、慢查询、WAL和复制延迟；
- Outbox积压、重试、死信和下游延迟；
- DEAP/钉钉平台限流及真实网络时延。

## 生产测试阶段

1. 本地基准：验证脚本和相对性能，不作生产结论。
2. 等价测试环境开放式负载：按真实峰值RPS运行至少30分钟。
3. 阶梯增压：逐级提高到出现SLO拐点，确定安全容量，不在生产环境摸底。
4. 稳态浸泡：以安全容量的60%至70%运行至少4小时，观察内存、连接、队列和数据库增长。
5. 故障测试：单实例退出、数据库切换、下游超时和限流，验证降级、恢复及不重复建单。

当前SQLite只允许本地/单节点试点。正式3000人生产容量测试必须使用公司标准高可用数据库和等价部署拓扑。
