import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:3108';
const response=await fetch(base+'/api/projects',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({name:'MOBI导入隔离验收'})});
assert.equal(response.status,201);const id=(await response.json()).project.id;
const bytes=await fs.readFile('data/local/ebooks/冰与火之歌·卷一·权力的游戏（全三册）.mobi');
async function upload(content,name,category='reference') {
 const data=new FormData();data.set('category',category);data.set('file',new File([content],name));
 return fetch(`${base}/api/projects/${id}/documents`,{method:'POST',headers:{origin:base},body:data});
}
const imported=await upload(bytes,'sample.mobi');assert.equal(imported.status,201,await imported.text());
assert.equal((await upload(bytes,'sample.mobi')).status,409);
assert.equal((await upload(bytes,'sample.mobi','history')).status,400);
assert.equal((await upload(Buffer.from('broken'),'broken.mobi')).status,400);
const locked=Buffer.from(bytes);locked.writeUInt16BE(2,locked.readUInt32BE(78)+12);
assert.equal((await upload(locked,'locked.mobi')).status,400);
const list=await (await fetch(`${base}/api/projects/${id}/documents`)).json();assert.equal(list.documents.length,1);assert.equal(list.documents[0].category,'reference');
console.log('PASS: real MOBI upload, duplicate rejection, category separation, corrupt/encrypted rejection; isolated database only.');
