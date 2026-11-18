# 历史小说创作工具实施计划与任务

版本：0.5 | 日期：2026-11-16 | 状态：逐章创作改版待实施，既有实施记录保留 | 需求：[spec.md](spec.md)

## 1. 摘要

按“资料可信、选择可查、方案可审、正文可追溯”的顺序实现个人本地创作工具。首期采用固定工作流，而非让模型自由决定步骤。当前改版优先完成阶段 10 的创作链，详见[作品流程设计](plans/2026-11-16-route-isolation-frontend-design.md)。商业服务为已配置的百炼按量或 Token Plan：`qwen3.8-max` 负责高质量写作，`qwen3.8-flash` 负责低成本提取和检查。

任务复选框仅在实现及其完成条件通过后勾选。阶段 9 已勾选项及文末日期记录描述原有行为；与阶段 10 冲突时，以阶段 10 和最新版需求规格为准。表中的文件是预定实现位置，实施时可局部调整，但必须同步映射和验收证据。

## 2. 技术上下文与决策

### 2.1 已有输入与技术基线

输入为本次对话确认方案及需求规格，不存在旧代码、迁移拓扑或仓库宪章。不生成迁移分析、Java 知识图谱或额外架构文件。现有迁移指南仅覆盖 Spring/Struts，不适用于本项目。

| 部分 | 首期选择 | 约束 |
|---|---|---|
| 运行平台 | macOS 本地 Node.js 服务 | 实施时采用依赖共同支持的 Node.js LTS，记录准确版本 |
| 应用 | Next.js、React、TypeScript | App Router；本机浏览器工作台；版本在初始化时核对并锁定 |
| 存储 | SQLite、参数化 SQL、显式迁移 | 选择一个维护中的 Node 驱动，初始化验证目标平台兼容性；不引入 ORM 和图数据库 |
| 文件 | 本地受控目录与文件清单 | 原始文件不可静默改写；备份不包含环境配置 |
| 模型 | 阿里云百炼，OpenAI 兼容 SDK；按量或 Token Plan，由配置决定且不自动切换 | 主模型 `qwen3.8-max`；辅助模型 `qwen3.8-flash`；按量默认 Base URL 为 `https://dashscope.aliyuncs.com/compatible-mode/v1`，Token Plan 使用北京官方专属端点；Key 与端点、计费模式匹配，不使用 Coding Plan 凭证 |
| 输出校验 | Zod | 每步独立 Schema，加程序化来源、版本与业务规则校验 |
| 图形 | React Flow | 用于关系预览，限制可见节点数，另有表格视图；时间线先用普通布局 |
| 文档 | TXT、Markdown、参考小说用未加密 MOBI | 文本 PDF 和结构化历史 JSON 包后置；不做 OCR |
| 古籍获取 | 项目抓取二十四史及《资治通鉴》，按书/卷/篇目录执行 | 25 部书目固定，站点和版本需合法性与完整性审核；优先开放 API 或下载，不依赖模型联网工具采集 |
| 上下文 | 按人物、事件、章节依赖筛选，加摘要与原文片段 | 不把全库或参考小说原文直接发送给正文模型 |
| 调度 | SQLite 任务状态与固定步骤执行器 | 一个模型任务运行；进程重启后显式恢复；不实现通用工作流 DSL |

`.env.local` 供本地开发使用，运行时由服务端读取；只提交空值的 `.env.example`：

```dotenv
DASHSCOPE_API_KEY=
BAILIAN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
BAILIAN_MODEL_WRITING=qwen3.8-max
BAILIAN_MODEL_FAST=qwen3.8-flash
```

Key 不使用 `NEXT_PUBLIC_` 前缀，不保存到业务数据库、作品导出或日志。配置以北京地域为默认，Key 与 Base URL 地域必须相同；缺少 Key 时仅提供模拟模型，不发送网络请求。2026-10-27 官方价格快照：Max 输入/输出 ¥12/¥36 每百万 Token；Flash ¥0.8/¥2.7。仅用于预算预估，按量单价和促销会调整，真实用量/费用以百炼控制台为准。

### 2.2 实施原则检查

| 原则 | 计划落实 |
|---|---|
| 用户决定故事方向 | 选人、虚构设定、方案确认和正文接受均有显式操作 |
| 史实与文学分层 | 原始证据、用户核定和虚构内容分别记录；模型不直接写入已采用史实 |
| 密钥与调用受控 | 所有模型调用经单一服务端入口，验证同源、本地会话、输入版本和适用的外发同意 |
| 轻量且可恢复 | 单应用、单数据库、受控本地文件；固定节点持久化，无多 Agent 平台 |
| 不夸大能力 | 没有证据显示未知；格式正确不等于史实正确，重复检测不等于版权保证 |

### 2.3 实现边界与关键约定

- 内部人物、事件、来源和章节使用稳定 ID；名称只用于展示与搜索。实体身份与事实断言分开。
- 后续支持的历史 JSON 资料包采用版本化 Schema：资料包元信息、来源与片段、区域、人物、活动、事件、事实和关系。包内引用必须有效；没有证据者为待核对项。
- 默认采集目录严格对应规格第 9 节的 25 部书；《史记》不重复计数。每书单独绑定版本、预期卷篇、许可、来源域、抓取状态和完整率，不能仅凭目录有链接就称为原文完整。
- 抓取器优先使用来源平台允许的 API 或下载，并核查条款、许可和 robots；使用成熟 HTML 解析器而非正则抽正文。低并发、限速、有限重试、缓存、断点和内容哈希持久化；拒绝访问控制绕过和未经审核的跨域重定向。
- 保留原始快照与清洗片段映射、异体/繁简原文、正文/注释界限、URL 和修订号；更新生成新版本，不用新来源静默补进旧版本。原文缓存和全文索引免费于模型额度，事实提取只处理所选范围，先确认预算。
- 新增本地全文检索使用 SQLite FTS5；中文优先核对 trigram tokenizer 支持，对长短查询分别回退到有界精确检索，不假设默认英文分词可直接检索古汉语人物。原文词命中只产生候选证据，不直接成为史实。
- 时间保留原始文字、精度和规范化区间。内部可用天文年份表示便于排序，但界面历史纪年无零年；只对可可靠定位的纪年建立筛选键；不做全面古历换算。
- 人物筛选用活动区间与区域证据，不仅是生卒或出生地。未知值不混入确定匹配。
- 史实关联图仅使用已采用且时间有效的关系和事件参与记录。人物与事件构成邻接结构，用标准 BFS 查最短路径和连通分量；超限路径明确提示截断，不能误报无关联。
- 参考小说分析输出写作规格；任何模型输出都视为不可信输入。来源和人物 ID 在服务端重新解析，不接受模型任意路径或 URL。
- 方案版本包含范围、人物、采用事实、虚构设定、写作规格、大纲与依赖。确认接口在事务内检查当前版本并保存快照，生成接口再次复核。
- 人工确认最小粒度为当前全书方案；修改方案默认使当前全书确认过期。章节依赖初期按前序章节及显式引用保守追踪，不追求精细语义影响推断。
- 模型节点不长期占用 HTTP 请求或数据库事务；本地任务执行器由独立 Node 进程运行，与应用共享受控数据目录。浏览器轮询进度，沿用现有流式检查点作为中断恢复依据，重启后由用户显式继续。
- 每个模型步骤先保存请求意图、输入版本和适用的用量预留，返回后原子提交结果。进程异常后远端状态未知的步骤等待用户决定，不自动重发。
- 模型目录保存官方来源及核对时间，首期只开放 `qwen3.8-max` 和 `qwen3.8-flash`；Max 默认用于写作规格、大纲、正文，Flash 默认用于提取和检查。启动时校验 Model ID 来自服务端 allowlist；正式 API 请求失败时不自动换模型。其他模型需要人工核对价格、能力和地域后更新文档与 allowlist。
- 数据恢复在新项目目录执行，校验清单、文件哈希、大小与路径后提交；损坏包不得部分替换现有项目。

## 3. 实施步骤与任务

依赖使用任务编号标注。计划项编号用于追踪，不表示模块拓扑。一个任务的验证可复用相邻任务的验收样例，不要求每项新建测试文件。0.4：T001-T002、T030、T031 已验收；T031 最终校验为 25 部、3,563/3,563 卷页、0 失败，检查器确认快照、来源许可元数据及哈希有效；T032 尚未开始。T033 至 T037（情节事件与大纲生成）已验收，证据为 `scripts/test-plot-events.mjs` 在隔离数据目录下的真实 HTTP 回归，未发起模型请求；详见文末 2026-11-13 记录。

### 阶段 1：本地基础与商业调用入口

计划项 **1.1**；需求：REQ-001、REQ-033、REQ-037、REQ-039、REQ-044、REQ-045；输入：规格 1、3.6、3.7、3.8、4、10 节。前置：无；真实接入依赖用户配置 API Key。

- [x] T001 [Plan:1.1] 初始化应用、锁定兼容运行版本和本地启动方式，建立 `package.json`、`src/app/layout.tsx`、`src/app/page.tsx`、`.gitignore`、`.env.example`、`README.md`。依赖：无。完成：仅监听回环地址，缺 Key 时仍能管理本地作品，环境文件不入版本控制。证据：Next 生产构建通过；开发服务器监听 `127.0.0.1`。
- [x] T002 [Plan:1.1] 在 `src/lib/db.ts`、`src/lib/migrations/001-initial.sql`、`src/lib/projects.ts` 和 `src/app/api/projects/route.ts` 建立基础存储、项目隔离与显式迁移。依赖：T001。完成：迁移可重复运行；两个项目数据不混用，重启保留内容；包含后续领域所需稳定 ID、版本和约束。证据：同源创建/列表、SQLite 查询和跨来源写拒绝 HTTP 验收通过。
- [ ] T003 [Plan:1.1] 在 `src/lib/config.ts`、`src/lib/model.ts`、`src/lib/security.ts`、`src/lib/diagnostics.ts` 建立服务端商业调用入口、配置校验、本地会话、同源检查和脱敏错误。依赖：T002。完成：非法来源、缺失 Key、错误配置均不触发供应商调用；所有后续模型节点只能经该入口，尚未实现外发同意与调用边界前禁用实际付费执行。
- [ ] T029 [Plan:1.1] 在 `src/lib/model-catalog.ts`、`src/lib/bailian.ts`、`src/app/api/models/route.ts` 和 `src/components/model-selector.tsx` 实现百炼配置、Model ID allowlist、模型用途和地域/能力校验。依赖：T003。完成：默认 `qwen3.8-max` 写作、`qwen3.8-flash` 辅助；记录官方清单与价格核对时间；环境变量只读于服务端；缺 Key 仅模拟；按量与 Token Plan 使用各自匹配的凭证和 Base URL，禁止静默切换模型、计费模式或回退公共端点。

阶段退出：能创建本地项目、重启恢复，非法请求被拒绝；不宣称具备小说生成能力。

### 阶段 2：古籍采集、资料导入与证据核定

计划项 **2.1**；需求：REQ-002、REQ-006、REQ-007、REQ-008、REQ-009、REQ-011、REQ-041、REQ-042、REQ-043；输入：规格 1.2、1.3、3.1、3.2、3.8、4、9 节。前置：1.1 的本地基础；古籍采集不依赖模型 Key。

- [ ] T004 [US1] [Plan:2.1] 在 `src/lib/documents.ts`、`src/lib/document-schema.ts`、`src/app/api/projects/[id]/documents/route.ts` 实现历史/参考分类、TXT/Markdown 与现有参考小说 MOBI 导入；文本 PDF 和版本化历史 JSON 包另排期。依赖：T002、T003。完成：大小、格式、路径、重复和引用校验有效；扫描件和损坏文件明确失败；原始文件和定位可追溯。
- [ ] T005 [US1] [Plan:2.1] 在 `src/lib/history.ts`、`src/lib/schemas/history.ts`、`src/lib/prompts/history.ts` 实现资料提取、证据引用校验、核定和冲突口径；在 `src/app/api/projects/[id]/facts/route.ts` 提供受保护写入。依赖：T004、T032。完成：按所选范围从古籍索引提取，产物先为待核对，用户采用前不进入史实查询；无效来源 ID 被拒绝；缺少 Key 用模拟验证，真实提取经用户预算确认后使用配置的 Flash 模型。
- [ ] T006 [US1] [Plan:2.1] 在 `src/app/projects/[id]/sources/page.tsx`、`src/components/source-viewer.tsx` 展示覆盖范围、原文片段、版本、权利说明、冲突和采用口径。依赖：T005。完成：证据可定位；删除或更换来源后相关事实提示失效；空库不出现虚构候选。
- [ ] T007 [US1] [Plan:2.1] 从已抓取的原文在 `data/samples/history.json`、`data/samples/README.md` 建立最小人工核定样例及来源/权利记录，并在 `src/lib/context-policy.ts` 实现资料类别隔离和不可信文档规则。依赖：T004、T005、T032。完成：样例覆盖直接、间接、孤立、冲突、同名案例；不以样例代替 25 部默认原文；恶意文档不能设置指令、调用 URL 或把参考内容写入史实。
- [x] T030 [US8] [Plan:2.1] 在 `data/catalog/history-books.json`、`docs/corpus-sources.md` 建立 25 部默认书目、各版本卷页基准和逐站来源审核。依赖：T004。完成：二十四史齐全，《史记》不重复，《资治通鉴》单列；来源许可和robots规则已核；普通页面目录扫描得到 25 部、3,563 个卷页，书目与许可证信息可追溯。
- [x] T031 [US8] [Plan:2.1] 在 `scripts/fetch-history.mjs` 实现并执行目录驱动的普通页面采集，原始页面压缩快照保存至 `data/local/corpus/wikisource/`。依赖：T030。完成：固定主机/普通`/wiki/`路径白名单、User-Agent、串行1.2秒间隔、有限重试、断点、oldid版本留存、gzip快照、文本/HTML哈希与逐书失败报告；3,563页逐页对账，缺卷/429/拒绝访问不能伪装成功；遵守CC BY-SA归属，不调用模型。证据：`npm run corpus:check` 通过，25部完整、3,563页有效、0错误；晋书2卷和旧五代史1卷经失败项重试成功。
- [ ] T032 [US8] [Plan:2.1] 在 `src/lib/corpus-normalize.ts`、`src/lib/corpus-index.ts` 和 `src/components/corpus-status.tsx` 实现古籍清洗、稳定片段定位、FTS5 索引和分阶段进度；接入来源页。依赖：T004、T031。完成：原始快照和清洗结果可互查，正文/注释及版本不混合；缺卷/空白/重复有报告；中文检索可用，按所选时间区域准备增量提取；付费模型提取须由用户确认批次预算。

