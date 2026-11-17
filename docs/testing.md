# 测试

聊天端到端测试有两组，共用一份场景，都用 Chrome 驱动构建后的前端：

| 组 | 后端 | 命令 | 特点 |
| --- | --- | --- | --- |
| 夹具 | 假的 DeepSeek 服务端，按脚本回放流式回复 | `bun run build && bun run test:bdd` | 确定、不需要密钥、断言精确（回复文字、请求内容） |
| 真实 | 真实的 DeepSeek 接口 | `bun run build && DEEPSEEK_API_KEY=sk-… bun run test:bdd:real` | 手动触发；输出不确定，只断言结构（出现回复、版本数、重载后还在） |

`bun run test` 只跑 `web/src/` 下现有的少量单元测试，不包含上面两组。

Rust 服务端测试单独运行 `bun run test:server`，覆盖扫码响应解析、固定操作的请求校验、导出状态解析、充值参数和 ZIP 流式转发。

## 目录

- `web/tests/bdd/setup.test.ts`：用夹具验证二维码过期刷新、断线后恢复、历史导入、跳过、API Key 重试、退出和余额检查。
- `web/tests/bdd/chat.feature.test.ts`：聊天场景，两组共用。`strict`（夹具模式）为真时才做精确断言。
- `web/tests/bdd/support/world.ts`：测试台。起一个本地服务提供 `dist/`，并在测试浏览器里拦截 DeepSeek 直连请求，转给假服务端（夹具）或真实接口（测试台注入真实密钥）；每个场景一个全新的浏览器环境（独立的 localStorage 与 IndexedDB），已带上登录凭证。
- `web/tests/bdd/support/mockDeepseek.ts`：假服务端，回放脚本化的 SSE 响应，并记录收到的请求。
- `web/tests/bdd/support/bdd.ts`：`feature` / `scenario` 和带步骤名的 `given` / `when` / `thenStep` / `and`，失败时错误信息里会带上出错的步骤。

## 聊天端到端场景

1. 发送消息并收到流式回复（夹具模式还检查流式中间状态和发出的请求体）。
2. 重新生成保留旧回复作为另一个版本，可来回切换，新请求的历史不含旧回复（夹具模式）。
3. 页面重载后，会话仍在侧边栏，打开后消息和回复还在。
4. 在桌面和手机宽度点击品牌标识，均会在新标签页打开项目仓库（仅夹具）。

## 覆盖范围

- **真实微信登录、官方导出和充值**：向导测试使用模拟的中继响应。
- **附件上传、语音、搜索、深度思考、手动导入导出、手机端。**
- 真实模式每个场景只跑一次，模型输出有随机性；通过不代表稳定。

## 已知情况

- 构建产物 `dist/` 必须是最新的，测试不会自动构建。
- 需要本机安装 Google Chrome（用 Playwright 的 `channel: 'chrome'`）。
- 真实模式会产生少量 token 费用；密钥只通过环境变量传入，不会写入文件。
