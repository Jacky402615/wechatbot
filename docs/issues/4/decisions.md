# decisions.md — issue 4（Attachments: media decrypt + download, voice/video archive-only）

- 日期：2026-09-13（r1，self-grill + codex-eval `kind=options` 一轮）
- 评审结论：`needs-attention`（11 项裁定全部方向性同意，其中 7 项附实质强化，全部采纳；1 项 AC4 语义收紧按更安全方向消解，无需人工；0 项信息缺口）；plan 轮 R1/R2/R3 亦 `needs-attention`（12 + 5 + 2 项 findings 全部处置——见「plan 评审 R1/R2/R3 修订」节；R2 含 1 项事实性否决）
- 依据：issue 描述（内嵌 SRS 节，spec Q8/Q12）+ `@wecom/aibot-node-sdk@1.0.7` 源码实测（`dist/index.cjs.js`：`WSClient.downloadFile`/`WeComApiClient.downloadFileRaw`/`decryptFile`；`.d.ts`：`ImageContent/FileContent/VideoContent={url,aeskey?}`、`VoiceContent={content}`、`message.image/file/voice/video/mixed` 事件）+ W1–W3 代码勘察（分派序、prompt 通路、`.bot/` 脚手架）

## D1: transport 事件面 — 统一 mediaMessage 事件

**选定 (a)+强化：单一类型化事件** —— `TransportEvent` 增 `{ type: 'mediaMessage'; message: InboundMediaMessage }`；`InboundMediaMessage = { msgid, chatType, chatId?, userId, kind: 'image'|'file'|'voice'|'video', url?, aeskey?, replyTo }`（**url/aeskey 可选**——plan 评审 R1-F1：缺 url 的协议异常帧仍上抛事件、由 handler 走 D8 错误面，adapter 不得静默丢）。adapter 订阅 SDK `message.image|file|voice|video` 四事件并映射到统一形状（voice 的 url/aeskey 按运行时字段防御式读取——SDK `.d.ts` 的 `VoiceContent` 只声明 `content`，见 D7/D12）。帧内无 filename/size/MIME 字段（协议不携带），文件名在下载时从 Content-Disposition 获得（D6）。
理由：(b) 四分事件徒增分派面；(c) 复用 textMessage 是类型混淆（W3 D7 同判）。
Codex 强化（采纳）：元数据契约显式化——kind 判别式联合即类型安全；帧面无元数据可加的事实记录在案。

## D2: 下载能力端口 — WeComTransport 增 downloadFile

**选定 (a)：transport 端口委托 SDK** —— `WeComTransport` 增 `downloadFile(url: string, aeskey?: string): Promise<{ buffer: Buffer; filename?: string }>`，adapter 实现委托 `client.downloadFile(url, aesKey)`（SDK 内建：axios arraybuffer 下载，10 s 超时，Content-Disposition 解析文件名；无 aeskey 原样返回，有则 AES-256-CBC 解密）。媒体模块/AgentHandler 只消费端口；单测 FakeTransport 打桩。
理由：(b) 破坏 transport 抽象、测试不可替身；(c) 违反 Q12（no hand-rolled crypto）。
Codex 强化（采纳，简化形）：错误分类不必五类——下载/解密任何 throw 统一走 D8 的关键终帧错误路径（用户可见语义相同：短错误回执），底层 message 入日志；oversize/empty 在 buffer 返回后判定（D8）。

## D3: 模块归属 — src/media.ts 纯模块 + handler 薄编排

**选定 (a)：纯模块 + 薄编排** —— 新增 `src/media.ts`：`MediaStore`（save/sanitize/prune——纯 fs 逻辑，独立单测）与纯函数 attachment-note 构造器；`AgentHandler.onMedia` 只做编排：群守卫 → access gate → expireStaleAsk → download（经端口）→ save → note → submit。
理由：(b) handler 内联不可测且策略重复；(c) 并行 handler 无传播控制（W3 D1 已否决同构提案）。
Codex 强化（采纳）：handler 恒薄——存储/消毒/文案全部下沉 media.ts。

