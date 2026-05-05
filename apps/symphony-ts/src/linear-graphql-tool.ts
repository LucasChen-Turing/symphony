import { LinearClient, type LinearGraphqlResponse } from "./linear-client.ts";
import type { JsonMap } from "./types.ts";
import { errorMessage } from "./util.ts";

export interface LinearGraphqlToolClient {
  rawQuery(query: string, variables: JsonMap): Promise<LinearGraphqlResponse>;
}

export interface LinearGraphqlToolInput {
  query: string;
  variables: JsonMap;
}

export interface LinearGraphqlToolResult {
  success: boolean;
  response?: LinearGraphqlResponse;
  error?: string;
}

export function linearGraphqlToolSpec(): JsonMap {
  return {
    namespace: "symphony",
    name: "linear_graphql",
    description: "Execute one Linear GraphQL query or mutation using Symphony's configured Linear credentials.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description: "A single GraphQL query or mutation document.",
        },
        variables: {
          type: "object",
          description: "Optional GraphQL variables object.",
          additionalProperties: true,
        },
      },
    },
  };
}

export function parseLinearGraphqlInput(input: unknown): LinearGraphqlToolInput {
  if (typeof input === "string") {
    const query = input.trim();
    validateGraphqlDocument(query);
    return { query, variables: {} };
  }
  if (!isObject(input)) {
    throw new Error("invalid linear_graphql input: expected object or GraphQL query string");
  }
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (query.length === 0) {
    throw new Error("linear_graphql query is required");
  }
  if ("variables" in input && !isObject(input.variables)) {
    throw new Error("linear_graphql variables must be an object");
  }
  validateGraphqlDocument(query);
  return {
    query,
    variables: isObject(input.variables) ? input.variables : {},
  };
}

export async function executeLinearGraphqlTool(
  input: unknown,
  client: LinearGraphqlToolClient,
): Promise<LinearGraphqlToolResult> {
  try {
    const parsed = parseLinearGraphqlInput(input);
    const response = await client.rawQuery(parsed.query, parsed.variables);
    return {
      success: !Array.isArray(response.errors) || response.errors.length === 0,
      response,
    };
  } catch (error) {
    return {
      success: false,
      error: errorMessage(error),
    };
  }
}

export function createLinearGraphqlToolClient(endpoint: string, apiKey: string): LinearGraphqlToolClient {
  return new LinearClient(endpoint, apiKey);
}

function validateGraphqlDocument(query: string): void {
  const stripped = stripGraphqlIgnoredText(query).trim();
  if (stripped.length === 0) {
    throw new Error("linear_graphql query is required");
  }

  const operations = stripped.match(/\b(query|mutation|subscription)\b/g) ?? [];
  if (operations.length > 1) {
    throw new Error("linear_graphql query must contain exactly one operation");
  }
  if (operations.length === 1) {
    return;
  }
  if (stripped.startsWith("{")) {
    return;
  }
  throw new Error("linear_graphql query must contain exactly one operation");
}

function stripGraphqlIgnoredText(source: string): string {
  let output = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (char === "#") {
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      output += " ";
    } else if (char === '"' && next === '"' && source[index + 2] === '"') {
      index += 3;
      while (index < source.length && !(source[index] === '"' && source[index + 1] === '"' && source[index + 2] === '"')) {
        index += 1;
      }
      index = Math.min(index + 3, source.length);
      output += " ";
    } else if (char === '"') {
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
        } else if (source[index] === '"') {
          index += 1;
          break;
        } else {
          index += 1;
        }
      }
      output += " ";
    } else {
      output += char;
      index += 1;
    }
  }
  return output;
}

function isObject(value: unknown): value is JsonMap {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
