# 按实测出口整理订阅

此目录是 `byJoey/cfnew` 精简内核的可选订阅整理层。`../_worker.js` 保持上游原样；部署入口改用 `subscriptions/worker.mjs` 后，原代理流量、配置 API、UUID 和 KV 继续由原内核处理。

订阅仍由原独立面板 `https://cfnew.xy.kg/` 生成，本层只修改名称和排列顺序。保留项目来源，不将本功能称为独立原创内核。

## 使用

```text
https://你的Worker域名/你的UUID/sub?target=clash
https://你的Worker域名/你的UUID/sub?target=loon
https://你的Worker域名/你的UUID/sub?target=base64
```

- Clash Verge 使用 `clash`。
- Loon 使用 `loon`。
- Shadowrocket / 小火箭、v2rayN 使用 `base64`。
- 也接受 `/sub?uuid=你的UUID&target=clash`。从公共面板的原订阅迁移时，把域名换成自己的 Worker 域名，其余查询参数可以保留；旧 `host` 参数会被忽略。
- 不带 `target` 时按 Loon / Clash User-Agent 识别，其余返回 Base64。

命名示例：`美国·洛杉矶〔实测〕｜联通｜01｜VLESS-WS`。

同一线路中的相同入口使用相同编号；同一入口的不同协议分别显示。实测成功的节点排在前面，未测成功的显示 `出口待测`。不会根据 IP 注册地、入口机房、域名或其他协议的测试结果推断出口。

Clash / Loon 上游将 XHTTP 来源转换为 WebSocket 的条目标为 `VLESS-WS兼容`，不误称 XHTTP，且独立测试其实际 WS 路径。保留其原有连接参数。节点数、凭据、Host / SNI、端口、路径、路由规则均保留；代理组内的节点名称同步更新。

## 测量实际出口

从要使用的网络运行测量脚本。脚本逐一通过每个入口的 VLESS WS、Trojan WS 或 XHTTP，向 `ipwho.is` 发起 HTTPS 请求，取得该连接的公网出口 IP、国家和城市；两层 TLS 都校验证书。失败时不生成地区记录。

```bash
python -m pip install websockets certifi h2
python scripts/probe-exits.py --subscription-file 私有原始订阅.txt --output 私有出口记录.json
```

输入是原面板 `target=base64` 的完整响应。文件含访问凭据，应保存在仓库之外。脚本仅输出进度、协议和国家，不输出密码、UUID 或完整订阅链接。

使用原 UUID 将结果以 JSON POST 到：

```text
https://你的Worker域名/你的UUID/api/exit-labels
Content-Type: application/json
```

GET 同一路径可读取记录；POST 替换整份记录。结果存于原 `C` / `c` KV 的独立键 `subscription_exit_labels_v1`，不改写内核配置 `c`。提交需要原 UUID 鉴权，并限制体积及字段。

这些标签是**测量网络、测量时间和具体协议**下的结果，不保证国内联通、手机蜂窝或其他网络会得到相同地区。7 天后显示 `出口待复测`，重新运行脚本并上传即可恢复标签。测试超时或 XHTTP 403 不代表其他网络必然不可用。

订阅处理失败时返回非 200 状态，客户端可保留上一份有效订阅。所有响应禁止公共缓存；错误消息不包含上游 URL 和凭据。

## 部署和回退

推荐先构建单文件混淆版，输出可直接粘贴到 Worker 编辑器的 `dist/_worker.js`：

```bash
npm ci
npm test
npm run build:readable
npm run test:bundle
npm run test:runtime
```

构建先打包为 ES Module，再混淆标识符和字符串。禁用动态代码生成、自防护、调试干扰、控制流平坦化和死代码注入；保留 Workers 需要的静态 import/export 与 `fetch` 属性。`dist/SHA256SUMS.txt` 提供校验值。混淆版通过禁止动态代码生成的隔离运行测试，验证首页、配置鉴权和订阅改名；另在 Miniflare / workerd 中使用 KV 重复验证首页和配置接口。

开发调试也可使用 ES Module 多文件部署，入口 `subscriptions/worker.mjs`。需要同时包含以下模块（Wrangler 可自动打包这些本地 import）：

```text
_worker.js
subscriptions/worker.mjs
subscriptions/handler.mjs
subscriptions/rename.mjs
```

保留原 `u` / `U`、`C` / `c` 及兼容日期 `2026-01-20`。不需要新增秘密或第三方订阅服务。原面板仍参与订阅生成，仍能接触原先的配置凭据。

恢复先前 Worker 版本即可撤销整理层，或者重新部署上游原 `_worker.js`。独立标签键不会影响原内核；原面板订阅地址也仍然可用。

## 验证

```bash
node --test subscriptions/rename.test.mjs
```

测试覆盖改名前后连接参数一致、组引用同步、协议标签、出口标签过期、UUID 鉴权、独立 KV 写入、请求大小限制及错误凭据隐藏。
