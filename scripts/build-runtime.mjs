// Node doesn't strip TypeScript from installed dependencies. Emit just the public runtime adapter.
import ts from "typescript";
import { readFileSync, writeFileSync } from "node:fs";
for (const file of ["rage/core.ts", "src/native-runtime.ts"]) {
  const result = ts.transpileModule(readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      rewriteRelativeImportExtensions: true,
    },
  });
  writeFileSync(file.replace(/\.ts$/, ".js"), result.outputText);
}
