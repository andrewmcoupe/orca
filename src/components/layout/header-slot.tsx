import {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/**
 * Slot for rendering page-specific actions inside the workspace header bar
 * (next to the breadcrumb). Detail views use this to surface their action
 * toolbar in the always-visible top chrome rather than duplicating chrome
 * inside each route's own scroll container.
 *
 * The provider owns a single DOM node; consumers portal into it. The node is
 * created by `<HeaderSlotTarget />` which is rendered by the workspace layout
 * at the desired position. When no consumer is mounted the target stays
 * empty — the slot has zero visual footprint.
 */
const HeaderSlotContext = createContext<HTMLElement | null>(null);

type ProviderInternals = {
  setEl: (el: HTMLElement | null) => void;
};
const HeaderSlotInternalsContext = createContext<ProviderInternals | null>(
  null,
);

export function HeaderSlotProvider({ children }: { children: ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  return (
    <HeaderSlotInternalsContext.Provider value={{ setEl }}>
      <HeaderSlotContext.Provider value={el}>
        {children}
      </HeaderSlotContext.Provider>
    </HeaderSlotInternalsContext.Provider>
  );
}

/** Marker rendered by the layout where slot content should appear. */
export function HeaderSlotTarget({ className }: { className?: string }) {
  const internals = useContext(HeaderSlotInternalsContext);
  if (!internals) return null;
  return <div ref={internals.setEl} className={className} />;
}

/** Render `children` into the workspace header's action slot. Returns null
 * when the slot isn't mounted (i.e. outside the workspace layout). */
export function HeaderSlot({ children }: { children: ReactNode }) {
  const el = useContext(HeaderSlotContext);
  if (!el) return null;
  return createPortal(children, el);
}