阶段退出：25 部默认原文采集与卷页完整性报告、补充导入、索引、来源核定和样例齐备；原文采集与完整性报告已完成（25部、3,563/3,563页），补充导入、FTS索引、结构化史实核定和样例仍待实施。

### 阶段 3：时间区域选人及关联检查

计划项 **3.1**；需求：REQ-003、REQ-004、REQ-005、REQ-012、REQ-013、REQ-014、REQ-015；输入：规格 US1、US2 和边界条件。前置：2.1。

- [ ] T008 [US1] [Plan:3.1] 在 `src/lib/history-time.ts`、`src/lib/characters.ts`、`src/app/api/projects/[id]/characters/route.ts` 实现时间、区域、活动证据筛选及别名搜索。依赖：T005、T007。完成：公元前后边界、未知时间、活动地与出生地、同名异人均有确定行为，筛选结果含匹配理由。
- [ ] T009 [US2] [Plan:3.1] 在 `src/lib/relations.ts`、`src/app/api/projects/[id]/relations/route.ts` 实现有效时间关系查询、事件参与关联、最短路径和群组检查。依赖：T008。完成：展示最多 3 条最短可解释路径；背景同属不变成交往，虚构边和未来关系不参与历史连通判断。
- [ ] T010 [US1] [Plan:3.1] 在 `src/app/projects/[id]/setup/page.tsx`、`src/components/character-picker.tsx` 实现历史范围、候选人物列表、选择与匹配证据预览。依赖：T008。完成：空范围、未知值、同名消歧和所选人物持久化可用；候选不由模型自由生成。
- [ ] T011 [US2] [Plan:3.1] 在 `src/components/association-report.tsx`、`src/lib/consistency.ts` 实现关联报告、时间冲突和四种继续方式。依赖：T009、T010。完成：未关联给出检索范围；平行线可继续，确证不可能的同场情节标记阻断；证据不足只警告。

交互要求：T011 在选择或增删人物时触发关联检查；时间段或区域变更后重新检查并使旧结果失效。

阶段退出：不调用模型也能基于已核定资料完成人物选择与关联检查。

### 阶段 4：写作规格与虚构设定

计划项 **4.1**；需求：REQ-010、REQ-016、REQ-017、REQ-018；输入：规格 US3、3.2、3.3。前置：2.1；与阶段 3 的不同文件工作可独立推进。

- [ ] T012 [US3] [Plan:4.1] 在 `src/lib/style.ts`、`src/lib/schemas/style.ts`、`src/lib/prompts/style.ts` 提炼并版本化抽象写作规格，通过 `src/app/api/projects/[id]/style/route.ts` 保存审核结果。依赖：T004、T007。完成：允许编辑视角、节奏与设计方法；不采纳原作人物、桥段和文档指令；真实模型执行依赖 T025。
- [ ] T013 [US3] [Plan:4.1] 在 `src/lib/fiction.ts`、`src/lib/schemas/fiction.ts`、`src/app/api/projects/[id]/fiction/route.ts` 实现虚构人物和关系、分类与事实冲突检查。依赖：T009、T011。完成：新增人物不覆盖真实人物，虚构关系不进入历史连通图；与已采用事实矛盾时给出阻断原因。
- [ ] T014 [US3] [Plan:4.1] 在 `src/app/projects/[id]/settings/page.tsx`、`src/components/fiction-editor.tsx` 实现规格审核、虚构人物和关系编辑与分层显示。依赖：T012、T013。完成：史实/存疑/虚构标记与核定状态区分；调整设定记录版本而非覆写来源。

阶段退出：用户可以明确选择采用的写作规格与虚构设定。

### 阶段 5：情节规划、预览与强制确认

计划项 **5.1**；需求：REQ-019、REQ-020、REQ-021、REQ-022、REQ-023、REQ-024、REQ-025、REQ-046 至 REQ-051；输入：规格 US4、3.4、5 节。前置：3.1、4.1。

- [ ] T015 [US4] [Plan:5.1] 在 `src/lib/planning.ts`、`src/lib/schemas/plan.ts`、`src/lib/prompts/plan.ts` 和 `src/app/api/projects/[id]/plan/route.ts` 实现全书/章节/场景草稿、证据标记、双时间顺序和依赖。依赖：T011、T014。完成：关键事实有出处，补写有标记，平行叙事不被强制连为一条人物链，循环依赖被拒绝。
- [ ] T016 [US4] [Plan:5.1] 在 `src/components/relationship-graph.tsx`、`src/components/story-timeline.tsx`、`src/app/projects/[id]/plan/page.tsx` 实现关系图、历史线和章节线联动预览。依赖：T015。完成：缩放、筛选、证据查看、列表替代、章节调整与失败反馈可用；原图与列表使用同一份版本数据。
- [ ] T017 [US4] [Plan:5.1] 在 `src/lib/approvals.ts`、`src/app/api/projects/[id]/approvals/route.ts` 实现预览记录、阻断检查、事务内版本验证和不可变快照。依赖：T016。完成：直接请求不能绕过预览和确认；确认时发生并发编辑即拒绝；能查看确认的精确方案版本。
- [ ] T018 [US4] [Plan:5.1] 在 `src/lib/revisions.ts` 统一处理范围、证据、设定、规格和大纲变化，并接入所有修改路径。依赖：T017。完成：相关变更使确认过期；旧快照保持不可变；生成前版本复核与运行中版本变化具有明确处理结果。
- [x] T033 [US4] [Plan:5.1] 在 `src/lib/migrations/005-plot-events.sql`、`src/lib/db.ts`、`src/lib/plot-events.ts` 建立情节事件与参与人物存储，候选由 `character_activity` 和 `historical_relations` 即时推导。依赖：T008、T009 已接通的最小实现（`002-creative-setup.sql` 的活动与关系记录）。完成：迁移在 `ensureSchema` 中可重复执行，年份按无零年的天文纪年存储、界面按历史纪年读写；事件带稳定 `source_key`（`activity:{id}`、`relation:{id}`）与 `UNIQUE(project_id, source_key)`，已采用的来源不再出现在候选中；候选不落库缓存，修订出处或关系记录后立即反映，无需重新同步；参与人物限定主导、出席、对立。证据：`scripts/test-plot-events.mjs` 断言 3 条候选、采用后剩 2 条、重复采用被拒。
- [x] T034 [US4] [Plan:5.1] 在 `src/app/api/projects/[id]/events/route.ts` 实现事件读取与 `adopt`、`add`、`update`、`remove` 动作。依赖：T033。完成：GET 返回范围、已存事件、候选、人物和出处资料，仅本机可读，写操作要求同源本机；历史事件必须选择本作品 `category='history'` 的资料、证据为该原文子串且 `confirmed === true`，虚构事件不要求证据；事件时间需与当前历史范围重叠，参与人物须为本作品已有人物且不超过 12 位；缺出处、错证据、未确认、超范围均拒绝写入。
- [x] T035 [US4] [Plan:5.1] 在 `src/app/api/projects/[id]/outline/route.ts` 用 `buildGenerationContext` 从项目数据构建大纲上下文，实现预览、生成与保存。依赖：T034。完成：GET 返回阻塞原因、范围、证据列表、生成上下文、模型与计费模式；缺范围或无带证据的已采用事件时阻塞并拒绝写入；POST 默认 `preview` 为 dry-run，返回完整外发内容和 Token、人民币上限估算，不发模型请求；`generate` 仅在 `allowExternalTransfer === true` 且已配置 Key 时调用 `qwen3.8-max`，服务端做字段裁剪、`validPlan` 校验和证据编号校验并返回 `issues`、`accepted`，生成结果不写库；只有 PUT 落库并递增版本。
- [x] T036 [US4] [Plan:5.1] 在 `src/lib/story-plan.ts` 抽出 `sha256`、`readPlan`、`parsePlan`、`validPlan` 和事务写入 `commitPlan`，供 `story` 与 `outline` 两条路径共用版本链。依赖：T035。完成：`story_plan_approvals` 以 (project_id, plan_version) 为主键，新版本自动撤销上一次人工确认；正文草稿仍绑定各自版本；存在 `status='generating'` 章节时拒绝改版本；预期版本不符时 `PlanVersionError` 映射 HTTP 409，不静默覆盖。
- [x] T037 [US4] [Plan:5.1] 建立 `scripts/test-plot-events.mjs` 端到端回归，用 `HISTORY_DATA_DIR` 指向隔离数据目录，默认对 `http://127.0.0.1:3000` 运行。依赖：T033、T034、T035、T036。完成：覆盖候选推导、采用与重复采用、缺出处/非原文证据/未确认/超出范围四类拒绝、否决与恢复、dry-run 预览、缺少外发确认的生成拒绝、PUT 版本链及大纲新版本撤销人工确认、清空事件后 outline 重新阻塞；脚本不发起任何真实模型请求。

阶段退出：用户可完成生成前预览确认，服务端能拒绝所有未确认或过期任务。

### 阶段 6：章节生成、校验与连续性

计划项 **6.1**；需求：REQ-026、REQ-027、REQ-028、REQ-029、REQ-034；输入：规格 US5、3.5、5 节。前置：5.1。

- [ ] T019 [US5] [Plan:6.1] 在 `src/lib/context.ts`、`src/lib/schemas/output.ts` 实现分步骤结构校验、来源/版本校验与按单次容量组织上下文。依赖：T007、T018。完成：只使用当前有效依据与已接受前章，控制未来信息；正文请求不含参考小说原文；能展示实际上下文清单。
- [ ] T020 [US5] [Plan:6.1] 在 `src/lib/generation.ts`、`src/lib/prompts/chapter.ts`、`src/lib/story-state.ts` 及 `src/app/api/projects/[id]/chapters/route.ts` 实现单章草稿与状态更新提案。依赖：T019。完成：生成绑定快照和章节依赖，不自动接受草稿或改变史实；尚未完成执行器前以模拟调用验收纯业务行为。
- [ ] T021 [US5] [Plan:6.1] 在 `src/lib/review.ts`、`src/lib/prompts/review.ts` 实现规则校验、辅助模型审阅、阻断/警告/建议及有限修订。依赖：T020。完成：来源不存在、确定年代冲突等被捕获；最多 2 次修订后等待人工；模型审阅通过不能绕过规则。
- [ ] T022 [US5] [Plan:6.1] 在 `src/app/projects/[id]/chapters/page.tsx`、`src/components/chapter-editor.tsx`、`src/components/review-panel.tsx` 实现编辑、接受、局部重生成、版本回看和下游过期展示。依赖：T021。完成：用户文本可找回，只有当前通过复核且被接受的版本影响下一章；前章修改后依赖项全部待复核。

阶段退出：模拟模型下能完成三章的生成、审阅、接受和旧章修改流程。

### 阶段 7：持久化任务、费用与真实接入

计划项 **7.1**；需求：REQ-030、REQ-031、REQ-032、REQ-035、REQ-036；输入：规格 US6、3.6、7 节。前置：6.1；调用限制与执行器的接口约定在阶段 1 固定。

- [ ] T023 [US6] [Plan:7.1] 在 `src/lib/budget.ts`、`src/lib/consent.ts`、`src/components/call-confirmation.tsx` 实现资料外发同意、Token 用量与人民币成本估算、预算预留和实际记录。依赖：T003、T019、T029。完成：按量估算与账单分开，Token Plan 只展示用量；未同意外发不调用。正文不要求整书预算，仍执行单请求和单章续写限制。
- [ ] T024 [US6] [Plan:7.1] 在 `src/lib/tasks.ts`、`src/worker.ts`、`src/app/api/projects/[id]/tasks/route.ts` 实现固定工作流、单执行槽、租约、阶段提交、幂等、取消和中断恢复。依赖：T018、T021、T023。完成：重复提交只建一个有效任务，进程崩溃不永久卡住；远端结果未知不自动重发，取消不再启动新步骤。
- [ ] T025 [US6] [Plan:7.1] 在 `src/lib/bailian.ts`、`src/components/task-panel.tsx`、`README.md` 串联按量模型调用、进度及错误。依赖：T022、T024、T029。完成：所有请求经服务端校验；用户在本机配置百炼 Key 后，联调核对 Max/Flash Model ID、输入/输出 Token 及当前计费模式；未提供 Key 时明确报告联调未完成，不触发外网调用。

阶段退出：中断恢复与费用语义通过，完成经用户授权的商业 API 联调；暂停等待输入不是后台持续付费调用。

### 阶段 8：备份导出、体验与交付

计划项 **8.1**；需求：REQ-038、REQ-040；输入：规格 US7、6、7 节。前置：7.1。

- [ ] T026 [US7] [Plan:8.1] 在 `src/lib/backup.ts`、`src/app/api/projects/[id]/export/route.ts`、`src/app/api/projects/import/route.ts` 实现正文导出和带版本清单的完整备份恢复。依赖：T025。完成：在一致性快照下备份数据库和文件；校验路径、大小、哈希和版本；恢复生成新项目，不包含 Key 或覆盖旧项目。
- [ ] T027 [US7] [Plan:8.1] 在 `src/app/globals.css`、`src/components/project-navigation.tsx` 及现有列表/图形界面完成键盘操作、目标视口、分页、邻域筛选、进度与空/错误状态。依赖：T016、T022、T025。完成：约定数据规模和两个视口符合 SC-008；图形非唯一操作入口，刷新保留提交状态。
- [ ] T028 [Plan:8.1] 在 `docs/acceptance.md`、`README.md` 记录 SC-001 至 SC-012 的证据、默认古籍覆盖、百炼按量模型/价格快照、配置与恢复说明，回填任务状态及证据路径。依赖：T026、T027、T031、T032。完成：模拟与真实调用分开，25 部卷篇完整性、人工三章复核和恢复验收完成；价格/模型变化或受限来源不得隐藏，不以文档覆盖率当作发布通过。

