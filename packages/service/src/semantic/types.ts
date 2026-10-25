export interface EmbeddingProfile {
  version: 1;
  model: string;
  revision: string | null;
  artifacts: string[];
  provider: string;
  runtime: { name: string; version: string } | null;
  epoch: string;
  dimension: number;
  encoding: "f32le";
  normalization: "unit-l2" | "none";
  distance: "cosine" | "dot";
  document: InputRecipe;
  query: InputRecipe;
  parameters: Record<string, unknown>;
}

export interface InputRecipe {
  recipe: string;
  task: string | null;
  prefix: string;
  truncation: string;
}

export class SemanticError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SemanticError";
  }
}
