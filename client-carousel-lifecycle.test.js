'use strict';
// Deterministic scheduler/DOM fixture: reproduce two carousel builds before
// the first idle drain. No browser launch or network access.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert/strict');
const acorn = require('acorn');
const src = (process.env.MZ_CLIENT_SOURCE ? fs.readFileSync(process.env.MZ_CLIENT_SOURCE, 'utf8') : require('./scripts/app-source.cjs').readAppSource());
const node = acorn.parse(src, {ecmaVersion: 'latest'}).body.find(n => n.type === 'FunctionDeclaration' && n.id.name === 'buildCarousel');
assert(node, 'buildCarousel declaration exists');
function setup(nativeIdle = true) {
  const idle = [], timers = [], calls = {warm: [], quality: [], batch: []}, images = [];
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.classList = {contains: () => false}; this._html = ''; }
    set innerHTML(s) { this._html = s; this.children = []; }
    get innerHTML() { return this._html; }
    appendChild(el) { if (el.tag === 'fragment') this.children.push(...el.children); else this.children.push(el); return el; }
    querySelectorAll() { return []; }
    querySelector(selector) {
      if (selector !== '.slide-bg-img') return null;
      const listeners = {};
      const img = {complete: false, addEventListener: (event, fn) => {listeners[event] = fn;}, fire: event => {if (listeners[event]) listeners[event]();}};
      images.push(img); return img;
    }
    setAttribute() {} addEventListener() {}
  }
  const els = Object.fromEntries(['carouselTrack', 'carouselDots', 'carouselThumbs'].map(k => [k, new Element('div')]));
  const ctx = {
    console, Date, Set, Map, carouselBuildRunId: 0, carouselMovies: [], currentSlide: 0,
    document: {getElementById: id => els[id], createElement: tag => new Element(tag), createDocumentFragment: () => new Element('fragment')},
    window: {}, requestIdleCallback: fn => idle.push(fn), setTimeout: fn => timers.push(fn),
    GENRE_MAP: {}, CAROUSEL_BACKDROP_OVERRIDES: {},
    getHeroBackdrop: p => 'hero' + p, getResponsiveBackdrop: p => 'next' + p,
    slideBackdropMarkup: () => '<img class="slide-bg-img">', heroPosterUrl: p => p,
    localStorage: {setItem() {}}, titleQualityState: () => ({cls: '', qual: 'HD'}),
    escapeHTML: String, mzLangName: s => s || 'English',
    goToSlide() {}, resetAutoSlide() {}, startAutoSlide() {},
    ensureSlideBg: i => calls.warm.push(i), refreshSlideQuality: i => calls.quality.push(i),
    isDataSaver: () => false, mediaTypeOf: () => 'movie',
    tmdbBatch: plan => calls.batch.push(plan), CAROUSEL_AUTOPLAY_MS: 6000, MZ_BATCH_MIN_REQUESTS: 2
  };
  if (nativeIdle) ctx.window.requestIdleCallback = ctx.requestIdleCallback;
  vm.createContext(ctx); vm.runInContext(src.slice(node.start, node.end), ctx);
  const deck = base => Array.from({length: 10}, (_, i) => ({id: base + i, title: 'Title ' + (base + i), backdrop_path: '/backdrop.jpg', poster_path: '/poster.jpg'}));
  const drain = queue => {let max = 100; while (queue.length) {assert(max-- > 0, 'scheduler must terminate'); queue.shift()();}};
  return {ctx, els, idle, timers, calls, images, deck, drain};
}
let pass = 0, fail = 0;
function test(label, fn) {
  try {fn(); pass++; console.log('PASS ' + label);}
  catch (e) {fail++; console.error('FAIL ' + label + ': ' + e.message);}
}
for (const nativeIdle of [true, false]) test('rebuild discards old deferred slides; nativeIdle=' + nativeIdle, () => {
  const {ctx, els, idle, timers, deck, drain} = setup(nativeIdle);
  ctx.carouselMovies = deck(100); ctx.buildCarousel();
  ctx.carouselMovies = deck(200); ctx.buildCarousel();
  assert.equal(els.carouselTrack.children.length, 2);
  drain(nativeIdle ? idle : timers);
  assert.equal(els.carouselTrack.children.length, 10, 'old idle chunks must not append eight extra slides');
  assert.equal(els.carouselDots.children.length, 10);
  assert.equal(els.carouselThumbs.children.length, 10);
  assert(els.carouselTrack.children.every(el => !el.innerHTML.includes('Title 10')), 'only current deck remains');
});
test('detached hero load cannot warm the replacement deck', () => {
  const {ctx, idle, images, calls, deck, drain} = setup();
  ctx.carouselMovies = deck(100); ctx.buildCarousel(); const oldHero = images[0];
  ctx.carouselMovies = deck(200); ctx.buildCarousel();
  oldHero.fire('load'); drain(idle);
  assert.equal(calls.warm.length, 0);
  images[1].fire('load'); drain(idle);
  assert.deepEqual(calls.warm, [1], 'current hero still warms its next slide');
});
test('superseded idle quality work does not duplicate requests', () => {
  const {ctx, idle, timers, calls, deck, drain} = setup();
  ctx.carouselMovies = deck(100); ctx.buildCarousel();
  ctx.carouselMovies = deck(200); ctx.buildCarousel();
  drain(idle); drain(timers);
  assert.equal(calls.quality.length, 1, 'one current-deck quality refresh');
  assert.equal(calls.batch.length, 1, 'one current-deck release-date batch');
  assert(calls.batch[0].every(row => row[0].startsWith('/movie/2')));
});
test('already scheduled old quality timer is cancelled logically on rebuild', () => {
  const {ctx, idle, timers, calls, deck, drain} = setup();
  ctx.carouselMovies = deck(100); ctx.buildCarousel(); drain(idle);
  assert.equal(timers.length, 1);
  ctx.carouselMovies = deck(200); ctx.buildCarousel(); drain(idle); drain(timers);
  assert.equal(calls.batch.length, 1, 'old timer must not send another request');
});
console.log('client-carousel-lifecycle: ' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
