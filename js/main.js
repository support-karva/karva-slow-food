/* Karva Pro — page behaviour.
   Everything here is progressive: the HTML reads complete without it,
   and every animated piece checks the Motion switch. */
import { PotRenderer, run } from './pot.js';
import { motionOn, onMotion, initMotionToggles } from './prefs.js';
import { initStatus } from './status.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sm = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const NAV = 48;

initMotionToggles($$('[data-motion-toggle]'));
initStatus();

/* ==========================================================================
   Pots
   ========================================================================== */
function canvasOK() {
  try { const c = document.createElement('canvas'); return !!(c.getContext && c.getContext('2d') && window.Float32Array); }
  catch (_) { return false; }
}
const CAN = canvasOK();

/** Wires one PotRenderer to a [data-pot] box: sizing, visibility, motion. */
function makePot(box, { place, spin = 0.25, setup, live }) {
  const canvas = $('.pot-canvas', box);
  const pot = new PotRenderer(canvas, { budget: 7 });
  setup && setup(pot.s);
  let w = 0, h = 0, shown = false;
  const layout = () => {
    w = canvas.clientWidth; h = canvas.clientHeight;
    if (!w || !h) return;
    const U = place(pot.s, w, h);
    pot.resize(U);
    pot.needsDraw = true;
  };
  const applyMotion = () => {
    pot.still = !motionOn() || (live && !live());
    pot.s.baseSpin = spin;
    pot.needsDraw = true;
  };
  let visible = true;
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((es) => { visible = es[0].isIntersecting; run(pot, visible); }, { rootMargin: '120px' }).observe(box);
  }
  const first = pot.frame.bind(pot);
  pot.frame = (now, dt) => {
    first(now, dt);
    if (!shown && pot.buf) { shown = true; box.classList.add('pot-ok'); }
  };
  layout(); applyMotion();
  run(pot, visible);
  return { pot, layout, applyMotion, box };
}

const pots = [];
if (CAN) {
  try {
    /* 1 · hero: the finished, fired karva turning slowly */
    const heroBox = $('[data-pot="hero"]');
    if (heroBox) {
      const hero = makePot(heroBox, {
        spin: 0.26,
        setup: (s) => Object.assign(s, { k: 5, wet: 0, fired: 1, heat: 0, wheel: 0, spiral: 0, wobble: 0, glaze: 0, spot: 1.15, rot: 0.9 }),
        place: (s, w, h) => {
          const U = Math.min(h * 0.62, w * 0.66, 520);
          s.unit = U; s.cx = 0.5; s.base = 0.7;
          return U;
        }
      });
      hero.pot.attachSpin(heroBox);
      pots.push(hero);
    }

    /* 5 · bento: the celadon-glazed pot, the second kitchen */
    const celBox = $('[data-pot="celadon"]');
    if (celBox) {
      pots.push(makePot(celBox, {
        spin: 0.2,
        setup: (s) => Object.assign(s, { k: 5, wet: 0, fired: 1, heat: 0, wheel: 0, spiral: 0, wobble: 0, glaze: 1, glazeAt: 0.4, spot: 0, rot: 0.4 }),
        place: (s, w, h) => {
          const U = Math.min(h * 0.74, w * 0.62, 380);
          s.unit = U; s.cx = 0.5; s.base = 0.88;
          return U;
        }
      }));
    }

    /* 2 · the film */
    initFilm();
  } catch (e) {
    console.error(e);   // the SVG pots stay
  }
}

/* ==========================================================================
   2 · The pot film — thrown as you scroll.
   The section is tall; its inner stage is position: sticky. Scroll progress
   through the section is mapped onto the pot's life:
     0 → .42   lump · opened · walls · belly · shoulder · lip (keys 0–5)
     .42 → .8  fire: dries, glows, fires to terracotta     (k 5–7)
     .8 → 1    settles on the table                        (k 7–8)
   ========================================================================== */
