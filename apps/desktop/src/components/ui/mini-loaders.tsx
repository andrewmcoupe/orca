/**
 * A small gallery of minimal indeterminate loaders, each designed to fit in
 * extremely tight UI spots (badges, table cells, status rows) where a
 * pulsing dot would normally go. All use only CSS keyframes — no JS ticks.
 *
 * Loaders use `currentColor` (via `bg-current` / `border-current`) so callers
 * can colour them by setting a `text-*` class on the parent.
 *
 * Keyframes (`miniSweep`, `miniEq`, …) live in `src/App.css` so the loaders
 * work anywhere in the app without each consumer needing to inject a <style>.
 */

/** Thin track with a soft gradient highlight that sweeps across. */
export function SweepBar({ className = "" }: { className?: string }) {
  return (
    <span
      className={`relative inline-block h-[2px] w-10 overflow-hidden rounded-full bg-current/10 ${className}`}
    >
      <span
        className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-gradient-to-r from-transparent via-current/80 to-transparent"
        style={{ animation: "miniSweep 1.1s ease-in-out infinite" }}
      />
    </span>
  );
}

/** Tiny equalizer — 4 vertical bars breathing at staggered phases. */
export function EqualizerLoader({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-end gap-[2px] h-3 ${className}`}>
      {[0, 0.12, 0.24, 0.36].map((d, i) => (
        <span
          key={i}
          className="block w-[2px] rounded-sm bg-current/70"
          style={{
            animation: "miniEq 0.9s ease-in-out infinite",
            animationDelay: `${d}s`,
          }}
        />
      ))}
    </span>
  );
}

/** Comet — bright head trailing a fading tail along a thin rail. */
export function CometBar({ className = "" }: { className?: string }) {
  return (
    <span
      className={`relative inline-block h-[2px] w-12 overflow-hidden rounded-full bg-current/8 ${className}`}
    >
      <span
        className="absolute inset-y-0 -left-1/2 w-1/2 rounded-full bg-gradient-to-r from-transparent via-current/30 to-current"
        style={{ animation: "miniComet 1.3s linear infinite" }}
      />
    </span>
  );
}

/** Five-segment progress tracker — segments brighten in sequence. */
export function SegmentedLoader({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex gap-[2px] ${className}`}>
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className="block h-[3px] w-2 rounded-[1px] bg-current/15"
          style={{
            animation: "miniSeg 1.4s ease-in-out infinite",
            animationDelay: `${i * 0.12}s`,
          }}
        />
      ))}
    </span>
  );
}

/** Marching dashes — dashed line whose pattern slides continuously. */
export function MarchingDashes({ className = "" }: { className?: string }) {
  return (
    <span
      className={`relative inline-block h-[2px] w-12 overflow-hidden ${className}`}
      aria-hidden
    >
      <span
        className="absolute inset-0 opacity-70"
        style={{
          backgroundImage:
            "repeating-linear-gradient(90deg, currentColor 0 4px, transparent 4px 8px)",
          animation: "miniMarch 0.6s linear infinite",
        }}
      />
    </span>
  );
}

/** Caret cursor walking along a faint baseline. */
export function CaretWalk({ className = "" }: { className?: string }) {
  return (
    <span className={`relative inline-block h-3 w-12 ${className}`} aria-hidden>
      <span className="absolute inset-x-0 bottom-0 h-px bg-current/15" />
      <span
        className="absolute bottom-0 h-2 w-[1.5px] bg-current"
        style={{ animation: "miniCaret 1.6s steps(12) infinite" }}
      />
    </span>
  );
}

/** Particle stream — tiny dots flowing through a track. */
export function ParticleStream({ className = "" }: { className?: string }) {
  return (
    <span
      className={`relative inline-block h-2 w-12 overflow-hidden ${className}`}
      aria-hidden
    >
      {[0, 0.3, 0.6, 0.9].map((d, i) => (
        <span
          key={i}
          className="absolute top-1/2 -mt-[1px] h-[2px] w-[2px] rounded-full bg-current"
          style={{
            animation: "miniParticle 1.4s linear infinite",
            animationDelay: `${d}s`,
          }}
        />
      ))}
    </span>
  );
}

/** Breathing line — thin bar whose width pulses around its center. */
export function BreathingLine({ className = "" }: { className?: string }) {
  return (
    <span
      className={`relative inline-flex h-[2px] w-12 items-center justify-center ${className}`}
      aria-hidden
    >
      <span className="absolute inset-x-0 h-px bg-current/15 rounded-full" />
      <span
        className="block h-[2px] rounded-full bg-current origin-center"
        style={{ animation: "miniBreath 1.4s ease-in-out infinite" }}
      />
    </span>
  );
}

/** Two opposing sweeps that cross in the middle, then reset. */
export function CrossfadeBar({ className = "" }: { className?: string }) {
  return (
    <span
      className={`relative inline-block h-[2px] w-12 overflow-hidden rounded-full bg-current/10 ${className}`}
    >
      <span
        className="absolute inset-y-0 left-0 w-1/4 rounded-full bg-current"
        style={{ animation: "miniCrossA 1.5s ease-in-out infinite" }}
      />
      <span
        className="absolute inset-y-0 right-0 w-1/4 rounded-full bg-current/60"
        style={{ animation: "miniCrossB 1.5s ease-in-out infinite" }}
      />
    </span>
  );
}

