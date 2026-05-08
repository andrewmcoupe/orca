import release from "./generated/release.json";

const screenshots = [
  { src: "/homescreen.png", label: "Workspace" },
  { src: "/brief.png", label: "Brief" },
  { src: "/plan-detail.png", label: "Plan" },
  { src: "/task-detail.png", label: "Tasks" },
  { src: "/review.png", label: "Review" },
  { src: "/pass-back.png", label: "Observe" },
];

function Logo() {
  return (
    <svg
      className="h-9 w-9"
      viewBox="0 0 104 104"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <circle cx="52" cy="52" r="52" fill="#252525" />
      <ellipse
        className="orca-logo-blink"
        cx="60.3645"
        cy="46.8248"
        rx="20.1116"
        ry="9.27013"
        transform="rotate(-10.2353 60.3645 46.8248)"
        fill="#D9D9D9"
      />
    </svg>
  );
}

export function App() {
  return (
    <main className="min-h-dvh bg-[#080808]">
      <section className="mx-auto grid min-h-dvh max-w-[1440px] border-x border-white/15 lg:grid-cols-2">
        <div className="flex min-h-[52dvh] flex-col justify-between border-b border-white/15 p-5 lg:min-h-dvh lg:border-r lg:border-b-0">
          <header className="flex items-center justify-between border-b border-white/15 pb-4 font-mono text-xs uppercase tracking-[0.12em] text-white/55">
            <span className="flex items-center gap-3">
              <Logo />
              <span>Orca</span>
            </span>
            <span>Local-first</span>
          </header>

          <div className="max-w-2xl py-16 lg:py-24">
            <p className="mb-5 font-mono text-[0.6rem] uppercase tracking-[0.16em]">
              Brief. Plan. Tasks. Audit. Review. Observe.
            </p>
            <h1 className="text-4xl leading-[0.9] font-semibold tracking-normal text-balance sm:text-5xl font-body">
              Orca keeps agent work simple.
            </h1>
            <p className="mt-7 max-w-xl font-serif text-neutral-400">
              A focused desktop app for turning intent into traceable work: from
              brief to plan, from task to audit, from review to merge.
            </p>
          </div>

          <div className="flex flex-col gap-3 border-t border-white/15 pt-5 sm:flex-row">
            <a
              className="inline-flex min-h-12 items-center justify-center border border-white bg-white px-5 font-mono text-sm font-medium text-black transition hover:bg-transparent hover:text-white"
              href={release.aarch64}
            >
              Download for macOS
            </a>
            <a
              className="inline-flex min-h-12 items-center justify-center border border-white/25 px-5 font-mono text-sm font-medium text-white transition hover:border-white hover:bg-white hover:text-black"
              href="https://github.com/andrewmcoupe/orca"
            >
              View GitHub
            </a>
            {release.x64 && (
              <a
                className="inline-flex min-h-12 items-center justify-center font-mono text-xs text-white/55 underline underline-offset-4 transition hover:text-white sm:px-3"
                href={release.x64}
              >
                Intel Mac
              </a>
            )}
          </div>
        </div>

        <div className="flex min-h-[48dvh] items-center overflow-hidden p-5 sm:p-8 lg:min-h-dvh xl:p-10">
          <div className="grid w-full grid-cols-2 border border-white/20 bg-[#101010] shadow-2xl shadow-black/60">
            {screenshots.map((screenshot, index) => (
              <article
                className={[
                  "group min-w-0 border-white/15",
                  index % 2 === 0 ? "border-r" : "",
                  index < screenshots.length - 2 ? "border-b" : "",
                ].join(" ")}
                key={screenshot.src}
              >
                <div className="flex h-8 items-center justify-between border-b border-white/15 px-3 font-mono text-[10px] uppercase tracking-[0.14em] text-white/35">
                  <span>{screenshot.label}</span>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                </div>
                <div className="overflow-hidden bg-black">
                  <img
                    className="aspect-[16/10] w-full object-cover object-left-top opacity-80 grayscale transition duration-500 group-hover:opacity-100 group-hover:grayscale-0"
                    src={screenshot.src}
                    alt={`${screenshot.label} screen in Orca`}
                  />
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
