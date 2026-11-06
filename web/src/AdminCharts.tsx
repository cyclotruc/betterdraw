// The admin dashboard's charts, in plain SVG and HTML. One accent hue carries the data; a second series
// (the period before, or guests next to accounts) is a neutral or a second hue with a legend. Every chart
// shows its values on hover, and text always wears the text colors, never the data's.
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { arc, area, curveMonotoneX, line, pie, type PieArcDatum } from "d3-shape";

export const num = (n: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
export const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "–");

// The width an SVG gets, so that text is drawn at its real size instead of scaled with the chart.
export function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

// Clean ticks: 0, then 1, 2 or 5 times a power of ten. With a base (1024 for bytes), clean in the unit the
// values read in: whole MB or GB.
function scale(max: number, base = 0) {
  const per = base ? base ** Math.max(0, Math.floor(Math.log(Math.max(1, max)) / Math.log(base))) : 1;
  const m = Math.max(1, max / per);
  const unit = 10 ** Math.floor(Math.log10(m));
  const top = [1, 2, 2.5, 5, 10].map((k) => k * unit).find((v) => v >= m)!;
  const steps = top / unit === 2.5 || top / unit === 5 ? 5 : top / unit === 1 || top / unit === 10 ? 4 : 4;
  const ticks = Array.from({ length: steps + 1 }, (_, i) => (top / steps) * i).filter((v) => Number.isInteger(v) || top < 4);
  return { top: top * per, ticks: (ticks.length > 1 ? ticks : [0, top]).map((v) => v * per) };
}

// ---------- the change against the period before ----------
export function Delta({ now, before, label }: { now: number; before: number; label?: string }) {
  if (!before && !now) return <span className="delta flat">no change</span>;
  if (!before) return <span className="delta up">new</span>;
  const d = (now - before) / before;
  const cls = Math.abs(d) < 0.005 ? "flat" : d > 0 ? "up" : "down";
  return (
    <span className={"delta " + cls} title={`${num(before)} ${label ?? "the period before"}`}>
      {cls === "up" ? "▲" : cls === "down" ? "▼" : "■"} {Math.abs(Math.round(d * 100))}%
    </span>
  );
}

// ---------- a small line, no axes ----------
export function Sparkline({ values, height = 36 }: { values: number[]; height?: number }) {
  const [ref, w] = useWidth();
  const max = Math.max(1, ...values);
  const x = (i: number) => (values.length < 2 ? 0 : (i / (values.length - 1)) * (w - 4) + 2);
  const y = (v: number) => height - 3 - (v / max) * (height - 6);
  const line = values.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join("");
  return (
    <div ref={ref} className="spark" aria-hidden>
      {w > 0 && values.length > 1 && (
        <svg width={w} height={height}>
          <path className="area" d={`${line}L${x(values.length - 1)},${height}L${x(0)},${height}Z`} />
          <path className="line" d={line} />
          <circle className="dot" cx={x(values.length - 1)} cy={y(values[values.length - 1])} r={3} />
        </svg>
      )}
    </div>
  );
}

