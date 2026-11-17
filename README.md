# 史稿 | 历史小说工作台

个人本地创作工具。史料、写作规划和正文保存在本机；接入模型前先审阅人物关系与情节方案。

## 本地运行

要求 Node.js 20.9 或更新版本。

```sh
npm install
cp .env.example .env.local
npm run dev
```

打开 http://127.0.0.1:3000 。本地 API Key 只由服务端读取，禁止添加 `NEXT_PUBLIC_` 前缀。

## 百炼模型

- `qwen3.8-max`：写作规格、大纲与章节正文。
- `qwen3.8-flash`：史料结构化提取、关联辅助与规则审阅。
- 北京地域兼容端点：`https://dashscope.aliyuncs.com/compatible-mode/v1`。

在 `.env.local` 配置 `DASHSCOPE_API_KEY`。实际价格和账号可用性以百炼控制台为准，文档价格为查询日快照。未配置 Key 时应用不调用外部服务。

## 状态

已完成 T001-T002 本地工作台和 SQLite 项目创建/列表，T030 古籍书目、来源许可与 robots 核验完成。T031 全量采集正在进行；默认来源是遵循 CC BY-SA 4.0 的 Wikisource 普通书目/卷页，采集器只使用 robots 允许的 `/wiki/` 页面，不调用通用 Action API。

执行 `npm run corpus:fetch` 可启动/续抓，`npm run corpus:fetch -- --book shiji --limit 2` 可做限量测试。产物保存至被 Git 忽略的 `data/local/corpus/wikisource/`；逐书状态和完整率写入 `report.json`。当前 25 部、3,563/3,563 卷页已采集并通过 `npm run corpus:check`，失败卷均已补抓。历史原文获取不等于已完成事实提取或人工史实核定；T032 全文索引仍未实现。

百炼按量模型调用、项目详情、人物关系预览、情节预览及事实提取尚未实现。原文采集完成不代表全文索引、结构化史实或人工核定已完成。
## 本地选人与虚构设定（2026-10-28）

现可保存时间与区域，导入历史 TXT/Markdown，在“补充并核定人物活动证据”中录入原文、活动年份与区域，再从匹配候选勾选人物。多个区域用顿号分隔，目前按名称精确匹配；旧人物缺少活动信息时列入证据不足。可补充核定历史关系，选人或范围变化会重新检查直接、间接关联与孤立人物，显示原文依据。

虚构人物、关系、对白、心理和日常场景支持本地新增、修改和删除，与历史关联分开。当前是手动核定资料的可用流程；默认古籍自动提取、史实冲突审核与正文生成仍待实现。

开发验收可用 `HISTORY_DATA_DIR` 指定独立临时数据目录，在端口 3107 启动应用后执行 `node scripts/test-setup.mjs`。该脚本会创建明确标记的测试作品，应只在隔离目录运行；不发送模型请求。

## MOBI 参考小说与全文试运行

网页“作品资料”现支持未加密 MOBI（仅参考小说类别，最多 32 MB）。转换在本机进行，保留原始 MOBI、纯文本及来源/正文 SHA-256、目录链接检查清单。不会执行电子书脚本或获取远程资源；加密、损坏及无文本文件明确拒绝。转换目录为 `data/local/converted/<sha256>/`，不进入 Git。

先安装一次转换依赖（Python 3.11 或以上）：

```sh
python3 -m venv data/local/tools/mobi-venv
data/local/tools/mobi-venv/bin/python -m pip install -r scripts/requirements-mobi.txt
npm run ebooks:convert -- "data/local/ebooks/你的小说.mobi"
```

可用 `MOBI_PYTHON` 指定网页服务使用的 Python 路径。命令行保留输入文件名；网页上传的原文件按哈希保留，上传名称仍保存于项目资料记录。TXT、Markdown、MOBI 导入本身均不调用商业模型。

本次全文试运行脚本 `scripts/analyze-reference-trial.mjs` 针对已转换的《冰与火之歌》中文五卷和已准备的唐末五代史料：先逐块分析全部提取文本，再汇总抽象写作规格，最后使用史料与规格生成一次原创试写并复核。正文生成上下文不包含参考小说原文。块边界连续且记录字符范围与哈希；前言、目录、附录也保留并提醒模型区分，目录链接有效不等于出版版本完整或模型理解完全。

