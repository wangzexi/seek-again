# 浏览器 Agent 与持久化虚拟文件系统设计

> 状态：设计与工程交接稿。第一部分已实现（见下方“实现状态”），其余仍是设计。开始改代码前先复核当前工作区和 API 实测结果。

## 实现状态（2026-11-17）

已实现并在假服务端与真实 DeepSeek 接口上测过：

- **能力注册表** [`web/src/services/agent/registry.ts`](../web/src/services/agent/registry.ts)：深度思考（请求选项）、智能搜索与阅读链接（服务端工具）、bash（浏览器工具）都登记在这里，请求里的 `thinking` 和 `tools` 由它按界面开关生成。
- **Agent 循环**：`streamReply`（`web/src/services/chat/store.ts`）在第一次请求以 `tool_use` 结束时，执行工具、回传 `tool_result`、让模型继续，直到它不再调用。限制：最多 8 轮；用户点停止会中断当前请求和后续工具；达到上限时以“工具调用次数过多”收尾。续写不声明客户端工具。
- **bash**（工具名 `bash`，唯一参数 `command`）：对齐 DeepSeek Harness 极简模式，模型只有这一个客户端工具，读、写、删、搜索都用命令完成（没有单独的文件工具）。在 Web Worker 里运行 just-bash（浏览器版），当前目录起点是对话目录。支持 `grep`、`rg`、`find`、`sed`、`awk`、`jq`、`sort`、`uniq`、`wc`、`head`、`tail`、`cat`、`ls`、`diff`、`xargs` 和管道。**状态跨命令保留**：当前目录和 shell 变量（含没 `export` 的）带到下一条命令，也带到后面的消息；状态记在回复的 `agent.shell` 上，所以和文件一样随分支走、重载后还在，每一轮从路径上最近的一份状态开始。函数和别名带不过去（just-bash 序列化不出函数体），也没有后台任务。**空目录会保留**：文件清单里只有文件，没有文件的目录用以 `/` 结尾的占位条目保存，`mkdir x` 之后下一条命令还能 `cd x`；目录里有了文件，占位自动移除，占位不会当作文件出现。文件内容**懒加载**：命令真正读到某个文件时才从 IndexedDB 取；命令结束后，新建、修改（`>`、`>>`、`sed -i`、`mv`、`cp`）和删除（`rm`）按差异保存回对话目录，同样记进回复的 `commit`。限制与官方 bash 一致：单条命令 300 秒（Worker 超过 310 秒无响应会被直接终止，用户点停止也会终止，下次调用重建）、输出 16,000 字符（stdout 和 stderr 合计）；另有 2 万条内部命令、1 MB 输出的内部上限，死循环会很快被挡住。没有网络（`curl` 不存在）、只能看到对话目录，`/tmp` 等目录里的东西命令结束后丢弃；`gzip`/`gunzip`/`zcat` 在浏览器里不可用。命令结果里写明退出码和被改动的文件（最多列 20 个）。**退出码非 0 不算工具出错**（`grep` 没匹配也是 1）。
- **按分支的目录**：每次写入以 `AssistantMessage.commit`（路径 → 内容哈希）记在回复上，目录状态由 `resolveDirectory` 沿当前分支叠加。重新生成产生的兄弟版本互不可见，切换版本时目录跟着变，重载后仍在。文件内容存在 IndexedDB 新增的 `workspaceBlobs`（按 SHA-256 内容寻址，先写内容再记引用；数据库版本升到 12）。
- **工具轨迹**：`AssistantMessage.agent.calls`，随回复版本保存，在回复时间线里显示“读取 / 写入 / 删除 / 查看文件列表”及失败、停止状态。
- **导出**：不受影响。`toSessionFile` 本来就是逐字段构造，一个测试保证带 Agent 数据与不带的会话导出结果完全相同（`web/src/services/chat/history/toArchive.agent.test.ts`）。

**重要限制（真实探针确认）：bash 只在开启深度思考时可用。** 请求里只要同时有 `safety_check`、`deepseek_read_url`、`deepseek_web_search` 或 `title` 之一，客户端工具就必须开启思考，否则接口返回 400（见 [探针记录](probes/deepseek-protocol-2026-11-16.md) 的“组合限制”）。应用的每个请求都带 `safety_check` 和 `deepseek_read_url`，所以关闭深度思考时请求里不声明 bash，聊天行为与以前完全一致。这与本文“Agent 默认启用”的决定有冲突：默认启用的前提是深度思考开着。

**参照 DeepSeek Harness 极简模式**（开源：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，MIT，读的是 `master` 的 `packages/bundle/sdk-minimal`）：它只给模型三个工具——常驻的 `bash`（唯一参数 `command`，超时 300 秒，输出默认截到 16,000 字符）、`read_image`、`working_directory`，**没有文本文件工具**。我们照此只保留 `bash`。和官方的差别：官方的 bash 是真实的进程；我们的是浏览器里模拟的 just-bash。当前目录和变量、超时（300 秒）、输出上限（16,000 字符）、工具名和参数都对齐了；做不到的是函数和别名跨命令保留、后台任务、网络、Python，以及真实进程才有的一切（管道里的交互输入等）。系统提示词也保持简单：它只是设置里的一个全局文本框（`chat-demo:system-prompt`，默认为空），原样作为 `system` 发送，Agent 不往里加任何东西，bash 的用法全在工具描述里。

**Python 和 JS：没做，也不打算做（按用户的决定，只要常用的文本检索）。** 实测确认 just-bash 的浏览器版**明确拒绝 `python3`**（真实 Chrome 里的报错是 `command not available in browser environments`），`js-exec`、`sqlite3` 同样不可用，所以 Shell 不会顺带提供它们。Pyodide / JS 沙箱的方案保留在下面的设计里，需要时再做。

**Shell 的实测（桌面 Chrome、本机，Worker 里真实运行 just-bash；手机没有测）：** 首次使用（下载并启动 Worker）约 124 ms，之后每条命令约 50–60 ms；一条命令创建并保存 1000 个文件约 835 ms；在 1000 个文件里 `grep -rl` 约 127 ms；`ls` 约 51 ms（不读文件内容，证明懒加载有效）。打包后主包只增加约 3 KB，just-bash 在单独的 1.25 MB 分包里，第一次用到 Shell 时才下载；`dist/` 总体积从 4.6 MB 到 5.8 MB。just-bash 的浏览器包引用了 `node:zlib`（gzip 命令），在 `rspack.config.ts` 里用一个会抛错的替身替换。真实模型（3 次）都自己选了合适的 `grep -rn` 命令并答对。