function initFilm() {
  const film = $('#film');
  const box = $('[data-pot="film"]');
  if (!film || !box) return;
  const beats = $$('.beat', film);
  const words = beats.map((b) => $('.beat__word', b));
  const caps = beats.map((b) => $('.beat__cap', b));
  const WIN = [[-1, -1, 0.26, 0.32], [0.34, 0.4, 0.64, 0.7], [0.74, 0.8, 2, 2]];
  let U = 0, H = 0, W = 0, isLive = false, lastP = -1;

  const liveWanted = () => motionOn();
  const ctl = makePot(box, {
    spin: 0.3,
    live: liveWanted,
    setup: (s) => Object.assign(s, { k: 5, fired: 1, wet: 0, heat: 0, wheel: 0, spot: 1 }),
    place: (s, w, h) => {
      W = w; H = h;
      if (!isLive) {                       // static: the fired pot, drawn once
        U = Math.min(h * 0.8, w * 0.66, 400);
        Object.assign(s, { k: 5, wet: 0, fired: 1, heat: 0, wheel: 0, spiral: 0, wobble: 0, spot: 1, cx: 0.5, base: 0.84, unit: U });
        return U;
      }
      // live: word above, pot in the middle, caption below — never overlapping
      const bar = parseFloat(getComputedStyle(document.body).paddingBottom) || 0;
      const wordH = Math.max(...words.map((x) => x.offsetHeight));
      const capH = Math.max(...caps.map((x) => x.offsetHeight));
      const gap = clamp(h * 0.035, 16, 40);
      const top = NAV + gap, bottom = h - bar - gap;
      const avail = bottom - top - wordH - capH - gap * 2.6;
      U = clamp(Math.min(avail, w * 0.62, 470), 120, 470);
      const total = wordH + gap + U * 1.04 + gap * 1.6 + capH;
      const y0 = Math.max(top, top + (bottom - top - total) / 2);
      const base = y0 + wordH + gap + U * 1.04;
      film.style.setProperty('--word-top', `${Math.round(y0)}px`);
      film.style.setProperty('--cap-top', `${Math.round(base + gap * 1.6)}px`);
      s.cx = 0.5; s.base = base / h; s.unit = U;
      lastP = -1;
      return U;
    }
  });
  const pot = ctl.pot, s = pot.s;

  function setLive(on) {
    if (on === isLive) return;
    isLive = on;
    film.classList.toggle('is-live', on);
    if (!on) {
      film.style.removeProperty('--word-top'); film.style.removeProperty('--cap-top');
      beats.forEach((b) => b.removeAttribute('style'));
    }
    ctl.applyMotion();
    ctl.layout();
    if (window.ScrollTrigger) ScrollTrigger.refresh();
  }

  pot.beforeFrame = () => {
    if (!isLive) return;
    const r = film.getBoundingClientRect();
    const span = r.height - H;
    const p = clamp(-r.top / (span || 1), 0, 1);
    if (Math.abs(p - lastP) < 0.0004) return;
    lastP = p;
    const k = p < 0.42 ? (p / 0.42) * 5 : p < 0.8 ? 5 + ((p - 0.42) / 0.38) * 2 : 7 + (p - 0.8) / 0.2;
    s.k = Math.min(5, k);
    s.wet = 1 - sm(5.2, 6.2, k);
    s.fired = sm(5.5, 6.8, k);
    s.heat = sm(5.35, 6.1, k) * (1 - 0.6 * sm(6.5, 7.1, k)) * (1 - sm(7.1, 7.7, k));
    s.wheel = 1 - sm(5.1, 5.9, k);
    s.spiral = sm(0.5, 1.2, k) * (1 - sm(4.4, 5.3, k));
    s.wobble = 0.55 * (1 - sm(0.5, 1, k)) + sm(0.5, 1.1, k) * (1 - sm(4.4, 5.2, k));
    s.spot = 1 + 0.25 * sm(7, 8, k);
    s.unit = U * (1 - 0.06 * sm(7, 8, k));   // a breath of scrubbed scale as it comes to rest
    s.baseSpin = 0.3 + 1.6 * sm(0.3, 1, k) * (1 - sm(4.6, 5.4, k));

    for (let i = 0; i < beats.length; i++) {
      const [a, b, c, d] = WIN[i];
      const vin = a < 0 ? 1 : sm(a, b, p), vout = 1 - sm(c, d, p);
      const v = Math.round(Math.min(vin, vout) * 1000) / 1000;
      const st = beats[i].style;
      st.opacity = v;
      st.visibility = v > 0.001 ? 'visible' : 'hidden';
      const leaving = p > (b + c) / 2;
      st.setProperty('--wy', `${((1 - v) * (leaving ? -40 : 48)).toFixed(1)}px`);
      st.setProperty('--ws', (0.94 + 0.06 * v).toFixed(3));
      st.setProperty('--cy', `${((1 - v) * (leaving ? -16 : 24)).toFixed(1)}px`);
    }
  };

  pots.push(ctl);
  const relayout = () => { ctl.layout(); };
  setLive(liveWanted());
  onMotion((on) => setLive(on));
  ctl._relayout = relayout;
}

