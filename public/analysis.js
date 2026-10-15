/* Analysis section of the admin dashboard: build, save and display custom charts.
   Charts are computed in the browser from the attendee list, so they update live with the rest of the dashboard. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = new Intl.NumberFormat('en-US');
  const SVGNS = 'http://www.w3.org/2000/svg';
  const FONT = "Roboto, 'Helvetica Neue', Arial, sans-serif";

  // ------------------------------------------------------------ what can be analysed
  const DIMS = {
    company: { label: 'Company', kind: 'cat', noun: 'company' },
    designation: { label: 'Designation', kind: 'cat', noun: 'designation' },
    emailDomain: { label: 'Email domain', kind: 'cat', noun: 'email domain' },
    status: { label: 'Attendance status', kind: 'status', noun: 'attendance status' },
    regDay: { label: 'Registration date', kind: 'time', noun: 'registration date' },
    regWeekday: { label: 'Day of the week registered', kind: 'ordinal', noun: 'day of the week' },
    regHour: { label: 'Time of day registered', kind: 'ordinal', noun: 'time of day' },
    arrival15: { label: 'Arrival time (15 minutes)', kind: 'time', arrival: true, noun: 'arrival time' },
    arrivalHour: { label: 'Arrival time (hour)', kind: 'ordinal', arrival: true, noun: 'arrival hour' },
  };
  const METRICS = {
    count: { label: 'Number of registrants', short: 'Registrants' },
    checkedIn: { label: 'Number checked in', short: 'Checked in' },
    rate: { label: 'Attendance rate (%)', short: 'Attendance rate' },
    stacked: { label: 'Registered vs checked in', short: 'Registered vs checked in' },
  };
  const TYPES = {
    bar: { label: 'Bar', icon: '<path d="M4 6h12M4 12h16M4 18h8"/>' },
    column: { label: 'Column', icon: '<path d="M6 20V10M12 20V4M18 20v-7"/>' },
    line: { label: 'Line', icon: '<path d="m3 17 6-6 4 4 8-8"/>' },
    pie: { label: 'Pie', icon: '<circle cx="12" cy="12" r="8"/><path d="M12 4v8l6 5"/>' },
  };
  const FILTERS = { all: 'Everyone', in: 'Checked in only', out: 'Not arrived only' };

  function allowedMetrics(dim) {
    const d = DIMS[dim];
    if (d.arrival) return ['checkedIn'];
    if (d.kind === 'status') return ['count'];
    if (d.kind === 'time') return ['count', 'checkedIn'];
    return ['count', 'checkedIn', 'rate', 'stacked'];
  }
  function allowedTypes(dim, metric) {
    const d = DIMS[dim];
    if (metric === 'rate' || metric === 'stacked') return ['bar', 'column'];
    if (d.kind === 'time') return ['column', 'line'];
    if (d.kind === 'ordinal') return ['column', 'line', 'bar'];
    if (d.kind === 'status') return ['bar', 'column'];      // a two-slice pie is better as bars
    return ['bar', 'column', 'pie'];
  }
  const filterApplies = (dim, metric) => !DIMS[dim].arrival && DIMS[dim].kind !== 'status' && metric !== 'rate' && metric !== 'stacked';

  function autoTitle(c) {
    const d = DIMS[c.dimension];
    let t;
    if (d.arrival) t = c.dimension === 'arrival15' ? 'Arrivals every 15 minutes' : 'Arrivals by hour';
    else if (c.dimension === 'status') t = 'Checked in vs not arrived';
    else if (c.metric === 'rate') t = `Attendance rate by ${d.noun}`;
    else if (c.metric === 'stacked') t = `Registered vs checked in by ${d.noun}`;
    else if (c.metric === 'checkedIn') t = `Checked in by ${d.noun}`;
    else t = c.chartType === 'pie' ? `Share of registrants by ${d.noun}` : `Registrants by ${d.noun}`;
    if (filterApplies(c.dimension, c.metric) && c.filter !== 'all') t += c.filter === 'in' ? ' (checked in only)' : ' (not arrived only)';
    return t;
  }

  // ------------------------------------------------------------ grouping
  let TZ = 'Asia/Manila';
  const partsFmt = () => new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
  function local(iso) {
    const o = {};
    for (const p of partsFmt().formatToParts(new Date(iso))) o[p.type] = p.value;
    return { day: `${o.year}-${o.month}-${o.day}`, hour: Number(o.hour), minute: Number(o.minute), weekday: o.weekday };
  }
  const dayLabel = (day, long) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', ...(long ? { weekday: 'short' } : {}) }).format(new Date(day + 'T00:00:00Z'));
  const addDays = (day, n) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const clock = (m) => { const h = Math.floor(m / 60) % 24, mm = m % 60; return `${((h + 11) % 12) + 1}${mm ? ':' + String(mm).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`; };
  const normKey = (s) => String(s || '').toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
  const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const WEEK_LONG = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };

  // Returns ordered groups: [{ key, label, long, rows: [...] }]
  function groupRows(dim, rows) {
    const map = new Map();
    const add = (key, label, long, r) => {
      if (!map.has(key)) map.set(key, { key, label, long, rows: [], names: new Map() });
      const g = map.get(key);
      g.rows.push(r);
      g.names.set(label, (g.names.get(label) || 0) + 1);
    };
    if (DIMS[dim].kind === 'cat') {
      for (const r of rows) {
        const raw = dim === 'emailDomain' ? (r.email.split('@')[1] || '(none)') : (dim === 'company' ? r.company : r.designation);
        const label = String(raw || '(blank)').trim();
        add(normKey(label), label, label, r);
      }
      // the most common spelling names each group
      const groups = [...map.values()].map((g) => { const best = [...g.names.entries()].sort((a, b) => b[1] - a[1])[0][0]; return { ...g, label: best, long: best }; });
      return groups;
    }
    if (dim === 'status') {
      const g = [{ key: 'in', label: 'Checked in', long: 'Checked in', rows: [] }, { key: 'out', label: 'Not arrived', long: 'Not arrived', rows: [] }];
      for (const r of rows) g[r.checkedInAt ? 0 : 1].rows.push(r);
      return g;
    }
    if (dim === 'regDay') {
      for (const r of rows) { const d = local(r.registeredAt).day; add(d, dayLabel(d), dayLabel(d, true), r); }
      const days = [...map.keys()].sort();
      if (!days.length) return [];
      const out = [];
      for (let d = days[0]; d <= days[days.length - 1]; d = addDays(d, 1)) out.push(map.get(d) || { key: d, label: dayLabel(d), long: dayLabel(d, true), rows: [] });
      return out.slice(-60);
    }
    if (dim === 'regWeekday') {
      for (const r of rows) { const w = local(r.registeredAt).weekday; add(w, w, WEEK_LONG[w], r); }
      return WEEK.map((w) => map.get(w) || { key: w, label: w, long: WEEK_LONG[w], rows: [] });
    }
    if (dim === 'regHour') {
      for (const r of rows) { const h = local(r.registeredAt).hour; add(h, clock(h * 60), `${clock(h * 60)} – ${clock(h * 60 + 60)}`, r); }
      return fillHours(map);
    }
    // arrival dimensions: check-ins on the most recent check-in day
    const ins = rows.filter((r) => r.checkedInAt);
    if (!ins.length) return [];
    const lastDay = local(ins.reduce((a, b) => (a.checkedInAt > b.checkedInAt ? a : b)).checkedInAt).day;
    const todays = ins.filter((r) => local(r.checkedInAt).day === lastDay);
    if (dim === 'arrivalHour') {
      for (const r of todays) { const h = local(r.checkedInAt).hour; add(h, clock(h * 60), `${clock(h * 60)} – ${clock(h * 60 + 60)}`, r); }
      return fillHours(map);
    }
    for (const r of todays) { const l = local(r.checkedInAt); const m = Math.floor((l.hour * 60 + l.minute) / 15) * 15; add(m, clock(m), `${clock(m)} – ${clock(m + 15)}`, r); }
    const ks = [...map.keys()].sort((a, b) => a - b);
    const out = [];
    for (let m = ks[0]; m <= ks[ks.length - 1]; m += 15) out.push(map.get(m) || { key: m, label: clock(m), long: `${clock(m)} – ${clock(m + 15)}`, rows: [] });
    return out;
  }
  function fillHours(map) {
    const ks = [...map.keys()].sort((a, b) => a - b);
    if (!ks.length) return [];
    const out = [];
    for (let h = ks[0]; h <= ks[ks.length - 1]; h++) out.push(map.get(h) || { key: h, label: clock(h * 60), long: `${clock(h * 60)} – ${clock(h * 60 + 60)}`, rows: [] });
    return out;
  }

  // Builds the plotted model: { cats: [{label, long, values: [..]}], series: [{name, color}], percent, total, more }
  function buildModel(c, people, colors) {
    const d = DIMS[c.dimension];
    let rows = people;
    if (filterApplies(c.dimension, c.metric) && c.filter === 'in') rows = rows.filter((r) => r.checkedInAt);
    if (filterApplies(c.dimension, c.metric) && c.filter === 'out') rows = rows.filter((r) => !r.checkedInAt);
    let groups = groupRows(c.dimension, rows);
    const inCount = (g) => g.rows.filter((r) => r.checkedInAt).length;
    const value = (g) => (c.metric === 'checkedIn' || d.arrival ? inCount(g) : g.rows.length);
    const model = { series: [{ name: METRICS[c.metric].short, color: colors.series }], percent: c.metric === 'rate', more: 0, cats: [] };

    if (c.metric === 'stacked') {
      model.series = [{ name: 'Checked in', color: colors.series }, { name: 'Not arrived', color: colors.rest }];
      groups.sort((a, b) => b.rows.length - a.rows.length);
      model.more = Math.max(0, groups.length - 10);
      model.cats = groups.slice(0, 10).map((g) => ({ label: g.label, long: g.long, values: [inCount(g), g.rows.length - inCount(g)] }));
    } else if (c.metric === 'rate') {
      groups = groups.filter((g) => g.rows.length).sort((a, b) => b.rows.length - a.rows.length);
      model.more = Math.max(0, groups.length - 10);
      model.cats = groups.slice(0, 10).map((g) => ({ label: g.label, long: `${g.long}: ${inCount(g)} of ${g.rows.length} checked in`, values: [Math.round((inCount(g) / g.rows.length) * 100)] }));
    } else if (d.kind === 'cat') {
      groups = groups.map((g) => ({ ...g, v: value(g) })).filter((g) => g.v > 0).sort((a, b) => b.v - a.v || a.label.localeCompare(b.label));
      if (c.chartType === 'pie') {
        const top = groups.slice(0, 5);
        const rest = groups.slice(5).reduce((s, g) => s + g.v, 0);
        model.cats = top.map((g, i) => ({ label: g.label, long: g.long, values: [g.v], color: colors.cat[i] }));
        if (rest) model.cats.push({ label: `Other (${groups.length - 5})`, long: `${groups.length - 5} others`, values: [rest], color: colors.other });
      } else {
        model.more = Math.max(0, groups.length - 10);
        model.cats = groups.slice(0, 10).map((g) => ({ label: g.label, long: g.long, values: [g.v] }));
      }
    } else {
      model.cats = groups.map((g) => ({ label: g.label, long: g.long, values: [value(g)] }));
    }
    model.total = model.cats.reduce((s, x) => s + x.values.reduce((a, b) => a + b, 0), 0);
    return model;
  }

  // ------------------------------------------------------------ colors (read from the page's light/dark tokens)
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    return {
      series: v('--series'), surface: v('--surface'), ink: v('--ink'), muted: v('--muted'), grid: v('--grid'), line: v('--line'),
      cat: [1, 2, 3, 4, 5, 6].map((i) => v(`--cat-${i}`)), other: v('--cat-other'), rest: v('--stack-rest'),
    };
  }

  // ------------------------------------------------------------ rendering (inline SVG with explicit colors, so it exports cleanly)
  function niceMax(v) {
    if (v <= 4) return 4;
    const step = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10]) if (m * step >= v) return m * step;
    return 10 * step;
  }
  const ticksFor = (top) => [0, top / 4, top / 2, (3 * top) / 4, top].filter((t) => Number.isInteger(t));
  const fmtVal = (v, pct) => (pct ? `${v}%` : nf.format(v));
  const text = (x, y, s, attrs, colors) => `<text x="${x}" y="${y}" fill="${attrs.fill || colors.muted}" font-size="${attrs.size || 12}" ${attrs.weight ? `font-weight="${attrs.weight}"` : ''} text-anchor="${attrs.anchor || 'start'}" font-family="${FONT}" ${attrs.extra || ''}>${esc(s)}</text>`;
  // a bar with a 4px rounded data end and a square baseline
  function barPath(x, y, w, h, dir) {
    if (w <= 0 || h <= 0) return '';
    if (dir === 'up') { const r = Math.min(4, h, w / 2); return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`; }
    const r = Math.min(4, w, h / 2); return `M${x},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x} Z`;
  }
  const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  function renderChart(el, c, model, colors) {
    if (!model.cats.length || model.total === 0) {
      el.innerHTML = `<p class="empty">${DIMS[c.dimension].arrival ? 'No one has checked in yet.' : 'No data to show yet.'}</p>`;
      return null;
    }
    const W = Math.max(300, Math.round(el.clientWidth || 560));
    let svg, hits;
    if (c.chartType === 'pie') ({ svg, hits } = pie(W, model, colors));
    else if (c.chartType === 'bar') ({ svg, hits } = hbar(W, model, colors));
    else if (c.chartType === 'line') ({ svg, hits } = line(W, model, colors));
    else ({ svg, hits } = column(W, model, colors));
    el.innerHTML = svg + '<div class="tip" hidden></div>';
    const svgEl = el.querySelector('svg');
    const tip = el.querySelector('.tip');
    el.querySelectorAll('[data-hit]').forEach((h) => {
      const i = Number(h.dataset.hit);
      const info = hits[i];
      h.addEventListener('pointerenter', () => {
        const k = svgEl.getBoundingClientRect().width / W;
        tip.innerHTML = info.html;
        tip.style.left = `${info.x * k}px`;
        tip.style.top = `${info.y * k}px`;
        tip.hidden = false;
        el.querySelectorAll(`[data-mark="${i}"]`).forEach((m) => m.setAttribute('opacity', '0.8'));
      });
      h.addEventListener('pointerleave', () => { tip.hidden = true; el.querySelectorAll(`[data-mark="${i}"]`).forEach((m) => m.removeAttribute('opacity')); });
    });
    return svgEl;
  }

  function tipHtml(model, cat) {
    if (model.series.length > 1) {
      const tot = cat.values.reduce((a, b) => a + b, 0);
      return `<b>${esc(cat.long)}</b><br>${model.series.map((s, i) => `${esc(s.name)}: ${nf.format(cat.values[i])}`).join('<br>')}<br>Total: ${nf.format(tot)}`;
    }
    return `<b>${fmtVal(cat.values[0], model.percent)}</b> ${model.percent ? 'checked in' : ''}<br>${esc(cat.long)}`;
  }

  function legend(model, colors, W, y) {
    if (model.series.length < 2) return { svg: '', h: 0 };
    let x = 0, out = '';
    model.series.forEach((s) => {
      out += `<rect x="${x}" y="${y}" width="12" height="12" rx="3" fill="${s.color}"/>` + text(x + 18, y + 10.5, s.name, { fill: colors.ink, size: 12.5 }, colors);
      x += 18 + s.name.length * 7.2 + 22;
    });
    return { svg: out, h: 26 };
  }

  function column(W, model, colors) {
    const lg = legend(model, colors, W, 0);
    const H = 260 + lg.h, m = { l: 40, r: 8, t: 22 + lg.h, b: 30 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const top = model.percent ? 100 : niceMax(Math.max(...model.cats.map((c) => c.values.reduce((a, b) => a + b, 0))));
    const y = (v) => m.t + ph - (v / top) * ph;
    const band = pw / model.cats.length, bw = Math.max(2, Math.min(24, band - 4));
    const every = Math.max(1, Math.ceil(model.cats.length / Math.max(1, Math.floor(pw / 66))));
    let s = `<svg xmlns="${SVGNS}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">` + lg.svg;
    for (const t of ticksFor(top)) s += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}" stroke="${t === 0 ? colors.line : colors.grid}" stroke-width="1" shape-rendering="crispEdges"/>` + text(m.l - 8, y(t) + 4, fmtVal(t, model.percent), { anchor: 'end' }, colors);
    const hits = [];
    let peak = 0;
    model.cats.forEach((c, i) => { if (c.values.reduce((a, b) => a + b, 0) > model.cats[peak].values.reduce((a, b) => a + b, 0)) peak = i; });
    model.cats.forEach((c, i) => {
      const cx = m.l + band * i + band / 2, x0 = cx - bw / 2;
      let acc = 0;
      c.values.forEach((v, si) => {
        if (v <= 0) return;
        const yTop = y(acc + v), yBot = y(acc) - (acc > 0 ? 2 : 0);   // 2px surface gap between stacked segments
        const isTop = c.values.slice(si + 1).every((n) => n <= 0);
        s += isTop ? `<path data-mark="${i}" d="${barPath(x0, yTop, bw, yBot - yTop, 'up')}" fill="${model.series[si].color}"/>`
          : `<rect data-mark="${i}" x="${x0}" y="${yTop}" width="${bw}" height="${Math.max(0, yBot - yTop)}" fill="${model.series[si].color}"/>`;
        acc += v;
      });
      if (i === peak || model.cats.length <= 8) s += text(cx, y(acc) - 6, fmtVal(acc, model.percent), { anchor: 'middle', fill: colors.ink, weight: 600 }, colors);
      if (i % every === 0) s += text(cx, H - 10, trunc(c.label, Math.max(4, Math.floor((band * every) / 7))), { anchor: 'middle' }, colors);
      s += `<rect data-hit="${i}" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ph}" fill="transparent"/>`;
      hits.push({ x: cx, y: y(acc), html: tipHtml(model, c) });
    });
    return { svg: s + '</svg>', hits };
  }

  function hbar(W, model, colors) {
    const lg = legend(model, colors, W, 0);
    const rowH = 30, bh = 18;
    const labelW = Math.min(Math.round(W * 0.38), 210);
    const valueW = model.percent ? 44 : 50;
    const H = lg.h + 6 + model.cats.length * rowH + 4;
    const x0 = labelW + 12, pw = W - x0 - valueW;
    const top = model.percent ? 100 : Math.max(...model.cats.map((c) => c.values.reduce((a, b) => a + b, 0)));
    const xw = (v) => (v / top) * pw;
    let s = `<svg xmlns="${SVGNS}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">` + lg.svg;
    const hits = [];
    s += `<line x1="${x0}" x2="${x0}" y1="${lg.h + 2}" y2="${H - 2}" stroke="${colors.line}" stroke-width="1" shape-rendering="crispEdges"/>`;
    model.cats.forEach((c, i) => {
      const yy = lg.h + 6 + i * rowH, by = yy + (rowH - bh) / 2;
      s += text(labelW, by + bh / 2 + 4.5, trunc(c.label, Math.floor(labelW / 7)), { anchor: 'end', fill: colors.ink, size: 12.5 }, colors);
      let acc = 0;
      c.values.forEach((v, si) => {
        if (v <= 0) return;
        const xs = x0 + xw(acc) + (acc > 0 ? 2 : 0), w = Math.max(0, xw(v) - (acc > 0 ? 2 : 0));
        const isEnd = c.values.slice(si + 1).every((n) => n <= 0);
        s += isEnd ? `<path data-mark="${i}" d="${barPath(xs, by, w, bh, 'right')}" fill="${model.series[si].color}"/>`
          : `<rect data-mark="${i}" x="${xs}" y="${by}" width="${w}" height="${bh}" fill="${model.series[si].color}"/>`;
        acc += v;
      });
      s += text(x0 + xw(acc) + 6, by + bh / 2 + 4.5, fmtVal(acc, model.percent), { fill: colors.ink, weight: 600 }, colors);
      s += `<rect data-hit="${i}" x="0" y="${yy}" width="${W}" height="${rowH}" fill="transparent"/>`;
      hits.push({ x: x0 + xw(acc) / 2, y: by, html: tipHtml(model, c) });
    });
    return { svg: s + '</svg>', hits };
  }

  function line(W, model, colors) {
    const H = 260, m = { l: 40, r: 14, t: 22, b: 30 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const vals = model.cats.map((c) => c.values[0]);
    const top = niceMax(Math.max(...vals));
    const n = model.cats.length;
    const x = (i) => m.l + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
    const y = (v) => m.t + ph - (v / top) * ph;
    const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 66))));
    let s = `<svg xmlns="${SVGNS}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">`;
    for (const t of ticksFor(top)) s += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}" stroke="${t === 0 ? colors.line : colors.grid}" stroke-width="1" shape-rendering="crispEdges"/>` + text(m.l - 8, y(t) + 4, nf.format(t), { anchor: 'end' }, colors);
    const pts = vals.map((v, i) => `${x(i)},${y(v)}`).join(' ');
    s += `<polygon points="${x(0)},${y(0)} ${pts} ${x(n - 1)},${y(0)}" fill="${model.series[0].color}" fill-opacity="0.1"/>`;
    s += `<polyline points="${pts}" fill="none" stroke="${model.series[0].color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    const last = n - 1;
    s += `<circle cx="${x(last)}" cy="${y(vals[last])}" r="4.5" fill="${model.series[0].color}" stroke="${colors.surface}" stroke-width="2"/>`;
    s += text(Math.min(x(last), W - m.r - 4), y(vals[last]) - 10, nf.format(vals[last]), { anchor: 'end', fill: colors.ink, weight: 600 }, colors);
    const hits = [];
    model.cats.forEach((c, i) => {
      if (i % every === 0) s += text(x(i), H - 10, c.label, { anchor: i === 0 && n > 1 ? 'start' : 'middle' }, colors);
      const bandW = n === 1 ? pw : pw / (n - 1);
      s += `<circle data-mark="${i}" cx="${x(i)}" cy="${y(c.values[0])}" r="4.5" fill="${model.series[0].color}" stroke="${colors.surface}" stroke-width="2" visibility="hidden"/>`;
      s += `<rect data-hit="${i}" x="${x(i) - bandW / 2}" y="${m.t}" width="${bandW}" height="${ph}" fill="transparent"/>`;
      hits.push({ x: x(i), y: y(c.values[0]), html: tipHtml(model, c) });
    });
    return { svg: s + '</svg>', hits };
  }

  function pie(W, model, colors) {
    const narrow = W < 520;
    const R = 92, r = 56, cx = narrow ? W / 2 : R + 10, cy = R + 10;
    const legendX = narrow ? 10 : cx + R + 34, legendY = narrow ? cy * 2 + 16 : Math.max(14, cy - (model.cats.length * 30) / 2 + 6);
    const H = narrow ? legendY + model.cats.length * 30 + 4 : Math.max(cy * 2 + 10, legendY + model.cats.length * 30);
    let s = `<svg xmlns="${SVGNS}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">`;
    const hits = [];
    let a0 = -Math.PI / 2;
    const P = (rad, a) => [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
    model.cats.forEach((c, i) => {
      const frac = c.values[0] / model.total;
      const a1 = a0 + frac * Math.PI * 2;
      let d;
      if (frac >= 0.9999) d = `M${cx - R},${cy} a${R},${R} 0 1,0 ${2 * R},0 a${R},${R} 0 1,0 ${-2 * R},0 M${cx - r},${cy} a${r},${r} 0 1,1 ${2 * r},0 a${r},${r} 0 1,1 ${-2 * r},0 Z`;
      else {
        const large = a1 - a0 > Math.PI ? 1 : 0;
        const [x1, y1] = P(R, a0), [x2, y2] = P(R, a1), [x3, y3] = P(r, a1), [x4, y4] = P(r, a0);
        d = `M${x1},${y1} A${R},${R} 0 ${large} 1 ${x2},${y2} L${x3},${y3} A${r},${r} 0 ${large} 0 ${x4},${y4} Z`;
      }
      // 2px surface gap between slices
      s += `<path data-mark="${i}" d="${d}" fill="${c.color}" stroke="${colors.surface}" stroke-width="2" stroke-linejoin="round" fill-rule="evenodd"/>`;
      const [hx, hy] = P((R + r) / 2, (a0 + a1) / 2);
      s += `<path data-hit="${i}" d="${d}" fill="transparent"/>`;
      const pct = Math.round(frac * 100);
      hits.push({ x: hx, y: hy, html: `<b>${nf.format(c.values[0])}</b> (${pct}%)<br>${esc(c.long)}` });
      const ly = legendY + i * 30;
      const maxChars = Math.max(10, Math.floor((W - legendX - 110) / 7.2));
      s += `<rect data-mark="${i}" x="${legendX}" y="${ly}" width="12" height="12" rx="3" fill="${c.color}"/>`;
      s += text(legendX + 20, ly + 10.5, trunc(c.label, maxChars), { fill: colors.ink, size: 13 }, colors);
      s += text(W - 10, ly + 10.5, `${nf.format(c.values[0])} · ${pct}%`, { anchor: 'end', fill: colors.muted, size: 13, extra: 'font-variant-numeric="tabular-nums"' }, colors);
      s += `<rect data-hit="${i}" x="${legendX - 4}" y="${ly - 7}" width="${W - legendX}" height="26" fill="transparent"/>`;
      a0 = a1;
    });
    s += text(cx, cy + 2, nf.format(model.total), { anchor: 'middle', fill: colors.ink, size: 22, weight: 600 }, colors);
    s += text(cx, cy + 20, 'total', { anchor: 'middle', size: 12 }, colors);
    return { svg: s + '</svg>', hits };
  }

  function dataTable(c, model) {
    const head = model.series.length > 1 ? model.series.map((s) => `<th>${esc(s.name)}</th>`).join('') : `<th>${esc(METRICS[c.metric].short)}</th>`;
    return `<tr><th>${esc(DIMS[c.dimension].label)}</th>${head}</tr>` + model.cats.map((x) => `<tr><td>${esc(x.long)}</td>${x.values.map((v) => `<td class="num">${fmtVal(v, model.percent)}</td>`).join('')}</tr>`).join('');
  }

  // ------------------------------------------------------------ image download
  function downloadPng(svgEl, title, colors) {
    const w = Number(svgEl.getAttribute('width')), h = Number(svgEl.getAttribute('height'));
    const pad = 24, head = 44, foot = 26;
    const inner = svgEl.innerHTML;
    const full = `<svg xmlns="${SVGNS}" width="${w + pad * 2}" height="${h + head + foot + pad * 2}" viewBox="0 0 ${w + pad * 2} ${h + head + foot + pad * 2}">
      <rect width="100%" height="100%" fill="${colors.surface}"/>
      <text x="${pad}" y="${pad + 18}" font-family="${FONT}" font-size="18" font-weight="600" fill="${colors.ink}">${esc(title)}</text>
      <g transform="translate(${pad},${pad + head})">${inner.replace(/ data-hit="\d+"[^>]*fill="transparent"\/>/g, '/>')}</g>
      <text x="${w + pad}" y="${h + head + pad + foot}" text-anchor="end" font-family="${FONT}" font-size="11" fill="${colors.muted}">Powered by Jupiter Systems, Inc.</text></svg>`;
    const img = new Image();
    img.onload = () => {
      const k = 2, cv = document.createElement('canvas');
      cv.width = (w + pad * 2) * k; cv.height = (h + head + foot + pad * 2) * k;
      const ctx = cv.getContext('2d'); ctx.scale(k, k); ctx.drawImage(img, 0, 0);
      const a = document.createElement('a');
      a.href = cv.toDataURL('image/png');
      a.download = `${title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'chart'}.png`;
      document.body.appendChild(a); a.click(); a.remove();
    };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(full);
  }

  // ------------------------------------------------------------ saved charts on the page
  let people = [];
  let charts = [];
  let api = null;
  let onError = () => {};

  function chartCard(c) {
    const card = document.createElement('section');
    card.className = 'card span-6 an-card';
    card.setAttribute('aria-label', c.title);
    const d = DIMS[c.dimension];
    const sub = `${METRICS[c.metric].label} by ${d.label.toLowerCase()}${filterApplies(c.dimension, c.metric) && c.filter !== 'all' ? `, ${FILTERS[c.filter].toLowerCase()}` : ''}`;
    card.innerHTML = `
      <div class="an-head">
        <div><h2>${esc(c.title)}</h2><p class="sub">${esc(sub)}</p></div>
        <div class="an-actions">
          <button class="icon-btn" type="button" data-act="png" aria-label="Download ${esc(c.title)} as an image" title="Download image"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/></svg></button>
          <button class="icon-btn" type="button" data-act="remove" aria-label="Remove ${esc(c.title)}" title="Remove chart"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M10 11v6M14 11v6M6 7l1 12h10l1-12M9 7V4h6v3"/></svg></button>
        </div>
      </div>
      <div class="chart an-chart"></div>
      <p class="an-more"></p>
      <details class="data"><summary>Show data</summary><table></table></details>`;
    return card;
  }

  function renderSaved() {
    const box = $('anGrid');
    if (!box) return;
    const colors = readColors();
    box.innerHTML = '';
    $('anEmpty').hidden = charts.length > 0;
    for (const c of charts) {
      const card = chartCard(c);
      box.appendChild(card);
      const model = buildModel(c, people, colors);
      const svgEl = renderChart(card.querySelector('.an-chart'), c, model, colors);
      card.querySelector('.an-more').textContent = model.more ? `Showing the top 10. ${model.more} more ${model.more === 1 ? 'is' : 'are'} in the data table and the attendee list.` : '';
      card.querySelector('table').innerHTML = model.cats.length ? dataTable(c, model) : '';
      const pngBtn = card.querySelector('[data-act="png"]');
      pngBtn.disabled = !svgEl;
      pngBtn.addEventListener('click', () => svgEl && downloadPng(svgEl, c.title, colors));
      card.querySelector('[data-act="remove"]').addEventListener('click', async () => {
        if (!confirm(`Remove "${c.title}" from the dashboard? This removes it for all admins.`)) return;
        try { await api(`/api/admin/charts/${c.id}`, { method: 'DELETE' }); charts = charts.filter((x) => x.id !== c.id); renderSaved(); }
        catch { onError('The chart could not be removed. Try again.'); }
      });
    }
  }

  // ------------------------------------------------------------ builder
  const draft = { dimension: 'company', metric: 'count', chartType: 'bar', filter: 'all', title: '' };
  let titleTouched = false;

  function fillSelect(sel, entries, value) {
    sel.innerHTML = entries.map(([k, v]) => `<option value="${k}"${k === value ? ' selected' : ''}>${esc(v)}</option>`).join('');
  }
  function syncBuilder() {
    const metrics = allowedMetrics(draft.dimension);
    if (!metrics.includes(draft.metric)) draft.metric = metrics[0];
    const types = allowedTypes(draft.dimension, draft.metric);
    if (!types.includes(draft.chartType)) draft.chartType = types[0];
    if (!filterApplies(draft.dimension, draft.metric)) draft.filter = 'all';
    fillSelect($('anDim'), Object.entries(DIMS).map(([k, d]) => [k, d.label]), draft.dimension);
    fillSelect($('anMetric'), metrics.map((k) => [k, METRICS[k].label]), draft.metric);
    $('anMetric').disabled = metrics.length === 1;
    fillSelect($('anFilter'), Object.entries(FILTERS), draft.filter);
    $('anFilterWrap').hidden = !filterApplies(draft.dimension, draft.metric);
    $('anTypes').innerHTML = Object.entries(TYPES).filter(([k]) => types.includes(k)).map(([k, t]) => `
      <button type="button" class="type-btn" data-type="${k}" aria-pressed="${k === draft.chartType}">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${t.icon}</svg>${t.label}
      </button>`).join('');
    $('anTypes').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { draft.chartType = b.dataset.type; syncBuilder(); }));
    const hint = DIMS[draft.dimension].kind === 'status' ? 'Two groups read best as bars; pie charts are offered for 3 or more groups.'
      : draft.chartType === 'pie' ? 'Pie charts show the top 5 plus "Other", so slices stay readable.' : '';
    $('anHint').textContent = hint;
    if (!titleTouched) { draft.title = autoTitle(draft); $('anTitle').value = draft.title; }
    renderPreview();
  }
  function renderPreview() {
    const colors = readColors();
    const model = buildModel(draft, people, colors);
    renderChart($('anPreview'), draft, model, colors);
  }

  function openBuilder() {
    titleTouched = false;
    Object.assign(draft, { dimension: 'company', metric: 'count', chartType: 'bar', filter: 'all' });
    $('anBuilder').hidden = false;
    $('anAdd').setAttribute('aria-expanded', 'true');
    $('anErr').textContent = '';
    syncBuilder();
    $('anDim').focus();
  }
  function closeBuilder() {
    $('anBuilder').hidden = true;
    $('anAdd').setAttribute('aria-expanded', 'false');
    $('anAdd').focus();
  }

  function wire() {
    $('anAdd').addEventListener('click', () => ($('anBuilder').hidden ? openBuilder() : closeBuilder()));
    $('anCancel').addEventListener('click', closeBuilder);
    $('anDim').addEventListener('change', (e) => { draft.dimension = e.target.value; syncBuilder(); });
    $('anMetric').addEventListener('change', (e) => { draft.metric = e.target.value; syncBuilder(); });
    $('anFilter').addEventListener('change', (e) => { draft.filter = e.target.value; syncBuilder(); });
    $('anTitle').addEventListener('input', (e) => { titleTouched = true; draft.title = e.target.value; });
    $('anForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('anErr').textContent = '';
      const title = $('anTitle').value.trim() || autoTitle(draft);
      try {
        await api('/api/admin/charts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...draft, title }) });
        charts = await api('/api/admin/charts');
        renderSaved();
        closeBuilder();
        const cards = $('anGrid').querySelectorAll('.an-card');
        if (cards.length) cards[cards.length - 1].scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (err) { $('anErr').textContent = err.message || 'The chart could not be saved. Try again.'; }
    });
  }

  window.Analysis = {
    init(opts) { api = opts.api; onError = opts.onError || onError; wire(); },
    async update(nextPeople, tz) {
      people = nextPeople; TZ = tz || TZ;
      try { charts = await api('/api/admin/charts'); } catch { /* keep the last list */ }
      renderSaved();
      if (!$('anBuilder').hidden) renderPreview();
    },
    rerender() { renderSaved(); if (!$('anBuilder').hidden) renderPreview(); },
  };
})();
