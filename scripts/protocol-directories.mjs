// SPDX-License-Identifier: Apache-2.0
// Keep historical source packages separate from current immutable role bundles.
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const sha=text=>createHash('sha256').update(text).digest('hex');
const canonical=v=>JSON.stringify(sort(v));
function sort(v){
 if(Array.isArray(v))return v.map(sort);
 if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])]));
 assert(v===null||['string','boolean'].includes(typeof v)||Number.isSafeInteger(v));return v;
}
export async function verifyRoleBundles(directory){
 const lock=JSON.parse(await readFile(join(directory,'bundles.lock.json'),'utf8'));
 assert.equal(lock.format,'peerwork.protocol-bundle-lock.v1');assert(lock.bundles.length>0);
 const ids=new Set();
 for(const pin of lock.bundles){
  assert(/^[a-z0-9-]+$/.test(pin.package_id));assert(!ids.has(pin.package_id));ids.add(pin.package_id);
  const b=JSON.parse(await readFile(join(directory,pin.package_id+'.bundle.json'),'utf8'));
  assert.equal(b.format,'peerwork.protocol-bundle.v1');assert.equal(b.metadata.package_id,pin.package_id);assert.equal(b.manifest.semantics,'peerwork.kernel.v1');
  assert(Buffer.byteLength(canonical(b))<=114688);assert(Object.keys(b.resources).length<=32);
  const resources={};for(const [path,r]of Object.entries(b.resources)){
   assert(path.split('/').every(p=>/^[A-Za-z0-9_.-]+$/.test(p)&&!['.','..','constructor','__proto__','prototype'].includes(p)));assert(Buffer.byteLength(r.text)>0&&Buffer.byteLength(r.text)<=8192);
   // Included authoring resource files must exactly match the packaged bytes.
   assert.equal(await readFile(join(directory,path),'utf8'),r.text);
   resources[path]={sha256:sha(r.text),bytes:Buffer.byteLength(r.text),media_type:r.media_type};
  }
  assert.deepEqual(Object.keys(b.roles).sort(),[...b.manifest.protocol_roles].sort());
  for(const role of Object.values(b.roles)){
   assert.equal(b.resources[role.instructions]?.media_type,'text/markdown');assert(role.tools.length<=32);
   assert.equal(new Set(role.tools.map(t=>t.name)).size,role.tools.length);
   for(const t of role.tools)assert(b.manifest.actions.some(a=>a.id===t.action));
  }
  const protocol_digest=sha(canonical({semantics:b.manifest.semantics,manifest:b.manifest}));assert.equal(protocol_digest,pin.protocol_digest);
  const header={format:b.format,metadata:b.metadata,protocol_digest,manifest:b.manifest,roles:b.roles,resources,dependencies:b.dependencies};assert.equal(sha(canonical(header)),pin.package_digest);
 }
 const artifacts=(await readdir(directory)).filter(n=>n.endsWith('.bundle.json')).sort();assert.deepEqual(artifacts,[...ids].sort().map(id=>id+'.bundle.json'));
 return lock;
}
export async function protocolDirectories(root){
 const legacy=[];
 for(const entry of await readdir(join(root,'protocols'),{withFileTypes:true})){
  if(!entry.isDirectory())continue;
  const base=join(root,'protocols',entry.name),files=await readdir(base);
  if(files.includes('package.json'))legacy.push(entry.name);
  else await verifyRoleBundles(base);
 }
 return legacy.sort();
}
