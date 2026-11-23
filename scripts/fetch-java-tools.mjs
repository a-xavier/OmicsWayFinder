// Download pinned upstream Java releases into public/java/<tool>/<version>/.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync, zipSync } from "fflate";

const OUT = path.resolve(import.meta.dirname, "../public/java");
const releases = [
  {
    url: "https://faculty.washington.edu/browning/beagle/beagle.27Feb25.75f.jar",
    sha256: "7319f4af9638be05c18dcc1bfb8fb41a58a09293507ebf0d54617d0e40df5a70",
    file: "beagle/5.5-27Feb25.75f/beagle.jar",
  },
  {
    url: "https://faculty.washington.edu/browning/beagle/beagle.250227.zip",
    sha256: "12521996021dbd79f8140e8adbb91c3f73bec51fd795a6594525bbe9fd486d23",
    file: "beagle/5.5-27Feb25.75f/source.zip",
    entries: { "src/gpl_license": "beagle/5.5-27Feb25.75f/LICENSE" },
  },
  {
    url: "https://snpeff-public.s3.amazonaws.com/versions/snpEff_v5_4c_core.zip",
    sha256: "3b06a1e1f939e7ebd5433387f088c1d3d1e0a7d472d63f39161b1fe9f00adf33",
    entries: {
      "snpEff/snpEff.jar": "snpeff/5.4c/snpeff.jar",
      "snpEff/SnpSift.jar": "snpsift/5.4c/snpsift.jar",
      "snpEff/LICENSE.md": ["snpeff/5.4c/LICENSE.md", "snpsift/5.4c/LICENSE.md"],
    },
  },
  {
    url: "https://github.com/usadellab/Trimmomatic/releases/download/v0.40/Trimmomatic-0.40.zip",
    sha256: "d2194fd1b22a9660e577d0a4d291356543b1ee79df8f39db1b842c7306cb1db6",
    entries: {
      "trimmomatic-0.40.jar": "trimmomatic/0.40/trimmomatic.jar",
      "LICENSE": "trimmomatic/0.40/LICENSE",
    },
  },
  {
    url: "https://github.com/usadellab/Trimmomatic/archive/refs/tags/v0.40.zip",
    sha256: "8952d7b2e7300d6cb8077dd143540de422dfebb86b5c9ffb1c6332abe223f84a",
    source: "trimmomatic/0.40/source.zip",
  },
  {
    url: "https://github.com/pedrofmb/jbzip2/archive/cc31ed7d40ddd65709e076e10e2d7bd1ba7cc6ae.zip",
    sha256: "6e21f4d4af90c1bae9980ba9e3f946804fcc162113cc365afe6ad9f2ff0cbcfe",
    file: "trimmomatic/0.40/jbzip2-source.zip",
    entries: {
      "jbzip2-cc31ed7d40ddd65709e076e10e2d7bd1ba7cc6ae/LICENCE": "trimmomatic/0.40/jbzip2-LICENSE",
    },
  },
];

export async function fetchJavaTools(out = OUT, fetchFile = fetch) {
  for (const release of releases) {
    const response = await fetchFile(release.url);
    if (!response.ok) throw new Error(`${release.url}: HTTP ${response.status}`);
    const data = new Uint8Array(await response.arrayBuffer());
    const hash = createHash("sha256").update(data).digest("hex");
    if (hash !== release.sha256) throw new Error(`Checksum mismatch for ${release.url}: ${hash}`);
    const files = [];
    if (release.file) files.push([release.file, data]);
    if (release.source) {
      const prefix = "Trimmomatic-0.40/";
      const entries = unzipSync(data, {
        filter: entry => entry.name.startsWith(`${prefix}src/`) ||
          [`${prefix}LICENSE`, `${prefix}pom.xml`, `${prefix}MANIFEST.MF`, `${prefix}resources/version.properties`].includes(entry.name),
      });
      if (!entries[`${prefix}src/main/java/org/usadellab/trimmomatic/Trimmomatic.java`]) {
        throw new Error(`${release.url}: missing Trimmomatic source`);
      }
      files.push([release.source, zipSync(entries)]);
    }
    if (release.entries) {
      const entries = unzipSync(data, { filter: entry => Object.hasOwn(release.entries, entry.name) });
      for (const [source, destinations] of Object.entries(release.entries)) {
        if (!entries[source]) throw new Error(`${release.url}: missing ${source}`);
        for (const destination of [destinations].flat()) files.push([destination, entries[source]]);
      }
    }
    for (const [name, bytes] of files) {
      const target = path.join(out, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
      console.log(`${name} (${bytes.length} bytes)`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await fetchJavaTools();
}
