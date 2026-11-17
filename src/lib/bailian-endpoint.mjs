/** Beijing pay-as-you-go endpoints. Workspace API Hosts may omit the API path. */
export const DEFAULT_BAILIAN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
export function resolveBailianEndpoint(value) {
 let url;
 try { url = new URL(value?.trim() || DEFAULT_BAILIAN_BASE_URL); }
 catch { throw new Error('百炼服务端地址无效。'); }
 const allowed = url.hostname === 'dashscope.aliyuncs.com' || url.hostname === 'token-plan.cn-beijing.maas.aliyuncs.com' || /^llm-[a-z0-9]+\.cn-beijing\.maas\.aliyuncs\.com$/.test(url.hostname);
 if (!allowed || url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) throw new Error('仅支持北京地域百炼按量地址或 Token Plan 专属地址。');
 const pathname = url.pathname.replace(/\/+$/, '');
 if (pathname && pathname !== '/compatible-mode/v1') throw new Error('百炼 OpenAI 兼容接口路径应为 /compatible-mode/v1。');
 url.pathname = '/compatible-mode/v1';
 return url.toString();
}

export function billingMode(value) { return new URL(resolveBailianEndpoint(value)).hostname === "token-plan.cn-beijing.maas.aliyuncs.com" ? "token-plan" : "pay-as-you-go"; }
