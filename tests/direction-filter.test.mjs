import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../dist/app.mjs',import.meta.url),'utf8');
const body=source.slice(source.indexOf('function matches('),source.indexOf('function statusMatches('));
const matches=(view,selection,r)=>Function('view','$','allows',body+';return matches(arguments[3])')(view,()=>({value:''}),(id,value)=>id!=='directionFilter'||!selection.length||selection.includes(value),r);
test('direction filters raw views while leaving complete net-accounting groups visible',()=>{
 for(const view of ['review','spam']){
  assert.equal(matches(view,['in'],{direction:'in'}),true);
  assert.equal(matches(view,['in'],{direction:'out'}),false);
  assert.equal(matches(view,['out'],{direction:'in'}),false);
  assert.equal(matches(view,['in','out'],{direction:'out'}),true);
  assert.equal(matches(view,[],{direction:'out'}),true);
 }
 for(const view of ['ledger','assets'])assert.equal(matches(view,['out'],{due:'100',paid:'40'}),true);
});
