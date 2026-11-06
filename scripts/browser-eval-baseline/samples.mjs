import { readFile } from "node:fs/promises";

export function validateSample(sample) {
  const middle = sample?.[20]?.cohort;
  if (
    !Array.isArray(sample) ||
    sample.length !== 60 ||
    !sample.every(
      (word) => typeof word?.word === "string" && word.word.length,
    ) ||
    new Set(sample.map((word) => word.word)).size !== 60 ||
    !["heavily_judged", "many_definitions_no_judgments"].includes(middle) ||
    !sample.every(
      (word, index) =>
        word.cohort ===
        (index < 20 ? "common_manual" : index < 40 ? middle : "long_tail"),
    )
  )
    throw Error(
      "Measurements require 60 distinct eligible words: 20 common, 20 judged or definition-rich, and 20 long-tail.",
    );
}

export async function readCachedDataset(path) {
  let dataset;
  try {
    dataset = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
  if (dataset?.schema === 2 || dataset?.schema === 3)
    validateSample(dataset.sample);
  return dataset;
}
