import type { JsonMap } from "./types.ts";

export interface LinearGraphqlResponse {
  data?: JsonMap;
  errors?: unknown[];
}

export interface LinearGraphqlClient {
  query(query: string, variables: JsonMap): Promise<LinearGraphqlResponse>;
}

export class LinearClient implements LinearGraphqlClient {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(endpoint: string, apiKey: string, timeoutMs = 30000) {
    this.endpoint = endpoint;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  async query(query: string, variables: JsonMap): Promise<LinearGraphqlResponse> {
    const payload = await this.rawQuery(query, variables);
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      throw new Error(`linear_graphql_errors: ${JSON.stringify(payload.errors)}`);
    }
    return payload;
  }

  async rawQuery(query: string, variables: JsonMap): Promise<LinearGraphqlResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Authorization": this.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`linear_api_status: ${response.status}`);
      }
      return await response.json() as LinearGraphqlResponse;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`linear_api_request: timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
