# 代码归档（2026-11-02）

后续更新：用户之后授权测试上游原版，并要求遇到 1101/522 删除部署；本次 Worker 和 Pages 已清理，见[测试及清理记录](../../UPSTREAM_CONTROL.md)。下文是归档时的历史快照。

按用户要求保存源码与已生成的网页混淆文件，仅作归档。本次仓库上传不部署，也不修改 Cloudflare 资源。

- `worker.readable.mjs`：独立 JavaScript 重写版的可读单文件构建。
- `worker.obfuscated.mjs`：此前实际上传的网页混淆版，保留依赖许可声明。
- `worker.website.raw.mjs`：第三方网页的原始下载，未补许可注释，保留供核对；使用带许可的副本。
- `manifest.json`：文件大小、SHA-256 和最后一次部署结果。

可维护的源码在 [src](../../src/)，配置与协议说明见 [README](../../README.md)。凭据需要独立配置，归档不包含实际 UUID、API 令牌或订阅链接。

此前本地 workerd 的 11 项运行测试通过。最后一次部署到 `few.176278.xyz` 的主页返回 HTTP 500 / `1101`，线上不可用；没有足够证据确认根因是代码识别、账户限制或监控。用户随后要求停止，未继续测试，未删除此次 Worker。更换账号或混淆不保证可用。

可在仓库根目录核对文件：

```powershell
node --check rewrite-js/archive/2026-11-02/worker.obfuscated.mjs
Get-FileHash rewrite-js/archive/2026-11-02/worker.obfuscated.mjs -Algorithm SHA256
```

如需复核网页结果的既有本地运行测试，可在安装依赖后执行以下命令；此命令不部署：

```powershell
npm ci
$env:CFNEW_REWRITE_DIST = 'rewrite-js/archive/2026-11-02'
$env:CFNEW_REWRITE_ARTIFACT = 'worker.obfuscated.mjs'
node --test rewrite-js/test/runtime.integration.mjs
Remove-Item Env:CFNEW_REWRITE_DIST, Env:CFNEW_REWRITE_ARTIFACT
```
