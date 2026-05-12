// Icon specs — each spec mirrors what's in public/controller/index.html.
// Opacities are split into three semantic buckets so the "opacity boost"
// slider can lift the dim layers (chevrons, ghosted rings) without flatting
// the solid focal dot.
//
//   primary   — the solid filled circle (the focal element)
//   secondary — chevrons and the "where the finger goes" connector line
//   tertiary  — ghosted background rings / horizontal indicator lines

const ICONS = [
  {
    key: 'swipe',
    verb: 'Swipe',
    result: 'move',
    width: 36, height: 18,
    strokeLinejoin: 'round',
    elements: [
      // Chevrons + the two connector segments live inside ONE <path>: SVG
      // applies opacity per element, so overlapping stroke caps at the
      // chevron tips (3,9) / (33,9) compose as a single shape — no alpha
      // doubling. The line endpoints reach slightly inside the dot region
      // (x=14 and x=22, dot edges at 13.8 / 22.2) so their round caps are
      // hidden by the solid dot drawn on top.
      { tag: 'path', attrs: { d: 'M9 3L3 9L9 15M3 9L14 9M22 9L33 9M27 3L33 9L27 15' }, baseOpacity: 0.4 },
      { tag: 'circle', attrs: { cx: 18, cy: 9 }, dotR: 4, fill: true, baseOpacity: 1.0 },
    ],
  },
  {
    key: 'tap',
    verb: 'Tap',
    result: 'rotate',
    width: 28, height: 28,
    strokeLinejoin: 'round',
    elements: [
      // Rings first, dot last — keeps the solid focal dot on top of any
      // ring stroke that grazes the center.
      { tag: 'circle', attrs: { cx: 14, cy: 14, r: 8 }, baseOpacity: 0.25 },
      { tag: 'circle', attrs: { cx: 14, cy: 14, r: 13 }, fixedOpacity: 0.25 },
      { tag: 'circle', attrs: { cx: 14, cy: 14 }, dotR: 3, fill: true, baseOpacity: 1.0 },
    ],
  },
  {
    key: 'flick-drop',
    verb: 'Flick',
    result: 'drop',
    width: 22, height: 28,
    strokeLinejoin: 'round',
    elements: [
      // Shaft + chevron in one <path> so they share opacity and don't
      // alpha-double at the chevron tip (11,24) where both subpaths meet.
      { tag: 'path', attrs: { d: 'M11 10L11 24M7 19L11 24L15 19' }, baseOpacity: 0.4 },
      { tag: 'circle', attrs: { cx: 11, cy: 6 }, dotR: 4, fill: true, baseOpacity: 1.0 },
    ],
  },
  {
    key: 'flick-hold',
    verb: 'Flick',
    result: 'hold',
    width: 22, height: 28,
    strokeLinejoin: 'round',
    elements: [
      { tag: 'path', attrs: { d: 'M11 18L11 4M7 9L11 4L15 9' }, baseOpacity: 0.4 },
      { tag: 'circle', attrs: { cx: 11, cy: 22 }, dotR: 4, fill: true, baseOpacity: 1.0 },
    ],
  },
];

const BASELINE = { stroke: 1.4, boost: 0.5, dot: 1.05, scale: 1.4 };
const SVG_NS = 'http://www.w3.org/2000/svg';

function liftOpacity(base, boost) {
  return base + (1 - base) * boost;
}

function buildIconSvg(spec, { stroke, boost, dot }) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', spec.width);
  svg.setAttribute('height', spec.height);
  svg.setAttribute('viewBox', `0 0 ${spec.width} ${spec.height}`);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', stroke);
  svg.setAttribute('stroke-linecap', 'round');
  if (spec.strokeLinejoin) svg.setAttribute('stroke-linejoin', spec.strokeLinejoin);

  for (const el of spec.elements) {
    const node = document.createElementNS(SVG_NS, el.tag);
    for (const [k, v] of Object.entries(el.attrs)) {
      node.setAttribute(k, v);
    }
    if (el.dotR != null) {
      node.setAttribute('r', (el.dotR * dot).toFixed(2));
    }
    if (el.fill) {
      node.setAttribute('fill', 'currentColor');
      node.setAttribute('stroke', 'none');
    }
    // `fixedOpacity` opts an element out of the boost slider — used for
    // elements like the tap outer ring whose intended opacity is below
    // what `base + (1-base)*boost` can reach at the baseline boost.
    const op = el.fixedOpacity != null ? el.fixedOpacity : liftOpacity(el.baseOpacity, boost);
    node.setAttribute('opacity', op.toFixed(3));
    svg.appendChild(node);
  }
  return svg;
}

