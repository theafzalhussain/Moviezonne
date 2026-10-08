'use strict';
const fs = require('fs');
const vm = require('vm');
const assert = require('assert/strict');
const src = fs.readFileSync('moviezone.js', 'utf8');
const start = src.indexOf('const _mzCacheWriteQueue = new Map();');
const end = src.indexOf('// Leaving the page', start);
assert(start >= 0 && end > start);
function setup(nativeIdle) {
  const scheduled = [], stored = new Map();
  const ctx = {
    Map, Date, JSON, Boolean, parseInt,
    setTimeout(fn) { scheduled.push(fn); },
    localStorage: { setItem(k,v) { stored.set(k,v); }, getItem(k) { return stored.get(k) || null; } }
  };
  if (nativeIdle) ctx.requestIdleCallback = fn => scheduled.push(fn);
  vm.createContext(ctx);
  vm.runInContext(src.slice(start,end) + '\nthis.queue = _mzQueueCacheWrite; this.flush = _mzFlushCacheWrites;',ctx);
  return {ctx,scheduled,stored};
}
for (const nativeIdle of [false,true]) {
  const {ctx,scheduled,stored} = setup(nativeIdle);
  for (let i=0;i<30;i++) ctx.queue('mz_cache_'+i,{results:[{id:i}]});
  assert.equal(scheduled.length,1);
  scheduled.shift()(nativeIdle ? {didTimeout:true,timeRemaining:()=>0} : undefined);
  assert.equal(stored.size,3,'scheduled fallback/timeout yields after three writes');
  assert.equal(scheduled.length,1);
  let turns=1;
  while(scheduled.length) {
    assert(turns++ < 20,'flush must make progress');
    scheduled.shift()(nativeIdle ? {didTimeout:true,timeRemaining:()=>0} : undefined);
  }
  assert.equal(stored.size,30);
  for(let i=0;i<30;i++) assert.equal(JSON.parse(stored.get('mz_cache_'+i)).data.results[0].id,i);
  console.log('PASS bounded scheduling and full persistence; nativeIdle='+nativeIdle);
}
for (const event of [undefined,{type:'pagehide'}]) {
  const {ctx,stored} = setup(false);
  for(let i=0;i<30;i++) ctx.queue('mz_cache_'+i,{id:i});
  ctx.flush(event);
  assert.equal(stored.size,30,'lifecycle flush preserves all queued records');
}
console.log('PASS pagehide and hidden-page flush remain complete');
