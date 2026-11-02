# Rust/Wasm 代理核心

此实现把协议解析、鉴权、配置接口和 TCP/UDP DNS 转发改写为 Rust，编译为 WebAssembly。构建不导入旧 `_worker.js`。Workers SDK 的 JavaScript 绑定及现有订阅格式/出口命名层继续使用 JavaScript；这些胶水代码在打包后重新混淆。

当前为开发验证版本：线上验证未通过，部署尝试已暂停，先在仓库内维护和验证代码。

## 支持范围

- VLESS over WebSocket、Trojan over WebSocket、VLESS XHTTP stream-one。
- 处理分片协议头、WebSocket early data、IPv4/IPv6/域名目标；鉴权失败关闭连接。
- VLESS UDP 仅允许 DNS 53，使用 DoH 转发；其余 UDP 拒绝。
- TCP 直连、显式 ProxyIP、区域回退、SOCKS5 和 HTTP/HTTPS CONNECT 出站。
- 保留 `u`/`U`、`C`/`c`、配置优先级及现有配置键。`c`、`c_ver` 的存储方式兼容，UUID 仍只从 Worker 环境读取。
- 读取/更新配置、地区信息、API 连通检查、优选地址管理；订阅和实测出口命名复用现有兼容层。
- 保留 Free CPU 字节/块预算，连接结束时关闭出站 socket。预算不能保证平台 CPU 配额一定不超限。

Rust 实现不是对 JavaScript 的逐字翻译：流式缓冲、关闭时机及回退行为应以本实现测试为准，尤其不承诺复现旧版所有零字节响应后的自动重试策略。修改核心后，应重新实测订阅节点的出口；旧测量结果不能作为新核心的出口保证。

## 构建

准备 Rust stable、`wasm32-unknown-unknown` 目标、Node.js，以及固定版本 `worker-build 0.8.7`：

```sh
rustup target add wasm32-unknown-unknown
cargo install worker-build --version 0.8.7 --locked
npm ci
npm run verify:rust
```

`verify:rust` 依次运行 Rust 单元测试、重新编译 Wasm、混淆打包、Wasm 集成测试和订阅测试；任一步失败即停止。`npm run build:rust` 自身也会先调用 `worker-build --release` 编译，避免把旧 Wasm 与新源码混装。构建和检查命令均不执行部署。

发布构建启用 LTO、尺寸优化和 Wasm 调试信息移除；JavaScript 绑定/订阅层使用随机种子、RC4 字符串数组、长字符串拆分和名称混淆。不使用动态代码生成、自防护或调试干扰。编译和混淆不保证解除平台限制。

产物位于 `dist/rust/`：`worker.mjs`、`index_bg.wasm` 和 `manifest.json`。部署时这两个模块必须同时上传，入口为 `worker.mjs`，Wasm 部分使用 `application/wasm`。保留原 UUID、KV、兼容日期及运行配置；先验证服务再切换域名。

清单同时记录 Rust 源文件指纹和各模块的 SHA-256，以便核对源码与构建包。优选地址 API 接受带独立整数端口的 IPv6，自动规范化并使用方括号写入列表；错误或超范围端口不会导致误删已有条目，全部无效的新增请求不会改写 KV。

## 验证

Rust 单元测试覆盖配置校验、分片报文、错误鉴权、SHA-224 Trojan 头、IPv6 和目标格式。运行时测试在 Miniflare/workerd 中直接执行最终混淆 JavaScript 和 Wasm：验证配置读写、错误身份拒绝、VLESS/Trojan 双向 TCP、early data、SOCKS5/HTTP CONNECT 和 XHTTP 流式返回。测试使用临时本地 TCP 服务及测试 UUID，不写入线上配置。

本地测试通过与上传成功均不能证明公网恢复。部署结果还须验证实际 HTTP/配置/代理转发及持续可用性。