## D4: 分派序与 pending-ask — 媒体绕过作答、照常排队

**选定 (a)：W3 序的媒体变体** —— 群帧守卫（媒体帧带 `chattype=group` ⇒ debug 忽略——平台 single-chat only，D10）→ access gate（p2p tier；非 admin/approved ⇒ 拒绝文案 notice，**不下载**——不为陌生人花费网络/磁盘）→ `expireStaleAsk(chatKey)`（同 text：过期先判，banner 让渡）→ **绝不喂 `answerPendingAsk`**（媒体不可能是数字/文字作答；pending ask 不因媒体失效——用户稍后仍可文字作答）→ download → submit（busy 时入队，回合结束后按批量回合合流——媒体 prompt 与后续排队文本同框）。
理由：(b) 媒体认领 ask 无产品语义；(c) 提示重发即丢弃附件（违反 never-silent-drop 精神）。

## D5: 下载时机 — 过 gate 即下载（5 分钟窗硬约束）

**选定 (a)：入站即物化** —— 过 access gate 后、submit 前立即下载落盘；即使该回合因 busy 排队、或后续 claude 回合失败，附件已物化（URL 5 分钟过期，排队延迟不得吞噬下载窗）。文档化：已授权附件先物化、后消费。
理由：(b) 回合开始才下载 ⇒ 排队 >5 min 即必败；(c) agent 自行下载 ⇒ agent 持有传输凭据/解密职责，且同样过窗。

## D6: 存储布局与文件名 — msgid 前缀 + 消毒名

