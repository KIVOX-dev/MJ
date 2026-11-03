/** One news item in the digest. */
export interface Story {
  /** One-sentence summary written by the model from the article (no trailing period, no source). */
  summary: string;
  /** Publisher name, e.g. "The Hindu". */
  source?: string;
  /** Photo from the article's feed, used by the PDF edition only. */
  imageUrl?: string;
}

export interface DigestSection {
  title: string;
  /** Plain label, e.g. "TAMIL NADU · POLITICS" (used by the PDF). */
  label: string;
  /** Chat header with emoji, e.g. "🏛  TAMIL NADU · POLITICS". */
  header: string;
  stories: Story[];
}

/** Everything needed to send the text digest and render the PDF; stored as JSON between 05:00 and 08:00. */
export interface DigestPayload {
  /** Human date, e.g. "Wednesday, 4 November 2026". */
  date: string;
  /** Ready-to-send chat text. */
  text: string;
  sections: DigestSection[];
}
