import { describe, expect, it } from "vitest";
import { loadDefinition } from "../src/cardigann/loader";
import {
  buildRequest,
  parseHtmlResults,
  parseJsonResults,
} from "../src/cardigann/executor";
import { buildCategoryMap } from "../src/cardigann/categories";

const HTML_DEF = loadDefinition(`
id: example
name: Example
type: public
encoding: UTF-8
links:
  - https://example.test/
caps:
  categories:
    Movies: Movies/HD
  modes:
    search: [q]
search:
  paths:
    - path: search
  inputs:
    q: "{{ .Keywords }}"
  rows:
    selector: table.results > tbody > tr
  fields:
    title:
      selector: a.name
    details:
      selector: a.name
      attribute: href
    magnet:
      selector: a.magnet
      attribute: href
    size:
      selector: td.size
    seeders:
      selector: td.seeds
    leechers:
      selector: td.peers
    category:
      text: Movies
`);

const HTML = `
<html><body>
<table class="results"><tbody>
  <tr>
    <td><a class="name" href="/t/1">Ubuntu 24.04 Desktop</a></td>
    <td><a class="magnet" href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=ubuntu">M</a></td>
    <td class="size">3.5 GiB</td>
    <td class="seeds">1,200</td>
    <td class="peers">42</td>
  </tr>
  <tr>
    <td><a class="name" href="/t/2">Debian 12 netinst</a></td>
    <td><a class="magnet" href="magnet:?xt=urn:btih:89abcdef0123456789abcdef0123456789abcdef&dn=debian">M</a></td>
    <td class="size">700 MB</td>
    <td class="seeds">300</td>
    <td class="peers">5</td>
  </tr>
</tbody></table>
</body></html>`;

describe("executor — HTML parsing", () => {
  it("extracts rows and fields", () => {
    const catMap = buildCategoryMap(HTML_DEF.caps);
    const results = parseHtmlResults(
      HTML,
      HTML_DEF,
      catMap,
      { ".Keywords": "ubuntu" },
      "https://example.test/",
      "https://example.test/search?q=ubuntu",
      false,
    );
    expect(results).toHaveLength(2);
    const first = results[0]!;
    expect(first.title).toBe("Ubuntu 24.04 Desktop");
    expect(first.infoHash).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(first.magnet).toContain("urn:btih:0123456789abcdef");
    expect(first.sizeBytes).toBe(Math.round(3.5 * 1024 ** 3));
    expect(first.seeders).toBe(1200);
    expect(first.leechers).toBe(42);
    expect(first.category).toBe("Movies");
    expect(first.detailsUrl).toBe("https://example.test/t/1");
  });

  it("derives info hash from a magnet field", () => {
    const catMap = buildCategoryMap(HTML_DEF.caps);
    const results = parseHtmlResults(HTML, HTML_DEF, catMap, {}, "https://example.test/", "", false);
    expect(results[1]!.infoHash).toBe("89abcdef0123456789abcdef0123456789abcdef");
  });
});

const JSON_DEF = loadDefinition(`
id: jsonex
name: JsonEx
type: public
encoding: UTF-8
links:
  - https://api.test/
caps:
  categories: {}
  modes:
    search: [q]
search:
  paths:
    - path: list.json
      response:
        type: json
  inputs:
    q: "{{ .Keywords }}"
  rows:
    selector: data.items
  fields:
    title:
      selector: name
    infohash:
      selector: hash
    size:
      selector: size_bytes
    seeders:
      selector: seeds
    leechers:
      selector: peers
`);

describe("executor — JSON parsing", () => {
  it("extracts rows from a json array selector", () => {
    const body = JSON.stringify({
      data: {
        items: [
          { name: "Movie A", hash: "AABBCCDDEEFF00112233445566778899AABBCCDD", size_bytes: 1048576, seeds: 50, peers: 3 },
          { name: "Movie B", hash: "112233445566778899AABBCCDDEEFF0011223344", size_bytes: 2097152, seeds: 10, peers: 1 },
        ],
      },
    });
    const catMap = buildCategoryMap(JSON_DEF.caps);
    const results = parseJsonResults(body, JSON_DEF, catMap, {}, "https://api.test/", "https://api.test/list.json");
    expect(results).toHaveLength(2);
    expect(results[0]!.title).toBe("Movie A");
    expect(results[0]!.infoHash).toBe("aabbccddeeff00112233445566778899aabbccdd");
    expect(results[0]!.sizeBytes).toBe(1048576);
    expect(results[0]!.seeders).toBe(50);
    expect(results[1]!.magnet).toContain("urn:btih:1122334455");
  });
});

describe("executor — request building", () => {
  it("substitutes keywords into path inputs (GET query string)", () => {
    const req = buildRequest(
      HTML_DEF,
      HTML_DEF.search.paths![0]!,
      { ".Keywords": "linux iso" },
      "https://example.test/",
    );
    expect(req.method).toBe("get");
    expect(req.url).toBe("https://example.test/search?q=linux%20iso");
  });

  it("handles $raw inputs", () => {
    const def = loadDefinition(`
id: rawex
name: RawEx
type: public
encoding: UTF-8
links: [https://r.test/]
caps: { categories: {}, modes: { search: [q] } }
search:
  paths:
    - path: s
  inputs:
    $raw: "q={{ .Keywords }}&cat=movies"
  rows: { selector: tr }
  fields:
    title: { selector: a }
    magnet: { selector: a, attribute: href }
`);
    const req = buildRequest(def, def.search.paths![0]!, { ".Keywords": "dune" }, "https://r.test/");
    expect(req.url).toContain("q=dune");
    expect(req.url).toContain("cat=movies");
  });
});
