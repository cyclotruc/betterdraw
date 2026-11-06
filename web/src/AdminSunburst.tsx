// Devices, systems and browsers as rings, each splitting the one inside it. A click opens a part: it becomes
// the whole (100%), its pieces fill the rings, and the middle goes back up.
import { useEffect, useMemo, useRef, useState } from "react";
import { hierarchy, partition, type HierarchyRectangularNode } from "d3-hierarchy";
import { arc } from "d3-shape";
import { num, useWidth } from "./AdminCharts";

type Leaf = { name: string; value?: number; children?: Leaf[] };
type Node = HierarchyRectangularNode<Leaf>;
type View = { x0: number; x1: number; depth: number };

// "Phone|iOS|Safari" keys into device › system › browser.
function tree(items: { key: string; n: number }[]): Leaf {
  const root: Leaf = { name: "All visitors", children: [] };
  for (const { key, n } of items) {
    let at = root;
    for (const part of (key || "Not known").split("|")) {
      at.children ??= [];
      let next = at.children.find((c) => c.name === part);
      if (!next) at.children.push((next = { name: part }));
      at = next;
    }
    at.value = (at.value ?? 0) + n;
  }
  return root;
}

const RINGS = [0, 0.42, 0.68, 0.86, 1, 1.12]; // inner edge of the middle, then of each ring, as a share of the radius
const HUES: Record<string, string> = { Desktop: "--dev-desktop", Phone: "--dev-phone", Tablet: "--dev-tablet" };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// Each device, system and browser by its icon, drawn on its part: Tabler Icons (MIT, © Paweł Kuna), strokes on 24
// units, and the Linux penguin from Phosphor Icons (MIT, © Phosphor Icons), filled on 256. ChromeOS wears Chrome's,
// iOS and macOS the apple, Samsung Internet a planet like its logo.
const CHROME = [
  "M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0",
  "M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0",
  "M12 9h8.4",
  "M14.598 13.5l-4.2 7.275",
  "M9.402 13.5l-4.2 -7.275",
];
const APPLE = [
  "M8.286 7.008c-3.216 0 -4.286 3.23 -4.286 5.92c0 3.229 2.143 8.072 4.286 8.072c1.165 -.05 1.799 -.538 3.214 -.538c1.406 0 1.607 .538 3.214 .538s4.286 -3.229 4.286 -5.381c-.03 -.011 -2.649 -.434 -2.679 -3.23c-.02 -2.335 2.589 -3.179 2.679 -3.228c-1.096 -1.606 -3.162 -2.113 -3.75 -2.153c-1.535 -.12 -3.032 1.077 -3.75 1.077c-.729 0 -2.036 -1.077 -3.214 -1.077",
  "M12 4a2 2 0 0 0 2 -2a2 2 0 0 0 -2 2",
];
const ICONS: Record<string, string[]> = {
  Desktop: ["M3 5a1 1 0 0 1 1 -1h16a1 1 0 0 1 1 1v10a1 1 0 0 1 -1 1h-16a1 1 0 0 1 -1 -1v-10", "M7 20h10", "M9 16v4", "M15 16v4"],
  Phone: ["M6 5a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2v-14", "M11 4h2", "M12 17v.01"],
  Tablet: ["M5 4a1 1 0 0 1 1 -1h12a1 1 0 0 1 1 1v16a1 1 0 0 1 -1 1h-12a1 1 0 0 1 -1 -1v-16", "M11 17a1 1 0 1 0 2 0a1 1 0 0 0 -2 0"],
  Windows: [
    "M17.8 20l-12 -1.5c-1 -.1 -1.8 -.9 -1.8 -1.9v-9.2c0 -1 .8 -1.8 1.8 -1.9l12 -1.5c1.2 -.1 2.2 .8 2.2 1.9v12.1c0 1.2 -1.1 2.1 -2.2 1.9l0 .1",
    "M12 5l0 14",
    "M4 12l16 0",
  ],
  macOS: APPLE,
  iOS: APPLE,
  Android: [
    "M4 10l0 6",
    "M20 10l0 6",
    "M7 9h10v8a1 1 0 0 1 -1 1h-8a1 1 0 0 1 -1 -1v-8a5 5 0 0 1 10 0",
    "M8 3l1 2",
    "M16 3l-1 2",
    "M9 18l0 3",
    "M15 18l0 3",
  ],
  ChromeOS: CHROME,
  Chrome: CHROME,
  Safari: ["M8 16l2 -6l6 -2l-2 6l-6 2", "M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"],
  Firefox: [
    "M4.028 7.82a9 9 0 1 0 12.823 -3.4c-1.636 -1.02 -3.064 -1.02 -4.851 -1.02h-1.647",
    "M4.914 9.485c-1.756 -1.569 -.805 -5.38 .109 -6.17c.086 .896 .585 1.208 1.111 1.685c.88 -.275 1.313 -.282 1.867 0c.82 -.91 1.694 -2.354 2.628 -2.093c-1.082 1.741 -.07 3.733 1.371 4.173c-.17 .975 -1.484 1.913 -2.76 2.686c-1.296 .938 -.722 1.85 0 2.234c.949 .506 3.611 -1 4.545 .354c-1.698 .102 -1.536 3.107 -3.983 2.727c2.523 .957 4.345 .462 5.458 -.34c1.965 -1.52 2.879 -3.542 2.879 -5.557c-.014 -1.398 .194 -2.695 -1.26 -4.75",
  ],
  Edge: [
    "M20.978 11.372a9 9 0 1 0 -1.593 5.773",
    "M20.978 11.372c.21 2.993 -5.034 2.413 -6.913 1.486c1.392 -1.6 .402 -4.038 -2.274 -3.851c-1.745 .122 -2.927 1.157 -2.784 3.202c.28 3.99 4.444 6.205 10.36 4.79",
    "M3.022 12.628c-.283 -4.043 8.717 -7.228 11.248 -2.688",
    "M12.628 20.978c-2.993 .21 -5.162 -4.725 -3.567 -9.748",
  ],
  Opera: ["M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0", "M9 12a3 5 0 1 0 6 0a3 5 0 1 0 -6 0"],
  "Samsung Internet": [
    "M18.816 13.58c2.292 2.138 3.546 4 3.092 4.9c-.745 1.46 -5.783 -.259 -11.255 -3.838c-5.47 -3.579 -9.304 -7.664 -8.56 -9.123c.464 -.91 2.926 -.444 5.803 .805",
    "M5 12a7 7 0 1 0 14 0a7 7 0 1 0 -14 0",
  ],
};
const PENGUIN =
  "M231.49,217.38a12,12,0,0,1-16.89-1.9C213.19,213.72,180,171.24,180,88A52,52,0,1,0,76,88c0,83.24-33.21,125.72-34.62,127.48A12,12,0,0,1,22.6,200.53C23,200,52,162.06,52,88a76,76,0,1,1,152,0c0,74.19,29.1,112.16,29.4,112.54A12,12,0,0,1,231.49,217.38ZM104,120a16,16,0,1,0-16-16A16,16,0,0,0,104,120Zm64-16a16,16,0,1,0-16,16A16,16,0,0,0,168,104ZM95.26,155l28,12a12,12,0,0,0,9.45,0l28-12A12,12,0,0,0,151.26,133l-23.27,10-23.27-10A12,12,0,0,0,95.26,155ZM128,184a57.12,57.12,0,0,0-38.66,15.15,12,12,0,0,0,16.23,17.69,32.86,32.86,0,0,1,44.85,0,12,12,0,1,0,16.23-17.69A57.1,57.1,0,0,0,128,184Z";