阶段退出：可在干净本机目录按说明运行、恢复并完成一个经审阅的小型历史小说流程。

### 阶段 9：本机全集固定、史料人物候选与确认后自动生成

计划项 **9.1**；需求：REQ-052、REQ-053、REQ-054、REQ-055、REQ-056，并复用 REQ-041 至 REQ-043、REQ-046 至 REQ-051；输入：规格 3.1、3.2、3.3、3.4、9 节。前置：2.1、3.1、5.1。

- [x] T040 [US2] [Plan:9.1] 在 `src/lib/migrations/006-corpus-source.sql` 与 `src/lib/schema-columns.mjs`、`src/lib/db.ts` 建 `corpus_book`、`corpus_volume`、`corpus_person`、`corpus_person_edge`、`corpus_person_blocks`、`corpus_state`、`reference_novel`、`reference_spec`、`project_corpus`、`project_reference`、`project_auto_settings`、`auto_runs`。依赖：T005、T030。完成：迁移在 `ensureSchema` 中可重复执行，卷级文本按书分表存储、以 `text_sha256` 去重，固定表只记哈希不复制原文。
- [x] T041 [US2] [Plan:9.1] 实现 `scripts/index-corpus.mjs` 与 `src/lib/corpus-import.mjs`：把 `data/local/corpus/wikisource` 的 25 部 / 3,563 卷原文按卷入库，写 `corpus_state(kind='corpus')` 的报告哈希与卷数，提供 `iterateCorpusVolumes` 流式读取。依赖：T040。完成：重复运行不产生重复卷；单卷缺失或哈希变化可在报告中定位；3,446 万字的读取不整库载入内存。
- [x] T042 [US2] [Plan:9.1] 在 `src/app/api/projects/[id]/corpus/route.ts` 与 `src/lib/source-text.ts` 实现语料固定与证据校验：POST `pin` 按当前历史范围选出重叠书目并写 `project_corpus`，`assertEvidenceInSource` 用 `instr(corpus_volume.text, ?)` 在 SQL 侧校验证据子串。依赖：T041。完成：未固定语料时史料证据写入被拒；GET 返回 ready、volumes、pinned、pinning、personsIndexed 与范围内书目；证据校验不加载全库文本。
- [x] T043 [US3] [Plan:9.1] 实现 `scripts/index-corpus-persons.mjs`、`src/lib/corpus-person-extract.mjs` 与 `src/lib/corpus-persons.ts`：本地词典加动词邻接抽取人名与共现边，`corpusPersonCandidates` 按范围给出默认候选，`corpusPersonPairs` 给出强关联人名对及字面原文证据，`importCorpusPersons` 幂等导入并勾选。依赖：T042。完成：索引零 Token、可分书重建；边的证据只在两个名字同处一段时写入，否则留空由校验拒绝；`corpus_state(kind='persons')` 记录条数与时间；`corpus_person_blocks` 支持“不再显示”与恢复。
- [x] T044 [US3] [Plan:9.1] 在 `src/app/api/projects/[id]/persons/route.ts` 提供候选读取与 `import`、`block`、`unblock` 写入。依赖：T043。完成：GET 返回范围内候选人物（含 `strong`、`imported`）与默认勾选名单；写操作要求同源本机；候选只建人物与活动记录，原文证据仍需人工核对。
- [x] T045 [US4] [Plan:9.1] 在 `src/lib/reference-novels.mjs`、`src/lib/reference-spec.ts`、`scripts/register-reference-novels.mjs` 和 `src/app/api/projects/[id]/references/route.ts` 登记并固定参考小说，《冰与火之歌》五卷为默认系列；`activeReferenceSpec` 校验卷级合并哈希并给出漂移原因，`buildGenerationContext` 只注入抽象写作规格。依赖：T040。完成：未登记时界面提示执行 `npm run refs:register`；固定与取消固定可逆；提示词与产物中不出现参考小说原文。
- [x] T046 [US4] [Plan:9.1] 抽出 `src/lib/event-writes.ts`、`src/lib/outline-generate.ts` 与 `src/lib/auto-setup.ts`，新增 `src/app/api/projects/[id]/auto/route.ts`：确认后按范围、人物、强关联、派生事件、本地骨架大纲、可选模型大纲的顺序生成并写 `auto_runs`；`localOutlinePlan` 均分事件产出引用真实证据编号的骨架，`commitPlan` 前后按 `sha256` 比对避免无谓新版本。依赖：T034、T035、T036、T043。完成：重复运行幂等且状态为 ok；`outlineMode` 三种取值行为分明；未同意外发或未配 Key 时只保留骨架并说明原因；正文不在此流程生成。
- [x] T047 [US4] [Plan:9.1] 界面接通：`src/components/document-import.tsx` 增加本机古籍与参考小说固定区并把上传降为补充资料，`src/components/character-picker.tsx` 增加史料人物候选区与“确认范围与人物并自动生成”入口，`src/components/config-column.tsx` 按古籍固定 + 参考小说固定推导资料步骤状态，`src/components/panels/outline-panel.tsx` 与 `plan-panel.tsx` 标注大纲来源与写作规格。依赖：T042、T044、T045、T046。完成：步骤徽章反映真实数据；自动生成后展示逐步结果与“正文仍需人工批准”的口径；浏览器无 React key 警告。
- [x] T048 [US4] [Plan:9.1] 建立 `scripts/test-corpus-auto.mjs` 回归：`HISTORY_DATA_DIR` 隔离数据目录，覆盖固定拒绝、候选导入、强关联证据校验、骨架大纲结构与证据编号、幂等重跑、规划版本未变、参考小说原文不出现在大纲上下文。依赖：T046、T047。完成：脚本不发起任何真实模型请求，`npm run test:auto` 可重复执行。

阶段退出：干净本机目录按 README 采集、索引、登记后即可在五步配置内完成“范围与人物确认 → 自动生成骨架”，且证据全部可回溯到本机古籍原文。

### 阶段 10：按年份与文风逐章创作

计划项 **10.1**；接续现有作品 API、古籍索引、参考小说登记与逐章生成。新增能力均待实施；本阶段不要求先建设平台上传库、三列概览或逐作品模型绑定。

- [x] T049 路由与作品归属（REQ-001、REQ-037、REQ-040、REQ-057）。拆分平台概览、全局模型和作品路由，复用现有工作台面板与项目 API。完成：新作品进入设置，旧作品恢复最近有效步骤；跨作品的章节、资料引用和任务读写均被服务端拒绝。
  - 实施注记（2026-11-17）：路由分为 `/`（平台概览，`src/app/page.tsx` + `src/components/overview-home.tsx`，模型目录与 `/api/models` 同源服务端 allowlist）、`/models`（全局模型与密钥）和作品域 `/projects/[projectId]`（`layout.tsx` 用 `getProject` 把关，不存在即 `notFound()`），配置步骤为 `setup/{scope,persons,events,references,outline}`，正文深链为 `chapters` 与 `chapters/[chapterId]`；「最近有效步骤」由 `resolveProjectEntry`（`src/lib/projects.ts`）按已完成配置推导，新作品落到设置。归属仍在服务端强制：作品 API 逐条 `projectExists`/项目作用域取数，写请求另经 `isSameOriginLoopback` 同源校验，跨作品的章节、资料与任务读写拿不到他人 id。
- [x] T050 范围、史料与候选（REQ-003、REQ-004、REQ-007、REQ-046 至 REQ-048、REQ-050、REQ-052、REQ-054、REQ-055）。以证据片段支持的活动时间为准，沿用古籍固定及作品私有上传；来源与证据量不足时单列待核，移除作品年份代填和自动采用派生史实。自动流程可保存 `review_status='auto'` 的共现关系作为待核线索；未经核对不进入已核定关系图、历史事件依据或生成上下文。保留旧事件、章纲和正文快照；缺少可验证人工确认记录的旧派生事件在当前流程标记待复核，不以 `adopted + derived` 认定已核对。完成：单年和区间筛选、范围或来源变化刷新、采用前核对；未复核的旧证据不能用于新章纲或正文，旧快照的引用不因重新排序被替换。
  - 实施注记（2026-11-17）：① 史料人物活动时间以证据所在书目年代近似（语料暂无人物级年份），区域仍取作品范围首个，均待人工核对，精确标注归 T051 规格版本；② 证据编号→事件身份的强绑定列为 T052 章纲确认的核对内容，当前以「新版本使确认失效 + 保存时重指向警示」过渡；③ 方案确认与每次生成前复核证据快照状态（story 路由），命中待复核或已排除事件即阻止。
- [x] T051 作品写作规格（REQ-009 至 REQ-011、REQ-049、REQ-053）。在现有登记基础上保存作品可编辑及可确认的规格版本。完成：大纲与正文的实际请求能验证使用了同一份规格，参考小说原文不进入请求，源版本变动提示复核。
  - 实施注记（2026-11-17）：① 迁移 008 建 `project_reference_spec`（`version`、`spec_text`、`origin='registered'|'edited'`、`confirmed_at`，随作品 CASCADE），`src/lib/reference-spec.ts` 区分「生效版本」与「待确认草稿」：`saveProjectSpec` 只产生草稿不改生效版本，`confirmProjectSpec` 事务内确认且生效版本只能前进（更早版本要另存草稿再确认），`activeReferenceSpec` 单行查询并给出 `driftKind='source'|'series'`。② 门禁统一到 `specGateReason`（`src/lib/outline-generate.ts`）：已固定参考小说但无已确认版本时，大纲 GET/PUT/POST 与正文 approve/generate 一律 409「写作规格尚未确认」（REQ-010）。③ 请求一致性：大纲请求带 `writingSpecification`/`writingMethods`/`writingSpecVersion`，正文请求带同源的 `referenceSpecification`/`referenceMethods`/`referenceSpecVersion`，全部取自已确认版本而非登记时的静态文本；旧方案快照没记规格版本时 `withConfirmedReference` 用当前已确认版本补全（含静态试跑兜底分支）并标记 `backfilled`，`specVersionNotice` 提示「本次请求改用当前已确认的 vN，请复核」——按既定策略提示复核、不阻断，旧稿仍保留原版本（REQ-053）。④ 界面：`src/components/document-import.tsx` 提供规格编辑→保存草稿→确认的版本列表与 `driftKind` 分类修复指引，`src/components/chapter-workspace.tsx` 在正文视图同样显示 `specNotice`。⑤ 验证：`npm run test:auto` 断言未确认时大纲被阻断、确认后放行、请求全文与快照 `spec_sha256` 一致、草稿不改生效版本、确认后旧方案只提示复核，并对参考小说原文做全量分块检索证明不出现在提示词与规划里；`scripts/test-chapter-stream.mjs` 由假流记录实际发出的两笔正文请求（首次与续写）并核对同一份已确认规格，复用真实库备份时改为只改写本测试作品的草稿与尝试记录、每次运行截断请求日志。回归全程走隔离 `HISTORY_DATA_DIR` 与 `STORY_STREAM_FIXTURE=1`，零真实模型调用。
- [x] T052 剧情提案和章纲确认（REQ-019 至 REQ-025、REQ-049 至 REQ-051、REQ-056）。依赖 T050、T051。完成：从同一组已采用史实提出可编辑方案，重生成保留已采用内容；选定后才能生成章纲，确认绑定输入版本，旧草稿可回看；缺前置配置时不使用旧试跑资料。完成，验证于 2026-11-17：同一组已采用史实上至多三份可编辑提案、重生成只替换未选定槽位、章纲三条写入路径绑定提案输入版本、缺前置时只给门禁口径不回退静态试跑资料。
    - 数据：迁移 `src/lib/migrations/009-plot-proposals.sql` 建 `plot_proposals`（主键 `project_id + slot(1..3) + revision`，`source` 限 local/model/manual、`status` 限 draft/selected/superseded，索引 `(project_id,status)`）；被替换的旧版本原样保留供回看，`spec_version` 记录当时的规格版本；章纲快照新增 `proposal: {slot,revision,inputHash,title}` 绑定，`StoryPlan` 结构其余不变。
    - 服务：`src/lib/plot-proposals.ts` 负责槽位读写、只替换未选定槽位的重生成、本地三份提案拼装与模型提案（默认 dry run 预览外发内容与估算，显式同意外发才发请求，请求失败不落库）；`src/lib/proposal-binding.ts` 统一输入版本哈希（范围/人物/关系/虚构设定/已采用证据；按既定「漂移只提示复核」口径不含规格版本）与 `proposalGateReason`/`planProposalIssue`，接进 `outlineBlockReason`、章纲三条写入路径、方案确认、逐章生成派发和 `confirmAndGenerate`；新增 `/api/projects/[id]/proposals`（save/select/unselect/local/generate），`/outline` 增加 `action:'skeleton'` 本地骨架章纲，`/story` 删除 `loadDefaultPlan`/`ensurePlan`/`action:'initialize'`（改显式 409）并改为按方案快照展示证据、快照缺失时给出 `blocked` 口径且拒绝确认与生成。
    - 界面：新增 `/projects/[projectId]/setup/proposals` 与 `proposal-panel.tsx`（三份提案卡片、逐份编辑、选定/取消选定、历史版本正文回看、外发预览与估算）；步骤条、总览入口与 `resolveProjectEntry` 加入提案步；章纲面板加「本地骨架章纲」按钮和绑定徽章；方案面板与章节工作台改为按 `blocked`/`proposalIssue` 显示门禁，删除「载入唐末五代试跑方案」按钮与 `initializePlan`。
    - 验证：`test-plot-events`、`test-corpus-auto`、`test-story-billing`、`test-chapter-stream` 在 `HISTORY_DATA_DIR` 隔离副本 + `DASHSCOPE_API_KEY=fixture-only` + fetch 拦截下全部 PASS，覆盖未选定提案时章纲与自动流程被门禁拦下、重生成保留选定项、人工改写保留原输入版本、骨架章纲幂等且不新增版本、证据漂移令确认失效、正文请求带同一份已确认规格；`npx tsc --noEmit`、`npm run lint` 与 `HISTORY_TEST_BUILD=1 next build` 通过；全程无真实模型请求。
    - 评审后调整：规格合规评审发现「人工改写过期提案会把它重新盖章成当前输入版本，从而绕过 REQ-050 的位置式证据编号守卫」，`editProposal` 改为沿用原有 `input_hash`/`spec_version`/`model_request_id`，改写后的过期提案仍须重新生成才能选定，并补断言；同时按评审意见让历史版本返回完整提案内容（此前只有元数据）、章纲人工保存强制携带 `expectedVersion`（REQ-051 不再静默覆盖）、`chapter-plan` 请求补已确认写作规格并接提案门禁、人工编辑的冲突/虚构条目逐项限长；评审记录的未修项：REQ-019 的每章「地点/核心冲突/建议章长」字段、`story_plan_revisions` 尚无读取路径、证据 `revisionUrl` 恒空与 `status` 恒 confirmed，连同跨进程写事务的 `BEGIN IMMEDIATE` 取舍一并留待后续任务。
