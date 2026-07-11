import { describe, expect, it, vi } from "vitest";
import { loadDefinition } from "../src/cardigann/loader";
import {
  buildRequest,
  executeSearch,
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

  it("does not leak optional .Result variables between rows", () => {
    const def = loadDefinition(`
id: row-state
name: Row State
type: public
links: [https://example.test/]
caps: { categories: {}, modes: { search: [q] } }
search:
  paths: [{ path: search }]
  rows: { selector: tr }
  fields:
    title|optional:
      selector: .title
      default: "{{ .Result.title }}"
    magnet: { selector: .magnet, attribute: href }
`);
    const vars = { ".Keywords": "movie" };
    const results = parseHtmlResults(
      `<table><tr><td class="title">First result</td><td><a class="magnet" href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567">M</a></td></tr>
      <tr><td><a class="magnet" href="magnet:?xt=urn:btih:89abcdef0123456789abcdef0123456789abcdef">M</a></td></tr></table>`,
      def,
      buildCategoryMap(def.caps),
      vars,
      "https://example.test/",
      "https://example.test/search",
      false,
    );

    expect(results.map((result) => result.title)).toEqual(["First result"]);
    expect(vars).not.toHaveProperty(".Result.title");
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

const XML_DEF = loadDefinition(`
id: xmlex
name: XmlEx
type: public
encoding: UTF-8
links: [https://api.test/]
caps: { categories: {}, modes: { search: [q] } }
search:
  paths:
    - path: feed.xml
      response: { type: xml }
  rows: { selector: item }
  fields:
    title: { selector: title }
    infohash: { selector: infohash }
    seeders: { selector: seeders }
`);

describe("executor — XML parsing", () => {
  it("extracts XML rows through the shared selector pipeline", () => {
    const results = parseHtmlResults(
      `<rss><channel><item><title>XML Movie</title><infohash>0123456789abcdef0123456789abcdef01234567</infohash><seeders>12</seeders></item></channel></rss>`,
      XML_DEF,
      buildCategoryMap(XML_DEF.caps),
      {},
      "https://api.test/",
      "https://api.test/feed.xml",
      true,
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: "XML Movie",
      infoHash: "0123456789abcdef0123456789abcdef01234567",
      seeders: 12,
    });
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

  it("sends POST inputs as a form with an explicit content type", async () => {
    const def = loadDefinition(`
id: postex
name: PostEx
type: public
links: [https://post.test/]
caps: { categories: {}, modes: { search: [q] } }
search:
  paths:
    - path: search
      method: post
  inputs:
    q: "{{ .Keywords }}"
  rows: { selector: tr }
  fields:
    title: { selector: .title }
    magnet: { selector: .magnet, attribute: href }
`);
    let captured: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      captured = init;
      return new Response(
        `<table><tr><td class="title">Result</td><td><a class="magnet" href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567">M</a></td></tr></table>`,
      );
    };

    await executeSearch(def, "foo", "https://post.test/", { fetchImpl });

    expect(captured?.method).toBe("POST");
    expect(captured?.body).toBe("q=foo");
    expect(new Headers(captured?.headers).get("content-type")).toBe(
      "application/x-www-form-urlencoded;charset=UTF-8",
    );
  });

  it("routes search requests through the supplied source governor", async () => {
    const governor = { wait: vi.fn(async () => {}) };
    const fetchImpl: typeof fetch = async () => new Response("<table></table>");

    await executeSearch(HTML_DEF, "foo", "https://example.test/", {
      fetchImpl,
      requestGovernor: governor,
    });

    expect(governor.wait).toHaveBeenCalledTimes(1);
  });
});
