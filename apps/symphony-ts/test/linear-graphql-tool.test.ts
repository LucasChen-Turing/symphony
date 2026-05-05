import test from "node:test";
import assert from "node:assert/strict";
import { executeLinearGraphqlTool, linearGraphqlToolSpec, parseLinearGraphqlInput } from "../src/linear-graphql-tool.ts";
import type { JsonMap } from "../src/types.ts";

class FakeLinearToolClient {
  calls: Array<{ query: string; variables: JsonMap }> = [];
  private readonly response: { data?: JsonMap; errors?: unknown[] };

  constructor(response: { data?: JsonMap; errors?: unknown[] }) {
    this.response = response;
  }

  async rawQuery(query: string, variables: JsonMap): Promise<{ data?: JsonMap; errors?: unknown[] }> {
    this.calls.push({ query, variables });
    return this.response;
  }
}

test("parseLinearGraphqlInput accepts object input with variables", () => {
  assert.deepEqual(parseLinearGraphqlInput({
    query: "mutation UpdateIssue($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
    variables: { id: "issue-1" },
  }), {
    query: "mutation UpdateIssue($id: String!) { issueUpdate(id: $id, input: {}) { success } }",
    variables: { id: "issue-1" },
  });
});

test("parseLinearGraphqlInput accepts raw query shorthand", () => {
  assert.deepEqual(parseLinearGraphqlInput("{ viewer { id } }"), {
    query: "{ viewer { id } }",
    variables: {},
  });
});

test("parseLinearGraphqlInput rejects invalid variables and multiple operations", () => {
  assert.throws(
    () => parseLinearGraphqlInput({ query: "query A { viewer { id } }", variables: [] }),
    /variables must be an object/,
  );
  assert.throws(
    () => parseLinearGraphqlInput("query A { viewer { id } } mutation B { issueUpdate(id: \"1\", input: {}) { success } }"),
    /exactly one operation/,
  );
});

test("parseLinearGraphqlInput ignores operation words in comments and strings", () => {
  const parsed = parseLinearGraphqlInput(`
    # mutation Fake { nope }
    query ReadIssue {
      issue(id: "query not counted") { id }
    }
  `);
  assert.match(parsed.query, /query ReadIssue/);
});

test("executeLinearGraphqlTool returns success true for clean GraphQL response", async () => {
  const client = new FakeLinearToolClient({ data: { viewer: { id: "user-1" } } });
  const result = await executeLinearGraphqlTool({ query: "query Viewer { viewer { id } }" }, client);

  assert.equal(result.success, true);
  assert.deepEqual(result.response, { data: { viewer: { id: "user-1" } } });
  assert.deepEqual(client.calls, [{ query: "query Viewer { viewer { id } }", variables: {} }]);
});

test("executeLinearGraphqlTool returns success false while preserving GraphQL errors", async () => {
  const client = new FakeLinearToolClient({ errors: [{ message: "bad query" }] });
  const result = await executeLinearGraphqlTool({ query: "query Viewer { viewer { id } }" }, client);

  assert.equal(result.success, false);
  assert.deepEqual(result.response, { errors: [{ message: "bad query" }] });
});

test("linearGraphqlToolSpec exposes a strict input schema", () => {
  const spec = linearGraphqlToolSpec();
  assert.equal(spec.name, "linear_graphql");
  assert.equal((spec.inputSchema as JsonMap).type, "object");
});
