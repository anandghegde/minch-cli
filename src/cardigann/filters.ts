// Scoped port of Cardigann's ApplyFilters (CardigannBase.cs). Only the filters
// public definitions actually use are implemented (verified against the 81
// public, no-login v11 defs): regexp, re_replace, replace, split, querystring,
// dateparse/timeparse/timeago/reltime/fuzzytime, append/prepend, trim, tolower,
// toupper, urldecode, urlencode, htmldecode, validate, diacritics.

import { decode as decodeEntities } from "./entities";
import { fromTimeAgo, fromUnknown, parseGoLayout } from "./dates";
import { applyTemplate, type TemplateVars } from "./template";
import type { CardigannFilter } from "./model";

function arg(args: CardigannFilter["args"], i = 0): string {
  if (args == null) return "";
  if (Array.isArray(args)) return args[i] != null ? String(args[i]) : "";
  return i === 0 ? String(args) : "";
}

function dateToString(unix: number | null): string {
  // Emit an RFC-ish string the downstream `date` field parser re-reads; using
  // ISO keeps it round-trippable through Date.parse.
  return unix != null ? new Date(unix * 1000).toISOString() : "";
}

export function applyFilters(
  input: string,
  filters: CardigannFilter[] | undefined,
  vars: TemplateVars,
): string {
  if (!filters || filters.length === 0) return input;
  let data = input;

  for (const filter of filters) {
    switch (filter.name) {
      case "querystring": {
        const param = arg(filter.args);
        try {
          const u = new URL(data, "http://x/");
          data = u.searchParams.get(param) ?? "";
        } catch {
          const m = data.match(new RegExp(`[?&]${param}=([^&]*)`));
          data = m ? decodeURIComponent(m[1]!) : "";
        }
        break;
      }
      case "timeparse":
      case "dateparse": {
        const layout = arg(filter.args);
        const unix = parseGoLayout(data, layout);
        data = dateToString(unix ?? fromUnknown(data));
        break;
      }
      case "regexp": {
        const pattern = arg(filter.args);
        try {
          const m = new RegExp(pattern).exec(data);
          data = m ? (m[1] ?? "") : "";
        } catch {
          data = "";
        }
        break;
      }
      case "re_replace": {
        const pattern = arg(filter.args, 0);
        const repl = applyTemplate(arg(filter.args, 1), vars);
        try {
          data = data.replace(new RegExp(pattern, "g"), repl);
        } catch {
          /* leave data unchanged on bad pattern */
        }
        break;
      }
      case "split": {
        const sep = arg(filter.args, 0);
        let pos = parseInt(arg(filter.args, 1), 10);
        const parts = data.split(sep.charAt(0) || sep);
        if (pos < 0) pos += parts.length;
        data = parts[pos] ?? "";
        break;
      }
      case "replace": {
        const from = arg(filter.args, 0);
        const to = applyTemplate(arg(filter.args, 1), vars);
        data = data.split(from).join(to);
        break;
      }
      case "trim": {
        const cutset = arg(filter.args);
        if (cutset) {
          const c = cutset.charAt(0);
          while (data.startsWith(c)) data = data.slice(1);
          while (data.endsWith(c)) data = data.slice(0, -1);
        } else {
          data = data.trim();
        }
        break;
      }
      case "prepend":
        data = applyTemplate(arg(filter.args), vars) + data;
        break;
      case "append":
        data = data + applyTemplate(arg(filter.args), vars);
        break;
      case "tolower":
        data = data.toLowerCase();
        break;
      case "toupper":
        data = data.toUpperCase();
        break;
      case "urldecode":
        try {
          data = decodeURIComponent(data.replace(/\+/g, " "));
        } catch {
          /* keep */
        }
        break;
      case "urlencode":
        data = encodeURIComponent(data);
        break;
      case "htmldecode":
        data = decodeEntities(data);
        break;
      case "htmlencode":
        data = data
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
        break;
      case "timeago":
      case "reltime":
        data = dateToString(fromTimeAgo(data));
        break;
      case "fuzzytime":
        data = dateToString(fromUnknown(data));
        break;
      case "diacritics": {
        if (arg(filter.args) === "replace") {
          data = data.normalize("NFD").replace(/[\u0300-\u036f]/g, "").normalize("NFC");
        }
        break;
      }
      case "validate": {
        const delimiters = /[,\s/)(.;[\]"|:]+/;
        const valid = arg(filter.args).toLowerCase().split(delimiters).filter(Boolean);
        const have = data.toLowerCase().split(delimiters).filter(Boolean);
        data = valid.filter((v) => have.includes(v)).join(", ");
        break;
      }
      case "hexdump":
      case "strdump":
      case "validfilename":
        // no-op / debug filters: pass data through unchanged.
        break;
      default:
        // Unknown filter: pass through (matches Prowlarr's "log and continue").
        break;
    }
  }

  return data;
}
