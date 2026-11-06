// A treemap of features, each box as big as its share, grouped by what they are for.
import { useMemo, useState } from "react";
import { hierarchy, treemap } from "d3-hierarchy";
import { num, pct, useWidth } from "./AdminCharts";

type Item = { key: string; n: number };

// Features, grouped by what they are for: a box per group, a box per feature inside, as big as its uses.
const FEATURES: Record<string, [string, string]> = {
  "copy canvas link": ["Sharing", "Link copied"],
  "link access: edit": ["Sharing", "Anyone edits"],
  "link access: view": ["Sharing", "Anyone views"],
  "link access: none": ["Sharing", "Made private"],
  "agent panel opened": ["Agents", "Panel opened"],
  "copy agent prompt": ["Agents", "Prompt copied"],
  "copy MCP setup": ["Agents", "MCP copied"],
  "agent key created": ["Agents", "Key made"],
  "export image": ["Export", "Image"],
  "download canvas": ["Export", "File"],
  "image added": ["Images", "Added"],
  "project created": ["Projects", "Made"],
  "feedback sent": ["Feedback", "Sent"],
  "bug reported": ["Feedback", "Bug reported"],
};
type Group = { name: string; children?: Group[]; n?: number; key?: string };
// Each group in its own color, the dashboard's palette: agents keep their blue.
const HUES: Record<string, string> = {
  Sharing: "--cat-1",
  Agents: "--agents",
  Images: "--cat-2",
  Export: "--cat-3",
  Projects: "--cat-4",
};

// A click on a group opens it: it becomes the whole (100%), its boxes fill the space and their shares read "of
// Sharing"; the trail above goes back to all features.
export function FeatureMap({ items, height = 250 }: { items: Item[]; height?: number }) {
  const [ref, w] = useWidth();
  const [on, setOn] = useState<{ group: string; name: string; n: number; x: number; y: number } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const total = items.reduce((s, i) => s + i.n, 0);
  const groups = useMemo(() => {
    const out = new Map<string, Group>();
    for (const it of items) {
      const [group, name] = FEATURES[it.key] ?? ["Other", it.key];
      if (!out.has(group)) out.set(group, { name: group, children: [] });
      out.get(group)!.children!.push({ name, n: it.n, key: it.key });
    }
    return out;
  }, [items]);
  const focus = open && groups.has(open) ? open : null;
  const shown = useMemo(() => (focus ? [groups.get(focus)!] : [...groups.values()]), [groups, focus]);
  const whole = shown.reduce((s, g) => s + g.children!.reduce((n, c) => n + (c.n ?? 0), 0), 0);
  const max = Math.max(1, ...shown.flatMap((g) => g.children!.map((c) => c.n ?? 0)));
  const root = useMemo(() => {
    if (!w) return null;
    const h = hierarchy<Group>({ name: "all", children: shown })
      .sum((d) => d.n ?? 0)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    // Room for each group's name above its boxes; none around the whole.
    const edge = (d: { depth: number }) => (d.depth ? 3 : 0);
    return treemap<Group>()
      .size([w, height])
      .paddingInner((d) => (d.depth ? 2 : 4))
      .paddingTop((d) => (d.depth ? 22 : 0))
      .paddingRight(edge)
      .paddingBottom(edge)
      .paddingLeft(edge)
      .round(true)(h);
  }, [shown, w, height]);
  const strength = (n: number) => Math.round(22 + 78 * Math.sqrt(n / max));
  const pick = (group: string) => {
    setOn(null);
    setOpen(focus ? null : group);
  };
  return (
    <div ref={ref} className="viz features">
      <div className="sb-crumbs">
        {focus ? (
          <>
            <button className="link" onClick={() => setOpen(null)}>
              All features
            </button>
            {" › "}
            <strong>{focus}</strong>
          </>
        ) : (
          <strong>All features</strong>
        )}
      </div>
      {root && (
        <svg width={w} height={height} role="img" aria-label="Features used" onPointerLeave={() => setOn(null)}>
          {(root.children ?? []).map((g) => (
            <g key={g.data.name} className="opens" onClick={() => pick(g.data.name)}>
              <rect
                className="group"
                x={g.x0}
                y={g.y0}
                width={g.x1 - g.x0}
                height={g.y1 - g.y0}
                rx={6}
                style={{ fill: `color-mix(in srgb, var(${HUES[g.data.name] ?? "--dev-other"}) 12%, var(--bg))` }}
              />
              <text className="group-name" x={g.x0 + 8} y={g.y0 + 15}>
                <tspan className="strong">{g.data.name}</tspan>
                <tspan dx={6}>
                  {num(g.value ?? 0)}
                  {focus ? " · 100%" : ""}
                </tspan>
              </text>
            </g>
          ))}
          {root.leaves().map((c) => {
            const [cw, ch] = [c.x1 - c.x0, c.y1 - c.y0];
            const s = strength(c.data.n ?? 0);
            const group = c.parent!.data.name;
            const value = `${num(c.data.n ?? 0)}${focus ? ` · ${pct(c.data.n ?? 0, whole)}` : ""}`;
            // The name on one line, else a word per line when the box is narrow but tall.
            const lines = c.data.name.length * 6.8 + 14 < cw ? [c.data.name] : c.data.name.split(" ");
            const fits = Math.max(...lines.map((l) => l.length)) * 6.8 + 14 < cw && ch > 20 + 15 * lines.length;
            return (
              <g
                key={c.data.key}
                className="opens"
                transform={`translate(${c.x0},${c.y0})`}
                onClick={() => pick(group)}
                onPointerMove={(e) => {
                  const r = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
                  setOn({ group, name: c.data.name, n: c.data.n ?? 0, x: e.clientX - r.left, y: e.clientY - r.top });
                }}
              >
                <rect
                  width={cw}
                  height={ch}
                  rx={3}
                  style={{ fill: `color-mix(in srgb, var(${HUES[group] ?? "--dev-other"}) ${s}%, var(--bg))` }}
                />
                {fits && (
                  <text className={"lang-label" + (s > 55 ? " on-deep" : "")} x={7} y={16}>
                    {lines.map((l, i) => (
                      <tspan key={i} className="lang-name" x={7} dy={i ? 15 : 0}>
                        {l}
                      </tspan>
                    ))}
                    <tspan x={7} dy={15}>
                      {value}
                    </tspan>
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {on && (
        <div className="viz-tip" style={{ left: Math.max(0, Math.min(on.x + 14, w - 190)), top: on.y + 14 }}>
          <div className="tip-title">
            {on.group} › {on.name}
          </div>
          <div className="tip-row">
            Uses <strong>{num(on.n)}</strong>
          </div>
          {focus && (
            <div className="tip-row">
              Of {focus} <strong>{pct(on.n, whole)}</strong>
            </div>
          )}
          <div className="tip-row">
            Of all <strong>{pct(on.n, total)}</strong>
          </div>
          <div className="tip-hint">{focus ? "Click to go back to all features" : `Click to open ${on.group}`}</div>
        </div>
      )}
    </div>
  );
}