```sh
npm run trial:reference                 # 只准备覆盖清单与费用估算
npm run trial:reference -- --execute    # 真实按量调用；需用户授权全文外发与本次运行
```

试运行输出在 `data/local/trials/tang-full-reference/`：`coverage-plan.json`、`analysis.md`、`writing-spec.md`、`generation-input.json`、`draft.md`、`review.md`、`report.json`。原文与完整分析仅保存在本地。逐步持久化请求意图与返回用量；已完成步骤按输入哈希复用，未知结果和失败请求不会自动重发。单请求串行执行，执行保护上限 12 元，按官方标价估算不等于供应商账单；该专用试运行脚本尚未接入网页章节管理和完整方案审批流程。结果始终为待人工审核草稿。

验证：`npm run test:mobi` 检查无效/加密文件和本次五卷转换清单；`scripts/test-mobi-http.mjs` 在隔离数据目录运行的 3108 端口服务上验证真实上传、重复导入、分类限制及损坏/加密拒绝。

若调用遇到 `AllocationQuota.FreeTierOnly`，表示供应商免费额度策略阻止继续调用，不是转换失败。确认在控制台解除该限制后，可执行 `npm run trial:reference -- --execute --retry-free-tier`：只允许重试明确返回该 403 的步骤，并保留旧拒绝记录；超时或未知请求不会重发。本次截至第16块已完成，`progress.json` 记录未完成状态，尚无正文产物。

与已运行开发服务并行验证时，使用 `HISTORY_TEST_BUILD=1` 执行构建及启动，产物写入 `.next-test/`，避免覆盖 `.next/`。

百炼北京工作空间专属 API Host 现已支持：`https://llm-<workspace-id>.cn-beijing.maas.aliyuncs.com`。服务端统一补齐 `/compatible-mode/v1`，也接受带完整兼容路径的地址；拒绝非 HTTPS、其他主机、凭证/查询参数和不匹配路径。实际请求使用配置地址，不回退旧公共域名。新地址返回 `insufficient_quota` 时，应检查对应账号与工作空间可用额度；这与免费额度用完即停错误不同。

### Token Plan（2026-10-28 更新）

按用户最新选择，现支持 Token Plan 专属 Key 与 `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`。沿用服务端变量 `DASHSCOPE_API_KEY`、`BAILIAN_BASE_URL`，不会回退按量端点。`qwen3.8-flash` 用于全文分析及复核，`qwen3.8-max` 用于本次正文。旧文档中“只用按量、不使用 Token Plan”的约束已由本次用户要求替代。

Token Plan 返回 Token 用量会持久化，不能据按量价格换算套餐 Credits 或实际账单。旧按量调用的估算单独保留；试运行原有人民币阈值仅作为等价工作量保护，不代表 Token Plan 费用。网页按当前端点显示套餐模式。Token Plan 配额不足时停止，不自动改用按量服务。官方接入依据：https://help.aliyun.com/en/model-studio/qwen-code 。

最新试运行已完成：五卷全文22/22块分析、写作规格汇总、一次Max正文与Flash复核。新增9次Token Plan调用，返回输入573,936、输出7,150 Token；此前按量结果仅作缓存复用。阅读 `data/local/trials/tang-full-reference/draft.md`；原始模型稿与编辑复核记录同时保留。正文仍待人工史实审核。

### 网页章节审批（2026-10-30）

“人工确认方案”自 2026-11-17 起不再要求填写整书人民币预算或 Token 上限（REQ-035）：确认只固定当前方案哈希、史料核对与资料外发口径，页面展示的整书估算仅用于了解规模；旧口径填过的预算数字作为当时估算的备注保存，重新确认不填即清空。套餐模式不计算人民币费用或 Credits；输入按 UTF-8 字节加余量估算，并与最大输出合计，只用于单次请求的输出上限与本地任务工作量，不代表套餐剩余额度。

审批记录与当前规划哈希、计费模式、模型绑定；切换模式或模型后需要重新确认。历史请求保留所属模式和用量预留，未知结果不自动重发，缺少 usage 时不会按零用量释放预留。旧数据库的人民币预算列在套餐审批中仅保留兼容占位值，不作为费用或预算使用，API 返回该值为空。

