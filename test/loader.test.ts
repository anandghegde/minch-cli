import { describe, expect, it } from "vitest";
import {
  definitionRequiresConfig,
  loadDefinition,
  UnsupportedDefinitionError,
} from "../src/cardigann/loader";

describe("loadDefinition", () => {
  it("rejects private indexers", () => {
    expect(() =>
      loadDefinition(`
id: priv
name: Private
type: private
links: [https://x.test/]
caps: {}
search: { rows: { selector: tr }, fields: {} }
`),
    ).toThrow(UnsupportedDefinitionError);
  });

  it("rejects definitions requiring login", () => {
    expect(() =>
      loadDefinition(`
id: needlogin
name: NeedLogin
type: public
links: [https://x.test/]
login:
  path: login.php
  method: form
caps: {}
search: { rows: { selector: tr }, fields: {} }
`),
    ).toThrow(/login/i);
  });

  it("rejects definitions with no links", () => {
    expect(() =>
      loadDefinition(`
id: nolinks
name: NoLinks
type: public
caps: {}
search: { rows: { selector: tr }, fields: {} }
`),
    ).toThrow(/links/i);
  });

  it("accepts a minimal public definition and preserves mirror order", () => {
    const def = loadDefinition(`
id: ok
name: Okay
type: public
links:
  - https://a.test/
  - https://b.test/
caps:
  categories: { Movies: Movies }
search:
  paths:
    - path: search
  rows: { selector: tr }
  fields:
    title: { selector: a }
    magnet: { selector: a, attribute: href }
`);
    expect(def.id).toBe("ok");
    expect(def.links).toEqual(["https://a.test/", "https://b.test/"]);
    expect(def.search.fields.map((f) => f.key)).toEqual(["title", "magnet"]);
  });

  it("flags definitions needing api keys as requiring config", () => {
    const def = loadDefinition(`
id: apik
name: ApiKeyed
type: public
links: [https://x.test/]
settings:
  - name: apikey
    type: text
    label: API Key
caps: {}
search:
  paths: [{ path: api }]
  rows: { selector: tr }
  fields: { title: { selector: a }, magnet: { selector: a, attribute: href } }
`);
    expect(definitionRequiresConfig(def)).toBe(true);
  });
});
