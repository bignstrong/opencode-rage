import { writeSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { activityInterval, createActivity } from "../src/button/activity.ts";

export const previews = [
  { name: "Цифровой вдох", next: createActivity("breath") },
  { name: "Цифровой дождь", next: createActivity("rain") },
];

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.stdout;
  if (!out.isTTY) {
    for (const [i, p] of previews.entries())
      console.log(`${i + 1}. ${p.name}: ${Array.from({ length: 16 }, p.next).join(" → ")}`);
  } else {
    const draw = () => {
      const rows = previews.map(
        ({ name, next }, i) => `${i + 1}. ${name.padEnd(16)} ${next()}`,
      );
      out.write(
        "\x1b[H" +
          [...rows, "", "Ctrl+C — выход"]
            .slice(0, out.rows)
            .map((s) => s.slice(0, out.columns - 1))
            .join("\r\n") +
          "\x1b[J",
      );
    };
    out.write("\x1b[?1049h\x1b[?25l");
    process.on("exit", () => writeSync(out.fd, "\x1b[?25h\x1b[?1049l"));
    process.once("SIGINT", () => process.exit(0));
    process.once("SIGTERM", () => process.exit(0));
    draw();
    setInterval(draw, activityInterval);
  }
}