`node scripts/test-story-billing.mjs` 使用临时测试项目检查审批持久化、用量不足、配置变更和逐章顺序门禁，完成后清理测试项目，不发起模型请求。可用 `TEST_BASE_URL` 和 `HISTORY_DATA_DIR` 指向同一套隔离服务与数据库。

### 章节中断与继续生成

网页生成接口返回 HTTP 202 后在本地服务后台接收模型流，正文分段写入 SQLite，每次请求另存正文快照和用量。页面自动读取进度；刷新或关闭浏览器不取消后台任务，重新打开可查看已保存正文。任务运行时不能并发生成或保存新版规划。

模型长时间无输出、输出截断或连接断开时保留最后检查点，不自动重发。服务进程中断后，超过 150 秒没有心跳的任务会在读取状态时归档为中断。核对供应商请求与用量后，可手动从已保存末尾继续；续写是携带旧稿的新请求，不是恢复供应商原连接。旧版失败记录若保存了 0 字符，只能重新请求，无法找回未收到的正文。进程被强制终止时，最后尚未落库的小段文本仍可能丢失。

只有明确在长度上限处截断且确有新增正文时才自动续写，单章同一轮最多两次；每段是独立请求与独立快照，续写只接在已保存正文之后。续写开头与已有正文重复时回滚该段并交回人工；断线、超时、无进展或达到上限一律停在未完成状态并保留检查点，人工续写会把计数重置。每次请求仍只受自己的输出上限约束，历史预留与旧稿输入不再被拿去比对整书额度，也不会因此自动加预算或切换计费模式。

`node scripts/test-chapter-stream.mjs` 在临时数据库与独立服务中注入假模型流，验证 202、断线检查点、服务重启、失活锁归档、显式续写、逐章自动续写与重复回滚、接受后的故事状态传递以及前文改写导致的下游待复核；不使用真实 Key、不连接模型供应商。

## 本机古籍固定、史料人物索引与确认后自动生成（2026-11-15）

已采集的 25 部 / 3,563 卷维基文库原文要先入库并固定到项目，才能作为史料证据的唯一来源；三条命令均在离线状态下执行，不产生模型调用：

```sh
npm run corpus:index            # data/local/corpus/wikisource -> corpus_book/corpus_volume（可重复执行，按哈希跳过）
npm run corpus:persons          # 逐卷抽取人名与同段共现 -> corpus_person/corpus_person_edge（零 Token）
npm run refs:register           # 登记已转换的参考小说卷与抽象写作规格 -> reference_novel/reference_spec
```

`corpus:persons` 支持 `--book <id>`、`--min-mentions`、`--max-persons`、`--max-edges` 做单书或阈值调整；重建前先 `npm run corpus:check` 确认采集报告完整。`refs:register` 只登记哈希与写作规格文本，参考小说原文永不进入生成上下文。

网页流程：资料步骤把本机古籍全集与《冰与火之歌》各自固定到当前项目（取消固定需重新点击），人物步骤从史料候选中默认勾选存在强关联者并可“不再显示”，随后“确认范围与人物并自动生成”按范围、人物、强关联、派生事件、本地骨架大纲的顺序写入并回显逐步结果。自动路径只在项目已保存“同意资料外发”且服务端配置 Key 时才调用 `qwen3.8-max` 覆盖骨架；章节正文仍需逐章人工批准。

自动化配置在 `src/app/api/projects/[id]/auto`，最近一次运行保存在 `auto_runs`，可重复执行且幂等：同名人物、已有关系、已采用事件与内容相同的骨架都不会新增规划版本或撤销既有人工确认。

真实 Key 风险提示：`next dev` 会自动加载 `.env`/`.env.local` 的 `DASHSCOPE_API_KEY`，一旦项目保存了“同意资料外发”，模型分支就会真的计费。回归脚本（`npm run test:auto`，即 `node scripts/test-corpus-auto.mjs`）必须在 `HISTORY_DATA_DIR` 隔离目录、`outlineMode=local` 且未同意外发的项目上运行，缺少 `HISTORY_DATA_DIR` 会直接退出，并在断言中检查提示词不含参考小说原文。

## 剧情提案、章纲绑定与规格版本（2026-11-17）

