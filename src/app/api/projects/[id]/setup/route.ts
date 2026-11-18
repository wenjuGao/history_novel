import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { isLoopbackRequest, isSameOriginLoopback } from '@/lib/security';
import { associationReport } from '@/lib/relations';
import { historicalToAstronomical, overlaps } from '@/lib/history-time';
import { assertEvidenceInSource, corpusPinning, historySources } from '@/lib/source-text';
export const runtime = 'nodejs';
type Context = {params: Promise<{id: string}>};
type Person = {id:string; name:string; selected:number; evidence:string; source:string; start:number|null; end:number|null; region:string|null};
type Scope = {start:number; end:number; region:string};
function people(id:string) {
 return db.prepare(`SELECT c.*, d.title AS source, a.start_year AS start, a.end_year AS end, a.region FROM characters c JOIN documents d ON d.id=c.document_id LEFT JOIN character_activity a ON a.character_id=c.id WHERE c.project_id=? ORDER BY c.created_at`).all(id) as Person[];
}
function scope(id:string) {return db.prepare('SELECT start_year AS start, end_year AS end, region FROM project_scope WHERE project_id=?').get(id) as Scope|undefined;}
// 范围为空区域＝不限区域（REQ-003）；人物活动无区域记录时也不因缺区域而判为不匹配。
function matches(p:Person, s:Scope) {return overlaps(p.start,p.end,s.start,s.end) && (!s.region.trim() || s.region.split(/[、,，]/).map(v=>v.trim()).includes(p.region??''));}
export async function GET(request:NextRequest, context:Context) {
 if (!isLoopbackRequest(request)) return NextResponse.json({error:'仅允许本机访问。'},{status:403});
 const {id}=await context.params;
 if (!db.prepare('SELECT id FROM projects WHERE id=?').get(id)) return NextResponse.json({error:'作品不存在。'},{status:404});
 const all=people(id), current=scope(id);
 const relations=db.prepare('SELECT id, from_id AS "from", to_id AS "to", document_id AS sourceId, start_year AS start, end_year AS end, label, evidence, review_status AS reviewStatus FROM historical_relations WHERE project_id=?').all(id) as Array<{id:string;from:string;to:string;sourceId:string;start:number|null;end:number|null;label:string;evidence:string;reviewStatus:string}>;
 const sources=historySources(id);
 // 已核定关系图只统计作者核对过的关系；auto 共现线索单列为待核，不进入关系图与生成上下文。
 const confirmed=relations.filter(r=>r.reviewStatus==='confirmed'&&r.start!==null&&r.end!==null);
 const report=current ? associationReport(all.filter(p=>p.selected).map(p=>p.id),confirmed.map(r=>({...r,adopted:true,kind:'historical' as const})),current.start,current.end,new Set(sources.map(s=>s.id))) : null;
 return NextResponse.json({people:all.map(p=>({...p,match:!!current&&matches(p,current)})),scope:current??null,report,sources,relations,corpus:corpusPinning(id),fiction:db.prepare('SELECT * FROM fiction_settings WHERE project_id=? ORDER BY updated_at DESC').all(id)},{headers:{'cache-control':'no-store'}});
}
export async function POST(request:NextRequest, context:Context) {
 if (!isSameOriginLoopback(request)) return NextResponse.json({error:'请求来源无效。'},{status:403});
 const {id}=await context.params;
 if (!db.prepare('SELECT id FROM projects WHERE id=?').get(id)) return NextResponse.json({error:'作品不存在。'},{status:404});
 try {
  const b=await request.json();
  if (!b || typeof b!=='object') throw new Error('请求无效。');
  const text=(key:string,max=1000)=> {if(typeof b[key]!=='string'||!b[key].trim()||b[key].length>max) throw new Error('请完整填写有效内容。');return b[key].trim() as string;};
  // 批量勾选要回传实际生效条数与跳过的 id，故单独收集结果，其余操作仍只返回 {ok:true}。
  let batch:{selected:number;skipped:string[]}|null=null;
  const operation=()=>{
   if(b.action==='select') {
    if(typeof b.selected!=='boolean') throw new Error('选择无效。');
    const p=people(id).find(p=>p.id===b.id), s=scope(id);
    if(!p) throw new Error('人物不存在。');
    if(b.selected && (!s || !matches(p,s))) throw new Error('人物活动证据不匹配当前范围，请先补充资料或调整范围。');
    db.prepare('UPDATE characters SET selected=? WHERE id=? AND project_id=?').run(b.selected?1:0,b.id,id);
   } else if(b.action==='selectMany') {
    // 批量勾选逐条校验范围：不匹配的人物跳过并回传 id，不让整批因一人失败；取消勾选不设范围门槛。
    if(typeof b.selected!=='boolean') throw new Error('选择无效。');
    if(!Array.isArray(b.ids)) throw new Error('请选择人物。');
    const all=people(id),s=scope(id);
    // 去重后再按 2000 上限截断，实际生效范围只限本作品已有人物。
    const ids=[...new Set((b.ids as unknown[]).map(key=>typeof key==='string'?key.trim():'').filter(Boolean))].slice(0,2000);
    const pass=ids.filter(key=>{const p=all.find(x=>x.id===key);if(!p) return false;return !b.selected||s!==undefined&&matches(p,s);});
    const result:{selected:number;skipped:string[]}={selected:0,skipped:ids.filter(key=>!pass.includes(key))};
    db.transaction(()=>{for(const key of pass) result.selected+=db.prepare('UPDATE characters SET selected=? WHERE id=? AND project_id=?').run(b.selected?1:0,key,id).changes;})();
    batch=result;
   } else if(b.action==='fiction') {
    const kind=text('kind',20),title=text('title',80),content=text('content',10000);
    if(!['人物','关系','对白','心理','日常场景'].includes(kind)) throw new Error('虚构类别无效。');
    if(b.id) {const result=db.prepare('UPDATE fiction_settings SET kind=?,title=?,content=?,updated_at=? WHERE id=? AND project_id=?').run(kind,title,content,new Date().toISOString(),text('id',100),id); if(!result.changes) throw new Error('设定不存在。');}
    else db.prepare('INSERT INTO fiction_settings VALUES (?,?,?,?,?,?)').run(randomUUID(),id,kind,title,content,new Date().toISOString());
   } else if(b.action==='deleteFiction') {
    if(!db.prepare('DELETE FROM fiction_settings WHERE id=? AND project_id=?').run(text('id',100),id).changes) throw new Error('设定不存在。');
   } else if(b.action==='person'||b.action==='relation') {
    const start=historicalToAstronomical(Number(text('start',8))),end=historicalToAstronomical(Number(text('end',8)));
    if(start>end) throw new Error('起始年份不能晚于结束年份。');
    const documentId=text('documentId',100),evidence=text('evidence');
    if(!assertEvidenceInSource(id,documentId,evidence).ok) throw new Error('证据必须来自当前作品的历史资料原文。');
    if(b.confirmed!==true) throw new Error('请核对原文确实支持所填活动或关系后确认。');
    if(b.action==='person') {
     const personId=randomUUID();
     // 活动区域可留空：范围未限区域时，人物只凭时间证据入选。
     const region=typeof b.region==='string'&&b.region.trim()?b.region.trim().slice(0,200):'';
     db.prepare('INSERT INTO characters (id,project_id,name,document_id,evidence,created_at) VALUES (?,?,?,?,?,?)').run(personId,id,text('name',80),documentId,evidence,new Date().toISOString());
     db.prepare('INSERT INTO character_activity VALUES (?,?,?,?)').run(personId,start,end,region);
    } else {
     const from=text('from',100),to=text('to',100),all=people(id);
     if(from===to||![from,to].every(key=>all.some(p=>p.id===key))) throw new Error('请选择本作品中两个不同人物。');
     db.prepare('INSERT INTO historical_relations (id,project_id,from_id,to_id,label,document_id,evidence,start_year,end_year) VALUES (?,?,?,?,?,?,?,?,?)').run(randomUUID(),id,from,to,text('label',80),documentId,evidence,start,end);
    }
   } else if(b.action==='confirmRelation') {
    // 待核共现线索的人工确认：核对原文后补关系时间并进入已核定关系图。
    const relationId=text('id',100);
    const row=db.prepare('SELECT id, review_status FROM historical_relations WHERE id=? AND project_id=?').get(relationId,id) as {id:string;review_status:string}|undefined;
    if(!row) throw new Error('关系线索不存在。');
    if(row.review_status!=='auto') throw new Error('该关系已核对过。');
    if(b.confirmed!==true) throw new Error('请核对原文确实支持该关系后再确认。');
    const parseYear=(value:unknown,field:string)=>{const parsed=Number(value);if(!Number.isInteger(parsed)||parsed===0||Math.abs(parsed)>10000) throw new Error(`${field}必须是非零整数年份。`);return historicalToAstronomical(parsed)};
    const start=parseYear(text('start',8),'起始年份'),end=parseYear(text('end',8),'结束年份');
    if(start>end) throw new Error('起始年份不能晚于结束年份。');
    const s=scope(id);
    if(s && !overlaps(start,end,s.start,s.end)) throw new Error('关系时间需与当前历史范围重叠。');
    db.prepare("UPDATE historical_relations SET review_status='confirmed', start_year=?, end_year=? WHERE id=? AND project_id=?").run(start,end,relationId,id);
   } else if(b.action==='rejectRelation') {
    const relationId=text('id',100);
    if(!db.prepare("DELETE FROM historical_relations WHERE id=? AND project_id=? AND review_status='auto'").run(relationId,id).changes) throw new Error('待核关系线索不存在。');
   } else throw new Error('操作无效。');
   db.prepare('UPDATE projects SET version=version+1,updated_at=? WHERE id=?').run(new Date().toISOString(),id);
   // 事务函数的返回值会原样传回调用方，闭包内赋值的变量在这里会被类型收窄成 null。
   return batch;
  };
  const applied=db.transaction(operation)();
  return NextResponse.json(applied?{ok:true,...applied}:{ok:true});
 } catch(error) {return NextResponse.json({error:error instanceof Error && !/SQLITE|constraint|database/i.test(error.message)?error.message:'保存失败，请检查输入。'},{status:400});}
}
