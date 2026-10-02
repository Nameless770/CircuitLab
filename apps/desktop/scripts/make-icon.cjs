// Renders build/icon.svg to build/icon.png (512 x 512), the icon electron-builder puts on the app
// and the installer. Run it with Electron itself, which can draw SVG:
//   npx electron scripts/make-icon.cjs
// Only needed again after changing icon.svg; icon.png is committed.
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const SIZE = 512;
const svgFile = path.join(__dirname, "..", "build", "icon.svg");
const pngFile = path.join(__dirname, "..", "build", "icon.png");

app.whenReady().then(() => {
  // An invisible "offscreen" window: Chromium draws the page into memory and hands every frame
  // to the "paint" event, which is where we take the picture.
  const window = new BrowserWindow({ width: SIZE, height: SIZE, show: false, transparent: true, webPreferences: { offscreen: true } });
  window.webContents.on("paint", (_event, _dirty, image) => {
    const { width, height } = image.getSize();
    if (width === 0 || height === 0) return; // not drawn yet
    // On a high-DPI screen the frame is bigger than SIZE; scale it to exactly SIZE.
    fs.writeFileSync(pngFile, image.resize({ width: SIZE, height: SIZE, quality: "best" }).toPNG());
    const cornerAlpha = image.toBitmap()[3]; // pixel (0, 0); bitmaps are BGRA
    console.log(`Wrote ${pngFile} (from a ${width}x${height} frame, corner alpha ${cornerAlpha})`);
    app.quit();
  });
  const svg = fs.readFileSync(svgFile, "utf8");
  // display:block and overflow:hidden: an inline SVG adds a few pixels under itself, which would
  // make the page scroll and draw scrollbars into the icon.
  const page = `<!doctype html><html><body style="margin:0;overflow:hidden;background:transparent"><div style="width:${SIZE}px;height:${SIZE}px">${svg.replace("<svg ", "<svg style=\"display:block\" ")}</div></body></html>`;
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
});
