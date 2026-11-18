// Run against a separate server with HISTORY_DATA_DIR set to an empty temporary directory.
import assert from 'node:assert/strict';
const base=process.env.TEST_BASE_URL || 'http://127.0.0.1:3107';
async function call(path,body,method='POST',expected=200) {
 const r=await fetch(base+path,{method:body===undefined?'GET':method,headers:{origin:base,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const data=await r.json();assert.equal(r.status,expected,JSON.stringify(data));return data;
}
const project=(await call('/api/projects',{name:'自动验收：虚构样例'},'POST',201)).project.id;
const other=(await call('/api/projects',{name:'隔离验收'},'POST',201)).project.id;
const root=`/api/projects/${project}`;
await call(root+'/scope',{startYear:100,endYear:120,region:'测试甲地、测试乙地'},'PUT');
const form=new FormData();form.set('category','history');form.set('file',new File(['以下全为软件测试虚构资料，非史实。甲在测试甲地活动。乙在测试乙地活动。丙在测试甲地活动。甲乙为友。乙丙为友。'],'fixture.txt'));
const uploaded=await fetch(base+root+'/documents',{method:'POST',headers:{origin:base},body:form});assert.equal(uploaded.status,201);
let state=await call(root+'/setup');// 新建项目会自动固定本机古籍，资料首位不再保证是本次上传的测试原文，须显式取上传条目。
const documentId=state.sources.find(s=>s.kind==='upload').id;
for(const [name,region,evidence] of [['甲','测试甲地','甲在测试甲地活动。'],['乙','测试乙地','乙在测试乙地活动。'],['丙','测试甲地','丙在测试甲地活动。']]) {
 await call(root+'/setup',{action:'person',name,region,evidence,documentId,start:'100',end:'120',confirmed:true});
}
state=await call(root+'/setup');assert.equal(state.people.filter(p=>p.match).length,3);
const [a,b,c]=state.people;
for(const p of [a,b,c]) await call(root+'/setup',{action:'select',id:p.id,selected:true});
state=await call(root+'/setup');assert.equal(state.report.groups.length,3);
await call(root+'/setup',{action:'fiction',kind:'关系',title:'甲丙虚构联系',content:'测试用途'});
state=await call(root+'/setup');assert.equal(state.report.groups.length,3);assert.equal(state.fiction.length,1);
for(const [from,to,evidence] of [[a.id,b.id,'甲乙为友。'],[b.id,c.id,'乙丙为友。']]) await call(root+'/setup',{action:'relation',from,to,label:'友人',evidence,documentId,start:'100',end:'120',confirmed:true});
state=await call(root+'/setup');assert.equal(state.report.groups.length,1);assert.equal(state.report.pairs.find(p=>p.from===a.id&&p.to===c.id).paths[0].edges.length,2);
await call(root+'/scope',{startYear:200,endYear:220,region:'测试甲地'},'PUT');
state=await call(root+'/setup');assert.equal(state.people.filter(p=>p.match).length,0);assert.equal(state.report.groups.length,3);
await call(root+'/setup',{action:'select',id:a.id,selected:true},'POST',400);
await call(root+'/characters',{id:a.id,selected:true},'PATCH',400);
await call(`/api/projects/${other}/setup`,{action:'select',id:a.id,selected:true},'POST',400);
// 全选（需求 1）：逐条校验范围，不匹配与不属于本作品的编号原样跳过；一次批量只加一个版本；取消勾选不设范围门槛。
const versionBefore=(await call('/api/projects')).projects.find(p=>p.id===project).version;
const batch=await call(root+'/setup',{action:'selectMany',ids:[a.id,b.id,'不存在的人物'],selected:true});
assert.equal(batch.selected,0,'范围不匹配时全选不勾选任何人');
assert.deepEqual(batch.skipped,[a.id,b.id,'不存在的人物'],'跳过的编号原样回传，含不属于本作品的人物');
assert.equal((await call('/api/projects')).projects.find(p=>p.id===project).version,versionBefore+1,'一次全选只加一个版本');
await call(root+'/scope',{startYear:100,endYear:120,region:'测试甲地、测试乙地'},'PUT');
const picked=await call(root+'/setup',{action:'selectMany',ids:[a.id,b.id,c.id],selected:true});
assert.equal(picked.selected,3);assert.deepEqual(picked.skipped,[]);
assert.equal((await call(root+'/setup')).people.filter(p=>p.selected).length,3,'全选结果落库');
await call(root+'/scope',{startYear:200,endYear:220,region:'测试甲地'},'PUT');
const cleared=await call(root+'/setup',{action:'selectMany',ids:[a.id,b.id],selected:false});
assert.equal(cleared.selected,2,'取消勾选不需要匹配当前范围');
assert.equal((await call(root+'/setup')).people.filter(p=>p.selected).length,1);
await call(root+'/scope',{startYear:100,endYear:120,region:'测试甲地、测试乙地'},'PUT');
await call(root+'/setup',{action:'selectMany',ids:[a.id],selected:'yes'},'POST',400);
await call(root+'/setup',{action:'selectMany',selected:true},'POST',400);
await call(root+'/setup',{action:'person',name:'无证据',region:'测试甲地',evidence:'不存在的引文',documentId,start:'100',end:'120',confirmed:true},'POST',400);
await call(root+'/setup',{action:'person',name:'零年',region:'测试甲地',evidence:'甲在测试甲地活动。',documentId,start:'0',end:'120',confirmed:true},'POST',400);
const f=state.fiction[0];await call(root+'/setup',{...f,action:'fiction',content:'修改后内容'});assert.equal((await call(root+'/setup')).fiction[0].content,'修改后内容');
await call(root+'/setup',{action:'deleteFiction',id:f.id});assert.equal((await call(root+'/setup')).fiction.length,0);
assert.equal((await call(`/api/projects/${other}/setup`)).people.length,0);
const denied=await fetch(base+root+'/setup',{method:'POST',headers:{origin:'https://example.com','content-type':'application/json'},body:JSON.stringify({action:'fiction',kind:'人物',title:'非法来源',content:'测试'})});assert.equal(denied.status,403);
console.log('PASS: candidates, selection, direct/indirect/disconnected relations, scope invalidation, fictional isolation, editing/deletion, evidence validation, BCE zero rejection, project isolation, same-origin enforcement.');
