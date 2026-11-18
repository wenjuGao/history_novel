// 章纲数量与分组生成的共享上限：src/lib/story-plan.ts 是 server-only 模块，
// 界面面板与服务端校验必须读到同一个数，因此这两个常量单独放在客户端可导入的模块里。

/** 一部作品的章纲最多能有多少章；接口、结构校验与界面输入框共用。 */
export const MAX_PLAN_CHAPTERS = 1000

/** 章纲一次模型调用产出的章节数上限；计划章数超过它时自动分组逐组生成。 */
export const OUTLINE_GROUP_SIZE = 10