// ---------- a time series: this period as an area, the one before as a line ----------
export type Line = { name: string; values: number[]; kind: "area" | "line" | "prev" };
export function TimeChart({
  labels,
  lines,
  height = 260,
  format = num,
  base,
}: {
  labels: string[];
  lines: Line[];
  height?: number;
  format?: (n: number) => string;
  base?: number;
}) {
  const [ref, w] = useWidth();
  const [on, setOn] = useState<number | null>(null);
  const { top, ticks } = scale(Math.max(...lines.flatMap((l) => l.values)), base);
  const pad = { l: Math.max(40, 12 + 6.4 * Math.max(...ticks.map((v) => format(v).length))), r: 12, t: 12, b: 26 };
  const n = labels.length;
  const x = (i: number) => pad.l + (n < 2 ? 0 : (i / (n - 1)) * (w - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - v / top) * (height - pad.t - pad.b);
  const path = (vs: number[]) => vs.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join("");
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(w / 90))));
  const move = (e: React.PointerEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left - pad.l) / (w - pad.l - pad.r)) * (n - 1));
    setOn(i >= 0 && i < n ? i : null);
  };
  return (
    <div ref={ref} className="viz">
      {lines.length > 1 && <Legend items={lines.map((l) => [l.name, l.kind === "prev" ? "prev" : "s1"])} />}
      {w > 0 && (
        <svg width={w} height={height} onPointerMove={move} onPointerLeave={() => setOn(null)} role="img" aria-label={lines[0]?.name}>
          {ticks.map((v) => (
            <g key={v}>
              <line className="gridline" x1={pad.l} x2={w - pad.r} y1={y(v)} y2={y(v)} />
              <text className="tick" x={pad.l - 8} y={y(v) + 4} textAnchor="end">
                {v ? format(v) : "0"}
              </text>
            </g>
          ))}
          {labels.map((l, i) =>
            i % every === 0 ? (
              <text key={i} className="tick" x={x(i)} y={height - 6} textAnchor={i === 0 ? "start" : "middle"}>
                {l}
              </text>
            ) : null,
          )}
          {lines.map((l) =>
            l.kind === "area" ? (
              <g key={l.name}>
                <path className="s1-area" d={`${path(l.values)}L${x(n - 1)},${y(0)}L${x(0)},${y(0)}Z`} />
                <path className="s1-line" d={path(l.values)} />
              </g>
            ) : (
              <path key={l.name} className={l.kind === "prev" ? "prev-line" : "s1-line"} d={path(l.values)} />
            ),
          )}
          {on !== null && (
            <g>
              <line className="cross" x1={x(on)} x2={x(on)} y1={pad.t} y2={height - pad.b} />
              {lines.map((l) => (
                <circle key={l.name} className={l.kind === "prev" ? "prev-dot" : "s1-dot"} cx={x(on)} cy={y(l.values[on])} r={4} />
              ))}
            </g>
          )}
        </svg>
      )}
      {on !== null && (
        <Tip x={x(on)} w={w}>
          <div className="tip-title">{labels[on]}</div>
          {lines.map((l) => (
            <div key={l.name} className="tip-row">
              <i className={"key " + (l.kind === "prev" ? "prev" : "s1")} />
              {l.name}
              <strong>{format(l.values[on])}</strong>
            </div>
          ))}
        </Tip>
      )}
    </div>
  );
}