const hasIcon = (name: string) => name === "Linux" || name in ICONS;
function Glyph({ name, x, y, size }: { name: string; x: number; y: number; size: number }) {
  const at = { x: x - size / 2, y: y - size / 2, width: size, height: size };
  if (name === "Linux")
    return (
      <svg {...at} viewBox="0 0 256 256" aria-hidden="true">
        <path d={PENGUIN} fill="currentColor" />
      </svg>
    );
  return (
    <svg
      {...at}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
const ring = (r: number) => lerp(RINGS[Math.floor(r)] ?? 1.12, RINGS[Math.ceil(r)] ?? 1.12, r - Math.floor(r));

export function Sunburst({ items, unit = "visitors" }: { items: { key: string; n: number }[]; unit?: string }) {
  const [ref, w] = useWidth();
  const root = useMemo(() => {
    const h = hierarchy(tree(items))
      .sum((d) => d.value ?? 0)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    return partition<Leaf>().size([2 * Math.PI, 1])(h);
  }, [items]);
  const [focus, setFocus] = useState<Node>(root);
  const [view, setView] = useState<View>({ x0: 0, x1: 2 * Math.PI, depth: 0 });
  const [on, setOn] = useState<{ node: Node; x: number; y: number } | null>(null);
  const anim = useRef(0);
  useEffect(() => {
    setFocus(root);
    setView({ x0: 0, x1: 2 * Math.PI, depth: 0 });
  }, [root]);

  // Opening a part (or going back up) turns the rings smoothly, unless motion is reduced.
  const open = (node: Node) => {
    if (!node.children) return;
    setFocus(node);
    setOn(null);
    const from = view;
    const to = { x0: node.x0, x1: node.x1, depth: node.depth };
    cancelAnimationFrame(anim.current);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return setView(to);
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 450);
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      setView({ x0: lerp(from.x0, to.x0, e), x1: lerp(from.x1, to.x1, e), depth: lerp(from.depth, to.depth, e) });
      if (t < 1) anim.current = requestAnimationFrame(step);
    };
    anim.current = requestAnimationFrame(step);
  };

  const size = Math.min(w, 300);
  const R = size / 2 - 4;
  const angle = (x: number) => Math.max(0, Math.min(2 * Math.PI, ((x - view.x0) / (view.x1 - view.x0)) * 2 * Math.PI));
  const shape = arc<Node>()
    .startAngle((d) => angle(d.x0))
    .endAngle((d) => angle(d.x1))
    .innerRadius((d) => ring(d.depth - view.depth) * R)
    .outerRadius((d) => ring(d.depth - view.depth + 1) * R - 2)
    .padAngle(0.012)
    .padRadius(R)
    .cornerRadius(2);
  const total = focus.value ?? 0;
  const top = (d: Node) => d.ancestors().find((a) => a.depth === 1) ?? d;
  const fill = (d: Node) => `color-mix(in srgb, var(${HUES[top(d).data.name] ?? "--dev-other"}) ${100 - (d.depth - 1) * 26}%, var(--bg))`;
  const shown = root
    .descendants()
    .filter((d) => d.depth > view.depth - 0.001 && d.depth - view.depth > 0.001 && d.depth - view.depth < 3.999);
  // Each piece of the first ring shows its share of what is open; names are in the legend and on hover.
  const label = (d: Node) => d.depth - focus.depth === 1 && (angle(d.x1) - angle(d.x0)) * ((ring(1) + ring(2)) / 2) * R > 34;
  // Each piece wears its icon too, at its middle, when it has the room; in the first ring, above its share.
  const icon = (d: Node) => {
    if (!hasIcon(d.data.name)) return null;
    const r = d.depth - view.depth;
    const [inner, outer] = [ring(r) * R, ring(r + 1) * R - 2];
    const size = Math.min(16, outer - inner - 6);
    if (size < 10 || (angle(d.x1) - angle(d.x0)) * ((inner + outer) / 2) < size + 6) return null;
    const [x, y] = arc<Node>().innerRadius(inner).outerRadius(outer).startAngle(angle(d.x0)).endAngle(angle(d.x1)).centroid(d);
    return { x, y: label(d) ? y - 8 : y, size };
  };
  const crumbs = focus.ancestors().reverse();
  return (
    <div ref={ref} className="viz sunburst">
      <div className="sb-crumbs">
        {crumbs.map((c, i) => (
          <span key={i}>
            {i > 0 && " › "}
            {i < crumbs.length - 1 ? (
              <button className="link" onClick={() => open(c)}>
                {c.data.name}
              </button>
            ) : (
              <strong>{c.data.name}</strong>
            )}
          </span>
        ))}
      </div>
      {w > 0 && (
        <svg width={w} height={size} role="img" aria-label={`${focus.data.name}: ${num(total)} ${unit}`} onPointerLeave={() => setOn(null)}>
          <g transform={`translate(${w / 2},${size / 2})`}>
            {shown.map((d) => (
              <path
                key={d
                  .ancestors()
                  .map((a) => a.data.name)
                  .join("/")}
                d={shape(d) ?? ""}
                style={{ fill: fill(d) }}
                className={d.children ? "opens" : ""}
                tabIndex={d.children && d.depth - focus.depth === 1 ? 0 : -1}
                role={d.children ? "button" : undefined}
                aria-label={`${d.data.name}: ${num(d.value ?? 0)} ${unit}`}
                onClick={() => open(d)}
                onKeyDown={(e) => e.key === "Enter" && open(d)}
                onPointerMove={(e) => {
                  const r = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
                  setOn({ node: d, x: e.clientX - r.left, y: e.clientY - r.top });
                }}
              />
            ))}
            {shown.filter(label).map((d) => {
              const [x, y] = arc<Node>()
                .innerRadius(ring(1) * R)
                .outerRadius(ring(2) * R)
                .startAngle(angle(d.x0))
                .endAngle(angle(d.x1))
                .centroid(d);
              return (
                <text key={"t" + d.data.name} className="sb-pct" x={x} y={y + (icon(d) ? 13 : 4)} textAnchor="middle">
                  {Math.round(((d.value ?? 0) / total) * 100)}%
                </text>
              );
            })}
            {shown.map((d) => {
              const at = icon(d);
              const hue = `var(${HUES[top(d).data.name] ?? "--dev-other"})`;
              return (
                at && (
                  <g
                    key={
                      "i" +
                      d
                        .ancestors()
                        .map((a) => a.data.name)
                        .join("/")
                    }
                    className={"sb-icon" + (d.depth > 1 && !label(d) ? " deep" : "")}
                    style={{ "--hue": hue } as React.CSSProperties}
                  >
                    <Glyph name={d.data.name} {...at} />
                  </g>
                )
              );
            })}
            <circle
              className={"sb-middle" + (focus.parent ? " back" : "")}
              r={ring(1) * R - 4}
              onClick={() => focus.parent && open(focus.parent as Node)}
              role={focus.parent ? "button" : undefined}
              aria-label={focus.parent ? `Back to ${focus.parent.data.name}` : undefined}
            />
            <text className="sb-value" textAnchor="middle" y={focus.parent ? -2 : 4}>
              {num(total)}
            </text>
            <text className="tick" textAnchor="middle" y={focus.parent ? 14 : 20}>
              {focus.parent ? focus.data.name : unit}
            </text>
            {focus.parent && (
              <text className="tick" textAnchor="middle" y={30}>
                ↩ back
              </text>
            )}
          </g>
        </svg>
      )}
      {on && (
        <div className="viz-tip" style={{ left: Math.max(0, Math.min(on.x + 14, w - 190)), top: on.y + 14 }}>
          <div className="tip-title">
            {on.node
              .ancestors()
              .reverse()
              .slice(1)
              .map((a) => a.data.name)
              .join(" › ")}
          </div>
          <div className="tip-row">
            {unit[0].toUpperCase() + unit.slice(1)} <strong>{num(on.node.value ?? 0)}</strong>
          </div>
          {focus.parent && (
            <div className="tip-row">
              Of {focus.data.name} <strong>{Math.round(((on.node.value ?? 0) / total) * 100)}%</strong>
            </div>
          )}
          <div className="tip-row">
            Of all <strong>{Math.round(((on.node.value ?? 0) / (root.value || 1)) * 100)}%</strong>
          </div>
          {on.node.children && on.node !== focus && <div className="tip-hint">Click to open</div>}
        </div>
      )}
      <div className="legend sb-legend">
        {(root.children ?? []).map((c) => (
          <button key={c.data.name} className="link" onClick={() => open(c)}>
            <i className="key" style={{ background: `var(${HUES[c.data.name] ?? "--dev-other"})` }} />
            {c.data.name}
          </button>
        ))}
      </div>
    </div>
  );
}
