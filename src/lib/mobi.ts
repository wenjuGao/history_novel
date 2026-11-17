import 'server-only';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const execute=promisify(execFile);
export async function convertMobi(bytes:Buffer) {
 const temporary=await mkdtemp(path.join(os.tmpdir(),'history-upload-'));
 try {
  const input=path.join(temporary,'upload.mobi');await writeFile(input,bytes,{mode:0o600});
  const python=process.env.MOBI_PYTHON || path.join(process.cwd(),'data/local/tools/mobi-venv/bin/python');
  const output=path.join(process.env.HISTORY_DATA_DIR || path.join(process.cwd(),'data/local'),'converted');
  let stdout:string;
  try {({stdout}=await execute(python,[path.join(process.cwd(),'scripts/convert-mobi.py'),input,'--output',output],{timeout:60000,maxBuffer:1024*1024}));}
  catch {throw new Error('MOBI 转换失败：请确认已安装转换依赖，文件未加密且未损坏。');}
  const result=JSON.parse(stdout) as {textPath:string;sourceSha256:string};
  const expected=path.join(await realpath(output),result.sourceSha256,'text.txt');
  if(!/^[a-f0-9]{64}$/.test(result.sourceSha256)||path.resolve(result.textPath)!==path.resolve(expected))throw new Error('转换产物路径无效。');
  return await readFile(expected,'utf8');
 } finally {await rm(temporary,{recursive:true,force:true});}
}