采用史实之后、生成章纲之前新增“剧情提案”步骤（`/projects/<id>/setup/proposals`）：同一组已采用史实上至多保留三份可编辑提案，区分叙述视角、主线、冲突与虚构边界。「本地提案」零 Token、不外发；「生成模型提案」先预览将要外发的内容与用量上限，需显式勾同意外发才发请求，请求失败不落库。重新生成只替换未选定的槽位，已选定的一份原地不动，被替换的旧版本标为“已废弃”并保留完整正文供回看；人工改写另存新版本，只改文字不会刷新提案所依据的输入版本。

选定提案后才解锁章纲步骤。章纲的三条写入路径（模型大纲、本地骨架章纲、人工保存）都绑定当时的提案槽位、修订号与输入版本哈希；范围、人物、关系、虚构设定或已采用史实任一变化，都会让章纲保存、方案确认和逐章生成一起被拦下，须回到提案步骤重新生成。人工保存章纲必须携带预期版本号，不会按当前版本静默覆盖；新版本仍会自动撤销上一次人工确认。本地骨架章纲只按已采用事件的年代顺序编排，零 Token、不外发，仍需作者自行确认。参考小说的写作规格按版本管理：编辑产生草稿，确认才生效；确认新版本只提示既有方案复核，不作废已选定提案与章纲，正文沿用方案快照里的旧规格。缺少前置配置时页面只给出门禁口径，不再回退到静态试跑资料。

回归：`test-plot-events`、`test-story-billing`、`test-corpus-auto` 共用 `scripts/lib/story-chain.mjs` 走完整本地链路（采用证据→选定提案→本地骨架章纲）并在结束时清理测试作品；`test-chapter-stream` 自带假模型流与独立服务；`test:chain`（`node scripts/test-creation-chain.mjs`）自起自停一台注入假模型流的开发服务，覆盖单年选题、截断与断线恢复、跨作品隔离与旧派生数据复核。五条均须在 `HISTORY_DATA_DIR` 隔离副本和 `DASHSCOPE_API_KEY=fixture-only` 下运行并**串行执行**（共用 `.next-test` 构建目录，`test:chain` 占到锁即报错），全程不发起真实模型请求。

除 `test:chain` 与 `test-chapter-stream` 外，其余脚本不自带服务且默认地址不同：`test-setup` 指向 `http://127.0.0.1:3107`，`test-plot-events`、`test-story-billing`、`test-corpus-auto` 指向 `http://127.0.0.1:3000`——裸跑会把请求打到正在使用的开发实例和活跃工作区。请先起一台隔离服务（`HISTORY_TEST_BUILD=1 HISTORY_DATA_DIR=<副本目录> DASHSCOPE_API_KEY=fixture-only node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port <端口>`），再用 `TEST_BASE_URL=http://127.0.0.1:<端口>` 运行脚本；`test-corpus-auto` 还要求脚本进程自身带 `HISTORY_DATA_DIR`，缺失时直接退出。

## 故事状态、前文变更与待复核（2026-11-17）

章节被人工接受时，本章收束后的摘要、人物所在地、关系口径、各视角已知信息与未收束伏笔固化为该方案版本的“故事状态”（`chapter_states`），同时记录接受时的正文输入版本与当时生效的写作规格版本。下一章请求只带入位于其前且仍为已确认的状态条目：请求体里 `confirmedStoryState.usedInputs` 逐条写明用了哪一章的哪个输入版本，`excludedStoryState` 写明哪些内容因前文变更被排除及原因，界面在章节工作台的故事状态卡同样分“带入本章”和“本章状态”两栏显示，未来章与已失效内容不会静默混入。

改写或删除任一前章正文、重新接受前章，都会让本章状态转为“已失效”，并把其后所有章节标记为“前文变更待复核”——包括当时正在生成的那一章。已写文本一律保留，不自动重写或删除；待复核的章节复核后可以直接重新接受而无需重写正文，重新接受即完成本章复核，但其后章节仍需逐章复核。前一章未接受、正在待复核或没有已确认故事状态时，本章生成请求被拒绝。未完成（截断、断线、达到自动续写上限）的章节不能直接接受，只能先人工续写补全，避免半句截断的正文成为后续章节的既定事实。


