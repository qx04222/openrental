import { readFileSync } from "node:fs";

describe("quality gate", () => {
  it("enforces a zero lint-warning budget in CI", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");

    const lintCommand = packageJson.scripts?.["lint:ci"] ?? "";
    const warningBudget = Number(lintCommand.match(/--max-warnings\s+(\d+)/)?.[1]);

    expect(warningBudget).toBe(0);
    expect(workflow).toContain("npm run lint:ci");
  });
});
