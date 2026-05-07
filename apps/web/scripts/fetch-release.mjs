import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "andrewmcoupe/orca";
const OUTPUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src/generated/release.json",
);

const FALLBACK = {
  version: null,
  aarch64: `https://github.com/${REPO}/releases/latest`,
  x64: `https://github.com/${REPO}/releases/latest`,
  releasesUrl: `https://github.com/${REPO}/releases/latest`,
};

async function main() {
  let payload = FALLBACK;

  try {
    const headers = { "User-Agent": "orca-landing-build" };
    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    const res = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      { headers },
    );

    if (!res.ok) {
      throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    const findAsset = (suffix) =>
      data.assets?.find((a) => a.name.endsWith(suffix))?.browser_download_url;

    payload = {
      version: data.tag_name ?? null,
      aarch64: findAsset("_aarch64.dmg") ?? FALLBACK.aarch64,
      x64: findAsset("_x64.dmg") ?? FALLBACK.x64,
      releasesUrl: data.html_url ?? FALLBACK.releasesUrl,
    };
  } catch (err) {
    console.warn(
      `[fetch-release] failed, using fallback: ${err.message ?? err}`,
    );
  }

  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, JSON.stringify(payload, null, 2) + "\n");
  console.log(`[fetch-release] wrote ${OUTPUT}`);
}

main();
