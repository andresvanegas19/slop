"use client";

import { useId } from "react";
import styles from "./BlobLoader.module.css";

type BlobLoaderProps = {
  label?: string;
  size?: number;
  detail?: string;
};

// Geometry in a 200x200 viewBox.
const TRACK_R = 60;
const TRACK_C = 2 * Math.PI * TRACK_R;
const ARC_LEN = TRACK_C * 0.23;

// Slightly irregular organic outlines that rotate/breathe behind the ring.
const OUTLINE_A =
  "M100 9 C141 7 176 32 186 70 C196 110 181 158 142 180 C104 200 56 192 30 160 C5 129 6 80 28 49 C46 23 70 10 100 9 Z";
const OUTLINE_B =
  "M104 12 C146 14 184 44 188 86 C192 130 170 170 128 186 C88 199 46 184 24 150 C4 118 12 70 38 42 C58 22 80 11 104 12 Z";

export default function BlobLoader({ label = "Loading...", size = 280, detail }: BlobLoaderProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const arcGrad = `bl-arc-${uid}`;
  const coreGrad = `bl-core-${uid}`;
  const glow = `bl-glow-${uid}`;
  const compact = size < 120;

  return (
    <div
      className={`${styles.root} ${compact ? styles.compact : ""}`}
      role="status"
      aria-live="polite"
      style={{ maxWidth: "100%", width: Math.max(size, compact ? 160 : 240) }}
    >
      <svg
        className={styles.graphic}
        style={{ width: size }}
        viewBox="0 0 200 200"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <linearGradient id={arcGrad} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#5cbf8a" />
            <stop offset="100%" stopColor="#4fb38a" />
          </linearGradient>
          <linearGradient id={coreGrad} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#7ccf7a" />
            <stop offset="100%" stopColor="#4fb08f" />
          </linearGradient>
          <filter id={glow} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="7" />
          </filter>
        </defs>

        <g className={styles.outlineA}>
          <path d={OUTLINE_A} className={styles.outline} fill="none" stroke="rgba(170,230,195,0.17)" strokeWidth="1" />
        </g>
        <g className={styles.outlineB}>
          <path d={OUTLINE_B} className={styles.outline} fill="none" stroke="rgba(170,230,195,0.17)" strokeWidth="1" />
        </g>

        <circle className={styles.track} cx="100" cy="100" r={TRACK_R} fill="none" stroke="rgba(110,200,150,0.15)" strokeWidth="7" />
        <g className={styles.spinner}>
          {/* SMIL fallback spin; the CSS animation overrides it whenever the stylesheet is loaded. */}
          <animateTransform attributeName="transform" type="rotate" from="0 100 100" to="360 100 100" dur="1.3s" repeatCount="indefinite" />
          <circle
            className={styles.arc}
            cx="100"
            cy="100"
            r={TRACK_R}
            fill="none"
            strokeWidth="7"
            strokeLinecap="round"
            stroke={`url(#${arcGrad})`}
            strokeDasharray={`${ARC_LEN} ${TRACK_C}`}
            transform="rotate(-90 100 100)"
          />
        </g>

        <circle cx="100" cy="104" r="36" fill="#5cbf8a" opacity="0.35" filter={`url(#${glow})`} />
        <circle className={styles.core} cx="100" cy="100" r="38" fill={`url(#${coreGrad})`} />

        <g className={styles.bars} fill="#fff">
          <rect className={styles.bar1} x="84" y="104" width="8" height="10" rx="3" />
          <rect className={styles.bar2} x="96" y="96" width="8" height="18" rx="3" />
          <rect className={styles.bar3} x="108" y="87" width="8" height="27" rx="3" />
        </g>
      </svg>

      <div className={styles.text}>
        <p className={styles.title} style={{ margin: 0, color: "#f2f4f2", fontWeight: 700 }}>{label}</p>
        {detail ? <p className={styles.detail} style={{ margin: 0, color: "#8e948f" }}>{detail}</p> : null}
      </div>
    </div>
  );
}
