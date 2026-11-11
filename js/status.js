/* Open / closed — always computed in Little Elm's own time zone,
   never from the visitor's clock. */
const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', hour: 'numeric', minute: 'numeric', hourCycle: 'h23'
});

const SERVICES = [
  { name: 'Lunch', open: 11 * 60, close: 14 * 60 },
  { name: 'Dinner', open: 17 * 60, close: 23 * 60 }
];

function chicagoMinutes(date = new Date()) {
  const p = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  return (parseInt(p.hour, 10) % 24) * 60 + parseInt(p.minute, 10);
}

const clock = (mins) => {
  const h = Math.floor(mins / 60) % 24, m = mins % 60, h12 = h % 12 || 12, ap = h < 12 ? 'am' : 'pm';
  return m ? `${h12}:${String(m).padStart(2, '0')} ${ap}` : `${h12} ${ap}`;
};

export function serviceState(t = chicagoMinutes()) {
  for (const s of SERVICES) if (t >= s.open && t < s.close) return { open: true, until: s.close, service: s.name, now: t };
  const next = SERVICES.find((s) => t < s.open);
  return { open: false, opens: next ? next.open : SERVICES[0].open, tomorrow: !next, service: (next || SERVICES[0]).name, now: t };
}

export function initStatus() {
  const nodes = document.querySelectorAll('[data-status]');
  const live = document.getElementById('visit-live');
  const update = () => {
    const st = serviceState();
    for (const el of nodes) {
      el.classList.toggle('is-open', st.open);
      el.classList.add('is-live');
      const label = el.querySelector('[data-status-text]');
      if (label) label.textContent = st.open ? 'Open now' : `Opens ${clock(st.opens)}`;
      el.setAttribute('aria-label', st.open
        ? `Open now, ${st.service.toLowerCase()} until ${clock(st.until)}, Little Elm time`
        : `Closed now, opens ${st.tomorrow ? 'tomorrow at ' : 'at '}${clock(st.opens)}, Little Elm time`);
    }
    if (live) {
      live.textContent = st.open
        ? `Open now. ${st.service} until ${clock(st.until)}.`
        : `It is ${clock(st.now)} in Little Elm. ${st.service} starts at ${clock(st.opens)}${st.tomorrow ? ' tomorrow' : ''}.`;
    }
  };
  update();
  setInterval(update, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) update(); });
}
