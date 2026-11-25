// OpenCode server plugin in the scratch config only. Reject admission, before any model call.
import { appendFileSync } from "node:fs";
import { join } from "node:path";

export default {
  id: "qa-refuse-prompt",
  async setup(ctx) {
    await ctx.session.hook("http.request", () => {
      appendFileSync(join(process.env.QA_RUN, "unexpected-provider"), "request\n");
      throw new Error("Provider access disabled in fixture");
    });
    await ctx.session.hook("prompt", ({ sessionID, prompt }) => {
      appendFileSync(join(process.env.QA_RUN, "refused.jsonl"), JSON.stringify({ sessionID, prompt }) + "\n");
      throw new Error("Fixture refused prompt admission");
    });
  },
};
