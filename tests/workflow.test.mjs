import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";

const job = (id, extra = {}) => ({ id, url: `https://jobicy.com/jobs/${id}`, jobTitle: "Python engineer", ...extra });
const page = (jobs, nextCursor = null) => ({ jobs, nextCursor, hasMore: nextCursor !== null });
const jsonResponse = (body, options) => new Response(JSON.stringify(body), options);

test("n8n combines all pages, rejects incomplete traversal, and preserves large baselines", async () => {
  const workflow = JSON.parse(await readFile(new URL("../workflows/jobicy-telegram-workflow.json", import.meta.url), "utf8"));
  const nodes = Object.fromEntries(workflow.nodes.map((node) => [node.name, node]));
  const pagination = nodes["Request Jobicy jobs"].parameters.options.pagination.pagination;
  assert.equal(pagination.paginationMode, "responseContainsNextURL");
  const evaluate = (expression, context) => vm.runInNewContext(expression.slice(3, -2).trim(), { ...context, encodeURIComponent });
  const url = new URL(evaluate(pagination.nextURL, {
    $: () => ({ first: () => ({ json: { count: 100, geo: "usa", industry: "engineering" } }) }),
    $response: { body: page([], "opaque+/=") }
  }));
  assert.equal(url.searchParams.get("cursor"), "opaque+/=");
  assert.equal(url.searchParams.get("geo"), "usa");
  assert.equal(evaluate(pagination.completeExpression, { $response: { body: page([]) } }), true);
  assert.equal(evaluate(pagination.completeExpression, { $response: { body: page([], "next") } }), false);
  const run = (name, items, state = {}) => new Function("$input", "$getWorkflowStaticData", "URL", nodes[name].parameters.jsCode)(
    { all: () => items }, () => state, URL
  );
  const extracted = run("Extract jobs", [{ json: page([job(1)], "next") }, { json: page([job(1), job(2)]) }]);
  assert.deepEqual(extracted.map(({ json }) => json.id), [1, 2]);
  assert.throws(() => run("Extract jobs", [{ json: page([job(1)], "incomplete") }]), /safety limit/);
  const state = {};
  const many = Array.from({ length: 2100 }, (_, index) => ({ json: job(index) }));
  assert.deepEqual(run("Deduplicate and format", many, state), []);
  assert.equal(state.jobIds.length, 2100);
  assert.deepEqual(run("Deduplicate and format", many, state), []);
  assert.equal(run("Deduplicate and format", [...many, { json: job(2101) }], state).length, 1);
});