**与设计的差异：** 第一版没有跨对话读取和附件读取工具。

**还没做：** 附件的本地读取与按需上传（`read_attachment`）、跨对话只读访问与 `/skills`、Python 与 JS 运行时（见上）、Shell 对**很大**目录的性能（现在每条命令都把整个清单传给 Worker，几万个文件时这一步会变慢）、Blob 的标记清除回收（删除对话后内容仍留在 `workspaceBlobs`，只多占空间）、`/INDEX.md` 与 `chat.md` 投影、旧 `tool_result` 的裁剪（现在历史里只保留最终文本，本回合内的往返完整回传）。

## 1. 目标

把 chat-demo 从“附件一选中就上传、一次 API 请求生成回答”的聊天流程，扩展成“浏览器运行 Agent 循环、按需访问本地文件”的应用：

- 用户选择的附件先保存在浏览器本机，不因为选中或发送消息而自动上传。
- 聊天记录与附件在浏览器本地形成 Agent 可读的虚拟文件视图。
- 对可直接读取的文本，Agent 在浏览器本地读取，只把相关结果片段交给 DeepSeek。
- 对本地无法解析、确需 DeepSeek 文件解析能力的附件，只有 Agent 请求读取时才上传并引用 DeepSeek 返回的 `file_id`。
- Agent loop、文件系统和工具分发在前端运行；模型推理仍通过现有 DeepSeek API 路径在云端执行。

- 百万上下文用户的聊天与资料以目录组织，Agent 通过 `ls`、`grep`、`find`、`head`、`sed` 导航，而不是每轮把全部历史塞进请求。
- 文件系统是产品能力，不只是 Agent 的内部实现：用户能浏览、上传、下载、导出，不同对话之间可以按目录互相引用。

此设计服务于需要长期上下文的聊天用户。已有聊天记录保持原有内容和分支，不要求把历史对话转换成摘要或更换存储格式。

## 2. 非目标与边界

- 不在浏览器运行模型推理，不在浏览器模拟 DeepSeek 服务端。
- 不让虚拟 Shell 访问设备的真实文件系统。
- 不在本期重写登录、历史导入、聊天 UI、语音、DeepSeek 请求或现有聊天数据库。
- 不让 Shell 默认访问网络、任意 JavaScript、Python 或其他宿主能力。
- Agent 的文件读取和 Shell 执行是本地动作；工具结果、被读取的文本片段、上传文件和模型请求仍会发送给 DeepSeek。不能把“前端运行 Agent”描述成“模型看不到文件内容”。

## 3. 当前工程基线

目标仓库是本目录的 DeepSeek `chat-demo`。目前可依赖的现有能力：

- 会话、附件 Blob 和历史导入暂存保存在 IndexedDB，见 [`web/src/services/chat/db.ts`](../web/src/services/chat/db.ts)。当前数据库版本为 11。
- 会话和附件元数据已有本地 ID `id`，以及 DeepSeek 文件 ID `serverId`，见 [`web/src/services/chat/types.ts`](../web/src/services/chat/types.ts)。
- 聊天通过 Anthropic 兼容 Messages/Files API；浏览器持 API Key 直接调用 DeepSeek。见 [`web/src/services/api/client.ts`](../web/src/services/api/client.ts)。
- 选中文件目前会启动上传；发送前 `prepareFiles` 会确保当前及上下文附件已取得 `serverId`，见 [`web/src/services/attachments.ts`](../web/src/services/attachments.ts) 和 [`web/src/services/chat/store.ts`](../web/src/services/chat/store.ts)。这是本设计要调整的行为。
- 当前 `streamReply` 对每条用户消息发起一轮请求；`applyEvent` 可识别 `tool_use`，但会丢弃客户端工具块，见 [`web/src/services/chat/store.ts`](../web/src/services/chat/store.ts)、[`web/src/services/chat/reply.ts`](../web/src/services/chat/reply.ts) 和 [`web/src/services/api/types.ts`](../web/src/services/api/types.ts)。因此需要增加客户端 Agent loop。

### 工作区保护

编写本设计时，仓库已有大量未提交修改，涉及登录、导入、网关、设置、附件和聊天服务。实施者必须保留这些工作，开始时记录 `git status --short`，不要 reset、checkout、clean 或覆盖已有改动。本文件是独立新增的设计文档。

## 4. 建议架构

```text
React chat UI
    │ 用户输入、附件元数据、Agent 状态
    ▼
Agent turn controller (browser)
    ├─ DeepSeek Messages API stream ──► /api/deepseek ──► DeepSeek
    ├─ bash(command) ──────────────────► just-bash (browser)
    └─ read_attachment(path, purpose)
         ├─ 可读文本：本机 Blob/虚拟文件 ──► 有界文本 tool_result
         └─ 需要 DeepSeek 解析：Files API 上传 ──► file_id
                                              └─► 后续 Messages 请求的文件块

IndexedDB
    ├─ sessions / files：现有聊天和原始附件
    └─ workspaceFiles：新增的持久化 Agent 工作区
```

### 文件系统布局

| 路径 | 来源 | 权限 | 持久性 |
| --- | --- | --- | --- |
| `/INDEX.md` | 自动生成的总览（会话数、日期范围、目录说明） | 只读 | 按需生成 |
| `/chats/<yyyy>/<mm>/<title>-<session-id>/chat.md` | 现有 IndexedDB 会话投影成文本，只含当前选中分支 | 只读 | 原始会话已持久化 |
| `/chats/.../<title>-<session-id>/attachments/<name>` | 现有 IndexedDB `files` 中的 Blob，挂在所属对话下 | 只读 | 附件原件已持久化 |
| `/chats/.../<title>-<session-id>/.branches/` | 其他分支的文本投影 | 只读 | 按需生成 |
| `/chats/.../<title>-<session-id>/<其他路径>` | 新增 `workspaceFiles` 存储，键为对话 ID + 相对路径 | **仅当前对话可写**，其他对话只读 | IndexedDB 持久化 |
| `/skills/<name>/SKILL.md` | 应用内置的说明文件（例如跨对话查阅方式） | 只读 | 随应用发布 |
| `/tmp/<path>` | 当前 Shell 实例 | 读写 | 运行时内存，重启后丢弃 |

