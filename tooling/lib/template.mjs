import { GovernanceError } from "./errors.mjs";

const variablePattern = /\{\{([A-Z0-9_]+)\}\}/g;

export function renderStrict(source, variables) {
  const missing = new Set();
  const rendered = source.replace(variablePattern, (match, name) => {
    if (!(name in variables)) {
      missing.add(name);
      return match;
    }
    return String(variables[name]);
  });
  if (missing.size > 0) {
    throw new GovernanceError("UNRESOLVED_VARIABLE", "模板变量未解析", {
      variables: [...missing].sort()
    });
  }
  return rendered;
}
