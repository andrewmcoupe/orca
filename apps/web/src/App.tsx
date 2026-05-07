export function App() {
  return (
    <main className="page">
      <header className="hero">
        <h1>Orca</h1>
        <p className="tagline">Your local-first task companion.</p>
        <div className="actions">
          <a className="button primary" href="https://github.com/andrewmcoupe/orca/releases/latest">
            Download
          </a>
          <a className="button" href="https://github.com/andrewmcoupe/orca">
            View on GitHub
          </a>
        </div>
      </header>

      <section className="features">
        <article>
          <h2>Local-first</h2>
          <p>Your data stays on your machine. No accounts, no cloud lock-in.</p>
        </article>
        <article>
          <h2>Fast</h2>
          <p>Built with Tauri and React for a native, snappy desktop experience.</p>
        </article>
        <article>
          <h2>Open source</h2>
          <p>MIT-licensed. Contributions and feedback welcome.</p>
        </article>
      </section>

      <footer className="footer">
        <p>© {new Date().getFullYear()} Orca</p>
      </footer>
    </main>
  );
}