// ---------- columns, one series or two stacked ----------
export function Columns({
  labels,
  stacks,
  height = 220,
  tipLabels,
}: {
  labels: string[];
  stacks: { name: string; values: number[]; cls?: string }[];
  height?: number;
  tipLabels?: string[];
}) {
  const [ref, w] = useWidth();
  const [on, setOn] = useState<number | null>(null);
  const totals = labels.map((_, i) => stacks.reduce((s, st) => s + st.values[i], 0));
  const { top, ticks } = scale(Math.max(...totals));
  const pad = { l: 40, r: 8, t: 12, b: 26 };
  const n = labels.length;
  const slot = (w - pad.l - pad.r) / Math.max(1, n);
  const bar = Math.max(2, Math.min(24, slot * 0.7));
  const y = (v: number) => pad.t + (1 - v / top) * (height - pad.t - pad.b);
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(w / 70))));
  return (
    <div ref={ref} className="viz">
      {stacks.length > 1 && <Legend items={stacks.map((s, i) => [s.name, s.cls ?? (i ? "s2" : "s1")])} />}
      {w > 0 && (
        <svg width={w} height={height} onPointerLeave={() => setOn(null)} role="img" aria-label={stacks.map((s) => s.name).join(", ")}>
          {ticks.map((v) => (
            <g key={v}>
              <line className="gridline" x1={pad.l} x2={w - pad.r} y1={y(v)} y2={y(v)} />
              <text className="tick" x={pad.l - 8} y={y(v) + 4} textAnchor="end">
                {num(v)}
              </text>
            </g>
          ))}
          {labels.map((l, i) => {
            const cx = pad.l + i * slot + slot / 2;
            let base = 0;
            return (
              <g key={i} onPointerEnter={() => setOn(i)}>
                <rect x={pad.l + i * slot} y={pad.t} width={slot} height={height - pad.t - pad.b} fill="transparent" />
                {on === i && <rect className="col-hover" x={pad.l + i * slot} y={pad.t} width={slot} height={height - pad.t - pad.b} />}
                {stacks.map((st, k) => {
                  const v = st.values[i];
                  if (!v) return null;
                  const y0 = y(base),
                    y1 = y(base + v);
                  base += v;
                  const isTop = stacks.slice(k + 1).every((s) => !s.values[i]);
                  const h = Math.max(0, y0 - y1 - (k ? 2 : 0));
                  const r = isTop ? Math.min(4, h, bar / 2) : 0;
                  const x0 = cx - bar / 2;
                  const yb = y0 - (k ? 2 : 0);
                  return (
                    <path
                      key={k}
                      className={(st.cls ?? (k ? "s2" : "s1")) + "-fill"}
                      d={`M${x0},${yb}V${yb - h + r}Q${x0},${yb - h} ${x0 + r},${yb - h}H${x0 + bar - r}Q${x0 + bar},${yb - h} ${x0 + bar},${yb - h + r}V${yb}Z`}
                    />
                  );
                })}
                {i % every === 0 && (
                  <text className="tick" x={cx} y={height - 6} textAnchor="middle">
                    {l}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {on !== null && (
        <Tip x={pad.l + on * slot + slot / 2} w={w}>
          <div className="tip-title">{(tipLabels ?? labels)[on]}</div>
          {stacks.map((st, k) => (
            <div key={st.name} className="tip-row">
              <i className={"key " + (st.cls ?? (k ? "s2" : "s1"))} />
              {st.name}
              <strong>{num(st.values[on])}</strong>
            </div>
          ))}
        </Tip>
      )}
    </div>
  );
}

// ---------- two series each side of one line: one above, the other below ----------
// With `shared`, both sides use one scale and the line sits where it splits the total; otherwise each side
// has its own, labelled at its end.
export type Side = { name: string; values: number[]; cls: string };
export function Mirror({
  labels,
  up,
  down,
  shared = true,
  height = 220,
}: {
  labels: string[];
  up: Side;
  down: Side;
  shared?: boolean;
  height?: number;
}) {
  const [ref, w] = useWidth();
  const [on, setOn] = useState<number | null>(null);
  const n = labels.length;
  const pad = { l: 40, r: 8, t: 10, b: 26 };
  const plot = height - pad.t - pad.b;
  // Shared: one unit per pixel both ways, and each side keeps at least a quarter of the other's room.
  let top = scale(Math.max(...up.values)).top;
  let bottom = scale(Math.max(...down.values)).top;
  if (shared) [top, bottom] = [scale(Math.max(top, bottom / 3)).top, scale(Math.max(bottom, top / 3)).top];
  const mid = pad.t + plot * (shared ? top / (top + bottom) : 0.45);
  const yUp = (v: number) => mid - 1 - (v / top) * (mid - 1 - pad.t);
  const yDown = (v: number) => mid + 1 + (v / bottom) * (pad.t + plot - mid - 1);
  const slot = (w - pad.l - pad.r) / Math.max(1, n);
  const bar = Math.max(2, Math.min(24, slot * 0.7));
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(w / 70))));
  const column = (x: number, y0: number, y1: number, cls: string, end: "top" | "bottom") => {
    const h = Math.abs(y1 - y0);
    if (h < 0.5) return null;
    const r = Math.min(3, h, bar / 2);
    const x0 = x - bar / 2;
    return end === "top" ? (
      <path
        className={cls}
        d={`M${x0},${y0}V${y1 + r}Q${x0},${y1} ${x0 + r},${y1}H${x0 + bar - r}Q${x0 + bar},${y1} ${x0 + bar},${y1 + r}V${y0}Z`}
      />
    ) : (
      <path
        className={cls}
        d={`M${x0},${y0}V${y1 - r}Q${x0},${y1} ${x0 + r},${y1}H${x0 + bar - r}Q${x0 + bar},${y1} ${x0 + bar},${y1 - r}V${y0}Z`}
      />
    );
  };
  return (
    <div ref={ref} className="viz">
      <Legend
        items={[
          [up.name, up.cls],
          [down.name, down.cls],
        ]}
      />
      {w > 0 && (
        <svg width={w} height={height} onPointerLeave={() => setOn(null)} role="img" aria-label={`${up.name} above, ${down.name} below`}>
          <line className="gridline" x1={pad.l} x2={w - pad.r} y1={pad.t} y2={pad.t} />
          <line className="gridline" x1={pad.l} x2={w - pad.r} y1={pad.t + plot} y2={pad.t + plot} />
          <line className="midline" x1={pad.l} x2={w - pad.r} y1={mid} y2={mid} />
          <text className="tick" x={pad.l - 8} y={pad.t + 4} textAnchor="end">
            {num(top)}
          </text>
          <text className="tick" x={pad.l - 8} y={mid + 4} textAnchor="end">
            0
          </text>
          <text className="tick" x={pad.l - 8} y={pad.t + plot + 4} textAnchor="end">
            {num(bottom)}
          </text>
          {labels.map((l, i) => {
            const cx = pad.l + i * slot + slot / 2;
            return (
              <g key={i} onPointerEnter={() => setOn(i)}>
                <rect x={pad.l + i * slot} y={pad.t} width={slot} height={plot} fill="transparent" />
                {on === i && <rect className="col-hover" x={pad.l + i * slot} y={pad.t} width={slot} height={plot} />}
                {column(cx, mid - 1, yUp(up.values[i]), up.cls + "-fill", "top")}
                {column(cx, mid + 1, yDown(down.values[i]), down.cls + "-fill", "bottom")}
                {i % every === 0 && (
                  <text className="tick" x={cx} y={height - 6} textAnchor="middle">
                    {l}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {on !== null && (
        <Tip x={pad.l + on * slot + slot / 2} w={w}>
          <div className="tip-title">{labels[on]}</div>
          {[up, down].map((s) => (
            <div key={s.name} className="tip-row">
              <i className={"key " + s.cls} />
              {s.name}
              <strong>{num(s.values[on])}</strong>
            </div>
          ))}
        </Tip>
      )}
    </div>
  );
}

// ---------- a grid of cells whose color deepens with the value ----------
export function Heatmap({
  rows,
  cols,
  values,
  colEvery = 1,
  tip,
  cellText,
}: {
  rows: string[];
  cols: string[];
  values: (number | null)[][];
  colEvery?: number;
  tip: (r: number, c: number) => string;
  cellText?: (r: number, c: number) => string;
}) {
  const max = Math.max(1e-9, ...values.flat().map((v) => v ?? 0));
  return (
    <div className="heat" style={{ gridTemplateColumns: `auto repeat(${cols.length}, minmax(0, 1fr))` }}>
      <span />
      {cols.map((c, i) => (
        <span key={i} className="heat-col">
          {i % colEvery === 0 ? c : ""}
        </span>
      ))}
      {rows.map((r, ri) => (
        <Row key={ri}>
          <span className="heat-row">{r}</span>
          {cols.map((_, ci) => {
            const v = values[ri][ci];
            if (v === null) return <span key={ci} className="heat-cell none" />;
            const share = v / max;
            return (
              <span
                key={ci}
                className={"heat-cell" + (share > 0.55 ? " deep" : "")}
                style={{ ["--share" as string]: v ? 0.12 + share * 0.88 : 0 }}
                title={tip(ri, ci)}
              >
                {cellText?.(ri, ci)}
              </span>
            );
          })}
        </Row>
      ))}
    </div>
  );
}
const Row = ({ children }: { children: ReactNode }) => <>{children}</>;

// ---------- weekday by hour: one dot per hour, as big as how busy it was ----------
export function PunchCard({
  rows,
  values,
  height = 232,
  unit = "page loads",
}: {
  rows: string[];
  values: number[][];
  height?: number;
  unit?: string;
}) {
  const [ref, w] = useWidth();
  const [on, setOn] = useState<[number, number] | null>(null);
  const pad = { l: 40, r: 6, t: 6, b: 22 };
  const cols = values[0]?.length ?? 24;
  const cw = (w - pad.l - pad.r) / cols;
  const ch = (height - pad.t - pad.b) / rows.length;
  const max = Math.max(1e-9, ...values.flat());
  const big = Math.max(2, Math.min(cw, ch) / 2 - 1);
  const cx = (c: number) => pad.l + c * cw + cw / 2;
  const cy = (r: number) => pad.t + r * ch + ch / 2;
  return (
    <div ref={ref} className="viz punch">
      {w > 0 && (
        <svg width={w} height={height} role="img" aria-label={`${unit} by weekday and hour`} onPointerLeave={() => setOn(null)}>
          {rows.map((r, i) => (
            <text key={r} className="tick" x={pad.l - 10} y={cy(i) + 4} textAnchor="end">
              {r}
            </text>
          ))}
          {Array.from({ length: cols }, (_, c) =>
            c % 3 === 0 ? (
              <text key={c} className="tick" x={cx(c)} y={height - 6} textAnchor="middle">
                {String(c).padStart(2, "0")}
              </text>
            ) : null,
          )}
          {values.map((row, r) =>
            row.map((v, c) => (
              <g key={`${r}-${c}`} onPointerEnter={() => setOn([r, c])}>
                <rect x={cx(c) - cw / 2} y={cy(r) - ch / 2} width={cw} height={ch} fill="transparent" />
                <circle
                  className={v ? "punch-dot" + (on && on[0] === r && on[1] === c ? " on" : "") : "punch-none"}
                  cx={cx(c)}
                  cy={cy(r)}
                  r={v ? Math.max(2, Math.sqrt(v / max) * big) : 1.5}
                />
              </g>
            )),
          )}
        </svg>
      )}
      {on && (
        <div className="viz-tip" style={{ left: Math.max(0, Math.min(cx(on[1]) + 12, w - 170)), top: cy(on[0]) + 12 }}>
          <div className="tip-title">
            {rows[on[0]]} {String(on[1]).padStart(2, "0")}:00 to {String((on[1] + 1) % 24).padStart(2, "0")}:00 UTC
          </div>
          <div className="tip-row">
            {unit[0].toUpperCase() + unit.slice(1)} <strong>{num(values[on[0]][on[1]])}</strong>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- 30 days in a row of small cells, for the people table ----------
export function Strip({ days }: { days: number[] }) {
  const max = Math.max(1, ...days);
  return (
    <span className="strip-mini" aria-label={`${days.filter((d) => d >= 0).length} active days of 30`}>
      {days.map((d, i) => (
        <i
          key={i}
          className={d < 0 ? "" : d === 0 ? "seen" : "drew"}
          style={d > 0 ? { ["--share" as string]: 0.35 + 0.65 * (d / max) } : undefined}
        />
      ))}
    </span>
  );
}

// ---------- a ring of the parts of a whole ----------
// Each part has its own color (a CSS variable), the same wherever that kind shows. Pointing at a part, or
// at its line in the legend, puts its share in the middle.
export type Part = { key: string; name: string; n: number; color: string };
export function Donut({
  parts,
  size = 140,
  unit,
  format = num,
}: {
  parts: Part[];
  size?: number;
  unit?: string;
  format?: (n: number) => string;
}) {
  const [on, setOn] = useState<string | null>(null);
  const total = parts.reduce((s, p) => s + p.n, 0);
  const r = size / 2;
  const arcs = useMemo(
    () =>
      pie<Part>()
        .value((p) => p.n)
        .sort(null)
        .padAngle(0.03)(parts.filter((p) => p.n > 0)),
    [parts],
  );
  const ring = arc<PieArcDatum<Part>>()
    .innerRadius(r * 0.68)
    .outerRadius(r)
    .cornerRadius(3);
  const hovered = parts.find((p) => p.key === on);
  const middle = hovered ? pct(hovered.n, total) : format(total);
  return (
    <div className="donut">
      <svg width={size} height={size} viewBox={`${-r} ${-r} ${size} ${size}`} role="img" aria-label={unit ?? "Parts of the whole"}>
        {arcs.map((a) => (
          <path
            key={a.data.key}
            d={ring(a) ?? ""}
            className={on && on !== a.data.key ? "dim" : ""}
            style={{ fill: `var(${a.data.color})` }}
            onPointerEnter={() => setOn(a.data.key)}
            onPointerLeave={() => setOn(null)}
          />
        ))}
        <text
          className="donut-value"
          textAnchor="middle"
          y={unit || hovered ? 3 : 8}
          style={{ fontSize: Math.min(22, (r * 1.36 - 16) / (middle.length * 0.6)) }}
        >
          {middle}
        </text>
        {(unit || hovered) && (
          <text className="donut-unit" textAnchor="middle" y={21}>
            {hovered ? hovered.name : unit}
          </text>
        )}
      </svg>
      <ul>
        {parts.map((p) => (
          <li key={p.key} className={on === p.key ? "on" : ""} onPointerEnter={() => setOn(p.key)} onPointerLeave={() => setOn(null)}>
            <i className="key" style={{ background: `var(${p.color})` }} />
            <span>{p.name}</span>
            <strong>{format(p.n)}</strong>
            <small>{pct(p.n, total)}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- how concentrated a total is ----------
// People from the biggest, left to right, and the share of the whole held by the first k: the further the
// curve bulges above the diagonal (where everyone holds as much), the fewer hold most of it.
export function Concentration({
  curve,
  names,
  values,
  height = 200,
  unit = "people",
  one = "person",
  format = num,
}: {
  curve: [number, number][];
  names: string[];
  values: number[];
  height?: number;
  unit?: string;
  one?: string;
  format?: (n: number) => string;
}) {
  const [ref, w] = useWidth();
  const [on, setOn] = useState<number | null>(null);
  const n = curve[curve.length - 1]?.[0] ?? 0;
  const pad = { l: 38, r: 10, t: 12, b: 24 };
  const x = (k: number) => pad.l + (k / Math.max(1, n)) * (w - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v) * (height - pad.t - pad.b);
  const pts: [number, number][] = [[0, 0], ...curve];
  const shape = line<[number, number]>()
    .x((p) => x(p[0]))
    .y((p) => y(p[1]))
    .curve(curveMonotoneX);
  const fill = area<[number, number]>()
    .x((p) => x(p[0]))
    .y0(y(0))
    .y1((p) => y(p[1]))
    .curve(curveMonotoneX);
  const shareAt = (k: number) => curve.find((p) => p[0] >= k)?.[1] ?? 1;
  const mark = Math.min(3, n);
  const move = (e: React.PointerEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    const k = Math.round(((e.clientX - r.left - pad.l) / (w - pad.l - pad.r)) * n);
    setOn(k >= 1 && k <= n ? (curve.find((p) => p[0] >= k)?.[0] ?? null) : null);
  };
  // Dots for the named ones while they stay apart.
  const dots = (w - pad.l - pad.r) / Math.max(1, n) >= 7 ? curve.filter(([k]) => k <= names.length) : [];
  return (
    <div ref={ref} className="viz concentration">
      {w > 0 && n > 0 && (
        <svg
          width={w}
          height={height}
          onPointerMove={move}
          onPointerLeave={() => setOn(null)}
          role="img"
          aria-label={`Share held by the biggest ${unit}`}
        >
          {[0, 0.5, 1].map((v) => (
            <g key={v}>
              <line className="gridline" x1={pad.l} x2={w - pad.r} y1={y(v)} y2={y(v)} />
              <text className="tick" x={pad.l - 8} y={y(v) + 4} textAnchor="end">
                {v * 100}%
              </text>
            </g>
          ))}
          <line className="even" x1={x(0)} y1={y(0)} x2={x(n)} y2={y(1)} />
          <path className="people-area" d={fill(pts) ?? ""} />
          <path className="people-line" d={shape(pts) ?? ""} />
          {dots.map(([k, v]) => (
            <circle key={k} className={"people-dot" + (on === k ? " on" : "")} cx={x(k)} cy={y(v)} r={on === k ? 5 : 3.5} />
          ))}
          {on !== null && !dots.some(([k]) => k === on) && <circle className="people-dot on" cx={x(on)} cy={y(shareAt(on))} r={5} />}
          {n > mark && (
            <text className="note" x={x(mark) + 10} y={Math.min(y(shareAt(mark)) + 20, y(0) - 6)}>
              <tspan className="strong">{Math.round(shareAt(mark) * 100)}%</tspan>
              <tspan dx={5}>held by the first {mark}</tspan>
            </text>
          )}
          <text className="tick" x={x(0)} y={height - 6}>
            the biggest
          </text>
          <text className="tick" x={x(n)} y={height - 6} textAnchor="end">
            {num(n)} {n === 1 ? one : unit}
          </text>
        </svg>
      )}
      {on !== null && (
        <Tip x={x(on)} w={w}>
          <div className="tip-title">{on <= names.length ? `#${on} · ${names[on - 1]}` : `The first ${num(on)}`}</div>
          {on <= values.length && (
            <div className="tip-row">
              Keeps <strong>{format(values[on - 1])}</strong>
            </div>
          )}
          <div className="tip-row">
            {on === 1 ? "Alone holds" : `The first ${num(on)} hold`} <strong>{Math.round(shareAt(on) * 100)}%</strong>
          </div>
        </Tip>
      )}
    </div>
  );
}

// ---------- a whole in a few parts, on one bar ----------
export function SplitBar({ parts, format = num }: { parts: Part[]; format?: (n: number) => string }) {
  const [on, setOn] = useState<string | null>(null);
  const total = parts.reduce((s, p) => s + p.n, 0);
  return (
    <div className="split">
      <div className="split-bar" role="img" aria-label={parts.map((p) => `${p.n} ${p.name}`).join(", ")}>
        {parts
          .filter((p) => p.n > 0)
          .map((p) => (
            <i
              key={p.key}
              className={on && on !== p.key ? "dim" : ""}
              style={{ flexGrow: p.n, background: `var(${p.color})` }}
              onPointerEnter={() => setOn(p.key)}
              onPointerLeave={() => setOn(null)}
            />
          ))}
      </div>
      <div className="split-keys">
        {parts.map((p) => (
          <span key={p.key} className={on === p.key ? "on" : ""} onPointerEnter={() => setOn(p.key)} onPointerLeave={() => setOn(null)}>
            <i className="key" style={{ background: `var(${p.color})` }} />
            <strong>{format(p.n)}</strong> {p.name} <small>{pct(p.n, total)}</small>
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------- a share of a whole, as a gauge ----------
export function Meter({
  label,
  n,
  of,
  color = "--people",
  format = num,
}: {
  label: string;
  n: number;
  of: number;
  color?: string;
  format?: (n: number) => string;
}) {
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <span>
          <strong>{pct(n, of)}</strong>{" "}
          <small>
            {format(n)} of {format(of)}
          </small>
        </span>
      </div>
      <div className="meter-track" role="img" aria-label={`${label}: ${n} of ${of}`}>
        <i style={{ width: `${Math.max(1.5, Math.min(100, (n / Math.max(1, of)) * 100))}%`, background: `var(${color})` }} />
      </div>
    </div>
  );
}

// ---------- a value per day, as small bars in a table cell ----------
// With `fluid`, it stretches to the width of where it is.
export function MiniBars({
  values,
  max,
  cls = "s1",
  width = 120,
  height = 22,
  fluid,
}: {
  values: number[];
  max?: number;
  cls?: string;
  width?: number;
  height?: number;
  fluid?: boolean;
}) {
  const top = max ?? Math.max(1, ...values);
  const slot = width / Math.max(1, values.length);
  return (
    <svg
      className="mini-bars"
      width={fluid ? "100%" : width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${values.filter((v) => v > 0).length} days of ${values.length}`}
    >
      {values.map((v, i) =>
        v > 0 ? (
          <rect
            key={i}
            className={cls + "-fill"}
            x={i * slot + (slot > 3 ? 0.5 : 0)}
            y={height - Math.max(1.5, (v / top) * height)}
            width={Math.max(1, slot - (slot > 3 ? 1 : 0))}
            height={Math.max(1.5, (v / top) * height)}
            rx={slot > 4 ? 1 : 0}
          />
        ) : (
          <rect key={i} className="mini-none" x={i * slot} y={height - 1} width={Math.max(1, slot - 1)} height={1} />
        ),
      )}
    </svg>
  );
}

// ---------- a calendar: a cell per day, the weeks as columns from Monday ----------
// A day is deeper the more was drawn; a day someone only opened a canvas is pale.
export function Calendar({
  days,
  values,
  seen,
  unit = "shapes drawn",
}: {
  days: string[];
  values: number[];
  seen: boolean[];
  unit?: string;
}) {
  const [ref, w] = useWidth();
  const [on, setOn] = useState<number | null>(null);
  const offset = (new Date(days[0] + "T00:00:00Z").getUTCDay() + 6) % 7;
  const weeks = Math.ceil((offset + days.length) / 7);
  const [gap, left, top] = [3, 30, 16];
  const cell = Math.max(8, Math.min(18, Math.floor((w - left - gap * (weeks - 1)) / weeks)));
  const max = Math.max(1, ...values);
  const at = (i: number) => ({ x: left + Math.floor((offset + i) / 7) * (cell + gap), y: top + ((offset + i) % 7) * (cell + gap) });
  const height = top + 7 * cell + 6 * gap;
  const month = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en", { month: "short", timeZone: "UTC" });
  // A month's name above the first week it starts in, and above the first week shown.
  const months = days.flatMap((d, i) => (((offset + i) % 7 === 0 && d.slice(8) <= "07") || i === 0 ? [{ i, name: month(d) }] : []));
  return (
    <div ref={ref} className="viz calendar">
      {w > 0 && (
        <svg width={w} height={height} onPointerLeave={() => setOn(null)} role="img" aria-label={`${unit}, each day`}>
          {["Mon", "Wed", "Fri"].map((d, k) => (
            <text key={d} className="tick" x={0} y={top + k * 2 * (cell + gap) + cell - 2}>
              {d}
            </text>
          ))}
          {months
            .filter((m, k) => !k || at(m.i).x - at(months[k - 1].i).x > 30)
            .map((m) => (
              <text key={m.i} className="tick" x={at(m.i).x} y={10}>
                {m.name}
              </text>
            ))}
          {days.map((d, i) => (
            <rect
              key={d}
              x={at(i).x}
              y={at(i).y}
              width={cell}
              height={cell}
              rx={2}
              className={values[i] > 0 ? "cal-drew" : seen[i] ? "cal-seen" : "cal-none"}
              style={
                values[i] > 0
                  ? { fill: `color-mix(in srgb, var(--people) ${Math.round(35 + 65 * Math.sqrt(values[i] / max))}%, var(--viz-empty))` }
                  : undefined
              }
              onPointerEnter={() => setOn(i)}
            />
          ))}
          {on !== null && <rect className="cal-on" x={at(on).x - 1} y={at(on).y - 1} width={cell + 2} height={cell + 2} rx={3} />}
        </svg>
      )}
      {on !== null && (
        <Tip x={at(on).x + cell / 2} w={w}>
          <div className="tip-title">
            {new Date(days[on] + "T00:00:00Z").toLocaleDateString("en", {
              weekday: "short",
              day: "numeric",
              month: "short",
              timeZone: "UTC",
            })}
          </div>
          <div className="tip-row">
            {unit[0].toUpperCase() + unit.slice(1)} <strong>{num(values[on])}</strong>
          </div>
          {seen[on] && !values[on] && <div className="tip-hint">Opened a canvas</div>}
        </Tip>
      )}
    </div>
  );
}

// ---------- pieces ----------
export function Legend({ items }: { items: [string, string][] }) {
  return (
    <div className="legend">
      {items.map(([name, cls]) => (
        <span key={name}>
          <i className={"key " + cls} />
          {name}
        </span>
      ))}
    </div>
  );
}

function Tip({ x, w, children }: { x: number; w: number; children: ReactNode }) {
  const right = x > w * 0.6;
  return (
    <div className="viz-tip" style={right ? { right: w - x + 12 } : { left: x + 12 }}>
      {children}
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return <p className="empty">{text}</p>;
}

export function Card({
  title,
  sub,
  span = 12,
  children,
  right,
}: {
  title: string;
  sub?: string;
  span?: number;
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <section className={`a-card span-${span}`}>
      <header>
        <div>
          <h3>{title}</h3>
          {sub && <p>{sub}</p>}
        </div>
        {right}
      </header>
      {children}
    </section>
  );
}