- [x] T053 单章生成、连续性与恢复（REQ-025 至 REQ-036）。依赖 T051、T052。复用章节快照、流式保存与前章确认门禁。完成：下一章消费已确认的故事状态，前文更改后依赖结果变为待复核；仅明确长度截断可以有限自动续写，其他未完成情况保存检查点。移除整书预算必填项，保留针对当前方案和外发的校验及用量记录。完成，验证于 2026-11-17。
    - 数据：迁移 `src/lib/migrations/010-chapter-state.sql` 建 `chapter_states`（主键 `project_id + plan_version + chapter_id`，存 `draft_input_hash`、`spec_version`、摘要与地点/关系/知识/伏笔四类 JSON 列表、`body_tail`、`status='confirmed'|'stale'`、`stale_reason`）；`011-approval-limits.mjs` 把 `story_plan_approvals` 的预算列改为可空备注；`schema-columns` 补 `chapter_drafts.needs_review/review_reason/auto_continuations` 与 `chapter_generation_attempts.initiator`。
    - 服务：`src/lib/chapter-state.ts` 提供 `confirmChapterState`/`markFollowingChapters`/`invalidateChapterState`/`listChapterStates`/`storyStateBefore`（只串联目标章之前、且仍为 confirmed 的状态，并按章保留输入版本、规格版本与确认时间）。`/story`：接受只接受非空草稿并原子地固化本章状态 + 把其后章节（含正在生成的）标为待复核；改写走单一事务，清掉模型产出的故事状态元信息、以正文指纹充当新的输入版本、本章状态失效并标记其后章节，且不再顺手清除待复核标记；已接受但被前文变更标记的章节可复核后直接重新接受。生成前置在原有确认/外发/规格/提案/证据门禁外新增「前一章必须已接受且非待复核」和「必须有已确认故事状态」，请求体带 `confirmedStoryState.usedInputs`（实际使用的输入版本）与 `excludedStoryState`（失效内容及原因）。
    - 恢复与续写：`after()` 流水线每段一条 attempt（`initiator='manual'|'manual-resume'|'auto-continuation'`），心跳/空闲/整体时限与检查点按 `active_attempt_id` 归属写入；只有「明确 `finish_reason='length'` 且有新增正文」才自动续写，上限 2 次，续写前缀取已保存正文（截断处的 `[[META]]` 残段不进入下一轮），新增开头与已有正文重复时回滚本段并交回人工，断线/超时/无进展/达上限一律停在 `failed-or-unknown` 保留检查点，人工 resume 重置计数；派发事务改为 `BEGIN IMMEDIATE` 并设 `busy_timeout`，避免并发请求双双通过「无生成中章节」检查。
    - 计费口径：确认方案不再要求整书预算或 Token 上限（REQ-035），预算数字只作为当时估算的备注保存；方案哈希、模型与计费模式、外发与证据核对仍在请求前复核，逐请求估算与返回用量继续按 attempt 记录。
    - 界面：`plan-panel` 删除预算输入改为「用量记录」卡；`story-provider` 回显 `storyStates`/`autoContinuationLimit`/本章待复核与失效原因；`chapter-workspace` 新增故事状态卡（带入本章的前文状态与本章已确认/已失效状态、输入版本与规格版本）、待复核提示、自动续写次数徽章和「改写已接受正文」入口。
    - 验证：`scripts/lib/story-chain.mjs` 新增 `extraEvents`（本地骨架章纲章数受已采用事件数限制），`test-chapter-stream` 扩到四章，覆盖断线检查点、进程重启归档、人工续写、接受后固化状态、下一章请求带入前章状态、两次截断后自动收尾、重复段回滚后再人工补完、持续截断触顶停在检查点、未完成章不可接受、前文改写使后续全部待复核并拦下再生成、重新接受即完成复核与输入版本追溯；`test-story-billing` 改为按 REQ-035 断言（不填预算可确认、备注保存、额度数字不再拦章、外发撤销与哈希漂移仍被拒且零请求）。四条回归（`test-setup`、`test-plot-events`、`test-story-billing`、`test-chapter-stream`）在 `HISTORY_DATA_DIR` 隔离副本 + `DASHSCOPE_API_KEY=fixture-only` + 假模型流下全部 PASS，`npx tsc --noEmit`、`npm run lint`、`HISTORY_TEST_BUILD=1 next build` 通过，全程无真实模型请求。
    - 评审后调整与未修项：规格评审指出「改写已接受章节后仍用旧元信息固化状态会让输入版本追溯失真」与「待复核章节必须重写正文才能重新接受」，已按上述事务与 `input_hash` 指纹、重新接受路径修复；质量评审指出的自动续写前缀含 `[[META]]` 残段、生成中章节漏标待复核、`after()` 未捕获异常、`openContinuationAttempt` 静默失败、编辑非原子、轮询响应回退版本等已修并补断言。仍未实现：REQ-028 的规则检查与辅助模型审阅、REQ-032 的结构修订≤2 与取消入口（依赖映射表把它们归 6.1/T021 与 7.1/T024-T025，本次不冒充完成）；未完成章节不提供直接改写入口（只能人工续写补全后接受，避免半句截断正文成为既定事实）；GET 每秒回传全部章正文的带宽开销、`chapter_states` 索引冗余与 `normalizeMeta`/估算字段表重复留待后续。
- [x] T054 创作链回归（SC-002、SC-004、SC-005、SC-009、SC-012、SC-013）。依赖 T049 至 T053。完成：隔离数据目录、假模型流下按单年和参考小说完成连续两章，核对证据、风格输入、前章状态、深链、跨作品隔离以及截断和断线恢复。另用含旧派生事件和自动共现关系的作品验收：旧稿可打开，待复核项不进入新请求；核对出处及年代、确认所需证据并重新确认受影响方案后，可继续生成下一章。全程不调用真实模型。完成，验证于 2026-11-17。
  - 实施注记（2026-11-17）：新增 `scripts/test-creation-chain.mjs`（`npm run test:chain`）。父进程在 `HISTORY_DATA_DIR` 隔离副本上自起自停一台 `HISTORY_TEST_BUILD=1` 开发服务，子进程用 `--import` 装载脚本自身接管 `fetch`：只放行回环地址，其余主机断言必须等于 `BAILIAN_BASE_URL` 且密钥为 `fixture-only`；子进程未写出 ready 标记即判失败，避免「零请求」断言在服务没起来时空过。`.next-test` 构建目录用 PID 锁文件串行化，占不到锁直接报错而不是踩坏别人的缓存；结束时按归属回收锁、清理测试作品并删除请求日志与编排文件。假流按「编排键 = 年份范围 + 章节」注册多段模式（`truncate`/`finish-truncated`/`drop`/`finish-dropped`/`plain`/`proposals`），SSE 只输出新增片段，与真实流的增量口径一致。
  - 场景 A（SC-002、SC-004、SC-005、SC-009、SC-012）：单年选题只选用覆盖该年的古籍（隔离副本 25 部书目中 5 部覆盖 904 年），年份外的书目与人物不进候选；人物与事件采用要求证据命中资料原文，未核对被拒；参考小说自动固定后须确认抽象写作规格才放行章纲与正文，请求体逐条核对不含原文片段与原作人名、只带已确认规格的抽象方法与版本号。提案三选一 → 骨架章纲 → 批准 → 连续三章，假流依次给出「明确截断后有限自动续写至收尾」「断线保留检查点后人工续写」「一次成稿」三种形态，并核对 attempt 归属与自动续写计数；改写已接受章节后，依赖前文的章节转待复核、已写文本保留、再生成被 409 拦下且零请求，重新接受即完成复核并带入前两章状态与「带入/排除」输入版本；规格改版（`saveSpec`+`confirmSpec`）只产生复核提示，大纲与正文仍用同一份规格版本；章节深链页面可达，跨作品读取 404 且不增加任何请求。
  - 场景 B（SC-013 旧作品续写）：预置带 `needs_review` 的旧派生事件（含超出当前范围的年份与参与者）和 `review_status='auto'`、无年代的史料共现关系。待复核项被预防性排除并给出提示，据此生成的请求被 409 拦下且零请求；逐项核对出处、修正年代、确认关系后依赖恢复，方案输入变化要求回到提案步骤（撤销选定 → 本地章纲 → 重新选定 → 人工改写产生新修订 → 重排章纲 → 批准）后才能继续。旧方案版本的草稿行与 `chapter_generation_attempts` 原文留档仍在，旧稿可读回；未核对的共现关系不随请求外送，核对补上年月后才出现在 `associationPreview`。全程 9 次假模型请求，与编排段数逐条对账，一个不多一个不少。
  - 未覆盖（留待后续）：REQ-026 只断言「复核后 `excludedStoryState` 为空」，非空清单需要在同一方案版本内存在已失效但仍可发起生成的分支才能观测；生成取消与重复提交入口（界面项）、无效模型/地域/端点的拦截（在 `test-bailian-endpoint` 侧）、`story_plan_revisions` 的产品内回看路径仍缺。
- [x] T055 章节多选队列与章纲改版保留（REQ-058、REQ-059）。依赖 T052、T053。完成，验证于 2026-11-17：多选队列在交互层逐章串起「生成→等落定→接受」，每章仍是一次独立请求，服务端生成逻辑未改；章纲改版把已接受正文与已固化故事状态逐章带到新版本，已确认章节不再退回未生成。
    - 服务：`src/lib/story-plan.ts` 新增 `chapterSignature`（本章参与正文请求的章纲字段指纹）与 `carryForwardChapters`，`commitPlan` 在写入新版本的同一事务内按章节 ID 继承旧版本的 `draft`/`accepted` 草稿与 `chapter_states`：本章章纲未变且前序章节同样完整继承→正文、输入版本、已接受状态与状态行原样沿用；否则保留正文并置 `needs_review=1`、把状态行转为 `stale` 并写明原因。继承行清空 `active_attempt_id`、`auto_continuations` 归零，生成中与 `failed-or-unknown` 的草稿不进入新版本（旧版本行与 attempt 原样留档）。`/story` 的 PUT 回显 `{carried, preserved, needsReview}` 供界面逐数说明。方案级确认仍随新版撤销（REQ-051 不变）。
    - 前端：`story-provider` 增加 `queue`/`queueRunning`/`startQueue`/`stopQueue` 与 `waitForDraft`，并让 `data` 走 `dataRef` + `commitData`，使异步循环读到最新版本与本章状态；`runChapter`/`acceptChapter` 返回 `{ok, status/error}` 供队列判断停下与否。`chapter-workspace` 目录视图加多选框、「全选可入队/清空选择」、队列进度与停止入口、「就地确认方案与资料外发」，并把增删排序、保存目录、AI 续设下一章、改写与接受在队列进行中禁用。队列只调用既有单章接口，串行、失败即停、不重发已接受章节。
    - 验证：`npx tsc --noEmit`、`npm run lint` 通过；`scripts/test-chapter-stream.mjs` 扩展 `PUT` 支持并断言改版继承计数 `{carried:3, preserved:2, needsReview:1}`、已接受正文与 `confirmed` 状态逐章保留、改写章纲的那章转待复核且状态 `stale`、未重新确认与待复核前章被 409 拦下、新版只对未生成章节发一次任务且已接受章节零重发（按 `requests.jsonl` 逐章计数），隔离目录 + `DASHSCOPE_API_KEY=fixture-only` + 假模型流下 PASS，全程无真实模型请求。
