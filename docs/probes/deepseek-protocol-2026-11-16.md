# DeepSeek 协议探针记录（阶段 A）

日期：2026-11-16。模型：`deepseek-flash`。接口：`https://api.deepseek.com/anthropic/v1`。
脚本：[`web/scripts/probes/deepseek-protocol.ts`](../../web/scripts/probes/deepseek-protocol.ts)（`DEEPSEEK_API_KEY=… bun web/scripts/probes/deepseek-protocol.ts`）。
夹具：[`web/src/services/agent/fixtures/`](../../web/src/services/agent/fixtures/)，每次请求与响应一个 JSON（流式的按事件录制），密钥已脱敏，上传的测试文件已在结束时删除。

**样本量说明：整套脚本跑了两次（第二次是修正测试 PDF 后的重跑，夹具保存的是第二次的结果），模型输出有随机性。“通过”表示这一次接口接受并给出了合理回答，不是对稳定性的保证。**

## 结果

| 编号 | 验证内容 | 结果 | 夹具 |
| --- | --- | --- | --- |
| A1 | 声明客户端工具后，模型返回 `tool_use`（非流式） | 200，`stop_reason: tool_use`，内容块为 `text` + `tool_use` | `a1-tool-use` |
| A2 | 回传 assistant 内容 + 紧随的 user `tool_result` | 200，`end_turn`，模型正确引用了工具结果 | `a2-tool-roundtrip` |
| A3 | 流式 `tool_use`，用 `input_json_delta` 拼出参数 | 200，参数 `{"path":"notes.txt"}` 可拼回完整 JSON | `a3-tool-use-stream` |
| A4 | 开启 thinking 后的流式 `tool_use` | 200，内容块顺序为 `thinking` → `text` → `tool_use` | `a4-thinking-tool-use-stream` |
| A5 | thinking 开启，回传完整 assistant 内容（含 thinking）+ `tool_result` | 200，`end_turn` | `a5-thinking-roundtrip-full` |
| A6 | thinking 开启，回传时**去掉** thinking 块 | 200，**也被接受**（见下文注意事项） | `a6-thinking-roundtrip-dropped` |
| A7 | 同一轮并行调用两个工具 | 模型确实返回 2 个 `tool_use`；两个 `tool_result` 放在同一条 user 消息里回传，200 | `a7-parallel-*` |
| A8 | `tool_result` 带 `is_error: true`，`content` 为 text 块数组 | 200，模型向用户转述了错误 | `a8-tool-result-error` |
| B1 | 文本上传，带 `expires_after[anchor]` / `expires_after[seconds]` | 200；响应里没有任何过期字段，**无法确认过期参数是否生效或被忽略** | `b1-upload-text-expiry` |
| B2 | PDF 上传，`purpose=text_recognition` | 200 | `b2-upload-pdf` |
| B3 | 直接在 user 消息里用 `document` 文件块（PDF） | 200，正确读出暗号 | `b3-document-direct` |
| **B4** | **同一条 user 消息里同时放 `tool_result` 和 `document` 文件块** | **200，模型读出了 PDF 内容**（设计文档里最大的未知项） | `b4a-…`、`b4b-tool-result-plus-document` |
| B5 | `tool_result` 单独一条 user 消息，文件块放在紧随其后的另一条 user 消息（连续两条 user） | 200，也被接受 | `b5-document-in-following-user-message` |
| B6 | **thinking 开启** + `document` 文件块 | **200，正常读出内容** | `b6-document-with-thinking` |
| B7 | 把纯文本文件（`user_data`）当 `document` 块引用 | 200，正确读出第一行 | `b7-text-file-document` |

B3 备注：第一次运行时我自制的测试 PDF 页面只有 300pt 宽，最后一个字符画到了页面外面，模型读到 `SECRET-PDF-4`（连思考里读到的文本也是少一个字符）。把页面加宽到 612pt 重跑后，B3、B4、B5、B6 都读出完整的 `SECRET-PDF-42`。这是测试夹具的问题，不是协议问题；但也说明解析按页面可见区域取文本，页面外的文字会被丢弃。

