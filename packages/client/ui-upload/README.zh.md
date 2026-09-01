# `@deepseek-ai/dsh-client-ui-upload`

[English](README.md) | 中文

Web `/upload` 命令。注册一个 `/` 输入触发源（`order: 3`，与 `ui-commands`、`ui-skill` 并列），其唯一的 `upload` 候选项会打开原生文件选择器——由插件在其生命周期内持有的常驻隐藏 `<input type="file">` 驱动。所选文件以规范 base64 读取，发送到宿主 Remote `workspaceUpload.put`，后者将其写入 `<会话 cwd>/files/`。成功后，触发源清除 `/upload` 词元，并（通过共享的 `@deepseek-ai/dsh-file-reference` 语法）向草稿追加一个 `@files/<name>` 引用，使该文件沿普通的 `@path` 管线进入模型的下一轮。

客户端 10 MB 预检把明显超大的文件挡在传输之外；`@deepseek-ai/dsh-workspace-upload` 的 `maxBytes` 配置才是权威，会对解码后的载荷再次校验。字节上限、读取失败与宿主拒绝都通过 `SessionInput.notify` 以编辑器提示形式呈现；草稿绝不会残留一个半成品命令。

## 模型体验

间接。本插件本身不贡献任何模型可见输入：上传的文件只有作为它拼接进草稿的 `@files/<name>` 路径文本才对模型可见，宿主的 `file-reference` 指引会告诉模型去 `read` 它。

#### KV 缓存影响

无；本包既不组装也不发送提供方请求。拼接的 `@files/<name>` 文本仅改变新的用户消息后缀。

## 已知限制与后续工作

- **仅菜单选择** —— 该源既未实现 `matchSpace` 也未实现 `matchEnter`，因此在菜单已关闭时把 `/upload` 作为整行提交会退化为普通提示词，而不会打开选择器。
- **无进度或附件卡片** —— 大文件上传在落定为提示之前不显示任何内容；没有轨道条目或上传进度展示（有待编辑器支持非图片附件）。
- **每次调用一个文件** —— 选择器为单选；上传多个文件需多次运行 `/upload`。
