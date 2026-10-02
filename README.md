# Tencent Meeting Export

Tampermonkey userscript for exporting Tencent Meeting public-share pages to readable Markdown, including AI summaries, todos, and complete transcripts.

这是一个在浏览器本地运行的 Tampermonkey Userscript。它从腾讯会议公开分享页面读取当前用户正常有权查看的数据，并在本地生成易读的 Markdown；可选保存经过筛选的 Raw JSON。会议内容不会上传到第三方服务。

## 项目介绍

脚本适用于腾讯会议公开分享页（`/cw/...`），可以导出：

- AI 会议纪要
- 待办事项
- 完整逐字稿
- 合并后的 Markdown 文件
- 可选的 metadata、minutes、summary Raw JSON 文件

脚本使用当前公开分享页使用的 Web API 和响应结构。相关页面或接口更新后，脚本可能需要适配；遇到无法确认完整性的情况，脚本会报告不完整，而不是把部分结果伪装成完整导出。

## 功能

- 自动从当前腾讯会议分享页读取会议标题、开始时间和会议时长。
- 遍历逐字稿的全部分页，兼容 paragraph → sentence 层级，并统计最终 transcript entry 数量。
- 要求分页明确以 `more=false` 结束，并检查 cursor 是否正常推进。
- 任意中间页失败、分页状态缺失或响应 schema 不符合预期时，逐字稿会被标记为不完整。
- 连续同一发言人的句子只在 Markdown 展示层合并；原始 sentence/entry 顺序和内容仍保留在内部结果及可选 Raw JSON 中。
- 将逐字稿相对时间戳转换为人类可读的 `时:分:秒` 格式。
- AI 纪要、Todo 和 Transcript 可以一起导出为易读 Markdown，也可以选择分别导出纪要和逐字稿。
- 可选保存经过字段筛选的 metadata、minutes、summary Raw JSON，便于调试当前页面 API 的变化。
- 失败模块与成功模块独立处理：例如纪要失败时，已经确认完整的逐字稿仍可单独导出，界面会明确提示部分成功。
- 下载文件使用唯一文件名，避免再次执行时静默覆盖已有导出文件。

## 安装方法

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展。
2. 打开 [tencent-meeting-export.user.js](https://github.com/EngraftMeNew/tencent-meeting-export/blob/main/tencent-meeting-export.user.js)。
3. 点击 GitHub 页面右上角的 **Raw**，或直接打开下面的 Raw 地址：

   [安装 / 查看 Raw Userscript](https://raw.githubusercontent.com/EngraftMeNew/tencent-meeting-export/main/tencent-meeting-export.user.js)

4. Tampermonkey 应自动进入安装页面。
5. 确认安装并返回腾讯会议分享页。

脚本包含 Tampermonkey metadata header，并使用 `@match https://meeting.tencent.com/cw/*` 匹配腾讯会议公开分享页。当前版本没有配置 `@updateURL` 或 `@downloadURL`；可从仓库 Raw 地址手动更新。

## 使用方法

1. 正常打开一个你本身有权限查看的腾讯会议分享页面，例如 `https://meeting.tencent.com/cw/...`。
2. 等待页面加载完成，页面中会出现 **导出会议** 按钮。
3. 点击按钮，选择要导出的内容：AI 纪要和待办、完整逐字稿、Raw JSON，以及是否分别保存纪要和逐字稿。
4. 点击开始导出，浏览器会下载 Markdown 文件；如果选择了 Raw JSON，也会下载对应的 JSON 文件。
5. 如需查看分页、段落、sentence/entry 数量和首尾时间戳等诊断信息，可在导出后打开导出详情。

脚本只处理当前页面实际返回且用户正常可以查看的数据，不提供绕过访问限制的功能。

## 导出示例

以下内容完全虚构，仅用于展示 Markdown 结构：

```markdown
# 示例项目讨论会

- 时间：2026-10-01 14:00
- 时长：32:15
- 发言人：张三、李四

## AI 纪要

本次会议讨论了实验安排、文档整理和下一阶段的交付计划。

## 待办事项

- [ ] 完成实验
- [ ] 整理文档

## 完整逐字稿

**[00:04] 张三：**

大家下午好，我们开始今天的讨论。

**[00:15] 李四：**

好的。
```

## 权限与隐私

- Userscript 不绕过腾讯会议的访问控制。
- 用户必须本身拥有正常查看该分享页及其内容的权限。
- 脚本不读取、保存或导出 `document.cookie`、token、Authorization、密码或其他认证凭据。
- 脚本不向第三方服务器上传会议内容。
- 数据请求使用当前页面的同源浏览器请求环境，仅用于读取用户正常可以访问的腾讯会议页面数据。
- 可选 Raw JSON 只保存会议 metadata、分页响应和纪要相关结果，并对凭据形状的字段进行过滤。

## 完整性设计

逐字稿导出会逐页读取 transcript 数据，并验证：

- 所有 paragraph 下的 sentence 都被展开为最终 transcript entry；
- 分页 cursor 持续推进，不重复或停滞；
- 分页响应包含明确的布尔结束状态；
- 只有明确取得 `more=false` 时，才标记为完整导出；
- 任意中间页失败、schema 变化或结束状态无法确认时，结果保持 INCOMPLETE。

展示层可以把连续同一发言人的句子合并为更易读的段落，但这种合并不删除原始 transcript sentence，也不改变其顺序。纪要和逐字稿分别判断成功状态，一个模块失败不会阻止另一个已经确认完整的模块导出。

## 已知限制

- 腾讯会议网页或 Web API 可能更新，导致当前脚本暂时失效或进入 INCOMPLETE 状态。
- 当前脚本只适配明确支持的腾讯会议公开分享页面 `/cw/*`。
- 需要用户本身拥有正常访问权限；脚本不提供登录、密码、验证码或权限绕过能力。
- Raw JSON 是为当前页面结构提供的调试输出，不承诺跨版本 schema 永久稳定。
- 浏览器对同名下载文件的最终命名行为可能因浏览器设置而不同；脚本每次导出都会使用新的候选文件名，避免主动静默覆盖。

## License

本项目使用 [MIT License](LICENSE) 发布。
