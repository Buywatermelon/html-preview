import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { MAX_BYTES } from "../src/common";
import { extractZip } from "../src/zip";
const html="<h1>preview</h1>";
function zip(files:Record<string,string>,level:0|6=6){return zipSync(Object.fromEntries(Object.entries(files).map(([name,value])=>[name,strToU8(value)])),{level});}
describe("ZIP validation", () => {
  it.each(["../evil.html", "/absolute.html", "a/../../evil", "a\\evil", "a/%2e%2e/evil"])(
    "rejects unsafe archive path %s before writing anything", async path => {
      await expect(extractZip(zip({ "index.html": html, [path]: "bad" }))).rejects.toMatchObject({status:400});
    },
  );

  it("rejects archives without an entry point, truncated ZIPs, and bad checksums", async () => {
    await expect(extractZip(zip({ "file.txt": "hi" }))).rejects.toMatchObject({ status: 400 });
    await expect(extractZip(new Uint8Array([80, 75]))).rejects.toMatchObject({ status: 400 });
    const broken = zip({ "index.html": html }, 0);
    broken[30 + "index.html".length] ^= 1;
    await expect(extractZip(broken)).rejects.toMatchObject({ status: 400 });
  });

  it("rejects symlinks and encrypted entries", async () => {
    for (const kind of ["symlink", "encrypted"]) {
      const archive = zip({ "index.html": html }, 0);
      const view = new DataView(archive.buffer);
      let central = 0;
      while (view.getUint32(central, true) !== 0x02014b50) central++;
      if (kind === "symlink") view.setUint32(central + 38, 0xa1ff0000, true);
      else view.setUint16(central + 8, 1, true);
      await expect(extractZip(archive)).rejects.toMatchObject({ status: 400 });
    }
  });

  it("rejects more than 500 files and an oversized declared expansion", async () => {
    const files = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [i ? `f${i}.txt` : "index.html", "x"]));
    await expect(extractZip(zip(files))).rejects.toMatchObject({ status: 413 });
    const archive = zip({ "index.html": html }, 0);
    const view = new DataView(archive.buffer);
    let central = 0;
    while (view.getUint32(central, true) !== 0x02014b50) central++;
    view.setUint32(central + 24, MAX_BYTES + 1, true);
    await expect(extractZip(archive)).rejects.toMatchObject({ status: 413 });
  });

  it("bounds actual inflate output when an archive lies about expanded size", async () => {
    const archive = zip({ "index.html": "a".repeat(1024 * 1024) });
    const view = new DataView(archive.buffer);
    let central = 0;
    while (view.getUint32(central, true) !== 0x02014b50) central++;
    view.setUint32(central + 24, 1, true);
    await expect(extractZip(archive)).rejects.toMatchObject({ status: 413 });
  });
});
