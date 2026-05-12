import { Link, Outlet, createRoute } from "@tanstack/react-router";
import type { ComponentType, ReactNode } from "react";
import {
  ArrowLeft,
  BracketsCurly,
  ChatCircleText,
  GearSix,
  GitBranch,
  Lightning,
  Plugs,
  SlidersHorizontal,
} from "@phosphor-icons/react";
import { PhaseConfigPanel } from "@/features/workspaces/components/phase-config-panel";
import { DefaultPhaseSettingsPanel } from "@/features/workspaces/components/default-phase-settings-panel";
import { BriefingPersonaSettingsPanel } from "@/features/workspaces/components/briefing-persona-settings-panel";
import { rootRoute } from "./root";

const appScope = { type: "app" as const };

function SettingsLayout() {
  return (
    <SettingsFrame
      title="Settings"
      navItems={[
        { id: "general", label: "General", icon: GearSix, to: "/settings" },
        {
          id: "briefing",
          label: "Briefing",
          icon: ChatCircleText,
          to: "/settings/briefing",
        },
        {
          id: "providers",
          label: "AI Providers",
          icon: Plugs,
          to: "/settings/providers",
        },
      ]}
    />
  );
}

function GeneralSettingsPage() {
  return (
    <SettingsRouteContent
      title="General"
      description="User-level defaults for how Orca plans and runs task work."
    >
      <SettingsSection
        id="general"
        title="General"
        description="Global workflow preferences. Workspaces can override these when a repository needs different defaults."
      >
        <div className="space-y-5">
          <SettingBlock
            title="Default workflow"
            description="Choose the phases that new tasks inherit by default."
          >
            <PhaseConfigPanel scope={appScope} />
          </SettingBlock>
          <SettingBlock
            title="Default models and permissions"
            description="Provider, model, and trust defaults for each phase."
          >
            <DefaultPhaseSettingsPanel scope={appScope} />
          </SettingBlock>
        </div>
      </SettingsSection>
    </SettingsRouteContent>
  );
}

function BriefingSettingsPage() {
  return (
    <SettingsRouteContent
      title="Briefing"
      description="User-level defaults for the specialist reviewers used by the briefing workbench."
    >
      <SettingsSection
        id="briefing"
        title="Briefing"
        description="These preferences apply across workspaces unless a workspace sets its own briefing defaults."
      >
        <SettingBlock
          title="Briefing personas"
          description="Provider and model defaults for specialist reviewers."
        >
          <BriefingPersonaSettingsPanel scope={appScope} />
        </SettingBlock>
      </SettingsSection>
    </SettingsRouteContent>
  );
}

export function SettingsFrame({
  title,
  subtitle,
  navItems,
  showBackLink = true,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  navItems?: SettingsNavItem[];
  showBackLink?: boolean;
  children?: ReactNode;
}) {
  const fallbackNav: SettingsNavItem[] = [
    { id: "general", label: "General", icon: GearSix },
    { id: "configuration", label: "Configuration", icon: BracketsCurly },
    { id: "workflow", label: "Workflow", icon: GitBranch },
    { id: "reliability", label: "Reliability", icon: Lightning },
    { id: "advanced", label: "Advanced", icon: SlidersHorizontal },
  ];
  const nav = navItems ?? fallbackNav;

  return (
    <div className="flex h-full min-h-0 bg-background">
      <aside className="hidden w-[220px] shrink-0 border-r bg-sidebar text-sidebar-foreground md:flex md:flex-col">
        <div className="flex h-11 items-center border-b p-2">
          {showBackLink ? (
            <Link
              to="/"
              className="flex h-7 items-center gap-2 rounded-sm px-2 text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
            >
              <ArrowLeft className="size-4" />
              <span>Back to app</span>
            </Link>
          ) : (
            <span className="px-2 font-mono text-xs font-thin lowercase text-muted-foreground">
              Settings
            </span>
          )}
        </div>
        <nav className="space-y-1 p-2">
          {nav.map((item) => {
            const Icon = item.icon;
            const baseClass =
              "flex h-[28px] w-full items-center gap-2 rounded-sm px-2 text-left text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground [&.active]:bg-sidebar-accent [&.active]:text-foreground [&.active]:font-medium";
            return item.to ? (
              <Link
                key={item.id}
                to={item.to}
                activeOptions={{ exact: item.to === "/settings" }}
                className={baseClass}
              >
                <Icon className="size-4" />
                <span className="truncate">{item.label}</span>
              </Link>
            ) : (
              <button
                key={item.id}
                type="button"
                onClick={() =>
                  document.getElementById(item.id)?.scrollIntoView({
                    block: "start",
                    behavior: "smooth",
                  })
                }
                className={baseClass}
              >
                <Icon className="size-4" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>
      <main className="scrollbar-styled min-w-0 flex-1 overflow-auto px-5 py-10 md:px-12">
        <div className="mx-auto w-full max-w-[980px] space-y-12">
          {children ? (
            <>
              <header className="space-y-2">
                <h1 className="text-[26px] font-semibold tracking-tight">
                  {title}
                </h1>
                {subtitle ? (
                  <div className="text-muted-foreground text-sm leading-relaxed">
                    {subtitle}
                  </div>
                ) : null}
              </header>
              {children}
            </>
          ) : (
            <Outlet />
          )}
        </div>
      </main>
    </div>
  );
}

type SettingsNavItem = {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  to?: "/settings" | "/settings/briefing" | "/settings/providers";
};

function SettingsRouteContent({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <>
      <header className="space-y-2">
        <h1 className="text-[26px] font-semibold tracking-tight">{title}</h1>
        <p className="text-muted-foreground text-sm leading-relaxed">
          {description}
        </p>
      </header>
      {children}
    </>
  );
}

export function SettingsSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-8 space-y-5">
      <div>
        <h2 className="text-[20px] font-semibold tracking-tight">{title}</h2>
        <p className="text-muted-foreground mt-1 text-sm">{description}</p>
      </div>
      {children}
    </section>
  );
}

export function SettingBlock({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-md border bg-card">
      <div className="border-b px-4 py-3">
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-muted-foreground mt-1 text-xs">{description}</p>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

export const globalSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsLayout,
});

export const globalSettingsIndexRoute = createRoute({
  getParentRoute: () => globalSettingsRoute,
  path: "/",
  component: GeneralSettingsPage,
});

export const globalSettingsBriefingRoute = createRoute({
  getParentRoute: () => globalSettingsRoute,
  path: "/briefing",
  component: BriefingSettingsPage,
});