/** Scanner — single bar bouncing back and forth (Knight Rider). */
export function ScannerBar({ className = "" }: { className?: string }) {
  return (
    <span
      className={`relative inline-block h-[2px] w-12 overflow-hidden rounded-full bg-current/10 ${className}`}
    >
      <span
        className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-gradient-to-r from-transparent via-current to-transparent"
        style={{ animation: "miniScan 1.4s ease-in-out infinite alternate" }}
      />
    </span>
  );
}

/** Heartbeat — ECG-style trace drawn left to right. */
export function HeartbeatLine({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 48 12"
      className={`inline-block h-3 w-12 overflow-visible ${className}`}
      aria-hidden
    >
      <path
        d="M0 6 H14 L17 2 L20 10 L23 4 L26 6 H48"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={1}
        style={{
          strokeDasharray: 1,
          animation: "miniBeat 1.4s linear infinite",
        }}
      />
    </svg>
  );
}

/** Morse — dots and dashes appearing in sequence then resetting. */
export function MorseLoader({ className = "" }: { className?: string }) {
  const cells = [{ w: 2 }, { w: 2 }, { w: 6 }, { w: 2 }, { w: 6 }, { w: 2 }];
  return (
    <span className={`inline-flex items-center gap-[2px] ${className}`}>
      {cells.map((c, i) => (
        <span
          key={i}
          className="block h-[2px] rounded-sm bg-current"
          style={{
            width: `${c.w}px`,
            animation: "miniMorse 1.6s ease-in-out infinite",
            animationDelay: `${i * 0.12}s`,
          }}
        />
      ))}
    </span>
  );
}

/** Orbit — small dot circling around a faint ring. */
export function OrbitDot({ className = "" }: { className?: string }) {
  return (
    <span
      className={`relative inline-block h-3 w-3 rounded-full border border-current/15 ${className}`}
      aria-hidden
    >
      <span
        className="absolute inset-0"
        style={{ animation: "miniSpin 1.1s linear infinite" }}
      >
        <span className="absolute -top-[1px] left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-current" />
      </span>
    </span>
  );
}

/** Sine wave — small wave that slides horizontally. */
export function SineWave({ className = "" }: { className?: string }) {
  return (
    <span
      className={`relative inline-block h-3 w-12 overflow-hidden ${className}`}
      aria-hidden
    >
      <svg
        viewBox="0 0 96 12"
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-[200%]"
        style={{ animation: "miniWaveShift 1.4s linear infinite" }}
      >
        <path
          d="M0 6 Q6 1 12 6 T24 6 T36 6 T48 6 T60 6 T72 6 T84 6 T96 6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

/** Typewriter — three dots cascade in then collapse out. */
export function TypewriterDots({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-[3px] ${className}`}>
      {[0, 0.16, 0.32].map((d, i) => (
        <span
          key={i}
          className="block h-1 w-1 rounded-full bg-current"
          style={{
            animation: "miniType 1.2s ease-in-out infinite",
            animationDelay: `${d}s`,
          }}
        />
      ))}
    </span>
  );
}

/** Pixel rain — tiny squares blink at random-feeling phases. */
export function PixelRain({ className = "" }: { className?: string }) {
  const phases = [0, 0.4, 0.15, 0.7, 0.25, 0.55, 0.05, 0.85];
  return (
    <span className={`inline-flex items-center gap-[1px] ${className}`}>
      {phases.map((d, i) => (
        <span
          key={i}
          className="block h-[3px] w-[3px] bg-current"
          style={{
            animation: "miniPixel 1.1s ease-in-out infinite",
            animationDelay: `${d}s`,
          }}
        />
      ))}
    </span>
  );
}

/** Slash — a short diagonal stroke spinning in a 12px slot. */
export function SlashSpinner({ className = "" }: { className?: string }) {
  return (
    <span className={`relative inline-block h-3 w-3 ${className}`} aria-hidden>
      <span
        className="absolute left-1/2 top-1/2 h-[1.5px] w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current"
        style={{ animation: "miniSpin 0.9s linear infinite" }}
      />
    </span>
  );
}

/** Bookends — two bars converge to the center then bounce out. */
export function BookendCollapse({ className = "" }: { className?: string }) {
  return (
    <span
      className={`relative inline-block h-[2px] w-12 overflow-hidden rounded-full bg-current/10 ${className}`}
    >
      <span
        className="absolute inset-y-0 left-0 w-2 rounded-full bg-current"
        style={{ animation: "miniBookA 1.4s ease-in-out infinite" }}
      />
      <span
        className="absolute inset-y-0 right-0 w-2 rounded-full bg-current"
        style={{ animation: "miniBookB 1.4s ease-in-out infinite" }}
      />
    </span>
  );
}

/** Glyph ticker — tiny rolling characters, mono digits. */
export function GlyphTicker({ className = "" }: { className?: string }) {
  const cols = ["0123456789", "ABCDEF0123", "9876543210"];
  return (
    <span
      className={`relative inline-flex h-3 items-center overflow-hidden font-mono text-[10px] leading-none tracking-tighter text-current ${className}`}
      style={{ width: "1.65rem" }}
      aria-hidden
    >
      {cols.map((set, i) => (
        <span key={i} className="relative h-3 w-[0.55rem] overflow-hidden">
          <span
            className="absolute inset-x-0 top-0 flex flex-col items-center"
            style={{
              animation: `miniTick 0.8s steps(${set.length}) infinite`,
              animationDelay: `${i * 0.1}s`,
            }}
          >
            {[...set, ...set].map((ch, j) => (
              <span key={j} className="block h-3 leading-3">
                {ch}
              </span>
            ))}
          </span>
        </span>
      ))}
    </span>
  );
}

// Keyframes for these loaders live in src/App.css.
