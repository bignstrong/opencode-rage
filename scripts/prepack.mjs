import { execFileSync } from "node:child_process";

if (process.platform === "darwin") {
  execFileSync("sh", ["scripts/build-native.sh"], { stdio: "inherit" });
}