- [x] T056 范围与史料只查询、候选人物按生卒交集、候选事件（REQ-061、REQ-062、REQ-063）。依赖 T043、T046。完成，验证于 2026-11-18。
    - 预处理（零 Token）：`src/lib/corpus-years.mjs` 纯函数解析年纪标题（「元年春王正月」「二年，汴人大饥」）、帝王纪年与干支软校验，在句读段内定年并沿用卷内最近纪年；`scripts/build-years-index.mjs`（`npm run corpus:years`，支持 `--resume/--limit/--book/--stats`）只重切《资治通鉴》（卷名以「资治通鉴卷」开头，且要求正卷纪年标题以避开《通鉴目录》的多年一行），写入 `corpus_entry`／`corpus_entry_person`／`corpus_person_profile` 并以 `corpus_state(kind='years')` 记就绪；`src/lib/migrations/011-person-years.sql` 建表。卒年锚点取「卒／殁／死／诛／及于难／殒于位／遇害」并排除「生／先／未／不」等虚词与「诛之」类宾语陷阱，「年若干」反推生年，「弱冠／三十许」只给活动年份；生年不晚于最早卒年、卒年不早于最晚活动年份，跨度或提及不足的档案 `plausible=0`。实测本机库：13,364 条带年记事（前 403—959）、1,719 份人物档案、154 人卒年可考。
    - 读取层与门禁：`src/lib/person-years.ts` 提供 `yearsIndexReady`／`personProfiles`／`profileInScope`（区间有交集即入选）／`profileSpan`，跨度 >90 年视为同名未消歧而不可信。`corpus-persons.ts` 的候选只列 `in-range`，不可信或缺年份的单列 `pending`（年份待核）且不进默认勾选；`profileInScope` 返回 false（年份可信但与区间无交集）标为 `out-of-range`，两个列表都不进——浏览器实跑发现 904—960 的项目把郭子儀、王世充列进「年份待核」，正是这两个状态被并成一个标签所致。区域留空即不限区域、只按年份筛。`importCorpusPersons` 的活动年份只取可信档案（REQ-054），`auto-setup.ts` 在未预处理时直接报出需要执行的命令而不回退到书目年代。
    - 候选事件：`src/lib/corpus-events.ts` + `GET /api/projects/[id]/events/candidates?start=&end=`，按已勾选人物 × 时间 × 固定古籍检索真实记事，返回年份、书名卷次、命中人物、原文与 `corpus:<entry_key>` 来源标记；按「人物数 + 卒年锚点 + 动词命中」排序，跳过已采用的 `source_key`，超出已定年覆盖范围时提示手工新增。事件面板在新增历史事件时提供查询与「填入」，填完仍需核对原文并确认才采用。
    - 交互：`character-picker.tsx` 卡片展示生卒／活动年份、年份来源、提及数与最多三条带卷次出处的事迹、「年份待核」组、就绪态提示与「保存范围只做查询」的说明；区域字段标注选填。
    - 验证：`node scripts/test-corpus-years.mjs`（纪年/干支/死亡陷阱/修剪/档案构建纯函数断言，带 `HISTORY_DATA_DIR` 时另以只读方式抽查记事原文 `instr()` 命中、跨度异常占比与最早年份 = 前 403）PASS；`test-plot-events`（区域留空匹配、候选记事年份/人物/原文逐条校验、采用后不再重复候选）、`test-corpus-auto`（`yearState='in-range'`、`plausible`、交集、事迹非空、待核组隔离、区域留空候选不变、范围外候选为空并提示手工新增）与 `test-setup`、`test-story-billing` 在隔离副本 + `DASHSCOPE_API_KEY=fixture-only` 下全部 PASS，`npx tsc --noEmit`、`npm run lint`、`HISTORY_TEST_BUILD=1 npm run build` 通过，全程零真实模型请求。第二批「模型补全生卒与事迹」未做（需另行批准外发与计费）。界面在 :3000 实跑核对：01 显示「区域（可留空）」与「范围只用于查询…保存不会触发生成」；03 候选人物卡片给出「李克用 · 生卒 未详—未详 · 活动 878—908 · 提及 163 次 / 51 卷 / 6 部」与三条带卷次出处的事迹、「年份来源：年纪锚点」、「年份待核」组只留年份不可考者；04 新增事件对话框按 904—907 查出通鉴记事、点「填入」后标题/起止年/出处（资治通鉴）/原文证据/参与人物（李克用、楊行密、李茂貞）同步写入且「已核对原文」保持未勾，随后取消，未在真实作品里保存任何数据。

阶段退出：通过 SC-013 的两章创作链及对应边界案例。T049 至 T054 已于 2026-11-17 完成，退出凭据为 `scripts/test-creation-chain.mjs`（`npm run test:chain`）在隔离副本与假模型流下的 PASS 记录；本阶段未覆盖项已逐条列在 T054 注记末尾。T056 于 2026-11-18 完成范围/史料只查询、候选人物按年份与候选事件三项口径，模型补全生卒与事迹作为第二批待批准。开放范围的补充资料提取、共享上传库、复杂概览和逐作品模型绑定另排期；旧实施记录不作为修订后行为的验收证据。

## 4. 依赖、里程碑与执行顺序

主顺序：1.1 → 2.1 → 3.1/4.1 → 5.1 → 6.1 → 7.1 → 8.1。

新增采集链为 T004 → T030 → T031 → T032 → T005/T007；模型约束链为 T003 → T029 → T023/T025；情节事件与大纲链为 T033 → T034 → T035 → T036 → T037，共用 5.1 的版本链与确认规则。原阶段 9 的本机全集链为 T040 → T041 → T042 → T043 → T044，参考小说链为 T040 → T045，二者汇入自动生成链 T046 → T047 → T048；`auto_runs` 只在该机固定完成后写入，避免证据校验落到非固定文本。当前改版以阶段 10 为优先：T049、T050、T051 可先各自推进，T052 采用 T050、T051 的产物，随后 T053、T054。原编号保留；事实提取等独立批次保留批次预算规则，正文入口不再要求整书预算或 Token 上限（REQ-035，见 T053）。

| 里程碑 | 对应任务 | 用户可见结果 | 不代表 |
|---|---|---|---|
| M1 资料与选人 | T001 至 T011、T029 至 T032 | 默认 25 部原文获取、覆盖可查、选人和关联检查 | 原文全集等于完整结构化事实库 |
| M2 可审阅方案 | T012 至 T018、T033 至 T037 | 写作规格、虚构设定、关系与大纲预览确认 | 审核结果等于客观史实 |
| M3 连贯性闭环 | T019 至 T025 | 章节草稿、审阅接受、版本影响、恢复和按量模型接入 | 模拟验证等于真实账单验证 |
| M4 本地交付 | T026 至 T028 | 导出恢复、可用界面与验收记录 | 已覆盖任意历史范围 |

不提供未经开发估算的工期承诺。影响工期的主要变量为首批历史资料质量、供应商能力差异和人工样章评审；不通过增加 Agent 数量绕过这些工作。

## 5. 预定项目结构

以下是实施目标，不在本轮创建空目录或代码骨架。领域文件按需新增，不要求每个任务拆出独立架构层。

```text
docs/
  spec.md
  plan.md
  checkpoints/
  acceptance.md                 实施验收时新增
src/
  app/                         本地页面、受保护业务接口
  components/                  选人、关系图、时间线、章节与任务界面
  lib/
    migrations/                显式 SQLite 迁移
    schemas/                   模型输出和资料包结构
    prompts/                   按任务版本化的提示模板
    ...                        计划中列明的领域模块
  worker.ts                    单任务固定工作流执行器
data/
  catalog/history-books.json   默认 25 部及版本卷篇来源目录
  samples/                     从原文建立的人工核定样例
  local/corpus/                原始古籍快照与清洗数据，忽略提交
scripts/fetch-history.ts       合规目录采集入口，不调用模型
README.md
.env.example
```

## 6. 验证与发布关卡

每项任务的完成条件是必需验收，不要求所有任务独立新建测试文件。实施时为高风险规则保留可重复执行的验证；本轮只制定验证要求，不运行不存在的应用测试。

| 关卡 | 验证内容 | 对应标准 |
|---|---|---|
| G1 事实与关联 | 人工核对样例；直接/间接/孤立、时间有效期、别名、未知时间、证据失效；25 部卷篇覆盖、许可、失败恢复、原文索引 | SC-001、SC-010、SC-011 |
| G2 审批与版本 | 直接请求未确认方案、并发修改、执行中方案变更、旧版结果不得自动成为当前章节；大纲新版本撤销上一次人工确认（`scripts/test-plot-events.mjs`） | SC-002、SC-004 |
| G3 正文与隔离 | 模拟输出故意注入无效 ID、时间错误、桥段和未来信息；连续三章人工复核 | SC-003、SC-009 |
| G4 调用与恢复 | 重复提交、限流、截断、自动续写上限、无进展、超时结果未知、进程终止、取消；模拟不计真实费用 | SC-005 |
| G5 安全与隐私 | 跨站写、路径穿越、超限文件、恶意文档；检查客户端资源/日志/备份无测试 Key | SC-006 |
| G6 备份与可用性 | 干净目录恢复、约定规模交互测量、桌面与窄屏人工或浏览器自动化操作 | SC-007、SC-008 |
| G7 真实供应商 | 用户本机配置百炼 Key，联调核对 Model ID、输入/输出用量、地域和当前计费模式；不公开内容或 Key | SC-003、SC-005、SC-006、SC-012 |

建议在现有 Node 工具链下使用轻量的单元/集成验证；UI 验收工具在实施阶段选择。模拟返回与真实 API 必须分开标注。未配置 Key 时 G7 未通过；古籍来源未获准、卷篇不完整或无核定样例时 G1 未通过。

创作链改版以阶段 10 任务及 SC-013 的验收记录为准；正式发布还须保留适用的 SC-001 至 SC-012 验收记录，G1 至 G7 无未处理阻断项。模型审阅不替代人工事实口径确认或原创性审查。真实 API 联调需用户自行配置 Key 并明确同意资料外发。

## 7. 需求映射

“预定证据”是未来实现位置，不是当前完成声明。任务依赖和完成条件见第 3 节；阶段 10 的修订条款映射如下，下面保留基础阶段的实现索引。

| 修订条款（阶段 10） | 任务 |
|---|---|
| REQ-001、REQ-037、REQ-040、REQ-057：路由、直达与作品归属 | T049 |
| REQ-003、REQ-004、REQ-007、REQ-046 至 REQ-048、REQ-050、REQ-052、REQ-054、REQ-055：范围、史料、候选刷新与旧证据复核 | T050 |
| REQ-009 至 REQ-011、REQ-049、REQ-053：作品写作规格版本 | T051 |
| REQ-019 至 REQ-025、REQ-049 至 REQ-051、REQ-056：剧情提案与章纲确认 | T052 |
| REQ-025 至 REQ-036：单章生成、连续性与恢复；含 REQ-035 正文不要求整书预算或 Token 上限 | T053 |
| SC-002、SC-004、SC-005、SC-009、SC-012、SC-013：两章创作链与旧作品续写回归 | T054 |

| 需求 | 摘要 | 计划项 | 任务 | 预定实现证据 |
|---|---|---|---|---|
| REQ-001 | 本地项目隔离 | 1.1 | T001、T002 | `src/lib/projects.ts` |
| REQ-002 | 历史覆盖与采集进度 | 2.1 | T006、T007、T032 | `src/app/projects/[id]/sources/page.tsx` |
| REQ-003 | 时间区域筛选 | 3.1 | T008、T010 | `src/lib/history-time.ts` |
| REQ-004 | 有依据候选 | 3.1 | T008、T010 | `src/lib/characters.ts` |
| REQ-005 | 别名与身份 | 3.1 | T008、T010 | `src/components/character-picker.tsx` |
| REQ-006 | 历史资料导入 | 2.1 | T004 | `src/lib/documents.ts` |
| REQ-007 | 证据核定追溯 | 2.1 | T005、T006 | `src/lib/history.ts` |
| REQ-008 | 分歧口径 | 2.1 | T005、T006 | `src/components/source-viewer.tsx` |
| REQ-009 | 参考小说导入 | 2.1 | T004 | `src/lib/document-schema.ts` |
| REQ-010 | 写作规格 | 4.1 | T012、T014 | `src/lib/style.ts` |
| REQ-011 | 原作隔离与文档指令 | 2.1 | T007 | `src/lib/context-policy.ts` |
| REQ-012 | 直接关系 | 3.1 | T009 | `src/lib/relations.ts` |
| REQ-013 | 间接路径 | 3.1 | T009 | `src/lib/relations.ts` |
| REQ-014 | 未关联提示 | 3.1 | T011 | `src/components/association-report.tsx` |
| REQ-015 | 时间冲突 | 3.1 | T011 | `src/lib/consistency.ts` |
| REQ-016 | 新增虚构设定 | 4.1 | T013、T014 | `src/lib/fiction.ts` |
| REQ-017 | 分类与非自动升级 | 4.1 | T013、T014 | `src/lib/schemas/fiction.ts` |
| REQ-018 | 史实冲突边界 | 4.1 | T013 | `src/lib/fiction.ts` |
| REQ-019 | 章节场景规划 | 5.1 | T015 | `src/lib/planning.ts` |
| REQ-020 | 双时间顺序 | 5.1 | T015、T016 | `src/lib/schemas/plan.ts` |
| REQ-021 | 人物关系预览 | 5.1 | T016 | `src/components/relationship-graph.tsx` |
| REQ-022 | 时间与情节线 | 5.1 | T016 | `src/components/story-timeline.tsx` |
| REQ-023 | 证据编辑联动 | 5.1 | T016 | `src/app/projects/[id]/plan/page.tsx` |
| REQ-024 | 确认与强制关卡 | 5.1 | T017 | `src/lib/approvals.ts` |
| REQ-025 | 版本与确认失效 | 5.1 | T018 | `src/lib/revisions.ts` |
| REQ-046 | 事件候选即时推导 | 5.1 | T033 | `src/lib/plot-events.ts` |
| REQ-047 | 事件采用与证据校验 | 5.1 | T034 | `src/app/api/projects/[id]/events/route.ts` |
| REQ-048 | 事件时间与范围重叠 | 5.1 | T034 | `src/lib/history-time.ts`、`src/app/api/projects/[id]/events/route.ts` |
| REQ-049 | 大纲 dry-run 与外发授权 | 5.1 | T035 | `src/app/api/projects/[id]/outline/route.ts` |
| REQ-050 | 稳定证据引用（旧实现按位置编号） | 5.1 | T033、T035 | `src/lib/plot-events.ts` |
| REQ-051 | 新版本撤销人工确认 | 5.1 | T036 | `src/lib/story-plan.ts` |
| REQ-052 | 本机全集固定为默认史料 | 9.1 | T040、T041、T042 | `src/app/api/projects/[id]/corpus/route.ts`、`src/lib/source-text.ts` |
| REQ-053 | 默认固定参考小说且只注入抽象规格 | 9.1 | T045 | `src/lib/reference-spec.ts`、`src/app/api/projects/[id]/references/route.ts` |
| REQ-054 | 史料人物候选与强关联默认勾选 | 9.1 | T043、T044 | `src/lib/corpus-persons.ts`、`src/app/api/projects/[id]/persons/route.ts` |
| REQ-055 | 候选准备与幂等运行日志 | 9.1 | T046 | `src/lib/auto-setup.ts`、`src/app/api/projects/[id]/auto/route.ts` |
| REQ-056 | 剧情提案、章纲生成与来源标注 | 9.1 | T046、T047 | `src/lib/outline-generate.ts`、`src/components/panels/outline-panel.tsx` |
| REQ-026 | 上下文与知识边界 | 6.1 | T019 | `src/lib/context.ts` |
| REQ-027 | 顺序生成与接受 | 6.1 | T020、T022 | `src/lib/generation.ts` |
| REQ-028 | 检查与有限修订 | 6.1 | T021 | `src/lib/review.ts` |
| REQ-029 | 改稿与下游复核 | 6.1 | T022 | `src/components/chapter-editor.tsx` |
| REQ-030 | 任务持久化恢复 | 7.1 | T024 | `src/lib/tasks.ts` |
| REQ-031 | 幂等与未知结果 | 7.1 | T024 | `src/worker.ts` |
| REQ-032 | 取消与重试 | 7.1 | T024、T025 | `src/components/task-panel.tsx` |
| REQ-033 | 商业 API 环境配置 | 1.1 | T001、T003 | `src/lib/config.ts` |
| REQ-034 | 结构与业务校验 | 6.1 | T019 | `src/lib/schemas/output.ts` |
| REQ-035 | 正文调用边界与用量 | 7.1 | T023、T025 | `src/lib/budget.ts` |
| REQ-036 | 资料外发同意 | 7.1 | T023 | `src/lib/consent.ts` |
| REQ-037 | 本地安全边界 | 1.1 | T001、T003 | `src/lib/security.ts` |
| REQ-038 | 导出备份恢复 | 8.1 | T026 | `src/lib/backup.ts` |
| REQ-039 | 脱敏诊断 | 1.1 | T003 | `src/lib/diagnostics.ts` |
| REQ-040 | 规模与可用性 | 8.1 | T027、T028 | `src/app/globals.css`、`docs/acceptance.md` |
| REQ-041 | 默认 25 部古籍目录与获取 | 2.1 | T030、T031 | `data/catalog/history-books.json` |
| REQ-042 | 合规限速与断点采集 | 2.1 | T030、T031 | `src/lib/corpus-fetch.ts` |
| REQ-043 | 原文溯源清洗与增量索引 | 2.1 | T032 | `src/lib/corpus-index.ts` |
| REQ-044 | 百炼模型选择约束 | 1.1 | T029 | `src/lib/model-catalog.ts` |
| REQ-045 | 百炼地域、权限与计费模式 | 1.1 | T029、T023 | `src/lib/bailian.ts` |
| REQ-057 | 路由、直达与作品归属 | 10.1 | T049、T054 | 作品路由、现有作品 API |
| REQ-061 | 区域选填与保存范围只查询 | 9.1 | T056 | `src/app/api/projects/[id]/scope/route.ts`、`src/components/character-picker.tsx` |
| REQ-062 | 候选人物按生卒交集并展示事迹 | 9.1 | T056 | `src/lib/corpus-years.mjs`、`src/lib/person-years.ts`、`src/lib/corpus-persons.ts` |
| REQ-063 | 基于史料/人物/时间的候选事件 | 9.1 | T056 | `src/lib/corpus-events.ts`、`src/app/api/projects/[id]/events/candidates/route.ts`、`src/components/panels/event-panel.tsx` |

