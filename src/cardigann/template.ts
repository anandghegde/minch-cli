// Scoped port of Cardigann's ApplyGoTemplateText (CardigannBase.cs). Handles the
// Go-template-ish expressions public definitions use: re_replace, join, and/or,
// eq/ne, if/else, range, and simple {{ .Variable }} substitution.
//
// Variables are a flat record keyed by dotted names (".Query.Keywords",
// ".Config.foo", ".Result.title", ".Keywords", etc). Values are strings,
// string arrays, or null. A null value represents Go's "empty/false".

export type TemplateVars = Record<string, string | string[] | null | undefined>;

export type TextModifier = (s: string) => string;

const SUPPORTED_LOGIC = ["and", "or", "eq", "ne"];
const LOGIC_RE = new RegExp(
  `\\b(${SUPPORTED_LOGIC.join("|")})((?:\\s+(?:\\(?\\.[^\\)\\s]+\\)?|"[^"]+")){2,})`,
);

function varString(vars: TemplateVars, key: string): string | null {
  const v = vars[key];
  if (v == null) return null;
  if (Array.isArray(v)) return v.length ? v.join(",") : null;
  return v;
}

// ---- individual template transforms (each independently testable) -----------

/** {{ re_replace .Var "pattern" "replacement" }} */
function applyReReplace(
  out: string,
  vars: TemplateVars,
  modifier?: TextModifier,
): string {
  return out.replace(
    /{{\s*re_replace\s+(\.[^\s]+?)\s+"([^"]*)"\s+"([^"]*)"\s*}}/g,
    (_all, variable: string, pattern: string, repl: string) => {
      const input = varString(vars, variable) ?? "";
      let expanded: string;
      try {
        expanded = input.replace(new RegExp(pattern, "g"), repl);
      } catch {
        expanded = input;
      }
      return modifier ? modifier(expanded) : expanded;
    },
  );
}

/** {{ join .Var "," }} */
function applyJoin(
  out: string,
  vars: TemplateVars,
  modifier?: TextModifier,
): string {
  return out.replace(
    /{{\s*join\s+(\.[^\s]+?)\s+"([^"]*)"\s*}}/g,
    (_all, variable: string, delim: string) => {
      const v = vars[variable];
      const arr = Array.isArray(v) ? v : v != null ? [String(v)] : [];
      const expanded = arr.join(delim);
      return modifier ? modifier(expanded) : expanded;
    },
  );
}

/** {{ and/or/eq/ne (.A) (.B) "literal" ... }} — iterated to support nesting. */
function applyLogic(out: string, vars: TemplateVars): string {
  for (let guard = 0; guard < 50; guard++) {
    const m = LOGIC_RE.exec(out);
    if (!m) break;
    const fn = m[1]!;
    const paramRe = /\(?\.[^\)\s]+\)?|"[^"]+"/g;
    let pm: RegExpExecArray | null;
    let params: string[] = [];
    while ((pm = paramRe.exec(m[2]!)) !== null) {
      params.push(pm[0]!.replace(/^\(|\)$/g, ""));
    }
    if (fn !== "eq" && fn !== "ne") {
      params = params.filter((p) => !p.startsWith('"'));
    }
    let result = "";
    if (fn === "and" || fn === "or") {
      const isAnd = fn === "and";
      for (const p of params) {
        result = p;
        const empty = !varString(vars, p);
        if (empty === isAnd) break;
      }
    } else {
      const wantEqual = fn === "eq";
      const resolve = (p: string): string | null =>
        p.startsWith('"') ? p.replace(/^"|"$/g, "") : varString(vars, p);
      const taken = params.slice(0, 2).map(resolve);
      const isEqual = taken[0] === taken[1];
      result = isEqual === wantEqual ? ".True" : ".False";
    }
    const start = m.index;
    let consumed = m[0]!.length;
    if ((fn === "eq" || fn === "ne") && params.length > 2) {
      const matchText = m[0]!;
      const re2 = /\(?\.[^\)\s]+\)?|"[^"]+"/g;
      let count = 0;
      let end = matchText.length;
      let mm: RegExpExecArray | null;
      while ((mm = re2.exec(matchText)) !== null) {
        count++;
        if (count === 2) {
          end = mm.index + mm[0]!.length;
          break;
        }
      }
      consumed = end;
    }
    out = out.slice(0, start) + result + out.slice(start + consumed);
  }
  return out;
}

/** {{ if .Var }}A{{ else }}B{{ end }} */
function applyIfElse(out: string, vars: TemplateVars): string {
  return out.replace(
    /{{\s*if\s*(.+?)\s*}}(.*?){{\s*else\s*}}(.*?){{\s*end\s*}}/gs,
    (_all, cond: string, onTrue: string, onFalse: string) => {
      if (!cond.startsWith(".")) return onFalse;
      if (cond === ".True") return onTrue;
      if (cond === ".False") return onFalse;
      const v = vars[cond];
      const truthy = Array.isArray(v) ? v.length > 0 : !!v;
      return truthy ? onTrue : onFalse;
    },
  );
}

/** {{ range .Var }}prefix{{.}}postfix{{end}} */
function applyRange(
  out: string,
  vars: TemplateVars,
  modifier?: TextModifier,
): string {
  return out.replace(
    /{{\s*range\s*(?:(\$[^,]+?),\s*([^\s]+?)\s*:=\s*)?(.+?)\s*}}(.*?){{\.}}(.*?){{\s*end\s*}}/gs,
    (_all, index: string | undefined, _el, variable: string, prefix: string, postfix: string) => {
      const v = vars[variable];
      const arr = Array.isArray(v) ? v : v != null ? [String(v)] : [];
      let expanded = "";
      arr.forEach((value, i) => {
        const nv = modifier ? modifier(value) : value;
        if (index) {
          const rep = "{{" + index + "}}";
          expanded +=
            prefix.split(rep).join(String(i)) +
            nv +
            postfix.split(rep).join(String(i));
        } else {
          expanded += prefix + nv + postfix;
        }
      });
      return expanded;
    },
  );
}

/** Simple variables: {{ .Var }} */
function applySimpleVar(
  out: string,
  vars: TemplateVars,
  modifier?: TextModifier,
): string {
  return out.replace(/{{\s*(\.[^\s}]+?)\s*}}/g, (_all, variable: string) => {
    const value = varString(vars, variable) ?? "";
    return modifier ? modifier(value) : value;
  });
}

/**
 * Apply all template transforms in evaluation order: function-call forms first
 * (re_replace, join), then logic, then control flow (if/else, range), then
 * plain variable substitution. Order matters: logic produces .True/.False which
 * if/else reads, and all of these must run before the final simple-var pass.
 */
export function applyTemplate(
  template: string | undefined,
  vars: TemplateVars,
  modifier?: TextModifier,
): string {
  if (template == null) return "";
  if (template === "" || !template.includes("{{")) return template;

  let out = template;
  out = applyReReplace(out, vars, modifier);
  out = applyJoin(out, vars, modifier);
  out = applyLogic(out, vars);
  out = applyIfElse(out, vars);
  out = applyRange(out, vars, modifier);
  out = applySimpleVar(out, vars, modifier);
  return out;
}

// Exposed for unit testing of individual transforms.
export {
  applyReReplace,
  applyJoin,
  applyLogic,
  applyIfElse,
  applyRange,
  applySimpleVar,
};
