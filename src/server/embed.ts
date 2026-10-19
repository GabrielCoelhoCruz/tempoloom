// The website embed script (docs/specs/booking-links-sharing.md rules 24-25).
// A host page adds a container with data-url and this script; the script puts
// the booking page in a frame, keeps the frame as tall as the page, and, in
// the "top page" redirect mode, sends the host page to the redirect URL.
import { Hono } from "hono";

const SCRIPT = `(function () {
  var me = document.currentScript;
  var origin = me ? new URL(me.src).origin : "";
  function mount(box) {
    if (box.getAttribute("data-tempoloom-mounted")) return;
    box.setAttribute("data-tempoloom-mounted", "1");
    var frame = document.createElement("iframe");
    frame.src = box.getAttribute("data-url");
    frame.title = "Book a time";
    frame.style.cssText = "display:block;width:100%;height:600px;border:0";
    box.textContent = "";
    box.appendChild(frame);
  }
  var boxes = document.querySelectorAll(".tempoloom-embed[data-url]");
  for (var i = 0; i < boxes.length; i++) mount(boxes[i]);
  window.addEventListener("message", function (e) {
    var d = e.data;
    if (e.origin !== origin || !d || typeof d !== "object") return;
    var frames = document.querySelectorAll(".tempoloom-embed iframe");
    for (var j = 0; j < frames.length; j++) {
      if (frames[j].contentWindow !== e.source) continue;
      if (d.type === "tempoloom:height" && d.height > 0) frames[j].style.height = Math.ceil(d.height) + "px";
      if (d.type === "tempoloom:redirect" && /^https:\\/\\//.test(d.url)) window.location.href = d.url;
    }
  });
})();
`;

export function embedRoutes(): Hono {
  const r = new Hono();
  r.get("/embed.js", (c) =>
    c.body(SCRIPT, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=3600",
    }),
  );
  return r;
}