追踪文件：[需求到计划](checkpoints/spec-to-plan.yaml)、[计划到任务](checkpoints/plan-to-tasks.yaml)。它们记录此前基线的文档覆盖；本次修订的任务映射以阶段 10 为准。

## 2026-10-28 本地选人与虚构设定实施记录

已接通本次需求的手动核定流程：历史范围保存 → 从导入原文补充活动证据 → 提供匹配候选并勾选 → 自动检查历史关联 → 新增、编辑、删除虚构设定。范围变化重新检查，保留已选但不再匹配人物并明确提示；旧人物选择接口也执行匹配校验。

实现位置：`src/app/api/projects/[id]/setup/route.ts`、`src/components/character-picker.tsx`、`src/lib/migrations/002-creative-setup.sql`。旧数据保留；没有活动信息的旧人物列入证据不足。关联只使用本作品历史资料中的、用户显式核定且时间有效的关系；展示至多三条最短路径及方向、时间、原文出处。虚构设定独立存储，不进入史实关系图。修改保存时增加项目版本。

验证：生产构建、ESLint、隔离临时 SQLite 数据目录下的 HTTP 验收（`scripts/test-setup.mjs`）；浏览器检查候选缺口、过期选择、无关联提示和虚构入口。测试资料显式标记为软件测试虚构文本，未写入日常作品数据库，未调用商业模型。

仍未完成：默认古籍索引与自动提取、别名映射、多活动记录、生卒冲突审核、虚构设定史实冲突审核、方案预览和正文生成；其中事件参与关联已由 2026-11-13 情节事件实施覆盖（`plot_events`、`plot_event_participants`，见 T033、T034），方案预览中的人物关系图和章节情节线仍待实施。因此 T004–T014 的完整验收条件仍未全部满足，不勾选为全部完成。

## 2026-10-28 MOBI 转换与全文参考试运行

用户新增要求：使用 `data/local/ebooks` 中提供的 MOBI 作为全文参考，并完成一次唐末五代生成。

已实现 `scripts/convert-mobi.py`（mobi 0.4.1 / BeautifulSoup 4.15.0）、`src/lib/mobi.ts` 和资料上传接口/界面：参考小说可导入未加密 MOBI，限 32 MB；保留源文件、哈希、文本、目录目标定位清单；不执行电子书脚本，不访问远程资源。转换工具安装在被忽略的本地 Python 环境，依赖见 `scripts/requirements-mobi.txt`。

已转换五卷中文文件，共 3,084,943 字符，403 个目录条目目标全部可定位，0 个编码替换字符。这证明所给文件的提取与目录定位通过，不证明出版版本无删节。分析范围包括前言、目录、正文与附录，模型被要求区分材料类型。

专用 CLI `scripts/analyze-reference-trial.mjs`：全量连续分块 → Flash 抽象分析 → Flash 汇总写作规格 → Max 一次正文 → Flash 复核。调用单槽串行、输入哈希缓存、请求意图和用量落盘、不自动重试；未接入网页章节管理，不替代完整 T012–T025。参考小说原文不进入正文生成请求。测试构建使用 `HISTORY_TEST_BUILD=1` 的 `.next-test/`，避免与已有开发服务共用编译产物。

本次状态：真实分析完成 16/22 块（2,294,534 字符），第17块被百炼 HTTP 403 `AllocationQuota.FreeTierOnly` 拒绝；正文尚未生成。已完成结果缓存于 `data/local/trials/tang-full-reference/calls/`；进度见 `progress.json`。返回输入 1,586,042 Token、输出 9,541 Token，按标价估算约 1.2946 元，不代表实际账单。待用户解除模型免费额度限制或明确选择部分分析测试稿。

验证通过：五卷转换及哈希/目录/编码检查、损坏/加密拒绝、隔离数据库下真实 HTTP 上传与重复/分类校验、ESLint、独立生产构建。没有修改用户现有作品数据，也没有把部分分析标为全文完成。

端点适配更新：用户更新 Key 与 URL 后，支持北京百炼 `llm-*.cn-beijing.maas.aliyuncs.com` 工作空间 API Host，并统一补全 `/compatible-mode/v1`。官方依据：https://help.aliyun.com/en/model-studio/regions/ 。应用配置与两个试运行脚本共用 `src/lib/bailian-endpoint.mjs`。新端点第17块请求返回 HTTP 403 `insufficient_quota`，尚未得到新增分析或正文；旧16块仍复用。未回退其他服务或模型。

### Token Plan 续跑完成（2026-10-28）

用户明确改用 Token Plan 后，共用端点校验器支持北京官方 Token Plan 地址，应用模型信息与首页同步展示订阅模式。没有回退按量端点；调用结果记录 billingMode，Token Plan 不折算人民币或 Credits。端点安全测试、ESLint、独立生产构建通过。

全文22/22块全部完成，3,084,943字符连续覆盖；复用旧16块，新增Token Plan调用9次（剩余6块、规格汇总、正文、复核）。新增调用返回输入573,936 Token、输出7,150 Token，实际Credits以控制台为准。完整流程累计25个成功请求。

输出：`data/local/trials/tang-full-reference/draft.md` 为《汴水换旗》修整试写；`draft.raw.md`保留Max模型原稿，`writing-spec.md`为全文分析抽象规格，`review.md`保留辅助模型报告，`editorial-review.md`记录助手编辑纠正的指令泄漏、史实对象、视角知识和日期问题，`report.json`及`progress.json`记录最终状态。仍为待人工史实审核草稿，不标记为完整产品交付或人工核定通过。

## 2026-11-13 情节事件与大纲规划（P4）实施记录

已接通生成策略步骤的规划链路：`src/lib/migrations/005-plot-events.sql`（在 `src/lib/db.ts` 的 `ensureSchema` 中注册）新增 `plot_events` 与 `plot_event_participants`，标题限 1 至 120 字符，`kind` 分历史与虚构，`status` 分候选、已采用、已否决，`origin` 分派生与手动，年份按无零年天文纪年存储并经 `historicalToAstronomical`/`astronomicalToHistorical` 转换，附 `CHECK(start_year <= end_year)`、`UNIQUE(project_id, source_key)` 和 `plot_events_project_status_idx`；参与人物的参与方式限定主导、出席、对立。

事件候选不落库缓存：`src/lib/plot-events.ts` 的 `derivedCandidates` 每次从 `character_activity`（每人一条）和 `historical_relations`（每条关系一行）即时推导，用 `activity:{characterId}`、`relation:{relationId}` 作为稳定来源标记去重，已采用的来源不再出现在候选中。这样修订出处记录立刻反映到候选，不需要重新同步，也不产生与来源不同步的派生副本。`outlineEvidence` 把已采用、属历史且有原文证据的事件按（起始年份、创建时间）排序编号为 E1…En，上限 60 条；编号是位置式的，改动已采用集合会改变编号指向，因此大纲写入前逐条重新校验引用，该风险已作为已知限制记入规格第 7 节。

接口：`src/app/api/projects/[id]/events/route.ts` 提供 scope、events、candidates、people、sources 读取和 adopt、add、update（含 adopt/reject/restore 与整条编辑）、remove 写入，历史事件必须选择本作品 `category='history'` 资料、证据为原文子串且经确认（与 `/setup` 同口径），虚构事件不要求证据，事件时间需与当前范围重叠，参与人物限本作品已有人物且不超过 12 位；读请求要求 `isLoopbackRequest`，写请求要求 `isSameOriginLoopback`。`src/app/api/projects/[id]/outline/route.ts` 的 POST 默认 `preview` 为 dry-run，只返回将要外发的完整 prompt 与 Token、人民币上限估算，`generate` 需 `allowExternalTransfer === true` 才调用 `qwen3.8-max` 并返回 `issues` 与 `accepted` 且不写库，PUT 才落库。上下文由 `buildGenerationContext` 从范围、证据、已选人物、范围内关系、虚构设定和固定约束构建，替代原先的静态试跑输入；`data/local/trials/tang-five-dynasties` 仅作为无 `generationContext` 的旧规划回退。

版本链抽出为 `src/lib/story-plan.ts` 的 `commitPlan(projectId, plan, expectedVersion)`，`story` 与 `outline` 两条写入路径共用。审批记录 `story_plan_approvals` 以 (project_id, plan_version) 为主键，因此任何新版本都会让上一次人工确认自动失效；正文草稿仍绑定各自版本；存在 `status='generating'` 章节时拒绝改版本；`PlanVersionError` 映射 HTTP 409。

验证：`scripts/test-plot-events.mjs` 在 `HISTORY_DATA_DIR` 指向的隔离数据目录和本机 dev server（默认 `http://127.0.0.1:3000`）上覆盖候选推导、采用与重复采用、缺出处/非原文证据/未确认/超出范围的四类拒绝、否决与恢复、dry-run 预览、缺少外发确认的生成拒绝、PUT 版本链与大纲新版本撤销人工确认、清空事件后 outline 重新阻塞。脚本不发起任何真实模型请求，`generate` 的真实外呼路径尚未联调。P5 产物栏宽幅正文展示与 P6 删除剩余手写 CSS、全量回归未在本轮范围，已由下一条 2026-11-14 记录接续完成。

## 2026-11-14 界面布局与产物栏（P5/P6）实施记录

界面部分收尾。其前 P1 至 P3 已交付：Tailwind 4 与 shadcn/ui（`src/components/ui`，15 个组件）、纸墨色板映射为 shadcn 令牌（`src/app/globals.css` 的 `:root`/`@theme`）、rail + 配置栏 + 产物栏三列外壳（`src/components/workbench-shell.tsx`，`h-dvh` 且三列各自独立纵向滚动，<1280 时配置栏转 Sheet 抽屉）、五步手风琴配置栏（`src/components/config-column.tsx`，步骤状态由范围/资料/人物/事件/方案版本真实数据推导，底部常驻上一步/下一步）。

P5 产物栏：`src/components/chapter-workspace.tsx` 改为「目录 / 正文」双视图。目录视图保留章纲编辑（标题、视点、史料编号、梗概、情节节点、章末钩子、排序与增删）与逐章生成、失败恢复入口；正文视图一次只读一章，正文区按 `--reading-measure`（88ch）居中、衬线、行高 1.9，工具条提供小/中/大字号档位，生成中显示已保存字符数与最近保存时间（正文随轮询增量可见，刷新不丢），中断章节提示回目录处理；新增「导出全文」，把已有正文按 Markdown 拼成文件并本地下载，不上传任何内容。

P6 全站样式：`src/app/globals.css` 由 1,284 行减至 197 行，删除 86 个手写类与对应媒体查询，只保留 `@import`、纸墨与 shadcn 令牌、`@theme inline`、`.dark` 与最小基准（含标题/段落 `margin: 0`，替代原遗留排版基线）。概览、模型与密钥、配置各步、详情、对话框均已使用 shadcn 组件与 Tailwind 工具类，不再依赖遗留类名。

验证：`npx tsc --noEmit` 通过；`npm run lint` 仅剩 `eslint.config.mjs` 既有的匿名默认导出警告；`npm run build` 通过。浏览器在 `http://127.0.0.1:3000` 逐屏核对：概览、故事方案的目录与正文两视图、字号切换（19px 生效）、导出提示「已导出 1 章正文」，并用脚本确认配置栏（543/503）与产物栏（5196/572）为两个独立滚动容器。窄视口抽屉沿用 P2 实现，本轮未改动，也未重复截图。

## 2026-11-15 本机全集固定、史料人物候选与确认后自动生成（P7）实施记录

四项需求（REQ-052 至 REQ-056）落地为阶段 9 的 T040 至 T047，T048 回归脚本单独收尾。