**选定 (a)+强化：`.bot/uploads/<YYYY-MM-DD>/<safeMsgid>-<sanitized>`** ——
- 日期目录取**本地时区**当日（与 feishubot 对齐；确定性记录在案——不混 UTC）。
- **msgid 本身也是平台输入**（plan 评审 R1-F2）：前缀经 `safeMsgid` 白名单消毒（`[^A-Za-z0-9._-]` → `_`、≤64 字符、空串占位 `_`）——穿越/注入/超长在入路径与 prompt 前被拦。
- sanitize：去路径分隔符（`/`、`\`）、去控制字符与换行（**prompt 注入防线**——见 D7）、连续空白折叠、保留安全扩展名、名字段截断至 ~120 UTF-8 字节（**截断发生在保留扩展之后**——扩展不丢）。
- Content-Disposition 缺文件名 ⇒ fallback `<safeMsgid>-<kind>.<ext>`（image→jpg、voice→amr、video→mp4、file→bin——平台格式惯例；**统一命名序 plan 评审 R1-F3**）。
- safeMsgid 前缀 = 碰撞安全 + **同 msgid 重投递幂等覆盖**（有意语义，记录；回合级不去重——排重是平台责任，与 text 路径同构）。
理由：(b) 路径穿越/碰撞/控制字符风险；(c) 内容哈希名损失可读性且需额外索引保幂等。
Codex 强化（采纳）：扩展保留后截断、时区确定化、同 msgid 覆盖显式化为幂等设计、msgid 消毒、fallback 命名序统一。

## D7: prompt 组装 — 路径 note（非嵌入、非 ASR）

**选定 (a)+强化：纯函数 note，元数据定界，文件名按不可信数据渲染** ——
- image/file：`[附件] 用户发送的图片/文件 …` + **绝对路径** + 字节数 + 提示 agent 用 Read 工具查看（claude cwd=workspace，绝对路径无歧义）。
- voice/video：归档绝对路径 + 显式声明「内容已归档但 v1 无法解析（无转写）——请告知用户以文字复述或改发可解析材料」。
- **忽略 SDK `VoiceContent.content`（平台 ASR 字段）**——issue 判 voice 不可解析、转写 v2+；引入 ASR 文本即越界（v2 议题，D12 记录）。
- 注入防线：note 模板由我方代码固定，唯一变量是路径（msgid 前缀 + D6 消毒——换行/控制字符已剥，无法伪造多行指令）与字节数；文件名即不可信数据，消毒后仅作路径成分。
理由：(b) 违反 v1 转写边界且 ASR 缺失时行为不一致；(c) base64 嵌入 token 膨胀、二进制脆弱、无工具调用溯源。

## D8: 失败面 — 下载失败走关键终帧（AC4 硬保证）；降级面走 note

**选定 (a)+强化（AC4 语义收紧）**：
- **下载/解密 throw（过期 URL、网络、bad aeskey）⇒ 关键终帧路径**（`criticalFinal` 同款：有界等待预算 ≤25 s → 强制发送 + `record()` 逃逸记账 + ERROR 日志）——**不走可丢弃 notice()**。codex 指出：notice 预算耗尽即丢，作为 AC4「not silence」的载体语义含糊；关键终帧路径消除含糊（每次入站媒体至多一条错误回执，成本可忽略）。不 spawn claude、不产会话。
- **oversize（buffer >100 MB 防御帽）/ 空 buffer / 落盘失败 ⇒ 降级 note**（归档式「不可用」声明入 prompt，回合照跑）+ warn/error 日志。**100 MB 帽在 SDK 全量缓冲之后判定**（axios arraybuffer 无流式截断；真流式帽需自研下载，违反 Q12）——平台本就限 100 MB 入站，此帽是防御性双保险；内存尖峰风险记入 Risk Notes。
- 任何路径不得静默丢（issue 原文 never a silent drop）。
Codex 裁定（采纳）：AC4 送达语义按严格向消解（关键终帧），无需人工 clamp；(b) 全部错误走保证送达过噪——仅下载失败这一「用户当前消息的应答」需要保证。

## D9: 30 天清理 — 启动 + 每日定时

**选定 (a)+强化：双触发剪枝** —— 网关启动（`createGateway` 装配后）+ 每 24 h `unref()` 定时器；扫描 `uploads/` 下 `YYYY-MM-DD` 形目录名，删除本地日期早于 30 天者；**逐目录 try/catch——失败记日志不抛**（清理面不得打死消息面）；非日期形条目不动。
理由：(b) 每次保存扫描浪费；(c) 违反 retention 要求。
Codex 强化（采纳）：逐目录失败隔离、unref、日期边界确定性（本地时区同 D6）。

## D10: 群媒体帧与 mixed — 双留痕忽略

**选定 (a)：可见地忽略** —— 群类型媒体帧 ⇒ debug 日志忽略（平台 single-chat only；fail-safe 方向——不误收）；SDK `message.mixed` **维持未订阅**（群图文混排 = 群发图路径，v1 out of scope）——SPEC 记 known gap，另立 follow-up issue（不在本 issue 扩张）。
理由：(b) 无需求先行的解析/测试扩张；(c) 平台行为下是死代码。
Codex 强化（采纳）：忽略必须可观测（debug 日志而非真空）。

## D11: 测试策略 — 单测桩端口 + 集成真 SDK 解密

**选定 (a)+强化**：
- 单测：`media.test.ts`（sanitize 边界：路径穿越/unicode/超长/控制字符/扩展保留；布局；30 天剪枝边界：29/30/31 天、非日期目录不动、逐目录失败隔离；attachment-note 渲染与注入防线——换行剥离后单行断言）；`agent-handler.test.ts` 增媒体流（FakeTransport.downloadFile 桩：成功 image/file、voice/video note、下载 throw ⇒ 关键终帧错误 + 零 submit、oversize/empty ⇒ 降级 note、未授权 ⇒ 拒绝文案 + **零下载**、群媒体忽略、pending-ask 期间媒体排队不认领）；adapter 映射（mock server 推四类帧 → 事件形状；群帧忽略）。
- 集成：本地 HTTP 文件服务端 + **测试侧 AES-256-CBC 加密镜像**（PKCS#7 填充至 32 字节块、IV=key 前 16 字节——与 SDK `decryptFile` 互逆；SDK 版本已 pin 1.0.7）；真 SDK `downloadFile` 全链路：文件落 `uploads/YYYY-MM-DD/`、fake-claude `stdin.jsonl` 携带路径 note（AC1/AC2）、voice/video note（AC3）、404 URL 与 bad aeskey ⇒ 站内错误帧（AC4）。
- 回归红线：W1–W3 全量测试保持绿。
Codex 强化（采纳）：分发/消毒/剪枝/notice 丢弃路径全覆盖；加密镜像 pin SDK 版本。

## D12: SDK 契约核验与未验证面

- **已核验（源码实读）**：`downloadFile` 存在且签名如 D2；`decryptFile` AES-256-CBC + 手动 PKCS#7（32 字节块）+ IV=key[:16]；`WeComApiClient` axios 10 s 超时、arraybuffer 全量缓冲、Content-Disposition RFC5987 优先解析；SDK 事件 `message.image/file/voice/video/mixed` 存在（msgtype switch 分发）。
- **未验证（真实平台面，Human-Review 手工清单）**：voice 帧运行时是否携带 `voice.url`/`voice.aeskey`（`.d.ts` 只声明 `content`，平台协议文档称有——adapter 防御式读取，缺失即走 D8 下载失败错误路径，fail-safe）；image 实际格式（jpg/png）；Content-Disposition 文件名真实形状。
- 真机媒体消息（图/文件/语音/视频各一发）列入 Human-Review 证据清单。

## 评审缺失记录

- 无。codex 调用记录：`options` 轮 ×1（verdict: needs-attention，11 项全部方向性同意、7 项强化全部采纳、0 项否决；AC4 语义含糊以更安全方向〔关键终帧〕消解；SDK 契约疑点以源码实读核验，voice 运行时形状列 Human-Review）；`plan` 轮 R1（verdict: needs-attention，12 项 findings：10 采纳、1 部分采纳、1 天然满足——见「plan 评审 R1 修订」）；`plan` 轮 R2（verdict: needs-attention，5 项 findings：3 采纳、1 事实性否决〔AC4 uploads 前置——证据见 R2 节〕、1 采纳——见「plan 评审 R2 修订」）；`plan` 轮 R3（verdict: needs-attention，2 项机械 findings 全部采纳修复——见「plan 评审 R3 修订」。轮次预算 3 已用尽，R3 修复未再跑第 4 轮复验，残余风险由 Step 3.5 自审清单 + 执行阶段 Checkpoint A–D full gate 兜底〔W3 同例〕）。



## plan 评审 R1 修订（12 项 findings：10 采纳、1 部分采纳、1 天然满足）

- **缺 url 帧不静默丢（采纳）**：`InboundMediaMessage.url` 改可选——adapter 对缺 url 协议异常帧**仍上抛事件**（debug 留痕），handler 走 D8 错误面（关键终帧短错误）；原「adapter 忽略缺 url 帧」设计废弃（违反 never-silent-drop）。
- **msgid 不可信输入消毒（采纳）**：新增 `safeMsgid`（白名单 `[^A-Za-z0-9._-]→_`、≤64 字符、空串占位 `_`）——msgid 直入文件路径/prompt 前拦截穿越/注入/超长；D6 落盘名前缀改为 `<safeMsgid>-`。
- **fallback 命名契约统一（采纳）**：D6/Task 1/Task 4/SPEC 统一为 `<safeMsgid>-<kind>.<ext>`（img1-image.jpg 形）——原 D6 文字 `<kind>-<msgid>.<ext>` 与实现矛盾，以实现为准修正决策文字。
- **prune 边界确定化（采纳）**：删除条件 = 目录日期**严格早于**（当日 − 30 天）零点——恰 30 天的当日目录保留（30 天保留期 = ≥30 天可用性）；测试期望同步（2026-08-14 恰 30 天保留、2026-08-13 即 31 天删除）。
- **prune 失败隔离改 removeDir 注入（采纳）**：chmod 0o500 法在 root 环境不失效不可靠——`MediaStore` opts 增 `removeDir?: (dir) => void` 测试注入，确定性覆盖失败隔离与恢复。
- **缺 aeskey 不得落盘密文（采纳）**：长连接模式媒体恒加密——`onMedia` 在下载前守卫 `!m.url || !m.aeskey` ⇒ 关键终帧错误（SDK 无 key 原样返回密文，不得当可解析附件交给 agent Read）。
- **save 失败确定性单测（采纳）**：目标路径预置为目录（mkdir 精确路径 ⇒ writeFileSync EISDIR）——handler 降级分支有编排级验证（degraded note + 单次下载 + submit 照常）。
- **SDK pin 任务门（采纳）**：Checkpoint A 增精确版本核验（package.json 无 `^`/`~` + `bun pm ls` 解析 1.0.7）——加密镜像与 decryptFile 内部耦合的漂移哨兵。
- **follow-up 步骤可执行化（采纳）**：Task 5 Step 2 补 `gh issue create` fallback 命令与 verbatim 正文；看板记录明确为 GitHub 看板评论原位编辑（非 git 文件）。
- **Task 4 确定性化（采纳）**：重定义为确定性证据门——唯一合法首跑失败是 fixture 级（helper 模块缺失），行为级 FAIL 一律回补实现。
- **集成 fixture 修正（采纳）**：Content-Disposition 非 ASCII 走 RFC 5987 `filename*=UTF-8''…`（SDK 优先解析 filename*）；每测试 try/finally（withMedia 包装）防服务端级联泄漏；NO_PROXY 保存原值 afterAll 还原。
- **回合级 msgid 去重（部分采纳——文档化接受）**：codex 建议下载/submit 前去重——**不采纳新增去重状态**：msgid 排重是平台责任（协议「唯一性标志，用于事件排重」），W1–W3 text 路径同构不去重；文件级幂等覆盖已保磁盘。接受「同 msgid 重投递 = 重复回合」并写入 Risk Notes。
- **.bot/uploads gitignore（天然满足）**：`.gitignore` 已含 `.bot/`——Checkpoint B 复核 `git check-ignore` 即可，无需改动。

## plan 评审 R2 修订（5 项 findings：3 采纳、1 事实性否决、1 采纳）

- **旧契约残留清理（采纳）**：Task 5 SPEC 片段与 D1/D6 原文同步 R1 修订后的契约（url 可选 + 异常帧上抛、`<safeMsgid>-<kind>.<ext>` fallback、prune 严格早于语义）；Task 5 Step 3 增旧措辞负检查（`grep -q` 两断言）。
- **prune 读目录错误分级（采纳）**：`catch { return [] }` 只对 ENOENT 静默（脚手架未建安全）；EACCES 等 IO 错误经 `onError` 留痕不抛——新增 `readdir?: (dir) => string[]` 注入，确定性覆盖（chmod 法 root 下失效不可靠，同 removeDir 注入理由）。
- **Task 4 证据门措辞（采纳）**：Step 1 已落 helper ⇒ 首跑不存在「helper 缺失」失败——重定义为 post-implementation PASS-only 证据门（唯一允许的 fixture 修正：NO_PROXY 行、http server 关闭竞态）。
- **follow-up 步骤具体化（采纳）**：gh fallback 命令给全 body verbatim；看板回写给 `mcp__github__update_issue_comment`（comment_id = 本轮看板）与 `gh api … comments/<id> -X PATCH` 双路径。
- **AC4 uploads 目录前置（事实性否决）**：codex 断言「无任务创建 uploads/、AC4 readdirSync 将 ENOENT」——**不成立**：`src/config.ts` 的 `ensureWorkspaceTree` 无条件 `mkdirSync(join(botDir, 'uploads'), { recursive: true })`（config.ts:44），而 `loadWorkspace`（setupMedia 显式调用 + `createGateway` 内部再调，gateway.ts:144）必经此路径——AC4 断言时 uploads/ 必然存在且内容为空数组。

## plan 评审 R3 修订（2 项机械 findings 全部采纳——轮次预算用尽，未跑第 4 轮复验）

- **readdir 注入类型对齐**：Task 1 实现块构造器 opts 类型补 `readdir?: (dir: string) => string[]`（Produces 块与测试已声明，实现块漏同步——typecheck 会拦截，评审先行修正）。
- **验证门措辞矛盾**：Task 1 测试计数 6 → 7（safeMsgid 独立用例后未同步）；Task 5 Step 3 负检查措辞改为「取反命令退出码必须为 0（底层 grep 退出 1 = 无匹配）」。


## code 评审 R1 修订（Building 收尾，5 项 findings：4 采纳、1 部分采纳）

- **存储身份碰撞安全（C-F1，部分采纳——哈希后缀 + 契约精确化）**：`safeMsgid` 有损变换（替换/截断/空）时追加原始 msgid 的 SHA-256 短哈希后缀（`~<8>`）——不同原始 msgid 不折叠成同一存储身份；未受损的常规 msgid 原样保留（可读性）。**同 msgid 异名 = 不同投递内容 ⇒ 独立文件**（不强制 per-msgid 单一规范路径——那会牺牲 AC2 的可读文件名；契约措辞精确化为「同 msgid 同名幂等覆盖」）。测试补：跨 msgid 折叠不碰撞、截断折叠不碰撞、同 msgid 异名两文件。
- **prune 硬化（C-F2，采纳）**：只删**真实目录**（lstat 判定——日期形普通文件/符号链接不动）；日历往返校验（`2026-02-30` 被 Date 归一到 3 月 ⇒ 非真实日期不动）。测试补两类残留样本。
- **mixed 可见忽略落地（C-F3，采纳）**：adapter 显式订阅 `message.mixed` + debug 留痕（msgid/chatid）+ 零事件——兑现 D10「可见地忽略」的裁定（原实现无订阅 = 真空，与 SPEC/CHANGELOG 声明矛盾）；mock 补 `pushMixedMessage`，transport 测试经注入 logger 断言 debug 行。
- **网关剪枝接线测试（C-F4，采纳启动面）**：集成测试播种旧日期目录 ⇒ `createGateway` 后被删、当日保留——`media.prune()` 调用有行为锚点。**24 h 定时器注入不做**（timer 工厂注入属过度工程；`startPruneTimer` 的 unref 语义由单测 + 代码审读覆盖，记录为接受）。
- **残帧守卫（C-F5，采纳）**：缺 msgid/发送者的媒体帧在 adapter debug 忽略（msgid 是存储身份、userid 是会话键——缺失即不可定址；原实现会在 safeMsgid(undefined) 崩进 catch-all）。mock 补 `pushRaw` 原始帧注入，测试断言守卫生效。

## FLAGGED-FOR-HUMAN 汇总

1. **voice 帧运行时 url/aeskey 形状**（D12）：SDK `.d.ts` 的 `VoiceContent` 只声明 `content`（ASR），平台协议称携带 url+aeskey；adapter 防御式读取 `voice.url`/`voice.aeskey`，缺失 ⇒ 失败错误面（D8 关键终帧——不下载不落盘，fail-safe 不误吞）。Human-Review 真机发语音核对。
2. **真实媒体下载链路**（D12）：mock 集成测试锁定协议形状与解密互逆；真实平台 5 分钟窗/文件名/格式的端到端确认列 Human-Review 手工清单（图/文件/语音/视频各一发）。
3. **mixed（群图文混排）不做**（D10）：群发图 v1 不可用——SPEC known gap + follow-up issue；owner 若认为 v1 群图必需，属需求变更另议。
