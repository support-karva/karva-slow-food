/* Motion preference.
   Default follows the OS (prefers-reduced-motion). Any Motion switch on the
   page overrides it either way, and the choice is remembered. Choosing the
   OS's own setting clears the override, so the page follows the system again. */
const KEY = 'karva-motion';
const html = document.documentElement;
const mq = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
const listeners = new Set();
const buttons = [];

function read() { try { return localStorage.getItem(KEY); } catch (_) { return null; } }
function write(v) { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch (_) {} }

let override = read();
if (override !== 'on' && override !== 'off') override = null;

export const motionOn = () => html.getAttribute('data-motion') === 'on';
export const onMotion = (fn) => listeners.add(fn);

function apply() {
  const on = override ? override === 'on' : !mq.matches;
  const was = motionOn();
  html.setAttribute('data-motion', on ? 'on' : 'off');
  if (was !== on) listeners.forEach((fn) => { try { fn(on); } catch (e) { console.error(e); } });
}

function sync() {
  const on = motionOn();
  for (const btn of buttons) {
    btn.setAttribute('aria-pressed', String(on));
    const st = btn.querySelector('[data-motion-state]');
    if (st) st.textContent = on ? 'On' : 'Off';
    btn.title = override
      ? `Motion ${on ? 'on' : 'off'} (your choice)`
      : `Motion ${on ? 'on' : 'off'} (following your system setting)`;
  }
}

export function initMotionToggles(list) {
  for (const btn of list) {
    if (!btn) continue;
    buttons.push(btn);
    btn.hidden = false;
    btn.addEventListener('click', () => {
      const next = motionOn() ? 'off' : 'on';
      const osDefault = mq.matches ? 'off' : 'on';
      override = next === osDefault ? null : next;
      write(override);
      apply();
      sync();
    });
  }
  if (mq.addEventListener) mq.addEventListener('change', () => { if (!override) { apply(); sync(); } });
  apply();
  sync();
}
