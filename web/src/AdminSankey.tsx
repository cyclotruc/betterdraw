// Flows from one stage to the next, each band as wide as how many went that way. Bands wear the color of
// where they started, and each later box is split into the colors flowing into it, like the rings of devices
// carry each device's color outwards; the bands that matter most are drawn stronger.
import { useMemo, useState } from "react";
import { sankey, sankeyJustify, sankeyLinkHorizontal } from "d3-sankey";
import { num, pct, useWidth } from "./AdminCharts";

export type FlowNode = { id: string; name: string; color?: string };
export type FlowLink = { source: string; target: string; value: number; color: string; strong?: boolean };

export function Flow({
  nodes,
  links,
  stages,
  unit,
  height = 300,
}: {
  nodes: FlowNode[];
  links: FlowLink[];
  stages: string[];
  unit: string;
  height?: number;
}) {
  const [ref, box] = useWidth();
  // A narrow screen scrolls it sideways rather than crush its labels.
  const w = box && Math.max(box, 720);
  const [on, setOn] = useState<{ title: string; n: number; x: number; y: number } | null>(null);
  const graph = useMemo(() => {
    if (!w || !links.length) return null;
    return sankey<FlowNode, FlowLink>()
      .nodeId((d) => d.id)
      .nodeWidth(12)
      .nodePadding(14)
      .nodeAlign(sankeyJustify)
      .nodeSort(null as any)
      .linkSort(null as any)
      .extent([
        [1, 6],
        [w - 1, height - 6],
      ])({ nodes: nodes.map((d) => ({ ...d })), links: links.map((d) => ({ ...d })) });
  }, [nodes, links, w, height]);
  const total = links.filter((l) => !links.some((m) => m.target === l.source)).reduce((s, l) => s + l.value, 0);
  const point = (e: React.PointerEvent<SVGElement>) => {
    const r = (e.currentTarget as SVGElement).ownerSVGElement!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const path = sankeyLinkHorizontal();
  return (
    <div ref={ref} className="flow-scroll">
      <div className="viz flow" style={{ width: w || undefined }}>
        <div className="stages">
          {stages.map((s) => (
            <span key={s}>{s}</span>
          ))}
        </div>
        {graph && (
          <svg width={w} height={height} role="img" aria-label={stages.join(", then ")} onPointerLeave={() => setOn(null)}>
            <g fill="none">
              {graph.links.map((l, i) => {
                const s = l.source as FlowNode & { name: string };
                const t = l.target as FlowNode & { name: string };
                return (
                  <path
                    key={i}
                    className={"band" + (l.strong ? " strong" : "")}
                    d={path(l as any) ?? ""}
                    style={{ stroke: `var(${l.color})`, strokeWidth: Math.max(1, l.width ?? 1) }}
                    onPointerMove={(e) => setOn({ title: `${s.name} → ${t.name}`, n: l.value, ...point(e) })}
                  />
                );
              })}
            </g>
            {graph.nodes.map((d) => (
              <rect
                key={d.id}
                className="node"
                x={d.x0}
                y={d.y0}
                width={(d.x1 ?? 0) - (d.x0 ?? 0)}
                height={Math.max(2, (d.y1 ?? 0) - (d.y0 ?? 0))}
                rx={2}
                style={d.color ? { fill: `var(${d.color})` } : undefined}
                onPointerMove={(e) => setOn({ title: d.name, n: d.value ?? 0, ...point(e) })}
              />
            ))}
            {graph.links.map((l, i) => {
              const t = l.target as FlowNode & { x0: number; x1: number };
              const width = Math.max(1, l.width ?? 1);
              return (
                <rect
                  key={"p" + i}
                  className="node-part"
                  x={t.x0}
                  y={(l.y1 ?? 0) - width / 2}
                  width={t.x1 - t.x0}
                  height={width}
                  style={{ fill: `var(${l.color})` }}
                />
              );
            })}
            {graph.nodes.map((d) => {
              const left = (d.x0 ?? 0) < w / 2;
              return (
                <text
                  key={"t" + d.id}
                  className="flow-label"
                  x={left ? (d.x1 ?? 0) + 8 : (d.x0 ?? 0) - 8}
                  y={((d.y0 ?? 0) + (d.y1 ?? 0)) / 2}
                  dy="0.35em"
                  textAnchor={left ? "start" : "end"}
                >
                  <tspan className="flow-name">{d.name}</tspan>
                  <tspan dx={6}>
                    {num(d.value ?? 0)} · {pct(d.value ?? 0, total)}
                  </tspan>
                </text>
              );
            })}
          </svg>
        )}
        {on && (
          <div className="viz-tip" style={{ left: Math.max(0, Math.min(on.x + 14, w - 220)), top: on.y + 14 }}>
            <div className="tip-title">{on.title}</div>
            <div className="tip-row">
              {unit[0].toUpperCase() + unit.slice(1)} <strong>{num(on.n)}</strong>
            </div>
            <div className="tip-row">
              Of all <strong>{pct(on.n, total)}</strong>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
