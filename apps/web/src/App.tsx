import release from "./generated/release.json";

const features = [
  {
    title: "Briefings",
    body: "Turn rough intent into a structured briefing and plan.",
  },
  {
    title: "Plans",
    body: "Group related work, track dependencies, status, and lifecycle decisions.",
  },
  {
    title: "Tasks",
    body: "Run task-specific implementation flows with relevant files and dependency awareness.",
  },
  {
    title: "Phase runs",
    body: "Execute provider-backed phases for test authoring, implementation, and audit.",
  },
  {
    title: "Providers",
    body: "Integrations for CLI-based coding providers, including Codex and Claude.",
  },
  {
    title: "Review",
    body: "Inspect phase output, diffs, auditor verdicts, and merge readiness.",
  },
];

export function App() {
  return (
    <main className="page">
      <section className="hero">
        <img src="/orca-logo.png" alt="Orca" className="logo" />
        <p className="tagline">A local-first task companion.</p>
        <div className="actions">
          <a className="button primary" href={release.aarch64}>
            Download for macOS
          </a>
          <a
            className="button secondary"
            href="https://github.com/andrewmcoupe/orca"
          >
            GitHub
          </a>
        </div>
        {release.x64 && (
          <a className="intel-link" href={release.x64}>
            Intel Mac?
          </a>
        )}
      </section>

      <section className="features" aria-label="Features">
        <ul className="feature-grid">
          {features.map((feature) => (
            <li key={feature.title} className="feature">
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
