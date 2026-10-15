import type { CSSProperties } from "react";
import { laneLabelColor } from "./palette";
import { describePill, type CommitLabels, type RefPill } from "./refLabels";

interface RefLabelContentProps {
  labels: CommitLabels;
  lane: number;
  /** The brighter color: the commit HEAD points at, or a hovered label. */
  active: boolean;
}

/**
 * A commit's first ref as a pill in its lane color (spec §1 Ref labels), and a
 * `+N` badge for its other refs. The pill's name is cut off with `…` when it
 * does not fit; hovering shows the full names.
 */
export function RefLabelContent({ labels, lane, active }: RefLabelContentProps) {
  const [pill, ...rest] = labels.pills;
  if (!pill) return null;
  const style = { "--label-bg": laneLabelColor(lane, active) } as CSSProperties;
  const others = rest.flatMap((p) => p.names);
  return (
    <>
      <span className="ref-pill" style={style} title={pill.names.join("\n")}>
        {pill.checkedOut && <CheckIcon />}
        {/* Screen readers get the full names from the hidden text instead. */}
        <span className="ref-name" aria-hidden="true">
          {pill.label}
        </span>
        {pill.local && <LaptopIcon />}
        {pill.remote && <CloudIcon />}
        {pill.tag && <TagIcon />}
        <span className="visually-hidden">{spokenPill(pill)}</span>
      </span>
      {rest.length > 0 && (
        <span className="ref-more" style={style} title={others.join("\n")}>
          <span aria-hidden="true">+{rest.length}</span>
          <span className="visually-hidden">
            , {rest.length} more: {rest.map(spokenPill).join("; ")}
          </span>
        </span>
      )}
    </>
  );
}

function spokenPill(pill: RefPill): string {
  return `${pill.names.join(" and ")}, ${describePill(pill)}${pill.checkedOut ? ", checked out" : ""}`;
}

function CheckIcon() {
  return (
    <svg className="ref-icon" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 8.5l3.2 3.2L13 4.8" fill="none" stroke="currentColor" strokeWidth="2.2" />
    </svg>
  );
}

function LaptopIcon() {
  return (
    <svg
      className="ref-icon"
      data-icon="local"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path
        d="M3.5 3.5h9v7h-9zM1.5 12.5h13"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloudIcon() {
  return (
    <svg
      className="ref-icon"
      data-icon="remote"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path
        d="M4.6 12.5h7.2a2.7 2.7 0 00.3-5.4A4.1 4.1 0 004.3 6.6a3 3 0 00.3 5.9z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TagIcon() {
  return (
    <svg
      className="ref-icon"
      data-icon="tag"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path
        d="M2.5 2.5h5.2l5.8 5.8-5.2 5.2-5.8-5.8z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="5.4" cy="5.4" r="1" fill="currentColor" />
    </svg>
  );
}
