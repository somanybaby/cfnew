# JavaScript 独立重写版

入口是 `src/worker.mjs`，不导入 `_worker.js`、`subscriptions/` 或 `rust-worker/`。原实现保留以便对照。协议依据公开格式重新实现；Trojan 的标准 SHA-224 使用固定版本的 `@noble/hashes`。用户已要求删除 `cfnew-best` 并停止部署，相关线上资源已移除，本地代码保留；过程见 [历史部署记录](./DEPLOYMENT_BEST.md)。

代码重构和混淆不能保证 Cloudflare 不识别该程序，也不能解除平台限制。本地测试验证程序行为，不验证线上账户状态、实际出口或联通网络速度。

## 与上一版的差异

| 项目 | 原内核及兼容层 | 本次 JavaScript 重写 |
| --- | --- | --- |
| 实现 | 上游单文件内核，或 Rust/Wasm 加 JS 订阅兼容层 | 分离的 JS 配置、协议、流、出站、订阅和路由模块 |
| 订阅 | 请求公共独立面板生成，再修改名称 | 在自己的 Worker 内生成，不把 UUID 交给公共面板 |
| 回退目标 | 含公共 ProxyIP 和地区回退来源 | 只使用明确配置的 `p`，没有隐含公共回退 |
| `qj=only` | 缺少有效代理时可能直连 | 缺少代理便拒绝连接；DNS over DoH 也不绕过此限制 |
| 失败重试 | 可能在初次转发后重新建立连接 | 只在建立连接失败时选择下一条路线；不重发已写入的应用数据 |
| 优选来源 | 内置域名、公共 IP 来源及在线列表 | 仅使用 `ena`、`yx`、明确填写的 `yxURL` |
| 地区命名 | 旧测量记录 | 独立的测量存储，绑定域名、版本、身份和出站设置，7 天后提示复测 |
| Loon 的 XHTTP | 可能生成 WS 兼容项 | Loon 输出只包含真实启用的 WS；没有可用协议则明确报错 |
| 配置存储 | KV 键 `c`、`c_ver` | 保留；不写入或继承旧出口测量键 |
| 界面 | 依赖独立面板 | 提供配置 API 和订阅；私有入口返回使用提示，没有移植完整面板 UI |

`wk`、`rm` 仍保存供迁移参考，但不再选择公共地区回退。`homepage`、`scu`、`ispMobile`、`ispUnicom`、`ispTelecom` 是保留字段，没有内置供应商列表可供其筛选。`jk=yes` 会明确拒绝生成链式订阅；此版本尚未实现家宽链式配置。没有实现通用 UDP、Shadowsocks、SSR、XHTTP `packet-up` 或 `stream-up`。

## 本地构建与测试

在仓库根目录运行：

```powershell
npm ci
npm run verify:rewrite
```

命令只执行本地单元测试、打包、workerd 转发测试和旧订阅回归测试，不包含部署、推送、域名管理或线上 KV 操作。测试使用虚构 UUID、临时本地 KV、本机 TCP 回显服务和本机模拟代理。

构建输出位于 `dist/rewrite-js/`：

| 文件 | 用途 |
| --- | --- |
| `worker.mjs` | 便于审阅的单文件 ES Module |
| `worker.min.mjs` | 压缩构建 |
| `worker.obfuscated.mjs` | 基于本次新实现的混淆构建，不含动态代码执行或反调试逻辑 |
| `manifest.json` | 三个文件的大小、SHA-256、源文件哈希和实际依赖图 |

构建会拒绝打包旧实现。混淆没有启用无用代码注入、反调试或控制流膨胀，避免徒增 Workers CPU 开销；混淆结果也执行相同的运行测试。

以上是标准混淆档。用户要求的高混淆档通过 `npm run verify:rewrite-strong` 构建和验证，单独输出至 `dist/rewrite-js-strong/`。高档启用 RC4 字符串数组、字符串拆分、多层包装、全局标识符重命名、控制流变换及少量无用代码注入；关闭反调试和动态代码执行，保留依赖许可声明。它增加代码体积和运行开销，不代表隐身或解除平台限制。验证命令本身仍不发布。生产配置 `wrangler.best.jsonc` 指向已经生成的高混淆文件，使用独立 KV；UUID 以服务器端 secret 保存，不写入配置文件。