/* layout + motion changes for all pots */
let rq = 0;
window.addEventListener('resize', () => { cancelAnimationFrame(rq); rq = requestAnimationFrame(() => pots.forEach((p) => p.layout())); });
onMotion(() => pots.forEach((p) => { p.applyMotion(); p.layout(); }));
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => pots.forEach((p) => p.layout()));

/* ==========================================================================
   3 · Highlights carousel
   ========================================================================== */
(function carousel() {
  const car = $('.car');
  const track = $('#car-track');
  if (!car || !track) return;
  const slides = $$('.slide', track);
  const ctl = $('.car__ctl', car);
  const dots = $$('.dot', car);
  const play = $('.car__play', car);
  ctl.hidden = false;

  const DUR = 5000;
  let idx = 0, elapsed = 0, userPaused = false, inView = false, hover = false, focus = false, drag = null, last = 0;

  const pad = () => parseFloat(getComputedStyle(track).paddingLeft) || 0;
  const target = (i) => slides[i].offsetLeft - pad();
  const nearest = () => {
    const x = track.scrollLeft; let best = 0, bd = Infinity;
    slides.forEach((_, i) => { const d = Math.abs(target(i) - x); if (d < bd) { bd = d; best = i; } });
    // at the far end the last slides cannot snap to the start edge
    if (track.scrollLeft + track.clientWidth >= track.scrollWidth - 4) best = slides.length - 1;
    return best;
  };
  const mark = (i) => {
    if (i === idx && dots[i].getAttribute('aria-current') === 'true') return;
    idx = i;
    dots.forEach((d, j) => d.setAttribute('aria-current', String(j === i)));
    slides.forEach((s, j) => s.setAttribute('aria-hidden', String(j !== i && !isVisible(s))));
  };
  const isVisible = (s) => { const a = s.offsetLeft - track.scrollLeft, b = a + s.offsetWidth; return b > 40 && a < track.clientWidth - 40; };
  const goTo = (i, user) => {
    i = (i + slides.length) % slides.length;
    track.scrollTo({ left: target(i), behavior: motionOn() ? 'smooth' : 'auto' });
    mark(i);
    elapsed = 0;
    if (user) setProgress(motionOn() && playing() ? 0 : null);
  };
  const playing = () => !userPaused && motionOn();
  const setProgress = (p) => {
    const span = dots[idx] && dots[idx].firstElementChild;
    dots.forEach((d) => d.firstElementChild.style.removeProperty('--p'));
    if (span && p !== null) span.style.setProperty('--p', p.toFixed(4));
  };
  const syncButton = () => {
    const on = playing();
    play.hidden = !motionOn();
    play.dataset.state = on ? 'playing' : 'paused';
    play.setAttribute('aria-label', on ? 'Pause highlights' : 'Play highlights');
    track.setAttribute('aria-live', on ? 'off' : 'polite');
    if (!on) setProgress(null);
  };

  dots.forEach((d, i) => d.addEventListener('click', () => goTo(i, true)));
  play.addEventListener('click', () => { userPaused = !userPaused; elapsed = 0; syncButton(); });

  let sq = 0;
  track.addEventListener('scroll', () => { cancelAnimationFrame(sq); sq = requestAnimationFrame(() => { if (!drag) mark(nearest()); }); }, { passive: true });
  track.addEventListener('keydown', (e) => {
    const map = { ArrowRight: idx + 1, ArrowLeft: idx - 1, Home: 0, End: slides.length - 1 };
    if (e.key in map) { e.preventDefault(); goTo(clamp(map[e.key], 0, slides.length - 1), true); }
  });
  car.addEventListener('pointerenter', () => { hover = true; });
  car.addEventListener('pointerleave', () => { hover = false; });
  car.addEventListener('focusin', () => { focus = true; });
  car.addEventListener('focusout', () => { focus = car.contains(document.activeElement); });

  // mouse drag (touch and trackpads scroll natively)
  track.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    drag = { x: e.clientX, left: track.scrollLeft, moved: false, id: e.pointerId, t: performance.now(), vx: 0, lx: e.clientX };
  });
  track.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) > 6) { drag.moved = true; track.classList.add('is-drag'); try { track.setPointerCapture(drag.id); } catch (_) {} }
    if (drag.moved) {
      track.scrollLeft = drag.left - dx;
      const now = performance.now(); drag.vx = (e.clientX - drag.lx) / Math.max(1, now - drag.t); drag.t = now; drag.lx = e.clientX;
    }
  });
  const endDrag = (e) => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    const d = drag; drag = null;
    track.classList.remove('is-drag');
    if (!d.moved) return;
    let i = nearest();
    if (Math.abs(d.vx) > 0.3) i = clamp(idx + (d.vx < 0 ? 1 : -1), 0, slides.length - 1);
    goTo(i, true);
  };
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);
  track.addEventListener('dragstart', (e) => e.preventDefault());

  if ('IntersectionObserver' in window) {
    new IntersectionObserver((es) => { inView = es[0].intersectionRatio > 0.5; }, { threshold: [0, 0.5, 1] }).observe(track);
  }

  // the autoplay clock: only advances while visible, unhovered, unfocused
  const tick = (now) => {
    const dt = Math.min(100, now - (last || now)); last = now;
    if (playing() && inView && !hover && !focus && !drag && !document.hidden) {
      elapsed += dt;
      setProgress(Math.min(1, elapsed / DUR));
      if (elapsed >= DUR) { goTo(idx + 1); setProgress(0); }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  onMotion(() => { elapsed = 0; syncButton(); });
  mark(0); syncButton();
})();

