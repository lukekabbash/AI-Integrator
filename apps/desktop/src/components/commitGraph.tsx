import { Tooltip } from "./Tooltip";
import {
  COMMIT_GRAPH_MAX_LANES,
  type CommitGraphEdge,
  type CommitGraphRow,
} from "./commitGraphModel";

const GRAPH_LANE_WIDTH = 9;
const GRAPH_ROW_HEIGHT = 35;

/** Keep the widest current-commit ring inside the SVG view box. */
const GRAPH_EDGE_PAD = 2.5;

const GRAPH_LANE_COLORS = [
  "var(--color-accent)",
  "#d0679d",
  "#5aa7e0",
  "#c9a227",
  "#9a7ecc",
  "#5fb08a",
];

function graphLaneX(lane: number): number {
  return GRAPH_EDGE_PAD + 4.5 + lane * GRAPH_LANE_WIDTH;
}

function graphEdgePath(edge: CommitGraphEdge, half: "top" | "bottom"): string {
  const from = graphLaneX(edge.from);
  const to = graphLaneX(edge.to);
  const mid = GRAPH_ROW_HEIGHT / 2;
  if (half === "top") {
    if (!edge.node || edge.from === edge.to) return `M ${from} 0 L ${from} ${mid}`;
    return `M ${from} 0 C ${from} ${mid - 4}, ${to} ${mid - 12}, ${to} ${mid}`;
  }
  if (!edge.node || edge.from === edge.to) return `M ${from} ${mid} L ${from} ${GRAPH_ROW_HEIGHT}`;
  return `M ${from} ${mid} C ${to} ${mid + 12}, ${to} ${mid + 4}, ${to} ${GRAPH_ROW_HEIGHT}`;
}

export function CommitGraphCell({
  row,
  current,
  unpushed,
  merge,
  tooltip,
}: {
  row: CommitGraphRow;
  current: boolean;
  unpushed: boolean;
  merge: boolean;
  tooltip: string;
}) {
  const width = row.laneCount * GRAPH_LANE_WIDTH + GRAPH_EDGE_PAD * 2;
  const laneColor = GRAPH_LANE_COLORS[row.lane % GRAPH_LANE_COLORS.length];
  const edges = [
    ...row.incoming.map((edge) => ({ edge, half: "top" as const })),
    ...row.outgoing.map((edge) => ({ edge, half: "bottom" as const })),
  ].filter(({ edge }) => edge.from < COMMIT_GRAPH_MAX_LANES && edge.to < COMMIT_GRAPH_MAX_LANES);
  return (
    <Tooltip label={tooltip} placement="right">
      <svg
        className="commit-graph-cell"
        width={width}
        height={GRAPH_ROW_HEIGHT}
        viewBox={`0 0 ${width} ${GRAPH_ROW_HEIGHT}`}
        role="img"
        aria-label={tooltip}
      >
        {edges.map(({ edge, half }, index) => (
          <path
            key={`${half}-${index}`}
            d={graphEdgePath(edge, half)}
            fill="none"
            stroke={GRAPH_LANE_COLORS[Math.max(edge.from, edge.to) % GRAPH_LANE_COLORS.length]}
            strokeWidth="1.5"
          />
        ))}
        {current ? (
          <circle
            cx={graphLaneX(row.lane)}
            cy={GRAPH_ROW_HEIGHT / 2}
            r={5.6}
            fill="none"
            stroke={laneColor}
            strokeWidth="1"
            opacity="0.45"
          />
        ) : null}
        <circle
          className="commit-graph-node"
          cx={graphLaneX(row.lane)}
          cy={GRAPH_ROW_HEIGHT / 2}
          r={3.4}
          fill={unpushed ? "var(--color-rail)" : laneColor}
          stroke={laneColor}
          strokeWidth="1.6"
        />
        {merge ? (
          <circle
            cx={graphLaneX(row.lane)}
            cy={GRAPH_ROW_HEIGHT / 2}
            r={1.3}
            fill={unpushed ? laneColor : "var(--color-rail)"}
          />
        ) : null}
      </svg>
    </Tooltip>
  );
}
