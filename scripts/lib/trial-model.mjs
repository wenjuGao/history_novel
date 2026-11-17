import {resolveBailianEndpoint,billingMode} from '../../src/lib/bailian-endpoint.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import OpenAI from 'openai';
import nextEnv from '@next/env';
nextEnv.loadEnvConfig(process.cwd());
export const prices={'qwen3.8-flash':[0.8,2.7],'qwen3.8-max':[12,36]};
export function estimate(model,messages,maxTokens) {const input=Buffer.byteLength(JSON.stringify(messages),'utf8')+1024;return (input*prices[model][0]+maxTokens*prices[model][1])/1e6;}
export function makeRunner(directory,budget=12,{retryFreeTierRejection=false,retryQuotaRejection=false}={}) {
 let reserved=0;
 return async function call(name,model,messages,maxTokens) {
  if(!prices[model])throw new Error('模型未审核');
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const hash=createHash('sha256').update(JSON.stringify({model,messages,maxTokens})).digest('hex');
  const file=path.join(directory,name+'.json');
  const bound=estimate(model,messages,maxTokens);
  const mode=billingMode(process.env.BAILIAN_BASE_URL);
  try {const cached=JSON.parse(await fs.readFile(file,'utf8'));if(cached.hash!==hash)throw new Error('输入已变化，请使用新的试运行目录。');reserved+=cached.reservedCny;console.log(`CACHE ${name}`);return cached.text;}catch(e){if(e.code!=='ENOENT')throw e;}
  if(reserved+bound>budget)throw new Error('预算保护：停止新调用。');
  if(!process.env.DASHSCOPE_API_KEY)throw new Error('没有配置 API Key。');
  const baseURL=resolveBailianEndpoint(process.env.BAILIAN_BASE_URL);
  if(retryFreeTierRejection || retryQuotaRejection) {
   const rejected=path.join(directory,name+'.error.json');
   try {
    const error=JSON.parse(await fs.readFile(rejected,'utf8'));
    if(error.status===403 && ((retryFreeTierRejection && error.code==='AllocationQuota.FreeTierOnly') || (retryQuotaRejection && error.code==='insufficient_quota'))) {
     const stamp=Date.now();
     await fs.rename(path.join(directory,name+'.intent.json'),path.join(directory,name+`.rejected-${stamp}.intent.json`));
     await fs.rename(rejected,path.join(directory,name+`.rejected-${stamp}.error.json`));
    }
   } catch(e) {if(e.code!=='ENOENT')throw e;}
  }
  const intent=await fs.open(path.join(directory,name+'.intent.json'),'wx');
  reserved+=bound;
  await intent.writeFile(JSON.stringify({hash,model,baseURL,billingMode:mode,workloadAllowanceCnyEquivalent:bound,reservedCny:bound,startedAt:new Date().toISOString(),status:'sent-or-unknown',note:'不得自动重发；检查供应商状态后人工处理。'},null,2));await intent.close();
  const client=new OpenAI({apiKey:process.env.DASHSCOPE_API_KEY,baseURL,maxRetries:0,timeout:180000});
  console.log(`CALL ${name} ${model} mode=${mode} workloadAllowance=${bound.toFixed(4)}`);
  try {
   const r=await client.chat.completions.create({model,messages,max_tokens:maxTokens,enable_thinking:false,stream:false});
   const c=r.choices[0];
   const text=c?.message?.content??'';
   if(c?.finish_reason!=='stop'||!text.trim()) {
    await fs.writeFile(path.join(directory,name+'.incomplete.json'),JSON.stringify({hash,usage:r.usage,finishReason:c?.finish_reason,text},null,2));throw new Error('模型输出不完整，已保存，不自动重试。');
   }
   const usage=r.usage;
   const cost=usage && mode==='pay-as-you-go'?(usage.prompt_tokens*prices[model][0]+usage.completion_tokens*prices[model][1])/1e6:null;
   await fs.writeFile(file,JSON.stringify({hash,model,baseURL,billingMode:mode,workloadAllowanceCnyEquivalent:bound,reservedCny:bound,estimatedActualCny:cost,usage,requestId:r.id,text,completedAt:new Date().toISOString()},null,2),{flag:'wx'});
   console.log(`DONE ${name} tokens=${usage?.total_tokens??'unknown'} billing=${mode} estimatedCny=${cost?.toFixed(4)??'not-applicable'}`);
   return text;
  } catch(e) {
   await fs.writeFile(path.join(directory,name+'.error.json'),JSON.stringify({status:e.status??null,code:typeof e.code==='string'?e.code:null,note:'请求失败或结果不完整；不自动重试，原始凭证不记录。'},null,2));
   throw new Error(`模型步骤 ${name} 未完成（HTTP ${e.status??'unknown'}，code ${typeof e.code==='string'?e.code:'unknown'}）。`);
  }
 };
}