/* ==========================================================================
   4 · Take a closer look
   ========================================================================== */
(function closer() {
  const list = $('.closer__list');
  const stage = $('#cl-stage');
  if (!list || !stage) return;
  const tabs = $$('[role="tab"]', list);
  const imgs = $$('.closer__photos img', stage);
  const cap = $('.closer__cap', stage);
  const select = (t, focus) => {
    tabs.forEach((x) => { const on = x === t; x.setAttribute('aria-selected', String(on)); x.tabIndex = on ? 0 : -1; });
    const key = t.dataset.img;
    imgs.forEach((im) => im.classList.toggle('is-on', im.dataset.for === key));
    stage.setAttribute('aria-labelledby', t.id);
    if (cap) cap.textContent = $('.chip__line', t).textContent;
    if (focus) t.focus();
    // keep the chosen pill in view on phones, without moving the page
    if (list.scrollWidth > list.clientWidth) {
      const l = t.offsetLeft - list.offsetLeft - parseFloat(getComputedStyle(list).paddingLeft);
      list.scrollTo({ left: l - 8, behavior: motionOn() ? 'smooth' : 'auto' });
    }
  };
  tabs.forEach((t) => t.addEventListener('click', () => select(t)));
  list.addEventListener('keydown', (e) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const next = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    select(tabs[(next + tabs.length) % tabs.length], true);
  });
  // warm the cache for the photos once the section is near
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((es) => {
      if (es[0].isIntersecting) { imgs.forEach((im) => { im.loading = 'eager'; }); io.disconnect(); }
    }, { rootMargin: '600px' });
    io.observe(stage);
  }
  tabs.forEach((x, i) => { x.tabIndex = i === 0 ? 0 : -1; });
})();

/* ==========================================================================
   6 · Menu — segmented control
   ========================================================================== */
(function menu() {
  const seg = $('.seg');
  if (!seg) return;
  const rail = $('.seg__rail', seg);
  const thumb = $('.seg__thumb', seg);
  const tabs = $$('[role="tab"]', rail);
  const panels = tabs.map((t) => document.getElementById(t.getAttribute('aria-controls')));
  seg.hidden = false;

  const place = (t, cold) => {
    if (!thumb) return;
    if (cold) thumb.classList.add('is-cold');
    thumb.style.width = `${t.offsetWidth}px`;
    thumb.style.transform = `translateX(${t.offsetLeft}px)`;
    if (cold) { thumb.getBoundingClientRect(); thumb.classList.remove('is-cold'); }
  };
  const select = (t, { focus = false, cold = false } = {}) => {
    tabs.forEach((x, i) => {
      const on = x === t;
      x.setAttribute('aria-selected', String(on));
      x.tabIndex = on ? 0 : -1;
      panels[i].hidden = !on;
    });
    place(t, cold);
    if (focus) t.focus({ preventScroll: true });
    if (seg.scrollWidth > seg.clientWidth) {
      const l = t.offsetLeft + rail.offsetLeft - seg.clientWidth / 2 + t.offsetWidth / 2;
      seg.scrollTo({ left: Math.max(0, l), behavior: motionOn() && !cold ? 'smooth' : 'auto' });
    }
    if (!cold && motionOn() && window.gsap) {
      const items = $$('li', panels[tabs.indexOf(t)]);
      gsap.fromTo(items, { y: 18, opacity: 0 }, { y: 0, opacity: 1, duration: 0.7, ease: 'power3.out', stagger: 0.035, overwrite: true, clearProps: 'transform,opacity' });
    }
  };
  tabs.forEach((t) => t.addEventListener('click', () => select(t)));
  rail.addEventListener('keydown', (e) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    select(tabs[(next + tabs.length) % tabs.length], { focus: true });
  });
  const current = () => tabs.find((t) => t.getAttribute('aria-selected') === 'true') || tabs[1];
  select(current(), { cold: true });
  window.addEventListener('resize', () => place(current(), true));
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => place(current(), true));
})();