function renderRow(container, opts) {
  container.innerHTML = '';
  container.style.setProperty('--icon-scale', opts.scale);
  for (const spec of ICONS) {
    const item = document.createElement('div');
    item.className = 'hint-bar-item';
    const iconWrap = document.createElement('div');
    iconWrap.className = 'hint-bar-item__icon';
    iconWrap.appendChild(buildIconSvg(spec, opts));
    const verb = document.createElement('div');
    verb.className = 'hint-bar-item__verb';
    verb.textContent = spec.verb;
    const result = document.createElement('div');
    result.className = 'hint-bar-item__result';
    result.textContent = spec.result;
    item.append(iconWrap, verb, result);
    container.appendChild(item);
  }
}

function renderSweep(container) {
  container.innerHTML = '';
  const widths = [1.2, 1.4, 1.6, 1.8];
  const corner = document.createElement('div');
  corner.className = 'sweep-label';
  corner.textContent = '';
  container.appendChild(corner);
  for (const spec of ICONS) {
    const head = document.createElement('div');
    head.className = 'sweep-label';
    head.style.textAlign = 'center';
    head.style.paddingRight = '0';
    head.textContent = spec.verb;
    container.appendChild(head);
  }
  for (const w of widths) {
    const label = document.createElement('div');
    label.className = 'sweep-label';
    label.textContent = w.toFixed(1);
    container.appendChild(label);
    for (const spec of ICONS) {
      const cell = document.createElement('div');
      cell.className = 'sweep-cell';
      cell.appendChild(buildIconSvg(spec, { stroke: w, boost: BASELINE.boost, dot: BASELINE.dot }));
      container.appendChild(cell);
    }
  }
}

// Serialize an icon SVG to the one-line shape used in public/controller/index.html.
function svgMarkup(spec, opts) {
  const svg = buildIconSvg(spec, opts);
  let out = `<svg width="${spec.width}" height="${spec.height}" viewBox="0 0 ${spec.width} ${spec.height}" fill="none" stroke="currentColor" stroke-width="${opts.stroke}" stroke-linecap="round"`;
  if (spec.strokeLinejoin) out += ` stroke-linejoin="${spec.strokeLinejoin}"`;
  out += '>';
  for (const child of svg.children) {
    out += '<' + child.tagName;
    for (const attr of child.attributes) {
      out += ` ${attr.name}="${attr.value}"`;
    }
    out += '/>';
  }
  out += '</svg>';
  return out;
}

const els = {
  baseline: document.getElementById('baseline'),
  preview: document.getElementById('preview'),
  sweep: document.getElementById('sweep'),
  stroke: document.getElementById('stroke'),
  boost: document.getElementById('boost'),
  dot: document.getElementById('dot'),
  scale: document.getElementById('scale'),
  strokeVal: document.getElementById('strokeVal'),
  boostVal: document.getElementById('boostVal'),
  dotVal: document.getElementById('dotVal'),
  scaleVal: document.getElementById('scaleVal'),
  output: document.getElementById('output'),
  reset: document.getElementById('reset'),
  copy: document.getElementById('copy'),
};

function currentOpts() {
  return {
    stroke: parseFloat(els.stroke.value),
    boost: parseFloat(els.boost.value),
    dot: parseFloat(els.dot.value),
    scale: parseFloat(els.scale.value),
  };
}

function updateValueLabels(opts) {
  els.strokeVal.textContent = opts.stroke.toFixed(1);
  els.boostVal.textContent = Math.round(opts.boost * 100) + '%';
  els.dotVal.textContent = opts.dot.toFixed(2) + '×';
  els.scaleVal.textContent = opts.scale.toFixed(2) + '×';
}

function updateOutput(opts) {
  const lines = [];
  lines.push(`// stroke-width=${opts.stroke}  opacity-boost=${(opts.boost*100).toFixed(0)}%  dot-scale=${opts.dot.toFixed(2)}×  css-scale=${opts.scale.toFixed(2)}×`);
  lines.push('');
  for (const spec of ICONS) {
    lines.push(`<!-- ${spec.verb.toLowerCase()} → ${spec.result} -->`);
    lines.push(svgMarkup(spec, opts));
    lines.push('');
  }
  els.output.textContent = lines.join('\n');
}

function rerender() {
  const opts = currentOpts();
  updateValueLabels(opts);
  renderRow(els.preview, opts);
  updateOutput(opts);
}

function setSliders(o) {
  els.stroke.value = o.stroke;
  els.boost.value = o.boost;
  els.dot.value = o.dot;
  els.scale.value = o.scale;
}

for (const id of ['stroke', 'boost', 'dot', 'scale']) {
  els[id].addEventListener('input', rerender);
}

els.reset.addEventListener('click', () => {
  setSliders(BASELINE);
  rerender();
});

els.copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.output.textContent);
    const orig = els.copy.textContent;
    els.copy.textContent = 'Copied';
    setTimeout(() => { els.copy.textContent = orig; }, 1200);
  } catch (e) {
    els.copy.textContent = 'Clipboard blocked';
  }
});

renderRow(els.baseline, BASELINE);
renderSweep(els.sweep);
rerender();