## 对设计的影响

1. **`tool_result` 与文件块可以放在同一条 user 消息里**，这条路径可用，设计文档 5.3 的主方案成立，备选方案（B5 的两条 user 消息）也能用，暂时不需要备选。
2. **`tool_use` 的 id 形如 `call_00_…`**，并行调用的 id 各不相同，需要按 id 一一对应回传 `tool_result`。
3. **并行工具调用是真实会发生的**，Agent 循环必须逐个执行并把全部结果放进同一条 user 消息。
4. **流式的 `tool_use`** 通过 `input_json_delta` 累积；现有 `applyEvent`（`web/src/services/chat/reply.ts`）会丢掉客户端工具块，需要改成完整收集。
5. **thinking 开启时 `document` 块可用（B6）。** 但 [`web/src/services/api/types.ts`](../../web/src/services/api/types.ts) 的注释写着“扩展模式不支持 document，返回 400”。本次探针里没有出现 400。可能注释里的“扩展模式”指的是别的模式，或接口行为已改变；**在弄清楚之前，代码不要依赖任何一边**，需要时再单独验证。

## 注意事项（不要过度解读）

- **A6 被接受，不代表可以丢掉 thinking 块。** DeepSeek 兼容文档要求继续工具调用时保留完整 assistant 内容；这次它没有拒绝，但可能影响推理质量或之后被收紧。实现里仍然保留完整内容。
- **B1 的过期参数**：Anthropic 兼容接口对 `expires_after[...]` 返回 200，但响应不带过期时间，无法确认是否生效。要验证需要等到过期时间之后检查文件是否仍可引用（最短 3600 秒），本次没做。在确认之前，不能依赖“上传设置过期”来做清理，仍要在本地记录并主动删除。
- **未验证**：`max_tokens` 不传时的行为（探针一律传了 1024，而应用现有请求不传）；`system`、`safety_check`、`title` 对工具调用的影响；DeepSeek 内置搜索工具与客户端工具同时声明；大文件和多页 PDF；`rich_layout_recognition` 的行为与费用；缓存命中的规律（第一次运行 `cache_read_input_tokens` 为 0；因为整套脚本又跑了一遍，夹具里是第二次运行的结果，其中大部分请求出现了 128 或 256 的缓存命中，看起来按 128 token 的块命中前缀。这只说明重复前缀会命中缓存，没有专门测试“追加式裁剪不破坏缓存”）；手机端和浏览器端（探针在 Bun 里直连，没有经过 `/api/deepseek` 网关，也没有 CORS）。
- 探针使用的是一把临时密钥，测试结束后由用户删除。

## 组合限制：客户端工具必须开启思考（补充探针）

起因：把文件工具接进聊天后，真实接口对应用的请求返回 400。脚本 [`web/scripts/probes/deepseek-tools-matrix.ts`](../../web/scripts/probes/deepseek-tools-matrix.ts)，夹具 `web/src/services/agent/fixtures/matrix-*.json`（每组合一个，另有 `matrix-_summary.json`）。每个组合只跑了一次。

| 请求里除客户端工具外还有 | 思考关闭 | 思考开启 |
| --- | --- | --- |
| 无（仅客户端工具） | 200 | 200 |
| `safety_check` | **400** | 200 |
| `deepseek_read_url` | **400** | 200 |
| `title` | **400** | 200 |
| `deepseek_read_url` + `safety_check` + `title`（应用的实际请求） | **400** | 200 |
| 再加 `deepseek_web_search` | **400** | 200 |

错误信息：`tools: client tools can only be used together with deepseek_web_search, deepseek_read_url, safety_check or title in thinking mode`。

结论：只要请求里有任何“扩展模式”参数，客户端工具就要求开启思考。应用固定带 `safety_check` 和 `deepseek_read_url`，所以文件工具只能在深度思考开启时声明。去掉安全审核或标题来绕开它不可接受。
