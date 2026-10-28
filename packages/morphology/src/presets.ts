import type { BuilderPreset } from "./types.ts";

/** Documented presets in display order, with pinned source references. */
export function builderPresets(): BuilderPreset[] {
  return [
    {
      id: "cll-1995",
      label: "CLL 1995",
      description:
        "The updated six-language table of CLL chapter 4.14. The archive dates it to 1995.",
      source_url: "https://lojban.github.io/cll/4/14/",
      source_digest:
        "ba8c352f9a2ae390a45f46d1b062534da2cc9280ca0ea9d3f507db38c312fb3f",
      reference_url: "https://lojban.org/files/etymology/langstat99.htm",
      denominator: 1000,
      languages: [
        {
          language: "cmn",
          name: "Mandarin Chinese",
          numerator: 347,
        },
        {
          language: "hin",
          name: "Hindi",
          numerator: 196,
        },
        {
          language: "eng",
          name: "English",
          numerator: 160,
        },
        {
          language: "spa",
          name: "Spanish",
          numerator: 123,
        },
        {
          language: "rus",
          name: "Russian",
          numerator: 89,
        },
        {
          language: "ara",
          name: "Arabic",
          numerator: 85,
        },
      ],
    },
    {
      id: "cll-1987",
      label: "CLL 1987",
      description:
        "The original 1987 gismu-remaking table of the Lojban language-statistics archive. It is not the rounded 1985 table of CLL.",
      source_url: "https://lojban.org/files/etymology/langstat99.htm",
      source_digest:
        "5975cfcf8f4d5941810b50dd523ed2f1effa84e6c34fd47d2103ebcc150147f9",
      reference_url: "https://lojban.github.io/cll/4/14/",
      denominator: 1000,
      languages: [
        {
          language: "cmn",
          name: "Mandarin Chinese",
          numerator: 360,
        },
        {
          language: "hin",
          name: "Hindi",
          numerator: 156,
        },
        {
          language: "eng",
          name: "English",
          numerator: 208,
        },
        {
          language: "spa",
          name: "Spanish",
          numerator: 116,
        },
        {
          language: "rus",
          name: "Russian",
          numerator: 87,
        },
        {
          language: "ara",
          name: "Arabic",
          numerator: 73,
        },
      ],
    },
    {
      id: "ilmen6",
      label: "Ilmen 6",
      description:
        "The six-language table of lynn's gimyzba page, labeled there as first and second language speakers. It first appears in that page's first commit of 2026-06-16. The attribution to Ilmen is by name only, and the page names no population source.",
      source_url:
        "https://github.com/lynn/lynn.github.io/blob/567f4ada91/gimyzba/index.html",
      source_digest:
        "2da167c4d5f66146d6083e36793d9142dc6fcf5e150ca8d702a09b75764dfaa7",
      reference_url: "https://github.com/lynn/lynn.github.io/commit/567f4ada91",
      denominator: 1000,
      languages: [
        {
          language: "eng",
          name: "English",
          numerator: 339,
        },
        {
          language: "cmn",
          name: "Mandarin Chinese",
          numerator: 255,
        },
        {
          language: "hin",
          name: "Hindi",
          numerator: 136,
        },
        {
          language: "spa",
          name: "Spanish",
          numerator: 126,
        },
        {
          language: "ara",
          name: "Arabic",
          numerator: 74,
        },
        {
          language: "fra",
          name: "French",
          numerator: 70,
        },
      ],
    },
    {
      id: "ilmen8",
      label: "Ilmen 8",
      description:
        "The eight-language table that the lynn/gimyzba README credits to Ilmen. The README states no population data or method for deriving the weights.",
      source_url:
        "https://github.com/lynn/lynn.github.io/blob/567f4ada91/gimyzba/index.html",
      source_digest:
        "2da167c4d5f66146d6083e36793d9142dc6fcf5e150ca8d702a09b75764dfaa7",
      reference_url: "https://github.com/lynn/gimyzba/blob/b413e2b/README.md",
      denominator: 1000,
      languages: [
        {
          language: "cmn",
          name: "Mandarin Chinese",
          numerator: 271,
        },
        {
          language: "eng",
          name: "English",
          numerator: 170,
        },
        {
          language: "spa",
          name: "Spanish",
          numerator: 130,
        },
        {
          language: "hin",
          name: "Hindi",
          numerator: 125,
        },
        {
          language: "ara",
          name: "Arabic",
          numerator: 104,
        },
        {
          language: "ben",
          name: "Bengali",
          numerator: 76,
        },
        {
          language: "rus",
          name: "Russian",
          numerator: 64,
        },
        {
          language: "por",
          name: "Portuguese",
          numerator: 60,
        },
      ],
    },
    {
      id: "ilmen12",
      label: "Ilmen 12",
      description:
        "The twelve-language table of lynn's gimyzba page. Its numerators sum to 999. It first appears in that page's first commit of 2026-06-16 and differs from Ilmen's 2016 table. The attribution to Ilmen is by name only, and the page names no population source.",
      source_url:
        "https://github.com/lynn/lynn.github.io/blob/567f4ada91/gimyzba/index.html",
      source_digest:
        "2da167c4d5f66146d6083e36793d9142dc6fcf5e150ca8d702a09b75764dfaa7",
      reference_url: "https://github.com/lynn/lynn.github.io/commit/567f4ada91",
      denominator: 1000,
      languages: [
        {
          language: "cmn",
          name: "Mandarin Chinese",
          numerator: 238,
        },
        {
          language: "eng",
          name: "English",
          numerator: 160,
        },
        {
          language: "spa",
          name: "Spanish",
          numerator: 113,
        },
        {
          language: "hin",
          name: "Hindi",
          numerator: 108,
        },
        {
          language: "ara",
          name: "Arabic",
          numerator: 90,
        },
        {
          language: "ben",
          name: "Bengali",
          numerator: 66,
        },
        {
          language: "rus",
          name: "Russian",
          numerator: 55,
        },
        {
          language: "por",
          name: "Portuguese",
          numerator: 52,
        },
        {
          language: "msa",
          name: "Malay",
          numerator: 32,
        },
        {
          language: "jpn",
          name: "Japanese",
          numerator: 30,
        },
        {
          language: "deu",
          name: "German",
          numerator: 29,
        },
        {
          language: "fra",
          name: "French",
          numerator: 26,
        },
      ],
    },
  ];
}