每个对话的目录就是它自己的工作区：Shell 的当前目录是当前对话目录，`chat.md`、`attachments/`、`.branches/` 为只读投影，其余位置 Agent 可以写。其他对话的目录一律只读，任何写入请求返回明确错误，没有全局共享的 `/workspace`。

聊天和附件是已有数据的虚拟视图，避免再永久复制一套聊天归档。目录和文件名带标题与日期，使 `ls`、`grep -l` 的结果能被模型和用户直接读懂；附件挂在所属对话目录下，导出一个对话时聊天文本与附件天然在一起，聊天里的相对引用（`attachments/<name>`）成立。同一对话内同名附件自动加后缀。工作区文件与聊天原件分开管理，聊天 ID、附件 ID、DeepSeek `file_id` 不互相替代。路径解析必须规范化，禁止 `..` 越过虚拟根目录。

### 4.1 文件服务层

Agent、文件管理界面和导出都通过同一层文件服务访问数据，不直接读写 IndexedDB store：

- 接口：`list`、`stat`、`read`（支持范围）、`write`、`move`、`delete`、`mkdir`、`pack`（流式打包）。
- 挂载表决定每个路径由谁提供：会话投影、附件 Blob、`workspaceFiles`、内置 skills、内存 `/tmp`。写权限按调用方的对话 ID 判断：只有路径属于该对话目录且不在只读投影内才允许写。
- `just-bash` 通过它的文件系统适配接入此层；代码运行时（4.4）和导出直接调用同一服务，保证看到的内容一致。
- 每个文件记录来源（`chat-attachment`、`agent`）、创建时间、所属对话，供导出清单使用。
- 存储配额、清理和大文件流式读取在这一层统一处理，手机上不得一次把整个工作区读入内存。

### 4.2 跨对话挂载与引用

- **默认只在当前对话目录工作。** Agent 不主动浏览其他对话；用户在消息里明确提到（例如“看看之前旅行计划那个对话”）时才去读。
- 内置一个 skill：`/skills/chats/SKILL.md`，说明所有对话目录的布局和查阅方式（`ls /chats`、按日期和标题找、`grep -l`、读取 `chat.md` 与 `attachments/`）。系统提示只列出 skill 名称和一句话描述；模型需要跨对话查阅时再读取该文件，平时不占上下文。这与 pi 等 Agent 把会话以本地文件暴露、按需读取的做法类似。
- **其他对话只读。** 文件服务按调用方对话 ID 拒绝对其他对话目录的任何写入、移动和删除，返回明确错误。
- 读取其他对话时，工具轨迹显示“读取了对话《标题》”，让用户看见哪些内容被带出当前对话。这些内容同样会发送给 DeepSeek。
- 对话被删除后，读取它的路径返回明确的“已不存在”错误，不静默返回空内容。
- 是否在输入框提供 `@` 引用，不是第一期必需项：用户用自然语言说就够，`@` 之后再加。

### 4.3 导航与上下文预算

- 系统提示说明目录布局、只读与可写位置，并提示先读 `/INDEX.md`；给出“找人名”“按日期范围看”等示例。
- 工具输出默认截断到几千 token，带“还有 N 行，用 `sed -n` 翻页”的提示。
- 旧的 `tool_result` 在后续轮次折叠或裁剪；裁剪应追加式进行，不改写前面的消息，以免破坏 DeepSeek 的前缀缓存。具体上限由阶段 A 实测确定。
- 不做全文索引：`grep` 直接扫描。阶段 A 的性能探针仍然要测规模上限，若在目标规模下不可接受，再回头评估索引。

### 4.4 代码运行时（Python 与 Node）

调研结论：`just-bash` 的浏览器构建只支持核心 Shell 与内置命令，`python3`、`js-exec`（QuickJS）和 `sqlite3` 都需要 Node.js，**浏览器里不可用**（其 README 明确写明；已读 2.14.0 与当前文档，均如此）。因此要另接运行时：

- **Python：Pyodide**（CPython 编译到 WebAssembly），运行在专用 Web Worker 中。基础包体积约十几 MB，按需加载，首次使用时才下载并缓存；新版本编号已改为 314.x，接入时核对当前发布。numpy、pandas 等包按需加载。
- **JavaScript：** 浏览器本身就能运行 JS，需要的是隔离。方案是把模型生成的代码放进独立 Worker（sandboxed iframe + CSP 禁止网络），只提供一个受限的 `fs`/`path` 适配层，桥接到文件服务。不追求完整 Node API；“Node”在这里指“能 `require('fs')` 读写文件的 JS”。备选是 QuickJS 的 WASM 构建（隔离更强、内存可限，但性能和 API 更少）。
- **完整虚拟机方案对比**（搜索所得，未实测）：

  | 方案 | 能跑什么 | 许可与限制 | 判断 |
  | --- | --- | --- | --- |
  | Pyodide | Python（含 numpy、pandas 等按需包） | 开源 | 第一版的 Python 方案 |
  | 沙箱 Worker / QuickJS | JS，自定义 `fs` | 自研或开源库 | 第一版的 JS 方案，不是真 Node |
  | WebContainers（StackBlitz） | 真 Node.js（含 npm） | 盈利性生产使用需商业授权，价格需联系销售；原型可免费 | 只有 Node，没有 Python；授权成本不明 |
  | BrowserPod（Leaning Technologies） | 首发 Node.js 22，Python、Ruby 列为后续 | 官方发布说明，成熟度和授权未核实 | 值得跟踪，暂不依赖 |
  | WebVM / CheerpX（Leaning Technologies） | 完整 Debian（x86 虚拟化），Python 等原生工具链；Node 未在搜索结果中确认 | 仓库 Apache 2.0，但官方 README 称组织使用需商业授权，且不得自行托管下载的 CheerpX 构建 | 能力最全，但授权和体积是风险 |
  | v86 | x86 PC 模拟器，可跑 Linux | 只支持 32 位内核；需要自备镜像，性能和体积都较重 | 不适合手机和移动端检索场景 |

  结论：第一版用 Pyodide + 沙箱 JS，覆盖“简单 Python 和 Node 检索”的需求；若后来确实需要真实 npm 生态或系统工具，再评估 WebVM/CheerpX（先确认授权）。虚拟机方案另有一个共同难点：虚拟机内部文件系统要和 IndexedDB 里的文件互通，只能靠复制或挂载桥接，复杂度高于 Pyodide。