Wrangler 配置仅作本地配置模板：KV ID 是占位值，没有账号、线上路由或真实 UUID。`worker-configuration.d.ts` 由 Wrangler 根据该模板生成，不用于存放生产身份。Miniflare 的旧版依赖继续服务原测试，新测试固定使用与当前 Wrangler 同代的 Miniflare 5 测试包及其官方 V4 配置转换函数。

如需本地交互调试，复制 `.dev.vars.example` 到 `.dev.vars`，换成新的测试 UUID，再执行：

```powershell
npx wrangler dev --local --config rewrite-js/wrangler.jsonc
```

这不是生产部署配置，不能直接用占位 KV ID 发布。

## 首次配置建议

手机先使用 VLESS WS 或 Trojan WS，电脑可以额外试 VLESS XHTTP。先保持少量入口，避免同一地址混合大量协议造成列表杂乱。可从下面的配置开始，待真实网络验证后再选优选地址：

```json
{
  "ena": "yes",
  "dkby": "yes",
  "ev": "yes",
  "et": "no",
  "ex": "no",
  "freeCpu": "no",
  "ech": "no"
}
```

这是兼容性优先的起点，不是已经测得的联通最优配置。`freeCpu=yes` 每条连接双向合计超过 384 KiB 或 96 块会断开，通常不适合下载或视频测速。

环境中必须自行设置 `u` 或 `U`。KV 绑定使用 `C` 或 `c`，配置优先级仍为 KV 覆盖 > 环境变量 > 默认值。UUID 不接受配置接口修改。没有 KV 可转发、读取配置和生成订阅，不能保存配置、管理优选或导入测量。

内置默认 `ena=no`，为兼容旧配置保留；本地 Wrangler 模板设置了 `ena=yes`。没有原生入口或可用优选时，订阅返回 503，并提示配置来源，不生成占位节点。`yx` 优先于 `yxURL`；最多读取 4 个 HTTPS 在线列表，每个最多 1 MiB，超时 8 秒。输出最多 256 个入口。IP/域名去重后，每个入口按 VLESS WS、Trojan WS、VLESS XHTTP 排列；IPv4/IPv6 开关在新版中筛选所有优选地址，原生域名不受其影响。

订阅只保留已知 Cloudflare HTTP/HTTPS 入口端口，`dkby=yes` 进一步只保留 HTTPS。Trojan 与 XHTTP 订阅只生成 TLS 节点。TLS SNI 和 WS Host 始终使用当前 Worker 域名；不要用入口 IP 替代。

## 配置与订阅接口

`<入口>` 是 UUID 或配置 `d`。支持区分大小写的多级和中文 `d`。以下接口均在自己的 Worker 域名上：

| 方法、路径 | 用途 |
| --- | --- |
| `GET /` | `hello` 健康检查，不代表已鉴权或可正常出站 |
| `GET /<入口>/api/config` | 有效配置、UUID、KV 状态和实现版本 |
| `POST /<入口>/api/config` | 配置局部更新；空字符串或 `null` 撤销覆盖 |
| `GET /<入口>/api/preferred-ips` | 优选列表 |
| `POST /<入口>/api/preferred-ips` | 添加单个对象或对象数组，去重 |
| `DELETE /<入口>/api/preferred-ips` | 删除 `{ip,port}`，或 `{all:true}` 清空 |
| `GET /<入口>/region` | 配置地区偏好；明确不代表实际出口 |
| `GET /<入口>/test-api` | 配置入口可达性 |
| `GET /<入口>/sub?target=clash` | Clash Verge / Mihomo 配置，JSON 形式的有效 YAML |
| `GET /<入口>/sub?target=loon` | Loon 完整配置，WS 节点 |
| `GET /<入口>/sub?target=base64` | 小火箭 / v2rayN 等使用的 Base64 分享链接列表 |
| `GET /<入口>/sub?target=uri` | 明文分享链接列表 |
| `GET /sub?uuid=<UUID>&target=...` | UUID 查询参数兼容入口 |

