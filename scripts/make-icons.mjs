// Regenerate the icon set from the design source build/icon-meander.svg
// (Meander's waterfall, 2026-10-27; it reuses build/icon-flat.svg's squircle).
//
//   build/icon.ico  — Windows (.ico with 16/24/32/48/64/128/256 PNG entries)
//   build/icon.png  — Linux (512×512; AppImage/deb/desktop entry)
//
//   build/icon.icns — macOS (16→1024 PNG entries, drawn on Apple's icon
//                     grid: the squircle at 824/1024 with transparent margin).
//                     The Mac builds pass -c.mac.icon=build/icon.icns, and
//                     scripts/after-pack.cjs copies it into the bundle.
//
// Renders each size DIRECTLY from the SVG (resvg) — sharper squircle
// edges than downsampling a raster. Committed outputs; rerun only when
// the design changes: `node scripts/make-icons.mjs`.
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const svg = readFileSync(path.join(root, "build", "icon-meander.svg"), "utf8");

const render = (size) => new Resvg(svg, { fitTo: { mode: "width", value: size } }).render(size, size).asPng();

// ---- build/icon.ico: ICONDIR + PNG entries ------------------------------
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const pngs = ICO_SIZES.map(render);
// Header (6) + one 16-byte directory entry per image, then the PNGs.
const header = Buffer.alloc(6 + ICO_SIZES.length * 16);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(ICO_SIZES.length, 4);
let offset = header.length;
ICO_SIZES.forEach((size, i) => {
	const e = 6 + i * 16;
	header.writeUInt8(size === 256 ? 0 : size, e); // 0 encodes 256
	header.writeUInt8(size === 256 ? 0 : size, e + 1);
	header.writeUInt8(0, e + 2); // colors
	header.writeUInt8(0, e + 3); // reserved
	header.writeUInt16LE(1, e + 4); // planes
	header.writeUInt16LE(32, e + 6); // bpp
	header.writeUInt32LE(pngs[i].length, e + 8);
	header.writeUInt32LE(offset, e + 12);
	offset += pngs[i].length;
});
const ico = Buffer.concat([header, ...pngs]);
writeFileSync(path.join(root, "build", "icon.ico"), ico);
console.log(`build/icon.ico  ${ICO_SIZES.join("/")} — ${(ico.length / 1024).toFixed(1)} KB`);

// ---- build/icon.png: the Linux icon -------------------------------------
const png512 = render(512);
writeFileSync(path.join(root, "build", "icon.png"), png512);
console.log(`build/icon.png  512×512 — ${(png512.length / 1024).toFixed(1)} KB`);

// ---- build/icon.icns: macOS ---------------------------------------------
// Apple's grid: the artwork's squircle is 824px of the 1024 canvas.
const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
const macSvg = `<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><g transform="translate(100 100) scale(${824 / 1024})">${inner}</g></svg>`;
const renderMac = (size) => new Resvg(macSvg, { fitTo: { mode: "width", value: size } }).render().asPng();
// [OSType, pixel size] — PNG payloads, which every macOS since 10.7 reads.
const ICNS = [["icp4", 16], ["icp5", 32], ["ic11", 32], ["ic12", 64], ["ic07", 128], ["ic13", 256], ["ic08", 256], ["ic14", 512], ["ic09", 512], ["ic10", 1024]];
const chunks = ICNS.map(([type, size]) => {
	const png = renderMac(size);
	const head = Buffer.alloc(8);
	head.write(type, 0, "ascii");
	head.writeUInt32BE(png.length + 8, 4);
	return Buffer.concat([head, png]);
});
const body = Buffer.concat(chunks);
const icnsHead = Buffer.alloc(8);
icnsHead.write("icns", 0, "ascii");
icnsHead.writeUInt32BE(body.length + 8, 4);
const icns = Buffer.concat([icnsHead, body]);
writeFileSync(path.join(root, "build", "icon.icns"), icns);
// The running Mac app sets its Dock/About icon from this (electron/main.cjs).
writeFileSync(path.join(root, "build", "icon-mac.png"), renderMac(512));
console.log(`build/icon.icns ${ICNS.length} entries — ${(icns.length / 1024).toFixed(1)} KB`);