存储与固定：`src/lib/migrations/006-corpus-source.sql` 增加 12 张表，其中 `corpus_book`/`corpus_volume` 保存本机维基文库采集的 25 部 / 3,563 卷原文与 `text_sha256`，`corpus_person`/`corpus_person_edge`/`corpus_person_blocks` 保存启发式人名索引、同段共现边与用户否决名单，`corpus_state` 记录 corpus／persons／references 三类构建哈希与时间，`project_corpus`/`project_reference` 把全集与参考小说固定到具体项目，`project_auto_settings`/`auto_runs` 保存自动生成的口径与逐次结果。`scripts/index-corpus.mjs` 与 `src/lib/corpus-import.mjs` 的 `iterateCorpusVolumes` 以流式方式读卷，`src/lib/source-text.ts` 的 `assertEvidenceInSource` 在 SQL 侧用 `instr(text, ?)` 判断证据子串，3,446 万字不进入 Node 进程。界面资料步骤据此把“已固定古籍 + 已固定参考小说”判为完成，仅有自备上传时降为待补充（`src/components/config-column.tsx`）。

史料人物候选：`scripts/index-corpus-persons.mjs` 用书名号外的词典匹配加动词邻接抽取人名，按（提及次数、命中卷数、书名）排序并保留字面原文片段与原文链接；边只在两个名字同处一段时写入证据，此前回退成 `${a} ${b}` 的合成片段会让所有共现证据在 `instr()` 校验下失败，已改为截不出片段就留空。强关联阈值为同段共现 ≥6 次且跨 ≥2 卷。`src/lib/corpus-persons.ts` 暴露 `corpusPersonCandidates`（默认勾选名单）、`corpusPersonPairs`（自动生成用的人名对与证据）和 `importCorpusPersons`（幂等导入，返回 inserted/skipped）。API 为 `src/app/api/projects/[id]/persons/route.ts` 的读取加 `import`、`block`、`unblock`，写操作要求同源本机；本机古籍全集的抽取不使用任何模型，零 Token。

参考小说：`scripts/register-reference-novels.mjs` 把已转换的《冰与火之歌》五卷 MOBI 产物登记为系列，按卷级哈希合并值匹配 `reference_spec` 的抽象写作规格；`activeReferenceSpec` 在文件重转导致哈希变化时返回漂移原因，`src/lib/plot-events.ts` 的 `buildGenerationContext` 仍只注入规格文本，`originalWritingSpecification` 保持为空，原文不进提示与产物。界面默认固定该系列，可改选或取消。

确认后自动生成：`src/lib/auto-setup.ts` 的 `confirmAndGenerate` 依次写范围（历史纪年转天文纪年）、导入史料人物、按强关联对写入 `historical_relations`（`review_status='auto'`，逐条证据校验，未命中的单独计数报告）、采用 `derivedCandidates` 派生事件（上限 40，`source_key` 去重），再用 `localOutlinePlan` 把已采用事件按年代均分成分章骨架——余数摊给前几章以避免空章节通不过 `validPlan`；骨架与当前规划 `sha256` 相同则不新增版本，从而不撤销既有的人工确认。只有 `outlineMode='model'` 且项目已存 `allowExternalTransfer` 且服务端配置 Key 时才调用模型覆盖，`local`/`off` 分别止步骨架或跳过。`src/lib/outline-generate.ts` 抽出提示词、估算、调用与校验，`src/app/api/projects/[id]/outline/route.ts` 与自动路径共用同一实现，HTTP 契约不变。`src/lib/event-writes.ts` 统一手动、采用与自动三条事件写入路径。规划新增可选 `origin` 字段（local/model/manual），大纲面板与方案面板据此标注来源并显示写作规格字数。
界面接通 T047：`src/components/document-import.tsx` 顶部新增本机古籍与参考小说两区并保留上传（现标为补充资料），`src/components/character-picker.tsx` 新增“史料人物候选”区（强关联计数、勾选、查原文、不再显示与恢复）和“确认范围与人物并自动生成”按钮，直接回显 `auto_runs` 的逐步结果。浏览器核对隔离实例：资料步骤徽章、人物候选区、自动生成后的步骤列表与“正文仍需逐章人工批准”提示均符合预期；修掉了 `references.registered` 字段名与 `corpus_state` 计数别名两处导致 React key 缺失和“N 卷”显示为对象的问题。

验证与事故记录：`npx tsc --noEmit`、`npx eslint` 与 `HISTORY_TEST_BUILD=1 npm run build` 通过；隔离数据目录（`HISTORY_DATA_DIR=/tmp/note-corpus-test`）里跑通固定、候选导入、强关联证据校验、骨架大纲证据编号零缺失、重复运行幂等（人物/关系/事件/规划四步全部 ok 且不新增版本）、409 版本冲突与 400 未知证据编号拒绝。T048 收尾为 `scripts/test-corpus-auto.mjs`（`npm run test:auto`，缺少 `HISTORY_DATA_DIR` 直接退出，末尾清理测试项目）：断言新建项目即自动固定全集与参考小说、伪造出处与非原文子串的证据均被 400 拒绝、默认勾选人物逐条能在固定卷里 `instr()` 命中、骨架大纲 `origin='local'` 且引用全部落在证据集合内、提示词与规划中检索不到参考小说的 40 字中段切片、重跑后 `story_plans.version` 未变。接口口径记录：`/auto` 的 POST 直接返回 `{ ok, run }`，GET 返回 `{ settings, lastRun }`，前端两处都按各自形状读取。真实 workspace 的 `corpus_state(kind='persons')` 仍是别名修复前的 0，需要重新执行一次 `npm run corpus:persons` 才会在界面上显示正确条数。需要如实记录的偏差：开发用的 `.env` 含真实 `DASHSCOPE_API_KEY` 且被 `next dev` 自动加载，在验证 `outlineMode='model'` 分支时误发了 2 次真实 qwen3.8-max 大纲调用（生成 plan v2 与重跑 v4），未经用户授权；此后所有验证改在 `outlineMode='local'` 下进行。另有一次教训：在服务运行期间直接对隔离库写入并 `wal_checkpoint(TRUNCATE)` 会让服务瞬时的表可见性判断出错（报 `no such table: corpus_book`），回归一律走 API 与脚本，不再手工改活跃数据库。README 的采集、索引、登记三步命令与真实 Key 风险提示同步更新。

## 2026-11-17 章节多选队列与章纲改版保留（T055）实施记录

需求口径（REQ-058、REQ-059）：章节支持多选并在前端形成队列自动生成与自动确认，明确只是交互调整，生成逻辑仍逐章调用；「AI 生成下一章」后保存章纲产生的新版本不得重置已确认章节，需保留已确认内容。

改版保留落在服务层唯一的写入口：`commitPlan` 在插入 `story_plan_revisions`、更新 `story_plans` 与项目版本的同一事务里调用新增的 `carryForwardChapters`，因此本地骨架章纲、模型大纲与人工保存三条路径一并生效，不需要各路径自己去补正文。判定用 `chapterSignature`（标题、视点、时间设定、梗概、情节节点、史料编号、虚构设定、章末钩子）而不是整章 JSON 比对，`generationContext` 快照重建不会误伤。继承规则：本章签名未变、该章草稿是 `accepted` 且非待复核、且它之前的章节在新版本里同样被完整继承（`prefixIntact` 逐章传递）时，草稿正文、`input_hash`、用量字段与 `chapter_states` 状态行原样写入新版本；其余情况正文照抄但 `needs_review=1` 并写原因，状态行转为 `stale`，从而既不丢字也不让旧故事状态静默进入新请求。继承行清空 `active_attempt_id`、`auto_continuations` 归零，避免旧进程的检查点写入挂到新版本的行上；`generating` 与 `failed-or-unknown` 的草稿不在继承集合内，旧版本行与 attempt 全部留档，界面据此把该章显示为未生成并要求人工核对用量后重新请求。PUT 回显 `carried/preserved/needsReview`，`savePlan` 用它拼出「N 章正文与故事状态原样保留、M 章需复核」的说明。方案级确认仍随新版撤销（REQ-051），改为在章节工作台提供同页「就地确认方案与资料外发」补做，避免为一次改版把作者推回左侧步骤。

队列落在前端编排层：`story-provider` 的 `startQueue` 逐章读 `dataRef`（`data` 的所有写入统一走 `commitData` 镜像，异步循环才不会拿旧 `version`/`planHash` 和旧的本章状态），已接受即跳过、无草稿才 `runChapter`、`generating` 只用 `waitForDraft` 等落定而不补发请求，随后才 `acceptChapter`；任何一步失败或状态未知都带原因停下，`stopQueue` 只置 `stopRequested` 让下一次调度点退出，不打断已在后台推进的流式任务。`runChapter`/`acceptChapter` 改为返回 `{ok, status/error}`，队列据此判断，界面原有单章按钮行为不变。`chapter-workspace` 的多选、全选可入队、进度与停止入口都在目录视图内，队列进行中禁用增删排序、保存目录、AI 续设下一章、改写与接受，防止与队列争抢同一版本链。服务端没有新增队列接口，也没有放宽 REQ-027 的单章单请求。

验证：`npx tsc --noEmit` 通过、`npm run lint` 仅剩既有 `eslint.config.mjs` 匿名默认导出警告；`scripts/test-chapter-stream.mjs` 的 `call` 加 `method` 参数后新增改版段——先把前文改写留下的两处待复核复核干净，再改章第三章纲并追加一章，断言 `{carried:3, preserved:2, needsReview:1}`、章一章二正文与 `confirmed` 状态在新版本原样存在、章三正文保留但转待复核且状态 `stale`、新章与中断章在新版本没有草稿行、未重新确认被 409 拦下、待复核前章拦下后续生成、复核接受即恢复 `confirmed`，最后按 `requests.jsonl` 逐章计数核对 `{2,3,3,6}`：改版后只有未生成章节各发一次任务（含两次自动续写），已接受章节一次都不重发。脚本在临时隔离目录与 `DASHSCOPE_API_KEY=fixture-only` 下 PASS，全程零真实模型调用。`HISTORY_DATA_DIR=` 空串会被服务端 `||` 判空后回退到真实 `data/local`，因此脚本改用 `?.trim()` 并在解析后拒绝仓库目录与 `data/local`（`HISTORY_DATA_DIR=.` 与 `=data/local` 均在启动服务前断言失败）。队列状态在 `startQueue` 入口即写入本次 `ids`，全部章节已接受、循环内不再更新时末态也不会指向上一次选择。界面侧另在隔离实例（独立 `HISTORY_DATA_DIR`、注入假模型流、`DASHSCOPE_API_KEY=fixture-only`）实跑一遍：目录视图多选后队列栏显示「已选 4 章 · 按目录顺序逐章生成，每章仍是一次独立请求」，逐章生成→自动接受按顺序推进；「AI 续设下一章」后保存目录回显「章节目录已保存为第 2 版；3 章已接受正文与故事状态原样保留，1 章因章纲或前文变化需复核，复核后重新接受即可，方案级确认需重新做一次」，就地确认后已接受章节仍在原位、已写正文未丢。`HISTORY_TEST_BUILD=1 npm run build` 通过（产物写 `.next-test/`）。

## 2026-11-18 剧情调整后的章纲与正文重新生成（REQ-060）实施记录

需求口径：剧情提案调整后已保存章纲失去有效绑定时必须有重新生成入口；「章节目录（章纲设定）」与「章节正文」两类都支持全部重新生成或自行多选指定章节重新生成；章节正文不得组合生成，一次调用只生成一章（不放宽 REQ-027）。已确认的取舍：旧正文覆盖前归档到备份表并可恢复；入口同时放在章纲步骤与章节工作台；按章重生成章纲只重写所选章节、其余不动；正文重生成后默认不自动接受。

存储落在 `src/lib/migrations/012-draft-backups.sql` 新增的 `chapter_draft_backups`（`id/project_id/plan_version/chapter_id/chapter_title/content/meta_json/status/input_hash/request_id/reason/archived_at`，索引 `(project_id, plan_version, chapter_id, archived_at DESC)`），由 `src/lib/db.ts` 在 010 之后注册。归档表按 `(作品, 章纲版本, 章节)` 留存，只存非空正文：`archiveDraft` 在本章正文为空时直接返回 false，避免为没写过字的章节留下看起来能恢复的空行。

`src/app/api/projects/[id]/story/route.ts` 加两个动作。`regenerate` 要求 `regenerateConfirmed`，依次拦下「未确认（400，零请求）」「本章没有草稿（409，提示改用生成本章）」「本章正在生成（409）」「中断/状态未知（409，先续写，整章重写会把已收到的检查点一并归档掉）」；派发事务里先 `archiveDraft`，再把 `content/meta_json/raw_output/request_id` 清空、状态转 `generating`、`needs_review` 与 `auto_continuations` 归零，并 `invalidateChapterState` + `markFollowingChapters`。关键点是提示词前缀取空串而不是旧正文，覆盖是整体重写而非接在末尾续写；attempt 的 `initiator` 新增 `manual-regenerate`，与 manual / manual-resume / auto-continuation 区分开，账单与重试判断不会把重写当成续写。`restore` 只读归档不发模型请求，且写回旧文之前先把当前正文归档，因此覆盖与恢复来回切换任何一次都不丢字；恢复后本章转 `draft`、状态失效、其后章节待复核。GET 新增 `?backup=<chapterId>` 单章原文读取（不随整页轮询下发全部旧稿），章节列表子查询补 `backupCount/backupAt/backupChars`。

`src/app/api/projects/[id]/chapter-plan/route.ts` 的按章重生成把原来「只能续写最后一章之后」的单一形态拆成 `PlanningTarget`（append / regenerate）：`chapterAt` 定位本章在已保存目录中的位置与前后邻章，`rewriteSystemPrompt` 要求保住目录位置、承接前章钩子、给出能与后章现有设定衔接的收束与新钩子、且不得照抄原设定；送进提示词的邻章只取白名单字段（`chapterView`/`neighborFrom`），允许前端在同一轮多选里把刚生成、尚未保存的邻章设定随请求带上，否则连续重写相邻章节时钩子链会接在旧版上。`blockReason` 不再要求「必须有前一章」，改为 `proposalGateReason` 优先拦下过期绑定——避免花 Token 生成一份保存不进去的章节。一次调用仍严格返回一章，响应带 `chapterId`。

