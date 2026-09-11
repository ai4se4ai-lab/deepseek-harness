---
description: "面向用户与维护者的本地工作区 @file 补全提供方，用于启用、调整规模或排查 ctx.fileReferences 的发现能力。"
kind: "package-reference"
---

# @deepseek-ai/dsh-file-reference-local

[English](README.md) | 中文

## 概述

agent（智能体）及宿主 UI 可以用各 agent 本地工作区中经过排序的路径补全 `@file` mention；有界发现让大型仓库也能保持响应迅速。结果会在工具活动后刷新且不会阻塞补全，并且始终不会跟随目录符号链接。当 `read` 可用时，模型还会收到关于如何理解引用路径的稳定指引。当 `read` 使用 Harness 宿主文件系统时选择本包；远程或虚拟命名空间需要与之匹配的发现能力。

## 目录

- [使用本包](#use-this-package)
- [引用文件内联](#referenced-file-inlining)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当 `@file` 补全应发现 Harness 宿主自身的文件系统——即随附 `read` 工具所操作的命名空间——时，挂载此提供方。每个 agent 的工作区从该会话的工作目录开始建立索引；会话没有工作目录时回退到宿主进程目录。

### 启用提供方

默认设置适合典型工作区，因此最小挂载无需任何配置：

```yaml
- name: '@deepseek-ai/dsh-file-reference-local'
  config:
    maxResults: 20
```

### 你能得到什么

在宿主 UI 中输入 `@` 会为指定 agent 返回至多 `maxResults` 个排序路径候选。包含 `/` 的查询直接列出匹配目录的条目；裸查询对有界递归索引做模糊排序。目录候选以尾斜杠保持 mention 开放。任何工具结果之后，该 agent 的索引会被标记为陈旧：下一次查询仍由它作答，其替代品在后台构建，因此重建不会挡在光标前面。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxResults` | `20` | 单次查询返回的排序候选最大数量 |
| `maxEntries` | `50000` | 每个 agent 工作区建立索引的文件与目录最大数量 |
| `excludedDirectories` | `['.git', 'node_modules', 'dist', 'build', 'out', 'coverage', 'target', '.next', '.nuxt', '.turbo', '.venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.gradle']` | 遍历与候选中排除的目录基名 |
| `inlineReferencedFiles` | `true` | 将 `@` 引用文件的内容折叠进运行时上下文。 |
| `maxInlinedFiles` | `5` | 单次快照内联的最大不同引用路径数，按最新引用优先。 |
| `maxInlinedBytesPerFile` | `524288` | 单个引用文件在按名称列出（而非内联）之前的字节上限。 |
| `maxInlinedCharsPerFile` | `60000` | 单个文件内联文本在截断行之前的字符上限。 |
| `maxInlinedCharsTotal` | `160000` | 单次快照中所有内联文件的字符总上限。 |

所有数值都必须是正的安全整数，所有排除名都必须是不含 `/` 或 `\` 的非空基名。

-----

<a id="referenced-file-inlining"></a>
## 引用文件内联

选中一个 `@path` 只贡献一个路径；较小或调用工具不够积极的模型随后会针对它从未打开过的文件作答。当 `inlineReferencedFiles` 开启（默认）时，提供方安装一个按 agent 的 `system-prompt/assemble` 贡献方，读取用户以 `@` 引用过的文件——跨所有用户回合，最新引用优先——并将其当前文本折叠进运行时上下文快照，因此 `.md`、`.txt` 或 `.pdf` 无需 `read` 调用即可出现。PDF 会以其提取的文本层内联（[`@deepseek-ai/dsh-tool-fs`](../../fs/tool-fs)的 `extractDocumentText`）。每个文件的提取按其文件系统版本缓存，因此一个回合内的多个步骤只会重新 stat 而不会重新读取。超过 `maxInlinedBytesPerFile`、位于工作区之外或没有可读文本的文件会按名称列出并说明原因，并指向模型使用 `read`。内联文本中的 `{{` 与 `}}` 会用零宽空格分隔，因此引用的模板文件不会破坏快照的 `{{variable}}` 插值。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方的设计；可观察行为见[使用本包](#use-this-package)。

### 设计理念

提供方为每个 agent 维护一个可复用的 `WorkspaceFileSearch`，以该会话的 `cwd` 为根。目录范围查询（`a/b/...`）列出实时目录状态，裸模糊查询共享一次有界递归遍历。每个工作区仅首次裸查询会等待该遍历；`tool/result` 事件把已完成的条目标记为陈旧，下一次裸查询在替代品构建期间继续由它作答。模型指引是按 agent 的提示词段，仅在指定 agent 拥有 `read` 工具时贡献；agent dispose（资源释放）时会同时释放索引与提示词 fiber。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `LocalFileReferenceService`：配置校验、按 agent 搜索、提示词安装 |
| [`src/search.ts`](src/search.ts) | `WorkspaceFileSearch`：遍历、排序、排除、陈旧标记与后台重建 |
| — | 不发布运行时不变式伴生入口；按 agent 的 index 是私有 advisory cache，其失效与 dispose 行为通过服务测试直接观察。 |

### 主要流程

`list(agent, query, signal)` 要么列出某个目录的条目，要么读取共享的有界索引，对候选排序（精确、前缀、子串，再到子序列得分，目录有加成），并按确定性顺序返回至多 `maxResults` 个。`tool/result` 事件把指定 agent 的索引标记为陈旧；下一次裸查询仍从旧索引返回结果，同时在后台构建替代索引。不可读或已排除的子目录不贡献候选，而不可读的根目录则让该次遍历失败：一次瞬时故障不得用空索引覆盖仍然有效的条目。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

包级约定不够用时阅读以下页面。它们从本提供方所实现的 seam 进入其候选所指向的工具。

- [文件引用 seam](../file-reference/README.zh.md)——本提供方所实现的服务约定与 `@file` 语法。
- [会话引用子系统](../../../docs/subsystems/session-reference.zh.md)——宿主 UI 背后的共享文件引用约定。
- [文件系统工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-fs)——发现能力必须匹配其命名空间的 `read` 工具。
- [上下文组地图](../README.zh.md)——相邻的请求上下文包。

-----

<a id="model-experience"></a>
## 模型体验

### `read` 可用时的文件引用指引

#### 模型看到的内容

当指定 agent 有实际生效的 `read` 工具时，提供方会贡献以下稳定的系统提示词段：

##### 文件引用指令

```markdown
Tokens prefixed with @ are workspace paths the user explicitly referenced, relative to the workspace root. A trailing slash marks a directory: list it when its contents matter. Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading. @"..." quotes a path containing spaces.
```

#### Token 影响

该影响有条件且固定：只要 `read` 对指定 agent 可见，这一句就会存在；候选查询本身不增加 token，所选路径只会贡献普通用户消息中的对应字符。

#### KV Cache 影响

该稳定句子会加入系统提示词前缀。挂载或移除此提供方，或者改变 `read` 是否可见，都会改变该前缀；查询、候选项和索引陈旧标记不会改变前缀。

### 运行时上下文中的引用文件内容

#### 模型看到的内容

当 `inlineReferencedFiles` 开启且会话的用户回合中包含能解析为工作区下可读文件的 `@path` 引用时，运行时上下文快照会新增一个 `context:referenced-files` 段：一行简短引导，随后每个文件以 `----- <path> -----`（PDF 为 `----- <path> (extracted text) -----`）开头列出其文本，在单文件或总量字符上限处以 `[… truncated; use the read tool for the rest …]` 截断。无法内联的文件会在结尾的 `Referenced but not inlined (use the read tool): …` 行中按名称列出。

#### Token 影响

受 `maxInlinedFiles`、`maxInlinedCharsPerFile` 和 `maxInlinedCharsTotal` 约束。该段随运行时上下文快照发送，每回合替换上一版本而不是持续累积。

#### KV Cache 影响

该快照位于稳定系统提示词前缀之后，因此内联内容不会扰乱前缀复用；引用文件集合变化时，只是把快照当作一条普通的追加运行时上下文消息重新发出。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明该提供方何时不合适。它们是当前包约束。

- **宿主本地命名空间**：提供方扫描 Harness 宿主的文件系统，因此远程或虚拟 `read` 实现需要使用命名空间与该工具一致的提供方。
- **有界的提示性索引**：超大型工作区可能省略 `maxEntries` 之后的路径；被排除或无法读取的目录不会出现。默认排除项只列没有任何生态用作源码目录的构建产物；`lib` 被刻意排除在外，因此构建进 `lib` 的工作区需通过 `excludedDirectories` 自行加上。
- **一次失效的陈旧窗口**：紧接工具结果之后的裸查询反映的是上一次遍历时的目录树；下一次查询才看到重建结果。
- **没有忽略文件语义**：`.gitignore` 和其他项目忽略文件不会影响发现；系统只排除已配置的目录基名。
- **内联仅支持文本与 PDF**：引用的图像、压缩包或其他二进制文件只按名称列出而不内联；图像请使用 `read_image`。PDF 内联是文本层提取，不是 OCR。
- **引用检测仅依赖语法**：`collectReferencedPaths` 重新扫描用户消息文本中的 `@path` / `@"path"` token；不查询编辑器的结构化引用表，因此被编辑打断的引用不会被内联。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