- Shell 里通过 `python3 script.py`、`node script.js` 之类的命令转发到上述 Worker；`bash` 与代码运行共享同一套执行限制（时间、输出、内存）。
- **文件桥接是难点**：Pyodide 的文件系统是同步的，而 IndexedDB 是异步的。两种做法：(a) 运行前把脚本会读到的文件（当前对话目录与显式提到的对话）复制进 Pyodide 的内存文件系统，运行后把当前对话目录内的改动写回；(b) 用 `SharedArrayBuffer` + `Atomics.wait` 做同步桥，需要网页服务给页面设置跨域隔离头（COOP/COEP）。第一版倾向 (a)，由阶段 A 验证大文件和大目录时的开销。
- 网络：代码运行环境默认无网络；Python 的 `micropip` 在线安装包默认关闭。
- 代码生成的文件只能写到当前对话目录或 `/tmp`，写入走 4.1 的权限检查。

第一版采用 `just-bash` 浏览器构建，接入其可替换文件系统接口。Shell 执行加时间、命令数和输出长度限制。百万上下文用户的会话和文件量大，Shell 从阶段 B 起就放进 Web Worker，主线程只负责界面和流式显示。`rust-bash` 作为 Shell 兼容性不足时的备选，不在本期同时接两套运行时。

### 4.5 数据单一原则

目标是好维护：每类数据只有一个真相来源，其余全部是可重算的投影或缓存，不存在需要互相同步的副本。

| 数据 | 真相来源 | 性质 |
| --- | --- | --- |
| 消息树（含分支、轨迹、提交清单） | IndexedDB `sessions` | 唯一真相 |
| 文件内容 | `workspaceBlobs`，按内容哈希 | 内容本身，不可变 |
| 附件原件 | 现有 `files` | 第一阶段不动 |
| `chat.md`、`attachments/` 等目录视图、`/INDEX.md` | 由消息树和提交即时计算 | 派生，不落盘 |
| 导出 ZIP | 由以上投影（沿用 `toArchive`） | 派生，不落盘 |
| 目录清单缓存 | 由提交重算 | 内存缓存，不落盘 |
| 孤儿 Blob 的回收 | 标记清除 | 按需计算，不维护计数 |

新增任何存储或缓存前先问：它能否由已有数据重算？能，就不存。

## 5. 按需读取附件

### 5.1 选取与入库

1. 文件选择时继续检查扩展名、MIME、大小、数量和存储空间。
2. 读取 Blob 并保存到现有 IndexedDB `files`；聊天消息只记本地附件 ID、文件名、大小、MIME、类别和可选远端 `serverId`。
3. 停止调用 `uploadAttachment`；附件 UI 显示“仅保存在此设备”或“已发送给 DeepSeek”等实际状态。
4. 把附件名、类型、大小等轻量元数据提供给模型，使它能判断何时需要读取；不附带文件原文。

### 5.2 本地文本读取

`read_attachment` 或等价本地工具接收虚拟路径和读取意图。支持的纯文本、Markdown、CSV、JSON、源码等类型由浏览器解码后读取。按行数和字节数分页或截断，工具结果应带文件名、范围及是否截断，避免一条工具调用把整份大档案塞进模型上下文。

`bash` 用于组合搜索，例如 `grep`、`find`、`sed`、`head`。`read_attachment` 用于明确读取用户附上的单个文件。两者读取的结果都只在工具结果确实需要时发给 DeepSeek。

### 5.3 DeepSeek 解析兜底

本地无法解析且产品仍接受的 PDF、Word、PPT、图片等文件，按以下流程处理：

1. 模型在流中返回客户端 `tool_use`，例如 `read_attachment(path, purpose)`。
2. 浏览器 Agent 检查该附件的本地 Blob 和缓存的远端 `serverId`。如无有效远端 ID，调用现有 `uploadFile`，由 DeepSeek Files API 解析并返回新的 `file_id`。
3. 后续 Messages 请求保留完整 assistant `tool_use` 内容；紧接的 user 消息包含每个调用对应的 `tool_result`，并引用该文件的 `document` 或 `image` 文件块。
4. 模型读取文件后继续生成回答。缓存的 `serverId` 只作为远端缓存使用，不能在每轮历史请求中自动重新附上。

**协议验证结果（2026-11-16，真实 API，详见 [探针记录](probes/deepseek-protocol-2026-11-16.md)）：** 同一条 user 消息里同时放 `tool_result` 与 `document` 文件块，接口返回 200，模型读出了 PDF 内容；把文件块放在紧随其后的另一条 user 消息也被接受。thinking 开启时 `document` 块也可用，但 `web/src/services/api/types.ts` 的注释写着“扩展模式不支持 document，返回 400”，与本次结果不一致，需要再弄清楚后才能依赖任何一边。每项只测了一次或两次，结论是“可用”，不是“稳定”。