界面侧 `src/components/story-provider.tsx` 增加 `regenerateChapterPlans(chapterIds)`：只走 `/chapter-plan`、一次一章、不落库，结果实时并入 `planRef` 维护的本地草稿并 `setDirty(true)`，失败即停并保留已重生成部分，由作者逐章审阅后统一「保存章节目录」产生新版本（已接受正文的保留与待复核标记仍由服务端 `carryForward` 决定，前端不自作聪明）；配套的 `planQueue` 状态与 `stopPlanQueue` 让进度、停止和原因在界面上可读。`startQueue` 的 `regenerate` 口径是「已有正文的走覆盖、还没有正文的直接生成」，仍逐章串行、一章一请求。`chapter-workspace.tsx` 的勾选框改为通用多选（全选 / 全选可入队 / 全选有正文 / 清空），批量队列按 `queueableReason` 过滤后才发请求；新增重新生成区（章纲：全部或所选；正文：全部或所选，含覆盖确认与默认关闭的自动接受，并提示「第 N 章之前还有既未接受也未选中的章节，队列会在该章停下」——这是顺序门禁的必然结果，不是可绕过的实现细节）；每章卡片新增 `DraftBackup` 子组件用于查看上一版正文与恢复。`outline-panel.tsx` 不再在 blocked 时收起整个操作区：提案类拦截（`proposalBlocked`）保留操作区并给出「去剧情提案步骤重新选定」与「到章节工作台按章重生成」两条跳转，已有章纲时生成按钮改为「重新生成整本章纲」，并说明新版按章节继承已接受正文、被改写的章节转待复核。

验证：`npx tsc --noEmit` 通过，`npm run lint` 仅剩既有 `eslint.config.mjs` 匿名默认导出警告，`HISTORY_TEST_BUILD=1 npm run build` 通过。新增 `scripts/test-regenerate.mjs`（`npm run test:regen`）在临时隔离目录、`DASHSCOPE_API_KEY=fixture-only`、假模型流下 PASS，全程零真实调用：断言未确认覆盖 400 且零请求、普通 generate 对已有草稿仍 409、覆盖后正文不含旧文（不是续写）、默认不自动接受、其后章节转待复核且旧状态 `stale`、`?backup=` 取回旧文、恢复后 `backupCount=2` 且最近归档是重生成版本、generating 与不存在的章节分别 409/404、章纲重生成一次调用只发一章且请求带 `chapterNumber` 与本章/前章/后章三份设定、未知 chapterId 409、缺外发确认 400、保存新版 `{carried:3, preserved:1, needsReview:2}`、前章仍 `accepted` 且后章正文原样带入、新增已采用史实后 outline 回显 `proposalBlocked`/`proposalIssue` 且两类重新生成均 409 带「提案」、归档表恰有 3 行且无空正文。`scripts/test-chapter-stream.mjs` 复跑 PASS，无回归。`scripts/test-story-billing.mjs` 与 `scripts/test-plot-events.mjs` 需要本机常驻 dev server 且默认读写真实 `data/local`，不属于 fixture 隔离套件，本轮尝试未取得有效结果（未启动服务时请求直接超时）。界面改动（重新生成区、多选、归档面板、outline 跳转入口）只做了类型与构建级校验，未在浏览器实跑，实际交互与文案排版仍需人工过一遍。

## 2026-11-18 勾选列表全选、章纲分组生成与正文目录侧栏（REQ-064—REQ-066）实施记录

需求口径：其一，「人物和事件冲突支持全选」经确认作用在人物与事件的勾选列表上（「冲突」只是剧情提案的文本字段，不是勾选清单），全选要覆盖候选人物、「年份待核」组、已选人物、候选事件核对与事件弹窗的参与人物。其二，「章节数量不限制，10 章一组一次调用生成，超出自动分组逐组生成」经确认作用在大纲／章纲路径，并采用「放开数量 + 兜底上限」——所有硬编码的 1–24 与 50 章上限放开，只保留 1000 章的防御上限；正文与按章重生成不放宽。其三，「正文章节在内容区域左侧固定展示，左右独立滚动」选择 sticky 侧栏形态，不改项目工作台已有的单一滚动容器。

数量上限集中在新增的 `src/lib/plan-limits.ts`（`MAX_PLAN_CHAPTERS = 1000`、`OUTLINE_GROUP_SIZE = 10`）：`src/lib/story-plan.ts` 标了 `server-only`、界面面板取不到，因此常量单独成模块。`validPlan` 的「最多 50 章」改为该常量，`outline/route.ts` 对 `plannedChapters` 的校验、`outline-panel.tsx` 章数输入框的 `max`、`chapter-workspace.tsx` 本地骨架章数的上限都改为读它，四处不再各写各的数字。

分组生成落在改写的 `src/lib/outline-generate.ts`。`outlineGroupCount` 把计划章数折算成组数；`outlineGroupPayload` 在原有整本上下文之外加 `range`（`from`/`to`/`totalChapters`/`groupSize`/`generatedBefore`）、`book`（第一组的整本设定）与 `previousChapter`（上一组末章的 id、题名、梗概、章末钩子、史实编号），并把「本次只输出第 x 至 y 章……上一章《题名》的章末钩子是『……』，本章要接上它而不是复述它」写进 `instructions`；`groupMaxOutputTokens` 按本组章数折算输出预算（1000 + 1100 × 章数，20000 封顶），`outlineEstimate` 返回「单组请求体 + 组数 + 按组累加的合计用量」；`generateOutlineGroup` 用 `sanitizeChapters` 收下本组章节后按全书位置重排 `chapter-NN` 编号（模型回相对编号也不会串位），凑满计划章数才带 `plan`；`mergeOutlinePlan` 供停笔成稿，缺第一组整本设定报 400、没有任何已生成章节报 409。路由新增 `action: 'generate-group' | 'finalize'`：逐组请求由界面发起而不是服务端一次跑完——单次请求串几十组会撞 `maxDuration = 600`，逐组还能让作者中途停笔。未凑满前不返回可保存规划、不写 `story_plans`；上游失败统一 502 并明确「章纲分组生成状态未知；未写入任何规划」，界面上的已生成章节不受影响。预览分支 `dryRun` 仍零请求，回显 `groups` 与合计估算，保持 REQ-049 口径。

界面 `src/components/panels/outline-panel.tsx` 增加 `GroupRun` 状态与 `generateGroups`/`postGroup`/`finalizeRun`：`while (已生成 < 计划)` 逐组串行发请求，用量在浏览器侧 `addUsage` 累加，最后一组直接进既有的检查—保存流程；进度行显示「第 x / y 组 · 已生成 a / N 章 · 已调用 k 次」并在停笔后给出「继续生成」「以已生成 N 章成稿」「放弃这批」，生成中主按钮换成「停止并成稿」（置 `stopRun` 后等本组落地再成稿，组件卸载也置位，避免后台继续发请求）。章数提示改为「不超过 10 章一次调用生成；N 章分 K 次调用逐组生成。」，估算行显示「K 次调用 · 输入约 … / 输出上限 … / 合计工作量 … Token」。

全选的第一条是人物。`src/app/api/projects/[id]/setup/route.ts` 新增 `action: 'selectMany'`：`selected` 必须是布尔、`ids` 必须是数组，去重后按 2000 条截断，逐条按当前范围校验——勾选时不匹配范围或不属于本作品的 id 原样进 `skipped` 回传（不让整批因一人失败），取消勾选不设范围门槛，全部更新在同一个 `db.transaction` 里完成，因此一次全选只加一个项目版本。`src/components/character-picker.tsx` 的已选人物列表用「全选／清空」走该动作，且只提交「仍匹配当前范围且未勾选」的行；候选人物与「年份待核」组各给「全选区间内 N 位／全选待核 N 位／清空选择」，全选只把未导入的候选加入勾选集合，导入仍是一次 `import` 批量提交、逐条人工核对原文的既有门禁不变。事件侧 `src/components/panels/event-panel.tsx` 给候选事件与待核对的已存事件各加「全部标记已核对／清空」（批量勾选是人工核对断言，采用仍逐条确认原文，范围外条目不进入批量集合），新增／编辑事件弹窗的参与人物给「全选／清空」，全选只补到服务端单条 12 位的上限、不制造必然被拒的提交。

正文两栏在 `src/components/chapter-workspace.tsx`：阅读视图的行容器是 `flex min-h-0 flex-1 gap-4`，左列 `<aside class="sticky top-0 hidden min-h-0 w-40 shrink-0 flex-col sm:flex lg:w-56">` 带「正文目录 · N 章」标题与 `<nav aria-label="正文章节目录" class="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">`，右列 `<div ref={contentTop} class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain">` 自己承载正文的纵向滚动。高度不靠 `100dvh` 估算：`chapters/page.tsx` 与 `chapter-reader.tsx` 的外层改为 `flex h-full min-h-0 … flex-col`，把 `project-workspace.tsx` 那个页面滚动容器的确定高度一路传到行容器，目录栏再用交叉轴拉伸取到与行等高——先前用 `self-start` + `max-h-[calc(100dvh-9rem)]` 时目录比行高出 56px，溢出漏回页面滚动容器，实测页面能滚 32px，故删掉。目录项由 `ChapterJump` 渲染（`layout: 'rail' | 'chips'` 复用同一份逻辑），当前章用 `aria-current` 标注；点选走 `selectChapter`，一律 `contentTop.current?.scrollTo({ top: 0 })`（重复点当前章也要回顶，换章则由 `[activeId]` 的 effect 兜住上一章/下一章等入口）。章节条在 `sm` 以下才出现，写法是 `hidden … max-sm:flex`；原来的 `flex … sm:hidden` 在本项目 Tailwind v4 产物里被无变体的 `.flex` 覆盖，1440px 下仍渲染出 132px 高的重复章节条。另记一条环境陷阱：`HISTORY_TEST_BUILD=1` 的 `.next-test` 缓存里若留着旧的 Tailwind 产物，新写的断点类（`lg:w-56`、`max-sm:flex`）不会生成，界面看着像「样式没生效」，删掉 `.next-test` 重建即恢复。

验证：`npx tsc --noEmit` 与 `HISTORY_TEST_BUILD=1 npm run build` 通过。`npm run lint` 在本机无法执行——`eslint-config-next@15.5.29` 的 `@rushstack/eslint-patch` 对 ESLint 9.39.5 报 `Failed to patch ESLint because the calling module was not recognized`，与本次改动无关（既有记录里 lint 是通过的，属工具链漂移），本轮未取得 lint 结果。新增 `npm run test:outline-groups`（`scripts/test-outline-groups.mjs`）自起自停一台注入假模型流的开发服务，在临时隔离目录与 `DASHSCOPE_API_KEY=fixture-only` 下 PASS 且零真实调用：25 章预览折算 3 次调用且预览零请求、缺外发确认 400、`from: 0` 与 1001 章 400、第一组只交 10 章且编号连续、输出预算按整组章数折算、第二组请求带第一组末章钩子与整本书名并按全书位置重编号为 chapter-11—chapter-20、上游 500 时报「未写入任何规划」且已生成组不丢、`story_plans.version` 全程不动、停笔 `finalize` 用 20 章成稿、缺整本设定 400、无已生成章节 409、补齐第三组后 25 章连续编号、每次只回显本组用量、确认后保存 25 章通过校验并落库、1001 章的保存被拒且不改动画版。`scripts/test-plot-events.mjs` 的章数断言按新口径改写（6 章 1 组、10 章 1 组、25 章 3 组，输出上限按整组章数折算、合计输入是三次同规模调用的累加、指令文本含「本次只输出第 1 至 10 章」、0 与 1001 章被拒）并 PASS；`scripts/test-setup.mjs` 新增 `selectMany` 断言（范围不匹配时 `selected: 0` 且 `skipped` 原样回传含非本作品人物、一次全选只加一个版本、范围恢复后全选 3 人落库、取消勾选不设范围门槛、`selected` 非布尔与缺 `ids` 均 400）并 PASS。`scripts/test-creation-chain.mjs` 本次复跑失败一处，定位为既有断言过期而非本次改动引入：章纲改版保留正文的 `carryForwardChapters` 与重生成的 `regenerateConfirmed` 门禁都在 HEAD 之后才出现，改版会把第一章已接受正文继承到新版本，因此那条「普通 generate 仍可重发第一章」的期望已不成立，改为显式 `regenerate` + 覆盖确认后 PASS。界面改动用 chrome-headless-shell 经 CDP 在 1440×900 与 760×900 实测：页面滚到 1500 时侧栏 `top` 停在 104.5（sticky 生效），目录自身 `scrollHeight 836 > clientHeight 756`、`scrollTop` 可滚而页面滚动位置不变（独立滚动成立），点第 12 章后页面滚回 72 且 `aria-current` 跟着切换；760px 时侧栏 `display: none`、横向章节条显示「正文目录 · 共 24 章 · 当前第 1 章囚龙」；控制台无报错。章纲页实测：章数框 `max=1000`、提示「不超过 10 章一次调用生成；25 章分 3 次调用逐组生成。」、预览「3 次调用 · 输入约 66,645 · 输出上限 36,000 · 合计工作量 102,645 Token」；跑到「第 2 / 3 组 · 已生成 10 / 25 章 · 已调用 1 次」时点「停止并成稿」，草稿停在《界面验证大纲（fixture）》· 20 章 · 输入 1800 / 输出 1000 Token 并提示「已用生成的 20 章组成章纲，检查后再保存。」，结构与证据编号校验通过；完整跑完三组得到 25 章草稿（用量逐组累加为 2700 / 1500）；「保存为章节目录」提示「章节目录已保存为第 3 版；人工确认需重新进行。」，接口回读 `version: 3`、25 章且提案绑定仍在。人物与事件步骤全选按钮在同一隔离实例上实测文案为「全选区间内 N 位／全选待核 N 位／清空选择／全选／清空」与「全部标记已核对／清空」，弹窗参与人物「全选／清空」可用。全部验证都在 `HISTORY_DATA_DIR` 隔离副本、`DASHSCOPE_API_KEY=fixture-only` 与假模型端点下执行，未对真实 `data/local` 写入、未发起真实模型请求。
