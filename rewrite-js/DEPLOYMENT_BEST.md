# best.176278.xyz 高混淆版发布记录

**当前状态：用户已要求删除并停止部署。** 2026-11-02 已删除 `cfnew-best` Worker，解除 `best.176278.xyz` 的 Custom Domain 绑定并移除对应 Worker 路由；随后通过 API 列表核实三者均已移除。KV 配置和本地代码保留，其他 Worker 未改动。用户重新明确授权前，不得再次部署。下方为历史发布及排查记录。

2026-11-02，用户明确授权部署到 `best.176278.xyz`，并要求高混淆。本次已完成代码上传和域名配置，但线上请求仍返回 Cloudflare `1101`，不能视为可用服务。

## 已发布内容

| 项目 | 值 |
| --- | --- |
| Worker | `cfnew-best` |
| 域名 | `best.176278.xyz` |
| 最终 deployment ID | `c4563ca428ec4ded9f5acb87e396bb45` |
| 最终恢复时间 | `2026-11-02T13:38:14.136772Z` |
| 上传文件 | `dist/rewrite-js-strong/worker.obfuscated.mjs` |
| 文件大小 | 406341 字节 |
| SHA-256 | `a0d014a29238c9a55791b6b2b3d6bb5b50dfa9f72c8259ea4e51f68211ba4934` |
| Cloudflare 最终报告的启动耗时 | 36 毫秒 |
| KV | 独立命名空间 `cfnew-best-config`，绑定 `C` |
| UUID | 沿用原身份，改为 `secret_text` 绑定 `u`，不写入仓库 |
| TLS 证书 | 已签发，状态 `active` |
| workers.dev / Preview | 临时诊断结束后均关闭 |

高混淆档启用 RC4 字符串数组、字符串拆分与包装、标识符改名、控制流变换和少量无用代码注入；关闭反调试、动态代码执行和 source map。构建不导入旧 JS 内核、Rust 核心或旧订阅层。上传前在 Cloudflare 执行工具内再次校验了源文件 SHA-256。

最终又从 Cloudflare 下载线上脚本，校验得到相同的 406341 字节和 SHA-256，确认线上已经恢复为本次高混淆构建。临时日志会话均已删除，最终剩余 0 个。

本地验证命令为 `npm run verify:rewrite-strong`：23 项单元/API 测试、三种构建各 11 项 workerd 运行测试、10 项旧订阅回归测试通过。高混淆版本自身执行了全部 11 项运行测试。

## 配置和路由

创建独立 KV，复制原配置后设定 `ena=yes`、`ev=yes`、`et=yes`、`ex=yes`、`dkby=yes`、`freeCpu=no`。原配置的 ECH 已在新 KV 中设为 `no`，避免新版 Loon ECH 未验证导致订阅拒绝生成；原 Worker 的 KV 没有改动。

先配置 Custom Domain，让 Cloudflare 管理 DNS 和证书。证书签发后首次访问返回 522；随后增加仅匹配 `best.176278.xyz/*` 的 Worker 路由，访问改为 HTTP 500、正文 `error code: 1101`。其他域名和 Worker 未更改。

生产配置模板见 `wrangler.best.jsonc`。构建、校验命令不会自动发布，GitHub 也没有推送。

## 最小程序对照

为区分业务代码和平台执行问题，曾在**同一个 Worker** 上短暂发布下面的无混淆、无代理逻辑程序，保留原绑定：

```javascript
export default {
  fetch() {
    return new Response('diagnostic-ok', {
      headers: { 'cache-control': 'no-store' }
    });
  }
};
```

Cloudflare 接受该程序，报告启动耗时 2 毫秒。在部署后即时和等待 20 秒后，分别访问自定义域名与临时开启的 `cfnew-best.somanybaby.workers.dev`：四次均返回 HTTP 500、`error code: 1101`。测试结束后已经恢复上表对应的高混淆文件，关闭临时 workers.dev 入口。

这项结果表明本次失败也影响最小响应程序，不能据此认定是高混淆版的代理逻辑错误；同样不能单凭它认定整个账号被封。确切的平台处理原因还需要 Cloudflare 核查。可供排查的一次请求 Ray ID：`a54385491e1b2f47-LAX`。

恢复高混淆版后重新连接实时 Tail，用浏览器 User-Agent 请求主页得到 HTTP 500；15 秒观察期间没有收到执行事件。最终再次访问仍为 `1101`。这只是当前观测结果，不是对 Cloudflare 内部限制原因的判定。

由于线上未正常执行，配置接口、线上订阅、真实代理出口及速度均未验证通过，没有生成或写入新的真实出口地区。增加混淆强度不构成规避识别或恢复服务的保证。