优选管理要求先把 `ae=yes` 保存到 KV，只有环境变量不足以开启。错误端口、无效 JSON、未知配置键会拒绝；配置体最多 1 MiB，`yx` 最多 262144 字符，其余单字段最多 16384 字符。KV 不提供读改写事务；同时保存配置可能相互覆盖，应串行操作。此版不复用跨请求的配置缓存，KV 本身的跨地区传播仍可能延迟。

WS 支持非空有效的 `p`、`s`、`wk`、`rm` 查询覆盖，不写回 KV；`wk`、`rm` 仅兼容保存含义。支持 URL 编码的 SOCKS5/HTTP/HTTPS 代理凭据。`qj` 为空时优先代理，`no` 先直连，`only` 只走代理。未设置 `p` 时没有公共回退。

## 按真实出口命名

节点默认形如 `出口待测 | 原生-001 | VLESS-WS`。只有通过对应节点实际访问出口查询服务所得的结果，才应该写入出口标签；入口 IP 属地、Worker 执行地区和客户端本机 IP 都不能替代该结果。

1. `GET /<入口>/api/exit-labels` 取得当前 `scope`。
2. 使用每个节点实测出口 IP、国家及城市，记录测量时间。
3. 把结果 POST 到同一接口，结构如下。示例地址和结果都是文档占位值，不是真实测量。

```json
{
  "scope": "替换成 GET 返回的 scope",
  "records": {
    "vless|ws|worker.example|443": {
      "countryCode": "JP",
      "city": "Tokyo",
      "exitIp": "203.0.113.7",
      "measuredAt": 1793577600000
    }
  }
}
```

`measuredAt` 是毫秒时间戳，提交时须处于最近 7 天，最多允许 5 分钟时钟偏差。写入会替换本版标签集；协议和传输分别测量，不能把一条 WS 的结果套到 XHTTP。更换域名、身份、版本、密码、出站代理、回退或协议开关后，旧记录不再生效。新键为 `subscription_exit_labels_js_v1`，不会把上一实现的出口记录当作本次结果。7 天只是显示有效期，CF 动态出口仍可能在有效期内变化。

部署不会自动把测试数据当作出口测量；没有实测结果时，新实现仍显示“出口待测”，不把文档或单元测试中的国家写入线上。

## 兼容范围和验证边界

VLESS WS / Trojan WS 支持分片首包、早期数据、IPv4/域名/IPv6 目标、SOCKS5 用户名密码和 HTTP CONNECT Basic 认证。VLESS UDP 只支持 DNS 53，查询通过 `customDNS` 的 HTTPS DoH 发送；`qj=only` 下拒绝这种直发 DNS，避免绕过代理约束。XHTTP 为 VLESS `stream-one` TCP，支持上传与下载同时持续、取消后关闭 TCP。

WS 输入队列最多 1 MiB 或 256 帧；配置、协议头、代理响应头、DNS 和在线来源均有长度限制。TCP 写入和 XHTTP 响应按流背压处理。Workers WebSocket 的 `send()` 没有可等待的背压接口，不能据此承诺无限期慢速接收端的内存恒定。

ECH 会生成分享链接参数及 Mihomo `ech-opts`；Loon 的 ECH 格式未验证，开启 ECH 时 Loon 输出明确报错，避免静默生成不完整设置。Clash 的 XHTTP 要求客户端使用支持该传输的 Mihomo 内核。这里只验证生成字段和本地服务端行为，没有宣称已在用户手机、真实 TLS 代理、真实 CF 平台或联通网络验证。

格式依据：[Mihomo 传输配置](https://wiki.metacubex.one/en/config/proxies/transport/)、[Mihomo TLS 配置](https://wiki.metacubex.one/en/config/proxies/tls/)、[Loon 节点格式](https://nsloon.app/en/docs/Node/)、[Workers TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)。
