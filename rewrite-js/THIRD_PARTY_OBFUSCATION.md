# 第三方网页混淆记录

2026-11-02，按用户要求停止部署，通过真实浏览器使用 [Obfuscator.io 标准混淆器](https://obfuscator.io/legacy-playground) 处理本次独立 JavaScript 重写版，点击网页“混淆”，从网页“下载”按钮保存结果。本次没有创建 Worker，没有部署，没有推送 GitHub，也没有启用付费功能。

## 后续操作约束

- 继续停止部署，用户重新明确授权之前不得发布。
- 如用户以后重新授权部署，Worker 名称使用 Cloudflare 控制台自动提供的随机名称，不能包含 `CFNEW`，大小写均适用。
- 不得为了提前获取名称而创建 Worker；历史配置文件中的旧名称仅供记录，不能直接用于重新部署。

## 实际使用的服务

网站免费标准版在浏览器内执行混淆。它使用 `javascript-obfuscator` 算法家族，与此前本地工具属于同一系列；本次确实操作了第三方网页，但不能把结果描述成另一种独立算法或第三方服务器加密。网站上的付费 VM 字节码功能没有使用，也没有绕过其权限限制。

参考：[网站标准版说明](https://obfuscator.io/legacy-playground)、[网站对代码处理方式的说明](https://obfuscator.io/)。

输入是未混淆的独立 JS 单文件构建 `dist/rewrite-js/worker.mjs`，57631 字节，SHA-256 为 `24390b06f3cd0322097e9704679a6ba00abfd34c3163f8264562bb49a74627cf`。处理前检查了输入不含实际 UUID；下载后也核对原始结果和可用副本均不含实际 UUID。没有向页面提供账号令牌、KV 内容、真实订阅地址或出站凭据。

## 网页选项

| 选项 | 设置 |
| --- | --- |
| Target | Browser No Eval |
| Seed | 20261103 |
| Compact / Simplify | 开启 |
| Rename Globals | 开启 |
| Rename Properties | 关闭，保留平台 API 属性 |
| String Array | 开启，Threshold 1 |
| Encoding | 网页多选保留了 None，并选中 RC4，即混合明文/RC4 字符串数组 |
| Rotate / Shuffle / Index Shift | 开启 |
| Calls Transform | 开启，Threshold 0.5 |
| Wrappers Count / Type | 3 / Variable |
| Wrappers Chained Calls | 开启 |
| Split Strings | 开启，Chunk Length 4 |
| Transform Object Keys / Numbers To Expressions | 开启 |
| Control Flow Flattening | 开启，Threshold 0.3 |
| Dead Code Injection | 开启，Threshold 0.1 |
| Self Defending / Debug Protection / Source Map | 关闭 |
| Domain Lock | 未设置 |

## 保存的文件

以下文件均位于本地仓库工作目录，生成物不纳入 Git：

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `output/playwright/obfuscator-io/worker.website.raw.mjs` | 245604 | `c4b14cb373aecf9a2c5d6937293bb05c44a1554214cb9193ec207468f09a309a` |
| `dist/rewrite-js-website/worker.obfuscated.mjs` | 246761 | `582d357635c1eef73e7b31c319de9a40b87574c5125080957d5e800ff7280e0a` |

原始下载保持逐字节不变。网站删除了依赖的许可证注释，所以可用副本仅在开头补回 `@noble/hashes` 的 MIT 许可说明，没有再次混淆或改写代码。网页结果截图保存在 `output/playwright/obfuscator-io/result.png`，输入、下载、可用副本的哈希与验证结果保存在 `dist/rewrite-js-website/manifest.json`。

## 本地验证

执行 `npm run verify:website-artifact` 返回 0。通过 JavaScript 语法检查、禁止动态代码执行的静态检查，以及 11 项真实 workerd 本地运行测试：配置和订阅、错误身份拒绝、VLESS/Trojan 分片双向 TCP、早期数据、SOCKS5/HTTP CONNECT、代理限定模式、预算保护、XHTTP 持续双向流和取消后清理。

这些测试没有连接 Cloudflare 账号或真实代理出口，没有做线上可用性测试。更换名称和混淆方式不保证解除 Cloudflare 限制。