/* ==========================================================================
   7 · Gatherings — the route draws itself when the tile arrives
   ========================================================================== */
(function gather() {
  const tiles = $$('.g-tile');
  if (!('IntersectionObserver' in window)) { tiles.forEach((t) => t.classList.add('is-in')); return; }
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); } }), { threshold: 0.35 });
  tiles.forEach((t) => io.observe(t));
})();

/* ==========================================================================
   Motion layer (GSAP). Built when Motion is on, fully reverted when off.
   ========================================================================== */
let ctx = null;
function buildMotion() {
  if (!window.gsap || !window.ScrollTrigger) return;
  gsap.registerPlugin(ScrollTrigger);
  ctx = gsap.context(() => {
    const E = 'expo.out';
    // hero lines rise in on load
    gsap.from('.hero [data-line]', { yPercent: 60, opacity: 0, duration: 1.6, ease: E, stagger: 0.12, delay: 0.1 });
    gsap.from('.hero [data-rise]', { y: 24, opacity: 0, duration: 1.4, ease: E, stagger: 0.1, delay: 0.25 });
    gsap.from('.hero__stage > *', { y: 60, opacity: 0, scale: 0.94, duration: 2, ease: E, delay: 0.35 });
    // the hero pot recedes as the film takes over (scrubbed)
    gsap.fromTo('.hero__stage', { scale: 1, opacity: 1, yPercent: 0 }, {
      scale: 0.82, opacity: 0.2, yPercent: 10, ease: 'none',
      scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true }
    });

    // headings and single lines rise and fade on enter
    $$('[data-rise]').filter((el) => !el.closest('.hero')).forEach((el) => {
      gsap.from(el, { y: 48, opacity: 0, duration: 1.3, ease: E, scrollTrigger: { trigger: el, start: 'top 90%', once: true } });
    });

    // groups of tiles arrive together, staggered
    const group = (sel, trig, y = 64) => gsap.from(sel, {
      y, opacity: 0, duration: 1.3, ease: E, stagger: 0.08,
      scrollTrigger: { trigger: trig, start: 'top 82%', once: true }
    });
    group('.slide', '.car__track', 0);
    gsap.from('.slide', { x: 120, duration: 1.6, ease: E, stagger: 0.06, scrollTrigger: { trigger: '.car__track', start: 'top 82%', once: true } });
    group('.closer__stage', '.closer__grid', 48);
    group('.closer__list .chip', '.closer__grid', 24);
    group('.bento .tile', '.bento');
    group('.g-tile', '.gather__grid');
    group('.rewards', '.rewards', 24);
    group('.chapter:not([hidden]) .dishes li', '.chapters', 18);

    // numbers count up (0 counts down from 9)
    $$('[data-count]').forEach((el) => {
      const to = +el.dataset.count, from = el.dataset.from ? +el.dataset.from : 0;
      const o = { v: from };
      gsap.to(o, {
        v: to, duration: to > 20 ? 2 : 1.6, ease: 'power3.out',
        onStart() { el.textContent = String(from); },
        onUpdate() { el.textContent = String(Math.round(o.v)); },
        onComplete() { el.textContent = String(to); },
        scrollTrigger: { trigger: el, start: 'top 88%', once: true }
      });
    });
  });
  ScrollTrigger.refresh();
}
function teardownMotion() {
  if (ctx) { ctx.revert(); ctx = null; }
  $$('[data-count]').forEach((el) => { el.textContent = el.dataset.count; });
}
function syncMotion() { motionOn() ? (ctx || buildMotion()) : teardownMotion(); }
// GSAP is a deferred classic script; it has run by the time this module does.
syncMotion();
onMotion(syncMotion);
window.addEventListener('load', () => { if (window.ScrollTrigger) ScrollTrigger.refresh(); });