DeepSeek 文件解析在上传成功时按文档页数收取一次解析费，后续请求还按输入 token 收费。纯文本 `user_data` 上传没有解析上传费，但模型读取的文本仍收费。选择 `rich_layout_recognition` 时模型可获得识别出的图表/图片，选择 `text_recognition` 则只给文本；默认目的和费用提示应匹配用户的读取问题。[DeepSeek File Parsing](https://api-docs.deepseek.com/guides/document_parsing/)

Files API 支持 1 小时至 30 天的过期时间，省略时永久保存。新上传应设置明确的过期策略；本地 Blob 保留，过期后再按需上传。当前 API helper 不设置过期时间，需在实施时调整。删除本地会话时不应误删其他会话仍引用的附件；远端文件清理按引用和过期策略独立处理。[DeepSeek Files API](https://api-docs.deepseek.com/guides/files_api/)

## 6. Agent loop 与聊天状态

增加一个独立的客户端工具调度层，围绕现有 `streamMessage`/`streamReply` 工作，而不是把所有控制流继续堆进 React 组件。

```text
发出 Messages 请求
    │
    ├─ 普通文本结束 → 完成当前 assistant 回复
    │
    └─ stop_reason=tool_use
          ├─ 收集完整 assistant content（包含 thinking、tool_use）
          ├─ 校验工具名与 input schema
          ├─ 本地执行工具；必要时再上传并生成 file_id
          ├─ 持久化工具调用/结果状态
          ├─ 追加匹配的 user tool_result（必要时附 DeepSeek 文件块）
          └─ 发下一轮 Messages 请求
```

**默认启用。** 所有对话统一走 Agent loop；用户没有需要工具的请求时，模型不会调用工具，一轮请求即结束，行为与现在的单轮聊天一致，不另设两套流程。

**保留现有分支能力。** 产品的主要用户是剧情玩家，重新生成、编辑提问、在版本间切换和分叉剧情是核心用法，Agent 不能破坏它。现有行为不变：`regenerateReply` 用 `appendBranch` 在同一问题下新增兄弟回复，`editMessage` 新增同父的提问版本，`BranchSwitcher` 切换版本，导入导出沿用完整消息树。

- Agent 的工具往返（`tool_use`、`tool_result`、上传记录、轨迹）**挂在各自的回复上**，随该回复的版本保存。切换版本就显示那个版本的轨迹。
- 重新生成的请求历史仍是 `path.slice(0, index - 1)`，不含其他版本的工具往返，不会被其他分支的轨迹污染。
- **工作目录随分支变化（分层提交模型）。** 对话目录的内容由消息树决定：每个回复版本可以带一个“提交”（该回复写入的路径 → 内容哈希，或删除标记），目录状态 = 沿当前可见路径（根到当前消息）把提交依次叠加，越靠近当前消息的优先。切换版本时目录自动变成那个分支的状态，重新生成产生的新兄弟版本从同一个父状态出发，互不影响。这与 [LayerFS](https://github.com/Ephemeral-AI-Lab/layerfs)（每个工具调用一个提交、分支是一串提交、内容寻址存储）的思路一致，但 LayerFS 本身是服务端的 FUSE 文件系统，只支持 Linux/macOS/WSL，没有浏览器版本，不能直接使用，只借鉴模型。
  - 存储：Blob 放在新增的 `workspaceBlobs`（内容哈希 → Blob，带引用计数）。提交的清单（路径 → 哈希或删除标记，很小）**内联在 `AssistantMessage.commit` 上**，随消息一起保存，这样它与 `saveSession` 同事务、随消息导出导入、天然只有消息树这一棵树（子代理评审的倾向；备选是独立的 `workspaceCommits` 表，键必须是 `(sessionId, messageId)`，见第 11 节）。
  - 读取：沿祖先链向上找该路径最近的一次提交；结果按消息 ID 缓存在内存里，后续读取只需追溯到最近一个已缓存的祖先。
  - 写入：文件服务把一次 Agent 回复里的全部写入合成一个提交，挂到该回复上；回复失败或被停止时不生成提交，或标记为未完成。
  - 代码运行：脚本运行前按当前路径解析出文件，复制进 Pyodide 内存文件系统；运行后对比差异，差异即提交。
  - 现成库不合适：`@zenfs/core` 的 CopyOnWriteFS 和 `layer-fs` 都是固定的“只读下层 + 可写上层”两层，不能表达任意深度的分叉链。第一版自己实现这一层，规模不大（解析路径、叠加、检查点、哈希去重）。
  - 并发：同一时间一个对话只有一个正在生成的回复，所以同一路径不会有两个提交同时写；不需要 LayerFS 的冲突检测。
  - 完整性约束（两位独立评审一致指出）：
    1. **消息 ID 不稳定**：导入时 `toLocal.ts` 用 `String(message.id)`，不同会话里都是 "1"、"2"……；导出时 `toArchive.ts` 又把 ID 重新编号为 1 到 n。因此提交绝不能只以本地消息 ID 为键。内联在消息上可以天然避免；若用独立表，键必须是 `(sessionId, messageId)`，导出的 Agent 条目使用 `toArchive` 那份 `ids` 映射后的 ID，导入时再映射回来。
    2. **回复会被原地修改**：`continueReply` 和 `retryUpload` 沿用同一个回复 ID，`settleInterrupted` 会在重新加载时把流式状态改为已停止。提交因此必须**只追加**：每次工具调用追加一条操作（带 `tool_use_id`），带 `partial` / `complete` 状态；已停止的回复保留已发生的部分提交，轨迹中标为不完整；`continueReply` 在同一提交上继续追加。不要在回复结束时才一次性生成提交。
    3. **只有一处写入顺序约束，没有需要同步的派生数据**：写文件时先写 `workspaceBlobs`，再写消息里的提交清单（先有内容再有引用）；崩溃时最坏只留下孤儿 Blob，不会有悬空引用。提交内联在消息上，随 `saveSession` 同事务保存，`deleteSession` 删消息即删提交，不用另外清理。**Blob 不维护引用计数**，改为标记清除：删除对话之后或用户清理空间时，遍历所有会话内联的提交，收集仍被引用的哈希，其余 Blob 删除；可延后、后台执行，不在写入的主路径上。`commitStaging('replace')` 同样只需在替换会话的同一事务里处理，回收仍由标记清除完成。
    4. **检查点只放内存缓存，不落盘**：它是可由提交重算的派生数据。打开会话时沿当前路径解析一次，按消息 ID 缓存目录清单；丢失后重算。长对话上缓存是必须的，但不作为存储的一部分，也就没有需要和提交同步的第二份数据。
    5. **作用域要一致**：附件挂在用户消息上，本来就随分支走，所以 `attachments/` 也要按路径（当前可见路径上的附件）投影，不能按整个会话显示；`chat.md` 定义为到“正在生成的那条回复的父消息”为止的路径，不使用 `current_message_id`；跨对话读取时按对方会话的 `current_message_id` 解析；`BranchSwitcher` 提示“两个版本的文件不同”，避免剧情玩家重新生成后发现角色卡不见了。用户在对话里上传到目录的文件，也作为挂在用户消息上的提交。
    6. **Pyodide 不要整目录复制**：只复制当前解析出的清单中被脚本触碰或明确点名的文件，设字节上限（iOS Safari 内存有限），改动用哈希比较得出，不对 Shell 路径使用“运行后比差异”，只对 Pyodide 这种有边界的单个操作使用。
    7. **配额**：调用 `navigator.storage.persist()`，写入前检查并提示剩余配额。
  - 删除对话时清理它的提交与 Blob 引用；没有任何引用的 Blob 才回收。
- 已上传到 DeepSeek 的文件无法撤回；`serverId` 缓存仍可复用或等待过期。
- 剧情用户的典型用法是把世界观、人物设定、剧情摘要放在对话目录里，让 Agent 按需读取；跨对话读取（只读）可以引用其他故事的设定。这些用法要纳入阶段 A 的模型稳定性探针。

实施要点：

- 扩展 API 请求工具类型，声明本地 `bash`、`read_attachment` 工具；保留现有 DeepSeek 服务端联网工具。
- 流解析器需要完整收集 `tool_use` 内容；不能只处理 `content_block_start` 后丢弃。校验工具名、JSON 参数、路径和目的类型，拒绝未知工具。
- 一轮中返回多个 `tool_use` 时，按本地策略逐个或有界并行执行；不能依赖 `disable_parallel_tool_use` 限制，因为 DeepSeek 兼容文档说明该参数会被忽略。
- 给每条用户消息设置最大工具轮数、命令时间、命令数量、输入大小和工具结果字节上限；达到上限时向模型返回可理解的工具错误或结束本轮。
- 复用现有 Stop 按钮的 `AbortController`，停止时取消当前请求及可取消的本地操作；停止状态、失败状态和附件上传中状态必须区分。
- 在 IndexedDB 记录 Agent 中间轨迹，至少保存 tool_use ID、参数、工具状态、结果摘要、上传结果和文件 ID，以便刷新后恢复或明确标记未完成。模型 API 请求历史只重建当前需要的工具往返，避免把旧的文档 file block 每次都发回。
- 用户界面显示“正在搜索本地记录”“正在读取附件”“正在发送文件给 DeepSeek”等状态；命令和长工具输出放在可展开细节里。

Anthropic 兼容格式要求：客户端工具放在 `tools` 数组中；每个 assistant `tool_use` 都要在紧接的 user 消息中得到匹配 `tool_result`；开启 thinking 时，继续工具调用要保留 assistant 的完整内容数组，包括 thinking 和 tool-use 块。[DeepSeek Anthropic API 工具协议](https://api-docs.deepseek.com/guides/anthropic_api/)

## 7. 持久化与备份

- IndexedDB 仍是聊天记录和附件原件的权威存储；增加 `workspaceFiles` 与必要的 Agent 运行记录，升级数据库版本并保持升级事务原子性。
- 虚拟 `/chats`、`/attachments` 从已有存储读取，不在每个发送时把所有 Blob 永久复制到新 store。
- 当前对话目录中文件的创建、覆盖、重命名、删除应原子保存。默认不提供绕出该对话目录写入的能力。
- 现有 ZIP 历史导出/恢复保持标准格式不变，Agent 数据不进默认导出（见 7.1）；不导出 API 访问 token、模型密钥或 DeepSeek `file_id`（远端缓存，可能已过期）。
- 捕获 IndexedDB quota 错误并提示导出或释放空间。可调用 Storage API 查询估计用量并请求持久存储，但仍提供用户可带走的备份；浏览器清理站点数据后本地数据仍可能消失。
- 暂不引入 OPFS。若 IndexedDB 文件记录的实测性能成为瓶颈，再比较 OPFS 文件树后端；这不改变聊天记录仍以 IndexedDB 为权威源的设计。

### 7.1 导出

**目标：导出的历史能被别的 DeepSeek 导入。** 导出就是 `toArchive` 那条现有的投影路径，本设计不改变它的产物。

- **默认导出 = 纯标准格式**：`export_format_version: 3` 的 ZIP（`manifest.json`、`chat_sessions/{session_id}.json`、`chat_session_index.json`、`chat_sessions/{session_id}_files/…`），见 [`web/src/services/chat/history/README.md`](../web/src/services/chat/history/README.md)。条目、顺序和字段与官方一致，不加任何额外条目，也不在标准字段里夹带提交、轨迹、哈希等 Agent 数据。别的 DeepSeek 看到的就是普通的历史会话。
- **Agent 数据不进默认导出**：对话目录里的文件、Agent 轨迹、非图片附件原件，在别的 DeepSeek 里本来就用不上；也不能保证对方的导入器会忽略不认识的条目，所以默认不写。
- 因此也不需要为导出做消息 ID 映射：提交内联在消息上，导出时 `toArchive` 照常重新编号并只写标准字段，提交随之被丢弃。
- **可选的“带 Agent 数据导出”（以后再说，非第一阶段）**：给用户自己备份对话目录用，作为单独的、明确标注的导出选项，把 Agent 文件和轨迹放在标准结构之外的独立前缀下（如 `chat_sessions/{session_id}_agent/`）。该选项需要提交按导出时的新编号重映射，导入我们自己的应用时再映射回来；不作为默认，也不承诺别的 DeepSeek 能导入。
- 不导出 API 访问令牌、模型密钥和 DeepSeek `file_id`。
- 导出仍按现有方式生成 ZIP；沿用“受 ZIP32 容量限制”的约束。

### 7.2 文件管理界面

暂不做。用户通过对话与 Agent 交互，查看生成的文件通过聊天中的文件卡片或导出获取；单独的文件浏览、上传、重命名界面留待以后。文件服务层仍保留，它同时服务 Agent、代码运行和导出。

## 8. 工程实施顺序

### 阶段 A：协议探针

- 用合成附件验证 Anthropic Messages 的客户端 `tool_use` / `tool_result` 往返。
- 验证 tool_result 与 document/image file block 的组合消息；覆盖 thinking 开启模式。
- 分别验证 PDF `text_recognition`、`rich_layout_recognition` 和可读文本本地回传。
- 记录上传完成时间、返回 `file_id`、解析费用行为、过期及失效错误处理。
- 性能探针：生成数百到数千个合成会话，测 `grep -r`、`find` 的耗时、主线程卡顿和峰值内存（桌面与手机），确认不做索引是否可接受。
- 运行时探针：在 Worker 里加载 Pyodide，测首次下载体积、冷启动时间、手机内存；验证“运行前复制文件、运行后写回”的开销；验证 JS 沙箱（sandboxed iframe/Worker + CSP）确实无法联网。
- 用合成长历史测 `deepseek-flash` 使用 `ls`/`grep`/`sed` 的稳定性：参数是否正确、是否会翻页、是否会先读 `/INDEX.md`。
- 验证追加式裁剪旧 `tool_result` 时前缀缓存是否仍命中。

### 阶段 B：文件服务与虚拟文件系统

- 先做一个不依赖存储的纯函数 `resolveDirectory(session, messageId)`（放在 `branches.ts` 或新模块）：给定消息路径和提交（可选内存缓存），返回目录清单。用 `appendBranch` / `selectVersion` 构造的合成树做属性测试，覆盖重新生成、编辑、继续生成和深链。再把 `commit` 加进消息类型并接存储，最后才是文件服务和 Agent 循环；导出不需要为提交做 ID 映射（见 7.1）。
- 新增 `workspaceFiles` 数据 store（对话 ID + 相对路径）与迁移。
- 实现文件服务层（4.1）：挂载表、按对话 ID 的写权限、`list/read/write/move/delete/pack`；写入合成为挂在回复上的提交，并回报给轨迹。
- 实现 `/INDEX.md`、`/chats`（含对话下的 `attachments/`）只读投影、当前对话目录的可写部分，以及 `/skills`；文本投影格式先定稿并写入文档。
- 用 just-bash 接入文件系统接口，Shell 运行在 Web Worker，添加执行限制和取消。
- 接入 Pyodide 与 JS 沙箱 Worker（4.4）。
- 验证重新加载页面后当前对话目录的文件仍存在、其他对话的写入被拒绝、聊天源数据保持不变。

### 阶段 C：客户端 Agent loop

- 扩展 API 类型和 SSE 解析，保留客户端 tool-use blocks。
- 实现工具注册、参数校验、调度、错误结果和轮数上限。
- 在现有 `streamReply` 中编排模型/工具多轮，持久化可恢复的执行状态。
- 仅在附件工具被调用时触发 DeepSeek 上传，并按协议带入 file block。

### 阶段 D：界面、备份与完整验收

- 增加附件本地/远端状态、Agent 运行状态、停止操作与工具轨迹展示。
- 跨对话读取时的轨迹提示；轨迹随回复版本保存和切换；Agent 写入记录在轨迹里。
- 确认默认导出仍是纯标准格式（7.1），并完成数据库迁移。
- 在桌面 Chrome 和手机浏览器验证：长会话搜索、文本附件本地读取、PDF 远端兜底、停止/失败恢复、刷新后持久化、备份往返和存储不足提示。
- 以真实规模文本库测量搜索延迟、UI 卡顿、峰值内存、文件结果 token 数和反复引用文件的上下文开销。

## 9. 验收条件

1. 选择、粘贴或拖入附件时没有发起 Files API 上传；浏览器本地仍能在会话中展示附件。
2. 对纯文本附件执行本地搜索/读取，Network 面板无附件 Files API 上传；只有受限片段出现在模型请求中。
3. 对需要远端解析的合成 PDF，只有 Agent 调用读取工具后才上传；使用返回的 `file_id` 完成一次 DeepSeek 回答。
4. 同一附件的有效 `serverId` 会复用；历史请求不自动重复附加所有旧文件块。
5. 模型返回未知工具、无效路径、超长输出或工具调用超限时，Agent 安全结束并向聊天状态显示明确错误。
6. Agent 正在执行工具时可以停止；刷新后能恢复或清晰标记未完成状态，不会伪装成已完成回答。
7. 当前对话目录中 Agent 写入的文件在刷新后仍存在，且 ZIP 导出后可恢复；聊天原始消息与附件不会被 Shell 修改。
8. 在对话 A 中，Agent 对对话 B 的目录只能读，任何写入、移动、删除都返回明确错误；默认情况下 Agent 不主动浏览其他对话，用户明确提到时才读，并在轨迹中显示“读取了对话《标题》”；B 被删除后读取返回明确错误。
9. 默认导出的 ZIP 与现在结构一致：`export_format_version: 3` 标准结构，不含任何 Agent 提交、轨迹或额外条目；有 Agent 提交的会话导出后，在现有导入逻辑里能正常导入，聊天内容和分支与导出前一致。
10. 重新生成和编辑仍新增分支版本，旧版本及其工具轨迹可切回；切换版本时显示对应版本的轨迹，请求历史不含其他版本的工具往返；Agent 写入的文件在轨迹里可见；切换版本后，对话目录的内容与该分支路径一致（在 A 分支写的文件在 B 分支不可见，除非 B 的祖先链中有它）。
11. Python 与 JS 脚本可读写当前对话目录，且无法联网、无法写其他对话目录；在目标规模的合成数据上，`grep -r` 与脚本检索在桌面和手机上达到阶段 A 定下的延迟目标，界面无明显卡顿。

## 10. 关键风险与交接提醒

- **工具协议组合待证实：**tool_result 与 document file block 的同一 user 消息需真实 API 验证。
- **文件可能被永久保存在 DeepSeek 账号中：**上传应设有效期；本地文件被删除不代表远端文件已删除。
- **长上下文可能被附件膨胀：**模型引用文档后会把完整解析内容保留在上下文；请求构造器必须区分“本地保存附件”和“本轮发送附件”。
- **浏览器内执行不等于本地推理：**Agent 的决策来自 DeepSeek，工具输出会发回 DeepSeek。
- **当前仓库已有未提交改动：**实施前保护现有工作；优先按阶段提交，避免顺手重构登录、导入和聊天持久层。

## 10.5 上下文压缩（已实现，只支持官方 DeepSeek）

**用户无感**：界面、消息树、分支切换完全不变，压缩只改变发给模型的那部分历史。

参照 pi 的 compaction（MIT；`packages/coding-agent/src/core/compaction`）和 DeepSeek Harness 的 `compaction-basic`。pi 本身不能直接用：`pi-agent-core` 引用 `node:fs`、`child_process`、`os`、`path`、`crypto`，`pi-ai` 依赖 AWS/Google/Mistral/OpenAI 等多家 SDK，三个包都要求 `node >= 22.19`，`session-manager` 直接读写文件，所以只移植了它的算法思路，没有引入依赖。

- **参数**：窗口 1,048,576 token（官方 `/models` 列表声明）。预估的**下一次请求**超过窗口的 **90%** 就压缩；压缩后原样保留最近约 **50%** 的窗口；另按窗口的 3% 预留给下一轮的思考、回复和工具往返。溢出补救时保留比例降到 25%。
- **大小怎么算**：用接口返回的真实用量。实测（2026-11-16）官方 `input_tokens` **不含缓存命中**：同一个 2297 token 的请求，首次 `input_tokens` 是 2297，之后是 249 加 `cache_read_input_tokens` 2048。所以上下文 = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`，再加上那条回复的输出。没有用量（导入的历史、刚压缩完）才按字符估算：ASCII 约 4 字符一个 token，非 ASCII 按 0.75 个，偏保守，**这个比例没有用分词器验证过**。
- **切点**：从最新的轮次往旧累加，取满足保留额度的最小集合；只在提问处切，不拆开一轮；全部轮次都不到保留额度时不压缩。
- **存在哪**：`Message.compaction`（摘要、保留起点的提问 ID、压缩前预估的 token 数），挂在**提问之前的最后一条消息**上，所以同一位置的多个回复版本、编辑过的提问共用同一份摘要，重新生成不会重复摘要；路径不经过这条消息的分支用不到它（在压缩点之前分叉的分支看到完整的早期历史）。不是树里的新节点，导出时不带（有测试保证）。
- **怎么发给模型**：压缩点之前的轮次不再发出，摘要包在 `<conversation-notes>` 里并进第一条保留的用户消息（保持用户和助手严格交替），并告诉模型把它当作自己的记忆、不要提到它的存在。
- **摘要请求**：同一个模型，不声明工具、不要标题、不开思考，保留安全审核，输出上限 8192 token。提示词按剧情设计：故事与话题进展、人物与关系、世界与已确立的事实、当前情形、未了结的线索与承诺、语气与视角、用户的偏好与指示；要求保留名字、数字、决定，不编造，用对话所用的语言。旧内容超过窗口 25%（最多 25 万 token）就分块迭代摘要：每块带着上一块得到的笔记，所以导入的超长历史也能处理。
- **失败不挡聊天**：摘要请求失败就照原样发送，下一轮再试（失败期间这一轮的请求可能偏大）。
- **溢出补救**：请求被判为上下文溢出（HTTP 400/413 加通用关键词匹配）且还没收到内容时，更狠地压缩一次后重发。

**已验证：** 假服务端上 5 个场景（长对话压缩且用户无感、重新生成复用摘要、压缩点之前分叉的分支看到完整历史、摘要失败不挡聊天且之后分块迭代、溢出补救）；真实 API 上小规模验证（1 个剧情例子，约 1,100 字符的中文摘要结构完整、关键事实都在、没有编造；压缩后的请求形状被接受；模型答出了只存在于被压缩部分的细节，没有把笔记说出口）。

**未验证 / 已知缺口：**
- **DeepSeek 上下文溢出的错误文案没有验证**（要验证得真发一个超过 104.8 万 token 的请求，费用不低）；pi 的检测表里没有它。目前只靠通用关键词，匹配不到就按普通错误处理。
- **100 万 token 规模的真实表现没有测过**：摘要请求读几十万 token 的耗时和费用、接近满窗口时的首字延迟、摘要质量是否随层层迭代而下降。
- 非 ASCII 字符的 token 估算比例没有校准。
- 带附件的轮次进摘要时只保留文件名，不含文件内容。
- “刚压缩完的回复用量已过期”的判断在测试里区分不出来：压缩后剩下的轮次恰好是满足保留额度的最小集合，再算一次也找不到可压的内容，所以去掉它结果一样。它只是省一次无谓计算。
- 摘要不可见、不可编辑、不可撤销（按用户的决定，无感）。

## 11. 决策记录与待确认

已定：

| 问题 | 决定 |
| --- | --- |
| 跨对话范围 | 默认只在当前对话目录工作；用户明确提到才读其他对话；内置 skill 说明查阅方式；其他对话只读 |
| 每个对话的可写位置 | 各自的对话目录；没有全局共享 `/workspace` |
| Agent 是否默认启用 | 默认启用，统一流程 |
| 重新生成 / 编辑 | 保留现有分支能力（用户主要是剧情玩家）；Agent 轨迹挂在各回复版本上 |
| 工作目录与分支 | 目录状态随分支路径推导（分层提交模型，借鉴 LayerFS），不用共享可变目录 |
| 附件上传 | 默认不上传，Agent 读取时才上传 |
| 全文索引 | 不做 |
| 导出格式 | 默认纯标准格式，目标是别的 DeepSeek 能导入；Agent 数据不进默认导出，“带 Agent 数据导出”作为以后的可选项 |
| 文件管理界面 | 暂不做 |
| 代码运行时 | 第一版 Pyodide + 沙箱 JS（just-bash 浏览器版不支持 python3 与 js-exec） |

仍待确认：

| # | 问题 | 倾向 | 影响 |
| --- | --- | --- | --- |
| 1 | 提交清单内联在 `AssistantMessage.commit`，还是独立 `workspaceCommits` 表（键 `(sessionId, messageId)`） | 内联（Fable 倾向；Opus 倾向独立表但指出键要含 sessionId）。内联会让单次整会话 `put` 变大，需要用合成长会话实测 | 数据一致性、`saveSession` 写入量 |
| 1a | 标记清除回收 Blob 的触发时机，以及内存缓存的容量 | 删除对话后和用户清理空间时触发；缓存容量实测后定 | 存储占用、读取延迟 |
| 1b | 附件是否并入内容寻址存储 | 不在第一阶段；最早在界面阶段之后，只迁字节（`files.blob → files.hash`），保持附件 ID 和 `serverId` 语义不变 | 迁移风险 |
| 1c | 会话/消息树是否迁入分层存储 | 不迁（两位评审都明确反对），消息树仍是唯一真相 | 避免第二份真相 |
| 2 | 当前对话目录内哪些位置可写（`chat.md`、`attachments/`、`.branches/` 之外的全部，还是限定在子目录） | 之外的全部可写 | 目录约定、导出条目命名 |
| 3 | 旧 `tool_result` 的裁剪策略和上限 | 追加式折叠，阈值由实测决定 | 上下文占用、缓存命中 |
| 4 | 远端文件的过期时间默认值 | 设明确的短期限，本地 Blob 保留 | 费用、失效处理 |
| 5 | 手机端支持范围与最低浏览器版本（Worker、IndexedDB 配额、后台被杀） | 阶段 A 就在手机上验证 | 是否需要降级方案 |
| 6 | 不可信内容（附件、其他对话）诱导模型写文件时是否提示用户 | 工具输出一律按数据处理，写入在轨迹中可见，覆盖已有文件前确认 | 安全与交互 |
| 7 | 是否需要真实 Node/npm 或系统工具 | 暂不需要；需要时评估 WebVM/CheerpX（先确认授权） | 运行时选型、体积 |
| 8 | Python 文件桥接用“复制进内存文件系统”还是 `SharedArrayBuffer` 同步桥（需跨域隔离头） | 第一版复制，阶段 A 验证 | 大文件开销、跨域隔离响应头 |

## 参考

- [DeepSeek Anthropic API](https://api-docs.deepseek.com/guides/anthropic_api/)
- [DeepSeek File Parsing](https://api-docs.deepseek.com/guides/document_parsing/)
- [DeepSeek Files API](https://api-docs.deepseek.com/guides/files_api/)
- [just-bash](https://github.com/vercel-labs/just-bash)
