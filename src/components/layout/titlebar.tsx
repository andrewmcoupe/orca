import type { CSSProperties, ReactNode } from "react";

// macOS traffic lights live in the top-left ~70px. Reserve that space so our
// own controls don't sit underneath them.
const MACOS_TRAFFIC_LIGHT_INSET = 78;

// `WebkitAppRegion` isn't in React's CSS type definitions, so we cast.
const dragStyle = { WebkitAppRegion: "drag" } as CSSProperties;
const noDragStyle = { WebkitAppRegion: "no-drag" } as CSSProperties;

export function TitleBar({ children }: { children?: ReactNode }) {
  return (
    <div
      data-tauri-drag-region
      className="bg-background flex h-9 flex-shrink-0 items-center border-b"
      style={{ ...dragStyle, paddingLeft: MACOS_TRAFFIC_LIGHT_INSET }}
    >
      <div
        data-tauri-drag-region
        className="flex flex-1 items-center gap-2 px-2"
        style={dragStyle}
      >
        {children}
      </div>
    </div>
  );
}

// Wrap interactive content with this so it doesn't trigger window drag.
export function TitleBarItem({ children }: { children: ReactNode }) {
  return <div style={noDragStyle}>{children}</div>;
}
